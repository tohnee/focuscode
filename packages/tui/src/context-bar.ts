import { fg, type TuiTheme } from "./themes.js";

export interface ContextUsageState {
  usedTokens: number;
  maxTokens: number;
  reasoningTokens?: number;
}

export function formatTokens(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

export function renderContextBar(state: ContextUsageState, width: number, theme: TuiTheme): string {
  const { usedTokens, maxTokens } = state;
  if (maxTokens <= 0) {
    return fg(theme.muted, "⚙ " + formatTokens(usedTokens) + " tokens");
  }

  const ratio = Math.min(1, usedTokens / maxTokens);
  const usedLabel = formatTokens(usedTokens);
  const maxLabel = formatTokens(maxTokens);
  const labelWidth = usedLabel.length + maxLabel.length + 4; // " X/Y"
  const barWidth = Math.max(8, width - labelWidth - 2);
  const filled = Math.round(ratio * barWidth);
  const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);

  const color = ratio < 0.7 ? theme.success : ratio < 0.9 ? theme.warning : theme.danger;
  return fg(color, "⚙ ") + fg(color, bar) + " " + fg(theme.muted, usedLabel + "/" + maxLabel);
}
