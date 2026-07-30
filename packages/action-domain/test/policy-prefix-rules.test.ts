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
  type ApprovalMode,
  type CommandPrefixRule,
} from "../src/index.js";

/**
 * P0: spine prefixRules — PolicyEngine must enforce user-configured command
 * prefix rules so the legacy PermissionController path and the effect spine
 * path decide identically. Before this fix, PolicyEngine had no prefix rule
 * support; the legacy path ran PrefixRuleEngine externally and the spine path
 * ignored prefixRules entirely, producing a split-brain where a user's deny
 * rule fired on one path but not the other.
 *
 * Semantics (mirroring the legacy PermissionController contract):
 *  - Prefix deny is immediate (stricter-than-engine): always wins, even in
 *    full-auto, even before capability/budget checks.
 *  - Prefix allow is held back: PolicyEngine hard denials (critical commands,
 *    protected paths, unadvertised effects, capability checks) cannot be
 *    bypassed; allow only promotes approval_required/grant to grant.
 *  - First-match wins; rules only apply to tool.id === "bash".
 */
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

const bash = spec("bash", "command");
const write = spec("write", "file_write");
const emptyLedger = () => new EffectLedger().snapshot();

function engineWith(
  mode: ApprovalMode,
  prefixRules: CommandPrefixRule[] | undefined,
  projectTrusted = false,
): PolicyEngine {
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
    ...(prefixRules !== undefined ? { prefixRules } : {}),
  });
}

function bashRuling(
  mode: ApprovalMode,
  prefixRules: CommandPrefixRule[] | undefined,
  command: string,
  projectTrusted = false,
) {
  return engineWith(mode, prefixRules, projectTrusted).evaluate(
    intentFor(bash, { command }, "command"),
    bash,
    emptyLedger(),
    2,
  );
}

