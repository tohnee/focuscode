import { fg, type TuiTheme } from "./themes.js";

/**
 * Vim modes supported by the TUI input editor.
 *
 * - `normal` — modal command mode (default).
 * - `insert` — text is inserted verbatim.
 * - `visual` — character-wise selection; the cursor extends one end of the
 *   selection while `visualAnchor` pins the other.
 * - `visual-line` — whole-line selection; the anchor and cursor rows bound the
 *   selected line range.
 */
export type VimMode = "normal" | "insert" | "visual" | "visual-line";

/**
 * Editor cursor position recorded by the host (the host owns the canonical
 * cursor in `EditorBuffer`). VimState keeps its own copy only for the visual
 * anchor so the state machine can reason about selection bounds without
 * reaching into the editor.
 */
export interface VimCursor {
  row: number;
  col: number;
}

export interface VimState {
  mode: VimMode;
  /** Pending operator awaiting a motion/operand (e.g. "d" waiting for "d" or "w"). */
  pendingOperator?: "d" | "y" | "g" | "c" | "r";
  /**
   * Pending text-object modifier ("i" or "a") set after the operator receives
   * an `i`/`a` key. The next key is the text-object target (w, ", ', (, etc.).
   */
  pendingTextObject?: "i" | "a";
  /**
   * Anchor (start) of the current visual selection. Set when entering visual
   * or visual-line mode and cleared when returning to normal. The host must
   * populate this from `EditorBuffer.getCursor()` because vimHandleKey itself
   * does not have access to the editor.
   */
  visualAnchor?: VimCursor;
}

/**
 * Actions the vim state machine can request the host (app.ts) to perform.
 * The host maps these to EditorBuffer calls.
 */
export type VimAction =
  | "cursor_left"
  | "cursor_right"
  | "cursor_up"
  | "cursor_down"
  | "word_left"
  | "word_right"
  | "home"
  | "end"
  | "goto_top"
  | "goto_bottom"
  | "delete_line"
  | "yank_line"
  | "paste_after"
  | "delete_char"
  | "newline_below"
  // ─── Visual-mode selection operators ───
  /** Delete the character-wise selection between anchor and cursor. */
  | "delete_selection"
  /** Yank the character-wise selection between anchor and cursor. */
  | "yank_selection"
  /** Delete all lines spanned by the visual-line selection. */
  | "delete_selection_lines"
  /** Yank all lines spanned by the visual-line selection. */
  | "yank_selection_lines"
  // ─── New normal-mode operators ───
  | "undo"
  /** Delete from cursor to end of line (vim D). */
  | "delete_to_end_of_line"
  /** Delete one word forward from cursor (vim dw). */
  | "delete_word"
  /** Toggle the case of the grapheme under the cursor and advance (vim ~). */
  | "toggle_case"
  /** Change the current line (vim cc). Host enters insert mode after. */
  | "change_line"
  /** Change one word forward from cursor (vim cw). Host enters insert mode after. */
  | "change_word"
  // ─── Text-object operators (diw, daw, ci", ca( etc.) ───
  /** Delete a text object; the `textObject` field carries modifier + target. */
  | "delete_text_object"
  /** Change a text object; host enters insert mode after. */
  | "change_text_object"
  /** Yank a text object. */
  | "yank_text_object"
  // ─── High-frequency operations ───
  /** Paste before cursor (vim P). */
  | "paste_before"
  /** Open newline above and enter insert (vim O). */
  | "newline_above"
  /** Join current line with next (vim J). */
  | "join_lines"
  /** Move forward to end of word (vim e). */
  | "word_end_forward"
  /** Replace single character under cursor (vim r{char}). */
  | "replace_char"
  | "noop";

/** Text-object descriptor passed alongside text-object actions. */
export interface VimTextObject {
  /** "i" = inner (content only), "a" = around (include delimiters/whitespace). */
  modifier: "i" | "a";
  /** Target: "w" (word), '"', "'", "`", "(", "{", "[" (always opening delimiter). */
  target: string;
}

