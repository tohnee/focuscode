import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestDirectory, type ScriptedStep } from "@focuscode/testkit";
import { createCodingAgent, createLocalHarness } from "../src/index.js";

describe("LocalHarness end-to-end", () => {
  it("constructs the conversational coding-agent SDK without global state", async () => {
    const repoRoot = await createTestDirectory("sdk-agent");
    const created = await createCodingAgent({
      cwd: repoRoot,
      provider: "custom",
      model: "fixture",
      baseUrl: "http://127.0.0.1:1/v1",
      approval: "deny",
      sandbox: { kind: "host" },
      persistentSession: false,
      projectTrusted: false,
    });
    expect(await created.agent.status()).toMatchObject({
      provider: "custom",
      model: "fixture",
      approval: "deny",
    });
    expect(created.extensions.list()).toEqual([]);
  });

  it("repairs a repository through the canonical decision/effect/verification loop", async () => {
    const repoRoot = await createTestDirectory("sdk-repo");
    const stateDirectory = await createTestDirectory("sdk-state");
    await mkdir(join(repoRoot, "src"));
    await mkdir(join(repoRoot, "test"));
    await mkdir(join(repoRoot, ".focuscode"));
    await writeFile(join(repoRoot, "package.json"), '{"name":"e2e","type":"module"}\n');
    await writeFile(
      join(repoRoot, "src", "math.js"),
      "export function add(a, b) { return a - b; }\n",
    );
    await writeFile(
      join(repoRoot, "test", "math.test.js"),
      [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'import { add } from "../src/math.js";',
        'test("add", () => assert.equal(add(2, 3), 5));',
        "",
      ].join("\n"),
    );
    await writeFile(
      join(repoRoot, ".focuscode", "config.json"),
      JSON.stringify({
        schemaVersion: "focuscode-repo.v1",
        protectedPaths: [".git", ".focuscode"],
        commands: [{ id: "test", argv: [process.execPath, "--test"], timeoutMs: 30_000 }],
        verificationCommandIds: ["test"],
      }),
    );
    const steps: ScriptedStep[] = [
      {
        kind: "tool_intent_template",
        intents: [
          {
            toolId: "apply_edit_ir",
            arguments: {
              path: "src/math.js",
              edits: [{ search: "a - b", replace: "a + b", expectedOccurrences: 1 }],
            },
            expectedEffects: [
              { class: "file_write", resource: "src/math.js", description: "Fix operator" },
            ],
            justification: "Unique one-line repair",
          },
        ],
      },
      { kind: "completion_candidate", summary: "fixed", evidence: [], residualRisks: [] },
    ];
    const harness = await createLocalHarness({
      repoRoot,
      stateDirectory,
      approvalMode: "auto-safe",
      trustRepoConfig: true,
      model: { kind: "scripted", steps },
    });
    const result = await harness.run(
      {
        schemaVersion: "task-spec.v1",
        repoId: repoRoot,
        baseRef: "WORKTREE",
        mode: "change",
        objective: "Fix add",
        acceptanceCriteria: [{ id: "test", description: "Tests pass" }],
      },
      { taskId: "sdk-e2e" },
    );
    expect(result.checkpoint.state).toBe("REVIEW_READY");
    expect(result.verification?.conclusion).toBe("PASS");
    expect(await readFile(join(repoRoot, "src", "math.js"), "utf8")).toContain("a + b");
    expect(harness.actions.ledgerSnapshot().changedFiles).toEqual(["src/math.js"]);
    expect((await harness.facts.loadEvents("sdk-e2e")).map((event) => event.kind)).toContain(
      "EffectObserved",
    );
  });
});

describe("createCodingAgent enterprise extension policy", () => {
  async function installFixtureExtension(
    extensionDirectory: string,
    options: { signed: boolean; permissions: string[] },
  ): Promise<void> {
    const extensionRoot = join(extensionDirectory, "node_modules", "@fixture", "net-tools");
    await mkdir(extensionRoot, { recursive: true });
    await writeFile(join(extensionRoot, "index.mjs"), "export default () => undefined;\n");
    await writeFile(
      join(extensionDirectory, "focuscode-lock.json"),
      JSON.stringify({
        schemaVersion: "focuscode-extension-lock.v1",
        extensions: {
          "@fixture/net-tools": {
            name: "@fixture/net-tools",
            version: "1.0.0",
            path: extensionRoot,
            entryPath: join(extensionRoot, "index.mjs"),
            signed: options.signed,
            manifest: {
              apiVersion: "focuscode.extension.v1",
              entry: "./index.mjs",
              permissions: options.permissions,
            },
          },
        },
      }),
    );
  }

  function enterpriseOptions(
    repoRoot: string,
    extensionDirectory: string,
  ): Parameters<typeof createCodingAgent>[0] {
    return {
      cwd: repoRoot,
      provider: "custom",
      model: "fixture",
      baseUrl: "http://127.0.0.1:1/v1",
      approval: "deny",
      sandbox: { kind: "docker", image: `node@sha256:${"a".repeat(64)}` },
      enterprise: { enabled: true, allowedExtensions: ["@fixture/net-tools"] },
      extensionDirectory,
      persistentSession: false,
      projectTrusted: false,
      globalConfigPath: join(repoRoot, "missing-global-config.json"),
      projectConfigPath: join(repoRoot, "missing-project-config.json"),
      shellExecutor: {
        kind: "docker",
        execute: async () => ({
          exitCode: 0,
          stdout: "",
          stderr: "",
          timedOut: false,
          durationMs: 0,
        }),
      },
    };
  }

  it("rejects installed extensions requesting network or shell permissions", async () => {
    const repoRoot = await createTestDirectory("sdk-ent-repo");
    const extensionDirectory = await createTestDirectory("sdk-ent-ext");
    await installFixtureExtension(extensionDirectory, {
      signed: true,
      permissions: ["tools", "network"],
    });
    await expect(
      createCodingAgent(enterpriseOptions(repoRoot, extensionDirectory)),
    ).rejects.toThrow(/network or shell permissions/);
  });

  it("rejects unsigned installed extensions", async () => {
    const repoRoot = await createTestDirectory("sdk-ent-repo-unsigned");
    const extensionDirectory = await createTestDirectory("sdk-ent-ext-unsigned");
    await installFixtureExtension(extensionDirectory, {
      signed: false,
      permissions: ["tools"],
    });
    await expect(
      createCodingAgent(enterpriseOptions(repoRoot, extensionDirectory)),
    ).rejects.toThrow(/Unsigned extensions are disabled/);
  });
});
