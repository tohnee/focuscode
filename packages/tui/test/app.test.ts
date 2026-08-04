import { describe, expect, it, vi } from "vitest";
import { FullScreenTui } from "../src/app.js";
import { DEFAULT_KEYMAP, mergeKeymap } from "../src/keymap.js";
import { TUI_MASCOTS } from "../src/mascots.js";
import type { ContextUsageState } from "../src/context-bar.js";
import type { SpecDecisionView, SpecProgressState } from "../src/spec-progress.js";
import { TUI_THEMES } from "../src/themes.js";

function createTui(
  overrides: {
    onSpecConfirm?: (specId: string, choices: Record<string, string>) => void;
    onSpecDecline?: (specId: string) => void;
  } = {},
): FullScreenTui {
  return new FullScreenTui({
    input: {
      isTTY: false,
      setRawMode: () => {},
      setEncoding: () => {},
      resume: () => {},
      on: () => {},
      off: () => {},
    } as never,
    output: {
      isTTY: false,
      columns: 80,
      rows: 24,
      write: () => {},
      on: () => {},
      off: () => {},
    } as never,
    model: "test/model",
    session: "test-session",
    approval: "ask",
    sandbox: "host",
    theme: TUI_THEMES[0]!,
    mascot: TUI_MASCOTS[0]!,
    onSubmit: async () => {},
    onSteer: async () => {},
    onAbort: () => {},
    ...(overrides.onSpecConfirm ? { onSpecConfirm: overrides.onSpecConfirm } : {}),
    ...(overrides.onSpecDecline ? { onSpecDecline: overrides.onSpecDecline } : {}),
  });
}

describe("FullScreenTui spec state", () => {
  it("setSpecProgress updates phase", () => {
    const tui = createTui();
    const state: SpecProgressState = { phase: "start", stages: [] };
    tui.setSpecProgress(state);
    const snap = tui.snapshot();
    expect(snap.specProgress?.phase).toBe("start");
  });

  it("updateSpecStage adds and updates stages", () => {
    const tui = createTui();
    tui.setSpecProgress({ phase: "classify", stages: [] });
    tui.updateSpecStage("classify", { status: "done", durationMs: 500, model: "test" });
    const snap = tui.snapshot();
    expect(snap.specProgress?.stages).toHaveLength(1);
    expect(snap.specProgress?.stages[0]?.name).toBe("classify");
    expect(snap.specProgress?.stages[0]?.status).toBe("done");
  });

  it("setSpecConfirmation stores pending decisions", () => {
    const tui = createTui();
    const decisions: SpecDecisionView[] = [
      {
        id: "d1",
        point: "Test?",
        severity: "critical",
        options: [{ label: "A", description: "a" }],
        selectedIndex: 0,
      },
    ];
    tui.setSpecConfirmation("spec_1", decisions);
    const snap = tui.snapshot();
    expect(snap.specConfirmation?.specId).toBe("spec_1");
    expect(snap.specConfirmation?.decisions).toHaveLength(1);
  });

  it("clearSpecConfirmation removes confirmation state", () => {
    const tui = createTui();
    tui.setSpecConfirmation("spec_1", []);
    tui.clearSpecConfirmation();
    const snap = tui.snapshot();
    expect(snap.specConfirmation).toBeUndefined();
  });

  it("getSpecConfirmationState returns current state", () => {
    const tui = createTui();
    tui.setSpecConfirmation("spec_1", []);
    const state = tui.getSpecConfirmationState();
    expect(state?.specId).toBe("spec_1");
  });

  it("setSpecDraft updates specId and topic", () => {
    const tui = createTui();
    tui.setSpecDraft({ specId: "spec_42", topic: "kernel image" });
    const snap = tui.snapshot();
    expect(snap.specProgress?.specId).toBe("spec_42");
    expect(snap.specProgress?.topic).toBe("kernel image");
  });

  it("getSpecStartTime returns startTime from spec progress", () => {
    const tui = createTui();
    const start = Date.now();
    tui.setSpecProgress({ phase: "start", stages: [], startTime: start });
    expect(tui.getSpecStartTime()).toBe(start);
  });
});

describe("FullScreenTui spec confirmation navigation", () => {
  it("confirmSpecNavigation option_down advances selected index", () => {
    const tui = createTui();
    tui.setSpecConfirmation("spec_1", [
      {
        id: "d1",
        point: "Pick one",
        severity: "critical",
        options: [
          { label: "A", description: "first" },
          { label: "B", description: "second" },
        ],
        selectedIndex: 0,
      },
    ]);
    tui.confirmSpecNavigation("option_down");
    const state = tui.getSpecConfirmationState();
    expect(state?.decisions[0]?.selectedIndex).toBe(1);
  });

  it("confirmSpecNavigation confirm fires onSpecConfirm with choices", () => {
    const onConfirm = vi.fn();
    const tui = createTui({ onSpecConfirm: onConfirm });
    tui.setSpecConfirmation("spec_1", [
      {
        id: "d1",
        point: "Pick one",
        severity: "critical",
        options: [
          { label: "A", description: "first" },
          { label: "B", description: "second" },
        ],
        selectedIndex: 0,
      },
    ]);
    tui.confirmSpecNavigation("confirm");
    expect(onConfirm).toHaveBeenCalledWith("spec_1", { d1: "A" });
    expect(tui.getSpecConfirmationState()).toBeUndefined();
  });

  it("confirmSpecNavigation cancel fires onSpecDecline", () => {
    const onDecline = vi.fn();
    const tui = createTui({ onSpecDecline: onDecline });
    tui.setSpecConfirmation("spec_1", [
      {
        id: "d1",
        point: "Pick",
        severity: "major",
        options: [{ label: "A", description: "a" }],
        selectedIndex: 0,
      },
    ]);
    tui.confirmSpecNavigation("cancel");
    expect(onDecline).toHaveBeenCalledWith("spec_1");
    expect(tui.getSpecConfirmationState()).toBeUndefined();
  });
});

