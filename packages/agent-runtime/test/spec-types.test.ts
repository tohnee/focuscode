import { describe, expect, it } from "vitest";
import type { AgentEvent, ModelClient, ModelProfile } from "../src/types.js";
import type { AgentToolRegistry } from "../src/tools.js";
import type {
  SpecDocument,
  SpecUnderstanding,
  SpecConstraint,
  SpecAcceptanceCriterion,
  SpecAffectedArea,
  SpecAmbiguity,
  SpecTaskNode,
  SpecKeyDecision,
  SpecInitialTodo,
  SpecStatus,
  SpecPipelineTrace,
  SpecStageTrace,
  SpecClarifyInput,
  SpecClarifyResult,
  SpecDraft,
  ExplorerResult,
  SpecEngineOptions,
  SpecPipeline,
  SpecStageModel,
  SpecEngineDeps,
  KeyDecisionRule,
  SpecSummary,
} from "../src/spec-types.js";

describe("spec-types", () => {
  it("SpecDocument has all required fields", () => {
    const doc: SpecDocument = {
      id: "spec_1784767951_a3f2c1",
      createdAt: "2026-07-23T10:25:51Z",
      updatedAt: "2026-07-23T10:26:03Z",
      topic: "add-spec-engine",
      trigger: "explicit",
      originalInput: "add a spec engine",
      understanding: {
        goal: "Add SpecEngine",
        constraints: [],
        acceptanceCriteria: [],
        affectedAreas: [],
        ambiguities: [],
      },
      taskBreakdown: [],
      keyDecisions: [],
      enhancedPrompt: "enhanced",
      initialTodos: [],
      status: "draft",
      pipelineTrace: { stages: [], totalMs: 0, hadFallback: false },
    };
    expect(doc.id).toBe("spec_1784767951_a3f2c1");
    expect(doc.status).toBe("draft");
  });

  it("SpecStatus covers all lifecycle states", () => {
    const statuses: SpecStatus[] = [
      "draft",
      "confirming",
      "confirmed",
      "executing",
      "completed",
      "superseded",
      "aborted",
    ];
    expect(statuses).toHaveLength(7);
  });

  it("SpecClarifyResult discriminated union works", () => {
    const skip: SpecClarifyResult = { action: "skip", reason: "test" };
    const abort: SpecClarifyResult = { action: "abort", reason: "test" };
    const apply: SpecClarifyResult = {
      action: "apply",
      specId: "spec_1",
      enhancedPrompt: "p",
      initialTodos: [],
      specPath: "/tmp/spec.md",
    };
    expect(skip.action).toBe("skip");
    expect(abort.action).toBe("abort");
    expect(apply.action).toBe("apply");
  });

  it("SpecStageTrace name includes persist", () => {
    const trace: SpecStageTrace = {
      name: "persist",
      model: "none",
      durationMs: 0,
      fellBack: false,
    };
    expect(trace.name).toBe("persist");
  });

  it("SpecStageModel has profile, client, fallback", () => {
    const stage: SpecStageModel = {
      profile: {} as never,
      client: {} as never,
      fallback: "primary",
    };
    expect(stage.fallback).toBe("primary");
  });

  it("ExplorerResult has all fields", () => {
    const result: ExplorerResult = {
      entryPoints: ["src/main.ts:entry"],
      patterns: ["registry:tool pattern"],
      testConventions: "vitest in test/",
      constraints: ["no external deps"],
      relevantFiles: ["src/main.ts"],
    };
    expect(result.entryPoints).toHaveLength(1);
  });

  it("KeyDecisionRule has name and description", () => {
    const rule: KeyDecisionRule = { name: "destructive-change", description: "deletes files" };
    expect(rule.name).toBe("destructive-change");
  });

  it("SpecClarifyInput has required fields for submit() integration", () => {
    const input: SpecClarifyInput = {
      prompt: "fix bug",
      cwd: "/tmp",
      sessionBranch: [],
      modelClient: {} as never,
      model: {} as never,
      toolRegistry: {} as never,
    };
    expect(input.prompt).toBe("fix bug");
  });

  it("SpecClarifyInput.eventSink accepts AgentEvent-typed callback (M1)", () => {
    const input: SpecClarifyInput = {
      prompt: "test",
      cwd: "/tmp",
      sessionBranch: [],
      modelClient: {} as ModelClient,
      model: { provider: "test", model: "test" } as ModelProfile,
      toolRegistry: {} as AgentToolRegistry,
      eventSink: (event: AgentEvent) => {
        if (event.type === "spec_start") {
          // Type narrowing must work — would fail to compile if eventSink were `unknown`
          void event.input;
        }
      },
    };
    expect(typeof input.eventSink).toBe("function");
  });
});
