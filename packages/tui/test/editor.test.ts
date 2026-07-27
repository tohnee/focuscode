import { describe, expect, it } from "vitest";
import { EditorBuffer } from "../src/editor.js";

describe("EditorBuffer — existing behavior (regression guard)", () => {
  it("inserts text and reads it back", () => {
    const buf = new EditorBuffer();
    buf.insertText("hello");
    expect(buf.getText()).toBe("hello");
  });

  it("splits on newline insertion", () => {
    const buf = new EditorBuffer();
    buf.insertText("a\nb");
    expect(buf.getLines()).toEqual(["a", "b"]);
  });
});

describe("EditorBuffer.deleteLine (vim dd)", () => {
  it("deletes the current line and moves cursor to next line start", () => {
    const buf = new EditorBuffer();
    buf.setText("line1\nline2\nline3");
    buf.setCursor({ row: 1, col: 0 });
    buf.deleteLine();
    expect(buf.getLines()).toEqual(["line1", "line3"]);
    expect(buf.getCursor()).toEqual({ row: 1, col: 0 });
  });

  it("deletes the only line and leaves an empty buffer", () => {
    const buf = new EditorBuffer();
    buf.setText("only");
    buf.setCursor({ row: 0, col: 0 });
    buf.deleteLine();
    expect(buf.getLines()).toEqual([""]);
    expect(buf.getCursor()).toEqual({ row: 0, col: 0 });
  });

  it("deletes the last line and moves cursor to new last line", () => {
    const buf = new EditorBuffer();
    buf.setText("a\nb\nc");
    buf.setCursor({ row: 2, col: 0 });
    buf.deleteLine();
    expect(buf.getLines()).toEqual(["a", "b"]);
    expect(buf.getCursor()).toEqual({ row: 1, col: 0 });
  });
});

describe("EditorBuffer.yankLine (vim yy)", () => {
  it("copies current line to kill ring without deleting", () => {
    const buf = new EditorBuffer();
    buf.setText("foo\nbar\nbaz");
    buf.setCursor({ row: 1, col: 0 });
    buf.yankLine();
    expect(buf.getLines()).toEqual(["foo", "bar", "baz"]);
    buf.setCursor({ row: 0, col: 0 });
    buf.yank();
    expect(buf.getText()).toBe("barfoo\nbar\nbaz");
  });
});

describe("EditorBuffer.pasteAfter (vim p)", () => {
  it("pastes kill-ring content on a new line below cursor", () => {
    const buf = new EditorBuffer();
    buf.setText("line1\nline2\nline3");
    buf.setCursor({ row: 0, col: 0 });
    buf.yankLine();
    buf.setCursor({ row: 2, col: 0 });
    buf.pasteAfter();
    expect(buf.getLines()).toEqual(["line1", "line2", "line3", "line1"]);
  });
});

describe("EditorBuffer.deleteChar (vim x)", () => {
  it("deletes character at cursor and stays in place", () => {
    const buf = new EditorBuffer();
    buf.setText("hello");
    buf.setCursor({ row: 0, col: 2 });
    buf.deleteChar();
    expect(buf.getText()).toBe("helo");
    expect(buf.getCursor()).toEqual({ row: 0, col: 2 });
  });

  it("does nothing at end of line", () => {
    const buf = new EditorBuffer();
    buf.setText("hi");
    buf.setCursor({ row: 0, col: 2 });
    buf.deleteChar();
    expect(buf.getText()).toBe("hi");
    expect(buf.getCursor()).toEqual({ row: 0, col: 2 });
  });
});

describe("EditorBuffer.gotoTop (vim gg)", () => {
  it("moves cursor to first line, column 0", () => {
    const buf = new EditorBuffer();
    buf.setText("a\nb\nc");
    buf.setCursor({ row: 2, col: 1 });
    buf.gotoTop();
    expect(buf.getCursor()).toEqual({ row: 0, col: 0 });
  });
});

describe("EditorBuffer.gotoBottom (vim G)", () => {
  it("moves cursor to last line, column 0", () => {
    const buf = new EditorBuffer();
    buf.setText("a\nb\nc");
    buf.setCursor({ row: 0, col: 0 });
    buf.gotoBottom();
    expect(buf.getCursor()).toEqual({ row: 2, col: 0 });
  });
});

