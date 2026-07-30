import type { AgentEvent, AgentPromptInput, AgentRunResult } from "@focuscode/agent-runtime";
import type { StreamingAgent } from "./async-iterable.js";

export interface RunCodingAgentOptions {
  /** Any object satisfying {@link StreamingAgent} (e.g. a `CodingAgent`). */
  agent: StreamingAgent;
  /** Prompt text or {@link AgentPromptInput} with attachments. */
  input: string | AgentPromptInput;
  /** Optional abort signal forwarded to the underlying agent. */
  signal?: AbortSignal;
}

export interface RunCodingAgentResult extends AsyncGenerator<AgentEvent, void, unknown> {
  /**
   * Resolves with the final {@link AgentRunResult} after the agent finishes.
   * Rejects if the underlying `agent.submit()` throws.
   */
  result: Promise<AgentRunResult>;
}

/**
 * Native AsyncGenerator entry point for the Coding Agent SDK.
 *
 * This is the FocusCode equivalent of Claude Agent SDK's `query()`:
 * a single function that returns an `AsyncGenerator<AgentEvent>` you can
 * consume with `for await ... of`, plus a `result` promise for the final
 * structured output.
 *
 * Unlike `streamSubmit` (which wraps an existing agent), `runCodingAgent`
 * is self-contained: it drives `agent.submit()` internally and yields events
 * as they arrive, closing the stream after `agent_end` or `error`.
 *
 * @example
 * ```ts
 * const stream = runCodingAgent({ agent, input: "Refactor utils.ts" });
 * for await (const event of stream) {
 *   if (event.type === "text_delta") process.stdout.write(event.delta);
 * }
 * const result = await stream.result;
 * console.log("stopped:", result.stopped);
 * ```
 */
export function runCodingAgent(options: RunCodingAgentOptions): RunCodingAgentResult {
  const { agent, input, signal } = options;
  const queue: AgentEvent[] = [];
  let resolveNext: (() => void) | undefined;
  let rejectNext: ((err: unknown) => void) | undefined;
  let streamClosed = false;
  let sinkInstalled = false;
  const previousSink = agent.setEventSink(async (event) => {
    queue.push(event);
    resolveNext?.();
    await previousSink?.(event);
  });
  sinkInstalled = true;

  const resultPromise: Promise<AgentRunResult> = agent.submit(input, signal).then(
    (value) => {
      closeStream(undefined);
      return value;
    },
    (error: unknown) => {
      closeStream(error);
      throw error;
    },
  );
  // Prevent unhandled rejection when the consumer only iterates events
  // without awaiting the result promise.
  resultPromise.catch(() => {});

  function closeStream(error: unknown): void {
    if (streamClosed) return;
    streamClosed = true;
    if (error !== undefined && !queue.some((e) => e.type === "error")) {
      queue.push({ type: "error", message: errorMessage(error) });
    }
    resolveNext?.();
    if (sinkInstalled) {
      agent.setEventSink(previousSink);
      sinkInstalled = false;
    }
  }

  async function* generator(): AsyncGenerator<AgentEvent, void, unknown> {
    while (true) {
      while (queue.length > 0) {
        const event = queue.shift()!;
        yield event;
        // P1-C: only terminal events close the stream. `agent_end` is always
        // terminal. `error` is terminal ONLY when severity !== "recoverable"
        // (undefined defaults to "fatal" for backward compatibility).
        // Recoverable errors (truncation, doom-loop guard) are yielded but
        // the stream stays open — the agent will still emit `agent_end`.
        if (event.type === "agent_end") {
          return;
        }
        if (event.type === "error" && event.severity !== "recoverable") {
          return;
        }
      }
      if (streamClosed) return;
      await new Promise<void>((resolve, reject) => {
        resolveNext = resolve;
        rejectNext = reject;
      });
      resolveNext = undefined;
      rejectNext = undefined;
    }
  }

  const gen = generator();
  const result: RunCodingAgentResult = Object.assign(gen, { result: resultPromise });
  return result;
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
