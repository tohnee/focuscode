import { describe, expect, it } from "vitest";
import {
  confirmPicker,
  createPickerState,
  cycleProvider,
  cycleReasoningEffort,
  fuzzyMatch,
  pickerVisibleModels,
  renderPicker,
  REASONING_EFFORTS,
  updatePicker,
  type PickerInit,
  type PickerProvider,
  type PickerState,
  type TuiTheme,
} from "../src/index.js";

const THEME: TuiTheme = {
  id: "test",
  name: "Test",
  background: 232,
  foreground: 252,
  accent: 75,
  secondary: 99,
  success: 48,
  warning: 214,
  danger: 197,
  muted: 240,
  border: "─",
};

const PROVIDERS: PickerProvider[] = [
  {
    id: "kimi",
    label: "Kimi",
    models: [
      { id: "kimi/k2", label: "K2" },
      { id: "kimi/k1.5", label: "K1.5" },
    ],
  },
  {
    id: "glm",
    label: "GLM",
    models: [
      { id: "glm/glm-4.6", label: "GLM 4.6" },
      { id: "glm/glm-4.5", label: "GLM 4.5" },
    ],
  },
  {
    id: "empty",
    label: "Empty",
    models: [],
  },
];

function state(init?: Partial<PickerInit>): PickerState {
  return createPickerState({ providers: PROVIDERS, ...init });
}

