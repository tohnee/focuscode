# TUI 深度优化设计文档

> **Date:** 2026-07-23
> **Status:** Design
> **Scope:** packages/tui + apps/cli/src/tui.ts
> **Goal:** 使 FocusCode TUI 在视觉精致度、键盘效率、信息架构、SpecEngine 集成四个维度超越 Claude Code 和 opencode

## 1. 设计目标与原则

### 1.1 核心目标

| 维度            | 当前状态                                | 目标状态                              | 对标           |
| --------------- | --------------------------------------- | ------------------------------------- | -------------- |
| 视觉精致度      | 8 色 ANSI 256，无 truecolor，无过渡动画 | Truecolor 支持 + 排版系统 + 微动画    | Claude Code    |
| 键盘效率        | 22 action，无 vim 模式，无命令面板      | Vim 模式 + 命令面板 + transcript 搜索 | opencode       |
| 信息架构        | 单屏固定布局，无 pane/tab/侧栏          | 可配置分屏 + todo panel + context bar | Claude Code    |
| SpecEngine 集成 | 7 种 spec_* 事件全部忽略                | 完整可视化 + 交互式确认               | FocusCode 独有 |

### 1.2 设计原则

1. **零依赖原则不可破坏** — `packages/tui` 不得引入任何运行时依赖（Ink/React/blessed 等），全部用 Node 内建能力
2. **架构边界不可越界** — `packages/tui` 是叶子 adapter，不得依赖任何 `@focuscode/*`；所有 AgentEvent 翻译在 `apps/cli/src/tui.ts`
3. **向后兼容** — 现有主题、吉祥物、皮肤包、keymap 配置必须继续工作
4. **渐进式启用** — 新功能（vim 模式、分屏等）默认关闭或可选，不破坏现有用户体验
5. **YAGNI** — 不引入未证明需要的功能；每个新特性必须有明确的对标差距驱动

### 1.3 非目标

- 不重写吉祥物系统（当前系统成熟且是独有优势）
- 不引入图片内联渲染（终端限制大，ROI 低）
- 不做多 session tab 并行视图（复杂度过高，单 session 分屏已足够）
- 不引入 LSP diagnostics 内联显示（应由 agent-runtime 的 LspClient 驱动，非 TUI 职责）

## 2. 架构边界与集成点

### 2.1 包职责划分

```
packages/tui (叶子 adapter，零依赖)
├── src/
│   ├── app.ts              # FullScreenTui 主类（扩展）
│   ├── renderer.ts         # 帧渲染（重构为布局引擎）
│   ├── layout.ts           # 【新增】Pane 布局引擎
│   ├── themes.ts           # 主题系统（扩展 truecolor）
│   ├── typography.ts       # 【新增】排版系统
│   ├── keymap.ts           # 键位系统（扩展 action 集合）
│   ├── vim.ts              # 【新增】Vim 模式状态机
│   ├── command-palette.ts  # 【新增】命令面板
│   ├── search.ts           # 【新增】Transcript 搜索
│   ├── widgets.ts          # 小部件（扩展）
│   ├── spec-progress.ts    # 【新增】SpecEngine 进度 widget
│   ├── context-bar.ts      # 【新增】Context usage 进度条
│   ├── todo-panel.ts       # 【新增】Todo list 侧栏
│   ├── editor.ts           # 编辑器（扩展 vim 支持）
│   ├── ...existing files   # 其余文件不变
│   └── index.ts            # barrel export
└── test/                   # 测试

apps/cli/src/tui.ts (组合根)
├── renderEvent()           # 【扩展】添加 spec_* 事件翻译
├── spec event bridge       # 【新增】SpecEngine 交互式确认桥接
└── ...existing             # 其余不变
```

### 2.2 数据流

```
AgentEvent (agent-runtime)
    │
    ▼
renderEvent (apps/cli/src/tui.ts)  ← 事件翻译层
    │
    ├── spec_start       → tui.setSpecPhase({ phase: "start", trigger })
    ├── spec_stage       → tui.setSpecPhase({ phase: stage, model, durationMs, fellBack })
    ├── spec_draft_ready → tui.setSpecDraft({ specId, topic, understanding })
    ├── spec_confirmation_required → tui.setSpecConfirmation({ specId, decisions })
    ├── spec_confirmed   → tui.clearSpecConfirmation()
    ├── spec_skipped     → tui.setSpecPhase({ phase: "skipped", reason })
    ├── spec_completed   → tui.setSpecPhase({ phase: "completed", specId })
    ├── reasoning_delta  → tui.appendReasoning(delta)  【新增】
    │
    ▼
FullScreenTui (packages/tui)
    │
    ├── 状态管理 (state)
    ├── 布局引擎 (layout.ts) → 决定 pane 布局
    ├── 渲染 (renderer.ts)   → 组合各 pane 内容
    └── 输入处理 (keymap.ts + vim.ts) → 分发 action
```

