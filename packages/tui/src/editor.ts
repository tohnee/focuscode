import { segmentGraphemes } from "./width.js";

export interface EditorCursor {
  /** Logical line index. */
  row: number;
  /** Grapheme-cluster index within the row (NOT a UTF-16 offset), so CJK/emoji stay atomic. */
  col: number;
}

interface EditorSnapshot {
  lines: string[];
  cursor: EditorCursor;
}

const UNDO_LIMIT = 100;
const KILL_RING_LIMIT = 10;

/**
 * Multi-line input buffer for the TUI. Lines are stored as a string array and the
 * cursor column counts grapheme clusters (via Intl.Segmenter), which keeps wide
 * CJK characters and combined emoji from splitting under the cursor.
 */
export class EditorBuffer {
  private lines: string[] = [""];
  private cursor: EditorCursor = { row: 0, col: 0 };
  private undoStack: EditorSnapshot[] = [];
  private killRing: string[] = [];

  getText(): string {
    return this.lines.join("\n");
  }

  getLines(): readonly string[] {
    return this.lines;
  }

  getCursor(): EditorCursor {
    return { ...this.cursor };
  }

  setText(text: string): void {
    this.pushUndo();
    this.lines = text.split("\n");
    const last = this.lines.length - 1;
    this.cursor = { row: last, col: this.graphemes(this.lines[last]!).length };
  }

  clear(): void {
    this.pushUndo();
    this.lines = [""];
    this.cursor = { row: 0, col: 0 };
  }

  /** Insert text at the cursor, splitting on newlines (paste-safe). */
  insertText(text: string): void {
    if (!text) return;
    this.pushUndo();
    this.insertRaw(text.replaceAll("\r\n", "\n").replaceAll("\r", "\n"));
  }

  newline(): void {
    this.pushUndo();
    this.insertRaw("\n");
  }

  backspace(): void {
    if (this.cursor.row === 0 && this.cursor.col === 0) return;
    this.pushUndo();
    if (this.cursor.col > 0) {
      const line = this.currentLine();
      this.lines[this.cursor.row] =
        this.slice(line, 0, this.cursor.col - 1) + this.slice(line, this.cursor.col);
      this.cursor.col -= 1;
      return;
    }
    const previous = this.lines[this.cursor.row - 1]!;
    const removed = this.lines.splice(this.cursor.row, 1)[0]!;
    this.cursor = { row: this.cursor.row - 1, col: this.graphemes(previous).length };
    this.lines[this.cursor.row] = previous + removed;
  }

  /** Delete backwards to the previous whitespace boundary (readline ctrl+w). */
  deleteWordBackward(): void {
    if (this.cursor.row === 0 && this.cursor.col === 0) return;
    this.pushUndo();
    let { row, col } = this.cursor;
    while (col === 0 && row > 0) {
      const previous = this.lines[row - 1]!;
      const removed = this.lines.splice(row, 1)[0]!;
      this.lines[row - 1] = previous + removed;
      row -= 1;
      col = this.graphemes(previous).length;
    }
    const clusters = this.graphemes(this.lines[row]!);
    let start = col;
    while (start > 0 && /\s/.test(clusters[start - 1]!)) start -= 1;
    while (start > 0 && !/\s/.test(clusters[start - 1]!)) start -= 1;
    this.lines[row] = clusters.slice(0, start).join("") + clusters.slice(col).join("");
    this.cursor = { row, col: start };
  }

  cursorLeft(): void {
    if (this.cursor.col > 0) {
      this.cursor.col -= 1;
    } else if (this.cursor.row > 0) {
      this.cursor.row -= 1;
      this.cursor.col = this.graphemes(this.currentLine()).length;
    }
  }

  cursorRight(): void {
    if (this.cursor.col < this.graphemes(this.currentLine()).length) {
      this.cursor.col += 1;
    } else if (this.cursor.row < this.lines.length - 1) {
      this.cursor.row += 1;
      this.cursor.col = 0;
    }
  }

  cursorUp(): void {
    if (this.cursor.row === 0) return;
    this.cursor.row -= 1;
    this.cursor.col = Math.min(this.cursor.col, this.graphemes(this.currentLine()).length);
  }

  cursorDown(): void {
    if (this.cursor.row >= this.lines.length - 1) return;
    this.cursor.row += 1;
    this.cursor.col = Math.min(this.cursor.col, this.graphemes(this.currentLine()).length);
  }

