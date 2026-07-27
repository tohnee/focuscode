import { fg, type TuiTheme } from "./themes.js";
import { sanitizeTerminalText } from "./width.js";

/**
 * Full-screen model picker: a list of providers with their models, fuzzy
 * filtering by query, and reasoning-effort selection (off/minimal/low/medium/
 * high/max). Pure state + render helpers — input handling lives in app.ts.
 *
 * The picker is intentionally renderer-agnostic: it produces ANSI lines that
 * the TUI renderer embeds inside its body area.
 */

export type ReasoningEffort = "off" | "minimal" | "low" | "medium" | "high" | "max";

export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "max",
];

export interface PickerModel {
  /** Fully-qualified model id, e.g. "kimi/k2". */
  id: string;
  /** Display label; defaults to id when omitted. */
  label?: string;
  /** Optional free-form description shown beneath the label. */
  description?: string;
}

export interface PickerProvider {
  id: string;
  label: string;
  models: PickerModel[];
}

export interface PickerState {
  /** All providers and models available for selection. */
  providers: PickerProvider[];
  /** Active provider index; Tab cycles to the next. */
  activeProvider: number;
  /** Currently selected model id, if any. */
  selectedModel?: string | undefined;
  /** Fuzzy query typed by the user. */
  query: string;
  /** Active reasoning-effort slot. */
  reasoningEffort: ReasoningEffort;
  /**
   * When true, the selected model + reasoning effort only apply to the current
   * session; otherwise they persist as the profile default.
   */
  sessionOnly: boolean;
  /** Highlighted row within the currently filtered list. */
  cursor: number;
}

export interface PickerInit {
  providers: PickerProvider[];
  selectedModel?: string | undefined;
  reasoningEffort?: ReasoningEffort;
  sessionOnly?: boolean;
}

export function createPickerState(init: PickerInit): PickerState {
  const providers = init.providers.length ? init.providers : [];
  const activeProvider = init.selectedModel
    ? Math.max(
        0,
        providers.findIndex((provider) =>
          provider.models.some((model) => model.id === init.selectedModel),
        ),
      )
    : 0;
  return {
    providers,
    activeProvider: activeProvider < 0 ? 0 : activeProvider,
    ...(init.selectedModel ? { selectedModel: init.selectedModel } : {}),
    query: "",
    reasoningEffort: init.reasoningEffort ?? "off",
    sessionOnly: init.sessionOnly ?? false,
    cursor: 0,
  };
}

/** Fuzzy match: every char of the query appears, in order, in the target. */
export function fuzzyMatch(query: string, target: string): boolean {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q) return true;
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti += 1) {
    if (t[ti] === q[qi]) qi += 1;
  }
  return qi === q.length;
}

/** Filter the active provider's models by the current query. */
export function pickerVisibleModels(state: PickerState): PickerModel[] {
  const provider = state.providers[state.activeProvider];
  if (!provider) return [];
  if (!state.query) return provider.models;
  return provider.models.filter((model) => {
    const label = (model.label ?? model.id) + " " + model.id + " " + (model.description ?? "");
    return fuzzyMatch(state.query, label);
  });
}

export interface PickerUpdate {
  query?: string;
  cursor?: number;
  activeProvider?: number;
  reasoningEffort?: ReasoningEffort;
  sessionOnly?: boolean;
  selectedModel?: string;
}

/** Apply a partial update; cursor is clamped to the new visible-list length. */
export function updatePicker(state: PickerState, update: PickerUpdate): PickerState {
  const next: PickerState = {
    ...state,
    ...(update.query !== undefined ? { query: update.query } : {}),
    ...(update.activeProvider !== undefined ? { activeProvider: update.activeProvider } : {}),
    ...(update.reasoningEffort !== undefined ? { reasoningEffort: update.reasoningEffort } : {}),
    ...(update.sessionOnly !== undefined ? { sessionOnly: update.sessionOnly } : {}),
    ...(update.selectedModel !== undefined ? { selectedModel: update.selectedModel } : {}),
  };
  const visible = pickerVisibleModels(next);
  const max = Math.max(0, visible.length - 1);
  const cursor =
    update.cursor !== undefined
      ? Math.max(0, Math.min(max, update.cursor))
      : Math.max(0, Math.min(state.cursor, max));
  next.cursor = cursor;
  return next;
}

