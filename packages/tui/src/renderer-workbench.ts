/**
 * workbench 布局渲染器 —— yazi × tmux 风格三栏工作台（默认体验）。
 *
 * 结构：
 *   左导航栏（todo/会话树/技能，yazi 文件列表样式）
 *   中对话流（消息 + 工具紧凑行）
 *   右预览栏（任务进度条 + 最近工具输出 + 上下文用量 + 成本 + 输入实时预览）
 *   底部输入行（语境前缀 + 上下文快捷键提示）
 *   底部状态栏（tmux 风格：面板列表 + 右侧系统信息）
 *
 * 所有模型/工具派生文本经过 sanitizeTerminalText（终端注入护栏）；
 * 截断用 stringWidth/takeWidth/truncateAnsi（UTF-8/CJK/ANSI 安全）。
 */
import { renderMarkdownTranscript } from "./markdown.js";
import { renderContextBar, type ContextUsageState } from "./context-bar.js";
import { renderVimIndicator, type VimState } from "./vim.js";
import type { CompanionState } from "./companion.js";
import { bg, bold, fg, type ColorValue, type TuiTheme } from "./themes.js";
import {
  sanitizeTerminalText,
  segmentGraphemes,
  stringWidth,
  stripAnsi,
  takeWidth,
  truncateAnsi,
} from "./width.js";
import { renderMinimalMessage, toolSummary, truncateToWidth } from "./renderer-minimal.js";
import type { TuiRenderState, TuiTranscriptLine } from "./renderer.js";
import type { TodoPanelState } from "./todo-panel.js";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const PROGRESS_BLOCKS = ["⣀", "⣄", "⣤", "⣦", "⣶", "⣷", "⣿"];

export function renderWorkbench(
  state: TuiRenderState,
  width: number,
  height: number,
  theme: TuiTheme,
  navWidth: number,
  previewWidth: number,
): string {
  const bodyHeight = Math.max(8, height - 3);
  const contentWidth = Math.max(20, width);
  const hasNav = navWidth > 0;
  const hasPreview = previewWidth > 0;
  // main 段 = 总宽 - nav 段 - preview 段；栏间分隔符「 │ 」已计入 nav/preview 段自身。
  const mainWidth = contentWidth - navWidth - previewWidth;

  const navLines = hasNav ? renderNavPanel(state, navWidth, bodyHeight, theme) : [];
  const mainLines = renderTranscript(state, mainWidth, theme);
  const previewLines = hasPreview ? renderPreviewPanel(state, previewWidth, bodyHeight, theme) : [];

  const body: string[] = [];
  for (let row = 0; row < bodyHeight; row += 1) {
    const nav = navLines[row] ?? "";
    const main = mainLines[row] ?? "";
    const preview = previewLines[row] ?? "";
    // tmux/yazi 风格：竖线在栏间（nav 右缘、main 右缘），行首行尾不画边框。
    body.push(
      (hasNav ? padToWidth(nav, navWidth - 3) + fg(theme.muted, " │ ") : "") +
        padToWidth(main, mainWidth) +
        (hasPreview ? fg(theme.muted, " │ ") + padToWidth(preview, previewWidth - 3) : ""),
    );
  }

  // 输入行与 main 列对齐（左侧留 nav 空白），避免三栏结构在底部断掉。
  const inputLine =
    (hasNav ? " ".repeat(navWidth) : "") +
    padToWidth(renderInputLine(state, mainWidth, theme), mainWidth);
  const statusBar = renderStatusBar(state, width, theme, hasNav, hasPreview);

  return bg(
    theme.background,
    [...body, fg(theme.muted, "─".repeat(width)), inputLine, statusBar].join("\n"),
  );
}

// ─── 左导航栏（yazi 文件列表样式） ───────────────────────────────────

