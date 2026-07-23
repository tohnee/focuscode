import { describe, expect, it } from "vitest";
import {
  ActionIntentSchema,
  assertSchema,
  sha256Digest,
  type ActionIntentV1,
  type CapabilityGrantV1,
  type EffectContextV1,
  type EffectPort,
  type EffectReceiptV1,
} from "@focuscode/contracts";
import {
  AgentToolRegistry,
  CodingAgent,
  SESSION_TOOL_SPEC_VERSION,
  SessionStore,
  buildActionIntent,
  receiptToToolResult,
  type AgentEvent,
  type AgentTool,
  type AgentToolCall,
  type ModelClient,
  type ModelProfile,
  type ToolDefinition,
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
    timeoutMs: 10_000,
    maxRetries: 0,
    retryBaseDelayMs: 10,
    retryMaximumDelayMs: 100,
  },
};

const writeDefinition: ToolDefinition = {
  name: "write",
  label: "Write",
  description: "Write a UTF-8 file",
  parameters: {
    type: "object",
    required: ["path", "content"],
    properties: { path: { type: "string" }, content: { type: "string" } },
  },
  effect: "write",
};

const writeCall: AgentToolCall = {
  id: "call_1",
  name: "write",
  arguments: { path: "src/a.ts", content: "export {}\n" },
};

function fixtureGrant(): CapabilityGrantV1 {
  return {
    schemaVersion: "capability-grant.v1",
    grantId: "grant_1",
    taskId: "task_1",
    subject: { taskId: "task_1", workerId: "worker_1", modelCertificateId: "cert_1" },
    capabilities: [{ name: "repo.write" }],
    constraints: [],
    expiresAt: "2026-01-01T00:05:00.000Z",
    fencingToken: "fence_1",
    policySnapshotDigest: sha256Digest("policy"),
  };
}

function fixtureReceipt(overrides: Partial<EffectReceiptV1> = {}): EffectReceiptV1 {
  return {
    schemaVersion: "effect-receipt.v1",
    actionId: "action_1",
    grantId: "grant_1",
    status: "applied",
    observedEffects: [],
    artifacts: [],
    reconciliation: "matched",
    message: JSON.stringify("wrote src/a.ts"),
    ...overrides,
  };
}

