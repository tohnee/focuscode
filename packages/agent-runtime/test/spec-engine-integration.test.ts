import { describe, expect, it } from "vitest";
import { CodingAgent } from "../src/agent.js";
import { SessionStore } from "../src/session-store.js";
import type { AgentEvent, AgentMessage, ModelProfile, ModelResponse } from "../src/types.js";
import type { SpecEngineDeps, SpecEngineOptions, SpecPipeline } from "../src/spec-types.js";
import { mockClient } from "../src/spec-pipeline-helpers.js";

// Minimal options to construct a CodingAgent without SpecEngine
async function makeAgent(events: AgentEvent[] = []) {
  const store = new SessionStore("unused", false);
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
    modelClient: mockClient("done"),
    tools: [],
    permission: { mode: "allowAll", projectTrusted: true, protectedPaths: [] },
    sessionStore: store,
    eventSink: (e) => events.push(e),
  });
}

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

const drafterResponse = JSON.stringify({
  topic: "test feature",
  understanding: {
    goal: "implement test feature",
    constraints: [],
    acceptanceCriteria: [],
    affectedAreas: [],
    ambiguities: [],
  },
  taskBreakdown: [
    { id: "t1", description: "implement task 1", dependsOn: [], files: [], kind: "implement" },
  ],
});

async function makeAgentWithSpecEngine(events: AgentEvent[] = []): Promise<{
  agent: Awaited<ReturnType<typeof CodingAgent.create>>;
  capturedMessages: AgentMessage[];
}> {
  const store = new SessionStore("unused", false);
  const pipeline: SpecPipeline = {
    drafter: { profile: smallProfile, client: mockClient(drafterResponse), fallback: "strict" },
    decisionDetector: { profile: smallProfile, client: mockClient("[]"), fallback: "strict" },
    enhancer: {
      profile: smallProfile,
      client: mockClient("## Objective\nimplement test feature"),
      fallback: "strict",
    },
  };
  // Recording mock: captures the messages sent to the main model so tests
  // can verify the enhanced prompt actually reached the model (M15).
  const capturedMessages: AgentMessage[] = [];
  const recordingClient = {
    protocol: "openai-chat",
    async complete(request: { messages: AgentMessage[] }): Promise<ModelResponse> {
      capturedMessages.push(...request.messages);
      return {
        content: "done",
        stopReason: "stop",
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
  const agent = await CodingAgent.create({
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
    modelClient: recordingClient,
    tools: [],
    permission: { mode: "allowAll", projectTrusted: true, protectedPaths: [] },
    sessionStore: store,
    eventSink: (e) => events.push(e),
    specEngine: makeSpecEngineOptions(pipeline),
    specEngineDeps: makeDeps(),
  });
  return { agent, capturedMessages };
}

describe("CodingAgent.submit with SpecEngine", () => {
  it("does not activate SpecEngine when specEngine option is undefined", async () => {
    const events: AgentEvent[] = [];
    const agent = await makeAgent(events);
    const result = await agent.submit("fix typo");
    expect(result.stopped).toBe("stop");
    expect(events.some((e) => e.type.startsWith("spec_"))).toBe(false);
  });

  it("skips SpecEngine on /raw command", async () => {
    const events: AgentEvent[] = [];
    const agent = await makeAgent(events);
    const result = await agent.submit("/raw fix typo");
    expect(result.stopped).toBe("stop");
  });

  it("emits spec_* events and applies enhanced prompt when SpecEngine pipeline runs", async () => {
    const events: AgentEvent[] = [];
    const { agent, capturedMessages } = await makeAgentWithSpecEngine(events);
    const result = await agent.submit("/spec add a feature");
    expect(result.stopped).toBe("stop");
    const specEventTypes = events.filter((e) => e.type.startsWith("spec_")).map((e) => e.type);
    expect(specEventTypes).toContain("spec_start");
    expect(specEventTypes).toContain("spec_completed");
    // The enhanced prompt from the mock enhancer should reach the model and
    // produce the final "done" content.
    expect(result.content).toBe("done");
    // M15: verify the enhanced prompt actually reached the model by inspecting
    // the captured messages. The enhancer mock returns
    // "## Objective\nimplement test feature" — that content must appear in the
    // messages sent to the main model, not just be swallowed by the pipeline.
    expect(capturedMessages.length).toBeGreaterThan(0);
    const userMessages = capturedMessages.filter((m) => m.role === "user");
    const lastUserMessage = userMessages.at(-1);
    expect(lastUserMessage).toBeDefined();
    expect(lastUserMessage!.content).toContain("implement test feature");
  });

  it("exposes the SpecEngine instance via getter when configured", async () => {
    const { agent } = await makeAgentWithSpecEngine([]);
    expect(agent.specEngineInstance).toBeDefined();
  });

  it("does not expose SpecEngine instance when not configured", async () => {
    const agent = await makeAgent([]);
    expect(agent.specEngineInstance).toBeUndefined();
  });

  it("throws when specEngine option is set without specEngineDeps", async () => {
    const store = new SessionStore("unused", false);
    await expect(
      CodingAgent.create({
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
        modelClient: mockClient("done"),
        tools: [],
        permission: { mode: "allowAll", projectTrusted: true, protectedPaths: [] },
        sessionStore: store,
        specEngine: makeSpecEngineOptions(),
      }),
    ).rejects.toThrow(/specEngineDeps/);
  });
});
