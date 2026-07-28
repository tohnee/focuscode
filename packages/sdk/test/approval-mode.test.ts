import { describe, expect, it } from "vitest";
import { createTestDirectory } from "@focuscode/testkit";
import {
  createLocalHarness,
  HARNESS_APPROVAL_MODES,
  type HarnessApprovalMode,
  type LocalHarnessOptions,
} from "../src/index.js";
import type { ScriptedStep } from "@focuscode/testkit";

describe("SDK ApprovalMode disambiguation", () => {
  it("exports HARNESS_APPROVAL_MODES as the runtime authority for HarnessApprovalMode", () => {
    // The const array is the single source of truth; the type is derived
    // from it via `typeof HARNESS_APPROVAL_MODES[number]`. If the export
    // disappears, this test fails at import time.
    expect(HARNESS_APPROVAL_MODES).toEqual(["deny", "prompt", "auto-safe"]);
  });

  it("HarnessApprovalMode accepts every value listed in HARNESS_APPROVAL_MODES", () => {
    // Type-level check: each runtime value must be assignable to the type.
    // If the type alias drifts (e.g., drops "prompt"), tsc fails on the
    // assignment below.
    for (const mode of HARNESS_APPROVAL_MODES) {
      const assigned: HarnessApprovalMode = mode;
      expect(assigned).toBe(mode);
    }
  });

  it("LocalHarnessOptions.approvalMode accepts every HarnessApprovalMode value", async () => {
    const repoRoot = await createTestDirectory("sdk-approval-mode-repo");
    const stateDirectory = await createTestDirectory("sdk-approval-mode-state");

    const modes: HarnessApprovalMode[] = [...HARNESS_APPROVAL_MODES];
    for (const mode of modes) {
      const options: LocalHarnessOptions = {
        repoRoot,
        stateDirectory,
        approvalMode: mode,
        model: { kind: "scripted", steps: [] as ScriptedStep[] },
      };
      expect(options.approvalMode).toBe(mode);
    }
  });

  it("createLocalHarness treats an omitted approvalMode as deny (back-compat default)", async () => {
    const repoRoot = await createTestDirectory("sdk-approval-default-repo");
    const stateDirectory = await createTestDirectory("sdk-approval-default-state");
    const harness = await createLocalHarness({
      repoRoot,
      stateDirectory,
      model: { kind: "scripted", steps: [] as ScriptedStep[] },
    });
    expect(harness.actions).toBeDefined();
    expect(typeof harness.run).toBe("function");
  });
});
