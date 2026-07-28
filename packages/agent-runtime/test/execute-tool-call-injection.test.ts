import { describe, expect, it } from "vitest";
import { createTestDirectory } from "@focuscode/testkit";
import {
  CodingAgent,
  ExtensionHost,
  SessionStore,
  createCodingToolRegistry,
  type AgentToolCall,
  type ModelClient,
  type ModelProfile,
  type ModelRequest,
  type ModelResponse,
  type ToolExecutionResult,
} from "../src/index.js";
import type {
  ActionIntentV1,
  EffectContextV1,
  EffectPort,
  EffectReceiptV1,
} from "@focuscode/contracts";

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

function mockDigest(value: string) {
  return { algorithm: "sha256" as const, value };
}

/**
 * Mock EffectPort that captures submitted intents and delegates execution
 * to an injected executor function. This simulates the FocusKernel spine
 * path without importing harness-core or sdk.
 */
function createMockEffectPort(
  executor: (call: AgentToolCall) => Promise<ToolExecutionResult>,
): EffectPort {
  return {
    async submit(
      intents: ActionIntentV1[],
      _context: EffectContextV1,
      _signal?: AbortSignal,
    ): Promise<EffectReceiptV1[]> {
      const receipts: EffectReceiptV1[] = [];
      for (const intent of intents) {
        // Convert intent back to a tool call for the executor
        const call: AgentToolCall = {
          id: intent.actionId,
          name: intent.tool.id,
          arguments: intent.arguments as Record<string, unknown>,
        };
        const result = await executor(call);
        receipts.push({
          schemaVersion: "effect-receipt.v1",
          actionId: intent.actionId,
          grantId: "grant_test",
          status: result.isError ? "rejected" : "applied",
          observedEffects: [],
          artifacts: [],
          reconciliation: "matched",
          content: result.content,
          durationMs: 0,
          createdAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        } satisfies EffectReceiptV1);
      }
      return receipts;
    },
  };
}

function mockEffectContext(taskId: string): EffectContextV1 {
  return {
    execution: {
      schemaVersion: "execution-context.v1",
      taskId,
      tenantId: "tenant_test",
      actor: { kind: "user", id: "user_test" },
      dataClass: "standard",
      policySnapshot: mockDigest("policy"),
      budget: {
        maxTokens: 100_000,
        maxDurationMs: 300_000,
        maxToolCalls: 50,
      },
      traceId: "trace_test",
      createdAt: new Date().toISOString(),
    },
    model: {
      modelId: "fixture",
      modelRevision: mockDigest("rev"),
      tokenizer: mockDigest("tok"),
      chatTemplate: mockDigest("tpl"),
      modelPack: mockDigest("pack"),
      deploymentProfile: mockDigest("deploy"),
      certificateId: "cert_test",
      certifiedCapabilities: ["tool_calling"],
      riskLevel: "pilot",
    },
    workerId: "worker_test",
  };
}