const effectContext: EffectContextV1 = {
  execution: {
    schemaVersion: "execution-context.v1",
    taskId: "task_test",
    tenantId: "local",
    actor: { id: "tester", kind: "user" },
    dataClass: "standard",
    policySnapshot: sha256Digest("policy"),
    budget: {
      maxTurns: 10,
      maxActions: 10,
      maxWallTimeMs: 60_000,
      maxChangedFiles: 10,
      maxChangedLines: 100,
    },
    traceId: "trace_test",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  model: {
    modelId: "fixture/fixture",
    modelRevision: sha256Digest("fixture"),
    tokenizer: sha256Digest("fixture:tokenizer"),
    chatTemplate: sha256Digest("fixture:chat-template"),
    modelPack: sha256Digest("fixture:pack"),
    deploymentProfile: sha256Digest("fixture:deployment"),
    certificateId: "fixture-cert",
    certifiedCapabilities: [],
    riskLevel: "change",
  },
  workerId: "worker_test",
};

describe("buildActionIntent", () => {
  it("maps every session effect enum to its canonical effect class", () => {
    const expected: Record<ToolDefinition["effect"], string> = {
      read: "read",
      write: "file_write",
      shell: "command",
      git: "git",
      network: "network",
    };
    for (const [effect, effectClass] of Object.entries(expected)) {
      const definition = { ...writeDefinition, effect: effect as ToolDefinition["effect"] };
      const intent = buildActionIntent(writeCall, definition, "task_1");
      assertSchema(ActionIntentSchema, intent, "session intent");
      expect(intent.expectedEffects).toHaveLength(1);
      expect(intent.expectedEffects[0]).toMatchObject({ class: effectClass });
    }
  });

  it("produces a stable schema digest and a fresh action id per invocation", () => {
    const first = buildActionIntent(writeCall, writeDefinition, "task_1");
    const second = buildActionIntent(writeCall, writeDefinition, "task_1");
    expect(first.taskId).toBe("task_1");
    expect(first.tool).toMatchObject({ id: "write", version: SESSION_TOOL_SPEC_VERSION });
    expect(first.tool.schemaDigest).toBe(sha256Digest(writeDefinition.parameters));
    expect(second.tool.schemaDigest).toBe(first.tool.schemaDigest);
    // Fresh action ids: the session loop never replays a call in-process, and
    // provider call ids repeat across turns in prompt-json mode, so cache
    // keying on them would collide or serve stale receipts.
    expect(first.actionId).toMatch(/^action_/);
    expect(second.actionId).not.toBe(first.actionId);
    const other = buildActionIntent(
      writeCall,
      { ...writeDefinition, parameters: { type: "object" } },
      "task_1",
    );
    expect(other.tool.schemaDigest).not.toBe(first.tool.schemaDigest);
  });

  it("carries the path argument as the effect resource and passes arguments through", () => {
    const intent = buildActionIntent(writeCall, writeDefinition, "task_1");
    expect(intent.expectedEffects[0]?.resource).toBe("src/a.ts");
    expect(intent.arguments).toEqual(writeCall.arguments);
    const shell = buildActionIntent(
      { id: "call_2", name: "bash", arguments: { command: "ls" } },
      { ...writeDefinition, name: "bash", effect: "shell" },
      "task_1",
    );
    expect(shell.expectedEffects[0]?.resource).toBeUndefined();
  });
});

describe("receiptToToolResult", () => {
  it("unwraps applied receipts and exposes grant linkage in metadata", () => {
    const receipt = fixtureReceipt({ grant: fixtureGrant() });
    const result = receiptToToolResult(receipt);
    expect(result).toMatchObject({
      content: "wrote src/a.ts",
      metadata: {
        grantId: "grant_1",
        receiptDigest: sha256Digest(receipt),
        grantExpiresAt: "2026-01-01T00:05:00.000Z",
      },
    });
    expect(result.isError).toBeUndefined();
  });

  it("marks policy denials as permission errors without grant expiry", () => {
    const receipt = fixtureReceipt({
      status: "rejected",
      grantId: "denied_1",
      message: "Protected path is outside this task's write capability: .env",
    });
    const result = receiptToToolResult(receipt);
    expect(result.isError).toBe(true);
    expect(result.content).toBe(
      "Permission denied: Protected path is outside this task's write capability: .env",
    );
    expect(result.metadata?.grantId).toBe("denied_1");
    expect(result.metadata?.grantExpiresAt).toBeUndefined();
  });

  it("keeps raw tool errors for executions that failed after a grant", () => {
    const receipt = fixtureReceipt({
      status: "rejected",
      grant: fixtureGrant(),
      message: "disk full",
    });
    const result = receiptToToolResult(receipt);
    expect(result.isError).toBe(true);
    expect(result.content).toBe("disk full");
  });

  it("treats partial and unknown receipts as errors", () => {
    for (const status of ["partial", "unknown"] as const) {
      const result = receiptToToolResult(fixtureReceipt({ status, message: "m" }));
      expect(result.isError).toBe(true);
    }
  });
});

describe("CodingAgent effect spine", () => {
  class FakeEffectPort implements EffectPort {
    readonly submissions: Array<{ intents: ActionIntentV1[]; context: EffectContextV1 }> = [];

    async submit(intents: ActionIntentV1[], context: EffectContextV1): Promise<EffectReceiptV1[]> {
      for (const intent of intents) assertSchema(ActionIntentSchema, intent, "submitted intent");
      this.submissions.push({ intents, context });
      return intents.map((intent) =>
        fixtureReceipt({
          actionId: intent.actionId,
          grantId: "grant_fake",
          grant: { ...fixtureGrant(), grantId: "grant_fake", taskId: intent.taskId },
          message: JSON.stringify("spine applied"),
        }),
      );
    }
  }

  const writeTool: AgentTool = {
    definition: writeDefinition,
    async execute() {
      throw new Error("legacy tool executor must not run on the spine path");
    },
  };

  function throwingPermission() {
    return {
      mode: "ask" as const,
      projectTrusted: false,
      protectedPaths: [] as string[],
      approve: () => {
        throw new Error("PermissionController must not be consulted on the spine path");
      },
    };
  }

  it("routes executeCall through the injected EffectPort and skips PermissionController", async () => {
    const effectPort = new FakeEffectPort();
    const events: AgentEvent[] = [];
    const agent = await CodingAgent.create({
      cwd: "/tmp",
      model,
      modelClient: {} as ModelClient,
      tools: [writeTool],
      toolRegistry: new AgentToolRegistry([writeTool]),
      permission: throwingPermission(),
      sessionStore: new SessionStore("unused", false),
      effectPort,
      effectContext,
      eventSink: (event) => events.push(event),
    });
    const result = await agent.runTool("write", { path: "src/a.ts", content: "export {}\n" });
    expect(result).toMatchObject({
      content: "spine applied",
      metadata: { grantId: "grant_fake" },
    });
    expect(result.isError).toBeUndefined();
    expect(effectPort.submissions).toHaveLength(1);
    const [submission] = effectPort.submissions;
    expect(submission?.intents[0]?.taskId).toBe("task_test");
    expect(submission?.intents[0]?.tool.id).toBe("write");
    expect(submission?.context).toBe(effectContext);
    const toolEnd = events.find((event) => event.type === "tool_end");
    expect(toolEnd).toMatchObject({
      type: "tool_end",
      result: { metadata: { grantId: "grant_fake" } },
    });
    expect(events.some((event) => event.type === "tool_start")).toBe(true);
  });

  it("still consults PermissionController when no EffectPort is injected", async () => {
    const agent = await CodingAgent.create({
      cwd: "/tmp",
      model,
      modelClient: {} as ModelClient,
      tools: [writeTool],
      toolRegistry: new AgentToolRegistry([writeTool]),
      permission: throwingPermission(),
      sessionStore: new SessionStore("unused", false),
    });
    await expect(
      agent.runTool("write", { path: "src/a.ts", content: "export {}\n" }),
    ).rejects.toThrow("PermissionController must not be consulted");
  });

  it("requires an effectContext when an effectPort is configured", async () => {
    await expect(
      CodingAgent.create({
        cwd: "/tmp",
        model,
        modelClient: {} as ModelClient,
        tools: [writeTool],
        permission: {
          mode: "full-auto",
          projectTrusted: false,
          protectedPaths: [],
        },
        sessionStore: new SessionStore("unused", false),
        effectPort: new FakeEffectPort(),
      }),
    ).rejects.toThrow("effectContext");
  });
});
