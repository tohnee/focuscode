import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PolicyEngine } from "@focuscode/action-domain";
import { fixtureExecution, fixtureModel, createTestDirectory } from "@focuscode/testkit";
import {
  LocalActionRuntime,
  SafeCommandRunner,
  WorkspaceGuard,
  createLocalToolRegistry,
} from "../src/index.js";

describe("local Action Runtime", () => {
  it("rejects traversal and symlink escape", async () => {
    const root = await createTestDirectory("workspace");
    const outside = await createTestDirectory("outside");
    await writeFile(join(outside, "secret.txt"), "secret", "utf8");
    await symlink(outside, join(root, "escape"));
    const workspace = await WorkspaceGuard.create(root);
    await expect(workspace.resolvePath("../outside/secret.txt")).rejects.toThrow(/escapes/);
    await expect(workspace.resolvePath("escape/secret.txt")).rejects.toThrow(/outside/);
  });

  it("requires approval for writes and never mutates on denial", async () => {
    const root = await createTestDirectory("deny-write");
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "value.js"), "export const value = 1;\n", "utf8");
    const { runtime, registry } = await runtimeFixture(root, false, false);
    const spec = registry.get("apply_edit_ir")!.spec;
    const receipt = await runtime.submit(
      [
        {
          schemaVersion: "action-intent.v1",
          actionId: "write-denied",
          taskId: "fixture-task",
          tool: { id: spec.id, version: spec.version, schemaDigest: spec.schemaDigest },
          arguments: {
            path: "src/value.js",
            edits: [{ search: "value = 1", replace: "value = 2", expectedOccurrences: 1 }],
          },
          expectedEffects: [
            { class: "file_write", resource: "src/value.js", description: "Update value" },
          ],
          justification: "fixture",
        },
      ],
      { execution: fixtureExecution(), model: fixtureModel(), workerId: "test" },
    );
    expect(receipt[0]?.status).toBe("rejected");
    expect(receipt[0]?.grant).toBeUndefined();
    expect(await readFile(join(root, "src", "value.js"), "utf8")).toContain("value = 1");
  });

  it("applies an explicitly auto-granted bounded edit exactly once", async () => {
    const root = await createTestDirectory("apply-write");
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "value.js"), "export const value = 1;\n", "utf8");
    const { runtime, registry } = await runtimeFixture(root, true, false);
    const spec = registry.get("apply_edit_ir")!.spec;
    const intent = {
      schemaVersion: "action-intent.v1" as const,
      actionId: "write-once",
      taskId: "fixture-task",
      tool: { id: spec.id, version: spec.version, schemaDigest: spec.schemaDigest },
      arguments: {
        path: "src/value.js",
        edits: [{ search: "value = 1", replace: "value = 2", expectedOccurrences: 1 }],
      },
      expectedEffects: [
        { class: "file_write" as const, resource: "src/value.js", description: "Update value" },
      ],
      justification: "fixture",
    };
    const context = { execution: fixtureExecution(), model: fixtureModel(), workerId: "test" };
    const first = await runtime.submit([intent], context);
    const second = await runtime.submit([intent], context);
    expect(first[0]?.status).toBe("applied");
    expect(first[0]?.grant?.grantId).toBe(first[0]?.grantId);
    expect(first[0]?.grant?.capabilities).toEqual(
      spec.requiredCapabilities.map((name) => ({ name })),
    );
    expect(second).toEqual(first);
    expect(runtime.ledgerSnapshot().changedFiles).toEqual(["src/value.js"]);
    expect(await readFile(join(root, "src", "value.js"), "utf8")).toContain("value = 2");
  });

  it("exposes bounded read tools and argv-only registered commands", async () => {
    const root = await createTestDirectory("read-tools");
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "value.js"), "export const needle = 7;\n", "utf8");
    const workspace = await WorkspaceGuard.create(root);
    const runner = new SafeCommandRunner(
      [{ id: "echo", argv: [process.execPath, "-e", "process.stdout.write('ok')"] }],
      { cwd: root },
    );
    const registry = createLocalToolRegistry(workspace, runner);
    const tree = await registry.get("repo_tree")!.execute({ path: ".", maxDepth: 3 });
    expect(JSON.stringify(tree.output)).toContain("src/value.js");
    const search = await registry.get("search_text")!.execute({ query: "needle", path: "." });
    expect(JSON.stringify(search.output)).toContain("src/value.js");
    const read = await registry
      .get("read_file_range")!
      .execute({ path: "src/value.js", startLine: 1, endLine: 2 });
    expect(JSON.stringify(read.output)).toContain("needle");
    const command = await registry.get("run_registered_command")!.execute({ commandId: "echo" });
    expect(JSON.stringify(command.output)).toContain("ok");
    await expect(runner.run("not-registered")).rejects.toThrow(/not registered/);
  });
});

async function runtimeFixture(root: string, autoWrites: boolean, approval: boolean) {
  const workspace = await WorkspaceGuard.create(root);
  const runner = new SafeCommandRunner([], { cwd: root });
  const registry = createLocalToolRegistry(workspace, runner);
  const runtime = new LocalActionRuntime(
    registry,
    new PolicyEngine({
      protectedPaths: [".git", ".env"],
      maxChangedFiles: 10,
      maxChangedLines: 100,
      maxRiskScore: 50,
      allowNetwork: false,
      allowSecrets: false,
      autoGrantRegisteredCommands: false,
      autoGrantSafeWrites: autoWrites,
    }),
    {
      async request() {
        return approval;
      },
    },
  );
  return { runtime, registry };
}
