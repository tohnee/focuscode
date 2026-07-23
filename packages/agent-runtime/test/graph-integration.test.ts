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

describe("CodingAgent graph tool integration", () => {
  it("registers the graph tool alongside delegate, goal, and todo", async () => {
    const root = await createTestDirectory("agent-graph-tool");
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
    expect(names).toContain("graph");
    expect(names).toContain("delegate");
    expect(names).toContain("goal");
    expect(names).toContain("todo");
  });

  it("honors enableGraph=false to skip graph tool registration", async () => {
    const root = await createTestDirectory("agent-graph-disabled");
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
      enableGraph: false,
    });
    expect(agent.toolDefinitions().map((tool) => tool.name)).not.toContain("graph");
  });

  it("executes a simple DAG with dependencies and returns a summary", async () => {
    const root = await createTestDirectory("agent-graph-run");
    const registry = await createCodingToolRegistry(root);
    // Parent invokes graph with two nodes: a (no deps) -> b (depends on a).
    // Each child gets one scripted response, then the parent summarizes.
    const modelClient = new QueueModelClient([
      {
        content: "",
        toolCalls: [
          {
            id: "graph-1",
            name: "graph",
            arguments: {
              nodes: [
                { id: "a", task: "Step A: list files", dependencies: [] },
                { id: "b", task: "Step B: read the first file", dependencies: ["a"] },
              ],
            },
          },
        ],
        usage: { inputTokens: 10, outputTokens: 4 },
        stopReason: "tool_use",
      },
      // Child A response: a stops immediately with a short message.
      {
        content: "step A done: found 2 files",
        toolCalls: [],
        usage: { inputTokens: 6, outputTokens: 3 },
        stopReason: "stop",
      },
      // Child B response.
      {
        content: "step B done: read README",
        toolCalls: [],
        usage: { inputTokens: 6, outputTokens: 3 },
        stopReason: "stop",
      },
      // Parent final summary.
      {
        content: "graph complete",
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
    });
    const result = await agent.submit("run the graph");
    expect(result.content).toBe("graph complete");

    // The graph tool result should mention both nodes and a completed status.
    const toolMessage = agent
      .snapshot()
      .entries.map((entry) => entry.message)
      .find((message) => message.role === "tool" && message.toolName === "graph");
    expect(toolMessage?.content).toContain("completed");
    expect(toolMessage?.content).toContain("ok a:");
    expect(toolMessage?.content).toContain("ok b:");
    expect(toolMessage?.content).toContain("step A done");
    expect(toolMessage?.content).toContain("step B done");

    // The child agents must not have graph/delegate/bash in their registries.
    // (todo is always re-registered by the CodingAgent constructor — same as
    // the delegate tool — and is harmless for child agents.)
    // Child A is the second model request (index 1); Child B is index 2.
    const childARequest = modelClient.requests[1]!;
    const childATools = childARequest.tools.map((tool) => tool.name);
    expect(childATools).not.toContain("graph");
    expect(childATools).not.toContain("delegate");
    expect(childATools).not.toContain("bash");
    expect(childATools).toContain("read");
    expect(childATools).toContain("write");
  });

  it("rejects a cyclic graph with an error result", async () => {
    const root = await createTestDirectory("agent-graph-cycle");
    const registry = await createCodingToolRegistry(root);
    const modelClient = new QueueModelClient([
      {
        content: "",
        toolCalls: [
          {
            id: "graph-cycle",
            name: "graph",
            arguments: {
              nodes: [
                { id: "x", task: "X", dependencies: ["y"] },
                { id: "y", task: "Y", dependencies: ["x"] },
              ],
            },
          },
        ],
        usage: { inputTokens: 8, outputTokens: 2 },
        stopReason: "tool_use",
      },
      {
        content: "cycle handled",
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
    const result = await agent.submit("run a cyclic graph");
    expect(result.content).toBe("cycle handled");
    const toolMessage = agent
      .snapshot()
      .entries.map((entry) => entry.message)
      .find((message) => message.role === "tool" && message.toolName === "graph");
    expect(toolMessage?.content).toContain("cycle");
    expect(toolMessage?.content).toContain("x");
    expect(toolMessage?.content).toContain("y");
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
