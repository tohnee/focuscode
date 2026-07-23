import { describe, expect, it } from "vitest";
import { formatTokens, renderContextBar, type ContextUsageState } from "../src/context-bar.js";
import { TUI_THEMES } from "../src/themes.js";

const theme = TUI_THEMES[0]!;

describe("formatTokens", () => {
  it("formats numbers under 1000 as-is", () => {
    expect(formatTokens(500)).toBe("500");
    expect(formatTokens(0)).toBe("0");
  });

  it("formats thousands with k suffix", () => {
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(32000)).toBe("32.0k");
    expect(formatTokens(200000)).toBe("200.0k");
  });
});

describe("renderContextBar", () => {
  it("renders progress bar with token counts", () => {
    const state: ContextUsageState = { usedTokens: 32000, maxTokens: 200000 };
    const line = renderContextBar(state, 40, theme);
    expect(line).toContain("32.0k");
    expect(line).toContain("200.0k");
    expect(line).toContain("█");
    expect(line).toContain("░");
  });

  it("uses success color when ratio < 0.7", () => {
    const state: ContextUsageState = { usedTokens: 50000, maxTokens: 200000 };
    const line = renderContextBar(state, 40, theme);
    expect(line.length).toBeGreaterThan(0);
  });

  it("uses warning color when 0.7 <= ratio < 0.9", () => {
    const state: ContextUsageState = { usedTokens: 150000, maxTokens: 200000 };
    const line = renderContextBar(state, 40, theme);
    expect(line.length).toBeGreaterThan(0);
  });

  it("uses danger color when ratio >= 0.9", () => {
    const state: ContextUsageState = { usedTokens: 190000, maxTokens: 200000 };
    const line = renderContextBar(state, 40, theme);
    expect(line.length).toBeGreaterThan(0);
  });

  it("handles zero max tokens gracefully", () => {
    const state: ContextUsageState = { usedTokens: 0, maxTokens: 0 };
    const line = renderContextBar(state, 40, theme);
    expect(line.length).toBeGreaterThan(0);
  });

  it("includes reasoning tokens in label when present", () => {
    const state: ContextUsageState = {
      usedTokens: 32000,
      maxTokens: 200000,
      reasoningTokens: 5000,
    };
    const line = renderContextBar(state, 50, theme);
    expect(line).toContain("32.0k");
    expect(line).toContain("200.0k");
  });
});
