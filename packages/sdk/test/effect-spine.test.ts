import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestDirectory } from "@focuscode/testkit";
import {
  AgentToolRegistry,
  CodingAgent,
  FileAuditJournal,
  SessionStore,
  verifyAuditJournal,
  type AgentEvent,
  type AgentTool,
  type ModelClient,
  type ModelProfile,
  type PermissionRequest,
} from "@focuscode/agent-runtime";
import { createSessionEffectSpine } from "../src/index.js";

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

const unusedModelClient: ModelClient = {
  protocol: "openai-chat",
  async complete() {
    throw new Error("model client is not used by runTool");
  },
};

function writeNoteTool(): AgentTool {
  return {
    definition: {
      name: "write",
      label: "Write Note",
      description: "Write a note file inside the workspace",
      parameters: {
        type: "object",
        required: ["path", "content"],
        properties: { path: { type: "string" }, content: { type: "string" } },
      },
      effect: "write",
    },
    async execute(args, { cwd }) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(cwd, String(args.path)), String(args.content), "utf8");
      return { content: `wrote ${String(args.path)}` };
    },
  };
}

describe("session effect spine composition", () => {
  it("executes writes through LocalActionRuntime with grant linkage in events and audit", async () => {
    const root = await createTestDirectory("effect-spine");
    const auditDirectory = await createTestDirectory("effect-spine-audit");
    const registry = new AgentToolRegistry([writeNoteTool()]);
    const spine = createSessionEffectSpine({
      cwd: root,
      registry,
      taskId: "task_spine_test",
      model,
      permission: { mode: "full-auto", projectTrusted: false, protectedPaths: [".env"] },
    });
    const events: AgentEvent[] = [];
    const hmacKey = "spine-test-key-material-32-bytes!!";
    const agent = await CodingAgent.create({
      cwd: root,
      model,
      modelClient: unusedModelClient,
      tools: registry.values(),
      toolRegistry: registry,
      permission: { mode: "full-auto", projectTrusted: false, protectedPaths: [".env"] },
      sessionStore: new SessionStore("unused", false),
      effectPort: spine.effectPort,
      effectContext: spine.effectContext,
      auditJournal: new FileAuditJournal({ directory: auditDirectory, hmacKey }),
      eventSink: (event) => events.push(event),
    });

    const result = await agent.runTool("write", {
      path: "note.txt",
      content: "hello spine",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("wrote note.txt");
    expect(result.metadata?.grantId).toMatch(/^grant_/);
    expect(result.metadata?.receiptDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    // grantExpiresAt only exists when the receipt carries a real grant.
    expect(typeof result.metadata?.grantExpiresAt).toBe("string");
    expect(await readFile(join(root, "note.txt"), "utf8")).toBe("hello spine");

    const ledger = spine.runtime.ledgerSnapshot();
    expect(ledger.actionIds).toHaveLength(1);
    expect(ledger.changedFiles).toContain("note.txt");

    const toolEnd = events.find((event) => event.type === "tool_end");
    expect(toolEnd).toMatchObject({
      type: "tool_end",
      result: { metadata: { grantId: result.metadata?.grantId } },
    });

    const auditPath = join(auditDirectory, `${agent.sessionId}.audit.jsonl`);
    const verification = await verifyAuditJournal(auditPath, hmacKey);
    expect(verification.records).toBeGreaterThan(0);
    const records = (await readFile(auditPath, "utf8"))
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as { event: Record<string, unknown> });
    const auditedToolEnd = records.find((record) => record.event.type === "tool_end");
    expect(auditedToolEnd?.event.result).toMatchObject({
      grantId: result.metadata?.grantId,
      receiptDigest: result.metadata?.receiptDigest,
    });
  });

  it("denies protected paths without recording an effect", async () => {
    const root = await createTestDirectory("effect-spine-deny");
    const registry = new AgentToolRegistry([writeNoteTool()]);
    const spine = createSessionEffectSpine({
      cwd: root,
      registry,
      taskId: "task_spine_deny",
      model,
      permission: { mode: "full-auto", projectTrusted: false, protectedPaths: [".env"] },
    });
    const agent = await CodingAgent.create({
      cwd: root,
      model,
      modelClient: unusedModelClient,
      tools: registry.values(),
      toolRegistry: registry,
      permission: { mode: "full-auto", projectTrusted: false, protectedPaths: [".env"] },
      sessionStore: new SessionStore("unused", false),
      effectPort: spine.effectPort,
      effectContext: spine.effectContext,
    });
    const result = await agent.runTool("write", { path: ".env", content: "SECRET=1" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Permission denied");
    expect(spine.runtime.ledgerSnapshot().actionIds).toHaveLength(0);
  });

  it("asks exactly once per action through the bridged approval handler", async () => {
    const root = await createTestDirectory("effect-spine-ask");
    const registry = new AgentToolRegistry([writeNoteTool()]);
    const approvals: PermissionRequest[] = [];
    const spine = createSessionEffectSpine({
      cwd: root,
      registry,
      taskId: "task_spine_ask",
      model,
      permission: { mode: "ask", projectTrusted: false, protectedPaths: [] },
      approve: (request) => {
        approvals.push(request);
        return Promise.resolve(true);
      },
    });
    const agent = await CodingAgent.create({
      cwd: root,
      model,
      modelClient: unusedModelClient,
      tools: registry.values(),
      toolRegistry: registry,
      permission: {
        mode: "ask",
        projectTrusted: false,
        protectedPaths: [],
        approve: () => {
          throw new Error("session PermissionController must not prompt on the spine path");
        },
      },
      sessionStore: new SessionStore("unused", false),
      effectPort: spine.effectPort,
      effectContext: spine.effectContext,
    });
    const result = await agent.runTool("write", { path: "approved.txt", content: "yes" });
    expect(result.isError).toBeUndefined();
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ risk: "medium" });
    expect(approvals[0]?.tool.name).toBe("write");
  });
});

describe("setApprovalListener explicit wiring", () => {
  function approveAll(): (request: PermissionRequest) => Promise<boolean> {
    return () => Promise.resolve(true);
  }

  async function createAskAgent(
    root: string,
    registry: AgentToolRegistry,
    spine: ReturnType<typeof createSessionEffectSpine>,
    events: AgentEvent[],
  ): Promise<CodingAgent> {
    return CodingAgent.create({
      cwd: root,
      model,
      modelClient: unusedModelClient,
      tools: registry.values(),
      toolRegistry: registry,
      permission: {
        mode: "ask",
        projectTrusted: false,
        protectedPaths: [],
        approve: () => {
          throw new Error("session PermissionController must not prompt on the spine path");
        },
      },
      sessionStore: new SessionStore("unused", false),
      effectPort: spine.effectPort,
      effectContext: spine.effectContext,
      eventSink: (event) => events.push(event),
    });
  }

  it("delivers approval notifications through the listener wired after agent creation", async () => {
    const root = await createTestDirectory("effect-spine-listener");
    const registry = new AgentToolRegistry([writeNoteTool()]);
    const spine = createSessionEffectSpine({
      cwd: root,
      registry,
      taskId: "task_spine_listener",
      model,
      permission: { mode: "ask", projectTrusted: false, protectedPaths: [] },
      approve: approveAll(),
    });
    const events: AgentEvent[] = [];
    // Explicit wiring replaces the old create-time closure: the spine is
    // created without any reference to the agent, then the composition root
    // connects the listener once the agent exists.
    const agent = await createAskAgent(root, registry, spine, events);
    spine.setApprovalListener((request) => agent.notifyApprovalRequired(request));

    const result = await agent.runTool("write", { path: "wired.txt", content: "yes" });
    expect(result.isError).toBeUndefined();
    const approvalEvents = events.filter((event) => event.type === "approval_required");
    expect(approvalEvents).toHaveLength(1);
    expect(approvalEvents[0]).toMatchObject({
      type: "approval_required",
      request: { tool: { name: "write" }, risk: "medium" },
    });
  });

  it("keeps approvals working when no listener is wired", async () => {
    const root = await createTestDirectory("effect-spine-no-listener");
    const registry = new AgentToolRegistry([writeNoteTool()]);
    const approvals: PermissionRequest[] = [];
    const spine = createSessionEffectSpine({
      cwd: root,
      registry,
      taskId: "task_spine_no_listener",
      model,
      permission: { mode: "ask", projectTrusted: false, protectedPaths: [] },
      approve: (request) => {
        approvals.push(request);
        return Promise.resolve(true);
      },
    });
    const events: AgentEvent[] = [];
    const agent = await createAskAgent(root, registry, spine, events);

    // No setApprovalListener call: authorization must still work; only the
    // approval_required notification is skipped.
    const result = await agent.runTool("write", { path: "ok.txt", content: "yes" });
    expect(result.isError).toBeUndefined();
    expect(approvals).toHaveLength(1);
    expect(events.filter((event) => event.type === "approval_required")).toHaveLength(0);
  });

  it("routes notifications to the most recently wired listener", async () => {
    const root = await createTestDirectory("effect-spine-rebind");
    const registry = new AgentToolRegistry([writeNoteTool()]);
    const spine = createSessionEffectSpine({
      cwd: root,
      registry,
      taskId: "task_spine_rebind",
      model,
      permission: { mode: "ask", projectTrusted: false, protectedPaths: [] },
      approve: approveAll(),
    });
    const events: AgentEvent[] = [];
    const agent = await createAskAgent(root, registry, spine, events);
    const receivedA: PermissionRequest[] = [];
    const receivedB: PermissionRequest[] = [];
    spine.setApprovalListener((request) => {
      receivedA.push(request);
    });
    spine.setApprovalListener((request) => {
      receivedB.push(request);
    });

    const result = await agent.runTool("write", { path: "rebind.txt", content: "yes" });
    expect(result.isError).toBeUndefined();
    expect(receivedA).toHaveLength(0);
    expect(receivedB).toHaveLength(1);
    expect(receivedB[0]?.tool.name).toBe("write");
  });
});
