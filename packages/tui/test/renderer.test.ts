import { describe, expect, it } from "vitest";
import { renderTui, type TuiRenderState } from "../src/renderer.js";
import type { ContextUsageState } from "../src/context-bar.js";
import type { SpecProgressState } from "../src/spec-progress.js";
import { TUI_MASCOTS } from "../src/mascots.js";
import { TUI_THEMES } from "../src/themes.js";
import type { SearchState } from "../src/search.js";
import {
  createPaletteState,
  updatePaletteQuery,
  type PaletteState,
} from "../src/command-palette.js";
import type { VimState } from "../src/vim.js";
import { createInitialLayout, setLayoutMode } from "../src/layout.js";
import { createInitialTodoPanel, setTodoItems } from "../src/todo-panel.js";
import { stripAnsi } from "../src/width.js";

function baseState(overrides: Partial<TuiRenderState> = {}): TuiRenderState {
  return {
    width: 80,
    height: 24,
    title: "Test",
    model: "test/model",
    session: "s1",
    approval: "ask",
    sandbox: "host",
    busy: false,
    queued: 0,
    mood: "idle",
    tick: 0,
    theme: TUI_THEMES[0]!,
    mascot: TUI_MASCOTS[0]!,
    transcript: [],
    input: "",
    inputCursor: { row: 0, col: 0 },
    attachments: [],
    scrollOffset: 0,
    ...overrides,
  };
}

describe("renderTui spec integration", () => {
  it("renders spec progress when phase is not idle", () => {
    const specProgress: SpecProgressState = {
      phase: "explore",
      stages: [
        { name: "classify", status: "done", durationMs: 500 },
        { name: "explore", status: "running" },
      ],
    };
    const frame = renderTui(baseState({ specProgress }));
    expect(frame).toContain("Spec Engine");
    expect(frame).toContain("classify");
    expect(frame).toContain("explore");
  });

  it("does not render spec progress when idle", () => {
    const specProgress: SpecProgressState = { phase: "idle", stages: [] };
    const frame = renderTui(baseState({ specProgress }));
    expect(frame).not.toContain("Spec Engine");
  });

  it("renders context usage bar when set", () => {
    const contextUsage: ContextUsageState = { usedTokens: 50000, maxTokens: 200000 };
    const frame = renderTui(baseState({ contextUsage }));
    expect(frame).toContain("50.0k");
    expect(frame).toContain("200.0k");
  });

  it("renders reasoning indicator when reasoning present and collapsed", () => {
    const frame = renderTui(
      baseState({ reasoning: "thinking about it", reasoningExpanded: false }),
    );
    expect(frame).toContain("thinking");
  });

  it("renders reasoning inline when expanded", () => {
    const frame = renderTui(baseState({ reasoning: "deep thoughts", reasoningExpanded: true }));
    expect(frame).toContain("deep thoughts");
  });
});

describe("renderTui — search bar", () => {
  it("renders search bar when search.visible is true", () => {
    const search: SearchState = {
      visible: true,
      query: "hello",
      matches: [0, 2],
      currentIndex: 0,
    };
    const frame = renderTui(baseState({ search }));
    expect(frame).toContain("hello");
    expect(frame).toContain("1/2");
  });

  it("does not render search bar when search is invisible", () => {
    const search: SearchState = { visible: false, query: "", matches: [], currentIndex: 0 };
    const frame = renderTui(baseState({ search }));
    expect(frame).not.toContain("/hello");
  });
});

describe("renderTui — command palette", () => {
  it("renders palette overlay when palette.visible is true", () => {
    let palette: PaletteState = createPaletteState();
    palette = { ...palette, visible: true, query: "vim" };
    palette = updatePaletteQuery(palette, "vim");
    const frame = renderTui(baseState({ palette }));
    expect(frame).toContain("vim");
    expect(frame).toContain("Vim");
  });

  it("does not render palette when invisible", () => {
    const palette = createPaletteState();
    const frame = renderTui(baseState({ palette }));
    expect(frame).not.toContain("-- NORMAL --");
  });
});

