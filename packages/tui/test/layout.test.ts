import { describe, expect, it } from "vitest";
import {
  computeLayout,
  createInitialLayout,
  cycleLayoutMode,
  LAYOUT_MODES,
  setLayoutMode,
  type LayoutMode,
  type LayoutState,
} from "../src/layout.js";

describe("layout module", () => {
  it("createInitialLayout returns classic mode with default panes", () => {
    const state = createInitialLayout();
    expect(state.mode).toBe("classic");
    expect(state.activePane).toBe("transcript");
    expect(state.panes.length).toBeGreaterThan(0);
    const todo = state.panes.find((p) => p.id === "todo");
    expect(todo?.visible).toBe(false);
  });

  it("LAYOUT_MODES lists all four modes in cycle order", () => {
    expect(LAYOUT_MODES).toEqual(["classic", "split", "focus", "wide"]);
  });

  it("cycleLayoutMode advances mode forward and wraps", () => {
    expect(cycleLayoutMode("classic")).toBe("split");
    expect(cycleLayoutMode("split")).toBe("focus");
    expect(cycleLayoutMode("focus")).toBe("wide");
    expect(cycleLayoutMode("wide")).toBe("classic");
  });

  it("setLayoutMode split shows sidebar panes", () => {
    const initial = createInitialLayout();
    const next = setLayoutMode(initial, "split");
    expect(next.mode).toBe("split");
    const todo = next.panes.find((p) => p.id === "todo");
    expect(todo?.visible).toBe(true);
  });

  it("setLayoutMode classic hides sidebar panes", () => {
    const split = setLayoutMode(createInitialLayout(), "split");
    const classic = setLayoutMode(split, "classic");
    const todo = classic.panes.find((p) => p.id === "todo");
    expect(todo?.visible).toBe(false);
  });

  it("computeLayout classic produces single main pane spanning full body", () => {
    const state = createInitialLayout();
    const layout = computeLayout(state, 120, 40);
    expect(layout.main).toBeDefined();
    expect(layout.main.width).toBeGreaterThan(80);
    expect(layout.sidebar).toBeUndefined();
  });

  it("computeLayout split produces main + sidebar at 70/30 ratio", () => {
    const state: LayoutState = { ...createInitialLayout(), mode: "split" };
    const layout = computeLayout(state, 120, 40);
    expect(layout.main).toBeDefined();
    expect(layout.sidebar).toBeDefined();
    expect(layout.sidebar!.width).toBeLessThan(layout.main.width);
    expect(layout.sidebar!.width).toBeGreaterThan(20);
    expect(layout.main.width + layout.sidebar!.width).toBeLessThanOrEqual(118);
  });

  it("computeLayout focus hides mascot and sidebar, full-width transcript", () => {
    const state: LayoutState = { ...createInitialLayout(), mode: "focus" };
    const layout = computeLayout(state, 120, 40);
    expect(layout.sidebar).toBeUndefined();
    expect(layout.hideMascot).toBe(true);
    expect(layout.main.width).toBeGreaterThan(100);
  });

  it("computeLayout wide produces main + wider sidebar at 60/40 ratio", () => {
    const state: LayoutState = { ...createInitialLayout(), mode: "wide" };
    const layout = computeLayout(state, 160, 40);
    expect(layout.main).toBeDefined();
    expect(layout.sidebar).toBeDefined();
    expect(layout.sidebar!.width).toBeGreaterThan(layout.main.width * 0.5);
  });

  it("computeLayout forces classic when width < 100", () => {
    const state: LayoutState = { ...createInitialLayout(), mode: "split" };
    const layout = computeLayout(state, 80, 40);
    expect(layout.sidebar).toBeUndefined();
    expect(layout.mode).toBe("classic");
  });

  it("computeLayout forces classic when height < 20", () => {
    const state: LayoutState = { ...createInitialLayout(), mode: "wide" };
    const layout = computeLayout(state, 160, 15);
    expect(layout.sidebar).toBeUndefined();
    expect(layout.mode).toBe("classic");
  });

  it("PaneConfig side field is one of left/right/bottom/main", () => {
    const state = createInitialLayout();
    for (const pane of state.panes) {
      expect(["left", "right", "bottom", "main"]).toContain(pane.side);
    }
  });

  it("LayoutMode type accepts all four values", () => {
    const modes: LayoutMode[] = ["classic", "split", "focus", "wide"];
    expect(modes).toHaveLength(4);
  });
});
