import { readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  newId,
  sha256Digest,
  type ArtifactRefV1,
  type EffectObservationV1,
  type ToolSpecV1,
} from "@focuscode/contracts";
import { SafeCommandRunner } from "./command-runner.js";
import { WorkspaceGuard } from "./workspace.js";

export interface ToolExecutionResult {
  observedEffects: EffectObservationV1[];
  artifacts: ArtifactRefV1[];
  before?: `sha256:${string}`;
  after?: `sha256:${string}`;
  output: unknown;
}

export interface ToolExecutor {
  spec: ToolSpecV1;
  /**
   * Execute the tool. When `signal` is provided the executor should abort any
   * in-flight subprocess / network call it owns; executors that cannot cancel
   * may ignore it (the runtime still enforces cancellation between calls).
   */
  execute(argumentsValue: unknown, signal?: AbortSignal): Promise<ToolExecutionResult>;
}

function toolSpec(
  id: string,
  description: string,
  inputSchema: Record<string, unknown>,
  outputSchema: Record<string, unknown>,
  effectClasses: string[],
  idempotency: ToolSpecV1["idempotency"],
  requiredCapabilities: string[],
): ToolSpecV1 {
  return {
    id,
    version: "1.0.0",
    description,
    inputSchema,
    outputSchema,
    schemaDigest: sha256Digest({ id, version: "1.0.0", inputSchema, outputSchema }),
    effectClasses,
    idempotency,
    requiredCapabilities,
  };
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function integerValue(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

async function walkFiles(
  workspace: WorkspaceGuard,
  start: string,
  maxDepth: number,
  maxEntries: number,
): Promise<string[]> {
  const output: string[] = [];
  const ignored = new Set([".git", ".focuscode-state", "node_modules", "dist", "coverage"]);
  const visit = async (relativeDirectory: string, depth: number): Promise<void> => {
    if (depth > maxDepth || output.length >= maxEntries) return;
    const absolute =
      relativeDirectory === "." ? workspace.root : await workspace.resolvePath(relativeDirectory);
    const entries = await readdir(absolute, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (ignored.has(entry.name) || output.length >= maxEntries) continue;
      const path = relativeDirectory === "." ? entry.name : `${relativeDirectory}/${entry.name}`;
      if (entry.isSymbolicLink()) continue;
      output.push(entry.isDirectory() ? `${path}/` : path);
      if (entry.isDirectory()) await visit(path, depth + 1);
    }
  };
  await visit(start, 0);
  return output;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolExecutor>();

  register(tool: ToolExecutor): void {
    if (this.tools.has(tool.spec.id)) throw new Error(`Duplicate tool id: ${tool.spec.id}`);
    this.tools.set(tool.spec.id, tool);
  }

  get(toolId: string): ToolExecutor | undefined {
    return this.tools.get(toolId);
  }

  specs(): ToolSpecV1[] {
    return [...this.tools.values()].map((tool) => tool.spec);
  }
}

export function createLocalToolRegistry(
  workspace: WorkspaceGuard,
  commandRunner: SafeCommandRunner,
): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register({
    spec: toolSpec(
      "repo_tree",
      "List a bounded repository tree without following symlinks.",
      { type: "object", properties: { path: { type: "string" }, maxDepth: { type: "integer" } } },
      { type: "object", properties: { entries: { type: "array", items: { type: "string" } } } },
      ["read"],
      "read",
      ["repo.read"],
    ),
    async execute(value) {
      const input = objectValue(value, "repo_tree arguments");
      const path = typeof input.path === "string" && input.path ? input.path : ".";
      if (path !== ".") await workspace.resolvePath(path);
      const entries = await walkFiles(
        workspace,
        path,
        integerValue(input.maxDepth, 4, 0, 12),
        1_000,
      );
      return {
        observedEffects: [{ class: "read", resource: path, detail: { entries: entries.length } }],
        artifacts: [],
        output: { entries },
      };
    },
  });

  registry.register({
    spec: toolSpec(
      "read_file_range",
      "Read a bounded UTF-8 line range from a workspace file.",
      {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string" },
          startLine: { type: "integer", minimum: 1 },
          endLine: { type: "integer", minimum: 1 },
        },
      },
      { type: "object", properties: { content: { type: "string" }, digest: { type: "string" } } },
      ["read"],
      "read",
      ["repo.read"],
    ),
    async execute(value) {
      const input = objectValue(value, "read_file_range arguments");
      const path = stringValue(input.path, "path");
      const absolute = await workspace.resolvePath(path);
      const info = await stat(absolute);
      if (!info.isFile() || info.size > 2_000_000)
        throw new Error(`File is not a bounded regular file: ${path}`);
      const content = await readFile(absolute, "utf8");
      const lines = content.split("\n");
      const start = integerValue(input.startLine, 1, 1, Math.max(lines.length, 1));
      const end = integerValue(
        input.endLine,
        Math.min(lines.length, start + 199),
        start,
        start + 500,
      );
      const selected = lines.slice(start - 1, end).join("\n");
      return {
        observedEffects: [
          { class: "read", resource: path, detail: { startLine: start, endLine: end } },
        ],
        artifacts: [],
        output: {
          path,
          startLine: start,
          endLine: end,
          content: selected,
          digest: sha256Digest(content),
        },
      };
    },
  });

  registry.register({
    spec: toolSpec(
      "search_text",
      "Search bounded UTF-8 repository files for a literal string.",
      {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string" },
          path: { type: "string" },
          maxResults: { type: "integer" },
        },
      },
      { type: "object", properties: { matches: { type: "array" } } },
      ["read"],
      "read",
      ["repo.read"],
    ),
    async execute(value) {
      const input = objectValue(value, "search_text arguments");
      const query = stringValue(input.query, "query");
      const path = typeof input.path === "string" && input.path ? input.path : ".";
      const maxResults = integerValue(input.maxResults, 100, 1, 500);
      const entries = await walkFiles(workspace, path, 12, 5_000);
      const matches: Array<{ path: string; line: number; text: string }> = [];
      for (const entry of entries) {
        if (entry.endsWith("/") || matches.length >= maxResults) continue;
        try {
          const absolute = await workspace.resolvePath(entry);
          const info = await stat(absolute);
          if (!info.isFile() || info.size > 1_000_000) continue;
          const lines = (await readFile(absolute, "utf8")).split("\n");
          lines.forEach((line, index) => {
            if (matches.length < maxResults && line.includes(query)) {
              matches.push({ path: entry, line: index + 1, text: line.slice(0, 500) });
            }
          });
        } catch {
          // Binary, permission-denied and racing files are skipped and never executed.
        }
      }
      return {
        observedEffects: [
          { class: "read", resource: path, detail: { query, matches: matches.length } },
        ],
        artifacts: [],
        output: { matches, truncated: matches.length >= maxResults },
      };
    },
  });

  registry.register({
    spec: toolSpec(
      "apply_edit_ir",
      "Apply bounded, base-aware search/replace edits and return a normalized effect.",
      {
        type: "object",
        required: ["path", "edits"],
        properties: {
          path: { type: "string" },
          baseHash: { type: "string" },
          edits: {
            type: "array",
            items: {
              type: "object",
              required: ["search", "replace"],
              properties: {
                search: { type: "string" },
                replace: { type: "string" },
                expectedOccurrences: { type: "integer" },
              },
            },
          },
        },
      },
      { type: "object", properties: { path: { type: "string" }, before: {}, after: {} } },
      ["file_write"],
      "conditional",
      ["repo.write"],
    ),
    async execute(value) {
      const input = objectValue(value, "apply_edit_ir arguments");
      const path = stringValue(input.path, "path");
      const absolute = await workspace.resolvePath(path);
      const info = await stat(absolute);
      if (!info.isFile() || info.size > 2_000_000)
        throw new Error(`File is not a bounded regular file: ${path}`);
      const beforeText = await readFile(absolute, "utf8");
      const before = sha256Digest(beforeText);
      if (input.baseHash !== undefined && input.baseHash !== before) {
        throw new Error(
          `Base hash mismatch for ${path}: expected ${String(input.baseHash)}, actual ${before}`,
        );
      }
      if (!Array.isArray(input.edits) || input.edits.length === 0 || input.edits.length > 20) {
        throw new Error("edits must contain 1 to 20 operations");
      }
      let next = beforeText;
      let changedLines = 0;
      for (const [index, rawEdit] of input.edits.entries()) {
        const edit = objectValue(rawEdit, `edit ${index}`);
        const search = stringValue(edit.search, `edit ${index}.search`);
        const replacement = typeof edit.replace === "string" ? edit.replace : undefined;
        if (replacement === undefined) throw new Error(`edit ${index}.replace must be a string`);
        const occurrences = next.split(search).length - 1;
        const expected = integerValue(edit.expectedOccurrences, 1, 1, 1_000);
        if (occurrences !== expected) {
          throw new Error(`Edit ${index} expected ${expected} occurrence(s), found ${occurrences}`);
        }
        next = next.split(search).join(replacement);
        changedLines +=
          Math.max(search.split("\n").length, replacement.split("\n").length) * occurrences;
      }
      if (next === beforeText) throw new Error("Edit produced no change");
      const after = sha256Digest(next);
      const temporary = join(dirname(absolute), `.${basename(absolute)}.${newId("edit")}.tmp`);
      await writeFile(temporary, next, { encoding: "utf8", mode: info.mode });
      await rename(temporary, absolute);
      return {
        observedEffects: [{ class: "file_write", resource: path, detail: { changedLines } }],
        artifacts: [],
        before,
        after,
        output: { path, before, after, changedLines },
      };
    },
  });

  registry.register({
    spec: toolSpec(
      "run_registered_command",
      "Run one owner-registered argv command without a shell.",
      { type: "object", required: ["commandId"], properties: { commandId: { type: "string" } } },
      { type: "object", properties: { exitCode: {}, stdout: {}, stderr: {}, timedOut: {} } },
      ["command"],
      "conditional",
      ["process.registered"],
    ),
    async execute(value) {
      const input = objectValue(value, "run_registered_command arguments");
      const commandId = stringValue(input.commandId, "commandId");
      const result = await commandRunner.run(commandId);
      return {
        observedEffects: [
          {
            class: "command",
            resource: commandId,
            detail: { exitCode: result.exitCode, timedOut: result.timedOut },
          },
        ],
        artifacts: [],
        output: result,
      };
    },
  });

  return registry;
}