### 2.3 TUI → Agent 回调扩展

`FullScreenTuiOptions` 新增回调：

```typescript
export interface FullScreenTuiOptions {
  // ...existing fields...

  /** SpecEngine 交互式确认回调。当用户在 TUI 里确认/拒绝决策时调用。 */
  onSpecConfirm?(specId: string, choices: Record<string, string>): void;
  /** SpecEngine 拒绝整个 spec 时调用。 */
  onSpecDecline?(specId: string): void;
  /** 命令面板触发命令时调用。 */
  onPaletteCommand?(command: string): void;
  /** Transcript 搜索时调用（可选，用于外部搜索）。 */
  onSearch?(query: string): void;
}
```

## 3. 布局引擎重构（layout.ts）

### 3.1 Pane 模型

引入可配置的 pane 布局系统，默认保持当前单屏布局（向后兼容），用户可通过 `/layout` 命令切换。

```typescript
// layout.ts
export type PaneId = "transcript" | "input" | "todo" | "spec" | "context";

export interface PaneConfig {
  id: PaneId;
  visible: boolean;
  width?: number; // 列宽占比 0..1，undefined 表示自适应
  height?: number; // 行高占比 0..1
  side: "left" | "right" | "bottom" | "main";
  minSize?: number; // 最小宽度/高度
}

export type LayoutMode =
  | "classic" // 当前单屏布局（默认）
  | "split" // 左右分屏：transcript | (todo + spec + context)
  | "focus" // 专注模式：只显示 transcript + input，隐藏吉祥物
  | "wide"; // 宽屏：transcript + 右侧侧栏（todo/spec/context 上下排列）

export interface LayoutState {
  mode: LayoutMode;
  panes: PaneConfig[];
  activePane: PaneId; // 当前焦点 pane
}
```

### 3.2 布局模式

**classic（默认）**：完全保持当前布局，零破坏性

```
╭──────────────────────────────────╮
│ 🦊 FocusCode · model             │
├──────────────────────────────────┤
│ [mascot] │ transcript            │
│          │ input                 │
├──────────────────────────────────┤
│ footer                           │
╰──────────────────────────────────╯
```

**split**：左右分屏，右侧为信息侧栏

```
╭──────────────────────────────────╮
│ 🦊 FocusCode · model             │
├──────────────────┬───────────────┤
│ transcript       │ 📋 Todo       │
│                  │ ├ task 1      │
│ input            │ ├ task 2      │
│                  │ ✦ Spec        │
│                  │ ● classify ✓  │
│                  │ ◐ explore...  │
│                  │ ⚙ Context     │
│                  │ 32k/200k ████ │
├──────────────────┴───────────────┤
│ footer                           │
╰──────────────────────────────────╯
```

**focus**：专注模式，隐藏吉祥物，transcript 占满

```
╭──────────────────────────────────╮
│ FocusCode · model                │
├──────────────────────────────────┤
│ transcript (full width)          │
│                                  │
│ input                            │
├──────────────────────────────────┤
│ footer                           │
╰──────────────────────────────────╯
```

**wide**：宽屏模式，transcript + 右侧侧栏

```
╭──────────────────────────────────────────────────╮
│ 🦊 FocusCode · model                             │
├────────────────────────────┬─────────────────────┤
│ [mascot] │ transcript      │ 📋 Todo / ✦ Spec    │
│          │                 │ ├ task 1            │
│          │ input           │ ✦ Spec Engine       │
│          │                 │ ● classify ✓ 1.2s   │
│          │                 │ ◐ explore... 3.4s   │
│          │                 │ ⚙ Context 32k/200k  │
├────────────────────────────┴─────────────────────┤
│ footer                                           │
╰──────────────────────────────────────────────────╯
```

### 3.3 布局切换

- `/layout classic|split|focus|wide` 命令切换
- `Ctrl+L` 循环切换布局（重用当前 clear action，改为 cycle-layout）
- 窗口尺寸变化时自动适配：宽度 < 100 列强制回 classic

