# TUI Phase 3 实施计划：布局重构 + 信息架构

> **Date:** 2026-07-24
> **Status:** Plan
> **Scope:** packages/tui + apps/cli/src/tui.ts
> **Design Spec:** `docs/superpowers/specs/2026-07-23-tui-deep-optimization-design.md` §3 §6
> **Predecessor:** `docs/superpowers/plans/2026-07-23-tui-phase2-keyboard-efficiency.md`（已完成）

## 0. 目标与约束

### 0.1 目标

1. **引入 Pane 布局引擎**：支持 classic / split / focus / wide 四种布局模式
2. **持久化 Todo 侧栏**：从 SpecEngine `initialTodos` 和 `tool_end` 事件解析 todo，渲染为侧栏 panel
3. **renderer.ts 重构**：保持 `renderTui(state)` 签名不变，内部根据 `LayoutState` 调度 pane 渲染
4. **窗口尺寸自适应**：宽度 < 100 列强制回 classic；高度 < 20 行隐藏侧栏
5. **向后兼容**：缺省 `LayoutState` 时完全保持当前 classic 布局，零破坏性

### 0.2 不可破坏的约束

- `packages/tui` 仍是叶子 adapter，零运行时 npm 依赖
- `packages/tui` 不得依赖任何 `@focuscode/*` 包
- TypeScript strict 配置（`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`verbatimModuleSyntax`、`isolatedModules`）必须通过
- Prettier（printWidth 100、双引号、semicolon、trailing comma `"all"`）必须通过
- 边界检查（`scripts/check-boundaries.mjs`）必须通过
- `renderTui(state)` 签名不变；`TuiRenderState` 新增字段全部可选

### 0.3 TDD + SDD 工作流

每个任务严格遵循：

1. **RED**：先写失败测试，`pnpm build && npx vitest run <test-file>` 确认失败
2. **GREEN**：最小实现让测试通过
3. **REFACTOR**：边界检查 + prettier + 完整 verify

---

## Task 1: 创建 layout.ts 模块（Pane 布局引擎）

### 1.1 目的

定义 Pane 模型与 LayoutState，提供 `computeLayout()` 纯函数，根据 mode / width / height 计算每个 pane 的位置与尺寸。

### 1.2 测试（RED）

**文件**：`packages/tui/test/layout.test.ts`

```typescript
import { describe, expect, it } from "vitest";
import {
  computeLayout,
  createInitialLayout,
  cycleLayoutMode,
  LAYOUT_MODES,
  type LayoutMode,
  type LayoutState,
  type PaneConfig,
} from "../src/layout.js";

describe("layout module", () => {
  it("createInitialLayout returns classic mode with default panes", () => {
    const state = createInitialLayout();
    expect(state.mode).toBe("classic");
    expect(state.activePane).toBe("transcript");
    expect(state.panes.length).toBeGreaterThan(0);
    // classic 模式下 todo/spec/context panes 默认不可见
    const todo = state.panes.find((p) => p.id === "todo");
    expect(todo?.visible).toBe(false);
  });

  it("LAYOUT_MODES lists all four modes in cycle order", () => {
    expect(LAYOUT_MODES).toEqual(["classic", "split", "focus", "wide"]);
  });

  it("cycleLayoutMode advances mode forward and wraps", () => {
    expect(cycleLayoutMode("classic")).toBe("split");
    expect(cycleLayoutMode("split")).toBe("focus");
    expect(cycleLayoutMode("focus")).toBe("wide");
    expect(cycleLayoutMode("wide")).toBe("classic");
  });

  it("computeLayout classic produces single main pane spanning full body", () => {
    const state = createInitialLayout();
    const layout = computeLayout(state, 120, 40);
    expect(layout.main).toBeDefined();
    expect(layout.main.width).toBeGreaterThan(80);
    expect(layout.sidebar).toBeUndefined();
  });

  it("computeLayout split produces main + sidebar at 70/30 ratio", () => {
    const state: LayoutState = { ...createInitialLayout(), mode: "split" };
    const layout = computeLayout(state, 120, 40);
    expect(layout.main).toBeDefined();
    expect(layout.sidebar).toBeDefined();
    expect(layout.sidebar!.width).toBeLessThan(layout.main.width);
    // 70/30 比例容差
    expect(layout.sidebar!.width).toBeGreaterThan(20);
    expect(layout.main.width + layout.sidebar!.width).toBeLessThanOrEqual(118);
  });

  it("computeLayout focus hides mascot and sidebar, full-width transcript", () => {
    const state: LayoutState = { ...createInitialLayout(), mode: "focus" };
    const layout = computeLayout(state, 120, 40);
    expect(layout.sidebar).toBeUndefined();
    expect(layout.hideMascot).toBe(true);
    expect(layout.main.width).toBeGreaterThan(100);
  });

  it("computeLayout wide produces main + wider sidebar at 60/40 ratio", () => {
    const state: LayoutState = { ...createInitialLayout(), mode: "wide" };
    const layout = computeLayout(state, 160, 40);
    expect(layout.main).toBeDefined();
    expect(layout.sidebar).toBeDefined();
    expect(layout.sidebar!.width).toBeGreaterThan(layout.main.width * 0.5);
  });

  it("computeLayout forces classic when width < 100", () => {
    const state: LayoutState = { ...createInitialLayout(), mode: "split" };
    const layout = computeLayout(state, 80, 40);
    expect(layout.sidebar).toBeUndefined();
    expect(layout.mode).toBe("classic");
  });

  it("computeLayout forces classic when height < 20", () => {
    const state: LayoutState = { ...createInitialLayout(), mode: "wide" };
    const layout = computeLayout(state, 160, 15);
    expect(layout.sidebar).toBeUndefined();
    expect(layout.mode).toBe("classic");
  });

  it("PaneConfig side field is one of left/right/bottom/main", () => {
    const state = createInitialLayout();
    for (const pane of state.panes) {
      expect(["left", "right", "bottom", "main"]).toContain(pane.side);
    }
  });
});
```

### 1.3 实现（GREEN）

**文件**：`packages/tui/src/layout.ts`

```typescript
import type { TuiTheme } from "./themes.js";

