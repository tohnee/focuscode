/**
 * minimal 布局渲染器 —— codex/zcode 风格的极简流式界面。
 *
 * 与 classic/split/focus/wide 不同，这里没有边框、没有 mascot、没有侧栏：
 * 整屏只有消息流 + 单行输入 + 一行状态 footer。所有模型/工具派生文本
 * 一律经过 sanitizeTerminalText（终端注入护栏），截断用 stringWidth/takeWidth
 * （UTF-8/CJK 安全）。
 *
 * 消息流形态：
 *   > user 修复登录 bug
 *   assistant 我来看看
 *   ✓ read src/auth.ts · 摘要…
 *   > 继续
 */
import { renderMarkdownTranscript } from "./markdown.js";
import { renderSpecProgress, type SpecProgressState } from "./spec-progress.js";
import { renderContextBar, type ContextUsageState } from "./context-bar.js";
import { renderVimIndicator, type VimState } from "./vim.js";
import { bg, fg, type TuiTheme } from "./themes.js";
import {
  charWidth,
  sanitizeTerminalText,
  segmentGraphemes,
  stringWidth,
  takeWidth,
  truncateAnsi,
} from "./width.js";
import type { TuiRenderState, TuiTranscriptLine } from "./renderer.js";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** 工具调用紧凑行的摘要长度上限。 */
const MAX_TOOL_SUMMARY = 80;

export function renderMinimal(
  state: TuiRenderState,
  width: number,
  height: number,
  theme: TuiTheme,
): string {
  const contentWidth = Math.max(20, width);
  const lines: string[] = [];

  for (const entry of state.transcript) {
    lines.push(...renderMinimalMessage(entry, contentWidth, theme));
  }

  // SpecEngine 进度（仅在有内容时）
  if (state.specProgress && state.specProgress.phase !== "idle") {
    lines.push(
      ...renderSpecProgress(state.specProgress, contentWidth, theme, { tick: state.tick }),
    );
  }

  // Reasoning（展开时）
  if (state.reasoning && state.reasoningExpanded) {
    lines.push(
      "💭 " +
        truncateToWidth(
          sanitizeTerminalText(state.reasoning).replaceAll(/\r?\n/g, " "),
          contentWidth - 2,
        ),
    );
  }

  // busy 状态行
  if (state.busy) {
    lines.push(
      fg(
        theme.warning,
        SPINNER[state.tick % SPINNER.length] +
          " " +
          sanitizeTerminalText(state.status ?? "working…").replaceAll(/\r?\n/g, " "),
      ),
    );
  } else if (state.status) {
    lines.push(fg(theme.muted, sanitizeTerminalText(state.status).replaceAll(/\r?\n/g, " ")));
  }

  // 底部固定两行：输入行 + footer；其上全部是消息流视口
  const footerLine = renderMinimalFooter(state, contentWidth, theme);
  const inputLine = renderMinimalInput(state, contentWidth, theme);
  const viewportHeight = Math.max(4, height - 2);
  const viewport = lines.slice(-viewportHeight);

  return bg(theme.background, [...viewport, "", inputLine, footerLine].join("\n"));
}

/** 单条消息 → 行序列。user 带 `> ` 标签，tool 折叠为紧凑行，assistant 走 markdown。 */
export function renderMinimalMessage(
  entry: TuiTranscriptLine,
  width: number,
  theme: TuiTheme,
): string[] {
  const text = entry.text ?? "";
  switch (entry.role) {
    case "user": {
      return wrapMinimal(text, width - 2).map(
        (line, index) =>
          fg(theme.secondary, index === 0 ? "> " : "  ") + fg(theme.foreground, line),
      );
    }
    case "tool": {
      // 工具输出折叠为单行紧凑摘要（容错：非 JSON 原样截断）。
      const summary = toolSummary(text);
      // summary 提取到 error 字段时自带 ✗ 前缀，避免与状态标记重复。
      const mark = summary.startsWith("✗ ") ? "" : "✓ ";
      return [fg(theme.success, mark) + fg(theme.muted, truncateToWidth(summary, width - 2))];
    }
    case "assistant": {
      const rendered = renderMarkdownTranscript(text || " ", width, theme);
      return rendered.map((segment, index) => (index === 0 ? segment : segment));
    }
    case "system":
    default: {
      return wrapMinimal(text, width).map((line) => fg(theme.muted, line));
    }
  }
}

