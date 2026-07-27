import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import type { ReadStream, WriteStream } from "node:tty";
import {
  DEFAULT_KEYMAP,
  EditorBuffer,
  FullScreenTui,
  TUI_MASCOTS,
  TUI_THEMES,
  TerminalInputDecoder,
  collectCompletions,
  getMascot,
  getTheme,
  mascotFrame,
  mergeKeymap,
  parseTerminalInput,
  renderDiff,
  renderMarkdownTranscript,
  renderTui,
  validateTuiMascot,
  validateTuiTheme,
  visibleLength,
  type CompletionProvider,
} from "../src/index.js";

describe("TUI primitives", () => {
  it("parses printable, navigation and configurable control keys", () => {
    expect(parseTerminalInput("hi\u001b[A\r\u0003")).toEqual([
      { type: "text", text: "h" },
      { type: "text", text: "i" },
      { type: "action", action: "history_previous" },
      { type: "action", action: "submit" },
      { type: "action", action: "abort" },
    ]);
    expect(parseTerminalInput("\u001b[200~line one\nline two\u001b[201~")).toEqual([
      { type: "text", text: "line one\nline two" },
    ]);
    const decoder = new TerminalInputDecoder();
    expect(decoder.push("\u001b[20")).toEqual([]);
    expect(decoder.push("0~pasted\ntext\u001b[20")).toEqual([]);
    expect(decoder.push("1~")).toEqual([{ type: "text", text: "pasted\ntext" }]);
    const custom = mergeKeymap({ "ctrl+x": "abort" });
    expect(custom["ctrl+x"]).toBe("abort");
    expect(custom["ctrl+c"]).toBeUndefined();
    expect(() => mergeKeymap({ bad: "abort" })).toThrow("Invalid key");
  });

  it("ships multiple animated cute mascots and themes", () => {
    expect(TUI_MASCOTS.length).toBeGreaterThanOrEqual(6);
    expect(TUI_THEMES.length).toBeGreaterThanOrEqual(5);
    expect(mascotFrame(getMascot("mochi"), "idle", 0).join("\n")).toContain("ᐠ");
    expect(mascotFrame(getMascot("mochi"), "idle", 1)).not.toEqual(
      mascotFrame(getMascot("mochi"), "idle", 0),
    );
    expect(() => getTheme("missing")).toThrow("Unknown");
    const customTheme = validateTuiTheme({
      ...getTheme("aurora"),
      id: "team-blue",
      name: "Team Blue",
      accent: 45,
    });
    expect(getTheme(customTheme).id).toBe("team-blue");
    const customMascot = validateTuiMascot({
      ...getMascot("mochi"),
      id: "team-pet",
      name: "Team Pet",
    });
    expect(getMascot(customMascot).name).toBe("Team Pet");
    expect(() => validateTuiTheme({ ...customTheme, accent: 999 })).toThrow("ANSI color");
    expect(() => validateTuiMascot({ ...customMascot, name: "bad\u001b[2J" })).toThrow("name");
  });

  it("renders a bounded full-screen frame with status, transcript and queue", () => {
    const output = renderTui({
      width: 80,
      height: 24,
      title: "FocusCode",
      model: "openai/gpt",
      session: "session_1",
      approval: "ask",
      sandbox: "gvisor",
      busy: true,
      queued: 2,
      mood: "working",
      tick: 0,
      theme: getTheme("aurora"),
      mascot: getMascot("byte"),
      transcript: [
        { role: "user", text: "fix tests" },
        { role: "assistant", text: "Inspecting \u001b[2Jfiles" },
      ],
      input: "also\nupdate docs",
      inputCursor: { row: 0, col: 4 },
      attachments: ["screen.png"],
      scrollOffset: 0,
    });
    expect(output).toContain("FocusCode");
    expect(output).toContain("queued 2");
    expect(output).toContain("screen.png");
    expect(output).not.toContain("\u001b[2J");
    expect(output).toContain("also");
    expect(output).toContain("update docs");
    expect(output.split("\n")).toHaveLength(24);
    expect(DEFAULT_KEYMAP.enter).toBe("submit");
  });

  it("runs raw full-screen input, approvals, steering and restores the terminal", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const submitted: string[] = [];
    const steered: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tui = new FullScreenTui({
      input: input as unknown as ReadStream,
      output: output as unknown as WriteStream,
      model: "fixture/model",
      session: "session_1",
      approval: "ask",
      sandbox: "docker",
      onSubmit: async (text) => {
        submitted.push(text);
        await blocked;
      },
      onSteer: async (text) => {
        steered.push(text);
      },
      onAbort: () => undefined,
    });
    const running = tui.run();
    input.emit("data", "first\r");
    await tick();
    input.emit("data", "second\r");
    await tick();
    expect(submitted).toEqual(["first"]);
    expect(steered).toEqual(["second"]);
    tui.setModel("next/model");
    tui.setSession("session_2");
    tui.setApproval("deny");
    expect(tui.snapshot()).toMatchObject({
      model: "next/model",
      session: "session_2",
      approval: "deny",
    });
    release();
    await tick();
    const approval = tui.requestApproval("Allow write?");
    input.emit("data", "y\r");
    await expect(approval).resolves.toBe(true);
    input.emit("data", "\u0004");
    await running;
    expect(input.rawModes).toEqual([true, false]);
    expect(output.content).toContain("\u001b[?1049h");
    expect(output.content).toContain("\u001b[?1049l");
  });
});

