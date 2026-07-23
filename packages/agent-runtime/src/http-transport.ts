import type { ModelReliabilityPolicy, ModelStreamEvent } from "./types.js";

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export async function fetchWithReliability(
  fetchImplementation: typeof fetch,
  input: string | URL | Request,
  init: RequestInit,
  policy: ModelReliabilityPolicy,
  onEvent: (event: ModelStreamEvent) => void,
): Promise<Response> {
  let attempt = 0;
  while (true) {
    try {
      const response = await fetchImplementation(input, init);
      if (!RETRYABLE_STATUS.has(response.status) || attempt >= policy.maxRetries) {
        return response;
      }
      attempt += 1;
      const delayMs = retryDelay(response.headers, attempt, policy);
      onEvent({
        type: "model_retry",
        attempt,
        delayMs,
        status: response.status,
        reason: `HTTP ${response.status}`,
      });
      await response.body?.cancel().catch(() => undefined);
      await abortableDelay(delayMs, init.signal ?? undefined);
    } catch (error) {
      if (init.signal?.aborted || attempt >= policy.maxRetries || !isRetryableNetworkError(error)) {
        throw error;
      }
      attempt += 1;
      const delayMs = exponentialDelay(attempt, policy);
      onEvent({
        type: "model_retry",
        attempt,
        delayMs,
        reason: error instanceof Error ? error.name || "network error" : "network error",
      });
      await abortableDelay(delayMs, init.signal ?? undefined);
    }
  }
}

function retryDelay(headers: Headers, attempt: number, policy: ModelReliabilityPolicy): number {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(policy.retryMaximumDelayMs, Math.round(seconds * 1_000));
    }
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) {
      return Math.min(policy.retryMaximumDelayMs, Math.max(0, date - Date.now()));
    }
  }
  return exponentialDelay(attempt, policy);
}

function exponentialDelay(attempt: number, policy: ModelReliabilityPolicy): number {
  const capped = Math.min(
    policy.retryMaximumDelayMs,
    policy.retryBaseDelayMs * 2 ** Math.max(0, attempt - 1),
  );
  // Equal jitter: spread retries over [0.5, 1.0] of the capped backoff so
  // synchronized clients do not thunder the provider in lockstep. The
  // server-provided Retry-After path stays exact on purpose.
  return Math.round(capped * (0.5 + Math.random() * 0.5));
}

function abortableDelay(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Request aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, delayMs);
    timer.unref();
    signal?.addEventListener("abort", aborted, { once: true });
    function done() {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Request aborted"));
    }
  });
}

function isRetryableNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  return !["AbortError", "TimeoutError"].includes(error.name);
}
