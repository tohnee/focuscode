import { describe, expect, it } from "vitest";
import {
  DEFAULT_KEYMAP,
  mergeKeymap,
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
