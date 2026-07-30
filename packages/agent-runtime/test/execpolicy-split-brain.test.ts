import { describe, expect, it } from "vitest";
import { PermissionController } from "../src/permissions.js";
import type { AgentToolCall, ToolDefinition } from "../src/types.js";

/**
 * P0-1: execpolicy split-brain — allow prefix rules must not bypass
 * PolicyEngine hard denials (critical commands, protected paths).
 *
 * Before the fix, PermissionController.decide() let an allow prefix rule
 * short-circuit to grant *before* PolicyEngine evaluated the command, so
 * `allow "rm"` would grant `rm -rf /` even though PolicyEngine classifies
 * it as critical risk and hard-denies it.
 *
 * The fix runs PolicyEngine first; if it returns `deny` (hard denial),
 * prefix allow cannot override it. Prefix deny and prefix allow can still
 * override `approval_required` (soft) decisions.
 */
describe("P0-1: execpolicy split-brain — allow prefix cannot bypass hard deny", () => {
  const bash: ToolDefinition = {
    name: "bash",
    label: "Shell",
    description: "shell",
    parameters: {},
    effect: "shell",
  };

  const call = (command: string): AgentToolCall => ({
    id: "call",
    name: "bash",
    arguments: { command },
  });

  it("TC-P0-1-01: allow prefix 'rm' does NOT bypass hard deny for 'rm -rf /'", () => {
    const policy = new PermissionController({
      cwd: process.cwd(),
      mode: "full-auto",
      projectTrusted: true,
      protectedPaths: [".env"],
      prefixRules: [{ prefix: "rm", effect: "allow", reason: "test allow rm" }],
    });
    const result = policy.evaluate(bash, call("rm -rf /"));
    expect(result.allowed).toBe(false);
  });

  it("TC-P0-1-02: allow prefix 'git' still grants 'git status' (non-critical)", () => {
    const policy = new PermissionController({
      cwd: process.cwd(),
      mode: "ask",
      projectTrusted: true,
      protectedPaths: [".env"],
      prefixRules: [{ prefix: "git", effect: "allow", reason: "test allow git" }],
    });
    const result = policy.evaluate(bash, call("git status"));
    expect(result.allowed).toBe(true);
  });

  it("TC-P0-1-03: deny prefix 'rm' still denies 'rm -rf /'", () => {
    const policy = new PermissionController({
      cwd: process.cwd(),
      mode: "full-auto",
      projectTrusted: true,
      protectedPaths: [".env"],
      prefixRules: [{ prefix: "rm", effect: "deny", reason: "test deny rm" }],
    });
    const result = policy.evaluate(bash, call("rm -rf /"));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Prefix rule denied");
  });

  it("TC-P0-1-04: no prefix match + 'rm -rf /' → deny (PolicyEngine hard deny)", () => {
    const policy = new PermissionController({
      cwd: process.cwd(),
      mode: "full-auto",
      projectTrusted: true,
      protectedPaths: [".env"],
    });
    const result = policy.evaluate(bash, call("rm -rf /"));
    expect(result.allowed).toBe(false);
  });

  it("TC-P0-1-05: allow prefix 'ls' grants 'ls -la' (non-critical)", () => {
    const policy = new PermissionController({
      cwd: process.cwd(),
      mode: "ask",
      projectTrusted: true,
      protectedPaths: [".env"],
      prefixRules: [{ prefix: "ls", effect: "allow", reason: "test allow ls" }],
    });
    const result = policy.evaluate(bash, call("ls -la"));
    expect(result.allowed).toBe(true);
  });

  it("TC-P0-1-06: allow prefix 'cat' does NOT bypass protected path deny for 'cat .env'", () => {
    const policy = new PermissionController({
      cwd: process.cwd(),
      mode: "full-auto",
      projectTrusted: true,
      protectedPaths: [".env"],
      prefixRules: [{ prefix: "cat", effect: "allow", reason: "test allow cat" }],
    });
    const result = policy.evaluate(bash, call("cat .env"));
    expect(result.allowed).toBe(false);
  });

  it("TC-P0-1-07: allow prefix 'dd' does NOT bypass hard deny for 'dd if=/dev/zero of=/dev/sda'", () => {
    const policy = new PermissionController({
      cwd: process.cwd(),
      mode: "full-auto",
      projectTrusted: true,
      protectedPaths: [".env"],
      prefixRules: [{ prefix: "dd", effect: "allow", reason: "test allow dd" }],
    });
    const result = policy.evaluate(bash, call("dd if=/dev/zero of=/dev/sda"));
    expect(result.allowed).toBe(false);
  });
});