function renderNavPanel(
  state: TuiRenderState,
  width: number,
  height: number,
  theme: TuiTheme,
): string[] {
  const lines: string[] = [];
  lines.push(bold(fg(theme.accent, " ▌Todo")) + todoCountBadge(state.todoPanel, theme));
  if (state.todoPanel && state.todoPanel.items.length > 0) {
    const selected = state.paneSelection?.todo ?? 0;
    const items = state.todoPanel.items.slice(0, Math.max(2, height - 12));
    for (const [index, item] of items.entries()) {
      const icon = item.status === "completed" ? "✓" : item.status === "in_progress" ? "▶" : "·";
      const color =
        item.status === "completed"
          ? theme.success
          : item.status === "in_progress"
            ? theme.warning
            : theme.muted;
      const label = truncateToWidth(sanitizeTerminalText(item.content), width - 7);
      const isSelected = state.layout?.activePane === "nav" && index === selected;
      lines.push(
        isSelected
          ? fg(theme.background, bg(theme.accent, "  " + icon + " " + label))
          : fg(color, "  " + icon + " " + label),
      );
    }
  } else {
    lines.push(fg(theme.muted, "  no tasks — /task add"));
  }
  lines.push("");
  lines.push(bold(fg(theme.accent, " ▌Session")));
  lines.push(
    fg(theme.muted, "  " + truncateToWidth(sanitizeTerminalText(state.session), width - 5)),
  );
  if (state.layout?.activePane) {
    lines.push(fg(theme.muted, "  focus: " + state.layout.activePane));
  }
  lines.push("");
  lines.push(bold(fg(theme.accent, " ▌Info")));
  lines.push(
    fg(
      theme.muted,
      "  busy: " + (state.busy ? "●" : "○") + (state.queued ? " · queued " + state.queued : ""),
    ),
  );
  lines.push("");
  lines.push(bold(fg(theme.accent, " ▌Partner")));
  const glyph = state.mascot.id === "foxy" ? "🦊" : "🐾";
  lines.push(
    fg(
      theme.secondary,
      "  " +
        truncateToWidth(glyph + " " + state.mascot.name + " · " + state.mascot.species, width - 5),
    ),
  );
  lines.push(fg(theme.muted, "  " + moodLabel(state.mood)));
  const line = state.speech?.trim() || state.mascot.catchphrase;
  if (line) {
    lines.push(
      fg(
        theme.muted,
        "  「" +
          truncateToWidth(sanitizeTerminalText(line).replaceAll(/\r?\n/g, " "), width - 5) +
          "」",
      ),
    );
  }
  return lines.slice(0, height);
}

/** 伙伴 mood → 表情 + 文案（workbench 导航栏 Partner 区块）。 */
function moodLabel(mood: string): string {
  const labels: Record<string, string> = {
    idle: "😌 休息中",
    thinking: "🤔 思考中",
    working: "⚡ 工作中",
    happy: "😄 状态很好",
    oops: "😵 有点沮丧",
    sleeping: "😴 打盹中",
    celebrating: "🎉 庆祝中",
    levelup: "⬆ 升级啦",
  };
  return labels[mood] ?? "😌 休息中";
}

function todoCountBadge(panel: TodoPanelState | undefined, theme: TuiTheme): string {
  if (!panel) return "";
  const inProgress = panel.items.filter((item) => item.status === "in_progress").length;
  const pending = panel.items.filter((item) => item.status === "pending").length;
  const total = panel.items.length;
  return fg(theme.muted, " " + inProgress + "▶/" + pending + "·/" + total);
}

// ─── 中对话流 ────────────────────────────────────────────────────────

function renderTranscript(state: TuiRenderState, width: number, theme: TuiTheme): string[] {
  const lines: string[] = [];
  // assistant 消息首行带伙伴前缀（🦊/🐾），续行缩进对齐 —— 个性化点睛。
  const glyph = state.mascot.id === "foxy" ? "🦊 " : "🐾 ";
  const indent = " ".repeat(3);
  for (const entry of state.transcript) {
    const rendered = renderMinimalMessage(entry, width, theme);
    if (entry.role === "assistant" && rendered.length > 0) {
      const first = rendered[0]!;
      rendered[0] = fg(theme.secondary, glyph) + first;
      for (let i = 1; i < rendered.length; i += 1) {
        rendered[i] = fg(theme.secondary, indent) + rendered[i]!;
      }
    }
    lines.push(...rendered);
  }
  return lines;
}

// ─── 右预览栏（yazi 预览面板 + 进度） ───────────────────────────────

