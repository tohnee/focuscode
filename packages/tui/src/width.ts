const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Split a string into user-perceived grapheme clusters (keeps ZWJ emoji and CJK intact). */
export function segmentGraphemes(value: string): string[] {
  const clusters: string[] = [];
  for (const part of GRAPHEME_SEGMENTER.segment(value)) clusters.push(part.segment);
  return clusters;
}

/**
 * Approximate East Asian Wide/Fullwidth detection. This is intentionally a compact
 * approximation of UAX #11 rather than the full table: it covers the ranges terminals
 * almost always render double-width (CJK ideographs, Hiragana/Katakana, Hangul
 * syllables/jamo, fullwidth forms and the common emoji blocks). Ambiguous-width
 * symbols such as box drawing characters, ♡ or ★ are treated as narrow.
 */
export function charWidth(codePoint: number): number {
  return (codePoint >= 0x1100 && codePoint <= 0x115f) || // Hangul Jamo
    (codePoint >= 0x2e80 && codePoint <= 0x33ff) || // CJK radicals, punctuation, kana, enclosed CJK
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) || // CJK Unified Extension A
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) || // CJK Unified Ideographs
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) || // Yi syllables
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) || // Hangul syllables
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK compatibility ideographs
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) || // CJK compatibility forms
    (codePoint >= 0xff01 && codePoint <= 0xff60) || // Fullwidth forms
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) || // Fullwidth signs
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) || // Emoji blocks (approximate)
    (codePoint >= 0x20000 && codePoint <= 0x3fffd) // CJK Unified Extension B+
    ? 2
    : 1;
}

/** Display width of a plain string in terminal columns. */
export function stringWidth(value: string): number {
  let width = 0;
  for (const char of value) width += charWidth(char.codePointAt(0)!);
  return width;
}

export function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

/** Remove terminal control sequences and control characters from untrusted text. */
export function sanitizeTerminalText(value: string): string {
  return value
    .replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)?)/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

/** Take as many leading code points of a plain string as fit into `width` columns. */
export function takeWidth(value: string, width: number): string {
  let used = 0;
  let result = "";
  for (const char of value) {
    const cell = charWidth(char.codePointAt(0)!);
    if (used + cell > width) break;
    used += cell;
    result += char;
  }
  return result;
}

/** Truncate a string that may contain SGR sequences, preserving them and appending a reset. */
export function truncateAnsi(value: string, width: number): string {
  if (stringWidth(stripAnsi(value)) <= width) return value;
  let result = "";
  let used = 0;
  let index = 0;
  while (index < value.length) {
    const escape = /^\u001b\[[0-9;]*m/.exec(value.slice(index));
    if (escape) {
      result += escape[0];
      index += escape[0].length;
      continue;
    }
    const point = value.codePointAt(index)!;
    const cell = charWidth(point);
    if (used + cell > width) break;
    result += String.fromCodePoint(point);
    used += cell;
    index += point > 0xffff ? 2 : 1;
  }
  return result + "\u001b[0m";
}
