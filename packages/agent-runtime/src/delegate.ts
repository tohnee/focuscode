import { SessionStore } from "./session-store.js";
import { AgentToolRegistry } from "./tools.js";
import type {
  AgentRunResult,
  AgentRuntimeOptions,
  AgentTool,
  ModelClient,
  ModelProfile,
} from "./types.js";

const MAX_TASK_CHARS = 4_000;
const MAX_RESULT_CHARS = 20_000;
const DEFAULT_MAX_ROUNDS = 12;
const MAX_ROUNDS_LIMIT = 20;
/** Tools never handed to a child agent: no nested delegation, no shell. */
const EXCLUDED_TOOLS = new Set(["delegate", "bash", "todo"]);

/** The child-agent surface the delegate tool relies on (CodingAgent satisfies it). */
export interface DelegateRunner {
  submit(input: string, signal?: AbortSignal): Promise<AgentRunResult>;
  abort(reason?: string): boolean;
}

export interface DelegateContext {
  cwd: string;
  model: ModelProfile;
  modelClient: ModelClient;
  registry: AgentToolRegistry;
  permission: AgentRuntimeOptions["permission"];
  instructions?: string[];
  createAgent(options: AgentRuntimeOptions): Promise<DelegateRunner>;
}

/**
 * The `delegate` tool: run one bounded sub-task in a fresh child agent that
 * shares the parent's model, workspace and approval handler, with a trimmed
 * registry (no delegate/bash/todo), an in-memory session and no effect spine.
 * Steering and events stay inside the child; only its final message returns.
 */
export function createDelegateTool(getContext: () => DelegateContext): AgentTool {
  return {
    definition: {
      name: "delegate",
      label: "Delegate sub-task",
      description:
        "Run a self-contained sub-task in a child agent with the same workspace, model and permissions but no shell. Returns the child's final message.",
      parameters: {
        type: "object",
        required: ["task"],
        properties: {
          task: { type: "string", minLength: 1, maxLength: MAX_TASK_CHARS },
          maxRounds: { type: "integer", minimum: 1, maximum: MAX_ROUNDS_LIMIT },
        },
        additionalProperties: false,
      },
      effect: "write",
    },
    async execute(input, context) {
      const task = typeof input.task === "string" ? input.task.trim() : "";
      if (!task || task.length > MAX_TASK_CHARS) {
        throw new Error(`delegate task must be 1-${MAX_TASK_CHARS} characters`);
      }
      const maxRounds = boundedInteger(input.maxRounds, DEFAULT_MAX_ROUNDS, 1, MAX_ROUNDS_LIMIT);
      const parent = getContext();
      const childRegistry = new AgentToolRegistry(
        parent.registry.values().filter((tool) => !EXCLUDED_TOOLS.has(tool.definition.name)),
      );
      const child = await parent.createAgent({
        cwd: parent.cwd,
        model: parent.model,
        modelClient: parent.modelClient,
        tools: childRegistry.values(),
        toolRegistry: childRegistry,
        permission: parent.permission,
        sessionStore: new SessionStore("delegate", false),
        maxRounds,
        ...(parent.instructions?.length ? { instructions: parent.instructions } : {}),
      });
      const result = await child.submit(task, context.signal);
      const body =
        result.content.length > MAX_RESULT_CHARS
          ? `${result.content.slice(0, MAX_RESULT_CHARS)}\n... [truncated to ${MAX_RESULT_CHARS} characters]`
          : result.content;
      const usage = result.usage;
      return {
        content: `${body}\n\n[delegate: ${result.rounds} round(s), ${result.toolCalls} tool call(s), stopped=${result.stopped}, tokens in=${usage.inputTokens} out=${usage.outputTokens}]`,
        metadata: {
          rounds: result.rounds,
          toolCalls: result.toolCalls,
          stopped: result.stopped,
          usage: result.usage,
        },
      };
    },
  };
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}