  home(): void {
    this.cursor.col = 0;
  }

  end(): void {
    this.cursor.col = this.graphemes(this.currentLine()).length;
  }

  wordLeft(): void {
    let { row, col } = this.cursor;
    if (col === 0 && row > 0) {
      row -= 1;
      col = this.graphemes(this.lines[row]!).length;
    }
    const clusters = this.graphemes(this.lines[row]!);
    while (col > 0 && /\s/.test(clusters[col - 1]!)) col -= 1;
    while (col > 0 && !/\s/.test(clusters[col - 1]!)) col -= 1;
    this.cursor = { row, col };
  }

  wordRight(): void {
    let { row, col } = this.cursor;
    let clusters = this.graphemes(this.lines[row]!);
    if (col === clusters.length && row < this.lines.length - 1) {
      row += 1;
      col = 0;
      clusters = this.graphemes(this.lines[row]!);
    }
    while (col < clusters.length && /\s/.test(clusters[col]!)) col += 1;
    while (col < clusters.length && !/\s/.test(clusters[col]!)) col += 1;
    this.cursor = { row, col };
  }

  undo(): boolean {
    const snapshot = this.undoStack.pop();
    if (!snapshot) return false;
    this.lines = [...snapshot.lines];
    this.cursor = { ...snapshot.cursor };
    return true;
  }

  /** Kill from the cursor to end of line, or the newline itself at end of line. */
  killLine(): void {
    const line = this.currentLine();
    const length = this.graphemes(line).length;
    if (this.cursor.col < length) {
      const killed = this.slice(line, this.cursor.col);
      this.pushUndo();
      this.lines[this.cursor.row] = this.slice(line, 0, this.cursor.col);
      this.pushKill(killed);
      return;
    }
    if (this.cursor.row < this.lines.length - 1) {
      this.pushUndo();
      const removed = this.lines.splice(this.cursor.row + 1, 1)[0]!;
      this.lines[this.cursor.row] = line + removed;
      this.pushKill("\n");
    }
  }

  /**
   * Kill from the beginning of the line up to the cursor (readline ctrl+u).
   * The killed text is pushed onto the kill ring. No-op when the cursor is
   * already at column 0.
   */
  killToStart(): void {
    if (this.cursor.col === 0) return;
    const line = this.currentLine();
    const killed = this.slice(line, 0, this.cursor.col);
    this.pushUndo();
    this.lines[this.cursor.row] = this.slice(line, this.cursor.col);
    this.cursor.col = 0;
    this.pushKill(killed);
  }

  /**
   * Delete the grapheme at the cursor position (forward delete, vim x alias).
   * Unlike `deleteChar` (which is a vim x alias), this method is exposed under
   * a readline-friendly name for the Delete key binding. The cursor stays in
   * place. No-op at end of line.
   */
  deleteCharForward(): void {
    this.deleteChar();
  }

  /**
   * Upcase the word from the cursor to the end of the word (readline alt+u).
   * Whitespace before the word is skipped. The cursor advances to the end of
   * the upcased word.
   */
  upcaseWord(): void {
    this.transformWord((word) => word.toUpperCase());
  }

  /**
   * Downcase the word from the cursor to the end of the word (readline alt+l).
   * The cursor advances to the end of the downcased word.
   */
  downcaseWord(): void {
    this.transformWord((word) => word.toLowerCase());
  }

  /**
   * Capitalize the first letter of the word from the cursor and lowercase the
   * rest (readline alt+c). The cursor advances to the end of the capitalized
   * word.
   */
  capitalizeWord(): void {
    this.transformWord((word) => {
      if (!word) return word;
      return word[0]!.toUpperCase() + word.slice(1).toLowerCase();
    });
  }

  /**
   * Shared helper for word-case transformations (alt+u / alt+l / alt+c).
   * Skips leading whitespace, applies `fn` to the next non-whitespace run,
   * and advances the cursor to the end of the transformed region.
   */
  private transformWord(fn: (word: string) => string): void {
    const line = this.currentLine();
    const clusters = this.graphemes(line);
    if (this.cursor.col >= clusters.length) return;
    let start = this.cursor.col;
    while (start < clusters.length && /\s/.test(clusters[start]!)) start += 1;
    if (start >= clusters.length) return;
    let end = start;
    while (end < clusters.length && !/\s/.test(clusters[end]!)) end += 1;
    const word = clusters.slice(start, end).join("");
    const transformed = fn(word);
    this.pushUndo();
    this.lines[this.cursor.row] =
      clusters.slice(0, start).join("") + transformed + clusters.slice(end).join("");
    this.cursor.col = start + this.graphemes(transformed).length;
  }

