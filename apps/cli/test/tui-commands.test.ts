/**
 * TDD tests for TUI slash-command extraction (T2 fix).
 *
 * The historical `runFullScreenAgent` had a 120-line `onCommand` switch with
 * 35+ commands inline. This test verifies the extracted command builders
 * produce the same observable behavior through the SlashCommandRegistry.
 *
 * Step 1 covered: status, tools, approval, model, new, resume, fork, sessions.
 * Step 2 covers: export, reload, skills, undo, cost, diagnostics, vim,
 *                palette, search, layout, todopanel, character, skin, init.
 * Commands needing rich mutable context (image, cheer, todo, mcp, skill, tree)
 * remain in tui.ts until their context shape is finalised.
 */
import { describe, expect, it, vi } from "vitest";
import { createSlashCommandRegistry } from "../src/slash-command-registry.js";
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
      snapshot: () => ({
        sessionId: "abc",
        activeLeafId: "e1",
        entries: [{ entryId: "e1", message: { role: "user", content: "hello" } }],
      }),
      undoCheckpoint: async () => "Restored checkpoint.",
    },
    sessions: {
      list: async () => [{ sessionId: "abc123", name: "test", preview: "hello" }],
    },
    tui: {
      setApproval: vi.fn(),
      setModel: vi.fn(),
      setSession: vi.fn(),
      showToast: vi.fn(),
      setVimEnabled: vi.fn(),
      getVimState: vi.fn(() => undefined),
      openPalette: vi.fn(),
      openSearch: vi.fn(),
      updateSearchQuery: vi.fn(),
    },
    extensions: {
      reload: async () => ["ext-a"],
    },
    resources: {
      skills: [{ name: "review", description: "Code review", content: "..." }],
    },
    activeModel: { provider: "custom", model: "fixture" },
    changeModel: async () => ({ provider: "custom", model: "kimi/k2" }),
    cwd: "/tmp/test",
    sessionCost: 0,
    sessionBudget: undefined,
    companion: { level: 1 },
    diagnosticsEnabled: true,
    formatSessionCost: () => "$0.00",
    scaffoldFocuscodeProject: async () => "Initialised.",
    describeMascots: () => "mascots list",
    describeSkins: () => "skins list",
    runLayoutSubcommand: () => "layout: classic",
    runTodoPanelSubcommand: () => "todo panel: hidden",
    runTodoSubcommand: async () => "todo: ok",
    exportSessionHtml: async () => "/tmp/exported.html",
    ...overrides,
  };
}