describe("D1: executeToolCall callback injection (mock scenario)", () => {
  it("beforeTool hooks fire when effectPort delegates to injected executor", async () => {
    const cwd = await createTestDirectory("d1-beforetool-spine");
    const registry = await createCodingToolRegistry(cwd);
    const extensionHost = new ExtensionHost(registry);

    // Track beforeTool hook calls
    let beforeToolCalled = false;
    let capturedToolName = "";
    extensionHost["api"]().beforeTool((ctx) => {
      beforeToolCalled = true;
      capturedToolName = ctx.toolName;
      return { allow: true };
    });

    const client = new QueueModelClient([
      {
        content: "",
        toolCalls: [{ id: "tc1", name: "write", arguments: { path: "test.txt", content: "hi" } }],
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "tool_use",
      },
      {
        content: "Done",
        toolCalls: [],
        usage: { inputTokens: 5, outputTokens: 2 },
        stopReason: "stop",
      },
    ]);

    // The injected executor goes through extensionHost.checkBeforeTool
    // before executing, simulating what CodingAgent.executeCall does
    const mockPort = createMockEffectPort(async (call) => {
      const veto = await extensionHost.checkBeforeTool?.({
        toolName: call.name,
        arguments: call.arguments,
        cwd,
      });
      if (veto && !veto.allow) {
        return { content: `Blocked: ${veto.reason}`, isError: true };
      }
      return { content: `${call.name} executed` };
    });

    const agent = await CodingAgent.create({
      cwd,
      model,
      modelClient: client,
      tools: registry.values(),
      toolRegistry: registry,
      permission: { mode: "full-auto", projectTrusted: true, protectedPaths: [] },
      sessionStore: new SessionStore("d1-test", false),
      extensionHost,
      effectPort: mockPort,
      effectContext: mockEffectContext("task_test"),
      checkpoints: false,
      maxRounds: 5,
    });

    const result = await agent.submit("write test.txt");
    expect(result.stopped).toBe("stop");
    expect(beforeToolCalled).toBe(true);
    expect(capturedToolName).toBe("write");
  });

  it("beforeTool veto prevents tool execution in spine path", async () => {
    const cwd = await createTestDirectory("d1-veto-spine");
    const registry = await createCodingToolRegistry(cwd);
    const extensionHost = new ExtensionHost(registry);

    extensionHost["api"]().beforeTool(() => ({
      allow: false,
      reason: "vetoed by test",
    }));

    const client = new QueueModelClient([
      {
        content: "",
        toolCalls: [
          { id: "tc1", name: "write", arguments: { path: "blocked.txt", content: "no" } },
        ],
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "tool_use",
      },
      {
        content: "I see it was blocked",
        toolCalls: [],
        usage: { inputTokens: 5, outputTokens: 2 },
        stopReason: "stop",
      },
    ]);

    const mockPort = createMockEffectPort(async (call) => {
      const veto = await extensionHost.checkBeforeTool?.({
        toolName: call.name,
        arguments: call.arguments,
        cwd,
      });
      if (veto && !veto.allow) {
        return { content: `Blocked: ${veto.reason}`, isError: true };
      }
      return { content: "executed" };
    });

    const agent = await CodingAgent.create({
      cwd,
      model,
      modelClient: client,
      tools: registry.values(),
      toolRegistry: registry,
      permission: { mode: "full-auto", projectTrusted: true, protectedPaths: [] },
      sessionStore: new SessionStore("d1-veto", false),
      extensionHost,
      effectPort: mockPort,
      effectContext: mockEffectContext("task_veto"),
      checkpoints: false,
      maxRounds: 5,
    });

    const result = await agent.submit("write blocked.txt");
    expect(result.stopped).toBe("stop");
    const toolMessages = agent
      .snapshot()
      .entries.filter((e) => e.message.role === "tool")
      .map((e) => e.message);
    expect(toolMessages.length).toBe(1);
    expect(toolMessages[0]?.content).toContain("vetoed by test");
  });

  it("no effectPort falls back to legacy path with beforeTool hooks", async () => {
    const cwd = await createTestDirectory("d1-legacy");
    const registry = await createCodingToolRegistry(cwd);
    const extensionHost = new ExtensionHost(registry);

    let hookFired = false;
    extensionHost["api"]().beforeTool(() => {
      hookFired = true;
      return { allow: true };
    });

    const client = new QueueModelClient([
      {
        content: "",
        toolCalls: [{ id: "tc1", name: "write", arguments: { path: "legacy.txt", content: "ok" } }],
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "tool_use",
      },
      {
        content: "Done",
        toolCalls: [],
        usage: { inputTokens: 5, outputTokens: 2 },
        stopReason: "stop",
      },
    ]);

    // No effectPort - legacy path
    const agent = await CodingAgent.create({
      cwd,
      model,
      modelClient: client,
      tools: registry.values(),
      toolRegistry: registry,
      permission: { mode: "full-auto", projectTrusted: true, protectedPaths: [] },
      sessionStore: new SessionStore("d1-legacy", false),
      extensionHost,
      checkpoints: false,
      maxRounds: 5,
    });

    const result = await agent.submit("write legacy.txt");
    expect(result.stopped).toBe("stop");
    expect(hookFired).toBe(true);
  });
});
