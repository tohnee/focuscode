import type { TuiTheme } from "./themes.js";

/**
 * Pure TUI widgets: progress bars, cost bars, level badges. Each returns a
 * single-line ANSI-styled string (no newlines), driven only by its inputs and
 * the supplied theme. Width is clamped to a sensible minimum so the widgets
 * never collapse into garbage on tiny terminals.
 */

export interface ProgressBarOptions {
  /** Ratio in [0, 1]; values outside the range are clamped. */
  ratio: number;
  /** Total display width in columns, including borders. */
  width: number;
  /** Optional label shown before the bar; sanitized and truncated to fit. */
  label?: string;
  /** Use the theme's success color when ratio >= 1, warning when >= 0.5. */
  theme: TuiTheme;
}

const FILLED_GLYPH = "█";
const PARTIAL_GLYPHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
const EMPTY_GLYPH = "░";

/** A bounded progress bar with optional label, themed by ratio thresholds. */
export function progressBar(options: ProgressBarOptions): string {
  const width = Math.max(8, Math.floor(options.width));
  const ratio = clamp01(options.ratio);
  const label = options.label ? sanitizeLabel(options.label) : "";
  const labelSegment = label ? label + " " : "";
  const barWidth = Math.max(4, width - stringWidth(labelSegment) - 2);
  const filled = ratio * barWidth;
  const whole = Math.floor(filled);
  const remainder = Math.round((filled - whole) * 8);
  const partial = PARTIAL_GLYPHS[remainder] ?? "";
  const filledText = FILLED_GLYPH.repeat(whole) + partial;
  const emptyText = EMPTY_GLYPH.repeat(Math.max(0, barWidth - filledText.length));
  const bar = filledText + emptyText;
  const color =
    ratio >= 1
      ? options.theme.success
      : ratio >= 0.5
        ? options.theme.warning
        : options.theme.accent;
  return fg(color, labelSegment + "[" + bar + "]");
}

export interface CostBarOptions {
  /** Spent amount in USD. */
  spent: number;
  /** Optional budget cap; when provided, the bar shows spent/budget. */
  budget?: number;
  width: number;
  theme: TuiTheme;
}

/**
 * A cost bar that shows USD spent and, when a budget is provided, a ratio bar
 * themed by spend thresholds (warning at 50%, danger at 90%).
 */
export function costBar(options: CostBarOptions): string {
  const width = Math.max(16, Math.floor(options.width));
  const spent = Number.isFinite(options.spent) ? options.spent : 0;
  const budget = options.budget;
  if (budget === undefined || budget <= 0) {
    const label = "$" + spent.toFixed(4);
    return fg(options.theme.foreground, padLabel(label, width));
  }
  const ratio = clamp01(spent / budget);
  const label = "$" + spent.toFixed(4) + " / $" + budget.toFixed(2);
  const labelWidth = stringWidth(label) + 2;
  const barWidth = Math.max(4, width - labelWidth - 2);
  const filled = Math.round(ratio * barWidth);
  const empty = Math.max(0, barWidth - filled);
  const color =
    ratio >= 0.9
      ? options.theme.danger
      : ratio >= 0.5
        ? options.theme.warning
        : options.theme.success;
  const bar =
    fg(color, FILLED_GLYPH.repeat(filled)) + fg(options.theme.muted, EMPTY_GLYPH.repeat(empty));
  return (
    fg(options.theme.foreground, label) +
    " " +
    fg(options.theme.muted, "[") +
    bar +
    fg(options.theme.muted, "]")
  );
}

export interface LevelBadgeOptions {
  /** Level in 1..9 (clamped). */
  level: number;
  /** Optional level name (e.g. "九尾天福"); shown after the level number. */
  name?: string;
  theme: TuiTheme;
}

/** A compact badge like `Lv 5 · 灵尾狐`, themed by the level tier. */
export function levelBadge(options: LevelBadgeOptions): string {
  const level = Math.max(1, Math.min(9, Math.floor(options.level)));
  const tier =
    level >= 7 ? options.theme.danger : level >= 4 ? options.theme.accent : options.theme.secondary;
  const name = options.name ? sanitizeLabel(options.name) : "";
  const badge = "Lv " + level;
  const nameSegment = name ? " · " + name : "";
  return fg(tier, badge) + fg(options.theme.muted, nameSegment);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Drop control characters and collapse whitespace so labels never break layout. */
function sanitizeLabel(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replaceAll(/\s+/g, " ")
    .trim();
}

function fg(color: number, text: string): string {
  return "\u001b[38;5;" + color + "m" + text + "\u001b[39m";
}

/** Visible width of a string ignoring SGR sequences (compact local copy). */
function stringWidth(value: string): number {
  return value.replace(/\u001b\[[0-9;]*m/g, "").length;
}

function padLabel(value: string, width: number): string {
  const clean = value.replace(/\u001b\[[0-9;]*m/g, "");
  if (clean.length >= width) return clean.slice(0, width);
  return clean + " ".repeat(width - clean.length);
}
