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
  it("createInitialLayout returns workbench mode (yazi×tmux default) with default panes", () => {
    const state = createInitialLayout();
    expect(state.mode).toBe("workbench");
    expect(state.activePane).toBe("transcript");
    expect(state.panes.length).toBeGreaterThan(0);
    const todo = state.panes.find((p) => p.id === "todo");
    expect(todo?.visible).toBe(false);
  });

  it("LAYOUT_MODES lists all six modes in cycle order", () => {
    expect(LAYOUT_MODES).toEqual(["workbench", "classic", "split", "focus", "wide", "minimal"]);
  });

  it("cycleLayoutMode advances mode forward and wraps", () => {
    expect(cycleLayoutMode("workbench")).toBe("classic");
    expect(cycleLayoutMode("classic")).toBe("split");
    expect(cycleLayoutMode("split")).toBe("focus");
    expect(cycleLayoutMode("focus")).toBe("wide");
    expect(cycleLayoutMode("wide")).toBe("minimal");
    expect(cycleLayoutMode("minimal")).toBe("workbench");
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

  it("computeLayout (default workbench) produces three-column geometry", () => {
    const state = createInitialLayout();
    const layout = computeLayout(state, 180, 40);
    expect(layout.mode).toBe("workbench");
    expect(layout.nav).toBeDefined();
    expect(layout.preview).toBeDefined();
    expect(layout.main).toBeDefined();
    // nav 在左，preview 在右，main 居中
    expect(layout.nav!.col).toBe(0);
    expect(layout.main.col).toBe(layout.nav!.width);
    expect(layout.preview!.col).toBe(layout.nav!.width + layout.main.width);
    // 三栏宽合计不超过屏幕
    expect(layout.nav!.width + layout.main.width + layout.preview!.width).toBeLessThanOrEqual(180);
    expect(layout.hideMascot).toBe(true);
  });

  it("computeLayout workbench hides preview below 140 columns, keeps nav", () => {
    const state = createInitialLayout();
    const layout = computeLayout(state, 120, 40);
    expect(layout.mode).toBe("workbench");
    expect(layout.preview).toBeUndefined();
    expect(layout.nav).toBeDefined();
  });

  it("computeLayout workbench hides nav below 100 columns (single-pane fallback)", () => {
    const state = createInitialLayout();
    const layout = computeLayout(state, 80, 40);
    expect(layout.mode).toBe("workbench");
    expect(layout.nav).toBeUndefined();
    expect(layout.preview).toBeUndefined();
    expect(layout.main.width).toBeGreaterThanOrEqual(70);
  });

  it("computeLayout workbench zoom hides both side columns (tmux C-b z)", () => {
    const state: LayoutState = { ...createInitialLayout(), zoom: true };
    const layout = computeLayout(state, 180, 40);
    expect(layout.mode).toBe("workbench");
    expect(layout.nav).toBeUndefined();
    expect(layout.preview).toBeUndefined();
    expect(layout.main.width).toBe(180);
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

  it("computeLayout minimal hides mascot/sidebar and spans full width", () => {
    const state: LayoutState = { ...createInitialLayout(), mode: "minimal" };
    const layout = computeLayout(state, 120, 40);
    expect(layout.mode).toBe("minimal");
    expect(layout.sidebar).toBeUndefined();
    expect(layout.hideMascot).toBe(true);
    expect(layout.main.width).toBe(120);
  });

  it("computeLayout minimal is NOT forced back to classic on narrow terminals", () => {
    // minimal has no sidebar, so the <100 column fallback must not apply.
    const state: LayoutState = { ...createInitialLayout(), mode: "minimal" };
    const layout = computeLayout(state, 60, 12);
    expect(layout.mode).toBe("minimal");
    expect(layout.main.width).toBe(60);
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

  it("LayoutMode type accepts all six values", () => {
    const modes: LayoutMode[] = ["workbench", "classic", "split", "focus", "wide", "minimal"];
    expect(modes).toHaveLength(6);
  });
});
