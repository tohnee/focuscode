import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bg,
  colorToRgb,
  detectTruecolorSupport,
  dim,
  fg,
  rgbToAnsi256,
  setColorMode,
} from "../src/themes.js";

describe("D11 truecolor detection and auto-downgrade", () => {
  const originalColorterm = process.env.COLORTERM;
  const originalTerm = process.env.TERM;

  beforeEach(() => {
    delete process.env.COLORTERM;
    delete process.env.TERM;
    setColorMode("truecolor");
  });

  afterEach(() => {
    if (originalColorterm !== undefined) process.env.COLORTERM = originalColorterm;
    else delete process.env.COLORTERM;
    if (originalTerm !== undefined) process.env.TERM = originalTerm;
    else delete process.env.TERM;
    setColorMode("truecolor");
  });

  // ── detectTruecolorSupport ──────────────────────────────────────────

  it("TC-D11-01: detectTruecolorSupport returns true when COLORTERM=truecolor", () => {
    process.env.COLORTERM = "truecolor";
    expect(detectTruecolorSupport()).toBe(true);
  });

  it("TC-D11-02: detectTruecolorSupport returns true when COLORTERM=24bit", () => {
    process.env.COLORTERM = "24bit";
    expect(detectTruecolorSupport()).toBe(true);
  });

  it("TC-D11-03: detectTruecolorSupport returns false when COLORTERM unset and TERM is unknown", () => {
    process.env.TERM = "xterm-256color";
    expect(detectTruecolorSupport()).toBe(false);
  });

  it("TC-D11-04: detectTruecolorSupport returns true when TERM contains xterm-direct", () => {
    process.env.TERM = "xterm-direct";
    expect(detectTruecolorSupport()).toBe(true);
  });

  // ── rgbToAnsi256 ────────────────────────────────────────────────────

  it("TC-D11-05: rgbToAnsi256 converts pure black [0,0,0] to 16", () => {
    expect(rgbToAnsi256(0, 0, 0)).toBe(16);
  });

  it("TC-D11-06: rgbToAnsi256 converts pure white [255,255,255] to 231", () => {
    expect(rgbToAnsi256(255, 255, 255)).toBe(231);
  });

  it("TC-D11-07: rgbToAnsi256 converts pure red [255,0,0] to 196", () => {
    expect(rgbToAnsi256(255, 0, 0)).toBe(196);
  });

  it("TC-D11-08: rgbToAnsi256 maps gray [128,128,128] to grayscale ramp", () => {
    const code = rgbToAnsi256(128, 128, 128);
    expect(code).toBeGreaterThanOrEqual(232);
    expect(code).toBeLessThanOrEqual(255);
  });

  it("TC-D11-09: rgbToAnsi256 is symmetric — roundtrips via colorToRgb", () => {
    for (const expected of [16, 196, 231, 240]) {
      const [r, g, b] = colorToRgb(expected);
      expect(rgbToAnsi256(r, g, b)).toBe(expected);
    }
  });

  // ── fg / bg / dim in 256-color mode ────────────────────────────────

  it("TC-D11-10: fg with hex color in truecolor mode emits \\e[38;2;R;G;Bm", () => {
    setColorMode("truecolor");
    const out = fg("#ff5500", "hello");
    expect(out).toContain("\u001b[38;2;255;85;0m");
    expect(out).toContain("hello");
    expect(out.endsWith("\u001b[39m")).toBe(true);
  });

  it("TC-D11-11: fg with hex color in 256-color mode emits \\e[38;5;Nm", () => {
    setColorMode("256");
    const out = fg("#ff5500", "hello");
    expect(out).not.toContain("\u001b[38;2;");
    expect(out).toMatch(/^\u001b\[38;5;\d+m/);
    expect(out).toContain("hello");
    expect(out.endsWith("\u001b[39m")).toBe(true);
  });

  it("TC-D11-12: fg with number color always emits 256-color escape regardless of mode", () => {
    setColorMode("truecolor");
    const tc = fg(81, "x");
    expect(tc).toContain("\u001b[38;5;81m");

    setColorMode("256");
    const c256 = fg(81, "x");
    expect(c256).toContain("\u001b[38;5;81m");
  });

  it("TC-D11-13: bg with hex color in 256-color mode emits \\e[48;5;Nm", () => {
    setColorMode("256");
    const out = bg("#00aa55", "text");
    expect(out).not.toContain("\u001b[48;2;");
    expect(out).toMatch(/^\u001b\[48;5;\d+m/);
    expect(out.endsWith("\u001b[49m")).toBe(true);
  });

  it("TC-D11-14: dim in 256-color mode emits 256-color escape instead of truecolor", () => {
    setColorMode("256");
    const out = dim("#ff5500", "dimmed");
    expect(out).not.toContain("\u001b[38;2;");
    expect(out).toMatch(/^\u001b\[38;5;\d+m/);
    expect(out).toContain("dimmed");
  });

  it("TC-D11-15: setColorMode('auto') detects from COLORTERM env", () => {
    process.env.COLORTERM = "truecolor";
    setColorMode("auto");
    const out = fg("#ff5500", "x");
    expect(out).toContain("\u001b[38;2;255;85;0m");
  });

  it("TC-D11-16: setColorMode('auto') downgrades when no truecolor env", () => {
    process.env.TERM = "xterm-256color";
    setColorMode("auto");
    const out = fg("#ff5500", "x");
    expect(out).not.toContain("\u001b[38;2;");
    expect(out).toMatch(/^\u001b\[38;5;\d+m/);
  });

  it("TC-D11-17: fg with RGB tuple in 256-color mode emits 256-color escape", () => {
    setColorMode("256");
    const out = fg([255, 85, 0] as const, "rgb");
    expect(out).not.toContain("\u001b[38;2;");
    expect(out).toMatch(/^\u001b\[38;5;\d+m/);
  });

  it("TC-D11-18: downgrade preserves text content and reset sequence", () => {
    setColorMode("256");
    const out = fg("#336699", "preserve me");
    expect(out).toContain("preserve me");
    expect(out.endsWith("\u001b[39m")).toBe(true);
  });
});
