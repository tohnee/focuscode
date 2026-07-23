import { describe, expect, it } from "vitest";
import { highlightCode, type SupportedLang, type TuiTheme } from "../src/index.js";

const THEME: TuiTheme = {
  id: "test",
  name: "Test",
  background: 232,
  foreground: 252,
  accent: 75,
  secondary: 99,
  success: 48,
  warning: 214,
  danger: 197,
  muted: 240,
  border: "─",
};

function fg(color: number, text: string): string {
  return "\u001b[38;5;" + color + "m" + text + "\u001b[39m";
}

/** Strip SGR sequences so assertions can also reason about plain content. */
function stripSgr(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("syntax.highlightCode", () => {
  it("returns sanitized text unchanged for unknown languages", () => {
    const code = "let x = 1;";
    const out = highlightCode(code, "rust", THEME);
    expect(out).toBe(code);
  });

  it("normalizes language aliases case-insensitively", () => {
    const code = "const x = 1;";
    const tsLower = highlightCode(code, "ts", THEME);
    const tsUpper = highlightCode(code, "TypeScript", THEME);
    const tsAlias = highlightCode(code, "TYPESCRIPT", THEME);
    expect(tsUpper).toBe(tsLower);
    expect(tsAlias).toBe(tsLower);
  });

  it("treats js and ts as distinct dialects", () => {
    const code = "const Maybe = 1;";
    const ts = highlightCode(code, "ts", THEME);
    const js = highlightCode(code, "js", THEME);
    // TS highlights capitalized Maybe as a type (danger); JS leaves it plain.
    expect(ts).toContain(fg(THEME.danger, "Maybe"));
    expect(js).not.toContain(fg(THEME.danger, "Maybe"));
  });

  it("highlights TS keywords with the accent color", () => {
    const out = highlightCode("const x = 1;", "ts", THEME);
    expect(out).toContain(fg(THEME.accent, "const"));
    expect(stripSgr(out)).toBe("const x = 1;");
  });

  it("highlights string literals with the success color", () => {
    const out = highlightCode('const hi = "world";', "ts", THEME);
    expect(out).toContain(fg(THEME.success, '"world"'));
  });

  it("highlights numbers with the warning color", () => {
    const out = highlightCode("const n = 42;", "ts", THEME);
    expect(out).toContain(fg(THEME.warning, "42"));
  });

  it("highlights single-line comments with the muted color", () => {
    const out = highlightCode("// hi\nconst x = 1;", "ts", THEME);
    expect(out).toContain(fg(THEME.muted, "// hi"));
  });

  it("highlights block comments with the muted color", () => {
    const out = highlightCode("/* a\nb */ const x = 1;", "ts", THEME);
    expect(out).toContain(fg(THEME.muted, "/* a\nb */"));
  });

  it("colors function-call identifiers (followed by `(`) with secondary", () => {
    const out = highlightCode("foo(1);", "ts", THEME);
    expect(out).toContain(fg(THEME.secondary, "foo"));
  });

  it("sanitizes existing ANSI sequences before highlighting", () => {
    const dirty = "\u001b[31mconst\u001b[39m x = 1;";
    const out = highlightCode(dirty, "ts", THEME);
    // No raw red SGR leaks; only the theme's accent wraps `const`.
    expect(out).not.toContain("\u001b[31m");
    expect(out).toContain(fg(THEME.accent, "const"));
    expect(stripSgr(out)).toBe("const x = 1;");
  });

  it("strips non-SGR control characters from input", () => {
    const dirty = "const\u0007 x = 1;";
    const out = highlightCode(dirty, "ts", THEME);
    expect(stripSgr(out)).toBe("const x = 1;");
  });

  it("highlights JSON keys, values, booleans and punctuation", () => {
    const json = '{"name": "Foxy", "level": 9, "active": true}';
    const out = highlightCode(json, "json", THEME);
    expect(out).toContain(fg(THEME.accent, '"name"'));
    expect(out).toContain(fg(THEME.success, '"Foxy"'));
    expect(out).toContain(fg(THEME.warning, "9"));
    expect(out).toContain(fg(THEME.danger, "true"));
    expect(out).toContain(fg(THEME.muted, "{"));
    expect(out).toContain(fg(THEME.muted, "}"));
    expect(stripSgr(out)).toBe(json);
  });

  it("highlights bash keywords, comments and numbers", () => {
    const out = highlightCode('if [ -n "$x" ]; then echo 42; fi', "bash", THEME);
    expect(out).toContain(fg(THEME.accent, "if"));
    expect(out).toContain(fg(THEME.accent, "then"));
    expect(out).toContain(fg(THEME.accent, "fi"));
    expect(out).toContain(fg(THEME.accent, "echo"));
    expect(out).toContain(fg(THEME.success, '"$x"'));
    expect(out).toContain(fg(THEME.warning, "42"));
  });

  it("highlights markdown headers, lists, fences and inline code", () => {
    const md = ["# Title", "- item with `code`", "```ts", "const x = 1;", "```"].join("\n");
    const out = highlightCode(md, "markdown", THEME);
    expect(out).toContain(fg(THEME.accent, "# Title"));
    // List lines are colored as a whole; inline code spans are NOT separately
    // highlighted when the whole line matches a list pattern.
    expect(out).toContain(fg(THEME.secondary, "- item with `code`"));
    expect(out).toContain(fg(THEME.muted, "```ts"));
    expect(stripSgr(out)).toBe(md);
  });

  it("highlights inline code spans on plain markdown lines", () => {
    const out = highlightCode("run `npm test` now", "markdown", THEME);
    expect(out).toContain(fg(THEME.warning, "`npm test`"));
  });

  it("exposes the SupportedLang type surface at compile time", () => {
    const langs: SupportedLang[] = ["ts", "js", "json", "bash", "markdown"];
    expect(langs).toHaveLength(5);
  });

  it("does not leak non-SGR ANSI escapes in any language branch", () => {
    const samples: Array<[string, string]> = [
      ["const x = 1;", "ts"],
      ['const x = "hi";', "js"],
      ['{"a":1}', "json"],
      ["echo hi", "bash"],
      ["# hi", "markdown"],
    ];
    for (const [code, lang] of samples) {
      const out = highlightCode(code, lang, THEME);
      // Only SGR (\u001b[...m) sequences are allowed.
      const forbidden = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)?)/g;
      const sgrOnly = out.replace(/\u001b\[[0-9;]*m/g, "");
      expect(sgrOnly).not.toMatch(forbidden);
    }
  });
});
