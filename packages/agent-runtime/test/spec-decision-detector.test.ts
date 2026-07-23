import { describe, expect, it } from "vitest";
import { detectDecisions } from "../src/spec-decision-detector.js";
import { mockClient, mockClientSequence } from "../src/spec-pipeline-helpers.js";
import type { KeyDecisionRule, SpecDraft } from "../src/spec-types.js";
import type { ModelClient, ModelProfile, ModelRequest, ModelResponse } from "../src/types.js";

const profile: ModelProfile = {
  provider: "test",
  model: "test-model",
  protocol: "openai-chat",
  baseUrl: "http://localhost",
  contextWindow: 32768,
  maxOutputTokens: 1024,
  temperature: 0.1,
  toolMode: "auto",
  reasoningEffort: "minimal",
  capabilities: { input: ["text"], reasoning: false, toolCalling: false },
  compatibility: {},
  reliability: {
    timeoutMs: 10000,
    maxRetries: 1,
    retryBaseDelayMs: 100,
    retryMaximumDelayMs: 1000,
  },
};

const draft: SpecDraft = {
  id: "spec_1",
  topic: "test",
  understanding: {
    goal: "test goal",
    constraints: [],
    acceptanceCriteria: [],
    affectedAreas: [{ path: "src/old.ts", impact: "delete", reason: "removing old code" }],
    ambiguities: [],
  },
  taskBreakdown: [],
  keyDecisions: [],
};

const rules: KeyDecisionRule[] = [
  {
    name: "destructive-change",
    description: "Any task that deletes files or removes functionality",
  },
  { name: "arch-decision", description: "Choice between fundamentally different approaches" },
];

describe("detectDecisions", () => {
  it("returns empty array when model outputs []", async () => {
    const client = mockClient("[]");
    const result = await detectDecisions(client, profile, draft, rules);
    expect(result).toEqual([]);
  });

  it("parses decisions with severity", async () => {
    const client = mockClient(
      JSON.stringify([
        {
          id: "d1",
          point: "Delete old file?",
          options: [
            { label: "A", description: "delete", tradeoffs: "clean but destructive" },
            { label: "B", description: "keep", tradeoffs: "safe but cluttered" },
          ],
          severity: "critical",
        },
      ]),
    );
    const result = await detectDecisions(client, profile, draft, rules);
    expect(result).toHaveLength(1);
    expect(result[0]!.severity).toBe("critical");
    expect(result[0]!.options).toHaveLength(2);
  });

  it("retries on non-JSON output", async () => {
    const client = mockClientSequence(["not json", "[]"]);
    const result = await detectDecisions(client, profile, draft, rules);
    expect(result).toEqual([]);
  });

  it("throws on second non-JSON output", async () => {
    const client = mockClientSequence(["not json", "still not"]);
    await expect(detectDecisions(client, profile, draft, rules)).rejects.toThrow(/JSON/);
  });

  it("filters out malformed decisions", async () => {
    const client = mockClient(
      JSON.stringify([
        { id: "d1", point: "valid", options: [], severity: "major" },
        { id: "", point: "invalid no id", options: [], severity: "minor" },
        { id: "d3", point: "invalid no options", options: "not array", severity: "minor" },
      ]),
    );
    const result = await detectDecisions(client, profile, draft, rules);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("d1");
  });

  it("includes rules in user message", async () => {
    let captured = "";
    const client: ModelClient = {
      protocol: "openai-chat",
      async complete(request: ModelRequest): Promise<ModelResponse> {
        captured = request.messages[0]!.content;
        return {
          content: "[]",
          stopReason: "stop",
          toolCalls: [],
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
    };
    await detectDecisions(client, profile, draft, rules);
    expect(captured).toContain("destructive-change");
    expect(captured).toContain("arch-decision");
  });

  it("normalizes unknown severity to minor", async () => {
    const client = mockClient(
      JSON.stringify([
        {
          id: "d1",
          point: "p",
          options: [{ label: "A", description: "d", tradeoffs: "t" }],
          severity: "unknown",
        },
      ]),
    );
    const result = await detectDecisions(client, profile, draft, rules);
    expect(result[0]!.severity).toBe("minor");
  });

  it("defaults missing options to empty array", async () => {
    const client = mockClient(JSON.stringify([{ id: "d1", point: "p", severity: "minor" }]));
    const result = await detectDecisions(client, profile, draft, rules);
    expect(result[0]!.options).toEqual([]);
  });
});
