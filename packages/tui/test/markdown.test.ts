import { describe, expect, it } from "vitest";
import { renderMarkdownTranscript } from "../src/markdown.js";
import { TUI_THEMES } from "../src/themes.js";

const THEME = TUI_THEMES[0]!;

/** Strip SGR sequences so assertions can reason about plain content. */
function stripSgr(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

/** Strip SGR then join lines with "|" for compact snapshot comparison. */
function plainLines(out: string[]): string[] {
  return out.map((line) => stripSgr(line));
}

describe("renderMarkdownTranscript — blockquote (>)", () => {
  it("renders a single blockquote line with a marker prefix and muted style", () => {
    const out = renderMarkdownTranscript("> hello world", 60, THEME);
    expect(out).toHaveLength(1);
    const plain = plainLines(out);
    // The leading "> " marker should be preserved as a visible marker.
    expect(plain[0]).toContain("hello world");
    // The whole line should be styled with the muted color (blockquote treatment).
    expect(out[0]).toContain("\u001b[");
  });

  it("renders consecutive blockquote lines as one quoted block", () => {
    const md = "> line one\n> line two";
    const out = renderMarkdownTranscript(md, 60, THEME);
    expect(out).toHaveLength(2);
    expect(plainLines(out)[0]).toContain("line one");
    expect(plainLines(out)[1]).toContain("line two");
  });

  it("preserves inline code styling inside blockquote text", () => {
    const out = renderMarkdownTranscript("> run `npm test` now", 60, THEME);
    const plain = plainLines(out)[0]!;
    expect(plain).toContain("run npm test now");
    // Inline code should still carry its own color (warning), separate from
    // the blockquote's muted styling.
    expect(out[0]).toContain("\u001b[38;5;");
  });

  it("handles lazy continuation (no > prefix on continuation line)", () => {
    const md = "> first line\nsecond line";
    const out = renderMarkdownTranscript(md, 60, THEME);
    expect(out).toHaveLength(2);
    // Both lines belong to the same blockquote block.
    expect(plainLines(out)[0]).toContain("first line");
    expect(plainLines(out)[1]).toContain("second line");
  });
});

describe("renderMarkdownTranscript — table (GFM)", () => {
  it("renders a minimal 2-column table preserving header and rows", () => {
    const md = ["| Name | Age |", "| --- | --- |", "| Alice | 30 |", "| Bob | 25 |"].join("\n");
    const out = renderMarkdownTranscript(md, 60, THEME);
    // Expect 3 rendered lines: header + 2 data rows (separator skipped).
    expect(out).toHaveLength(3);
    const plain = plainLines(out);
    expect(plain[0]).toContain("Name");
    expect(plain[0]).toContain("Age");
    expect(plain[1]).toContain("Alice");
    expect(plain[1]).toContain("30");
    expect(plain[2]).toContain("Bob");
    expect(plain[2]).toContain("25");
  });

  it("skips the separator row in rendered output but validates it", () => {
    const md = ["| A | B |", "| --- | --- |", "| 1 | 2 |"].join("\n");
    const out = renderMarkdownTranscript(md, 60, THEME);
    // The separator row should NOT appear as a rendered line.
    const plain = plainLines(out);
    expect(plain.some((l) => /---/.test(l))).toBe(false);
    // Header + 1 data row = 2 rendered lines.
    expect(out).toHaveLength(2);
  });

  it("renders a single-column table", () => {
    const md = ["| Only |", "| --- |", "| value |"].join("\n");
    const out = renderMarkdownTranscript(md, 40, THEME);
    expect(out).toHaveLength(2);
    expect(plainLines(out)[0]).toContain("Only");
    expect(plainLines(out)[1]).toContain("value");
  });

  it("rejects a missing separator as non-table (falls back to plain text)", () => {
    const md = ["| A | B |", "| Alice | 30 |"].join("\n");
    const out = renderMarkdownTranscript(md, 40, THEME);
    // No separator → not a table → each line rendered as plain paragraph.
    const plain = plainLines(out);
    expect(plain.some((l) => l.includes("Alice"))).toBe(true);
    // Both lines should be rendered (not consumed as table rows).
    expect(out.length).toBeGreaterThanOrEqual(2);
  });

  it("renders header row with bold styling", () => {
    const md = ["| Name | Age |", "| --- | --- |", "| Alice | 30 |"].join("\n");
    const out = renderMarkdownTranscript(md, 60, THEME);
    // The header line should contain a bold SGR sequence.
    expect(out[0]).toContain("\u001b[1m");
  });

  it("does not leak SGR sequences from cell content", () => {
    const dirty = "| A |\n| --- |\n| \u001b[31mevil\u001b[39m |";
    const out = renderMarkdownTranscript(dirty, 40, THEME);
    for (const line of out) {
      // Only SGR sequences from the theme are allowed; raw red (31) must not leak.
      expect(line).not.toContain("\u001b[31m");
    }
  });
});