  yank(): void {
    const text = this.killRing.at(-1);
    if (!text) return;
    this.insertText(text);
  }

  /** The unbroken non-whitespace word immediately before the cursor ("" when none). */
  wordBeforeCursor(): string {
    const before = this.slice(this.currentLine(), 0, this.cursor.col);
    return /[^\s]+$/.exec(before)?.[0] ?? "";
  }

  /** Replace `prefix` (expected right before the cursor) with `value`, atomically. */
  applyCompletion(prefix: string, value: string): void {
    const line = this.currentLine();
    const before = this.slice(line, 0, this.cursor.col);
    if (!before.endsWith(prefix)) return;
    this.pushUndo();
    const shortened = before.slice(0, before.length - prefix.length);
    this.lines[this.cursor.row] = shortened + this.slice(line, this.cursor.col);
    this.cursor.col = this.graphemes(shortened).length;
    this.insertRaw(value);
  }

  /** Set the cursor directly, clamping to valid bounds. Used by vim navigation. */
  setCursor(cursor: EditorCursor): void {
    const row = Math.max(0, Math.min(cursor.row, this.lines.length - 1));
    const maxCol = this.graphemes(this.lines[row]!).length;
    const col = Math.max(0, Math.min(cursor.col, maxCol));
    this.cursor = { row, col };
  }

  /** Return the text of a specific line (for vim yy/inspection). */
  getLineText(row: number): string {
    return this.lines[row] ?? "";
  }

  /** Replace the text of a specific line in place. */
  setLineText(row: number, text: string): void {
    if (row < 0 || row >= this.lines.length) return;
    this.pushUndo();
    this.lines[row] = text;
  }

  /** Delete the entire current line (vim dd). Cursor moves to the next line (or new last line). */
  deleteLine(): void {
    if (this.lines.length <= 1) {
      this.pushUndo();
      // Vim dd on the only line still saves it to the unnamed register.
      this.pushKill(this.lines[0]!);
      this.lines = [""];
      this.cursor = { row: 0, col: 0 };
      return;
    }
    this.pushUndo();
    // Vim dd yanks the deleted line into the unnamed register so p/P can paste.
    this.pushKill(this.lines[this.cursor.row]!);
    const wasLast = this.cursor.row === this.lines.length - 1;
    this.lines.splice(this.cursor.row, 1);
    if (wasLast) {
      this.cursor = { row: this.lines.length - 1, col: 0 };
    } else {
      this.cursor = { row: this.cursor.row, col: 0 };
    }
  }

  /** Yank the current line into the kill ring without deleting (vim yy). */
  yankLine(): void {
    const line = this.currentLine();
    this.pushKill(line);
  }

  /**
   * Paste the most recent kill-ring entry as a new line below the cursor (vim p).
   * If the kill-ring entry contains a newline, it is inserted as-is.
   */
  pasteAfter(): void {
    const text = this.killRing.at(-1);
    if (!text) return;
    this.pushUndo();
    const newLines = text.split("\n");
    this.lines.splice(this.cursor.row + 1, 0, ...newLines);
    this.cursor = { row: this.cursor.row + 1, col: 0 };
  }

  /** Delete the grapheme at the cursor position (vim x). Cursor stays in place. */
  deleteChar(): void {
    const line = this.currentLine();
    const clusters = this.graphemes(line);
    if (this.cursor.col >= clusters.length) return;
    this.pushUndo();
    this.lines[this.cursor.row] =
      clusters.slice(0, this.cursor.col).join("") + clusters.slice(this.cursor.col + 1).join("");
  }

  /** Move cursor to the first line, column 0 (vim gg). */
  gotoTop(): void {
    this.cursor = { row: 0, col: 0 };
  }

  /** Move cursor to the last line, column 0 (vim G). */
  gotoBottom(): void {
    this.cursor = { row: this.lines.length - 1, col: 0 };
  }

  /** Insert a new empty line below the cursor and move there (vim o). */
  appendNewlineBelow(): void {
    this.pushUndo();
    this.lines.splice(this.cursor.row + 1, 0, "");
    this.cursor = { row: this.cursor.row + 1, col: 0 };
  }