function renderPreviewPanel(
  state: TuiRenderState,
  width: number,
  height: number,
  theme: TuiTheme,
): string[] {
  const lines: string[] = [];
  lines.push(bold(fg(theme.accent, " ▌Progress")));
  lines.push(...renderProgressBar(state, width, theme));
  lines.push("");
  lines.push(bold(fg(theme.accent, " ▌Tool output")));
  const lastTool = [...state.transcript].reverse().find((entry) => entry.role === "tool");
  if (lastTool) {
    const summary = toolSummary(lastTool.text);
    for (const line of wrapPreview(summary, width - 2)) {
      lines.push(fg(theme.muted, " " + line));
    }
  } else {
    lines.push(fg(theme.muted, "  (no tool output yet)"));
  }
  lines.push("");
  lines.push(bold(fg(theme.accent, " ▌Context")));
  if (state.contextUsage) {
    lines.push(
      fg(theme.muted, " " + renderContextBar(state.contextUsage, Math.min(30, width - 2), theme)),
    );
  } else {
    lines.push(fg(theme.muted, "  (no context data)"));
  }
  if (state.sessionCost !== undefined) {
    lines.push(bold(fg(theme.accent, " ▌Cost")));
    lines.push(
      fg(
        theme.success,
        "  $" +
          state.sessionCost.toFixed(4) +
          (state.sessionBudget ? " / $" + state.sessionBudget.toFixed(2) : ""),
      ),
    );
    if (state.cacheMetrics && state.cacheMetrics.hitRatio > 0) {
      lines.push(
        fg(
          theme.secondary,
          "  ⚡ cache hit " +
            Math.round(state.cacheMetrics.hitRatio * 100) +
            "% · saved $" +
            state.cacheMetrics.savedUsd.toFixed(2),
        ),
      );
    }
  }
  // 输入实时预览（markdown 渲染输入内容）
  if (state.input.trim()) {
    lines.push("");
    lines.push(bold(fg(theme.accent, " ▌Input preview")));
    lines.push(
      ...renderMarkdownTranscript(state.input, width - 2, theme).slice(
        0,
        Math.max(3, height - lines.length),
      ),
    );
  }
  return lines.slice(0, height);
}

/** yazi 风格任务进度条：⣿⣿⣿⣀⣀ 62% · 标签。数据源：todo 完成度 + busy。 */
function renderProgressBar(state: TuiRenderState, width: number, theme: TuiTheme): string[] {
  const items = state.todoPanel?.items ?? [];
  const total = items.length;
  const done = items.filter((item) => item.status === "completed").length;
  const ratio = total > 0 ? done / total : state.busy ? 0.5 : 0;
  const barWidth = Math.max(4, width - 8);
  const filled = Math.floor(ratio * barWidth);
  const partialIdx = Math.floor((ratio * barWidth - filled) * PROGRESS_BLOCKS.length);
  const partial = partialIdx > 0 && filled < barWidth ? PROGRESS_BLOCKS[partialIdx] : "";
  const bar =
    "⣿".repeat(filled) + partial + "⣀".repeat(Math.max(0, barWidth - filled - (partial ? 1 : 0)));
  const label = state.busy
    ? SPINNER[state.tick % SPINNER.length] + " working"
    : total > 0
      ? done + "/" + total + " tasks"
      : "idle";
  const pct = Math.round(ratio * 100);
  return [
    fg(theme.warning, " " + truncateToWidth(bar, barWidth + 1)) + fg(theme.muted, " " + pct + "%"),
    fg(theme.muted, " " + label),
  ];
}

function wrapPreview(text: string, width: number): string[] {
  const clean = sanitizeTerminalText(text);
  const lines: string[] = [];
  for (const logical of clean.split("\n")) {
    for (let offset = 0; offset < logical.length; offset += width) {
      lines.push(logical.slice(offset, offset + width));
    }
  }
  return lines.slice(0, 6);
}

// ─── 底部输入行（语境前缀 + 多行显示 + 上下文快捷键提示） ─────────────

function renderInputLine(state: TuiRenderState, width: number, theme: TuiTheme): string {
  const prefix = inputContextPrefix(state.input);
  const rows = sanitizeTerminalText(state.input).split("\n");
  // 多行输入：显示最后 MAX_WORKBENCH_INPUT_ROWS 行（自动扩展），光标所在行最后。
  const MAX_WORKBENCH_INPUT_ROWS = 4;
  const visibleRows = rows.slice(-MAX_WORKBENCH_INPUT_ROWS);
  const row = Math.max(0, rows.length - 1);
  const cursorCol =
    row === state.inputCursor.row ? state.inputCursor.col : (visibleRows.at(-1)?.length ?? 0);
  const lastRow = visibleRows.at(-1) ?? "";
  const clusters = segmentGraphemes(lastRow);
  const position = Math.max(0, Math.min(clusters.length, cursorCol));
  const before = clusters.slice(0, position).join("");
  const current = clusters[position] ?? " ";
  const afterBudget = Math.max(
    0,
    width - prefix.length - stringWidth(before) - stringWidth(current),
  );
  const after = takeWidth(clusters.slice(position + 1).join(""), afterBudget);
  const cursorRow = before + "\u001b[7m" + current + "\u001b[27m" + after;
  // 提示文字截断到屏幕 40%，光标区保留其余宽度，避免窄屏溢出。
  const hint = renderInputHint(state, theme);
  const hintText = hint
    ? fg(theme.muted, "  " + truncateToWidth(hint, Math.max(0, Math.floor(width * 0.4))))
    : "";
  const cursorBudget = Math.max(
    10,
    width - prefix.length - (hintText ? stringWidth(stripAnsi(hintText)) + 2 : 0),
  );
  return (
    fg(theme.accent, prefix) +
    fg(theme.foreground, truncateAnsi(cursorRow, cursorBudget)) +
    hintText
  );
}

