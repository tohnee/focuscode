import { describe, expect, it } from "vitest";
import { CheckpointStore } from "../src/checkpoints.js";
import { createTestDirectory } from "@focuscode/testkit";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

describe("多步 rewind - CheckpointStore", () => {
  it("restoreN(0) returns empty array", async () => {
    const root = await createTestDirectory("rewind-0");
    const store = new CheckpointStore({ rootDir: join(root, "checkpoints"), workspaceRoot: root });
    const restored = await store.restoreN(0);
    expect(restored).toEqual([]);
  });

  it("restoreN(1) restores single checkpoint", async () => {
    const root = await createTestDirectory("rewind-1");
    await writeFile(join(root, "file.txt"), "v1");
    const store = new CheckpointStore({ rootDir: join(root, "checkpoints"), workspaceRoot: root });
    await store.capture("first", ["file.txt"]);
    await writeFile(join(root, "file.txt"), "v2");
    await store.capture("second", ["file.txt"]);

    const restored = await store.restoreN(1);
    expect(restored).toHaveLength(1);
    expect(restored[0]!.label).toBe("second");
  });

  it("restoreN(2) restores two checkpoints in order", async () => {
    const root = await createTestDirectory("rewind-2");
    await writeFile(join(root, "file.txt"), "v1");
    const store = new CheckpointStore({ rootDir: join(root, "checkpoints"), workspaceRoot: root });
    await store.capture("first", ["file.txt"]);
    await writeFile(join(root, "file.txt"), "v2");
    await store.capture("second", ["file.txt"]);
    await writeFile(join(root, "file.txt"), "v3");
    await store.capture("third", ["file.txt"]);

    const restored = await store.restoreN(2);
    expect(restored).toHaveLength(2);
    expect(restored[0]!.label).toBe("third");
    expect(restored[1]!.label).toBe("second");
  });

  it("restoreN(n) with n > available returns all available", async () => {
    const root = await createTestDirectory("rewind-all");
    await writeFile(join(root, "file.txt"), "v1");
    const store = new CheckpointStore({ rootDir: join(root, "checkpoints"), workspaceRoot: root });
    await store.capture("first", ["file.txt"]);
    await store.capture("second", ["file.txt"]);

    const restored = await store.restoreN(10);
    expect(restored).toHaveLength(2);
  });

  it("restoreN(n) restores files to correct state", async () => {
    const root = await createTestDirectory("rewind-state");
    await writeFile(join(root, "file.txt"), "v1");
    const store = new CheckpointStore({ rootDir: join(root, "checkpoints"), workspaceRoot: root });
    await store.capture("first", ["file.txt"]); // captures v1
    await writeFile(join(root, "file.txt"), "v2");
    await store.capture("second", ["file.txt"]); // captures v2

    // restoreN(1) restores the "second" checkpoint (v2 state)
    // After restore, file should be v2
    await store.restoreN(1);
    const contentAfter1 = await readFile(join(root, "file.txt"), "utf8");
    expect(contentAfter1).toBe("v2");

    // restoreN(1) again restores the "first" checkpoint (v1 state)
    await store.restoreN(1);
    const contentAfter2 = await readFile(join(root, "file.txt"), "utf8");
    expect(contentAfter2).toBe("v1");
  });

  it("restoreN(n) removes restored checkpoints from store", async () => {
    const root = await createTestDirectory("rewind-remove");
    await writeFile(join(root, "file.txt"), "v1");
    const store = new CheckpointStore({ rootDir: join(root, "checkpoints"), workspaceRoot: root });
    await store.capture("first", ["file.txt"]);
    await writeFile(join(root, "file.txt"), "v2");
    await store.capture("second", ["file.txt"]);

    await store.restoreN(1);
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.label).toBe("first");
  });
});
