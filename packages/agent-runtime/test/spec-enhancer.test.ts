import { describe, expect, it } from "vitest";
import { enhancePrompt } from "../src/spec-enhancer.js";
import { fallbackEnhance, mockClient } from "../src/spec-pipeline-helpers.js";
import type { SpecDraft, SpecKeyDecision } from "../src/spec-types.js";
import type { ModelProfile } from "../src/types.js";

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

const draft: SpecDraft = {
  id: "spec_1",
  topic: "add-feature",
  understanding: {
    goal: "Add a feature",
    constraints: [{ source: "codebase", description: "no deps", severity: "hard" }],
    acceptanceCriteria: [{ description: "tests pass", verification: "test" }],
    affectedAreas: [{ path: "src/main.ts", impact: "modify", reason: "entry" }],
    ambiguities: [],
  },
  taskBreakdown: [
    { id: "t1", description: "impl", dependsOn: [], files: ["src/main.ts"], kind: "implement" },
  ],
  keyDecisions: [],
};

const decisions: SpecKeyDecision[] = [
  {
    id: "d1",
    point: "use approach A or B?",
    options: [{ label: "A", description: "a", tradeoffs: "t" }],
    chosen: "A",
    severity: "major",
  },
];

describe("enhancePrompt", () => {
  it("returns model's text output directly", async () => {
    const client = mockClient("## Objective\nAdd a feature\n\n## Constraints\n- no deps");
    const result = await enhancePrompt(client, profile, { draft, confirmedDecisions: decisions });
    expect(result).toContain("## Objective");
    expect(result).toContain("Add a feature");
  });

  it("includes confirmed decisions in user message", async () => {
    let captured = "";
    const client = {
      protocol: "openai-chat",
      async complete(request: { messages: { content: string }[] }) {
        captured = request.messages[0]!.content;
        return {
          content: "enhanced",
          stopReason: "stop",
          toolCalls: [],
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
    };
    await enhancePrompt(client, profile, { draft, confirmedDecisions: decisions });
    expect(captured).toContain("use approach A or B?");
    expect(captured).toContain("chosen: A");
  });

  it("works with empty decisions", async () => {
    const client = mockClient("## Objective\ntest");
    const result = await enhancePrompt(client, profile, { draft, confirmedDecisions: [] });
    expect(result).toBe("## Objective\ntest");
  });

  it("returns raw content even if not formatted", async () => {
    const client = mockClient("just plain text");
    const result = await enhancePrompt(client, profile, { draft, confirmedDecisions: [] });
    expect(result).toBe("just plain text");
  });

  it("trims whitespace from output", async () => {
    const client = mockClient("  ## Objective\n\ntest  \n\n");
    const result = await enhancePrompt(client, profile, { draft, confirmedDecisions: [] });
    expect(result).toBe("## Objective\n\ntest");
  });

  it("includes spec draft JSON in user message", async () => {
    let captured = "";
    const client = {
      protocol: "openai-chat",
      async complete(request: { messages: { content: string }[] }) {
        captured = request.messages[0]!.content;
        return {
          content: "ok",
          stopReason: "stop",
          toolCalls: [],
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
    };
    await enhancePrompt(client, profile, { draft, confirmedDecisions: [] });
    expect(captured).toContain("Add a feature");
    expect(captured).toContain("src/main.ts");
  });

  it("SYSTEM_PROMPT instructs model to emit ## Confirmed Decisions matching fallbackEnhance (M8)", async () => {
    // The system prompt sent to the model must instruct it to emit a
    // `## Confirmed Decisions` section so the happy-path output matches
    // the fallbackEnhance format (which already emits this section).
    let capturedSystemPrompt = "";
    const client = {
      protocol: "openai-chat",
      async complete(request: { systemPrompt: string }) {
        capturedSystemPrompt = request.systemPrompt;
        return {
          content: "ok",
          stopReason: "stop",
          toolCalls: [],
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
    };
    await enhancePrompt(client, profile, { draft, confirmedDecisions: decisions });
    expect(capturedSystemPrompt).toContain("## Confirmed Decisions");

    // fallbackEnhance already emits the section — verify parity of the header
    const fallbackResult = fallbackEnhance(draft, decisions);
    expect(fallbackResult).toContain("## Confirmed Decisions");
  });
});
