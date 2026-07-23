import type { ModelClient, ModelRequest, ModelResponse, ModelStreamEvent } from "./types.js";

export const DEFAULT_CIRCUIT_THRESHOLD = 5;
export const DEFAULT_CIRCUIT_COOLDOWN_MS = 30_000;
export const DEFAULT_MAX_CONCURRENCY = 8;

export class CircuitOpenError extends Error {
  constructor(
    readonly key: string,
    readonly retryAfterMs: number,
  ) {
    super(`Circuit open for ${key}; failing fast for ${retryAfterMs}ms before a probe is allowed`);
    this.name = "CircuitOpenError";
  }
}

interface BreakerEntry {
  state: "closed" | "open" | "half-open";
  consecutiveFailures: number;
  openedAt: number;
  probeInFlight: boolean;
}

/**
 * Shared breaker/bulkhead state. Composition roots may hand one registry to
 * several CircuitBreakingModelClient instances so circuits keyed by
 * `provider/model` and semaphores keyed by `provider` coordinate across
 * clients; by default each decorator keeps its own instance-level registry.
 */
export interface CircuitBreakerRegistry {
  breakers: Map<string, BreakerEntry>;
  semaphores: Map<string, Semaphore>;
}

export function createCircuitBreakerRegistry(): CircuitBreakerRegistry {
  return { breakers: new Map(), semaphores: new Map() };
}

export interface CircuitBreakerOptions {
  provider: string;
  circuitThreshold?: number;
  circuitCooldownMs?: number;
  maxConcurrency?: number;
  registry?: CircuitBreakerRegistry;
  now?: () => number;
}

/**
 * ModelClient decorator adding three reliability guards around any protocol
 * client: a per `provider/model` circuit breaker (closed → open after
 * `circuitThreshold` consecutive failures → half-open probe after
 * `circuitCooldownMs`), and a per-provider concurrency bulkhead that queues
 * calls beyond `maxConcurrency` instead of rejecting them.
 */
export class CircuitBreakingModelClient implements ModelClient {
  readonly protocol: string;
  private readonly registry: CircuitBreakerRegistry;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly concurrency: number;
  private readonly now: () => number;

  constructor(
    private readonly inner: ModelClient,
    private readonly options: CircuitBreakerOptions,
  ) {
    this.protocol = inner.protocol;
    this.registry = options.registry ?? createCircuitBreakerRegistry();
    this.threshold = Math.max(1, options.circuitThreshold ?? DEFAULT_CIRCUIT_THRESHOLD);
    this.cooldownMs = Math.max(0, options.circuitCooldownMs ?? DEFAULT_CIRCUIT_COOLDOWN_MS);
    this.concurrency = Math.max(1, options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
    this.now = options.now ?? Date.now;
  }

  async complete(
    request: ModelRequest,
    onEvent: (event: ModelStreamEvent) => void = () => undefined,
  ): Promise<ModelResponse> {
    const key = `${this.options.provider}/${request.model}`;
    const entry = this.entryFor(key);
    const probe = this.gate(key, entry);
    const semaphore = this.semaphoreFor(this.options.provider);
    await semaphore.acquire();
    try {
      const response = await this.inner.complete(request, onEvent);
      if (response.stopReason === "error") {
        this.recordFailure(entry, probe, request);
      } else {
        this.recordSuccess(entry);
      }
      return response;
    } catch (error) {
      this.recordFailure(entry, probe, request);
      throw error;
    } finally {
      if (probe) entry.probeInFlight = false;
      semaphore.release();
    }
  }

  /** Circuit state for a key, exposed for diagnostics and tests. */
  state(key: string): "closed" | "open" | "half-open" {
    return this.entryFor(key).state;
  }

  private entryFor(key: string): BreakerEntry {
    let entry = this.registry.breakers.get(key);
    if (!entry) {
      entry = { state: "closed", consecutiveFailures: 0, openedAt: 0, probeInFlight: false };
      this.registry.breakers.set(key, entry);
    }
    return entry;
  }

  private semaphoreFor(provider: string): Semaphore {
    let semaphore = this.registry.semaphores.get(provider);
    if (!semaphore) {
      semaphore = new Semaphore(this.concurrency);
      this.registry.semaphores.set(provider, semaphore);
    }
    return semaphore;
  }

  /**
   * Admits the call or throws CircuitOpenError. Returns true when this call is
   * the single half-open probe allowed after the cooldown elapsed.
   */
  private gate(key: string, entry: BreakerEntry): boolean {
    if (entry.state === "open") {
      const elapsed = this.now() - entry.openedAt;
      if (elapsed < this.cooldownMs) {
        throw new CircuitOpenError(key, this.cooldownMs - elapsed);
      }
      entry.state = "half-open";
      entry.probeInFlight = true;
      return true;
    }
    if (entry.state === "half-open") {
      if (entry.probeInFlight) throw new CircuitOpenError(key, this.cooldownMs);
      entry.probeInFlight = true;
      return true;
    }
    return false;
  }

  private recordSuccess(entry: BreakerEntry): void {
    entry.consecutiveFailures = 0;
    entry.state = "closed";
  }

  private recordFailure(entry: BreakerEntry, probe: boolean, request: ModelRequest): void {
    // A caller-side abort says nothing about provider health; never count it.
    if (request.signal?.aborted) return;
    if (probe) {
      entry.state = "open";
      entry.openedAt = this.now();
      return;
    }
    entry.consecutiveFailures += 1;
    if (entry.consecutiveFailures >= this.threshold) {
      entry.state = "open";
      entry.openedAt = this.now();
    }
  }
}

class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    // Queue instead of rejecting: the slot transfers directly on release.
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active -= 1;
  }
}
