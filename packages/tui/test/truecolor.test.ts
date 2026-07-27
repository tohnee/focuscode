import { describe, expect, it } from "vitest";
import {
  bg,
  colorToRgb,
  dim,
  fg,
  getTheme,
  TUI_THEMES,
  validateTuiTheme,
  type ColorValue,
  type TuiTheme,
} from "../src/themes.js";

describe("ColorValue — 8-bit ANSI (backward compat)", () => {
  it("fg renders 8-bit color escape", () => {
    expect(fg(208, "x")).toBe("\u001b[38;5;208mx\u001b[39m");
  });

  it("bg renders 8-bit color escape", () => {
    expect(bg(233, "x")).toBe("\u001b[48;5;233mx\u001b[49m");
  });

  it("fg accepts 0 and 255 boundaries", () => {
    expect(fg(0, "x")).toBe("\u001b[38;5;0mx\u001b[39m");
    expect(fg(255, "x")).toBe("\u001b[38;5;255mx\u001b[39m");
  });
});

describe("ColorValue — hex truecolor", () => {
  it("fg renders truecolor escape from #rrggbb hex", () => {
    expect(fg("#ff8800", "x")).toBe("\u001b[38;2;255;136;0mx\u001b[39m");
  });

  it("bg renders truecolor escape from #rrggbb hex", () => {
    expect(bg("#00aaff", "x")).toBe("\u001b[48;2;0;170;255mx\u001b[49m");
  });

  it("fg handles lowercase and uppercase hex", () => {
    expect(fg("#FF8800", "x")).toBe("\u001b[38;2;255;136;0mx\u001b[39m");
    expect(fg("#ff8800", "x")).toBe("\u001b[38;2;255;136;0mx\u001b[39m");
  });

  it("fg handles #000000 and #ffffff boundaries", () => {
    expect(fg("#000000", "x")).toBe("\u001b[38;2;0;0;0mx\u001b[39m");
    expect(fg("#ffffff", "x")).toBe("\u001b[38;2;255;255;255mx\u001b[39m");
  });
});

describe("ColorValue — RGB tuple truecolor", () => {
  it("fg renders truecolor escape from [r,g,b] tuple", () => {
    expect(fg([255, 136, 0], "x")).toBe("\u001b[38;2;255;136;0mx\u001b[39m");
  });

  it("bg renders truecolor escape from [r,g,b] tuple", () => {
    expect(bg([0, 170, 255], "x")).toBe("\u001b[48;2;0;170;255mx\u001b[49m");
  });

  it("fg handles [0,0,0] and [255,255,255] boundaries", () => {
    expect(fg([0, 0, 0], "x")).toBe("\u001b[38;2;0;0;0mx\u001b[39m");
    expect(fg([255, 255, 255], "x")).toBe("\u001b[38;2;255;255;255mx\u001b[39m");
  });
});

describe("validateTuiTheme — truecolor acceptance", () => {
  const validBase = {
    id: "tc-test",
    name: "TC Test",
    border: "─",
  } as const;

  it("accepts hex colors for all color fields", () => {
    const theme = validateTuiTheme({
      ...validBase,
      background: "#0a0a0a",
      foreground: "#f0f0f0",
      accent: "#ff8800",
      secondary: "#00aaff",
      success: "#00ff88",
      warning: "#ffcc00",
      danger: "#ff0044",
      muted: "#555555",
    });
    expect(theme.accent).toBe("#ff8800");
    expect(theme.background).toBe("#0a0a0a");
  });

  it("accepts RGB tuple colors for all color fields", () => {
    const theme = validateTuiTheme({
      ...validBase,
      background: [10, 10, 10],
      foreground: [240, 240, 240],
      accent: [255, 136, 0],
      secondary: [0, 170, 255],
      success: [0, 255, 136],
      warning: [255, 204, 0],
      danger: [255, 0, 68],
      muted: [85, 85, 85],
    });
    expect(theme.accent).toEqual([255, 136, 0]);
  });

  it("accepts mixed 8-bit and truecolor values", () => {
    const theme = validateTuiTheme({
      ...validBase,
      background: 233,
      foreground: "#f0f0f0",
      accent: [255, 136, 0],
      secondary: 141,
      success: "#00ff88",
      warning: 221,
      danger: "#ff0044",
      muted: 241,
    });
    expect(theme.background).toBe(233);
    expect(theme.foreground).toBe("#f0f0f0");
    expect(theme.accent).toEqual([255, 136, 0]);
  });

  it("rejects invalid hex strings", () => {
    expect(() =>
      validateTuiTheme({ ...validBase, accent: "#gg8800", background: 0, foreground: 0 }),
    ).toThrow();
    expect(() =>
      validateTuiTheme({ ...validBase, accent: "#ff880", background: 0, foreground: 0 }),
    ).toThrow();
    expect(() =>
      validateTuiTheme({ ...validBase, accent: "#ff88000", background: 0, foreground: 0 }),
    ).toThrow();
  });

  it("rejects RGB tuples with out-of-range components", () => {
    expect(() =>
      validateTuiTheme({ ...validBase, accent: [256, 0, 0], background: 0, foreground: 0 }),
    ).toThrow();
    expect(() =>
      validateTuiTheme({ ...validBase, accent: [-1, 0, 0], background: 0, foreground: 0 }),
    ).toThrow();
    expect(() =>
      validateTuiTheme({ ...validBase, accent: [0, 0], background: 0, foreground: 0 }),
    ).toThrow();
  });
});

