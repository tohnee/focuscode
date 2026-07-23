import type { CompletionCandidate } from "./completion.js";
import type { CompanionState } from "./companion.js";
import { renderMarkdownTranscript } from "./markdown.js";
import { mascotFrame, type MascotMood, type TuiMascot } from "./mascots.js";
import { renderPicker, type PickerState } from "./picker.js";
import {
  renderSpecConfirmation,
  renderSpecProgress,
  type SpecConfirmationState,
  type SpecProgressState,
} from "./spec-progress.js";
import { renderContextBar, type ContextUsageState } from "./context-bar.js";
import { bg, fg, type TuiTheme } from "./themes.js";
import {
  charWidth,
  sanitizeTerminalText,
  segmentGraphemes,
  stringWidth,
  stripAnsi,
  takeWidth,
  truncateAnsi,
} from "./width.js";

export interface TuiTranscriptLine {
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  /** Pre-rendered, trusted ANSI lines (e.g. diffs) that bypass text wrapping. */
  rendered?: string[];
}

export interface TuiInputCursor {
  row: number;
  /** Grapheme-cluster index within the row. */
  col: number;
}

export interface TuiCompletionView {
  candidates: CompletionCandidate[];
  index: number;
}

export interface TuiRenderState {
  width: number;
  height: number;
  title: string;
  model: string;
  session: string;
  approval: string;
  sandbox: string;
  busy: boolean;
  queued: number;
  mood: MascotMood;
  tick: number;
  theme: TuiTheme;
  mascot: TuiMascot;
  transcript: TuiTranscriptLine[];
  input: string;
  inputCursor: TuiInputCursor;
  completion?: TuiCompletionView;
  attachments: string[];
  status?: string;
  /** One encouraging line spoken by the mascot, wrapped into its column. */
  speech?: string;
  scrollOffset: number;
  /** When set, the model picker takes over the body area as a modal overlay. */
  picker?: PickerState;
  /** Companion state used to render the XP/level badge in the footer. */
  companion?: CompanionState;
  /** Cumulative session spend in USD; rendered as a small cost widget. */
  sessionCost?: number;
  /** Optional session budget cap in USD; when set, the cost bar shows a ratio. */
  sessionBudget?: number;
  /** SpecEngine 进度状态;缺省 idle 时不渲染。 */
  specProgress?: SpecProgressState;
  /** SpecEngine 待确认决策;存在时渲染交互式 UI。 */
  specConfirmation?: SpecConfirmationState;
  /** 模型 reasoning 累积文本。 */
  reasoning?: string;
  /** 是否展开显示 reasoning。 */
  reasoningExpanded?: boolean;
  /** Context window 使用量;存在时在 footer 显示进度条。 */
  contextUsage?: ContextUsageState;
}

const MAX_INPUT_ROWS = 5;
const MAX_COMPLETION_ROWS = 8;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Wrap one short speech line into the mascot column; sanitized and bounded. */
function wrapSpeech(speech: string | undefined, width: number): string[] {
  if (!speech || width < 6) return [];
  const clean = sanitizeTerminalText(speech).replaceAll(/\r?\n/g, " ").trim();
  if (!clean) return [];
  const lines: string[] = [];
  let current = "";
  for (const word of clean.split(/(\s+)/)) {
    if (stringWidth(current + word) > width && current) {
      lines.push(current.trimEnd());
      current = word.trimStart();
    } else current += word;
    while (stringWidth(current) > width) {
      lines.push(takeWidth(current, width));
      current = current.slice([...takeWidth(current, width)].length);
    }
  }
  if (current.trim()) lines.push(current.trimEnd());
  return lines.slice(0, 4);
}

