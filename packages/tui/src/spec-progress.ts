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
  /** Reason text captured from spec_skipped; rendered under the "Spec skipped" header. */
  skipReason?: string;
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

/**
 * Phase 5 — pipeline preset. Returns a `start` state with the 5 canonical
 * SpecEngine stages pre-registered as pending, so the user immediately sees
 * the full pipeline shape when spec_start fires (instead of an empty list
 * that only fills in as stages complete).
 */
export function createInitialSpecPipeline(trigger: "auto" | "explicit"): SpecProgressState {
  return {
    phase: "start",
    trigger,
    stages: [
      { name: "classify", status: "pending" },
      { name: "explore", status: "pending" },
      { name: "draft", status: "pending" },
      { name: "detect-decisions", status: "pending" },
      { name: "enhance", status: "pending" },
    ],
    startTime: Date.now(),
  };
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

const RUNNING_SPINNER = ["◐", "◓", "◑", "◒"];

export interface RenderSpecProgressOptions {
  /** Animation tick used to rotate the running-stage spinner. */
  tick?: number;
  /** Reason text rendered when phase === "skipped". */
  reason?: string;
}

export function renderSpecProgress(
  state: SpecProgressState,
  width: number,
  theme: TuiTheme,
  options?: RenderSpecProgressOptions,
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

  if (state.phase === "skipped") {
    const reason = options?.reason ?? state.skipReason;
    if (reason) {
      lines.push(fg(theme.muted, "  " + truncate(reason, width - 4)));
    }
  } else if (state.topic) {
    lines.push(fg(theme.muted, "  " + truncate(state.topic, width - 4)));
  }

  for (const stage of state.stages) {
    let icon = STATUS_ICONS[stage.status];
    if (stage.status === "running") {
      const tick = options?.tick ?? 0;
      icon = RUNNING_SPINNER[tick % RUNNING_SPINNER.length]!;
    }
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

  if (state.phase === "completed") {
    if (state.totalDuration !== undefined) {
      lines.push(fg(theme.success, "  Total: " + formatDuration(state.totalDuration)));
    }
    if (state.specId) {
      lines.push(fg(theme.muted, "  spec: " + truncate(state.specId, width - 9)));
    }
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

  // Border width adapts to the available panel width (clamped to a sane range
  // so very narrow terminals still render a recognizable dialog).
  const innerWidth = Math.max(30, Math.min(width, 78));
  const dash = "─".repeat(innerWidth - 2);

  const lines: string[] = [];
  const total = state.decisions.length;
  const current = state.currentDecisionIndex + 1;
  lines.push(fg(theme.accent, "╭─ ✦ Spec Confirmation " + dash.slice(22) + "╮"));
  lines.push(fg(theme.muted, "│ " + truncate(state.specId, innerWidth - 4)));
  lines.push(fg(theme.muted, "├" + dash + "┤"));
  lines.push(
    fg(theme.warning, "│ Decision " + current + "/" + total + " [" + decision.severity + "]"),
  );
  lines.push(fg(theme.foreground, "│ " + truncate(decision.point, innerWidth - 4)));

  for (const [i, option] of decision.options.entries()) {
    const selected = i === decision.selectedIndex;
    const marker = selected ? "›" : " ";
    const label = selected
      ? fg(theme.accent, marker + " " + option.label)
      : fg(theme.muted, marker + " " + option.label);
    const desc = fg(theme.muted, " — " + truncate(option.description, innerWidth - 20));
    lines.push("│ " + label + desc);
  }

  lines.push(fg(theme.muted, "├" + dash + "┤"));
  lines.push(fg(theme.muted, "│ ↑↓ navigate  Enter confirm  Esc decline"));
  return lines;
}