### 3.4 renderer.ts 重构策略

当前 `renderTui(state)` 是一个单体函数。重构为：

```typescript
// renderer.ts (重构后)
export function renderTui(state: TuiRenderState): string {
  const layout = computeLayout(state.layout, state.width, state.height);
  const panes = renderPanes(layout, state);
  return composeFrame(panes, state.theme, state.width, state.height);
}

function renderPanes(layout: LayoutState, state: TuiRenderState): RenderedPane[] {
  // 根据 layout.mode 调度各 pane 的渲染
  // 每个 pane 是独立的渲染函数，返回 string[]
}

function composeFrame(panes: RenderedPane[], theme: TuiTheme, w: number, h: number): string {
  // 用框线字符组合各 pane，处理边框/分隔线
}
```

**关键约束**：`renderTui(state)` 签名不变，`TuiRenderState` 新增 `layout?: LayoutState` 字段（可选，缺省为 classic）。这保证向后兼容。

## 4. 视觉精致度提升

### 4.1 Truecolor 支持

当前 `themes.ts` 使用 8 色 ANSI 256（`\u001b[38;5;Nm`）。扩展为支持 truecolor（`\u001b[38;2;R;G;Bm`），同时保持对 256 色终端的回退。

```typescript
// themes.ts (扩展)
export interface TuiTheme {
  // ...existing fields...
  /** 颜色深度：'truecolor' | '256' | 'mono'。缺省 '256'。 */
  colorDepth?: "truecolor" | "256" | "mono";
  /** Truecolor 调色板（当 colorDepth === 'truecolor' 时使用）。 */
  truecolor?: ThemeTruecolor;
}

export interface ThemeTruecolor {
  background: string; // "#0a0a0a"
  foreground: string; // "#e0e0e0"
  accent: string; // "#ff8c42"
  secondary: string;
  success: string;
  warning: string;
  danger: string;
  muted: string;
}

// fg() 函数扩展：根据 colorDepth 选择转义序列
export function fg(color: number | string, text: string, depth?: "truecolor" | "256"): string {
  if (typeof color === "string" && color.startsWith("#")) {
    // truecolor 路径
    const { r, g, b } = hexToRgb(color);
    return `\u001b[38;2;${r};${g};${b}m${text}\u001b[39m`;
  }
  // 256 色路径（现有逻辑）
  return `\u001b[38;5;${color}m${text}\u001b[39m`;
}
```

**终端能力检测**：`app.ts` 启动时检测 `process.env.COLORTERM === 'truecolor'`，自动选择 colorDepth。

### 4.2 排版系统（typography.ts）

引入轻量排版抽象，统一样式应用：

```typescript
// typography.ts
export interface Typography {
  bold: boolean;
  italic: boolean;
  dim: boolean;
  underline: boolean;
  inverse: boolean;
  color?: number | string;
}

export function styled(text: string, typo: Typography, depth?: "truecolor" | "256"): string {
  let s = text;
  if (typo.bold) s = `\u001b[1m${s}\u001b[22m`;
  if (typo.italic) s = `\u001b[3m${s}\u001b[23m`;
  if (typo.dim) s = `\u001b[2m${s}\u001b[22m`;
  if (typo.underline) s = `\u001b[4m${s}\u001b[24m`;
  if (typo.inverse) s = `\u001b[7m${s}\u001b[27m`;
  if (typo.color !== undefined) s = fg(typo.color, s, depth);
  return s;
}

/** 语义化样式预设 */
export const STYLES = {
  heading: { bold: true, color: "accent" },
  code: { color: "success", inverse: false },
  muted: { dim: true },
  error: { bold: true, color: "danger" },
  success: { color: "success" },
  warning: { color: "warning" },
} as const;
```

### 4.3 微动画系统

当前只有 mascot 帧动画和 spinner。扩展为统一的动画系统：

```typescript
// widgets.ts (扩展)
export type AnimationEasing = "linear" | "ease-in" | "ease-out" | "ease-in-out";

export interface AnimationState {
  startTime: number;
  duration: number;
  easing: AnimationEasing;
}

/** 进度条动画 — 带 shimmer 效果 */
export function animatedProgressBar(
  progress: number, // 0..1
  width: number,
  tick: number,
  theme: TuiTheme,
): string {
  // 进度填充部分带 shimmer（▓▒░ 循环）
  const filled = Math.round(progress * width);
  const shimmer = "▓▒░"[tick % 3];
  const bar = shimmer.repeat(filled) + "░".repeat(width - filled);
  return fg(theme.accent, bar);
}

/** Toast 通知 — slide-in/out */
export interface ToastState {
  id: string;
  message: string;
  level: "info" | "success" | "warning" | "error";
  startTime: number;
  duration: number; // ms，自动消失
}

export function renderToast(toast: ToastState, now: number, width: number): string | undefined {
  const elapsed = now - toast.startTime;
  if (elapsed > toast.duration) return undefined;
  // 前 200ms slide-in，最后 200ms slide-out
  const slideIn = Math.min(1, elapsed / 200);
  const slideOut = Math.min(1, (toast.duration - elapsed) / 200);
  const visibleWidth = Math.round(width * Math.min(slideIn, slideOut));
  // 渲染 toast 文本，截断到 visibleWidth
  // ...
}
```

### 4.4 Reasoning 可视化

当前 `reasoning_delta` AgentEvent 被完全丢弃。新增 reasoning 展示：

```typescript
// TuiRenderState 扩展
export interface TuiRenderState {
  // ...existing...
  /** 模型思考过程（reasoning_delta 累积）。 */
  reasoning?: string;
  /** 是否展开显示 reasoning。 */
  reasoningExpanded?: boolean;
}
```

渲染方式：

- 折叠状态：footer 显示 `💭 thinking...` + spinner
- 展开状态：transcript 顶部显示 `💭 <reasoning text>`，用 dim 样式

切换：`Ctrl+R` 切换 reasoning 展开/折叠（新增 action `toggle_reasoning`）。

## 5. 键盘效率提升

### 5.1 Vim 模式（vim.ts）

引入 modal editing，支持 normal/insert/visual 三种模式。

```typescript
// vim.ts
export type VimMode = "normal" | "insert" | "visual";

export interface VimState {
  mode: VimMode;
  /** Visual 模式的选择起点。 */
  visualStart?: number;
  /** 重复计数（如 3dd 中的 3）。 */
  count?: number;
  /** 待处理的操作符（如 d, y, c 等待 motion）。 */
  pendingOperator?: "d" | "y" | "c";
}

/** Vim 模式状态机 — 纯函数 */
export function vimTransition(
  state: VimState,
  input: string, // 单个按键
): { state: VimState; action?: TuiAction; textMutation?: TextMutation } {
  // 实现 vim 按键解析
  // normal 模式：hjkl/w/b/dd/yy/p/i/a/o 等
  // insert 模式：直接输入
  // visual 模式：v 进入，移动选择，d/y 操作
}
```

**默认禁用**：vim 模式默认关闭，通过 `/vim on` 命令启用。启用后 `Esc` 进入 normal 模式，`i` 进入 insert 模式。

**Normal 模式按键**：

| 键              | 动作                               |
| --------------- | ---------------------------------- |
| `h`/`j`/`k`/`l` | 左/下/上/右移动光标                |
| `w`/`b`         | 下一个/上一个单词                  |
| `0`/`$`         | 行首/行尾                          |
| `gg`/`G`        | 输入缓冲首/尾                      |
| `dd`            | 删除当前行                         |
| `yy`/`p`        | 复制/粘贴当前行                    |
| `u`             | 撤销                               |
| `i`/`a`/`o`     | 进入 insert 模式（前/后/下方插入） |
| `v`             | 进入 visual 模式                   |

### 5.2 命令面板（command-palette.ts）

`Ctrl+P` 打开 fuzzy 命令面板（新增 action `open_palette`）：

```typescript
// command-palette.ts
export interface PaletteCommand {
  id: string;
  label: string;
  description?: string;
  shortcut?: string;
  category: "navigation" | "editing" | "view" | "spec" | "model" | "session";
}

export const BUILTIN_COMMANDS: PaletteCommand[] = [
  { id: "layout:split", label: "Switch to Split Layout", shortcut: "Ctrl+L", category: "view" },
  { id: "vim:toggle", label: "Toggle Vim Mode", category: "editing" },
  { id: "spec:decline", label: "Decline Current Spec", category: "spec" },
  { id: "model:picker", label: "Open Model Picker", shortcut: "Alt+M", category: "model" },
  {
    id: "search:transcript",
    label: "Search Transcript",
    shortcut: "Ctrl+F",
    category: "navigation",
  },
  // ...更多命令
];

export interface PaletteState {
  query: string;
  selectedIndex: number;
  filtered: PaletteCommand[];
  visible: boolean;
}

export function createPaletteState(): PaletteState {
  /* ... */
}
export function updatePalette(state: PaletteState, input: string): PaletteState {
  /* fuzzy filter */
}
export function confirmPalette(state: PaletteState): PaletteCommand | undefined {
  /* ... */
}
```

UI：打开时在输入区上方显示半透明 overlay（用 dim 样式），显示过滤后的命令列表，`↑↓` 选择，`Enter` 确认，`Esc` 取消。

### 5.3 Transcript 搜索（search.ts）

`Ctrl+F` 打开搜索（新增 action `search_transcript`）：

```typescript
// search.ts
export interface SearchState {
  query: string;
  matches: number[]; // 匹配的 transcript 行索引
  currentIndex: number;
  visible: boolean;
}

export function searchTranscript(transcript: TuiTranscriptLine[], query: string): number[] {
  // 返回所有匹配的行索引
  const lower = query.toLowerCase();
  return transcript
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => line.text.toLowerCase().includes(lower))
    .map(({ i }) => i);
}
```

UI：footer 上方显示 `/query>` 输入框，实时高亮匹配，`Enter` 跳到下一个匹配，`Shift+Enter` 上一个，`Esc` 关闭。

### 5.4 Keymap Action 扩展

`TuiAction` 新增 action：

```typescript
// keymap.ts (扩展)
export type TuiAction =
  | "submit"
  | "newline"
  | "abort"
  | "exit"
  | "clear"
  | "backspace"
  | "delete_word"
  | "cursor_left"
  | "cursor_right"
  | "home"
  | "end"
  | "word_left"
  | "word_right"
  | "undo"
  | "kill_line"
  | "yank"
  | "complete"
  | "history_previous"
  | "history_next"
  | "scroll_up"
  | "scroll_down"
  | "cycle_theme"
  | "cycle_mascot"
  // 新增
  | "cycle_layout" // Ctrl+L（重用）
  | "toggle_vim" // Ctrl+V（切换 vim 模式）
  | "open_palette" // Ctrl+P（命令面板）
  | "search_transcript" // Ctrl+F（搜索）
  | "toggle_reasoning" // Ctrl+R（reasoning 展开）
  | "toggle_todo_panel" // Ctrl+T（重用，todo panel 显隐）
  | "accept_diff" // Ctrl+Y（重用，接受 diff）
  | "reject_diff" // Ctrl+N（拒绝 diff）
  | "spec_confirm" // Tab（spec 确认）
  | "spec_decline"; // Shift+Tab（spec 拒绝）
```

## 6. 信息架构提升

### 6.1 Todo Panel（todo-panel.ts）

当前 `/todo` 命令只输出文本。新增持久化 todo panel：

```typescript
// todo-panel.ts
export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "high" | "medium" | "low";
  activeForm?: string; // SpecEngine 注入的初始 todo
}

export interface TodoPanelState {
  items: TodoItem[];
  visible: boolean;
  filter: "all" | "pending" | "completed";
}

export function renderTodoPanel(
  state: TodoPanelState,
  width: number,
  height: number,
  theme: TuiTheme,
): string[] {
  // 渲染 todo 列表，带状态图标和优先级颜色
  // ☐ pending  🔄 in_progress  ✓ completed
}
```

**数据源**：

1. SpecEngine 的 `initialTodos`（通过 `spec_completed` 事件注入）
2. Agent 的 TodoWrite 工具调用（通过 `tool_end` 事件解析）
3. 用户手动 `/todo add <text>` 命令

### 6.2 Context Usage Bar（context-bar.ts）

显示当前 context window 使用量：

```typescript
// context-bar.ts
export interface ContextUsageState {
  usedTokens: number;
  maxTokens: number;
  /** 模型 reasoning 消耗的 token（可选）。 */
  reasoningTokens?: number;
}

export function renderContextBar(state: ContextUsageState, width: number, theme: TuiTheme): string {
  const ratio = state.usedTokens / state.maxTokens;
  const barWidth = width - 20; // 留给文字
  const filled = Math.round(ratio * barWidth);
  const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
  const color = ratio < 0.7 ? theme.success : ratio < 0.9 ? theme.warning : theme.danger;
  return fg(color, bar) + ` ${formatTokens(state.usedTokens)}/${formatTokens(state.maxTokens)}`;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
```

**数据源**：AgentEvent 的 `usage` 字段（`inputTokens + outputTokens` 累积）。

### 6.3 Diff 交互

当前 diff 只展示，不能交互。新增 accept/reject：

```typescript
// TuiRenderState 扩展
export interface TuiRenderState {
  // ...existing...
  /** 待确认的 diff（来自 tool_end 的 edit 类工具）。 */
  pendingDiff?: {
    toolName: string;
    filePath: string;
    lines: string[]; // pre-rendered diff lines
    acceptKey?: string;
    rejectKey?: string;
  };
}
```

当 agent 执行 edit 类工具（`edit`/`write`）时，`tool_end` 事件携带 diff，TUI 显示 diff 并等待 `Ctrl+Y`（accept）或 `Ctrl+N`（reject）。reject 时通过回调通知 agent-runtime（需要 agent 支持 reject）。

**注意**：这需要 agent-runtime 支持工具拒绝回调，是较大的集成改动。MVP 阶段先只做 diff 展示增强（折叠/展开），交互式 accept/reject 作为 v2。

## 7. SpecEngine 深度集成

### 7.1 SpecEngine 进度 Widget（spec-progress.ts）

```typescript
// spec-progress.ts
export type SpecPhase =
  | "idle"
  | "start"
  | "classify"
  | "explore"
  | "draft"
  | "detect-decisions"
  | "enhance"
  | "skipped"
  | "completed";

export interface SpecProgressState {
  phase: SpecPhase;
  trigger?: "auto" | "explicit";
  specId?: string;
  topic?: string;
  understanding?: string;
  stages: SpecStageInfo[];
  /** 待确认的决策列表。 */
  pendingDecisions?: SpecDecision[];
  startTime?: number;
  totalDuration?: number;
}

export interface SpecStageInfo {
  name: string;
  model?: string;
  durationMs?: number;
  fellBack?: boolean;
  status: "pending" | "running" | "done" | "failed";
}

export function renderSpecProgress(
  state: SpecProgressState,
  width: number,
  theme: TuiTheme,
): string[] {
  // 渲染 spec 进度面板
  // ✦ Spec Engine
  // ● classify ✓ 1.2s
  // ◐ explore... 3.4s (running)
  // ○ draft
  // ○ detect-decisions
  // ○ enhance
}
```

### 7.2 交互式确认

当 `spec_confirmation_required` 事件到达时，TUI 显示决策确认 UI：

```
╭─ ✦ Spec Confirmation Required ───────────────────╮
│ spec_1784821602_c5be32 · Firecracker microVM      │
├───────────────────────────────────────────────────┤
│ Decision 1/5: [critical]                          │
│ How to supply Firecracker kernel image?           │
│   > A. Bundled with FocusCode (recommended)       │
│     B. User-provided path                         │
│     C. Download on-demand                         │
├───────────────────────────────────────────────────┤
│ ↑↓ navigate  Enter confirm  Tab auto-pick first  │
│ Esc decline spec  1-5 jump to decision            │
╰───────────────────────────────────────────────────╯
```

**交互**：

- `↑↓` 在决策选项间导航
- `Enter` 确认当前选择
- `Tab` 自动选择第一个选项（当前 live test 的行为）
- `1`-`5` 跳转到指定决策
- `Esc` 拒绝整个 spec（触发 `onSpecDecline`）

**确认后**：通过 `onSpecConfirm(specId, choices)` 回调通知 CLI 层，CLI 层调用 `engine.resolveDecisions(specId, choices)`。

### 7.3 Spec Draft 预览

当 `spec_draft_ready` 事件到达时，TUI 显示 draft 预览：

```
╭─ ✦ Spec Draft Ready ─────────────────────────────╮
│ spec_1784821602_c5be32                            │
│ Topic: Firecracker microVM sandbox backend        │
├───────────────────────────────────────────────────┤
│ Understanding:                                    │
│   Add a Firecracker microVM sandbox backend to    │
│   packages/sandbox, integrating with the existing │
│   SandboxExecutor interface...                    │
├───────────────────────────────────────────────────┤
│ Press Space to continue to decision detection     │
╰───────────────────────────────────────────────────╯
```

**交互**：`Space` 继续，`Esc` 跳过 spec（触发 skip）。

### 7.4 CLI 层事件翻译扩展

`apps/cli/src/tui.ts` 的 `renderEvent()` 新增 spec_* 分支：

```typescript
function renderEvent(tui: FullScreenTui, event: AgentEvent, cheerOn?: () => boolean): void {
  switch (event.type) {
    // ...existing cases...

    case "spec_start":
      tui.setSpecProgress({ phase: "start", trigger: event.trigger, startTime: Date.now() });
      tui.setStatus(`✦ Spec engine started (${event.trigger})`);
      break;

    case "spec_stage":
      tui.updateSpecStage(event.stage, {
        model: event.model,
        durationMs: event.durationMs,
        fellBack: event.fellBack,
        status: "done",
      });
      tui.setStatus(
        `✦ ${event.stage} ${event.fellBack ? "(fallback)" : "✓"} ${event.durationMs}ms`,
      );
      break;

    case "spec_draft_ready":
      tui.setSpecDraft({
        specId: event.specId,
        topic: event.topic,
        understanding: event.understanding,
      });
      tui.setSpeech(`Spec draft ready: ${event.topic}`);
      break;

    case "spec_confirmation_required":
      tui.setSpecConfirmation(event.specId, event.decisions);
      tui.setMood("thinking");
      break;

    case "spec_confirmed":
      tui.clearSpecConfirmation();
      tui.setMood("happy");
      break;

    case "spec_skipped":
      tui.setSpecProgress({ phase: "skipped" });
      tui.setStatus(`✦ Spec skipped: ${event.reason}`);
      break;

    case "spec_completed":
      tui.setSpecProgress({
        phase: "completed",
        specId: event.specId,
        totalDuration: Date.now() - tui.getSpecStartTime(),
      });
      tui.setMood("celebrating");
      break;

    case "reasoning_delta":
      tui.appendReasoning(event.delta);
      break;
  }
}
```

## 8. 主题系统扩展

### 8.1 Truecolor 主题升级

现有 7 个主题升级为同时提供 256 色和 truecolor 调色板：

```typescript
// themes.ts
export const TUI_THEMES: TuiTheme[] = [
  {
    id: "fox",
    name: "Fox Fire",
    colorDepth: "256",
    background: 235,
    foreground: 223,
    accent: 208,
    secondary: 166,
    success: 114,
    warning: 221,
    danger: 203,
    muted: 245,
    border: "─",
    truecolor: {
      background: "#1a0f0a",
      foreground: "#f5e6d3",
      accent: "#ff8c42",
      secondary: "#d9741a",
      success: "#87af5f",
      warning: "#ffd75f",
      danger: "#d75f5f",
      muted: "#888888",
    },
  },
  // ...其他主题同理升级
];
```

### 8.2 新增主题

新增 2 个 truecolor 优先主题：

- `neon` — 霓虹紫青（赛博朋克风）
- `solarized` — Solarized Dark（经典开发者主题）

## 9. 测试策略

### 9.1 单元测试（packages/tui/test/）

| 模块               | 测试文件                | 测试要点                                              |
| ------------------ | ----------------------- | ----------------------------------------------------- |
| layout.ts          | layout.test.ts          | 4 种布局模式渲染、尺寸自适应、pane 显隐切换           |
| typography.ts      | typography.test.ts      | 样式组合、truecolor/256 回退、嵌套样式                |
| vim.ts             | vim.test.ts             | normal/insert/visual 切换、dd/yy/p 等操作、count 前缀 |
| command-palette.ts | command-palette.test.ts | fuzzy 过滤、键盘导航、命令执行                        |
| search.ts          | search.test.ts          | 大小写不敏感搜索、匹配高亮、next/prev 导航            |
| spec-progress.ts   | spec-progress.test.ts   | 5 阶段进度渲染、决策确认 UI、fallback 显示            |
| context-bar.ts     | context-bar.test.ts     | token 格式化、阈值变色、进度条填充                    |
| todo-panel.ts      | todo-panel.test.ts      | todo 增删改、状态图标、优先级颜色                     |
| themes.ts (扩展)   | themes.test.ts          | truecolor 检测、256 回退、新主题校验                  |

### 9.2 集成测试

- `apps/cli/test/tui-integration.test.ts` — 验证 `renderEvent()` 对 spec_* 事件的翻译
- 验证 `onSpecConfirm` 回调链路：TUI 确认 → CLI → engine.resolveDecisions

### 9.3 快照测试

- 4 种布局模式的渲染快照（`renderer.test.ts`）
- SpecEngine 各阶段的 widget 渲染快照

### 9.4 边界检查

- `node scripts/check-boundaries.mjs` 必须通过
- `packages/tui` 不得引入任何 `@focuscode/*` 依赖
- `packages/tui` 不得引入任何运行时 npm 依赖

## 10. 实施分期

### Phase 1：SpecEngine 集成 + 基础视觉（最高优先级）

- spec-progress.ts + CLI 层 spec_* 事件翻译
- 交互式 spec 确认 UI
- context-bar.ts（context usage）
- reasoning 可视化（折叠/展开）
- **价值**：补齐 FocusCode 独有的最大缺口，立即可见的效果

### Phase 2：键盘效率

- vim.ts（normal/insert/visual 模式）
- command-palette.ts（Ctrl+P 命令面板）
- search.ts（Ctrl+F transcript 搜索）
- keymap action 扩展
- **价值**：达到 opencode 级别的键盘效率

### Phase 3：布局重构 + 信息架构

- layout.ts（pane 布局引擎）
- renderer.ts 重构（分屏支持）
- todo-panel.ts（持久化 todo 侧栏）
- 4 种布局模式
- **价值**：达到 Claude Code 级别的信息密度

### Phase 4：视觉精致化

- truecolor 主题升级
- typography.ts 排版系统
- 微动画（toast、shimmer、slide-in）
- 新增 neon/solarized 主题
- **价值**：视觉精致度超越 Claude Code

## 11. 风险与缓解

| 风险                         | 概率 | 影响 | 缓解                                                                     |
| ---------------------------- | ---- | ---- | ------------------------------------------------------------------------ |
| renderer.ts 重构引入回归     | 高   | 高   | 保持 `renderTui(state)` 签名不变；classic 模式作为黄金路径；快照测试覆盖 |
| vim 模式与现有 keymap 冲突   | 中   | 中   | vim 模式默认关闭；启用时 keymap 优先级明确（vim normal 模式 > keymap）   |
| truecolor 在不支持终端上损坏 | 低   | 中   | COLORTERM 检测 + 256 色回退；mono 主题作为最终回退                       |
| 布局引擎性能问题（每帧计算） | 低   | 低   | 布局计算结果缓存；尺寸变化时才重算                                       |
| SpecEngine 交互式确认阻塞 UI | 中   | 高   | 确认 UI 是非阻塞 overlay；用户可 Esc 跳过；超时自动 Tab                  |

## 12. 成功标准

1. **SpecEngine 可视化**：spec_* 事件全部有 TUI 反馈，用户能看到 5 阶段进度和 draft
2. **交互式 spec 确认**：用户能在 TUI 里 `↑↓ Enter` 选择决策选项，无需自动 resolve
3. **键盘效率**：vim 模式可用，命令面板可 Ctrl+P 打开，transcript 可 Ctrl+F 搜索
4. **信息密度**：split/wide 布局下同时显示 transcript + todo + spec + context bar
5. **视觉精致度**：truecolor 主题在支持的终端上正确渲染，过渡动画流畅
6. **零依赖保持**：`packages/tui` 仍无任何运行时 npm 依赖
7. **向后兼容**：现有主题/吉祥物/keymap 配置全部继续工作
8. **测试覆盖**：新增模块 ≥80% 覆盖率，全套测试通过，边界检查通过

## 13. 文件清单

### 新增文件（packages/tui/src/）

1. `layout.ts` — Pane 布局引擎
2. `typography.ts` — 排版系统
3. `vim.ts` — Vim 模式状态机
4. `command-palette.ts` — 命令面板
5. `search.ts` — Transcript 搜索
6. `spec-progress.ts` — SpecEngine 进度 widget
7. `context-bar.ts` — Context usage 进度条
8. `todo-panel.ts` — Todo list 侧栏

### 新增测试（packages/tui/test/）

1. `layout.test.ts`
2. `typography.test.ts`
3. `vim.test.ts`
4. `command-palette.test.ts`
5. `search.test.ts`
6. `spec-progress.test.ts`
7. `context-bar.test.ts`
8. `todo-panel.test.ts`

### 修改文件

1. `packages/tui/src/app.ts` — FullScreenTui 扩展（spec/vim/palette/search 状态管理）
2. `packages/tui/src/renderer.ts` — 布局引擎集成
3. `packages/tui/src/keymap.ts` — action 扩展
4. `packages/tui/src/themes.ts` — truecolor 支持
5. `packages/tui/src/widgets.ts` — 动画扩展
6. `packages/tui/src/index.ts` — 新增导出
7. `apps/cli/src/tui.ts` — spec_* 事件翻译 + 回调桥接
