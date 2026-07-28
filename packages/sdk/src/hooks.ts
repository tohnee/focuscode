import type { AgentEvent, ToolExecutionResult } from "@focuscode/agent-runtime";

/**
 * Sink function signature — matches `AgentRuntimeOptions["eventSink"]`.
 * Kept as a local type alias so this module doesn't need to depend on the
 * full `AgentRuntimeOptions` surface.
 */
export type EventSink = (event: AgentEvent) => void | Promise<void>;

/**
 * Context passed to {@link AgentHooks.postToolUse} after a tool executes.
 */
export interface PostToolContext {
  /** Tool name (matches `ToolDefinition.name`). */
  toolName: string;
  /** Parsed arguments that were passed to the tool. */
  arguments: Record<string, unknown>;
  /** Working directory of the agent. */
  cwd: string;
  /** Wall-clock duration of the tool execution in milliseconds. */
  durationMs: number;
}

/**
 * Context for session-lifecycle hooks.
 */
export interface SessionContext {
  /** Stable session identifier (matches `AgentRunResult.sessionId`). */
  sessionId: string;
  /** Working directory the agent runs in. */
  cwd: string;
  /** Provider/model identifier (e.g. `kimi/k2`). */
  model: string;
}

/**
 * Reason the agent stopped. Mirrors `AgentRunResult.stopped`.
 */
export type StopReason = "stop" | "tool_use" | "length" | "aborted" | "error" | "max_rounds";

/**
 * Lifecycle hooks for the SDK. Complementary to the existing `beforeTool`
 * veto hook: `beforeTool` decides whether a tool may run; `postToolUse`
 * observes the result. `sessionStart` / `sessionEnd` bracket the session
 * lifecycle, and `stop` fires once per `submit()` call when the agent
 * finishes.
 *
 * Hooks are optional; omit any you don't need. Hook errors propagate to the
 * caller (e.g. via `dispatchAgentEvent` rejection) so the agent loop can
 * observe them — wrap in try/catch inside the hook if you want fail-soft.
 */
export interface AgentHooks {
  /** Called after each tool execution with the call context and result. */
  postToolUse?: (context: PostToolContext, result: ToolExecutionResult) => void | Promise<void>;
  /** Called when a session is created (integrators invoke directly). */
  sessionStart?: (context: SessionContext) => void | Promise<void>;
  /** Called when a session is closed (integrators invoke directly). */
  sessionEnd?: (context: SessionContext) => void | Promise<void>;
  /** Called when the agent stops, with the stop reason. */
  stop?: (reason: StopReason) => void | Promise<void>;
}

/**
 * Identity factory that returns the hooks object as-is. Useful for type
 * narrowing and forward-compatible hook discovery (e.g. a future validator
 * could warn on unknown hook names).
 *
 * @example
 * ```ts
 * const hooks = createHooks({
 *   postToolUse: async (ctx, result) => {
 *     metrics.recordTool(ctx.toolName, ctx.durationMs);
 *   },
 *   stop: async (reason) => {
 *     if (reason === "max_rounds") telemetry.warn("round_ceiling_hit");
 *   },
 * });
 * ```
 */
export function createHooks(hooks: AgentHooks): AgentHooks {
  return hooks;
}

/**
 * Dispatch context for {@link dispatchAgentEvent}.
 */
export interface DispatchContext {
  /** Working directory of the agent, forwarded to `postToolUse`. */
  cwd: string;
}

/**
 * Route an {@link AgentEvent} to the matching {@link AgentHooks} callback.
 *
 * Called by `createCodingAgent` from its composed `eventSink` so integrators
 * can register lifecycle hooks without manually parsing `AgentEvent` variants.
 *
 * Behavior:
 *   - `tool_end` → `postToolUse` (with toolName, arguments, durationMs, result)
 *   - `agent_end` → `stop` (with `AgentRunResult.stopped` as StopReason)
 *   - Other event types are no-ops (no matching hook).
 *   - `sessionStart` / `sessionEnd` are NOT dispatched from events; integrators
 *     call them directly because session lifecycle doesn't emit a unique event.
 *
 * @throws Rethrows any hook error so the agent loop can observe failures.
 */
export async function dispatchAgentEvent(
  hooks: AgentHooks,
  event: AgentEvent,
  context: DispatchContext,
): Promise<void> {
  if (event.type === "tool_end") {
    if (hooks.postToolUse) {
      await hooks.postToolUse(
        {
          toolName: event.call.name,
          arguments: event.call.arguments,
          cwd: context.cwd,
          durationMs: event.durationMs,
        },
        event.result,
      );
    }
    return;
  }
  if (event.type === "agent_end") {
    if (hooks.stop) {
      await hooks.stop(event.response.stopped as StopReason);
    }
    return;
  }
  // No matching hook for other event types.
}

/**
 * Options for {@link composeEventSink}.
 */
export interface ComposeEventSinkOptions {
  /** Working directory, forwarded to `postToolUse` as `ctx.cwd`. */
  cwd: string;
  /** Existing `onEvent` callback from `CreateCodingAgentOptions.onEvent`. */
  onEvent?: ((event: AgentEvent) => void | Promise<void>) | undefined;
  /** Lifecycle hooks to dispatch in addition to `onEvent`. */
  hooks?: AgentHooks | undefined;
}

/**
 * Compose the user-supplied `onEvent` callback and the SDK `hooks` map into a
 * single `eventSink` function suitable for `CodingAgent.create({ eventSink })`.
 *
 * Behavior:
 *   - If neither `onEvent` nor `hooks` is provided, returns `undefined` so the
 *     agent runtime keeps its default no-op sink.
 *   - If only `onEvent` is provided, returns it directly (zero overhead).
 *   - If `hooks` is provided (with or without `onEvent`), returns a sink that
 *     calls `onEvent` first, then `dispatchAgentEvent` for hook routing.
 *   - Hook errors propagate to the caller — wrap them in try/catch inside the
 *     hook if you want fail-soft behavior.
 *
 * This is the wiring layer that makes `CreateCodingAgentOptions.hooks`
 * actually fire — without it the `hooks` option would be silently ignored.
 */
export function composeEventSink(options: ComposeEventSinkOptions): EventSink | undefined {
  const { cwd, onEvent, hooks } = options;
  if (!onEvent && !hooks) return undefined;
  if (!hooks) return onEvent;
  return async (event: AgentEvent) => {
    if (onEvent) await onEvent(event);
    await dispatchAgentEvent(hooks, event, { cwd });
  };
}