  /**
   * Paste the most recent kill-ring entry as a new line above the cursor (vim P).
   * Mirror of `pasteAfter()`: the pasted text is inserted at the current row,
   * pushing the current line down. The cursor moves to column 0 of the pasted
   * region (which now occupies the original cursor row).
   */
  pasteBefore(): void {
    const text = this.killRing.at(-1);
    if (!text) return;
    this.pushUndo();
    const newLines = text.split("\n");
    this.lines.splice(this.cursor.row, 0, ...newLines);
    this.cursor = { row: this.cursor.row, col: 0 };
  }

  /**
   * Insert a new empty line above the cursor and move there (vim O). Mirror of
   * `appendNewlineBelow()`: the new line is inserted at the current row, pushing
   * the current line down. The cursor lands on the new empty line.
   */
  newlineAbove(): void {
    this.pushUndo();
    this.lines.splice(this.cursor.row, 0, "");
    this.cursor = { row: this.cursor.row, col: 0 };
  }

  /**
   * Join the current line with the next line (vim J). Leading whitespace on the
   * next line is stripped. A single space is inserted between the two lines
   * unless the next line is empty (or all-whitespace) or the current line
   * already ends with whitespace. The cursor moves to the join point (the
   * column where the space was inserted, or the end of the current line when
   * no space is inserted). No-op on the last line.
   */
  joinLines(): void {
    if (this.cursor.row >= this.lines.length - 1) return;
    this.pushUndo();
    const current = this.lines[this.cursor.row]!;
    const next = this.lines[this.cursor.row + 1]!;
    const strippedNext = next.replace(/^\s+/, "");
    const currentEndsWithSpace = /\s$/.test(current);
    const joinCol = this.graphemes(current).length;
    let joined: string;
    if (strippedNext === "") {
      joined = current;
    } else if (currentEndsWithSpace) {
      joined = current + strippedNext;
    } else {
      joined = current + " " + strippedNext;
    }
    this.lines[this.cursor.row] = joined;
    this.lines.splice(this.cursor.row + 1, 1);
    this.cursor = { row: this.cursor.row, col: joinCol };
  }

  /**
   * Move the cursor to the end of the current word (vim e). If the cursor is
   * already at the end of a word, advance to the end of the next word. A
   * "word" is a maximal run of word characters (alphanumeric + underscore) or
   * a maximal run of non-word, non-whitespace characters. Whitespace is
   * skipped. No-op at the end of the buffer.
   */
  wordEndForward(): void {
    const line = this.currentLine();
    const clusters = this.graphemes(line);
    // At or past the last grapheme of this line: try to advance to the next line.
    if (this.cursor.col >= clusters.length - 1) {
      if (this.cursor.row < this.lines.length - 1) {
        this.cursor = { row: this.cursor.row + 1, col: 0 };
        this.wordEndForward();
      }
      return;
    }
    const isWordChar = (c: string) => /\w/.test(c);
    // Step forward one, then skip whitespace.
    let col = this.cursor.col + 1;
    while (col < clusters.length && /\s/.test(clusters[col]!)) col += 1;
    if (col >= clusters.length) {
      this.cursor = { row: this.cursor.row, col: clusters.length - 1 };
      return;
    }
    const wordType = isWordChar(clusters[col]!);
    while (
      col + 1 < clusters.length &&
      !/\s/.test(clusters[col + 1]!) &&
      isWordChar(clusters[col + 1]!) === wordType
    ) {
      col += 1;
    }
    this.cursor = { row: this.cursor.row, col };
  }

  /**
   * Replace the grapheme at the cursor with `replacement` (vim r). The cursor
   * stays at the replaced position for a single-character replacement; for a
   * multi-character replacement, the cursor moves to the end of the inserted
   * run. No-op at end of line.
   */
  replaceChar(replacement: string): void {
    const line = this.currentLine();
    const clusters = this.graphemes(line);
    if (this.cursor.col >= clusters.length) return;
    this.pushUndo();
    const before = clusters.slice(0, this.cursor.col).join("");
    const after = clusters.slice(this.cursor.col + 1).join("");
    this.lines[this.cursor.row] = before + replacement + after;
    this.cursor.col = this.cursor.col + this.graphemes(replacement).length - 1;
  }

  // ─── Vim extended operators ────────────────────────────────────────────

