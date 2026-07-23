import { describe, expect, it } from "vitest";
import {
  sha256Digest,
  type ActionIntentV1,
  type EffectClaimV1,
  type ToolSpecV1,
} from "@focuscode/contracts";
import {
  EffectLedger,
  PolicyEngine,
  classifyShell,
  commandReferencesPath,
  extractApplyPatchPaths,
  type ApprovalMode,
} from "../src/index.js";

function spec(id: string, effectClass: EffectClaimV1["class"]): ToolSpecV1 {
  return {
    id,
    version: "1",
    description: id,
    inputSchema: {},
    outputSchema: {},
    schemaDigest: sha256Digest(`${id}-schema`),
    effectClasses: [effectClass],
    idempotency: "non_idempotent",
    requiredCapabilities: ["repo.write"],
  };
}

function intentFor(
  tool: ToolSpecV1,
  argumentsValue: Record<string, unknown>,
  effectClass: EffectClaimV1["class"],
): ActionIntentV1 {
  return {
    schemaVersion: "action-intent.v1",
    actionId: "action-1",
    taskId: "task",
    tool: { id: tool.id, version: tool.version, schemaDigest: tool.schemaDigest },
    arguments: argumentsValue,
    expectedEffects: [{ class: effectClass, description: "fixture" }],
    justification: "fixture",
  };
}

function engine(mode: ApprovalMode, projectTrusted = false): PolicyEngine {
  return new PolicyEngine({
    protectedPaths: [".env", ".ssh"],
    maxChangedFiles: 100,
    maxChangedLines: 1_000,
    maxRiskScore: 1_000,
    allowNetwork: true,
    allowSecrets: false,
    autoGrantRegisteredCommands: false,
    autoGrantSafeWrites: false,
    approvalMode: mode,
    projectTrusted,
  });
}

const bash = spec("bash", "command");
const write = spec("write", "file_write");
const read = spec("read", "read");
const patch = spec("apply_patch", "file_write");
const emptyLedger = () => new EffectLedger().snapshot();

function ruling(
  mode: ApprovalMode,
  tool: ToolSpecV1,
  argumentsValue: Record<string, unknown>,
  effectClass: EffectClaimV1["class"],
  projectTrusted = false,
) {
  return engine(mode, projectTrusted).evaluate(
    intentFor(tool, argumentsValue, effectClass),
    tool,
    emptyLedger(),
    2,
  );
}

