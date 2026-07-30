import { appendFile, readFile, writeFile } from "node:fs/promises";
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

describe("FileFactStore torn-tail recovery (P0-3)", () => {
  it("TC-P0-3-01: loadEvents skips a torn final line without mutating the file; append repairs under lock (P1-F: lockless read)", async () => {
    const root = await createTestDirectory("p03-truncate");
    const store = new FileFactStore(root);
    await store.append({
      taskId: "task-1",
      expectedVersion: 0,
      events: [makeEvent("task-1", 1), makeEvent("task-1", 2)],
    });
    const path = eventsPath(root, "task-1");
    const original = await readFile(path, "utf8");
    await appendFile(path, '{"schemaVersion":"domain-ev', "utf8");

    // loadEvents is a public read method callable without the task lock, so
    // it must NOT truncate the file — doing so would race with a concurrent
    // append. It only skips the torn tail in memory.
    const events = await store.loadEvents("task-1");
    expect(events.map((event) => event.seq)).toEqual([1, 2]);

    const afterLoad = await readFile(path, "utf8");
    expect(afterLoad).toBe(`${original}{"schemaVersion":"domain-ev`);

    // The repair happens under the task lock on the next append.
    await store.append({
      taskId: "task-1",
      expectedVersion: 2,
      events: [makeEvent("task-1", 3)],
    });

    const afterAppend = await readFile(path, "utf8");
    expect(afterAppend.endsWith("\n")).toBe(true);
    expect(afterAppend.endsWith('{"schemaVersion":"domain-ev')).toBe(false);
  });

  it("TC-P0-3-02: append after torn-tail recovery keeps the log readable", async () => {
    const root = await createTestDirectory("p03-append");
    const store = new FileFactStore(root);
    await store.append({
      taskId: "task-1",
      expectedVersion: 0,
      events: [makeEvent("task-1", 1), makeEvent("task-1", 2)],
    });
    await appendFile(eventsPath(root, "task-1"), '{"schemaVersion":"domain-ev', "utf8");

    // loadEvents does not truncate (P1-F), but the subsequent append holds the
    // lock and repairs the torn tail via loadEventsLocked before writing.
    await store.loadEvents("task-1");

    const ack = await store.append({
      taskId: "task-1",
      expectedVersion: 2,
      events: [makeEvent("task-1", 3)],
    });
    expect(ack.lastSeq).toBe(3);

    const events = await store.loadEvents("task-1");
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
  });

  it("TC-P0-3-03: consecutive appends after recovery keep seq continuity and valid digests", async () => {
    const root = await createTestDirectory("p03-seq");
    const store = new FileFactStore(root);
    await store.append({
      taskId: "task-1",
      expectedVersion: 0,
      events: [makeEvent("task-1", 1)],
    });
    await appendFile(eventsPath(root, "task-1"), '{"schemaVersion":"domain-ev', "utf8");

    await store.loadEvents("task-1");

    const ack1 = await store.append({
      taskId: "task-1",
      expectedVersion: 1,
      events: [makeEvent("task-1", 2)],
    });
    const ack2 = await store.append({
      taskId: "task-1",
      expectedVersion: 2,
      events: [makeEvent("task-1", 3)],
    });
    expect([ack1.firstSeq, ack1.lastSeq]).toEqual([2, 2]);
    expect([ack2.firstSeq, ack2.lastSeq]).toEqual([3, 3]);

    const reopened = new FileFactStore(root);
    const events = await reopened.loadEvents("task-1");
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(events).toHaveLength(3);
  });

  it("TC-P0-3-04: corruption before the tail still fails closed", async () => {
    const root = await createTestDirectory("p03-fail-closed");
    const store = new FileFactStore(root);
    await store.append({
      taskId: "task-1",
      expectedVersion: 0,
      events: [makeEvent("task-1", 1), makeEvent("task-1", 2)],
    });
    const path = eventsPath(root, "task-1");
    const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
    lines[0] = "not-json";
    await writeFile(path, `${lines.join("\n")}\n{"schemaVersion":"domain-ev`, "utf8");

    await expect(store.loadEvents("task-1")).rejects.toThrow(/Invalid event JSON/);
  });
});
