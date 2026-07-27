import { describe, expect, it, vi } from "vitest";
import { FullScreenTui } from "../src/app.js";
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
  it("initial layout is classic mode", () => {
    const tui = createTui();
    const snap = tui.snapshot();
    expect(snap.layout?.mode).toBe("classic");
  });

  it("setLayoutMode updates mode to split", () => {
    const tui = createTui();
    tui.setLayoutMode("split");
    const snap = tui.snapshot();
    expect(snap.layout?.mode).toBe("split");
  });

  it("cycleLayoutMode rotates classic → split → focus → wide → classic", () => {
    const tui = createTui();
    expect(tui.snapshot().layout?.mode).toBe("classic");
    tui.cycleLayoutMode();
    expect(tui.snapshot().layout?.mode).toBe("split");
    tui.cycleLayoutMode();
    expect(tui.snapshot().layout?.mode).toBe("focus");
    tui.cycleLayoutMode();
    expect(tui.snapshot().layout?.mode).toBe("wide");
    tui.cycleLayoutMode();
    expect(tui.snapshot().layout?.mode).toBe("classic");
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
    expect(tui.snapshot().layout?.mode).toBe("classic");
    void anyTui.action("cycle_layout");
    expect(tui.snapshot().layout?.mode).toBe("split");
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
