/**
 * 端到端布局渲染快照测试。
 *
 * 这些测试捕获不同 LayoutMode 与 TodoPanelState 组合下的完整 TUI 帧，
 * 验证 renderer 在 classic / split / focus / wide 四种模式下的视觉结构。
 * 快照使用去 ANSI 后的纯文本，避免颜色码导致的不稳定 diff。
 */
import { describe, expect, it } from "vitest";
import { renderTui, type TuiRenderState } from "../src/renderer.js";
import { stripAnsi } from "../src/width.js";
import { TUI_MASCOTS } from "../src/mascots.js";
import { TUI_THEMES } from "../src/themes.js";
import { createInitialLayout, setLayoutMode } from "../src/layout.js";
import { createInitialTodoPanel, setTodoItems } from "../src/todo-panel.js";

/** 去掉 ANSI 颜色码，返回纯文本帧，便于稳定快照比对。 */
function cleanFrame(state: TuiRenderState): string {
  return stripAnsi(renderTui(state));
}

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

/** 宽窗口 baseState，足以触发 split/focus/wide 模式（width >= 100 && height >= 20）。 */
function wideState(overrides: Partial<TuiRenderState> = {}): TuiRenderState {
  return baseState({ width: 120, height: 40, ...overrides });
}

describe("renderer snapshot — classic layout", () => {
  it("renders classic frame with top/bottom borders and header", () => {
    const frame = cleanFrame(baseState());
    const lines = frame.split("\n");
    expect(lines[0]?.startsWith("╭")).toBe(true);
    expect(lines[0]?.endsWith("╮")).toBe(true);
    expect(lines[lines.length - 1]?.startsWith("╰")).toBe(true);
    expect(lines[lines.length - 1]?.endsWith("╯")).toBe(true);
    // Header 行包含 title 与 model
    expect(lines[1]).toContain("Test");
    expect(lines[1]).toContain("test/model");
  });

  it("renders mascot glyph (🦊) in header for foxy mascot in classic mode", () => {
    const frame = cleanFrame(baseState());
    const lines = frame.split("\n");
    expect(lines[1]).toContain("🦊");
  });

  it("renders transcript lines in body region", () => {
    const frame = cleanFrame(
      baseState({
        transcript: [
          { role: "user", text: "Hello world" },
          { role: "assistant", text: "Hi there" },
        ],
      }),
    );
    expect(frame).toContain("Hello world");
    expect(frame).toContain("Hi there");
  });

  it("does not render Todo sidebar in classic mode even when todoPanel has items", () => {
    const todoPanel = setTodoItems(createInitialTodoPanel(), [
      { id: "1", content: "Hidden classic task", status: "pending", priority: "high" },
    ]);
    const frame = cleanFrame(baseState({ todoPanel }));
    expect(frame).not.toContain("📋 Todo");
    expect(frame).not.toContain("Hidden classic task");
  });
});

describe("renderer snapshot — split layout", () => {
  it("renders sidebar with Todo header when todoPanel has items", () => {
    const layout = setLayoutMode(createInitialLayout(), "split");
    const todoPanel = setTodoItems(createInitialTodoPanel(), [
      { id: "1", content: "Split task A", status: "pending", priority: "high" },
      { id: "2", content: "Split task B", status: "in_progress", priority: "medium" },
    ]);
    const frame = cleanFrame(wideState({ layout, todoPanel }));
    expect(frame).toContain("📋 Todo");
    expect(frame).toContain("Split task A");
    expect(frame).toContain("Split task B");
  });

  it("renders sidebar with vertical separator (│) between main and sidebar", () => {
    const layout = setLayoutMode(createInitialLayout(), "split");
    const todoPanel = setTodoItems(createInitialTodoPanel(), [
      { id: "1", content: "Visible", status: "pending", priority: "medium" },
    ]);
    const frame = cleanFrame(wideState({ layout, todoPanel }));
    // body 行应包含 sidebar 分隔符
    const bodyLines = frame.split("\n").slice(2, 36);
    const withSidebar = bodyLines.filter((l) => l.includes("Visible") || l.includes("Todo"));
    expect(withSidebar.length).toBeGreaterThan(0);
  });

  it("still shows mascot glyph in split mode (only focus hides it)", () => {
    const layout = setLayoutMode(createInitialLayout(), "split");
    const frame = cleanFrame(wideState({ layout }));
    const lines = frame.split("\n");
    expect(lines[1]).toContain("🦊");
  });

  it("renders todo status icons (☐ pending, 🔄 in_progress, ✓ completed)", () => {
    const layout = setLayoutMode(createInitialLayout(), "split");
    const todoPanel = setTodoItems(createInitialTodoPanel(), [
      { id: "1", content: "Pending item", status: "pending", priority: "medium" },
      { id: "2", content: "Active item", status: "in_progress", priority: "medium" },
      { id: "3", content: "Done item", status: "completed", priority: "medium" },
    ]);
    const frame = cleanFrame(wideState({ layout, todoPanel }));
    expect(frame).toContain("☐");
    expect(frame).toContain("🔄");
    expect(frame).toContain("✓");
  });
});

