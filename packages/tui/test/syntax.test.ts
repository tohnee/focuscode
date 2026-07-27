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
    const out = highlightCode(code, "cobol", THEME);
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
    const langs: SupportedLang[] = ["ts", "js", "json", "bash", "markdown", "python", "go", "rust"];
    expect(langs).toHaveLength(8);
  });

  it("does not leak non-SGR ANSI escapes in any language branch", () => {
    const samples: Array<[string, string]> = [
      ["const x = 1;", "ts"],
      ['const x = "hi";', "js"],
      ['{"a":1}', "json"],
      ["echo hi", "bash"],
      ["# hi", "markdown"],
      ["x = 1", "python"],
      ["package main", "go"],
      ["fn main() {}", "rust"],
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

describe("syntax.highlightCode — Python", () => {
  it("normalizes python/py aliases case-insensitively", () => {
    const code = "def f():\n    return 1";
    const a = highlightCode(code, "python", THEME);
    const b = highlightCode(code, "py", THEME);
    const c = highlightCode(code, "PYTHON", THEME);
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it("highlights keywords with the accent color", () => {
    const out = highlightCode("def f():\n    return None", "python", THEME);
    expect(out).toContain(fg(THEME.accent, "def"));
    expect(out).toContain(fg(THEME.accent, "return"));
    expect(out).toContain(fg(THEME.danger, "None"));
  });

  it("highlights string literals (single, double, triple-quoted) with success color", () => {
    const out = highlightCode('x = "hello"', "python", THEME);
    expect(out).toContain(fg(THEME.success, '"hello"'));
    const triple = highlightCode('x = """multi\nline"""', "python", THEME);
    expect(triple).toContain(fg(THEME.success, '"""multi\nline"""'));
  });

  it("highlights comments starting with # in muted color", () => {
    const out = highlightCode("x = 1  # set x", "python", THEME);
    expect(out).toContain(fg(THEME.muted, "# set x"));
  });

  it("highlights numbers with warning color", () => {
    const out = highlightCode("n = 42", "python", THEME);
    expect(out).toContain(fg(THEME.warning, "42"));
  });

  it("highlights function-call identifiers with secondary color", () => {
    const out = highlightCode("print(42)", "python", THEME);
    expect(out).toContain(fg(THEME.secondary, "print"));
  });

  it("preserves plain content after stripping SGR", () => {
    const code = "def f():\n    return 1";
    const out = highlightCode(code, "python", THEME);
    expect(stripSgr(out)).toBe(code);
  });

  it("strips non-SGR control characters from input", () => {
    const dirty = "x =\u0007 1";
    const out = highlightCode(dirty, "python", THEME);
    expect(stripSgr(out)).toBe("x = 1");
  });
});

describe("syntax.highlightCode — Go", () => {
  it("normalizes go/golang aliases case-insensitively", () => {
    const code = "package main";
    const a = highlightCode(code, "go", THEME);
    const b = highlightCode(code, "golang", THEME);
    const c = highlightCode(code, "GO", THEME);
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it("highlights package, func, return keywords with accent color", () => {
    const out = highlightCode("package main\n\nfunc f() int { return 1 }", "go", THEME);
    expect(out).toContain(fg(THEME.accent, "package"));
    expect(out).toContain(fg(THEME.accent, "func"));
    expect(out).toContain(fg(THEME.accent, "return"));
  });

  it("highlights string literals (interpreted and raw) with success color", () => {
    const out = highlightCode('s := "hello"', "go", THEME);
    expect(out).toContain(fg(THEME.success, '"hello"'));
    const raw = highlightCode("s := `hello`", "go", THEME);
    expect(raw).toContain(fg(THEME.success, "`hello`"));
  });

  it("highlights comments starting with // in muted color", () => {
    const out = highlightCode("// comment\npackage main", "go", THEME);
    expect(out).toContain(fg(THEME.muted, "// comment"));
  });

  it("highlights block comments /* */ in muted color", () => {
    const out = highlightCode("/* a\nb */\npackage main", "go", THEME);
    expect(out).toContain(fg(THEME.muted, "/* a\nb */"));
  });

  it("highlights numbers with warning color", () => {
    const out = highlightCode("n := 42", "go", THEME);
    expect(out).toContain(fg(THEME.warning, "42"));
  });

  it("highlights function-call identifiers with secondary color", () => {
    const out = highlightCode("fmt.Println(42)", "go", THEME);
    expect(out).toContain(fg(THEME.secondary, "Println"));
  });

  it("highlights true/false/nil as danger (constants) color", () => {
    const out = highlightCode("x := true", "go", THEME);
    expect(out).toContain(fg(THEME.danger, "true"));
  });

  it("preserves plain content after stripping SGR", () => {
    const code = "package main";
    const out = highlightCode(code, "go", THEME);
    expect(stripSgr(out)).toBe(code);
  });
});

describe("syntax.highlightCode — Rust", () => {
  it("normalizes rust/rs aliases case-insensitively", () => {
    const code = "fn main() {}";
    const a = highlightCode(code, "rust", THEME);
    const b = highlightCode(code, "rs", THEME);
    const c = highlightCode(code, "RUST", THEME);
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it("highlights fn, let, return, mut keywords with accent color", () => {
    const out = highlightCode("fn f() -> i32 { let mut x = 1; return x; }", "rust", THEME);
    expect(out).toContain(fg(THEME.accent, "fn"));
    expect(out).toContain(fg(THEME.accent, "let"));
    expect(out).toContain(fg(THEME.accent, "return"));
    expect(out).toContain(fg(THEME.accent, "mut"));
  });

  it("highlights string literals with success color", () => {
    const out = highlightCode('let s = "hello";', "rust", THEME);
    expect(out).toContain(fg(THEME.success, '"hello"'));
  });

  it("highlights comments starting with // in muted color", () => {
    const out = highlightCode("// comment\nfn main() {}", "rust", THEME);
    expect(out).toContain(fg(THEME.muted, "// comment"));
  });

  it("highlights block comments /* */ in muted color", () => {
    const out = highlightCode("/* a\nb */\nfn main() {}", "rust", THEME);
    expect(out).toContain(fg(THEME.muted, "/* a\nb */"));
  });

  it("highlights numbers with warning color", () => {
    const out = highlightCode("let n = 42;", "rust", THEME);
    expect(out).toContain(fg(THEME.warning, "42"));
  });

  it("highlights function-call identifiers with secondary color", () => {
    const out = highlightCode('println!("hi")', "rust", THEME);
    expect(out).toContain(fg(THEME.secondary, "println"));
  });

  it("highlights true/false as danger (constants) color", () => {
    const out = highlightCode("let x = true;", "rust", THEME);
    expect(out).toContain(fg(THEME.danger, "true"));
  });

  it("preserves plain content after stripping SGR", () => {
    const code = "fn main() {}";
    const out = highlightCode(code, "rust", THEME);
    expect(stripSgr(out)).toBe(code);
  });
});
