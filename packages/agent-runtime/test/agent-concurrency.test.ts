import { describe, expect, it } from "vitest";
import { CodingAgent } from "../src/agent.js";
import { SessionStore } from "../src/session-store.js";
import { mockClient } from "../src/spec-pipeline-helpers.js";
import type { AgentEvent, ModelClient, ModelProfile, ModelResponse } from "../src/types.js";
import type { SpecEngineDeps, SpecEngineOptions, SpecPipeline } from "../src/spec-types.js";

// === Shared fixtures (mirrors spec-engine-integration.test.ts patterns) ===

const smallProfile: ModelProfile = {
  provider: "test",
  model: "small-model",
  protocol: "openai-chat",
  baseUrl: "http://localhost",
  contextWindow: 32768,
  maxOutputTokens: 256,
  temperature: 0.1,
  toolMode: "native",
  reasoningEffort: "minimal",
  capabilities: { input: ["text"], reasoning: false, toolCalling: false },
  compatibility: {},
  reliability: { timeoutMs: 5000, maxRetries: 0, retryBaseDelayMs: 100, retryMaximumDelayMs: 1000 },
};

const drafterResponse = JSON.stringify({
  topic: "test feature",
  understanding: {
    goal: "implement test feature",
    constraints: [],
    acceptanceCriteria: [],
    affectedAreas: [],
    ambiguities: [],
  },
  taskBreakdown: [],
});

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

function makeSpecEngineOptions(pipeline?: Partial<SpecPipeline>): SpecEngineOptions {
  return {
    enabled: true,
    autoTrigger: true,
    specDirectory: "docs/specs",
    maxExplorationRounds: 6,
    keyDecisionRules: [],
    pipeline: pipeline ?? {},
  };
}

interface AgentFactoryOptions {
  /** Override the SpecEngine drafter client (e.g. to block on a gate). */
  drafterClient?: ModelClient;
  /** Override the main model client (e.g. to capture this.running). */
  mainClient?: ModelClient;
}

async function makeAgentWithSpecEngine(
  events: AgentEvent[],
  opts: AgentFactoryOptions = {},
): Promise<CodingAgent> {
  const store = new SessionStore("unused", false);
  const pipeline: SpecPipeline = {
    drafter: {
      profile: smallProfile,
      client: opts.drafterClient ?? mockClient(drafterResponse),
      fallback: "strict",
    },
    decisionDetector: { profile: smallProfile, client: mockClient("[]"), fallback: "strict" },
    enhancer: {
      profile: smallProfile,
      client: mockClient("## Objective\nimplement test feature"),
      fallback: "strict",
    },
  };
  return CodingAgent.create({
    cwd: "/tmp",
    model: {
      provider: "test",
      model: "test-model",
      protocol: "openai-chat",
      baseUrl: "http://localhost",
      contextWindow: 32768,
      maxOutputTokens: 100,
      temperature: 0,
      toolMode: "auto",
      reasoningEffort: "off",
      capabilities: { input: ["text"], reasoning: false, toolCalling: false },
      compatibility: {},
      reliability: {
        timeoutMs: 5000,
        maxRetries: 0,
        retryBaseDelayMs: 100,
        retryMaximumDelayMs: 1000,
      },
    },
    modelClient: opts.mainClient ?? mockClient("done"),
    tools: [],
    permission: { mode: "allowAll", projectTrusted: true, protectedPaths: [] },
    sessionStore: store,
    eventSink: (e) => {
      events.push(e);
    },
    specEngine: makeSpecEngineOptions(pipeline),
    specEngineDeps: makeDeps(),
  });
}

/** Poll the events array until an event of the given type appears. */
async function waitForEventType(
  events: AgentEvent[],
  type: string,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (events.some((e) => e.type === type)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timeout waiting for event type: ${type}`);
}

describe("CodingAgent.submit concurrency (P1-11)", () => {
  it("TC-P1-11-01: rejects concurrent submit without entering SpecEngine", async () => {
    const events: AgentEvent[] = [];
    let resolveGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });

    // Drafter client that blocks on the gate so the first submit stays inside
    // SpecEngine until we explicitly release it.
    const blockingDrafter: ModelClient = {
      protocol: "openai-chat",
      async complete(): Promise<ModelResponse> {
        await gate;
        return {
          content: drafterResponse,
          stopReason: "stop",
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };

    const agent = await makeAgentWithSpecEngine(events, { drafterClient: blockingDrafter });

    // Start the first submit — it will block inside SpecEngine (drafter stage).
    const first = agent.submit("/spec add a feature");
    await waitForEventType(events, "spec_start");

    // Release the gate after a short delay so the test does not hang in RED
    // (without the fix the second submit also enters SpecEngine and blocks).
    const gateTimer = setTimeout(() => resolveGate(), 300);

    // Second concurrent submit — must reject with "already processing".
    await expect(agent.submit("/spec add a feature")).rejects.toThrow(/already processing/);

    clearTimeout(gateTimer);

    // Critical assertion: only ONE spec_start should have fired. The second
    // submit must not have entered SpecEngine at all.
    expect(events.filter((e) => e.type === "spec_start").length).toBe(1);

    // Cleanup: release the gate so the first submit can complete.
    resolveGate();
    await first;
  });

  it("TC-P1-11-02: resets this.running after SpecEngine abort so a new submit can proceed", async () => {
    const events: AgentEvent[] = [];
    const agent = await makeAgentWithSpecEngine(events);

    // Pass an already-aborted signal so SpecEngine.clarify returns
    // { action: "abort" } immediately (spec-engine.ts line 49-50).
    const controller = new AbortController();
    controller.abort();
    const firstResult = await agent.submit("/spec add a feature", controller.signal);
    expect(firstResult.stopped).toBe("aborted");

    // this.running must have been reset — verify directly.
    const status = await agent.status();
    expect(status.steering.running).toBe(false);

    // A subsequent submit should succeed, proving this.running was reset.
    const secondResult = await agent.submit("/spec add a feature");
    expect(secondResult.stopped).toBe("stop");
  });

  it("TC-P1-11-03: keeps this.running true during SpecEngine so the agent loop runs", async () => {
    const events: AgentEvent[] = [];
    const runningValues: boolean[] = [];
    const agentRef: { current?: CodingAgent } = {};

    // Main model client that captures this.running on every call (explorer
    // stage inside SpecEngine + the agent loop).
    const recordingMainClient: ModelClient = {
      protocol: "openai-chat",
      async complete(): Promise<ModelResponse> {
        if (agentRef.current) {
          const status = await agentRef.current.status();
          runningValues.push(status.steering.running);
        }
        return {
          content: "done",
          stopReason: "stop",
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };

    const agent = await makeAgentWithSpecEngine(events, { mainClient: recordingMainClient });
    agentRef.current = agent;

    const result = await agent.submit("/spec add a feature");

    // SpecEngine applied (spec_completed fired).
    expect(events.some((e) => e.type === "spec_completed")).toBe(true);
    // Agent loop ran and produced a result.
    expect(result.content).toBe("done");
    expect(result.stopped).toBe("stop");
    // this.running was true on every model call — including the explorer call
    // inside SpecEngine. Without the fix this.running is false during the
    // explorer call (it is only set after SpecEngine finishes).
    expect(runningValues).not.toContain(false);
    // this.running was reset after the agent loop completed.
    const finalStatus = await agent.status();
    expect(finalStatus.steering.running).toBe(false);
  });
});