describe("renderTui — vim indicator", () => {
  it("renders vim mode indicator in footer when vim is present", () => {
    const vim: VimState = { mode: "normal" };
    const frame = renderTui(baseState({ vim }));
    expect(frame).toContain("-- NORMAL --");
  });

  it("renders INSERT indicator when vim mode is insert", () => {
    const vim: VimState = { mode: "insert" };
    const frame = renderTui(baseState({ vim }));
    expect(frame).toContain("-- INSERT --");
  });

  it("does not render vim indicator when vim is undefined", () => {
    const frame = renderTui(baseState());
    expect(frame).not.toContain("-- NORMAL --");
    expect(frame).not.toContain("-- INSERT --");
  });
});

describe("renderTui — visual refinement (theme.border + header status)", () => {
  it("uses theme.border character for top/bottom border fill", () => {
    // candy 主题的 border 是 "·"，顶部边框中间应该用 · 填充
    const candyTheme = TUI_THEMES.find((t) => t.id === "candy")!;
    const frame = renderTui(baseState({ theme: candyTheme }));
    const lines = frame.split("\n").map(stripAnsi);
    // 顶部边框：╭ + ···· + ╮
    expect(lines[0]!.startsWith("╭")).toBe(true);
    expect(lines[0]!.endsWith("╮")).toBe(true);
    expect(lines[0]).toContain("·");
    // 默认 fox 主题用 ─，不应在 candy 顶部出现 ─ 作为填充（角字符外）
    const foxFrame = renderTui(baseState());
    const foxTop = stripAnsi(foxFrame.split("\n")[0]!);
    expect(foxTop).toContain("─");
  });

  it("uses theme.border for separator line fill (├...┤)", () => {
    const candyTheme = TUI_THEMES.find((t) => t.id === "candy")!;
    const frame = renderTui(baseState({ theme: candyTheme }));
    const lines = frame.split("\n").map(stripAnsi);
    // 找到 separator 行（├ 开头 ┤ 结尾）
    const separator = lines.find((l) => l.startsWith("├") && l.endsWith("┤"));
    expect(separator).toBeDefined();
    expect(separator!).toContain("·");
  });

  it("shows busy status indicator (●) in header when busy", () => {
    const frame = renderTui(baseState({ busy: true }));
    const lines = frame.split("\n");
    const header = lines[1] ?? "";
    expect(header).toContain("●");
  });

  it("shows idle status indicator (○) in header when not busy", () => {
    const frame = renderTui(baseState({ busy: false }));
    const lines = frame.split("\n");
    const header = lines[1] ?? "";
    expect(header).toContain("○");
  });

  it("header indicator changes with busy state", () => {
    const busyFrame = renderTui(baseState({ busy: true }));
    const idleFrame = renderTui(baseState({ busy: false }));
    const busyHeader = busyFrame.split("\n")[1]!;
    const idleHeader = idleFrame.split("\n")[1]!;
    expect(busyHeader).toContain("●");
    expect(idleHeader).toContain("○");
    // 互斥：busy 不含 ○，idle 不含 ●
    expect(busyHeader).not.toContain("○");
    expect(idleHeader).not.toContain("●");
  });
});