describe("picker.fuzzyMatch", () => {
  it("matches when every query char appears in order", () => {
    expect(fuzzyMatch("k2", "kimi/k2")).toBe(true);
    expect(fuzzyMatch("k2", "kimi/k1.5")).toBe(false);
    expect(fuzzyMatch("g46", "glm/glm-4.6")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(fuzzyMatch("K2", "kimi/k2")).toBe(true);
    expect(fuzzyMatch("GLM", "glm/glm-4.6")).toBe(true);
  });

  it("returns true for an empty query", () => {
    expect(fuzzyMatch("", "anything")).toBe(true);
  });

  it("returns false when a query char is absent", () => {
    expect(fuzzyMatch("xyz", "kimi/k2")).toBe(false);
  });
});

describe("picker.createPickerState", () => {
  it("initializes with sensible defaults", () => {
    const s = state();
    expect(s.providers).toBe(PROVIDERS);
    expect(s.activeProvider).toBe(0);
    expect(s.query).toBe("");
    expect(s.reasoningEffort).toBe("off");
    expect(s.sessionOnly).toBe(false);
    expect(s.cursor).toBe(0);
    expect(s.selectedModel).toBeUndefined();
  });

  it("derives the active provider from selectedModel", () => {
    const s = state({ selectedModel: "glm/glm-4.6" });
    expect(s.activeProvider).toBe(1);
    expect(s.selectedModel).toBe("glm/glm-4.6");
  });

  it("falls back to provider 0 when selectedModel is unknown", () => {
    const s = state({ selectedModel: "nope/nope" });
    expect(s.activeProvider).toBe(0);
  });

  it("honors explicit reasoningEffort and sessionOnly", () => {
    const s = state({ reasoningEffort: "high", sessionOnly: true });
    expect(s.reasoningEffort).toBe("high");
    expect(s.sessionOnly).toBe(true);
  });

  it("handles an empty provider list without throwing", () => {
    const s = createPickerState({ providers: [] });
    expect(s.providers).toEqual([]);
    expect(s.activeProvider).toBe(0);
  });
});

describe("picker.pickerVisibleModels", () => {
  it("returns all models for the active provider when query is empty", () => {
    const s = state();
    expect(pickerVisibleModels(s)).toHaveLength(2);
  });

  it("filters by fuzzy match across label, id and description", () => {
    const s = updatePicker(state(), { query: "k2" });
    const visible = pickerVisibleModels(s);
    expect(visible.map((m) => m.id)).toEqual(["kimi/k2"]);
  });

  it("returns an empty list when the active provider has no models", () => {
    const s = updatePicker(state(), { activeProvider: 2 });
    expect(pickerVisibleModels(s)).toEqual([]);
  });
});

describe("picker.updatePicker", () => {
  it("applies partial updates without touching other fields", () => {
    const s = state({ reasoningEffort: "high" });
    const next = updatePicker(s, { query: "k" });
    expect(next.query).toBe("k");
    expect(next.reasoningEffort).toBe("high");
    expect(next.sessionOnly).toBe(false);
  });

  it("clamps cursor to the visible list length", () => {
    const s = state();
    const next = updatePicker(s, { cursor: 99 });
    expect(next.cursor).toBe(1); // 2 models → max index 1
  });

  it("clamps cursor to 0 when the visible list is empty", () => {
    const s = updatePicker(state(), { activeProvider: 2, cursor: 0 });
    const next = updatePicker(s, { cursor: 5 });
    expect(next.cursor).toBe(0);
  });

  it("preserves the existing cursor when no cursor update is given", () => {
    const s = updatePicker(state(), { cursor: 1 });
    const next = updatePicker(s, { query: "k" });
    // query "k" matches both kimi models → visible length 2 → cursor clamps to 1.
    expect(next.cursor).toBe(1);
  });

  it("clamps preserved cursor to the new visible length", () => {
    const s = updatePicker(state(), { cursor: 1 });
    const next = updatePicker(s, { query: "k2" });
    // query "k2" matches only kimi/k2 → visible length 1 → cursor clamps to 0.
    expect(next.cursor).toBe(0);
  });

  it("treats undefined values as no-op for optional fields", () => {
    const s = state({ sessionOnly: true });
    const next = updatePicker(s, { sessionOnly: undefined });
    expect(next.sessionOnly).toBe(true);
  });
});

describe("picker.cycleProvider", () => {
  it("cycles forward through providers and wraps around", () => {
    // Use a fixture without empty providers so every index is reachable.
    const providers: PickerProvider[] = [
      { id: "a", label: "A", models: [{ id: "a/1" }] },
      { id: "b", label: "B", models: [{ id: "b/1" }] },
      { id: "c", label: "C", models: [{ id: "c/1" }] },
    ];
    let s = createPickerState({ providers });
    s = cycleProvider(s);
    expect(s.activeProvider).toBe(1);
    s = cycleProvider(s);
    expect(s.activeProvider).toBe(2);
    s = cycleProvider(s);
    expect(s.activeProvider).toBe(0);
  });

  it("skips empty providers in either direction", () => {
    let s = state();
    s = updatePicker(s, { activeProvider: 1 });
    s = cycleProvider(s); // 1 → would be 2 (empty) → wrap to 0
    expect(s.activeProvider).toBe(0);
    s = cycleProvider(s, -1); // 0 → wrap to 2 (empty) → 1
    expect(s.activeProvider).toBe(1);
  });

  it("resets the cursor to 0 on provider switch", () => {
    let s = updatePicker(state(), { cursor: 1 });
    s = cycleProvider(s);
    expect(s.cursor).toBe(0);
  });

  it("is a no-op when only one provider is present", () => {
    const single: PickerProvider[] = [{ id: "solo", label: "Solo", models: [{ id: "solo/1" }] }];
    const s = createPickerState({ providers: single });
    expect(cycleProvider(s).activeProvider).toBe(0);
  });
});

describe("picker.cycleReasoningEffort", () => {
  it("cycles forward through REASONING_EFFORTS and wraps", () => {
    let s = state({ reasoningEffort: "off" });
    for (const expected of REASONING_EFFORTS.slice(1)) {
      s = cycleReasoningEffort(s);
      expect(s.reasoningEffort).toBe(expected);
    }
    s = cycleReasoningEffort(s);
    expect(s.reasoningEffort).toBe("off");
  });

  it("cycles backward with direction -1", () => {
    let s = state({ reasoningEffort: "off" });
    s = cycleReasoningEffort(s, -1);
    expect(s.reasoningEffort).toBe("max");
  });
});

describe("picker.confirmPicker", () => {
  it("returns the highlighted model with current effort and scope", () => {
    const s = updatePicker(state(), { reasoningEffort: "high", sessionOnly: true });
    const result = confirmPicker(s);
    expect(result).toEqual({
      model: "kimi/k2",
      reasoningEffort: "high",
      sessionOnly: true,
    });
  });

  it("falls back to the first visible model when cursor is beyond bounds", () => {
    // Construct a state where cursor points past the end of the visible list
    // without going through updatePicker's clamping.
    const base = state();
    const outOfRange: PickerState = { ...base, cursor: 99 };
    const result = confirmPicker(outOfRange);
    expect(result?.model).toBe("kimi/k2");
  });

  it("returns the clamped cursor model after updatePicker", () => {
    // updatePicker clamps cursor to the visible list max; confirmPicker then
    // returns that clamped position, not visible[0].
    const s = updatePicker(state(), { cursor: 99 });
    expect(s.cursor).toBe(1);
    const result = confirmPicker(s);
    expect(result?.model).toBe("kimi/k1.5");
  });

  it("returns undefined when no models are visible", () => {
    const s = updatePicker(state(), { activeProvider: 2 });
    expect(confirmPicker(s)).toBeUndefined();
  });
});

describe("picker.renderPicker", () => {
  it("emits header, provider tabs, query, effort, scope and body lines", () => {
    const s = state();
    const lines = renderPicker(s, { width: 60, height: 20, theme: THEME });
    expect(lines.length).toBeGreaterThanOrEqual(7);
    expect(lines[0]).toContain("Model picker");
    expect(lines[1]).toContain("[Kimi]");
    expect(lines[1]).toContain("GLM");
    expect(lines[2]).toContain("filter›");
    expect(lines[3]).toContain("reasoning›");
    expect(lines[4]).toContain("scope›");
  });

  it("clamps width and height to minimums without throwing", () => {
    const s = state();
    const lines = renderPicker(s, { width: 1, height: 1, theme: THEME });
    expect(lines.length).toBeGreaterThan(0);
  });

  it("highlights the active row with the accent color", () => {
    const s = state();
    const lines = renderPicker(s, { width: 60, height: 20, theme: THEME });
    // Body starts after the separator (line 5 is the separator; line 6 is the first row).
    const firstRow = lines[6] ?? "";
    expect(firstRow).toContain("›");
  });

  it("uses warning color when sessionOnly is true", () => {
    const s = updatePicker(state(), { sessionOnly: true });
    const lines = renderPicker(s, { width: 60, height: 20, theme: THEME });
    const scopeLine = lines[4] ?? "";
    expect(scopeLine).toContain("[session-only]");
  });

  it("never emits non-SGR ANSI escapes", () => {
    const s = state();
    const lines = renderPicker(s, { width: 60, height: 20, theme: THEME });
    for (const line of lines) {
      const sgrOnly = line.replace(/\u001b\[[0-9;]*m/g, "");
      expect(sgrOnly).not.toMatch(/\u001b/g);
    }
  });
});