export interface VimHandleKeyResult {
  state: VimState;
  action: VimAction;
  /** Present only for text-object actions; carries the modifier and target. */
  textObject?: VimTextObject;
  /** Present only for replace_char; the character to replace with. */
  replaceChar?: string;
}

export function createVimState(): VimState {
  return { mode: "normal" };
}

/**
 * Handle a single key in normal, visual, or visual-line mode. Returns the new
 * state and an action for the host to execute. This function must NOT be
 * called in insert mode — insert-mode characters are handled by the host's
 * normal input path.
 *
 * The optional `cursor` argument is the editor's current cursor position; it is
 * used to seed `visualAnchor` when entering visual mode. When omitted, the
 * anchor defaults to `{ row: 0, col: 0 }` (sufficient for unit tests that do
 * not exercise selection bounds).
 *
 * Supported keys (normal mode):
 *   h j k l  — cursor movement
 *   w b      — word forward/back
 *   0 $      — line start/end
 *   gg G     — buffer top/bottom
 *   dd       — delete line
 *   yy       — yank line
 *   dw       — delete word
 *   cc       — change line (delete content, enter insert)
 *   cw       — change word (delete word, enter insert)
 *   D        — delete to end of line
 *   C        — change to end of line (delete + insert)
 *   A        — append at end of line (enter insert)
 *   I        — insert at start of line (enter insert)
 *   p        — paste after
 *   x        — delete char under cursor
 *   i a o    — enter insert mode (before/after cursor / newline below)
 *   O        — enter insert mode, newline above
 *   P        — paste before cursor
 *   J        — join current line with next
 *   e        — forward to end of word
 *   r{char}  — replace char under cursor
 *   u        — undo
 *   ~        — toggle case of char under cursor
 *   v V      — enter visual / visual-line mode
 *   Esc      — cancel pending operator
 *
 * Visual mode keys:
 *   h j k l w e b 0 $ gg G — move cursor (extends selection)
 *   d x      — delete selection (char) / lines (line)
 *   y        — yank selection (char) / lines (line)
 *   Esc      — cancel selection
 */
