import { describe, expect, it } from "vitest";
import type { AgentToolCall, ModelProfile, ToolDefinition } from "../src/index.js";
import {
  ConversationContext,
  PermissionController,
  SessionStore,
  activeBranch,
  classifyShell,
  extractPromptToolCalls,
  renderSessionHtml,
} from "../src/index.js";

const model: ModelProfile = {
  provider: "fixture",
  model: "fixture-model",
  protocol: "openai-chat",
  baseUrl: "http://localhost/v1",
  contextWindow: 4_096,
  maxOutputTokens: 512,
  temperature: 0,
  toolMode: "auto",
};

describe("SessionStore and conversation context", () => {
  it("persists branches, metadata, compaction, forks and HTML export", async () => {
    const store = new SessionStore("unused", false, () => new Date("2026-01-01T00:00:00.000Z"));
    const session = await store.create({ cwd: process.cwd(), model, name: "fixture" });
    const user = await store.appendMessage(session.header.sessionId, {
      role: "user",
      content: "fix <unsafe>",
    });
    const assistant = await store.appendMessage(
      session.header.sessionId,
      {
        role: "assistant",
        content: "working",
        providerState: {
          reasoningContent: "opaque continuation",
          thinkingBlocks: [
            { type: "thinking", thinking: "private thought", signature: "provider-signature" },
          ],
        },
      },
      { inputTokens: 10, outputTokens: 2 },
    );
    await store.appendMessage(session.header.sessionId, {
      role: "tool",
      content: "ok",
      toolCallId: "call-1",
      toolName: "read",
    });
    await store.moveLeaf(session.header.sessionId, user.entryId);
    const branchReply = await store.appendMessage(session.header.sessionId, {
      role: "assistant",
      content: "alternate",
    });
    await store.setName(session.header.sessionId, "renamed");
    await store.setModel(session.header.sessionId, { ...model, model: "fixture-2" });
    await store.saveCompaction(session.header.sessionId, "summary", user.entryId);
    const loaded = await store.load(session.header.sessionId.slice(0, 20));
    expect(loaded.header.name).toBe("renamed");
    expect(loaded.header.model.model).toBe("fixture-2");
    expect(loaded.entries).toHaveLength(4);
    expect(
      loaded.entries.find((entry) => entry.entryId === assistant.entryId)?.message,
    ).toMatchObject({
      providerState: {
        reasoningContent: "opaque continuation",
        thinkingBlocks: [{ signature: "provider-signature" }],
      },
    });
    expect(activeBranch(loaded).map((entry) => entry.entryId)).toEqual([
      user.entryId,
      branchReply.entryId,
    ]);
    expect(renderSessionHtml(loaded)).toContain("&lt;unsafe&gt;");
    expect((await store.list(process.cwd()))[0]).toMatchObject({ entries: 4 });

    const fork = await store.fork(session.header.sessionId, assistant.entryId, model, "fork");
    expect(activeBranch(fork)).toHaveLength(2);
    expect(fork.header.forkedFrom?.sessionId).toBe(session.header.sessionId);
    expect(await store.latest(process.cwd())).toBeDefined();
  });

  it("computes compaction boundaries and parses prompt JSON tool envelopes", async () => {
    const store = new SessionStore("unused", false);
    const session = await store.create({ cwd: process.cwd(), model });
    for (let index = 0; index < 14; index += 1) {
      await store.appendMessage(session.header.sessionId, {
        role: index % 2 === 0 ? "user" : "assistant",
        content: `${index} ${"x".repeat(800)}`,
      });
    }
    const snapshot = await store.load(session.header.sessionId);
    const context = new ConversationContext(model);
    const compiled = context.compile(snapshot, 1_000);
    expect(compiled.shouldCompact).toBe(true);
    expect(compiled.compactableEntries.length).toBeGreaterThan(0);
    expect(context.summarize(compiled.compactableEntries)).toContain("User goals");
    expect(
      extractPromptToolCalls(
        '```json\n{"tool_calls":[{"name":"read","arguments":{"path":"a.ts"}}]}\n```',
      ),
    ).toMatchObject([{ name: "read", arguments: { path: "a.ts" } }]);
    expect(extractPromptToolCalls("ordinary response")).toEqual([]);
  });
});

