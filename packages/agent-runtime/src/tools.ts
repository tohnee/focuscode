import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { WorkspaceGuard } from "@focuscode/action-backends";
import { newId, sha256Digest } from "@focuscode/contracts";
import { grepRecursive, listFiles } from "./rg-fallback.js";
import type {
  AgentTool,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./types.js";
import { createWebFetchTool, createWebSearchTool } from "./web-tools.js";

export interface ShellExecutor {
  readonly kind: string;
  execute(input: {
    command: string;
    cwd: string;
    workspaceRoot: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    durationMs: number;
    backend?: string;
  }>;
}

export interface CodingToolOptions {
  maxFileBytes?: number;
  maxOutputChars?: number;
  commandTimeoutMs?: number;
  shellExecutor?: ShellExecutor;
  /** Custom web_search endpoint (GET ?q= returning JSON); defaults to DuckDuckGo lite. */
  searchEndpoint?: string;
}

interface ProcessResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  backend?: string;
  /** True when the process was terminated by an AbortSignal rather than timeout or normal exit. */
  aborted?: boolean;
}

/** Throw an AbortError if the given signal is already aborted. */
function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const error = new Error(signal.reason instanceof Error ? signal.reason.message : "Aborted");
    error.name = "AbortError";
    throw error;
  }
}

export class AgentToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  constructor(tools: AgentTool[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: AgentTool): void {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(tool.definition.name)) {
      throw new Error(`Invalid tool name: ${tool.definition.name}`);
    }
    if (this.tools.has(tool.definition.name)) {
      throw new Error(`Duplicate tool name: ${tool.definition.name}`);
    }
    this.tools.set(tool.definition.name, tool);
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((tool) => tool.definition);
  }

  values(): AgentTool[] {
    return [...this.tools.values()];
  }
}