export function vimHandleKey(
  state: VimState,
  key: string,
  cursor: VimCursor = { row: 0, col: 0 },
): VimHandleKeyResult {
  // Esc always cancels: pending operator, visual selection, or back to normal.
  if (key === "\u001b") {
    return { state: { mode: "normal" }, action: "noop" };
  }

  // ─── Visual modes ──────────────────────────────────────────────────────
  if (state.mode === "visual" || state.mode === "visual-line") {
    return handleVisualKey(state, key);
  }

  // ─── Pending text-object target (operator + i/a already pressed) ───────
  // The next key must be a valid text-object target (w, ", ', `, (, ), {, }, [, ]).
  // If it is, emit the appropriate operator action with the textObject descriptor.
  // If not, cancel the pending state and reprocess the key fresh.
  if (state.pendingTextObject && state.pendingOperator) {
    const target = normalizeTextObjectTarget(key);
    if (target !== null) {
      const op = state.pendingOperator;
      const action: VimAction =
        op === "d" ? "delete_text_object" : op === "c" ? "change_text_object" : "yank_text_object";
      const mode: VimMode = op === "c" ? "insert" : "normal";
      return {
        state: { mode },
        action,
        textObject: { modifier: state.pendingTextObject, target },
      };
    }
    // Invalid target → cancel everything and process the key from scratch.
    return vimHandleKey({ mode: "normal" }, key, cursor);
  }

  // ─── Pending operator (normal mode) ────────────────────────────────────
  if (state.pendingOperator === "d") {
    if (key === "d") return { state: { mode: "normal" }, action: "delete_line" };
    if (key === "w") return { state: { mode: "normal" }, action: "delete_word" };
    if (key === "i" || key === "a") {
      return {
        state: { mode: "normal", pendingOperator: "d", pendingTextObject: key },
        action: "noop",
      };
    }
    // Any other key cancels the operator and is processed fresh.
    return vimHandleKey({ mode: "normal" }, key, cursor);
  }
  if (state.pendingOperator === "y") {
    if (key === "y") return { state: { mode: "normal" }, action: "yank_line" };
    if (key === "i" || key === "a") {
      return {
        state: { mode: "normal", pendingOperator: "y", pendingTextObject: key },
        action: "noop",
      };
    }
    return vimHandleKey({ mode: "normal" }, key, cursor);
  }
  if (state.pendingOperator === "g") {
    if (key === "g") return { state: { mode: "normal" }, action: "goto_top" };
    return vimHandleKey({ mode: "normal" }, key, cursor);
  }
  if (state.pendingOperator === "c") {
    if (key === "c") return { state: { mode: "insert" }, action: "change_line" };
    if (key === "w") return { state: { mode: "insert" }, action: "change_word" };
    if (key === "i" || key === "a") {
      return {
        state: { mode: "normal", pendingOperator: "c", pendingTextObject: key },
        action: "noop",
      };
    }
    return vimHandleKey({ mode: "normal" }, key, cursor);
  }
  if (state.pendingOperator === "r") {
    // Any printable character replaces the char under cursor; Esc cancels.
    if (key === "\u001b") return { state: { mode: "normal" }, action: "noop" };
    if (key.length === 1) {
      return { state: { mode: "normal" }, action: "replace_char", replaceChar: key };
    }
    return vimHandleKey({ mode: "normal" }, key, cursor);
  }

  // ─── Single-key normal-mode commands ───────────────────────────────────
  switch (key) {
    case "h":
      return { state, action: "cursor_left" };
    case "j":
      return { state, action: "cursor_down" };
    case "k":
      return { state, action: "cursor_up" };
    case "l":
      return { state, action: "cursor_right" };
    case "w":
      return { state, action: "word_right" };
    case "b":
      return { state, action: "word_left" };
    case "0":
      return { state, action: "home" };
    case "$":
      return { state, action: "end" };
    case "G":
      return { state, action: "goto_bottom" };
    case "p":
      return { state, action: "paste_after" };
    case "x":
      return { state, action: "delete_char" };
    case "u":
      return { state, action: "undo" };
    case "~":
      return { state, action: "toggle_case" };
    case "D":
      return { state, action: "delete_to_end_of_line" };
    case "C":
      return { state: { mode: "insert" }, action: "delete_to_end_of_line" };
    case "A":
      return { state: { mode: "insert" }, action: "end" };
    case "I":
      return { state: { mode: "insert" }, action: "home" };
    case "i":
      return { state: { mode: "insert" }, action: "noop" };
    case "a":
      return { state: { mode: "insert" }, action: "cursor_right" };
    case "o":
      return { state: { mode: "insert" }, action: "newline_below" };
    case "O":
      return { state: { mode: "insert" }, action: "newline_above" };
    case "P":
      return { state, action: "paste_before" };
    case "J":
      return { state, action: "join_lines" };
    case "e":
      return { state, action: "word_end_forward" };
    case "r":
      return { state: { mode: "normal", pendingOperator: "r" }, action: "noop" };
    case "d":
      return { state: { mode: "normal", pendingOperator: "d" }, action: "noop" };
    case "y":
      return { state: { mode: "normal", pendingOperator: "y" }, action: "noop" };
    case "c":
      return { state: { mode: "normal", pendingOperator: "c" }, action: "noop" };
    case "g":
      return { state: { mode: "normal", pendingOperator: "g" }, action: "noop" };
    case "v":
      return {
        state: { mode: "visual", visualAnchor: { ...cursor } },
        action: "noop",
      };
    case "V":
      return {
        state: { mode: "visual-line", visualAnchor: { ...cursor } },
        action: "noop",
      };
    default:
      return { state, action: "noop" };
  }
}

