import { describe, expect, it } from "vitest";
import {
  advanceConfirmation,
  collectChoices,
  createInitialSpecProgress,
  createInitialSpecPipeline,
  createSpecConfirmation,
  renderSpecConfirmation,
  renderSpecProgress,
  type SpecDecisionView,
  type SpecProgressState,
} from "../src/spec-progress.js";
import { TUI_THEMES } from "../src/themes.js";
import { stripAnsi } from "../src/width.js";

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

// ─── Phase 5 — SpecEngine integration depth refinements ──────────────────────

describe("createInitialSpecPipeline (Phase 5 — pipeline preset)", () => {
  it("returns start phase with 5 pending stages in canonical order", () => {
    const state = createInitialSpecPipeline("auto");
    expect(state.phase).toBe("start");
    expect(state.trigger).toBe("auto");
    expect(state.stages.map((s) => s.name)).toEqual([
      "classify",
      "explore",
      "draft",
      "detect-decisions",
      "enhance",
    ]);
    for (const stage of state.stages) {
      expect(stage.status).toBe("pending");
    }
  });

  it("startTime is set to a fresh timestamp", () => {
    const before = Date.now();
    const state = createInitialSpecPipeline("explicit");
    const after = Date.now();
    expect(state.startTime).toBeDefined();
    expect(state.startTime!).toBeGreaterThanOrEqual(before);
    expect(state.startTime!).toBeLessThanOrEqual(after);
    expect(state.trigger).toBe("explicit");
  });
});

describe("renderSpecProgress — Phase 5 refinements", () => {
  it("running stage spinner rotates with tick (4-frame cycle)", () => {
    const state: SpecProgressState = {
      phase: "draft",
      stages: [{ name: "draft", status: "running" }],
    };
    const frames: string[] = [];
    for (let tick = 0; tick < 4; tick += 1) {
      const lines = renderSpecProgress(state, 40, theme, { tick });
      frames.push(stripAnsi(lines.join("\n")));
    }
    // 4 distinct frames means rotation is alive
    const unique = new Set(frames);
    expect(unique.size).toBeGreaterThan(1);
  });

  it("skipped phase renders the reason when provided", () => {
    const state: SpecProgressState = {
      phase: "skipped",
      stages: [],
      topic: undefined,
    };
    const lines = renderSpecProgress(state, 60, theme, { reason: "classifier: trivial" });
    const text = stripAnsi(lines.join("\n"));
    expect(text).toContain("Spec skipped");
    expect(text).toContain("classifier: trivial");
  });

  it("completed phase renders specId when provided", () => {
    const state: SpecProgressState = {
      phase: "completed",
      stages: [],
      totalDuration: 4200,
      specId: "spec_abc123",
    };
    const lines = renderSpecProgress(state, 60, theme);
    const text = stripAnsi(lines.join("\n"));
    expect(text).toContain("Spec completed");
    expect(text).toContain("spec_abc123");
    expect(text).toContain("4.2s");
  });

  it("preserves stage history when phase transitions to completed", () => {
    const state: SpecProgressState = {
      phase: "completed",
      stages: [
        { name: "classify", status: "done", durationMs: 500 },
        { name: "explore", status: "done", durationMs: 1200 },
      ],
      totalDuration: 1700,
    };
    const lines = renderSpecProgress(state, 60, theme);
    const text = stripAnsi(lines.join("\n"));
    expect(text).toContain("classify");
    expect(text).toContain("explore");
    expect(text).toContain("Total");
  });
});

describe("renderSpecConfirmation — Phase 5 width-adaptive layout", () => {
  it("border fills adapt to width param (narrow vs wide)", () => {
    const state = createSpecConfirmation("spec_xyz", sampleDecisions);
    const narrow = renderSpecConfirmation(state, 40, theme).map(stripAnsi);
    const wide = renderSpecConfirmation(state, 80, theme).map(stripAnsi);
    const narrowTop = narrow.find((l) => l.startsWith("╭")) ?? "";
    const wideTop = wide.find((l) => l.startsWith("╭")) ?? "";
    expect(wideTop.length).toBeGreaterThan(narrowTop.length);
    // Both should end with a closing ╮
    expect(wideTop.endsWith("╮")).toBe(true);
    expect(narrowTop.endsWith("╮")).toBe(true);
  });

  it("shows decision progress (current/total) and severity label", () => {
    const state = createSpecConfirmation("spec_xyz", sampleDecisions);
    const lines = renderSpecConfirmation(state, 60, theme);
    const text = stripAnsi(lines.join("\n"));
    expect(text).toContain("1/2");
    expect(text).toContain("critical");
  });

  it("keybind hint line is present", () => {
    const state = createSpecConfirmation("spec_xyz", sampleDecisions);
    const lines = renderSpecConfirmation(state, 60, theme);
    const text = stripAnsi(lines.join("\n"));
    expect(text).toContain("↑↓");
    expect(text).toContain("Enter");
    expect(text).toContain("Esc");
  });
});
