/**
 * TDD tests for the TUI session-cost tracker (Task 1A-3).
 *
 * `runFullScreenAgent` previously set the session cost widget to the raw
 * token count (input + output), which the Cost block and /cost displayed as
 * if it were USD. The fix extracts a pure `createTuiCostTracker` that
 * converts each usage event to USD via `estimateCostUsd` so the widget shows
 * real dollars.
 *
 * NOTE: the tracker delegates to `estimateCostUsd`, which prices the cached
 * input segment at the cached rate only (uncached input at the input rate),
 * so the expected total for 1M input / 500k output / 400k cached at
 * {2.0, 8.0, 0.2} per 1M is 1.2 + 4.0 + 0.08 = 5.28, not 6.08.
 */
import { describe, expect, it } from "vitest";
import { createTuiCostTracker } from "../src/tui.js";
import type { TokenUsage } from "@focuscode/agent-runtime";

describe("tui cost tracking", () => {
  it("converts usage to USD using pricing, not raw token counts", () => {
    const pricing = { input: 2.0, output: 8.0, cachedInput: 0.2 };
    const tracker = createTuiCostTracker({
      pricing: { "provider/model": pricing },
      modelKey: "provider/model",
      modelId: "model",
    });
    const usage: TokenUsage = {
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cachedInputTokens: 400_000,
    };
    tracker.add(usage);
    // 600k uncached input @ $2/M = 1.2 · 500k output @ $8/M = 4.0
    // · 400k cached @ $0.2/M = 0.08 → total 5.28
    expect(tracker.usd).toBeCloseTo(5.28);
  });

  it("resolves pricing by bare model id when provider/model is absent", () => {
    const tracker = createTuiCostTracker({
      pricing: { model: { input: 2.0, output: 8.0 } },
      modelKey: "provider/model",
      modelId: "model",
    });
    tracker.add({ inputTokens: 1_000_000, outputTokens: 500_000 });
    expect(tracker.usd).toBeCloseTo(6.0);
  });

  it("zero cost when no pricing configured", () => {
    const tracker = createTuiCostTracker({
      pricing: {},
      modelKey: "provider/model",
      modelId: "model",
    });
    tracker.add({ inputTokens: 100, outputTokens: 50, cachedInputTokens: 40 });
    expect(tracker.usd).toBe(0);
  });
});