/**
 * Handle a key while in visual or visual-line mode. Navigation keys move the
 * editor cursor (extending the selection); operators consume the selection
 * and return to normal mode.
 */
function handleVisualKey(state: VimState, key: string): VimHandleKeyResult {
  const preserveMode: VimMode = state.mode;
  const anchor = state.visualAnchor;
  // Helper: build a visual state that preserves the anchor only when defined.
  // Required because exactOptionalPropertyTypes forbids `undefined` assignments.
  const visualState = (extra?: { pendingOperator?: "g" }): VimState => {
    const base: VimState = { mode: preserveMode };
    if (anchor) base.visualAnchor = anchor;
    if (extra?.pendingOperator) base.pendingOperator = extra.pendingOperator;
    return base;
  };

  // Operators: consume selection and return to normal mode.
  if (key === "d" || key === "x") {
    if (preserveMode === "visual-line") {
      return { state: { mode: "normal" }, action: "delete_selection_lines" };
    }
    return { state: { mode: "normal" }, action: "delete_selection" };
  }
  if (key === "y") {
    if (preserveMode === "visual-line") {
      return { state: { mode: "normal" }, action: "yank_selection_lines" };
    }
    return { state: { mode: "normal" }, action: "yank_selection" };
  }

  // Navigation: emit the motion action and stay in visual mode, preserving
  // the anchor. The host applies the motion to the editor cursor.
  const motion = visualMotion(key);
  if (motion !== "noop") {
    return {
      state: visualState(),
      action: motion,
    };
  }

  // Pending "g" inside visual mode (for "gg"). Check the completed sequence
  // before arming a new pending operator so the second "g" resolves correctly.
  if (state.pendingOperator === "g" && key === "g") {
    return {
      state: visualState(),
      action: "goto_top",
    };
  }
  if (key === "g") {
    return {
      state: visualState({ pendingOperator: "g" }),
      action: "noop",
    };
  }

  // Unknown key in visual mode: ignore (do NOT cancel selection, matching vim).
  return { state, action: "noop" };
}

/** Map a navigation key to its motion action; returns "noop" for non-motions. */
function visualMotion(key: string): VimAction {
  switch (key) {
    case "h":
      return "cursor_left";
    case "j":
      return "cursor_down";
    case "k":
      return "cursor_up";
    case "l":
      return "cursor_right";
    case "w":
      return "word_right";
    case "e":
      return "word_end_forward";
    case "b":
      return "word_left";
    case "0":
      return "home";
    case "$":
      return "end";
    case "G":
      return "goto_bottom";
    default:
      return "noop";
  }
}

/**
 * Normalize a text-object target key. Returns the canonical opening
 * delimiter for paired delimiters (e.g. `)` → `(`), or `null` if the key
 * is not a valid text-object target.
 *
 * Supported targets:
 *   w  — word
 *   " ' ` — quote-delimited strings
 *   ( ) { } [ ] — bracket-delimited blocks (normalized to opening)
 */
function normalizeTextObjectTarget(key: string): string | null {
  switch (key) {
    case "w":
    case '"':
    case "'":
    case "`":
    case "(":
      return key;
    case ")":
      return "(";
    case "{":
      return key;
    case "}":
      return "{";
    case "[":
      return key;
    case "]":
      return "[";
    default:
      return null;
  }
}

/**
 * Render a mode indicator string for the footer, e.g. "-- NORMAL --".
 */
export function renderVimIndicator(state: VimState, theme: TuiTheme): string {
  const label =
    state.mode === "insert"
      ? "-- INSERT --"
      : state.mode === "visual"
        ? "-- VISUAL --"
        : state.mode === "visual-line"
          ? "-- VISUAL LINE --"
          : "-- NORMAL --";
  return fg(theme.accent, label);
}