describe("FullScreenTui reasoning state", () => {
  it("appendReasoning accumulates text", () => {
    const tui = createTui();
    tui.appendReasoning("hello ");
    tui.appendReasoning("world");
    const snap = tui.snapshot();
    expect(snap.reasoning).toBe("hello world");
  });

  it("clearReasoning resets to undefined", () => {
    const tui = createTui();
    tui.appendReasoning("thinking...");
    tui.clearReasoning();
    const snap = tui.snapshot();
    expect(snap.reasoning).toBeUndefined();
  });

  it("setReasoningExpanded toggles expanded flag", () => {
    const tui = createTui();
    tui.setReasoningExpanded(true);
    const snap = tui.snapshot();
    expect(snap.reasoningExpanded).toBe(true);
  });

  it("toggle_reasoning action flips expanded state", () => {
    const tui = createTui();
    // Access private action via type cast for testing
    const any_tui = tui as unknown as { action: (a: string) => Promise<void> };
    expect(tui.snapshot().reasoningExpanded).toBeUndefined();
    any_tui.action("toggle_reasoning");
    expect(tui.snapshot().reasoningExpanded).toBe(true);
    any_tui.action("toggle_reasoning");
    expect(tui.snapshot().reasoningExpanded).toBe(false);
  });
});

describe("FullScreenTui cache metrics", () => {
  it("setCacheMetrics stores metrics and snapshot exposes them", () => {
    const tui = createTui();
    tui.setCacheMetrics({ hitRatio: 0.4, savedUsd: 0.72 });
    const snap = tui.snapshot();
    expect(snap.cacheMetrics).toEqual({ hitRatio: 0.4, savedUsd: 0.72 });
  });

  it("cacheMetrics is undefined until set", () => {
    const tui = createTui();
    expect(tui.snapshot().cacheMetrics).toBeUndefined();
  });
});

describe("FullScreenTui context usage", () => {
  it("setContextUsage stores token counts", () => {
    const tui = createTui();
    const ctx: ContextUsageState = { usedTokens: 5000, maxTokens: 100000 };
    tui.setContextUsage(ctx);
    const snap = tui.snapshot();
    expect(snap.contextUsage?.usedTokens).toBe(5000);
    expect(snap.contextUsage?.maxTokens).toBe(100000);
  });
});

describe("FullScreenTui search state", () => {
  it("openSearch activates search with empty query", () => {
    const tui = createTui();
    tui.openSearch();
    const snap = tui.snapshot();
    expect(snap.search?.visible).toBe(true);
    expect(snap.search?.query).toBe("");
    expect(snap.search?.matches).toEqual([]);
  });

  it("updateSearchQuery updates query and recomputes matches against transcript", () => {
    const tui = createTui();
    tui.addMessage("user", "Hello world");
    tui.addMessage("assistant", "Hi there");
    tui.addMessage("user", "Search for hello");
    tui.openSearch();
    tui.updateSearchQuery("hello");
    const snap = tui.snapshot();
    expect(snap.search?.query).toBe("hello");
    expect(snap.search?.matches).toEqual([0, 2]);
    expect(snap.search?.currentIndex).toBe(0);
  });

  it("advanceSearch moves through matches with wrap-around", () => {
    const tui = createTui();
    tui.addMessage("user", "Hello world");
    tui.addMessage("user", "Hello again");
    tui.openSearch();
    tui.updateSearchQuery("hello");
    tui.advanceSearch(1);
    expect(tui.snapshot().search?.currentIndex).toBe(1);
    tui.advanceSearch(1);
    expect(tui.snapshot().search?.currentIndex).toBe(0);
  });

  it("closeSearch resets to invisible with cleared state", () => {
    const tui = createTui();
    tui.addMessage("user", "Hello");
    tui.openSearch();
    tui.updateSearchQuery("hello");
    tui.closeSearch();
    const snap = tui.snapshot();
    expect(snap.search?.visible).toBe(false);
    expect(snap.search?.query).toBe("");
    expect(snap.search?.matches).toEqual([]);
  });

  it("getSearchState returns current search snapshot", () => {
    const tui = createTui();
    tui.openSearch();
    tui.updateSearchQuery("xyz");
    const state = tui.getSearchState();
    expect(state?.visible).toBe(true);
    expect(state?.query).toBe("xyz");
  });
});

