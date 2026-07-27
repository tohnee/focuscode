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

  it("returns VISUAL indicator when in visual-char mode", () => {
    const state: VimState = { mode: "visual", visualAnchor: { row: 0, col: 0 } };
    const indicator = renderVimIndicator(state, theme);
    expect(indicator).toContain("-- VISUAL --");
  });

  it("returns VISUAL LINE indicator when in visual-line mode", () => {
    const state: VimState = { mode: "visual-line", visualAnchor: { row: 0, col: 0 } };
    const indicator = renderVimIndicator(state, theme);
    expect(indicator).toContain("-- VISUAL LINE --");
  });
});

// ─── Visual mode ──────────────────────────────────────────────────────────────

describe("vimHandleKey — entering visual mode", () => {
  it("v enters visual-char mode with anchor at current cursor", () => {
    const result = vimHandleKey(createVimState(), "v");
    expect(result.state.mode).toBe("visual");
    expect(result.state.visualAnchor).toEqual({ row: 0, col: 0 });
    expect(result.action).toBe("noop");
  });

  it("V enters visual-line mode with anchor at current cursor", () => {
    const result = vimHandleKey(createVimState(), "V");
    expect(result.state.mode).toBe("visual-line");
    expect(result.state.visualAnchor).toEqual({ row: 0, col: 0 });
    expect(result.action).toBe("noop");
  });
});

describe("vimHandleKey — visual mode navigation", () => {
  it("h/j/k/l in visual mode move cursor (action emitted) and stay in visual", () => {
    const visual: VimState = { mode: "visual", visualAnchor: { row: 0, col: 0 } };
    const r = vimHandleKey(visual, "l");
    expect(r.state.mode).toBe("visual");
    expect(r.action).toBe("cursor_right");
    // Anchor must be preserved across navigation.
    expect(r.state.visualAnchor).toEqual({ row: 0, col: 0 });
  });

  it("w/b in visual mode move cursor and stay in visual", () => {
    const visual: VimState = { mode: "visual", visualAnchor: { row: 0, col: 0 } };
    expect(vimHandleKey(visual, "w").action).toBe("word_right");
    expect(vimHandleKey(visual, "b").action).toBe("word_left");
  });

  it("0/$ in visual mode move cursor and stay in visual", () => {
    const visual: VimState = { mode: "visual", visualAnchor: { row: 0, col: 0 } };
    expect(vimHandleKey(visual, "0").action).toBe("home");
    expect(vimHandleKey(visual, "$").action).toBe("end");
  });

  it("G in visual mode moves cursor to bottom and stays in visual", () => {
    const visual: VimState = { mode: "visual", visualAnchor: { row: 0, col: 0 } };
    const r = vimHandleKey(visual, "G");
    expect(r.action).toBe("goto_bottom");
    expect(r.state.mode).toBe("visual");
  });

  it("gg sequence in visual mode moves cursor to top and stays in visual", () => {
    const visual: VimState = { mode: "visual", visualAnchor: { row: 5, col: 0 } };
    const first = vimHandleKey(visual, "g");
    expect(first.action).toBe("noop");
    expect(first.state.pendingOperator).toBe("g");
    expect(first.state.mode).toBe("visual");
    const second = vimHandleKey(first.state, "g");
    expect(second.action).toBe("goto_top");
    expect(second.state.mode).toBe("visual");
  });
});

