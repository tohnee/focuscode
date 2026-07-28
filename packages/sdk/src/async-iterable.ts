import type { AgentEvent, AgentPromptInput, AgentRunResult } from "@focuscode/agent-runtime";

/**
 * Minimal contract for an agent that supports {@link streamSubmit}.
 *
 * The real {@link CodingAgent} satisfies this interface; tests can supply
 * fakes. `setEventSink` returns the previously-installed sink so the wrapper
 * can save and restore it.
 */
export interface StreamingAgent {
  submit(input: string | AgentPromptInput, signal?: AbortSignal): Promise<AgentRunResult>;
  setEventSink(
    sink: ((event: AgentEvent) => void | Promise<void>) | undefined,
  ): ((event: AgentEvent) => void | Promise<void>) | undefined;
}

/**
 * Result of {@link streamSubmit}: an `AsyncIterable<AgentEvent>` that streams
 * agent events as they occur, plus a `result` promise that resolves with the
 * final {@link AgentRunResult} when the agent finishes.
 *
 * The iterable closes after `agent_end` (or `error`). Consumers can use
 * `for await ... of` to react to events in real time, then `await stream.result`
 * to obtain the structured result.
 */
export interface StreamSubmitResult extends AsyncIterable<AgentEvent> {
  /**
   * Resolves with the final {@link AgentRunResult} after the agent finishes.
   * Rejects if the underlying `agent.submit()` throws.
   */
  result: Promise<AgentRunResult>;
}

export interface StreamSubmitOptions {
  /** Optional abort signal forwarded to the underlying agent. */
  signal?: AbortSignal;
}

/**
 * Wrap an agent's `submit()` call into a native `AsyncIterable<AgentEvent>`.
 *
 * This bridges the gap between FocusCode's callback-based `eventSink` API and
 * the streaming pattern popularized by Claude Agent SDK (`AsyncGenerator<SDKMessage>`).
 *
 * Behavior:
 *   - Installs a temporary event sink that pushes events into an internal queue.
 *   - Returns an `AsyncIterable` that drains the queue as events arrive.
 *   - After the agent finishes (or errors), restores the previous event sink.
 *   - The `result` promise resolves with the {@link AgentRunResult} or rejects
 *     with the agent's error.
 *
 * @example
 * ```ts
 * const stream = streamSubmit(agent, "Refactor utils.ts");
 * for await (const event of stream) {
 *   if (event.type === "text_delta") process.stdout.write(event.delta);
 * }
 * const result = await stream.result;
 * console.log("stopped:", result.stopped);
 * ```
 *
 * @param agent - Any object satisfying {@link StreamingAgent} (e.g. a `CodingAgent`).
 * @param input - Prompt text or {@link AgentPromptInput} with attachments.
 * @param options - Optional {@link StreamSubmitOptions} (e.g. abort signal).
 */
export function streamSubmit(
  agent: StreamingAgent,
  input: string | AgentPromptInput,
  options?: StreamSubmitOptions,
): StreamSubmitResult {
  const queue: AgentEvent[] = [];
  let resolveNext: (() => void) | undefined;
  let rejectNext: ((err: unknown) => void) | undefined;
  let streamClosed = false;
  let sinkInstalled: boolean = false;
  const previousSink = agent.setEventSink(async (event) => {
    queue.push(event);
    resolveNext?.();
    // Forward to any sink the integrator previously installed so chaining
    // (e.g. audit journals) keeps working.
    await previousSink?.(event);
  });
  sinkInstalled = true;

  const resultPromise: Promise<AgentRunResult> = agent.submit(input, options?.signal).then(
    (value) => {
      closeStream(undefined, value);
      return value;
    },
    (error: unknown) => {
      closeStream(error, undefined);
      throw error;
    },
  );

  function closeStream(error: unknown, _result: AgentRunResult | undefined): void {
    if (streamClosed) return;
    streamClosed = true;
    if (error !== undefined && !queue.some((e) => e.type === "error")) {
      queue.push({ type: "error", message: errorMessage(error) });
      resolveNext?.();
    }
    // Signal end-of-stream to the consumer loop.
    resolveNext?.();
    // Restore the previous sink so subsequent direct submit() calls behave
    // as if streamSubmit was never called.
    if (sinkInstalled) {
      agent.setEventSink(previousSink);
      sinkInstalled = false;
    }
  }

  async function* generator(): AsyncGenerator<AgentEvent, void, unknown> {
    while (true) {
      // Drain anything already in the queue without awaiting.
      while (queue.length > 0) {
        const event = queue.shift()!;
        yield event;
        if (event.type === "agent_end" || event.type === "error") {
          // Stream closed by terminal event; allow caller to drain result.
          return;
        }
      }
      if (streamClosed) return;
      // Wait for the next event or stream close.
      await new Promise<void>((resolve, reject) => {
        resolveNext = resolve;
        rejectNext = reject;
      });
      resolveNext = undefined;
      rejectNext = undefined;
    }
  }

  const iterable: StreamSubmitResult = {
    [Symbol.asyncIterator]() {
      return generator();
    },
    result: resultPromise,
  };
  return iterable;
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
