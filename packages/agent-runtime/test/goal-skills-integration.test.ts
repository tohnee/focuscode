import { describe, expect, it } from "vitest";
import { createTestDirectory } from "@focuscode/testkit";
import {
  CodingAgent,
  SessionStore,
  createCodingToolRegistry,
  loadSkills,
  type ModelClient,
  type ModelProfile,
  type ModelRequest,
  type ModelResponse,
  type SkillManifest,
} from "../src/index.js";

const model: ModelProfile = {
  provider: "fixture",
  model: "fixture",
  protocol: "openai-chat",
  baseUrl: "http://fixture",
  contextWindow: 16_000,
  maxOutputTokens: 1_000,
  temperature: 0,
  toolMode: "native",
  reasoningEffort: "off",
  capabilities: { input: ["text"], reasoning: false, toolCalling: true },
  compatibility: {},
  reliability: {
    timeoutMs: 30_000,
    maxRetries: 0,
    retryBaseDelayMs: 100,
    retryMaximumDelayMs: 1_000,
  },
};

const skillsManifest: SkillManifest = {
  schemaVersion: "focuscode-skills.v1",
  skills: [
    {
      name: "tdd",
      description: "Test-driven development",
      trigger: { keywords: ["test", "tdd", "spec"] },
      prompt: "Always write a failing test first, then implement.",
      allowedTools: ["read", "write", "edit", "bash"],
    },
    {
      name: "refactor",
      description: "Refactor with confidence",
      trigger: { keywords: ["refactor", "clean"] },
      prompt: "Refactor only when tests cover the changed code.",
      allowedTools: ["read", "edit"],
    },
  ],
};

describe("CodingAgent goal + skills integration", () => {
  it("registers the goal tool alongside delegate and todo", async () => {
    const root = await createTestDirectory("agent-goal-tool");
    const registry = await createCodingToolRegistry(root);
    const agent = await CodingAgent.create({
      cwd: root,
      model,
      modelClient: new QueueModelClient([]),
      tools: registry.values(),
      toolRegistry: registry,
      permission: { mode: "auto-edit", projectTrusted: true, protectedPaths: [] },
      sessionStore: new SessionStore("unused", false),
      checkpoints: false,
    });
    const names = agent.toolDefinitions().map((tool) => tool.name);
    expect(names).toContain("goal");
    expect(names).toContain("delegate");
    expect(names).toContain("todo");
  });

  it("honors enableGoal=false to skip goal tool registration", async () => {
    const root = await createTestDirectory("agent-goal-disabled");
    const registry = await createCodingToolRegistry(root);
    const agent = await CodingAgent.create({
      cwd: root,
      model,
      modelClient: new QueueModelClient([]),
      tools: registry.values(),
      toolRegistry: registry,
      permission: { mode: "auto-edit", projectTrusted: true, protectedPaths: [] },
      sessionStore: new SessionStore("unused", false),
      checkpoints: false,
      enableGoal: false,
    });
    expect(agent.toolDefinitions().map((tool) => tool.name)).not.toContain("goal");
  });

  it("injects matching skill prompt into the system prompt on submit", async () => {
    const root = await createTestDirectory("agent-skills-prompt");
    const registry = await createCodingToolRegistry(root);
    const skills = loadSkills(skillsManifest);
    const modelClient = new QueueModelClient([
      {
        content: "ok",
        toolCalls: [],
        usage: { inputTokens: 5, outputTokens: 2 },
        stopReason: "stop",
      },
    ]);
    const agent = await CodingAgent.create({
      cwd: root,
      model,
      modelClient,
      tools: registry.values(),
      toolRegistry: registry,
      permission: { mode: "auto-edit", projectTrusted: true, protectedPaths: [] },
      sessionStore: new SessionStore("unused", false),
      checkpoints: false,
      skills,
    });
    await agent.submit("please add a test for the parser");
    const request = modelClient.requests[0]!;
    expect(request.systemPrompt).toContain("Skill: tdd");
    expect(request.systemPrompt).toContain("Always write a failing test first");
    expect(request.systemPrompt).not.toContain("Skill: refactor");
  });

  it("omits skill prompt entirely when no trigger matches", async () => {
    const root = await createTestDirectory("agent-skills-no-match");
    const registry = await createCodingToolRegistry(root);
    const skills = loadSkills(skillsManifest);
    const modelClient = new QueueModelClient([
      {
        content: "ok",
        toolCalls: [],
        usage: { inputTokens: 5, outputTokens: 2 },
        stopReason: "stop",
      },
    ]);
    const agent = await CodingAgent.create({
      cwd: root,
      model,
      modelClient,
      tools: registry.values(),
      toolRegistry: registry,
      permission: { mode: "auto-edit", projectTrusted: true, protectedPaths: [] },
      sessionStore: new SessionStore("unused", false),
      checkpoints: false,
      skills,
    });
    await agent.submit("describe the architecture");
    const request = modelClient.requests[0]!;
    expect(request.systemPrompt).not.toContain("Skill: tdd");
    expect(request.systemPrompt).not.toContain("Skill: refactor");
  });

  it("runs the goal tool and surfaces the recorded action", async () => {
    const root = await createTestDirectory("agent-goal-tool-run");
    const registry = await createCodingToolRegistry(root);
    const modelClient = new QueueModelClient([
      {
        content: "",
        toolCalls: [{ id: "g1", name: "goal", arguments: { action: "set", description: "ship" } }],
        usage: { inputTokens: 10, outputTokens: 4 },
        stopReason: "tool_use",
      },
      {
        content: "goal set",
        toolCalls: [],
        usage: { inputTokens: 6, outputTokens: 3 },
        stopReason: "stop",
      },
    ]);
    const agent = await CodingAgent.create({
      cwd: root,
      model,
      modelClient,
      tools: registry.values(),
      toolRegistry: registry,
      permission: { mode: "auto-edit", projectTrusted: true, protectedPaths: [] },
      sessionStore: new SessionStore("unused", false),
      checkpoints: false,
    });
    const result = await agent.submit("set a goal");
    expect(result.content).toBe("goal set");
    const toolMessage = agent
      .snapshot()
      .entries.map((entry) => entry.message)
      .find((message) => message.role === "tool" && message.toolName === "goal");
    expect(toolMessage?.content).toContain("goal action 'set' recorded");
  });
});

class QueueModelClient implements ModelClient {
  readonly protocol = "fixture";
  readonly requests: ModelRequest[] = [];

  constructor(private readonly responses: ModelResponse[]) {}

  async complete(
    request: ModelRequest,
    onEvent?: Parameters<ModelClient["complete"]>[1],
  ): Promise<ModelResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) throw new Error("No scripted response");
    if (response.content) onEvent?.({ type: "text_delta", delta: response.content });
    return response;
  }
}
