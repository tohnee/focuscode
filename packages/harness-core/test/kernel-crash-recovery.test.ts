import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AtomicDecisionResultV1,
  CertifiedModelRefV1,
  DecisionPort,
  EffectPort,
  EffectReceiptV1,
  TurnInputV1,
} from "@focuscode/contracts";
import {
  FakeEffectPort,
  ScriptedDecisionPort,
  StaticVerifier,
  fixtureExecution,
  fixtureModel,
  fixtureTask,
  fixtureTool,
} from "@focuscode/testkit";
import { FocusKernel } from "../src/index.js";
// @focuscode/persistence is not a declared harness-core dependency (the kernel must
// stay storage-agnostic), so the test reaches the built adapter by relative path.
import { FileFactStore } from "../../persistence/dist/index.js";

/** Simulates a worker that dies mid-run: the first turn succeeds, the next decide() crashes. */
class CrashAfterFirstDecision implements DecisionPort {
  private calls = 0;

  constructor(private readonly inner: DecisionPort) {}

  async decide(input: TurnInputV1, model: CertifiedModelRefV1): Promise<AtomicDecisionResultV1> {
    this.calls += 1;
    if (this.calls > 1) throw new Error("simulated worker crash");
    return this.inner.decide(input, model);
  }
}

/**
 * Simulates crash window C: ActionStarted is already durable when the worker
 * dies inside the effect dispatch, before any receipt can be recorded.
 */
class CrashOnSubmitEffectPort implements EffectPort {
  async submit(): Promise<EffectReceiptV1[]> {
    throw new Error("simulated effect crash");
  }
}

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function tempFactDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "focus-kernel-crash-"));
  directories.push(directory);
  return directory;
}

