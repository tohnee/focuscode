import { describe, expect, it } from "vitest";
import type { SpecDraft, SpecKeyDecision } from "../src/spec-types.js";
import {
  parseJsonResponse,
  emptyExplorerResult,
  fallbackEnhance,
  mockClient,
  mockClientSequence,
} from "../src/spec-pipeline-helpers.js";

describe("parseJsonResponse", () => {
  it("parses valid JSON", () => {
    const result = parseJsonResponse('{"key":"value"}');
    expect(result).toEqual({ key: "value" });
  });

  it("strips markdown code fences", () => {
    const result = parseJsonResponse('```json\n{"key":"value"}\n```');
    expect(result).toEqual({ key: "value" });
  });

  it("strips plain code fences", () => {
    const result = parseJsonResponse('```\n{"key":"value"}\n```');
    expect(result).toEqual({ key: "value" });
  });

  it("returns null for non-JSON", () => {
    const result = parseJsonResponse("not json at all");
    expect(result).toBeNull();
  });

  it("returns null for partial JSON", () => {
    const result = parseJsonResponse('{"key":');
    expect(result).toBeNull();
  });
});

describe("emptyExplorerResult", () => {
  it("returns all fields empty", () => {
    const result = emptyExplorerResult();
    expect(result.entryPoints).toEqual([]);
    expect(result.patterns).toEqual([]);
    expect(result.testConventions).toBe("");
    expect(result.constraints).toEqual([]);
    expect(result.relevantFiles).toEqual([]);
  });
});

describe("fallbackEnhance", () => {
  it("builds prompt from draft goal and tasks", () => {
    const draft = {
      id: "spec_1",
      topic: "add-feature",
      understanding: {
        goal: "Add a new feature",
        constraints: [
          {
            source: "codebase" as const,
            description: "no external deps",
            severity: "hard" as const,
          },
        ],
        acceptanceCriteria: [{ description: "tests pass", verification: "test" as const }],
        affectedAreas: [{ path: "src/main.ts", impact: "modify" as const, reason: "entry" }],
        ambiguities: [],
      },
      taskBreakdown: [
        {
          id: "t1",
          description: "implement",
          dependsOn: [],
          files: ["src/main.ts"],
          kind: "implement" as const,
        },
      ],
      keyDecisions: [],
    };
    const result = fallbackEnhance(draft, []);
    expect(result).toContain("## Objective");
    expect(result).toContain("Add a new feature");
    expect(result).toContain("## Constraints");
    expect(result).toContain("no external deps");
    expect(result).toContain("## Acceptance Criteria");
    expect(result).toContain("tests pass");
    expect(result).toContain("## Execution Order");
    expect(result).toContain("t1: implement");
  });

  it("includes Confirmed Decisions section when decisions have chosen (M4)", () => {
    const draft: SpecDraft = {
      id: "spec-test",
      topic: "Test Topic",
      understanding: {
        goal: "Test goal",
        constraints: [],
        acceptanceCriteria: [],
        affectedAreas: [],
        ambiguities: [],
      },
      taskBreakdown: [],
      keyDecisions: [],
    };
    const decisions: SpecKeyDecision[] = [
      {
        id: "dec1",
        point: "Which library?",
        severity: "minor",
        options: [
          { label: "Option A", description: "first", tradeoffs: "none" },
          { label: "Option B", description: "second", tradeoffs: "none" },
        ],
        chosen: "Option A",
      },
    ];
    const result = fallbackEnhance(draft, decisions);
    expect(result).toContain("## Confirmed Decisions");
    expect(result).toContain("Option A");
    expect(result).toContain("Which library?");
  });
});

describe("mockClient", () => {
  it("returns fixed response", async () => {
    const client = mockClient('{"ok":true}');
    const response = await client.complete({
      model: "test",
      systemPrompt: "",
      messages: [],
      tools: [],
      temperature: 0,
      maxOutputTokens: 100,
    });
    expect(response.content).toBe('{"ok":true}');
    expect(response.stopReason).toBe("stop");
    expect(response.toolCalls).toEqual([]);
  });
});

describe("mockClientSequence", () => {
  it("returns responses in order", async () => {
    const client = mockClientSequence(["first", "second", "third"]);
    const req = {
      model: "t",
      systemPrompt: "",
      messages: [],
      tools: [],
      temperature: 0,
      maxOutputTokens: 1,
    };
    expect((await client.complete(req)).content).toBe("first");
    expect((await client.complete(req)).content).toBe("second");
    expect((await client.complete(req)).content).toBe("third");
  });

  it("repeats last response when exhausted", async () => {
    const client = mockClientSequence(["only"]);
    const req = {
      model: "t",
      systemPrompt: "",
      messages: [],
      tools: [],
      temperature: 0,
      maxOutputTokens: 1,
    };
    expect((await client.complete(req)).content).toBe("only");
    expect((await client.complete(req)).content).toBe("only");
  });

  it("throws clear error when response array is empty (M2)", async () => {
    const client = mockClientSequence([]);
    await expect(
      client.complete({
        model: "test",
        systemPrompt: "",
        messages: [],
        tools: [],
        temperature: 0,
        maxOutputTokens: 1,
      }),
    ).rejects.toThrow(/mockClientSequence.*empty|no responses/i);
  });
});
