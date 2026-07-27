import { describe, expect, it } from "vitest";
import { FullScreenTui } from "@focuscode/tui";
import { TUI_MASCOTS, TUI_THEMES } from "@focuscode/tui";
import { runLayoutSubcommand, runTodoPanelSubcommand } from "../src/tui.js";

function createTui(): FullScreenTui {
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
  });
}

describe("runLayoutSubcommand", () => {
  it("cycle with no args advances to next mode", () => {
    const tui = createTui();
    expect(tui.snapshot().layout?.mode).toBe("classic");
    const result = runLayoutSubcommand(tui, "");
    expect(result).toContain("split");
    expect(tui.snapshot().layout?.mode).toBe("split");
  });

  it("explicit 'cycle' arg also advances", () => {
    const tui = createTui();
    runLayoutSubcommand(tui, "cycle");
    expect(tui.snapshot().layout?.mode).toBe("split");
  });

  it("sets specific mode 'split'", () => {
    const tui = createTui();
    const result = runLayoutSubcommand(tui, "split");
    expect(tui.snapshot().layout?.mode).toBe("split");
    expect(result).toContain("split");
  });

  it("sets specific mode 'focus'", () => {
    const tui = createTui();
    runLayoutSubcommand(tui, "focus");
    expect(tui.snapshot().layout?.mode).toBe("focus");
  });

  it("sets specific mode 'wide'", () => {
    const tui = createTui();
    runLayoutSubcommand(tui, "wide");
    expect(tui.snapshot().layout?.mode).toBe("wide");
  });

  it("sets specific mode 'classic'", () => {
    const tui = createTui();
    runLayoutSubcommand(tui, "split");
    runLayoutSubcommand(tui, "classic");
    expect(tui.snapshot().layout?.mode).toBe("classic");
  });

  it("unknown mode returns usage hint", () => {
    const tui = createTui();
    const result = runLayoutSubcommand(tui, "diagonal");
    expect(result).toContain("Usage");
    expect(tui.snapshot().layout?.mode).toBe("classic");
  });
});

describe("runTodoPanelSubcommand", () => {
  it("toggle with no args flips visibility", () => {
    const tui = createTui();
    expect(tui.snapshot().todoPanel?.visible).toBe(true);
    const result = runTodoPanelSubcommand(tui, "");
    expect(tui.snapshot().todoPanel?.visible).toBe(false);
    expect(result).toContain("off");
  });

  it("explicit 'toggle' arg also flips", () => {
    const tui = createTui();
    runTodoPanelSubcommand(tui, "toggle");
    expect(tui.snapshot().todoPanel?.visible).toBe(false);
  });

  it("'on' makes panel visible", () => {
    const tui = createTui();
    runTodoPanelSubcommand(tui, "off");
    expect(tui.snapshot().todoPanel?.visible).toBe(false);
    runTodoPanelSubcommand(tui, "on");
    expect(tui.snapshot().todoPanel?.visible).toBe(true);
  });

  it("'off' makes panel invisible", () => {
    const tui = createTui();
    runTodoPanelSubcommand(tui, "off");
    expect(tui.snapshot().todoPanel?.visible).toBe(false);
  });

  it("unknown arg returns usage hint", () => {
    const tui = createTui();
    const result = runTodoPanelSubcommand(tui, "diagonal");
    expect(result).toContain("Usage");
    expect(tui.snapshot().todoPanel?.visible).toBe(true);
  });
});