/** 从工具输出提取单行摘要；解析 JSON 时优先取 message/error 字段。 */
export function toolSummary(text: string): string {
  const clean = sanitizeTerminalText(text).replace(/\s+/g, " ").trim();
  if (!clean) return "(empty tool output)";
  const parsed = tryParseJson(clean);
  if (parsed !== undefined) {
    if (typeof parsed.error === "string" && parsed.error) return "✗ " + parsed.error;
    if (typeof parsed.message === "string" && parsed.message) return parsed.message;
    if (typeof parsed.output === "string" && parsed.output) return parsed.output;
  }
  return clean.slice(0, MAX_TOOL_SUMMARY) + (clean.length > MAX_TOOL_SUMMARY ? "…" : "");
}

function tryParseJson(text: string): Record<string, unknown> | undefined {
  if (!text.startsWith("{")) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** 单行输入：`> ` + 输入的最后一行（光标用反显块标注）。 */
function renderMinimalInput(state: TuiRenderState, width: number, theme: TuiTheme): string {
  const rows = sanitizeTerminalText(state.input).split("\n");
  const lastRow = rows[rows.length - 1] ?? "";
  const row = Math.max(0, rows.length - 1);
  const cursorCol = row === state.inputCursor.row ? state.inputCursor.col : lastRow.length;
  const clusters = segmentGraphemes(lastRow);
  const position = Math.max(0, Math.min(clusters.length, cursorCol));
  const before = clusters.slice(0, position).join("");
  const current = clusters[position] ?? " ";
  const afterBudget = Math.max(0, width - 3 - stringWidth(before) - stringWidth(current));
  const after = takeWidth(clusters.slice(position + 1).join(""), afterBudget);
  const visible = before + "\u001b[7m" + current + "\u001b[27m" + after;
  // ANSI-safe truncation: takeWidth on styled text would cut colour codes.
  return fg(theme.accent, "> ") + fg(theme.foreground, truncateAnsi(visible, width - 2));
}

/** 精简 footer：model · approval · sandbox · cost · vim（无 mascot/XP/快捷键提示）。 */
function renderMinimalFooter(state: TuiRenderState, width: number, theme: TuiTheme): string {
  const parts: string[] = [];
  parts.push(sanitizeTerminalText(state.model) || "model");
  parts.push(state.approval);
  parts.push(state.sandbox);
  if (state.sessionCost !== undefined) {
    parts.push(
      fg(
        theme.success,
        "$" +
          state.sessionCost.toFixed(4) +
          (state.sessionBudget ? "/$" + state.sessionBudget.toFixed(2) : ""),
      ),
    );
  }
  if (state.vim) parts.push(renderVimIndicator(state.vim, theme));
  if (state.contextUsage) parts.push(renderContextBar(state.contextUsage, 30, theme));
  const footer = parts.join(fg(theme.muted, " · "));
  return fg(theme.muted, truncateAnsi(footer, width));
}

/** 按可视宽度换行（与 renderer 的 wrap 语义一致；tab 展开为两格）。 */
export function wrapMinimal(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const logical of sanitizeTerminalText(text).replaceAll("\t", "  ").split("\n")) {
    if (!logical) {
      lines.push("");
      continue;
    }
    let current = "";
    let currentWidth = 0;
    for (const char of logical) {
      const cell = charWidth(char.codePointAt(0)!);
      if (currentWidth + cell > width && current) {
        lines.push(current);
        current = "";
        currentWidth = 0;
      }
      current += char;
      currentWidth += cell;
    }
    lines.push(current);
  }
  return lines;
}

export function truncateToWidth(value: string, width: number): string {
  if (width <= 0) return "";
  if (stringWidth(value) <= width) return value;
  return takeWidth(value, Math.max(1, width - 1)) + "…";
}
