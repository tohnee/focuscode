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
 * Context passed to {@link AgentHooks.preCompact} when the agent runtime
 * emits a `compaction` event. The hook fires as the compaction happens —
 * integrators can observe the summary and dropped-message count.
 */
export interface CompactContext {
  /** Working directory of the agent. */
  cwd: string;
  /** Human-readable summary produced by the compactor. */
  summary: string;
  /** Number of messages dropped by the compaction. */
  droppedMessages: number;
}

/**
 * Context passed to {@link AgentHooks.userPromptSubmit} when the integrator
 * submits a prompt via `agent.submit()`. The hook may return `false` to veto
 * the submission (integrator-controlled gate).
 */
export interface PromptSubmitContext {
  /** The prompt text the user submitted. */
  prompt: string;
  /** Working directory of the agent. */
  cwd: string;
}

/**
 * Context passed to {@link AgentHooks.subagentStop} when a subagent session
 * ends. Integrators that spawn subagents call this hook directly.
 */
export interface SubagentStopContext {
  /** Subagent session identifier. */
  sessionId: string;
  /** Reason the subagent stopped (mirrors `AgentRunResult.stopped`). */
  stopped: StopReason;
  /** Working directory of the subagent. */
  cwd: string;
}

/**
 * Notification payload passed to {@link AgentHooks.notification}. Currently
 * fired on `error` AgentEvents; the level reflects the event severity.
 */
export interface Notification {
  /** Notification level. */
  level: "info" | "warn" | "error";
  /** Notification message. */
  message: string;
}

/**
 * Lifecycle hooks for the SDK. Complementary to the existing `beforeTool`
 * veto hook: `beforeTool` decides whether a tool may run; `postToolUse`
 * observes the result. `sessionStart` / `sessionEnd` bracket the session
 * lifecycle, and `stop` fires once per `submit()` call when the agent
 * finishes.
 *
 * New hooks (P2-2, review §9.5 gap #2):
 *   - `preCompact`         — fires on `compaction` events.
 *   - `userPromptSubmit`   — fires when the integrator submits a prompt.
 *                            May return `false` to veto.
 *   - `subagentStop`       — fires when a subagent session ends.
 *   - `notification`       — fires on `error` events.
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
  /** Called when the agent runtime emits a compaction event. */
  preCompact?: (context: CompactContext) => void | Promise<void>;
  /**
   * Called when the integrator submits a prompt via `agent.submit()`.
   * Return `false` to veto the submission; any other return value (including
   * `undefined`) allows it.
   */
  userPromptSubmit?: (context: PromptSubmitContext) => boolean | void | Promise<boolean | void>;
  /** Called when a subagent session ends (integrators invoke directly). */
  subagentStop?: (context: SubagentStopContext) => void | Promise<void>;
  /** Called on notification-worthy events (e.g. `error`). */
  notification?: (notification: Notification) => void | Promise<void>;
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
 *   - `compaction` → `preCompact` (with summary, droppedMessages, cwd)
 *   - `error` → `notification` (with level "error" and the message)
 *   - Other event types are no-ops (no matching hook).
 *   - `sessionStart` / `sessionEnd` / `userPromptSubmit` / `subagentStop` are
 *     NOT dispatched from events; integrators call them directly because
 *     session/prompt/subagent lifecycle doesn't emit a unique event.
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
  if (event.type === "compaction") {
    if (hooks.preCompact) {
      await hooks.preCompact({
        cwd: context.cwd,
        summary: event.summary,
        droppedMessages: event.droppedMessages,
      });
    }
    return;
  }
  if (event.type === "error") {
    if (hooks.notification) {
      await hooks.notification({ level: "error", message: event.message });
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