class FakeInput extends EventEmitter {
  isTTY = true;
  rawModes: boolean[] = [];

  setRawMode(value: boolean): this {
    this.rawModes.push(value);
    return this;
  }

  setEncoding(): this {
    return this;
  }

  resume(): this {
    return this;
  }
}

class FakeOutput extends EventEmitter {
  isTTY = true;
  columns = 80;
  rows = 24;
  content = "";

  write(value: string): boolean {
    this.content += value;
    return true;
  }
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("EditorBuffer", () => {
  it("edits multi-line text with grapheme-safe cursor movement", () => {
    const editor = new EditorBuffer();
    editor.insertText("hello");
    editor.newline();
    editor.insertText("世界🌍");
    expect(editor.getText()).toBe("hello\n世界🌍");
    expect(editor.getCursor()).toEqual({ row: 1, col: 3 });
    editor.cursorLeft(); // emoji stays atomic
    expect(editor.getCursor()).toEqual({ row: 1, col: 2 });
    editor.cursorLeft();
    editor.cursorLeft();
    expect(editor.getCursor()).toEqual({ row: 1, col: 0 });
    editor.cursorLeft(); // wraps to the end of the previous line
    expect(editor.getCursor()).toEqual({ row: 0, col: 5 });
    editor.home();
    editor.wordRight();
    expect(editor.getCursor()).toEqual({ row: 0, col: 5 });
    editor.end();
    editor.wordLeft();
    expect(editor.getCursor()).toEqual({ row: 0, col: 0 });
    editor.cursorDown();
    expect(editor.getCursor()).toEqual({ row: 1, col: 0 });
    editor.cursorUp();
    editor.cursorRight();
    editor.cursorRight();
    editor.cursorDown(); // clamps to shorter line length
    expect(editor.getCursor()).toEqual({ row: 1, col: 2 });
  });

  it("pastes multi-line text and keeps at least 50 undo steps", () => {
    const editor = new EditorBuffer();
    editor.insertText("one\ntwo\nthree");
    expect(editor.getLines()).toEqual(["one", "two", "three"]);
    expect(editor.getCursor()).toEqual({ row: 2, col: 5 });
    editor.undo();
    expect(editor.getText()).toBe("");
    const typing = new EditorBuffer();
    for (let count = 0; count < 60; count += 1) typing.insertText("x");
    let steps = 0;
    while (typing.undo()) steps += 1;
    expect(steps).toBe(60);
    expect(typing.getText()).toBe("");
  });

  it("backspaces whole grapheme clusters and supports kill/yank", () => {
    const editor = new EditorBuffer();
    editor.insertText("a👨‍👩‍👧b");
    editor.backspace();
    expect(editor.getText()).toBe("a👨‍👩‍👧");
    editor.backspace();
    expect(editor.getText()).toBe("a");
    editor.setText("alpha beta");
    editor.home();
    editor.wordRight();
    editor.killLine();
    expect(editor.getText()).toBe("alpha");
    editor.yank();
    expect(editor.getText()).toBe("alpha beta");
    editor.end();
    editor.killLine(); // nothing left to kill on the last line
    expect(editor.getText()).toBe("alpha beta");
    editor.undo();
    expect(editor.getText()).toBe("alpha");
  });

  it("deletes words and joins lines like readline ctrl+w", () => {
    const editor = new EditorBuffer();
    editor.insertText("foo bar\nbaz qux");
    editor.deleteWordBackward();
    expect(editor.getText()).toBe("foo bar\nbaz ");
    editor.deleteWordBackward();
    expect(editor.getText()).toBe("foo bar\n");
    editor.deleteWordBackward(); // at line start: joins the line, then kills the previous word
    expect(editor.getText()).toBe("foo ");
  });

  it("replaces the word before the cursor when applying a completion", () => {
    const editor = new EditorBuffer();
    editor.insertText("/he");
    expect(editor.wordBeforeCursor()).toBe("/he");
    editor.applyCompletion("/he", "/help");
    expect(editor.getText()).toBe("/help");
    editor.applyCompletion("nope", "/nope"); // prefix mismatch is a no-op
    expect(editor.getText()).toBe("/help");
  });
});

describe("display width", () => {
  it("counts wide CJK characters as two columns", () => {
    expect(visibleLength("abc")).toBe(3);
    expect(visibleLength("世界中")).toBe(6);
    expect(visibleLength("ab世界")).toBe(6);
    expect(visibleLength("\u001b[31m赤\u001b[39m")).toBe(2);
    expect(visibleLength("box ─ drawing")).toBe(13);
  });

  it("wraps wide characters without breaking frame width", () => {
    const output = renderTui({
      width: 80,
      height: 24,
      title: "FocusCode",
      model: "openai/gpt",
      session: "session_1",
      approval: "ask",
      sandbox: "gvisor",
      busy: false,
      queued: 0,
      mood: "idle",
      tick: 0,
      theme: getTheme("aurora"),
      mascot: getMascot("byte"),
      transcript: [{ role: "user", text: "界".repeat(60) }],
      input: "",
      inputCursor: { row: 0, col: 0 },
      attachments: [],
      scrollOffset: 0,
    });
    for (const line of output.split("\n")) expect(visibleLength(line)).toBeLessThanOrEqual(80);
    expect(output.split("\n")).toHaveLength(24);
  });
});

describe("completion", () => {
  const slashProvider: CompletionProvider = {
    complete(prefix, fullText) {
      if (!prefix.startsWith("/") || !fullText.startsWith(prefix)) return [];
      return ["/help", "/history"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value }));
    },
  };

