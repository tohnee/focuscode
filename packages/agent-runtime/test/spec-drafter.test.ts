import { describe, expect, it } from "vitest";
import { draftSpec } from "../src/spec-drafter.js";
import { mockClient, mockClientSequence } from "../src/spec-pipeline-helpers.js";
import type { ExplorerResult } from "../src/spec-types.js";
import type { ModelClient, ModelProfile, ModelRequest, ModelResponse } from "../src/types.js";

const profile: ModelProfile = {
  provider: "test",
  model: "test-model",
  protocol: "openai-chat",
  baseUrl: "http://localhost",
  contextWindow: 32768,
  maxOutputTokens: 2048,
  temperature: 0.3,
  toolMode: "auto",
  reasoningEffort: "low",
  capabilities: { input: ["text"], reasoning: false, toolCalling: false },
  compatibility: {},
  reliability: {
    timeoutMs: 30000,
    maxRetries: 1,
    retryBaseDelayMs: 100,
    retryMaximumDelayMs: 1000,
  },
};

const explorerResult: ExplorerResult = {
  entryPoints: ["src/main.ts:entry"],
  patterns: ["registry pattern"],
  testConventions: "vitest in test/",
  constraints: ["no external deps"],
  relevantFiles: ["src/main.ts"],
};

describe("draftSpec", () => {
  it("parses valid spec draft JSON", async () => {
    const client = mockClient(
      JSON.stringify({
        topic: "add-feature",
        understanding: {
          goal: "Add a feature",
          constraints: [{ source: "codebase", description: "no deps", severity: "hard" }],
          acceptanceCriteria: [{ description: "tests pass", verification: "test" }],
          affectedAreas: [{ path: "src/main.ts", impact: "modify", reason: "entry" }],
          ambiguities: [],
        },
        taskBreakdown: [
          {
            id: "t1",
            description: "impl",
            dependsOn: [],
            files: ["src/main.ts"],
            kind: "implement",
          },
        ],
      }),
    );
    const result = await draftSpec(client, profile, {
      prompt: "add a feature",
      explorerResult,
      instructionsSummary: "",
    });
    expect(result.topic).toBe("add-feature");
    expect(result.understanding.goal).toBe("Add a feature");
    expect(result.taskBreakdown).toHaveLength(1);
    expect(result.taskBreakdown[0]!.id).toBe("t1");
    expect(result.keyDecisions).toEqual([]);
    expect(result.id).toBeTruthy();
  });

  it("generates a spec ID", async () => {
    const client = mockClient(
      JSON.stringify({
        topic: "test",
        understanding: {
          goal: "g",
          constraints: [],
          acceptanceCriteria: [],
          affectedAreas: [],
          ambiguities: [],
        },
        taskBreakdown: [],
      }),
    );
    const result = await draftSpec(client, profile, {
      prompt: "test",
      explorerResult,
      instructionsSummary: "",
    });
    expect(result.id).toMatch(/^spec_\d+_[a-f0-9]+$/);
  });

  it("retries on non-JSON output", async () => {
    const client = mockClientSequence([
      "not json",
      JSON.stringify({
        topic: "t",
        understanding: {
          goal: "g",
          constraints: [],
          acceptanceCriteria: [],
          affectedAreas: [],
          ambiguities: [],
        },
        taskBreakdown: [],
      }),
    ]);
    const result = await draftSpec(client, profile, {
      prompt: "test",
      explorerResult,
      instructionsSummary: "",
    });
    expect(result.topic).toBe("t");
  });

  it("throws on second non-JSON output", async () => {
    const client = mockClientSequence(["not json", "still not json"]);
    await expect(
      draftSpec(client, profile, { prompt: "test", explorerResult, instructionsSummary: "" }),
    ).rejects.toThrow(/JSON/);
  });

  it("includes explorer result in user message", async () => {
    let capturedContent = "";
    const client: ModelClient = {
      protocol: "openai-chat",
      async complete(request: ModelRequest): Promise<ModelResponse> {
        capturedContent = request.messages[0]!.content;
        return {
          content: JSON.stringify({
            topic: "t",
            understanding: {
              goal: "g",
              constraints: [],
              acceptanceCriteria: [],
              affectedAreas: [],
              ambiguities: [],
            },
            taskBreakdown: [],
          }),
          stopReason: "stop",
          toolCalls: [],
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
    };
    await draftSpec(client, profile, {
      prompt: "add feature",
      explorerResult,
      instructionsSummary: "convention: TDD",
    });
    expect(capturedContent).toContain("src/main.ts:entry");
    expect(capturedContent).toContain("convention: TDD");
  });

  it("normalizes missing arrays to empty", async () => {
    const client = mockClient(
      JSON.stringify({
        topic: "t",
        understanding: { goal: "g" },
        taskBreakdown: [],
      }),
    );
    const result = await draftSpec(client, profile, {
      prompt: "test",
      explorerResult,
      instructionsSummary: "",
    });
    expect(result.understanding.constraints).toEqual([]);
    expect(result.understanding.acceptanceCriteria).toEqual([]);
    expect(result.understanding.affectedAreas).toEqual([]);
    expect(result.understanding.ambiguities).toEqual([]);
  });
});
