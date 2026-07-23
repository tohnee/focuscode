import { spawn, type ChildProcess } from "node:child_process";
import { basename } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { ExtensionCommand, ExtensionHostLike, LoadedExtension } from "./extensions.js";
import type { AgentToolRegistry } from "./tools.js";
import type { AgentEvent, AgentTool, ToolDefinition, ToolExecutionResult } from "./types.js";

export interface ProcessExtensionHostOptions {
  /** Per tool/command execution budget. Default 60_000 ms. */
  toolTimeoutMs?: number;
  /** Budget for an extension child process to become ready. Default 30_000 ms. */
  loadTimeoutMs?: number;
  /** Runner entrypoint override; defaults to the built extension-runner.js next to this file. */
  runnerPath?: string;
}

type ChildToParent =
  | { type: "registerTool"; definition: ToolDefinition }
  | { type: "registerCommand"; name: string; description: string }
  | { type: "appendSystemPrompt"; fragment: string }
  | { type: "subscribeEvents" }
  | { type: "ready"; name?: string }
  | { type: "error"; message: string }
  | { type: "toolResult"; id: string; result?: ToolExecutionResult; error?: string }
  | { type: "commandResult"; id: string; result?: string | null; error?: string }
  | { type: "log"; message: string };

type ParentToChild =
  | {
      type: "toolExecute";
      id: string;
      name: string;
      arguments: Record<string, unknown>;
      cwd: string;
    }
  | {
      type: "commandExecute";
      id: string;
      name: string;
      args: string;
      context: { sessionId: string; cwd: string };
    }
  | { type: "event"; event: AgentEvent }
  | { type: "cancel"; id: string };

/** Request payloads the host can invoke on a child; the id is added on send. */
type InvocationMessage =
  | {
      type: "toolExecute";
      name: string;
      arguments: Record<string, unknown>;
      cwd: string;
    }
  | {
      type: "commandExecute";
      name: string;
      args: string;
      context: { sessionId: string; cwd: string };
    };

interface PendingRequest {
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout | undefined;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
}

interface ExtensionProcess {
  path: string;
  name: string;
  child: ChildProcess;
  status: "starting" | "running" | "dead";
  wantsEvents: boolean;
  toolNames: string[];
  pending: Map<string, PendingRequest>;
  settleReady: { resolve(): void; reject(error: Error): void } | undefined;
  failure: Error | undefined;
}

const DEFAULT_RUNNER_PATH = fileURLToPath(new URL("./extension-runner.js", import.meta.url));

/**
 * Extension host that runs every extension in its own Node child process and
 * talks JSON-RPC over stdio (one JSON object per line). This provides
 * reliability isolation — a crashing extension cannot take down the agent —
 * and a hook point for runtime permission enforcement. It is not a security
 * sandbox: children run with the user's permissions, so extensions remain
 * explicitly trusted code.
 */
export class ProcessExtensionHost implements ExtensionHostLike {
  private readonly registry: AgentToolRegistry;
  private readonly baseToolNames: Set<string>;
  private readonly toolTimeoutMs: number;
  private readonly loadTimeoutMs: number;
  private readonly runnerPath: string;
  private readonly commands = new Map<
    string,
    { command: ExtensionCommand; owner: ExtensionProcess }
  >();
  private readonly promptFragments: Array<{ owner: ExtensionProcess; fragment: string }> = [];
  private readonly extensions: ExtensionProcess[] = [];
  private paths: string[] = [];
  private requestCounter = 0;

  constructor(registry: AgentToolRegistry, options: ProcessExtensionHostOptions = {}) {
    this.registry = registry;
    this.baseToolNames = new Set(registry.definitions().map((tool) => tool.name));
    this.toolTimeoutMs = options.toolTimeoutMs ?? 60_000;
    this.loadTimeoutMs = options.loadTimeoutMs ?? 30_000;
    this.runnerPath = options.runnerPath ?? DEFAULT_RUNNER_PATH;
    // Last-resort cleanup so extension children never outlive the CLI process.
    process.once("exit", this.killAllOnExit);
  }

