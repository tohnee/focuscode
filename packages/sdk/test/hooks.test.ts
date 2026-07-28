import { describe, expect, it } from "vitest";
import {
  composeEventSink,
  createHooks,
  dispatchAgentEvent,
  type AgentHooks,
  type PostToolContext,
  type SessionContext,
} from "../src/index.js";
import type { AgentEvent, ToolExecutionResult } from "@focuscode/agent-runtime";

/**
 * P2-3: 扩展 hooks (PostToolUse/SessionStart/SessionEnd/Stop).
 *
 * 设计目标（与 review §7 P2-10 对齐）：
 *   - 提供 `createHooks()` helper 让集成者一行式注册生命周期回调
 *   - 4 类新 hook：postToolUse / sessionStart / sessionEnd / stop
 *   - 与 `beforeTool` veto 互补：before 决定是否执行，post 在执行后观察
 *   - dispatchAgentEvent(hooks, event) 把 AgentEvent 路由到对应 hook
 */
describe("createHooks()", () => {
  it("is exported from the SDK entry", () => {
    expect(typeof createHooks).toBe("function");
  });

  it("returns the hooks object as-is for type-narrowing and chaining", () => {
    const hooks: AgentHooks = {
      postToolUse: async () => {},
      sessionStart: async () => {},
    };
    const result = createHooks(hooks);
    expect(result).toBe(hooks);
  });
});

describe("dispatchAgentEvent()", () => {
  it("is exported from the SDK entry", async () => {
    const { dispatchAgentEvent } = await import("../src/index.js");
    expect(typeof dispatchAgentEvent).toBe("function");
  });

  it("invokes postToolUse on tool_end events with the tool call and result", async () => {
    const calls: PostToolContext[] = [];
    const hooks = createHooks({
      postToolUse: async (ctx) => {
        calls.push(ctx);
      },
    });
    const event: AgentEvent = {
      type: "tool_end",
      call: { id: "c1", name: "bash", arguments: { command: "ls" } },
      result: { content: "output" },
      durationMs: 42,
    };
    await dispatchAgentEvent(hooks, event, { cwd: "/tmp/repo" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      toolName: "bash",
      arguments: { command: "ls" },
      cwd: "/tmp/repo",
      durationMs: 42,
    });
  });

  it("invokes stop on agent_end events with the stop reason", async () => {
    const stops: string[] = [];
    const hooks = createHooks({
      stop: async (reason) => {
        stops.push(reason);
      },
    });
    const event: AgentEvent = {
      type: "agent_end",
      response: {
        sessionId: "s1",
        entryId: "e1",
        content: "done",
        rounds: 1,
        toolCalls: 0,
        usage: { inputTokens: 1, outputTokens: 1 },
        stopped: "stop",
      },
    };
    await dispatchAgentEvent(hooks, event, { cwd: "/tmp" });
    expect(stops).toEqual(["stop"]);
  });

  it("invokes stop with 'max_rounds' when the agent hit the round ceiling", async () => {
    const stops: string[] = [];
    const hooks = createHooks({
      stop: async (reason) => {
        stops.push(reason);
      },
    });
    const event: AgentEvent = {
      type: "agent_end",
      response: {
        sessionId: "s1",
        entryId: "e1",
        content: "incomplete",
        rounds: 40,
        toolCalls: 5,
        usage: { inputTokens: 1, outputTokens: 1 },
        stopped: "max_rounds",
      },
    };
    await dispatchAgentEvent(hooks, event, { cwd: "/tmp" });
    expect(stops).toEqual(["max_rounds"]);
  });

  it("does nothing for events without a matching hook", async () => {
    const hooks = createHooks({
      postToolUse: async () => {
        throw new Error("should not be called");
      },
    });
    const event: AgentEvent = { type: "text_delta", delta: "hi" };
    await expect(dispatchAgentEvent(hooks, event, { cwd: "/tmp" })).resolves.toBeUndefined();
  });

  it("ignores undefined hooks gracefully", async () => {
    const hooks = createHooks({});
    const events: AgentEvent[] = [
      {
        type: "tool_end",
        call: { id: "c", name: "x", arguments: {} },
        result: { content: "" },
        durationMs: 1,
      },
      { type: "agent_end", response: stubResult("stop") },
      { type: "text_delta", delta: "x" },
    ];
    for (const event of events) {
      await expect(dispatchAgentEvent(hooks, event, { cwd: "/tmp" })).resolves.toBeUndefined();
    }
  });

  it("propagates hook errors so the agent loop can observe them", async () => {
    const hooks = createHooks({
      postToolUse: async () => {
        throw new Error("postToolUse exploded");
      },
    });
    const event: AgentEvent = {
      type: "tool_end",
      call: { id: "c", name: "x", arguments: {} },
      result: { content: "" },
      durationMs: 1,
    };
    await expect(dispatchAgentEvent(hooks, event, { cwd: "/tmp" })).rejects.toThrow(
      "postToolUse exploded",
    );
  });

  it("forwards sessionStart/sessionEnd hooks (called directly by integrator)", async () => {
    const starts: SessionContext[] = [];
    const ends: SessionContext[] = [];
    const hooks = createHooks({
      sessionStart: async (ctx) => {
        starts.push(ctx);
      },
      sessionEnd: async (ctx) => {
        ends.push(ctx);
      },
    });
    // The SDK does not emit session lifecycle events through AgentEvent;
    // integrators call these hooks directly from createCodingAgent.
    const ctx: SessionContext = { sessionId: "s1", cwd: "/repo", model: "kimi/k2" };
    await hooks.sessionStart?.(ctx);
    await hooks.sessionEnd?.(ctx);
    expect(starts).toEqual([ctx]);
    expect(ends).toEqual([ctx]);
  });
});

