import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SafeCommandRunner, type RegisteredCommand } from "@focuscode/action-backends";
import { createTestDirectory } from "@focuscode/testkit";
import { RegisteredCommandVerifier } from "../src/index.js";

/**
 * P2-3: Comprehensive coverage for RegisteredCommandVerifier (review §9.5 gap #5).
 *
 * The existing test file covers only 2 paths (BASELINE_FAIL→PASS and PARTIAL).
 * This file covers the remaining conclusions and branches:
 *   - REGRESSION (new failure in target, or different exit code)
 *   - BASELINE_FAIL via hadSameFailures (same failure in baseline and target)
 *   - BLOCKED (runner throws, exitCode null)
 *   - Mixed pass/fail results
 *   - summarize() for every conclusion
 *   - Multiple commands with independent pass/fail
 */

/** A command that exits 0. */
const passCommand = (id: string): RegisteredCommand => ({
  id,
  argv: [process.execPath, "-e", "process.exit(0)"],
});

/** A command that exits with the given code. */
const failCommand = (id: string, code: number): RegisteredCommand => ({
  id,
  argv: [process.execPath, "-e", `process.exit(${String(code)})`],
});

/** A command that references a non-existent binary (spawn ENOENT → error). */
const missingBinaryCommand = (id: string): RegisteredCommand => ({
  id,
  argv: ["/definitely/not/a/real/binary/xyz", "--flag"],
});

describe("RegisteredCommandVerifier — REGRESSION conclusion", () => {
  it("reports REGRESSION when target introduces a new failure not in baseline", async () => {
    const root = await createTestDirectory("verifier-regression-new");
    // Baseline: both pass.
    const runner = new SafeCommandRunner([passCommand("a"), passCommand("b")], { cwd: root });
    const verifier = new RegisteredCommandVerifier(runner, ["a", "b"]);
    const baseline = await verifier.verify({ taskId: "t", phase: "baseline" });
    expect(baseline.conclusion).toBe("PASS");

    // Target: "b" now fails — new failure.
    const runner2 = new SafeCommandRunner([passCommand("a"), failCommand("b", 1)], { cwd: root });
    const verifier2 = new RegisteredCommandVerifier(runner2, ["a", "b"]);
    const target = await verifier2.verify({
      taskId: "t",
      phase: "target",
      baseline,
    });
    expect(target.conclusion).toBe("REGRESSION");
    expect(target.summary).toBe(
      "Target verification introduced or changed a deterministic failure.",
    );
  });

  it("reports REGRESSION when target changes the exit code of an existing failure", async () => {
    const root = await createTestDirectory("verifier-regression-code");
    // Baseline: "a" fails with exit 1.
    const runner = new SafeCommandRunner([failCommand("a", 1)], { cwd: root });
    const verifier = new RegisteredCommandVerifier(runner, ["a"]);
    const baseline = await verifier.verify({ taskId: "t", phase: "baseline" });
    expect(baseline.conclusion).toBe("BASELINE_FAIL");

    // Target: "a" fails with exit 2 — different exit code.
    const runner2 = new SafeCommandRunner([failCommand("a", 2)], { cwd: root });
    const verifier2 = new RegisteredCommandVerifier(runner2, ["a"]);
    const target = await verifier2.verify({
      taskId: "t",
      phase: "target",
      baseline,
    });
    expect(target.conclusion).toBe("REGRESSION");
  });
});

describe("RegisteredCommandVerifier — BASELINE_FAIL via hadSameFailures", () => {
  it("reports BASELINE_FAIL when target has the same failures as baseline", async () => {
    const root = await createTestDirectory("verifier-same-failure");
    const runner = new SafeCommandRunner([failCommand("a", 1), passCommand("b")], { cwd: root });
    const verifier = new RegisteredCommandVerifier(runner, ["a", "b"]);
    const baseline = await verifier.verify({ taskId: "t", phase: "baseline" });
    expect(baseline.conclusion).toBe("BASELINE_FAIL");

    // Target: "a" still fails with exit 1 (same failure), "b" still passes.
    const target = await verifier.verify({
      taskId: "t",
      phase: "target",
      baseline,
    });
    expect(target.conclusion).toBe("BASELINE_FAIL");
    expect(target.summary).toBe(
      "The observed failure was already present in the baseline or remains equivalent.",
    );
  });

  it("reports BASELINE_FAIL when target has a subset of baseline failures", async () => {
    const root = await createTestDirectory("verifier-subset-failure");
    // Baseline: both "a" and "b" fail.
    const runner = new SafeCommandRunner([failCommand("a", 1), failCommand("b", 1)], { cwd: root });
    const verifier = new RegisteredCommandVerifier(runner, ["a", "b"]);
    const baseline = await verifier.verify({ taskId: "t", phase: "baseline" });
    expect(baseline.conclusion).toBe("BASELINE_FAIL");

    // Target: only "a" fails (same exit code), "b" now passes.
    // hadSameFailures checks that target failures are a subset of baseline
    // failures with matching exit codes. Since "a" matches, this is BASELINE_FAIL.
    const runner2 = new SafeCommandRunner([failCommand("a", 1), passCommand("b")], { cwd: root });
    const verifier2 = new RegisteredCommandVerifier(runner2, ["a", "b"]);
    const target = await verifier2.verify({
      taskId: "t",
      phase: "target",
      baseline,
    });
    expect(target.conclusion).toBe("BASELINE_FAIL");
  });
});

