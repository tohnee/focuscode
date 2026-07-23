import { describe, expect, it } from "vitest";
import { costBar, levelBadge, progressBar, type TuiTheme } from "../src/index.js";

const THEME: TuiTheme = {
  id: "test",
  name: "Test",
  background: 232,
  foreground: 252,
  accent: 75,
  secondary: 99,
  success: 48,
  warning: 214,
  danger: 197,
  muted: 240,
  border: "─",
};

function fg(color: number, text: string): string {
  return "\u001b[38;5;" + color + "m" + text + "\u001b[39m";
}

function stripSgr(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

/** True when `value` contains an SGR foreground sequence for `color`. */
function hasFg(value: string, color: number): boolean {
  return value.includes("\u001b[38;5;" + color + "m");
}

describe("widgets.progressBar", () => {
  it("clamps ratio into [0, 1]", () => {
    const over = progressBar({ ratio: 2, width: 20, theme: THEME });
    const under = progressBar({ ratio: -1, width: 20, theme: THEME });
    const full = progressBar({ ratio: 1, width: 20, theme: THEME });
    // ratio >= 1 → success color wraps the whole bar; under → accent.
    expect(hasFg(over, THEME.success)).toBe(true);
    expect(hasFg(under, THEME.accent)).toBe(true);
    expect(full).toBe(over);
  });

  it("uses warning color at ratio >= 0.5 and accent below", () => {
    const mid = progressBar({ ratio: 0.5, width: 20, theme: THEME });
    const low = progressBar({ ratio: 0.49, width: 20, theme: THEME });
    expect(hasFg(mid, THEME.warning)).toBe(true);
    expect(hasFg(low, THEME.accent)).toBe(true);
  });

  it("clamps width to a minimum of 8 columns", () => {
    const tiny = progressBar({ ratio: 0.5, width: 2, theme: THEME });
    // Bar still renders without throwing; plain content includes brackets.
    expect(stripSgr(tiny)).toContain("[");
    expect(stripSgr(tiny)).toContain("]");
    // Width-2 input should produce a wider bar (clamped), so length > 2.
    expect(stripSgr(tiny).length).toBeGreaterThan(2);
  });

  it("renders the label segment before the bar when provided", () => {
    const out = progressBar({ ratio: 0.5, width: 30, label: "build", theme: THEME });
    expect(stripSgr(out)).toMatch(/^build \[.+]$/);
  });

  it("sanitizes control characters in the label", () => {
    const dirty = "bu\u0007ild";
    const out = progressBar({ ratio: 0.5, width: 30, label: dirty, theme: THEME });
    expect(stripSgr(out)).toMatch(/^build \[.+]$/);
  });

  it("uses the partial glyph for fractional fill", () => {
    // Pick a width and ratio that produces a fractional fill so the partial
    // glyph is non-empty. Bar internals: width 24, no label → bar width 22.
    // ratio 0.5 → filled = 11, remainder 0 → no partial. ratio 0.51 → 11.22,
    // remainder round(0.22 * 8) = 2 → '▎'.
    const out = progressBar({ ratio: 0.51, width: 24, theme: THEME });
    expect(out).toContain("▎");
  });

  it("never emits non-SGR ANSI escapes", () => {
    const out = progressBar({ ratio: 0.5, width: 24, label: "x", theme: THEME });
    const sgrOnly = out.replace(/\u001b\[[0-9;]*m/g, "");
    expect(sgrOnly).not.toMatch(/\u001b/g);
  });
});

describe("widgets.costBar", () => {
  it("renders a flat padded label when no budget is supplied", () => {
    const out = costBar({ spent: 0.5, width: 24, theme: THEME });
    // Padded to the requested width with trailing spaces.
    expect(stripSgr(out).trimEnd()).toBe("$0.5000");
    expect(stripSgr(out).length).toBe(24);
  });

  it("renders a ratio bar when a budget is supplied", () => {
    const out = costBar({ spent: 0.5, budget: 1, width: 30, theme: THEME });
    expect(stripSgr(out)).toMatch(/^\$0\.5000 \/ \$1\.00 \[[█░]+]$/);
  });

  it("uses success below 50%, warning at 50%+, danger at 90%+", () => {
    const low = costBar({ spent: 1, budget: 4, width: 30, theme: THEME });
    const mid = costBar({ spent: 2, budget: 4, width: 30, theme: THEME });
    const high = costBar({ spent: 3.6, budget: 4, width: 30, theme: THEME });
    expect(hasFg(low, THEME.success)).toBe(true);
    expect(hasFg(mid, THEME.warning)).toBe(true);
    expect(hasFg(high, THEME.danger)).toBe(true);
  });

  it("clamps spent to 0 when non-finite", () => {
    const out = costBar({ spent: Number.NaN, width: 16, theme: THEME });
    expect(stripSgr(out)).toContain("$0.0000");
  });

  it("treats non-positive budget as no budget", () => {
    const zero = costBar({ spent: 1, budget: 0, width: 24, theme: THEME });
    const negative = costBar({ spent: 1, budget: -1, width: 24, theme: THEME });
    expect(stripSgr(zero).trimEnd()).toBe("$1.0000");
    expect(stripSgr(negative).trimEnd()).toBe("$1.0000");
  });

  it("clamps width to a minimum of 16 columns", () => {
    const out = costBar({ spent: 1, width: 4, theme: THEME });
    expect(stripSgr(out).length).toBeGreaterThanOrEqual(16);
  });
});

describe("widgets.levelBadge", () => {
  it("formats as `Lv <n>` with optional name suffix", () => {
    const plain = levelBadge({ level: 1, theme: THEME });
    expect(stripSgr(plain)).toBe("Lv 1");
    const named = levelBadge({ level: 5, name: "灵尾狐", theme: THEME });
    expect(stripSgr(named)).toBe("Lv 5 · 灵尾狐");
  });

  it("clamps level into 1..9", () => {
    const low = levelBadge({ level: -3, theme: THEME });
    const high = levelBadge({ level: 99, theme: THEME });
    expect(stripSgr(low)).toBe("Lv 1");
    expect(stripSgr(high)).toBe("Lv 9");
  });

  it("uses secondary tier below level 4, accent at 4-6, danger at 7+", () => {
    const low = levelBadge({ level: 2, theme: THEME });
    const mid = levelBadge({ level: 5, theme: THEME });
    const high = levelBadge({ level: 8, theme: THEME });
    expect(low).toContain(fg(THEME.secondary, "Lv 2"));
    expect(mid).toContain(fg(THEME.accent, "Lv 5"));
    expect(high).toContain(fg(THEME.danger, "Lv 8"));
  });

  it("sanitizes control characters in the name", () => {
    const dirty = levelBadge({ level: 3, name: "fo\u0007xy", theme: THEME });
    expect(stripSgr(dirty)).toBe("Lv 3 · foxy");
  });

  it("omits the name segment entirely when name is absent", () => {
    const out = levelBadge({ level: 4, theme: THEME });
    expect(stripSgr(out)).toBe("Lv 4");
    expect(out).not.toContain("·");
  });
});
