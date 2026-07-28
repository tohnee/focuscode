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
  type AgentToolCall,
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

class QueueModelClient implements ModelClient {
  readonly protocol = "fixture";
  readonly requests: ModelRequest[] = [];
  private index = 0;

  constructor(private readonly responses: ModelResponse[]) {}

  async complete(
    request: ModelRequest,
    onEvent?: Parameters<ModelClient["complete"]>[1],
  ): Promise<ModelResponse> {
    this.requests.push(request);
    const response = this.responses[this.index++];
    if (!response) throw new Error("No scripted response");
    if (response.content) onEvent?.({ type: "text_delta", delta: response.content });
    return response;
  }
}

describe("G1: truncation rejection", () => {
  it("rejects tool calls when stopReason is length", async () => {
    const root = await createTestDirectory("truncation-reject");
    const registry = await createCodingToolRegistry(root);
    const truncatedToolCall: AgentToolCall = {
      id: "tc1",
      name: "write",
      arguments: { path: "test.txt", content: "hello" },
    };
    const client = new QueueModelClient([
      // First response: truncated with tool calls
      {
        content: "Let me write a fi", // truncated mid-sentence
        toolCalls: [truncatedToolCall],
        usage: { inputTokens: 10, outputTokens: 20 },
        stopReason: "length", // truncated!
      },
      // Second response: model retries without tools
      {
        content: "I retried successfully.",
        toolCalls: [],
        usage: { inputTokens: 15, outputTokens: 5 },
        stopReason: "stop",
      },
    ]);
    const agent = await CodingAgent.create({
      cwd: root,
      model,
      modelClient: client,
      tools: registry.values(),
      toolRegistry: registry,
      permission: { mode: "full-auto", projectTrusted: true, protectedPaths: [] },
      sessionStore: new SessionStore("truncation-test", false),
      checkpoints: false,
      maxRounds: 5,
    });
    const result = await agent.submit("write test.txt");
    expect(result.stopped).toBe("stop");
    // The model should have been called twice: truncated + retry
    expect(client.requests.length).toBe(2);
    // The truncated tool call should NOT have been executed
    // (no write tool result in the session)
    const toolMessages = agent
      .snapshot()
      .entries.filter((e) => e.message.role === "tool")
      .map((e) => e.message);
    expect(toolMessages.length).toBe(1); // only the error result
    expect(toolMessages[0]?.content).toContain("truncated");
  });

  it("executes tool calls normally when stopReason is stop", async () => {
    const root = await createTestDirectory("truncation-normal");
    const registry = await createCodingToolRegistry(root);
    const client = new QueueModelClient([
      {
        content: "",
        toolCalls: [{ id: "tc1", name: "write", arguments: { path: "ok.txt", content: "ok" } }],
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "tool_use", // not truncated
      },
      {
        content: "Done.",
        toolCalls: [],
        usage: { inputTokens: 5, outputTokens: 2 },
        stopReason: "stop",
      },
    ]);
    const agent = await CodingAgent.create({
      cwd: root,
      model,
      modelClient: client,
      tools: registry.values(),
      toolRegistry: registry,
      permission: { mode: "full-auto", projectTrusted: true, protectedPaths: [] },
      sessionStore: new SessionStore("truncation-normal", false),
      checkpoints: false,
      maxRounds: 5,
    });
    const result = await agent.submit("write ok.txt");
    expect(result.stopped).toBe("stop");
    expect(result.toolCalls).toBe(1);
  });
});
