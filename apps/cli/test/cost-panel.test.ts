import { describe, expect, it } from "vitest";
import type { ModelPricing, ResolvedAgentConfig, TokenUsage } from "@focuscode/agent-runtime";
import { printCostPanel } from "../src/agent-command.js";

// Capture process.stderr.write into a string buffer while `fn` runs. The
// --cost panel emits to stderr so stdout JSON/print output stays parseable,
// so we swap stderr rather than stdout here. We replace write directly
// (instead of vi.spyOn) because the WriteStream overloads confuse
// mockImplementation's parameter inference.
function captureStderr(fn: () => void): string {
  const chunks: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    if (typeof chunk === "string") chunks.push(chunk);
    else chunks.push(Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return chunks.join("");
}

// Build a minimal ResolvedAgentConfig fixture. printCostPanel only touches
// `config.model.provider`, `config.model.model` and `config.pricing`, so the
// other fields are intentionally omitted via a partial cast.
function fixtureConfig(
  provider: string,
  model: string,
  pricing: Record<string, ModelPricing>,
): ResolvedAgentConfig {
  return {
    model: {
      provider,
      model,
      protocol: "openai-chat",
      baseUrl: "https://example.invalid/v1",
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      temperature: 0,
      toolMode: "auto",
      reasoningEffort: "off",
      capabilities: { input: ["text"], reasoning: false, toolCalling: true },
      compatibility: {},
      reliability: {
        timeoutMs: 60_000,
        maxRetries: 0,
        retryBaseDelayMs: 0,
        retryMaximumDelayMs: 0,
      },
    },
    pricing,
  } as unknown as ResolvedAgentConfig;
}

describe("printCostPanel cache reporting", () => {
  const pricing: ModelPricing = { input: 2.0, output: 8.0, cachedInput: 0.2 };
  const config = fixtureConfig("fixture", "model", {
    "fixture/model": pricing,
  });

  it("reports cache hit ratio and saved USD when cached tokens exist", () => {
    const usage: TokenUsage = {
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cachedInputTokens: 400_000,
    };
    const output = captureStderr(() => printCostPanel(usage, config));
    // hitRatio = 400k / 1M = 40%
    expect(output).toContain("cache hit 40%");
    // saved = (400k / 1M) * $2.00 = $0.80 (what those cached tokens would
    // have cost at the uncached input price)
    expect(output).toContain("saved $0.800000");
    // uncached input = 1M - 400k = 600k
    expect(output).toContain("600000 in / 500000 out / 400000 cached tokens");
  });

  it("omits the cache segment when no cached tokens exist", () => {
    const usage: TokenUsage = {
      inputTokens: 1_000_000,
      outputTokens: 500_000,
    };
    const output = captureStderr(() => printCostPanel(usage, config));
    expect(output).not.toContain("cache hit");
    expect(output).toContain("1000000 in / 500000 out / 0 cached tokens");
  });
});