/** Cycle to the next non-empty provider; wraps around. */
export function cycleProvider(state: PickerState, direction: 1 | -1 = 1): PickerState {
  if (state.providers.length <= 1) return state;
  let next = (state.activeProvider + direction + state.providers.length) % state.providers.length;
  let safety = 0;
  while (state.providers[next]?.models.length === 0 && safety < state.providers.length) {
    next = (next + direction + state.providers.length) % state.providers.length;
    safety += 1;
  }
  return updatePicker(state, { activeProvider: next, cursor: 0 });
}

/** Cycle reasoning effort forward through REASONING_EFFORTS. */
export function cycleReasoningEffort(state: PickerState, direction: 1 | -1 = 1): PickerState {
  const index = REASONING_EFFORTS.indexOf(state.reasoningEffort);
  const next = (index + direction + REASONING_EFFORTS.length) % REASONING_EFFORTS.length;
  return updatePicker(state, { reasoningEffort: REASONING_EFFORTS[next]! });
}

export interface PickerResult {
  model: string;
  reasoningEffort: ReasoningEffort;
  sessionOnly: boolean;
}

/** Confirm the highlighted model; returns undefined when nothing is visible. */
export function confirmPicker(state: PickerState): PickerResult | undefined {
  const visible = pickerVisibleModels(state);
  const model = visible[state.cursor] ?? visible[0];
  if (!model) return undefined;
  return {
    model: model.id,
    reasoningEffort: state.reasoningEffort,
    sessionOnly: state.sessionOnly,
  };
}

export interface PickerRenderOptions {
  width: number;
  height: number;
  theme: TuiTheme;
}

/** Render the picker as trusted ANSI lines that fit `width` columns. */
export function renderPicker(state: PickerState, options: PickerRenderOptions): string[] {
  const width = Math.max(40, options.width);
  const height = Math.max(12, options.height);
  const theme = options.theme;
  const provider = state.providers[state.activeProvider];
  const visible = pickerVisibleModels(state);
  const header =
    fg(theme.accent, "Model picker") +
    "  " +
    fg(theme.muted, "Tab provider · ↑↓ navigate · Enter confirm · Esc cancel · Alt+S session-only");
  const providerTabs = state.providers
    .map((item, index) => {
      const label = sanitizeTerminalText(item.label);
      if (index === state.activeProvider) return fg(theme.accent, "[" + label + "]");
      return fg(theme.muted, " " + label + " ");
    })
    .join("");
  const queryLine =
    fg(theme.muted, "filter› ") + fg(theme.foreground, sanitizeTerminalText(state.query) || " ");
  const effortLine =
    fg(theme.muted, "reasoning› ") +
    REASONING_EFFORTS.map((effort) =>
      effort === state.reasoningEffort
        ? fg(theme.accent, "[" + effort + "]")
        : fg(theme.muted, " " + effort + " "),
    ).join("");
  const sessionLine =
    fg(theme.muted, "scope› ") +
    (state.sessionOnly
      ? fg(theme.warning, "[session-only]")
      : fg(theme.success, "[profile default]"));
  const separator = fg(theme.muted, "─".repeat(width));
  const lines = [header, providerTabs, queryLine, effortLine, sessionLine, separator];
  const bodyHeight = Math.max(3, height - lines.length - 1);
  const start = Math.min(Math.max(state.cursor - 2, 0), Math.max(0, visible.length - bodyHeight));
  const slice = visible.slice(start, start + bodyHeight);
  for (let offset = 0; offset < bodyHeight; offset += 1) {
    const model = slice[offset];
    if (!model) {
      lines.push("");
      continue;
    }
    const absoluteIndex = start + offset;
    const active = absoluteIndex === state.cursor;
    const prefix = active ? "› " : "  ";
    const label = sanitizeTerminalText(model.label ?? model.id);
    const idText = sanitizeTerminalText(model.id);
    const description = model.description ? "  " + sanitizeTerminalText(model.description) : "";
    const row =
      prefix +
      (active ? fg(theme.accent, label) : fg(theme.foreground, label)) +
      "  " +
      fg(theme.muted, idText) +
      description;
    lines.push(truncatePlain(row, width));
  }
  lines.push(separator);
  return lines;
}

function truncatePlain(value: string, width: number): string {
  const clean = value.replace(/\u001b\[[0-9;]*m/g, "");
  if (clean.length <= width) return value;
  // Strip ANSI, truncate the plain text, then drop styling on overflow.
  return clean.slice(0, Math.max(0, width - 1)) + "…";
}

function _pickerUnusedFg(): void {
  void fg;
}
// Note: `fg` is re-exported transitively via the import above; the helper
// ensures the import is not tree-shaken in type-only consumers.