export type PaneId = "transcript" | "input" | "todo" | "spec" | "context";

export type LayoutMode = "classic" | "split" | "focus" | "wide";

export const LAYOUT_MODES: readonly LayoutMode[] = ["classic", "split", "focus", "wide"] as const;

export interface PaneConfig {
  id: PaneId;
  visible: boolean;
  /** 列宽占比 0..1，undefined 表示自适应。 */
  width?: number;
  /** 行高占比 0..1，undefined 表示自适应。 */
  height?: number;
  side: "left" | "right" | "bottom" | "main";
  /** 最小宽度/高度（列或行）。 */
  minSize?: number;
}

export interface LayoutState {
  mode: LayoutMode;
  panes: PaneConfig[];
  activePane: PaneId;
}

/** 渲染时计算出的 pane 几何信息。 */
export interface ComputedLayout {
  mode: LayoutMode;
  main: PaneGeometry;
  sidebar?: PaneGeometry;
  /** focus 模式下隐藏吉祥物。 */
  hideMascot: boolean;
  /** sidebar 可见的具体 pane id 列表（按渲染顺序）。 */
  sidebarPanes: PaneId[];
}

export interface PaneGeometry {
  width: number;
  height: number;
  col: number; // 起始列（0-based）
  row: number; // 起始行（0-based）
}

export function createInitialLayout(): LayoutState {
  return {
    mode: "classic",
    activePane: "transcript",
    panes: [
      { id: "transcript", visible: true, side: "main" },
      { id: "input", visible: true, side: "bottom" },
      { id: "todo", visible: false, side: "right" },
      { id: "spec", visible: false, side: "right" },
      { id: "context", visible: false, side: "right" },
    ],
  };
}

export function cycleLayoutMode(mode: LayoutMode): LayoutMode {
  const idx = LAYOUT_MODES.indexOf(mode);
  return LAYOUT_MODES[(idx + 1) % LAYOUT_MODES.length]!;
}

export function setLayoutMode(state: LayoutState, mode: LayoutMode): LayoutState {
  // split/wide 模式下显示 todo/spec/context 侧栏
  const showSidebar = mode === "split" || mode === "wide";
  const panes = state.panes.map((pane) => {
    if (pane.side === "right") {
      return { ...pane, visible: showSidebar };
    }
    return pane;
  });
  return { ...state, mode, panes };
}

/**
 * 根据当前 LayoutState 和终端尺寸计算 pane 几何。
 * 宽度 < 100 或高度 < 20 强制回 classic。
 */
export function computeLayout(state: LayoutState, width: number, height: number): ComputedLayout {
  // 强制 classic 的回退条件
  if (width < 100 || height < 20) {
    return computeClassicLayout(width, height);
  }
  switch (state.mode) {
    case "classic":
      return computeClassicLayout(width, height);
    case "split":
      return computeSplitLayout(width, height, state);
    case "focus":
      return computeFocusLayout(width, height);
    case "wide":
      return computeWideLayout(width, height, state);
    default:
      return computeClassicLayout(width, height);
  }
}

function computeClassicLayout(width: number, height: number): ComputedLayout {
  return {
    mode: "classic",
    main: { width: Math.max(40, width - 4), height: Math.max(10, height - 6), col: 2, row: 2 },
    hideMascot: false,
    sidebarPanes: [],
  };
}

function computeSplitLayout(width: number, height: number, state: LayoutState): ComputedLayout {
  const sidebarWidth = Math.max(20, Math.floor(width * 0.3));
  const mainWidth = width - sidebarWidth - 4;
  const sidebarPanes = visibleSidebarPanes(state);
  return {
    mode: "split",
    main: { width: mainWidth, height: Math.max(10, height - 6), col: 2, row: 2 },
    sidebar: { width: sidebarWidth, height: Math.max(10, height - 6), col: mainWidth + 3, row: 2 },
    hideMascot: false,
    sidebarPanes,
  };
}

function computeFocusLayout(width: number, height: number): ComputedLayout {
  return {
    mode: "focus",
    main: { width: Math.max(40, width - 4), height: Math.max(10, height - 6), col: 2, row: 2 },
    hideMascot: true,
    sidebarPanes: [],
  };
}

function computeWideLayout(width: number, height: number, state: LayoutState): ComputedLayout {
  const sidebarWidth = Math.max(30, Math.floor(width * 0.4));
  const mainWidth = width - sidebarWidth - 4;
  const sidebarPanes = visibleSidebarPanes(state);
  return {
    mode: "wide",
    main: { width: mainWidth, height: Math.max(10, height - 6), col: 2, row: 2 },
    sidebar: { width: sidebarWidth, height: Math.max(10, height - 6), col: mainWidth + 3, row: 2 },
    hideMascot: false,
    sidebarPanes,
  };
}

function visibleSidebarPanes(state: LayoutState): PaneId[] {
  const order: PaneId[] = ["todo", "spec", "context"];
  return order.filter((id) => state.panes.find((p) => p.id === id)?.visible);
}

/** 主题着色 helper（供 renderer 使用）。 */
export function paneBorder(theme: TuiTheme): string {
  return theme.muted.toString();
}
```

### 1.4 验证

```bash
pnpm build && npx vitest run packages/tui/test/layout.test.ts
```

---

## Task 2: 创建 todo-panel.ts 模块（Todo 侧栏）

### 2.1 目的

定义 TodoItem / TodoPanelState，提供 `renderTodoPanel()` 纯函数渲染 todo 列表。

### 2.2 测试（RED）

**文件**：`packages/tui/test/todo-panel.test.ts`

```typescript
import { describe, expect, it } from "vitest";
import {
  addTodoItem,
  createInitialTodoPanel,
  removeTodoItem,
  renderTodoPanel,
  setTodoItems,
  updateTodoStatus,
  type TodoItem,
  type TodoPanelState,
} from "../src/todo-panel.js";
import { TUI_THEMES } from "../src/themes.js";

