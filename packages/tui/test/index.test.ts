import { describe, expect, it } from "vitest";
import * as Tui from "../src/index.js";

describe("TUI public exports", () => {
  it("exports spec-progress types and functions", () => {
    expect(typeof Tui.createInitialSpecProgress).toBe("function");
    expect(typeof Tui.renderSpecProgress).toBe("function");
    expect(typeof Tui.renderSpecConfirmation).toBe("function");
    expect(typeof Tui.createSpecConfirmation).toBe("function");
    expect(typeof Tui.advanceConfirmation).toBe("function");
    expect(typeof Tui.collectChoices).toBe("function");
  });

  it("exports context-bar types and functions", () => {
    expect(typeof Tui.renderContextBar).toBe("function");
    expect(typeof Tui.formatTokens).toBe("function");
  });

  it("exports spec-progress type definitions via type re-export", () => {
    // Type-only exports cannot be checked at runtime, but importing them as
    // values would fail to compile if they were missing. This test ensures
    // the module compiles and the named exports are present.
    const sample: Tui.SpecProgressState = Tui.createInitialSpecProgress();
    expect(sample.phase).toBe("idle");
  });

  it("exports context-bar type definitions via type re-export", () => {
    const sample: Tui.ContextUsageState = { usedTokens: 0, maxTokens: 100 };
    expect(sample.maxTokens).toBe(100);
  });

  it("exports search module functions", () => {
    expect(typeof Tui.createSearchState).toBe("function");
    expect(typeof Tui.searchTranscript).toBe("function");
    expect(typeof Tui.advanceSearch).toBe("function");
    expect(typeof Tui.closeSearch).toBe("function");
    expect(typeof Tui.renderSearchBar).toBe("function");
  });

  it("exports command-palette module functions", () => {
    expect(typeof Tui.createPaletteState).toBe("function");
    expect(typeof Tui.updatePaletteQuery).toBe("function");
    expect(typeof Tui.movePaletteCursor).toBe("function");
    expect(typeof Tui.confirmPalette).toBe("function");
    expect(typeof Tui.closePalette).toBe("function");
    expect(typeof Tui.renderPalette).toBe("function");
    expect(Array.isArray(Tui.BUILTIN_COMMANDS)).toBe(true);
    expect(Tui.BUILTIN_COMMANDS.length).toBeGreaterThan(0);
  });

  it("exports vim module functions", () => {
    expect(typeof Tui.createVimState).toBe("function");
    expect(typeof Tui.vimHandleKey).toBe("function");
    expect(typeof Tui.renderVimIndicator).toBe("function");
  });

  it("exports search/palette/vim type definitions via type re-export", () => {
    const search: Tui.SearchState = Tui.createSearchState();
    expect(search.visible).toBe(false);
    const palette: Tui.PaletteState = Tui.createPaletteState();
    expect(palette.visible).toBe(false);
    const vim: Tui.VimState = Tui.createVimState();
    expect(vim.mode).toBe("normal");
  });

  it("exports layout module functions", () => {
    expect(typeof Tui.createInitialLayout).toBe("function");
    expect(typeof Tui.cycleLayoutMode).toBe("function");
    expect(typeof Tui.setLayoutMode).toBe("function");
    expect(typeof Tui.computeLayout).toBe("function");
    expect(Array.isArray(Tui.LAYOUT_MODES)).toBe(true);
    expect(Tui.LAYOUT_MODES.length).toBe(4);
  });

  it("exports todo-panel module functions", () => {
    expect(typeof Tui.createInitialTodoPanel).toBe("function");
    expect(typeof Tui.addTodoItem).toBe("function");
    expect(typeof Tui.updateTodoStatus).toBe("function");
    expect(typeof Tui.removeTodoItem).toBe("function");
    expect(typeof Tui.setTodoItems).toBe("function");
    expect(typeof Tui.clearCompletedTodos).toBe("function");
    expect(typeof Tui.renderTodoPanel).toBe("function");
  });

  it("exports layout/todo-panel type definitions via type re-export", () => {
    const layout: Tui.LayoutState = Tui.createInitialLayout();
    expect(layout.mode).toBe("classic");
    expect(layout.panes.length).toBeGreaterThan(0);
    const todo: Tui.TodoPanelState = Tui.createInitialTodoPanel();
    expect(todo.items).toEqual([]);
    expect(todo.visible).toBe(true);
  });
});
