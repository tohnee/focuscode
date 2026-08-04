import type { ReadStream, WriteStream } from "node:tty";
import { collectCompletions, type CompletionProvider, type CompletionState } from "./completion.js";
import type { CompanionState } from "./companion.js";
import { EditorBuffer } from "./editor.js";
import {
  DEFAULT_KEYMAP,
  PREFIX_BINDINGS,
  TerminalInputDecoder,
  type TuiAction,
  type TuiKeymap,
} from "./keymap.js";
import { getMascot, TUI_MASCOTS, type MascotMood, type TuiMascot } from "./mascots.js";
import {
  confirmPicker,
  createPickerState,
  cycleProvider,
  cycleReasoningEffort,
  pickerVisibleModels,
  updatePicker,
  type PickerProvider,
  type PickerResult,
  type PickerState,
  type ReasoningEffort,
} from "./picker.js";
import { renderTui, type TuiRenderState, type TuiTranscriptLine } from "./renderer.js";
import {
  advanceConfirmation,
  collectChoices,
  createInitialSpecProgress,
  createSpecConfirmation,
  type SpecConfirmationState,
  type SpecDecisionView,
  type SpecProgressState,
  type SpecStageInfo,
} from "./spec-progress.js";
import { getTheme, initColorModeFromEnv, TUI_THEMES, type TuiTheme } from "./themes.js";
import type { ContextUsageState } from "./context-bar.js";
import {
  closePalette,
  confirmPalette,
  createPaletteState,
  movePaletteCursor,
  updatePaletteQuery,
  type PaletteCommand,
  type PaletteState,
} from "./command-palette.js";
import {
  advanceSearch,
  closeSearch,
  createSearchState,
  searchTranscript,
  type SearchState,
} from "./search.js";
import { createVimState, vimHandleKey, type VimAction, type VimState } from "./vim.js";
import {
  createInitialLayout,
  cycleLayoutMode as cycleLayoutModeFn,
  setLayoutMode as setLayoutModeFn,
  toggleSidebarPane as toggleSidebarPaneFn,
  setSidebarPaneVisible as setSidebarPaneVisibleFn,
  type LayoutMode,
  type LayoutState,
  type PaneId,
} from "./layout.js";
import {
  addTodoItem as addTodoItemFn,
  createInitialTodoPanel,
  removeTodoItem as removeTodoItemFn,
  setTodoItems as setTodoItemsFn,
  updateTodoStatus as updateTodoStatusFn,
  type TodoItem,
  type TodoPanelState,
  type TodoPriority,
  type TodoStatus,
} from "./todo-panel.js";
import {
  buildSessionTree as buildSessionTreeFn,
  createInitialTreePanel,
  type SessionTreeInput,
  type SessionTreeNode,
  type TreePanelState,
} from "./tree-panel.js";

export interface FullScreenTuiOptions {
  input: ReadStream;
  output: WriteStream;
  title?: string;
  model: string;
  session: string;
  approval: string;
  sandbox: string;
  theme?: string | TuiTheme;
  mascot?: string | TuiMascot;
  keymap?: TuiKeymap;
  completionProviders?: CompletionProvider[];
  /**
   * Providers + models shown in the full-screen picker (Alt+M). When omitted,
   * Alt+M is a no-op.
   */
  pickerProviders?: PickerProvider[];
  /** Initial reasoning-effort slot for the picker. */
  pickerReasoningEffort?: ReasoningEffort;
  /** Optional callback invoked when the user confirms a picker selection. */
  onPickModel?(result: PickerResult): void;
  onSubmit(text: string): Promise<void>;
  onSteer(text: string): Promise<void>;
  onAbort(): void;
  onCommand?(command: string): Promise<string | void>;
  /** SpecEngine 交互式确认回调。当用户在 TUI 里完成决策选择时调用。 */
  onSpecConfirm?(specId: string, choices: Record<string, string>): void;
  /** SpecEngine 拒绝整个 spec 时调用。 */
  onSpecDecline?(specId: string): void;
  /** 命令面板确认回调。当用户从 palette 选择命令时调用。 */
  onPaletteCommand?(command: PaletteCommand): void;
  /** 初始 vim 模式开关；默认 false。用于持久化恢复用户偏好。 */
  vimEnabled?: boolean;
  /** vim 模式切换回调（构造时不会触发，仅 setVimEnabled/toggle_vim 触发）。 */
  onVimToggle?(enabled: boolean): void;
}

export class FullScreenTui {
  private theme: TuiTheme;
  private mascot: TuiMascot;
  private model: string;
  private session: string;
  private approval: string;
  private readonly keymap: TuiKeymap;
  private transcript: TuiTranscriptLine[] = [];
  private readonly editor = new EditorBuffer();
  private completion: CompletionState | undefined;
  private history: string[] = [];
  private historyIndex = 0;
  private busy = false;
  private queued = 0;
  private mood: MascotMood = "idle";
  private tick = 0;
  private attachments: string[] = [];
  private status: string | undefined;
  private speech: string | undefined;
  private scrollOffset = 0;
  private disposed = false;
  /** Removes the abnormal-exit signal handlers installed by run(). */
  private signalCleanup: (() => void) | undefined;
  private exitResolve!: () => void;
  private readonly exited = new Promise<void>((resolve) => {
    this.exitResolve = resolve;
  });
  private timer?: NodeJS.Timeout;
  private approvalResolve: ((allowed: boolean) => void) | undefined;
  private readonly inputDecoder: TerminalInputDecoder;
  private lastFrame: string[] = [];
  private lastDimensions = "";
  private picker: PickerState | undefined;
  private pickerPreviousMood: MascotMood | undefined;
  private moodRevertTimer: NodeJS.Timeout | undefined;
  private companion: CompanionState | undefined;
  private sessionCost: number | undefined;
  private sessionBudget: number | undefined;
  private cacheMetrics: { hitRatio: number; savedUsd: number } | undefined;
  private specProgress: SpecProgressState = createInitialSpecProgress();
  private specConfirmation: SpecConfirmationState | undefined;
  private reasoning: string | undefined;
  private reasoningExpanded: boolean | undefined;
  private contextUsage: ContextUsageState | undefined;
  private search: SearchState = createSearchState();
  private palette: PaletteState = createPaletteState();
  private vimEnabled = false;
  private vimState: VimState = createVimState();
  /** Which sidebar pane currently has keyboard focus ("input" = main input has focus). */
  private activePane: "input" | "todo" | "spec" | "context" | "tree" | "nav" | "preview" = "input";
  /** tmux 前缀键等待态：Ctrl+B 之后的下一个键是面板组合。 */
  private prefixPending = false;
  /** Selected item index within each sidebar pane. */
  private paneSelection: { todo: number; spec: number; context: number; tree: number } = {
    todo: 0,
    spec: 0,
    context: 0,
    tree: 0,
  };
  private layout: LayoutState = createInitialLayout();
  private todoPanel: TodoPanelState = createInitialTodoPanel();
  private treePanel: TreePanelState = createInitialTreePanel();
  /** Active toast notification with fade animation state. */
  private toast?: { text: string; startedAt: number; level: "info" | "success" | "warning" };
  /** History of completed/skipped specs for browsing. */
  private specHistory: Array<{
    specId: string;
    topic: string;
    completedAt: number;
    totalDuration?: number;
    status: "completed" | "skipped";
    stages: SpecStageInfo[];
  }> = [];
  /** Whether the spec history browser overlay is visible. */
  private specHistoryVisible = false;
  /** Selected index in the spec history list. */
  private specHistorySelection = 0;

  constructor(private readonly options: FullScreenTuiOptions) {
    // L4: honor FOCUSCODE_COLOR_MODE env var before the first render so
    // 256-color downgrade applies from the very first frame.
    initColorModeFromEnv();
    this.theme = getTheme(options.theme);
    this.mascot = getMascot(options.mascot);
    this.model = options.model;
    this.session = options.session;
    this.approval = options.approval;
    this.keymap = options.keymap ?? DEFAULT_KEYMAP;
    this.inputDecoder = new TerminalInputDecoder(this.keymap);
    // D10: restore vim mode from persisted preference (no callback during init).
    if (options.vimEnabled) this.vimEnabled = true;
  }