describe("todo-panel module", () => {
  const theme = TUI_THEMES[0]!;

  it("createInitialTodoPanel has empty items and is visible", () => {
    const state = createInitialTodoPanel();
    expect(state.items).toEqual([]);
    expect(state.visible).toBe(true);
    expect(state.filter).toBe("all");
  });

  it("addTodoItem appends with pending status and medium priority by default", () => {
    const state = createInitialTodoPanel();
    const next = addTodoItem(state, "Write tests");
    expect(next.items).toHaveLength(1);
    expect(next.items[0]?.content).toBe("Write tests");
    expect(next.items[0]?.status).toBe("pending");
    expect(next.items[0]?.priority).toBe("medium");
    expect(next.items[0]?.id).toBeTruthy();
  });

  it("updateTodoStatus transitions pending -> in_progress -> completed", () => {
    const state = createInitialTodoPanel();
    const withItem = addTodoItem(state, "Task");
    const id = withItem.items[0]!.id;
    const inProgress = updateTodoStatus(withItem, id, "in_progress");
    expect(inProgress.items[0]?.status).toBe("in_progress");
    const done = updateTodoStatus(inProgress, id, "completed");
    expect(done.items[0]?.status).toBe("completed");
  });

  it("removeTodoItem removes by id", () => {
    const state = createInitialTodoPanel();
    const withItem = addTodoItem(state, "Task");
    const id = withItem.items[0]!.id;
    const removed = removeTodoItem(withItem, id);
    expect(removed.items).toHaveLength(0);
  });

  it("setTodoItems replaces entire list (used by SpecEngine initialTodos injection)", () => {
    const state = createInitialTodoPanel();
    const items: TodoItem[] = [
      { id: "t1", content: "Step 1", status: "pending", priority: "high" },
      { id: "t2", content: "Step 2", status: "pending", priority: "medium" },
    ];
    const next = setTodoItems(state, items);
    expect(next.items).toHaveLength(2);
    expect(next.items[0]?.id).toBe("t1");
  });

  it("renderTodoPanel renders header and items with status icons", () => {
    const state: TodoPanelState = {
      visible: true,
      filter: "all",
      items: [
        { id: "1", content: "Pending task", status: "pending", priority: "high" },
        { id: "2", content: "Active task", status: "in_progress", priority: "medium" },
        { id: "3", content: "Done task", status: "completed", priority: "low" },
      ],
    };
    const lines = renderTodoPanel(state, 30, 10, theme);
    expect(lines.length).toBeGreaterThan(0);
    const joined = lines.join("\n");
    expect(joined).toContain("Todo");
    expect(joined).toContain("Pending task");
    expect(joined).toContain("Active task");
    expect(joined).toContain("Done task");
    // 状态图标
    expect(joined).toContain("☐"); // pending
    expect(joined).toContain("🔄"); // in_progress
    expect(joined).toContain("✓"); // completed
  });

  it("renderTodoPanel returns empty when not visible", () => {
    const state: TodoPanelState = { visible: false, filter: "all", items: [] };
    expect(renderTodoPanel(state, 30, 10, theme)).toEqual([]);
  });

  it("renderTodoPanel truncates long content to fit width", () => {
    const longContent = "A".repeat(100);
    const state: TodoPanelState = {
      visible: true,
      filter: "all",
      items: [{ id: "1", content: longContent, status: "pending", priority: "medium" }],
    };
    const lines = renderTodoPanel(state, 20, 10, theme);
    // 每行可见长度不超过 width
    for (const line of lines) {
      // stripAnsi 后再测长度（这里用简化版本）
      expect(line.length).toBeLessThan(60); // ANSI 转义会增加长度，但内容截断
    }
  });

  it("renderTodoPanel respects filter pending", () => {
    const state: TodoPanelState = {
      visible: true,
      filter: "pending",
      items: [
        { id: "1", content: "Pending", status: "pending", priority: "medium" },
        { id: "2", content: "Done", status: "completed", priority: "medium" },
      ],
    };
    const lines = renderTodoPanel(state, 30, 10, theme);
    const joined = lines.join("\n");
    expect(joined).toContain("Pending");
    expect(joined).not.toContain("Done");
  });
});
```

### 2.3 实现（GREEN）

**文件**：`packages/tui/src/todo-panel.ts`

```typescript
import { fg, type TuiTheme } from "./themes.js";
import { stringWidth, stripAnsi, takeWidth } from "./width.js";

export type TodoStatus = "pending" | "in_progress" | "completed";
export type TodoPriority = "high" | "medium" | "low";

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
  priority: TodoPriority;
  /** SpecEngine 注入的初始 todo 携带的 active form。 */
  activeForm?: string;
}

export interface TodoPanelState {
  items: TodoItem[];
  visible: boolean;
  filter: "all" | "pending" | "completed";
}

export function createInitialTodoPanel(): TodoPanelState {
  return { items: [], visible: true, filter: "all" };
}

let todoIdCounter = 0;
function nextTodoId(): string {
  todoIdCounter += 1;
  return "todo_" + todoIdCounter;
}

export function addTodoItem(
  state: TodoPanelState,
  content: string,
  priority: TodoPriority = "medium",
): TodoPanelState {
  const item: TodoItem = {
    id: nextTodoId(),
    content,
    status: "pending",
    priority,
  };
  return { ...state, items: [...state.items, item] };
}

export function updateTodoStatus(
  state: TodoPanelState,
  id: string,
  status: TodoStatus,
): TodoPanelState {
  return {
    ...state,
    items: state.items.map((item) => (item.id === id ? { ...item, status } : item)),
  };
}

export function removeTodoItem(state: TodoPanelState, id: string): TodoPanelState {
  return { ...state, items: state.items.filter((item) => item.id !== id) };
}

export function setTodoItems(state: TodoPanelState, items: TodoItem[]): TodoPanelState {
  return { ...state, items: [...items] };
}

export function clearCompletedTodos(state: TodoPanelState): TodoPanelState {
  return { ...state, items: state.items.filter((item) => item.status !== "completed") };
}

const STATUS_ICONS: Record<TodoStatus, string> = {
  pending: "☐",
  in_progress: "🔄",
  completed: "✓",
};

function priorityColor(priority: TodoPriority, theme: TuiTheme): number {
  switch (priority) {
    case "high":
      return theme.danger;
    case "medium":
      return theme.warning;
    case "low":
      return theme.muted;
  }
}

