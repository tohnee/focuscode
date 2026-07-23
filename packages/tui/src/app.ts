import type { ReadStream, WriteStream } from "node:tty";
import { collectCompletions, type CompletionProvider, type CompletionState } from "./completion.js";
import type { CompanionState } from "./companion.js";
import { EditorBuffer } from "./editor.js";
import { DEFAULT_KEYMAP, TerminalInputDecoder, type TuiAction, type TuiKeymap } from "./keymap.js";
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
import { getTheme, TUI_THEMES, type TuiTheme } from "./themes.js";
import type { ContextUsageState } from "./context-bar.js";

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
  private specProgress: SpecProgressState = createInitialSpecProgress();
  private specConfirmation: SpecConfirmationState | undefined;
  private reasoning: string | undefined;
  private reasoningExpanded: boolean | undefined;
  private contextUsage: ContextUsageState | undefined;

  constructor(private readonly options: FullScreenTuiOptions) {
    this.theme = getTheme(options.theme);
    this.mascot = getMascot(options.mascot);
    this.model = options.model;
    this.session = options.session;
    this.approval = options.approval;
    this.keymap = options.keymap ?? DEFAULT_KEYMAP;
    this.inputDecoder = new TerminalInputDecoder(this.keymap);
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

  setAttachments(names: string[]): void {
    this.attachments = [...names];
    this.render();
  }

  setModel(model: string): void {
    this.model = model;
    this.render();
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

  /** Update SpecEngine progress state. */
  setSpecProgress(state: SpecProgressState): void {
    this.specProgress = { ...state, stages: [...state.stages] };
    this.render();
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

  /** Set spec draft preview (topic + understanding). */
  setSpecDraft(draft: { specId?: string; topic?: string }): void {
    this.specProgress = {
      ...this.specProgress,
      ...(draft.specId !== undefined ? { specId: draft.specId } : {}),
      ...(draft.topic !== undefined ? { topic: draft.topic } : {}),
    };
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
    this.reasoning = (this.reasoning ?? "") + delta;
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
      specProgress: this.specProgress,
      ...(this.specConfirmation ? { specConfirmation: this.specConfirmation } : {}),
      ...(this.reasoning ? { reasoning: this.reasoning } : {}),
      ...(this.reasoningExpanded !== undefined
        ? { reasoningExpanded: this.reasoningExpanded }
        : {}),
      ...(this.contextUsage ? { contextUsage: this.contextUsage } : {}),
      scrollOffset: this.scrollOffset,
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
    if (value.startsWith("\u001bm")) {
      this.openPicker();
      const rest = value.slice(2);
      if (rest) this.feedInput(rest);
      return;
    }
    this.feedInput(value);
  };

  private feedInput(value: string): void {
    for (const key of this.inputDecoder.push(value)) {
      if (key.type === "text") {
        this.cancelCompletion();
        this.editor.insertText(key.text);
      } else {
        void this.action(key.action).catch((error: unknown) => {
          this.setStatus(error instanceof Error ? error.message : String(error));
          this.setMood("oops");
        });
      }
    }
    this.render();
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
      this.editor.deleteWord();
    } else if (action === "undo") {
      this.cancelCompletion();
      if (!this.editor.undo()) this.setStatus("Nothing to undo.");
    } else if (action === "kill_line") {
      this.cancelCompletion();
      this.editor.killLine();
    } else if (action === "yank") {
      this.cancelCompletion();
      this.editor.yank();
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
      this.recall(-1);
    } else if (action === "history_next") {
      this.cancelCompletion();
      this.recall(1);
    } else if (action === "scroll_up") {
      this.scrollOffset += 5;
    } else if (action === "scroll_down") {
      this.scrollOffset = Math.max(0, this.scrollOffset - 5);
    } else if (action === "clear") {
      this.transcript = [];
    } else if (action === "cycle_theme") {
      this.theme = TUI_THEMES[(TUI_THEMES.indexOf(this.theme) + 1) % TUI_THEMES.length]!;
      this.setStatus("Theme: " + this.theme.name);
    } else if (action === "cycle_mascot") {
      this.mascot = TUI_MASCOTS[(TUI_MASCOTS.indexOf(this.mascot) + 1) % TUI_MASCOTS.length]!;
      this.setStatus(
        this.mascot.name + " · " + this.mascot.species + " · " + this.mascot.catchphrase,
      );
    } else if (action === "toggle_reasoning") {
      this.reasoningExpanded = !this.reasoningExpanded;
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
