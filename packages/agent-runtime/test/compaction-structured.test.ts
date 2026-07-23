import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentMessage, ModelProfile } from "../src/index.js";
import {
  ConversationContext,
  SessionStore,
  summarizeEntriesStructured,
  type SessionCompactionStructured,
  type SessionEntry,
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
  reasoningEffort: "off",
  capabilities: { input: ["text"], reasoning: false, toolCalling: true },
  compatibility: {},
  reliability: {
    timeoutMs: 300_000,
    maxRetries: 0,
    retryBaseDelayMs: 500,
    retryMaximumDelayMs: 10_000,
  },
};

const now = () => new Date("2026-07-19T00:00:00.000Z");

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

let entryCounter = 0;

function entry(message: AgentMessage): SessionEntry {
  entryCounter += 1;
  return {
    entryId: `entry_${entryCounter}`,
    createdAt: now().toISOString(),
    message,
  };
}

describe("summarizeEntriesStructured", () => {
  it("extracts files, commands, decisions, approvals and questions from entries", () => {
    const entries = [
      entry({ role: "user", content: "帮我修复登录问题" }),
      entry({
        role: "assistant",
        content: "先看一下代码。",
        toolCalls: [
          { id: "c1", name: "read", arguments: { path: "src/auth.ts" } },
          { id: "c2", name: "grep", arguments: { path: "src/session.ts" } },
          { id: "c3", name: "write", arguments: { path: "src/auth.ts" } },
          { id: "c4", name: "edit", arguments: { path: "src/login.ts" } },
          { id: "c5", name: "apply_patch", arguments: { path: "src/util.ts" } },
          { id: "c6", name: "bash", arguments: { command: "pnpm test" } },
        ],
      }),
      entry({ role: "assistant", content: "我决定使用文件锁。改用抢占策略。其他说明。" }),
      entry({ role: "user", content: "这个方案待批准。是否需要回滚？" }),
    ];
    const structured = summarizeEntriesStructured(entries);
    expect(structured.schemaVersion).toBe("focuscode-compaction.v1");
    expect(structured.filesRead).toEqual(["src/auth.ts", "src/session.ts"]);
    expect(structured.filesChanged).toEqual(["src/auth.ts", "src/login.ts", "src/util.ts"]);
    expect(structured.commandsRun).toEqual(["pnpm test"]);
    expect(structured.keyDecisions).toEqual(["我决定使用文件锁。", "改用抢占策略。"]);
    expect(structured.pendingApprovals).toEqual(["这个方案待批准。"]);
    expect(structured.openQuestions).toEqual(["是否需要回滚？"]);
  });

  it("deduplicates and bounds every field", () => {
    const toolCalls = [];
    for (let index = 0; index < 60; index += 1) {
      toolCalls.push(
        { id: `r${index}`, name: "read", arguments: { path: `src/read-${index}.ts` } },
        { id: `w${index}`, name: "write", arguments: { path: `src/write-${index}.ts` } },
        { id: `b${index}`, name: "bash", arguments: { command: `command-${index}` } },
      );
    }
    // Duplicate the first file and command to confirm dedupe.
    toolCalls.push(
      { id: "dup-r", name: "read", arguments: { path: "src/read-0.ts" } },
      { id: "dup-b", name: "bash", arguments: { command: "command-0" } },
    );
    const decisions = Array.from({ length: 25 }, (_, index) => `决定方案${index}。`).join("");
    const entries = [
      entry({ role: "assistant", content: decisions, toolCalls }),
      entry({ role: "assistant", content: "决定方案0。" }),
    ];
    const structured = summarizeEntriesStructured(entries);
    expect(structured.filesRead).toHaveLength(50);
    expect(structured.filesRead).toEqual([...structured.filesRead].sort());
    expect(structured.filesChanged).toHaveLength(50);
    expect(structured.commandsRun).toHaveLength(50);
    expect(structured.keyDecisions).toHaveLength(20);
  });

  it("truncates long commands to 120 characters", () => {
    const longCommand = `echo ${"x".repeat(200)}`;
    const structured = summarizeEntriesStructured([
      entry({
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "bash", arguments: { command: longCommand } }],
      }),
    ]);
    expect(structured.commandsRun).toEqual([longCommand.slice(0, 120)]);
  });

  it("merges with a prior structured summary as a deduplicated bounded union", () => {
    const prior: SessionCompactionStructured = {
      schemaVersion: "focuscode-compaction.v1",
      filesRead: ["src/old.ts"],
      filesChanged: ["src/auth.ts", "src/legacy.ts"],
      commandsRun: ["pnpm build"],
      keyDecisions: ["我决定使用文件锁。"],
      pendingApprovals: ["旧方案待批准。"],
      openQuestions: ["旧问题？"],
    };
    const entries = [
      entry({
        role: "assistant",
        content: "我决定使用文件锁。改用抢占策略。",
        toolCalls: [
          { id: "c1", name: "write", arguments: { path: "src/auth.ts" } },
          { id: "c2", name: "bash", arguments: { command: "pnpm build" } },
          { id: "c3", name: "bash", arguments: { command: "pnpm test" } },
        ],
      }),
    ];
    const structured = summarizeEntriesStructured(entries, prior);
    expect(structured.filesRead).toEqual(["src/old.ts"]);
    expect(structured.filesChanged).toEqual(["src/auth.ts", "src/legacy.ts"]);
    expect(structured.commandsRun).toEqual(["pnpm build", "pnpm test"]);
    expect(structured.keyDecisions).toEqual(["我决定使用文件锁。", "改用抢占策略。"]);
    expect(structured.pendingApprovals).toEqual(["旧方案待批准。"]);
    expect(structured.openQuestions).toEqual(["旧问题？"]);
  });
});

