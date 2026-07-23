import type { TuiTheme } from "./themes.js";
import { sanitizeTerminalText } from "./width.js";

/**
 * Languages whose syntax we know how to colorize. Anything else is returned
 * sanitized but unstyled so unknown languages never leak ANSI from the source.
 */
export type SupportedLang = "ts" | "js" | "json" | "bash" | "markdown";

const TS_KEYWORDS = new Set([
  "abstract",
  "any",
  "as",
  "async",
  "await",
  "boolean",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "declare",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "get",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "is",
  "keyof",
  "let",
  "namespace",
  "never",
  "new",
  "null",
  "number",
  "of",
  "private",
  "protected",
  "public",
  "readonly",
  "return",
  "satisfies",
  "set",
  "static",
  "string",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "type",
  "typeof",
  "undefined",
  "unknown",
  "void",
  "while",
  "with",
  "yield",
]);

const JS_KEYWORDS = new Set([
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "get",
  "if",
  "import",
  "in",
  "instanceof",
  "let",
  "new",
  "null",
  "of",
  "return",
  "set",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "undefined",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

const BASH_KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "while",
  "do",
  "done",
  "case",
  "esac",
  "function",
  "in",
  "return",
  "local",
  "export",
  "unset",
  "readonly",
  "declare",
  "typeset",
  "exit",
  "break",
  "continue",
  "shift",
  "source",
  "alias",
  "unalias",
  "echo",
  "printf",
  "read",
  "test",
]);

/**
 * Colorize a code block with 256-color SGR sequences. Colors come from the
 * supplied theme (no hardcoded palette). Input is sanitized first; the output
 * only contains SGR sequences (`\u001b[38;5;Nm` / `\u001b[39m`), never any
 * other CSI/OSC characters, so the result is safe to embed in TUI frames.
 *
 * Unknown languages return the sanitized text unchanged.
 */
export function highlightCode(text: string, lang: string, theme: TuiTheme): string {
  const clean = sanitizeTerminalText(text);
  const normalized = normalizeLang(lang);
  switch (normalized) {
    case "ts":
      return highlightTsLike(clean, theme, TS_KEYWORDS, true);
    case "js":
      return highlightTsLike(clean, theme, JS_KEYWORDS, false);
    case "json":
      return highlightJson(clean, theme);
    case "bash":
      return highlightBash(clean, theme);
    case "markdown":
      return highlightMarkdown(clean, theme);
    default:
      return clean;
  }
}

function normalizeLang(lang: string): SupportedLang | undefined {
  const lower = lang.trim().toLowerCase();
  if (!lower) return undefined;
  if (["ts", "typescript"].includes(lower)) return "ts";
  if (["js", "javascript", "mjs", "cjs"].includes(lower)) return "js";
  if (["json"].includes(lower)) return "json";
  if (["bash", "sh", "shell", "zsh"].includes(lower)) return "bash";
  if (["markdown", "md"].includes(lower)) return "markdown";
  return undefined;
}

function fg(color: number, text: string): string {
  return "\u001b[38;5;" + color + "m" + text + "\u001b[39m";
}

interface Rule {
  pattern: RegExp;
  kind: "keyword" | "string" | "number" | "comment" | "function" | "type" | "punct";
}

