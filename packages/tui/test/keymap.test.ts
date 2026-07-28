import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_KEYMAP,
  mergeKeymap,
  parseTerminalInput,
  TerminalInputDecoder,
  type TuiKeymap,
} from "../src/keymap.js";

describe("toggle_reasoning action", () => {
  it("is a valid TuiAction accepted by mergeKeymap", () => {
    const overrides: Partial<TuiKeymap> = { "ctrl+r": "toggle_reasoning" };
    const merged = mergeKeymap(overrides);
    expect(merged["ctrl+r"]).toBe("toggle_reasoning");
  });

  it("parses Ctrl+R as toggle_reasoning when bound", () => {
    const decoder = new TerminalInputDecoder({
      ...DEFAULT_KEYMAP,
      "ctrl+r": "toggle_reasoning",
    });
    const keys = decoder.push("\u0012"); // Ctrl+R = 0x12
    const actions = keys.filter((k) => k.type === "action");
    expect(actions.length).toBe(1);
    if (actions[0]?.type === "action") {
      expect(actions[0].action).toBe("toggle_reasoning");
    }
  });

  it("is not bound by default in DEFAULT_KEYMAP", () => {
    for (const action of Object.values(DEFAULT_KEYMAP)) {
      expect(action).not.toBe("toggle_reasoning");
    }
  });
});

describe("Phase 2 keymap extensions", () => {
  it("DEFAULT_KEYMAP binds ctrl+v to toggle_vim", () => {
    expect(DEFAULT_KEYMAP["ctrl+v"]).toBe("toggle_vim");
  });

  it("DEFAULT_KEYMAP binds ctrl+p to open_palette", () => {
    expect(DEFAULT_KEYMAP["ctrl+p"]).toBe("open_palette");
  });

  it("DEFAULT_KEYMAP binds ctrl+f to search_transcript", () => {
    expect(DEFAULT_KEYMAP["ctrl+f"]).toBe("search_transcript");
  });

  it("parseTerminalInput maps Ctrl+V to toggle_vim action", () => {
    const parsed = parseTerminalInput("\x16");
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({ type: "action", action: "toggle_vim" });
  });

  it("parseTerminalInput maps Ctrl+P to open_palette action", () => {
    const parsed = parseTerminalInput("\x10");
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({ type: "action", action: "open_palette" });
  });

  it("parseTerminalInput maps Ctrl+F to search_transcript action", () => {
    const parsed = parseTerminalInput("\x06");
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({ type: "action", action: "search_transcript" });
  });

  it("mergeKeymap accepts toggle_vim as valid action", () => {
    const km = mergeKeymap({ "ctrl+g": "toggle_vim" });
    expect(km["ctrl+g"]).toBe("toggle_vim");
  });

  it("mergeKeymap accepts open_palette as valid action", () => {
    const km = mergeKeymap({ "ctrl+g": "open_palette" });
    expect(km["ctrl+g"]).toBe("open_palette");
  });

  it("mergeKeymap accepts search_transcript as valid action", () => {
    const km = mergeKeymap({ "ctrl+g": "search_transcript" });
    expect(km["ctrl+g"]).toBe("search_transcript");
  });
});

describe("Phase 3 keymap extensions", () => {
  it("DEFAULT_KEYMAP binds alt+l to cycle_layout", () => {
    expect(DEFAULT_KEYMAP["alt+l"]).toBe("cycle_layout");
  });

  it("DEFAULT_KEYMAP binds alt+t to toggle_todo_panel", () => {
    expect(DEFAULT_KEYMAP["alt+t"]).toBe("toggle_todo_panel");
  });

  it("mergeKeymap accepts cycle_layout as valid action", () => {
    const km = mergeKeymap({ "ctrl+g": "cycle_layout" });
    expect(km["ctrl+g"]).toBe("cycle_layout");
  });

  it("mergeKeymap accepts toggle_todo_panel as valid action", () => {
    const km = mergeKeymap({ "ctrl+g": "toggle_todo_panel" });
    expect(km["ctrl+g"]).toBe("toggle_todo_panel");
  });

  it("mergeKeymap rejects unknown action cycle_layout_typo", () => {
    expect(() => mergeKeymap({ "ctrl+g": "cycle_layout_typo" as never })).toThrow();
  });

  it("VALID_ACTIONS includes cycle_layout and toggle_todo_panel", () => {
    // 通过 mergeKeymap 间接验证 VALID_ACTIONS 包含这两个 action
    expect(() => mergeKeymap({ "ctrl+g": "cycle_layout" })).not.toThrow();
    expect(() => mergeKeymap({ "ctrl+g": "toggle_todo_panel" })).not.toThrow();
  });
});