describe("FullScreenTui command palette state", () => {
  it("openPalette activates palette with all commands", () => {
    const tui = createTui();
    tui.openPalette();
    const snap = tui.snapshot();
    expect(snap.palette?.visible).toBe(true);
    expect(snap.palette?.query).toBe("");
    expect(snap.palette?.filtered.length).toBeGreaterThan(0);
  });

  it("updatePaletteQuery filters commands", () => {
    const tui = createTui();
    tui.openPalette();
    tui.updatePaletteQuery("vim");
    const snap = tui.snapshot();
    expect(snap.palette?.query).toBe("vim");
    expect(snap.palette?.filtered.length).toBeGreaterThan(0);
    expect(snap.palette?.filtered.every((c) => c.label.toLowerCase().includes("vim"))).toBe(true);
  });

  it("movePaletteCursor advances selected index with wrap-around", () => {
    const tui = createTui();
    tui.openPalette();
    const initial = tui.snapshot().palette?.selectedIndex ?? 0;
    tui.movePaletteCursor(1);
    expect(tui.snapshot().palette?.selectedIndex).toBe(initial + 1);
  });

  it("confirmPaletteSelection fires onPaletteCommand with selected command", () => {
    const onPaletteCommand = vi.fn();
    const tui = createTui();
    tui.setPaletteCallback(onPaletteCommand);
    tui.openPalette();
    tui.updatePaletteQuery("vim");
    tui.confirmPaletteSelection();
    expect(onPaletteCommand).toHaveBeenCalledTimes(1);
    const cmd = onPaletteCommand.mock.calls[0]?.[0];
    expect(cmd?.id).toBe("vim:toggle");
    // palette is closed after confirmation
    expect(tui.snapshot().palette?.visible).toBe(false);
  });

  it("closePalette resets to invisible", () => {
    const tui = createTui();
    tui.openPalette();
    tui.updatePaletteQuery("foo");
    tui.closePalette();
    const snap = tui.snapshot();
    expect(snap.palette?.visible).toBe(false);
    expect(snap.palette?.query).toBe("");
  });
});

describe("FullScreenTui vim mode", () => {
  it("setVimEnabled toggles vim mode flag", () => {
    const tui = createTui();
    expect(tui.getVimState()).toBeUndefined();
    tui.setVimEnabled(true);
    expect(tui.getVimState()?.mode).toBe("normal");
    tui.setVimEnabled(false);
    expect(tui.getVimState()).toBeUndefined();
  });

  it("vim normal mode intercepts input via feedInput", () => {
    const tui = createTui();
    tui.setVimEnabled(true);
    // Type 'h' in normal mode → should move cursor left, not insert text
    const before = tui.snapshot().input;
    void tui.feedInputForTest("h");
    const after = tui.snapshot().input;
    // Input buffer should not change because 'h' is a motion, not an insert
    expect(after).toBe(before);
  });

  it("vim 'i' enters insert mode allowing text input", () => {
    const tui = createTui();
    tui.setVimEnabled(true);
    void tui.feedInputForTest("i");
    expect(tui.getVimState()?.mode).toBe("insert");
    void tui.feedInputForTest("x");
    expect(tui.snapshot().input).toBe("x");
  });

  it("vim Esc returns from insert to normal mode", () => {
    const tui = createTui();
    tui.setVimEnabled(true);
    void tui.feedInputForTest("i");
    expect(tui.getVimState()?.mode).toBe("insert");
    void tui.feedInputForTest("\u001b");
    expect(tui.getVimState()?.mode).toBe("normal");
  });

  it("vim dd deletes the current line", () => {
    const tui = createTui();
    tui.setVimEnabled(true);
    // First enter insert mode, type text, return to normal, then dd
    void tui.feedInputForTest("i");
    void tui.feedInputForTest("hello");
    void tui.feedInputForTest("\u001b");
    void tui.feedInputForTest("d");
    void tui.feedInputForTest("d");
    expect(tui.snapshot().input).toBe("");
  });

  it("toggle_vim action toggles vim mode", () => {
    const tui = createTui();
    const anyTui = tui as unknown as { action: (a: string) => Promise<void> };
    expect(tui.getVimState()).toBeUndefined();
    void anyTui.action("toggle_vim");
    expect(tui.getVimState()?.mode).toBe("normal");
    void anyTui.action("toggle_vim");
    expect(tui.getVimState()).toBeUndefined();
  });
});

