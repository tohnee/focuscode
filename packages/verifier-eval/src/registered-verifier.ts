import { sha256Digest, type VerificationReportV1, type VerifyPort } from "@focuscode/contracts";
import { SafeCommandRunner } from "@focuscode/action-backends";

export class RegisteredCommandVerifier implements VerifyPort {
  constructor(
    private readonly runner: SafeCommandRunner,
    private readonly commandIds: string[],
  ) {}

  async verify(request: {
    taskId: string;
    phase: "baseline" | "target";
    baseline?: VerificationReportV1;
  }): Promise<VerificationReportV1> {
    if (this.commandIds.length === 0) {
      return {
        schemaVersion: "verification-report.v1",
        conclusion: "PARTIAL",
        phase: request.phase,
        results: [],
        summary: "No deterministic verification command is registered for this repository.",
      };
    }
    const results = [];
    for (const commandId of this.commandIds) {
      try {
        results.push(await this.runner.run(commandId));
      } catch (error) {
        const raw = {
          commandId,
          exitCode: null,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          timedOut: false,
        };
        results.push({ ...raw, durationMs: 0, digest: sha256Digest(raw) });
      }
    }
    const allPassed = results.every((result) => result.exitCode === 0 && !result.timedOut);
    const unavailable = results.some((result) => result.exitCode === null);
    let conclusion: VerificationReportV1["conclusion"];
    if (unavailable) conclusion = "BLOCKED";
    else if (allPassed) conclusion = "PASS";
    else if (request.phase === "baseline") conclusion = "BASELINE_FAIL";
    else if (request.baseline && hadSameFailures(request.baseline, results)) {
      conclusion = "BASELINE_FAIL";
    } else {
      conclusion = "REGRESSION";
    }
    return {
      schemaVersion: "verification-report.v1",
      conclusion,
      phase: request.phase,
      results,
      summary: summarize(conclusion, results.length),
    };
  }
}

function hadSameFailures(
  baseline: VerificationReportV1,
  target: VerificationReportV1["results"],
): boolean {
  const baselineFailures = new Map(
    baseline.results
      .filter((result) => result.exitCode !== 0)
      .map((result) => [result.commandId, result.exitCode]),
  );
  const targetFailures = target.filter((result) => result.exitCode !== 0);
  return (
    targetFailures.length > 0 &&
    targetFailures.every((result) => baselineFailures.get(result.commandId) === result.exitCode)
  );
}

function summarize(conclusion: VerificationReportV1["conclusion"], commands: number): string {
  switch (conclusion) {
    case "PASS":
      return `${commands} deterministic verification command(s) passed.`;
    case "BASELINE_FAIL":
      return "The observed failure was already present in the baseline or remains equivalent.";
    case "REGRESSION":
      return "Target verification introduced or changed a deterministic failure.";
    case "BLOCKED":
      return "At least one verification command could not be started.";
    default:
      return `Verification concluded ${conclusion}.`;
  }
}
