import { describe, expect, it, vi } from "vitest";
import { FullScreenTui } from "../src/app.js";
import { TUI_MASCOTS } from "../src/mascots.js";
import type { ContextUsageState } from "../src/context-bar.js";
import type { SpecDecisionView, SpecProgressState } from "../src/spec-progress.js";
import { TUI_THEMES } from "../src/themes.js";

function createTui(
  overrides: {
    onSpecConfirm?: (specId: string, choices: Record<string, string>) => void;
    onSpecDecline?: (specId: string) => void;
  } = {},
): FullScreenTui {
  return new FullScreenTui({
    input: {
      isTTY: false,
      setRawMode: () => {},
      setEncoding: () => {},
      resume: () => {},
      on: () => {},
      off: () => {},
    } as never,
    output: {
      isTTY: false,
      columns: 80,
      rows: 24,
      write: () => {},
      on: () => {},
      off: () => {},
    } as never,
    model: "test/model",
    session: "test-session",
    approval: "ask",
    sandbox: "host",
    theme: TUI_THEMES[0]!,
    mascot: TUI_MASCOTS[0]!,
    onSubmit: async () => {},
    onSteer: async () => {},
    onAbort: () => {},
    ...(overrides.onSpecConfirm ? { onSpecConfirm: overrides.onSpecConfirm } : {}),
    ...(overrides.onSpecDecline ? { onSpecDecline: overrides.onSpecDecline } : {}),
  });
}

describe("FullScreenTui spec state", () => {
  it("setSpecProgress updates phase", () => {
    const tui = createTui();
    const state: SpecProgressState = { phase: "start", stages: [] };
    tui.setSpecProgress(state);
    const snap = tui.snapshot();
    expect(snap.specProgress?.phase).toBe("start");
  });

  it("updateSpecStage adds and updates stages", () => {
    const tui = createTui();
    tui.setSpecProgress({ phase: "classify", stages: [] });
    tui.updateSpecStage("classify", { status: "done", durationMs: 500, model: "test" });
    const snap = tui.snapshot();
    expect(snap.specProgress?.stages).toHaveLength(1);
    expect(snap.specProgress?.stages[0]?.name).toBe("classify");
    expect(snap.specProgress?.stages[0]?.status).toBe("done");
  });

  it("setSpecConfirmation stores pending decisions", () => {
    const tui = createTui();
    const decisions: SpecDecisionView[] = [
      {
        id: "d1",
        point: "Test?",
        severity: "critical",
        options: [{ label: "A", description: "a" }],
        selectedIndex: 0,
      },
    ];
    tui.setSpecConfirmation("spec_1", decisions);
    const snap = tui.snapshot();
    expect(snap.specConfirmation?.specId).toBe("spec_1");
    expect(snap.specConfirmation?.decisions).toHaveLength(1);
  });

  it("clearSpecConfirmation removes confirmation state", () => {
    const tui = createTui();
    tui.setSpecConfirmation("spec_1", []);
    tui.clearSpecConfirmation();
    const snap = tui.snapshot();
    expect(snap.specConfirmation).toBeUndefined();
  });

  it("getSpecConfirmationState returns current state", () => {
    const tui = createTui();
    tui.setSpecConfirmation("spec_1", []);
    const state = tui.getSpecConfirmationState();
    expect(state?.specId).toBe("spec_1");
  });

  it("setSpecDraft updates specId and topic", () => {
    const tui = createTui();
    tui.setSpecDraft({ specId: "spec_42", topic: "kernel image" });
    const snap = tui.snapshot();
    expect(snap.specProgress?.specId).toBe("spec_42");
    expect(snap.specProgress?.topic).toBe("kernel image");
  });

  it("getSpecStartTime returns startTime from spec progress", () => {
    const tui = createTui();
    const start = Date.now();
    tui.setSpecProgress({ phase: "start", stages: [], startTime: start });
    expect(tui.getSpecStartTime()).toBe(start);
  });
});

describe("FullScreenTui spec confirmation navigation", () => {
  it("confirmSpecNavigation option_down advances selected index", () => {
    const tui = createTui();
    tui.setSpecConfirmation("spec_1", [
      {
        id: "d1",
        point: "Pick one",
        severity: "critical",
        options: [
          { label: "A", description: "first" },
          { label: "B", description: "second" },
        ],
        selectedIndex: 0,
      },
    ]);
    tui.confirmSpecNavigation("option_down");
    const state = tui.getSpecConfirmationState();
    expect(state?.decisions[0]?.selectedIndex).toBe(1);
  });

  it("confirmSpecNavigation confirm fires onSpecConfirm with choices", () => {
    const onConfirm = vi.fn();
    const tui = createTui({ onSpecConfirm: onConfirm });
    tui.setSpecConfirmation("spec_1", [
      {
        id: "d1",
        point: "Pick one",
        severity: "critical",
        options: [
          { label: "A", description: "first" },
          { label: "B", description: "second" },
        ],
        selectedIndex: 0,
      },
    ]);
    tui.confirmSpecNavigation("confirm");
    expect(onConfirm).toHaveBeenCalledWith("spec_1", { d1: "A" });
    expect(tui.getSpecConfirmationState()).toBeUndefined();
  });

  it("confirmSpecNavigation cancel fires onSpecDecline", () => {
    const onDecline = vi.fn();
    const tui = createTui({ onSpecDecline: onDecline });
    tui.setSpecConfirmation("spec_1", [
      {
        id: "d1",
        point: "Pick",
        severity: "major",
        options: [{ label: "A", description: "a" }],
        selectedIndex: 0,
      },
    ]);
    tui.confirmSpecNavigation("cancel");
    expect(onDecline).toHaveBeenCalledWith("spec_1");
    expect(tui.getSpecConfirmationState()).toBeUndefined();
  });
});

describe("FullScreenTui reasoning state", () => {
  it("appendReasoning accumulates text", () => {
    const tui = createTui();
    tui.appendReasoning("hello ");
    tui.appendReasoning("world");
    const snap = tui.snapshot();
    expect(snap.reasoning).toBe("hello world");
  });

  it("clearReasoning resets to undefined", () => {
    const tui = createTui();
    tui.appendReasoning("thinking...");
    tui.clearReasoning();
    const snap = tui.snapshot();
    expect(snap.reasoning).toBeUndefined();
  });

  it("setReasoningExpanded toggles expanded flag", () => {
    const tui = createTui();
    tui.setReasoningExpanded(true);
    const snap = tui.snapshot();
    expect(snap.reasoningExpanded).toBe(true);
  });

  it("toggle_reasoning action flips expanded state", () => {
    const tui = createTui();
    // Access private action via type cast for testing
    const any_tui = tui as unknown as { action: (a: string) => Promise<void> };
    expect(tui.snapshot().reasoningExpanded).toBeUndefined();
    any_tui.action("toggle_reasoning");
    expect(tui.snapshot().reasoningExpanded).toBe(true);
    any_tui.action("toggle_reasoning");
    expect(tui.snapshot().reasoningExpanded).toBe(false);
  });
});

describe("FullScreenTui context usage", () => {
  it("setContextUsage stores token counts", () => {
    const tui = createTui();
    const ctx: ContextUsageState = { usedTokens: 5000, maxTokens: 100000 };
    tui.setContextUsage(ctx);
    const snap = tui.snapshot();
    expect(snap.contextUsage?.usedTokens).toBe(5000);
    expect(snap.contextUsage?.maxTokens).toBe(100000);
  });
});