describe("TUI_THEMES — truecolor themes present", () => {
  it("includes at least one truecolor theme (hex colors)", () => {
    const truecolorThemes = TUI_THEMES.filter(
      (t) => typeof t.accent === "string" || Array.isArray(t.accent),
    );
    expect(truecolorThemes.length).toBeGreaterThanOrEqual(1);
  });

  it("every truecolor theme validates", () => {
    for (const theme of TUI_THEMES) {
      expect(() => validateTuiTheme(theme)).not.toThrow();
    }
  });

  it("every 8-bit theme still validates (backward compat)", () => {
    const ansiThemes = TUI_THEMES.filter(
      (t) => typeof t.accent === "number" && typeof t.background === "number",
    );
    expect(ansiThemes.length).toBeGreaterThanOrEqual(7);
    for (const theme of ansiThemes) {
      expect(() => validateTuiTheme(theme)).not.toThrow();
    }
  });

  it("getTheme resolves truecolor themes by id", () => {
    const truecolorIds = TUI_THEMES.filter(
      (t) => typeof t.accent === "string" || Array.isArray(t.accent),
    ).map((t) => t.id);
    if (truecolorIds.length > 0) {
      const first = truecolorIds[0]!;
      expect(getTheme(first).id).toBe(first);
    }
  });
});

describe("ColorValue — runtime type narrowing", () => {
  it("number branch produces 8-bit escape", () => {
    const c: ColorValue = 208;
    expect(fg(c, "x")).toBe("\u001b[38;5;208mx\u001b[39m");
  });

  it("hex string branch produces truecolor escape", () => {
    const c: ColorValue = "#ff8800";
    expect(fg(c, "x")).toBe("\u001b[38;2;255;136;0mx\u001b[39m");
  });

  it("tuple branch produces truecolor escape", () => {
    const c: ColorValue = [255, 136, 0] as const;
    expect(fg(c, "x")).toBe("\u001b[38;2;255;136;0mx\u001b[39m");
  });
});

describe("TUI_THEMES — refined truecolor palettes", () => {
  const refinedIds = ["tokyo-night", "catppuccin-mocha", "rose-pine", "gruvbox-material"] as const;

  it("includes all four refined truecolor themes", () => {
    const ids = TUI_THEMES.map((t) => t.id);
    for (const id of refinedIds) {
      expect(ids).toContain(id);
    }
  });

  it("every refined theme uses truecolor (not 8-bit) for accent", () => {
    for (const id of refinedIds) {
      const theme = TUI_THEMES.find((t) => t.id === id);
      expect(theme).toBeDefined();
      expect(typeof theme!.accent === "string" || Array.isArray(theme!.accent)).toBe(true);
    }
  });

  it("every refined theme validates", () => {
    for (const id of refinedIds) {
      const theme = TUI_THEMES.find((t) => t.id === id);
      expect(() => validateTuiTheme(theme!)).not.toThrow();
    }
  });

  it("refined themes have distinct accent colors", () => {
    const accents = refinedIds.map((id) => {
      const theme = TUI_THEMES.find((t) => t.id === id);
      return JSON.stringify(theme!.accent);
    });
    const unique = new Set(accents);
    expect(unique.size).toBe(refinedIds.length);
  });

  it("getTheme resolves each refined theme by id", () => {
    for (const id of refinedIds) {
      expect(getTheme(id).id).toBe(id);
    }
  });
});

describe("dim — luminance-reduced color utility", () => {
  it("dims an 8-bit color by reducing to a darker ANSI code", () => {
    const result = dim(208, "text");
    // Should produce an ANSI escape (either 8-bit or truecolor)
    expect(result).toContain("\u001b[");
    expect(result).toContain("text");
  });

  it("dims a hex truecolor by blending toward background", () => {
    const result = dim("#ff8800", "text");
    expect(result).toContain("\u001b[38;2;");
    expect(result).toContain("text");
  });

  it("dim hex produces a darker shade than the original", () => {
    const original = colorToRgb("#ff8800");
    const dimmed = dim("#ff8800", "x");
    // Extract RGB from the escape sequence
    const match = dimmed.match(/\u001b\[38;2;(\d+);(\d+);(\d+)m/);
    expect(match).not.toBeNull();
    const dimR = parseInt(match![1]!, 10);
    const dimG = parseInt(match![2]!, 10);
    const dimB = parseInt(match![3]!, 10);
    // Each component should be less than or equal to the original
    expect(dimR).toBeLessThanOrEqual(original[0]);
    expect(dimG).toBeLessThanOrEqual(original[1]);
    expect(dimB).toBeLessThanOrEqual(original[2]);
    // At least one should be strictly less (unless original is already black)
    const anyReduced = dimR < original[0] || dimG < original[1] || dimB < original[2];
    expect(anyReduced).toBe(true);
  });
});

describe("truecolor theme — round-trip through validateTuiTheme", () => {
  it("preserves hex color values verbatim", () => {
    const original: TuiTheme = {
      id: "tc-rt",
      name: "TC Round Trip",
      background: "#0a0a0a",
      foreground: "#f0f0f0",
      accent: "#ff8800",
      secondary: "#00aaff",
      success: "#00ff88",
      warning: "#ffcc00",
      danger: "#ff0044",
      muted: "#555555",
      border: "─",
    };
    const validated = validateTuiTheme(original);
    expect(validated).toEqual(original);
    expect(validated).not.toBe(original); // structuredClone
  });

  it("preserves RGB tuple color values verbatim", () => {
    const original: TuiTheme = {
      id: "tc-rt2",
      name: "TC Round Trip 2",
      background: [10, 10, 10],
      foreground: [240, 240, 240],
      accent: [255, 136, 0],
      secondary: [0, 170, 255],
      success: [0, 255, 136],
      warning: [255, 204, 0],
      danger: [255, 0, 68],
      muted: [85, 85, 85],
      border: "─",
    };
    const validated = validateTuiTheme(original);
    expect(validated).toEqual(original);
    expect(validated).not.toBe(original);
  });
});
