import { describe, expect, it } from "vitest";
import { createTestDirectory } from "@focuscode/testkit";
import {
  CodingAgent,
  SessionStore,
  createCodingToolRegistry,
  type ModelClient,
  type ModelProfile,
  type ModelRequest,
  type ModelResponse,
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

describe("CodingAgent team tool integration", () => {
  it("registers the team tool alongside graph, delegate, goal, and todo", async () => {
    const root = await createTestDirectory("agent-team-tool");
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
    expect(names).toContain("team");
    expect(names).toContain("graph");
    expect(names).toContain("delegate");
    expect(names).toContain("goal");
    expect(names).toContain("todo");
  });

  it("honors enableTeam=false to skip team tool registration", async () => {
    const root = await createTestDirectory("agent-team-disabled");
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
      enableTeam: false,
    });
    expect(agent.toolDefinitions().map((tool) => tool.name)).not.toContain("team");
  });

  it("executes a team plan with one role and one task, returns results", async () => {
    const root = await createTestDirectory("agent-team-run");
    const registry = await createCodingToolRegistry(root);
    // Parent invokes team with one role (researcher) and one task (r1).
    // The child agent gets one scripted response, then the parent summarizes.
    const modelClient = new QueueModelClient([
      {
        content: "",
        toolCalls: [
          {
            id: "team-1",
            name: "team",
            arguments: {
              roles: [
                {
                  name: "researcher",
                  instructions: "You research code.",
                  allowedTools: ["read"],
                  maxRounds: 5,
                },
              ],
              tasks: [
                {
                  id: "r1",
                  roleId: "researcher",
                  input: "Find all exports",
                  dependencies: [],
                },
              ],
            },
          },
        ],
        usage: { inputTokens: 10, outputTokens: 4 },
        stopReason: "tool_use",
      },
      // Child researcher response.
      {
        content: "found 3 exports: foo, bar, baz",
        toolCalls: [],
        usage: { inputTokens: 6, outputTokens: 3 },
        stopReason: "stop",
      },
      // Parent final summary.
      {
        content: "team done",
        toolCalls: [],
        usage: { inputTokens: 12, outputTokens: 5 },
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
      maxRounds: 4,
    });
    const result = await agent.submit("run the team");
    expect(result.content).toBe("team done");

    // The team tool result should mention completion and the task id.
    const toolMessage = agent
      .snapshot()
      .entries.map((entry) => entry.message)
      .find((message) => message.role === "tool" && message.toolName === "team");
    expect(toolMessage?.content).toContain("completed");
    expect(toolMessage?.content).toContain("r1");
    expect(toolMessage?.content).toContain("researcher");
    expect(toolMessage?.content).toContain("found 3 exports");

    // The child agent must not have team/graph/delegate/bash in its registry.
    const childRequest = modelClient.requests[1]!;
    const childTools = childRequest.tools.map((tool) => tool.name);
    expect(childTools).not.toContain("team");
    expect(childTools).not.toContain("graph");
    expect(childTools).not.toContain("delegate");
    expect(childTools).not.toContain("bash");
    // Role allowedTools=["read"] means the child only gets read.
    expect(childTools).toContain("read");
    expect(childTools).not.toContain("write");
  });

  it("rejects an invalid team plan (unknown role) with an error result", async () => {
    const root = await createTestDirectory("agent-team-invalid");
    const registry = await createCodingToolRegistry(root);
    const modelClient = new QueueModelClient([
      {
        content: "",
        toolCalls: [
          {
            id: "team-bad",
            name: "team",
            arguments: {
              roles: [
                {
                  name: "coder",
                  instructions: "You write code.",
                  allowedTools: ["write"],
                  maxRounds: 5,
                },
              ],
              tasks: [
                {
                  id: "t1",
                  roleId: "reviewer",
                  input: "Review the code",
                  dependencies: [],
                },
              ],
            },
          },
        ],
        usage: { inputTokens: 8, outputTokens: 2 },
        stopReason: "tool_use",
      },
      {
        content: "invalid plan handled",
        toolCalls: [],
        usage: { inputTokens: 6, outputTokens: 2 },
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
    const result = await agent.submit("run an invalid team");
    expect(result.content).toBe("invalid plan handled");
    const toolMessage = agent
      .snapshot()
      .entries.map((entry) => entry.message)
      .find((message) => message.role === "tool" && message.toolName === "team");
    expect(toolMessage?.content).toContain("invalid plan");
    expect(toolMessage?.content).toContain("reviewer");
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
