import { describe, expect, it } from "vitest";
import {
  composeEventSink,
  createHooks,
  dispatchAgentEvent,
  type CompactContext,
  type Notification,
  type PromptSubmitContext,
  type SubagentStopContext,
} from "../src/index.js";
import type { AgentEvent } from "@focuscode/agent-runtime";

/**
 * P2-2: Extend the hook catalogue with 4 new lifecycle hooks that Claude
 * Agent SDK exposes but FocusCode was missing (review §9.5 gap #2).
 *
 * New hooks:
 *   - `preCompact`         — fires when the agent runtime emits a
 *                            `compaction` event, before messages are dropped.
 *   - `userPromptSubmit`   — fires when the integrator submits a prompt via
 *                            `agent.submit()` (called by createCodingAgent).
 *   - `subagentStop`       — fires when a subagent session ends (called by
 *                            integrators that spawn subagents).
 *   - `notification`       — fires on `error` events and other
 *                            notification-worthy signals.
 *
 * Design:
 *   - `preCompact` and `notification` are dispatched from `dispatchAgentEvent`
 *     (event-driven, like `postToolUse` and `stop`).
 *   - `userPromptSubmit` and `subagentStop` are called directly by the
 *     integrator (like `sessionStart` and `sessionEnd`), because they are not
 *     AgentEvent variants.
 */
describe("preCompact hook", () => {
  it("is exported from the SDK entry as a hook name", () => {
    const hooks = createHooks({
      preCompact: async () => {},
    });
    expect(typeof hooks.preCompact).toBe("function");
  });

  it("dispatchAgentEvent invokes preCompact on compaction events", async () => {
    const calls: CompactContext[] = [];
    const hooks = createHooks({
      preCompact: async (ctx) => {
        calls.push(ctx);
      },
    });
    const event: AgentEvent = {
      type: "compaction",
      summary: "dropped 12 messages",
      droppedMessages: 12,
    };
    await dispatchAgentEvent(hooks, event, { cwd: "/repo" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      cwd: "/repo",
      summary: "dropped 12 messages",
      droppedMessages: 12,
    });
  });

  it("composeEventSink routes compaction events to preCompact", async () => {
    const calls: CompactContext[] = [];
    const hooks = createHooks({
      preCompact: async (ctx) => {
        calls.push(ctx);
      },
    });
    const sink = composeEventSink({ cwd: "/repo", hooks });
    const event: AgentEvent = {
      type: "compaction",
      summary: "compacted",
      droppedMessages: 5,
    };
    await sink?.(event);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.droppedMessages).toBe(5);
  });
});

describe("userPromptSubmit hook", () => {
  it("is exported from the SDK entry as a hook name", () => {
    const hooks = createHooks({
      userPromptSubmit: async () => {},
    });
    expect(typeof hooks.userPromptSubmit).toBe("function");
  });

  it("is called directly by the integrator with the prompt text and cwd", async () => {
    const calls: PromptSubmitContext[] = [];
    const hooks = createHooks({
      userPromptSubmit: async (ctx) => {
        calls.push(ctx);
      },
    });
    await hooks.userPromptSubmit?.({ prompt: "fix the bug", cwd: "/repo" });
    expect(calls).toEqual([{ prompt: "fix the bug", cwd: "/repo" }]);
  });

  it("can veto a prompt by returning false (integrator-controlled)", async () => {
    const hooks = createHooks({
      userPromptSubmit: async () => false,
    });
    const result = await hooks.userPromptSubmit?.({ prompt: "x", cwd: "/r" });
    expect(result).toBe(false);
  });

  it("returns undefined (no veto) when the hook is omitted", async () => {
    const hooks = createHooks({});
    const result = await hooks.userPromptSubmit?.({ prompt: "x", cwd: "/r" });
    expect(result).toBeUndefined();
  });
});

describe("subagentStop hook", () => {
  it("is exported from the SDK entry as a hook name", () => {
    const hooks = createHooks({
      subagentStop: async () => {},
    });
    expect(typeof hooks.subagentStop).toBe("function");
  });

  it("is called directly by the integrator with session id and stop reason", async () => {
    const calls: SubagentStopContext[] = [];
    const hooks = createHooks({
      subagentStop: async (ctx) => {
        calls.push(ctx);
      },
    });
    await hooks.subagentStop?.({
      sessionId: "sub-1",
      stopped: "stop",
      cwd: "/repo",
    });
    expect(calls).toEqual([{ sessionId: "sub-1", stopped: "stop", cwd: "/repo" }]);
  });
});

describe("notification hook", () => {
  it("is exported from the SDK entry as a hook name", () => {
    const hooks = createHooks({
      notification: async () => {},
    });
    expect(typeof hooks.notification).toBe("function");
  });

  it("dispatchAgentEvent invokes notification on error events", async () => {
    const calls: Notification[] = [];
    const hooks = createHooks({
      notification: async (msg) => {
        calls.push(msg);
      },
    });
    const event: AgentEvent = { type: "error", message: "model failed" };
    await dispatchAgentEvent(hooks, event, { cwd: "/repo" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      level: "error",
      message: "model failed",
    });
  });

  it("composeEventSink routes error events to notification hook", async () => {
    const calls: Notification[] = [];
    const hooks = createHooks({
      notification: async (n) => {
        calls.push(n);
      },
    });
    const sink = composeEventSink({ cwd: "/repo", hooks });
    await sink?.({ type: "error", message: "boom" });
    expect(calls).toEqual([{ level: "error", message: "boom" }]);
  });
});

describe("createHooks() with all 4 new hooks together", () => {
  it("accepts all 4 new hooks in a single hooks object", () => {
    const hooks = createHooks({
      preCompact: async () => {},
      userPromptSubmit: async () => {},
      subagentStop: async () => {},
      notification: async () => {},
    });
    expect(typeof hooks.preCompact).toBe("function");
    expect(typeof hooks.userPromptSubmit).toBe("function");
    expect(typeof hooks.subagentStop).toBe("function");
    expect(typeof hooks.notification).toBe("function");
  });
});
