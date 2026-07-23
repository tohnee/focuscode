import { describe, expect, it } from "vitest";
import { createVimState, renderVimIndicator, vimHandleKey, type VimState } from "../src/vim.js";
import { TUI_THEMES } from "../src/themes.js";

const theme = TUI_THEMES[0]!;

describe("createVimState", () => {
  it("starts in normal mode", () => {
    const state = createVimState();
    expect(state.mode).toBe("normal");
    expect(state.pendingOperator).toBeUndefined();
  });
});

describe("vimHandleKey — normal mode navigation", () => {
  it("h → cursor_left", () => {
    const result = vimHandleKey(createVimState(), "h");
    expect(result.action).toBe("cursor_left");
    expect(result.state.mode).toBe("normal");
  });

  it("j → cursor_down", () => {
    const result = vimHandleKey(createVimState(), "j");
    expect(result.action).toBe("cursor_down");
  });

  it("k → cursor_up", () => {
    const result = vimHandleKey(createVimState(), "k");
    expect(result.action).toBe("cursor_up");
  });

  it("l → cursor_right", () => {
    const result = vimHandleKey(createVimState(), "l");
    expect(result.action).toBe("cursor_right");
  });

  it("w → word_right", () => {
    const result = vimHandleKey(createVimState(), "w");
    expect(result.action).toBe("word_right");
  });

  it("b → word_left", () => {
    const result = vimHandleKey(createVimState(), "b");
    expect(result.action).toBe("word_left");
  });

  it("0 → home", () => {
    const result = vimHandleKey(createVimState(), "0");
    expect(result.action).toBe("home");
  });

  it("$ → end", () => {
    const result = vimHandleKey(createVimState(), "$");
    expect(result.action).toBe("end");
  });

  it("g then g → goto_top (two-key sequence)", () => {
    const first = vimHandleKey(createVimState(), "g");
    expect(first.action).toBe("noop");
    expect(first.state.pendingOperator).toBe("g");
    const second = vimHandleKey(first.state, "g");
    expect(second.action).toBe("goto_top");
    expect(second.state.pendingOperator).toBeUndefined();
  });

  it("G → goto_bottom", () => {
    const result = vimHandleKey(createVimState(), "G");
    expect(result.action).toBe("goto_bottom");
  });

  it("single g without follow-up waits (sets pendingOperator)", () => {
    const result = vimHandleKey(createVimState(), "g");
    expect(result.action).toBe("noop");
    expect(result.state.pendingOperator).toBe("g");
  });
});

describe("vimHandleKey — normal mode editing", () => {
  it("d then d → delete_line", () => {
    const first = vimHandleKey(createVimState(), "d");
    expect(first.action).toBe("noop");
    expect(first.state.pendingOperator).toBe("d");
    const second = vimHandleKey(first.state, "d");
    expect(second.action).toBe("delete_line");
    expect(second.state.pendingOperator).toBeUndefined();
  });

  it("y then y → yank_line", () => {
    const first = vimHandleKey(createVimState(), "y");
    expect(first.action).toBe("noop");
    const second = vimHandleKey(first.state, "y");
    expect(second.action).toBe("yank_line");
  });

  it("p → paste_after", () => {
    const result = vimHandleKey(createVimState(), "p");
    expect(result.action).toBe("paste_after");
  });

  it("x → delete_char", () => {
    const result = vimHandleKey(createVimState(), "x");
    expect(result.action).toBe("delete_char");
  });

  it("i → enter_insert", () => {
    const result = vimHandleKey(createVimState(), "i");
    expect(result.action).toBe("noop");
    expect(result.state.mode).toBe("insert");
  });

  it("a → enter_insert_after", () => {
    const result = vimHandleKey(createVimState(), "a");
    expect(result.action).toBe("cursor_right");
    expect(result.state.mode).toBe("insert");
  });

  it("o → enter_insert_newline_below", () => {
    const result = vimHandleKey(createVimState(), "o");
    expect(result.action).toBe("newline_below");
    expect(result.state.mode).toBe("insert");
  });
});

describe("vimHandleKey — pending operator cancellation", () => {
  it("Esc cancels pending operator", () => {
    const pending = vimHandleKey(createVimState(), "d");
    const cancelled = vimHandleKey(pending.state, "\u001b");
    expect(cancelled.action).toBe("noop");
    expect(cancelled.state.pendingOperator).toBeUndefined();
    expect(cancelled.state.mode).toBe("normal");
  });

  it("unrelated key cancels pending operator", () => {
    const pending = vimHandleKey(createVimState(), "d");
    const cancelled = vimHandleKey(pending.state, "x");
    expect(cancelled.state.pendingOperator).toBeUndefined();
    expect(cancelled.action).toBe("delete_char");
  });
});

describe("vimHandleKey — unknown keys", () => {
  it("unknown key in normal mode returns noop", () => {
    const result = vimHandleKey(createVimState(), "Z");
    expect(result.action).toBe("noop");
    expect(result.state.mode).toBe("normal");
  });
});

describe("renderVimIndicator", () => {
  it("returns empty string when mode is normal (default, no indicator needed)", () => {
    const state = createVimState();
    const indicator = renderVimIndicator(state, theme);
    expect(indicator).toContain("-- NORMAL --");
  });

  it("returns INSERT indicator when in insert mode", () => {
    const state: VimState = { mode: "insert" };
    const indicator = renderVimIndicator(state, theme);
    expect(indicator).toContain("-- INSERT --");
  });
});
