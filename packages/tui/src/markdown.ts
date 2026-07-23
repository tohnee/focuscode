import { highlightCode } from "./syntax.js";
import { type TuiTheme } from "./themes.js";
import { sanitizeTerminalText, stringWidth, takeWidth } from "./width.js";

interface MdStyle {
  bold?: boolean;
  italic?: boolean;
  color?: number;
  background?: number;
}

interface MdToken {
  text: string;
  style: MdStyle;
}

const INLINE_PATTERN = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(_[^_\n]+_)/g;

/**
 * Render a small, safe Markdown subset into ANSI-styled lines that each fit `width`
 * display columns: headings, **bold** / *italic*, `inline code`, fenced code blocks
 * and unordered/ordered lists. Input is sanitized before any styling so no control
 * sequences from the raw text can leak into the output.
 */
export function renderMarkdownTranscript(text: string, width: number, theme: TuiTheme): string[] {
  const columns = Math.max(10, width);
  const rendered: string[] = [];
  let inFence = false;
  let fenceLang = "";
  for (const rawLine of sanitizeTerminalText(text).split("\n")) {
    const trimmed = rawLine.trimStart();
    if (trimmed.startsWith("```")) {
      if (!inFence) fenceLang = trimmed.slice(3).trim();
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      const body = takeWidth(rawLine.replaceAll("\t", "  "), columns);
      const highlighted = highlightCode(body, fenceLang, theme);
      const padding = " ".repeat(Math.max(0, columns - stringWidth(body)));
      const block = "\u001b[48;5;" + theme.muted + "m" + highlighted + padding + "\u001b[49m";
      rendered.push(block);
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(trimmed);
    if (heading) {
      rendered.push(
        ...flow([{ text: heading[1]!, style: { bold: true, color: theme.accent } }], columns),
      );
      continue;
    }
    if (!trimmed) {
      rendered.push("");
      continue;
    }
    const list = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(rawLine);
    if (list) {
      const indent = " ".repeat(Math.min(6, list[1]!.length));
      const marker = /^\d/.test(list[2]!) ? list[2]! : "•";
      const prefix = indent + marker + " ";
      const tokens = parseInline(list[3]!, theme);
      rendered.push(...flow(tokens, columns, prefix, " ".repeat(stringWidth(prefix))));
      continue;
    }
    rendered.push(...flow(parseInline(rawLine, theme), columns));
  }
  return rendered;
}

function parseInline(text: string, theme: TuiTheme): MdToken[] {
  const tokens: MdToken[] = [];
  const plain: MdStyle = { color: theme.foreground };
  let last = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    if (match.index > last) tokens.push({ text: text.slice(last, match.index), style: plain });
    const whole = match[0];
    if (whole.startsWith("`")) {
      tokens.push({ text: whole.slice(1, -1), style: { color: theme.warning } });
    } else if (whole.startsWith("**")) {
      tokens.push({ text: whole.slice(2, -2), style: { color: theme.foreground, bold: true } });
    } else {
      tokens.push({ text: whole.slice(1, -1), style: { color: theme.foreground, italic: true } });
    }
    last = match.index + whole.length;
  }
  if (last < text.length) tokens.push({ text: text.slice(last), style: plain });
  return tokens;
}

/** Greedily pack styled tokens into lines of at most `width` display columns. */
function flow(
  tokens: MdToken[],
  width: number,
  firstPrefix = "",
  restPrefix = firstPrefix,
): string[] {
  const lines: string[] = [];
  let prefix = firstPrefix;
  let current = prefix;
  let currentWidth = stringWidth(prefix);
  const flush = () => {
    lines.push(current);
    prefix = restPrefix;
    current = prefix;
    currentWidth = stringWidth(prefix);
  };
  for (const token of tokens) {
    let rest = token.text;
    while (rest) {
      const budget = width - currentWidth;
      if (budget <= 0) {
        flush();
        continue;
      }
      const taken = takeWidth(rest, budget);
      if (!taken) {
        flush();
        continue;
      }
      current += applyStyle(taken, token.style);
      currentWidth += stringWidth(taken);
      rest = rest.slice(taken.length);
      if (rest) flush();
    }
  }
  lines.push(current);
  return lines;
}

function applyStyle(text: string, style: MdStyle): string {
  if (!text) return "";
  let open = "";
  if (style.bold) open += "\u001b[1m";
  if (style.italic) open += "\u001b[3m";
  if (style.color !== undefined) open += "\u001b[38;5;" + style.color + "m";
  if (style.background !== undefined) open += "\u001b[48;5;" + style.background + "m";
  return open ? open + text + "\u001b[0m" : text;
}
