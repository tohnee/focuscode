import type { ModelClient, ModelRequest, ModelResponse, ModelStreamEvent } from "./types.js";
import { ModelHttpError } from "./model-clients.js";
import { CircuitOpenError } from "./circuit-breaker.js";

/**
 * HTTP statuses that justify failing over to the next model in the chain.
 * Mirrors `RETRYABLE_STATUS` in `http-transport.ts` so the fallback decision
 * matches the within-client retry decision: the same transient provider
 * conditions (rate limits, maintenance, bad gateways) that warrant a retry
 * also warrant switching providers once the local retry budget is exhausted.
 */
const RETRYABLE_HTTP_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/**
 * Emitted when the fallback chain advances from one model to the next. `from`
 * and `to` identify the link positions (`"primary"`, `"fallback[0]"`, …) so
 * observers can reconstruct the chain traversal without holding client
 * references.
 */
export interface FallbackEvent {
  from: string;
  to: string;
  reason: string;
}

export interface FallbackModelClientOptions {
  onFallback?: (event: FallbackEvent) => void;
  /**
   * Model id the primary client expects in `ModelRequest.model`. When set,
   * the request's `model` field is rewritten to this value before being
   * dispatched to the primary, so a request that arrived targeting a
   * fallback model is never forwarded to the primary provider verbatim.
   * When omitted, the request is passed unchanged (backward compatible).
   */
  primaryModel?: string;
  /**
   * Model ids for the fallback clients, in chain order. `fallbackModels[i]`
   * is used to rewrite `ModelRequest.model` when dispatching to
   * `fallbacks[i]`. Entries may be `undefined` to opt out of rewriting for
   * a specific link. When the whole array is omitted, no rewriting occurs.
   */
  fallbackModels?: string[];
}

/**
 * ModelClient decorator that wraps a primary client and an ordered list of
 * fallback clients. When the primary (or the current fallback) returns
 * `stopReason === "error"` or throws a retryable error (HTTP 429/5xx,
 * `CircuitOpenError`), the decorator transparently retries the in-flight
 * request on the next client in the chain.
 *
 * Non-retryable failures — HTTP 4xx (except 408/409/425/429), caller aborts,
 * drift errors — propagate immediately without consuming the fallback budget,
 * because switching providers cannot fix a malformed request or a caller that
 * has already given up.
 *
 * Stream events (`onEvent`) from discarded attempts are suppressed; only the
 * winning client's stream reaches the caller, so downstream consumers never
 * observe partial output from a model that was abandoned mid-stream. Each
 * attempt's events are buffered locally and flushed to the caller only after
 * that attempt is confirmed the winner.
 *
 * When `primaryModel` / `fallbackModels` are supplied, the request's `model`
 * field is rewritten per chain link so every provider receives the model id it
 * was configured for — the primary model id is never forwarded to a fallback
 * provider (or vice versa).
 */
export class FallbackModelClient implements ModelClient {
  readonly protocol: string;

  constructor(
    private readonly primary: ModelClient,
    private readonly fallbacks: ModelClient[],
    private readonly options: FallbackModelClientOptions = {},
  ) {
    this.protocol = primary.protocol;
  }

  async complete(
    request: ModelRequest,
    onEvent?: (event: ModelStreamEvent) => void,
  ): Promise<ModelResponse> {
    const chain: Array<{ client: ModelClient; label: string; model: string | undefined }> = [
      { client: this.primary, label: "primary", model: this.options.primaryModel },
      ...this.fallbacks.map((client, index) => ({
        client,
        label: `fallback[${index}]`,
        model: this.options.fallbackModels?.[index],
      })),
    ];

    let lastError: unknown;
    for (let i = 0; i < chain.length; i++) {
      const current = chain[i]!;
      const { client, label, model } = current;
      // Rewrite the model id so each provider receives the model it was
      // configured for. Without this, a fallback provider would be asked to
      // serve the primary model id (or vice versa), which either 404s at the
      // upstream API or silently routes to the wrong model.
      const attemptRequest: ModelRequest = model !== undefined ? { ...request, model } : request;
      // Buffer stream events for this attempt. If the attempt is discarded
      // (error or stopReason=error), the buffer is dropped so partial deltas
      // never reach the caller. If it wins, the buffer is flushed to the real
      // onEvent in emission order. Without this isolation, a model that
      // streams partial output before failing would leak that output to
      // downstream consumers.
      const buffer: ModelStreamEvent[] = [];
      const sink = onEvent ? (ev: ModelStreamEvent) => buffer.push(ev) : undefined;
      try {
        const response = await client.complete(attemptRequest, sink);
        if (response.stopReason === "error" && i < chain.length - 1) {
          const next = chain[i + 1]!;
          this.options.onFallback?.({
            from: label,
            to: next.label,
            reason: "stopReason=error",
          });
          lastError = new Error(`${label} returned stopReason=error`);
          continue;
        }
        if (onEvent) {
          for (const ev of buffer) onEvent(ev);
        }
        return response;
      } catch (error) {
        lastError = error;
        if (!isRetryable(error) || i >= chain.length - 1) {
          throw error;
        }
        const next = chain[i + 1]!;
        this.options.onFallback?.({
          from: label,
          to: next.label,
          reason: reasonFor(error),
        });
      }
    }
    throw lastError ?? new Error("Fallback chain exhausted with no error captured");
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof ModelHttpError) {
    return RETRYABLE_HTTP_STATUS.has(error.status);
  }
  if (error instanceof CircuitOpenError) {
    return true;
  }
  // AbortError and TimeoutError represent caller intent or hard deadlines —
  // switching providers cannot rescue them, so they are not retryable.
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") return false;
  }
  return false;
}

function reasonFor(error: unknown): string {
  if (error instanceof ModelHttpError) {
    return `HTTP ${error.status}`;
  }
  if (error instanceof CircuitOpenError) {
    return `circuit open for ${error.key}`;
  }
  if (error instanceof Error) {
    return error.message || error.name;
  }
  return "unknown error";
}