describe("FocusKernel crash recovery across instances", () => {
  it("resumes a crashed RUNNING task from a new kernel and FileFactStore without re-executing effects", async () => {
    const directory = await tempFactDirectory();
    const tool = fixtureTool();
    const crashedEffects = new FakeEffectPort();
    const crashedKernel = new FocusKernel({
      decision: new CrashAfterFirstDecision(
        new ScriptedDecisionPort([
          {
            kind: "tool_intent_template",
            intents: [
              {
                actionId: "action-crash-1",
                toolId: tool.id,
                arguments: { path: "src/value.ts" },
                expectedEffects: [
                  { class: "read", resource: "src/value.ts", description: "Inspect value" },
                ],
                justification: "Need evidence",
              },
            ],
          },
        ]),
      ),
      effects: crashedEffects,
      facts: new FileFactStore(directory),
      verifier: new StaticVerifier("PASS", "PASS"),
      tools: [tool],
      workerId: "worker-crash",
    });
    const execution = fixtureExecution("crash-recovery-task");
    await expect(
      crashedKernel.run({ task: fixtureTask(), execution, model: fixtureModel() }),
    ).rejects.toThrow(/simulated worker crash/);
    expect(crashedEffects.submitted).toEqual(["action-crash-1"]);

    // The facts left behind by the dead worker are visible to a fresh store instance.
    const facts = new FileFactStore(directory);
    const orphaned = await facts.loadEvents(execution.taskId);
    expect(orphaned.map((event) => event.kind)).toContain("EffectObserved");
    const checkpoint = await facts.loadCheckpoint(execution.taskId);
    expect(checkpoint).toMatchObject({ state: "RUNNING", turn: 1, actionCount: 1 });

    // A new worker process (new kernel, new fact store, new effect port) resumes the task.
    const resumedEffects = new FakeEffectPort();
    const resumedKernel = new FocusKernel({
      decision: new ScriptedDecisionPort([
        { kind: "completion_candidate", summary: "ready", evidence: [], residualRisks: [] },
      ]),
      effects: resumedEffects,
      facts,
      verifier: new StaticVerifier("PASS", "PASS"),
      tools: [tool],
      workerId: "worker-resume",
    });
    const result = await resumedKernel.run({
      task: fixtureTask(),
      execution,
      model: fixtureModel(),
    });
    expect(result.checkpoint).toMatchObject({
      state: "REVIEW_READY",
      turn: 2,
      actionCount: 1,
    });
    expect(result.verification?.conclusion).toBe("PASS");
    // The effect applied before the crash is not submitted again.
    expect(resumedEffects.submitted).toEqual([]);
    expect(result.events.filter((event) => event.kind === "EffectObserved")).toHaveLength(1);
    const persisted = await new FileFactStore(directory).loadCheckpoint(execution.taskId);
    expect(persisted).toMatchObject({ state: "REVIEW_READY", turn: 2, actionCount: 1 });
  });

  it("treats a quiescent task as a no-op when resumed by a new instance", async () => {
    const directory = await tempFactDirectory();
    const execution = fixtureExecution("crash-quiescent-task");
    const firstEffects = new FakeEffectPort();
    const firstKernel = new FocusKernel({
      decision: new ScriptedDecisionPort([
        { kind: "completion_candidate", summary: "done", evidence: [], residualRisks: [] },
      ]),
      effects: firstEffects,
      facts: new FileFactStore(directory),
      verifier: new StaticVerifier("PASS", "PASS"),
      tools: [],
      workerId: "worker-1",
    });
    const first = await firstKernel.run({
      task: fixtureTask(),
      execution,
      model: fixtureModel(),
    });
    expect(first.checkpoint.state).toBe("REVIEW_READY");

    const resumedEffects = new FakeEffectPort();
    const resumedKernel = new FocusKernel({
      decision: new ScriptedDecisionPort([]),
      effects: resumedEffects,
      facts: new FileFactStore(directory),
      verifier: new StaticVerifier("PASS", "PASS"),
      tools: [],
      workerId: "worker-2",
    });
    const resumed = await resumedKernel.run({
      task: fixtureTask(),
      execution,
      model: fixtureModel(),
    });
    expect(resumed.checkpoint.state).toBe("REVIEW_READY");
    expect(resumed.events).toHaveLength(first.events.length);
    expect(resumedEffects.submitted).toEqual([]);
  });

  it("rebuilds a checkpoint that is newer than the event log instead of wedging", async () => {
    const directory = await tempFactDirectory();
    const tool = fixtureTool();
    const execution = fixtureExecution("crash-window-b-task");
    // First run: turn 1 completes (effect applied and recorded), then the
    // worker crashes at the next decide().
    const crashedKernel = new FocusKernel({
      decision: new CrashAfterFirstDecision(
        new ScriptedDecisionPort([
          {
            kind: "tool_intent_template",
            intents: [
              {
                actionId: "action-b-1",
                toolId: tool.id,
                arguments: { path: "src/value.ts" },
                expectedEffects: [
                  { class: "read", resource: "src/value.ts", description: "Inspect value" },
                ],
                justification: "Need evidence",
              },
            ],
          },
        ]),
      ),
      effects: new FakeEffectPort(),
      facts: new FileFactStore(directory),
      verifier: new StaticVerifier("PASS", "PASS"),
      tools: [tool],
      workerId: "worker-crash",
    });
    await expect(
      crashedKernel.run({ task: fixtureTask(), execution, model: fixtureModel() }),
    ).rejects.toThrow(/simulated worker crash/);

    // Crash window B: the persisted checkpoint claims events that never landed.
    // Resuming against it would wedge every append on a VersionConflictError.
    const facts = new FileFactStore(directory);
    const eventCount = (await facts.loadEvents(execution.taskId)).length;
    const checkpoint = await facts.loadCheckpoint(execution.taskId);
    expect(checkpoint).toBeDefined();
    await facts.saveCheckpoint({ ...checkpoint!, eventVersion: eventCount + 5 });

    const resumedEffects = new FakeEffectPort();
    const resumedKernel = new FocusKernel({
      decision: new ScriptedDecisionPort([
        { kind: "completion_candidate", summary: "ready", evidence: [], residualRisks: [] },
      ]),
      effects: resumedEffects,
      facts,
      verifier: new StaticVerifier("PASS", "PASS"),
      tools: [tool],
      workerId: "worker-resume",
    });
    const result = await resumedKernel.run({
      task: fixtureTask(),
      execution,
      model: fixtureModel(),
    });
    // The uncommitted checkpoint is discarded and rebuilt from the events.
    expect(result.checkpoint.state).toBe("REVIEW_READY");
    expect(result.checkpoint.actionCount).toBe(1);
    expect(result.checkpoint.eventVersion).toBe(result.events.at(-1)?.seq);
    expect(resumedEffects.submitted).toEqual([]);
    expect(result.events.filter((event) => event.kind === "EffectObserved")).toHaveLength(1);
  });

  it("marks an action UNKNOWN when the worker crashed between dispatch and receipt", async () => {
    const directory = await tempFactDirectory();
    const tool = fixtureTool();
    const execution = fixtureExecution("crash-window-c-task");
    const crashedKernel = new FocusKernel({
      decision: new ScriptedDecisionPort([
        {
          kind: "tool_intent_template",
          intents: [
            {
              actionId: "action-c-1",
              toolId: tool.id,
              arguments: { path: "src/value.ts" },
              expectedEffects: [
                { class: "read", resource: "src/value.ts", description: "Inspect value" },
              ],
              justification: "Need evidence",
            },
          ],
        },
      ]),
      effects: new CrashOnSubmitEffectPort(),
      facts: new FileFactStore(directory),
      verifier: new StaticVerifier("PASS", "PASS"),
      tools: [tool],
      workerId: "worker-crash",
    });
    await expect(
      crashedKernel.run({ task: fixtureTask(), execution, model: fixtureModel() }),
    ).rejects.toThrow(/simulated effect crash/);

    // ActionStarted landed before the crash; no receipt was ever recorded.
    const facts = new FileFactStore(directory);
    const orphanedKinds = (await facts.loadEvents(execution.taskId)).map((event) => event.kind);
    expect(orphanedKinds).toContain("ActionStarted");
    expect(orphanedKinds).not.toContain("EffectObserved");

    const resumedEffects = new FakeEffectPort();
    const resumedKernel = new FocusKernel({
      decision: new ScriptedDecisionPort([
        { kind: "completion_candidate", summary: "ready", evidence: [], residualRisks: [] },
      ]),
      effects: resumedEffects,
      facts,
      verifier: new StaticVerifier("PASS", "PASS"),
      tools: [tool],
      workerId: "worker-resume",
    });
    const result = await resumedKernel.run({
      task: fixtureTask(),
      execution,
      model: fixtureModel(),
    });
    // Exactly one EffectUnknown marks the orphaned action; it is not re-executed.
    const unknowns = result.events.filter((event) => event.kind === "EffectUnknown");
    expect(unknowns).toHaveLength(1);
    expect(unknowns[0]?.payload).toEqual({
      actionId: "action-c-1",
      reason: "started without receipt",
    });
    expect(resumedEffects.submitted).toEqual([]);
    expect(result.checkpoint.actionCount).toBe(0);

    // Resuming again is idempotent: no second EffectUnknown is appended.
    const secondEffects = new FakeEffectPort();
    const secondKernel = new FocusKernel({
      decision: new ScriptedDecisionPort([]),
      effects: secondEffects,
      facts,
      verifier: new StaticVerifier("PASS", "PASS"),
      tools: [tool],
      workerId: "worker-resume-2",
    });
    const second = await secondKernel.run({
      task: fixtureTask(),
      execution,
      model: fixtureModel(),
    });
    expect(second.events.filter((event) => event.kind === "EffectUnknown")).toHaveLength(1);
    expect(secondEffects.submitted).toEqual([]);
  });
});
