import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestDirectory } from "@focuscode/testkit";
import { CheckpointStore } from "../src/index.js";

async function fixture(): Promise<{ root: string; store: CheckpointStore }> {
  const root = await createTestDirectory("checkpoints");
  await mkdir(join(root, "sub"), { recursive: true });
  await writeFile(join(root, "a.txt"), "a-v1");
  await writeFile(join(root, "sub", "b.txt"), "b-v1");
  return {
    root,
    store: new CheckpointStore({ rootDir: join(root, ".ckpt"), workspaceRoot: root }),
  };
}

describe("CheckpointStore", () => {
  it("captures, previews and restores the latest checkpoint", async () => {
    const { root, store } = await fixture();
    const manifest = await store.capture("tool:write", ["a.txt", "sub/b.txt", "new.txt"]);
    expect(manifest).toMatchObject({ schemaVersion: "focuscode-checkpoint.v1", seq: 1 });
    expect(manifest?.files).toEqual([
      { path: "a.txt", existed: true },
      { path: "sub/b.txt", existed: true },
      { path: "new.txt", existed: false },
    ]);
    // Snapshot payload lives under <rootDir>/<seq>/ with the workspace layout.
    expect(await readFile(join(root, ".ckpt", "1", "a.txt"), "utf8")).toBe("a-v1");

    await writeFile(join(root, "a.txt"), "a-v2");
    await writeFile(join(root, "new.txt"), "created");
    const preview = await store.undo();
    expect(preview).toMatchObject({ seq: 1, label: "tool:write" });
    // Preview does not restore anything.
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("a-v2");

    const restored = await store.restoreLatest();
    expect(restored).toMatchObject({ seq: 1 });
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("a-v1");
    // Files that did not exist at capture time are removed again.
    await expect(access(join(root, "new.txt"))).rejects.toThrow();
    // The checkpoint is consumed by the restore.
    expect(await store.undo()).toBeUndefined();
    expect(await store.restoreLatest()).toBeUndefined();
  });

  it("lists summaries and evicts the oldest checkpoints beyond the cap", async () => {
    const { root, store } = await fixture();
    const capped = new CheckpointStore({
      rootDir: join(root, ".ckpt"),
      workspaceRoot: root,
      maxCheckpoints: 3,
    });
    for (let index = 1; index <= 5; index += 1) {
      await writeFile(join(root, "a.txt"), `a-v${index}`);
      await capped.capture(`capture-${index}`, ["a.txt"]);
    }
    const list = await capped.list();
    expect(list.map((entry) => entry.seq)).toEqual([3, 4, 5]);
    expect(list.map((entry) => entry.label)).toEqual(["capture-3", "capture-4", "capture-5"]);
    expect(list[0]).toMatchObject({ files: 1 });
    await expect(stat(join(root, ".ckpt", "1"))).rejects.toThrow();
    await writeFile(join(root, "a.txt"), "corrupted");
    const restored = await capped.restoreLatest();
    expect(restored).toMatchObject({ seq: 5 });
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("a-v5");
  });

  it("skips absolute or escaping paths and empty captures", async () => {
    const { store } = await fixture();
    expect(await store.capture("nope", ["/etc/passwd", "../escape.txt", ""])).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });
});