describe("TUI command extraction (T2)", () => {
  it("registers all expected TUI commands (step 1 + step 2)", () => {
    const registry = createSlashCommandRegistry();
    buildTuiCommandRegistry(registry, makeState());
    const names = registry.listForMode("tui").map((c) => c.name);
    for (const n of ["status", "tools", "approval", "model", "new", "resume", "fork", "sessions"]) {
      expect(names).toContain(n);
    }
    for (const n of [
      "export",
      "reload",
      "skills",
      "undo",
      "cost",
      "diagnostics",
      "vim",
      "palette",
      "search",
      "layout",
      "todopanel",
      "character",
      "skin",
      "init",
    ]) {
      expect(names).toContain(n);
    }
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

  // ─── Step 2 commands ────────────────────────────────────────────────

  it("/reload reloads extensions and reports count", async () => {
    const registry = createSlashCommandRegistry();
    buildTuiCommandRegistry(registry, makeState());
    const result = await registry.dispatch("reload", { cwd: "/tmp", args: "" });
    expect(result).toContain("Reloaded");
    expect(result).toContain("1");
  });

  it("/skills lists discovered skills", async () => {
    const registry = createSlashCommandRegistry();
    buildTuiCommandRegistry(registry, makeState());
    const result = await registry.dispatch("skills", { cwd: "/tmp", args: "" });
    expect(result).toContain("review");
    expect(result).toContain("Code review");
  });

  it("/skills reports none when empty", async () => {
    const registry = createSlashCommandRegistry();
    buildTuiCommandRegistry(registry, makeState({ resources: { skills: [] } }));
    const result = await registry.dispatch("skills", { cwd: "/tmp", args: "" });
    expect(result).toContain("No skills");
  });

  it("/undo calls agent.undoCheckpoint", async () => {
    const registry = createSlashCommandRegistry();
    buildTuiCommandRegistry(registry, makeState());
    const result = await registry.dispatch("undo", { cwd: "/tmp", args: "" });
    expect(result).toContain("Restored checkpoint.");
  });

  it("/cost formats session cost via injected formatter", async () => {
    const registry = createSlashCommandRegistry();
    buildTuiCommandRegistry(registry, makeState({ formatSessionCost: () => "$1.23" }));
    const result = await registry.dispatch("cost", { cwd: "/tmp", args: "" });
    expect(result).toBe("$1.23");
  });

  it("/diagnostics on/off/toggle updates state", async () => {
    const registry = createSlashCommandRegistry();
    const state = makeState({ diagnosticsEnabled: false });
    buildTuiCommandRegistry(registry, state);
    expect(await registry.dispatch("diagnostics on", { cwd: "/tmp", args: "on" })).toContain("on");
    expect(state.diagnosticsEnabled).toBe(true);
    expect(await registry.dispatch("diagnostics off", { cwd: "/tmp", args: "off" })).toContain(
      "off",
    );
    expect(state.diagnosticsEnabled).toBe(false);
    expect(await registry.dispatch("diagnostics", { cwd: "/tmp", args: "" })).toContain("on");
    expect(state.diagnosticsEnabled).toBe(true);
  });

  it("/vim toggles vim mode on the TUI", async () => {
    const registry = createSlashCommandRegistry();
    const state = makeState();
    state.tui.getVimState = vi.fn(() => undefined);
    buildTuiCommandRegistry(registry, state);
    const result = await registry.dispatch("vim", { cwd: "/tmp", args: "" });
    expect(result).toContain("on");
    expect(state.tui.setVimEnabled).toHaveBeenCalledWith(true);
  });

  it("/vim reports off when already enabled", async () => {
    const registry = createSlashCommandRegistry();
    const state = makeState();
    state.tui.getVimState = vi.fn(() => ({ mode: "normal" }) as never);
    buildTuiCommandRegistry(registry, state);
    const result = await registry.dispatch("vim", { cwd: "/tmp", args: "" });
    expect(result).toContain("off");
    expect(state.tui.setVimEnabled).toHaveBeenCalledWith(false);
  });

  it("/palette opens the command palette", async () => {
    const registry = createSlashCommandRegistry();
    const state = makeState();
    buildTuiCommandRegistry(registry, state);
    await registry.dispatch("palette", { cwd: "/tmp", args: "" });
    expect(state.tui.openPalette).toHaveBeenCalled();
  });

  it("/search opens search and applies query when given", async () => {
    const registry = createSlashCommandRegistry();
    const state = makeState();
    buildTuiCommandRegistry(registry, state);
    await registry.dispatch("search hello", { cwd: "/tmp", args: "hello" });
    expect(state.tui.openSearch).toHaveBeenCalled();
    expect(state.tui.updateSearchQuery).toHaveBeenCalledWith("hello");
  });

  it("/search opens search without query when no args", async () => {
    const registry = createSlashCommandRegistry();
    const state = makeState();
    buildTuiCommandRegistry(registry, state);
    await registry.dispatch("search", { cwd: "/tmp", args: "" });
    expect(state.tui.openSearch).toHaveBeenCalled();
    expect(state.tui.updateSearchQuery).not.toHaveBeenCalled();
  });

  it("/layout delegates to layout subcommand handler", async () => {
    const registry = createSlashCommandRegistry();
    const state = makeState();
    buildTuiCommandRegistry(registry, state);
    const result = await registry.dispatch("layout split", { cwd: "/tmp", args: "split" });
    expect(result).toBe("layout: classic");
  });

  it("/todopanel delegates to todo panel subcommand handler", async () => {
    const registry = createSlashCommandRegistry();
    const state = makeState();
    buildTuiCommandRegistry(registry, state);
    const result = await registry.dispatch("todopanel", { cwd: "/tmp", args: "" });
    expect(result).toBe("todo panel: hidden");
  });

  it("/character describes mascots", async () => {
    const registry = createSlashCommandRegistry();
    buildTuiCommandRegistry(registry, makeState());
    const result = await registry.dispatch("character", { cwd: "/tmp", args: "" });
    expect(result).toBe("mascots list");
  });

  it("/skin describes skins", async () => {
    const registry = createSlashCommandRegistry();
    buildTuiCommandRegistry(registry, makeState());
    const result = await registry.dispatch("skin foxy", { cwd: "/tmp", args: "foxy" });
    expect(result).toBe("skins list");
  });

  it("/init scaffolds a focuscode project", async () => {
    const registry = createSlashCommandRegistry();
    buildTuiCommandRegistry(registry, makeState());
    const result = await registry.dispatch("init", { cwd: "/tmp", args: "" });
    expect(result).toBe("Initialised.");
  });

  it("/export writes a session HTML file", async () => {
    const registry = createSlashCommandRegistry();
    buildTuiCommandRegistry(
      registry,
      makeState({ exportSessionHtml: async () => "/tmp/exported.html" }),
    );
    const result = await registry.dispatch("export", { cwd: "/tmp", args: "" });
    expect(result).toContain("/tmp/exported.html");
  });
});