describe("FullScreenTui layout state", () => {
  it("initial layout is workbench mode", () => {
    const tui = createTui();
    const snap = tui.snapshot();
    expect(snap.layout?.mode).toBe("workbench");
  });

  it("setTheme switches by name and cycles when omitted", () => {
    const tui = createTui();
    const first = tui.snapshot().theme.name;
    const applied = tui.setTheme();
    const index = TUI_THEMES.findIndex((item) => item.name === first);
    expect(applied).toBe(TUI_THEMES[(index + 1) % TUI_THEMES.length]!.name);
    expect(tui.snapshot().theme.name).toBe(applied);
    const named = tui.setTheme(first);
    expect(named).toBe(first);
    expect(tui.snapshot().theme.name).toBe(first);
  });

  it("setTheme returns empty string for an unknown theme name", () => {
    const tui = createTui();
    expect(tui.setTheme("no-such-theme")).toBe("");
    expect(tui.snapshot().theme.name).not.toBe("");
  });

  it("setLayoutMode updates mode to split", () => {
    const tui = createTui();
    tui.setLayoutMode("split");
    const snap = tui.snapshot();
    expect(snap.layout?.mode).toBe("split");
  });

  it("cycleLayoutMode rotates workbench → classic → split → focus → wide → minimal", () => {
    const tui = createTui();
    expect(tui.snapshot().layout?.mode).toBe("workbench");
    tui.cycleLayoutMode();
    expect(tui.snapshot().layout?.mode).toBe("classic");
    tui.cycleLayoutMode();
    expect(tui.snapshot().layout?.mode).toBe("split");
    tui.cycleLayoutMode();
    expect(tui.snapshot().layout?.mode).toBe("focus");
    tui.cycleLayoutMode();
    expect(tui.snapshot().layout?.mode).toBe("wide");
    tui.cycleLayoutMode();
    expect(tui.snapshot().layout?.mode).toBe("minimal");
    tui.cycleLayoutMode();
    expect(tui.snapshot().layout?.mode).toBe("workbench");
  });

  it("setLayoutMode split makes sidebar panes visible", () => {
    const tui = createTui();
    tui.setLayoutMode("split");
    const snap = tui.snapshot();
    const todoPane = snap.layout?.panes.find((p) => p.id === "todo");
    expect(todoPane?.visible).toBe(true);
  });

  it("setLayoutMode focus hides sidebar panes", () => {
    const tui = createTui();
    tui.setLayoutMode("focus");
    const snap = tui.snapshot();
    const todoPane = snap.layout?.panes.find((p) => p.id === "todo");
    expect(todoPane?.visible).toBe(false);
  });

  it("getLayoutState returns current layout snapshot", () => {
    const tui = createTui();
    tui.setLayoutMode("wide");
    const layout = tui.getLayoutState();
    expect(layout.mode).toBe("wide");
  });

  it("cycle_layout action cycles layout mode", () => {
    const tui = createTui();
    const anyTui = tui as unknown as { action: (a: string) => Promise<void> };
    expect(tui.snapshot().layout?.mode).toBe("workbench");
    void anyTui.action("cycle_layout");
    expect(tui.snapshot().layout?.mode).toBe("classic");
  });
});

describe("FullScreenTui todo panel state", () => {
  it("initial todo panel is empty and visible", () => {
    const tui = createTui();
    const snap = tui.snapshot();
    expect(snap.todoPanel?.items).toEqual([]);
    expect(snap.todoPanel?.visible).toBe(true);
  });

  it("setTodoItems replaces items", () => {
    const tui = createTui();
    tui.setTodoItems([
      { id: "1", content: "Task A", status: "pending", priority: "high" },
      { id: "2", content: "Task B", status: "completed", priority: "low" },
    ]);
    const snap = tui.snapshot();
    expect(snap.todoPanel?.items).toHaveLength(2);
    expect(snap.todoPanel?.items[0]?.content).toBe("Task A");
  });

  it("addTodoItem appends a new item", () => {
    const tui = createTui();
    tui.addTodoItem("New task", "medium");
    const snap = tui.snapshot();
    expect(snap.todoPanel?.items).toHaveLength(1);
    expect(snap.todoPanel?.items[0]?.content).toBe("New task");
    expect(snap.todoPanel?.items[0]?.status).toBe("pending");
  });

  it("updateTodoStatus changes status by id", () => {
    const tui = createTui();
    tui.setTodoItems([{ id: "t1", content: "Task", status: "pending", priority: "medium" }]);
    tui.updateTodoStatus("t1", "completed");
    const snap = tui.snapshot();
    expect(snap.todoPanel?.items[0]?.status).toBe("completed");
  });

  it("removeTodoItem removes by id", () => {
    const tui = createTui();
    tui.setTodoItems([
      { id: "t1", content: "Keep", status: "pending", priority: "medium" },
      { id: "t2", content: "Remove", status: "pending", priority: "medium" },
    ]);
    tui.removeTodoItem("t2");
    const snap = tui.snapshot();
    expect(snap.todoPanel?.items).toHaveLength(1);
    expect(snap.todoPanel?.items[0]?.id).toBe("t1");
  });

  it("toggleTodoPanel toggles visibility", () => {
    const tui = createTui();
    expect(tui.snapshot().todoPanel?.visible).toBe(true);
    tui.toggleTodoPanel();
    expect(tui.snapshot().todoPanel?.visible).toBe(false);
    tui.toggleTodoPanel();
    expect(tui.snapshot().todoPanel?.visible).toBe(true);
  });

  it("toggle_todo_panel action toggles visibility", () => {
    const tui = createTui();
    const anyTui = tui as unknown as { action: (a: string) => Promise<void> };
    expect(tui.snapshot().todoPanel?.visible).toBe(true);
    void anyTui.action("toggle_todo_panel");
    expect(tui.snapshot().todoPanel?.visible).toBe(false);
  });

  it("getTodoPanelState returns current snapshot", () => {
    const tui = createTui();
    tui.addTodoItem("Task", "high");
    const state = tui.getTodoPanelState();
    expect(state.items).toHaveLength(1);
    // Mutating returned snapshot must not affect internal state
    state.items.push({ id: "x", content: "hack", status: "pending", priority: "low" });
    expect(tui.snapshot().todoPanel?.items).toHaveLength(1);
  });
});

