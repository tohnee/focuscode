import { describe, expect, it } from "vitest";
import { renderDiff } from "../src/diff.js";
import {
  createInitialSpecProgress,
  createSpecConfirmation,
  renderSpecConfirmation,
  renderSpecProgress,
  type SpecProgressState,
} from "../src/spec-progress.js";
import { TUI_THEMES } from "../src/themes.js";
import { addTodoItem, createInitialTodoPanel, renderTodoPanel } from "../src/todo-panel.js";
import { sanitizeTerminalText } from "../src/width.js";

/**
 * Regression: model/engine/file-derived strings rendered into the terminal
 * must never carry hostile CSI/OSC/bare-ESC sequences (documented rule:
 * distrust terminal control characters from model/tool/extension output).
 * The renderers' own SGR styling (fg/bold) is expected and allowed; the
 * hostile sequences (clear-screen, OSC title, BEL) must be gone.
 */
const theme = TUI_THEMES[0]!;
const HOSTILE = "\u001b[2J\u001b]0;owned\u0007evil\u001b[31mtext";

function progressWith(topic: string, skipReason?: string): SpecProgressState {
  const state = createInitialSpecProgress();
  return {
    ...state,
    phase: skipReason !== undefined ? "skipped" : "draft",
    topic,
    skipReason,
  };
}

function expectNoHostileSequences(output: string): void {
  expect(output).not.toContain("\u001b[2J"); // CSI clear screen
  expect(output).not.toContain("\u001b]"); // OSC
  expect(output).not.toContain("\u0007"); // BEL
}

describe("terminal-injection hardening", () => {
  it("sanitizes model-derived strings rendered via spec-progress", () => {
    const lines = renderSpecProgress(progressWith(HOSTILE, "skip: " + HOSTILE), 60, theme);
    expectNoHostileSequences(lines.join("\n"));
    expect(lines.join("\n")).toContain("evil");
    expect(lines.join("\n")).toContain("text");
  });

  it("sanitizes spec confirmation decision/option strings", () => {
    const confirmation = createSpecConfirmation("spec-" + HOSTILE, [
      {
        id: "d1",
        severity: "high",
        point: HOSTILE,
        options: [
          { label: HOSTILE, description: HOSTILE },
          { label: "safe", description: "ok" },
        ],
      },
    ]);
    const joined = renderSpecConfirmation(confirmation, 60, theme).join("\n");
    expectNoHostileSequences(joined);
    expect(joined).toContain("evil");
    expect(joined).toContain("text");
  });

  it("sanitizes todo content (SpecEngine-injected) in the todo panel", () => {
    const panel = addTodoItem(createInitialTodoPanel(), HOSTILE);
    const joined = renderTodoPanel(panel, 40, 20, theme).join("\n");
    expectNoHostileSequences(joined);
    expect(joined).toContain("evil");
  });

  it("sanitizes file content rendered in diffs", () => {
    const joined = renderDiff("before " + HOSTILE + "\n", "after " + HOSTILE + "\n", 60).join("\n");
    expectNoHostileSequences(joined);
    expect(joined).toContain("evil");
  });

  it("sanitizeTerminalText removes CSI, OSC and bare ESC", () => {
    expect(sanitizeTerminalText(HOSTILE)).not.toContain("\u001b");
    expect(sanitizeTerminalText("\u001b[31mred\u001b[0m")).toBe("red");
  });
});
