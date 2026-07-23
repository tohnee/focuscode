import { fg, type TuiTheme } from "./themes.js";

export type SpecPhase =
  | "idle"
  | "start"
  | "classify"
  | "explore"
  | "draft"
  | "detect-decisions"
  | "enhance"
  | "skipped"
  | "completed";

export type SpecStageStatus = "pending" | "running" | "done" | "failed";

export interface SpecStageInfo {
  name: string;
  model?: string;
  durationMs?: number;
  fellBack?: boolean;
  status: SpecStageStatus;
}

export interface SpecDecisionView {
  id: string;
  point: string;
  severity: "critical" | "major" | "minor";
  options: { label: string; description: string }[];
  selectedIndex: number;
}

export interface SpecProgressState {
  phase: SpecPhase;
  trigger?: "auto" | "explicit";
  specId?: string;
  topic?: string;
  stages: SpecStageInfo[];
  startTime?: number;
  totalDuration?: number;
  pendingDecisions?: SpecDecisionView[];
}

export interface SpecConfirmationState {
  specId: string;
  decisions: SpecDecisionView[];
  currentDecisionIndex: number;
  completed: boolean;
}

export type ConfirmationAction = "option_up" | "option_down" | "confirm" | "cancel";

const STATUS_ICONS: Record<SpecStageStatus, string> = {
  pending: "○",
  running: "◐",
  done: "●",
  failed: "✗",
};

export function createInitialSpecProgress(): SpecProgressState {
  return { phase: "idle", stages: [] };
}

export function createSpecConfirmation(
  specId: string,
  decisions: SpecDecisionView[],
): SpecConfirmationState {
  return {
    specId,
    decisions: decisions.map((d) => ({ ...d, options: [...d.options] })),
    currentDecisionIndex: 0,
    completed: false,
  };
}

export function advanceConfirmation(
  state: SpecConfirmationState,
  action: ConfirmationAction,
): SpecConfirmationState {
  if (state.completed) return state;
  const current = state.decisions[state.currentDecisionIndex];
  if (!current) return state;

  if (action === "cancel") {
    return { ...state, completed: true };
  }

  if (action === "option_up" || action === "option_down") {
    const max = current.options.length;
    if (max === 0) return state;
    const delta = action === "option_down" ? 1 : -1;
    const newIndex = (current.selectedIndex + delta + max) % max;
    const decisions = state.decisions.map((d, i) =>
      i === state.currentDecisionIndex ? { ...d, selectedIndex: newIndex } : d,
    );
    return { ...state, decisions };
  }

  if (action === "confirm") {
    const nextIndex = state.currentDecisionIndex + 1;
    if (nextIndex >= state.decisions.length) {
      return { ...state, completed: true };
    }
    return { ...state, currentDecisionIndex: nextIndex };
  }

  return state;
}

export function collectChoices(state: SpecConfirmationState): Record<string, string> {
  const choices: Record<string, string> = {};
  for (const decision of state.decisions) {
    const selected = decision.options[decision.selectedIndex];
    if (selected) choices[decision.id] = selected.label;
  }
  return choices;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return ms + "ms";
  return (ms / 1000).toFixed(1) + "s";
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(1, max - 1)) + "…";
}

export function renderSpecProgress(
  state: SpecProgressState,
  width: number,
  theme: TuiTheme,
): string[] {
  if (state.phase === "idle") return [];

  const lines: string[] = [];
  const header =
    state.phase === "skipped"
      ? "✦ Spec skipped"
      : state.phase === "completed"
        ? "✦ Spec completed"
        : "✦ Spec Engine";
  lines.push(fg(theme.accent, header));

  if (state.topic) {
    lines.push(fg(theme.muted, "  " + truncate(state.topic, width - 4)));
  }

  for (const stage of state.stages) {
    const icon = STATUS_ICONS[stage.status];
    const name = stage.name.padEnd(18);
    let detail = "";
    if (stage.status === "done" && stage.durationMs !== undefined) {
      detail = "✓ " + formatDuration(stage.durationMs);
      if (stage.fellBack) detail += " (fallback)";
    } else if (stage.status === "running") {
      detail = "...";
    } else if (stage.status === "failed") {
      detail = "failed";
    }
    const color =
      stage.status === "done"
        ? theme.success
        : stage.status === "running"
          ? theme.warning
          : theme.muted;
    lines.push(fg(color, "  " + icon + " " + name + detail));
  }

  if (state.phase === "completed" && state.totalDuration !== undefined) {
    lines.push(fg(theme.success, "  Total: " + formatDuration(state.totalDuration)));
  }

  return lines;
}

export function renderSpecConfirmation(
  state: SpecConfirmationState,
  width: number,
  theme: TuiTheme,
): string[] {
  if (state.completed) return [];
  const decision = state.decisions[state.currentDecisionIndex];
  if (!decision) return [];

  const lines: string[] = [];
  const total = state.decisions.length;
  const current = state.currentDecisionIndex + 1;
  lines.push(fg(theme.accent, "╭─ ✦ Spec Confirmation ──────────────"));
  lines.push(fg(theme.muted, "│ " + state.specId));
  lines.push(fg(theme.muted, "├────────────────────────────────────"));
  lines.push(
    fg(theme.warning, "│ Decision " + current + "/" + total + " [" + decision.severity + "]"),
  );
  lines.push(fg(theme.foreground, "│ " + truncate(decision.point, width - 4)));

  for (const [i, option] of decision.options.entries()) {
    const selected = i === decision.selectedIndex;
    const marker = selected ? "›" : " ";
    const label = selected
      ? fg(theme.accent, marker + " " + option.label)
      : fg(theme.muted, marker + " " + option.label);
    const desc = fg(theme.muted, " — " + truncate(option.description, width - 20));
    lines.push("│ " + label + desc);
  }

  lines.push(fg(theme.muted, "├────────────────────────────────────"));
  lines.push(fg(theme.muted, "│ ↑↓ navigate  Enter confirm  Esc decline"));
  return lines;
}