  it("filters candidates by prefix and dedupes across providers", () => {
    expect(collectCompletions([slashProvider], "/h", "/h")).toEqual([
      { value: "/help" },
      { value: "/history" },
    ]);
    expect(collectCompletions([slashProvider], "/he", "/he")).toEqual([{ value: "/help" }]);
    expect(collectCompletions([slashProvider], "abc", "abc")).toEqual([]);
    const duplicate: CompletionProvider = {
      complete: () => [{ value: "/help", description: "second" }],
    };
    expect(collectCompletions([slashProvider, duplicate], "/he", "/he")).toEqual([
      { value: "/help" },
    ]);
  });

  it("cycles candidates with tab, confirms with enter and submits the result", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const submitted: string[] = [];
    const provider: CompletionProvider = {
      complete(prefix) {
        return ["alpha", "alpine"]
          .filter((value) => value.startsWith(prefix))
          .map((value) => ({ value }));
      },
    };
    const tui = new FullScreenTui({
      input: input as unknown as ReadStream,
      output: output as unknown as WriteStream,
      model: "fixture/model",
      session: "session_1",
      approval: "ask",
      sandbox: "docker",
      completionProviders: [provider],
      onSubmit: async (text) => {
        submitted.push(text);
      },
      onSteer: async () => undefined,
      onAbort: () => undefined,
    });
    const running = tui.run();
    input.emit("data", "al");
    input.emit("data", "\t");
    await tick();
    expect(tui.snapshot().completion?.candidates.map((candidate) => candidate.value)).toEqual([
      "alpha",
      "alpine",
    ]);
    input.emit("data", "\t");
    await tick();
    expect(tui.snapshot().completion?.index).toBe(1);
    input.emit("data", "\t");
    await tick();
    expect(tui.snapshot().completion?.index).toBe(0); // wraps around
    input.emit("data", "\r"); // confirms the completion instead of submitting
    await tick();
    expect(tui.snapshot().input).toBe("alpha");
    expect(submitted).toEqual([]);
    input.emit("data", "\r");
    await tick();
    expect(submitted).toEqual(["alpha"]);
    input.emit("data", "\u001b[4~"); // input discarded after submit
    await tick();
    input.emit("data", "\u0004");
    await running;
  });

  it("renders completion rows above the input area", () => {
    const output = renderTui({
      width: 80,
      height: 24,
      title: "FocusCode",
      model: "openai/gpt",
      session: "session_1",
      approval: "ask",
      sandbox: "gvisor",
      busy: false,
      queued: 0,
      mood: "idle",
      tick: 0,
      theme: getTheme("aurora"),
      mascot: getMascot("byte"),
      transcript: [],
      input: "/h",
      inputCursor: { row: 0, col: 2 },
      completion: {
        candidates: [{ value: "/help", description: "Show help" }, { value: "/history" }],
        index: 1,
      },
      attachments: [],
      scrollOffset: 0,
    });
    const plain = output.replace(/\u001b\[[0-9;]*m/g, "");
    expect(plain).toContain("› /history");
    expect(plain).toContain("/help — Show help");
    expect(output.split("\n")).toHaveLength(24);
  });
});