export function renderTui(state: TuiRenderState): string {
  const width = Math.max(40, state.width);
  const height = Math.max(12, state.height);
  const theme = state.theme;
  const top = fg(theme.accent, "╭" + "─".repeat(width - 2) + "╮");
  const bottom = fg(theme.accent, "╰" + "─".repeat(width - 2) + "╯");
  const glyph = state.mascot.id === "foxy" ? "🦊 " : "";
  const headerText =
    " " +
    glyph +
    sanitizeTerminalText(state.title) +
    " · " +
    sanitizeTerminalText(state.model) +
    " ";
  const header =
    fg(theme.accent, "│") +
    bold(fg(theme.accent, padVisible(headerText, width - 2))) +
    fg(theme.accent, "│");
  const mascot = mascotFrame(state.mascot, state.mood, state.tick);
  const mascotWidth = Math.min(24, Math.max(...mascot.map(visibleLength), 0) + 2);
  const speechLines = wrapSpeech(state.speech, mascotWidth - 1);
  const bodyWidth = width - mascotWidth - 3;
  const inputRows = renderInputRows(state, width);
  const completionRows = renderCompletionRows(state, width);
  const bodyHeight = Math.max(6, height - 5 - inputRows.length - completionRows.length);
  const lines = wrapTranscript(state.transcript, bodyWidth, theme, state.mascot);
  const end = Math.max(0, lines.length - state.scrollOffset);
  const visible = lines.slice(Math.max(0, end - bodyHeight), end);
  const body: string[] = [];
  for (let row = 0; row < bodyHeight; row += 1) {
    const art = mascot[row];
    const bubble = speechLines[row - mascot.length - 1];
    let mascotCell: string;
    if (art !== undefined) {
      mascotCell = fg(theme.secondary, padVisible(" " + art, mascotWidth));
    } else if (row === mascot.length && speechLines.length) {
      mascotCell = fg(theme.accent, padVisible(" ╭" + "─".repeat(mascotWidth - 2), mascotWidth));
    } else if (bubble !== undefined) {
      mascotCell =
        fg(theme.accent, "│") + italic(fg(theme.secondary, padVisible(bubble, mascotWidth - 1)));
    } else if (speechLines.length && row === mascot.length + speechLines.length + 1) {
      mascotCell = fg(theme.accent, padVisible(" ╰" + "─".repeat(mascotWidth - 2), mascotWidth));
    } else {
      mascotCell = padVisible("", mascotWidth);
    }
    const transcript = visible[row] ?? "";
    body.push(
      fg(theme.accent, "│") +
        mascotCell +
        fg(theme.muted, "│") +
        padVisible(" " + transcript, bodyWidth) +
        fg(theme.accent, "│"),
    );
  }
  const separator = fg(theme.muted, "├" + "─".repeat(width - 2) + "┤");
  // SpecEngine progress widget (shown when phase !== idle)
  const specLines: string[] = [];
  if (state.specProgress && state.specProgress.phase !== "idle") {
    const rendered = renderSpecProgress(state.specProgress, bodyWidth, theme);
    for (const line of rendered) {
      specLines.push(line);
    }
  }
  // Spec confirmation overlay (takes priority over normal body)
  if (state.specConfirmation) {
    const confirmLines = renderSpecConfirmation(state.specConfirmation, width, theme);
    specLines.push(...confirmLines);
  }
  // Reasoning indicator (collapsed: show indicator; expanded: show text)
  let reasoningLine = "";
  if (state.reasoning) {
    if (state.reasoningExpanded) {
      const text = state.reasoning.replaceAll(/\r?\n/g, " ");
      const truncated = text.length > bodyWidth - 4 ? text.slice(0, bodyWidth - 5) + "…" : text;
      reasoningLine = "💭 " + truncated;
    } else {
      reasoningLine = "💭 thinking...";
    }
  }
  const queue = state.queued ? " · queued " + state.queued : "";
  const spinner = state.busy ? SPINNER[state.tick % SPINNER.length] + " " : "";
  const companionBadge = state.companion ? renderCompanionBadge(state.companion, theme) : "";
  const costBadge =
    state.sessionCost !== undefined
      ? renderCostBadge(state.sessionCost, state.sessionBudget, theme)
      : "";
  const contextBadge = state.contextUsage ? renderContextBar(state.contextUsage, 30, theme) : "";
  const footerExtras = [companionBadge, costBadge, contextBadge].filter(Boolean).join(" · ");
  const footerText =
    " " +
    sanitizeTerminalText(state.mascot.name) +
    " · " +
    state.approval +
    " · " +
    state.sandbox +
    queue +
    (footerExtras ? " · " + footerExtras : "") +
    " · Tab complete · Ctrl+O newline · Ctrl+G mascot · Ctrl+T theme ";
  const footer =
    fg(theme.accent, "│") +
    fg(
      theme.muted,
      padVisible(
        state.status
          ? " " + spinner + sanitizeTerminalText(state.status).replaceAll(/\r?\n/g, " ") + " "
          : footerText,
        width - 2,
      ),
    ) +
    fg(theme.accent, "│");
  const reasoningRows: string[] = reasoningLine ? [reasoningLine] : [];
  if (state.picker) {
    const overlay = renderPickerOverlay(state.picker, width, height, theme);
    return bg(theme.background, [top, header, ...overlay, footer, bottom].join("\n"));
  }
  return bg(
    theme.background,
    [
      top,
      header,
      ...body,
      ...specLines,
      ...reasoningRows,
      separator,
      ...completionRows,
      ...inputRows,
      footer,
      bottom,
    ].join("\n"),
  );
}

