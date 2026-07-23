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
 * observe partial output from a model that was abandoned mid-stream.
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
    const chain: Array<{ client: ModelClient; label: string }> = [
      { client: this.primary, label: "primary" },
      ...this.fallbacks.map((client, index) => ({ client, label: `fallback[${index}]` })),
    ];

    let lastError: unknown;
    for (let i = 0; i < chain.length; i++) {
      const current = chain[i]!;
      const { client, label } = current;
      try {
        const response = await client.complete(request, onEvent);
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
