import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelProfile } from "../src/index.js";
import { SessionStore, activeBranch } from "../src/index.js";

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

const now = () => new Date("2026-07-19T00:00:00.000Z");

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function tempStoreDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "focus-session-store-"));
  directories.push(directory);
  return directory;
}

describe("SessionStore persistent JSONL backend", () => {
  it("writes append-only JSONL and reloads everything from a fresh instance", async () => {
    const directory = await tempStoreDirectory();
    const writer = new SessionStore(directory, true, now);
    const session = await writer.create({
      cwd: process.cwd(),
      model,
      name: "persisted",
    });
    const sessionId = session.header.sessionId;
    const user = await writer.appendMessage(sessionId, { role: "user", content: "fix the bug" });
    const assistant = await writer.appendMessage(
      sessionId,
      {
        role: "assistant",
        content: "reading the file",
        providerState: {
          reasoningContent: "opaque continuation state",
          thinkingBlocks: [
            { type: "thinking", thinking: "private thought", signature: "provider-signature" },
            { type: "redacted_thinking", data: "redacted-payload" },
          ],
        },
      },
      { inputTokens: 10, outputTokens: 2, cachedInputTokens: 4 },
    );
    const tool = await writer.appendMessage(sessionId, {
      role: "tool",
      content: "file contents",
      toolCallId: "call-1",
      toolName: "read",
    });
    const withCalls = await writer.appendMessage(sessionId, {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call-1", name: "read", arguments: { path: "src/a.ts" } }],
    });
    await writer.moveLeaf(sessionId, user.entryId);
    const branchReply = await writer.appendMessage(sessionId, {
      role: "assistant",
      content: "alternate approach",
    });
    await writer.setName(sessionId, "renamed-persisted");
    await writer.saveCompaction(sessionId, "summary of progress", user.entryId);

    // The session file on disk is real append-only JSONL: header + 4*(entry+leaf)
    // + the moved leaf + the branched (entry+leaf) + 1 metadata + 1 compaction.
    const lines = (await readFile(join(directory, `${sessionId}.jsonl`), "utf8"))
      .split("\n")
      .filter(Boolean);
    expect(lines).toHaveLength(14);
    expect(lines.map((line) => (JSON.parse(line) as { type: string }).type)).toEqual([
      "session",
      ...Array.from({ length: 4 }, () => ["entry", "leaf"]).flat(),
      "leaf",
      "entry",
      "leaf",
      "metadata",
      "compaction",
    ]);

    const fork = await writer.fork(sessionId, assistant.entryId, model, "forked");

    // A brand new SessionStore over the same directory sees only what is on disk.
    const reader = new SessionStore(directory, true, now);
    const loaded = await reader.load(sessionId);
    expect(loaded.header).toMatchObject({
      schemaVersion: "focuscode-session.v1",
      sessionId,
      name: "renamed-persisted",
      model: { provider: "fixture", model: "fixture-model", protocol: "openai-chat" },
    });
    expect(loaded.entries.map((entry) => entry.entryId)).toEqual([
      user.entryId,
      assistant.entryId,
      tool.entryId,
      withCalls.entryId,
      branchReply.entryId,
    ]);
    expect(loaded.entries.map((entry) => entry.message)).toEqual([
      user.message,
      assistant.message,
      tool.message,
      withCalls.message,
      branchReply.message,
    ]);
    expect(loaded.entries.map((entry) => entry.parentId)).toEqual([
      undefined,
      user.entryId,
      assistant.entryId,
      tool.entryId,
      user.entryId,
    ]);
    expect(loaded.entries[1]?.message.providerState).toEqual({
      reasoningContent: "opaque continuation state",
      thinkingBlocks: [
        { type: "thinking", thinking: "private thought", signature: "provider-signature" },
        { type: "redacted_thinking", data: "redacted-payload" },
      ],
    });
    expect(loaded.entries[1]?.usage).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      cachedInputTokens: 4,
    });
    expect(loaded.entries[3]?.message.toolCalls).toEqual([
      { id: "call-1", name: "read", arguments: { path: "src/a.ts" } },
    ]);
    expect(loaded.compaction).toEqual({
      summary: "summary of progress",
      upToEntryId: user.entryId,
      createdAt: now().toISOString(),
    });
    expect(activeBranch(loaded).map((entry) => entry.entryId)).toEqual([
      user.entryId,
      branchReply.entryId,
    ]);

    const reloadedFork = await reader.load(fork.header.sessionId);
    expect(reloadedFork.header.forkedFrom).toEqual({
      sessionId,
      entryId: assistant.entryId,
    });
    expect(reloadedFork.header.name).toBe("forked");
    expect(reloadedFork.entries).toHaveLength(2);
    expect(reloadedFork.entries.map((entry) => entry.message)).toEqual([
      user.message,
      assistant.message,
    ]);
    expect(reloadedFork.entries[1]?.message.providerState).toEqual(assistant.message.providerState);

    const listed = await reader.list(process.cwd());
    expect(listed.map((item) => item.sessionId).sort()).toEqual(
      [sessionId, fork.header.sessionId].sort(),
    );
    expect(listed.find((item) => item.sessionId === sessionId)).toMatchObject({
      entries: 5,
      name: "renamed-persisted",
    });
  });

  it("tolerates a torn final JSONL line left by a crash mid-append", async () => {
    const directory = await tempStoreDirectory();
    const writer = new SessionStore(directory, true, now);
    const session = await writer.create({ cwd: process.cwd(), model });
    await writer.appendMessage(session.header.sessionId, { role: "user", content: "hello" });
    await appendFile(
      join(directory, `${session.header.sessionId}.jsonl`),
      '{"type":"entry","en',
      "utf8",
    );
    const reader = new SessionStore(directory, true, now);
    const loaded = await reader.load(session.header.sessionId);
    expect(loaded.entries).toHaveLength(1);
    expect(loaded.entries[0]?.message.content).toBe("hello");
  });

  it("rejects a session file with a corrupted JSONL line in the middle", async () => {
    const directory = await tempStoreDirectory();
    const writer = new SessionStore(directory, true, now);
    const session = await writer.create({ cwd: process.cwd(), model });
    await writer.appendMessage(session.header.sessionId, { role: "user", content: "hello" });
    const path = join(directory, `${session.header.sessionId}.jsonl`);
    const lines = (await readFile(path, "utf8")).split("\n");
    // Corrupt the entry line; the trailing leaf line stays valid, so the damage
    // is not a torn tail and must fail closed.
    lines[1] = "not-json";
    await writeFile(path, lines.join("\n"), "utf8");
    const reader = new SessionStore(directory, true, now);
    await expect(reader.load(session.header.sessionId)).rejects.toThrow(/Invalid session JSON/);
  });
});
