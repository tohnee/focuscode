export type TuiAction =
  | "submit"
  | "newline"
  | "abort"
  | "exit"
  | "clear"
  | "backspace"
  | "delete_word"
  | "delete_char_forward"
  | "kill_word_forward"
  | "kill_to_start"
  | "cursor_left"
  | "cursor_right"
  | "home"
  | "end"
  | "word_left"
  | "word_right"
  | "undo"
  | "kill_line"
  | "yank"
  | "complete"
  | "history_previous"
  | "history_next"
  | "scroll_up"
  | "scroll_down"
  | "cycle_theme"
  | "cycle_mascot"
  | "toggle_reasoning"
  | "toggle_vim"
  | "open_palette"
  | "search_transcript"
  | "cycle_layout"
  | "toggle_todo_panel"
  | "cycle_sidebar_focus"
  | "sidebar_action"
  | "upcase_word"
  | "downcase_word"
  | "capitalize_word"
  // ─── Spec decision keys (active during specConfirmation overlay) ───
  | "spec_option_up"
  | "spec_option_down"
  | "spec_confirm"
  | "spec_cancel"
  // ─── Spec history browser keys ───
  | "spec_history_up"
  | "spec_history_down"
  | "spec_history_close"
  | "spec_history_toggle";

export type TuiKeymap = Record<string, TuiAction>;

export const DEFAULT_KEYMAP: TuiKeymap = {
  enter: "submit",
  "ctrl+o": "newline",
  "ctrl+c": "abort",
  "ctrl+d": "exit",
  "ctrl+l": "clear",
  backspace: "backspace",
  "ctrl+w": "delete_word",
  "ctrl+u": "kill_to_start",
  delete: "delete_char_forward",
  "alt+d": "kill_word_forward",
  "alt+u": "upcase_word",
  "alt+l": "cycle_layout",
  "alt+c": "capitalize_word",
  left: "cursor_left",
  right: "cursor_right",
  home: "home",
  end: "end",
  "ctrl+a": "home",
  "ctrl+e": "end",
  "alt+b": "word_left",
  "alt+f": "word_right",
  "ctrl+z": "undo",
  "ctrl+k": "kill_line",
  "ctrl+y": "yank",
  tab: "complete",
  up: "history_previous",
  down: "history_next",
  pageup: "scroll_up",
  pagedown: "scroll_down",
  "ctrl+t": "cycle_theme",
  "ctrl+g": "cycle_mascot",
  "ctrl+v": "toggle_vim",
  "ctrl+p": "open_palette",
  "ctrl+f": "search_transcript",
  "alt+t": "toggle_todo_panel",
  "alt+]": "cycle_sidebar_focus",
  "alt+enter": "sidebar_action",
  "alt+h": "spec_history_toggle",
};

export type ParsedKey = { type: "action"; action: TuiAction } | { type: "text"; text: string };

export function parseTerminalInput(input: string, keymap: TuiKeymap = DEFAULT_KEYMAP): ParsedKey[] {
  return parseBufferedInput(input, keymap).parsed;
}

export class TerminalInputDecoder {
  private buffer = "";

  constructor(private readonly keymap: TuiKeymap = DEFAULT_KEYMAP) {}

  push(input: string): ParsedKey[] {
    this.buffer += input;
    const result = parseBufferedInput(this.buffer, this.keymap);
    this.buffer = this.buffer.slice(result.consumed);
    return result.parsed;
  }

  reset(): void {
    this.buffer = "";
  }
}

const TERMINAL_SEQUENCES: Array<[string, string]> = [
  ["\u001b[5~", "pageup"],
  ["\u001b[6~", "pagedown"],
  ["\u001b[A", "up"],
  ["\u001b[B", "down"],
  ["\u001b[C", "right"],
  ["\u001b[D", "left"],
  ["\u001b[H", "home"],
  ["\u001b[F", "end"],
  ["\u001b[1~", "home"],
  ["\u001b[4~", "end"],
  ["\u001b[3~", "delete"],
  ["\u001bOH", "home"],
  ["\u001bOF", "end"],
  ["\u001bb", "alt+b"],
  ["\u001bf", "alt+f"],
  ["\u001bd", "alt+d"],
  ["\u001bu", "alt+u"],
  ["\u001bc", "alt+c"],
  ["\u001bl", "alt+l"],
  ["\u001bt", "alt+t"],
  ["\u001bh", "alt+h"],
  ["\u001b]", "alt+]"],
  ["\u001b\r", "alt+enter"],
  ["\r", "enter"],
  ["\n", "enter"],
  ["\t", "tab"],
  ["\u007f", "backspace"],
  ["\b", "backspace"],
];

