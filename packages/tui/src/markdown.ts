import { highlightCode } from "./syntax.js";
import { bg, fg, type ColorValue, type TuiTheme } from "./themes.js";
import { sanitizeTerminalText, stringWidth, takeWidth } from "./width.js";

interface MdStyle {
  bold?: boolean;
  italic?: boolean;
  dim?: boolean;
  underline?: boolean;
  color?: ColorValue;
  background?: ColorValue;
}

interface MdToken {
  text: string;
  style: MdStyle;
}

const INLINE_PATTERN =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(__[^_\n]+__)|(_[^_\n]+_)|(~~[^~\n]+~~)/g;

/**
 * Render a small, safe Markdown subset into ANSI-styled lines that each fit `width`
 * display columns: headings, **bold** / *italic*, `inline code`, fenced code blocks,
 * unordered/ordered lists, blockquotes (`>`) and GFM tables. Input is sanitized
 * before any styling so no control sequences from the raw text can leak into
 * the output.
 */
export function renderMarkdownTranscript(text: string, width: number, theme: TuiTheme): string[] {
  const columns = Math.max(10, width);
  const rendered: string[] = [];
  let inFence = false;
  let fenceLang = "";
  const lines = sanitizeTerminalText(text).split("\n");
  let i = 0;
  while (i < lines.length) {
    const rawLine = lines[i]!;
    const trimmed = rawLine.trimStart();
    if (trimmed.startsWith("```")) {
      if (!inFence) fenceLang = trimmed.slice(3).trim();
      inFence = !inFence;
      i += 1;
      continue;
    }
    if (inFence) {
      const body = takeWidth(rawLine.replaceAll("\t", "  "), columns);
      const highlighted = highlightCode(body, fenceLang, theme);
      const padding = " ".repeat(Math.max(0, columns - stringWidth(body)));
      const block = bg(theme.muted, highlighted + padding);
      rendered.push(block);
      i += 1;
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(trimmed);
    if (heading) {
      rendered.push(
        ...flow([{ text: heading[1]!, style: { bold: true, color: theme.accent } }], columns),
      );
      i += 1;
      continue;
    }
    // Blockquote: line starts with `>` (optionally followed by a space).
    const blockquoteMatch = /^>\s?(.*)$/.exec(rawLine);
    if (blockquoteMatch) {
      const blockLines: string[] = [blockquoteMatch[1]!];
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j]!;
        const nextTrim = next.trimStart();
        if (nextTrim === "") break;
        const bq = /^>\s?(.*)$/.exec(next);
        if (bq) {
          blockLines.push(bq[1]!);
          j += 1;
          continue;
        }
        // Lazy continuation: a plain non-empty line that is not another block
        // starter (heading, list, table, fence) continues the blockquote.
        if (/^#{1,6}\s/.test(nextTrim)) break;
        if (/^(\s*)([-*+]|\d+[.)])\s/.test(next)) break;
        if (nextTrim.startsWith("|")) break;
        if (nextTrim.startsWith("```")) break;
        blockLines.push(next);
        j += 1;
      }
      const marker = "▌ ";
      const indent = " ".repeat(stringWidth(marker));
      for (let k = 0; k < blockLines.length; k++) {
        const tokens = parseBlockquoteInline(blockLines[k]!, theme);
        rendered.push(...flow(tokens, columns, marker, indent));
      }
      i = j;
      continue;
    }
    // GFM table: header row starting with `|`, next line is a separator.
    if (trimmed.startsWith("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1]!)) {
      const rows: string[][] = [];
      let j = i;
      while (j < lines.length && lines[j]!.trimStart().startsWith("|")) {
        rows.push(parseTableRow(lines[j]!));
        j += 1;
      }
      for (let r = 0; r < rows.length; r++) {
        if (r === 1) continue; // skip separator row
        const isHeader = r === 0;
        const cells = rows[r]!;
        const styledCells = cells.map((cell) => {
          const tokens = parseInline(cell, theme);
          const styled = tokens.map((t) =>
            applyStyle(t.text, isHeader ? { ...t.style, bold: true } : t.style),
          );
          return styled.join("");
        });
        rendered.push(styledCells.join(" │ "));
      }
      i = j;
      continue;
    }
    if (!trimmed) {
      rendered.push("");
      i += 1;
      continue;
    }
    const list = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(rawLine);
    if (list) {
      const indent = " ".repeat(Math.min(6, list[1]!.length));
      const marker = /^\d/.test(list[2]!) ? list[2]! : "•";
      const prefix = indent + marker + " ";
      const tokens = parseInline(list[3]!, theme);
      rendered.push(...flow(tokens, columns, prefix, " ".repeat(stringWidth(prefix))));
      i += 1;
      continue;
    }
    rendered.push(...flow(parseInline(rawLine, theme), columns));
    i += 1;
  }
  return rendered;
}

/**
 * Parse inline markdown tokens then recolor non-code, non-bold runs with the
 * theme's muted color so the entire blockquote reads as quoted material. Inline
 * code keeps its warning color; bold keeps its bold attribute but uses muted.
 */
function parseBlockquoteInline(text: string, theme: TuiTheme): MdToken[] {
  const tokens = parseInline(text, theme);
  return tokens.map((t) => {
    // Inline code retains its warning color.
    if (t.style.color === theme.warning) return t;
    // Everything else is muted.
    return { ...t, style: { ...t.style, color: theme.muted } };
  });
}

/** Match a GFM table separator row like `| --- | :---: | ---: |`. */
function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("-")) return false;
  // Allow optional leading/trailing pipe; cells are dashes with optional colons.
  const cellPattern = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  return cellPattern.test(trimmed);
}

/** Split a table row into trimmed cells (leading/trailing pipes stripped). */
function parseTableRow(line: string): string[] {
  const stripped = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return stripped.split("|").map((c) => c.trim());
}

function parseInline(text: string, theme: TuiTheme): MdToken[] {
  const tokens: MdToken[] = [];
  const plain: MdStyle = { color: theme.foreground };
  let last = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    if (match.index > last) tokens.push({ text: text.slice(last, match.index), style: plain });
    const whole = match[0]!;
    if (whole.startsWith("`")) {
      tokens.push({ text: whole.slice(1, -1), style: { color: theme.warning } });
    } else if (whole.startsWith("**")) {
      tokens.push({ text: whole.slice(2, -2), style: { color: theme.foreground, bold: true } });
    } else if (whole.startsWith("__")) {
      tokens.push({
        text: whole.slice(2, -2),
        style: { color: theme.foreground, underline: true },
      });
    } else if (whole.startsWith("~~")) {
      tokens.push({ text: whole.slice(2, -2), style: { color: theme.muted, dim: true } });
    } else if (whole.startsWith("*") || whole.startsWith("_")) {
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
  if (style.dim) open += "\u001b[2m";
  if (style.italic) open += "\u001b[3m";
  if (style.underline) open += "\u001b[4m";
  if (style.color !== undefined) {
    // Extract just the open sequence — `fg` returns open+text+close, we
    // strip the close and the text to reuse only the opening SGR.
    open += fg(style.color, "").slice(0, -"\u001b[39m".length);
  }
  if (style.background !== undefined) {
    open += bg(style.background, "").slice(0, -"\u001b[49m".length);
  }
  return open ? open + text + "\u001b[0m" : text;
}