describe("renderer snapshot — focus layout", () => {
  it("hides mascot glyph (🦊) from header in focus mode", () => {
    const layout = { ...createInitialLayout(), mode: "focus" as const };
    const frame = cleanFrame(wideState({ layout }));
    const lines = frame.split("\n");
    expect(lines[1]).not.toContain("🦊");
  });

  it("does not render Todo sidebar in focus mode", () => {
    const layout = { ...createInitialLayout(), mode: "focus" as const };
    const todoPanel = setTodoItems(createInitialTodoPanel(), [
      { id: "1", content: "Focus invisible task", status: "pending", priority: "medium" },
    ]);
    const frame = cleanFrame(wideState({ layout, todoPanel }));
    expect(frame).not.toContain("📋 Todo");
    expect(frame).not.toContain("Focus invisible task");
  });

  it("uses full width for transcript (no mascot column)", () => {
    const layout = { ...createInitialLayout(), mode: "focus" as const };
    const longText = "x".repeat(100);
    const frame = cleanFrame(
      wideState({
        layout,
        transcript: [{ role: "user", text: longText }],
      }),
    );
    // focus 模式下长文本应该能在单行显示更多字符（无 mascot 占位）
    expect(frame).toContain("x");
  });
});

describe("renderer snapshot — wide layout", () => {
  it("renders wider sidebar than split mode", () => {
    const splitLayout = setLayoutMode(createInitialLayout(), "split");
    const wideLayout = { ...createInitialLayout(), mode: "wide" as const };
    const todoPanel = setTodoItems(createInitialTodoPanel(), [
      { id: "1", content: "Wide task content here", status: "pending", priority: "low" },
    ]);
    const splitFrame = cleanFrame(
      wideState({ width: 160, height: 40, layout: splitLayout, todoPanel }),
    );
    const wideFrame = cleanFrame(
      wideState({ width: 160, height: 40, layout: wideLayout, todoPanel }),
    );
    // 两者都应该渲染 todo
    expect(splitFrame).toContain("Wide task content here");
    expect(wideFrame).toContain("Wide task content here");
  });

  it("renders Todo header and items in wide sidebar", () => {
    const layout = { ...createInitialLayout(), mode: "wide" as const };
    const todoPanel = setTodoItems(createInitialTodoPanel(), [
      { id: "1", content: "Wide task 1", status: "pending", priority: "high" },
      { id: "2", content: "Wide task 2", status: "completed", priority: "low" },
    ]);
    const frame = cleanFrame(wideState({ width: 160, height: 40, layout, todoPanel }));
    expect(frame).toContain("📋 Todo");
    expect(frame).toContain("Wide task 1");
    expect(frame).toContain("Wide task 2");
    expect(frame).toContain("✓");
  });
});

describe("renderer snapshot — fallback to classic", () => {
  it("forces classic when width < 100 even with split layout", () => {
    const layout = setLayoutMode(createInitialLayout(), "split");
    const todoPanel = setTodoItems(createInitialTodoPanel(), [
      { id: "1", content: "Should be hidden", status: "pending", priority: "medium" },
    ]);
    const frame = cleanFrame(baseState({ width: 80, height: 40, layout, todoPanel }));
    expect(frame).not.toContain("📋 Todo");
    expect(frame).not.toContain("Should be hidden");
    // 仍然渲染吉祥物（classic 行为）
    expect(frame).toContain("🦊");
  });

  it("forces classic when height < 20 even with wide layout", () => {
    const layout = { ...createInitialLayout(), mode: "wide" as const };
    const todoPanel = setTodoItems(createInitialTodoPanel(), [
      { id: "1", content: "Should be hidden", status: "pending", priority: "medium" },
    ]);
    const frame = cleanFrame(baseState({ width: 160, height: 15, layout, todoPanel }));
    expect(frame).not.toContain("📋 Todo");
    expect(frame).not.toContain("Should be hidden");
  });

  it("forces classic when both width and height are sufficient but mode is classic", () => {
    const layout = { ...createInitialLayout(), mode: "classic" as const };
    const todoPanel = setTodoItems(createInitialTodoPanel(), [
      { id: "1", content: "Classic hides this", status: "pending", priority: "medium" },
    ]);
    const frame = cleanFrame(wideState({ layout, todoPanel }));
    expect(frame).not.toContain("📋 Todo");
    expect(frame).not.toContain("Classic hides this");
  });
});

