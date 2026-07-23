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
});
