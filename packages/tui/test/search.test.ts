import { describe, expect, it } from "vitest";
import {
  advanceSearch,
  closeSearch,
  createSearchState,
  renderSearchBar,
  searchTranscript,
  type SearchState,
} from "../src/search.js";
import { TUI_THEMES } from "../src/themes.js";
import type { TuiTranscriptLine } from "../src/renderer.js";

const theme = TUI_THEMES[0]!;

const sampleTranscript: TuiTranscriptLine[] = [
  { role: "user", text: "Hello world" },
  { role: "assistant", text: "Hi there" },
  { role: "user", text: "Search for hello" },
  { role: "assistant", text: "Found it" },
];

describe("createSearchState", () => {
  it("returns invisible state with empty query", () => {
    const state = createSearchState();
    expect(state.visible).toBe(false);
    expect(state.query).toBe("");
    expect(state.matches).toEqual([]);
    expect(state.currentIndex).toBe(0);
  });
});

describe("searchTranscript", () => {
  it("finds case-insensitive matches", () => {
    const matches = searchTranscript(sampleTranscript, "hello");
    expect(matches).toEqual([0, 2]);
  });

  it("returns empty array for no matches", () => {
    const matches = searchTranscript(sampleTranscript, "nonexistent");
    expect(matches).toEqual([]);
  });

  it("returns empty array for empty query", () => {
    const matches = searchTranscript(sampleTranscript, "");
    expect(matches).toEqual([]);
  });

  it("handles special regex characters as literals", () => {
    const transcript: TuiTranscriptLine[] = [
      { role: "user", text: "price is $50.00" },
      { role: "assistant", text: "total (incl tax)" },
    ];
    expect(searchTranscript(transcript, "$50")).toEqual([0]);
    expect(searchTranscript(transcript, "(incl)")).toEqual([]);
    expect(searchTranscript(transcript, "(incl tax)")).toEqual([1]);
  });
});

describe("advanceSearch", () => {
  it("advances to next match and wraps around", () => {
    const state: SearchState = {
      visible: true,
      query: "hello",
      matches: [0, 2],
      currentIndex: 0,
    };
    const next = advanceSearch(state, 1);
    expect(next.currentIndex).toBe(1);
    const wrapped = advanceSearch(next, 1);
    expect(wrapped.currentIndex).toBe(0);
  });

  it("advances backwards and wraps", () => {
    const state: SearchState = {
      visible: true,
      query: "hello",
      matches: [0, 2],
      currentIndex: 0,
    };
    const prev = advanceSearch(state, -1);
    expect(prev.currentIndex).toBe(1);
  });

  it("returns unchanged when no matches", () => {
    const state: SearchState = {
      visible: true,
      query: "x",
      matches: [],
      currentIndex: 0,
    };
    const next = advanceSearch(state, 1);
    expect(next.currentIndex).toBe(0);
  });
});

describe("closeSearch", () => {
  it("resets to invisible and clears query", () => {
    const state: SearchState = {
      visible: true,
      query: "hello",
      matches: [0, 2],
      currentIndex: 1,
    };
    const closed = closeSearch(state);
    expect(closed.visible).toBe(false);
    expect(closed.query).toBe("");
    expect(closed.matches).toEqual([]);
    expect(closed.currentIndex).toBe(0);
  });
});

describe("renderSearchBar", () => {
  it("returns empty array when invisible", () => {
    const state = createSearchState();
    const lines = renderSearchBar(state, 60, theme);
    expect(lines).toEqual([]);
  });

  it("renders query and match count when visible", () => {
    const state: SearchState = {
      visible: true,
      query: "hello",
      matches: [0, 2],
      currentIndex: 0,
    };
    const lines = renderSearchBar(state, 60, theme);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("hello");
    expect(lines[0]).toContain("1/2");
  });

  it("shows no match indicator when matches is empty", () => {
    const state: SearchState = {
      visible: true,
      query: "xyz",
      matches: [],
      currentIndex: 0,
    };
    const lines = renderSearchBar(state, 60, theme);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("0/0");
  });
});
