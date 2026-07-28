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

// A tool call that always fails (bash false returns exit code 1)
function failingTool(): AgentToolCall {
  return {
    id: `fail-${Date.now()}`,
    name: "bash",
    arguments: { command: "false" },
  };
}

describe("G2: doom-loop detection", () => {
  it("stops after 3 consecutive identical failed tool calls", async () => {
    const root = await createTestDirectory("doom-loop-3x");
    const registry = await createCodingToolRegistry(root);
    // Create 3 identical failing calls + a final stop
    const failCall = failingTool();
    const responses: ModelResponse[] = [];
    for (let i = 0; i < 4; i++) {
      responses.push({
        content: "",
        toolCalls: [{ ...failCall, id: `fail-${i}` }],
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "tool_use",
      });
    }
    // Final response after doom-loop stop (shouldn't be reached if detection works)
    responses.push({
      content: "should not reach here",
      toolCalls: [],
      usage: { inputTokens: 5, outputTokens: 2 },
      stopReason: "stop",
    });
    const client = new QueueModelClient(responses);
    const agent = await CodingAgent.create({
      cwd: root,
      model,
      modelClient: client,
      tools: registry.values(),
      toolRegistry: registry,
      permission: { mode: "full-auto", projectTrusted: true, protectedPaths: [] },
      sessionStore: new SessionStore("doom-test", false),
      checkpoints: false,
      maxRounds: 10,
    });
    const result = await agent.submit("write to nonexistent path");
    // Should stop with error due to doom-loop
    expect(result.stopped).toBe("error");
    expect(result.content).toContain("doom-loop");
  });

  it("does not trigger when failures are different calls", async () => {
    const root = await createTestDirectory("doom-loop-different");
    const registry = await createCodingToolRegistry(root);
    const client = new QueueModelClient([
      {
        content: "",
        toolCalls: [{ id: "f1", name: "write", arguments: { path: "a.txt", content: "x" } }],
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "tool_use",
      },
      // Different call - should reset counter
      {
        content: "",
        toolCalls: [{ id: "f2", name: "write", arguments: { path: "b.txt", content: "x" } }],
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "tool_use",
      },
      {
        content: "Done after trying different approaches.",
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
      sessionStore: new SessionStore("doom-different", false),
      checkpoints: false,
      maxRounds: 10,
    });
    const result = await agent.submit("try different writes");
    expect(result.stopped).toBe("stop");
    expect(result.toolCalls).toBe(2);
  });

  it("resets counter when a round has successful calls", async () => {
    const root = await createTestDirectory("doom-loop-reset");
    const registry = await createCodingToolRegistry(root);
    const failCall = failingTool();
    const client = new QueueModelClient([
      // Round 1: fail
      {
        content: "",
        toolCalls: [{ ...failCall, id: "f1" }],
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "tool_use",
      },
      // Round 2: same fail - counter increments to 2
      {
        content: "",
        toolCalls: [{ ...failCall, id: "f2" }],
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "tool_use",
      },
      // Round 3: different successful call - counter resets
      {
        content: "",
        toolCalls: [{ id: "s1", name: "write", arguments: { path: "ok.txt", content: "ok" } }],
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "tool_use",
      },
      // Round 4: same fail as before - counter starts from 1 again
      {
        content: "",
        toolCalls: [{ ...failCall, id: "f3" }],
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "tool_use",
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
      sessionStore: new SessionStore("doom-reset", false),
      checkpoints: false,
      maxRounds: 10,
    });
    const result = await agent.submit("try and recover");
    expect(result.stopped).toBe("stop");
  });
});