function renderCompanionBadge(state: CompanionState, theme: TuiTheme): string {
  const tier = state.level >= 7 ? theme.danger : state.level >= 4 ? theme.accent : theme.secondary;
  return fg(tier, "Lv " + state.level) + fg(theme.muted, " · " + state.xp + "xp");
}

function renderCostBadge(spent: number, budget: number | undefined, theme: TuiTheme): string {
  if (budget === undefined || budget <= 0) {
    return fg(theme.success, "$" + spent.toFixed(4));
  }
  const ratio = Math.min(1, spent / budget);
  const color = ratio >= 0.9 ? theme.danger : ratio >= 0.5 ? theme.warning : theme.success;
  return fg(color, "$" + spent.toFixed(4) + "/$" + budget.toFixed(2));
}

function renderPickerOverlay(
  state: PickerState,
  width: number,
  height: number,
  theme: TuiTheme,
): string[] {
  const inner = renderPicker(state, { width: width - 4, height: height - 4, theme });
  return inner.map(
    (line) => fg(theme.accent, "│") + padVisible(" " + line, width - 2) + fg(theme.accent, "│"),
  );
}

function renderInputRows(state: TuiRenderState, width: number): string[] {
  const theme = state.theme;
  const label = state.busy ? "steer»" : state.mascot.id === "foxy" ? "fox»" : "focus»";
  const promptWidth = stringWidth(label) + 1;
  const contentWidth = width - 2 - promptWidth;
  const rows = state.input.split("\n");
  const cursorRow = Math.max(0, Math.min(rows.length - 1, state.inputCursor.row));
  const startRow = Math.min(
    Math.max(cursorRow - (MAX_INPUT_ROWS - 1), 0),
    Math.max(0, rows.length - MAX_INPUT_ROWS),
  );
  const attachmentText = state.attachments.length
    ? " 📎 " + state.attachments.map(sanitizeTerminalText).join(", ")
    : "";
  return rows.slice(startRow, startRow + MAX_INPUT_ROWS).map((text, offset) => {
    const logical = startRow + offset;
    const prefix = logical === 0 ? label + " " : " ".repeat(promptWidth);
    let content =
      logical === cursorRow
        ? renderInputCursor(text, state.inputCursor.col, contentWidth)
        : truncatePlain(expandTabs(text), contentWidth);
    if (logical === rows.length - 1 || offset === MAX_INPUT_ROWS - 1) content += attachmentText;
    return (
      fg(theme.accent, "│") +
      fg(theme.foreground, padVisible(prefix + content, width - 2)) +
      fg(theme.accent, "│")
    );
  });
}

/** Render one input row with the cursor highlighted; `col` is a grapheme index. */
function renderInputCursor(text: string, col: number, width: number): string {
  const clusters = segmentGraphemes(text).map((cluster) => (cluster === "\t" ? "  " : cluster));
  const position = Math.max(0, Math.min(clusters.length, col));
  // Slide a horizontal window so the cursor cell always stays visible.
  let start = 0;
  const widthOf = (list: string[]) => list.reduce((sum, item) => sum + stringWidth(item), 0);
  while (widthOf(clusters.slice(start, position)) > Math.max(0, width - 2)) start += 1;
  const before = clusters.slice(start, position).join("");
  const current = clusters[position] ?? " ";
  const afterBudget = Math.max(0, width - widthOf([before, current]));
  const after = takeWidth(clusters.slice(position + 1).join(""), afterBudget);
  return before + "\u001b[7m" + current + "\u001b[27m" + after;
}

