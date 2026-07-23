import { describe, expect, it } from "vitest";
import { renderTui, type TuiRenderState } from "../src/renderer.js";
import type { ContextUsageState } from "../src/context-bar.js";
import type { SpecProgressState } from "../src/spec-progress.js";
import { TUI_MASCOTS } from "../src/mascots.js";
import { TUI_THEMES } from "../src/themes.js";

function baseState(overrides: Partial<TuiRenderState> = {}): TuiRenderState {
  return {
    width: 80,
    height: 24,
    title: "Test",
    model: "test/model",
    session: "s1",
    approval: "ask",
    sandbox: "host",
    busy: false,
    queued: 0,
    mood: "idle",
    tick: 0,
    theme: TUI_THEMES[0]!,
    mascot: TUI_MASCOTS[0]!,
    transcript: [],
    input: "",
    inputCursor: { row: 0, col: 0 },
    attachments: [],
    scrollOffset: 0,
    ...overrides,
  };
}

describe("renderTui spec integration", () => {
  it("renders spec progress when phase is not idle", () => {
    const specProgress: SpecProgressState = {
      phase: "explore",
      stages: [
        { name: "classify", status: "done", durationMs: 500 },
        { name: "explore", status: "running" },
      ],
    };
    const frame = renderTui(baseState({ specProgress }));
    expect(frame).toContain("Spec Engine");
    expect(frame).toContain("classify");
    expect(frame).toContain("explore");
  });

  it("does not render spec progress when idle", () => {
    const specProgress: SpecProgressState = { phase: "idle", stages: [] };
    const frame = renderTui(baseState({ specProgress }));
    expect(frame).not.toContain("Spec Engine");
  });

  it("renders context usage bar when set", () => {
    const contextUsage: ContextUsageState = { usedTokens: 50000, maxTokens: 200000 };
    const frame = renderTui(baseState({ contextUsage }));
    expect(frame).toContain("50.0k");
    expect(frame).toContain("200.0k");
  });

  it("renders reasoning indicator when reasoning present and collapsed", () => {
    const frame = renderTui(
      baseState({ reasoning: "thinking about it", reasoningExpanded: false }),
    );
    expect(frame).toContain("thinking");
  });

  it("renders reasoning inline when expanded", () => {
    const frame = renderTui(baseState({ reasoning: "deep thoughts", reasoningExpanded: true }));
    expect(frame).toContain("deep thoughts");
  });
});