  async run(): Promise<void> {
    if (!this.options.input.isTTY || !this.options.output.isTTY) {
      throw new Error("Full-screen TUI requires a TTY");
    }
    this.options.input.setRawMode(true);
    this.options.input.setEncoding("utf8");
    this.options.input.resume();
    this.options.output.write("\u001b[?1049h\u001b[?25l\u001b[?2004h");
    this.options.input.on("data", this.onData);
    this.options.output.on("resize", this.onResize);
    this.timer = setInterval(() => {
      this.tick += 1;
      this.render();
    }, 500);
    this.timer.unref();
    // Restore the terminal on abnormal exit: only dispose() (Ctrl+D) used to
    // reset raw mode and leave the alternate screen, so a crash or a
    // SIGINT/SIGTERM/SIGHUP left the user's shell broken (raw mode, cursor
    // hidden). dispose() removes these handlers again.
    const restore = () => this.dispose();
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.once(signal, restore);
    }
    this.signalCleanup = () => {
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
        process.removeListener(signal, restore);
      }
    };
    this.render();
    await this.exited;
  }

  addMessage(
    role: TuiTranscriptLine["role"],
    text: string,
    options?: { rendered?: string[] },
  ): void {
    this.transcript.push({
      role,
      text,
      ...(options?.rendered ? { rendered: [...options.rendered] } : {}),
    });
    this.transcript = this.transcript.slice(-500);
    this.scrollOffset = 0;
    this.render();
  }

  appendAssistant(delta: string): void {
    const last = this.transcript.at(-1);
    if (last?.role === "assistant" && !last.rendered) last.text += delta;
    else this.transcript.push({ role: "assistant", text: delta });
    this.render();
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.mood = busy ? "thinking" : "idle";
    this.render();
  }

  setQueued(count: number): void {
    this.queued = Math.max(0, count);
    this.render();
  }

  setMood(mood: MascotMood): void {
    this.mood = mood;
    this.render();
  }

  setStatus(status?: string): void {
    this.status = status;
    this.render();
  }

  /** Show (or clear, when omitted) one short encouraging line beside the mascot. */
  setSpeech(speech?: string): void {
    const clean = speech?.trim();
    this.speech = clean ? clean : undefined;
    this.render();
  }

  /**
   * Show a brief toast notification that fades in, holds, and fades out over
   * ~2 seconds. The toast is rendered in the top-right corner of the TUI and
   * does not block input. Calling while a toast is active replaces it.
   */
  showToast(text: string, level: "info" | "success" | "warning" = "info"): void {
    const clean = text.trim();
    if (!clean) {
      delete this.toast;
      this.render();
      return;
    }
    this.toast = { text: clean, startedAt: Date.now(), level };
    this.render();
  }

  setAttachments(names: string[]): void {
    this.attachments = [...names];
    this.render();
  }

  setModel(model: string): void {
    this.model = model;
    this.render();
  }

  /**
   * Switch the active theme by name (from TUI_THEMES), or cycle to the next
   * theme when the name is omitted. Returns the applied theme name, or an
   * empty string when a named theme was requested but not found. Backs the
   * /theme slash command (Ctrl+T remains the instant cycle).
   */
  setTheme(name?: string): string {
    if (name) {
      const match = TUI_THEMES.find(
        (candidate) => candidate.name.toLowerCase() === name.toLowerCase(),
      );
      if (!match) return "";
      this.theme = match;
      this.render();
      return this.theme.name;
    }
    this.theme = this.nextTheme();
    this.render();
    return this.theme.name;
  }

  /**
   * Next theme in the cycle. Lookup is by theme id: getTheme/validate return
   * a fresh object, so reference-based indexOf would always miss and cycle
   * back to the first theme.
   */
  private nextTheme(): TuiTheme {
    const currentIndex = TUI_THEMES.findIndex((item) => item.id === this.theme.id);
    return TUI_THEMES[(Math.max(0, currentIndex) + 1) % TUI_THEMES.length]!;
  }

  setSession(session: string): void {
    this.session = session;
    this.render();
  }

  setApproval(approval: string): void {
    this.approval = approval;
    this.render();
  }

  /** Update the companion XP/level badge in the footer. */
  setCompanion(state: CompanionState | undefined): void {
    this.companion = state;
    this.render();
  }

  /** Update the session cost widget; pass `undefined` to hide it. */
  setSessionCost(spent: number | undefined, budget?: number): void {
    this.sessionCost = spent;
    this.sessionBudget = budget;
    this.render();
  }

  /** Update the cache hit metrics rendered under the Cost block. */
  setCacheMetrics(metrics: { hitRatio: number; savedUsd: number }): void {
    this.cacheMetrics = metrics;
    this.render();
  }

  /** Update SpecEngine progress state. */
  setSpecProgress(state: SpecProgressState): void {
    const wasTerminal =
      this.specProgress.phase === "completed" || this.specProgress.phase === "skipped";
    const isTerminal = state.phase === "completed" || state.phase === "skipped";
    this.specProgress = { ...state, stages: [...state.stages] };
    // When a spec first reaches a terminal state, record it in history.
    if (isTerminal && !wasTerminal) {
      this.recordSpecHistory(state);
    }
    this.render();
  }

  /** Record a completed/skipped spec into the rolling history buffer (max 20). */
  private recordSpecHistory(state: SpecProgressState): void {
    if (!state.specId) return;
    // Avoid duplicate entries for the same specId.
    if (this.specHistory.some((h) => h.specId === state.specId)) return;
    const entry = {
      specId: state.specId,
      topic: state.topic ?? "(untitled)",
      completedAt: Date.now(),
      ...(state.totalDuration !== undefined ? { totalDuration: state.totalDuration } : {}),
      status: state.phase as "completed" | "skipped",
      stages: state.stages.map((s) => ({ ...s })),
    };
    this.specHistory.unshift(entry);
    if (this.specHistory.length > 20) this.specHistory.length = 20;
  }

  /** Toggle the spec history browser overlay. */
  toggleSpecHistory(): void {
    this.specHistoryVisible = !this.specHistoryVisible;
    if (this.specHistoryVisible) {
      this.specHistorySelection = 0;
    }
    this.render();
  }

  /** Navigate spec history selection (delta = +1 or -1). */
  navigateSpecHistory(delta: number): void {
    if (!this.specHistoryVisible || this.specHistory.length === 0) return;
    const max = this.specHistory.length - 1;
    this.specHistorySelection = Math.max(0, Math.min(max, this.specHistorySelection + delta));
    this.render();
  }

  /** Close the spec history overlay. */
  closeSpecHistory(): void {
    this.specHistoryVisible = false;
    this.render();
  }

  /** Whether the spec history browser is currently visible. */
  isSpecHistoryVisible(): boolean {
    return this.specHistoryVisible;
  }

  /** Snapshot of current SpecEngine progress state (read-only). */
  getSpecProgress(): SpecProgressState {
    return {
      ...this.specProgress,
      stages: this.specProgress.stages.map((s) => ({ ...s })),
    };
  }

  /** Update or insert a single spec stage. */
  updateSpecStage(
    name: string,
    info: Partial<SpecStageInfo> & { status: SpecStageInfo["status"] },
  ): void {
    const stages = [...this.specProgress.stages];
    const idx = stages.findIndex((s) => s.name === name);
    const updated: SpecStageInfo = idx >= 0 ? { ...stages[idx]!, ...info } : { name, ...info };
    if (idx >= 0) stages[idx] = updated;
    else stages.push(updated);
    this.specProgress = { ...this.specProgress, stages };
    this.render();
  }

  /** Set spec draft preview (topic + understanding summary + task breakdown). */
  setSpecDraft(draft: {
    specId?: string;
    topic?: string;
    understanding?: {
      goal?: string;
      constraints?: unknown[];
      acceptanceCriteria?: unknown[];
      affectedAreas?: Array<{ path: string }>;
    };
    taskBreakdown?: Array<{ id: string; description: string; kind: string }>;
  }): void {
    const patch: Partial<SpecProgressState> = {};
    if (draft.specId !== undefined) patch.specId = draft.specId;
    if (draft.topic !== undefined) patch.topic = draft.topic;
    if (draft.understanding || draft.taskBreakdown) {
      const preview: SpecProgressState["draftPreview"] = {};
      if (draft.understanding?.goal !== undefined) preview.goal = draft.understanding.goal;
      if (draft.understanding?.constraints !== undefined)
        preview.constraintsCount = draft.understanding.constraints.length;
      if (draft.understanding?.acceptanceCriteria !== undefined)
        preview.acceptanceCriteriaCount = draft.understanding.acceptanceCriteria.length;
      if (draft.understanding?.affectedAreas !== undefined)
        preview.affectedFiles = draft.understanding.affectedAreas.map((a) => a.path);
      if (draft.taskBreakdown !== undefined) {
        preview.taskCount = draft.taskBreakdown.length;
        preview.tasks = draft.taskBreakdown.map((t) => ({
          id: t.id,
          description: t.description,
          kind: t.kind,
        }));
      }
      patch.draftPreview = preview;
    }
    this.specProgress = { ...this.specProgress, ...patch };
    this.render();
  }

  /** Get spec start time for duration calculation. */
  getSpecStartTime(): number | undefined {
    return this.specProgress.startTime;
  }

  /** Show interactive spec confirmation UI. */
  setSpecConfirmation(specId: string, decisions: SpecDecisionView[]): void {
    this.specConfirmation = createSpecConfirmation(specId, decisions);
    this.render();
  }

  /** Current confirmation state (for external assertion / input handling). */
  getSpecConfirmationState(): SpecConfirmationState | undefined {
    return this.specConfirmation;
  }

  /** Clear confirmation UI (after spec_confirmed or spec_skipped). */
  clearSpecConfirmation(): void {
    this.specConfirmation = undefined;
    this.render();
  }

  /** Decline the currently pending spec confirmation (equivalent to pressing Esc). */
  declineSpecConfirmation(): void {
    if (!this.specConfirmation) return;
    const specId = this.specConfirmation.specId;
    this.specConfirmation = undefined;
    this.options.onSpecDecline?.(specId);
    this.render();
  }

  /** Toggle reasoning display expanded/collapsed. */
  toggleReasoning(): void {
    this.reasoningExpanded = !this.reasoningExpanded;
    this.render();
  }

  /** Clear all transcript messages (keeps system welcome banner). */
  clearTranscript(): void {
    this.transcript = [];
    this.render();
  }

  /** Advance confirmation navigation; triggers callback on completion. */
  confirmSpecNavigation(action: "option_up" | "option_down" | "confirm" | "cancel"): void {
    if (!this.specConfirmation) return;
    const next = advanceConfirmation(this.specConfirmation, action);
    this.specConfirmation = next;
    if (next.completed) {
      if (action === "cancel") {
        this.options.onSpecDecline?.(next.specId);
      } else {
        const choices = collectChoices(next);
        this.options.onSpecConfirm?.(next.specId, choices);
      }
      this.specConfirmation = undefined;
    }
    this.render();
  }

  /** Append reasoning text (from reasoning_delta events). */
  appendReasoning(delta: string): void {
    // Cap the reasoning buffer (the transcript is capped too): an unbounded
    // buffer grows memory and makes every 500ms tick copy and re-scan the
    // whole string.
    const MAX_REASONING_CHARS = 20_000;
    this.reasoning = ((this.reasoning ?? "") + delta).slice(-MAX_REASONING_CHARS);
    this.render();
  }

  /** Clear reasoning buffer. */
  clearReasoning(): void {
    this.reasoning = undefined;
    this.render();
  }

  /** Toggle reasoning expanded state. */
  setReasoningExpanded(expanded: boolean): void {
    this.reasoningExpanded = expanded;
    this.render();
  }

  /** Update context usage display. */
  setContextUsage(state: ContextUsageState): void {
    this.contextUsage = { ...state };
    this.render();
  }

  // ─── Search ────────────────────────────────────────────────────────────

  /** Open the transcript search bar. */
  openSearch(): void {
    this.search = { ...createSearchState(), visible: true };
    this.render();
  }

  /** Close the search bar and clear state. */
  closeSearch(): void {
    this.search = closeSearch(this.search);
    this.render();
  }

  /** Update search query and recompute matches against the current transcript. */
  updateSearchQuery(query: string): void {
    const matches = searchTranscript(this.transcript, query);
    this.search = { ...this.search, query, matches, currentIndex: 0 };
    this.render();
  }

  /** Advance to the next/previous match (wraps around). */
  advanceSearch(delta: number): void {
    this.search = advanceSearch(this.search, delta);
    this.render();
  }

  /** Current search state snapshot. */
  getSearchState(): SearchState {
    return { ...this.search };
  }

  // ─── Command Palette ───────────────────────────────────────────────────

  /** Open the command palette overlay. */
  openPalette(): void {
    this.palette = { ...createPaletteState(), visible: true };
    this.render();
  }

  /** Close the palette overlay. */
  closePalette(): void {
    this.palette = closePalette(this.palette);
    this.render();
  }

  /** Update palette query and re-filter commands. */
  updatePaletteQuery(query: string): void {
    this.palette = updatePaletteQuery(this.palette, query);
    this.render();
  }

  /** Move the palette selection by delta (positive = down, negative = up). */
  movePaletteCursor(delta: number): void {
    this.palette = movePaletteCursor(this.palette, delta);
    this.render();
  }

  /** Confirm the current palette selection; fires onPaletteCommand and closes. */
  confirmPaletteSelection(): void {
    const cmd = confirmPalette(this.palette);
    if (cmd) {
      try {
        this.options.onPaletteCommand?.(cmd);
      } catch {
        // Swallow callback errors; palette UX stays non-blocking.
      }
    }
    this.closePalette();
  }

  /** Set the palette command callback at runtime (used by tests / late-binding). */
  setPaletteCallback(cb: (command: PaletteCommand) => void): void {
    (this.options as { onPaletteCommand?: (command: PaletteCommand) => void }).onPaletteCommand =
      cb;
  }

  // ─── Vim Mode ──────────────────────────────────────────────────────────

  /** Toggle vim modal editing on/off. When off, vimState is reset but kept as a valid object. */
  setVimEnabled(enabled: boolean): void {
    if (this.vimEnabled === enabled) return;
    this.vimEnabled = enabled;
    this.vimState = createVimState();
    // D10: notify caller so it can persist the preference.
    this.options.onVimToggle?.(enabled);
    this.render();
  }

  /** Current vim state (undefined when vim mode is disabled). */
  getVimState(): VimState | undefined {
    return this.vimEnabled ? { ...this.vimState } : undefined;
  }

  /**
   * Test-only entry point that mirrors feedInput. Exposed so unit tests can
   * drive the vim normal/insert state machine without constructing raw
   * keymap sequences. Not part of the public stable API.
   */
  feedInputForTest(value: string): void {
    this.feedInput(value);
  }

  // ─── Layout ────────────────────────────────────────────────────────────

  /** Switch to a specific layout mode (classic/split/focus/wide). */
  setLayoutMode(mode: LayoutMode): void {
    this.layout = setLayoutModeFn(this.layout, mode);
    // Sync todoPanel.visible with layout pane visibility
    const todoPane = this.layout.panes.find((p) => p.id === "todo");
    if (todoPane && this.todoPanel.visible !== todoPane.visible) {
      this.todoPanel = { ...this.todoPanel, visible: todoPane.visible };
    }
    // Sync treePanel.visible with layout pane visibility
    const treePane = this.layout.panes.find((p) => p.id === "tree");
    if (treePane && this.treePanel.visible !== treePane.visible) {
      this.treePanel = { ...this.treePanel, visible: treePane.visible };
    }
    this.render();
  }

  /** Cycle layout mode: classic → split → focus → wide → classic. */
  cycleLayoutMode(): void {
    const next = cycleLayoutModeFn(this.layout.mode);
    this.setLayoutMode(next);
  }

  /** Current layout state snapshot (defensive copy). */
  getLayoutState(): LayoutState {
    return {
      ...this.layout,
      panes: this.layout.panes.map((p) => ({ ...p })),
    };
  }

  // ─── Todo Panel ────────────────────────────────────────────────────────

  /** Replace all todo items. */
  setTodoItems(items: TodoItem[]): void {
    this.todoPanel = setTodoItemsFn(this.todoPanel, items);
    this.render();
  }

  /** Append a new todo item with given content and priority. */
  addTodoItem(content: string, priority: TodoPriority = "medium"): void {
    this.todoPanel = addTodoItemFn(this.todoPanel, content, priority);
    this.render();
  }

  /** Update todo item status by id. */
  updateTodoStatus(id: string, status: TodoStatus): void {
    this.todoPanel = updateTodoStatusFn(this.todoPanel, id, status);
    this.render();
  }

  /** Remove a todo item by id. */
  removeTodoItem(id: string): void {
    this.todoPanel = removeTodoItemFn(this.todoPanel, id);
    this.render();
  }

  /** Toggle a todo item between pending and completed. */
  toggleTodoItem(id: string): void {
    const item = this.todoPanel.items.find((i) => i.id === id);
    if (!item) return;
    const next: TodoStatus = item.status === "completed" ? "pending" : "completed";
    this.todoPanel = updateTodoStatusFn(this.todoPanel, id, next);
    this.render();
  }

  /** Toggle todo panel visibility. Syncs both todoPanel.visible and layout pane. */
  toggleTodoPanel(): void {
    const next = !this.todoPanel.visible;
    this.todoPanel = { ...this.todoPanel, visible: next };
    this.layout = setSidebarPaneVisibleFn(this.layout, "todo", next);
    this.render();
  }

  /**
   * Replace the sessions displayed in the tree panel. The caller is responsible
   * for loading SessionHeaders from the SessionStore and mapping them into
   * {@link SessionTreeInput}. Rebuilds the tree on every call.
   */
  setSessionTree(sessions: SessionTreeInput[]): void {
    const nodes = buildSessionTreeFn(sessions);
    this.treePanel = { ...this.treePanel, nodes };
    this.render();
  }

  /** Toggle tree panel visibility. Syncs both treePanel.visible and layout pane. */
  toggleTreePanel(): void {
    const next = !this.treePanel.visible;
    this.treePanel = { ...this.treePanel, visible: next };
    this.layout = setSidebarPaneVisibleFn(this.layout, "tree", next);
    this.render();
  }

  /** Toggle a sidebar pane (spec/context) visibility in the layout. */
  toggleSidebarPane(paneId: Exclude<PaneId, "todo" | "tree" | "transcript" | "input">): void {
    this.layout = toggleSidebarPaneFn(this.layout, paneId);
    this.render();
  }

  /** Cycle keyboard focus to the next visible sidebar pane, wrapping back to input. */
  cycleSidebarFocus(): void {
    const visible = this.visibleSidebarPanes();
    if (visible.length === 0) {
      this.activePane = "input";
      this.render();
      return;
    }
    if (this.activePane === "input") {
      this.activePane = visible[0]!;
    } else {
      const idx = visible.indexOf(this.activePane as "todo" | "spec" | "context" | "tree");
      if (idx < 0 || idx === visible.length - 1) {
        this.activePane = "input";
      } else {
        this.activePane = visible[idx + 1]!;
      }
    }
    // Clamp selection to visible items.
    this.clampPaneSelection();
    this.render();
  }

  /** Perform the primary action on the currently focused sidebar pane (e.g. toggle todo). */
  performSidebarAction(): void {
    if (this.activePane === "input") return;
    // workbench NORMAL 模式下 nav 面板聚焦时，动作落在 todo 列表上。
    const pane = this.activePane === "nav" ? "todo" : this.activePane;
    if (pane === "todo") {
      const idx = this.paneSelection.todo;
      const item = this.todoPanel.items[idx];
      if (item) {
        this.toggleTodoItem(item.id);
      }
      return;
    }
    // For spec/context panes, Enter is a no-op for now (informational panes).
  }

  /** Move the sidebar pane selection up or down (called by arrow keys when a pane is focused). */
  moveSidebarSelection(delta: number): void {
    if (this.activePane === "input") return;
    // 导航面板显示 todo 列表，选择索引复用 todo 槽位。
    const key = this.activePane === "nav" ? "todo" : this.activePane;
    if (key === "preview") return;
    const max = this.paneItemCount(key) - 1;
    this.paneSelection[key] = Math.max(0, Math.min(max, this.paneSelection[key] + delta));
    this.render();
  }

  private visibleSidebarPanes(): Array<"todo" | "spec" | "context" | "tree"> {
    const result: Array<"todo" | "spec" | "context" | "tree"> = [];
    const isVisible = (id: "todo" | "spec" | "context" | "tree") =>
      this.layout.panes.find((p) => p.id === id)?.visible === true;
    if (this.todoPanel.visible || isVisible("todo")) result.push("todo");
    if (isVisible("spec")) result.push("spec");
    if (isVisible("context")) result.push("context");
    if (this.treePanel.visible || isVisible("tree")) result.push("tree");
    return result;
  }

  private paneItemCount(pane: "todo" | "spec" | "context" | "tree"): number {
    if (pane === "todo") return Math.max(1, this.todoPanel.items.length);
    if (pane === "spec") return Math.max(1, this.specProgress.stages.length);
    if (pane === "context") return 1;
    if (pane === "tree") return Math.max(1, countTreeNodes(this.treePanel.nodes));
    return 0;
  }

  private clampPaneSelection(): void {
    for (const pane of ["todo", "spec", "context", "tree"] as const) {
      const max = Math.max(0, this.paneItemCount(pane) - 1);
      if (this.paneSelection[pane] > max) this.paneSelection[pane] = max;
    }
  }

  /** Current todo panel state snapshot (defensive copy). */
  getTodoPanelState(): TodoPanelState {
    return {
      ...this.todoPanel,
      items: this.todoPanel.items.map((i) => ({ ...i })),
    };
  }

  /** Current tree panel state snapshot (defensive copy). */
  getTreePanelState(): TreePanelState {
    return {
      ...this.treePanel,
      nodes: this.treePanel.nodes.map((n) => ({
        ...n,
        children: [...n.children],
        ...(n.forkedFrom ? { forkedFrom: { ...n.forkedFrom } } : {}),
      })),
    };
  }

  /**
   * Flash the `levelup` mascot mood, then revert to the previous mood after
   * 3 seconds. Reentrant: calling again while a flash is active reschedules
   * the revert without losing the original previous mood.
   */
  setLevelUpMood(): void {
    if (this.moodRevertTimer) {
      clearTimeout(this.moodRevertTimer);
      this.moodRevertTimer = undefined;
    }
    if (this.mood !== "levelup") this.pickerPreviousMood = this.mood;
    this.mood = "levelup";
    this.render();
    const previous = this.pickerPreviousMood ?? "idle";
    this.moodRevertTimer = setTimeout(() => {
      this.moodRevertTimer = undefined;
      this.pickerPreviousMood = undefined;
      if (this.mood === "levelup") this.mood = previous;
      this.render();
    }, 3000);
    this.moodRevertTimer.unref();
  }

  /** Open the full-screen model picker (Alt+M). No-op when no providers set. */
  openPicker(): void {
    if (this.picker) return;
    const providers = this.options.pickerProviders ?? [];
    if (!providers.length) {
      this.setStatus("No model providers configured.");
      return;
    }
    this.picker = createPickerState({
      providers,
      ...(this.model ? { selectedModel: this.model } : {}),
      ...(this.options.pickerReasoningEffort
        ? { reasoningEffort: this.options.pickerReasoningEffort }
        : {}),
    });
    this.pickerPreviousMood = this.mood;
    this.mood = "thinking";
    this.render();
  }

  closePicker(): void {
    if (!this.picker) return;
    this.picker = undefined;
    if (this.pickerPreviousMood && this.mood === "thinking") {
      this.mood = this.pickerPreviousMood;
    }
    this.pickerPreviousMood = undefined;
    this.render();
  }

  /** Current picker state (for tests / external assertions). */
  pickerState(): PickerState | undefined {
    return this.picker;
  }

  requestApproval(question: string): Promise<boolean> {
    if (this.approvalResolve) throw new Error("Another approval is already pending");
    this.status = question + " Type y or n, then Enter.";
    this.render();
    return new Promise<boolean>((resolve) => {
      this.approvalResolve = resolve;
    });
  }

  async submitText(text: string): Promise<void> {
    const prompt = text.trim();
    if (!prompt) return;
    this.history.push(prompt);
    // Cap prompt history like the transcript; long sessions must not grow
    // unbounded user input in memory.
    this.history = this.history.slice(-100);
    this.historyIndex = this.history.length;
    if (prompt.startsWith("/") && this.options.onCommand) {
      const result = await this.options.onCommand(prompt);
      if (result) this.addMessage("system", result);
      return;
    }
    if (this.busy) {
      this.addMessage("user", "[steer] " + prompt);
      await this.options.onSteer(prompt);
      return;
    }
    this.addMessage("user", prompt);
    this.setBusy(true);
    try {
      await this.options.onSubmit(prompt);
      this.setMood("happy");
    } catch (error) {
      this.setMood("oops");
      throw error;
    } finally {
      this.setBusy(false);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.signalCleanup?.();
    this.signalCleanup = undefined;
    if (this.timer) clearInterval(this.timer);
    if (this.moodRevertTimer) {
      clearTimeout(this.moodRevertTimer);
      this.moodRevertTimer = undefined;
    }
    this.options.input.off("data", this.onData);
    this.options.output.off("resize", this.onResize);
    this.approvalResolve?.(false);
    this.approvalResolve = undefined;
    this.inputDecoder.reset();
    this.options.input.setRawMode(false);
    this.options.output.write("\u001b[?2004l\u001b[?25h\u001b[?1049l");
    this.exitResolve();
  }

  snapshot(): TuiRenderState {
    // Expire toast notifications older than the fade-out window (2500ms).
    if (this.toast && Date.now() - this.toast.startedAt > 2500) {
      delete this.toast;
    }
    return {
      width: this.options.output.columns || 80,
      height: this.options.output.rows || 24,
      title: this.options.title ?? "FocusCode",
      model: this.model,
      session: this.session,
      approval: this.approval,
      sandbox: this.options.sandbox,
      busy: this.busy,
      queued: this.queued,
      mood: this.mood,
      tick: this.tick,
      theme: this.theme,
      mascot: this.mascot,
      transcript: this.transcript.map((line) => ({
        ...line,
        ...(line.rendered ? { rendered: [...line.rendered] } : {}),
      })),
      input: this.editor.getText(),
      inputCursor: this.editor.getCursor(),
      ...(this.completion
        ? {
            completion: {
              candidates: [...this.completion.candidates],
              index: this.completion.index,
            },
          }
        : {}),
      attachments: [...this.attachments],
      ...(this.status ? { status: this.status } : {}),
      ...(this.speech ? { speech: this.speech } : {}),
      ...(this.picker ? { picker: this.picker } : {}),
      ...(this.companion ? { companion: this.companion } : {}),
      ...(this.sessionCost !== undefined ? { sessionCost: this.sessionCost } : {}),
      ...(this.sessionBudget !== undefined ? { sessionBudget: this.sessionBudget } : {}),
      ...(this.cacheMetrics ? { cacheMetrics: this.cacheMetrics } : {}),
      specProgress: this.specProgress,
      ...(this.specConfirmation ? { specConfirmation: this.specConfirmation } : {}),
      ...(this.reasoning ? { reasoning: this.reasoning } : {}),
      ...(this.reasoningExpanded !== undefined
        ? { reasoningExpanded: this.reasoningExpanded }
        : {}),
      ...(this.contextUsage ? { contextUsage: this.contextUsage } : {}),
      search: { ...this.search, matches: [...this.search.matches] },
      palette: {
        ...this.palette,
        filtered: [...this.palette.filtered],
      },
      ...(this.vimEnabled ? { vim: { ...this.vimState } } : {}),
      layout: {
        ...this.layout,
        panes: this.layout.panes.map((p) => ({ ...p })),
      },
      todoPanel: {
        ...this.todoPanel,
        items: this.todoPanel.items.map((i) => ({ ...i })),
      },
      treePanel: {
        ...this.treePanel,
        nodes: this.treePanel.nodes.map((n) => ({
          ...n,
          children: [...n.children],
          ...(n.forkedFrom ? { forkedFrom: { ...n.forkedFrom } } : {}),
        })),
      },
      activePane: this.activePane,
      paneSelection: { ...this.paneSelection },
      scrollOffset: this.scrollOffset,
      ...(this.toast
        ? {
            toast: {
              text: this.toast.text,
              startedAt: this.toast.startedAt,
              level: this.toast.level,
            },
          }
        : {}),
      ...(this.specHistoryVisible
        ? {
            specHistoryView: {
              entries: this.specHistory.map((e) => ({
                ...e,
                stages: e.stages.map((s) => ({ ...s })),
              })),
              selectedIndex: this.specHistorySelection,
            },
          }
        : {}),
    };
  }

  private readonly onResize = () => this.render();

  private readonly onData = (data: Buffer | string) => {
    const value = Buffer.isBuffer(data) ? data.toString("utf8") : data;
    // Picker mode intercepts all input. Alt+M / Esc handled here; the keymap
    // decoder would otherwise drop the leading ESC and turn `ESC m` into `m`.
    if (this.picker) {
      this.handlePickerInput(value);
      return;
    }
    if (this.specConfirmation) {
      this.handleSpecConfirmationInput(value);
      return;
    }
    if (this.specHistoryVisible) {
      this.handleSpecHistoryInput(value);
      return;
    }
    if (value.startsWith("\u001bm")) {
      this.openPicker();
      const rest = value.slice(2);
      if (rest) this.feedInput(rest);
      return;
    }
    this.feedInput(value);
  };

  private feedInput(value: string): void {
    // Palette overlay intercepts all input.
    if (this.palette.visible) {
      this.handlePaletteInput(value);
      return;
    }
    // Search bar intercepts all input.
    if (this.search.visible) {
      this.handleSearchInput(value);
      return;
    }
    // Vim normal/visual modes intercept printable keys; Esc in insert mode reverts.
    if (
      this.vimEnabled &&
      (this.vimState.mode === "normal" ||
        this.vimState.mode === "visual" ||
        this.vimState.mode === "visual-line")
    ) {
      this.handleVimModalInput(value);
      return;
    }
    if (this.vimEnabled && this.vimState.mode === "insert") {
      // Esc returns to normal mode without inserting anything.
      if (value === "\u001b") {
        this.vimState = { mode: "normal" };
        this.render();
        return;
      }
      // Other input falls through to normal insert handling below.
    }
    // Workbench NORMAL 模式：导航/预览面板聚焦时，j/k/G/Enter/q 等按键用于面板导航。
    if (this.activePane === "nav" || this.activePane === "preview") {
      if (this.handleNavModalInput(value)) return;
    }
    // tmux 前缀键：Ctrl+B 之后的下一个键解析为面板组合。
    if (this.prefixPending) {
      this.prefixPending = false;
      const keys = this.inputDecoder.push(value);
      const first = keys[0];
      if (first?.type === "action" && PREFIX_BINDINGS[first.action]) {
        void this.action(PREFIX_BINDINGS[first.action]!).catch((error: unknown) => {
          this.setStatus(error instanceof Error ? error.message : String(error));
        });
        return;
      }
      if (first?.type === "text" && first.text === "z") {
        void this.action("panel_zoom");
        return;
      }
      // 未识别的前缀组合：吞掉，不落到输入框。
      return;
    }
    for (const key of this.inputDecoder.push(value)) {
      if (key.type === "text") {
        this.cancelCompletion();
        this.editor.insertText(key.text);
        this.maybeAutoComplete();
      } else if (key.type === "action") {
        void this.action(key.action).catch((error: unknown) => {
          this.setStatus(error instanceof Error ? error.message : String(error));
          this.setMood("oops");
        });
      } else if (key.type === "mouse") {
        this.handleMouseEvent(key);
      }
    }
    this.render();
  }

  /**
   * Handle keystrokes while the command palette overlay is open.
   * Esc closes, Enter confirms, Up/Down move, Backspace trims query,
   * printable chars extend query.
   */
  private handlePaletteInput(value: string): void {
    let index = 0;
    while (index < value.length) {
      const rest = value.slice(index);
      if (rest.startsWith("\u001b") && !rest.startsWith("\u001b[")) {
        this.closePalette();
        index += 1;
        continue;
      }
      if (rest.startsWith("\r") || rest.startsWith("\n")) {
        this.confirmPaletteSelection();
        index += 1;
        continue;
      }
      if (rest.startsWith("\u001b[A")) {
        this.movePaletteCursor(-1);
        index += 3;
        continue;
      }
      if (rest.startsWith("\u001b[B")) {
        this.movePaletteCursor(1);
        index += 3;
        continue;
      }
      if (rest.startsWith("\u007f") || rest.startsWith("\b")) {
        if (this.palette.query.length > 0) {
          this.updatePaletteQuery(this.palette.query.slice(0, -1));
        }
        index += 1;
        continue;
      }
      if (rest.startsWith("\u001b[")) {
        const match = /^(\u001b\[[0-?]*[ -/]*[@-~])/.exec(rest);
        if (match) {
          index += match[1]!.length;
          continue;
        }
        index += 1;
        continue;
      }
      const point = rest.codePointAt(0);
      if (point !== undefined && point >= 32 && point !== 127) {
        const char = String.fromCodePoint(point);
        this.updatePaletteQuery(this.palette.query + char);
        index += char.length;
        continue;
      }
      index += 1;
    }
  }

  /**
   * Handle keystrokes while the search bar is open.
   * Esc closes, Enter / arrow down advance, arrow up reverses,
   * Backspace trims query, printable chars extend query.
   */
  private handleSearchInput(value: string): void {
    let index = 0;
    while (index < value.length) {
      const rest = value.slice(index);
      if (rest.startsWith("\u001b") && !rest.startsWith("\u001b[")) {
        this.closeSearch();
        index += 1;
        continue;
      }
      if (rest.startsWith("\r") || rest.startsWith("\n")) {
        this.advanceSearch(1);
        index += 1;
        continue;
      }
      if (rest.startsWith("\u001b[A")) {
        this.advanceSearch(-1);
        index += 3;
        continue;
      }
      if (rest.startsWith("\u001b[B")) {
        this.advanceSearch(1);
        index += 3;
        continue;
      }
      if (rest.startsWith("\u007f") || rest.startsWith("\b")) {
        if (this.search.query.length > 0) {
          this.updateSearchQuery(this.search.query.slice(0, -1));
        }
        index += 1;
        continue;
      }
      if (rest.startsWith("\u001b[")) {
        const match = /^(\u001b\[[0-?]*[ -/]*[@-~])/.exec(rest);
        if (match) {
          index += match[1]!.length;
          continue;
        }
        index += 1;
        continue;
      }
      const point = rest.codePointAt(0);
      if (point !== undefined && point >= 32 && point !== 127) {
        const char = String.fromCodePoint(point);
        this.updateSearchQuery(this.search.query + char);
        index += char.length;
        continue;
      }
      index += 1;
    }
  }

  /**
   * Handle printable keys in vim normal or visual mode. Each character is fed
   * to the vim state machine; the resulting action is applied to the editor.
   * Control sequences (Esc, arrows, etc.) are passed through to the keymap
   * decoder so navigation still works.
   *
   * The editor cursor is passed to `vimHandleKey` so the visual-mode anchor
   * can be seeded from the real cursor position when entering visual mode.
   * When a selection operator fires, the visual anchor (captured before the
   * call) is forwarded to the editor's selection-aware methods.
   */
  private handleVimModalInput(value: string): void {
    for (const char of value) {
      // Skip control characters and CSI introducers; let the keymap handle them.
      const cp = char.codePointAt(0);
      if (cp === undefined) continue;
      if (cp === 0x1b || cp === 0x0d || cp === 0x0a || cp === 0x7f || cp === 0x08) continue;
      if (cp < 32) continue;
      // Capture the visual anchor before the call: selection operators clear
      // it from state, so we need a local copy to forward to the editor.
      const anchor = this.vimState.visualAnchor;
      const result = vimHandleKey(this.vimState, char, this.editor.getCursor());
      this.vimState = result.state;
      this.applyVimAction(result.action, anchor, result.textObject, result.replaceChar);
    }
    // Pass the original value through the keymap decoder so arrows / Ctrl
    // bindings still fire (e.g. Esc to cancel operator is handled above by
    // vimHandleKey; arrows for cursor movement work via EditorBuffer).
    for (const key of this.inputDecoder.push(value)) {
      if (key.type === "action") {
        void this.action(key.action).catch((error: unknown) => {
          this.setStatus(error instanceof Error ? error.message : String(error));
          this.setMood("oops");
        });
      } else if (key.type === "mouse") {
        this.handleMouseEvent(key);
      }
    }
    this.render();
  }

  /**
   * Apply a vim-emitted action to the editor buffer. The optional `anchor` is
   * the visual selection anchor captured before the operator fired; it is only
   * used by selection-aware actions (delete_selection, yank_selection, etc.).
   */
  private applyVimAction(
    action: VimAction,
    anchor?: { row: number; col: number },
    textObject?: { modifier: "i" | "a"; target: string },
    replaceChar?: string,
  ): void {
    switch (action) {
      case "cursor_left":
        this.editor.cursorLeft();
        break;
      case "cursor_right":
        this.editor.cursorRight();
        break;
      case "cursor_up":
        this.editor.cursorUp();
        break;
      case "cursor_down":
        this.editor.cursorDown();
        break;
      case "word_left":
        this.editor.wordLeft();
        break;
      case "word_right":
        this.editor.wordRight();
        break;
      case "home":
        this.editor.home();
        break;
      case "end":
        this.editor.end();
        break;
      case "goto_top":
        this.editor.gotoTop();
        break;
      case "goto_bottom":
        this.editor.gotoBottom();
        break;
      case "delete_line":
        this.editor.deleteLine();
        break;
      case "yank_line":
        this.editor.yankLine();
        break;
      case "paste_after":
        this.editor.pasteAfter();
        break;
      case "delete_char":
        this.editor.deleteChar();
        break;
      case "newline_below":
        this.editor.appendNewlineBelow();
        break;
      // ─── Extended normal-mode operators ───
      case "undo":
        if (!this.editor.undo()) this.setStatus("Nothing to undo.");
        break;
      case "delete_to_end_of_line":
        this.editor.deleteToEndOfLine();
        break;
      case "delete_word":
        this.editor.deleteWordForward();
        break;
      case "toggle_case":
        this.editor.toggleCase();
        break;
      // ─── Change operators (host enters insert mode after) ───
      case "change_line":
        this.editor.changeLine();
        break;
      case "change_word":
        this.editor.changeWord();
        break;
      // ─── Visual-mode selection operators ───
      case "delete_selection":
        if (anchor) this.editor.deleteSelection(anchor);
        break;
      case "yank_selection":
        if (anchor) this.editor.yankSelection(anchor);
        break;
      case "delete_selection_lines":
        if (anchor) this.editor.deleteSelectionLines(anchor);
        break;
      case "yank_selection_lines":
        if (anchor) this.editor.yankSelectionLines(anchor);
        break;
      // ─── Text-object operators (diw, daw, ci", ca( etc.) ───
      case "delete_text_object":
        if (textObject) this.editor.deleteTextObject(textObject.modifier, textObject.target);
        break;
      case "yank_text_object":
        if (textObject) this.editor.yankTextObject(textObject.modifier, textObject.target);
        break;
      case "change_text_object":
        // Delete the text object content; host is already in insert mode (set by
        // vimHandleKey), so subsequent typing fills the cleared region.
        if (textObject) this.editor.deleteTextObject(textObject.modifier, textObject.target);
        break;
      // ─── High-frequency operations (P, O, J, e, r) ───
      case "paste_before":
        this.editor.pasteBefore();
        break;
      case "newline_above":
        this.editor.newlineAbove();
        break;
      case "join_lines":
        this.editor.joinLines();
        break;
      case "word_end_forward":
        this.editor.wordEndForward();
        break;
      case "replace_char":
        // Only replace when a replacement character was captured by the vim
        // state machine (vim r{char}); otherwise treat as a no-op.
        if (replaceChar !== undefined) this.editor.replaceChar(replaceChar);
        break;
      case "noop":
        break;
    }
  }

  /**
   * Handle keystrokes while the picker overlay is open. Keys that do not map
   * to picker actions are dropped so the editor never sees them.
   */
  private handlePickerInput(value: string): void {
    let index = 0;
    while (index < value.length) {
      const rest = value.slice(index);
      // Esc cancels the picker.
      if (rest.startsWith("\u001b") && !rest.startsWith("\u001b[")) {
        this.closePicker();
        index += 1;
        continue;
      }
      // Alt+S toggles session-only scope.
      if (rest.startsWith("\u001bs")) {
        if (this.picker) {
          this.picker = updatePicker(this.picker, { sessionOnly: !this.picker.sessionOnly });
        }
        index += 2;
        continue;
      }
      // Enter confirms.
      if (rest.startsWith("\r") || rest.startsWith("\n")) {
        this.confirmPickerSelection();
        index += 1;
        continue;
      }
      // Tab cycles provider.
      if (rest.startsWith("\t")) {
        if (this.picker) this.picker = cycleProvider(this.picker, 1);
        index += 1;
        continue;
      }
      // Backspace clears the last filter char.
      if (rest.startsWith("\u007f") || rest.startsWith("\b")) {
        if (this.picker && this.picker.query) {
          this.picker = updatePicker(this.picker, {
            query: this.picker.query.slice(0, -1),
            cursor: 0,
          });
        }
        index += 1;
        continue;
      }
      // Up / down arrows move the cursor.
      if (rest.startsWith("\u001b[A")) {
        if (this.picker) {
          this.picker = updatePicker(this.picker, {
            cursor: Math.max(0, this.picker.cursor - 1),
          });
        }
        index += 3;
        continue;
      }
      if (rest.startsWith("\u001b[B")) {
        if (this.picker) {
          const visible = pickerVisibleModels(this.picker).length;
          this.picker = updatePicker(this.picker, {
            cursor: Math.min(Math.max(0, visible - 1), this.picker.cursor + 1),
          });
        }
        index += 3;
        continue;
      }
      // Left / right arrows cycle reasoning effort.
      if (rest.startsWith("\u001b[D")) {
        if (this.picker) this.picker = cycleReasoningEffort(this.picker, -1);
        index += 3;
        continue;
      }
      if (rest.startsWith("\u001b[C")) {
        if (this.picker) this.picker = cycleReasoningEffort(this.picker, 1);
        index += 3;
        continue;
      }
      // Drop any other CSI sequence we don't recognize.
      if (rest.startsWith("\u001b[")) {
        const match = /^(\u001b\[[0-?]*[ -/]*[@-~])/.exec(rest);
        if (match) {
          index += match[1]!.length;
          continue;
        }
        index += 1;
        continue;
      }
      // Printable characters extend the filter query.
      const point = rest.codePointAt(0);
      if (point !== undefined && point >= 32 && point !== 127) {
        const char = String.fromCodePoint(point);
        if (this.picker) {
          this.picker = updatePicker(this.picker, {
            query: this.picker.query + char,
            cursor: 0,
          });
        }
        index += char.length;
        continue;
      }
      index += 1;
    }
    this.render();
  }

  /**
   * Handle keystrokes while the spec confirmation overlay is open.
   * Up/Down navigate options, Enter confirms current decision,
   * Esc declines the entire spec.
   */
  private handleSpecConfirmationInput(value: string): void {
    let index = 0;
    while (index < value.length) {
      const rest = value.slice(index);
      // Esc declines spec
      if (rest.startsWith("\u001b") && !rest.startsWith("\u001b[")) {
        this.confirmSpecNavigation("cancel");
        index += 1;
        continue;
      }
      // Arrow up
      if (rest.startsWith("\u001b[A")) {
        this.confirmSpecNavigation("option_up");
        index += 3;
        continue;
      }
      // Arrow down
      if (rest.startsWith("\u001b[B")) {
        this.confirmSpecNavigation("option_down");
        index += 3;
        continue;
      }
      // Enter confirms
      if (rest.startsWith("\r") || rest.startsWith("\n")) {
        this.confirmSpecNavigation("confirm");
        index += 1;
        continue;
      }
      index += 1;
    }
  }

  /**
   * Handle keystrokes while the spec history browser overlay is open.
   * Esc closes; Up/Down navigate; other keys are dropped.
   */
  private handleSpecHistoryInput(value: string): void {
    let index = 0;
    while (index < value.length) {
      const rest = value.slice(index);
      // Esc closes history view
      if (rest.startsWith("\u001b") && !rest.startsWith("\u001b[")) {
        this.closeSpecHistory();
        index += 1;
        continue;
      }
      // Arrow up / k — previous entry
      if (rest.startsWith("\u001b[A") || rest === "k") {
        this.navigateSpecHistory(-1);
        index += rest.startsWith("\u001b[A") ? 3 : 1;
        continue;
      }
      // Arrow down / j — next entry
      if (rest.startsWith("\u001b[B") || rest === "j") {
        this.navigateSpecHistory(1);
        index += rest.startsWith("\u001b[B") ? 3 : 1;
        continue;
      }
      // Drop other CSI sequences safely
      if (rest.startsWith("\u001b[")) {
        const match = /^(\u001b\[[0-?]*[ -/]*[@-~])/.exec(rest);
        if (match) {
          index += match[1]!.length;
          continue;
        }
      }
      index += 1;
    }
  }

  private confirmPickerSelection(): void {
    if (!this.picker) return;
    const result = confirmPicker(this.picker);
    if (!result) {
      this.setStatus("No model selected.");
      return;
    }
    this.model = result.model;
    this.options.pickerReasoningEffort = result.reasoningEffort;
    this.picker = undefined;
    if (this.pickerPreviousMood) {
      this.mood = this.pickerPreviousMood;
      this.pickerPreviousMood = undefined;
    }
    this.setStatus(
      "Model: " +
        result.model +
        " · reasoning " +
        result.reasoningEffort +
        (result.sessionOnly ? " · session-only" : ""),
    );
    try {
      this.options.onPickModel?.(result);
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  /** 命令浮层：输入以 / 开头时自动弹出命令补全（yazi 输入即过滤的节奏）。 */
  private maybeAutoComplete(): void {
    const text = this.editor.getText();
    if (text.trimStart().startsWith("/") && !this.completion && !this.palette.visible) {
      this.triggerCompletion();
    } else if (!text.trimStart().startsWith("/")) {
      this.cancelCompletion();
    }
  }

  /**
   * Workbench NORMAL 模式（yazi 列表导航）：导航/预览面板聚焦时的按键处理。
   * nav: j/k/G 移动 todo 选择，Enter 切换选中项状态；preview: 只读。
   * 两个面板共用 q/Esc 返回输入。返回 true 表示已消费（不落入输入框）。
   */
  private handleNavModalInput(value: string): boolean {
    if (value === "\u001b") {
      this.panelFocus("input");
      return true;
    }
    const inNav = this.activePane === "nav";
    for (const key of this.inputDecoder.push(value)) {
      if (key.type === "action") {
        switch (key.action) {
          case "submit":
            if (inNav) this.performSidebarAction();
            break;
          case "history_previous":
            if (inNav) this.moveSidebarSelection(-1);
            break;
          case "history_next":
            if (inNav) this.moveSidebarSelection(1);
            break;
          case "home":
            if (inNav) this.moveSidebarSelection(-Number.MAX_SAFE_INTEGER);
            break;
          case "end":
            if (inNav) this.moveSidebarSelection(Number.MAX_SAFE_INTEGER);
            break;
          default:
            break; // 其他 action 在 NORMAL 模式下吞掉
        }
      } else if (key.type === "text") {
        const char = key.text;
        if (inNav) {
          if (char === "j") this.moveSidebarSelection(1);
          else if (char === "k") this.moveSidebarSelection(-1);
          else if (char === "G") this.moveSidebarSelection(Number.MAX_SAFE_INTEGER);
        }
        if (char === "q") this.panelFocus("input");
      } else if (key.type === "mouse") {
        this.handleMouseEvent(key);
      }
    }
    return true;
  }

  /** 在输入与 workbench 面板（导航/预览）之间切换焦点。 */
  panelFocus(pane: "input" | "nav" | "preview"): void {
    this.activePane = pane;
    this.render();
  }

  /** tmux Ctrl+B z：缩放对话流（隐藏导航/预览栏），再按还原。 */
  toggleZoom(): void {
    this.layout = { ...this.layout, zoom: !this.layout.zoom };
    this.render();
  }

  /**
   * Handle a parsed mouse event from the terminal. Currently a no-op
   * placeholder: the TUI logs the event for debugging but does not yet
   * map mouse actions to UI commands. Future work will route scroll
   * events to transcript scrolling and click events to pane focus.
   */
  private handleMouseEvent(key: {
    type: "mouse";
    event: "press" | "release" | "drag" | "scroll";
    button: "left" | "middle" | "right";
    column: number;
    row: number;
    direction?: "up" | "down";
  }): void {
    // Placeholder: mouse events are parsed but not yet acted upon.
    // This prevents the TUI from crashing on unrecognized input.
    void key;
  }

  private async action(action: TuiAction): Promise<void> {
    if (action === "exit") {
      if (this.busy) this.options.onAbort();
      else this.dispose();
      return;
    }
    if (action === "abort") {
      if (this.busy) this.options.onAbort();
      else this.setStatus("No active turn. Ctrl+D exits.");
      return;
    }
    if (action === "complete") {
      this.triggerCompletion();
      return;
    }
    if (action === "submit") {
      if (this.completion) {
        this.confirmCompletion();
        return;
      }
      const text = this.editor.getText().trim();
      if (!text) return;
      this.editor.clear();
      if (this.approvalResolve) {
        const resolveApproval = this.approvalResolve;
        this.approvalResolve = undefined;
        const allowed = ["y", "yes"].includes(text.toLowerCase());
        this.status = allowed ? "Approved once." : "Denied.";
        resolveApproval(allowed);
        this.render();
        return;
      }
      await this.submitText(text);
      return;
    }
    if (action === "newline") {
      this.cancelCompletion();
      this.editor.newline();
    } else if (action === "backspace") {
      this.cancelCompletion();
      this.editor.backspace();
    } else if (action === "delete_word") {
      this.cancelCompletion();
      this.editor.deleteWordBackward();
    } else if (action === "delete_char_forward") {
      this.cancelCompletion();
      this.editor.deleteCharForward();
    } else if (action === "kill_word_forward") {
      this.cancelCompletion();
      this.editor.deleteWordForward();
    } else if (action === "kill_to_start") {
      this.cancelCompletion();
      this.editor.killToStart();
    } else if (action === "undo") {
      this.cancelCompletion();
      if (!this.editor.undo()) this.setStatus("Nothing to undo.");
    } else if (action === "kill_line") {
      this.cancelCompletion();
      this.editor.killLine();
    } else if (action === "yank") {
      this.cancelCompletion();
      this.editor.yank();
    } else if (action === "upcase_word") {
      this.cancelCompletion();
      this.editor.upcaseWord();
    } else if (action === "downcase_word") {
      this.cancelCompletion();
      this.editor.downcaseWord();
    } else if (action === "capitalize_word") {
      this.cancelCompletion();
      this.editor.capitalizeWord();
    } else if (action === "cursor_left") {
      this.cancelCompletion();
      this.editor.cursorLeft();
    } else if (action === "cursor_right") {
      this.cancelCompletion();
      this.editor.cursorRight();
    } else if (action === "home") {
      this.cancelCompletion();
      this.editor.home();
    } else if (action === "end") {
      this.cancelCompletion();
      this.editor.end();
    } else if (action === "word_left") {
      this.cancelCompletion();
      this.editor.wordLeft();
    } else if (action === "word_right") {
      this.cancelCompletion();
      this.editor.wordRight();
    } else if (action === "history_previous") {
      this.cancelCompletion();
      if (this.activePane !== "input") {
        this.moveSidebarSelection(-1);
      } else {
        this.recall(-1);
      }
    } else if (action === "history_next") {
      this.cancelCompletion();
      if (this.activePane !== "input") {
        this.moveSidebarSelection(1);
      } else {
        this.recall(1);
      }
    } else if (action === "scroll_up") {
      this.scrollOffset += 5;
    } else if (action === "scroll_down") {
      this.scrollOffset = Math.max(0, this.scrollOffset - 5);
    } else if (action === "clear") {
      this.transcript = [];
    } else if (action === "cycle_theme") {
      this.theme = this.nextTheme();
      this.setStatus("Theme: " + this.theme.name);
    } else if (action === "cycle_mascot") {
      this.mascot = TUI_MASCOTS[(TUI_MASCOTS.indexOf(this.mascot) + 1) % TUI_MASCOTS.length]!;
      this.setStatus(
        this.mascot.name + " · " + this.mascot.species + " · " + this.mascot.catchphrase,
      );
    } else if (action === "toggle_reasoning") {
      this.reasoningExpanded = !this.reasoningExpanded;
    } else if (action === "toggle_vim") {
      this.setVimEnabled(!this.vimEnabled);
      this.setStatus(this.vimEnabled ? "Vim mode on" : "Vim mode off");
    } else if (action === "open_palette") {
      this.openPalette();
    } else if (action === "search_transcript") {
      this.openSearch();
    } else if (action === "cycle_layout") {
      this.cycleLayoutMode();
      this.setStatus("Layout: " + this.layout.mode);
    } else if (action === "prefix") {
      this.prefixPending = true;
    } else if (action === "panel_focus_left") {
      this.panelFocus("nav");
      this.setStatus("Nav panel (NORMAL: j/k navigate, q back)");
    } else if (action === "panel_focus_right") {
      this.panelFocus("preview");
      this.setStatus("Preview panel (q or Esc back to input)");
    } else if (action === "panel_zoom") {
      this.toggleZoom();
      this.setStatus(
        this.layout.zoom ? "Zoomed: transcript only (Ctrl+B z to restore)" : "Workbench restored",
      );
    } else if (action === "toggle_help") {
      this.setStatus(
        "Ctrl+B 前缀: ←/→ 面板 · z 缩放 | NORMAL: j/k/G 导航 · Enter 切换 · q 返回 | Ctrl+P 面板 · Ctrl+F 搜索 · Tab 补全",
      );
    } else if (action === "toggle_todo_panel") {
      this.toggleTodoPanel();
      this.setStatus(this.todoPanel.visible ? "Todo panel on" : "Todo panel off");
    } else if (action === "toggle_tree_panel") {
      this.toggleTreePanel();
      this.setStatus(this.treePanel.visible ? "Session tree on" : "Session tree off");
    } else if (action === "cycle_sidebar_focus") {
      this.cycleSidebarFocus();
      if (this.activePane !== "input") {
        this.setStatus("Focus: " + this.activePane + " pane (Alt+] cycles, Alt+Enter acts)");
      } else {
        this.setStatus("Focus: input");
      }
    } else if (action === "sidebar_action") {
      this.performSidebarAction();
    } else if (action === "spec_option_up") {
      this.confirmSpecNavigation("option_up");
    } else if (action === "spec_option_down") {
      this.confirmSpecNavigation("option_down");
    } else if (action === "spec_confirm") {
      this.confirmSpecNavigation("confirm");
    } else if (action === "spec_cancel") {
      this.confirmSpecNavigation("cancel");
    } else if (action === "spec_history_toggle") {
      this.toggleSpecHistory();
    } else if (action === "spec_history_up") {
      this.navigateSpecHistory(-1);
    } else if (action === "spec_history_down") {
      this.navigateSpecHistory(1);
    } else if (action === "spec_history_close") {
      this.closeSpecHistory();
    }
  }

  private triggerCompletion(): void {
    if (this.completion) {
      this.completion = {
        candidates: this.completion.candidates,
        index: (this.completion.index + 1) % this.completion.candidates.length,
      };
      return;
    }
    const providers = this.options.completionProviders ?? [];
    if (!providers.length) {
      this.setStatus("No completion providers configured.");
      return;
    }
    const candidates = collectCompletions(
      providers,
      this.editor.wordBeforeCursor(),
      this.editor.getText(),
    );
    if (!candidates.length) {
      this.setStatus("No completions.");
      return;
    }
    this.completion = { candidates, index: 0 };
  }

  private confirmCompletion(): void {
    const completion = this.completion;
    this.completion = undefined;
    const candidate = completion?.candidates[completion.index];
    if (!candidate) return;
    this.editor.applyCompletion(this.editor.wordBeforeCursor(), candidate.value);
  }

  private cancelCompletion(): void {
    this.completion = undefined;
  }

  private recall(delta: number): void {
    if (!this.history.length) return;
    this.historyIndex = Math.max(0, Math.min(this.history.length, this.historyIndex + delta));
    this.editor.setText(this.history[this.historyIndex] ?? "");
  }

  private render(): void {
    if (this.disposed) return;
    const snapshot = this.snapshot();
    const frame = renderTui(snapshot).split("\n");
    const dimensions = `${snapshot.width}x${snapshot.height}`;
    if (this.lastFrame.length === 0 || dimensions !== this.lastDimensions) {
      this.options.output.write("\u001b[H" + frame.join("\n") + "\u001b[J");
    } else {
      let patch = "";
      const rows = Math.max(frame.length, this.lastFrame.length);
      for (let row = 0; row < rows; row += 1) {
        if (frame[row] === this.lastFrame[row]) continue;
        patch += `\u001b[${row + 1};1H\u001b[2K${frame[row] ?? ""}`;
      }
      if (patch) this.options.output.write(patch);
    }
    this.lastFrame = frame;
    this.lastDimensions = dimensions;
  }
}

/**
 * Count all nodes in a session tree (roots + all descendants).
 * Used by paneItemCount to compute the keyboard-navigation range for the
 * tree sidebar pane.
 */
function countTreeNodes(nodes: SessionTreeNode[]): number {
  let count = 0;
  for (const node of nodes) {
    count += 1;
    count += countTreeNodes(node.children);
  }
  return count;
}
