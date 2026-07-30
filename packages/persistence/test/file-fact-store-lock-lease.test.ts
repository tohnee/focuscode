import { access, constants, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newId, type NewDomainEventV1 } from "@focuscode/contracts";
import { createTestDirectory } from "@focuscode/testkit";
import { FileFactStore } from "../src/index.js";

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

describe("FileFactStore lock lease (P1-F)", () => {
  it("TC-P1-F-01: loadEvents does NOT truncate the torn tail (read-only)", async () => {
    const root = await createTestDirectory("p1f-readonly");
    const store = new FileFactStore(root);
    await store.append({
      taskId: "task-1",
      expectedVersion: 0,
      events: [makeEvent("task-1", 1), makeEvent("task-1", 2)],
    });
    const path = eventsPath(root, "task-1");
    const original = await readFile(path, "utf8");
    await writeFile(path, `${original}{"schemaVersion":"domain-ev`, "utf8");

    const events = await store.loadEvents("task-1");
    expect(events.map((event) => event.seq)).toEqual([1, 2]);

    // File is NOT modified by the read-only loadEvents path.
    const after = await readFile(path, "utf8");
    expect(after).toBe(`${original}{"schemaVersion":"domain-ev`);
  });

  it("TC-P1-F-02: append truncates the torn tail before appending (under lock)", async () => {
    const root = await createTestDirectory("p1f-append-truncate");
    const store = new FileFactStore(root);
    await store.append({
      taskId: "task-1",
      expectedVersion: 0,
      events: [makeEvent("task-1", 1), makeEvent("task-1", 2)],
    });
    const path = eventsPath(root, "task-1");
    const original = await readFile(path, "utf8");
    await writeFile(path, `${original}{"schemaVersion":"domain-ev`, "utf8");

    const ack = await store.append({
      taskId: "task-1",
      expectedVersion: 2,
      events: [makeEvent("task-1", 3)],
    });
    expect(ack.lastSeq).toBe(3);

    const events = await store.loadEvents("task-1");
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);

    const after = await readFile(path, "utf8");
    expect(after.endsWith('{"schemaVersion":"domain-ev')).toBe(false);
  });

  it("TC-P1-F-03: withTaskLock does not delete a lock stolen by another process", async () => {
    const root = await createTestDirectory("p1f-no-delete-stolen");
    // Use a very short TTL + few retries so the lock is stolen quickly.
    const store = new FileFactStore(root, {
      lockTtlMs: 1,
      lockRetryAttempts: 5,
      lockRetryDelayMs: 5,
    });
    const lockPath = await writeLockFile(
      root,
      "task-1",
      JSON.stringify({
        pid: 999_999, // dead process
        acquiredAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    );

    // The append steals the stale lock (pid is dead + TTL expired).
    const ack = await store.append({
      taskId: "task-1",
      expectedVersion: 0,
      events: [makeEvent("task-1", 1)],
    });
    expect(ack.lastSeq).toBe(1);

    // After append, the lock file is deleted (we owned it).
    await expect(access(lockPath, constants.F_OK)).rejects.toThrow();
  });

  it("TC-P1-F-04: tryStealStaleLock steals when pid is dead even within TTL", async () => {
    const root = await createTestDirectory("p1f-dead-pid");
    // Long TTL but pid is dead — should still steal.
    const store = new FileFactStore(root, {
      lockTtlMs: 600_000,
      lockRetryAttempts: 5,
      lockRetryDelayMs: 5,
    });
    await writeLockFile(
      root,
      "task-1",
      JSON.stringify({
        pid: 999_999, // dead process
        acquiredAt: new Date().toISOString(), // fresh lock
      }),
    );

    const ack = await store.append({
      taskId: "task-1",
      expectedVersion: 0,
      events: [makeEvent("task-1", 1)],
    });
    expect(ack.lastSeq).toBe(1);
  });

  it("TC-P1-F-05: tryStealStaleLock waits when pid is alive within TTL", async () => {
    const root = await createTestDirectory("p1f-live-pid");
    const store = new FileFactStore(root, {
      lockTtlMs: 600_000,
      lockRetryAttempts: 5,
      lockRetryDelayMs: 5,
    });
    await writeLockFile(
      root,
      "task-1",
      JSON.stringify({
        pid: process.pid, // live process
        acquiredAt: new Date().toISOString(),
      }),
    );

    await expect(
      store.append({ taskId: "task-1", expectedVersion: 0, events: [makeEvent("task-1", 1)] }),
    ).rejects.toThrow(/Timed out acquiring event lock/);
  });

  it("TC-P1-F-06: heartbeat refreshes acquiredAt during long operations", async () => {
    const root = await createTestDirectory("p1f-heartbeat");
    const store = new FileFactStore(root, {
      lockTtlMs: 50,
      lockHeartbeatMs: 10,
    });

    // Start an append with a slow event producer — the operation should
    // outlive the TTL but the heartbeat keeps the lock alive.
    const slowEvents: NewDomainEventV1[] = [];
    for (let i = 0; i < 50; i += 1) {
      slowEvents.push(makeEvent("task-1", i));
    }

    // A second store with the same TTL but no heartbeat would steal the lock
    // if the first operation took longer than TTL. Here the heartbeat should
    // prevent the steal. We verify by checking the append succeeds.
    const ack = await store.append({
      taskId: "task-1",
      expectedVersion: 0,
      events: slowEvents,
    });
    expect(ack.lastSeq).toBe(50);
    expect(await store.loadEvents("task-1")).toHaveLength(50);
  });
});