export function renderTodoPanel(
  state: TodoPanelState,
  width: number,
  height: number,
  theme: TuiTheme,
): string[] {
  if (!state.visible || width < 10) return [];
  const lines: string[] = [];
  // Header
  lines.push(fg(theme.accent, "📋 Todo"));
  // Filter items
  const filtered = state.items.filter((item) => {
    if (state.filter === "all") return true;
    if (state.filter === "pending") return item.status !== "completed";
    if (state.filter === "completed") return item.status === "completed";
    return true;
  });
  // Items
  const maxItems = Math.max(0, height - 2);
  const visible = filtered.slice(0, maxItems);
  for (const item of visible) {
    const icon = STATUS_ICONS[item.status];
    const priority = priorityColor(item.priority, theme);
    const prefix = icon + " ";
    const contentWidth = Math.max(4, width - stringWidth(prefix) - 2);
    const content = truncateContent(item.content, contentWidth);
    const line = " " + prefix + fg(priority, content);
    lines.push(line);
  }
  if (filtered.length > maxItems) {
    lines.push(fg(theme.muted, " …+" + (filtered.length - maxItems) + " more"));
  }
  if (filtered.length === 0) {
    lines.push(fg(theme.muted, " (empty)"));
  }
  return lines;
}

function truncateContent(text: string, width: number): string {
  const clean = stripAnsi(text);
  if (stringWidth(clean) <= width) return clean;
  return takeWidth(clean, Math.max(1, width - 1)) + "…";
}
```

### 2.4 验证

```bash
pnpm build && npx vitest run packages/tui/test/todo-panel.test.ts
```

---

## Task 3: 扩展 keymap.ts（cycle_layout / toggle_todo_panel actions）

### 3.1 目的

新增两个 action：

- `cycle_layout`：循环切换布局模式
- `toggle_todo_panel`：显隐 todo 侧栏

键位选择（避免与现有冲突）：

- `alt+l` → `cycle_layout`（Ctrl+L 当前是 clear，不重用）
- `alt+t` → `toggle_todo_panel`（Ctrl+T 当前是 cycle_theme，不重用）

### 3.2 测试（RED）

**文件**：追加到 `packages/tui/test/keymap.test.ts`（若不存在则创建）

```typescript
import { describe, expect, it } from "vitest";
import { DEFAULT_KEYMAP, mergeKeymap, VALID_ACTIONS, type TuiAction } from "../src/keymap.js";

describe("keymap phase3 extensions", () => {
  it("DEFAULT_KEYMAP binds alt+l to cycle_layout", () => {
    expect(DEFAULT_KEYMAP["alt+l"]).toBe("cycle_layout");
  });

  it("DEFAULT_KEYMAP binds alt+t to toggle_todo_panel", () => {
    expect(DEFAULT_KEYMAP["alt+t"]).toBe("toggle_todo_panel");
  });

  it("VALID_ACTIONS includes cycle_layout and toggle_todo_panel", () => {
    expect(VALID_ACTIONS).toContain("cycle_layout");
    expect(VALID_ACTIONS).toContain("toggle_todo_panel");
  });

  it("mergeKeymap accepts alt+l override", () => {
    const km = mergeKeymap({ "alt+l": "cycle_layout" });
    expect(km["alt+l"]).toBe("cycle_layout");
  });
});
```

### 3.3 实现（GREEN）

修改 `packages/tui/src/keymap.ts`：

1. 在 `TuiAction` union 中追加 `"cycle_layout"` 和 `"toggle_todo_panel"`
2. 在 `DEFAULT_KEYMAP` 中追加 `"alt+l": "cycle_layout"` 和 `"alt+t": "toggle_todo_panel"`
3. 在 `VALID_ACTIONS` 数组中追加两项

### 3.4 验证

```bash
pnpm build && npx vitest run packages/tui/test/keymap.test.ts
```

---

## Task 4: 扩展 TuiRenderState 支持 LayoutState 与 TodoPanelState

### 4.1 目的

在 `renderer.ts` 的 `TuiRenderState` 中新增可选字段：

- `layout?: LayoutState`
- `todoPanel?: TodoPanelState`

缺省时 renderer 走 classic 路径（向后兼容）。

### 4.2 测试（RED）

**文件**：追加到 `packages/tui/test/renderer.test.ts`

```typescript
import { describe, expect, it } from "vitest";
import { renderTui, type TuiRenderState } from "../src/renderer.js";
import { TUI_THEMES } from "../src/themes.js";
import { TUI_MASCOTS } from "../src/mascots.js";
import { createInitialLayout } from "../src/layout.js";
import { createInitialTodoPanel, setTodoItems } from "../src/todo-panel.js";

