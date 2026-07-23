import { fg, type TuiTheme } from "./themes.js";
import { stringWidth } from "./width.js";

export type PaletteCategory = "navigation" | "editing" | "view" | "spec" | "model" | "session";

export interface PaletteCommand {
  id: string;
  label: string;
  description?: string;
  shortcut?: string;
  category: PaletteCategory;
}

export const BUILTIN_COMMANDS: readonly PaletteCommand[] = [
  {
    id: "layout:classic",
    label: "Classic Layout",
    description: "Switch to single-pane layout",
    category: "view",
  },
  {
    id: "layout:split",
    label: "Split Layout",
    description: "Left transcript, right sidebar",
    category: "view",
  },
  {
    id: "vim:toggle",
    label: "Toggle Vim Mode",
    description: "Enable or disable modal editing",
    category: "editing",
  },
  {
    id: "search:transcript",
    label: "Search Transcript",
    shortcut: "Ctrl+F",
    description: "Find text in conversation history",
    category: "navigation",
  },
  {
    id: "model:picker",
    label: "Open Model Picker",
    shortcut: "Alt+M",
    description: "Switch model or reasoning effort",
    category: "model",
  },
  {
    id: "spec:decline",
    label: "Decline Current Spec",
    description: "Reject the pending SpecEngine draft",
    category: "spec",
  },
  {
    id: "session:new",
    label: "New Session",
    description: "Start a fresh conversation",
    category: "session",
  },
  {
    id: "session:fork",
    label: "Fork Session",
    description: "Branch the current conversation",
    category: "session",
  },
  {
    id: "view:toggle_reasoning",
    label: "Toggle Reasoning Display",
    shortcut: "Ctrl+R",
    description: "Expand or collapse model reasoning",
    category: "view",
  },
  {
    id: "view:clear_transcript",
    label: "Clear Transcript",
    description: "Wipe the visible conversation",
    category: "view",
  },
];

export interface PaletteState {
  visible: boolean;
  query: string;
  filtered: PaletteCommand[];
  selectedIndex: number;
}

export function createPaletteState(): PaletteState {
  return {
    visible: false,
    query: "",
    filtered: [...BUILTIN_COMMANDS],
    selectedIndex: 0,
  };
}

/**
 * Fuzzy-ish case-insensitive substring filter on label, description, and category.
 * Resets selectedIndex to 0 when the filtered list changes.
 */
export function updatePaletteQuery(state: PaletteState, query: string): PaletteState {
  const q = query.toLowerCase().trim();
  if (!q) {
    return { ...state, query, filtered: [...BUILTIN_COMMANDS], selectedIndex: 0 };
  }
  const filtered = BUILTIN_COMMANDS.filter((cmd) => {
    return (
      cmd.label.toLowerCase().includes(q) ||
      (cmd.description?.toLowerCase().includes(q) ?? false) ||
      cmd.category.toLowerCase().includes(q)
    );
  });
  return { ...state, query, filtered, selectedIndex: 0 };
}

/**
 * Move selection by delta (positive = down, negative = up). Wraps around.
 * No-op when filtered is empty.
 */
export function movePaletteCursor(state: PaletteState, delta: number): PaletteState {
  if (state.filtered.length === 0) return { ...state, selectedIndex: 0 };
  const len = state.filtered.length;
  const next = (((state.selectedIndex + delta) % len) + len) % len;
  return { ...state, selectedIndex: next };
}

/**
 * Return the currently selected command, or undefined when filtered is empty.
 */
export function confirmPalette(state: PaletteState): PaletteCommand | undefined {
  if (state.filtered.length === 0) return undefined;
  return state.filtered[state.selectedIndex];
}

export function closePalette(state: PaletteState): PaletteState {
  return {
    visible: false,
    query: "",
    filtered: [...BUILTIN_COMMANDS],
    selectedIndex: 0,
  };
}

/**
 * Render the palette overlay. Returns empty array when invisible.
 * Layout:
 *   Line 0:  > query_
 *   Line 1+: filtered commands (selected prefixed with ">"), capped by maxHeight.
 */
export function renderPalette(
  state: PaletteState,
  width: number,
  maxHeight: number,
  theme: TuiTheme,
): string[] {
  if (!state.visible) return [];
  const lines: string[] = [];
  const queryLine = fg(theme.accent, "> ") + state.query + "_";
  lines.push(queryLine);
  const maxItems = Math.max(0, maxHeight - 1);
  const items = state.filtered.slice(0, maxItems);
  for (let i = 0; i < items.length; i++) {
    const cmd = items[i]!;
    const selected = i === state.selectedIndex;
    const marker = selected ? ">" : " ";
    const shortcut = cmd.shortcut ? fg(theme.muted, " [" + cmd.shortcut + "]") : "";
    const labelWidth = Math.max(0, width - 2 - stringWidth(shortcut));
    const label =
      cmd.label.length > labelWidth
        ? cmd.label.slice(0, Math.max(0, labelWidth - 1)) + "…"
        : cmd.label;
    const paddedLabel = label + " ".repeat(Math.max(0, labelWidth - stringWidth(label)));
    const line = marker + " " + (selected ? fg(theme.accent, paddedLabel) : paddedLabel) + shortcut;
    lines.push(line);
  }
  if (state.filtered.length === 0) {
    lines.push(fg(theme.muted, "  No matching commands"));
  }
  return lines;
}
