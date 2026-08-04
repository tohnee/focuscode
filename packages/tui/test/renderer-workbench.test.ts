/**
 * workbench（三栏工作台）渲染器测试 —— yazi × tmux 风格默认布局。
 *
 * 覆盖：三栏结构、行宽不溢出、窄屏逐级降级、zoom、进度条、
 * 状态栏分段、输入行语境前缀、输入实时预览、终端注入 sanitize。
 */
import { describe, expect, it } from "vitest";
import { renderTui, type TuiRenderState } from "../src/renderer.js";
import { TUI_THEMES } from "../src/themes.js";
import { TUI_MASCOTS } from "../src/mascots.js";
import { createInitialLayout } from "../src/layout.js";
import { createInitialTodoPanel, setTodoItems } from "../src/todo-panel.js";
import { stripAnsi, stringWidth } from "../src/width.js";

/** 去掉 ANSI 颜色码，返回纯文本帧，便于稳定断言。 */
function plain(state: TuiRenderState): string {
  return stripAnsi(renderTui(state));
}

function workbenchState(overrides: Partial<TuiRenderState> = {}): TuiRenderState {
  return {
    width: 180,
    height: 40,
    title: "FocusCode",
    model: "deepseek/deepseek-v4-flash",
    session: "s1",
    approval: "ask",
    sandbox: "seatbelt",
    busy: false,
    queued: 0,
    mood: "idle",
    tick: 0,
    theme: TUI_THEMES[0]!,
    mascot: TUI_MASCOTS[0]!,
    transcript: [
      { role: "user", text: "修复登录 bug" },
      { role: "assistant", text: "我来看一下。" },
      { role: "tool", text: '{"output":"grep 完成，命中 3 处"}' },
    ],
    input: "继续排查",
    inputCursor: { row: 0, col: 2 },
    attachments: [],
    scrollOffset: 0,
    layout: createInitialLayout(),
    todoPanel: setTodoItems(createInitialTodoPanel(), [
      { id: "1", content: "Task A", status: "in_progress", priority: "high" },
      { id: "2", content: "Task B", status: "pending", priority: "medium" },
    ]),
    ...overrides,
  };
}

describe("renderWorkbench — three-column structure", () => {
  it("renders nav panel with todo list and session info", () => {
    const frame = plain(workbenchState());
    expect(frame).toContain("▌Todo");
    expect(frame).toContain("Task A");
    expect(frame).toContain("▶"); // in_progress 图标
    expect(frame).toContain("·"); // pending 图标
    expect(frame).toContain("▌Session");
    expect(frame).toContain("s1");
    expect(frame).toContain("▌Info");
  });

  it("renders transcript in the main column", () => {
    const frame = plain(workbenchState());
    expect(frame).toContain("修复登录 bug");
    expect(frame).toContain("我来看一下。");
    expect(frame).toContain("grep 完成，命中 3 处");
  });

  it("renders preview panel with progress/tool output/context/cost", () => {
    const frame = plain(
      workbenchState({
        contextUsage: { context: { usedTokens: 1000, maxTokens: 8000 }, outputTokens: 0 },
        sessionCost: 0.0032,
      }),
    );
    expect(frame).toContain("▌Progress");
    expect(frame).toContain("▌Tool output");
    expect(frame).toContain("▌Context");
    expect(frame).toContain("▌Cost");
    expect(frame).toContain("$0.0032");
  });

  it("renders input preview from current input (markdown)", () => {
    const frame = plain(workbenchState({ input: "## 标题\n正文 **粗体**" }));
    expect(frame).toContain("▌Input preview");
    expect(frame).toContain("标题");
    expect(frame).toContain("粗体");
  });

  it("shows empty hints when no todo/tool/context data", () => {
    const frame = plain(
      workbenchState({
        todoPanel: createInitialTodoPanel(),
        transcript: [],
        contextUsage: undefined,
      }),
    );
    expect(frame).toContain("no tasks");
    expect(frame).toContain("(no tool output yet)");
    expect(frame).toContain("(no context data)");
  });

  it("every rendered line fits within the terminal width (no overflow)", () => {
    const frame = plain(workbenchState());
    for (const [index, line] of frame.split("\n").entries()) {
      expect(stringWidth(line), `line ${index} overflows`).toBeLessThanOrEqual(180);
    }
  });

  it("progress bar shows full blocks ⣿ for completed tasks and percentage", () => {
    const todoPanel = setTodoItems(createInitialTodoPanel(), [
      { id: "1", content: "Done", status: "completed", priority: "high" },
      { id: "2", content: "Done", status: "completed", priority: "high" },
      { id: "3", content: "Pending", status: "pending", priority: "medium" },
      { id: "4", content: "Pending", status: "pending", priority: "medium" },
    ]);
    const frame = plain(workbenchState({ todoPanel }));
    expect(frame).toContain("⣿");
    expect(frame).toContain("50%");
    expect(frame).toContain("2/4 tasks");
  });

  it("progress bar shows busy spinner state when working without todos", () => {
    const frame = plain(workbenchState({ busy: true, todoPanel: createInitialTodoPanel() }));
    expect(frame).toContain("working");
  });
});