function baseState(overrides: Partial<TuiRenderState> = {}): TuiRenderState {
  return {
    width: 120,
    height: 40,
    title: "FocusCode",
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

describe("renderer layout integration", () => {
  it("renderTui without layout field renders classic frame", () => {
    const frame = renderTui(baseState());
    expect(frame).toContain("FocusCode");
    expect(frame).toContain("│");
  });

  it("renderTui with classic layout produces same shape as without layout", () => {
    const withoutLayout = renderTui(baseState());
    const withLayout = renderTui(baseState({ layout: createInitialLayout() }));
    // 应该产生相同输出（向后兼容）
    expect(withLayout).toBe(withoutLayout);
  });

  it("renderTui with split layout renders sidebar with todo header", () => {
    const layout = { ...createInitialLayout(), mode: "split" as const };
    const todoPanel = setTodoItems(createInitialTodoPanel(), [
      { id: "1", content: "Task A", status: "pending", priority: "high" },
    ]);
    const frame = renderTui(baseState({ layout, todoPanel }));
    expect(frame).toContain("Todo");
    expect(frame).toContain("Task A");
  });

  it("renderTui with focus layout hides mascot name from header", () => {
    const layout = { ...createInitialLayout(), mode: "focus" as const };
    const frame = renderTui(baseState({ layout }));
    // focus 模式 header 不显示吉祥物 emoji（foxy 的 🦊）
    const firstLine = frame.split("\n")[1] ?? "";
    expect(firstLine).not.toContain("🦊");
  });

  it("renderTui forces classic when width < 100 even if mode is split", () => {
    const layout = { ...createInitialLayout(), mode: "split" as const };
    const todoPanel = setTodoItems(createInitialTodoPanel(), [
      { id: "1", content: "Task A", status: "pending", priority: "medium" },
    ]);
    const frame = renderTui(baseState({ width: 80, height: 40, layout, todoPanel }));
    // 经典布局不应该出现 sidebar
    expect(frame).not.toContain("Task A");
  });
});
```

### 4.4 实现（GREEN）

修改 `packages/tui/src/renderer.ts`：

1. 导入 `LayoutState, computeLayout, ComputedLayout` from `./layout.js`
2. 导入 `TodoPanelState, renderTodoPanel` from `./todo-panel.js`
3. 在 `TuiRenderState` 中追加 `layout?: LayoutState` 和 `todoPanel?: TodoPanelState`
4. 在 `renderTui()` 开头：
   - 若 `state.layout` 存在，调用 `computeLayout(state.layout, width, height)` 得到 `ComputedLayout`
   - 根据 `ComputedLayout.mode` 分派到 `renderClassicFrame()` / `renderSplitFrame()` / `renderFocusFrame()` / `renderWideFrame()`
   - 缺省 `state.layout` 走原 classic 路径
5. 提取当前单体逻辑为 `renderClassicFrame(state, width, height, theme)` 函数
6. 新增 `renderSidebar(layout, todoPanel, specProgress, contextUsage, theme)` 渲染右侧侧栏
7. `renderSplitFrame` / `renderWideFrame` 调用 `renderClassicFrame` 渲染 main 区域，再拼接 sidebar

**关键约束**：保持 `renderTui(state)` 签名不变；缺省 layout 时输出必须与重构前完全一致（向后兼容黄金路径）。

### 4.5 验证

```bash
pnpm build && npx vitest run packages/tui/test/renderer.test.ts
```

---

## Task 5: 扩展 FullScreenTui（app.ts）支持布局与 todo 状态

### 5.1 目的

在 `FullScreenTui` 类中：

1. 新增 `private layout: LayoutState = createInitialLayout()`
2. 新增 `private todoPanel: TodoPanelState = createInitialTodoPanel()`
3. 新增公开方法：
   - `setLayoutMode(mode: LayoutMode): void`
   - `getLayoutState(): LayoutState`
   - `cycleLayout(): void`（被 `cycle_layout` action 调用）
   - `setTodoItems(items: TodoItem[]): void`
   - `addTodo(content: string, priority?: TodoPriority): void`
   - `updateTodoStatus(id: string, status: TodoStatus): void`
   - `clearTodos(): void`
   - `toggleTodoPanel(): void`
   - `getTodoPanelState(): TodoPanelState`
4. 在 `action()` 中处理 `cycle_layout` 和 `toggle_todo_panel`
5. 在 `snapshot()` 中包含 `layout` 和 `todoPanel` 字段
6. 在构造 `TuiRenderState` 时注入 `layout` 和 `todoPanel`

### 5.2 测试（RED）

**文件**：追加到 `packages/tui/test/app.test.ts`

```typescript
describe("FullScreenTui layout state", () => {
  it("getLayoutState returns classic by default", () => {
    const tui = createTui();
    expect(tui.getLayoutState().mode).toBe("classic");
  });

  it("setLayoutMode switches to split and updates panes visibility", () => {
    const tui = createTui();
    tui.setLayoutMode("split");
    const state = tui.getLayoutState();
    expect(state.mode).toBe("split");
    const todo = state.panes.find((p) => p.id === "todo");
    expect(todo?.visible).toBe(true);
  });

  it("cycleLayout advances classic -> split -> focus -> wide -> classic", () => {
    const tui = createTui();
    expect(tui.getLayoutState().mode).toBe("classic");
    tui.cycleLayout();
    expect(tui.getLayoutState().mode).toBe("split");
    tui.cycleLayout();
    expect(tui.getLayoutState().mode).toBe("focus");
    tui.cycleLayout();
    expect(tui.getLayoutState().mode).toBe("wide");
    tui.cycleLayout();
    expect(tui.getLayoutState().mode).toBe("classic");
  });

  it("snapshot includes layout field", () => {
    const tui = createTui();
    tui.setLayoutMode("split");
    const snap = tui.snapshot();
    expect(snap.layout?.mode).toBe("split");
  });
});

describe("FullScreenTui todo panel state", () => {
  it("getTodoPanelState returns empty panel by default", () => {
    const tui = createTui();
    const state = tui.getTodoPanelState();
    expect(state.items).toEqual([]);
    expect(state.visible).toBe(true);
  });

  it("addTodo appends item with pending status", () => {
    const tui = createTui();
    tui.addTodo("Write tests");
    const state = tui.getTodoPanelState();
    expect(state.items).toHaveLength(1);
    expect(state.items[0]?.content).toBe("Write tests");
    expect(state.items[0]?.status).toBe("pending");
  });

  it("setTodoItems replaces list (SpecEngine injection)", () => {
    const tui = createTui();
    tui.addTodo("Old item");
    tui.setTodoItems([
      { id: "t1", content: "New 1", status: "pending", priority: "high" },
      { id: "t2", content: "New 2", status: "pending", priority: "medium" },
    ]);
    const state = tui.getTodoPanelState();
    expect(state.items).toHaveLength(2);
    expect(state.items[0]?.id).toBe("t1");
  });

  it("updateTodoStatus transitions status", () => {
    const tui = createTui();
    tui.addTodo("Task");
    const id = tui.getTodoPanelState().items[0]!.id;
    tui.updateTodoStatus(id, "completed");
    expect(tui.getTodoPanelState().items[0]?.status).toBe("completed");
  });

  it("toggleTodoPanel flips visibility", () => {
    const tui = createTui();
    const initial = tui.getTodoPanelState().visible;
    tui.toggleTodoPanel();
    expect(tui.getTodoPanelState().visible).toBe(!initial);
  });

  it("snapshot includes todoPanel field", () => {
    const tui = createTui();
    tui.addTodo("Task");
    const snap = tui.snapshot();
    expect(snap.todoPanel?.items).toHaveLength(1);
  });

  it("action cycle_layout advances layout mode", () => {
    const tui = createTui();
    void tui.action("cycle_layout");
    expect(tui.getLayoutState().mode).toBe("split");
  });

  it("action toggle_todo_panel flips visibility", () => {
    const tui = createTui();
    const initial = tui.getTodoPanelState().visible;
    void tui.action("toggle_todo_panel");
    expect(tui.getTodoPanelState().visible).toBe(!initial);
  });
});
```

### 5.3 实现（GREEN）

修改 `packages/tui/src/app.ts`：

1. 导入 `LayoutState, LayoutMode, createInitialLayout, cycleLayoutMode, setLayoutMode as setLayoutModeHelper` from `./layout.js`
2. 导入 `TodoPanelState, TodoItem, TodoStatus, TodoPriority, createInitialTodoPanel, addTodoItem, updateTodoStatus as updateTodoStatusHelper, setTodoItems as setTodoItemsHelper, clearCompletedTodos` from `./todo-panel.js`
3. 新增私有字段 `private layout: LayoutState = createInitialLayout()` 和 `private todoPanel: TodoPanelState = createInitialTodoPanel()`
4. 新增公开方法（见 5.1 列表）
5. 在 `action()` 的 switch 中追加：
   ```typescript
   case "cycle_layout":
     this.cycleLayout();
     break;
   case "toggle_todo_panel":
     this.toggleTodoPanel();
     break;
   ```
6. 在 `buildRenderState()` / `snapshot()` 中追加 `layout: this.layout` 和 `todoPanel: this.todoPanel`

### 5.4 验证

```bash
pnpm build && npx vitest run packages/tui/test/app.test.ts
```

---

## Task 6: 集成 layout/todo-panel 导出（index.ts）

### 6.1 目的

在 `packages/tui/src/index.ts` 中追加导出 `./layout.js` 和 `./todo-panel.js`。

### 6.2 测试（RED）

**文件**：追加到 `packages/tui/test/index.test.ts`

```typescript
import * as Tui from "../src/index.js";

describe("TUI phase3 exports", () => {
  it("exports layout module functions and types", () => {
    expect(typeof Tui.createInitialLayout).toBe("function");
    expect(typeof Tui.computeLayout).toBe("function");
    expect(typeof Tui.cycleLayoutMode).toBe("function");
    expect(typeof Tui.setLayoutMode).toBe("function");
    expect(Array.isArray(Tui.LAYOUT_MODES)).toBe(true);
  });

  it("exports todo-panel module functions and types", () => {
    expect(typeof Tui.createInitialTodoPanel).toBe("function");
    expect(typeof Tui.addTodoItem).toBe("function");
    expect(typeof Tui.updateTodoStatus).toBe("function");
    expect(typeof Tui.removeTodoItem).toBe("function");
    expect(typeof Tui.setTodoItems).toBe("function");
    expect(typeof Tui.renderTodoPanel).toBe("function");
  });

  it("exports layout type definitions via type re-export", () => {
    const sample: Tui.LayoutState = Tui.createInitialLayout();
    expect(sample.mode).toBe("classic");
  });

  it("exports todo-panel type definitions via type re-export", () => {
    const sample: Tui.TodoPanelState = Tui.createInitialTodoPanel();
    expect(sample.items).toEqual([]);
  });
});
```

### 6.3 实现（GREEN）

修改 `packages/tui/src/index.ts` 追加：

```typescript
export * from "./layout.js";
export * from "./todo-panel.js";
```

### 6.4 验证

```bash
pnpm build && npx vitest run packages/tui/test/index.test.ts
```

---

## Task 7: CLI 集成（apps/cli/src/tui.ts）— /layout 与 /todo 命令

### 7.1 目的

1. 在 `TUI_SLASH_COMMANDS` 中追加 `/layout` 和 `/todo` 命令描述
2. 在 `onCommand` 中处理：
   - `/layout [classic|split|focus|wide]`：无参数时循环切换；有参数时直接设置
   - `/todo add <text>`：追加 todo
   - `/todo done <id>`：标记完成
   - `/todo clear`：清空已完成
   - `/todo list`：输出当前 todo 列表为文本
   - `/todo panel`：切换侧栏显隐
3. 在 `renderEvent()` 中解析 `tool_end` 事件的 TodoWrite 工具调用，更新 todoPanel
4. 在 `spec_completed` 事件中，若 `enhancedPrompt` 携带 `initialTodos`，注入到 todoPanel

### 7.2 测试（RED）

**文件**：追加到 `apps/cli/test/tui-spec-events.test.ts`

```typescript
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@focuscode/agent-runtime";
import { FullScreenTui, TUI_THEMES, TUI_MASCOTS } from "@focuscode/tui";
import { renderEvent } from "../src/tui.js";

function createTui(): FullScreenTui {
  /* same helper as existing */
}

describe("renderEvent tool_end TodoWrite parsing", () => {
  it("tool_end with TodoWrite tool_call updates todo panel items", () => {
    const tui = createTui();
    const event: AgentEvent = {
      type: "tool_end",
      toolCallId: "tc1",
      toolName: "TodoWrite",
      output: {
        todos: [
          { id: "t1", content: "Implement feature", status: "pending", priority: "high" },
          { id: "t2", content: "Write tests", status: "pending", priority: "medium" },
        ],
      },
    } as never;
    renderEvent(tui, event);
    const state = tui.getTodoPanelState();
    expect(state.items).toHaveLength(2);
    expect(state.items[0]?.content).toBe("Implement feature");
  });

  it("tool_end with non-TodoWrite tool does not modify todo panel", () => {
    const tui = createTui();
    tui.addTodo("Existing");
    const event: AgentEvent = {
      type: "tool_end",
      toolCallId: "tc2",
      toolName: "Bash",
      output: "ok",
    } as never;
    renderEvent(tui, event);
    const state = tui.getTodoPanelState();
    expect(state.items).toHaveLength(1);
    expect(state.items[0]?.content).toBe("Existing");
  });
});
```

**文件**：新增 `apps/cli/test/tui-layout-commands.test.ts`

```typescript
import { describe, expect, it } from "vitest";
import { runFullScreenAgent } from "../src/tui.js";
// 注：由于 runFullScreenAgent 需要完整 TTY，这里只测试命令字符串解析逻辑
// 通过抽取 parseLayoutCommand / parseTodoCommand 纯函数来测试

describe("layout command parsing", () => {
  it("parseLayoutCommand returns cycle when no arg", () => {
    // 期望抽取的纯函数
  });

  it("parseLayoutCommand returns mode when valid arg", () => {});
});
```

### 7.3 实现（GREEN）

修改 `apps/cli/src/tui.ts`：

1. 在 `TUI_SLASH_COMMANDS` 中追加：
   ```typescript
   { name: "layout", description: "Switch or cycle layout (classic|split|focus|wide)" },
   { name: "todo", description: "Manage todos (add|done|clear|list|panel)" },
   ```
2. 在 `onCommand` 中追加 `name === "layout"` 和 `name === "todo"` 分支
3. 在 `renderEvent()` 的 `tool_end` case 中，若 `event.toolName === "TodoWrite"` 且 `event.output.todos` 存在，调用 `tui.setTodoItems(...)`
4. 在 `spec_completed` case 中，若 `event.initialTodos` 存在，调用 `tui.setTodoItems(...)`

### 7.4 验证

```bash
pnpm build && npx vitest run apps/cli/test/tui-spec-events.test.ts apps/cli/test/tui-layout-commands.test.ts
```

---

## Task 8: 更新 command-palette.ts 的 layout/todo 命令回调

### 8.1 目的

`BUILTIN_COMMANDS` 中已注册 `layout:classic` / `layout:split` 等命令 ID，但当前 `onPaletteCommand` 回调未处理。需要：

1. 在 `apps/cli/src/tui.ts` 的 `onPaletteCommand` 回调中，根据 command.id 分派：
   - `layout:*` → `tui.setLayoutMode(...)`
   - `vim:toggle` → `tui.setVimEnabled(!tui.getVimState())`
   - `todo:panel` → `tui.toggleTodoPanel()`
2. 在 `command-palette.ts` 中追加 `todo:panel` 和 `todo:clear` 命令

### 8.2 测试（RED）

**文件**：追加到 `packages/tui/test/command-palette.test.ts`

```typescript
describe("command-palette phase3 commands", () => {
  it("BUILTIN_COMMANDS includes layout:classic", () => {
    const cmd = BUILTIN_COMMANDS.find((c) => c.id === "layout:classic");
    expect(cmd).toBeDefined();
    expect(cmd?.category).toBe("view");
  });

  it("BUILTIN_COMMANDS includes todo:panel toggle", () => {
    const cmd = BUILTIN_COMMANDS.find((c) => c.id === "todo:panel");
    expect(cmd).toBeDefined();
    expect(cmd?.category).toBe("view");
  });

  it("BUILTIN_COMMANDS includes layout:wide", () => {
    const cmd = BUILTIN_COMMANDS.find((c) => c.id === "layout:wide");
    expect(cmd).toBeDefined();
  });

  it("BUILTIN_COMMANDS includes layout:focus", () => {
    const cmd = BUILTIN_COMMANDS.find((c) => c.id === "layout:focus");
    expect(cmd).toBeDefined();
  });
});
```

### 8.3 实现（GREEN）

修改 `packages/tui/src/command-palette.ts`：

1. 确认 `BUILTIN_COMMANDS` 包含：
   - `layout:classic`、`layout:split`、`layout:focus`、`layout:wide`
   - `todo:panel`（Toggle Todo Panel）
   - `todo:clear`（Clear Completed Todos）

修改 `apps/cli/src/tui.ts`：

1. 在 `FullScreenTui` 构造时传入 `onPaletteCommand` 回调：
   ```typescript
   onPaletteCommand: (cmd: PaletteCommand) => {
     handlePaletteCommand(cmd, tui);
   },
   ```
2. 新增 `handlePaletteCommand(cmd, tui)` 函数：
   ```typescript
   function handlePaletteCommand(cmd: PaletteCommand, tui: FullScreenTui): void {
     switch (cmd.id) {
       case "layout:classic":
         tui.setLayoutMode("classic");
         break;
       case "layout:split":
         tui.setLayoutMode("split");
         break;
       case "layout:focus":
         tui.setLayoutMode("focus");
         break;
       case "layout:wide":
         tui.setLayoutMode("wide");
         break;
       case "vim:toggle":
         tui.setVimEnabled(tui.getVimState() === undefined);
         break;
       case "todo:panel":
         tui.toggleTodoPanel();
         break;
       // ...其他命令
     }
   }
   ```

### 8.4 验证

```bash
pnpm build && npx vitest run packages/tui/test/command-palette.test.ts
```

---

## Task 9: 端到端布局渲染快照测试

### 9.1 目的

为四种布局模式创建快照测试，确保渲染输出稳定且符合预期。

### 9.2 测试（RED）

**文件**：新增 `packages/tui/test/layout-snapshot.test.ts`

```typescript
import { describe, expect, it } from "vitest";
import { renderTui, type TuiRenderState } from "../src/renderer.js";
import { TUI_THEMES } from "../src/themes.js";
import { TUI_MASCOTS } from "../src/mascots.js";
import { createInitialLayout } from "../src/layout.js";
import { createInitialTodoPanel, setTodoItems } from "../src/todo-panel.js";

function baseState(overrides: Partial<TuiRenderState> = {}): TuiRenderState {
  return {
    width: 120,
    height: 40,
    title: "FocusCode",
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
    transcript: [
      { role: "user", text: "Hello" },
      { role: "assistant", text: "Hi there" },
    ],
    input: "",
    inputCursor: { row: 0, col: 0 },
    attachments: [],
    scrollOffset: 0,
    ...overrides,
  };
}

describe("layout snapshot tests", () => {
  it("classic layout renders without sidebar", () => {
    const frame = renderTui(baseState({ layout: createInitialLayout() }));
    expect(frame).toMatchSnapshot();
  });

  it("split layout renders sidebar with todo", () => {
    const layout = { ...createInitialLayout(), mode: "split" as const };
    const todoPanel = setTodoItems(createInitialTodoPanel(), [
      { id: "1", content: "Task A", status: "pending", priority: "high" },
      { id: "2", content: "Task B", status: "in_progress", priority: "medium" },
    ]);
    const frame = renderTui(baseState({ layout, todoPanel }));
    expect(frame).toMatchSnapshot();
  });

  it("focus layout hides mascot", () => {
    const layout = { ...createInitialLayout(), mode: "focus" as const };
    const frame = renderTui(baseState({ layout }));
    expect(frame).toMatchSnapshot();
    expect(frame).not.toContain("🦊");
  });

  it("wide layout renders wider sidebar", () => {
    const layout = { ...createInitialLayout(), mode: "wide" as const };
    const todoPanel = setTodoItems(createInitialTodoPanel(), [
      { id: "1", content: "Wide task", status: "pending", priority: "low" },
    ]);
    const frame = renderTui(baseState({ width: 160, height: 40, layout, todoPanel }));
    expect(frame).toMatchSnapshot();
  });

  it("narrow terminal forces classic even with split mode", () => {
    const layout = { ...createInitialLayout(), mode: "split" as const };
    const todoPanel = setTodoItems(createInitialTodoPanel(), [
      { id: "1", content: "Hidden task", status: "pending", priority: "medium" },
    ]);
    const frame = renderTui(baseState({ width: 80, height: 40, layout, todoPanel }));
    expect(frame).not.toContain("Hidden task");
  });
});
```

### 9.3 实现（GREEN）

无需新代码——这是验证 Task 4 的 renderer 重构是否正确。若测试失败，回到 Task 4 修复。

### 9.4 验证

```bash
pnpm build && npx vitest run packages/tui/test/layout-snapshot.test.ts
```

---

## Task 10: 更新现有测试以兼容新 TuiRenderState 字段

### 10.1 目的

现有 `packages/tui/test/app.test.ts` 中的 `snapshot()` 断言可能因新增 `layout` / `todoPanel` 字段而失败。需要：

1. 检查所有 `snapshot()` 断言，确保它们不因新字段而 break
2. 更新 `createTui()` 测试 helper，确保返回的 snapshot 类型包含新字段

### 10.2 实现

运行完整测试套件，定位因新字段失败的测试，逐个修复：

```bash
pnpm build && npx vitest run packages/tui/test/
```

### 10.3 验证

所有 packages/tui 测试通过。

---

## Task 11: pnpm verify 完整门禁

### 11.1 目的

运行完整门禁，确保：

1. 边界检查通过（`scripts/check-boundaries.mjs`）
2. Prettier check 通过
3. Build 成功
4. 所有测试通过
5. 覆盖率达标（statements 75 / branches 60 / functions 80 / lines 80）

### 11.2 命令

```bash
pnpm verify
```

### 11.3 通过标准

- 0 个测试失败
- 覆盖率不低于阈值
- 边界检查无违规
- Prettier 无格式问题

---

## 验收标准

| #   | 标准                                             | 验证方式                 |
| --- | ------------------------------------------------ | ------------------------ |
| 1   | `layout.ts` 提供 4 种布局模式计算                | Task 1 测试通过          |
| 2   | `todo-panel.ts` 提供 todo 增删改查与渲染         | Task 2 测试通过          |
| 3   | keymap 支持 `cycle_layout` / `toggle_todo_panel` | Task 3 测试通过          |
| 4   | renderer 根据 LayoutState 分派渲染，向后兼容     | Task 4 + Task 9 测试通过 |
| 5   | FullScreenTui 暴露 layout / todoPanel 状态管理   | Task 5 测试通过          |
| 6   | index.ts 导出新模块                              | Task 6 测试通过          |
| 7   | CLI 支持 `/layout` 和 `/todo` 命令               | Task 7 测试通过          |
| 8   | 命令面板 layout/todo 命令可用                    | Task 8 测试通过          |
| 9   | 现有测试不回归                                   | Task 10 通过             |
| 10  | pnpm verify 通过                                 | Task 11 通过             |

---

## 风险与缓解

| 风险                                             | 概率 | 影响 | 缓解                                                                     |
| ------------------------------------------------ | ---- | ---- | ------------------------------------------------------------------------ |
| renderer 重构引入回归                            | 高   | 高   | classic 模式作为黄金路径；快照测试覆盖；保持 `renderTui(state)` 签名不变 |
| 新增字段破坏现有 snapshot 断言                   | 中   | 中   | Task 10 专门处理                                                         |
| 布局计算性能问题                                 | 低   | 低   | computeLayout 是纯函数，仅在尺寸变化时重算                               |
| todo panel 与 SpecEngine initialTodos 字段不匹配 | 中   | 中   | 在 CLI 层做字段映射，TUI 层只接受 TodoItem[]                             |
| 边界检查失败（误引入 @focuscode/* 依赖）         | 低   | 高   | layout.ts / todo-panel.ts 只依赖 ./themes.js / ./width.js                |

---

## 文件清单

### 新增文件

1. `packages/tui/src/layout.ts` — Pane 布局引擎
2. `packages/tui/src/todo-panel.ts` — Todo 侧栏
3. `packages/tui/test/layout.test.ts`
4. `packages/tui/test/todo-panel.test.ts`
5. `packages/tui/test/layout-snapshot.test.ts`
6. `apps/cli/test/tui-layout-commands.test.ts`

### 修改文件

1. `packages/tui/src/keymap.ts` — 新增 actions
2. `packages/tui/src/renderer.ts` — 集成布局引擎
3. `packages/tui/src/app.ts` — 状态管理扩展
4. `packages/tui/src/index.ts` — 新增导出
5. `packages/tui/src/command-palette.ts` — 确认命令注册
6. `apps/cli/src/tui.ts` — CLI 命令 + 事件翻译
7. `packages/tui/test/keymap.test.ts` — 追加测试
8. `packages/tui/test/renderer.test.ts` — 追加测试
9. `packages/tui/test/app.test.ts` — 追加测试
10. `packages/tui/test/index.test.ts` — 追加测试
11. `packages/tui/test/command-palette.test.ts` — 追加测试
12. `apps/cli/test/tui-spec-events.test.ts` — 追加测试