describe("PolicyEngine prefix rules integration (P0: spine prefixRules)", () => {
  it("TC-PE-PREFIX-01: prefix deny denies immediately with Prefix rule denied reason", () => {
    const rules: CommandPrefixRule[] = [
      { prefix: "npm publish", effect: "deny", reason: "Package publication is irreversible" },
    ];
    const decision = bashRuling("full-auto", rules, "npm publish --access public");
    expect(decision.disposition).toBe("deny");
    expect(decision.reason).toContain("Prefix rule denied");
    expect(decision.reason).toContain("Package publication is irreversible");
  });

  it("TC-PE-PREFIX-02: prefix allow promotes approval_required to grant in ask mode", () => {
    const rules: CommandPrefixRule[] = [
      { prefix: "git status", effect: "allow", reason: "read-only git allowed" },
    ];
    const decision = bashRuling("ask", rules, "git status");
    expect(decision.disposition).toBe("grant");
    expect(decision.reason).toContain("Prefix rule allowed");
  });

  it("TC-PE-PREFIX-03: prefix allow cannot bypass critical command (rm -rf /) hard deny", () => {
    const rules: CommandPrefixRule[] = [{ prefix: "rm", effect: "allow", reason: "test allow rm" }];
    const decision = bashRuling("full-auto", rules, "rm -rf /");
    expect(decision.disposition).toBe("deny");
    expect(decision.reason).toContain("Critical shell command blocked");
  });

  it("TC-PE-PREFIX-04: prefix allow cannot bypass protected path (cat .env) deny", () => {
    const rules: CommandPrefixRule[] = [
      { prefix: "cat", effect: "allow", reason: "test allow cat" },
    ];
    const decision = bashRuling("full-auto", rules, "cat .env");
    expect(decision.disposition).toBe("deny");
    expect(decision.reason).toContain("protected resource");
  });

  it("TC-PE-PREFIX-05: prefix deny wins in full-auto mode", () => {
    const rules: CommandPrefixRule[] = [
      { prefix: "npm publish", effect: "deny", reason: "blocked" },
    ];
    const decision = bashRuling("full-auto", rules, "npm publish");
    expect(decision.disposition).toBe("deny");
    expect(decision.reason).toContain("Prefix rule denied");
  });

  it("TC-PE-PREFIX-06: no prefix match falls through to normal session decision", () => {
    const rules: CommandPrefixRule[] = [
      { prefix: "npm publish", effect: "deny", reason: "blocked" },
    ];
    const decision = bashRuling("full-auto", rules, "git status");
    expect(decision.disposition).toBe("grant");
    expect(decision.reason).toBe("Recognized read-only command");
  });

  it("TC-PE-PREFIX-07: prefix rules do not affect non-bash tools", () => {
    const rules: CommandPrefixRule[] = [
      { prefix: "write", effect: "deny", reason: "should not apply to write tool" },
    ];
    const engine = engineWith("auto-edit", rules);
    const decision = engine.evaluate(
      intentFor(write, { path: "src/a.ts" }, "file_write"),
      write,
      emptyLedger(),
      2,
    );
    expect(decision.disposition).toBe("grant");
    expect(decision.reason).toBe("Workspace edit allowed by auto-edit mode");
  });

  it("TC-PE-PREFIX-08: prefix allow promotes general shell approval_required to grant", () => {
    const rules: CommandPrefixRule[] = [
      { prefix: "echo", effect: "allow", reason: "echo allowed" },
    ];
    const decision = bashRuling("ask", rules, "echo hello");
    expect(decision.disposition).toBe("grant");
    expect(decision.reason).toContain("Prefix rule allowed");
  });

  it("TC-PE-PREFIX-09: empty prefixRules array is a no-op (approval_required stays)", () => {
    const decision = bashRuling("ask", [], "echo hello");
    expect(decision.disposition).toBe("approval_required");
  });

  it("TC-PE-PREFIX-10: undefined prefixRules yields normal decisions", () => {
    const decision = bashRuling("full-auto", undefined, "git status");
    expect(decision.disposition).toBe("grant");
    expect(decision.reason).toBe("Recognized read-only command");
  });

  it("TC-PE-PREFIX-11: first-match wins — deny before allow for overlapping prefixes", () => {
    const rules: CommandPrefixRule[] = [
      { prefix: "npm", effect: "deny", reason: "npm blocked" },
      { prefix: "npm install", effect: "allow", reason: "npm install allowed" },
    ];
    const decision = bashRuling("ask", rules, "npm install");
    expect(decision.disposition).toBe("deny");
    expect(decision.reason).toContain("Prefix rule denied");
  });

  it("TC-PE-PREFIX-12: prefix allow cannot bypass unadvertised effects deny", () => {
    const rules: CommandPrefixRule[] = [
      { prefix: "echo", effect: "allow", reason: "echo allowed" },
    ];
    const engine = engineWith("full-auto", rules);
    const intent: ActionIntentV1 = {
      schemaVersion: "action-intent.v1",
      actionId: "action-1",
      taskId: "task",
      tool: { id: bash.id, version: bash.version, schemaDigest: bash.schemaDigest },
      arguments: { command: "echo hi" },
      expectedEffects: [{ class: "network", description: "smuggled" }],
      justification: "fixture",
    };
    const decision = engine.evaluate(intent, bash, emptyLedger(), 2);
    expect(decision.disposition).toBe("deny");
    expect(decision.reason).toContain("not declared by tool");
  });

  it("TC-PE-PREFIX-13: prefix allow on already-grant command changes reason to Prefix rule allowed", () => {
    const rules: CommandPrefixRule[] = [
      { prefix: "git status", effect: "allow", reason: "explicitly allowed" },
    ];
    const decision = bashRuling("full-auto", rules, "git status");
    expect(decision.disposition).toBe("grant");
    expect(decision.reason).toContain("Prefix rule allowed");
    expect(decision.reason).toContain("explicitly allowed");
  });

  it("TC-PE-PREFIX-14: prefix deny fires before budget/capability checks", () => {
    const rules: CommandPrefixRule[] = [
      { prefix: "npm publish", effect: "deny", reason: "blocked" },
    ];
    // Even with an exhausted budget, prefix deny wins (immediate).
    const engine = new PolicyEngine({
      protectedPaths: [".env"],
      maxChangedFiles: 0,
      maxChangedLines: 0,
      maxRiskScore: 0,
      allowNetwork: true,
      allowSecrets: false,
      autoGrantRegisteredCommands: false,
      autoGrantSafeWrites: false,
      approvalMode: "full-auto",
      projectTrusted: false,
      prefixRules: rules,
    });
    const decision = engine.evaluate(
      intentFor(bash, { command: "npm publish" }, "command"),
      bash,
      emptyLedger(),
      999,
    );
    expect(decision.disposition).toBe("deny");
    expect(decision.reason).toContain("Prefix rule denied");
  });

  it("TC-PE-PREFIX-15: prefix allow does not bypass exhausted budget deny", () => {
    const rules: CommandPrefixRule[] = [
      { prefix: "echo", effect: "allow", reason: "echo allowed" },
    ];
    const engine = new PolicyEngine({
      protectedPaths: [],
      maxChangedFiles: 0,
      maxChangedLines: 0,
      maxRiskScore: 1_000,
      allowNetwork: true,
      allowSecrets: false,
      autoGrantRegisteredCommands: false,
      autoGrantSafeWrites: false,
      approvalMode: "full-auto",
      projectTrusted: false,
      prefixRules: rules,
    });
    const decision = engine.evaluate(
      intentFor(bash, { command: "echo hi" }, "command"),
      bash,
      emptyLedger(),
      0,
    );
    // Budget exhausted (maxChangedFiles=0) → hard deny; prefix allow cannot override.
    expect(decision.disposition).toBe("deny");
    expect(decision.reason).toContain("budget");
  });

  it("TC-PE-PREFIX-16: non-string command argument skips prefix check (no crash)", () => {
    const rules: CommandPrefixRule[] = [{ prefix: "echo", effect: "deny", reason: "blocked" }];
    const engine = engineWith("full-auto", rules);
    const decision = engine.evaluate(
      intentFor(bash, { command: 123 }, "command"),
      bash,
      emptyLedger(),
      2,
    );
    // Prefix check skipped (command is not a string); core denies for invalid
    // command. The reason must come from the session matrix, not prefix deny.
    expect(decision.disposition).toBe("deny");
    expect(decision.reason).not.toContain("Prefix rule denied");
    expect(decision.reason).toContain("non-empty string");
  });
});