// ─── Tree panel integration (P1-4 会话树可视化 pane) ──────────────────────

describe("FullScreenTui tree panel integration", () => {
  it("treePanel starts hidden with no nodes", () => {
    const tui = createTui();
    const snap = tui.snapshot();
    expect(snap.treePanel?.visible).toBe(false);
    expect(snap.treePanel?.nodes).toEqual([]);
  });

  it("toggleTreePanel flips visibility and syncs layout pane", () => {
    const tui = createTui();
    expect(tui.snapshot().treePanel?.visible).toBe(false);
    tui.toggleTreePanel();
    expect(tui.snapshot().treePanel?.visible).toBe(true);
    // Layout pane should also be visible
    const layout = tui.getLayoutState();
    const treePane = layout.panes.find((p) => p.id === "tree");
    expect(treePane?.visible).toBe(true);
    // Toggle back off
    tui.toggleTreePanel();
    expect(tui.snapshot().treePanel?.visible).toBe(false);
    expect(tui.getLayoutState().panes.find((p) => p.id === "tree")?.visible).toBe(false);
  });

  it("toggle_tree_panel action toggles visibility", () => {
    const tui = createTui();
    const anyTui = tui as unknown as { action: (a: string) => Promise<void> };
    expect(tui.snapshot().treePanel?.visible).toBe(false);
    void anyTui.action("toggle_tree_panel");
    expect(tui.snapshot().treePanel?.visible).toBe(true);
    void anyTui.action("toggle_tree_panel");
    expect(tui.snapshot().treePanel?.visible).toBe(false);
  });

  it("setSessionTree builds tree from flat session list", () => {
    const tui = createTui();
    tui.setSessionTree([
      {
        sessionId: "s1",
        name: "Main session",
        model: "test/model",
        createdAt: "2026-07-29T00:00:00Z",
      },
      {
        sessionId: "s2",
        name: "Fork",
        model: "test/model",
        createdAt: "2026-07-29T01:00:00Z",
        forkedFrom: { sessionId: "s1" },
      },
    ]);
    const state = tui.getTreePanelState();
    expect(state.nodes).toHaveLength(1);
    expect(state.nodes[0]?.sessionId).toBe("s1");
    expect(state.nodes[0]?.children).toHaveLength(1);
    expect(state.nodes[0]?.children[0]?.sessionId).toBe("s2");
    expect(state.nodes[0]?.children[0]?.depth).toBe(1);
  });

  it("setSessionTree with empty array clears nodes", () => {
    const tui = createTui();
    tui.setSessionTree([
      {
        sessionId: "s1",
        name: "Main",
        model: "m",
        createdAt: "2026-07-29T00:00:00Z",
      },
    ]);
    expect(tui.getTreePanelState().nodes).toHaveLength(1);
    tui.setSessionTree([]);
    expect(tui.getTreePanelState().nodes).toEqual([]);
  });

  it("getTreePanelState returns defensive copy", () => {
    const tui = createTui();
    tui.setSessionTree([
      {
        sessionId: "s1",
        name: "Main",
        model: "m",
        createdAt: "2026-07-29T00:00:00Z",
      },
    ]);
    const state = tui.getTreePanelState();
    // Mutating returned snapshot must not affect internal state
    state.nodes.push({
      sessionId: "hack",
      name: "hack",
      model: "hack",
      createdAt: "2026-07-29T00:00:00Z",
      depth: 0,
      children: [],
    });
    expect(tui.getTreePanelState().nodes).toHaveLength(1);
  });

  it("setLayoutMode syncs treePanel visibility", () => {
    const tui = createTui();
    // Make tree visible first
    tui.toggleTreePanel();
    expect(tui.snapshot().treePanel?.visible).toBe(true);
    // Switch to classic (hides sidebar)
    tui.setLayoutMode("classic");
    expect(tui.snapshot().treePanel?.visible).toBe(false);
    // Switch to split (shows sidebar)
    tui.setLayoutMode("split");
    expect(tui.snapshot().treePanel?.visible).toBe(true);
  });

  it("cycleSidebarFocus includes tree pane", () => {
    const tui = createTui();
    // Enable tree panel only (todo is on by default, turn it off)
    tui.toggleTodoPanel();
    tui.toggleTreePanel();
    // Cycle from input → tree (since todo is off, tree is first visible sidebar pane)
    tui.cycleSidebarFocus();
    expect(tui.snapshot().activePane).toBe("tree");
    // Cycle back to input
    tui.cycleSidebarFocus();
    expect(tui.snapshot().activePane).toBe("input");
  });

  it("paneSelection includes tree field", () => {
    const tui = createTui();
    const snap = tui.snapshot();
    expect(snap.paneSelection).toHaveProperty("tree");
    expect(typeof snap.paneSelection?.tree).toBe("number");
  });

  it("alt+y keybinding maps to toggle_tree_panel", () => {
    // Verify the default keymap includes the new binding
    expect(DEFAULT_KEYMAP["alt+y"]).toBe("toggle_tree_panel");
  });

  it("toggle_tree_panel is a valid TuiAction in VALID_ACTIONS", () => {
    // Indirect verification: mergeKeymap would throw if action is invalid
    expect(() => mergeKeymap({ "alt+y": "toggle_tree_panel" })).not.toThrow();
  });

  it("snapshot includes treePanel in render state", () => {
    const tui = createTui();
    tui.setSessionTree([
      {
        sessionId: "s1",
        name: "Main",
        model: "m",
        createdAt: "2026-07-29T00:00:00Z",
      },
    ]);
    tui.toggleTreePanel();
    const snap = tui.snapshot();
    expect(snap.treePanel).toBeDefined();
    expect(snap.treePanel?.visible).toBe(true);
    expect(snap.treePanel?.nodes).toHaveLength(1);
  });

  it("toggleSidebarPane still works for spec/context panes (tree excluded)", () => {
    const tui = createTui();
    // spec pane
    tui.toggleSidebarPane("spec");
    expect(tui.getLayoutState().panes.find((p) => p.id === "spec")?.visible).toBe(true);
    tui.toggleSidebarPane("spec");
    expect(tui.getLayoutState().panes.find((p) => p.id === "spec")?.visible).toBe(false);
    // context pane
    tui.toggleSidebarPane("context");
    expect(tui.getLayoutState().panes.find((p) => p.id === "context")?.visible).toBe(true);
    tui.toggleSidebarPane("context");
    expect(tui.getLayoutState().panes.find((p) => p.id === "context")?.visible).toBe(false);
  });

  it("moveSidebarSelection works for tree pane", () => {
    const tui = createTui();
    tui.toggleTodoPanel(); // turn todo off
    tui.toggleTreePanel();
    tui.setSessionTree([
      {
        sessionId: "s1",
        name: "Main",
        model: "m",
        createdAt: "2026-07-29T00:00:00Z",
      },
      {
        sessionId: "s2",
        name: "Child",
        model: "m",
        createdAt: "2026-07-29T01:00:00Z",
        forkedFrom: { sessionId: "s1" },
      },
      {
        sessionId: "s3",
        name: "Child2",
        model: "m",
        createdAt: "2026-07-29T02:00:00Z",
        forkedFrom: { sessionId: "s1" },
      },
    ]);
    // Focus tree pane
    tui.cycleSidebarFocus();
    expect(tui.snapshot().activePane).toBe("tree");
    // Selection should start at 0
    expect(tui.snapshot().paneSelection?.tree).toBe(0);
    // Move down (3 total nodes: 1 root + 2 children; max index = 2)
    tui.moveSidebarSelection(1);
    expect(tui.snapshot().paneSelection?.tree).toBe(1);
    tui.moveSidebarSelection(1);
    expect(tui.snapshot().paneSelection?.tree).toBe(2);
    // Move down again — should clamp at max (2)
    tui.moveSidebarSelection(1);
    expect(tui.snapshot().paneSelection?.tree).toBe(2);
    // Move back up
    tui.moveSidebarSelection(-1);
    expect(tui.snapshot().paneSelection?.tree).toBe(1);
  });

  it("clampPaneSelection clamps tree selection to valid range", () => {
    const tui = createTui();
    tui.toggleTreePanel();
    tui.setSessionTree([
      {
        sessionId: "s1",
        name: "Only",
        model: "m",
        createdAt: "2026-07-29T00:00:00Z",
      },
    ]);
    // Focus tree, try to move beyond bounds
    tui.cycleSidebarFocus();
    tui.moveSidebarSelection(5);
    // Should clamp to 0 (only 1 node, max index is 0)
    expect(tui.snapshot().paneSelection?.tree).toBe(0);
  });
});