describe("vimHandleKey — visual mode operators", () => {
  it("d in visual mode → delete_selection and returns to normal", () => {
    const visual: VimState = { mode: "visual", visualAnchor: { row: 0, col: 0 } };
    const r = vimHandleKey(visual, "d");
    expect(r.action).toBe("delete_selection");
    expect(r.state.mode).toBe("normal");
    expect(r.state.visualAnchor).toBeUndefined();
  });

  it("x in visual mode → delete_selection and returns to normal", () => {
    const visual: VimState = { mode: "visual", visualAnchor: { row: 0, col: 0 } };
    const r = vimHandleKey(visual, "x");
    expect(r.action).toBe("delete_selection");
    expect(r.state.mode).toBe("normal");
  });

  it("y in visual mode → yank_selection and returns to normal", () => {
    const visual: VimState = { mode: "visual", visualAnchor: { row: 0, col: 0 } };
    const r = vimHandleKey(visual, "y");
    expect(r.action).toBe("yank_selection");
    expect(r.state.mode).toBe("normal");
  });

  it("Esc in visual mode cancels selection and returns to normal", () => {
    const visual: VimState = { mode: "visual", visualAnchor: { row: 0, col: 0 } };
    const r = vimHandleKey(visual, "\u001b");
    expect(r.action).toBe("noop");
    expect(r.state.mode).toBe("normal");
    expect(r.state.visualAnchor).toBeUndefined();
  });

  it("d in visual-line mode → delete_selection_lines", () => {
    const visual: VimState = { mode: "visual-line", visualAnchor: { row: 0, col: 0 } };
    const r = vimHandleKey(visual, "d");
    expect(r.action).toBe("delete_selection_lines");
    expect(r.state.mode).toBe("normal");
  });

  it("y in visual-line mode → yank_selection_lines", () => {
    const visual: VimState = { mode: "visual-line", visualAnchor: { row: 0, col: 0 } };
    const r = vimHandleKey(visual, "y");
    expect(r.action).toBe("yank_selection_lines");
    expect(r.state.mode).toBe("normal");
  });
});

// ─── New normal-mode commands (keyboard efficiency) ─────────────────────────

describe("vimHandleKey — extra normal-mode commands", () => {
  it("u → undo", () => {
    expect(vimHandleKey(createVimState(), "u").action).toBe("undo");
  });

  it("D → delete_to_end_of_line", () => {
    expect(vimHandleKey(createVimState(), "D").action).toBe("delete_to_end_of_line");
  });

  it("C → change_to_end_of_line (delete + enter insert)", () => {
    const r = vimHandleKey(createVimState(), "C");
    expect(r.action).toBe("delete_to_end_of_line");
    expect(r.state.mode).toBe("insert");
  });

  it("A → enter insert at end of line", () => {
    const r = vimHandleKey(createVimState(), "A");
    expect(r.action).toBe("end");
    expect(r.state.mode).toBe("insert");
  });

  it("I → enter insert at start of line", () => {
    const r = vimHandleKey(createVimState(), "I");
    expect(r.action).toBe("home");
    expect(r.state.mode).toBe("insert");
  });

  it("dw → delete_word", () => {
    const first = vimHandleKey(createVimState(), "d");
    expect(first.state.pendingOperator).toBe("d");
    const second = vimHandleKey(first.state, "w");
    expect(second.action).toBe("delete_word");
    expect(second.state.pendingOperator).toBeUndefined();
  });

  it("cw → change_word", () => {
    const first = vimHandleKey(createVimState(), "c");
    expect(first.state.pendingOperator).toBe("c");
    const second = vimHandleKey(first.state, "w");
    expect(second.action).toBe("change_word");
    expect(second.state.mode).toBe("insert");
  });

  it("cc → change_line", () => {
    const first = vimHandleKey(createVimState(), "c");
    const second = vimHandleKey(first.state, "c");
    expect(second.action).toBe("change_line");
    expect(second.state.mode).toBe("insert");
  });

  it("~ → toggle_case", () => {
    expect(vimHandleKey(createVimState(), "~").action).toBe("toggle_case");
  });
});

// ─── Text objects (ciw/daw/di"/ca( etc.) ────────────────────────────────────

