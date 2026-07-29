import { describe, expect, it } from "vitest";
import { parseTerminalInput, type ParsedKey, type TuiKeymap } from "../src/keymap.js";

describe("鼠标支持 - SGR 鼠标序列识别", () => {
  const keymap: TuiKeymap = {};

  it("recognizes SGR mouse press (left button)", () => {
    // SGR mouse: \u001b[<0;10;5M = left press at column 10, row 5
    const input = "\u001b[<0;10;5M";
    const parsed = parseTerminalInput(input, keymap);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.type).toBe("mouse");
    if (parsed[0]!.type === "mouse") {
      expect(parsed[0]!.event).toBe("press");
      expect(parsed[0]!.button).toBe("left");
      expect(parsed[0]!.column).toBe(10);
      expect(parsed[0]!.row).toBe(5);
    }
  });

  it("recognizes SGR mouse release (left button)", () => {
    // SGR mouse: \u001b[<0;10;5m = left release at column 10, row 5
    const input = "\u001b[<0;10;5m";
    const parsed = parseTerminalInput(input, keymap);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.type).toBe("mouse");
    if (parsed[0]!.type === "mouse") {
      expect(parsed[0]!.event).toBe("release");
      expect(parsed[0]!.button).toBe("left");
    }
  });

  it("recognizes SGR mouse press (middle button)", () => {
    // SGR mouse: \u001b[<1;10;5M = middle press
    const input = "\u001b[<1;10;5M";
    const parsed = parseTerminalInput(input, keymap);
    expect(parsed[0]!.type).toBe("mouse");
    if (parsed[0]!.type === "mouse") {
      expect(parsed[0]!.button).toBe("middle");
    }
  });

  it("recognizes SGR mouse press (right button)", () => {
    // SGR mouse: \u001b[<2;10;5M = right press
    const input = "\u001b[<2;10;5M";
    const parsed = parseTerminalInput(input, keymap);
    expect(parsed[0]!.type).toBe("mouse");
    if (parsed[0]!.type === "mouse") {
      expect(parsed[0]!.button).toBe("right");
    }
  });

  it("recognizes SGR mouse scroll (up)", () => {
    // SGR mouse: \u001b[<64;10;5M = scroll up
    const input = "\u001b[<64;10;5M";
    const parsed = parseTerminalInput(input, keymap);
    expect(parsed[0]!.type).toBe("mouse");
    if (parsed[0]!.type === "mouse") {
      expect(parsed[0]!.event).toBe("scroll");
      expect(parsed[0]!.direction).toBe("up");
    }
  });

  it("recognizes SGR mouse scroll (down)", () => {
    // SGR mouse: \u001b[<65;10;5M = scroll down
    const input = "\u001b[<65;10;5M";
    const parsed = parseTerminalInput(input, keymap);
    expect(parsed[0]!.type).toBe("mouse");
    if (parsed[0]!.type === "mouse") {
      expect(parsed[0]!.event).toBe("scroll");
      expect(parsed[0]!.direction).toBe("down");
    }
  });

  it("recognizes SGR mouse drag", () => {
    // SGR mouse: \u001b[<32;10;5M = left drag
    const input = "\u001b[<32;10;5M";
    const parsed = parseTerminalInput(input, keymap);
    expect(parsed[0]!.type).toBe("mouse");
    if (parsed[0]!.type === "mouse") {
      expect(parsed[0]!.event).toBe("drag");
      expect(parsed[0]!.button).toBe("left");
    }
  });

  it("does not treat partial SGR mouse sequence as mouse", () => {
    // Incomplete sequence should not match as mouse, but may match as text
    const input = "\u001b[<0;10";
    const parsed = parseTerminalInput(input, keymap);
    // The parser may treat the partial sequence as text characters
    // The key assertion is that no mouse event is parsed
    expect(parsed.every((p) => p.type !== "mouse")).toBe(true);
  });

  it("parses text before and after mouse sequence", () => {
    const input = "hello\u001b[<0;10;5Mworld";
    const parsed = parseTerminalInput(input, keymap);
    // Text before mouse: "hello" is parsed as individual characters
    const textBefore = parsed
      .filter((p) => p.type === "text")
      .map((p) => (p as { text: string }).text)
      .join("");
    expect(textBefore).toBe("helloworld");
    // Mouse event is parsed
    expect(parsed.some((p) => p.type === "mouse")).toBe(true);
  });
});
