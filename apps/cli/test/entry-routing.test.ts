/**
 * TDD tests for CLI entry-point routing (C1 fix).
 *
 * The historical implementation used a deny-list: any first argument not
 * in a hard-coded list was treated as an agent prompt. This is fragile —
 * adding a new subcommand requires updating the list, and forgetting to do
 * so silently breaks routing.
 *
 * The fix introduces an explicit subcommand registry. Agent invocations
 * are detected by the absence of a matching subcommand OR by an explicit
 * `--` separator (forward-compatible with future `focuscode agent` syntax).
 */
import { describe, expect, it } from "vitest";
import { isAgentInvocation, SUBCOMMANDS } from "../src/agent-command.js";

describe("CLI entry-point routing (C1: deny-list → explicit registry)", () => {
  it("treats empty argv as an agent invocation", () => {
    expect(isAgentInvocation([])).toBe(true);
  });

  it("treats a plain prompt as an agent invocation", () => {
    expect(isAgentInvocation(["fix the bug"])).toBe(true);
  });

  it("treats a known subcommand as NOT an agent invocation", () => {
    for (const sub of SUBCOMMANDS) {
      expect(isAgentInvocation([sub])).toBe(false);
    }
  });

  it("treats an unknown first token as an agent invocation (back-compat)", () => {
    // A user typing `focuscode hello world` expects "hello world" as a prompt,
    // not an "unknown subcommand" error. This preserves the default-to-agent
    // behaviour that makes FocusCode feel like a chat tool.
    expect(isAgentInvocation(["hello", "world"])).toBe(true);
  });

  it("SUBCOMMANDS is a frozen, exhaustive list (no deny-list drift)", () => {
    expect(Object.isFrozen(SUBCOMMANDS)).toBe(true);
    // Every entry must be a non-empty string.
    for (const sub of SUBCOMMANDS) {
      expect(typeof sub).toBe("string");
      expect(sub.length).toBeGreaterThan(0);
    }
    // Must include all historical subcommands so the refactor is behavior-preserving.
    const expected = [
      "init",
      "run",
      "inspect",
      "export",
      "auth",
      "extension",
      "share",
      "sandbox",
      "mascots",
      "themes",
      "doctor",
      "skins",
      "character",
      "companion",
    ];
    for (const name of expected) {
      expect(SUBCOMMANDS).toContain(name);
    }
  });
});
