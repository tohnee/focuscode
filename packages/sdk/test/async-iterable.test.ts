import { describe, expect, it } from "vitest";
import { streamSubmit, type StreamSubmitResult, type StreamingAgent } from "../src/index.js";
import type { AgentEvent, AgentRunResult } from "@focuscode/agent-runtime";

/**
 * P2-2: submit() 返回 AsyncIterable<AgentEvent>.
 *
 * 设计目标（与 review §7 P2-9 对齐）：
 *   - 提供 `streamSubmit()` helper 把 `CodingAgent.submit()` 的 Promise + eventSink
 *     回调包装成原生 `AsyncIterable<AgentEvent>`，便于 `for await ... of` 消费。
 *   - 保留 Promise 兼容：iterable 完成后仍可拿到 `AgentRunResult`。
 *   - 不修改 agent-runtime，仅在 SDK 层包装（通过 CodingAgent.setEventSink 注入）。
 */
describe("streamSubmit()", () => {
  it("is exported from the SDK entry", () => {
    expect(typeof streamSubmit).toBe("function");
  });

  it("returns an AsyncIterable<AgentEvent> that also exposes the final AgentRunResult", async () => {
    const fakeAgent = createFakeAgent({
      events: [
        { type: "agent_start", sessionId: "s1", turn: 1 },
        { type: "text_delta", delta: "hello" },
        { type: "agent_end", response: fakeResult("s1") },
      ],
      result: fakeResult("s1"),
    });

    const stream: StreamSubmitResult = streamSubmit(fakeAgent, "hi");
    expectSymbolAsyncIterator(stream);

    const seen: AgentEvent[] = [];
    for await (const event of stream) {
      seen.push(event);
    }

    expect(seen.map((e) => e.type)).toEqual(["agent_start", "text_delta", "agent_end"]);
    // Promise compatibility: final result accessible without extra call.
    const final = await stream.result;
    expect(final.sessionId).toBe("s1");
    expect(final.content).toBe("done");
  });

  it("forwards an AbortSignal to the underlying agent", async () => {
    let observedSignal: AbortSignal | undefined;
    const fakeAgent = createFakeAgent({
      events: [{ type: "agent_start", sessionId: "s2", turn: 1 }],
      result: fakeResult("s2"),
      captureSignal: (signal) => {
        observedSignal = signal;
      },
    });

    const controller = new AbortController();
    const stream = streamSubmit(fakeAgent, "hi", { signal: controller.signal });
    for await (const _event of stream) {
      break;
    }
    await stream.result.catch(() => undefined);
    expect(observedSignal).toBe(controller.signal);
  });

  it("propagates agent errors as an error event and rejects result", async () => {
    const fakeAgent = createFakeAgent({
      events: [],
      result: fakeResult("s3"),
      error: new Error("agent exploded"),
    });

    const stream = streamSubmit(fakeAgent, "hi");
    const seen: AgentEvent[] = [];
    try {
      for await (const event of stream) {
        seen.push(event);
      }
    } catch {
      // stream may throw; we still want to assert error event was emitted
    }
    expect(seen.some((e) => e.type === "error")).toBe(true);
    await expect(stream.result).rejects.toThrow("agent exploded");
  });

  it("supports attachments via AgentPromptInput", async () => {
    let capturedInput: unknown;
    const fakeAgent = createFakeAgent({
      events: [{ type: "agent_end", response: fakeResult("s4") }],
      result: fakeResult("s4"),
      captureInput: (input) => {
        capturedInput = input;
      },
    });

    const stream = streamSubmit(fakeAgent, {
      text: "describe this",
      attachments: [
        {
          type: "image",
          id: "img1",
          name: "x.png",
          mediaType: "image/png",
          sizeBytes: 10,
          source: { type: "base64", data: "Zm9v" },
        },
      ],
    });
    for await (const _event of stream) {
      // drain
    }
    await stream.result;
    expect(capturedInput).toEqual({
      text: "describe this",
      attachments: [expect.objectContaining({ id: "img1", type: "image" })],
    });
  });

  it("restores the previous event sink after the stream ends", async () => {
    const previousSink = (_event: AgentEvent) => {};
    const fakeAgent = createFakeAgent({
      events: [{ type: "agent_end", response: fakeResult("s5") }],
      result: fakeResult("s5"),
    });
    fakeAgent.setEventSink(previousSink);

    const stream = streamSubmit(fakeAgent, "hi");
    for await (const _event of stream) {
      // drain
    }
    await stream.result;

    expect(fakeAgent.currentSink).toBe(previousSink);
  });

  it("P1-C: recoverable error does not close the stream; agent_end still arrives", async () => {
    const fakeAgent = createFakeAgent({
      events: [
        { type: "agent_start", sessionId: "s6", turn: 1 },
        { type: "error", message: "truncated output", severity: "recoverable" },
        { type: "text_delta", delta: "retry" },
        { type: "agent_end", response: fakeResult("s6") },
      ],
      result: fakeResult("s6"),
    });

    const stream = streamSubmit(fakeAgent, "hi");
    const seen: AgentEvent[] = [];
    for await (const event of stream) {
      seen.push(event);
    }
    await stream.result;

    // Stream MUST drain all events including post-error ones.
    expect(seen.map((e) => e.type)).toEqual(["agent_start", "error", "text_delta", "agent_end"]);
  });

  it("P1-C: fatal error (explicit severity) closes the stream immediately", async () => {
    const fakeAgent = createFakeAgent({
      events: [
        { type: "agent_start", sessionId: "s7", turn: 1 },
        { type: "error", message: "boom", severity: "fatal" },
        // These events come after the fatal error in the queue; the
        // generator should have returned already.
        { type: "text_delta", delta: "should-not-see" },
      ],
      result: fakeResult("s7"),
    });

    const stream = streamSubmit(fakeAgent, "hi");
    const seen: AgentEvent[] = [];
    for await (const event of stream) {
      seen.push(event);
    }
    await stream.result.catch(() => undefined);

    expect(seen.map((e) => e.type)).toEqual(["agent_start", "error"]);
  });

  it("P1-C: error without severity defaults to fatal (backward compat)", async () => {
    const fakeAgent = createFakeAgent({
      events: [
        { type: "error", message: "legacy fatal" },
        { type: "text_delta", delta: "should-not-see" },
      ],
      result: fakeResult("s8"),
    });

    const stream = streamSubmit(fakeAgent, "hi");
    const seen: AgentEvent[] = [];
    for await (const event of stream) {
      seen.push(event);
    }
    await stream.result.catch(() => undefined);

    expect(seen.map((e) => e.type)).toEqual(["error"]);
  });
});