  /**
   * Delete from the cursor to the end of the current line (vim D). The deleted
   * text is pushed onto the kill ring so `p` can paste it back. No-op when the
   * cursor is already at end of line.
   */
  deleteToEndOfLine(): void {
    const line = this.currentLine();
    const length = this.graphemes(line).length;
    if (this.cursor.col >= length) return;
    const killed = this.slice(line, this.cursor.col);
    this.pushUndo();
    this.lines[this.cursor.row] = this.slice(line, 0, this.cursor.col);
    this.pushKill(killed);
  }

  /**
   * Delete one word forward from the cursor (vim dw). The deleted text is
   * pushed onto the kill ring. Whitespace between the cursor and the next word
   * is consumed along with the word, matching vim semantics.
   */
  deleteWordForward(): void {
    const line = this.currentLine();
    const clusters = this.graphemes(line);
    if (this.cursor.col >= clusters.length) return;
    this.pushUndo();
    let end = this.cursor.col;
    // Consume trailing whitespace first.
    while (end < clusters.length && /\s/.test(clusters[end]!)) end += 1;
    // Then consume the non-whitespace run.
    while (end < clusters.length && !/\s/.test(clusters[end]!)) end += 1;
    const killed = clusters.slice(this.cursor.col, end).join("");
    this.lines[this.cursor.row] =
      clusters.slice(0, this.cursor.col).join("") + clusters.slice(end).join("");
    this.pushKill(killed);
  }

  /**
   * Change the current line (vim cc): clear the line content but keep the line
   * itself, leaving the cursor at column 0. The host enters insert mode after
   * this call. The deleted content is pushed onto the kill ring.
   */
  changeLine(): void {
    const line = this.currentLine();
    if (line) this.pushKill(line);
    this.pushUndo();
    this.lines[this.cursor.row] = "";
    this.cursor = { row: this.cursor.row, col: 0 };
  }

  /**
   * Change one word forward from the cursor (vim cw): delete from the cursor
   * to the end of the current word (NOT including trailing whitespace, to match
   * vim's cw behavior). The host enters insert mode after this call.
   */
  changeWord(): void {
    const line = this.currentLine();
    const clusters = this.graphemes(line);
    if (this.cursor.col >= clusters.length) return;
    this.pushUndo();
    let end = this.cursor.col;
    // cw operates on the current word only, not trailing whitespace.
    if (/\s/.test(clusters[this.cursor.col]!)) {
      while (end < clusters.length && /\s/.test(clusters[end]!)) end += 1;
    } else {
      while (end < clusters.length && !/\s/.test(clusters[end]!)) end += 1;
    }
    const killed = clusters.slice(this.cursor.col, end).join("");
    this.lines[this.cursor.row] =
      clusters.slice(0, this.cursor.col).join("") + clusters.slice(end).join("");
    this.pushKill(killed);
  }

  /**
   * Toggle the case of the grapheme at the cursor and advance the cursor by
   * one (vim ~). No-op at end of line.
   */
  toggleCase(): void {
    const line = this.currentLine();
    const clusters = this.graphemes(line);
    if (this.cursor.col >= clusters.length) return;
    this.pushUndo();
    const ch = clusters[this.cursor.col]!;
    const toggled = toggleGraphemeCase(ch);
    this.lines[this.cursor.row] =
      clusters.slice(0, this.cursor.col).join("") +
      toggled +
      clusters.slice(this.cursor.col + 1).join("");
    this.cursor.col += 1;
  }

  /**
   * Delete the character-wise selection between `anchor` and the current
   * cursor (vim visual d/x). The selection spans across lines if needed. The
   * deleted text is pushed onto the kill ring. After deletion, the cursor
   * moves to the smaller of the two positions.
   */
  deleteSelection(anchor: EditorCursor): void {
    const cur = this.cursor;
    const [start, end] = orderCursors(anchor, cur);
    this.pushUndo();
    if (start.row === end.row) {
      const line = this.lines[start.row]!;
      const clusters = this.graphemes(line);
      const killed = clusters.slice(start.col, end.col).join("");
      this.lines[start.row] =
        clusters.slice(0, start.col).join("") + clusters.slice(end.col).join("");
      this.pushKill(killed);
      this.cursor = { row: start.row, col: start.col };
      return;
    }
    // Multi-line deletion: join the partial lines and remove middle lines.
    const firstLine = this.lines[start.row]!;
    const lastLine = this.lines[end.row]!;
    const firstClusters = this.graphemes(firstLine);
    const lastClusters = this.graphemes(lastLine);
    const killed =
      firstClusters.slice(start.col).join("") +
      "\n" +
      this.lines.slice(start.row + 1, end.row).join("\n") +
      (end.row > start.row + 1 ? "\n" : "") +
      lastClusters.slice(0, end.col).join("");
    const merged =
      firstClusters.slice(0, start.col).join("") + lastClusters.slice(end.col).join("");
    this.lines.splice(start.row, end.row - start.row + 1, merged);
    this.pushKill(killed);
    this.cursor = { row: start.row, col: start.col };
  }