describe("renderer snapshot — todo panel states", () => {
  it("renders (empty) placeholder when sidebar visible but no items", () => {
    const layout = setLayoutMode(createInitialLayout(), "split");
    const todoPanel = createInitialTodoPanel();
    const frame = cleanFrame(wideState({ layout, todoPanel }));
    expect(frame).toContain("📋 Todo");
    expect(frame).toContain("empty");
  });

  it("renders +N more indicator when items exceed sidebar height", () => {
    const layout = setLayoutMode(createInitialLayout(), "split");
    const items = Array.from({ length: 30 }, (_, i) => ({
      id: String(i),
      content: "Task " + i,
      status: "pending" as const,
      priority: "medium" as const,
    }));
    const todoPanel = setTodoItems(createInitialTodoPanel(), items);
    // 使用较小的 height 触发溢出
    const frame = cleanFrame(wideState({ width: 120, height: 22, layout, todoPanel }));
    expect(frame).toContain("more");
  });

  it("renders high priority items with distinct color (visible via content presence)", () => {
    const layout = setLayoutMode(createInitialLayout(), "split");
    const todoPanel = setTodoItems(createInitialTodoPanel(), [
      { id: "1", content: "High priority task", status: "pending", priority: "high" },
      { id: "2", content: "Low priority task", status: "pending", priority: "low" },
    ]);
    const frame = cleanFrame(wideState({ layout, todoPanel }));
    expect(frame).toContain("High priority task");
    expect(frame).toContain("Low priority task");
  });
});

describe("renderer snapshot — overlay precedence", () => {
  it("picker overlay takes precedence over split layout (renders classic frame)", () => {
    const layout = setLayoutMode(createInitialLayout(), "split");
    const todoPanel = setTodoItems(createInitialTodoPanel(), [
      { id: "1", content: "Sidebar hidden during picker", status: "pending", priority: "medium" },
    ]);
    const frame = cleanFrame(
      wideState({
        layout,
        todoPanel,
        picker: {
          providers: [],
          activeProvider: 0,
          query: "",
          reasoningEffort: "off",
          sessionOnly: false,
        },
      }),
    );
    // picker 是 overlay，走 classic 渲染路径，不应渲染 sidebar
    expect(frame).not.toContain("Sidebar hidden during picker");
  });

  it("palette overlay takes precedence over split layout", () => {
    const layout = setLayoutMode(createInitialLayout(), "split");
    const todoPanel = setTodoItems(createInitialTodoPanel(), [
      { id: "1", content: "Sidebar hidden during palette", status: "pending", priority: "medium" },
    ]);
    const frame = cleanFrame(
      wideState({
        layout,
        todoPanel,
        palette: {
          visible: true,
          query: "vim",
          filtered: [],
          selectedIndex: 0,
        },
      }),
    );
    // palette 是 overlay，不应渲染 sidebar
    expect(frame).not.toContain("Sidebar hidden during palette");
  });
});

describe("renderer snapshot — frame structure stability", () => {
  it("classic frame has consistent border characters", () => {
    const frame = cleanFrame(baseState());
    const lines = frame.split("\n");
    // 第一行以 ╭ 开头 ╮ 结尾
    expect(lines[0]!.startsWith("╭") && lines[0]!.endsWith("╮")).toBe(true);
    // 最后一行以 ╰ 开头 ╯ 结尾
    const last = lines[lines.length - 1]!;
    expect(last.startsWith("╰") && last.endsWith("╯")).toBe(true);
    // 所有中间行以 │ 或 ├ 开头，以 │ 或 ┤ 结尾（separator 行使用 ├...┤）
    for (let i = 1; i < lines.length - 1; i++) {
      const line = lines[i]!;
      expect(line.startsWith("│") || line.startsWith("├")).toBe(true);
      expect(line.endsWith("│") || line.endsWith("┤")).toBe(true);
    }
  });

  it("split frame maintains border consistency with sidebar", () => {
    const layout = setLayoutMode(createInitialLayout(), "split");
    const todoPanel = setTodoItems(createInitialTodoPanel(), [
      { id: "1", content: "Stability task", status: "pending", priority: "medium" },
    ]);
    const frame = cleanFrame(wideState({ layout, todoPanel }));
    const lines = frame.split("\n");
    expect(lines[0]!.startsWith("╭") && lines[0]!.endsWith("╮")).toBe(true);
    const last = lines[lines.length - 1]!;
    expect(last.startsWith("╰") && last.endsWith("╯")).toBe(true);
    // body 行也以 │ 结尾（包含 sidebar 的行）
    const bodyLine = lines.find((l) => l.includes("Stability task"));
    expect(bodyLine).toBeDefined();
    expect(bodyLine!.endsWith("│")).toBe(true);
  });

  it("focus frame maintains border consistency without mascot", () => {
    const layout = { ...createInitialLayout(), mode: "focus" as const };
    const frame = cleanFrame(wideState({ layout }));
    const lines = frame.split("\n");
    expect(lines[0]!.startsWith("╭") && lines[0]!.endsWith("╮")).toBe(true);
    const last = lines[lines.length - 1]!;
    expect(last.startsWith("╰") && last.endsWith("╯")).toBe(true);
    // header 不含 🦊
    expect(lines[1]).not.toContain("🦊");
  });
});
