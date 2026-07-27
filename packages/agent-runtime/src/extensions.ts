import { pathToFileURL } from "node:url";
import type { AgentToolRegistry } from "./tools.js";
import type { AgentEvent, AgentTool, ToolExecutionResult } from "./types.js";

export interface ExtensionCommandContext {
  sessionId: string;
  cwd: string;
}

export interface ExtensionCommand {
  name: string;
  description: string;
  execute(args: string, context: ExtensionCommandContext): Promise<string | void> | string | void;
}

export interface BeforeToolContext {
  toolName: string;
  arguments: Record<string, unknown>;
  cwd: string;
}

export interface BeforeToolResult {
  /** Return { allow: false, reason: "..." } to veto execution. */
  allow: boolean;
  reason?: string;
}

export type BeforeToolHook = (
  context: BeforeToolContext,
) => BeforeToolResult | Promise<BeforeToolResult>;

export interface AgentExtensionApi {
  registerTool(tool: AgentTool): void;
  registerCommand(command: ExtensionCommand): void;
  onEvent(listener: (event: AgentEvent) => void | Promise<void>): void;
  appendSystemPrompt(fragment: string): void;
  /**
   * Register a hook called before each tool execution. Return {allow:false}
   * to veto execution - the tool call is rejected and the reason is returned
   * to the model as an error result. Hooks are called in registration order;
   * the first veto wins.
   */
  beforeTool(hook: BeforeToolHook): void;
}

export interface LoadedExtension {
  path: string;
  name: string;
  /** Present for process-isolated extensions: child pid and lifecycle state. */
  pid?: number;
  status?: "running" | "dead";
}

/**
 * Shared surface of the in-process ExtensionHost and the process-isolated
 * ProcessExtensionHost. Consumers should program against this interface.
 */
export interface ExtensionHostLike {
  load(paths: string[]): Promise<LoadedExtension[]>;
  reload(): Promise<LoadedExtension[]>;
  list(): LoadedExtension[];
  commandList(): ExtensionCommand[];
  getCommand(name: string): ExtensionCommand | undefined;
  systemPrompt(): string;
  emit(event: AgentEvent): Promise<void>;
  /**
   * Check beforeTool hooks for a pending tool call. Returns the first veto
   * result, or undefined if all hooks allow execution. Hooks that throw are
   * treated as allow (fail-open) to avoid blocking the agent loop on
   * buggy extensions.
   */
  checkBeforeTool?(context: BeforeToolContext): Promise<BeforeToolResult | undefined>;
  /** Release host resources (child processes for the process host). No-op in-process. */
  dispose?(): void | Promise<void>;
}

type ExtensionFactory = (api: AgentExtensionApi) => void | Promise<void>;

export class ExtensionHost implements ExtensionHostLike {
  private readonly commands = new Map<string, ExtensionCommand>();
  private readonly listeners: Array<(event: AgentEvent) => void | Promise<void>> = [];
  private readonly promptFragments: string[] = [];
  private readonly beforeToolHooks: BeforeToolHook[] = [];
  private readonly loaded: LoadedExtension[] = [];
  private readonly baseToolNames: Set<string>;
  private paths: string[] = [];

  constructor(private readonly registry: AgentToolRegistry) {
    this.baseToolNames = new Set(registry.definitions().map((tool) => tool.name));
  }

  async load(paths: string[]): Promise<LoadedExtension[]> {
    this.paths = [...new Set([...this.paths, ...paths])];
    for (const path of paths) {
      const url = `${pathToFileURL(path).href}?focuscode_reload=${Date.now()}`;
      const moduleValue: unknown = await import(url);
      const moduleRecord = moduleValue as Record<string, unknown>;
      const factory = moduleRecord.default;
      if (typeof factory !== "function") {
        throw new Error(`Extension must export a default function: ${path}`);
      }
      await (factory as ExtensionFactory)(this.api());
      this.loaded.push({
        path,
        name:
          typeof moduleRecord.name === "string"
            ? moduleRecord.name
            : (path.split(/[\\/]/).pop() ?? path),
      });
    }
    return this.list();
  }

  async reload(): Promise<LoadedExtension[]> {
    const paths = [...this.paths];
    for (const tool of this.registry.definitions()) {
      if (!this.baseToolNames.has(tool.name)) this.registry.unregister(tool.name);
    }
    this.commands.clear();
    this.listeners.length = 0;
    this.promptFragments.length = 0;
    this.loaded.length = 0;
    this.paths = [];
    return this.load(paths);
  }

  list(): LoadedExtension[] {
    return this.loaded.map((extension) => ({ ...extension }));
  }

  commandList(): ExtensionCommand[] {
    return [...this.commands.values()];
  }

  getCommand(name: string): ExtensionCommand | undefined {
    return this.commands.get(name);
  }

  systemPrompt(): string {
    return this.promptFragments.join("\n\n");
  }

  async emit(event: AgentEvent): Promise<void> {
    for (const listener of this.listeners) await listener(event);
  }

  dispose(): void {
    // In-process extensions share the host process; nothing to release.
  }

  private api(): AgentExtensionApi {
    return {
      registerTool: (tool) => this.registry.register(wrapExtensionTool(tool)),
      registerCommand: (command) => {
        if (!/^[a-z][a-z0-9_-]{0,63}$/.test(command.name)) {
          throw new Error(`Invalid extension command name: ${command.name}`);
        }
        if (this.commands.has(command.name)) {
          throw new Error(`Duplicate extension command: ${command.name}`);
        }
        this.commands.set(command.name, command);
      },
      onEvent: (listener) => this.listeners.push(listener),
      appendSystemPrompt: (fragment) => {
        const trimmed = fragment.trim();
        if (trimmed) this.promptFragments.push(trimmed);
      },
      beforeTool: (hook) => this.beforeToolHooks.push(hook),
    };
  }

  async checkBeforeTool(context: BeforeToolContext): Promise<BeforeToolResult | undefined> {
    for (const hook of this.beforeToolHooks) {
      try {
        const result = await hook(context);
        if (!result.allow) return result;
      } catch {
        // Buggy hook: fail-open (allow execution) to avoid blocking the agent.
      }
    }
    return undefined;
  }
}

function wrapExtensionTool(tool: AgentTool): AgentTool {
  return {
    definition: tool.definition,
    async execute(argumentsValue, context): Promise<ToolExecutionResult> {
      try {
        return await tool.execute(argumentsValue, context);
      } catch (error) {
        return {
          content: `Extension tool failed: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }
    },
  };
}