function parseBufferedInput(
  input: string,
  keymap: TuiKeymap,
): { parsed: ParsedKey[]; consumed: number } {
  const parsed: ParsedKey[] = [];
  let index = 0;
  while (index < input.length) {
    if (input.startsWith("\u001b[200~", index)) {
      const end = input.indexOf("\u001b[201~", index + 6);
      if (end < 0) break;
      const pasted = input.slice(index + 6, end);
      if (pasted) parsed.push({ type: "text", text: pasted });
      index = end + 6;
      continue;
    }
    const matched = terminalKeyAt(input, index);
    if (matched) {
      const action = keymap[matched.key];
      if (action) parsed.push({ type: "action", action });
      index += matched.length;
      continue;
    }
    const rest = input.slice(index);
    if (
      ["\u001b[200~", ...TERMINAL_SEQUENCES.map(([sequence]) => sequence)].some(
        (sequence) => sequence.startsWith(rest) && sequence !== rest,
      )
    ) {
      break;
    }
    const point = input.codePointAt(index);
    if (point === undefined) break;
    const text = String.fromCodePoint(point);
    if ((point >= 32 && point !== 127) || text === "\t") parsed.push({ type: "text", text });
    index += text.length;
  }
  return { parsed, consumed: index };
}

const VALID_ACTIONS: readonly TuiAction[] = [
  "submit",
  "newline",
  "abort",
  "exit",
  "clear",
  "backspace",
  "delete_word",
  "delete_char_forward",
  "kill_word_forward",
  "kill_to_start",
  "cursor_left",
  "cursor_right",
  "home",
  "end",
  "word_left",
  "word_right",
  "undo",
  "kill_line",
  "yank",
  "complete",
  "history_previous",
  "history_next",
  "scroll_up",
  "scroll_down",
  "cycle_theme",
  "cycle_mascot",
  "toggle_reasoning",
  "toggle_vim",
  "open_palette",
  "search_transcript",
  "cycle_layout",
  "toggle_todo_panel",
  "cycle_sidebar_focus",
  "sidebar_action",
  "upcase_word",
  "downcase_word",
  "capitalize_word",
  "spec_option_up",
  "spec_option_down",
  "spec_confirm",
  "spec_cancel",
  "spec_history_up",
  "spec_history_down",
  "spec_history_close",
  "spec_history_toggle",
];

export function mergeKeymap(overrides: Partial<TuiKeymap> = {}): TuiKeymap {
  const result = { ...DEFAULT_KEYMAP };
  for (const [key, action] of Object.entries(overrides)) {
    if (!action) continue;
    if (!validKey(key)) throw new Error("Invalid key binding: " + key);
    if (!VALID_ACTIONS.includes(action)) throw new Error("Invalid TUI action: " + action);
    for (const [existing, value] of Object.entries(result)) {
      if (value === action && existing !== key) {
        console.warn(
          `keymap conflict: "${existing}" was bound to "${action}", reassigning to "${key}"`,
        );
        delete result[existing];
      }
    }
    result[key] = action;
  }
  return result;
}

function terminalKeyAt(value: string, index: number): { key: string; length: number } | undefined {
  const rest = value.slice(index);
  for (const [sequence, key] of TERMINAL_SEQUENCES) {
    if (rest.startsWith(sequence)) return { key, length: sequence.length };
  }
  const code = value.charCodeAt(index);
  if (code >= 1 && code <= 26) {
    return { key: "ctrl+" + String.fromCharCode(96 + code), length: 1 };
  }
  return undefined;
}

function validKey(value: string): boolean {
  return /^(ctrl\+[a-z]|alt\+[a-z]|enter|backspace|tab|home|end|left|right|up|down|pageup|pagedown|delete)$/.test(
    value,
  );
}