export async function createCodingToolRegistry(
  cwd: string,
  options: CodingToolOptions = {},
): Promise<AgentToolRegistry> {
  const workspace = await WorkspaceGuard.create(cwd);
  const maxFileBytes = options.maxFileBytes ?? 5_000_000;
  const maxOutputChars = options.maxOutputChars ?? 80_000;
  const commandTimeoutMs = options.commandTimeoutMs ?? 120_000;
  const registry = new AgentToolRegistry();

  registry.register({
    definition: definition(
      "read",
      "Read",
      "Read a UTF-8 file with line numbers. Use offset and limit for large files.",
      {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string", description: "Workspace-relative file path" },
          offset: { type: "integer", minimum: 1, description: "First line, 1-based" },
          limit: { type: "integer", minimum: 1, maximum: 2000 },
        },
        additionalProperties: false,
      },
      "read",
    ),
    async execute(input, context) {
      checkAbort(context?.signal);
      const path = requiredString(input.path, "path");
      const absolute = await workspace.resolvePath(path);
      checkAbort(context?.signal);
      const info = await stat(absolute);
      if (!info.isFile()) throw new Error(`Not a regular file: ${path}`);
      if (info.size > maxFileBytes) throw new Error(`File exceeds ${maxFileBytes} bytes: ${path}`);
      const content = await readFile(absolute, "utf8");
      checkAbort(context?.signal);
      const lines = content.split("\n");
      const offset = boundedInteger(input.offset, 1, 1, Math.max(1, lines.length));
      const limit = boundedInteger(input.limit, 400, 1, 2_000);
      const selected = lines.slice(offset - 1, offset - 1 + limit);
      const numbered = selected
        .map((line, index) => `${String(offset + index).padStart(6)}\t${line}`)
        .join("\n");
      return {
        content: `${numbered}\n\n[${path}: lines ${offset}-${offset + selected.length - 1} of ${lines.length}; sha256 ${sha256Digest(content).slice(7, 19)}]`,
        metadata: {
          path,
          offset,
          lines: selected.length,
          totalLines: lines.length,
          digest: sha256Digest(content),
          truncated: offset - 1 + limit < lines.length,
        },
      };
    },
  });

  registry.register({
    definition: definition(
      "write",
      "Write",
      "Create or replace a UTF-8 file atomically inside the workspace.",
      {
        type: "object",
        required: ["path", "content"],
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        additionalProperties: false,
      },
      "write",
    ),
    async execute(input, context) {
      checkAbort(context?.signal);
      const path = requiredString(input.path, "path");
      const content = stringValue(input.content, "content");
      if (Buffer.byteLength(content) > maxFileBytes) {
        throw new Error(`Content exceeds ${maxFileBytes} bytes`);
      }
      const absolute = await workspace.resolvePath(path, { allowMissing: true });
      checkAbort(context?.signal);
      const before = (await exists(absolute)) ? await readFile(absolute, "utf8") : undefined;
      await mkdir(dirname(absolute), { recursive: true });
      const temporary = join(dirname(absolute), `.${basename(absolute)}.${newId("write")}.tmp`);
      checkAbort(context?.signal);
      await writeFile(temporary, content, { encoding: "utf8", mode: 0o644 });
      await rename(temporary, absolute);
      return {
        content: `Wrote ${path} (${Buffer.byteLength(content)} bytes)`,
        metadata: {
          path,
          created: before === undefined,
          before: before === undefined ? null : sha256Digest(before),
          after: sha256Digest(content),
        },
      };
    },
  });

  registry.register({
    definition: definition(
      "edit",
      "Edit",
      "Replace exact text in one file. The old text must occur exactly expectedOccurrences times.",
      {
        type: "object",
        required: ["path", "oldText", "newText"],
        properties: {
          path: { type: "string" },
          oldText: { type: "string", minLength: 1 },
          newText: { type: "string" },
          expectedOccurrences: { type: "integer", minimum: 1, maximum: 1000 },
        },
        additionalProperties: false,
      },
      "write",
    ),
    async execute(input, context) {
      checkAbort(context?.signal);
      const path = requiredString(input.path, "path");
      const oldText = requiredString(input.oldText, "oldText");
      const newText = stringValue(input.newText, "newText");
      const expected = boundedInteger(input.expectedOccurrences, 1, 1, 1_000);
      const absolute = await workspace.resolvePath(path);
      const info = await stat(absolute);
      if (!info.isFile() || info.size > maxFileBytes) throw new Error(`File is too large: ${path}`);
      checkAbort(context?.signal);
      const before = await readFile(absolute, "utf8");
      const occurrences = before.split(oldText).length - 1;
      if (occurrences !== expected) {
        throw new Error(`Expected ${expected} occurrence(s) in ${path}, found ${occurrences}`);
      }
      const after = before.split(oldText).join(newText);
      if (after === before) throw new Error("Edit produced no change");
      checkAbort(context?.signal);
      const temporary = join(dirname(absolute), `.${basename(absolute)}.${newId("edit")}.tmp`);
      await writeFile(temporary, after, { encoding: "utf8", mode: info.mode });
      await rename(temporary, absolute);
      return {
        content: `Edited ${path}: replaced ${occurrences} occurrence(s)`,
        metadata: {
          path,
          occurrences,
          before: sha256Digest(before),
          after: sha256Digest(after),
        },
      };
    },
  });

  registry.register({
    definition: definition(
      "apply_patch",
      "Apply patch",
      "Apply a unified diff with git apply after a dry-run check. Paths must be workspace-relative.",
      {
        type: "object",
        required: ["patch"],
        properties: { patch: { type: "string", minLength: 1 } },
        additionalProperties: false,
      },
      "write",
    ),
    async execute(input, context) {
      const patch = requiredString(input.patch, "patch");
      if (Buffer.byteLength(patch) > 2_000_000) throw new Error("Patch exceeds 2 MB");
      const check = await runProcess("git", ["apply", "--check", "--whitespace=nowarn", "-"], {
        cwd: workspace.root,
        input: patch,
        timeoutMs: commandTimeoutMs,
        maxOutputChars,
        signal: context.signal,
      });
      if (check.exitCode !== 0) return commandError(check, "Patch dry-run failed");
      const applied = await runProcess("git", ["apply", "--whitespace=nowarn", "-"], {
        cwd: workspace.root,
        input: patch,
        timeoutMs: commandTimeoutMs,
        maxOutputChars,
        signal: context.signal,
      });
      if (applied.exitCode !== 0) return commandError(applied, "Patch apply failed");
      return {
        content: "Patch applied successfully",
        metadata: { digest: sha256Digest(patch), durationMs: applied.durationMs },
      };
    },
  });

  registry.register({
    definition: definition(
      "grep",
      "Grep",
      "Search file contents with ripgrep regex syntax. Results are bounded.",
      {
        type: "object",
        required: ["pattern"],
        properties: {
          pattern: { type: "string" },
          path: { type: "string" },
          glob: { type: "string" },
          ignoreCase: { type: "boolean" },
          maxResults: { type: "integer", minimum: 1, maximum: 1000 },
        },
        additionalProperties: false,
      },
      "read",
    ),
    async execute(input, context) {
      const pattern = requiredString(input.pattern, "pattern");
      const path = optionalString(input.path) ?? ".";
      if (path !== ".") await workspace.resolvePath(path);
      const maxResults = boundedInteger(input.maxResults, 200, 1, 1_000);
      const glob = optionalString(input.glob);
      if (!rgAvailable()) {
        const started = Date.now();
        const searchRoot = path === "." ? workspace.root : resolve(workspace.root, path);
        const found = await grepRecursive(searchRoot, {
          pattern,
          ...(input.ignoreCase === true ? { ignoreCase: true } : {}),
          ...(glob ? { glob } : {}),
          maxResults: maxResults + 1,
          cwd: workspace.root,
          ...(context?.signal ? { signal: context.signal } : {}),
        });
        const truncated = found.length > maxResults;
        const matches = found.slice(0, maxResults);
        return {
          content:
            matches
              .map((match) => `${match.path}:${match.line}:${match.column}:${match.content}`)
              .join("\n") || "No matches found",
          metadata: {
            backend: "fallback",
            durationMs: Date.now() - started,
            observed: matches.length,
            truncated,
          },
        };
      }
      const args = ["--line-number", "--column", "--no-heading", "--color", "never"];
      if (input.ignoreCase === true) args.push("--ignore-case");
      if (glob) args.push("--glob", glob);
      args.push("--max-count", String(maxResults), "--", pattern, path);
      const result = await runProcess("rg", args, {
        cwd: workspace.root,
        timeoutMs: 30_000,
        maxOutputChars,
        signal: context.signal,
      });
      if (result.exitCode !== 0 && result.exitCode !== 1)
        return commandError(result, "grep failed");
      const matches = result.stdout.split("\n").filter(Boolean);
      return {
        content: matches.slice(0, maxResults).join("\n") || "No matches found",
        metadata: {
          backend: "rg",
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          observed: matches.length,
          truncated: matches.length > maxResults,
        },
      };
    },
  });

  registry.register({
    definition: definition(
      "find",
      "Find",
      "List repository files using ignore rules. Optionally filter with a glob.",
      {
        type: "object",
        properties: {
          path: { type: "string" },
          glob: { type: "string" },
          maxResults: { type: "integer", minimum: 1, maximum: 5000 },
        },
        additionalProperties: false,
      },
      "read",
    ),
    async execute(input, context) {
      const path = optionalString(input.path) ?? ".";
      if (path !== ".") await workspace.resolvePath(path);
      const glob = optionalString(input.glob);
      const maxResults = boundedInteger(input.maxResults, 1_000, 1, 5_000);
      if (!rgAvailable()) {
        const searchRoot = path === "." ? workspace.root : resolve(workspace.root, path);
        const found = await listFiles(searchRoot, {
          ...(glob ? { glob } : {}),
          maxResults: maxResults + 1,
          cwd: workspace.root,
          ...(context?.signal ? { signal: context.signal } : {}),
        });
        const truncated = found.length > maxResults;
        const lines = found.slice(0, maxResults);
        return {
          content: lines.join("\n") || "No files found",
          metadata: { backend: "fallback", totalObserved: lines.length, truncated },
        };
      }
      const args = ["--files"];
      if (glob) args.push("--glob", glob);
      if (path !== ".") args.push(path);
      const result = await runProcess("rg", args, {
        cwd: workspace.root,
        timeoutMs: 30_000,
        maxOutputChars,
        signal: context.signal,
      });
      if (result.exitCode !== 0 && result.exitCode !== 1)
        return commandError(result, "find failed");
      const lines = result.stdout.split("\n").filter(Boolean);
      return {
        content: lines.slice(0, maxResults).join("\n") || "No files found",
        metadata: {
          backend: "rg",
          totalObserved: lines.length,
          truncated: lines.length > maxResults,
        },
      };
    },
  });

  registry.register({
    definition: definition(
      "ls",
      "List directory",
      "List one workspace directory, including file type and size.",
      {
        type: "object",
        properties: { path: { type: "string" }, limit: { type: "integer", maximum: 2000 } },
        additionalProperties: false,
      },
      "read",
    ),
    async execute(input, context) {
      checkAbort(context?.signal);
      const path = optionalString(input.path) ?? ".";
      const absolute = path === "." ? workspace.root : await workspace.resolvePath(path);
      const entries = await readdir(absolute, { withFileTypes: true });
      checkAbort(context?.signal);
      const limit = boundedInteger(input.limit, 500, 1, 2_000);
      const rendered: string[] = [];
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (context?.signal?.aborted) {
          const error = new Error("Aborted");
          error.name = "AbortError";
          throw error;
        }
        if (rendered.length >= limit) break;
        const entryPath = join(absolute, entry.name);
        const type = entry.isDirectory() ? "d" : entry.isSymbolicLink() ? "l" : "f";
        let size = 0;
        try {
          size = (await stat(entryPath)).size;
        } catch {
          // A racing file may disappear between readdir and stat.
        }
        rendered.push(`${type}\t${String(size).padStart(10)}\t${entry.name}`);
      }
      return {
        content: rendered.join("\n") || "Directory is empty",
        metadata: { path, entries: rendered.length, truncated: entries.length > limit },
      };
    },
  });

  registry.register({
    definition: definition(
      "bash",
      "Shell",
      "Run a shell command in the workspace. Use for builds, tests and repository tooling. Commands are permission-gated.",
      {
        type: "object",
        required: ["command"],
        properties: {
          command: { type: "string" },
          cwd: { type: "string", description: "Optional workspace-relative working directory" },
          timeoutMs: { type: "integer", minimum: 1000, maximum: 600000 },
        },
        additionalProperties: false,
      },
      "shell",
    ),
    async execute(input, context) {
      const command = requiredString(input.command, "command");
      const relativeCwd = optionalString(input.cwd);
      const commandCwd = relativeCwd ? await workspace.resolvePath(relativeCwd) : workspace.root;
      if (!(await stat(commandCwd)).isDirectory())
        throw new Error(`Not a directory: ${relativeCwd}`);
      const timeoutMs = boundedInteger(input.timeoutMs, commandTimeoutMs, 1_000, 600_000);
      const result = options.shellExecutor
        ? await options.shellExecutor.execute({
            command,
            cwd: commandCwd,
            workspaceRoot: workspace.root,
            timeoutMs,
            ...(context.signal ? { signal: context.signal } : {}),
          })
        : await runProcess(shellCommand(command).executable, shellCommand(command).arguments, {
            cwd: commandCwd,
            timeoutMs,
            maxOutputChars,
            signal: context.signal,
          });
      const output = [
        result.stdout ? `stdout:\n${result.stdout}` : "",
        result.stderr ? `stderr:\n${result.stderr}` : "",
        `[exit ${String(result.exitCode)}; ${result.durationMs}ms${result.timedOut ? "; timed out" : ""}]`,
      ]
        .filter(Boolean)
        .join("\n");
      return {
        content: output,
        ...(result.exitCode === 0 ? {} : { isError: true }),
        metadata: {
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
          cwd: relative(workspace.root, commandCwd) || ".",
          backend: result.backend ?? options.shellExecutor?.kind ?? "host",
        },
      };
    },
  });

  registry.register({
    definition: definition(
      "git_status",
      "Git status",
      "Show concise git worktree status without changing repository state.",
      { type: "object", properties: {}, additionalProperties: false },
      "git",
    ),
    async execute(_input, context) {
      const result = await runProcess("git", ["status", "--short", "--branch"], {
        cwd: workspace.root,
        timeoutMs: 30_000,
        maxOutputChars,
        signal: context.signal,
      });
      if (result.exitCode !== 0) return commandError(result, "git status failed");
      return { content: result.stdout || "Working tree clean", metadata: { exitCode: 0 } };
    },
  });

  registry.register({
    definition: definition(
      "git_diff",
      "Git diff",
      "Show a bounded git diff. Set staged=true for the index and optionally provide a path.",
      {
        type: "object",
        properties: { path: { type: "string" }, staged: { type: "boolean" } },
        additionalProperties: false,
      },
      "git",
    ),
    async execute(input, context) {
      const args = ["diff", "--no-ext-diff", "--unified=3"];
      if (input.staged === true) args.push("--cached");
      const path = optionalString(input.path);
      if (path) {
        await workspace.resolvePath(path, { allowMissing: true });
        args.push("--", path);
      }
      const result = await runProcess("git", args, {
        cwd: workspace.root,
        timeoutMs: 30_000,
        maxOutputChars,
        signal: context.signal,
      });
      if (result.exitCode !== 0) return commandError(result, "git diff failed");
      return { content: result.stdout || "No diff", metadata: { exitCode: 0 } };
    },
  });

  registry.register(createWebFetchTool());
  registry.register(
    createWebSearchTool({
      ...(options.searchEndpoint ? { endpoint: options.searchEndpoint } : {}),
    }),
  );

  return registry;
}