/**
 * composeEventSink: used by createCodingAgent to merge `onEvent` and `hooks`
 * into a single eventSink that the agent runtime calls. This is the wiring
 * layer that makes `hooks` actually fire — without it the `hooks` option
 * would be silently ignored.
 */
describe("composeEventSink()", () => {
  it("is exported from the SDK entry", () => {
    expect(typeof composeEventSink).toBe("function");
  });

  it("returns undefined when neither onEvent nor hooks are provided", () => {
    const sink = composeEventSink({ cwd: "/repo" });
    expect(sink).toBeUndefined();
  });

  it("returns the onEvent function as-is when no hooks are provided", async () => {
    const events: AgentEvent[] = [];
    const sink = composeEventSink({ cwd: "/repo", onEvent: (e) => void events.push(e) });
    expect(sink).toBeDefined();
    const event: AgentEvent = { type: "text_delta", delta: "hi" };
    await sink?.(event);
    expect(events).toEqual([event]);
  });

  it("dispatches to hooks.postToolUse on tool_end events", async () => {
    const calls: PostToolContext[] = [];
    const hooks = createHooks({
      postToolUse: async (ctx) => {
        calls.push(ctx);
      },
    });
    const sink = composeEventSink({ cwd: "/repo", hooks });
    const event: AgentEvent = {
      type: "tool_end",
      call: { id: "c1", name: "bash", arguments: { command: "ls" } },
      result: { content: "output" },
      durationMs: 10,
    };
    await sink?.(event);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      toolName: "bash",
      arguments: { command: "ls" },
      cwd: "/repo",
      durationMs: 10,
    });
  });

  it("dispatches to hooks.stop on agent_end events", async () => {
    const stops: string[] = [];
    const hooks = createHooks({
      stop: async (reason) => {
        stops.push(reason);
      },
    });
    const sink = composeEventSink({ cwd: "/repo", hooks });
    const event: AgentEvent = {
      type: "agent_end",
      response: stubResult("stop"),
    };
    await sink?.(event);
    expect(stops).toEqual(["stop"]);
  });

  it("calls BOTH onEvent and hooks for the same event (additive, not exclusive)", async () => {
    const onEventCalls: AgentEvent[] = [];
    const postToolCalls: PostToolContext[] = [];
    const hooks = createHooks({
      postToolUse: async (ctx) => {
        postToolCalls.push(ctx);
      },
    });
    const sink = composeEventSink({
      cwd: "/repo",
      onEvent: (e) => void onEventCalls.push(e),
      hooks,
    });
    const event: AgentEvent = {
      type: "tool_end",
      call: { id: "c1", name: "bash", arguments: { command: "ls" } },
      result: { content: "output" },
      durationMs: 5,
    };
    await sink?.(event);
    expect(onEventCalls).toEqual([event]);
    expect(postToolCalls).toHaveLength(1);
  });

  it("propagates hook errors to the caller (does not swallow)", async () => {
    const hooks = createHooks({
      postToolUse: async () => {
        throw new Error("hook failed");
      },
    });
    const sink = composeEventSink({ cwd: "/repo", hooks });
    const event: AgentEvent = {
      type: "tool_end",
      call: { id: "c1", name: "x", arguments: {} },
      result: { content: "" },
      durationMs: 1,
    };
    await expect(sink?.(event)).rejects.toThrow("hook failed");
  });

  it("calls onEvent first, then dispatches to hooks (ordering guarantee)", async () => {
    const order: string[] = [];
    const hooks = createHooks({
      postToolUse: async () => {
        order.push("hook");
      },
    });
    const sink = composeEventSink({
      cwd: "/repo",
      onEvent: async () => {
        order.push("onEvent");
      },
      hooks,
    });
    const event: AgentEvent = {
      type: "tool_end",
      call: { id: "c1", name: "x", arguments: {} },
      result: { content: "" },
      durationMs: 1,
    };
    await sink?.(event);
    expect(order).toEqual(["onEvent", "hook"]);
  });
});

function stubResult(
  stopped: "stop" | "max_rounds",
): AgentEvent extends { type: "agent_end" }
  ? (AgentEvent & { type: "agent_end" })["response"]
  : never {
  return {
    sessionId: "s1",
    entryId: "e1",
    content: "",
    rounds: 1,
    toolCalls: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    stopped,
  } as never;
}