const TS_RULES: Rule[] = [
  { pattern: /\/\/[^\n]*/g, kind: "comment" },
  { pattern: /\/\*[\s\S]*?\*\//g, kind: "comment" },
  { pattern: /`(?:\\.|[^`\\])*`/g, kind: "string" },
  { pattern: /"(?:\\.|[^"\\\n])*"/g, kind: "string" },
  { pattern: /'(?:\\.|[^'\\\n])*'/g, kind: "string" },
  { pattern: /\b\d[\d_]*(?:\.\d+(?:[eE][+-]?\d+)?)?\b/g, kind: "number" },
  { pattern: /[A-Z][A-Za-z0-9_]*/g, kind: "type" },
  { pattern: /[a-z_$][A-Za-z0-9_$]*/g, kind: "keyword" },
];

const BASH_RULES: Rule[] = [
  { pattern: /#[^\n]*/g, kind: "comment" },
  { pattern: /"(?:\\.|[^"\\])*"/g, kind: "string" },
  { pattern: /'(?:[^'])*'/g, kind: "string" },
  { pattern: /\b\d+(?:\.\d+)?\b/g, kind: "number" },
  { pattern: /[a-zA-Z_][A-Za-z0-9_-]*/g, kind: "keyword" },
];

function highlightTsLike(
  text: string,
  theme: TuiTheme,
  keywords: Set<string>,
  isTs: boolean,
): string {
  const tokens = tokenize(text, TS_RULES);
  return tokens
    .map((token) => {
      if (token.kind === "plain") return token.text;
      if (token.kind === "comment") return fg(theme.muted, token.text);
      if (token.kind === "string") return fg(theme.success, token.text);
      if (token.kind === "number") return fg(theme.warning, token.text);
      if (token.kind === "punct") return fg(theme.muted, token.text);
      if (token.kind === "type") {
        if (!isTs) return token.text;
        return fg(theme.danger, token.text);
      }
      // keyword / function disambiguation
      if (keywords.has(token.text)) return fg(theme.accent, token.text);
      // function call: identifier immediately followed by `(`
      const next = token.nextChar;
      if (next === "(") return fg(theme.secondary, token.text);
      if (/^[A-Z]/.test(token.text) && isTs) return fg(theme.danger, token.text);
      return token.text;
    })
    .join("");
}

function highlightBash(text: string, theme: TuiTheme): string {
  const tokens = tokenize(text, BASH_RULES);
  return tokens
    .map((token) => {
      if (token.kind === "plain") return token.text;
      if (token.kind === "comment") return fg(theme.muted, token.text);
      if (token.kind === "string") return fg(theme.success, token.text);
      if (token.kind === "number") return fg(theme.warning, token.text);
      if (token.kind === "punct") return fg(theme.muted, token.text);
      if (token.kind === "type") return token.text;
      if (BASH_KEYWORDS.has(token.text)) return fg(theme.accent, token.text);
      // Variable reference like $VAR
      if (token.text.startsWith("$")) return fg(theme.secondary, token.text);
      // Function call or command: identifier followed by space or end
      return token.text;
    })
    .join("");
}

function highlightJson(text: string, theme: TuiTheme): string {
  const pattern =
    /(?<string>"(?:\\.|[^"\\\n])*"\s*:?)|(?<number>-?\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(?<keyword>true|false|null)|(?<punct>[{}\[\]:,])/g;
  let result = "";
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) result += text.slice(last, index);
    if (match.groups?.string) {
      const raw = match[0];
      if (raw.endsWith(":")) {
        result += fg(theme.accent, raw.slice(0, -1).trimEnd()) + raw.slice(raw.length - 1);
      } else {
        result += fg(theme.success, raw);
      }
    } else if (match.groups?.number) {
      result += fg(theme.warning, match[0]);
    } else if (match.groups?.keyword) {
      result += fg(theme.danger, match[0]);
    } else if (match.groups?.punct) {
      result += fg(theme.muted, match[0]);
    }
    last = index + match[0].length;
  }
  if (last < text.length) result += text.slice(last);
  return result;
}

function highlightMarkdown(text: string, theme: TuiTheme): string {
  const lines = text.split("\n");
  return lines
    .map((line) => {
      if (/^#{1,6}\s/.test(line)) return fg(theme.accent, line);
      if (/^\s*([-*+]|\d+[.)])\s/.test(line)) return fg(theme.secondary, line);
      if (/^```/.test(line)) return fg(theme.muted, line);
      if (/^>/.test(line)) return fg(theme.muted, line);
      // inline code spans
      return line.replace(/`[^`\n]+`/g, (match) => fg(theme.warning, match));
    })
    .join("\n");
}

interface Token {
  text: string;
  kind: Rule["kind"] | "plain";
  nextChar?: string | undefined;
}

/** Run all rules, interleaving unmatched plain runs; non-overlapping matches. */
function tokenize(text: string, rules: Rule[]): Token[] {
  const matches: Array<{ start: number; end: number; rule: Rule; text: string }> = [];
  for (const rule of rules) {
    rule.pattern.lastIndex = 0;
    for (const match of text.matchAll(rule.pattern)) {
      const start = match.index;
      if (start === undefined) continue;
      const end = start + match[0].length;
      matches.push({ start, end, rule, text: match[0] });
    }
  }
  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  const tokens: Token[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start < cursor) continue; // overlaps an earlier (preferred) match
    if (match.start > cursor) tokens.push({ text: text.slice(cursor, match.start), kind: "plain" });
    tokens.push({
      text: match.text,
      kind: match.rule.kind,
      nextChar: text[match.end],
    });
    cursor = match.end;
  }
  if (cursor < text.length) tokens.push({ text: text.slice(cursor), kind: "plain" });
  return tokens;
}
