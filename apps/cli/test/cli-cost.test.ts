import { describe, expect, it } from "vitest";
import {
  type ModelPricing,
  type ResolvedAgentConfig,
  type TokenUsage,
} from "@focuscode/agent-runtime";
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
// other fields are intentionally omitted via a partial cast — keeping the
// fixture readable without constructing a full ResolvedAgentConfig.
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

describe("printCostPanel", () => {
  describe("no pricing configured", () => {
    it("emits a `no pricing configured` notice when the model has no entry", () => {
      const usage: TokenUsage = {
        inputTokens: 1_000,
        outputTokens: 500,
        cachedInputTokens: 100,
      };
      const config = fixtureConfig("openai", "gpt-test", {});
      const output = captureStderr(() => printCostPanel(usage, config));
      expect(output).toContain("Cost: 1000 input / 500 output / 100 cached tokens");
      expect(output).toContain("no pricing configured for openai/gpt-test");
      expect(output).toContain("set config.pricing in agent.json");
    });

    it("falls back to bare-model lookup before declaring no pricing", () => {
      // A pricing entry keyed by the bare model id (no provider/) should
      // resolve and avoid the `no pricing configured` branch.
      const usage: TokenUsage = {
        inputTokens: 1_000_000,
        outputTokens: 0,
      };
      const config = fixtureConfig("custom-provider", "my-model", {
        "my-model": { input: 1, output: 2 },
      });
      const output = captureStderr(() => printCostPanel(usage, config));
      expect(output).not.toContain("no pricing configured");
      // 1M input tokens @ $1/M = $1.00
      expect(output).toContain("$1.000000");
    });
  });

  describe("with pricing (input + output only)", () => {
    const pricing: ModelPricing = { input: 5, output: 15 };
    const config = fixtureConfig("anthropic", "claude-test", {
      "anthropic/claude-test": pricing,
    });

    it("computes USD totals per 1M tokens for input and output", () => {
      const usage: TokenUsage = {
        inputTokens: 2_000_000, // 2M * $5 = $10
        outputTokens: 500_000, // 0.5M * $15 = $7.5
      };
      const output = captureStderr(() => printCostPanel(usage, config));
      // Total = 10 + 7.5 = 17.5
      expect(output).toContain("$17.500000");
      expect(output).toContain("input $10.000000 @ $5.00/M");
      expect(output).toContain("output $7.500000 @ $15.00/M");
      expect(output).toContain("2000000 in / 500000 out / 0 cached tokens");
    });

    it("omits the cached segment when pricing has no cachedInput field", () => {
      const usage: TokenUsage = {
        inputTokens: 100,
        outputTokens: 50,
        cachedInputTokens: 30,
      };
      const output = captureStderr(() => printCostPanel(usage, config));
      expect(output).not.toContain("cached $");
      // Still reports the cached token count in the trailing summary.
      expect(output).toContain("30 cached tokens");
    });
  });

  describe("with pricing.cachedInput", () => {
    const pricing: ModelPricing = { input: 10, output: 30, cachedInput: 1 };
    const config = fixtureConfig("openai", "gpt-cached", {
      "openai/gpt-cached": pricing,
    });

    it("includes a cached cost segment when cachedInput is priced", () => {
      const usage: TokenUsage = {
        inputTokens: 1_000_000,
        outputTokens: 500_000, // 0.5M * $30 = $15
        cachedInputTokens: 400_000, // 0.4M * $1 = $0.4
      };
      const output = captureStderr(() => printCostPanel(usage, config));
      // Cached tokens are included in inputTokens, so input is billed only
      // for the uncached remainder: (1M - 400k) / 1M * $10 = $6.
      // Total = 6 + 15 + 0.4 = 21.4
      expect(output).toContain("$21.400000");
      expect(output).toContain("cached $0.400000 @ $1.00/M");
      expect(output).toContain("600000 in / 500000 out / 400000 cached tokens");
      // The cache segment reports the same 40% hit ratio.
      expect(output).toContain("cache hit 40%");
    });

    it("treats missing cachedInputTokens on usage as 0 cached tokens", () => {
      const usage: TokenUsage = {
        inputTokens: 1_000_000,
        outputTokens: 0,
        // cachedInputTokens intentionally absent
      };
      const output = captureStderr(() => printCostPanel(usage, config));
      expect(output).toContain("0 cached tokens");
      // Cached cost is 0 because cached tokens is 0, even though cachedInput
      // unit price is defined.
      expect(output).toContain("cached $0.000000 @ $1.00/M");
    });
  });

  describe("key resolution priority", () => {
    it("prefers `provider/model` over the bare model id when both exist", () => {
      const usage: TokenUsage = {
        inputTokens: 1_000_000,
        outputTokens: 0,
      };
      const config = fixtureConfig("openai", "dual-key", {
        "openai/dual-key": { input: 2, output: 0 }, // preferred
        "dual-key": { input: 99, output: 0 }, // shadowed
      });
      const output = captureStderr(() => printCostPanel(usage, config));
      // 1M * $2/M = $2 — if the bare-key entry were used it would be $99.
      expect(output).toContain("$2.000000");
      expect(output).toContain("@ $2.00/M");
      expect(output).not.toContain("$99");
    });
  });
});
