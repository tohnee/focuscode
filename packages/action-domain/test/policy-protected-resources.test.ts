import { describe, expect, it } from "vitest";
import {
  sha256Digest,
  type ActionIntentV1,
  type EffectClaimV1,
  type ToolSpecV1,
} from "@focuscode/contracts";
import { PolicyEngine, commandReferencesPath, type ApprovalMode } from "../src/index.js";

/**
 * Regression suite for the protected-resource gate and the kernel envelope
 * classification (code-review P1/P2 findings):
 * - intent claims must not widen what the tool declares (empty expectedEffects
 *   must not fall through to the default grant);
 * - every path-reading tool (grep/find/ls included) is gated on protected
 *   paths;
 * - APFS/NTFS case-insensitive and APFS trailing-dot variants cannot bypass
 *   the gate.
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
  effectClasses: EffectClaimV1["class"][] = ["read"],
): ActionIntentV1 {
  return {
    schemaVersion: "action-intent.v1",
    actionId: "action-1",
    taskId: "task",
    tool: { id: tool.id, version: tool.version, schemaDigest: tool.schemaDigest },
    arguments: argumentsValue,
    expectedEffects: effectClasses.map((effectClass) => ({
      class: effectClass,
      description: "fixture",
    })),
    justification: "fixture",
  };
}

function kernelEngine(overrides: Partial<Record<string, unknown>> = {}): PolicyEngine {
  return new PolicyEngine({
    protectedPaths: [".env", ".ssh"],
    maxChangedFiles: 100,
    maxChangedLines: 1_000,
    maxRiskScore: 1_000,
    allowNetwork: true,
    allowSecrets: false,
    autoGrantRegisteredCommands: false,
    autoGrantSafeWrites: false,
    ...overrides,
  });
}

function sessionEngine(mode: ApprovalMode): PolicyEngine {
  return kernelEngine({ approvalMode: mode });
}

const bash = spec("bash", "command");
const write = spec("write", "file_write");
const read = spec("read", "read");
const grep = spec("grep", "read");
const find = spec("find", "read");
const ls = spec("ls", "read");
const gitDiff = spec("git_diff", "git");

describe("kernel envelope classification", () => {
  it("grants tools that declare only read effects", () => {
    const decision = kernelEngine().evaluate(
      intentFor(read, { path: "src/a.ts" }),
      read,
      {
        changedFiles: [],
        changedLines: 0,
        riskScore: 0,
      },
      2,
    );
    expect(decision.disposition).toBe("grant");
  });

  it("requires approval for a command-class tool even when the intent claims no effects", () => {
    const decision = kernelEngine().evaluate(
      intentFor(bash, { command: "npm test" }, []),
      bash,
      { changedFiles: [], changedLines: 0, riskScore: 0 },
      2,
    );
    expect(decision.disposition).toBe("approval_required");
  });

  it("requires approval for a file_write tool (write is not read-only in the envelope)", () => {
    const decision = kernelEngine().evaluate(
      intentFor(write, { path: "src/a.ts", content: "x" }, ["file_write"]),
      write,
      { changedFiles: [], changedLines: 0, riskScore: 0 },
      2,
    );
    expect(decision.disposition).toBe("approval_required");
  });

  it("requires approval for a git-class tool", () => {
    const decision = kernelEngine().evaluate(
      intentFor(gitDiff, { path: "src" }, ["git"]),
      gitDiff,
      { changedFiles: [], changedLines: 0, riskScore: 0 },
      2,
    );
    expect(decision.disposition).toBe("approval_required");
  });
});

describe("protected paths gate path-reading tools (grep/find/ls included)", () => {
  for (const tool of [read, grep, find, ls]) {
    it(`${tool.id} path ".env" is gated in ask mode`, () => {
      const decision = sessionEngine("ask").evaluate(
        intentFor(tool, { path: ".env" }),
        tool,
        { changedFiles: [], changedLines: 0, riskScore: 0 },
        2,
      );
      expect(decision.disposition).toBe("approval_required");
    });

    it(`${tool.id} path ".env" is denied in full-auto mode`, () => {
      const decision = sessionEngine("full-auto").evaluate(
        intentFor(tool, { path: ".env" }),
        tool,
        { changedFiles: [], changedLines: 0, riskScore: 0 },
        2,
      );
      expect(decision.disposition).toBe("deny");
    });
  }

  it("grep path nested under .ssh is gated", () => {
    const decision = sessionEngine("ask").evaluate(
      intentFor(grep, { path: ".ssh/id_rsa", pattern: "BEGIN" }),
      grep,
      { changedFiles: [], changedLines: 0, riskScore: 0 },
      2,
    );
    expect(decision.disposition).toBe("approval_required");
  });

  it("dot-segment disguise still matches", () => {
    const decision = sessionEngine("ask").evaluate(
      intentFor(read, { path: "src/../.env" }),
      read,
      { changedFiles: [], changedLines: 0, riskScore: 0 },
      2,
    );
    expect(decision.disposition).toBe("approval_required");
  });
});

describe("case/trailing-dot folding (APFS/NTFS variants)", () => {
  it("uppercase variant .ENV is gated", () => {
    const decision = sessionEngine("ask").evaluate(
      intentFor(read, { path: ".ENV" }),
      read,
      { changedFiles: [], changedLines: 0, riskScore: 0 },
      2,
    );
    expect(decision.disposition).toBe("approval_required");
  });

  it("mixed-case variant .Ssh is gated", () => {
    const decision = sessionEngine("ask").evaluate(
      intentFor(grep, { path: ".Ssh/config", pattern: "x" }),
      grep,
      { changedFiles: [], changedLines: 0, riskScore: 0 },
      2,
    );
    expect(decision.disposition).toBe("approval_required");
  });

  it("APFS trailing-dot variant .env. is gated", () => {
    const decision = sessionEngine("ask").evaluate(
      intentFor(read, { path: ".env." }),
      read,
      { changedFiles: [], changedLines: 0, riskScore: 0 },
      2,
    );
    expect(decision.disposition).toBe("approval_required");
  });

  it("APFS trailing-space variant .env  is gated", () => {
    const decision = sessionEngine("ask").evaluate(
      intentFor(read, { path: ".env " }),
      read,
      { changedFiles: [], changedLines: 0, riskScore: 0 },
      2,
    );
    expect(decision.disposition).toBe("approval_required");
  });

  it("kernel envelope hard-denies uppercase shell reference `cat .ENV`", () => {
    const decision = kernelEngine().evaluate(
      intentFor(bash, { command: "cat .ENV" }, ["command"]),
      bash,
      { changedFiles: [], changedLines: 0, riskScore: 0 },
      2,
    );
    expect(decision.disposition).toBe("deny");
  });

  it("non-protected uppercase path is not gated", () => {
    const decision = sessionEngine("ask").evaluate(
      intentFor(read, { path: "SRC/MAIN.TS" }),
      read,
      { changedFiles: [], changedLines: 0, riskScore: 0 },
      2,
    );
    expect(decision.disposition).toBe("grant");
  });
});

describe("commandReferencesPath", () => {
  it("is case-insensitive", () => {
    expect(commandReferencesPath("cat .ENV", ".env")).toBe(true);
    expect(commandReferencesPath("cat .Env", ".env")).toBe(true);
  });

  it("still matches exact case", () => {
    expect(commandReferencesPath("cat .env", ".env")).toBe(true);
  });

  it("does not match unrelated paths", () => {
    expect(commandReferencesPath("cat src/main.ts", ".env")).toBe(false);
    expect(commandReferencesPath("cat .environs", ".env")).toBe(false);
  });
});
