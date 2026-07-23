import { fg, type TuiTheme } from "./themes.js";

export type VimMode = "normal" | "insert";

export interface VimState {
  mode: VimMode;
  /** Pending operator awaiting a motion/operand (e.g. "d" waiting for second "d"). */
  pendingOperator?: "d" | "y" | "g";
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
  | "noop";

export interface VimHandleKeyResult {
  state: VimState;
  action: VimAction;
}

export function createVimState(): VimState {
  return { mode: "normal" };
}

/**
 * Handle a single key in normal mode. Returns the new state and an action
 * for the host to execute. This function must NOT be called in insert mode —
 * insert-mode characters are handled by the host's normal input path.
 *
 * Supported keys:
 *   h j k l  — cursor movement
 *   w b      — word forward/back
 *   0 $      — line start/end
 *   gg G     — buffer top/bottom
 *   dd       — delete line
 *   yy       — yank line
 *   p        — paste after
 *   x        — delete char under cursor
 *   i a o    — enter insert mode (before/after cursor / newline below)
 *   Esc      — cancel pending operator
 */
export function vimHandleKey(state: VimState, key: string): VimHandleKeyResult {
  // Esc always cancels pending operator (and stays in normal mode).
  if (key === "\u001b") {
    return { state: { mode: "normal" }, action: "noop" };
  }

  // If we have a pending operator, consume the next key to complete it.
  if (state.pendingOperator === "d") {
    if (key === "d") return { state: { mode: "normal" }, action: "delete_line" };
    // Any other key cancels the operator and is processed fresh.
    return vimHandleKey({ mode: "normal" }, key);
  }
  if (state.pendingOperator === "y") {
    if (key === "y") return { state: { mode: "normal" }, action: "yank_line" };
    return vimHandleKey({ mode: "normal" }, key);
  }
  if (state.pendingOperator === "g") {
    if (key === "g") return { state: { mode: "normal" }, action: "goto_top" };
    return vimHandleKey({ mode: "normal" }, key);
  }

  // Single-key normal-mode commands.
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
    case "i":
      return { state: { mode: "insert" }, action: "noop" };
    case "a":
      return { state: { mode: "insert" }, action: "cursor_right" };
    case "o":
      return { state: { mode: "insert" }, action: "newline_below" };
    case "d":
      return { state: { mode: "normal", pendingOperator: "d" }, action: "noop" };
    case "y":
      return { state: { mode: "normal", pendingOperator: "y" }, action: "noop" };
    case "g":
      return { state: { mode: "normal", pendingOperator: "g" }, action: "noop" };
    default:
      return { state, action: "noop" };
  }
}

/**
 * Render a mode indicator string for the footer, e.g. "-- NORMAL --".
 */
export function renderVimIndicator(state: VimState, theme: TuiTheme): string {
  const label = state.mode === "insert" ? "-- INSERT --" : "-- NORMAL --";
  return fg(theme.accent, label);
}