// ─── Batch 2: vim high-frequency operations via TUI ────────────────────────

describe("FullScreenTui vim P/O/J/e/r end-to-end", () => {
  it("vim 'O' inserts a new line above cursor and enters insert mode", () => {
    const tui = createTui();
    tui.setVimEnabled(true);
    // Type "abc" then Esc to normal, then O
    void tui.feedInputForTest("i");
    void tui.feedInputForTest("abc");
    void tui.feedInputForTest("\u001b");
    void tui.feedInputForTest("O");
    expect(tui.getVimState()?.mode).toBe("insert");
    const snap = tui.snapshot();
    expect(snap.input).toBe("\nabc");
    // Cursor should be on the new (empty) first line
    expect(snap.inputCursor).toEqual({ row: 0, col: 0 });
  });

  it("vim 'P' pastes yanked line above cursor", () => {
    const tui = createTui();
    tui.setVimEnabled(true);
    // Type "line1", Esc, yy (yank line), then P
    void tui.feedInputForTest("i");
    void tui.feedInputForTest("line1");
    void tui.feedInputForTest("\u001b");
    void tui.feedInputForTest("y");
    void tui.feedInputForTest("y");
    void tui.feedInputForTest("P");
    const snap = tui.snapshot();
    expect(snap.input).toBe("line1\nline1");
  });

  it("vim 'J' joins current line with next", () => {
    const tui = createTui();
    tui.setVimEnabled(true);
    // Type "foo", Esc, then 'o' to open a new line below and type "bar".
    void tui.feedInputForTest("i");
    void tui.feedInputForTest("foo");
    void tui.feedInputForTest("\u001b");
    void tui.feedInputForTest("o");
    void tui.feedInputForTest("bar");
    void tui.feedInputForTest("\u001b");
    // Cursor is on "bar" line; move up with 'k' then J
    void tui.feedInputForTest("k");
    void tui.feedInputForTest("J");
    expect(tui.snapshot().input).toBe("foo bar");
  });

  it("vim 'e' moves cursor to end of word", () => {
    const tui = createTui();
    tui.setVimEnabled(true);
    void tui.feedInputForTest("i");
    void tui.feedInputForTest("hello world");
    void tui.feedInputForTest("\u001b");
    // Cursor is at col 10 (end of "world" after Esc). Move to start with 'gg',
    // then 'e' should land on col 4 (end of "hello").
    void tui.feedInputForTest("g");
    void tui.feedInputForTest("g");
    void tui.feedInputForTest("e");
    expect(tui.snapshot().inputCursor).toEqual({ row: 0, col: 4 });
  });

  it("vim 'r' replaces the grapheme at cursor", () => {
    const tui = createTui();
    tui.setVimEnabled(true);
    void tui.feedInputForTest("i");
    void tui.feedInputForTest("hello");
    void tui.feedInputForTest("\u001b");
    // Cursor at col 4 (last 'o'). Move to col 0 with '0', then r X
    void tui.feedInputForTest("0");
    void tui.feedInputForTest("r");
    void tui.feedInputForTest("X");
    expect(tui.snapshot().input).toBe("Xello");
  });
});

