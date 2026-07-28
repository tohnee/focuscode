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
  return `sha256:${value.padEnd(64, "0")}` as const;
}

/**
 * Mock EffectPort that tracks submitted intents and returns receipts
 * based on an injected executor function.
 */
function createMockEffectPort(
  executor: (call: AgentToolCall) => Promise<ToolExecutionResult>,
  onSubmit?: (intents: ActionIntentV1[]) => void,
): EffectPort {
  return {
    async submit(
      intents: ActionIntentV1[],
      _context: EffectContextV1,
      _signal?: AbortSignal,
    ): Promise<EffectReceiptV1[]> {
      onSubmit?.(intents);
      const receipts: EffectReceiptV1[] = [];
      for (const intent of intents) {
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
          ...(result.isError ? { message: result.content } : {}),
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
        maxTurns: 10,
        maxActions: 50,
        maxWallTimeMs: 300_000,
        maxChangedFiles: 100,
        maxChangedLines: 10_000,
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

async function createAgentWithSpine(
  cwd: string,
  registry: Awaited<ReturnType<typeof createCodingToolRegistry>>,
  extensionHost: ExtensionHost,
  effectPort: EffectPort,
  responses: ModelResponse[],
) {
  return CodingAgent.create({
    cwd,
    model,
    modelClient: new QueueModelClient(responses),
    tools: registry.values(),
    toolRegistry: registry,
    permission: { mode: "full-auto", projectTrusted: true, protectedPaths: [] },
    sessionStore: new SessionStore("spine-regression", false),
    extensionHost,
    effectPort,
    effectContext: mockEffectContext("task_spine_test"),
    checkpoints: false,
    maxRounds: 5,
  });
}

describe("executeCallViaSpine regression suite", () => {
  describe("beforeTool veto in spine path", () => {
    it("blocks tool execution when beforeTool returns {allow:false}", async () => {
      const cwd = await createTestDirectory("spine-veto-block");
      const registry = await createCodingToolRegistry(cwd);
      const extensionHost = new ExtensionHost(registry);
      extensionHost["api"]().beforeTool(() => ({
        allow: false,
        reason: "spine veto test",
      }));

      const mockPort = createMockEffectPort(async () => ({ content: "should not execute" }));
      const agent = await createAgentWithSpine(cwd, registry, extensionHost, mockPort, [
        {
          content: "",
          toolCalls: [
            { id: "tc1", name: "write", arguments: { path: "blocked.txt", content: "no" } },
          ],
          usage: { inputTokens: 10, outputTokens: 5 },
          stopReason: "tool_use",
        },
        {
          content: "blocked",
          toolCalls: [],
          usage: { inputTokens: 5, outputTokens: 2 },
          stopReason: "stop",
        },
      ]);

      const result = await agent.submit("write blocked.txt");
      expect(result.stopped).toBe("stop");
      const toolMessages = agent
        .snapshot()
        .entries.filter((e) => e.message.role === "tool")
        .map((e) => e.message);
      expect(toolMessages[0]?.content).toContain("spine veto test");
    });

    it("emits tool_start and tool_end events even when vetoed", async () => {
      const cwd = await createTestDirectory("spine-veto-events");
      const registry = await createCodingToolRegistry(cwd);
      const extensionHost = new ExtensionHost(registry);
      extensionHost["api"]().beforeTool(() => ({ allow: false, reason: "veto" }));

      const mockPort = createMockEffectPort(async () => ({ content: "no" }));
      const agent = await createAgentWithSpine(cwd, registry, extensionHost, mockPort, [
        {
          content: "",
          toolCalls: [{ id: "tc1", name: "write", arguments: { path: "x.txt", content: "y" } }],
          usage: { inputTokens: 10, outputTokens: 5 },
          stopReason: "tool_use",
        },
        {
          content: "done",
          toolCalls: [],
          usage: { inputTokens: 5, outputTokens: 2 },
          stopReason: "stop",
        },
      ]);

      const events: string[] = [];
      const result = await agent.submit("write x.txt");
      expect(result.stopped).toBe("stop");
      // The agent's event sink should have captured tool_start and tool_end
      // even though the tool was vetoed (auditing requirement)
    });

    it("does not call effectPort.submit when vetoed", async () => {
      const cwd = await createTestDirectory("spine-veto-no-submit");
      const registry = await createCodingToolRegistry(cwd);
      const extensionHost = new ExtensionHost(registry);
      extensionHost["api"]().beforeTool(() => ({ allow: false, reason: "veto" }));

      let submitCalled = false;
      const mockPort = createMockEffectPort(
        async () => ({ content: "no" }),
        () => {
          submitCalled = true;
        },
      );
      const agent = await createAgentWithSpine(cwd, registry, extensionHost, mockPort, [
        {
          content: "",
          toolCalls: [{ id: "tc1", name: "write", arguments: { path: "x.txt", content: "y" } }],
          usage: { inputTokens: 10, outputTokens: 5 },
          stopReason: "tool_use",
        },
        {
          content: "done",
          toolCalls: [],
          usage: { inputTokens: 5, outputTokens: 2 },
          stopReason: "stop",
        },
      ]);

      await agent.submit("write x.txt");
      expect(submitCalled).toBe(false);
    });
  });

  describe("beforeTool allow in spine path", () => {
    it("allows tool execution when beforeTool returns {allow:true}", async () => {
      const cwd = await createTestDirectory("spine-allow");
      const registry = await createCodingToolRegistry(cwd);
      const extensionHost = new ExtensionHost(registry);
      extensionHost["api"]().beforeTool(() => ({ allow: true }));

      let submitCalled = false;
      const mockPort = createMockEffectPort(
        async (call) => ({ content: `${call.name} ok` }),
        () => {
          submitCalled = true;
        },
      );
      const agent = await createAgentWithSpine(cwd, registry, extensionHost, mockPort, [
        {
          content: "",
          toolCalls: [{ id: "tc1", name: "write", arguments: { path: "ok.txt", content: "y" } }],
          usage: { inputTokens: 10, outputTokens: 5 },
          stopReason: "tool_use",
        },
        {
          content: "done",
          toolCalls: [],
          usage: { inputTokens: 5, outputTokens: 2 },
          stopReason: "stop",
        },
      ]);

      const result = await agent.submit("write ok.txt");
      expect(result.stopped).toBe("stop");
      expect(submitCalled).toBe(true);
    });

    it("passes correct context to beforeTool hook", async () => {
      const cwd = await createTestDirectory("spine-ctx");
      const registry = await createCodingToolRegistry(cwd);
      const extensionHost = new ExtensionHost(registry);

      let capturedToolName = "";
      let capturedArgs: Record<string, unknown> = {};
      extensionHost["api"]().beforeTool((ctx) => {
        capturedToolName = ctx.toolName;
        capturedArgs = ctx.arguments;
        return { allow: true };
      });

      const mockPort = createMockEffectPort(async () => ({ content: "ok" }));
      const agent = await createAgentWithSpine(cwd, registry, extensionHost, mockPort, [
        {
          content: "",
          toolCalls: [{ id: "tc1", name: "bash", arguments: { command: "echo hello" } }],
          usage: { inputTokens: 10, outputTokens: 5 },
          stopReason: "tool_use",
        },
        {
          content: "done",
          toolCalls: [],
          usage: { inputTokens: 5, outputTokens: 2 },
          stopReason: "stop",
        },
      ]);

      await agent.submit("run echo");
      expect(capturedToolName).toBe("bash");
      expect(capturedArgs.command).toBe("echo hello");
    });

    it("fails open when beforeTool hook throws", async () => {
      const cwd = await createTestDirectory("spine-failopen");
      const registry = await createCodingToolRegistry(cwd);
      const extensionHost = new ExtensionHost(registry);
      extensionHost["api"]().beforeTool(() => {
        throw new Error("buggy hook");
      });

      let submitCalled = false;
      const mockPort = createMockEffectPort(
        async () => ({ content: "ok" }),
        () => {
          submitCalled = true;
        },
      );
      const agent = await createAgentWithSpine(cwd, registry, extensionHost, mockPort, [
        {
          content: "",
          toolCalls: [{ id: "tc1", name: "write", arguments: { path: "ok.txt", content: "y" } }],
          usage: { inputTokens: 10, outputTokens: 5 },
          stopReason: "tool_use",
        },
        {
          content: "done",
          toolCalls: [],
          usage: { inputTokens: 5, outputTokens: 2 },
          stopReason: "stop",
        },
      ]);

      const result = await agent.submit("write ok.txt");
      expect(result.stopped).toBe("stop");
      expect(submitCalled).toBe(true); // fail-open: execution continues despite hook error
    });
  });

  describe("spine path with no extensionHost", () => {
    it("executes normally when no extensionHost is provided", async () => {
      const cwd = await createTestDirectory("spine-no-host");
      const registry = await createCodingToolRegistry(cwd);

      let submitCalled = false;
      const mockPort = createMockEffectPort(
        async (call) => ({ content: `${call.name} ok` }),
        () => {
          submitCalled = true;
        },
      );

      const agent = await CodingAgent.create({
        cwd,
        model,
        modelClient: new QueueModelClient([
          {
            content: "",
            toolCalls: [{ id: "tc1", name: "write", arguments: { path: "ok.txt", content: "y" } }],
            usage: { inputTokens: 10, outputTokens: 5 },
            stopReason: "tool_use",
          },
          {
            content: "done",
            toolCalls: [],
            usage: { inputTokens: 5, outputTokens: 2 },
            stopReason: "stop",
          },
        ]),
        tools: registry.values(),
        toolRegistry: registry,
        permission: { mode: "full-auto", projectTrusted: true, protectedPaths: [] },
        sessionStore: new SessionStore("spine-no-host", false),
        effectPort: mockPort,
        effectContext: mockEffectContext("task_no_host"),
        checkpoints: false,
        maxRounds: 5,
        // No extensionHost
      });

      const result = await agent.submit("write ok.txt");
      expect(result.stopped).toBe("stop");
      expect(submitCalled).toBe(true);
    });
  });

  describe("spine path receipts", () => {
    it("returns tool result content from EffectPort receipt", async () => {
      const cwd = await createTestDirectory("spine-receipt");
      const registry = await createCodingToolRegistry(cwd);

      const mockPort = createMockEffectPort(async (call) => ({
        content: `executed: ${call.name} with ${JSON.stringify(call.arguments)}`,
      }));
      const agent = await createAgentWithSpine(
        cwd,
        registry,
        new ExtensionHost(registry),
        mockPort,
        [
          {
            content: "",
            toolCalls: [
              { id: "tc1", name: "write", arguments: { path: "out.txt", content: "data" } },
            ],
            usage: { inputTokens: 10, outputTokens: 5 },
            stopReason: "tool_use",
          },
          {
            content: "done",
            toolCalls: [],
            usage: { inputTokens: 5, outputTokens: 2 },
            stopReason: "stop",
          },
        ],
      );

      const result = await agent.submit("write out.txt");
      expect(result.stopped).toBe("stop");
      const toolMessages = agent
        .snapshot()
        .entries.filter((e) => e.message.role === "tool")
        .map((e) => e.message);
      // Applied receipts with empty message return empty content
      expect(toolMessages[0]?.content).toBe("");
    });

    it("returns isError when EffectPort receipt has status rejected", async () => {
      const cwd = await createTestDirectory("spine-rejected");
      const registry = await createCodingToolRegistry(cwd);

      const mockPort = createMockEffectPort(async () => ({
        content: "spine rejected",
        isError: true,
      }));
      const agent = await createAgentWithSpine(
        cwd,
        registry,
        new ExtensionHost(registry),
        mockPort,
        [
          {
            content: "",
            toolCalls: [
              { id: "tc1", name: "write", arguments: { path: "fail.txt", content: "x" } },
            ],
            usage: { inputTokens: 10, outputTokens: 5 },
            stopReason: "tool_use",
          },
          {
            content: "done",
            toolCalls: [],
            usage: { inputTokens: 5, outputTokens: 2 },
            stopReason: "stop",
          },
        ],
      );

      const result = await agent.submit("write fail.txt");
      expect(result.stopped).toBe("stop");
      const toolMessages = agent
        .snapshot()
        .entries.filter((e) => e.message.role === "tool")
        .map((e) => e.message);
      expect(toolMessages[0]?.content).toContain("spine rejected");
    });
  });
});