describe("markdown transcript", () => {
  it("renders headings, emphasis, inline code, fences and lists", () => {
    const theme = getTheme("aurora");
    const lines = renderMarkdownTranscript(
      "# Title\n\nSome **bold** and `code` plus *ital*.\n\n```ts\nconst x = 1;\n```\n\n- first\n2. second",
      60,
      theme,
    );
    const plain = lines.map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""));
    expect(plain[0]).toBe("Title");
    expect(lines[0]).toContain("\u001b[1m");
    expect(lines[0]).toContain("\u001b[38;5;81m");
    expect(plain[2]).toBe("Some bold and code plus ital.");
    expect(lines[2]).toContain("\u001b[38;5;221m"); // inline code uses the warning color
    expect(plain[4]).toBe("const x = 1;" + " ".repeat(48)); // fenced block padded to width
    expect(lines[4]).toContain("\u001b[48;5;245m"); // code block background block
    expect(plain[6]).toBe("• first");
    expect(plain[7]).toBe("2. second");
  });

  it("strips dangerous sequences before rendering and wraps to width", () => {
    const theme = getTheme("aurora");
    const lines = renderMarkdownTranscript("hi \u001b[2Jthere " + "word ".repeat(30), 40, theme);
    expect(lines.join("\n")).not.toContain("\u001b[2J");
    for (const line of lines) expect(visibleLength(line)).toBeLessThanOrEqual(40);
  });
});

describe("diff rendering", () => {
  it("marks removals and additions and folds long unchanged runs", () => {
    const before = ["l1", "l2", "l3", "l4", "l5", "l6", "l7"].join("\n");
    const after = ["l1", "l2", "l3", "l4", "CHANGED", "l6", "l7"].join("\n");
    const lines = renderDiff(before, after, 60);
    const plain = lines.map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""));
    expect(plain).toEqual(["... 4 unchanged lines ...", "- l5", "+ CHANGED", "  l6", "  l7"]);
    expect(lines[1]).toContain("\u001b[38;5;1m");
    expect(lines[2]).toContain("\u001b[38;5;2m");
  });

  it("keeps short context runs and handles wholesale changes", () => {
    const context = renderDiff("a\nb\nc", "a\nX\nc", 40).map((line) =>
      line.replace(/\u001b\[[0-9;]*m/g, ""),
    );
    expect(context).toEqual(["  a", "- b", "+ X", "  c"]);
    const swapped = renderDiff("old", "new", 40).map((line) =>
      line.replace(/\u001b\[[0-9;]*m/g, ""),
    );
    expect(swapped).toEqual(["- old", "+ new"]);
  });
});