describe("readline keymap extensions (Phase 4 — keyboard efficiency)", () => {
  it("DEFAULT_KEYMAP binds ctrl+u to kill_to_start", () => {
    expect(DEFAULT_KEYMAP["ctrl+u"]).toBe("kill_to_start");
  });

  it("DEFAULT_KEYMAP binds delete to delete_char_forward", () => {
    expect(DEFAULT_KEYMAP["delete"]).toBe("delete_char_forward");
  });

  it("DEFAULT_KEYMAP binds alt+d to kill_word_forward", () => {
    expect(DEFAULT_KEYMAP["alt+d"]).toBe("kill_word_forward");
  });

  it("DEFAULT_KEYMAP binds alt+u to upcase_word", () => {
    expect(DEFAULT_KEYMAP["alt+u"]).toBe("upcase_word");
  });

  it("DEFAULT_KEYMAP binds alt+c to capitalize_word", () => {
    expect(DEFAULT_KEYMAP["alt+c"]).toBe("capitalize_word");
  });

  it("parseTerminalInput maps Ctrl+U (0x15) to kill_to_start", () => {
    const parsed = parseTerminalInput("\x15");
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({ type: "action", action: "kill_to_start" });
  });

  it("parseTerminalInput maps Delete (\\u001b[3~) to delete_char_forward", () => {
    const parsed = parseTerminalInput("\u001b[3~");
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({ type: "action", action: "delete_char_forward" });
  });

  it("parseTerminalInput maps Alt+D (\\u001bd) to kill_word_forward", () => {
    const parsed = parseTerminalInput("\u001bd");
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({ type: "action", action: "kill_word_forward" });
  });

  it("parseTerminalInput maps Alt+U (\\u001bu) to upcase_word", () => {
    const parsed = parseTerminalInput("\u001bu");
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({ type: "action", action: "upcase_word" });
  });

  it("parseTerminalInput maps Alt+C (\\u001bc) to capitalize_word", () => {
    const parsed = parseTerminalInput("\u001bc");
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({ type: "action", action: "capitalize_word" });
  });

  it("mergeKeymap accepts all new readline actions as valid", () => {
    expect(() => mergeKeymap({ "ctrl+g": "kill_to_start" })).not.toThrow();
    expect(() => mergeKeymap({ "ctrl+g": "delete_char_forward" })).not.toThrow();
    expect(() => mergeKeymap({ "ctrl+g": "kill_word_forward" })).not.toThrow();
    expect(() => mergeKeymap({ "ctrl+g": "upcase_word" })).not.toThrow();
    expect(() => mergeKeymap({ "ctrl+g": "downcase_word" })).not.toThrow();
    expect(() => mergeKeymap({ "ctrl+g": "capitalize_word" })).not.toThrow();
  });

  it("mergeKeymap accepts `delete` as a valid key name", () => {
    expect(() => mergeKeymap({ delete: "delete_char_forward" })).not.toThrow();
  });

  it("mergeKeymap rejects `delete_typo` as a key name", () => {
    expect(() => mergeKeymap({ delete_typo: "delete_char_forward" as never })).toThrow();
  });

  it("TerminalInputDecoder handles Delete key via push()", () => {
    const decoder = new TerminalInputDecoder();
    const keys = decoder.push("\u001b[3~");
    expect(keys).toHaveLength(1);
    if (keys[0]?.type === "action") {
      expect(keys[0].action).toBe("delete_char_forward");
    }
  });
});

// ─── Spec decision keymap actions ──────────────────────────────────────────