// ─── Batch 2: spec decision action routing ─────────────────────────────────

describe("FullScreenTui spec decision action routing", () => {
  it("spec_option_up action routes to confirmSpecNavigation('option_up')", () => {
    const tui = createTui();
    tui.setSpecConfirmation("spec_1", [
      {
        id: "d1",
        point: "Pick one",
        severity: "critical",
        options: [
          { label: "A", description: "first" },
          { label: "B", description: "second" },
        ],
        selectedIndex: 1,
      },
    ]);
    const anyTui = tui as unknown as { action: (a: string) => Promise<void> };
    void anyTui.action("spec_option_up");
    expect(tui.getSpecConfirmationState()?.decisions[0]?.selectedIndex).toBe(0);
  });

  it("spec_option_down action routes to confirmSpecNavigation('option_down')", () => {
    const tui = createTui();
    tui.setSpecConfirmation("spec_1", [
      {
        id: "d1",
        point: "Pick one",
        severity: "critical",
        options: [
          { label: "A", description: "first" },
          { label: "B", description: "second" },
        ],
        selectedIndex: 0,
      },
    ]);
    const anyTui = tui as unknown as { action: (a: string) => Promise<void> };
    void anyTui.action("spec_option_down");
    expect(tui.getSpecConfirmationState()?.decisions[0]?.selectedIndex).toBe(1);
  });

  it("spec_confirm action fires onSpecConfirm", () => {
    const onConfirm = vi.fn();
    const tui = createTui({ onSpecConfirm: onConfirm });
    tui.setSpecConfirmation("spec_1", [
      {
        id: "d1",
        point: "Pick",
        severity: "major",
        options: [{ label: "A", description: "a" }],
        selectedIndex: 0,
      },
    ]);
    const anyTui = tui as unknown as { action: (a: string) => Promise<void> };
    void anyTui.action("spec_confirm");
    expect(onConfirm).toHaveBeenCalledWith("spec_1", { d1: "A" });
    expect(tui.getSpecConfirmationState()).toBeUndefined();
  });

  it("spec_cancel action fires onSpecDecline", () => {
    const onDecline = vi.fn();
    const tui = createTui({ onSpecDecline: onDecline });
    tui.setSpecConfirmation("spec_1", [
      {
        id: "d1",
        point: "Pick",
        severity: "major",
        options: [{ label: "A", description: "a" }],
        selectedIndex: 0,
      },
    ]);
    const anyTui = tui as unknown as { action: (a: string) => Promise<void> };
    void anyTui.action("spec_cancel");
    expect(onDecline).toHaveBeenCalledWith("spec_1");
    expect(tui.getSpecConfirmationState()).toBeUndefined();
  });

  it("spec decision actions are no-ops when no confirmation is open", () => {
    const tui = createTui();
    const anyTui = tui as unknown as { action: (a: string) => Promise<void> };
    // These should not throw and should leave state unchanged
    expect(() => void anyTui.action("spec_option_up")).not.toThrow();
    expect(() => void anyTui.action("spec_option_down")).not.toThrow();
    expect(() => void anyTui.action("spec_confirm")).not.toThrow();
    expect(() => void anyTui.action("spec_cancel")).not.toThrow();
    expect(tui.getSpecConfirmationState()).toBeUndefined();
  });
});

