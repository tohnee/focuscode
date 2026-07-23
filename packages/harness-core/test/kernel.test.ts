import { describe, expect, it } from "vitest";
import { type EffectContextV1, type EffectPort, type EffectReceiptV1 } from "@focuscode/contracts";
import {
  FakeEffectPort,
  InMemoryFactStore,
  ScriptedDecisionPort,
  StaticVerifier,
  fixtureExecution,
  fixtureModel,
  fixtureTask,
  fixtureTool,
} from "@focuscode/testkit";
import { FocusKernel, assertTransition } from "../src/index.js";

class GrantingEffectPort extends FakeEffectPort {
  override async submit(
    intents: Parameters<EffectPort["submit"]>[0],
    context: EffectContextV1,
  ): Promise<EffectReceiptV1[]> {
    const receipts = await super.submit(intents, context);
    return receipts.map((receipt) => ({
      ...receipt,
      grant: {
        schemaVersion: "capability-grant.v1" as const,
        grantId: receipt.grantId,
        taskId: context.execution.taskId,
        subject: {
          taskId: context.execution.taskId,
          workerId: context.workerId,
          modelCertificateId: context.model.certificateId,
        },
        capabilities: [{ name: "repo.read" }],
        constraints: [],
        expiresAt: "2026-07-19T01:00:00.000Z",
        fencingToken: "fixture-fence",
        policySnapshotDigest: context.execution.policySnapshot,
      },
    }));
  }
}

describe("FocusKernel", () => {
  it("executes decision -> effect -> verification and stops at REVIEW_READY", async () => {
    const facts = new InMemoryFactStore();
    const effects = new GrantingEffectPort();
    const tool = fixtureTool();
    const decision = new ScriptedDecisionPort([
      {
        kind: "tool_intent_template",
        intents: [
          {
            toolId: tool.id,
            arguments: { path: "src/value.ts" },
            expectedEffects: [
              { class: "read", resource: "src/value.ts", description: "Inspect value" },
            ],
            justification: "Need evidence",
          },
        ],
      },
      { kind: "completion_candidate", summary: "ready", evidence: [], residualRisks: [] },
    ]);
    const kernel = new FocusKernel({
      decision,
      effects,
      facts,
      verifier: new StaticVerifier("PASS", "PASS"),
      tools: [tool],
      workerId: "worker-1",
    });
    const result = await kernel.run({
      task: fixtureTask(),
      execution: fixtureExecution(),
      model: fixtureModel(),
    });
    expect(result.checkpoint.state).toBe("REVIEW_READY");
    expect(result.checkpoint.turn).toBe(2);
    expect(result.checkpoint.actionCount).toBe(1);
    expect(effects.submitted).toHaveLength(1);
    expect(result.verification?.conclusion).toBe("PASS");
    const kinds = result.events.map((event) => event.kind);
    expect(kinds).toContain("VerificationCompleted");
    expect(kinds).toContain("GrantIssued");
    expect(kinds).toContain("ActionStarted");
    // Crash-window-C ordering: ActionStarted is persisted BEFORE the effect is
    // dispatched (it carries no grantId yet); GrantIssued and EffectObserved
    // land only after the effect port returns.
    expect(kinds.indexOf("ActionStarted")).toBeLessThan(kinds.indexOf("GrantIssued"));
    expect(kinds.indexOf("GrantIssued")).toBeLessThan(kinds.indexOf("EffectObserved"));
    const actionStarted = result.events.find((event) => event.kind === "ActionStarted");
    expect(typeof (actionStarted?.payload as { actionId?: string })?.actionId).toBe("string");
    const grantIssued = result.events.find((event) => event.kind === "GrantIssued");
    const effectObserved = result.events.find((event) => event.kind === "EffectObserved");
    expect((grantIssued?.payload as { grant?: { grantId?: string } })?.grant?.grantId).toBe(
      (effectObserved?.payload as { receipt?: { grantId?: string } })?.receipt?.grantId,
    );

    const eventCount = result.events.length;
    const resumed = await kernel.run({
      task: fixtureTask(),
      execution: fixtureExecution(),
      model: fixtureModel(),
    });
    expect(resumed.events).toHaveLength(eventCount);
    const resumedKinds = resumed.events.map((event) => event.kind);
    expect(resumedKinds.filter((kind) => kind === "GrantIssued")).toHaveLength(1);
    expect(resumedKinds.filter((kind) => kind === "ActionStarted")).toHaveLength(1);
    expect(resumedKinds.filter((kind) => kind === "EffectObserved")).toHaveLength(1);
  });

  it("rejects a truncated turn with zero effects", async () => {
    const facts = new InMemoryFactStore();
    const effects = new FakeEffectPort();
    const kernel = new FocusKernel({
      decision: new ScriptedDecisionPort([
        { kind: "fault", status: "truncated", message: "connection closed" },
      ]),
      effects,
      facts,
      verifier: new StaticVerifier(),
      tools: [fixtureTool()],
      workerId: "worker-1",
    });
    const result = await kernel.run({
      task: fixtureTask(),
      execution: fixtureExecution("truncated-task"),
      model: fixtureModel(),
    });
    expect(result.checkpoint.state).toBe("BLOCKED");
    expect(effects.submitted).toEqual([]);
    expect(result.events.map((event) => event.kind)).not.toContain("ActionRequested");
  });

  it("does not convert a completion candidate into success when verification regresses", async () => {
    const kernel = new FocusKernel({
      decision: new ScriptedDecisionPort([
        { kind: "completion_candidate", summary: "claims done", evidence: [], residualRisks: [] },
      ]),
      effects: new FakeEffectPort(),
      facts: new InMemoryFactStore(),
      verifier: new StaticVerifier("PASS", "REGRESSION"),
      tools: [],
      workerId: "worker-1",
    });
    const result = await kernel.run({
      task: fixtureTask(),
      execution: fixtureExecution("regression-task"),
      model: fixtureModel(),
    });
    expect(result.checkpoint.state).toBe("BLOCKED");
    expect(result.verification?.conclusion).toBe("REGRESSION");
  });

  it("enforces state-machine transitions", () => {
    expect(() => assertTransition("CREATED", "PREFLIGHT")).not.toThrow();
    expect(() => assertTransition("CREATED", "ACCEPTED")).toThrow(/Invalid kernel transition/);
  });

  it("fails closed when the model certificate is expired", async () => {
    const facts = new InMemoryFactStore();
    const kernel = new FocusKernel({
      decision: new ScriptedDecisionPort([]),
      effects: new FakeEffectPort(),
      facts,
      verifier: new StaticVerifier(),
      tools: [],
      workerId: "worker-1",
      now: () => new Date("2026-07-20T00:00:00.000Z"),
    });
    const expired = kernel.run({
      task: fixtureTask(),
      execution: fixtureExecution("expired-certificate"),
      model: { ...fixtureModel(), expiresAt: "2026-07-19T01:00:00.000Z" },
    });
    await expect(expired).rejects.toThrow(/expired/);
    // Fail closed happens before any fact is written.
    expect(facts.events).toHaveLength(0);
    // A certificate without expiry or with a future expiry still validates.
    await expect(
      kernel.run({
        task: fixtureTask(),
        execution: fixtureExecution("expired-certificate"),
        model: { ...fixtureModel(), expiresAt: "2026-07-21T00:00:00.000Z" },
      }),
    ).resolves.toBeTruthy();
  });
});