describe("EditorBuffer.setCursor", () => {
  it("sets cursor position directly", () => {
    const buf = new EditorBuffer();
    buf.setText("hello\nworld");
    buf.setCursor({ row: 1, col: 3 });
    expect(buf.getCursor()).toEqual({ row: 1, col: 3 });
  });

  it("clamps row to valid range", () => {
    const buf = new EditorBuffer();
    buf.setText("a\nb");
    buf.setCursor({ row: 99, col: 0 });
    expect(buf.getCursor().row).toBe(1);
  });
});

describe("EditorBuffer.appendNewlineBelow (vim o)", () => {
  it("creates a new line below cursor and moves there", () => {
    const buf = new EditorBuffer();
    buf.setText("line1\nline2");
    buf.setCursor({ row: 0, col: 3 });
    buf.appendNewlineBelow();
    expect(buf.getLines()).toEqual(["line1", "", "line2"]);
    expect(buf.getCursor()).toEqual({ row: 1, col: 0 });
  });
});

// ─── Text objects (diw, daw, ci", ca( etc.) ──────────────────────────────────

describe("EditorBuffer.deleteTextObject — word (diw/daw)", () => {
  it("diw deletes the inner word under cursor", () => {
    const buf = new EditorBuffer();
    buf.setText("hello world foo");
    buf.setCursor({ row: 0, col: 6 });
    buf.deleteTextObject("i", "w");
    expect(buf.getText()).toBe("hello  foo");
    expect(buf.getCursor()).toEqual({ row: 0, col: 6 });
  });

  it("diw deletes a word from cursor at start", () => {
    const buf = new EditorBuffer();
    buf.setText("hello world");
    buf.setCursor({ row: 0, col: 0 });
    buf.deleteTextObject("i", "w");
    expect(buf.getText()).toBe(" world");
  });

  it("daw deletes word plus trailing whitespace", () => {
    const buf = new EditorBuffer();
    buf.setText("hello world foo");
    buf.setCursor({ row: 0, col: 0 });
    buf.deleteTextObject("a", "w");
    expect(buf.getText()).toBe("world foo");
  });

  it("daw deletes word plus leading whitespace when at EOL", () => {
    const buf = new EditorBuffer();
    buf.setText("hello world");
    buf.setCursor({ row: 0, col: 6 });
    buf.deleteTextObject("a", "w");
    // "world" is the last word — leading whitespace is consumed.
    expect(buf.getText()).toBe("hello");
  });

  it("diw on cursor at whitespace skips to next word", () => {
    const buf = new EditorBuffer();
    buf.setText("a   b");
    buf.setCursor({ row: 0, col: 1 });
    buf.deleteTextObject("i", "w");
    expect(buf.getText()).toBe("a   ");
  });

  it("diw is a no-op on an empty line", () => {
    const buf = new EditorBuffer();
    buf.setText("");
    buf.deleteTextObject("i", "w");
    expect(buf.getText()).toBe("");
  });
});

describe("EditorBuffer.yankTextObject — word (yiw)", () => {
  it("yiw yanks the inner word without deleting", () => {
    const buf = new EditorBuffer();
    buf.setText("hello world");
    buf.setCursor({ row: 0, col: 6 });
    buf.yankTextObject("i", "w");
    expect(buf.getText()).toBe("hello world");
    expect(buf.getCursor()).toEqual({ row: 0, col: 6 });
  });
});

describe('EditorBuffer.deleteTextObject — quotes (di"/da")', () => {
  it('di" deletes content inside double quotes', () => {
    const buf = new EditorBuffer();
    buf.setText('say "hello" now');
    buf.setCursor({ row: 0, col: 6 });
    buf.deleteTextObject("i", '"');
    expect(buf.getText()).toBe('say "" now');
  });

  it('da" deletes content and the quotes', () => {
    const buf = new EditorBuffer();
    buf.setText('say "hello" now');
    buf.setCursor({ row: 0, col: 6 });
    buf.deleteTextObject("a", '"');
    expect(buf.getText()).toBe("say  now");
  });

  it('di" with cursor before opening quote finds the quote pair', () => {
    const buf = new EditorBuffer();
    buf.setText('say "hello" now');
    buf.setCursor({ row: 0, col: 0 });
    buf.deleteTextObject("i", '"');
    expect(buf.getText()).toBe('say "" now');
  });

  it("di' deletes content inside single quotes", () => {
    const buf = new EditorBuffer();
    buf.setText("say 'hi' now");
    buf.setCursor({ row: 0, col: 5 });
    buf.deleteTextObject("i", "'");
    expect(buf.getText()).toBe("say '' now");
  });

  it('di" is a no-op when no closing quote exists', () => {
    const buf = new EditorBuffer();
    buf.setText('say "hello');
    buf.setCursor({ row: 0, col: 5 });
    buf.deleteTextObject("i", '"');
    expect(buf.getText()).toBe('say "hello');
  });
});

