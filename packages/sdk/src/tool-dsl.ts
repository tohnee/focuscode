import type {
  AgentTool,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
} from "@focuscode/agent-runtime";

/**
 * Options for the {@link tool} DSL helper.
 */
export interface ToolOptions {
  /** Human-readable description shown to the model. Defaults to the name. */
  description?: string;
  /** Side-effect classification; defaults to "read". */
  effect?: ToolDefinition["effect"];
  /** Display label; defaults to the name. */
  label?: string;
}

/**
 * One-line process-in tool definition. Wraps the {@link AgentTool} interface
 * so integrators can register a custom tool without implementing the full
 * interface by hand.
 *
 * @example
 * ```ts
 * const echo = tool(
 *   "echo",
 *   { type: "object", properties: { message: { type: "string" } } },
 *   async (args) => ({ content: String(args.message ?? "") }),
 * );
 * registry.register(echo);
 * ```
 *
 * @param name - Tool name (must match `^[a-z][a-z0-9_]*$`).
 * @param parameters - JSON Schema describing the tool parameters.
 * @param handler - Async function receiving parsed arguments and execution context.
 * @param options - Optional description, effect, label overrides.
 */
export function tool(
  name: string,
  parameters: Record<string, unknown>,
  handler: (
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ) => Promise<ToolExecutionResult>,
  options?: ToolOptions,
): AgentTool {
  const definition: ToolDefinition = {
    name,
    label: options?.label ?? name,
    description: options?.description ?? name,
    parameters,
    effect: options?.effect ?? "read",
  };
  return {
    definition,
    async execute(args, ctx) {
      return handler(args, ctx);
    },
  };
}