describe("PolicyEngine session approval matrix", () => {
  it("grants reads in every mode and denies protected reads outside ask", () => {
    for (const mode of ["ask", "auto-edit", "full-auto", "deny"] as const) {
      expect(ruling(mode, read, { path: "src/a.ts" }, "read")).toMatchObject({
        disposition: "grant",
        reason: "Read-only workspace operation",
      });
    }
    expect(ruling("ask", read, { path: ".env" }, "read").disposition).toBe("approval_required");
    expect(ruling("auto-edit", read, { path: ".env" }, "read")).toMatchObject({
      disposition: "deny",
      reason: "Protected resource requires explicit access: .env",
    });
    expect(ruling("full-auto", read, { path: "src/../.env" }, "read").disposition).toBe("deny");
    expect(ruling("deny", read, { path: ".env" }, "read").disposition).toBe("deny");
  });

  it("maps writes per mode and keeps protected writes out of full-auto", () => {
    expect(ruling("ask", write, { path: "src/a.ts" }, "file_write")).toMatchObject({
      disposition: "approval_required",
      reason: "Explicit approval required",
    });
    expect(ruling("auto-edit", write, { path: "src/a.ts" }, "file_write")).toMatchObject({
      disposition: "grant",
      reason: "Workspace edit allowed by auto-edit mode",
    });
    expect(ruling("full-auto", write, { path: "src/a.ts" }, "file_write")).toMatchObject({
      disposition: "grant",
      reason: "Full-auto mode",
    });
    expect(ruling("deny", write, { path: "src/a.ts" }, "file_write")).toMatchObject({
      disposition: "deny",
      reason: "Side effects disabled",
    });
    expect(ruling("full-auto", write, { path: ".env" }, "file_write")).toMatchObject({
      disposition: "deny",
      reason: "Protected resource requires explicit access: .env",
    });
  });

  it("extracts apply_patch targets and denies protected ones", () => {
    const patchBody = "--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n";
    expect(ruling("full-auto", patch, { patch: patchBody }, "file_write")).toMatchObject({
      disposition: "deny",
      reason: "Protected resource requires explicit access: .env",
    });
    expect(ruling("ask", patch, { patch: patchBody }, "file_write").disposition).toBe(
      "approval_required",
    );
    expect(
      ruling("auto-edit", patch, { patch: "--- a/src/x.ts\n+++ b/src/x.ts\n" }, "file_write"),
    ).toMatchObject({ disposition: "grant" });
  });

  it("classifies shell commands and hard-denies critical ones in every mode", () => {
    for (const mode of ["ask", "auto-edit", "full-auto", "deny"] as const) {
      expect(ruling(mode, bash, { command: "rm -rf /" }, "command")).toMatchObject({
        disposition: "deny",
        reason: "Critical shell command blocked: recursive deletion of a broad system path",
      });
      expect(ruling(mode, bash, { command: "git status" }, "command")).toMatchObject({
        disposition: "grant",
        reason: "Recognized read-only command",
      });
    }
  });

  it("gates shell by risk and mode, including trusted project commands", () => {
    expect(ruling("ask", bash, { command: "echo hi" }, "command")).toMatchObject({
      disposition: "approval_required",
      reason: "General shell command requires approval",
    });
    expect(ruling("auto-edit", bash, { command: "echo hi" }, "command")).toMatchObject({
      disposition: "deny",
      reason: "General shell command requires approval",
    });
    expect(ruling("full-auto", bash, { command: "echo hi" }, "command")).toMatchObject({
      disposition: "grant",
      reason: "Full-auto mode allows non-critical command",
    });
    expect(ruling("deny", bash, { command: "echo hi" }, "command")).toMatchObject({
      disposition: "deny",
      reason: "Shell execution disabled",
    });
    // High-risk commands are never auto-granted, even in full-auto.
    expect(
      ruling("full-auto", bash, { command: "git reset --hard HEAD" }, "command"),
    ).toMatchObject({ disposition: "deny", reason: "destructive git reset" });
    expect(ruling("ask", bash, { command: "git reset --hard HEAD" }, "command").disposition).toBe(
      "approval_required",
    );
    // Repository-controlled verification commands: granted only to a trusted
    // project under auto-edit.
    expect(ruling("auto-edit", bash, { command: "pnpm test" }, "command", true)).toMatchObject({
      disposition: "grant",
      reason: "Trusted project verification command",
    });
    expect(ruling("auto-edit", bash, { command: "pnpm test" }, "command", false)).toMatchObject({
      disposition: "deny",
      reason: "Project command can execute repository-controlled code",
    });
    expect(ruling("full-auto", bash, { command: "pnpm test" }, "command").disposition).toBe(
      "grant",
    );
  });

  it("denies shell commands referencing protected paths, with ask prompting", () => {
    expect(ruling("ask", bash, { command: "cat ~/.ssh/id_rsa" }, "command")).toMatchObject({
      disposition: "approval_required",
      reason: "Shell command references protected resource: .ssh",
    });
    expect(ruling("full-auto", bash, { command: "cat ~/.ssh/id_rsa" }, "command")).toMatchObject({
      disposition: "deny",
      reason: "Shell command references protected resource: .ssh",
    });
    // Malformed commands keep the legacy wording.
    expect(ruling("ask", bash, { command: "  " }, "command")).toMatchObject({
      disposition: "approval_required",
      reason: "Shell command must be a non-empty string",
    });
    expect(ruling("full-auto", bash, {}, "command")).toMatchObject({
      disposition: "deny",
      reason: "Shell command must be a non-empty string",
    });
  });

  it("surfaces argument parse failures with the invalid marker text", () => {
    expect(ruling("ask", write, { _invalid: "bad json" }, "file_write")).toMatchObject({
      disposition: "approval_required",
      reason: "bad json",
    });
    expect(ruling("full-auto", write, { _invalid: "bad json" }, "file_write")).toMatchObject({
      disposition: "deny",
      reason: "bad json",
    });
  });

  it("repoints the approval mode for interactive switching", () => {
    const policy = engine("ask");
    const intent = intentFor(write, { path: "src/a.ts" }, "file_write");
    expect(policy.evaluate(intent, write, emptyLedger(), 2).disposition).toBe("approval_required");
    policy.setApprovalMode("full-auto");
    expect(policy.evaluate(intent, write, emptyLedger(), 2).disposition).toBe("grant");
  });
});

describe("shell policy rules", () => {
  it("classifies commands into four risk tiers", () => {
    expect(classifyShell("ls src")).toMatchObject({ risk: "low" });
    expect(classifyShell("cat /etc/passwd").risk).toBe("medium");
    expect(classifyShell("pnpm test")).toMatchObject({ risk: "medium" });
    expect(classifyShell("sudo apt-get update").risk).toBe("high");
    expect(classifyShell("dd if=/dev/zero of=/dev/sda").risk).toBe("critical");
    expect(classifyShell("").risk).toBe("high");
    expect(classifyShell(42).risk).toBe("high");
  });

  it("matches protected path references at token boundaries only", () => {
    expect(commandReferencesPath("cat ~/.ssh/id_rsa", ".ssh")).toBe(true);
    expect(commandReferencesPath("cat .env", ".env")).toBe(true);
    expect(commandReferencesPath("cat .envrc", ".env")).toBe(false);
    expect(commandReferencesPath("echo notes", ".env")).toBe(false);
  });

  it("extracts and normalizes apply_patch header paths", () => {
    expect(extractApplyPatchPaths("--- a/src/../.env\n+++ b/src/x.ts\n")).toEqual([
      ".env",
      "src/x.ts",
    ]);
    expect(extractApplyPatchPaths("no headers")).toEqual([]);
  });
});