describe("renderWorkbench — status bar (tmux style)", () => {
  it("renders segmented panel list with active highlight", () => {
    const frame = plain(workbenchState());
    expect(frame).toContain("[1]Nav");
    expect(frame).toContain("[2]Chat");
    expect(frame).toContain("[3]Preview");
  });

  it("renders system info on the right side", () => {
    const frame = plain(workbenchState());
    expect(frame).toContain("deepseek/deepseek-v4-flash");
    expect(frame).toContain("ask");
    expect(frame).toContain("seatbelt");
  });
});

describe("renderWorkbench — input line", () => {
  it("uses > context prefix for conversation input", () => {
    const frame = plain(workbenchState({ input: "继续排查", inputCursor: { row: 0, col: 0 } }));
    expect(frame).toContain("> 继续排查");
  });

  it("uses / context prefix for command input", () => {
    const frame = plain(workbenchState({ input: "/task add", inputCursor: { row: 0, col: 0 } }));
    expect(frame).toContain("/ /task add");
    expect(frame).toContain("[Tab] 命令补全");
  });

  it("shows contextual hint when input is empty", () => {
    const frame = plain(workbenchState({ input: "" }));
    expect(frame).toContain("[Tab] 命令");
    expect(frame).toContain("[Ctrl+B] 面板");
  });

  it("renders cursor with reverse-video highlight", () => {
    const frame = renderTui(workbenchState({ input: "abc", inputCursor: { row: 0, col: 1 } }));
    // 反显：光标字符被 \u001b[7m ... \u001b[27m 包裹
    const match = frame.match(/\u001b\[7m(.)\u001b\[27m/);
    expect(match?.[1]).toBe("b");
  });

  it("supports multi-line input display (auto-expanding)", () => {
    const frame = plain(
      workbenchState({ input: "第一行\n第二行", inputCursor: { row: 1, col: 2 } }),
    );
    expect(frame).toContain("第一行");
    expect(frame).toContain("第二行");
  });
});

describe("renderWorkbench — degradation & zoom", () => {
  it("hides preview column below 140 columns, keeps nav", () => {
    const frame = plain(workbenchState({ width: 120 }));
    expect(frame).toContain("[1]Nav");
    expect(frame).toContain("[2]Chat");
    expect(frame).not.toContain("[3]Preview");
    expect(frame).not.toContain("▌Progress");
  });

  it("hides nav column below 100 columns (single-pane fallback)", () => {
    const frame = plain(workbenchState({ width: 80, height: 24 }));
    expect(frame).not.toContain("[1]Nav");
    expect(frame).not.toContain("[3]Preview");
    expect(frame).toContain("修复登录 bug");
  });

  it("zoom hides both side columns and spans full width", () => {
    const frame = plain(workbenchState({ layout: { ...createInitialLayout(), zoom: true } }));
    expect(frame).not.toContain("[1]Nav");
    expect(frame).not.toContain("[3]Preview");
    expect(frame).toContain("修复登录 bug");
  });

  it("narrow single-pane fallback still fits width", () => {
    const frame = plain(workbenchState({ width: 60, height: 12 }));
    for (const [index, line] of frame.split("\n").entries()) {
      expect(stringWidth(line), `line ${index} overflows`).toBeLessThanOrEqual(60);
    }
  });
});

describe("renderWorkbench — security sanitize", () => {
  it("sanitizes terminal control sequences in messages and todo items", () => {
    const hostile = "evil\u001b[2J\u001b]0;owned\u0007text";
    const frame = plain(
      workbenchState({
        transcript: [{ role: "user", text: hostile }],
        todoPanel: setTodoItems(createInitialTodoPanel(), [
          { id: "1", content: hostile, status: "pending", priority: "high" },
        ]),
      }),
    );
    expect(frame).not.toContain("\u001b[2J");
    expect(frame).not.toContain("\u001b]");
    expect(frame).not.toContain("\u0007");
    expect(frame).toContain("evil");
    expect(frame).toContain("text");
  });

  it("sanitizes hostile model/session/tool output in preview panel", () => {
    const hostile = "pwn\u001b[2J\u001b]0;x\u0007ed";
    const frame = plain(
      workbenchState({
        model: hostile,
        session: hostile,
        transcript: [{ role: "tool", text: '{"output":"' + hostile + '"}' }],
      }),
    );
    expect(frame).not.toContain("\u001b[2J");
    expect(frame).not.toContain("\u001b]");
    expect(frame).not.toContain("\u0007");
    expect(frame).toContain("pwn");
  });
});

describe("renderWorkbench — Cost block cache metrics", () => {
  it("renders cache hit metrics in the Cost block when provided", () => {
    const frame = plain(
      workbenchState({
        sessionCost: 6.08,
        // savedUsd = (cachedInputTokens / 1_000_000) * pricing.input —
        // canonical numbers (cached 400K, input price 2.0) yield 0.8.
        cacheMetrics: { hitRatio: 0.4, savedUsd: 0.8 },
      }),
    );
    expect(frame).toContain("▌Cost");
    expect(frame).toContain("$6.0800");
    expect(frame).toContain("cache hit 40%");
    expect(frame).toContain("saved $0.80");
  });

  it("omits cache line when no cache metrics", () => {
    const frame = plain(workbenchState({ sessionCost: 0.0032 }));
    expect(frame).toContain("$0.0032");
    expect(frame).not.toContain("cache hit");
  });
});

describe("renderWorkbench — personalization (mascot/companion)", () => {
  it("renders assistant messages with the mascot glyph prefix", () => {
    const frame = plain(workbenchState({ transcript: [{ role: "assistant", text: "你好呀!" }] }));
    expect(frame).toContain("🦊 你好呀!");
  });

  it("renders the Partner block in the nav panel with mood and speech", () => {
    const frame = plain(workbenchState({ mood: "happy", speech: "今天也要加油鸭!" }));
    expect(frame).toContain("▌Partner");
    expect(frame).toContain("🦊");
    expect(frame).toContain("状态很好");
    expect(frame).toContain("今天也要加油鸭");
  });

  it("falls back to the mascot catchphrase when no speech is set", () => {
    const frame = plain(workbenchState({ speech: undefined, mood: "working" }));
    // TUI_MASCOTS[0] (foxy) 的 catchphrase 应出现在 Partner 区块
    expect(frame).toContain("工作中");
    expect(frame).toContain("「");
  });

  it("renders companion level/xp badge in the status bar", () => {
    const frame = plain(
      workbenchState({ companion: { xp: 128, level: 3, totalTurns: 20, totalToolSuccesses: 15 } }),
    );
    expect(frame).toContain("Lv 3");
    expect(frame).toContain("128xp");
  });

  it("non-foxy mascot uses the paw glyph", () => {
    const frame = plain(
      workbenchState({
        mascot: TUI_MASCOTS[1]!,
        transcript: [{ role: "assistant", text: "hi" }],
      }),
    );
    expect(frame).toContain("🐾 hi");
  });
});