/** 输入语境提示：/ 开头提示命令浮层，否则提示 Tab 补全等。 */
function renderInputHint(state: TuiRenderState, theme: TuiTheme): string {
  const trimmed = state.input.trimStart();
  if (trimmed.startsWith("/")) return "[Tab] 命令补全 · [Ctrl+P] 命令面板";
  if (state.input.length === 0) return "[Tab] 命令 · [Ctrl+O] 换行 · [Ctrl+B] 面板 · [↑↓] 历史";
  return "[Tab] 补全 · [Ctrl+O] 换行 · [Ctrl+B] 面板";
}

/** 输入语境前缀：/ 开头 → 命令；否则 → 对话。 */
function inputContextPrefix(input: string): string {
  const trimmed = input.trimStart();
  if (trimmed.startsWith("/")) return "/ ";
  return "> ";
}

// ─── 底部状态栏（tmux 风格） ────────────────────────────────────────

function renderStatusBar(
  state: TuiRenderState,
  width: number,
  theme: TuiTheme,
  hasNav: boolean,
  hasPreview: boolean,
): string {
  const left: string[] = [];
  if (hasNav) left.push(segment("[1]Nav", state.layout?.activePane === "nav", theme));
  left.push(
    segment(
      "[2]Chat",
      state.layout?.activePane === "transcript" || state.layout?.activePane === "input",
      theme,
    ),
  );
  if (hasPreview) left.push(segment("[3]Preview", state.layout?.activePane === "preview", theme));

  const right: string[] = [];
  right.push(sanitizeTerminalText(state.model) || "model");
  right.push(state.approval);
  right.push(state.sandbox);
  if (state.companion) {
    right.push(companionBadge(state.companion, theme));
  }
  if (state.contextUsage) {
    right.push(renderContextBar(state.contextUsage, Math.min(24, Math.floor(width / 6)), theme));
  }
  if (state.vim) right.push(renderVimIndicator(state.vim, theme));
  const leftText = left.join(fg(theme.muted, " "));
  const rightText = right.join(fg(theme.muted, " · "));
  // 宽度计算按去色后的显示宽度（leftText/rightText 含 ANSI 颜色码）。
  const leftWidth = stringWidth(stripAnsi(leftText));
  const rightWidth = stringWidth(stripAnsi(rightText));
  // 状态栏占满整行：左侧面板段 + 弹性空白 + 右侧系统信息（不截断 gap，窄屏由 truncate 兜底）。
  const gap = Math.max(1, width - leftWidth - rightWidth - 2);
  return (
    fg(theme.muted, " ") +
    truncateAnsi(leftText, Math.max(10, width - 2)) +
    fg(theme.muted, " ".repeat(gap)) +
    truncateAnsi(rightText, Math.max(10, width - leftWidth - 4)) +
    fg(theme.muted, " ")
  );
}

function segment(label: string, active: boolean, theme: TuiTheme): string {
  return active ? bold(fg(theme.accent, label)) : fg(theme.muted, label);
}

/** 伙伴成长徽章（等级配色与 classic footer 一致）。 */
function companionBadge(state: CompanionState, theme: TuiTheme): string {
  const tier = state.level >= 7 ? theme.danger : state.level >= 4 ? theme.accent : theme.secondary;
  return fg(tier, "Lv " + state.level) + " · " + state.xp + "xp";
}

function padToWidth(value: string, width: number): string {
  // 内容可能带 ANSI 颜色码：截断必须 ANSI 安全，补空格按去色后的显示宽度计算。
  const clean = truncateAnsi(value, Math.max(0, width));
  return clean + " ".repeat(Math.max(0, width - stringWidth(stripAnsi(clean))));
}