function renderCompletionRows(state: TuiRenderState, width: number): string[] {
  const completion = state.completion;
  if (!completion?.candidates.length) return [];
  const theme = state.theme;
  const total = completion.candidates.length;
  const selected = Math.max(0, Math.min(total - 1, completion.index));
  const start = Math.min(Math.max(selected - 3, 0), Math.max(0, total - MAX_COMPLETION_ROWS));
  return completion.candidates
    .slice(start, start + MAX_COMPLETION_ROWS)
    .map((candidate, offset) => {
      const active = start + offset === selected;
      const label =
        (active ? "› " : "  ") +
        candidate.value +
        (candidate.description ? " — " + candidate.description : "");
      const text = truncatePlain(sanitizeTerminalText(label), width - 4);
      const styled = active ? fg(theme.accent, text) : fg(theme.muted, text);
      return fg(theme.accent, "│") + padVisible(" " + styled, width - 2) + fg(theme.accent, "│");
    });
}

function wrapTranscript(
  transcript: TuiTranscriptLine[],
  width: number,
  theme: TuiTheme,
  mascot: TuiMascot,
): string[] {
  const colors: Record<TuiTranscriptLine["role"], number> = {
    user: theme.secondary,
    assistant: theme.foreground,
    tool: theme.warning,
    system: theme.muted,
  };
  const assistantTag = mascot.id === "foxy" ? "fox" : "ai";
  const tags: Record<TuiTranscriptLine["role"], string> = {
    user: "you › ",
    assistant: assistantTag + " › ",
    tool: " ⚙ › ",
    system: " ✱ › ",
  };
  const result: string[] = [];
  for (const line of transcript) {
    const prefix = tags[line.role];
    const indent = " ".repeat(stringWidth(prefix));
    const contentWidth = Math.max(10, width - stringWidth(prefix));
    if (line.rendered?.length) {
      // Trusted pre-rendered ANSI (e.g. diffs): pass through, truncated to fit.
      for (const [index, segment] of line.rendered.entries()) {
        result.push(
          fg(colors[line.role], index === 0 ? prefix : indent) +
            truncateAnsi(segment, contentWidth),
        );
      }
      continue;
    }
    if (line.role === "assistant") {
      // Sanitize the raw text first, then let the markdown renderer emit its own ANSI.
      const rendered = renderMarkdownTranscript(line.text || " ", contentWidth, theme);
      for (const [index, segment] of rendered.entries()) {
        result.push(fg(colors.assistant, index === 0 ? prefix : indent) + segment);
      }
      continue;
    }
    for (const [index, segment] of wrap(line.text || " ", contentWidth).entries()) {
      result.push(fg(colors[line.role], (index === 0 ? prefix : indent) + segment));
    }
  }
  return result;
}

function wrap(text: string, width: number): string[] {
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
      if (currentWidth + cell > width) {
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

function expandTabs(value: string): string {
  return value.replaceAll("\t", "  ");
}

function truncatePlain(value: string, width: number): string {
  if (stringWidth(value) <= width) return value;
  return takeWidth(value, Math.max(1, width - 1)) + "…";
}

function padVisible(value: string, width: number): string {
  const clean = truncateVisible(value, width);
  return clean + " ".repeat(Math.max(0, width - visibleLength(clean)));
}

function truncateVisible(value: string, width: number): string {
  if (visibleLength(value) <= width) return value;
  const plain = stripAnsi(value);
  return takeWidth(plain, Math.max(0, width - 1)) + "…";
}

/** Display width in terminal columns, ignoring SGR sequences. */
export function visibleLength(value: string): number {
  return stringWidth(stripAnsi(value));
}

function bold(value: string): string {
  return "\u001b[1m" + value + "\u001b[22m";
}

function italic(value: string): string {
  return "\u001b[3m" + value + "\u001b[23m";
}
