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
import { computeEpochManifest, diffEpochs, stableHash } from "../src/cache-epoch.js";
import type { ToolDefinition } from "../src/types.js";

describe("stableHash", () => {
  it("is deterministic and length-bounded", () => {
    const h1 = stableHash("stable system prompt");
    expect(h1).toBe(stableHash("stable system prompt"));
    expect(h1).toMatch(/^[0-9a-f]{16}$/);
    expect(h1).not.toBe(stableHash("stable system prompt "));
  });
});

describe("computeEpochManifest", () => {
  const tools: ToolDefinition[] = [
    { name: "read", label: "Read", description: "read file", parameters: { type: "object" }, effect: "read" },
  ];

  it("produces identical manifest for identical inputs", () => {
    const a = computeEpochManifest({ modelRevision: "r1", systemStable: "S", toolDefinitions: tools });
    const b = computeEpochManifest({ modelRevision: "r1", systemStable: "S", toolDefinitions: tools });
    expect(a).toEqual(b);
  });

  it("changes toolBundleHash when tool schema changes", () => {
    const a = computeEpochManifest({ modelRevision: "r1", systemStable: "S", toolDefinitions: tools });
    const b = computeEpochManifest({
      modelRevision: "r1",
      systemStable: "S",
      toolDefinitions: [...tools, { name: "write", label: "Write", description: "w", parameters: {}, effect: "write" }],
    });
    expect(a.toolBundleHash).not.toBe(b.toolBundleHash);
    expect(a.systemHash).toBe(b.systemHash);
  });

  it("changes systemHash when stable system changes", () => {
    const a = computeEpochManifest({ modelRevision: "r1", systemStable: "S", toolDefinitions: tools });
    const b = computeEpochManifest({ modelRevision: "r1", systemStable: "S2", toolDefinitions: tools });
    expect(a.systemHash).not.toBe(b.systemHash);
  });
});

describe("diffEpochs", () => {
  const tools: ToolDefinition[] = [
    { name: "read", label: "Read", description: "read file", parameters: { type: "object" }, effect: "read" },
  ];
  const writeTool: ToolDefinition = {
    name: "write",
    label: "Write",
    description: "w",
    parameters: {},
    effect: "write",
  };

  it("returns [] when manifests are identical", () => {
    const a = computeEpochManifest({ modelRevision: "r1", systemStable: "S", toolDefinitions: tools });
    const b = computeEpochManifest({ modelRevision: "r1", systemStable: "S", toolDefinitions: tools });
    expect(diffEpochs(a, b)).toEqual([]);
  });

  it("reports toolBundleHash when only the tool bundle differs", () => {
    const a = computeEpochManifest({ modelRevision: "r1", systemStable: "S", toolDefinitions: tools });
    const b = computeEpochManifest({
      modelRevision: "r1",
      systemStable: "S",
      toolDefinitions: [...tools, writeTool],
    });
    expect(diffEpochs(a, b)).toEqual(["toolBundleHash"]);
  });

  it("reports multiple fields when several differ", () => {
    const a = computeEpochManifest({ modelRevision: "r1", systemStable: "S", toolDefinitions: tools });
    const b = computeEpochManifest({ modelRevision: "r2", systemStable: "S2", toolDefinitions: tools });
    expect(diffEpochs(a, b)).toEqual(["modelRevision", "systemHash"]);
  });

  it("tracks churn across two simulated rounds (one more tool)", () => {
    // Simulates the agent's per-round semantics: manifest A in round 1, then
    // manifest B in round 2 after a new tool is registered.
    const round1 = computeEpochManifest({ modelRevision: "r1", systemStable: "S", toolDefinitions: tools });
    const round2 = computeEpochManifest({
      modelRevision: "r1",
      systemStable: "S",
      toolDefinitions: [...tools, writeTool],
    });
    expect(diffEpochs(round1, round2)).toContain("toolBundleHash");
  });
});

// Minimal model-client fixture for the CodingAgent integration test.
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
  private index = 0;
  constructor(private readonly responses: ModelResponse[]) {}

  async complete(
    _request: ModelRequest,
    onEvent?: Parameters<ModelClient["complete"]>[1],
  ): Promise<ModelResponse> {
    const response = this.responses[this.index++];
    if (!response) throw new Error("No scripted response");
    if (response.content) onEvent?.({ type: "text_delta", delta: response.content });
    return response;
  }
}

describe("CodingAgent epoch churn tracking", () => {
  it("tracks epoch churn when tools change between rounds", async () => {
    const root = await createTestDirectory("epoch-churn");
    const registry = await createCodingToolRegistry(root);
    const client = new QueueModelClient([
      {
        content: "first done",
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "stop",
      },
      {
        content: "second done",
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 5 },
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
      sessionStore: new SessionStore("epoch-churn", false),
      checkpoints: false,
      maxRounds: 5,
    });

    // Round 1: no previous epoch, so no churn recorded yet.
    await agent.submit("first");
    const before = agent.getCacheDiagnostics();
    expect(before.churnReasons).toEqual([]);
    expect(before.lastChanged).toBeUndefined();
    expect(before.current).toBeDefined();

    // Register a second tool, then run round 2 — tool bundle must churn.
    registry.register({
      definition: {
        name: "ping",
        label: "Ping",
        description: "pong",
        parameters: {},
        effect: "read",
      },
      execute: async () => ({ content: "pong", isError: false }),
    });

    await agent.submit("second");
    const after = agent.getCacheDiagnostics();
    expect(after.churnReasons.some((reason) => reason.includes("toolBundleHash"))).toBe(true);
    expect(after.lastChanged).toBeDefined();
    expect(after.current).toBeDefined();
  });
});