describe("FullScreenTui workbench keyboard (yazi × tmux)", () => {
  function withTodos(tui: FullScreenTui): void {
    tui.addTodoItem("Task A", "high");
    tui.addTodoItem("Task B", "medium");
    tui.addTodoItem("Task C", "low");
  }

  /** 带命令补全 provider 的 TUI：/ 开头时收集 slash 命令候选。 */
  function createTuiWithCompletion(): FullScreenTui {
    const tui = createTui();
    const anyTui = tui as unknown as { options: { completionProviders?: unknown[] } };
    anyTui.options.completionProviders = [
      {
        complete(prefix: string, fullText: string) {
          if (!prefix.startsWith("/") || !fullText.startsWith(prefix)) return [];
          return ["/goal", "/task", "/clear", "/permissions"].map((command) => ({
            value: command,
            description: "command",
          }));
        },
      },
    ];
    return tui;
  }

  it("ctrl+b prefix + right arrow focuses preview panel", () => {
    const tui = createTui();
    tui.feedInputForTest("\u0002"); // Ctrl+B → prefixPending
    tui.feedInputForTest("\u001b[C"); // → panel_focus_right
    expect(tui.snapshot().activePane).toBe("preview");
  });

  it("ctrl+b prefix + left arrow focuses nav panel", () => {
    const tui = createTui();
    tui.feedInputForTest("\u0002");
    tui.feedInputForTest("\u001b[D"); // → panel_focus_left
    expect(tui.snapshot().activePane).toBe("nav");
  });

  it("ctrl+b z toggles zoom (tmux style)", () => {
    const tui = createTui();
    expect(tui.snapshot().layout?.zoom).toBeUndefined();
    tui.feedInputForTest("\u0002");
    tui.feedInputForTest("z");
    expect(tui.snapshot().layout?.zoom).toBe(true);
    tui.feedInputForTest("\u0002");
    tui.feedInputForTest("z");
    expect(tui.snapshot().layout?.zoom).toBe(false);
  });

  it("ctrl+b followed by unknown key is swallowed (not typed into input)", () => {
    const tui = createTui();
    tui.feedInputForTest("\u0002");
    tui.feedInputForTest("x");
    expect(tui.snapshot().input).toBe("");
  });

  it("NORMAL mode: j/k move todo selection in nav panel", () => {
    const tui = createTui();
    withTodos(tui);
    tui.feedInputForTest("\u0002");
    tui.feedInputForTest("\u001b[D"); // focus nav
    expect(tui.snapshot().paneSelection.todo).toBe(0);
    tui.feedInputForTest("j");
    expect(tui.snapshot().paneSelection.todo).toBe(1);
    tui.feedInputForTest("j");
    expect(tui.snapshot().paneSelection.todo).toBe(2);
    tui.feedInputForTest("k");
    expect(tui.snapshot().paneSelection.todo).toBe(1);
    tui.feedInputForTest("G");
    expect(tui.snapshot().paneSelection.todo).toBe(2);
  });

  it("NORMAL mode: Enter toggles selected todo item", () => {
    const tui = createTui();
    withTodos(tui);
    tui.feedInputForTest("\u0002");
    tui.feedInputForTest("\u001b[D"); // focus nav
    tui.feedInputForTest("j"); // select Task B
    tui.feedInputForTest("\r"); // Enter → toggle
    const items = tui.snapshot().todoPanel?.items ?? [];
    expect(items[1]?.status).toBe("completed");
  });

  it("NORMAL mode: q returns to input without typing q", () => {
    const tui = createTui();
    tui.feedInputForTest("\u0002");
    tui.feedInputForTest("\u001b[D"); // focus nav
    tui.feedInputForTest("q");
    expect(tui.snapshot().activePane).toBe("input");
    expect(tui.snapshot().input).toBe("");
  });

  it("NORMAL mode: Esc returns to input from nav", () => {
    const tui = createTui();
    tui.feedInputForTest("\u0002");
    tui.feedInputForTest("\u001b[D");
    tui.feedInputForTest("\u001b");
    expect(tui.snapshot().activePane).toBe("input");
  });

  it("preview panel: q returns to input, other keys are swallowed", () => {
    const tui = createTui();
    tui.feedInputForTest("\u0002");
    tui.feedInputForTest("\u001b[C"); // focus preview
    tui.feedInputForTest("hello"); // must NOT land in input
    expect(tui.snapshot().input).toBe("");
    expect(tui.snapshot().activePane).toBe("preview");
    tui.feedInputForTest("q");
    expect(tui.snapshot().activePane).toBe("input");
  });

  it("typing / triggers completion automatically (command overlay)", () => {
    const tui = createTuiWithCompletion();
    tui.feedInputForTest("/");
    const snap = tui.snapshot();
    expect(snap.input).toBe("/");
    expect(snap.completion).toBeDefined();
    expect(snap.completion!.candidates.length).toBeGreaterThan(0);
  });

  it("typing non-slash text cancels command completion", () => {
    const tui = createTuiWithCompletion();
    tui.feedInputForTest("/");
    expect(tui.snapshot().completion).toBeDefined();
    tui.feedInputForTest("\u0015"); // Ctrl+U → kill to start, 清空输入
    tui.feedInputForTest("hello");
    expect(tui.snapshot().input).toBe("hello");
    expect(tui.snapshot().completion).toBeUndefined();
  });

  it("ctrl+/ shows keymap help in status", () => {
    const tui = createTui();
    tui.feedInputForTest("\u001f"); // Ctrl+/
    expect(tui.snapshot().status).toContain("Ctrl+B 前缀");
    expect(tui.snapshot().status).toContain("NORMAL");
  });
});
