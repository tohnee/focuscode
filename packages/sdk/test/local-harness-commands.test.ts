import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestDirectory, type ScriptedStep } from "@focuscode/testkit";
import { createLocalHarness } from "../src/index.js";

/**
 * Regression: repo-controlled commands (the repo's own .focuscode/config.json)
 * must not be registered for execution unless trustRepoConfig is set. An
 * untrusted repo can ship arbitrary command argv that auto-safe mode would
 * otherwise auto-grant and run with the user's privileges.
 */

interface CommandFixture {
  repoRoot: string;
  stateDirectory: string;
}

async function repoWithMarkerCommand(marker: string): Promise<CommandFixture> {
  const repoRoot = await createTestDirectory(`sdk-cmd-${marker}`);
  const stateDirectory = await createTestDirectory(`sdk-cmd-state-${marker}`);
  await mkdir(join(repoRoot, ".focuscode"), { recursive: true });
  const markerPath = join(repoRoot, "PWNED");
  await writeFile(
    join(repoRoot, ".focuscode", "config.json"),
    JSON.stringify({
      schemaVersion: "focuscode-repo.v1",
      protectedPaths: [".git", ".focuscode"],
      commands: [
        {
          id: "marker-command",
          argv: [
            process.execPath,
            "-e",
            `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "pwned")`,
          ],
          timeoutMs: 30_000,
        },
      ],
      verificationCommandIds: ["marker-command"],
    }),
  );
  return { repoRoot, stateDirectory };
}

const runCommandStep: ScriptedStep = {
  kind: "tool_intent_template",
  intents: [
    {
      toolId: "run_registered_command",
      arguments: { commandId: "marker-command" },
      expectedEffects: [
        { class: "command", resource: "marker-command", description: "Run repo command" },
      ],
      justification: "fixture",
    },
  ],
};

const completionStep: ScriptedStep = {
  kind: "completion_candidate",
  summary: "done",
  evidence: [],
  residualRisks: [],
};

function task(repoRoot: string) {
  return {
    schemaVersion: "task-spec.v1" as const,
    repoId: repoRoot,
    baseRef: "WORKTREE",
    mode: "change" as const,
    objective: "Run the marker command",
    acceptanceCriteria: [] as { id: string; description: string }[],
  };
}

async function receiptStatuses(
  harness: Awaited<ReturnType<typeof createLocalHarness>>,
  taskId: string,
) {
  const events = await harness.facts.loadEvents(taskId);
  return events
    .filter((event) => event.kind === "EffectObserved")
    .map((event) => {
      const payload = event.payload as { receipt?: { status?: string } } | undefined;
      return payload?.receipt?.status;
    });
}

describe("createLocalHarness command registration", () => {
  it("does not execute repo-controlled commands without trustRepoConfig (auto-safe)", async () => {
    const { repoRoot, stateDirectory } = await repoWithMarkerCommand("untrusted");
    const harness = await createLocalHarness({
      repoRoot,
      stateDirectory,
      approvalMode: "auto-safe",
      model: { kind: "scripted", steps: [runCommandStep, completionStep] },
    });
    await harness.run(task(repoRoot), { taskId: "sdk-cmd-untrusted" });
    // The repo-shipped command must never have run.
    expect(existsSync(join(repoRoot, "PWNED"))).toBe(false);
    expect(await receiptStatuses(harness, "sdk-cmd-untrusted")).toEqual(["rejected"]);
  });

  it("executes repo-controlled commands when trustRepoConfig is set (auto-safe)", async () => {
    const { repoRoot, stateDirectory } = await repoWithMarkerCommand("trusted");
    const harness = await createLocalHarness({
      repoRoot,
      stateDirectory,
      approvalMode: "auto-safe",
      trustRepoConfig: true,
      model: { kind: "scripted", steps: [runCommandStep, completionStep] },
    });
    await harness.run(task(repoRoot), { taskId: "sdk-cmd-trusted" });
    expect(existsSync(join(repoRoot, "PWNED"))).toBe(true);
    expect(await receiptStatuses(harness, "sdk-cmd-trusted")).toEqual(["applied"]);
  });

  it("rejects repo commands at the tool layer in default deny mode even when trusted", async () => {
    // trustRepoConfig registers the command for the verifier (documented), but
    // the run_registered_command tool must still be denied without auto-safe.
    const { repoRoot, stateDirectory } = await repoWithMarkerCommand("deny-mode");
    const harness = await createLocalHarness({
      repoRoot,
      stateDirectory,
      approvalMode: "deny",
      trustRepoConfig: true,
      model: { kind: "scripted", steps: [runCommandStep, completionStep] },
    });
    await harness.run(task(repoRoot), { taskId: "sdk-cmd-deny" });
    expect(await receiptStatuses(harness, "sdk-cmd-deny")).toEqual(["rejected"]);
  });
});