  /**
   * Yank the character-wise selection between `anchor` and the current cursor
   * without deleting (vim visual y). The cursor moves to the start of the
   * selection.
   */
  yankSelection(anchor: EditorCursor): void {
    const cur = this.cursor;
    const [start, end] = orderCursors(anchor, cur);
    if (start.row === end.row) {
      const line = this.lines[start.row]!;
      const clusters = this.graphemes(line);
      this.pushKill(clusters.slice(start.col, end.col).join(""));
    } else {
      const parts: string[] = [];
      const firstLine = this.lines[start.row]!;
      parts.push(this.graphemes(firstLine).slice(start.col).join(""));
      for (let r = start.row + 1; r < end.row; r += 1) parts.push(this.lines[r]!);
      const lastLine = this.lines[end.row]!;
      parts.push(this.graphemes(lastLine).slice(0, end.col).join(""));
      this.pushKill(parts.join("\n"));
    }
    this.cursor = { row: start.row, col: start.col };
  }

  /**
   * Delete all lines spanned by the visual-line selection between `anchor` and
   * the current cursor (vim V+d). The deleted lines are pushed onto the kill
   * ring joined by newlines. The cursor moves to the first deleted line's
   * successor (or a new empty line if the buffer becomes empty).
   */
  deleteSelectionLines(anchor: EditorCursor): void {
    const cur = this.cursor;
    const [start, end] = orderRows(anchor, cur);
    this.pushUndo();
    const removed = this.lines.splice(start, end - start + 1);
    this.pushKill(removed.join("\n"));
    if (this.lines.length === 0) this.lines = [""];
    this.cursor = { row: Math.min(start, this.lines.length - 1), col: 0 };
  }

  /**
   * Yank all lines spanned by the visual-line selection between `anchor` and
   * the current cursor without deleting (vim V+y). The cursor moves to the
   * start row.
   */
  yankSelectionLines(anchor: EditorCursor): void {
    const cur = this.cursor;
    const [start, end] = orderRows(anchor, cur);
    const removed = this.lines.slice(start, end + 1);
    this.pushKill(removed.join("\n"));
    this.cursor = { row: start, col: 0 };
  }

  // ─── Text objects (diw, daw, ci", ca( etc.) ───────────────────────────

  /**
   * Delete a text object and push the deleted text onto the kill ring.
   * The cursor is placed at the start of the deleted region.
   */
  deleteTextObject(modifier: "i" | "a", target: string): void {
    const range = this.findTextObjectRange(modifier, target);
    if (!range) return;
    this.pushUndo();
    const line = this.lines[this.cursor.row]!;
    const clusters = this.graphemes(line);
    const killed = clusters.slice(range.start, range.end).join("");
    this.lines[this.cursor.row] =
      clusters.slice(0, range.start).join("") + clusters.slice(range.end).join("");
    this.pushKill(killed);
    this.cursor = { row: this.cursor.row, col: range.start };
  }

  /**
   * Yank a text object without deleting. The cursor moves to the start of
   * the yanked region.
   */
  yankTextObject(modifier: "i" | "a", target: string): void {
    const range = this.findTextObjectRange(modifier, target);
    if (!range) return;
    const line = this.lines[this.cursor.row]!;
    const clusters = this.graphemes(line);
    const yanked = clusters.slice(range.start, range.end).join("");
    this.pushKill(yanked);
    this.cursor = { row: this.cursor.row, col: range.start };
  }