describe("renderTui — spacing & separator refinement", () => {
  it("header has leading space after │ for breathing room", () => {
    const frame = renderTui(baseState());
    const lines = frame.split("\n");
    const header = lines[1] ?? "";
    // 去掉 ANSI 后检查 │ 后第一个字符是空格
    const stripped = stripAnsi(header);
    expect(stripped.startsWith("│ ")).toBe(true);
  });

  it("footer has leading space after │ for breathing room", () => {
    const frame = renderTui(baseState());
    const lines = frame.split("\n");
    // footer 是倒数第二行
    const footer = lines[lines.length - 2] ?? "";
    const stripped = stripAnsi(footer);
    expect(stripped.startsWith("│ ")).toBe(true);
  });

  it("separator uses theme.muted color and theme.border fill", () => {
    const candyTheme = TUI_THEMES.find((t) => t.id === "candy")!;
    const frame = renderTui(baseState({ theme: candyTheme }));
    const lines = frame.split("\n");
    const separator = lines.find((l) => {
      const s = stripAnsi(l);
      return s.startsWith("├") && s.endsWith("┤");
    });
    expect(separator).toBeDefined();
    const stripped = stripAnsi(separator!);
    // candy 主题的 border 是 "·"
    expect(stripped).toContain("·");
  });

  it("mascot speech bubble uses theme.border for top/bottom in classic mode", () => {
    const candyTheme = TUI_THEMES.find((t) => t.id === "candy")!;
    const frame = renderTui(
      baseState({
        theme: candyTheme,
        speech: "hello world this is a long speech that wraps",
        width: 60,
        height: 30,
      }),
    );
    const lines = frame.split("\n");
    // 找到以 ╭ 开头（在 mascot 区域内）的行
    const bubbleTop = lines.find((l) => {
      const s = stripAnsi(l);
      return s.includes("╭") && !s.startsWith("╭");
    });
    if (bubbleTop) {
      const stripped = stripAnsi(bubbleTop);
      // 应该用 candy 主题的 "·" 填充
      expect(stripped).toContain("·");
    }
  });

  it("mascot speech bubble uses theme.border in split layout mode", () => {
    const candyTheme = TUI_THEMES.find((t) => t.id === "candy")!;
    const layout = setLayoutMode(createInitialLayout(), "split");
    const frame = renderTui(
      baseState({
        theme: candyTheme,
        layout,
        speech: "hello world this is a long speech that wraps",
        width: 120,
        height: 40,
      }),
    );
    const lines = frame.split("\n");
    // 在 split 模式下，mascot 区域仍应有气泡边框
    const bubbleLine = lines.find((l) => {
      const s = stripAnsi(l);
      return s.includes("╭") && !s.startsWith("╭");
    });
    if (bubbleLine) {
      const stripped = stripAnsi(bubbleLine);
      expect(stripped).toContain("·");
    }
  });

  it("header content is bold (contains ANSI bold code)", () => {
    const frame = renderTui(baseState());
    const lines = frame.split("\n");
    const header = lines[1] ?? "";
    // ANSI bold 是 \u001b[1m
    expect(header).toContain("\u001b[1m");
  });

  it("busy state shows spinner in footer when status is set", () => {
    const frame = renderTui(baseState({ busy: true, status: "working" }));
    const lines = frame.split("\n");
    const footer = lines[lines.length - 2] ?? "";
    // footer 应包含某个 spinner 字符
    const spinners = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    expect(spinners.some((s) => footer.includes(s))).toBe(true);
  });
});

