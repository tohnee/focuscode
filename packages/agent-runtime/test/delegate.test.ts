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

describe("delegate tool", () => {
  it("runs a child agent and returns its final message without delegate/bash in its registry", async () => {
    const root = await createTestDirectory("delegate");
    const registry = await createCodingToolRegistry(root);
    const modelClient = new QueueModelClient([
      {
        content: "",
        toolCalls: [
          { id: "delegate-1", name: "delegate", arguments: { task: "Inspect the workspace" } },
        ],
        usage: { inputTokens: 10, outputTokens: 4 },
        stopReason: "tool_use",
      },
      {
        content: "child answer: workspace is empty",
        toolCalls: [],
        usage: { inputTokens: 6, outputTokens: 3 },
        stopReason: "stop",
      },
      {
        content: "parent summary",
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
      maxRounds: 8,
    });
    expect(agent.toolDefinitions().map((tool) => tool.name)).toContain("delegate");

    const result = await agent.submit("delegate the inspection");
    expect(result.content).toBe("parent summary");

    // The child's model request went through the same client with a trimmed
    // registry: no delegate (no nesting) and no bash (no shell).
    const childRequest = modelClient.requests[1]!;
    const childTools = childRequest.tools.map((tool) => tool.name);
    expect(childTools).not.toContain("delegate");
    expect(childTools).not.toContain("bash");
    expect(childTools).toContain("read");
    expect(childTools).toContain("write");

    // The delegate tool result carries the child's final message and usage.
    const toolMessage = agent
      .snapshot()
      .entries.map((entry) => entry.message)
      .find((message) => message.role === "tool" && message.toolName === "delegate");
    expect(toolMessage?.content).toContain("child answer: workspace is empty");
    expect(toolMessage?.content).toContain("Delegate result (structured):");
    expect(toolMessage?.content).toContain('"inputTokens":6');
    expect(toolMessage?.content).toContain('"outputTokens":3');
  });

  it("rejects oversized tasks and honors maxRounds bounds", async () => {
    const root = await createTestDirectory("delegate-validate");
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
    const result = await agent.runTool("delegate", { task: "x".repeat(4_001) });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("task");
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
