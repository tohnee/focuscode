import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestDirectory } from "@focuscode/testkit";
import { CheckpointStore } from "../src/index.js";

describe("CheckpointStore realpath guard (P1-7)", () => {
  it("TC-P1-7-01: capture() rejects workspace-internal symlink pointing outside", async () => {
    const root = await createTestDirectory("ckpt-symlink-out");
    const outside = await createTestDirectory("ckpt-symlink-out-target");
    await writeFile(join(outside, "secret.txt"), "external-secret", "utf8");
    // Symlink inside workspace pointing to a file outside the workspace.
    await symlink(join(outside, "secret.txt"), join(root, "escape-link.txt"));

    const store = new CheckpointStore({ rootDir: join(root, ".ckpt"), workspaceRoot: root });
    const manifest = await store.capture("tool:write", ["escape-link.txt"]);

    // The symlink path must not be captured (existed: false, content not copied).
    expect(manifest).toBeDefined();
    const entry = manifest?.files.find((f) => f.path === "escape-link.txt");
    expect(entry).toBeDefined();
    expect(entry?.existed).toBe(false);

    // External content must not be copied into the checkpoint directory.
    await expect(readFile(join(root, ".ckpt", "1", "escape-link.txt"), "utf8")).rejects.toThrow();
  });

  it("TC-P1-7-02: capture() handles workspace-internal regular files", async () => {
    const root = await createTestDirectory("ckpt-regular");
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "a.txt"), "content-a", "utf8");
    await writeFile(join(root, "sub", "b.txt"), "content-b", "utf8");

    const store = new CheckpointStore({ rootDir: join(root, ".ckpt"), workspaceRoot: root });
    const manifest = await store.capture("tool:write", ["a.txt", "sub/b.txt"]);

    expect(manifest?.files).toEqual([
      { path: "a.txt", existed: true },
      { path: "sub/b.txt", existed: true },
    ]);
    expect(await readFile(join(root, ".ckpt", "1", "a.txt"), "utf8")).toBe("content-a");
    expect(await readFile(join(root, ".ckpt", "1", "sub", "b.txt"), "utf8")).toBe("content-b");
  });

  it("TC-P1-7-03: restoreLatest() rejects manifest path pointing outside via symlink", async () => {
    const root = await createTestDirectory("ckpt-restore-out");
    const outside = await createTestDirectory("ckpt-restore-out-target");
    await writeFile(join(outside, "victim.txt"), "victim-original", "utf8");

    // Capture a regular file inside the workspace.
    await writeFile(join(root, "a.txt"), "workspace-original", "utf8");
    const store = new CheckpointStore({ rootDir: join(root, ".ckpt"), workspaceRoot: root });
    await store.capture("tool:write", ["a.txt"]);

    // Swap the file for a symlink pointing outside the workspace.
    await rm(join(root, "a.txt"));
    await symlink(join(outside, "victim.txt"), join(root, "a.txt"));

    // Restore must NOT follow the symlink to write outside the workspace.
    const restored = await store.restoreLatest();
    expect(restored).toMatchObject({ seq: 1 });

    // The external file must remain unmodified.
    expect(await readFile(join(outside, "victim.txt"), "utf8")).toBe("victim-original");
  });

  it("TC-P1-7-04: restoreLatest() restores workspace-internal files", async () => {
    const root = await createTestDirectory("ckpt-restore-ok");
    await writeFile(join(root, "a.txt"), "v1", "utf8");
    const store = new CheckpointStore({ rootDir: join(root, ".ckpt"), workspaceRoot: root });
    await store.capture("tool:write", ["a.txt"]);

    await writeFile(join(root, "a.txt"), "v2", "utf8");
    await store.restoreLatest();

    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("v1");
  });

  it("TC-P1-7-05: capture() handles workspace-internal symlink pointing inside", async () => {
    const root = await createTestDirectory("ckpt-symlink-in");
    await writeFile(join(root, "target.txt"), "target-content", "utf8");
    // Symlink inside workspace pointing to another file inside the workspace.
    await symlink("target.txt", join(root, "link.txt"));

    const store = new CheckpointStore({ rootDir: join(root, ".ckpt"), workspaceRoot: root });
    const manifest = await store.capture("tool:write", ["link.txt"]);

    expect(manifest?.files).toEqual([{ path: "link.txt", existed: true }]);
    expect(await readFile(join(root, ".ckpt", "1", "link.txt"), "utf8")).toBe("target-content");
  });
});
