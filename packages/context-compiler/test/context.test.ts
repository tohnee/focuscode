import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelPackV1, TurnInputV1 } from "@focuscode/contracts";
import {
  createTestDirectory,
  fixtureExecution,
  fixtureTask,
  fixtureTool,
} from "@focuscode/testkit";
import { ContextCompiler, buildRepoProfile } from "../src/index.js";

const pack: ModelPackV1 = {
  schemaVersion: "model-pack.v1",
  id: "context-test",
  family: "fixture",
  revision: "1",
  systemPrompt: "fixture",
  responseFormat: "json",
  maxToolIntentsPerTurn: 2,
  contextEnvelope: { maxInputChars: 50_000, stablePrefixRatio: 0.5, maxToolOutputChars: 2_000 },
  recovery: { deterministicRepair: true, modelRetries: 0 },
};

describe("ContextCompiler", () => {
  it("keeps the stable prefix digest independent of dynamic task state", async () => {
    const root = await createTestDirectory("context");
    await mkdir(join(root, ".focuscode"));
    await writeFile(join(root, "package.json"), '{"name":"fixture"}\n');
    await writeFile(
      join(root, ".focuscode", "config.json"),
      JSON.stringify({
        schemaVersion: "focuscode-repo.v1",
        protectedPaths: [".git"],
        commands: [],
        verificationCommandIds: [],
      }),
    );
    const profile = await buildRepoProfile(root);
    const compiler = new ContextCompiler(profile, () => new Date("2026-07-19T00:00:00.000Z"));
    const first = compiler.compile(turnInput("first objective", 1), pack);
    const second = compiler.compile(turnInput("second objective", 2), pack);
    expect(first.stablePrefixDigest).toBe(second.stablePrefixDigest);
    expect(first.fullContextDigest).not.toBe(second.fullContextDigest);
    expect(first.frames.map((frame) => frame.kind)).toEqual([
      "harness.contract",
      "policy.snapshot",
      "tools.schemas",
      "repo.profile",
      "task",
      "kernel.state",
      "recent.effects",
      "recent.events",
    ]);
  });

  it("drops low-priority dynamic frames before policy and harness frames", async () => {
    const root = await createTestDirectory("context-budget");
    await writeFile(join(root, "package.json"), '{"name":"fixture"}\n');
    const compiler = new ContextCompiler(
      await buildRepoProfile(root),
      () => new Date("2026-07-19T00:00:00.000Z"),
    );
    const constrained = {
      ...pack,
      contextEnvelope: { ...pack.contextEnvelope, maxInputChars: 2_500 },
    };
    const compiled = compiler.compile(turnInput("x".repeat(5_000), 1), constrained);
    expect(compiled.frames.map((frame) => frame.kind)).toContain("harness.contract");
    expect(compiled.frames.map((frame) => frame.kind)).toContain("policy.snapshot");
    expect(compiled.droppedFrameKinds.length).toBeGreaterThan(0);
  });
});

function turnInput(objective: string, turn: number): TurnInputV1 {
  return {
    schemaVersion: "turn-input.v1",
    task: fixtureTask({ objective }),
    execution: fixtureExecution("context-task"),
    state: "RUNNING",
    turn,
    publicPlan: [],
    tools: [fixtureTool()],
    recentEvents: [],
    recentEffects: [],
  };
}