  /**
   * Find the [start, end) grapheme-cluster range of a text object on the
   * current line. Returns `null` if the text object cannot be located.
   *
   * Word ("w"):
   *   inner — the word under the cursor (no surrounding whitespace).
   *   around — the word plus trailing whitespace (or leading if at EOL).
   *
   * Quotes ('"' "'" "`"):
   *   inner — content between the nearest pair of matching quotes.
   *   around — content + the quotes themselves.
   *
   * Brackets ("(" "{" "["):
   *   inner — content between the nearest enclosing bracket pair.
   *   around — content + the brackets.
   */
  private findTextObjectRange(
    modifier: "i" | "a",
    target: string,
  ): { start: number; end: number } | null {
    const line = this.currentLine();
    const clusters = this.graphemes(line);
    const col = this.cursor.col;

    if (target === "w") {
      return this.findWordRange(modifier, clusters, col);
    }
    if (target === '"' || target === "'" || target === "`") {
      return this.findQuoteRange(modifier, clusters, col, target);
    }
    if (target === "(" || target === "{" || target === "[") {
      return this.findBracketRange(modifier, clusters, col, target);
    }
    return null;
  }

  /** Find the range of the word under `col`. */
  private findWordRange(
    modifier: "i" | "a",
    clusters: string[],
    col: number,
  ): { start: number; end: number } | null {
    if (clusters.length === 0) return null;
    const isSpace = (c: string) => /\s/.test(c);
    // If cursor is on whitespace, skip to the next word.
    let wordStart = col;
    if (wordStart < clusters.length && isSpace(clusters[wordStart]!)) {
      while (wordStart < clusters.length && isSpace(clusters[wordStart]!)) wordStart += 1;
    } else {
      // Scan backward to find the start of the word.
      while (wordStart > 0 && !isSpace(clusters[wordStart - 1]!)) wordStart -= 1;
    }
    if (wordStart >= clusters.length) return null;
    // Scan forward to find the end of the word.
    let wordEnd = wordStart;
    while (wordEnd < clusters.length && !isSpace(clusters[wordEnd]!)) wordEnd += 1;
    if (modifier === "i") {
      return { start: wordStart, end: wordEnd };
    }
    // around: include trailing whitespace (or leading if at EOL).
    let aroundEnd = wordEnd;
    while (aroundEnd < clusters.length && isSpace(clusters[aroundEnd]!)) aroundEnd += 1;
    if (aroundEnd > wordEnd) {
      return { start: wordStart, end: aroundEnd };
    }
    // No trailing whitespace — include leading whitespace instead.
    let aroundStart = wordStart;
    while (aroundStart > 0 && isSpace(clusters[aroundStart - 1]!)) aroundStart -= 1;
    return { start: aroundStart, end: wordEnd };
  }

  /** Find the range of content between a matching pair of quote chars. */
  private findQuoteRange(
    modifier: "i" | "a",
    clusters: string[],
    col: number,
    quote: string,
  ): { start: number; end: number } | null {
    // Find the nearest quote at or before the cursor.
    let first = -1;
    for (let i = col; i >= 0; i -= 1) {
      if (clusters[i] === quote) {
        first = i;
        break;
      }
    }
    // If not found before, search after.
    if (first === -1) {
      for (let i = col + 1; i < clusters.length; i += 1) {
        if (clusters[i] === quote) {
          first = i;
          break;
        }
      }
    }
    if (first === -1) return null;
    // Find the matching closing quote.
    let second = -1;
    for (let i = first + 1; i < clusters.length; i += 1) {
      if (clusters[i] === quote) {
        second = i;
        break;
      }
    }
    if (second === -1) return null;
    if (modifier === "i") {
      return { start: first + 1, end: second };
    }
    return { start: first, end: second + 1 };
  }

  /** Find the range of content between a matching bracket pair. */
  private findBracketRange(
    modifier: "i" | "a",
    clusters: string[],
    col: number,
    open: string,
  ): { start: number; end: number } | null {
    const close = open === "(" ? ")" : open === "{" ? "}" : "]";

    // If cursor is on the opening bracket, that's our open — scan forward.
    if (clusters[col] === open) {
      const closePos = this.findMatchingClose(clusters, col, open, close);
      if (closePos === -1) return null;
      return modifier === "i"
        ? { start: col + 1, end: closePos }
        : { start: col, end: closePos + 1 };
    }
    // If cursor is on the closing bracket, that's our close — scan backward.
    if (clusters[col] === close) {
      const openPos = this.findMatchingOpen(clusters, col, open, close);
      if (openPos === -1) return null;
      return modifier === "i" ? { start: openPos + 1, end: col } : { start: openPos, end: col + 1 };
    }
    // Otherwise: scan backward for the enclosing open (tracking depth so
    // nested pairs are skipped), then forward for the matching close.
    const openPos = this.findEnclosingOpen(clusters, col, open, close);
    if (openPos === -1) return null;
    const closePos = this.findMatchingClose(clusters, openPos, open, close);
    if (closePos === -1) return null;
    return modifier === "i"
      ? { start: openPos + 1, end: closePos }
      : { start: openPos, end: closePos + 1 };
  }