  async load(paths: string[]): Promise<LoadedExtension[]> {
    this.paths = [...new Set([...this.paths, ...paths])];
    for (const path of paths) {
      const extension = this.spawnExtension(path);
      this.extensions.push(extension);
      try {
        await this.waitReady(extension);
      } catch (error) {
        this.discardExtension(extension);
        throw new Error(
          `Failed to load extension ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return this.list();
  }

  async reload(): Promise<LoadedExtension[]> {
    const paths = [...this.paths];
    await this.stopAll();
    this.paths = [];
    return this.load(paths);
  }

  async dispose(): Promise<void> {
    await this.stopAll();
    this.paths = [];
    process.removeListener("exit", this.killAllOnExit);
  }

  list(): LoadedExtension[] {
    return this.extensions.map((extension) => ({
      path: extension.path,
      name: extension.name,
      ...(extension.child.pid !== undefined ? { pid: extension.child.pid } : {}),
      status: extension.status === "dead" ? ("dead" as const) : ("running" as const),
    }));
  }

  commandList(): ExtensionCommand[] {
    return [...this.commands.values()].map((entry) => entry.command);
  }

  getCommand(name: string): ExtensionCommand | undefined {
    return this.commands.get(name)?.command;
  }

  systemPrompt(): string {
    return this.promptFragments.map((entry) => entry.fragment).join("\n\n");
  }

  async emit(event: AgentEvent): Promise<void> {
    for (const extension of this.extensions) {
      if (extension.status !== "running" || !extension.wantsEvents) continue;
      this.send(extension, { type: "event", event });
    }
  }

  private spawnExtension(path: string): ExtensionProcess {
    const child = spawn(process.execPath, [this.runnerPath, path], {
      env: extensionEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const extension: ExtensionProcess = {
      path,
      name: basename(path),
      child,
      status: "starting",
      wantsEvents: false,
      toolNames: [],
      pending: new Map(),
      settleReady: undefined,
      failure: undefined,
    };
    if (child.stdout) {
      createInterface({ input: child.stdout }).on("line", (line) =>
        this.handleLine(extension, line),
      );
    }
    if (child.stderr) {
      createInterface({ input: child.stderr }).on("line", (line) => {
        process.stderr.write(`[ext:${extension.name}] ${line}\n`);
      });
    }
    child.stdin?.on("error", () => {
      // EPIPE when the child dies mid-write; the exit handler updates state.
    });
    child.once("error", (error) => this.markDead(extension, error));
    child.once("exit", (code, signal) => {
      this.markDead(
        extension,
        new Error(`extension process exited (code ${String(code)}, signal ${String(signal)})`),
      );
    });
    return extension;
  }

  private async waitReady(extension: ExtensionProcess): Promise<void> {
    if (extension.status === "dead") {
      throw extension.failure ?? new Error(`extension process ${extension.name} failed to start`);
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        extension.settleReady = undefined;
        this.terminate(extension.child);
        reject(
          new Error(
            `extension ${extension.name} did not become ready within ${this.loadTimeoutMs}ms`,
          ),
        );
      }, this.loadTimeoutMs);
      timer.unref();
      extension.settleReady = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
    });
  }

  private handleLine(extension: ExtensionProcess, line: string): void {
    if (!line.trim()) return;
    let message: ChildToParent;
    try {
      message = JSON.parse(line) as ChildToParent;
    } catch {
      // Stray output from the extension (stdout is protocol-owned): forward as a log line.
      process.stderr.write(`[ext:${extension.name}] ${line}\n`);
      return;
    }
    try {
      this.handleMessage(extension, message);
    } catch (error) {
      // Registration/validation failure: stop the child and fail its pending load.
      extension.failure = error instanceof Error ? error : new Error(String(error));
      this.terminate(extension.child);
      this.markDead(extension, extension.failure);
    }
  }

  private handleMessage(extension: ExtensionProcess, message: ChildToParent): void {
    switch (message.type) {
      case "registerTool": {
        const tool = this.wrapTool(extension, message.definition);
        this.registry.register(tool);
        extension.toolNames.push(message.definition.name);
        return;
      }
      case "registerCommand": {
        if (!/^[a-z][a-z0-9_-]{0,63}$/.test(message.name)) {
          throw new Error(`Invalid extension command name: ${message.name}`);
        }
        if (this.commands.has(message.name)) {
          throw new Error(`Duplicate extension command: ${message.name}`);
        }
        this.commands.set(message.name, {
          command: this.wrapCommand(extension, message.name, message.description),
          owner: extension,
        });
        return;
      }
      case "appendSystemPrompt": {
        const trimmed = message.fragment.trim();
        if (trimmed) this.promptFragments.push({ owner: extension, fragment: trimmed });
        return;
      }
      case "subscribeEvents":
        extension.wantsEvents = true;
        return;
      case "ready":
        extension.status = "running";
        if (typeof message.name === "string" && message.name.trim()) {
          extension.name = message.name;
        }
        extension.settleReady?.resolve();
        extension.settleReady = undefined;
        return;
      case "error":
        this.markDead(extension, new Error(message.message));
        return;
      case "toolResult":
      case "commandResult":
        this.settlePending(extension, message);
        return;
      case "log":
        process.stderr.write(`[ext:${extension.name}] ${message.message}\n`);
        return;
    }
  }

  private settlePending(
    extension: ExtensionProcess,
    message: { id: string; result?: unknown; error?: string },
  ): void {
    const pending = extension.pending.get(message.id);
    if (!pending) return;
    extension.pending.delete(message.id);
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
    if (message.error !== undefined) pending.reject(new Error(message.error));
    else pending.resolve(message.result ?? null);
  }

  private wrapTool(extension: ExtensionProcess, definition: ToolDefinition): AgentTool {
    return {
      definition,
      execute: async (argumentsValue, context): Promise<ToolExecutionResult> => {
        try {
          const result = await this.invoke(
            extension,
            {
              type: "toolExecute",
              name: definition.name,
              arguments: argumentsValue,
              cwd: context.cwd,
            },
            context.signal,
          );
          if (!result || typeof (result as ToolExecutionResult).content !== "string") {
            throw new Error("extension returned an invalid tool result");
          }
          return result as ToolExecutionResult;
        } catch (error) {
          return {
            content: `Extension tool failed: ${error instanceof Error ? error.message : String(error)}`,
            isError: true,
          };
        }
      },
    };
  }

  private wrapCommand(
    extension: ExtensionProcess,
    name: string,
    description: string,
  ): ExtensionCommand {
    return {
      name,
      description,
      execute: async (args, context) => {
        const result = await this.invoke(
          extension,
          { type: "commandExecute", name, args, context },
          undefined,
        );
        if (result === null) return undefined;
        if (typeof result !== "string") {
          throw new Error("extension returned an invalid command result");
        }
        return result;
      },
    };
  }

  private invoke(
    extension: ExtensionProcess,
    message: InvocationMessage,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    if (extension.status !== "running") {
      return Promise.reject(new Error(`extension ${extension.name} is not running`));
    }
    if (!extension.child.stdin?.writable) {
      return Promise.reject(new Error(`extension ${extension.name} stdin is closed`));
    }
    const id = `req-${++this.requestCounter}`;
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = {
        resolve,
        reject,
        timer: undefined,
        signal,
        onAbort: undefined,
      };
      const cancel = () => this.send(extension, { type: "cancel", id });
      const timer = setTimeout(() => {
        extension.pending.delete(id);
        cancel();
        reject(new Error(`extension ${extension.name} timed out after ${this.toolTimeoutMs}ms`));
      }, this.toolTimeoutMs);
      timer.unref();
      pending.timer = timer;
      if (signal) {
        if (signal.aborted) {
          cancel();
          reject(new Error(`extension ${extension.name} execution aborted`));
          return;
        }
        const onAbort = () => {
          extension.pending.delete(id);
          clearTimeout(timer);
          cancel();
          reject(new Error(`extension ${extension.name} execution aborted`));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        pending.onAbort = onAbort;
      }
      extension.pending.set(id, pending);
      this.send(extension, { ...message, id });
    });
  }

  private send(extension: ExtensionProcess, message: ParentToChild): void {
    if (!extension.child.stdin?.writable) return;
    extension.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private markDead(extension: ExtensionProcess, cause: Error): void {
    if (extension.status === "dead") return;
    extension.status = "dead";
    const error = extension.failure ?? cause;
    extension.failure = error;
    for (const pending of extension.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      if (pending.signal && pending.onAbort) {
        pending.signal.removeEventListener("abort", pending.onAbort);
      }
      pending.reject(error);
    }
    extension.pending.clear();
    extension.settleReady?.reject(error);
    extension.settleReady = undefined;
  }

  /** Remove a failed extension during load, including its partial registrations. */
  private discardExtension(extension: ExtensionProcess): void {
    this.terminate(extension.child);
    for (const name of extension.toolNames) this.registry.unregister(name);
    for (const [commandName, entry] of this.commands) {
      if (entry.owner === extension) this.commands.delete(commandName);
    }
    for (let index = this.promptFragments.length - 1; index >= 0; index -= 1) {
      if (this.promptFragments[index]?.owner === extension) this.promptFragments.splice(index, 1);
    }
    const at = this.extensions.indexOf(extension);
    if (at >= 0) this.extensions.splice(at, 1);
  }

  private async stopAll(): Promise<void> {
    await Promise.all(
      this.extensions.map(async (extension) => {
        this.markDead(extension, new Error("extension host stopped"));
        await this.killAndWait(extension.child);
      }),
    );
    this.extensions.length = 0;
    for (const tool of this.registry.definitions()) {
      if (!this.baseToolNames.has(tool.name)) this.registry.unregister(tool.name);
    }
    this.commands.clear();
    this.promptFragments.length = 0;
  }

  private terminate(child: ChildProcess): void {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill("SIGTERM");
    } catch {
      return;
    }
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 1_000).unref();
  }

  private async killAndWait(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(force);
        clearTimeout(cap);
        resolve();
      };
      const force = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 1_000);
      const cap = setTimeout(done, 3_000);
      child.once("exit", done);
      try {
        child.kill("SIGTERM");
      } catch {
        done();
      }
    });
  }

  private readonly killAllOnExit = (): void => {
    for (const extension of this.extensions) {
      try {
        extension.child.kill("SIGKILL");
      } catch {
        // Child already gone.
      }
    }
  };
}

/**
 * Minimal environment for extension children, mirroring the tool subprocess
 * whitelist: model credentials and other parent secrets are not inherited.
 */
function extensionEnvironment(): NodeJS.ProcessEnv {
  return {
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
}
