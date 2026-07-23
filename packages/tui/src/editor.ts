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
  deleteWord(): void {
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