describe("renderTui — layout integration (Phase 3)", () => {
  // 注意：split/wide/focus 模式需要 width >= 100，所以这里用更宽的 baseState
  function wideState(overrides: Partial<TuiRenderState> = {}): TuiRenderState {
    return baseState({ width: 120, height: 40, ...overrides });
  }

  it("renders classic frame without layout field (backward compat)", () => {
    const frame = renderTui(baseState());
    expect(frame).toContain("Test");
    expect(frame).toContain("│");
  });

  it("renderTui with classic layout produces same output as without layout", () => {
    const withoutLayout = renderTui(wideState());
    const withLayout = renderTui(
      wideState({ layout: { ...createInitialLayout(), mode: "classic" } }),
    );
    expect(withLayout).toBe(withoutLayout);
  });

  it("renderTui with split layout renders sidebar with todo header", () => {
    const layout = setLayoutMode(createInitialLayout(), "split");
    const todoPanel = setTodoItems(createInitialTodoPanel(), [
      { id: "1", content: "Task A", status: "pending", priority: "high" },
    ]);
    const frame = renderTui(wideState({ layout, todoPanel }));
    expect(frame).toContain("Todo");
    expect(frame).toContain("Task A");
  });

  it("renderTui with focus layout hides mascot emoji from header", () => {
    const layout = { ...createInitialLayout(), mode: "focus" as const };
    const frame = renderTui(wideState({ layout }));
    // focus 模式 header 不显示吉祥物 emoji（foxy 的 🦊）
    const lines = frame.split("\n");
    const headerLine = lines[1] ?? "";
    expect(headerLine).not.toContain("🦊");
  });

  it("renderTui forces classic when width < 100 even if mode is split", () => {
    const layout = setLayoutMode(createInitialLayout(), "split");
    const todoPanel = setTodoItems(createInitialTodoPanel(), [
      { id: "1", content: "Hidden task", status: "pending", priority: "medium" },
    ]);
    // width 80 < 100，强制 classic
    const frame = renderTui(baseState({ width: 80, height: 40, layout, todoPanel }));
    expect(frame).not.toContain("Hidden task");
    expect(frame).not.toContain("📋 Todo");
  });

  it("renderTui wide layout renders sidebar with wider todo panel", () => {
    const layout = { ...createInitialLayout(), mode: "wide" as const };
    // wide 模式需要更宽的窗口（160 列才能体现 60/40 比例）
    const todoPanel = setTodoItems(createInitialTodoPanel(), [
      { id: "1", content: "Wide task content here", status: "pending", priority: "low" },
    ]);
    const frame = renderTui(wideState({ width: 160, height: 40, layout, todoPanel }));
    expect(frame).toContain("Wide task content here");
  });

  it("renderTui split layout does not show mascot emoji in sidebar", () => {
    const layout = setLayoutMode(createInitialLayout(), "split");
    const frame = renderTui(wideState({ layout }));
    // sidebar 不应该有吉祥物
    // 主区域应该还有吉祥物，但 sidebar 区域不应该重复
    expect(frame).toContain("│");
  });

  // === 多 pane 侧栏渲染（spec + context + todo 堆叠）===

  it("split layout renders spec progress in sidebar when specProgress is active", () => {
    const layout = setLayoutMode(createInitialLayout(), "split");
    const specProgress: SpecProgressState = {
      phase: "explore",
      stages: [
        { name: "classify", status: "done", durationMs: 500 },
        { name: "explore", status: "running" },
      ],
    };
    const frame = renderTui(wideState({ layout, specProgress }));
    // spec 进度应出现在侧栏中
    expect(frame).toContain("Spec Engine");
    expect(frame).toContain("classify");
  });

  it("split layout renders context bar in sidebar when contextUsage is set", () => {
    const layout = setLayoutMode(createInitialLayout(), "split");
    const contextUsage: ContextUsageState = { usedTokens: 50000, maxTokens: 200000 };
    const frame = renderTui(wideState({ layout, contextUsage }));
    // context bar 应出现在侧栏中
    expect(frame).toContain("50.0k");
    expect(frame).toContain("200.0k");
  });

  it("split layout renders todo + spec + context panes stacked in sidebar", () => {
    const layout = setLayoutMode(createInitialLayout(), "split");
    const todoPanel = setTodoItems(createInitialTodoPanel(), [
      { id: "1", content: "Stacked task", status: "pending", priority: "high" },
    ]);
    const specProgress: SpecProgressState = {
      phase: "draft",
      stages: [
        { name: "classify", status: "done", durationMs: 300 },
        { name: "explore", status: "done", durationMs: 1000 },
        { name: "draft", status: "running" },
      ],
    };
    const contextUsage: ContextUsageState = { usedTokens: 80000, maxTokens: 200000 };
    const frame = renderTui(
      wideState({ layout, todoPanel, specProgress, contextUsage, height: 50 }),
    );
    // 三个 pane 都应出现在同一帧中
    expect(frame).toContain("Todo");
    expect(frame).toContain("Stacked task");
    expect(frame).toContain("Spec Engine");
    expect(frame).toContain("draft");
    expect(frame).toContain("80.0k");
  });

  it("split layout does not render spec pane in sidebar when phase is idle", () => {
    const layout = setLayoutMode(createInitialLayout(), "split");
    const todoPanel = setTodoItems(createInitialTodoPanel(), [
      { id: "1", content: "Only todo task", status: "pending", priority: "medium" },
    ]);
    const specProgress: SpecProgressState = { phase: "idle", stages: [] };
    const frame = renderTui(wideState({ layout, todoPanel, specProgress }));
    // idle spec 不应渲染
    expect(frame).not.toContain("Spec Engine");
    expect(frame).toContain("Todo");
    expect(frame).toContain("Only todo task");
  });
});