describe("EditorBuffer.deleteTextObject — brackets (di(/ca{)", () => {
  it("di( deletes content inside parentheses", () => {
    const buf = new EditorBuffer();
    buf.setText("foo(bar)baz");
    buf.setCursor({ row: 0, col: 4 });
    buf.deleteTextObject("i", "(");
    expect(buf.getText()).toBe("foo()baz");
  });

  it("ca( deletes content and the parentheses", () => {
    const buf = new EditorBuffer();
    buf.setText("foo(bar)baz");
    buf.setCursor({ row: 0, col: 4 });
    buf.deleteTextObject("a", "(");
    expect(buf.getText()).toBe("foobaz");
  });

  it("di) also works using closing paren", () => {
    const buf = new EditorBuffer();
    buf.setText("foo(bar)baz");
    buf.setCursor({ row: 0, col: 7 });
    buf.deleteTextObject("i", "(");
    expect(buf.getText()).toBe("foo()baz");
  });

  it("da{ deletes curly braces with content", () => {
    const buf = new EditorBuffer();
    buf.setText("x{ y }z");
    buf.setCursor({ row: 0, col: 3 });
    buf.deleteTextObject("a", "{");
    expect(buf.getText()).toBe("xz");
  });

  it("di( handles nested parens", () => {
    const buf = new EditorBuffer();
    buf.setText("foo(a(b)c)");
    buf.setCursor({ row: 0, col: 6 });
    buf.deleteTextObject("i", "(");
    // Cursor at "b" — inner paren pair is (b)
    expect(buf.getText()).toBe("foo(a()c)");
  });

  it("di( is a no-op when no opening paren found", () => {
    const buf = new EditorBuffer();
    buf.setText("foo bar");
    buf.setCursor({ row: 0, col: 0 });
    buf.deleteTextObject("i", "(");
    expect(buf.getText()).toBe("foo bar");
  });
});

describe("EditorBuffer.killToStart (readline ctrl+u)", () => {
  it("kills from cursor to beginning of line and pushes to kill ring", () => {
    const buf = new EditorBuffer();
    buf.setText("hello world");
    buf.setCursor({ row: 0, col: 5 });
    buf.killToStart();
    expect(buf.getText()).toBe(" world");
    expect(buf.getCursor()).toEqual({ row: 0, col: 0 });
    // yank should restore the killed text
    buf.yank();
    expect(buf.getText()).toBe("hello world");
  });

  it("is a no-op when cursor is at column 0", () => {
    const buf = new EditorBuffer();
    buf.setText("hello");
    buf.setCursor({ row: 0, col: 0 });
    buf.killToStart();
    expect(buf.getText()).toBe("hello");
  });

  it("kills entire line content when cursor at end", () => {
    const buf = new EditorBuffer();
    buf.setText("abcdef");
    buf.setCursor({ row: 0, col: 6 });
    buf.killToStart();
    expect(buf.getText()).toBe("");
    expect(buf.getCursor()).toEqual({ row: 0, col: 0 });
  });
});

describe("EditorBuffer.upcaseWord (readline alt+u)", () => {
  it("upcases the word from cursor to end of word", () => {
    const buf = new EditorBuffer();
    buf.setText("hello world");
    buf.setCursor({ row: 0, col: 0 });
    buf.upcaseWord();
    expect(buf.getText()).toBe("HELLO world");
    // cursor moves to end of upcased word
    expect(buf.getCursor()).toEqual({ row: 0, col: 5 });
  });

  it("skips leading whitespace before upcasing", () => {
    const buf = new EditorBuffer();
    buf.setText("   hello world");
    buf.setCursor({ row: 0, col: 0 });
    buf.upcaseWord();
    expect(buf.getText()).toBe("   HELLO world");
    expect(buf.getCursor()).toEqual({ row: 0, col: 8 });
  });

  it("upcases only the current word, not subsequent words", () => {
    const buf = new EditorBuffer();
    buf.setText("foo bar baz");
    buf.setCursor({ row: 0, col: 4 });
    buf.upcaseWord();
    expect(buf.getText()).toBe("foo BAR baz");
  });
});

