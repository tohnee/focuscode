import { describe, expect, it } from "vitest";
import { classifyIntent, type ClassifyResult } from "../src/spec-classifier.js";
import { mockClient, mockClientSequence } from "../src/spec-pipeline-helpers.js";
import type { ModelProfile } from "../src/types.js";

const profile: ModelProfile = {
  provider: "test",
  model: "test-model",
  protocol: "openai-chat",
  baseUrl: "http://localhost",
  contextWindow: 32768,
  maxOutputTokens: 256,
  temperature: 0.1,
  toolMode: "auto",
  reasoningEffort: "minimal",
  capabilities: { input: ["text"], reasoning: false, toolCalling: false },
  compatibility: {},
  reliability: { timeoutMs: 5000, maxRetries: 1, retryBaseDelayMs: 100, retryMaximumDelayMs: 1000 },
};

describe("classifyIntent", () => {
  it("returns needsClarification=false for specific bug fix", async () => {
    const client = mockClient(
      JSON.stringify({
        needsClarification: false,
        confidence: 0.95,
        reason: "specific file and line",
      }),
    );
    const result = await classifyIntent(
      client,
      profile,
      "Fix typo in README.md line 42",
      "typescript-monorepo",
    );
    expect(result.needsClarification).toBe(false);
    expect(result.confidence).toBe(0.95);
  });

  it("returns needsClarification=true for vague goal", async () => {
    const client = mockClient(
      JSON.stringify({
        needsClarification: true,
        confidence: 0.95,
        reason: "vague goal",
      }),
    );
    const result = await classifyIntent(client, profile, "make it better", "typescript-monorepo");
    expect(result.needsClarification).toBe(true);
  });

  it("retries once on non-JSON output with temperature=0", async () => {
    const client = mockClientSequence([
      "not json",
      '{"needsClarification":true,"confidence":0.7,"reason":"vague"}',
    ]);
    const result = await classifyIntent(client, profile, "make it better", "typescript");
    expect(result.needsClarification).toBe(true);
    expect(result.confidence).toBe(0.7);
  });

  it("throws on second non-JSON output", async () => {
    const client = mockClientSequence(["not json", "still not json"]);
    await expect(classifyIntent(client, profile, "test", "typescript")).rejects.toThrow(/JSON/);
  });

  it("truncates long input to 500 chars", async () => {
    const longInput = "x".repeat(600);
    const client = mockClient(
      JSON.stringify({ needsClarification: false, confidence: 0.9, reason: "ok" }),
    );
    const result = await classifyIntent(client, profile, longInput, "typescript");
    expect(result.needsClarification).toBe(false);
  });

  it("respects abort signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = mockClient('{"needsClarification":false,"confidence":0.9,"reason":"ok"}');
    await expect(
      classifyIntent(client, profile, "test", "typescript", controller.signal),
    ).rejects.toThrow();
  });

  it("includes project type in user message", async () => {
    let capturedRequest: { messages: { content: string }[] } | undefined;
    const client: ReturnType<typeof mockClient> = {
      protocol: "openai-chat",
      async complete(request) {
        capturedRequest = request as { messages: { content: string }[] };
        return {
          content: JSON.stringify({ needsClarification: false, confidence: 0.9, reason: "ok" }),
          stopReason: "stop",
          toolCalls: [],
          usage: { inputTokens: 10, outputTokens: 20 },
        };
      },
    };
    await classifyIntent(client, profile, "fix bug", "python-package");
    expect(capturedRequest!.messages[0]!.content).toContain("python-package");
  });
});
