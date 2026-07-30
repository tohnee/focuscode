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
  it("TC-P0-3-01: truncates the file after dropping a torn final line", async () => {
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

    const events = await store.loadEvents("task-1");
    expect(events.map((event) => event.seq)).toEqual([1, 2]);

    const after = await readFile(path, "utf8");
    expect(after).toBe(original);
    // The file must end with a newline (the torn tail had none).
    expect(after.endsWith("\n")).toBe(true);
    // The torn partial fragment must not survive as a trailing incomplete line.
    expect(after.endsWith('{"schemaVersion":"domain-ev')).toBe(false);
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