describe("EditorBuffer.downcaseWord (readline alt+l)", () => {
  it("lowercases the word from cursor to end of word", () => {
    const buf = new EditorBuffer();
    buf.setText("HELLO WORLD");
    buf.setCursor({ row: 0, col: 0 });
    buf.downcaseWord();
    expect(buf.getText()).toBe("hello WORLD");
    expect(buf.getCursor()).toEqual({ row: 0, col: 5 });
  });

  it("lowercases only the current word", () => {
    const buf = new EditorBuffer();
    buf.setText("FOO BAR BAZ");
    buf.setCursor({ row: 0, col: 4 });
    buf.downcaseWord();
    expect(buf.getText()).toBe("FOO bar BAZ");
  });
});

describe("EditorBuffer.capitalizeWord (readline alt+c)", () => {
  it("capitalizes first letter and lowercases rest, then moves to end of word", () => {
    const buf = new EditorBuffer();
    buf.setText("hello world");
    buf.setCursor({ row: 0, col: 0 });
    buf.capitalizeWord();
    expect(buf.getText()).toBe("Hello world");
    expect(buf.getCursor()).toEqual({ row: 0, col: 5 });
  });

  it("capitalizes a fully lowercase word", () => {
    const buf = new EditorBuffer();
    buf.setText("foo bar");
    buf.setCursor({ row: 0, col: 4 });
    buf.capitalizeWord();
    expect(buf.getText()).toBe("foo Bar");
  });

  it("lowercases the rest of an all-caps word", () => {
    const buf = new EditorBuffer();
    buf.setText("HELLO world");
    buf.setCursor({ row: 0, col: 0 });
    buf.capitalizeWord();
    expect(buf.getText()).toBe("Hello world");
  });
});

describe("EditorBuffer.deleteCharForward (readline Delete key)", () => {
  it("deletes the grapheme at cursor position without moving cursor", () => {
    const buf = new EditorBuffer();
    buf.setText("hello");
    buf.setCursor({ row: 0, col: 1 });
    buf.deleteCharForward();
    expect(buf.getText()).toBe("hllo");
    expect(buf.getCursor()).toEqual({ row: 0, col: 1 });
  });

  it("is a no-op when cursor is at end of line", () => {
    const buf = new EditorBuffer();
    buf.setText("abc");
    buf.setCursor({ row: 0, col: 3 });
    buf.deleteCharForward();
    expect(buf.getText()).toBe("abc");
  });

  it("handles multi-byte characters (CJK)", () => {
    const buf = new EditorBuffer();
    buf.setText("你好世界");
    buf.setCursor({ row: 0, col: 1 });
    buf.deleteCharForward();
    expect(buf.getText()).toBe("你世界");
    expect(buf.getCursor()).toEqual({ row: 0, col: 1 });
  });
});

// ─── Batch 2: high-frequency vim operations ────────────────────────────────

describe("EditorBuffer.pasteBefore (vim P)", () => {
  it("pastes kill-ring content on a new line above cursor", () => {
    const buf = new EditorBuffer();
    buf.setText("line1\nline2\nline3");
    buf.setCursor({ row: 0, col: 0 });
    buf.yankLine(); // kill-ring = ["line1"]
    buf.setCursor({ row: 2, col: 0 });
    buf.pasteBefore();
    expect(buf.getLines()).toEqual(["line1", "line2", "line1", "line3"]);
    expect(buf.getCursor()).toEqual({ row: 2, col: 0 });
  });

  it("is a no-op when kill ring is empty", () => {
    const buf = new EditorBuffer();
    buf.setText("abc");
    buf.setCursor({ row: 0, col: 1 });
    buf.pasteBefore();
    expect(buf.getText()).toBe("abc");
  });

  it("pastes multi-line kill-ring content above cursor", () => {
    const buf = new EditorBuffer();
    buf.setText("header\nbody");
    buf.setCursor({ row: 0, col: 0 });
    buf.deleteLine(); // removes "header", kill-ring = ["header"]
    buf.setCursor({ row: 0, col: 0 }); // on "body"
    buf.pasteBefore();
    expect(buf.getLines()).toEqual(["header", "body"]);
  });
});

