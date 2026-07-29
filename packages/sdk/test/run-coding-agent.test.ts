import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@focuscode/agent-runtime";
import { runCodingAgent, type RunCodingAgentOptions } from "../src/run-coding-agent.js";

function createMockAgent(events: AgentEvent[], result: { stopped: string; sessionId: string }) {
  const listeners: Array<(event: AgentEvent) => void | Promise<void>> = [];
  return {
    setEventSink(sink: ((event: AgentEvent) => void | Promise<void>) | undefined) {
      if (sink) listeners.push(sink);
      return listeners.length > 1 ? listeners[listeners.length - 2] : undefined;
    },
    async submit() {
      for (const event of events) {
        for (const listener of listeners) await listener(event);
      }
      return result;
    },
  };
}

describe("runCodingAgent", () => {
  it("yields events as an AsyncGenerator", async () => {
    const events: AgentEvent[] = [
      { type: "text_delta", delta: "hello" },
      { type: "text_delta", delta: " world" },
      { type: "agent_end", response: { stopped: "stop", sessionId: "s1" } },
    ];
    const agent = createMockAgent(events, { stopped: "stop", sessionId: "s1" });
    const options: RunCodingAgentOptions = {
      agent: agent as unknown as RunCodingAgentOptions["agent"],
      input: "test",
    };
    const received: AgentEvent[] = [];
    for await (const event of runCodingAgent(options)) {
      received.push(event);
    }
    expect(received).toEqual(events);
  });

  it("exposes result promise that resolves after stream ends", async () => {
    const events: AgentEvent[] = [
      { type: "agent_end", response: { stopped: "stop", sessionId: "s1" } },
    ];
    const result = { stopped: "stop" as const, sessionId: "s1" };
    const agent = createMockAgent(events, result);
    const options: RunCodingAgentOptions = {
      agent: agent as unknown as RunCodingAgentOptions["agent"],
      input: "test",
    };
    const stream = runCodingAgent(options);
    for await (const _ of stream) {
      /* drain */
    }
    expect(await stream.result).toEqual(result);
  });

  it("stops yielding after agent_end event", async () => {
    const events: AgentEvent[] = [
      { type: "text_delta", delta: "before" },
      { type: "agent_end", response: { stopped: "stop", sessionId: "s1" } },
      { type: "text_delta", delta: "after" }, // should not be yielded
    ];
    const agent = createMockAgent(events, { stopped: "stop", sessionId: "s1" });
    const options: RunCodingAgentOptions = {
      agent: agent as unknown as RunCodingAgentOptions["agent"],
      input: "test",
    };
    const received: AgentEvent[] = [];
    for await (const event of runCodingAgent(options)) {
      received.push(event);
    }
    expect(received).toHaveLength(2);
    expect(received[1]!.type).toBe("agent_end");
  });

  it("propagates errors as error events", async () => {
    const agent = {
      setEventSink: () => undefined,
      submit: () => Promise.reject(new Error("agent failed")),
    };
    const options: RunCodingAgentOptions = {
      agent: agent as unknown as RunCodingAgentOptions["agent"],
      input: "test",
    };
    const received: AgentEvent[] = [];
    for await (const event of runCodingAgent(options)) {
      received.push(event);
    }
    expect(received.some((e) => e.type === "error")).toBe(true);
  });
});
