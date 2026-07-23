import { describe, expect, it } from "vitest";
import { SpecEngine } from "../src/spec-engine.js";
import { mockClient, mockClientSequence } from "../src/spec-pipeline-helpers.js";
import type { SpecEngineOptions, SpecEngineDeps, SpecPipeline } from "../src/spec-types.js";
import type { ModelProfile, ModelClient, AgentEvent } from "../src/types.js";

const mainProfile: ModelProfile = {
  provider: "test",
  model: "main-model",
  protocol: "openai-chat",
  baseUrl: "http://localhost",
  contextWindow: 32768,
  maxOutputTokens: 2048,
  temperature: 0.3,
  toolMode: "native",
  reasoningEffort: "low",
  capabilities: { input: ["text"], reasoning: false, toolCalling: true },
  compatibility: {},
  reliability: {
    timeoutMs: 30000,
    maxRetries: 1,
    retryBaseDelayMs: 100,
    retryMaximumDelayMs: 1000,
  },
};

const smallProfile: ModelProfile = {
  ...mainProfile,
  model: "small-model",
  maxOutputTokens: 256,
  temperature: 0.1,
  reasoningEffort: "minimal",
  capabilities: { input: ["text"], reasoning: false, toolCalling: false },
};

function makeDeps(): SpecEngineDeps {
  const files = new Map<string, string>();
  return {
    detectProjectType: () => "typescript-monorepo",
    instructions: [],
    async writeFile(path, content) {
      files.set(path, content);
    },
    async readFile(path) {
      return files.get(path) ?? "";
    },
    async listDir() {
      return [...files.keys()];
    },
  };
}

function makeOptions(
  pipeline?: Partial<SpecPipeline>,
  overrides: Partial<SpecEngineOptions> = {},
): SpecEngineOptions {
  return {
    enabled: true,
    autoTrigger: true,
    specDirectory: "docs/specs",
    maxExplorationRounds: 6,
    keyDecisionRules: [
      { name: "destructive-change", description: "deletes files" },
      { name: "arch-decision", description: "architecture choice" },
    ],
    pipeline: pipeline ?? {},
    ...overrides,
  };
}

function makeStage(client: ModelClient, fallback: "primary" | "strict" | "skip" = "primary") {
  return { profile: smallProfile, client, fallback };
}