function fakeResult(sessionId: string): AgentRunResult {
  return {
    sessionId,
    entryId: "entry-1",
    content: "done",
    rounds: 1,
    toolCalls: 0,
    usage: { inputTokens: 1, outputTokens: 1 },
    stopped: "stop",
  };
}

function expectSymbolAsyncIterator(value: unknown): void {
  expect(typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator]).toBe("function");
}

interface FakeAgentOptions {
  events: AgentEvent[];
  result: AgentRunResult;
  error?: Error;
  captureSignal?: (signal: AbortSignal | undefined) => void;
  captureInput?: (input: unknown) => void;
}

function createFakeAgent(opts: FakeAgentOptions): StreamingAgent & {
  currentSink: ((event: AgentEvent) => void | Promise<void>) | undefined;
} {
  const holder: { sink: ((event: AgentEvent) => void | Promise<void>) | undefined } = {
    sink: undefined,
  };
  return {
    currentSink: undefined as never,
    setEventSink(sink) {
      const previous = holder.sink;
      holder.sink = sink;
      // expose current value via closure getter
      Object.defineProperty(this, "currentSink", { get: () => holder.sink });
      return previous;
    },
    async submit(input, signal) {
      opts.captureInput?.(input);
      opts.captureSignal?.(signal);
      // Emit queued events through the installed sink (mimics real agent).
      if (holder.sink) {
        for (const event of opts.events) {
          await holder.sink(event);
        }
      }
      if (opts.error) throw opts.error;
      return opts.result;
    },
  } as StreamingAgent & { currentSink: typeof holder.sink };
}