describe("keymap editor actions", () => {
  it("binds home/end/word/undo/complete keys and rejects invalid bindings", () => {
    expect(DEFAULT_KEYMAP.tab).toBe("complete");
    expect(DEFAULT_KEYMAP["ctrl+z"]).toBe("undo");
    expect(DEFAULT_KEYMAP["ctrl+a"]).toBe("home");
    expect(DEFAULT_KEYMAP["ctrl+e"]).toBe("end");
    expect(DEFAULT_KEYMAP["alt+b"]).toBe("word_left");
    expect(DEFAULT_KEYMAP["alt+f"]).toBe("word_right");
    expect(parseTerminalInput("\u001b[H")).toEqual([{ type: "action", action: "home" }]);
    expect(parseTerminalInput("\u001b[F")).toEqual([{ type: "action", action: "end" }]);
    expect(parseTerminalInput("\u001b[1~")).toEqual([{ type: "action", action: "home" }]);
    expect(parseTerminalInput("\u001bb")).toEqual([{ type: "action", action: "word_left" }]);
    expect(parseTerminalInput("\u001bf")).toEqual([{ type: "action", action: "word_right" }]);
    expect(parseTerminalInput("\t")).toEqual([{ type: "action", action: "complete" }]);
    expect(mergeKeymap({ tab: "clear" }).tab).toBe("clear");
    expect(() => mergeKeymap({ "alt+1": "clear" })).toThrow("Invalid key");
    expect(() => mergeKeymap({ "ctrl+q": "bogus" as never })).toThrow("Invalid TUI action");
  });

  it("drives the multi-line editor through decoded key actions", async () => {
    const input = new FakeInput();
    const output = new FakeOutput();
    const submitted: string[] = [];
    const tui = new FullScreenTui({
      input: input as unknown as ReadStream,
      output: output as unknown as WriteStream,
      model: "fixture/model",
      session: "session_1",
      approval: "ask",
      sandbox: "docker",
      onSubmit: async (text) => {
        submitted.push(text);
      },
      onSteer: async () => undefined,
      onAbort: () => undefined,
    });
    const running = tui.run();
    input.emit("data", "one\u000ftwo");
    await tick();
    expect(tui.snapshot().input).toBe("one\ntwo"); // ctrl+o inserts a newline
    expect(tui.snapshot().inputCursor).toEqual({ row: 1, col: 3 });
    input.emit("data", "\u0001");
    input.emit("data", "x");
    await tick();
    expect(tui.snapshot().input).toBe("one\nxtwo"); // ctrl+a jumps to the line start
    input.emit("data", "\u001a");
    await tick();
    expect(tui.snapshot().input).toBe("one\ntwo"); // ctrl+z undoes the edit
    input.emit("data", "\u0005");
    await tick();
    expect(tui.snapshot().inputCursor).toEqual({ row: 1, col: 3 }); // ctrl+e line end
    input.emit("data", "\r");
    await tick();
    expect(submitted).toEqual(["one\ntwo"]); // full multi-line text is submitted
    input.emit("data", "\u0004");
    await running;
  });
});

describe("Foxy companion experience", () => {
  it("ships the Foxy mascot and foxglow theme as the defaults", () => {
    expect(getMascot().id).toBe("foxy");
    expect(getMascot("foxy").name).toContain("Foxy");
    expect(getTheme().id).toBe("foxglow");
    expect(mascotFrame(getMascot("foxy"), "happy", 0).join("\n")).toContain("^ω^");
    expect(() => getMascot({ ...getMascot("foxy"), id: "foxy-2", name: "Foxy2" })).not.toThrow();
  });

  it("renders the mascot speech bubble, spinner and friendly role tags", () => {
    const frame = renderTui({
      width: 90,
      height: 26,
      title: "FocusCode",
      model: "kimi/k3",
      session: "s1",
      approval: "ask",
      sandbox: "auto",
      busy: true,
      queued: 0,
      mood: "working",
      tick: 2,
      theme: getTheme("foxglow"),
      mascot: getMascot("foxy"),
      transcript: [
        { role: "user", text: "hello" },
        { role: "assistant", text: "hi there" },
      ],
      input: "",
      inputCursor: { row: 0, col: 0 },
      attachments: [],
      status: "Running edit…",
      speech: "一步一步来，不慌。",
      scrollOffset: 0,
    });
    const plain = frame.replaceAll(/\u001b\[[0-9;]*m/g, "");
    expect(plain).toContain("🦊 FocusCode");
    expect(plain).toContain("一步一步来");
    expect(plain).toContain("you › hello");
    expect(plain).toContain("fox › hi there");
    expect(plain).toContain("steer»");
    expect(plain).not.toContain("user>");
    expect(plain).toMatch(/╭─+\s*│/);
    expect(plain).toMatch(/╰─+\s*│/);
    expect(plain).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Running edit…/);
  });
});