describe("spec decision keymap actions", () => {
  it("spec_option_up is a valid TuiAction accepted by mergeKeymap", () => {
    const overrides: Partial<TuiKeymap> = { up: "spec_option_up" };
    const merged = mergeKeymap(overrides);
    expect(merged["up"]).toBe("spec_option_up");
  });

  it("spec_option_down is a valid TuiAction accepted by mergeKeymap", () => {
    const overrides: Partial<TuiKeymap> = { down: "spec_option_down" };
    const merged = mergeKeymap(overrides);
    expect(merged["down"]).toBe("spec_option_down");
  });

  it("spec_confirm is a valid TuiAction accepted by mergeKeymap", () => {
    const overrides: Partial<TuiKeymap> = { enter: "spec_confirm" };
    const merged = mergeKeymap(overrides);
    expect(merged["enter"]).toBe("spec_confirm");
  });

  it("spec_cancel is a valid TuiAction accepted by mergeKeymap", () => {
    const overrides: Partial<TuiKeymap> = { "ctrl+c": "spec_cancel" };
    const merged = mergeKeymap(overrides);
    expect(merged["ctrl+c"]).toBe("spec_cancel");
  });

  it("TerminalInputDecoder maps up to spec_option_up when bound", () => {
    const decoder = new TerminalInputDecoder({
      ...DEFAULT_KEYMAP,
      up: "spec_option_up",
    });
    const keys = decoder.push("\u001b[A");
    expect(keys).toHaveLength(1);
    if (keys[0]?.type === "action") {
      expect(keys[0].action).toBe("spec_option_up");
    }
  });
});

describe("D9 keymap conflict warning", () => {
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

  beforeEach(() => {
    warnSpy.mockClear();
  });

  it("TC-D9-01: reassigning an action emits warning with old and new key", () => {
    // DEFAULT_KEYMAP has enter → submit; remapping submit to ctrl+x should warn
    const merged = mergeKeymap({ "ctrl+x": "submit" });
    expect(merged["ctrl+x"]).toBe("submit");
    expect(merged["enter"]).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = String(warnSpy.mock.calls[0]?.[0] ?? "");
    expect(msg).toContain("enter");
    expect(msg).toContain("ctrl+x");
    expect(msg).toContain("submit");
  });

  it("TC-D9-02: no warning when adding a binding for an action with no existing binding", () => {
    // toggle_reasoning has no default binding
    const merged = mergeKeymap({ "ctrl+r": "toggle_reasoning" });
    expect(merged["ctrl+r"]).toBe("toggle_reasoning");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("TC-D9-03: no warning when override key is the same as existing key", () => {
    // Re-binding enter to submit (same as default) should not warn
    const merged = mergeKeymap({ enter: "submit" });
    expect(merged["enter"]).toBe("submit");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("TC-D9-04: multiple conflicts emit multiple warnings", () => {
    // Remap two actions that have default bindings
    warnSpy.mockClear();
    mergeKeymap({ "ctrl+x": "submit", "ctrl+y": "abort" });
    // submit was on enter, abort was on ctrl+c
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it("TC-D9-05: resulting keymap has old binding removed and new binding set", () => {
    const merged = mergeKeymap({ "ctrl+x": "submit" });
    expect(merged["ctrl+x"]).toBe("submit");
    expect(merged["enter"]).toBeUndefined();
  });

  it("TC-D9-06: no warning for falsy action values (skipped)", () => {
    warnSpy.mockClear();
    mergeKeymap({ "ctrl+r": undefined });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("TC-D9-07: warning message is descriptive and actionable", () => {
    const merged = mergeKeymap({ "ctrl+x": "kill_line" });
    expect(merged["ctrl+x"]).toBe("kill_line");
    // ctrl+k was the default for kill_line
    expect(merged["ctrl+k"]).toBeUndefined();
    const msg = String(warnSpy.mock.calls[0]?.[0] ?? "");
    expect(msg).toContain("ctrl+k");
    expect(msg).toContain("ctrl+x");
    expect(msg).toContain("kill_line");
  });

  it("TC-D9-08: empty overrides produces no warnings", () => {
    warnSpy.mockClear();
    const merged = mergeKeymap();
    expect(merged).toEqual(DEFAULT_KEYMAP);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