describe("EditorBuffer.newlineAbove (vim O)", () => {
  it("inserts an empty line above cursor and moves there", () => {
    const buf = new EditorBuffer();
    buf.setText("line1\nline2");
    buf.setCursor({ row: 1, col: 3 });
    buf.newlineAbove();
    expect(buf.getLines()).toEqual(["line1", "", "line2"]);
    expect(buf.getCursor()).toEqual({ row: 1, col: 0 });
  });

  it("inserts above the first line", () => {
    const buf = new EditorBuffer();
    buf.setText("only");
    buf.setCursor({ row: 0, col: 2 });
    buf.newlineAbove();
    expect(buf.getLines()).toEqual(["", "only"]);
    expect(buf.getCursor()).toEqual({ row: 0, col: 0 });
  });
});

describe("EditorBuffer.joinLines (vim J)", () => {
  it("joins current line with next, separated by a single space", () => {
    const buf = new EditorBuffer();
    buf.setText("hello\nworld");
    buf.setCursor({ row: 0, col: 2 });
    buf.joinLines();
    expect(buf.getText()).toBe("hello world");
    expect(buf.getCursor()).toEqual({ row: 0, col: 5 }); // at the join point
  });

  it("strips leading whitespace on the joined line", () => {
    const buf = new EditorBuffer();
    buf.setText("foo\n    bar");
    buf.setCursor({ row: 0, col: 0 });
    buf.joinLines();
    expect(buf.getText()).toBe("foo bar");
  });

  it("is a no-op on the last line", () => {
    const buf = new EditorBuffer();
    buf.setText("a\nb");
    buf.setCursor({ row: 1, col: 0 });
    buf.joinLines();
    expect(buf.getText()).toBe("a\nb");
  });

  it("joins empty next line without inserting extra space", () => {
    const buf = new EditorBuffer();
    buf.setText("foo\n");
    buf.setCursor({ row: 0, col: 0 });
    buf.joinLines();
    expect(buf.getText()).toBe("foo");
  });
});

describe("EditorBuffer.wordEndForward (vim e)", () => {
  it("moves to end of current word", () => {
    const buf = new EditorBuffer();
    buf.setText("hello world");
    buf.setCursor({ row: 0, col: 0 });
    buf.wordEndForward();
    expect(buf.getCursor()).toEqual({ row: 0, col: 4 }); // 'o' of 'hello'
  });

  it("advances to end of next word when already at word end", () => {
    const buf = new EditorBuffer();
    buf.setText("hello world");
    buf.setCursor({ row: 0, col: 4 });
    buf.wordEndForward();
    expect(buf.getCursor()).toEqual({ row: 0, col: 10 }); // 'd' of 'world'
  });

  it("skips whitespace before the next word", () => {
    const buf = new EditorBuffer();
    buf.setText("foo   bar");
    buf.setCursor({ row: 0, col: 2 });
    buf.wordEndForward();
    expect(buf.getCursor()).toEqual({ row: 0, col: 8 }); // 'r' of 'bar'
  });

  it("stops at end of buffer", () => {
    const buf = new EditorBuffer();
    buf.setText("abc");
    buf.setCursor({ row: 0, col: 0 });
    buf.wordEndForward();
    buf.wordEndForward(); // already at last char
    expect(buf.getCursor()).toEqual({ row: 0, col: 2 });
  });
});

describe("EditorBuffer.replaceChar (vim r)", () => {
  it("replaces the grapheme at cursor and stays in place", () => {
    const buf = new EditorBuffer();
    buf.setText("hello");
    buf.setCursor({ row: 0, col: 0 });
    buf.replaceChar("X");
    expect(buf.getText()).toBe("Xello");
    expect(buf.getCursor()).toEqual({ row: 0, col: 0 });
  });

  it("replaces a CJK grapheme atomically", () => {
    const buf = new EditorBuffer();
    buf.setText("你好");
    buf.setCursor({ row: 0, col: 1 });
    buf.replaceChar("X");
    expect(buf.getText()).toBe("你X");
    expect(buf.getCursor()).toEqual({ row: 0, col: 1 });
  });

  it("is a no-op at end of line", () => {
    const buf = new EditorBuffer();
    buf.setText("abc");
    buf.setCursor({ row: 0, col: 3 });
    buf.replaceChar("X");
    expect(buf.getText()).toBe("abc");
  });

  it("handles multi-grapheme replacement string (vim r with multi-char)", () => {
    const buf = new EditorBuffer();
    buf.setText("abc");
    buf.setCursor({ row: 0, col: 1 });
    buf.replaceChar("XYZ");
    expect(buf.getText()).toBe("aXYZc");
    expect(buf.getCursor()).toEqual({ row: 0, col: 3 }); // end of inserted run
  });
});
