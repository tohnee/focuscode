import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@focuscode/agent-runtime";
import { FullScreenTui, type TuiTheme } from "@focuscode/tui";
import { TUI_MASCOTS } from "@focuscode/tui";
import { TUI_THEMES } from "@focuscode/tui";
import { renderEvent } from "../src/tui.js";

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
    session: "s1",
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

describe("renderEvent spec_start", () => {
  it("sets spec progress to start phase with trigger", () => {
    const tui = createTui();
    const event: AgentEvent = {
      type: "spec_start",
      input: "build a feature",
      trigger: "auto",
    };
    renderEvent(tui, event);
    const snap = tui.snapshot();
    expect(snap.specProgress?.phase).toBe("start");
    expect(snap.specProgress?.trigger).toBe("auto");
    expect(snap.specProgress?.startTime).toBeTypeOf("number");
  });

  it("Phase 5 — presets the 5 canonical stages as pending and marks classify as running", () => {
    const tui = createTui();
    renderEvent(tui, { type: "spec_start", input: "test", trigger: "explicit" });
    const snap = tui.snapshot();
    expect(snap.specProgress?.stages.map((s) => s.name)).toEqual([
      "classify",
      "explore",
      "draft",
      "detect-decisions",
      "enhance",
    ]);
    // classify is immediately promoted to running for visual feedback
    expect(snap.specProgress?.stages[0]?.status).toBe("running");
    // the rest remain pending
    for (let i = 1; i < 5; i += 1) {
      expect(snap.specProgress?.stages[i]?.status).toBe("pending");
    }
  });
});

describe("renderEvent spec_stage", () => {
  it("updates stage info with done status and duration", () => {
    const tui = createTui();
    // First start the spec engine to initialize progress
    renderEvent(tui, { type: "spec_start", input: "test", trigger: "explicit" });
    renderEvent(tui, {
      type: "spec_stage",
      stage: "classify",
      model: "glm-4",
      durationMs: 500,
      fellBack: false,
    });
    const snap = tui.snapshot();
    // 5 preset stages; classify is now done, explore promoted to running
    expect(snap.specProgress?.stages).toHaveLength(5);
    const classify = snap.specProgress?.stages.find((s) => s.name === "classify");
    expect(classify?.status).toBe("done");
    expect(classify?.durationMs).toBe(500);
    expect(classify?.model).toBe("glm-4");
    // Phase 5 — explore auto-promoted to running
    const explore = snap.specProgress?.stages.find((s) => s.name === "explore");
    expect(explore?.status).toBe("running");
  });

  it("records fellBack flag", () => {
    const tui = createTui();
    renderEvent(tui, { type: "spec_start", input: "test", trigger: "explicit" });
    // Run classify first so explore can be promoted to running before completing.
    renderEvent(tui, {
      type: "spec_stage",
      stage: "classify",
      model: "glm-4",
      durationMs: 100,
      fellBack: false,
    });
    renderEvent(tui, {
      type: "spec_stage",
      stage: "explore",
      model: "glm-4-flash",
      durationMs: 200,
      fellBack: true,
    });
    const snap = tui.snapshot();
    const explore = snap.specProgress?.stages.find((s) => s.name === "explore");
    expect(explore?.fellBack).toBe(true);
  });
});

describe("renderEvent spec_draft_ready", () => {
  it("sets spec draft with specId and topic", () => {
    const tui = createTui();
    renderEvent(tui, { type: "spec_start", input: "test", trigger: "explicit" });
    renderEvent(tui, {
      type: "spec_draft_ready",
      specId: "spec_42",
      topic: "kernel image",
      understanding: {},
    });
    const snap = tui.snapshot();
    expect(snap.specProgress?.specId).toBe("spec_42");
    expect(snap.specProgress?.topic).toBe("kernel image");
  });
});

describe("renderEvent spec_confirmation_required", () => {
  it("triggers confirmation UI with mapped decisions", () => {
    const tui = createTui();
    renderEvent(tui, { type: "spec_start", input: "test", trigger: "explicit" });
    renderEvent(tui, {
      type: "spec_confirmation_required",
      specId: "spec_123",
      decisions: [
        {
          id: "d1",
          point: "Which approach?",
          severity: "critical",
          options: [
            { label: "A", description: "first", tradeoffs: "fast" },
            { label: "B", description: "second", tradeoffs: "safe" },
          ],
        },
      ],
    });
    const snap = tui.snapshot();
    expect(snap.specConfirmation?.specId).toBe("spec_123");
    expect(snap.specConfirmation?.decisions).toHaveLength(1);
    expect(snap.specConfirmation?.decisions[0]?.id).toBe("d1");
    expect(snap.specConfirmation?.decisions[0]?.options).toHaveLength(2);
    expect(snap.specConfirmation?.decisions[0]?.selectedIndex).toBe(0);
  });
});

describe("renderEvent spec_confirmed", () => {
  it("clears confirmation UI", () => {
    const tui = createTui();
    renderEvent(tui, { type: "spec_start", input: "test", trigger: "explicit" });
    renderEvent(tui, {
      type: "spec_confirmation_required",
      specId: "spec_1",
      decisions: [],
    });
    expect(tui.snapshot().specConfirmation).toBeDefined();
    renderEvent(tui, {
      type: "spec_confirmed",
      specId: "spec_1",
      decisions: [],
    });
    expect(tui.snapshot().specConfirmation).toBeUndefined();
  });
});

describe("renderEvent spec_skipped", () => {
  it("sets spec progress to skipped phase", () => {
    const tui = createTui();
    renderEvent(tui, { type: "spec_start", input: "test", trigger: "auto" });
    renderEvent(tui, { type: "spec_skipped", reason: "classifier: clear enough" });
    const snap = tui.snapshot();
    expect(snap.specProgress?.phase).toBe("skipped");
  });
});

describe("renderEvent spec_completed", () => {
  it("sets spec progress to completed phase", () => {
    const tui = createTui();
    renderEvent(tui, { type: "spec_start", input: "test", trigger: "explicit" });
    renderEvent(tui, {
      type: "spec_completed",
      specId: "spec_99",
      enhancedPrompt: "enhanced text",
    });
    const snap = tui.snapshot();
    expect(snap.specProgress?.phase).toBe("completed");
    expect(snap.specProgress?.specId).toBe("spec_99");
  });
});

describe("renderEvent reasoning_delta", () => {
  it("appends reasoning text", () => {
    const tui = createTui();
    renderEvent(tui, { type: "reasoning_delta", delta: "thinking..." });
    const snap = tui.snapshot();
    expect(snap.reasoning).toContain("thinking");
  });
});

describe("renderEvent onSpecConfirm integration", () => {
  it("onSpecConfirm callback fires when confirmation completes via navigation", () => {
    const onConfirm = vi.fn();
    const tui = createTui({ onSpecConfirm: onConfirm });
    renderEvent(tui, { type: "spec_start", input: "test", trigger: "explicit" });
    renderEvent(tui, {
      type: "spec_confirmation_required",
      specId: "spec_1",
      decisions: [
        {
          id: "d1",
          point: "Pick",
          severity: "critical",
          options: [{ label: "A", description: "a", tradeoffs: "" }],
        },
      ],
    });
    tui.confirmSpecNavigation("confirm");
    expect(onConfirm).toHaveBeenCalledWith("spec_1", { d1: "A" });
  });
});