describe("RegisteredCommandVerifier — BLOCKED conclusion", () => {
  it("reports BLOCKED when the runner throws (command binary missing)", async () => {
    const root = await createTestDirectory("verifier-blocked-missing");
    const runner = new SafeCommandRunner([missingBinaryCommand("ghost")], { cwd: root });
    const verifier = new RegisteredCommandVerifier(runner, ["ghost"]);
    const report = await verifier.verify({ taskId: "t", phase: "target" });
    expect(report.conclusion).toBe("BLOCKED");
    expect(report.summary).toBe("At least one verification command could not be started.");
    expect(report.results).toHaveLength(1);
    expect(report.results[0]?.exitCode).toBeNull();
  });

  it("reports BLOCKED when the runner throws for an unregistered command id", async () => {
    const root = await createTestDirectory("verifier-blocked-unregistered");
    // The verifier references "unknown" but the runner has no such command.
    const runner = new SafeCommandRunner([passCommand("real")], { cwd: root });
    const verifier = new RegisteredCommandVerifier(runner, ["unknown"]);
    const report = await verifier.verify({ taskId: "t", phase: "baseline" });
    expect(report.conclusion).toBe("BLOCKED");
    expect(report.results[0]?.stderr).toContain("not registered");
  });
});

describe("RegisteredCommandVerifier — results and summary", () => {
  it("includes all command results in the report", async () => {
    const root = await createTestDirectory("verifier-results-array");
    const runner = new SafeCommandRunner(
      [passCommand("a"), failCommand("b", 1), passCommand("c")],
      { cwd: root },
    );
    const verifier = new RegisteredCommandVerifier(runner, ["a", "b", "c"]);
    const report = await verifier.verify({ taskId: "t", phase: "baseline" });
    expect(report.results).toHaveLength(3);
    expect(report.results.map((r) => r.commandId)).toEqual(["a", "b", "c"]);
    expect(report.results[0]?.exitCode).toBe(0);
    expect(report.results[1]?.exitCode).toBe(1);
    expect(report.results[2]?.exitCode).toBe(0);
  });

  it("PASS summary includes the command count", async () => {
    const root = await createTestDirectory("verifier-pass-summary");
    const runner = new SafeCommandRunner([passCommand("only")], { cwd: root });
    const verifier = new RegisteredCommandVerifier(runner, ["only"]);
    const report = await verifier.verify({ taskId: "t", phase: "target" });
    expect(report.conclusion).toBe("PASS");
    expect(report.summary).toBe("1 deterministic verification command(s) passed.");
  });

  it("PARTIAL summary is the early-return string (not from summarize())", async () => {
    const root = await createTestDirectory("verifier-partial-summary");
    const verifier = new RegisteredCommandVerifier(new SafeCommandRunner([], { cwd: root }), []);
    const report = await verifier.verify({ taskId: "t", phase: "target" });
    expect(report.conclusion).toBe("PARTIAL");
    expect(report.summary).toBe(
      "No deterministic verification command is registered for this repository.",
    );
    expect(report.results).toEqual([]);
  });

  it("schemaVersion and phase are set correctly on every report", async () => {
    const root = await createTestDirectory("verifier-schema-version");
    const runner = new SafeCommandRunner([passCommand("a")], { cwd: root });
    const verifier = new RegisteredCommandVerifier(runner, ["a"]);
    const baseline = await verifier.verify({ taskId: "t", phase: "baseline" });
    expect(baseline.schemaVersion).toBe("verification-report.v1");
    expect(baseline.phase).toBe("baseline");
    const target = await verifier.verify({ taskId: "t", phase: "target", baseline });
    expect(target.schemaVersion).toBe("verification-report.v1");
    expect(target.phase).toBe("target");
  });
});

describe("RegisteredCommandVerifier — target without baseline", () => {
  it("reports REGRESSION when target fails and no baseline is provided", async () => {
    const root = await createTestDirectory("verifier-no-baseline");
    const runner = new SafeCommandRunner([failCommand("a", 1)], { cwd: root });
    const verifier = new RegisteredCommandVerifier(runner, ["a"]);
    // No baseline provided — the verifier can't compare, so any failure is a regression.
    const report = await verifier.verify({ taskId: "t", phase: "target" });
    expect(report.conclusion).toBe("REGRESSION");
  });
});
