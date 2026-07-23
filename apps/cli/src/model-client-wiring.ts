import {
  CircuitBreakingModelClient,
  FallbackModelClient,
  type ModelClient,
  type ModelProfile,
} from "@focuscode/agent-runtime";

/**
 * Factory that builds a raw protocol client for a given `ModelProfile`. The
 * CLI composition root passes `createModelClient` here; tests inject a stub
 * so the chain builder can be verified without real network I/O.
 */
export type ModelClientFactory = (profile: ModelProfile) => ModelClient;

export interface BuildModelClientChainOptions {
  factory: ModelClientFactory;
  onFallback?: (event: { from: string; to: string; reason: string }) => void;
}

/**
 * Build the model client chain for a resolved agent config.
 *
 * When `fallbacks` is non-empty, the primary `CircuitBreakingModelClient` is
 * wrapped in a `FallbackModelClient` alongside one `CircuitBreakingModelClient`
 * per fallback profile. When `fallbacks` is empty, the primary client is
 * returned directly — preserving the exact pre-fallback runtime path so
 * existing behavior and performance characteristics are unchanged for
 * configurations that do not declare a fallback chain.
 *
 * Each client (primary and fallback) gets its own `CircuitBreakingModelClient`
 * decorator so circuit state and concurrency bulkheads are tracked
 * independently per provider/model. A circuit opening on the primary does not
 * poison the fallback's circuit, and vice versa.
 */
export function buildModelClientChain(
  primary: ModelProfile,
  fallbacks: ModelProfile[],
  options: BuildModelClientChainOptions,
): ModelClient {
  const primaryClient = circuitBreakingClient(primary, options.factory);
  if (fallbacks.length === 0) return primaryClient;

  const fallbackClients = fallbacks.map((profile) =>
    circuitBreakingClient(profile, options.factory),
  );
  return new FallbackModelClient(
    primaryClient,
    fallbackClients,
    options.onFallback ? { onFallback: options.onFallback } : {},
  );
}

function circuitBreakingClient(
  profile: ModelProfile,
  factory: ModelClientFactory,
): CircuitBreakingModelClient {
  const inner = factory(profile);
  return new CircuitBreakingModelClient(inner, {
    provider: profile.provider,
    ...(profile.reliability.circuitThreshold !== undefined
      ? { circuitThreshold: profile.reliability.circuitThreshold }
      : {}),
    ...(profile.reliability.circuitCooldownMs !== undefined
      ? { circuitCooldownMs: profile.reliability.circuitCooldownMs }
      : {}),
    ...(profile.reliability.maxConcurrency !== undefined
      ? { maxConcurrency: profile.reliability.maxConcurrency }
      : {}),
  });
}
