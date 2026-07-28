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
  type SpecStageInfo,
} from "./spec-progress.js";
import { renderContextBar, type ContextUsageState } from "./context-bar.js";
import { renderPalette, type PaletteState } from "./command-palette.js";
import { renderSearchBar, type SearchState } from "./search.js";
import { renderVimIndicator, type VimState } from "./vim.js";
import { computeLayout, type ComputedLayout, type LayoutState, type PaneId } from "./layout.js";
import { renderTodoPanel, type TodoPanelState } from "./todo-panel.js";
import { bg, fg, type ColorValue, type TuiTheme } from "./themes.js";
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
  /** Transcript 搜索状态;visible 时在底部渲染搜索栏。 */
  search?: SearchState;
  /** 命令面板状态;visible 时渲染 overlay。 */
  palette?: PaletteState;
  /** Vim 模式状态;存在时在 footer 渲染模式指示器。 */
  vim?: VimState;
  /** Pane 布局状态;缺省时使用 classic 模式(向后兼容)。 */
  layout?: LayoutState;
  /** Todo 侧栏面板状态;仅在 split/wide 布局且有 todo 项时渲染。 */
  todoPanel?: TodoPanelState;
  /** Which pane currently has keyboard focus; used for focus highlight in sidebar. */
  activePane?: "input" | "todo" | "spec" | "context";
  /** Selected item index within each sidebar pane (for keyboard navigation). */
  paneSelection?: { todo: number; spec: number; context: number };
  /** Toast notification rendered over the top-right corner with fade animation. */
  toast?: { text: string; startedAt: number; level: "info" | "success" | "warning" };
  /** Spec history browser overlay entries and selection. */
  specHistoryView?: {
    entries: Array<{
      specId: string;
      topic: string;
      completedAt: number;
      totalDuration?: number;
      status: "completed" | "skipped";
      stages: SpecStageInfo[];
    }>;
    selectedIndex: number;
  };
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

  // Layout dispatch: non-classic modes (split/focus/wide) use layout-aware rendering.
  // Overlays (picker/palette/spec-history) always use classic rendering since they take over the full screen.
  let frame: string;
  if (state.layout && !state.picker && !state.palette?.visible && !state.specHistoryView) {
    const computed = computeLayout(state.layout, width, height);
    if (computed.mode !== "classic") {
      frame = renderWithLayout(state, width, height, theme, computed);
    } else {
      frame = renderClassicFrame(state, width, height, theme);
    }
  } else {
    frame = renderClassicFrame(state, width, height, theme);
  }

  // Toast notification overlay: positioned at top-right with fade animation.
  if (state.toast) {
    frame += renderToastOverlay(state.toast, width, theme);
  }

  return frame;
}

/**
 * Classic single-pane rendering — the original golden path, unchanged for backward compat.
 * Called when no layout is set, layout mode is classic, or width/height force fallback.
 */
