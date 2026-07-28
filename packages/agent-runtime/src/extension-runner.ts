import { createInterface } from "node:readline";
import { inspect } from "node:util";
import { pathToFileURL } from "node:url";
import type {
  AgentExtensionApi,
  BeforeToolContext,
  BeforeToolHook,
  BeforeToolResult,
  ExtensionCommand,
} from "./extensions.js";
import type { AgentEvent, AgentTool, ToolDefinition, ToolExecutionResult } from "./types.js";

/**
 * Child-process entrypoint for ProcessExtensionHost. Spawned as
 * `node extension-runner.js <extension-entry>`; imports the extension module,
 * wires AgentExtensionApi calls to JSON-RPC messages on stdout (one JSON
 * object per line) and dispatches parent requests read line-wise from stdin.
 *
 * Runtime imports must stay limited to node builtins: this file runs in a
 * bare child process and type-only imports are erased at build time.
 */

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
  | { type: "beforeToolCheck"; id: string; context: BeforeToolContext }
  | { type: "cancel"; id: string };

type ChildToParent =
  | { type: "registerTool"; definition: ToolDefinition }
  | { type: "registerCommand"; name: string; description: string }
  | { type: "appendSystemPrompt"; fragment: string }
  | { type: "subscribeEvents" }
  | { type: "ready"; name?: string }
  | { type: "error"; message: string }
  | { type: "toolResult"; id: string; result?: ToolExecutionResult; error?: string }
  | { type: "commandResult"; id: string; result?: string | null; error?: string }
  | { type: "beforeToolResult"; id: string; result?: BeforeToolResult; error?: string }
  | { type: "log"; message: string };

const tools = new Map<string, AgentTool>();
const commands = new Map<string, ExtensionCommand>();
const listeners: Array<(event: AgentEvent) => void | Promise<void>> = [];
const beforeToolHooks: BeforeToolHook[] = [];
const executions = new Map<string, AbortController>();

// stdout is protocol-owned; redirect extension logging to stderr so stray
// console output cannot corrupt the JSON-RPC stream.
for (const method of ["log", "info", "warn", "error", "debug"] as const) {
  console[method] = (...values: unknown[]) => {
    process.stderr.write(`${values.map(renderValue).join(" ")}\n`);
  };
}

function renderValue(value: unknown): string {
  return typeof value === "string" ? value : inspect(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function send(message: ChildToParent): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function exitProcess(code: number): void {
  // Flush buffered protocol writes before exiting so the host sees them.
  process.stdout.write("", () => process.exit(code));
}

async function handleMessage(message: ParentToChild): Promise<void> {
  switch (message.type) {
    case "toolExecute": {
      const tool = tools.get(message.name);
      if (!tool) {
        send({
          type: "toolResult",
          id: message.id,
          error: `Unknown extension tool: ${message.name}`,
        });
        return;
      }
      const controller = new AbortController();
      executions.set(message.id, controller);
      try {
        const result = await tool.execute(message.arguments, {
          cwd: message.cwd,
          signal: controller.signal,
        });
        send({ type: "toolResult", id: message.id, result });
      } catch (error) {
        send({ type: "toolResult", id: message.id, error: errorMessage(error) });
      } finally {
        executions.delete(message.id);
      }
      return;
    }
    case "commandExecute": {
      const command = commands.get(message.name);
      if (!command) {
        send({
          type: "commandResult",
          id: message.id,
          error: `Unknown extension command: ${message.name}`,
        });
        return;
      }
      try {
        const result = await command.execute(message.args, message.context);
        send({ type: "commandResult", id: message.id, result: result ?? null });
      } catch (error) {
        send({ type: "commandResult", id: message.id, error: errorMessage(error) });
      }
      return;
    }
    case "event": {
      for (const listener of listeners) {
        try {
          await listener(message.event);
        } catch (error) {
          process.stderr.write(`extension event listener failed: ${errorMessage(error)}\n`);
        }
      }
      return;
    }
    case "beforeToolCheck": {
      process.stderr.write(
        `[beforeTool] recv tool=${message.context.toolName} hooks=${beforeToolHooks.length}\n`,
      );
      let result: BeforeToolResult | undefined;
      for (let i = 0; i < beforeToolHooks.length; i++) {
        try {
          const hookResult = await beforeToolHooks[i]!(message.context);
          process.stderr.write(
            `[beforeTool] hook index=${i} allow=${hookResult.allow} reason=${hookResult.reason ?? ""}\n`,
          );
          if (!hookResult.allow) {
            result = hookResult;
            break;
          }
        } catch (error) {
          process.stderr.write(`[beforeTool] hook index=${i} error=${errorMessage(error)}\n`);
        }
      }
      process.stderr.write(
        `[beforeTool] response reqId=${message.id} allow=${result ? !result.allow : true}\n`,
      );
      send({
        type: "beforeToolResult",
        id: message.id,
        ...(result ? { result } : {}),
      });
      return;
    }
    case "cancel":
      executions.get(message.id)?.abort();
      return;
  }
}

async function main(): Promise<void> {
  const entryPath = process.argv[2];
  if (!entryPath) {
    send({ type: "error", message: "extension-runner requires an extension entry path" });
    exitProcess(1);
    return;
  }

  const api: AgentExtensionApi = {
    registerTool(tool: AgentTool) {
      tools.set(tool.definition.name, tool);
      send({ type: "registerTool", definition: tool.definition });
    },
    registerCommand(command: ExtensionCommand) {
      commands.set(command.name, command);
      send({ type: "registerCommand", name: command.name, description: command.description });
    },
    onEvent(listener: (event: AgentEvent) => void | Promise<void>) {
      listeners.push(listener);
      send({ type: "subscribeEvents" });
    },
    appendSystemPrompt(fragment: string) {
      send({ type: "appendSystemPrompt", fragment });
    },
    beforeTool(hook: BeforeToolHook) {
      beforeToolHooks.push(hook);
    },
  };

  const lines = createInterface({ input: process.stdin });
  // Messages are dispatched as they arrive. Listener side effects of a sync
  // onEvent handler still run before the next message is handled, because an
  // async handler runs synchronously up to its first await.
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message: ParentToChild;
    try {
      message = JSON.parse(line) as ParentToChild;
    } catch (error) {
      send({ type: "log", message: `ignored malformed host message: ${errorMessage(error)}` });
      return;
    }
    void handleMessage(message);
  });
  // Parent closed stdin (parent exited or disposed): do not linger.
  lines.on("close", () => exitProcess(0));

  let moduleRecord: Record<string, unknown>;
  try {
    moduleRecord = (await import(pathToFileURL(entryPath).href)) as Record<string, unknown>;
  } catch (error) {
    send({ type: "error", message: `Extension import failed: ${errorMessage(error)}` });
    exitProcess(1);
    return;
  }
  const factory = moduleRecord.default;
  if (typeof factory !== "function") {
    send({ type: "error", message: `Extension must export a default function: ${entryPath}` });
    exitProcess(1);
    return;
  }
  try {
    await (factory as (extensionApi: AgentExtensionApi) => void | Promise<void>)(api);
  } catch (error) {
    send({ type: "error", message: `Extension activation failed: ${errorMessage(error)}` });
    exitProcess(1);
    return;
  }
  send({
    type: "ready",
    ...(typeof moduleRecord.name === "string" ? { name: moduleRecord.name } : {}),
  });
}

await main();
