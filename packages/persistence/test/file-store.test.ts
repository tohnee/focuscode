import { constants } from "node:fs";
import { access, appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newId, type NewDomainEventV1 } from "@focuscode/contracts";
import { createTestDirectory } from "@focuscode/testkit";
import { FileFactStore, VersionConflictError } from "../src/index.js";

function makeEvent(taskId: string, value: number): NewDomainEventV1 {
  return {
    schemaVersion: "domain-event.v1",
    eventId: newId("evt"),
    taskId,
    kind: "FixtureCreated",
    at: "2026-07-19T00:00:00.000Z",
    actor: { id: "tester", kind: "user" },
    payload: { value },
  };
}

function eventsPath(root: string, taskId: string): string {
  return join(root, "tasks", taskId, "events.jsonl");
}

async function writeLockFile(root: string, taskId: string, content: string): Promise<string> {
  const directory = join(root, "tasks", taskId);
  await mkdir(directory, { recursive: true });
  const lockPath = join(directory, ".append.lock");
  await writeFile(lockPath, content, "utf8");
  return lockPath;
}

describe("FileFactStore", () => {
  it("appends with optimistic versions and reloads canonical events", async () => {
    const root = await createTestDirectory("facts");
    const store = new FileFactStore(root);
    const event: NewDomainEventV1 = {
      schemaVersion: "domain-event.v1",
      eventId: newId("evt"),
      taskId: "task-1",
      kind: "FixtureCreated",
      at: "2026-07-19T00:00:00.000Z",
      actor: { id: "tester", kind: "user" },
      payload: { value: 1 },
    };
    const ack = await store.append({ taskId: "task-1", expectedVersion: 0, events: [event] });
    expect(ack.lastSeq).toBe(1);
    expect(ack.events[0]?.digest).toMatch(/^sha256:/);
    await expect(
      store.append({
        taskId: "task-1",
        expectedVersion: 0,
        events: [{ ...event, eventId: newId("evt") }],
      }),
    ).rejects.toBeInstanceOf(VersionConflictError);
    expect(await store.loadEvents("task-1")).toEqual(ack.events);
    expect(await store.listTaskIds()).toEqual(["task-1"]);
  });

  it("rejects unsafe task ids before touching the filesystem", async () => {
    const store = new FileFactStore(await createTestDirectory("unsafe-id"));
    await expect(store.loadEvents("../../escape")).rejects.toThrow(/Unsafe task id/);
  });

  it("serializes concurrent appends with optimistic CAS", async () => {
    const root = await createTestDirectory("facts-cas");
    const store = new FileFactStore(root);
    const results = await Promise.allSettled([
      store.append({ taskId: "task-1", expectedVersion: 0, events: [makeEvent("task-1", 1)] }),
      store.append({ taskId: "task-1", expectedVersion: 0, events: [makeEvent("task-1", 2)] }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toBeInstanceOf(VersionConflictError);
    }
    expect(await store.loadEvents("task-1")).toHaveLength(1);
  });

  it("fails closed when a stored event digest does not match its content", async () => {
    const root = await createTestDirectory("facts-digest");
    const store = new FileFactStore(root);
    await store.append({
      taskId: "task-1",
      expectedVersion: 0,
      events: [makeEvent("task-1", 1), makeEvent("task-1", 2)],
    });
    const path = eventsPath(root, "task-1");
    const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
    const tampered = {
      ...(JSON.parse(lines[0]!) as Record<string, unknown>),
      payload: { value: 99 },
    };
    lines[0] = JSON.stringify(tampered);
    await writeFile(path, `${lines.join("\n")}\n`, "utf8");
    await expect(store.loadEvents("task-1")).rejects.toThrow(/digest mismatch at seq 1/);
  });

  it("tolerates a torn final line left by a crash mid-append", async () => {
    const root = await createTestDirectory("facts-torn");
    const store = new FileFactStore(root);
    await store.append({
      taskId: "task-1",
      expectedVersion: 0,
      events: [makeEvent("task-1", 1), makeEvent("task-1", 2)],
    });
    await appendFile(eventsPath(root, "task-1"), '{"schemaVersion":"domain-ev', "utf8");
    const events = await store.loadEvents("task-1");
    expect(events.map((event) => event.seq)).toEqual([1, 2]);
  });

  it("fails closed when any line before the tail is corrupted", async () => {
    const root = await createTestDirectory("facts-corrupt");
    const store = new FileFactStore(root);
    await store.append({
      taskId: "task-1",
      expectedVersion: 0,
      events: [makeEvent("task-1", 1), makeEvent("task-1", 2)],
    });
    const path = eventsPath(root, "task-1");
    const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
    lines[0] = "not-json";
    await writeFile(path, `${lines.join("\n")}\n`, "utf8");
    await expect(store.loadEvents("task-1")).rejects.toThrow(/Invalid event JSON/);
  });

  it("steals a stale append lock left behind by a crashed process", async () => {
    const root = await createTestDirectory("facts-stale-lock");
    const store = new FileFactStore(root, { lockTtlMs: 30_000 });
    const lockPath = await writeLockFile(
      root,
      "task-1",
      JSON.stringify({ pid: 999_999, acquiredAt: new Date(Date.now() - 60_000).toISOString() }),
    );
    const ack = await store.append({
      taskId: "task-1",
      expectedVersion: 0,
      events: [makeEvent("task-1", 1)],
    });
    expect(ack.lastSeq).toBe(1);
    // The stolen lock is released normally once the append completes.
    await expect(access(lockPath, constants.F_OK)).rejects.toThrow();
  });

  it("keeps waiting and times out while the append lock is fresh", async () => {
    const root = await createTestDirectory("facts-live-lock");
    const store = new FileFactStore(root, {
      lockTtlMs: 60_000,
      lockRetryAttempts: 5,
      lockRetryDelayMs: 5,
    });
    const lockPath = await writeLockFile(
      root,
      "task-1",
      JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
    );
    await expect(
      store.append({ taskId: "task-1", expectedVersion: 0, events: [makeEvent("task-1", 1)] }),
    ).rejects.toThrow(/Timed out acquiring event lock/);
    // A lock that is not stale is left untouched.
    expect(await readFile(lockPath, "utf8")).toContain(String(process.pid));
  });

  it("does not steal an unparseable lock file (fail safe)", async () => {
    const root = await createTestDirectory("facts-bad-lock");
    const store = new FileFactStore(root, {
      lockTtlMs: 1,
      lockRetryAttempts: 5,
      lockRetryDelayMs: 5,
    });
    const lockPath = await writeLockFile(root, "task-1", "not-json");
    await expect(
      store.append({ taskId: "task-1", expectedVersion: 0, events: [makeEvent("task-1", 1)] }),
    ).rejects.toThrow(/Timed out acquiring event lock/);
    expect(await readFile(lockPath, "utf8")).toBe("not-json");
  });
});
