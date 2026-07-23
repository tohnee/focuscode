import { describe, expect, it } from "vitest";
import { exploreCodebase } from "../src/spec-explorer.js";
import type { ModelClient, ModelProfile, ModelResponse } from "../src/types.js";
import type { AgentTool } from "../src/types.js";

const profile: ModelProfile = {
  provider: "test",
  model: "test-model",
  protocol: "openai-chat",
  baseUrl: "http://localhost",
  contextWindow: 32768,
  maxOutputTokens: 1024,
  temperature: 0.2,
  toolMode: "native",
  reasoningEffort: "low",
  capabilities: { input: ["text"], reasoning: false, toolCalling: true },
  compatibility: {},
  reliability: {
    timeoutMs: 10000,
    maxRetries: 1,
    retryBaseDelayMs: 100,
    retryMaximumDelayMs: 1000,
  },
};

function makeReadTool(): AgentTool {
  return {
    definition: {
      name: "read",
      label: "Read",
      description: "read file",
      parameters: { type: "object", properties: { path: { type: "string" } } },
      effect: "read",
    },
    async execute(args) {
      return { content: `content of ${String(args.path ?? "")}` };
    },
  };
}

describe("exploreCodebase", () => {
  it("returns ExplorerResult from model's final JSON response", async () => {
    const responses: string[] = [];
    const client: ModelClient = {
      protocol: "openai-chat",
      async complete(request): Promise<ModelResponse> {
        responses.push(request.messages.length.toString());
        // First round: model calls read tool. Second round: model returns JSON summary.
        if (request.messages.length <= 2) {
          return {
            content: "",
            stopReason: "tool_use",
            toolCalls: [{ id: "c1", name: "read", arguments: { path: "src/main.ts" } }],
            usage: { inputTokens: 10, outputTokens: 20 },
          };
        }
        return {
          content: JSON.stringify({
            entryPoints: ["src/main.ts:entry"],
            patterns: ["registry pattern"],
            testConventions: "vitest",
            constraints: ["no external deps"],
            relevantFiles: ["src/main.ts"],
          }),
          stopReason: "stop",
          toolCalls: [],
          usage: { inputTokens: 10, outputTokens: 20 },
        };
      },
    };
    const result = await exploreCodebase({
      prompt: "add a feature",
      cwd: "/tmp",
      modelClient: client,
      model: profile,
      readOnlyTools: [makeReadTool()],
      maxRounds: 6,
    });
    expect(result.entryPoints).toEqual(["src/main.ts:entry"]);
    expect(result.testConventions).toBe("vitest");
  });

  it("respects maxRounds limit", async () => {
    let callCount = 0;
    const client: ModelClient = {
      protocol: "openai-chat",
      async complete(): Promise<ModelResponse> {
        callCount += 1;
        return {
          content: "",
          stopReason: "tool_use",
          toolCalls: [{ id: "c1", name: "read", arguments: { path: "x" } }],
          usage: { inputTokens: 10, outputTokens: 20 },
        };
      },
    };
    const result = await exploreCodebase({
      prompt: "test",
      cwd: "/tmp",
      modelClient: client,
      model: profile,
      readOnlyTools: [makeReadTool()],
      maxRounds: 3,
    });
    expect(callCount).toBeLessThanOrEqual(3);
    expect(result.entryPoints).toEqual([]);
  });

  it("returns empty result on abort", async () => {
    const controller = new AbortController();
    controller.abort();
    const client: ModelClient = {
      protocol: "openai-chat",
      async complete(): Promise<ModelResponse> {
        return {
          content: "{}",
          stopReason: "stop",
          toolCalls: [],
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
    };
    const result = await exploreCodebase({
      prompt: "test",
      cwd: "/tmp",
      modelClient: client,
      model: profile,
      readOnlyTools: [],
      maxRounds: 6,
      signal: controller.signal,
    });
    expect(result.entryPoints).toEqual([]);
  });

  it("returns empty result when model returns non-JSON", async () => {
    const client: ModelClient = {
      protocol: "openai-chat",
      async complete(): Promise<ModelResponse> {
        return {
          content: "not json",
          stopReason: "stop",
          toolCalls: [],
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
    };
    const result = await exploreCodebase({
      prompt: "test",
      cwd: "/tmp",
      modelClient: client,
      model: profile,
      readOnlyTools: [],
      maxRounds: 6,
    });
    expect(result.entryPoints).toEqual([]);
  });

  it("continues when read tool throws", async () => {
    const failingTool: AgentTool = {
      definition: {
        name: "read",
        label: "Read",
        description: "read",
        parameters: { type: "object", properties: {} },
        effect: "read",
      },
      async execute() {
        throw new Error("file not found");
      },
    };
    const client: ModelClient = {
      protocol: "openai-chat",
      async complete(request): Promise<ModelResponse> {
        if (request.messages.length <= 2) {
          return {
            content: "",
            stopReason: "tool_use",
            toolCalls: [{ id: "c1", name: "read", arguments: { path: "missing" } }],
            usage: { inputTokens: 0, outputTokens: 0 },
          };
        }
        return {
          content: JSON.stringify({
            entryPoints: [],
            patterns: [],
            testConventions: "",
            constraints: [],
            relevantFiles: [],
          }),
          stopReason: "stop",
          toolCalls: [],
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
    };
    const result = await exploreCodebase({
      prompt: "test",
      cwd: "/tmp",
      modelClient: client,
      model: profile,
      readOnlyTools: [failingTool],
      maxRounds: 6,
    });
    expect(result.entryPoints).toEqual([]);
  });

  it("uses empty tool list when readOnlyTools is empty", async () => {
    let capturedTools: unknown;
    const client: ModelClient = {
      protocol: "openai-chat",
      async complete(request): Promise<ModelResponse> {
        capturedTools = request.tools;
        return {
          content: JSON.stringify({
            entryPoints: [],
            patterns: [],
            testConventions: "",
            constraints: [],
            relevantFiles: [],
          }),
          stopReason: "stop",
          toolCalls: [],
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
    };
    await exploreCodebase({
      prompt: "test",
      cwd: "/tmp",
      modelClient: client,
      model: profile,
      readOnlyTools: [],
      maxRounds: 6,
    });
    expect(capturedTools).toEqual([]);
  });

  it("propagates abort signal to tool.execute (M5)", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const recordingTool: AgentTool = {
      definition: {
        name: "read",
        label: "Read",
        description: "read file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
        effect: "read",
      },
      async execute(_args, context) {
        receivedSignal = context.signal;
        return { content: "mock content" };
      },
    };
    const client: ModelClient = {
      protocol: "openai-chat",
      async complete(request): Promise<ModelResponse> {
        if (request.messages.length <= 2) {
          return {
            content: "",
            stopReason: "tool_use",
            toolCalls: [{ id: "c1", name: "read", arguments: { path: "src/main.ts" } }],
            usage: { inputTokens: 10, outputTokens: 20 },
          };
        }
        return {
          content: JSON.stringify({
            entryPoints: [],
            patterns: [],
            testConventions: "",
            constraints: [],
            relevantFiles: [],
          }),
          stopReason: "stop",
          toolCalls: [],
          usage: { inputTokens: 10, outputTokens: 20 },
        };
      },
    };
    await exploreCodebase({
      prompt: "test",
      cwd: "/tmp",
      modelClient: client,
      model: profile,
      readOnlyTools: [recordingTool],
      maxRounds: 6,
      signal: controller.signal,
    });
    expect(receivedSignal).toBe(controller.signal);
  });
});