describe("ConversationContext.summarize structured sections", () => {
  it("renders fixed sections for structured facts at the top of the summary", () => {
    const context = new ConversationContext(model);
    const summary = context.summarize([
      entry({ role: "user", content: "修复登录" }),
      entry({
        role: "assistant",
        content: "我决定加锁。",
        toolCalls: [
          { id: "c1", name: "edit", arguments: { path: "src/auth.ts" } },
          { id: "c2", name: "bash", arguments: { command: "pnpm test" } },
        ],
      }),
      entry({ role: "user", content: "是否继续？" }),
    ]);
    expect(summary).toContain("## Files changed\n- src/auth.ts");
    expect(summary).toContain("## Commands run\n- pnpm test");
    expect(summary).toContain("## Key decisions\n- 我决定加锁。");
    expect(summary).toContain("## Open questions\n- 是否继续？");
    expect(summary).toContain("User goals:");
    // Structured sections lead the summary so they survive the 24k slice.
    expect(summary.indexOf("## Files changed")).toBeLessThan(summary.indexOf("User goals:"));
  });

  it("omits sections that have no content", () => {
    const context = new ConversationContext(model);
    const summary = context.summarize([entry({ role: "user", content: "随便聊聊" })]);
    expect(summary).not.toContain("## Files changed");
    expect(summary).not.toContain("## Key decisions");
    expect(summary).not.toContain("## Open questions");
    expect(summary).toContain("User goals:");
  });
});

describe("SessionCompaction structured persistence", () => {
  it("round-trips the structured field through saveCompaction and load", async () => {
    const directory = await mkdtemp(join(tmpdir(), "focus-compaction-"));
    directories.push(directory);
    const store = new SessionStore(directory, true, now);
    const session = await store.create({ cwd: process.cwd(), model });
    const first = await store.appendMessage(session.header.sessionId, {
      role: "user",
      content: "hello",
    });
    const structured = summarizeEntriesStructured([
      entry({
        role: "assistant",
        content: "我决定重写。",
        toolCalls: [{ id: "c1", name: "edit", arguments: { path: "src/a.ts" } }],
      }),
    ]);
    await store.saveCompaction(session.header.sessionId, "summary", first.entryId, { structured });
    const loaded = await new SessionStore(directory, true, now).load(session.header.sessionId);
    expect(loaded.compaction?.structured).toEqual(structured);
  });

  it("loads a legacy compaction without a structured field and compiles from text", async () => {
    const directory = await mkdtemp(join(tmpdir(), "focus-compaction-"));
    directories.push(directory);
    const store = new SessionStore(directory, true, now);
    const session = await store.create({ cwd: process.cwd(), model });
    const first = await store.appendMessage(session.header.sessionId, {
      role: "user",
      content: "first question",
    });
    await store.appendMessage(session.header.sessionId, {
      role: "assistant",
      content: "first answer",
    });
    await store.saveCompaction(session.header.sessionId, "legacy text summary", first.entryId);

    const loaded = await new SessionStore(directory, true, now).load(session.header.sessionId);
    expect(loaded.compaction).toEqual({
      summary: "legacy text summary",
      upToEntryId: first.entryId,
      createdAt: now().toISOString(),
    });
    expect(loaded.compaction?.structured).toBeUndefined();

    const compiled = new ConversationContext(model).compile(loaded);
    expect(compiled.summary).toBe("legacy text summary");
    expect(compiled.messages.map((message) => message.content)).toEqual(["first answer"]);
  });

  it("keeps original entries untouched when a compaction is saved", async () => {
    const directory = await mkdtemp(join(tmpdir(), "focus-compaction-"));
    directories.push(directory);
    const store = new SessionStore(directory, true, now);
    const session = await store.create({ cwd: process.cwd(), model });
    const first = await store.appendMessage(session.header.sessionId, {
      role: "user",
      content: "question",
    });
    const second = await store.appendMessage(session.header.sessionId, {
      role: "assistant",
      content: "answer",
    });
    await store.saveCompaction(session.header.sessionId, "summary", second.entryId, {
      structured: summarizeEntriesStructured([
        entry({ role: "assistant", content: "决定保留原文。" }),
      ]),
    });
    const loaded = await new SessionStore(directory, true, now).load(session.header.sessionId);
    // Compaction is a projection: entries stay intact and replayable.
    expect(loaded.entries.map((item) => item.entryId)).toEqual([first.entryId, second.entryId]);
    expect(loaded.entries.map((item) => item.message.content)).toEqual(["question", "answer"]);
  });
});
