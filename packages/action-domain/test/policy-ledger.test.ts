import { describe, expect, it } from "vitest";
import { sha256Digest, type ActionIntentV1, type ToolSpecV1 } from "@focuscode/contracts";
import { EffectLedger, PolicyEngine } from "../src/index.js";

const tool: ToolSpecV1 = {
  id: "apply_edit_ir",
  version: "1",
  description: "edit",
  inputSchema: {},
  outputSchema: {},
  schemaDigest: sha256Digest("edit-schema"),
  effectClasses: ["file_write"],
  idempotency: "conditional",
  requiredCapabilities: ["repo.write"],
};

function intent(path = "src/value.ts"): ActionIntentV1 {
  return {
    schemaVersion: "action-intent.v1",
    actionId: "action-1",
    taskId: "task",
    tool: { id: tool.id, version: tool.version, schemaDigest: tool.schemaDigest },
    arguments: { path },
    expectedEffects: [{ class: "file_write", resource: path, description: "edit" }],
    justification: "fixture",
  };
}

describe("PolicyEngine and EffectLedger", () => {
  it("tracks cumulative effects once and projects risk", () => {
    const ledger = new EffectLedger();
    expect(ledger.projectedRisk(intent())).toBe(2);
    const receipt = {
      schemaVersion: "effect-receipt.v1" as const,
      actionId: "action-1",
      grantId: "grant-1",
      status: "applied" as const,
      observedEffects: [
        { class: "file_write", resource: "src/value.ts", detail: { changedLines: 4 } },
      ],
      artifacts: [],
      reconciliation: "matched" as const,
    };
    ledger.record(receipt);
    ledger.record(receipt);
    expect(ledger.hasAction("action-1")).toBe(true);
    expect(ledger.snapshot()).toMatchObject({
      changedFiles: ["src/value.ts"],
      changedLines: 4,
      riskScore: 2,
    });
  });

  it("hard-denies protected paths and requires approval for ordinary writes", () => {
    const policy = new PolicyEngine({
      protectedPaths: [".git", "generated"],
      maxChangedFiles: 2,
      maxChangedLines: 20,
      maxRiskScore: 10,
      allowNetwork: false,
      allowSecrets: false,
      autoGrantRegisteredCommands: false,
      autoGrantSafeWrites: false,
    });
    const empty = new EffectLedger().snapshot();
    expect(policy.evaluate(intent(".git/config"), tool, empty, 2).disposition).toBe("deny");
    expect(policy.evaluate(intent(), tool, empty, 2).disposition).toBe("approval_required");
    expect(policy.evaluate(intent(), tool, empty, 99).reason).toMatch(/Cumulative risk/);
  });

  it("hard-denies protected paths disguised with dot segments", () => {
    const policy = new PolicyEngine({
      protectedPaths: [".git", ".env"],
      maxChangedFiles: 2,
      maxChangedLines: 20,
      maxRiskScore: 10,
      allowNetwork: false,
      allowSecrets: false,
      autoGrantRegisteredCommands: false,
      autoGrantSafeWrites: true,
    });
    const empty = new EffectLedger().snapshot();
    expect(policy.evaluate(intent("src/../.env"), tool, empty, 2).disposition).toBe("deny");
    expect(policy.evaluate(intent("src/sub/../../.env"), tool, empty, 2).disposition).toBe("deny");
    expect(policy.evaluate(intent("src\\..\\.env"), tool, empty, 2).disposition).toBe("deny");
    expect(policy.evaluate(intent("sub/../.git/config"), tool, empty, 2).disposition).toBe("deny");
    expect(policy.evaluate(intent("src/../src/ok.ts"), tool, empty, 2).disposition).toBe("grant");
  });

  it("rejects effect claims not declared by the tool", () => {
    const policy = new PolicyEngine({
      protectedPaths: [],
      maxChangedFiles: 2,
      maxChangedLines: 20,
      maxRiskScore: 10,
      allowNetwork: false,
      allowSecrets: false,
      autoGrantRegisteredCommands: false,
      autoGrantSafeWrites: true,
    });
    const bad = {
      ...intent(),
      expectedEffects: [{ class: "network" as const, description: "send" }],
    };
    expect(policy.evaluate(bad, tool, new EffectLedger().snapshot(), 10).reason).toMatch(
      /not declared/,
    );
  });

  it("hard-denies shell commands that reference protected paths in the command text", () => {
    const shellTool: ToolSpecV1 = {
      id: "bash",
      version: "1",
      description: "shell",
      inputSchema: {},
      outputSchema: {},
      schemaDigest: sha256Digest("shell-schema"),
      effectClasses: ["command"],
      idempotency: "non_idempotent",
      requiredCapabilities: ["process.shell"],
    };
    const shellIntent = (command: string): ActionIntentV1 => ({
      schemaVersion: "action-intent.v1",
      actionId: "action-shell",
      taskId: "task",
      tool: { id: shellTool.id, version: shellTool.version, schemaDigest: shellTool.schemaDigest },
      arguments: { command },
      expectedEffects: [{ class: "command", description: "shell" }],
      justification: "fixture",
    });
    const policy = new PolicyEngine({
      protectedPaths: [".ssh"],
      maxChangedFiles: 10,
      maxChangedLines: 100,
      maxRiskScore: 100,
      allowNetwork: true,
      allowSecrets: false,
      autoGrantRegisteredCommands: false,
      autoGrantSafeWrites: false,
    });
    const empty = new EffectLedger().snapshot();
    const denied = policy.evaluate(shellIntent("cat ~/.ssh/id_rsa"), shellTool, empty, 3);
    expect(denied.disposition).toBe("deny");
    expect(denied.reason).toBe("Shell command references protected resource: .ssh");
    // Unrelated commands keep the kernel default: command effects need approval.
    expect(policy.evaluate(shellIntent("ls src"), shellTool, empty, 3).disposition).toBe(
      "approval_required",
    );
  });
});
