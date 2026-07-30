import { describe, expect, it } from "vitest";
import {
  CircuitBreakingModelClient,
  FallbackModelClient,
  type ModelClient,
  type ModelProfile,
  type ModelRequest,
  type ModelResponse,
} from "@focuscode/agent-runtime";
import { buildModelClientChain } from "../src/model-client-chain.js";

class StubClient implements ModelClient {
  readonly protocol: string;
  constructor(protocol: string) {
    this.protocol = protocol;
  }
  async complete(): Promise<ModelResponse> {
    return {
      content: "",
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: "stop",
    };
  }
}

function primaryProfile(provider = "ollama"): ModelProfile {
  return {
    provider,
    model: "primary",
    protocol: "openai-chat",
    baseUrl: "http://127.0.0.1:11434/v1",
    contextWindow: 32_768,
    maxOutputTokens: 8_192,
    temperature: 0,
    toolMode: "auto",
    reasoningEffort: "off",
    capabilities: { input: ["text"], reasoning: false, toolCalling: true },
    compatibility: {
      supportsParallelToolCalls: true,
      supportsStreamUsage: true,
      supportsToolChoice: true,
      supportsTemperature: true,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
      thinkingFormat: "openai",
      requiresReasoningContentOnAssistantMessages: false,
      requiresToolResultName: false,
      requiresAssistantContentForToolCalls: false,
      zaiToolStream: false,
      reasoningEffortMap: {},
      anthropicThinking: "omit",
      anthropicThinkingBudgetTokens: 16_384,
    },
    reliability: {
      timeoutMs: 30_000,
      maxRetries: 0,
      retryBaseDelayMs: 100,
      retryMaximumDelayMs: 1_000,
      circuitThreshold: 5,
      circuitCooldownMs: 10_000,
      maxConcurrency: 4,
    },
  };
}

function fallbackProfile(provider = "openrouter", model = "secondary"): ModelProfile {
  return { ...primaryProfile(provider), model, baseUrl: "https://openrouter.ai/api/v1" };
}

describe("buildModelClientChain (SDK)", () => {
  it("returns a CircuitBreakingModelClient when no fallbacks are declared", () => {
    const client = buildModelClientChain(primaryProfile(), [], {
      factory: () => new StubClient("openai-chat"),
    });
    expect(client).toBeInstanceOf(CircuitBreakingModelClient);
    expect(client).not.toBeInstanceOf(FallbackModelClient);
  });

  it("wraps the primary in a FallbackModelClient when fallbacks are declared", () => {
    const client = buildModelClientChain(primaryProfile(), [fallbackProfile()], {
      factory: () => new StubClient("openai-chat"),
    });
    expect(client).toBeInstanceOf(FallbackModelClient);
  });

  it("creates one fallback client per declared fallback profile", () => {
    const created: string[] = [];
    const client = buildModelClientChain(
      primaryProfile(),
      [fallbackProfile("openrouter", "a"), fallbackProfile("deepseek", "b")],
      {
        factory: (profile) => {
          created.push(`${profile.provider}/${profile.model}`);
          return new StubClient(profile.protocol);
        },
      },
    );
    expect(client).toBeInstanceOf(FallbackModelClient);
    expect(created).toEqual(["ollama/primary", "openrouter/a", "deepseek/b"]);
  });

  it("emits onFallback events with provider/model labels for observability", async () => {
    const events: Array<{ from: string; to: string; reason: string }> = [];
    let callCount = 0;
    const client = buildModelClientChain(primaryProfile(), [fallbackProfile()], {
      factory: () => ({
        protocol: "openai-chat",
        async complete(_req: ModelRequest): Promise<ModelResponse> {
          callCount += 1;
          if (callCount === 1) {
            return {
              content: "",
              toolCalls: [],
              usage: { inputTokens: 0, outputTokens: 0 },
              stopReason: "error",
            };
          }
          return {
            content: "recovered",
            toolCalls: [],
            usage: { inputTokens: 0, outputTokens: 0 },
            stopReason: "stop",
          };
        },
      }),
      onFallback: (e) => events.push(e),
    });
    const response = await client.complete({
      model: "primary",
      systemPrompt: "",
      messages: [],
      tools: [],
      temperature: 0,
      maxOutputTokens: 100,
    });
    expect(response.content).toBe("recovered");
    expect(events).toHaveLength(1);
    expect(events[0]?.from).toBe("primary");
    expect(events[0]?.to).toBe("fallback[0]");
  });
});
