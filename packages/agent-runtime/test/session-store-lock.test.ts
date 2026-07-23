import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelProfile } from "../src/index.js";
import { SessionStore } from "../src/index.js";

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

async function tempStore(): Promise<{ directory: string; store: SessionStore }> {
  const directory = await mkdtemp(join(tmpdir(), "focus-session-lock-"));
  directories.push(directory);
  return { directory, store: new SessionStore(directory, true, now) };
}

async function writeLock(
  directory: string,
  sessionId: string,
  record: { pid: number; acquiredAt: string },
): Promise<void> {
  await writeFile(
    join(directory, `${sessionId}.lock`),
    JSON.stringify({ ...record, hostname: hostname() }),
    "utf8",
  );
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  if (child.pid === undefined) throw new Error("failed to spawn probe process");
  return child.pid;
}

describe("SessionStore cross-process lock", () => {
  it("rejects mutations while another live pid holds the lock", async () => {
    const { directory, store } = await tempStore();
    const session = await store.create({ cwd: process.cwd(), model });
    const sessionId = session.header.sessionId;
    await writeLock(directory, sessionId, { pid: process.pid, acquiredAt: now().toISOString() });

    await expect(store.appendMessage(sessionId, { role: "user", content: "hi" })).rejects.toThrow(
      `Session ${sessionId} is locked by pid ${process.pid}`,
    );
    await expect(store.setName(sessionId, "rename")).rejects.toThrow(/locked by pid/);
    await expect(store.setModel(sessionId, model)).rejects.toThrow(/locked by pid/);
    await expect(store.moveLeaf(sessionId, "entry_x")).rejects.toThrow(/locked by pid/);
    await expect(store.saveCompaction(sessionId, "s", "entry_x")).rejects.toThrow(/locked by pid/);
    await expect(store.fork(sessionId, undefined, model)).rejects.toThrow(/locked by pid/);

    // Read-only operations are not gated by the lock.
    const loaded = await store.load(sessionId);
    expect(loaded.header.sessionId).toBe(sessionId);
  });

  it("preempts a lock whose recorded pid is dead", async () => {
    const { directory, store } = await tempStore();
    const session = await store.create({ cwd: process.cwd(), model });
    const sessionId = session.header.sessionId;
    await writeLock(directory, sessionId, {
      pid: await deadPid(),
      acquiredAt: now().toISOString(),
    });

    const appended = await store.appendMessage(sessionId, { role: "user", content: "hi" });
    expect(appended.message.content).toBe("hi");
    // The store released its own lock after the mutation completed.
    await expect(readFile(join(directory, `${sessionId}.lock`), "utf8")).rejects.toThrow();
  });

  it("preempts a lock older than the TTL even when the pid is alive", async () => {
    const { directory, store } = await tempStore();
    const session = await store.create({ cwd: process.cwd(), model });
    const sessionId = session.header.sessionId;
    const stale = new Date(now().getTime() - 60_000).toISOString();
    await writeLock(directory, sessionId, { pid: process.pid, acquiredAt: stale });

    const appended = await store.appendMessage(sessionId, { role: "user", content: "hi" });
    expect(appended.message.content).toBe("hi");
  });

  it("append CAS rejects a stale expected leaf and accepts the current one", async () => {
    const { store } = await tempStore();
    const session = await store.create({ cwd: process.cwd(), model });
    const sessionId = session.header.sessionId;
    const first = await store.appendMessage(sessionId, { role: "user", content: "one" });
    const second = await store.appendMessage(sessionId, { role: "assistant", content: "two" });

    await expect(
      store.appendMessage(sessionId, { role: "user", content: "three" }, undefined, {
        expectedLeafId: first.entryId,
      }),
    ).rejects.toThrow(/active leaf changed concurrently/);

    const third = await store.appendMessage(
      sessionId,
      { role: "user", content: "three" },
      undefined,
      { expectedLeafId: second.entryId },
    );
    expect(third.parentId).toBe(second.entryId);
    const loaded = await store.load(sessionId);
    expect(loaded.activeLeafId).toBe(third.entryId);
  });

  it("runs append, compaction and fork under the lock and releases it afterwards", async () => {
    const { directory, store } = await tempStore();
    const session = await store.create({ cwd: process.cwd(), model });
    const sessionId = session.header.sessionId;
    const first = await store.appendMessage(sessionId, { role: "user", content: "one" });
    await store.appendMessage(sessionId, { role: "assistant", content: "two" });
    await store.saveCompaction(sessionId, "summary", first.entryId);
    const fork = await store.fork(sessionId, first.entryId, model, "forked");
    expect(fork.entries.map((item) => item.message.content)).toEqual(["one"]);

    // Every mutation released its lock, so the files are gone and the lock can
    // be acquired again by a fresh store over the same directory.
    await expect(readFile(join(directory, `${sessionId}.lock`), "utf8")).rejects.toThrow();
    const other = new SessionStore(directory, true, now);
    const appended = await other.appendMessage(sessionId, { role: "user", content: "three" });
    expect(appended.message.content).toBe("three");
  });
});