function renderClassicFrame(
  state: TuiRenderState,
  width: number,
  height: number,
  theme: TuiTheme,
): string {
  const border = theme.border;
  const top = fg(theme.accent, "╭" + border.repeat(width - 2) + "╮");
  const bottom = fg(theme.accent, "╰" + border.repeat(width - 2) + "╯");
  const glyph = state.mascot.id === "foxy" ? "🦊 " : "";
  // Status indicator: ● when busy (danger), ○ when idle (muted).
  const statusColor = state.busy ? theme.danger : theme.muted;
  const statusDot = fg(statusColor, state.busy ? "●" : "○");
  const headerText =
    " " +
    statusDot +
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
      mascotCell = fg(theme.accent, padVisible(" ╭" + border.repeat(mascotWidth - 2), mascotWidth));
    } else if (bubble !== undefined) {
      mascotCell =
        fg(theme.accent, "│") + italic(fg(theme.secondary, padVisible(bubble, mascotWidth - 1)));
    } else if (speechLines.length && row === mascot.length + speechLines.length + 1) {
      mascotCell = fg(theme.accent, padVisible(" ╰" + border.repeat(mascotWidth - 2), mascotWidth));
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
  const separator = fg(theme.muted, "├" + border.repeat(width - 2) + "┤");
  // SpecEngine progress widget (shown when phase !== idle)
  const specLines: string[] = [];
  if (state.specProgress && state.specProgress.phase !== "idle") {
    const rendered = renderSpecProgress(state.specProgress, bodyWidth, theme, {
      tick: state.tick,
    });
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
  const vimIndicator = state.vim ? renderVimIndicator(state.vim, theme) : "";
  const footerExtras = [companionBadge, costBadge, contextBadge, vimIndicator]
    .filter(Boolean)
    .join(" · ");
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
  const searchLines: string[] = state.search?.visible
    ? renderSearchBar(state.search, width - 2, theme).map(
        (line) => fg(theme.accent, "│") + padVisible(line, width - 2) + fg(theme.accent, "│"),
      )
    : [];
  if (state.picker) {
    const overlay = renderPickerOverlay(state.picker, width, height, theme);
    return bg(theme.background, [top, header, ...overlay, footer, bottom].join("\n"));
  }
  if (state.palette?.visible) {
    const paletteLines = renderPalette(
      state.palette,
      width - 2,
      Math.max(4, Math.floor(height / 2)),
      theme,
    ).map((line) => fg(theme.accent, "│") + padVisible(line, width - 2) + fg(theme.accent, "│"));
    return bg(theme.background, [top, header, ...paletteLines, footer, bottom].join("\n"));
  }
  if (state.specHistoryView) {
    const historyLines = renderSpecHistory(
      state.specHistoryView,
      width - 2,
      Math.max(6, height - 7),
      theme,
    ).map((line) => fg(theme.accent, "│") + padVisible(line, width - 2) + fg(theme.accent, "│"));
    return bg(theme.background, [top, header, ...historyLines, footer, bottom].join("\n"));
  }
  return bg(
    theme.background,
    [
      top,
      header,
      ...body,
      ...specLines,
      ...reasoningRows,
      ...searchLines,
      separator,
      ...completionRows,
      ...inputRows,
      footer,
      bottom,
    ].join("\n"),
  );
}

/**
 * Layout-aware rendering for split/focus/wide modes.
 * Renders main pane (mascot + transcript) and optional sidebar (todo panel).
 * Only called when computed.mode !== "classic" (i.e. width >= 100 && height >= 20).
 */
function renderWithLayout(
  state: TuiRenderState,
  width: number,
  height: number,
  theme: TuiTheme,
  computed: ComputedLayout,
): string {
  const border = theme.border;
  const top = fg(theme.accent, "╭" + border.repeat(width - 2) + "╮");
  const bottom = fg(theme.accent, "╰" + border.repeat(width - 2) + "╯");
  // Header: hide mascot glyph in focus mode
  const glyph = computed.hideMascot ? "" : state.mascot.id === "foxy" ? "🦊 " : "";
  // Status indicator: ● when busy (danger), ○ when idle (muted).
  const statusColor = state.busy ? theme.danger : theme.muted;
  const statusDot = fg(statusColor, state.busy ? "●" : "○");
  const headerText =
    " " +
    statusDot +
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

  // Mascot (hidden in focus mode)
  const mascot = computed.hideMascot ? [] : mascotFrame(state.mascot, state.mood, state.tick);
  const mascotWidth = computed.hideMascot
    ? 0
    : Math.min(24, Math.max(...mascot.map(visibleLength), 0) + 2);
  const speechLines = computed.hideMascot ? [] : wrapSpeech(state.speech, mascotWidth - 1);

  const sidebarWidth = computed.sidebar?.width ?? 0;
  const hasSidebar = computed.sidebar !== undefined && sidebarWidth > 0;
  const transcriptWidth = computed.hideMascot
    ? width - 2
    : hasSidebar
      ? width - mascotWidth - sidebarWidth - 4
      : width - mascotWidth - 3;

  const inputRows = renderInputRows(state, width);
  const completionRows = renderCompletionRows(state, width);
  const bodyHeight = Math.max(6, height - 5 - inputRows.length - completionRows.length);

  // Main transcript lines
  const lines = wrapTranscript(state.transcript, transcriptWidth, theme, state.mascot);
  const end = Math.max(0, lines.length - state.scrollOffset);
  const visible = lines.slice(Math.max(0, end - bodyHeight), end);

  // Sidebar panes: render todo/spec/context stacked when in split/wide mode
  let sidebarLines: string[] = [];
  if (hasSidebar) {
    const panes = computed.sidebarPanes;
    if (panes.length > 0) {
      sidebarLines = renderSidebarPanes(panes, state, sidebarWidth, bodyHeight, theme);
    } else if (state.todoPanel) {
      // Fallback: no computed panes but todo panel exists (e.g. legacy layout)
      sidebarLines = renderTodoPanel(state.todoPanel, sidebarWidth - 1, bodyHeight, theme);
    }
  }

  const body: string[] = [];
  for (let row = 0; row < bodyHeight; row += 1) {
    let line: string;
    if (computed.hideMascot) {
      // Focus mode: no mascot column, full-width transcript
      const transcript = visible[row] ?? "";
      line = fg(theme.accent, "│") + padVisible(" " + transcript, transcriptWidth);
    } else {
      const art = mascot[row];
      const bubble = speechLines[row - mascot.length - 1];
      let mascotCell: string;
      if (art !== undefined) {
        mascotCell = fg(theme.secondary, padVisible(" " + art, mascotWidth));
      } else if (row === mascot.length && speechLines.length) {
        mascotCell = fg(
          theme.accent,
          padVisible(" ╭" + border.repeat(mascotWidth - 2), mascotWidth),
        );
      } else if (bubble !== undefined) {
        mascotCell =
          fg(theme.accent, "│") + italic(fg(theme.secondary, padVisible(bubble, mascotWidth - 1)));
      } else if (speechLines.length && row === mascot.length + speechLines.length + 1) {
        mascotCell = fg(
          theme.accent,
          padVisible(" ╰" + border.repeat(mascotWidth - 2), mascotWidth),
        );
      } else {
        mascotCell = padVisible("", mascotWidth);
      }
      const transcript = visible[row] ?? "";
      line =
        fg(theme.accent, "│") +
        mascotCell +
        fg(theme.muted, "│") +
        padVisible(" " + transcript, transcriptWidth);
    }

    if (hasSidebar) {
      const sidebarContent = sidebarLines[row] ?? "";
      line +=
        fg(theme.muted, "│") +
        padVisible(" " + sidebarContent, sidebarWidth - 1) +
        fg(theme.accent, "│");
    } else {
      line += fg(theme.accent, "│");
    }
    body.push(line);
  }

  // SpecEngine progress widget — only render in main area for classic/focus
  // mode. In split/wide mode, spec progress is rendered in the sidebar.
  const specLines: string[] = [];
  const specInSidebar = hasSidebar && computed.sidebarPanes.includes("spec");
  if (!specInSidebar && state.specProgress && state.specProgress.phase !== "idle") {
    const rendered = renderSpecProgress(state.specProgress, transcriptWidth, theme, {
      tick: state.tick,
    });
    for (const line of rendered) {
      specLines.push(line);
    }
  }
  if (state.specConfirmation) {
    const confirmLines = renderSpecConfirmation(state.specConfirmation, width, theme);
    specLines.push(...confirmLines);
  }

  // Reasoning indicator
  let reasoningLine = "";
  if (state.reasoning) {
    if (state.reasoningExpanded) {
      const text = state.reasoning.replaceAll(/\r?\n/g, " ");
      const truncated =
        text.length > transcriptWidth - 4 ? text.slice(0, transcriptWidth - 5) + "…" : text;
      reasoningLine = "💭 " + truncated;
    } else {
      reasoningLine = "💭 thinking...";
    }
  }
  const reasoningRows: string[] = reasoningLine ? [reasoningLine] : [];

  // Search bar
  const searchLines: string[] = state.search?.visible
    ? renderSearchBar(state.search, width - 2, theme).map(
        (line) => fg(theme.accent, "│") + padVisible(line, width - 2) + fg(theme.accent, "│"),
      )
    : [];

  // Separator + footer (same as classic)
  const separator = fg(theme.muted, "├" + border.repeat(width - 2) + "┤");
  const queue = state.queued ? " · queued " + state.queued : "";
  const spinner = state.busy ? SPINNER[state.tick % SPINNER.length]! + " " : "";
  const companionBadge = state.companion ? renderCompanionBadge(state.companion, theme) : "";
  const costBadge =
    state.sessionCost !== undefined
      ? renderCostBadge(state.sessionCost, state.sessionBudget, theme)
      : "";
  // Context bar: render in footer only when not already in sidebar
  const contextInSidebar = hasSidebar && computed.sidebarPanes.includes("context");
  const contextBadge =
    state.contextUsage && !contextInSidebar ? renderContextBar(state.contextUsage, 30, theme) : "";
  const vimIndicator = state.vim ? renderVimIndicator(state.vim, theme) : "";
  const footerExtras = [companionBadge, costBadge, contextBadge, vimIndicator]
    .filter(Boolean)
    .join(" · ");
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

  return bg(
    theme.background,
    [
      top,
      header,
      ...body,
      ...specLines,
      ...reasoningRows,
      ...searchLines,
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

/**
 * Render multiple panes (todo/spec/context) stacked vertically in the sidebar.
 * Each pane is rendered by its dedicated renderer; panes are separated by a
 * thin muted line. The result is truncated to `bodyHeight` lines.
 * The currently focused pane gets a highlighted title bar; selected items get
 * a cursor indicator.
 */
function renderSidebarPanes(
  panes: PaneId[],
  state: TuiRenderState,
  sidebarWidth: number,
  bodyHeight: number,
  theme: TuiTheme,
): string[] {
  const paneWidth = Math.max(8, sidebarWidth - 2);
  const lines: string[] = [];
  const separator = fg(theme.muted, "─".repeat(Math.max(1, paneWidth)));

  for (const paneId of panes) {
    let paneLines: string[] = [];
    const isFocused = state.activePane === paneId;
    const selIdx = state.paneSelection?.[paneId as "todo" | "spec" | "context"] ?? 0;

    if (paneId === "todo" && state.todoPanel) {
      const rendered = renderTodoPanel(state.todoPanel, paneWidth, bodyHeight, theme);
      paneLines = highlightPaneLines(rendered, paneWidth, isFocused, selIdx, theme, "todo");
    } else if (paneId === "spec" && state.specProgress && state.specProgress.phase !== "idle") {
      const rendered = renderSpecProgress(state.specProgress, paneWidth, theme, {
        tick: state.tick,
      });
      paneLines = highlightPaneLines(rendered, paneWidth, isFocused, selIdx, theme, "spec");
    } else if (paneId === "context" && state.contextUsage) {
      const bar = renderContextBar(state.contextUsage, paneWidth, theme);
      const title = isFocused
        ? fg(theme.accent, "▸ ") + fg(theme.foreground, "⚙ Context")
        : fg(theme.accent, "⚙ Context");
      paneLines = [title, bar];
    }

    if (paneLines.length === 0) continue;

    if (lines.length > 0) {
      lines.push(separator);
    }
    lines.push(...paneLines);
  }

  return lines.slice(0, bodyHeight);
}

/**
 * Apply focus styling to a pane: prefix focused title with ▸, and mark the
 * selected item line with a reverse-video highlight or cursor marker.
 * `kind` determines how we find the "selectable" item lines:
 * - "todo": lines starting with checkbox glyphs (☐/☑)
 * - "spec": lines starting with stage bullets (●/○/✓)
 */
function highlightPaneLines(
  lines: string[],
  width: number,
  focused: boolean,
  selectedIdx: number,
  theme: TuiTheme,
  kind: "todo" | "spec",
): string[] {
  if (lines.length === 0) return lines;
  const out: string[] = [];
  let itemCount = 0;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    // Detect the title line (first line) for focus marker.
    if (i === 0 && focused) {
      // Replace leading space with ▸ or prefix ▸ to indicate focus.
      if (line.startsWith(" ")) {
        line = fg(theme.accent, "▸") + line.slice(1);
      } else {
        line = fg(theme.accent, "▸ ") + line;
      }
    }
    // Detect selectable item lines and apply selection highlight.
    const isItemLine =
      (kind === "todo" && /^\s*[☐✓🔄]/.test(stripAnsi(line))) ||
      (kind === "spec" && /^\s*[●○◐◓◑◒✓◇◆◎]/.test(stripAnsi(line)));
    if (isItemLine) {
      if (focused && itemCount === selectedIdx) {
        // Apply selection: wrap in reverse-video or prefix with >.
        line = "\u001b[7m" + line + "\u001b[27m";
      }
      itemCount++;
    }
    out.push(line);
  }
  return out;
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
  const colors: Record<TuiTranscriptLine["role"], ColorValue> = {
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

function faintLocal(value: string): string {
  return "\u001b[2m" + value + "\u001b[22m";
}

interface SpecHistoryView {
  entries: Array<{
    specId: string;
    topic: string;
    completedAt: number;
    totalDuration?: number;
    status: "completed" | "skipped";
    stages: SpecStageInfo[];
  }>;
  selectedIndex: number;
}

/**
 * Render the spec history browser overlay: a scrollable list of past specs
 * with status icons, topics, timestamps, and stage summary. The selected
 * entry shows its full stage breakdown below the list.
 */
function renderSpecHistory(
  view: SpecHistoryView,
  width: number,
  height: number,
  theme: TuiTheme,
): string[] {
  const lines: string[] = [];
  const innerWidth = Math.max(30, width);
  const dash = "─".repeat(innerWidth);

  // Header
  lines.push(bold(fg(theme.accent, "✦ Spec History")));
  lines.push(fg(theme.muted, dash));

  if (view.entries.length === 0) {
    lines.push("");
    lines.push(faintLocal(fg(theme.muted, "  No specs recorded yet. Run /spec to plan a task.")));
    lines.push("");
    lines.push(fg(theme.muted, dash));
    lines.push(faintLocal(fg(theme.muted, " Esc close")));
    // Pad to fill height
    while (lines.length < height) lines.push("");
    return lines;
  }

  // List area: show up to ~8 entries, with selection highlight.
  const listMax = Math.min(8, Math.max(3, height - 12));
  const startIdx = Math.max(0, Math.min(view.selectedIndex - Math.floor(listMax / 2), view.entries.length - listMax));
  const visible = view.entries.slice(startIdx, startIdx + listMax);

  for (let i = 0; i < visible.length; i++) {
    const entry = visible[i]!;
    const idx = startIdx + i;
    const selected = idx === view.selectedIndex;
    const statusIcon = entry.status === "completed" ? "●" : "○";
    const statusColor = entry.status === "completed" ? theme.success : theme.warning;
    const dur = entry.totalDuration ? " · " + (entry.totalDuration / 1000).toFixed(1) + "s" : "";
    const timeAgo = formatTimeAgo(entry.completedAt);
    const topic = truncatePlain(entry.topic, innerWidth - 12);
    const line = " " + (selected ? "›" : " ") + " " + fg(statusColor, statusIcon) + " " + topic;
    const meta = faintLocal(fg(theme.muted, dur + " · " + timeAgo));
    const full = line + meta;
    const padded = padVisible(full, innerWidth);
    lines.push(selected ? bg(theme.muted, padded) : padded);
  }

  // Detail for selected entry
  const selected = view.entries[view.selectedIndex];
  if (selected) {
    lines.push(fg(theme.muted, dash));
    lines.push(bold(fg(theme.foreground, "  " + truncatePlain(selected.topic, innerWidth - 4))));
    lines.push(faintLocal(fg(theme.muted, "  " + truncatePlain(selected.specId, innerWidth - 4))));
    lines.push("");
    for (const stage of selected.stages) {
      const icon = stage.status === "done" ? "●" : stage.status === "failed" ? "✗" : stage.status === "running" ? "◐" : "○";
      const color = stage.status === "done" ? theme.success : stage.status === "failed" ? theme.danger : theme.muted;
      const dur = stage.durationMs ? faintLocal(" " + stage.durationMs + "ms") : "";
      const fb = stage.fellBack ? faintLocal(fg(theme.warning, " (fallback)")) : "";
      lines.push("  " + fg(color, icon) + " " + stage.name + dur + fb);
    }
  }

  // Footer with keybindings
  lines.push(fg(theme.muted, dash));
  lines.push(faintLocal(fg(theme.muted, " ↑↓ navigate  Esc close")));

  // Pad to fill height
  while (lines.length < height) lines.push("");
  return lines;
}

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return seconds + "s ago";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + "m ago";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + "h ago";
  return Math.floor(hours / 24) + "d ago";
}

/**
 * Render a toast notification overlay using ANSI cursor positioning.
 * The toast appears at the top-right corner with fade animation phases:
 *   0-300ms:  fade-in (faint → bold)
 *   300-1800ms: hold (full opacity)
 *   1800-2500ms: fade-out (normal → faint → gone)
 * Returns ANSI sequences that move the cursor, draw the toast, then restore.
 */
function renderToastOverlay(
  toast: { text: string; startedAt: number; level: "info" | "success" | "warning" },
  width: number,
  theme: TuiTheme,
): string {
  const elapsed = Date.now() - toast.startedAt;
  if (elapsed > 2500) return "";

  // Compute fade phase intensity.
  let intensity: "bold" | "normal" | "faint" | "gone";
  if (elapsed < 150) intensity = "gone";
  else if (elapsed < 300) intensity = "faint";
  else if (elapsed < 1800) intensity = "bold";
  else if (elapsed < 2200) intensity = "normal";
  else if (elapsed < 2500) intensity = "faint";
  else intensity = "gone";

  if (intensity === "gone") return "";

  // Truncate toast text to fit within half the screen width at most.
  const maxLen = Math.min(50, Math.floor(width / 2) - 4);
  const clean = sanitizeTerminalText(toast.text).replaceAll(/\s+/g, " ").trim();
  const text = clean.length > maxLen ? clean.slice(0, maxLen - 1) + "…" : clean;
  const padded = " " + text + " ";
  const visibleLen = stringWidth(padded);
  const col = Math.max(1, width - visibleLen - 1);

  const levelColor =
    toast.level === "success"
      ? theme.success
      : toast.level === "warning"
        ? theme.warning
        : theme.accent;

  let styled: string;
  const colored = fg(levelColor, padded);
  if (intensity === "bold") styled = bold(colored);
  else if (intensity === "faint") styled = faintLocal(colored);
  else styled = colored;

  // Position cursor at row 2 (below the top border), column `col`, clear the
  // toast area, draw the toast, then restore cursor to home. Using save/restore
  // cursor (ESC 7 / ESC 8) to avoid disturbing the frame's final cursor position.
  const clearArea = " ".repeat(visibleLen);
  return (
    "\u001b7" +
    "\u001b[" +
    2 +
    ";" +
    col +
    "H" +
    clearArea +
    "\u001b[" +
    2 +
    ";" +
    col +
    "H" +
    styled +
    "\u001b8"
  );
}