describe("vimHandleKey — word text objects", () => {
  it("diw → delete_text_object inner word", () => {
    const d = vimHandleKey(createVimState(), "d");
    const i = vimHandleKey(d.state, "i");
    expect(i.state.pendingTextObject).toBe("i");
    const w = vimHandleKey(i.state, "w");
    expect(w.action).toBe("delete_text_object");
    expect(w.textObject).toEqual({ modifier: "i", target: "w" });
    expect(w.state.mode).toBe("normal");
    expect(w.state.pendingOperator).toBeUndefined();
    expect(w.state.pendingTextObject).toBeUndefined();
  });

  it("daw → delete_text_object around word", () => {
    const d = vimHandleKey(createVimState(), "d");
    const a = vimHandleKey(d.state, "a");
    expect(a.state.pendingTextObject).toBe("a");
    const w = vimHandleKey(a.state, "w");
    expect(w.action).toBe("delete_text_object");
    expect(w.textObject).toEqual({ modifier: "a", target: "w" });
  });

  it("ciw → change_text_object inner word (enters insert)", () => {
    const c = vimHandleKey(createVimState(), "c");
    const i = vimHandleKey(c.state, "i");
    const w = vimHandleKey(i.state, "w");
    expect(w.action).toBe("change_text_object");
    expect(w.textObject).toEqual({ modifier: "i", target: "w" });
    expect(w.state.mode).toBe("insert");
  });

  it("caw → change_text_object around word (enters insert)", () => {
    const c = vimHandleKey(createVimState(), "c");
    const a = vimHandleKey(c.state, "a");
    const w = vimHandleKey(a.state, "w");
    expect(w.action).toBe("change_text_object");
    expect(w.textObject).toEqual({ modifier: "a", target: "w" });
    expect(w.state.mode).toBe("insert");
  });

  it("yiw → yank_text_object inner word", () => {
    const y = vimHandleKey(createVimState(), "y");
    const i = vimHandleKey(y.state, "i");
    const w = vimHandleKey(i.state, "w");
    expect(w.action).toBe("yank_text_object");
    expect(w.textObject).toEqual({ modifier: "i", target: "w" });
    expect(w.state.mode).toBe("normal");
  });

  it("yaw → yank_text_object around word", () => {
    const y = vimHandleKey(createVimState(), "y");
    const a = vimHandleKey(y.state, "a");
    const w = vimHandleKey(a.state, "w");
    expect(w.action).toBe("yank_text_object");
    expect(w.textObject).toEqual({ modifier: "a", target: "w" });
  });
});

describe("vimHandleKey — quote text objects", () => {
  it('di" → delete_text_object inner double-quote', () => {
    const d = vimHandleKey(createVimState(), "d");
    const i = vimHandleKey(d.state, "i");
    const q = vimHandleKey(i.state, '"');
    expect(q.action).toBe("delete_text_object");
    expect(q.textObject).toEqual({ modifier: "i", target: '"' });
  });

  it("da' → delete_text_object around single-quote", () => {
    const d = vimHandleKey(createVimState(), "d");
    const a = vimHandleKey(d.state, "a");
    const q = vimHandleKey(a.state, "'");
    expect(q.action).toBe("delete_text_object");
    expect(q.textObject).toEqual({ modifier: "a", target: "'" });
  });

  it('ci" → change_text_object inner double-quote (enters insert)', () => {
    const c = vimHandleKey(createVimState(), "c");
    const i = vimHandleKey(c.state, "i");
    const q = vimHandleKey(i.state, '"');
    expect(q.action).toBe("change_text_object");
    expect(q.textObject).toEqual({ modifier: "i", target: '"' });
    expect(q.state.mode).toBe("insert");
  });
});