let rgAvailabilityOverride: boolean | undefined;
let rgAvailabilityCache: boolean | undefined;

/** Test hook: force the grep/find backend; pass undefined to re-probe rg. */
export function setRgAvailabilityOverride(available: boolean | undefined): void {
  rgAvailabilityOverride = available;
  rgAvailabilityCache = undefined;
}

function rgAvailable(): boolean {
  if (rgAvailabilityOverride !== undefined) return rgAvailabilityOverride;
  if (rgAvailabilityCache === undefined) {
    try {
      const probe = spawnSync("rg", ["--version"], { stdio: "ignore" });
      rgAvailabilityCache = probe.status === 0;
    } catch {
      rgAvailabilityCache = false;
    }
  }
  return rgAvailabilityCache;
}

function definition(
  name: string,
  label: string,
  description: string,
  parameters: Record<string, unknown>,
  effect: ToolDefinition["effect"],
): ToolDefinition {
  return { name, label, description, parameters, effect };
}

export async function runProcess(
  executable: string,
  argumentsValue: string[],
  options: {
    cwd: string;
    input?: string;
    timeoutMs: number;
    maxOutputChars: number;
    signal: AbortSignal | undefined;
  },
): Promise<ProcessResult> {
  const started = Date.now();
  return new Promise((resolvePromise, reject) => {
    const environment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USER: process.env.USER,
      LOGNAME: process.env.LOGNAME,
      SHELL: process.env.SHELL,
      TMPDIR: process.env.TMPDIR,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      LANG: process.env.LANG ?? "C.UTF-8",
      LC_ALL: process.env.LC_ALL,
      TERM: process.env.TERM,
      NO_COLOR: process.env.NO_COLOR,
      CI: process.env.CI ?? "1",
      GIT_TERMINAL_PROMPT: "0",
      PAGER: "cat",
    };
    const child = spawn(executable, argumentsValue, {
      cwd: options.cwd,
      env: environment,
      shell: false,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const append = (current: string, chunk: Buffer): string =>
      appendBounded(current, chunk.toString("utf8"), options.maxOutputChars);
    child.stdout!.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    if (options.input !== undefined) child.stdin?.end(options.input);
    const terminate = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
    };
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    timer.unref();
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      // If aborted by signal, throw AbortError so the caller can distinguish cancellation.
      if (aborted) {
        const error = new Error(
          options.signal?.reason instanceof Error ? options.signal.reason.message : "Aborted",
        );
        error.name = "AbortError";
        reject(error);
        return;
      }
      resolvePromise({
        command: [executable, ...argumentsValue].join(" "),
        exitCode,
        stdout,
        stderr,
        timedOut,
        aborted: false,
        durationMs: Date.now() - started,
      });
    });
  });
}

function shellCommand(command: string): { executable: string; arguments: string[] } {
  if (process.platform === "win32") {
    return {
      executable: "powershell.exe",
      arguments: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
    };
  }
  return { executable: process.env.SHELL ?? "/bin/sh", arguments: ["-lc", command] };
}

function commandError(result: ProcessResult, prefix: string): ToolExecutionResult {
  return {
    content: `${prefix} (exit ${String(result.exitCode)})\n${result.stderr || result.stdout}`,
    isError: true,
    metadata: {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
    },
  };
}

function appendBounded(current: string, addition: string, limit: number): string {
  const next = current + addition;
  if (next.length <= limit) return next;
  const marker = `\n... [output truncated to ${limit} characters] ...\n`;
  const side = Math.max(1, Math.floor((limit - marker.length) / 2));
  return `${next.slice(0, side)}${marker}${next.slice(-side)}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

export function isPathWithin(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  return (
    resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${sep}`)
  );
}