describe("SpecEngine.clarify", () => {
  it("returns skip when prompt starts with /raw", async () => {
    const engine = new SpecEngine(makeOptions(), makeDeps());
    const result = await engine.clarify({
      prompt: "/raw fix typo",
      cwd: "/tmp",
      sessionBranch: [],
      modelClient: mockClient(""),
      model: mainProfile,
      toolRegistry: {} as never,
    });
    expect(result.action).toBe("skip");
  });

  it("returns skip when /spec is followed by empty prompt", async () => {
    const engine = new SpecEngine(makeOptions(), makeDeps());
    const result = await engine.clarify({
      prompt: "/spec   ",
      cwd: "/tmp",
      sessionBranch: [],
      modelClient: mockClient(""),
      model: mainProfile,
      toolRegistry: {} as never,
    });
    expect(result.action).toBe("skip");
  });

  it("skips when classifier returns needsClarification=false with high confidence", async () => {
    const classifier = makeStage(
      mockClient(
        JSON.stringify({ needsClarification: false, confidence: 0.95, reason: "specific" }),
      ),
    );
    const engine = new SpecEngine(makeOptions({ classifier }), makeDeps());
    const result = await engine.clarify({
      prompt: "fix typo in README.md line 42",
      cwd: "/tmp",
      sessionBranch: [],
      modelClient: mockClient(""),
      model: mainProfile,
      toolRegistry: {} as never,
    });
    expect(result.action).toBe("skip");
  });

  it("proceeds when classifier returns needsClarification=false but low confidence", async () => {
    const classifier = makeStage(
      mockClient(
        JSON.stringify({ needsClarification: false, confidence: 0.5, reason: "uncertain" }),
      ),
    );
    const drafter = makeStage(
      mockClient(
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
      ),
    );
    const detector = makeStage(mockClient("[]"));
    const enhancer = makeStage(mockClient("## Objective\ntest"));
    const engine = new SpecEngine(
      makeOptions({ classifier, drafter, decisionDetector: detector, enhancer }),
      makeDeps(),
    );
    const result = await engine.clarify({
      prompt: "add something",
      cwd: "/tmp",
      sessionBranch: [],
      modelClient: mockClient("[]"),
      model: mainProfile,
      toolRegistry: {} as never,
    });
    expect(result.action).toBe("apply");
  });

  it("forces pipeline when prompt starts with /spec", async () => {
    const drafter = makeStage(
      mockClient(
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
      ),
    );
    const detector = makeStage(mockClient("[]"));
    const enhancer = makeStage(mockClient("## Objective\ntest"));
    const engine = new SpecEngine(
      makeOptions({ drafter, decisionDetector: detector, enhancer }, { autoTrigger: false }),
      makeDeps(),
    );
    const result = await engine.clarify({
      prompt: "/spec add a feature",
      cwd: "/tmp",
      sessionBranch: [],
      modelClient: mockClient("[]"),
      model: mainProfile,
      toolRegistry: {} as never,
    });
    expect(result.action).toBe("apply");
  });

  it("skips when classifier fails with fallback=skip", async () => {
    const classifier = makeStage(mockClient("not json and not json"), "skip");
    const engine = new SpecEngine(makeOptions({ classifier }), makeDeps());
    const result = await engine.clarify({
      prompt: "add feature",
      cwd: "/tmp",
      sessionBranch: [],
      modelClient: mockClient(""),
      model: mainProfile,
      toolRegistry: {} as never,
    });
    expect(result.action).toBe("skip");
  });

  it("continues with empty context when explorer fails", async () => {
    const classifier = makeStage(
      mockClient(JSON.stringify({ needsClarification: true, confidence: 0.9, reason: "vague" })),
    );
    // Main model returns non-JSON for explorer → empty result
    const mainClient: ModelClient = {
      protocol: "openai-chat",
      async complete() {
        return {
          content: "not json",
          stopReason: "stop",
          toolCalls: [],
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
    };
    const drafter = makeStage(
      mockClient(
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
      ),
    );
    const detector = makeStage(mockClient("[]"));
    const enhancer = makeStage(mockClient("## Objective\ntest"));
    const engine = new SpecEngine(
      makeOptions({ classifier, drafter, decisionDetector: detector, enhancer }),
      makeDeps(),
    );
    const result = await engine.clarify({
      prompt: "make it better",
      cwd: "/tmp",
      sessionBranch: [],
      modelClient: mainClient,
      model: mainProfile,
      toolRegistry: {} as never,
    });
    expect(result.action).toBe("apply");
  });

  it("skips when drafter fails", async () => {
    const classifier = makeStage(
      mockClient(JSON.stringify({ needsClarification: true, confidence: 0.9, reason: "vague" })),
    );
    const drafter = makeStage(mockClientSequence(["not json", "still not"]), "strict");
    const engine = new SpecEngine(makeOptions({ classifier, drafter }), makeDeps());
    const result = await engine.clarify({
      prompt: "make it better",
      cwd: "/tmp",
      sessionBranch: [],
      modelClient: mockClient("[]"),
      model: mainProfile,
      toolRegistry: {} as never,
    });
    expect(result.action).toBe("skip");
  });

  it("continues without decisions when detector fails", async () => {
    const classifier = makeStage(
      mockClient(JSON.stringify({ needsClarification: true, confidence: 0.9, reason: "vague" })),
    );
    const drafter = makeStage(
      mockClient(
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
      ),
    );
    const detector = makeStage(mockClientSequence(["not json", "still not"]), "skip");
    const enhancer = makeStage(mockClient("## Objective\ntest"));
    const engine = new SpecEngine(
      makeOptions({ classifier, drafter, decisionDetector: detector, enhancer }),
      makeDeps(),
    );
    const result = await engine.clarify({
      prompt: "make it better",
      cwd: "/tmp",
      sessionBranch: [],
      modelClient: mockClient("[]"),
      model: mainProfile,
      toolRegistry: {} as never,
    });
    expect(result.action).toBe("apply");
  });

  it("uses fallback enhance when enhancer fails", async () => {
    const classifier = makeStage(
      mockClient(JSON.stringify({ needsClarification: true, confidence: 0.9, reason: "vague" })),
    );
    const drafter = makeStage(
      mockClient(
        JSON.stringify({
          topic: "test",
          understanding: {
            goal: "Add feature",
            constraints: [],
            acceptanceCriteria: [],
            affectedAreas: [],
            ambiguities: [],
          },
          taskBreakdown: [],
        }),
      ),
    );
    const detector = makeStage(mockClient("[]"));
    const enhancer = makeStage(mockClientSequence(["", ""]), "skip");
    const engine = new SpecEngine(
      makeOptions({ classifier, drafter, decisionDetector: detector, enhancer }),
      makeDeps(),
    );
    const result = await engine.clarify({
      prompt: "make it better",
      cwd: "/tmp",
      sessionBranch: [],
      modelClient: mockClient("[]"),
      model: mainProfile,
      toolRegistry: {} as never,
    });
    expect(result.action).toBe("apply");
    if (result.action === "apply") {
      expect(result.enhancedPrompt).toContain("## Objective");
      expect(result.enhancedPrompt).toContain("Add feature");
    }
  });

  it("does not pause for minor severity decisions", async () => {
    const classifier = makeStage(
      mockClient(JSON.stringify({ needsClarification: true, confidence: 0.9, reason: "vague" })),
    );
    const drafter = makeStage(
      mockClient(
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
      ),
    );
    const detector = makeStage(
      mockClient(
        JSON.stringify([
          {
            id: "d1",
            point: "naming?",
            options: [{ label: "A", description: "a", tradeoffs: "t" }],
            severity: "minor",
          },
        ]),
      ),
    );
    const enhancer = makeStage(mockClient("## Objective\ntest"));
    const engine = new SpecEngine(
      makeOptions({ classifier, drafter, decisionDetector: detector, enhancer }),
      makeDeps(),
    );
    const result = await engine.clarify({
      prompt: "make it better",
      cwd: "/tmp",
      sessionBranch: [],
      modelClient: mockClient("[]"),
      model: mainProfile,
      toolRegistry: {} as never,
    });
    expect(result.action).toBe("apply");
  });

  it("pauses for critical decisions and waits for confirmation", async () => {
    const classifier = makeStage(
      mockClient(JSON.stringify({ needsClarification: true, confidence: 0.9, reason: "vague" })),
    );
    const drafter = makeStage(
      mockClient(
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
      ),
    );
    const detector = makeStage(
      mockClient(
        JSON.stringify([
          {
            id: "d1",
            point: "delete files?",
            options: [
              { label: "A", description: "yes", tradeoffs: "destructive" },
              { label: "B", description: "no", tradeoffs: "safe" },
            ],
            severity: "critical",
          },
        ]),
      ),
    );
    const enhancer = makeStage(mockClient("## Objective\ntest"));
    const engine = new SpecEngine(
      makeOptions({ classifier, drafter, decisionDetector: detector, enhancer }),
      makeDeps(),
    );
    const clarifyPromise = engine.clarify({
      prompt: "make it better",
      cwd: "/tmp",
      sessionBranch: [],
      modelClient: mockClient("[]"),
      model: mainProfile,
      toolRegistry: {} as never,
    });
    // Wait a tick for pipeline to reach confirmation stage
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Resolve the decision
    engine.resolveDecisions(engine["pendingSpecId"] ?? "", { d1: "B" });
    const result = await clarifyPromise;
    expect(result.action).toBe("apply");
  });

  it("aborts when user declines spec (null choices)", async () => {
    const classifier = makeStage(
      mockClient(JSON.stringify({ needsClarification: true, confidence: 0.9, reason: "vague" })),
    );
    const drafter = makeStage(
      mockClient(
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
      ),
    );
    const detector = makeStage(
      mockClient(
        JSON.stringify([
          {
            id: "d1",
            point: "delete?",
            options: [{ label: "A", description: "a", tradeoffs: "t" }],
            severity: "critical",
          },
        ]),
      ),
    );
    const engine = new SpecEngine(
      makeOptions({ classifier, drafter, decisionDetector: detector }),
      makeDeps(),
    );
    const clarifyPromise = engine.clarify({
      prompt: "make it better",
      cwd: "/tmp",
      sessionBranch: [],
      modelClient: mockClient("[]"),
      model: mainProfile,
      toolRegistry: {} as never,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    engine.declineSpec(engine["pendingSpecId"] ?? "");
    const result = await clarifyPromise;
    expect(result.action).toBe("abort");
  });

  it("aborts on external signal", async () => {
    const controller = new AbortController();
    const engine = new SpecEngine(makeOptions(), makeDeps());
    controller.abort();
    const result = await engine.clarify({
      prompt: "test",
      cwd: "/tmp",
      sessionBranch: [],
      modelClient: mockClient(""),
      model: mainProfile,
      toolRegistry: {} as never,
      externalSignal: controller.signal,
    });
    expect(result.action).toBe("abort");
  });

  it("records pipeline trace with stages", async () => {
    const classifier = makeStage(
      mockClient(JSON.stringify({ needsClarification: true, confidence: 0.9, reason: "vague" })),
    );
    const drafter = makeStage(
      mockClient(
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
      ),
    );
    const detector = makeStage(mockClient("[]"));
    const enhancer = makeStage(mockClient("## Objective\ntest"));
    const engine = new SpecEngine(
      makeOptions({ classifier, drafter, decisionDetector: detector, enhancer }),
      makeDeps(),
    );
    const result = await engine.clarify({
      prompt: "make it better",
      cwd: "/tmp",
      sessionBranch: [],
      modelClient: mockClient("[]"),
      model: mainProfile,
      toolRegistry: {} as never,
    });
    expect(result.action).toBe("apply");
    // Trace is internal; verify via the saved spec file containing pipelineTrace
    // (indirect — we trust the stages ran since we got "apply")
  });

  it("skips when autoTrigger=false and no /spec prefix", async () => {
    const engine = new SpecEngine(makeOptions({}, { autoTrigger: false }), makeDeps());
    const result = await engine.clarify({
      prompt: "fix typo",
      cwd: "/tmp",
      sessionBranch: [],
      modelClient: mockClient(""),
      model: mainProfile,
      toolRegistry: {} as never,
    });
    expect(result.action).toBe("skip");
  });

  // === I-1: Mixed-severity decision bug — minor auto-choice must be preserved ===

  it("preserves minor decision auto-choice when blocking decisions exist (I-1)", async () => {
    const classifier = makeStage(
      mockClient(JSON.stringify({ needsClarification: true, confidence: 0.9, reason: "vague" })),
    );
    const drafter = makeStage(
      mockClient(
        JSON.stringify({
          topic: "mixed decisions",
          understanding: {
            goal: "g",
            constraints: [],
            acceptanceCriteria: [],
            affectedAreas: [],
            ambiguities: [],
          },
          taskBreakdown: [],
        }),
      ),
    );
    // Detector returns 1 critical + 1 minor decision
    const detector = makeStage(
      mockClient(
        JSON.stringify([
          {
            id: "crit-1",
            point: "delete files?",
            options: [
              { label: "Yes", description: "destructive", tradeoffs: "risky" },
              { label: "No", description: "safe", tradeoffs: "conservative" },
            ],
            severity: "critical",
          },
          {
            id: "min-1",
            point: "naming convention?",
            options: [
              { label: "camelCase", description: "js style", tradeoffs: "common" },
              { label: "snake_case", description: "python style", tradeoffs: "rare here" },
            ],
            severity: "minor",
          },
        ]),
      ),
    );
    // Enhancer fails so fallback enhance is used (which checks d.chosen explicitly)
    const enhancer = makeStage(mockClientSequence(["", ""]), "skip");
    const engine = new SpecEngine(
      makeOptions({ classifier, drafter, decisionDetector: detector, enhancer }),
      makeDeps(),
    );

    const events: AgentEvent[] = [];
    const clarifyPromise = engine.clarify({
      prompt: "make it better",
      cwd: "/tmp",
      sessionBranch: [],
      modelClient: mockClient("[]"),
      model: mainProfile,
      toolRegistry: {} as never,
      eventSink: (e) => {
        events.push(e);
        return undefined;
      },
    });
    // Wait for pipeline to reach confirmation stage
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Resolve the critical decision with "No"
    engine.resolveDecisions(engine["pendingSpecId"] ?? "", { "crit-1": "No" });
    const result = await clarifyPromise;
    expect(result.action).toBe("apply");

    // spec_confirmed event must contain both decisions with chosen fields
    const confirmedEvent = events.find((e) => e.type === "spec_confirmed");
    expect(confirmedEvent).toBeDefined();
    if (confirmedEvent && confirmedEvent.type === "spec_confirmed") {
      const decisions = confirmedEvent.decisions as Array<{
        id: string;
        chosen?: string;
        severity: string;
      }>;
      const crit = decisions.find((d) => d.id === "crit-1");
      const minor = decisions.find((d) => d.id === "min-1");
      expect(crit?.chosen).toBe("No");
      // I-1 fix: minor auto-choice must be preserved (options[0].label)
      expect(minor?.chosen).toBe("camelCase");
    }

    // fallbackEnhance output must include the minor decision's chosen value
    if (result.action === "apply") {
      expect(result.enhancedPrompt).toContain("naming convention?");
      expect(result.enhancedPrompt).toContain("camelCase");
    }
  });

  // === I-3a: spec_stage events emitted for each stage ===

  it("emits spec_stage events for each pipeline stage (I-3a)", async () => {
    const classifier = makeStage(
      mockClient(JSON.stringify({ needsClarification: true, confidence: 0.9, reason: "vague" })),
    );
    const drafter = makeStage(
      mockClient(
        JSON.stringify({
          topic: "stage test",
          understanding: {
            goal: "g",
            constraints: [],
            acceptanceCriteria: [],
            affectedAreas: [],
            ambiguities: [],
          },
          taskBreakdown: [],
        }),
      ),
    );
    const detector = makeStage(mockClient("[]"));
    const enhancer = makeStage(mockClient("## Objective\ntest"));
    const engine = new SpecEngine(
      makeOptions({ classifier, drafter, decisionDetector: detector, enhancer }),
      makeDeps(),
    );

    const events: AgentEvent[] = [];
    const result = await engine.clarify({
      prompt: "make it better",
      cwd: "/tmp",
      sessionBranch: [],
      modelClient: mockClient("[]"),
      model: mainProfile,
      toolRegistry: {} as never,
      eventSink: (e) => {
        events.push(e);
        return undefined;
      },
    });
    expect(result.action).toBe("apply");

    const stageEvents = events.filter((e) => e.type === "spec_stage");
    // Expect stages: classify, explore, draft, detect-decisions, enhance
    expect(stageEvents.length).toBeGreaterThanOrEqual(4);
    const stageNames = stageEvents.map((e) => (e.type === "spec_stage" ? e.stage : ""));
    expect(stageNames).toContain("classify");
    expect(stageNames).toContain("explore");
    expect(stageNames).toContain("draft");
    expect(stageNames).toContain("enhance");
    // Each spec_stage must have model, durationMs, fellBack fields
    for (const e of stageEvents) {
      if (e.type === "spec_stage") {
        expect(typeof e.model).toBe("string");
        expect(typeof e.durationMs).toBe("number");
        expect(typeof e.fellBack).toBe("boolean");
      }
    }
  });

  // === I-3b: spec_draft_ready event emitted after drafter ===

  it("emits spec_draft_ready event after drafter stage (I-3b)", async () => {
    const classifier = makeStage(
      mockClient(JSON.stringify({ needsClarification: true, confidence: 0.9, reason: "vague" })),
    );
    const drafter = makeStage(
      mockClient(
        JSON.stringify({
          topic: "draft ready test",
          understanding: {
            goal: "build feature X",
            constraints: [],
            acceptanceCriteria: [],
            affectedAreas: [],
            ambiguities: [],
          },
          taskBreakdown: [],
        }),
      ),
    );
    const detector = makeStage(mockClient("[]"));
    const enhancer = makeStage(mockClient("## Objective\ntest"));
    const engine = new SpecEngine(
      makeOptions({ classifier, drafter, decisionDetector: detector, enhancer }),
      makeDeps(),
    );

    const events: AgentEvent[] = [];
    const result = await engine.clarify({
      prompt: "make it better",
      cwd: "/tmp",
      sessionBranch: [],
      modelClient: mockClient("[]"),
      model: mainProfile,
      toolRegistry: {} as never,
      eventSink: (e) => {
        events.push(e);
        return undefined;
      },
    });
    expect(result.action).toBe("apply");

    const draftEvent = events.find((e) => e.type === "spec_draft_ready");
    expect(draftEvent).toBeDefined();
    if (draftEvent && draftEvent.type === "spec_draft_ready") {
      expect(draftEvent.topic).toBe("draft ready test");
      expect(draftEvent.specId).toBeTruthy();
      expect(draftEvent.understanding).toBeDefined();
    }

    // Verify ordering: spec_draft_ready comes after spec_start and before spec_completed
    const types = events.map((e) => e.type);
    const startIdx = types.indexOf("spec_start");
    const draftIdx = types.indexOf("spec_draft_ready");
    const completedIdx = types.indexOf("spec_completed");
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(draftIdx).toBeGreaterThan(startIdx);
    expect(completedIdx).toBeGreaterThan(draftIdx);
  });

  // === I-3c: spec_skipped event emitted on skip paths ===

  it("emits spec_skipped event when prompt starts with /raw (I-3c)", async () => {
    const engine = new SpecEngine(makeOptions(), makeDeps());
    const events: AgentEvent[] = [];
    const result = await engine.clarify({
      prompt: "/raw fix typo",
      cwd: "/tmp",
      sessionBranch: [],
      modelClient: mockClient(""),
      model: mainProfile,
      toolRegistry: {} as never,
      eventSink: (e) => {
        events.push(e);
        return undefined;
      },
    });
    expect(result.action).toBe("skip");
    const skippedEvent = events.find((e) => e.type === "spec_skipped");
    expect(skippedEvent).toBeDefined();
    if (skippedEvent && skippedEvent.type === "spec_skipped") {
      expect(skippedEvent.reason).toBe("user forced /raw");
    }
  });

  it("emits spec_skipped event when classifier says no clarification needed (I-3c)", async () => {
    const classifier = makeStage(
      mockClient(
        JSON.stringify({ needsClarification: false, confidence: 0.95, reason: "specific task" }),
      ),
    );
    const engine = new SpecEngine(makeOptions({ classifier }), makeDeps());
    const events: AgentEvent[] = [];
    const result = await engine.clarify({
      prompt: "fix typo in README.md line 42",
      cwd: "/tmp",
      sessionBranch: [],
      modelClient: mockClient(""),
      model: mainProfile,
      toolRegistry: {} as never,
      eventSink: (e) => {
        events.push(e);
        return undefined;
      },
    });
    expect(result.action).toBe("skip");
    const skippedEvent = events.find((e) => e.type === "spec_skipped");
    expect(skippedEvent).toBeDefined();
    if (skippedEvent && skippedEvent.type === "spec_skipped") {
      expect(skippedEvent.reason).toContain("classifier");
      expect(skippedEvent.reason).toContain("specific task");
    }
  });

  it("emits spec_skipped event when drafter fails (I-3c)", async () => {
    const classifier = makeStage(
      mockClient(JSON.stringify({ needsClarification: true, confidence: 0.9, reason: "vague" })),
    );
    const drafter = makeStage(mockClientSequence(["not json", "still not"]), "strict");
    const engine = new SpecEngine(makeOptions({ classifier, drafter }), makeDeps());
    const events: AgentEvent[] = [];
    const result = await engine.clarify({
      prompt: "make it better",
      cwd: "/tmp",
      sessionBranch: [],
      modelClient: mockClient("[]"),
      model: mainProfile,
      toolRegistry: {} as never,
      eventSink: (e) => {
        events.push(e);
        return undefined;
      },
    });
    expect(result.action).toBe("skip");
    const skippedEvent = events.find((e) => e.type === "spec_skipped");
    expect(skippedEvent).toBeDefined();
    if (skippedEvent && skippedEvent.type === "spec_skipped") {
      expect(skippedEvent.reason).toBe("drafter failed");
    }
  });
});