describe("PermissionController", () => {
  const shell: ToolDefinition = {
    name: "bash",
    label: "Shell",
    description: "shell",
    parameters: {},
    effect: "shell",
  };
  const write: ToolDefinition = {
    name: "write",
    label: "Write",
    description: "write",
    parameters: {},
    effect: "write",
  };
  const patchTool: ToolDefinition = {
    name: "apply_patch",
    label: "Patch",
    description: "patch",
    parameters: {},
    effect: "write",
  };
  const call = (name: string, argumentsValue: Record<string, unknown>): AgentToolCall => ({
    id: "call",
    name,
    arguments: argumentsValue,
  });

  it("allows bounded reads and edits while blocking secrets and catastrophic commands", () => {
    const policy = new PermissionController({
      cwd: process.cwd(),
      mode: "auto-edit",
      projectTrusted: true,
      protectedPaths: [".env", ".focuscode"],
    });
    expect(policy.evaluate(write, call("write", { path: "src/a.ts" })).allowed).toBe(true);
    expect(policy.evaluate(write, call("write", { path: ".env" })).allowed).toBe(false);
    expect(policy.evaluate(shell, call("bash", { command: "git status" })).allowed).toBe(true);
    expect(policy.evaluate(shell, call("bash", { command: "cat .env" })).allowed).toBe(false);
    expect(policy.evaluate(shell, call("bash", { command: "rm -rf /" }))).toMatchObject({
      allowed: false,
    });
    expect(
      policy.evaluate(
        patchTool,
        call("apply_patch", { patch: "--- a/.focuscode/x\n+++ b/.focuscode/x\n" }),
      ).allowed,
    ).toBe(false);
    expect(
      policy.evaluate(
        patchTool,
        call("apply_patch", { patch: "--- a/src/../.env\n+++ b/src/../.env\n" }),
      ).allowed,
    ).toBe(false);
    expect(classifyShell("pnpm test").risk).toBe("medium");
    expect(classifyShell("git reset --hard HEAD").risk).toBe("high");
    expect(classifyShell("dd if=/dev/zero of=/dev/sda").risk).toBe("critical");
  });

  it("blocks protected paths disguised with dot segments", () => {
    const read: ToolDefinition = {
      name: "read",
      label: "Read",
      description: "read",
      parameters: {},
      effect: "read",
    };
    const policy = new PermissionController({
      cwd: process.cwd(),
      mode: "full-auto",
      projectTrusted: true,
      protectedPaths: [".env", ".focuscode"],
    });
    expect(policy.evaluate(read, call("read", { path: "src/../.env" })).allowed).toBe(false);
    expect(policy.evaluate(read, call("read", { path: "src/sub/../../.env" })).allowed).toBe(false);
    expect(policy.evaluate(write, call("write", { path: "sub/../.focuscode/x" })).allowed).toBe(
      false,
    );
    expect(policy.evaluate(read, call("read", { path: "src/../src/a.ts" })).allowed).toBe(true);
  });

  it("uses explicit approval only for non-critical denied operations", async () => {
    let approvals = 0;
    const policy = new PermissionController({
      cwd: process.cwd(),
      mode: "ask",
      projectTrusted: false,
      protectedPaths: [".env"],
      approve: async () => {
        approvals += 1;
        return true;
      },
    });
    expect((await policy.authorize(write, call("write", { path: "src/a.ts" }))).allowed).toBe(true);
    expect((await policy.authorize(shell, call("bash", { command: "rm -rf /" }))).allowed).toBe(
      false,
    );
    expect(approvals).toBe(1);

    const automatic = new PermissionController({
      cwd: process.cwd(),
      mode: "full-auto",
      projectTrusted: false,
      protectedPaths: [],
    });
    expect(automatic.evaluate(shell, call("bash", { command: "echo hello" })).allowed).toBe(true);
    expect(automatic.evaluate(write, call("write", { _invalid: "bad arguments" })).reason).toBe(
      "bad arguments",
    );

    const denied = new PermissionController({
      cwd: process.cwd(),
      mode: "deny",
      projectTrusted: false,
      protectedPaths: [],
    });
    expect(denied.evaluate(write, call("write", { path: "a.ts" })).allowed).toBe(false);
  });
});
