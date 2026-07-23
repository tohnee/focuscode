import type { TuiTranscriptLine } from "./renderer.js";
import { fg, type TuiTheme } from "./themes.js";
import { stringWidth } from "./width.js";

export interface SearchState {
  visible: boolean;
  query: string;
  matches: number[];
  currentIndex: number;
}

export function createSearchState(): SearchState {
  return { visible: false, query: "", matches: [], currentIndex: 0 };
}

/**
 * Case-insensitive literal substring search across transcript lines.
 * Returns the indices of matching lines. Special regex characters are
 * treated as literals (no regex compilation).
 */
export function searchTranscript(transcript: TuiTranscriptLine[], query: string): number[] {
  if (!query) return [];
  const lower = query.toLowerCase();
  const matches: number[] = [];
  for (let i = 0; i < transcript.length; i++) {
    if (transcript[i]!.text.toLowerCase().includes(lower)) {
      matches.push(i);
    }
  }
  return matches;
}

/**
 * Advance the current match index by `delta` (positive = forward,
 * negative = backward). Wraps around. No-op when matches is empty.
 */
export function advanceSearch(state: SearchState, delta: number): SearchState {
  if (state.matches.length === 0) return state;
  const len = state.matches.length;
  const next = (((state.currentIndex + delta) % len) + len) % len;
  return { ...state, currentIndex: next };
}

export function closeSearch(state: SearchState): SearchState {
  return { visible: false, query: "", matches: [], currentIndex: 0 };
}

/**
 * Render the search bar as a single line: `/query> [current/total]`.
 * Returns empty array when invisible.
 */
export function renderSearchBar(state: SearchState, width: number, theme: TuiTheme): string[] {
  if (!state.visible) return [];
  const total = state.matches.length;
  const current = total > 0 ? state.currentIndex + 1 : 0;
  const countLabel = `${current}/${total}`;
  const prompt = "/";
  const queryPart = state.query + "_";
  const tail = `  ${countLabel}`;
  const available = Math.max(0, width - stringWidth(prompt) - stringWidth(tail));
  const truncatedQuery =
    stringWidth(queryPart) > available
      ? queryPart.slice(0, Math.max(0, available - 1)) + "…"
      : queryPart;
  const line =
    fg(theme.accent, prompt) +
    truncatedQuery +
    " ".repeat(Math.max(0, available - stringWidth(truncatedQuery))) +
    fg(theme.muted, tail);
  return [line];
}
