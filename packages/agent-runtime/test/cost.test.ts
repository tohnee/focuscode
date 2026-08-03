import { describe, expect, it } from "vitest";
import { cacheMetrics, estimateCostUsd } from "../src/cost.js";
import type { TokenUsage } from "../src/types.js";

describe("cacheMetrics", () => {
  it("hitRatio = cachedInputTokens / inputTokens", () => {
    const usage: TokenUsage = { inputTokens: 100, outputTokens: 50, cachedInputTokens: 40 };
    expect(cacheMetrics(usage).hitRatio).toBe(0.4);
  });

  it("uncachedInputTokens subtracts cached from input", () => {
    const usage: TokenUsage = { inputTokens: 100, outputTokens: 50, cachedInputTokens: 40 };
    expect(cacheMetrics(usage).uncachedInputTokens).toBe(60);
  });

  it("hitRatio is 0 when inputTokens is 0", () => {
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    expect(cacheMetrics(usage).hitRatio).toBe(0);
  });
});

describe("estimateCostUsd", () => {
  const pricing = { input: 2.0, output: 8.0, cachedInput: 0.2 };

  it("prices input/output/cached separately per 1M tokens", () => {
    const usage: TokenUsage = { inputTokens: 1_000_000, outputTokens: 500_000, cachedInputTokens: 400_000 };
    const c = estimateCostUsd(usage, pricing);
    expect(c.inputUsd).toBeCloseTo(1.2);
    expect(c.outputUsd).toBeCloseTo(4.0);
    expect(c.cachedUsd).toBeCloseTo(0.08);
    expect(c.totalUsd).toBeCloseTo(5.28);
  });

  it("treats all input as uncached when no pricing is given", () => {
    const usage: TokenUsage = { inputTokens: 100, outputTokens: 50, cachedInputTokens: 40 };
    const c = estimateCostUsd(usage, undefined);
    expect(c.totalUsd).toBe(0);
    expect(c.inputUsd).toBe(0);
  });
});
