import { describe, expect, it } from "vitest";
import {
  advanceConfirmation,
  collectChoices,
  createInitialSpecProgress,
  createSpecConfirmation,
  renderSpecConfirmation,
  renderSpecProgress,
  type SpecDecisionView,
  type SpecProgressState,
} from "../src/spec-progress.js";
import { TUI_THEMES } from "../src/themes.js";

const theme = TUI_THEMES[0]!;

describe("createInitialSpecProgress", () => {
  it("returns idle state with no stages", () => {
    const state = createInitialSpecProgress();
    expect(state.phase).toBe("idle");
    expect(state.stages).toEqual([]);
    expect(state.pendingDecisions).toBeUndefined();
  });
});

describe("renderSpecProgress", () => {
  it("renders idle state as empty", () => {
    const lines = renderSpecProgress(createInitialSpecProgress(), 40, theme);
    expect(lines).toEqual([]);
  });

  it("renders 5 stages with statuses", () => {
    const state: SpecProgressState = {
      phase: "enhance",
      stages: [
        { name: "classify", status: "done", durationMs: 1200 },
        { name: "explore", status: "done", durationMs: 3400 },
        { name: "draft", status: "done", durationMs: 2100 },
        { name: "detect-decisions", status: "done", durationMs: 800 },
        { name: "enhance", status: "running" },
      ],
    };
    const lines = renderSpecProgress(state, 40, theme);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).toContain("classify");
    expect(lines.join("\n")).toContain("explore");
    expect(lines.join("\n")).toContain("enhance");
    expect(lines.join("\n")).toContain("1.2s");
    expect(lines.join("\n")).toContain("...");
  });

  it("renders fallback marker for fellBack stages", () => {
    const state: SpecProgressState = {
      phase: "draft",
      stages: [
        { name: "classify", status: "done", durationMs: 500, fellBack: true },
        { name: "explore", status: "done", durationMs: 3000, fellBack: false },
        { name: "draft", status: "running" },
      ],
    };
    const lines = renderSpecProgress(state, 40, theme);
    expect(lines.join("\n")).toContain("fallback");
  });

  it("renders completed phase with total duration", () => {
    const state: SpecProgressState = {
      phase: "completed",
      stages: [
        { name: "classify", status: "done", durationMs: 500 },
        { name: "explore", status: "done", durationMs: 1000 },
      ],
      totalDuration: 1500,
    };
    const lines = renderSpecProgress(state, 40, theme);
    expect(lines.join("\n")).toContain("completed");
    expect(lines.join("\n")).toContain("1.5s");
  });
});

const sampleDecisions: SpecDecisionView[] = [
  {
    id: "d1",
    point: "How to supply kernel image?",
    severity: "critical",
    options: [
      { label: "Bundled", description: "Ship with FocusCode" },
      { label: "User path", description: "User provides path" },
      { label: "Download", description: "Fetch on-demand" },
    ],
    selectedIndex: 0,
  },
  {
    id: "d2",
    point: "Network mode?",
    severity: "major",
    options: [
      { label: "TAP", description: "TAP device" },
      { label: "VDE", description: "VDE switch" },
    ],
    selectedIndex: 0,
  },
];

describe("createSpecConfirmation", () => {
  it("creates confirmation state from decisions", () => {
    const state = createSpecConfirmation("spec_123", sampleDecisions);
    expect(state.specId).toBe("spec_123");
    expect(state.currentDecisionIndex).toBe(0);
    expect(state.decisions).toHaveLength(2);
  });
});

describe("advanceConfirmation", () => {
  it("navigates option down within current decision", () => {
    const state = createSpecConfirmation("spec_123", sampleDecisions);
    const next = advanceConfirmation(state, "option_down");
    expect(next.decisions[0]!.selectedIndex).toBe(1);
  });

  it("wraps option navigation at boundary", () => {
    const state = createSpecConfirmation("spec_123", sampleDecisions);
    const wrapped = advanceConfirmation(state, "option_up");
    expect(wrapped.decisions[0]!.selectedIndex).toBe(2);
  });

  it("advances to next decision on confirm", () => {
    const state = createSpecConfirmation("spec_123", sampleDecisions);
    const next = advanceConfirmation(state, "confirm");
    expect(next.currentDecisionIndex).toBe(1);
  });

  it("marks completed when last decision confirmed", () => {
    const state = createSpecConfirmation("spec_123", sampleDecisions);
    const atLast = { ...state, currentDecisionIndex: 1 };
    const next = advanceConfirmation(atLast, "confirm");
    expect(next.completed).toBe(true);
  });
});

describe("renderSpecConfirmation", () => {
  it("renders decision point and options", () => {
    const state = createSpecConfirmation("spec_123", sampleDecisions);
    const lines = renderSpecConfirmation(state, 50, theme);
    const text = lines.join("\n");
    expect(text).toContain("spec_123");
    expect(text).toContain("kernel image");
    expect(text).toContain("Bundled");
    expect(text).toContain("User path");
    expect(text).toContain("1/2");
    expect(text).toContain("critical");
  });

  it("marks selected option with arrow", () => {
    const state = createSpecConfirmation("spec_123", sampleDecisions);
    const lines = renderSpecConfirmation(state, 50, theme);
    expect(lines.join("\n")).toContain("›");
  });
});

describe("collectChoices", () => {
  it("collects selected option labels by decision id", () => {
    const state = createSpecConfirmation("spec_123", sampleDecisions);
    const next = advanceConfirmation(state, "option_down"); // d1 → User path
    const choices = collectChoices(next);
    expect(choices["d1"]).toBe("User path");
  });
});