  /** Scan forward from an opening bracket to find its matching close. */
  private findMatchingClose(
    clusters: string[],
    openPos: number,
    open: string,
    close: string,
  ): number {
    let depth = 0;
    for (let i = openPos + 1; i < clusters.length; i += 1) {
      if (clusters[i] === open) depth += 1;
      else if (clusters[i] === close) {
        if (depth === 0) return i;
        depth -= 1;
      }
    }
    return -1;
  }

  /** Scan backward from a closing bracket to find its matching open. */
  private findMatchingOpen(
    clusters: string[],
    closePos: number,
    open: string,
    close: string,
  ): number {
    let depth = 0;
    for (let i = closePos - 1; i >= 0; i -= 1) {
      if (clusters[i] === open) {
        if (depth === 0) return i;
        depth -= 1;
      } else if (clusters[i] === close) {
        depth += 1;
      }
    }
    return -1;
  }

  /** Scan backward from `col` to find the nearest enclosing opening bracket. */
  private findEnclosingOpen(clusters: string[], col: number, open: string, close: string): number {
    let depth = 0;
    for (let i = col; i >= 0; i -= 1) {
      if (clusters[i] === close) depth += 1;
      else if (clusters[i] === open) {
        if (depth === 0) return i;
        depth -= 1;
      }
    }
    return -1;
  }

  private insertRaw(text: string): void {
    const parts = text.split("\n");
    const line = this.currentLine();
    const before = this.slice(line, 0, this.cursor.col);
    const after = this.slice(line, this.cursor.col);
    if (parts.length === 1) {
      this.lines[this.cursor.row] = before + parts[0]! + after;
      this.cursor.col += this.graphemes(parts[0]!).length;
      return;
    }
    const inserted = [before + parts[0]!, ...parts.slice(1, -1), parts.at(-1)! + after];
    this.lines.splice(this.cursor.row, 1, ...inserted);
    this.cursor = {
      row: this.cursor.row + inserted.length - 1,
      col: this.graphemes(parts.at(-1)!).length,
    };
  }

  private pushUndo(): void {
    this.undoStack.push({ lines: [...this.lines], cursor: { ...this.cursor } });
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
  }

  private pushKill(text: string): void {
    this.killRing.push(text);
    if (this.killRing.length > KILL_RING_LIMIT) this.killRing.shift();
  }

  private currentLine(): string {
    return this.lines[this.cursor.row]!;
  }

  private graphemes(text: string): string[] {
    return segmentGraphemes(text);
  }

  private slice(text: string, start: number, end?: number): string {
    return this.graphemes(text).slice(start, end).join("");
  }
}

// ─── Free functions for cursor/row ordering and case toggling ──────────────

/**
 * Return the two cursors in document order (smaller first). When both cursors
 * share a row, the smaller column is "smaller". Used by visual selection
 * operations so the host does not have to pre-sort anchor vs. cursor.
 */
function orderCursors(a: EditorCursor, b: EditorCursor): [EditorCursor, EditorCursor] {
  if (a.row < b.row) return [a, b];
  if (a.row > b.row) return [b, a];
  if (a.col <= b.col) return [a, b];
  return [b, a];
}

/** Return [minRow, maxRow] of two cursors for visual-line operations. */
function orderRows(a: EditorCursor, b: EditorCursor): [number, number] {
  return a.row <= b.row ? [a.row, b.row] : [b.row, a.row];
}

/**
 * Toggle the case of a single grapheme cluster: lowercase → uppercase,
 * uppercase → lowercase, other characters unchanged. ASCII-fast path covers
 * the common case; non-ASCII clusters pass through unchanged because their
 * case rules are locale-dependent.
 */
function toggleGraphemeCase(ch: string): string {
  if (ch.length === 1) {
    const cp = ch.charCodeAt(0);
    if (cp >= 65 && cp <= 90) return ch.toLowerCase();
    if (cp >= 97 && cp <= 122) return ch.toUpperCase();
  }
  return ch;
}
