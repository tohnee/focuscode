/**
 * TDD tests for TUI slash-command extraction (T2 fix).
 *
 * The historical `runFullScreenAgent` had a 120-line `onCommand` switch with
 * 35+ commands inline. This test verifies the extracted command builders
 * produce the same observable behavior through the SlashCommandRegistry.
 *
 * We test a representative subset (status, tools, approval, model, sessions)
 * to validate the extraction pattern. The remaining commands follow the same
 * shape and will be migrated incrementally.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createSlashCommandRegistry,
  type SlashCommandContext,
} from "../src/slash-command-registry.js";
import { buildTuiCommandRegistry, type TuiCommandState } from "../src/tui-commands.js";

function makeState(overrides: Partial<TuiCommandState> = {}): TuiCommandState {
  return {
    agent: {
      status: async () => ({ model: "fixture", provider: "custom", approval: "deny" }),
      toolDefinitions: () => [
        { name: "read", effect: "read", description: "Read a file" },
        { name: "edit", effect: "write", description: "Edit a file" },
      ],
      changeApproval: vi.fn(),
      newSession: async () => "new-session-id",
      switchSession: async () => "switched-session-id",
      forkSession: async () => "forked-session-id",
    },
    sessions: {
      list: async () => [{ sessionId: "abc123", name: "test", preview: "hello" }],
    },
    tui: {
      setApproval: vi.fn(),
      setModel: vi.fn(),
      setSession: vi.fn(),
      showToast: vi.fn(),
    },
    activeModel: { provider: "custom", model: "fixture" },
    changeModel: async () => ({ provider: "custom", model: "kimi/k2" }),
    cwd: "/tmp/test",
    ...overrides,
  };
}

describe("TUI command extraction (T2)", () => {
  it("registers all expected TUI commands", () => {
    const registry = createSlashCommandRegistry();
    buildTuiCommandRegistry(registry, makeState());
    const names = registry.listForMode("tui").map((c) => c.name);
    expect(names).toContain("status");
    expect(names).toContain("tools");
    expect(names).toContain("approval");
    expect(names).toContain("model");
    expect(names).toContain("new");
    expect(names).toContain("resume");
    expect(names).toContain("fork");
    expect(names).toContain("sessions");
  });

  it("/status returns JSON agent status", async () => {
    const registry = createSlashCommandRegistry();
    buildTuiCommandRegistry(registry, makeState());
    const result = await registry.dispatch("status", { cwd: "/tmp", args: "" });
    expect(result).toContain('"model": "fixture"');
    expect(result).toContain('"provider": "custom"');
  });

  it("/tools lists tool name, effect, and description", async () => {
    const registry = createSlashCommandRegistry();
    buildTuiCommandRegistry(registry, makeState());
    const result = await registry.dispatch("tools", { cwd: "/tmp", args: "" });
    expect(result).toContain("read");
    expect(result).toContain("write");
    expect(result).toContain("Read a file");
  });

  it("/approval without args returns usage hint", async () => {
    const registry = createSlashCommandRegistry();
    const state = makeState();
    buildTuiCommandRegistry(registry, state);
    const result = await registry.dispatch("approval", { cwd: "/tmp", args: "" });
    expect(result).toContain("Usage");
    expect(state.tui.setApproval).not.toHaveBeenCalled();
  });

  it("/approval with valid mode changes approval and updates TUI", async () => {
    const registry = createSlashCommandRegistry();
    const state = makeState();
    buildTuiCommandRegistry(registry, state);
    const result = await registry.dispatch("approval full-auto", {
      cwd: "/tmp",
      args: "full-auto",
    });
    expect(result).toContain("full-auto");
    expect(state.agent.changeApproval).toHaveBeenCalledWith("full-auto");
    expect(state.tui.setApproval).toHaveBeenCalledWith("full-auto");
    expect(state.tui.showToast).toHaveBeenCalled();
  });

  it("/model without args returns current model", async () => {
    const registry = createSlashCommandRegistry();
    buildTuiCommandRegistry(registry, makeState());
    const result = await registry.dispatch("model", { cwd: "/tmp", args: "" });
    expect(result).toBe("custom/fixture");
  });

  it("/model with arg changes model and updates TUI", async () => {
    const registry = createSlashCommandRegistry();
    const state = makeState();
    buildTuiCommandRegistry(registry, state);
    const result = await registry.dispatch("model kimi/k2", { cwd: "/tmp", args: "kimi/k2" });
    expect(result).toContain("kimi/k2");
    expect(state.tui.setModel).toHaveBeenCalledWith("custom/kimi/k2");
  });

  it("/new creates a session and updates TUI", async () => {
    const registry = createSlashCommandRegistry();
    const state = makeState();
    buildTuiCommandRegistry(registry, state);
    const result = await registry.dispatch("new", { cwd: "/tmp", args: "" });
    expect(result).toContain("new-session-id");
    expect(state.tui.setSession).toHaveBeenCalledWith("new-session-id");
  });

  it("/sessions lists all sessions with id, name, and preview", async () => {
    const registry = createSlashCommandRegistry();
    buildTuiCommandRegistry(registry, makeState());
    const result = await registry.dispatch("sessions", { cwd: "/tmp", args: "" });
    expect(result).toContain("abc123");
    expect(result).toContain("test");
    expect(result).toContain("hello");
  });

  it("/resume without args returns usage hint", async () => {
    const registry = createSlashCommandRegistry();
    buildTuiCommandRegistry(registry, makeState());
    const result = await registry.dispatch("resume", { cwd: "/tmp", args: "" });
    expect(result).toContain("Usage");
  });
});
