import { describe, expect, it } from "vitest";
import { createTestDirectory, type ScriptedStep } from "@focuscode/testkit";
import type {
  AtomicDecisionResultV1,
  DecisionPort,
  DomainEventV1,
  FactPort,
  KernelCheckpointV1,
  VerificationReportV1,
  VerifyPort,
} from "@focuscode/contracts";
import { createLocalHarness } from "../src/index.js";

/**
 * Stub FactPort that records every interaction. Used to prove that
 * `createLocalHarness` wires an externally supplied fact store into the
 * FocusKernel instead of constructing the default FileFactStore.
 */
class RecordingFactPort implements FactPort {
  readonly calls: string[] = [];
  async append() {
    this.calls.push("append");
    return { firstSeq: 0, lastSeq: 0, events: [] as DomainEventV1[] };
  }
  async loadEvents(): Promise<DomainEventV1[]> {
    this.calls.push("loadEvents");
    return [];
  }
  async loadCheckpoint(): Promise<KernelCheckpointV1 | undefined> {
    this.calls.push("loadCheckpoint");
    return undefined;
  }
  async saveCheckpoint(): Promise<void> {
    this.calls.push("saveCheckpoint");
  }
}

/**
 * Stub VerifyPort that always returns PASS. Used to drive the kernel through
 * the VERIFYING → REVIEW_READY transition without depending on the default
 * RegisteredCommandVerifier (which has no registered commands in the test
 * fixture and therefore cannot produce a meaningful conclusion).
 */
class PassVerifier implements VerifyPort {
  readonly calls: string[] = [];
  async verify(): Promise<VerificationReportV1> {
    this.calls.push("verify");
    return {
      schemaVersion: "verification-report.v1",
      conclusion: "PASS",
      phase: "target",
      results: [],
      summary: "stub pass",
    };
  }
}

/**
 * Build a minimal AtomicDecisionResultV1 carrying a completion_candidate
 * decision. This is the smallest payload that drives the FocusKernel from
 * RUNNING → VERIFYING → REVIEW_READY, proving the injected decision port
 * (not the scripted model) shaped the outcome.
 */
function completionCandidateResult(): AtomicDecisionResultV1 {
  return {
    status: "complete",
    decision: {
      kind: "completion_candidate",
      summary: "stub completion",
      evidence: [],
      residualRisks: [],
    },
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    parserDiagnostics: [],
  };
}

describe("LocalHarness port injection", () => {
  it("accepts factStore, verifier, and decision overrides via LocalHarnessOptions", async () => {
    const repoRoot = await createTestDirectory("sdk-inject-options-repo");
    const stateDirectory = await createTestDirectory("sdk-inject-options-state");
    const factStore = new RecordingFactPort();
    const verifier = new PassVerifier();
    const decision: DecisionPort = {
      async decide() {
        return completionCandidateResult();
      },
    };

    const harness = await createLocalHarness({
      repoRoot,
      stateDirectory,
      approvalMode: "deny",
      model: { kind: "scripted", steps: [] as ScriptedStep[] },
      factStore,
      verifier,
      decision,
    });

    expect(harness).toBeDefined();
    // The harness should expose the injected fact store, not a FileFactStore.
    expect(harness.facts).toBe(factStore);
  });

  it("falls back to the default FileFactStore when factStore is omitted", async () => {
    const repoRoot = await createTestDirectory("sdk-inject-default-repo");
    const stateDirectory = await createTestDirectory("sdk-inject-default-state");
    const harness = await createLocalHarness({
      repoRoot,
      stateDirectory,
      model: { kind: "scripted", steps: [] as ScriptedStep[] },
    });
    // The default constructor name is FileFactStore; this proves the fallback
    // path still wires the bundled implementation when no override is given.
    expect(harness.facts.constructor.name).toBe("FileFactStore");
  });

  it("uses the injected decision port instead of building one from model.kind", async () => {
    const repoRoot = await createTestDirectory("sdk-inject-decision-repo");
    const stateDirectory = await createTestDirectory("sdk-inject-decision-state");
    let decideCalls = 0;
    const decision: DecisionPort = {
      async decide() {
        decideCalls++;
        return completionCandidateResult();
      },
    };
    // Inject PassVerifier so the kernel can transition VERIFYING → REVIEW_READY
    // without relying on the default RegisteredCommandVerifier (which has no
    // registered commands in this fixture).
    const verifier = new PassVerifier();
    const harness = await createLocalHarness({
      repoRoot,
      stateDirectory,
      model: { kind: "scripted", steps: [] as ScriptedStep[] },
      decision,
      verifier,
    });

    // Drive a no-op task through the kernel; the injected decision port
    // should be invoked, the scripted steps should never be consulted.
    const result = await harness.run({
      schemaVersion: "task-spec.v1",
      repoId: "test",
      baseRef: "HEAD",
      mode: "explore",
      objective: "stub",
      acceptanceCriteria: [{ id: "stub", description: "stub" }],
    });

    expect(decideCalls).toBeGreaterThan(0);
    // The injected decision returned a completion_candidate and the injected
    // verifier returned PASS, so the kernel should reach REVIEW_READY. This
    // proves the injected decision port shaped the outcome rather than the
    // scripted model.
    expect(result.checkpoint.state).toBe("REVIEW_READY");
  });
});
