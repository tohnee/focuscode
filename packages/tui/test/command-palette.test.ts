import { describe, expect, it } from "vitest";
import {
  BUILTIN_COMMANDS,
  closePalette,
  confirmPalette,
  createPaletteState,
  movePaletteCursor,
  renderPalette,
  updatePaletteQuery,
  type PaletteState,
} from "../src/command-palette.js";
import { TUI_THEMES } from "../src/themes.js";

const theme = TUI_THEMES[0]!;

describe("createPaletteState", () => {
  it("returns invisible state with empty query and all commands", () => {
    const state = createPaletteState();
    expect(state.visible).toBe(false);
    expect(state.query).toBe("");
    expect(state.selectedIndex).toBe(0);
    expect(state.filtered.length).toBe(BUILTIN_COMMANDS.length);
  });
});

describe("updatePaletteQuery", () => {
  it("filters commands case-insensitively by label or description", () => {
    const state = createPaletteState();
    const updated = updatePaletteQuery(state, "vim");
    expect(updated.query).toBe("vim");
    expect(updated.filtered.length).toBeGreaterThan(0);
    expect(updated.filtered.every((c) => c.label.toLowerCase().includes("vim"))).toBe(true);
    expect(updated.selectedIndex).toBe(0);
  });

  it("returns empty filtered when no match", () => {
    const state = createPaletteState();
    const updated = updatePaletteQuery(state, "zzznomatch");
    expect(updated.filtered).toEqual([]);
    expect(updated.selectedIndex).toBe(0);
  });

  it("matches on category field too", () => {
    const state = createPaletteState();
    // 使用 "navigation" 作为查询：该词仅出现在 search:transcript 的 category 中，
    // 不出现在任何命令的 label 或 description 里，可独立验证 category 匹配路径。
    const updated = updatePaletteQuery(state, "navigation");
    expect(updated.filtered.length).toBeGreaterThan(0);
    expect(updated.filtered.every((c) => c.category === "navigation")).toBe(true);
  });
});

describe("movePaletteCursor", () => {
  it("moves down and wraps to top", () => {
    const state: PaletteState = {
      visible: true,
      query: "",
      filtered: BUILTIN_COMMANDS.slice(0, 3),
      selectedIndex: 0,
    };
    const down1 = movePaletteCursor(state, 1);
    expect(down1.selectedIndex).toBe(1);
    const down2 = movePaletteCursor(down1, 1);
    expect(down2.selectedIndex).toBe(2);
    const wrapped = movePaletteCursor(down2, 1);
    expect(wrapped.selectedIndex).toBe(0);
  });

  it("moves up and wraps to bottom", () => {
    const state: PaletteState = {
      visible: true,
      query: "",
      filtered: BUILTIN_COMMANDS.slice(0, 3),
      selectedIndex: 0,
    };
    const up = movePaletteCursor(state, -1);
    expect(up.selectedIndex).toBe(2);
  });

  it("clamps when filtered is empty", () => {
    const state: PaletteState = {
      visible: true,
      query: "zzz",
      filtered: [],
      selectedIndex: 0,
    };
    const moved = movePaletteCursor(state, 1);
    expect(moved.selectedIndex).toBe(0);
  });
});

describe("confirmPalette", () => {
  it("returns selected command when filtered is non-empty", () => {
    const state: PaletteState = {
      visible: true,
      query: "vim",
      filtered: [BUILTIN_COMMANDS[0]!],
      selectedIndex: 0,
    };
    const result = confirmPalette(state);
    expect(result).toBeDefined();
    expect(result?.id).toBe(BUILTIN_COMMANDS[0]!.id);
  });

  it("returns undefined when filtered is empty", () => {
    const state: PaletteState = {
      visible: true,
      query: "zzz",
      filtered: [],
      selectedIndex: 0,
    };
    const result = confirmPalette(state);
    expect(result).toBeUndefined();
  });
});

describe("closePalette", () => {
  it("resets to invisible and clears query", () => {
    const state: PaletteState = {
      visible: true,
      query: "vim",
      filtered: [BUILTIN_COMMANDS[0]!],
      selectedIndex: 0,
    };
    const closed = closePalette(state);
    expect(closed.visible).toBe(false);
    expect(closed.query).toBe("");
    expect(closed.selectedIndex).toBe(0);
    expect(closed.filtered.length).toBe(BUILTIN_COMMANDS.length);
  });
});

describe("renderPalette", () => {
  it("returns empty array when invisible", () => {
    const state = createPaletteState();
    const lines = renderPalette(state, 60, 10, theme);
    expect(lines).toEqual([]);
  });

  it("renders query line and filtered commands when visible", () => {
    const state: PaletteState = {
      visible: true,
      query: "vim",
      filtered: [BUILTIN_COMMANDS[0]!],
      selectedIndex: 0,
    };
    const lines = renderPalette(state, 60, 10, theme);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]).toContain("vim");
    expect(lines[1]).toContain(BUILTIN_COMMANDS[0]!.label);
  });

  it("marks selected command with indicator", () => {
    const state: PaletteState = {
      visible: true,
      query: "",
      filtered: BUILTIN_COMMANDS.slice(0, 3),
      selectedIndex: 1,
    };
    const lines = renderPalette(state, 60, 10, theme);
    expect(lines.length).toBeGreaterThan(3);
    expect(lines[2]).toContain(">");
  });
});

describe("BUILTIN_COMMANDS layout & todo coverage", () => {
  it("includes layout:classic command", () => {
    const cmd = BUILTIN_COMMANDS.find((c) => c.id === "layout:classic");
    expect(cmd).toBeDefined();
    expect(cmd?.category).toBe("view");
  });

  it("includes layout:split command", () => {
    const cmd = BUILTIN_COMMANDS.find((c) => c.id === "layout:split");
    expect(cmd).toBeDefined();
    expect(cmd?.category).toBe("view");
  });

  it("includes layout:focus command", () => {
    const cmd = BUILTIN_COMMANDS.find((c) => c.id === "layout:focus");
    expect(cmd).toBeDefined();
    expect(cmd?.category).toBe("view");
  });

  it("includes layout:wide command", () => {
    const cmd = BUILTIN_COMMANDS.find((c) => c.id === "layout:wide");
    expect(cmd).toBeDefined();
    expect(cmd?.category).toBe("view");
  });

  it("includes layout:cycle command", () => {
    const cmd = BUILTIN_COMMANDS.find((c) => c.id === "layout:cycle");
    expect(cmd).toBeDefined();
    expect(cmd?.category).toBe("view");
  });

  it("includes todo:toggle_panel command", () => {
    const cmd = BUILTIN_COMMANDS.find((c) => c.id === "todo:toggle_panel");
    expect(cmd).toBeDefined();
    expect(cmd?.category).toBe("view");
  });

  it("searching 'layout' returns all 5 layout commands", () => {
    const state = createPaletteState();
    const updated = updatePaletteQuery(state, "layout");
    const layoutIds = updated.filtered.filter((c) => c.id.startsWith("layout:")).map((c) => c.id);
    expect(layoutIds.sort()).toEqual(
      ["layout:classic", "layout:cycle", "layout:focus", "layout:split", "layout:wide"].sort(),
    );
  });

  it("searching 'todo' returns the toggle_panel command", () => {
    const state = createPaletteState();
    const updated = updatePaletteQuery(state, "todo");
    const todoIds = updated.filtered.filter((c) => c.id.startsWith("todo:")).map((c) => c.id);
    expect(todoIds).toContain("todo:toggle_panel");
  });
});