describe("vimHandleKey — parenthesis text objects", () => {
  it("di( → delete_text_object inner paren", () => {
    const d = vimHandleKey(createVimState(), "d");
    const i = vimHandleKey(d.state, "i");
    const p = vimHandleKey(i.state, "(");
    expect(p.action).toBe("delete_text_object");
    expect(p.textObject).toEqual({ modifier: "i", target: "(" });
  });

  it("di) → delete_text_object inner paren (closing also works)", () => {
    const d = vimHandleKey(createVimState(), "d");
    const i = vimHandleKey(d.state, "i");
    const p = vimHandleKey(i.state, ")");
    expect(p.action).toBe("delete_text_object");
    expect(p.textObject).toEqual({ modifier: "i", target: "(" });
  });

  it("ca( → change_text_object around paren (enters insert)", () => {
    const c = vimHandleKey(createVimState(), "c");
    const a = vimHandleKey(c.state, "a");
    const p = vimHandleKey(a.state, "(");
    expect(p.action).toBe("change_text_object");
    expect(p.textObject).toEqual({ modifier: "a", target: "(" });
    expect(p.state.mode).toBe("insert");
  });

  it("da{ → delete_text_object around curly brace", () => {
    const d = vimHandleKey(createVimState(), "d");
    const a = vimHandleKey(d.state, "a");
    const b = vimHandleKey(a.state, "{");
    expect(b.action).toBe("delete_text_object");
    expect(b.textObject).toEqual({ modifier: "a", target: "{" });
  });
});

describe("vimHandleKey — text object cancellation", () => {
  it("Esc cancels pending text object modifier", () => {
    const d = vimHandleKey(createVimState(), "d");
    const i = vimHandleKey(d.state, "i");
    const esc = vimHandleKey(i.state, "\u001b");
    expect(esc.state.mode).toBe("normal");
    expect(esc.state.pendingOperator).toBeUndefined();
    expect(esc.state.pendingTextObject).toBeUndefined();
  });

  it("unrelated key after i cancels text object and processes fresh", () => {
    const d = vimHandleKey(createVimState(), "d");
    const i = vimHandleKey(d.state, "i");
    // "x" is not a valid text object target → cancel and process as delete_char
    const x = vimHandleKey(i.state, "x");
    expect(x.state.pendingOperator).toBeUndefined();
    expect(x.state.pendingTextObject).toBeUndefined();
  });
});

// ─── High-frequency operations补齐 (r, P, O, J, e) ─────────────────────────

describe("vimHandleKey — high-frequency operations", () => {
  it("P → paste_before", () => {
    const result = vimHandleKey(createVimState(), "P");
    expect(result.action).toBe("paste_before");
    expect(result.state.mode).toBe("normal");
  });

  it("O → newline_above (enter insert)", () => {
    const result = vimHandleKey(createVimState(), "O");
    expect(result.action).toBe("newline_above");
    expect(result.state.mode).toBe("insert");
  });

  it("J → join_lines", () => {
    const result = vimHandleKey(createVimState(), "J");
    expect(result.action).toBe("join_lines");
    expect(result.state.mode).toBe("normal");
  });

  it("e → word_end_forward", () => {
    const result = vimHandleKey(createVimState(), "e");
    expect(result.action).toBe("word_end_forward");
    expect(result.state.mode).toBe("normal");
  });

  it("r sets pending operator, next char emits replace_char", () => {
    const pending = vimHandleKey(createVimState(), "r");
    expect(pending.action).toBe("noop");
    expect(pending.state.pendingOperator).toBe("r");

    const resolved = vimHandleKey(pending.state, "X");
    expect(resolved.action).toBe("replace_char");
    expect(resolved.state.mode).toBe("normal");
    expect(resolved.replaceChar).toBe("X");
  });

  it("r Esc cancels pending replace", () => {
    const pending = vimHandleKey(createVimState(), "r");
    const esc = vimHandleKey(pending.state, "\u001b");
    expect(esc.state.mode).toBe("normal");
    expect(esc.state.pendingOperator).toBeUndefined();
  });

  it("e in visual mode moves cursor (word_end_forward)", () => {
    const visual = vimHandleKey(createVimState(), "v");
    const result = vimHandleKey(visual.state, "e");
    expect(result.action).toBe("word_end_forward");
    expect(result.state.mode).toBe("visual");
  });
});
