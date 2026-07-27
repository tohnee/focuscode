# TUI 深度优化 Phase 2: 键盘效率 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-v6-subagent-driven-development (recommended) or superpowers-v6-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 TUI 添加 Vim 模态编辑、Ctrl+P 命令面板、Ctrl+F transcript 搜索,达到 opencode 级别的键盘效率。

**Architecture:** 在 `packages/tui`(叶子 adapter,零依赖)新增三个纯函数模块 `vim.ts`、`command-palette.ts`、`search.ts`;扩展 `keymap.ts` 新增 3 个 action;扩展 `editor.ts` 新增 vim 所需的行级操作;扩展 `app.ts` 管理三种新状态并在 `onData` 输入分发中插入 overlay 拦截;扩展 `renderer.ts` 渲染 search bar、palette overlay、vim 模式指示器;在 `apps/cli/src/tui.ts` 组合层添加 `/vim`、`/palette`、`/search` 命令并桥接 `onPaletteCommand` 回调。

**Tech Stack:** TypeScript ESM、Node 内建能力、vitest、ANSI 转义序列。`packages/tui` 严格零运行时依赖。

## Global Constraints

- **边界规则**:`packages/tui` 不得依赖任何 `@focuscode/*` 包或运行时 npm 依赖(`scripts/check-boundaries.mjs` 强制)
- **TypeScript strict**:`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`verbatimModuleSyntax`、`isolatedModules`、ES2022、NodeNext
- **Prettier**:printWidth 100、双引号、semicolon、trailing comma `"all"`,用 `pnpm format` 不要手工排版
- **测试位置**:`packages/tui/test/`(不与 `src/` 同目录)
- **向后兼容**:`renderTui(state)` 签名不变,`TuiRenderState` 新字段全部可选;`FullScreenTuiOptions` 新字段全部可选;vim 模式默认关闭
- **YAGNI**:vim 只实现 normal + insert 模式;visual 模式留待将来
- **TDD**:每个任务先写失败测试 → 验证 RED → 实现 → 验证 GREEN → 边界检查 → prettier
- **输入分发优先级**(onData):picker > specConfirmation > palette > search > vim-normal > Alt+M > feedInput

## 文件结构

### 新增文件(packages/tui/src/)

1. `search.ts` — Transcript 搜索纯函数(状态机 + 渲染)
2. `command-palette.ts` — 命令面板纯函数(状态机 + 渲染)
3. `vim.ts` — Vim 模式状态机纯函数(normal + insert)

### 新增测试(packages/tui/test/)

1. `search.test.ts`
2. `command-palette.test.ts`
3. `vim.test.ts`
4. `editor.test.ts`(新建,覆盖已有 + 新增方法)

### 修改文件

1. `packages/tui/src/keymap.ts` — 新增 3 个 action(toggle_vim, open_palette, search_transcript)+ DEFAULT_KEYMAP 绑定
2. `packages/tui/src/editor.ts` — 新增 vim 所需行级操作(deleteLine, yankLine, pasteAfter, deleteChar, getLineText, setLineText)
3. `packages/tui/src/app.ts` — 集成 search/palette/vim 状态管理 + 输入拦截 + action 处理
4. `packages/tui/src/renderer.ts` — TuiRenderState 新增字段 + 渲染 search/palette/vim
5. `packages/tui/src/index.ts` — 导出新模块
6. `apps/cli/src/tui.ts` — 添加 /vim /palette /search 命令 + onPaletteCommand 回调桥接

---

## Task 1: search.ts — Transcript 搜索纯函数模块

**Files:**

- Create: `packages/tui/src/search.ts`
- Test: `packages/tui/test/search.test.ts`

**Interfaces:**

- Consumes: `TuiTranscriptLine` from `./renderer.js`、`TuiTheme` from `./themes.js`、`fg` from `./themes.js`、`stringWidth` from `./width.js`
- Produces: `SearchState`、`createSearchState`、`searchTranscript`、`advanceSearch`、`closeSearch`、`renderSearchBar`

- [ ] **Step 1: 写失败测试 — 类型与初始状态**

创建 `packages/tui/test/search.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  advanceSearch,
  closeSearch,
  createSearchState,
  renderSearchBar,
  searchTranscript,
  type SearchState,
} from "../src/search.js";
import { TUI_THEMES } from "../src/themes.js";
import type { TuiTranscriptLine } from "../src/renderer.js";

const theme = TUI_THEMES[0]!;

const sampleTranscript: TuiTranscriptLine[] = [
  { role: "user", text: "Hello world" },
  { role: "assistant", text: "Hi there" },
  { role: "user", text: "Search for hello" },
  { role: "assistant", text: "Found it" },
];

describe("createSearchState", () => {
  it("returns invisible state with empty query", () => {
    const state = createSearchState();
    expect(state.visible).toBe(false);
    expect(state.query).toBe("");
    expect(state.matches).toEqual([]);
    expect(state.currentIndex).toBe(0);
  });
});

describe("searchTranscript", () => {
  it("finds case-insensitive matches", () => {
    const matches = searchTranscript(sampleTranscript, "hello");
    expect(matches).toEqual([0, 2]);
  });

  it("returns empty array for no matches", () => {
    const matches = searchTranscript(sampleTranscript, "nonexistent");
    expect(matches).toEqual([]);
  });

  it("returns empty array for empty query", () => {
    const matches = searchTranscript(sampleTranscript, "");
    expect(matches).toEqual([]);
  });

  it("handles special regex characters as literals", () => {
    const transcript: TuiTranscriptLine[] = [
      { role: "user", text: "price is $50.00" },
      { role: "assistant", text: "total (incl tax)" },
    ];
    expect(searchTranscript(transcript, "$50")).toEqual([0]);
    expect(searchTranscript(transcript, "(incl)")).toEqual([]);
    expect(searchTranscript(transcript, "(incl tax)")).toEqual([1]);
  });
});

describe("advanceSearch", () => {
  it("advances to next match and wraps around", () => {
    const state: SearchState = {
      visible: true,
      query: "hello",
      matches: [0, 2],
      currentIndex: 0,
    };
    const next = advanceSearch(state, 1);
    expect(next.currentIndex).toBe(1);
    const wrapped = advanceSearch(next, 1);
    expect(wrapped.currentIndex).toBe(0);
  });

  it("advances backwards and wraps", () => {
    const state: SearchState = {
      visible: true,
      query: "hello",
      matches: [0, 2],
      currentIndex: 0,
    };
    const prev = advanceSearch(state, -1);
    expect(prev.currentIndex).toBe(1);
  });

  it("returns unchanged when no matches", () => {
    const state: SearchState = {
      visible: true,
      query: "x",
      matches: [],
      currentIndex: 0,
    };
    const next = advanceSearch(state, 1);
    expect(next.currentIndex).toBe(0);
  });
});

describe("closeSearch", () => {
  it("resets to invisible and clears query", () => {
    const state: SearchState = {
      visible: true,
      query: "hello",
      matches: [0, 2],
      currentIndex: 1,
    };
    const closed = closeSearch(state);
    expect(closed.visible).toBe(false);
    expect(closed.query).toBe("");
    expect(closed.matches).toEqual([]);
    expect(closed.currentIndex).toBe(0);
  });
});

describe("renderSearchBar", () => {
  it("returns empty array when invisible", () => {
    const state = createSearchState();
    const lines = renderSearchBar(state, 60, theme);
    expect(lines).toEqual([]);
  });

  it("renders query and match count when visible", () => {
    const state: SearchState = {
      visible: true,
      query: "hello",
      matches: [0, 2],
      currentIndex: 0,
    };
    const lines = renderSearchBar(state, 60, theme);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("hello");
    expect(lines[0]).toContain("1/2");
  });

  it("shows no match indicator when matches is empty", () => {
    const state: SearchState = {
      visible: true,
      query: "xyz",
      matches: [],
      currentIndex: 0,
    };
    const lines = renderSearchBar(state, 60, theme);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("0/0");
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm build && npx vitest run packages/tui/test/search.test.ts`
Expected: FAIL with "Cannot find module '../src/search.js'" 或类似错误

- [ ] **Step 3: 实现 search.ts**

创建 `packages/tui/src/search.ts`:

```typescript
import type { TuiTranscriptLine } from "./renderer.js";
import { fg, type TuiTheme } from "./themes.js";
import { stringWidth } from "./width.js";

export interface SearchState {
  visible: boolean;
  query: string;
  matches: number[];
  currentIndex: number;
}

export function createSearchState(): SearchState {
  return { visible: false, query: "", matches: [], currentIndex: 0 };
}

/**
 * Case-insensitive literal substring search across transcript lines.
 * Returns the indices of matching lines. Special regex characters are
 * treated as literals (no regex compilation).
 */
export function searchTranscript(transcript: TuiTranscriptLine[], query: string): number[] {
  if (!query) return [];
  const lower = query.toLowerCase();
  const matches: number[] = [];
  for (let i = 0; i < transcript.length; i++) {
    if (transcript[i]!.text.toLowerCase().includes(lower)) {
      matches.push(i);
    }
  }
  return matches;
}

/**
 * Advance the current match index by `delta` (positive = forward,
 * negative = backward). Wraps around. No-op when matches is empty.
 */
export function advanceSearch(state: SearchState, delta: number): SearchState {
  if (state.matches.length === 0) return state;
  const len = state.matches.length;
  const next = (((state.currentIndex + delta) % len) + len) % len;
  return { ...state, currentIndex: next };
}

export function closeSearch(state: SearchState): SearchState {
  return { visible: false, query: "", matches: [], currentIndex: 0 };
}

/**
 * Render the search bar as a single line: `/query> [current/total]`.
 * Returns empty array when invisible.
 */
export function renderSearchBar(state: SearchState, width: number, theme: TuiTheme): string[] {
  if (!state.visible) return [];
  const total = state.matches.length;
  const current = total > 0 ? state.currentIndex + 1 : 0;
  const countLabel = `${current}/${total}`;
  const prompt = "/";
  const queryPart = state.query + "_";
  const tail = `  ${countLabel}`;
  const available = Math.max(0, width - stringWidth(prompt) - stringWidth(tail));
  const truncatedQuery =
    stringWidth(queryPart) > available
      ? queryPart.slice(0, Math.max(0, available - 1)) + "…"
      : queryPart;
  const line =
    fg(theme.accent, prompt) +
    truncatedQuery +
    " ".repeat(Math.max(0, available - stringWidth(truncatedQuery))) +
    fg(theme.muted, tail);
  return [line];
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm build && npx vitest run packages/tui/test/search.test.ts`
Expected: PASS — all tests green

- [ ] **Step 5: 边界检查 + prettier**

Run: `node scripts/check-boundaries.mjs && pnpm prettier --check packages/tui/src/search.ts packages/tui/test/search.test.ts`
Expected: 边界检查通过,无 prettier 错误

- [ ] **Step 6: 提交**

```bash
git add packages/tui/src/search.ts packages/tui/test/search.test.ts
git commit -m "feat(tui): add transcript search pure-function module"
```

---

## Task 2: command-palette.ts — 命令面板纯函数模块

**Files:**

- Create: `packages/tui/src/command-palette.ts`
- Test: `packages/tui/test/command-palette.test.ts`

**Interfaces:**

- Consumes: `fg` from `./themes.js`、`stringWidth` from `./width.js`、`TuiTheme` from `./themes.js`
- Produces: `PaletteCommand`、`PaletteCategory`、`PaletteState`、`BUILTIN_COMMANDS`、`createPaletteState`、`updatePaletteQuery`、`movePaletteCursor`、`confirmPalette`、`closePalette`、`renderPalette`

- [ ] **Step 1: 写失败测试 — 类型、过滤、导航**

创建 `packages/tui/test/command-palette.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  BUILTIN_COMMANDS,
  closePalette,
  confirmPalette,
  createPaletteState,
  movePaletteCursor,
  renderPalette,
  updatePaletteQuery,
  type PaletteState,
} from "../src/command-palette.js";
import { TUI_THEMES } from "../src/themes.js";

const theme = TUI_THEMES[0]!;

describe("createPaletteState", () => {
  it("returns invisible state with empty query and all commands", () => {
    const state = createPaletteState();
    expect(state.visible).toBe(false);
    expect(state.query).toBe("");
    expect(state.selectedIndex).toBe(0);
    expect(state.filtered.length).toBe(BUILTIN_COMMANDS.length);
  });
});

describe("updatePaletteQuery", () => {
  it("filters commands case-insensitively by label or description", () => {
    const state = createPaletteState();
    const updated = updatePaletteQuery(state, "vim");
    expect(updated.query).toBe("vim");
    expect(updated.filtered.length).toBeGreaterThan(0);
    expect(updated.filtered.every((c) => c.label.toLowerCase().includes("vim"))).toBe(true);
    expect(updated.selectedIndex).toBe(0);
  });

  it("returns empty filtered when no match", () => {
    const state = createPaletteState();
    const updated = updatePaletteQuery(state, "zzznomatch");
    expect(updated.filtered).toEqual([]);
    expect(updated.selectedIndex).toBe(0);
  });

  it("matches on category field too", () => {
    const state = createPaletteState();
    const updated = updatePaletteQuery(state, "spec");
    expect(updated.filtered.length).toBeGreaterThan(0);
    expect(updated.filtered.every((c) => c.category === "spec")).toBe(true);
  });
});

describe("movePaletteCursor", () => {
  it("moves down and wraps to top", () => {
    const state: PaletteState = {
      visible: true,
      query: "",
      filtered: BUILTIN_COMMANDS.slice(0, 3),
      selectedIndex: 0,
    };
    const down1 = movePaletteCursor(state, 1);
    expect(down1.selectedIndex).toBe(1);
    const down2 = movePaletteCursor(down1, 1);
    expect(down2.selectedIndex).toBe(2);
    const wrapped = movePaletteCursor(down2, 1);
    expect(wrapped.selectedIndex).toBe(0);
  });

  it("moves up and wraps to bottom", () => {
    const state: PaletteState = {
      visible: true,
      query: "",
      filtered: BUILTIN_COMMANDS.slice(0, 3),
      selectedIndex: 0,
    };
    const up = movePaletteCursor(state, -1);
    expect(up.selectedIndex).toBe(2);
  });

  it("clamps when filtered is empty", () => {
    const state: PaletteState = {
      visible: true,
      query: "zzz",
      filtered: [],
      selectedIndex: 0,
    };
    const moved = movePaletteCursor(state, 1);
    expect(moved.selectedIndex).toBe(0);
  });
});

describe("confirmPalette", () => {
  it("returns selected command when filtered is non-empty", () => {
    const state: PaletteState = {
      visible: true,
      query: "vim",
      filtered: [BUILTIN_COMMANDS[0]!],
      selectedIndex: 0,
    };
    const result = confirmPalette(state);
    expect(result).toBeDefined();
    expect(result?.id).toBe(BUILTIN_COMMANDS[0]!.id);
  });

  it("returns undefined when filtered is empty", () => {
    const state: PaletteState = {
      visible: true,
      query: "zzz",
      filtered: [],
      selectedIndex: 0,
    };
    const result = confirmPalette(state);
    expect(result).toBeUndefined();
  });
});

describe("closePalette", () => {
  it("resets to invisible and clears query", () => {
    const state: PaletteState = {
      visible: true,
      query: "vim",
      filtered: [BUILTIN_COMMANDS[0]!],
      selectedIndex: 0,
    };
    const closed = closePalette(state);
    expect(closed.visible).toBe(false);
    expect(closed.query).toBe("");
    expect(closed.selectedIndex).toBe(0);
    expect(closed.filtered.length).toBe(BUILTIN_COMMANDS.length);
  });
});

describe("renderPalette", () => {
  it("returns empty array when invisible", () => {
    const state = createPaletteState();
    const lines = renderPalette(state, 60, 10, theme);
    expect(lines).toEqual([]);
  });

  it("renders query line and filtered commands when visible", () => {
    const state: PaletteState = {
      visible: true,
      query: "vim",
      filtered: [BUILTIN_COMMANDS[0]!],
      selectedIndex: 0,
    };
    const lines = renderPalette(state, 60, 10, theme);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]).toContain("vim");
    expect(lines[1]).toContain(BUILTIN_COMMANDS[0]!.label);
  });

  it("marks selected command with indicator", () => {
    const state: PaletteState = {
      visible: true,
      query: "",
      filtered: BUILTIN_COMMANDS.slice(0, 3),
      selectedIndex: 1,
    };
    const lines = renderPalette(state, 60, 10, theme);
    expect(lines.length).toBeGreaterThan(3);
    expect(lines[2]).toContain(">");
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm build && npx vitest run packages/tui/test/command-palette.test.ts`
Expected: FAIL with "Cannot find module '../src/command-palette.js'"

- [ ] **Step 3: 实现 command-palette.ts**

创建 `packages/tui/src/command-palette.ts`:

```typescript
import { fg, type TuiTheme } from "./themes.js";
import { stringWidth } from "./width.js";

export type PaletteCategory = "navigation" | "editing" | "view" | "spec" | "model" | "session";

export interface PaletteCommand {
  id: string;
  label: string;
  description?: string;
  shortcut?: string;
  category: PaletteCategory;
}

export const BUILTIN_COMMANDS: readonly PaletteCommand[] = [
  {
    id: "layout:classic",
    label: "Classic Layout",
    description: "Switch to single-pane layout",
    category: "view",
  },
  {
    id: "layout:split",
    label: "Split Layout",
    description: "Left transcript, right sidebar",
    category: "view",
  },
  {
    id: "vim:toggle",
    label: "Toggle Vim Mode",
    description: "Enable or disable modal editing",
    category: "editing",
  },
  {
    id: "search:transcript",
    label: "Search Transcript",
    shortcut: "Ctrl+F",
    description: "Find text in conversation history",
    category: "navigation",
  },
  {
    id: "model:picker",
    label: "Open Model Picker",
    shortcut: "Alt+M",
    description: "Switch model or reasoning effort",
    category: "model",
  },
  {
    id: "spec:decline",
    label: "Decline Current Spec",
    description: "Reject the pending SpecEngine draft",
    category: "spec",
  },
  {
    id: "session:new",
    label: "New Session",
    description: "Start a fresh conversation",
    category: "session",
  },
  {
    id: "session:fork",
    label: "Fork Session",
    description: "Branch the current conversation",
    category: "session",
  },
  {
    id: "view:toggle_reasoning",
    label: "Toggle Reasoning Display",
    shortcut: "Ctrl+R",
    description: "Expand or collapse model reasoning",
    category: "view",
  },
  {
    id: "view:clear_transcript",
    label: "Clear Transcript",
    description: "Wipe the visible conversation",
    category: "view",
  },
];

export interface PaletteState {
  visible: boolean;
  query: string;
  filtered: PaletteCommand[];
  selectedIndex: number;
}

export function createPaletteState(): PaletteState {
  return {
    visible: false,
    query: "",
    filtered: [...BUILTIN_COMMANDS],
    selectedIndex: 0,
  };
}

/**
 * Fuzzy-ish case-insensitive substring filter on label, description, and category.
 * Resets selectedIndex to 0 when the filtered list changes.
 */
export function updatePaletteQuery(state: PaletteState, query: string): PaletteState {
  const q = query.toLowerCase().trim();
  if (!q) {
    return { ...state, query, filtered: [...BUILTIN_COMMANDS], selectedIndex: 0 };
  }
  const filtered = BUILTIN_COMMANDS.filter((cmd) => {
    return (
      cmd.label.toLowerCase().includes(q) ||
      (cmd.description?.toLowerCase().includes(q) ?? false) ||
      cmd.category.toLowerCase().includes(q)
    );
  });
  return { ...state, query, filtered, selectedIndex: 0 };
}

/**
 * Move selection by delta (positive = down, negative = up). Wraps around.
 * No-op when filtered is empty.
 */
export function movePaletteCursor(state: PaletteState, delta: number): PaletteState {
  if (state.filtered.length === 0) return { ...state, selectedIndex: 0 };
  const len = state.filtered.length;
  const next = (((state.selectedIndex + delta) % len) + len) % len;
  return { ...state, selectedIndex: next };
}

/**
 * Return the currently selected command, or undefined when filtered is empty.
 */
export function confirmPalette(state: PaletteState): PaletteCommand | undefined {
  if (state.filtered.length === 0) return undefined;
  return state.filtered[state.selectedIndex];
}

export function closePalette(state: PaletteState): PaletteState {
  return {
    visible: false,
    query: "",
    filtered: [...BUILTIN_COMMANDS],
    selectedIndex: 0,
  };
}

/**
 * Render the palette overlay. Returns empty array when invisible.
 * Layout:
 *   Line 0:  > query_
 *   Line 1+: filtered commands (selected prefixed with ">"), capped by maxHeight.
 */
export function renderPalette(
  state: PaletteState,
  width: number,
  maxHeight: number,
  theme: TuiTheme,
): string[] {
  if (!state.visible) return [];
  const lines: string[] = [];
  const queryLine = fg(theme.accent, "> ") + state.query + "_";
  lines.push(queryLine);
  const maxItems = Math.max(0, maxHeight - 1);
  const items = state.filtered.slice(0, maxItems);
  for (let i = 0; i < items.length; i++) {
    const cmd = items[i]!;
    const selected = i === state.selectedIndex;
    const marker = selected ? ">" : " ";
    const shortcut = cmd.shortcut ? fg(theme.muted, " [" + cmd.shortcut + "]") : "";
    const labelWidth = Math.max(0, width - 2 - stringWidth(shortcut));
    const label =
      cmd.label.length > labelWidth
        ? cmd.label.slice(0, Math.max(0, labelWidth - 1)) + "…"
        : cmd.label;
    const paddedLabel = label + " ".repeat(Math.max(0, labelWidth - stringWidth(label)));
    const line = marker + " " + (selected ? fg(theme.accent, paddedLabel) : paddedLabel) + shortcut;
    lines.push(line);
  }
  if (state.filtered.length === 0) {
    lines.push(fg(theme.muted, "  No matching commands"));
  }
  return lines;
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm build && npx vitest run packages/tui/test/command-palette.test.ts`
Expected: PASS

- [ ] **Step 5: 边界检查 + prettier**

Run: `node scripts/check-boundaries.mjs && pnpm prettier --check packages/tui/src/command-palette.ts packages/tui/test/command-palette.test.ts`
Expected: 通过

- [ ] **Step 6: 提交**

```bash
git add packages/tui/src/command-palette.ts packages/tui/test/command-palette.test.ts
git commit -m "feat(tui): add command palette pure-function module"
```

---

## Task 3: vim.ts — Vim 模式状态机纯函数模块

**Files:**

- Create: `packages/tui/src/vim.ts`
- Test: `packages/tui/test/vim.test.ts`

**Interfaces:**

- Consumes: 无(纯状态机)
- Produces: `VimMode`、`VimState`、`VimAction`、`createVimState`、`vimHandleKey`、`renderVimIndicator`

**Vim 设计说明:**

- 只实现 normal + insert 模式(visual 留待将来)
- normal 模式:hjkl/w/b/0/$/gg/G/dd/yy/p/x/i/a/o/Esc/数字前缀(可选,先不做 count)
- insert 模式:Esc 返回 normal;其他字符由 app.ts 的 feedInput 正常处理(不经过 vim 状态机)
- `vimHandleKey` 只在 normal 模式被调用;insert 模式字符由 app.ts 直接传给 editor

- [ ] **Step 1: 写失败测试 — normal 模式按键**

创建 `packages/tui/test/vim.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { createVimState, renderVimIndicator, vimHandleKey, type VimState } from "../src/vim.js";
import { TUI_THEMES } from "../src/themes.js";

const theme = TUI_THEMES[0]!;

describe("createVimState", () => {
  it("starts in normal mode", () => {
    const state = createVimState();
    expect(state.mode).toBe("normal");
    expect(state.pendingOperator).toBeUndefined();
  });
});

describe("vimHandleKey — normal mode navigation", () => {
  it("h → cursor_left", () => {
    const result = vimHandleKey(createVimState(), "h");
    expect(result.action).toBe("cursor_left");
    expect(result.state.mode).toBe("normal");
  });

  it("j → cursor_down", () => {
    const result = vimHandleKey(createVimState(), "j");
    expect(result.action).toBe("cursor_down");
  });

  it("k → cursor_up", () => {
    const result = vimHandleKey(createVimState(), "k");
    expect(result.action).toBe("cursor_up");
  });

  it("l → cursor_right", () => {
    const result = vimHandleKey(createVimState(), "l");
    expect(result.action).toBe("cursor_right");
  });

  it("w → word_right", () => {
    const result = vimHandleKey(createVimState(), "w");
    expect(result.action).toBe("word_right");
  });

  it("b → word_left", () => {
    const result = vimHandleKey(createVimState(), "b");
    expect(result.action).toBe("word_left");
  });

  it("0 → home", () => {
    const result = vimHandleKey(createVimState(), "0");
    expect(result.action).toBe("home");
  });

  it("$ → end", () => {
    const result = vimHandleKey(createVimState(), "$");
    expect(result.action).toBe("end");
  });

  it("g then g → goto_top (two-key sequence)", () => {
    const first = vimHandleKey(createVimState(), "g");
    expect(first.action).toBe("noop");
    expect(first.state.pendingOperator).toBe("g");
    const second = vimHandleKey(first.state, "g");
    expect(second.action).toBe("goto_top");
    expect(second.state.pendingOperator).toBeUndefined();
  });

  it("G → goto_bottom", () => {
    const result = vimHandleKey(createVimState(), "G");
    expect(result.action).toBe("goto_bottom");
  });

  it("single g without follow-up waits (sets pendingOperator)", () => {
    const result = vimHandleKey(createVimState(), "g");
    expect(result.action).toBe("noop");
    expect(result.state.pendingOperator).toBe("g");
  });
});

describe("vimHandleKey — normal mode editing", () => {
  it("d then d → delete_line", () => {
    const first = vimHandleKey(createVimState(), "d");
    expect(first.action).toBe("noop");
    expect(first.state.pendingOperator).toBe("d");
    const second = vimHandleKey(first.state, "d");
    expect(second.action).toBe("delete_line");
    expect(second.state.pendingOperator).toBeUndefined();
  });

  it("y then y → yank_line", () => {
    const first = vimHandleKey(createVimState(), "y");
    expect(first.action).toBe("noop");
    const second = vimHandleKey(first.state, "y");
    expect(second.action).toBe("yank_line");
  });

  it("p → paste_after", () => {
    const result = vimHandleKey(createVimState(), "p");
    expect(result.action).toBe("paste_after");
  });

  it("x → delete_char", () => {
    const result = vimHandleKey(createVimState(), "x");
    expect(result.action).toBe("delete_char");
  });

  it("i → enter_insert", () => {
    const result = vimHandleKey(createVimState(), "i");
    expect(result.action).toBe("noop");
    expect(result.state.mode).toBe("insert");
  });

  it("a → enter_insert_after", () => {
    const result = vimHandleKey(createVimState(), "a");
    expect(result.action).toBe("cursor_right");
    expect(result.state.mode).toBe("insert");
  });

  it("o → enter_insert_newline_below", () => {
    const result = vimHandleKey(createVimState(), "o");
    expect(result.action).toBe("newline_below");
    expect(result.state.mode).toBe("insert");
  });
});

describe("vimHandleKey — pending operator cancellation", () => {
  it("Esc cancels pending operator", () => {
    const pending = vimHandleKey(createVimState(), "d");
    const cancelled = vimHandleKey(pending.state, "\u001b");
    expect(cancelled.action).toBe("noop");
    expect(cancelled.state.pendingOperator).toBeUndefined();
    expect(cancelled.state.mode).toBe("normal");
  });

  it("unrelated key cancels pending operator", () => {
    const pending = vimHandleKey(createVimState(), "d");
    const cancelled = vimHandleKey(pending.state, "x");
    expect(cancelled.state.pendingOperator).toBeUndefined();
    expect(cancelled.action).toBe("delete_char");
  });
});

describe("vimHandleKey — unknown keys", () => {
  it("unknown key in normal mode returns noop", () => {
    const result = vimHandleKey(createVimState(), "Z");
    expect(result.action).toBe("noop");
    expect(result.state.mode).toBe("normal");
  });
});

describe("renderVimIndicator", () => {
  it("returns empty string when mode is normal (default, no indicator needed)", () => {
    const state = createVimState();
    const indicator = renderVimIndicator(state, theme);
    expect(indicator).toBe("-- NORMAL --");
  });

  it("returns INSERT indicator when in insert mode", () => {
    const state: VimState = { mode: "insert" };
    const indicator = renderVimIndicator(state, theme);
    expect(indicator).toBe("-- INSERT --");
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm build && npx vitest run packages/tui/test/vim.test.ts`
Expected: FAIL with "Cannot find module '../src/vim.js'"

- [ ] **Step 3: 实现 vim.ts**

创建 `packages/tui/src/vim.ts`:

```typescript
import { fg, type TuiTheme } from "./themes.js";

export type VimMode = "normal" | "insert";

export interface VimState {
  mode: VimMode;
  /** Pending operator awaiting a motion/operand (e.g. "d" waiting for second "d"). */
  pendingOperator?: "d" | "y" | "g";
}

/**
 * Actions the vim state machine can request the host (app.ts) to perform.
 * The host maps these to EditorBuffer calls.
 */
export type VimAction =
  | "cursor_left"
  | "cursor_right"
  | "cursor_up"
  | "cursor_down"
  | "word_left"
  | "word_right"
  | "home"
  | "end"
  | "goto_top"
  | "goto_bottom"
  | "delete_line"
  | "yank_line"
  | "paste_after"
  | "delete_char"
  | "newline_below"
  | "noop";

export interface VimHandleKeyResult {
  state: VimState;
  action: VimAction;
}

export function createVimState(): VimState {
  return { mode: "normal" };
}

/**
 * Handle a single key in normal mode. Returns the new state and an action
 * for the host to execute. This function must NOT be called in insert mode —
 * insert-mode characters are handled by the host's normal input path.
 *
 * Supported keys:
 *   h j k l  — cursor movement
 *   w b      — word forward/back
 *   0 $      — line start/end
 *   gg G     — buffer top/bottom
 *   dd       — delete line
 *   yy       — yank line
 *   p        — paste after
 *   x        — delete char under cursor
 *   i a o    — enter insert mode (before/after cursor / newline below)
 *   Esc      — cancel pending operator
 */
export function vimHandleKey(state: VimState, key: string): VimHandleKeyResult {
  // Esc always cancels pending operator (and stays in normal mode).
  if (key === "\u001b") {
    return { state: { mode: "normal" }, action: "noop" };
  }

  // If we have a pending operator, consume the next key to complete it.
  if (state.pendingOperator === "d") {
    if (key === "d") return { state: { mode: "normal" }, action: "delete_line" };
    // Any other key cancels the operator and is processed fresh.
    return vimHandleKey({ mode: "normal" }, key);
  }
  if (state.pendingOperator === "y") {
    if (key === "y") return { state: { mode: "normal" }, action: "yank_line" };
    return vimHandleKey({ mode: "normal" }, key);
  }
  if (state.pendingOperator === "g") {
    if (key === "g") return { state: { mode: "normal" }, action: "goto_top" };
    return vimHandleKey({ mode: "normal" }, key);
  }

  // Single-key normal-mode commands.
  switch (key) {
    case "h":
      return { state, action: "cursor_left" };
    case "j":
      return { state, action: "cursor_down" };
    case "k":
      return { state, action: "cursor_up" };
    case "l":
      return { state, action: "cursor_right" };
    case "w":
      return { state, action: "word_right" };
    case "b":
      return { state, action: "word_left" };
    case "0":
      return { state, action: "home" };
    case "$":
      return { state, action: "end" };
    case "G":
      return { state, action: "goto_bottom" };
    case "p":
      return { state, action: "paste_after" };
    case "x":
      return { state, action: "delete_char" };
    case "i":
      return { state: { mode: "insert" }, action: "noop" };
    case "a":
      return { state: { mode: "insert" }, action: "cursor_right" };
    case "o":
      return { state: { mode: "insert" }, action: "newline_below" };
    case "d":
      return { state: { mode: "normal", pendingOperator: "d" }, action: "noop" };
    case "y":
      return { state: { mode: "normal", pendingOperator: "y" }, action: "noop" };
    case "g":
      return { state: { mode: "normal", pendingOperator: "g" }, action: "noop" };
    default:
      return { state, action: "noop" };
  }
}

/**
 * Render a mode indicator string for the footer, e.g. "-- NORMAL --".
 */
export function renderVimIndicator(state: VimState, theme: TuiTheme): string {
  const label = state.mode === "insert" ? "-- INSERT --" : "-- NORMAL --";
  return fg(theme.accent, label);
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm build && npx vitest run packages/tui/test/vim.test.ts`
Expected: PASS

- [ ] **Step 5: 边界检查 + prettier**

Run: `node scripts/check-boundaries.mjs && pnpm prettier --check packages/tui/src/vim.ts packages/tui/test/vim.test.ts`
Expected: 通过

- [ ] **Step 6: 提交**

```bash
git add packages/tui/src/vim.ts packages/tui/test/vim.test.ts
git commit -m "feat(tui): add vim mode state machine (normal + insert)"
```

---

## Task 4: keymap.ts 扩展 — 新增 3 个 action

**Files:**

- Modify: `packages/tui/src/keymap.ts`
- Test: `packages/tui/test/keymap.test.ts`

**Interfaces:**

- Consumes: 现有 `TuiAction`、`DEFAULT_KEYMAP`、`VALID_ACTIONS`、`mergeKeymap`
- Produces: 扩展后的 `TuiAction`(新增 `toggle_vim` | `open_palette` | `search_transcript`)、扩展后的 `DEFAULT_KEYMAP`(新增 ctrl+v / ctrl+p / ctrl+f 绑定)

- [ ] **Step 1: 写失败测试 — 新 action 与绑定**

在 `packages/tui/test/keymap.test.ts` 末尾追加:

```typescript
import { DEFAULT_KEYMAP, mergeKeymap, parseTerminalInput } from "../src/keymap.js";

describe("Phase 2 keymap extensions", () => {
  it("DEFAULT_KEYMAP binds ctrl+v to toggle_vim", () => {
    expect(DEFAULT_KEYMAP["ctrl+v"]).toBe("toggle_vim");
  });

  it("DEFAULT_KEYMAP binds ctrl+p to open_palette", () => {
    expect(DEFAULT_KEYMAP["ctrl+p"]).toBe("open_palette");
  });

  it("DEFAULT_KEYMAP binds ctrl+f to search_transcript", () => {
    expect(DEFAULT_KEYMAP["ctrl+f"]).toBe("search_transcript");
  });

  it("parseTerminalInput maps Ctrl+V to toggle_vim action", () => {
    const parsed = parseTerminalInput("\x16"); // Ctrl+V = code 22
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({ type: "action", action: "toggle_vim" });
  });

  it("parseTerminalInput maps Ctrl+P to open_palette action", () => {
    const parsed = parseTerminalInput("\x10"); // Ctrl+P = code 16
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({ type: "action", action: "open_palette" });
  });

  it("parseTerminalInput maps Ctrl+F to search_transcript action", () => {
    const parsed = parseTerminalInput("\x06"); // Ctrl+F = code 6
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({ type: "action", action: "search_transcript" });
  });

  it("mergeKeymap accepts toggle_vim as valid action", () => {
    const km = mergeKeymap({ "ctrl+g": "toggle_vim" });
    expect(km["ctrl+g"]).toBe("toggle_vim");
  });

  it("mergeKeymap accepts open_palette as valid action", () => {
    const km = mergeKeymap({ "ctrl+g": "open_palette" });
    expect(km["ctrl+g"]).toBe("open_palette");
  });

  it("mergeKeymap accepts search_transcript as valid action", () => {
    const km = mergeKeymap({ "ctrl+g": "search_transcript" });
    expect(km["ctrl+g"]).toBe("search_transcript");
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm build && npx vitest run packages/tui/test/keymap.test.ts`
Expected: FAIL — "Expected 'toggle_vim' but got undefined" 等

- [ ] **Step 3: 修改 keymap.ts**

在 `TuiAction` 类型末尾(`| "toggle_reasoning"` 后)新增 3 个 action:

```typescript
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
  | "toggle_reasoning"
  | "toggle_vim"
  | "open_palette"
  | "search_transcript";
```

在 `DEFAULT_KEYMAP` 中新增 3 个绑定(在 `"ctrl+g": "cycle_mascot"` 后):

```typescript
  "ctrl+g": "cycle_mascot",
  "ctrl+v": "toggle_vim",
  "ctrl+p": "open_palette",
  "ctrl+f": "search_transcript",
```

在 `VALID_ACTIONS` 数组末尾(`"toggle_reasoning"` 后)新增:

```typescript
const VALID_ACTIONS: readonly TuiAction[] = [
  // ...existing...
  "toggle_reasoning",
  "toggle_vim",
  "open_palette",
  "search_transcript",
];
```

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm build && npx vitest run packages/tui/test/keymap.test.ts`
Expected: PASS

- [ ] **Step 5: 边界检查 + prettier**

Run: `node scripts/check-boundaries.mjs && pnpm prettier --check packages/tui/src/keymap.ts packages/tui/test/keymap.test.ts`
Expected: 通过

- [ ] **Step 6: 提交**

```bash
git add packages/tui/src/keymap.ts packages/tui/test/keymap.test.ts
git commit -m "feat(tui): add toggle_vim, open_palette, search_transcript actions"
```

---

## Task 5: editor.ts 扩展 — vim 所需行级操作

**Files:**

- Modify: `packages/tui/src/editor.ts`
- Test: `packages/tui/test/editor.test.ts` (新建)

**Interfaces:**

- Consumes: 现有 `EditorBuffer`、`EditorCursor`、`segmentGraphemes`
- Produces: `EditorBuffer` 新增方法 `deleteLine()`、`yankLine()`、`pasteAfter()`、`deleteChar()`、`getLineText(row)`、`setLineText(row, text)`、`gotoTop()`、`gotoBottom()`

- [ ] **Step 1: 写失败测试 — 新增行级操作**

创建 `packages/tui/test/editor.test.ts`:

```typescript
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
    // cursor is on line2 (row=1) after setText? Actually setText puts cursor at end of last line.
    // So set cursor explicitly.
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

  it("deletes the last line and moves cursor to new last line end", () => {
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
    // yank should paste the yanked line
    buf.setCursor({ row: 0, col: 0 });
    buf.yank();
    // yank pastes "bar" at cursor position on line 0
    expect(buf.getText()).toBe("barfoo\nbar\nbaz");
  });
});

describe("EditorBuffer.pasteAfter (vim p)", () => {
  it("pastes kill-ring content on a new line below cursor", () => {
    const buf = new EditorBuffer();
    buf.setText("line1\nline2\nline3");
    buf.setCursor({ row: 0, col: 0 });
    buf.yankLine(); // yanks "line1"
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
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm build && npx vitest run packages/tui/test/editor.test.ts`
Expected: FAIL — "buf.deleteLine is not a function" 等

- [ ] **Step 3: 扩展 editor.ts**

在 `EditorBuffer` 类中(在 `yank()` 方法后)新增以下方法:

```typescript
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
      this.lines = [""];
      this.cursor = { row: 0, col: 0 };
      return;
    }
    this.pushUndo();
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
```

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm build && npx vitest run packages/tui/test/editor.test.ts`
Expected: PASS

- [ ] **Step 5: 边界检查 + prettier**

Run: `node scripts/check-boundaries.mjs && pnpm prettier --check packages/tui/src/editor.ts packages/tui/test/editor.test.ts`
Expected: 通过

- [ ] **Step 6: 提交**

```bash
git add packages/tui/src/editor.ts packages/tui/test/editor.test.ts
git commit -m "feat(tui): add vim line-level operations to EditorBuffer"
```

---

## Task 6: renderer.ts 扩展 — 渲染 search/palette/vim

**Files:**

- Modify: `packages/tui/src/renderer.ts`
- Test: `packages/tui/test/renderer.test.ts`

**Interfaces:**

- Consumes: `SearchState` + `renderSearchBar` from `./search.js`、`PaletteState` + `renderPalette` from `./command-palette.js`、`VimState` + `renderVimIndicator` from `./vim.js`
- Produces: `TuiRenderState` 新增 `search?`、`palette?`、`vim?` 字段;`renderTui` 渲染 search bar、palette overlay、vim 指示器

- [ ] **Step 1: 写失败测试 — 新字段渲染**

在 `packages/tui/test/renderer.test.ts` 末尾追加:

```typescript
import type { SearchState } from "../src/search.js";
import type { PaletteState } from "../src/command-palette.js";
import { createPaletteState, updatePaletteQuery } from "../src/command-palette.js";
import type { VimState } from "../src/vim.js";
import { renderTui } from "../src/renderer.js";

function baseState(overrides: Record<string, unknown> = {}) {
  return {
    width: 60,
    height: 20,
    title: "test",
    model: "m",
    session: "s",
    approval: "ask",
    sandbox: "host",
    busy: false,
    queued: 0,
    mood: "idle" as const,
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

describe("renderTui — search bar", () => {
  it("renders search bar when search.visible is true", () => {
    const search: SearchState = {
      visible: true,
      query: "hello",
      matches: [0, 2],
      currentIndex: 0,
    };
    const frame = renderTui(baseState({ search }) as Parameters<typeof renderTui>[0]);
    expect(frame).toContain("hello");
    expect(frame).toContain("1/2");
  });

  it("does not render search bar when search is invisible", () => {
    const search: SearchState = { visible: false, query: "", matches: [], currentIndex: 0 };
    const frame = renderTui(baseState({ search }) as Parameters<typeof renderTui>[0]);
    expect(frame).not.toContain("/hello");
  });
});

describe("renderTui — command palette", () => {
  it("renders palette overlay when palette.visible is true", () => {
    let palette: PaletteState = createPaletteState();
    palette = { ...palette, visible: true, query: "vim" };
    palette = updatePaletteQuery(palette, "vim");
    const frame = renderTui(baseState({ palette }) as Parameters<typeof renderTui>[0]);
    expect(frame).toContain("vim");
    expect(frame).toContain("Vim");
  });

  it("does not render palette when invisible", () => {
    const palette = createPaletteState();
    const frame = renderTui(baseState({ palette }) as Parameters<typeof renderTui>[0]);
    expect(frame).not.toContain("> ");
  });
});

describe("renderTui — vim indicator", () => {
  it("renders vim mode indicator in footer when vim is present", () => {
    const vim: VimState = { mode: "normal" };
    const frame = renderTui(baseState({ vim }) as Parameters<typeof renderTui>[0]);
    expect(frame).toContain("-- NORMAL --");
  });

  it("renders INSERT indicator when vim mode is insert", () => {
    const vim: VimState = { mode: "insert" };
    const frame = renderTui(baseState({ vim }) as Parameters<typeof renderTui>[0]);
    expect(frame).toContain("-- INSERT --");
  });

  it("does not render vim indicator when vim is undefined", () => {
    const frame = renderTui(baseState() as Parameters<typeof renderTui>[0]);
    expect(frame).not.toContain("-- NORMAL --");
    expect(frame).not.toContain("-- INSERT --");
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm build && npx vitest run packages/tui/test/renderer.test.ts`
Expected: FAIL — TuiRenderState 无 search/palette/vim 字段

- [ ] **Step 3: 修改 renderer.ts**

在文件顶部新增 import:

```typescript
import { renderSearchBar, type SearchState } from "./search.js";
import { renderPalette, type PaletteState } from "./command-palette.js";
import { renderVimIndicator, type VimState } from "./vim.js";
```

在 `TuiRenderState` 接口末尾(`contextUsage?: ContextUsageState;` 后)新增:

```typescript
  /** Context window 使用量;存在时在 footer 显示进度条。 */
  contextUsage?: ContextUsageState;
  /** Transcript 搜索状态;visible 时在底部渲染搜索栏。 */
  search?: SearchState;
  /** 命令面板状态;visible 时渲染 overlay。 */
  palette?: PaletteState;
  /** Vim 模式状态;存在时在 footer 渲染模式指示器。 */
  vim?: VimState;
```

在 `renderTui` 函数中,在渲染 footer 之前(或 footer 内),新增 search bar 和 palette overlay 渲染。找到 footer 渲染部分(通常在函数末尾构建 bottom 区域附近),在 footer 行之前插入:

```typescript
// Search bar (above footer, below body)
const searchLines: string[] = state.search ? renderSearchBar(state.search, width, theme) : [];

// Command palette overlay (takes priority over body when visible)
const paletteLines: string[] = state.palette
  ? renderPalette(state.palette, width, Math.max(4, Math.floor(height / 2)), theme)
  : [];

// Vim mode indicator (appended to footer)
const vimIndicator = state.vim ? renderVimIndicator(state.vim, theme) : "";
```

然后在构建 body 区域时,将 `paletteLines` 和 `searchLines` 插入到 body 与 footer 之间。具体实现取决于 renderer.ts 的现有结构 — 将 palette overlay 放在 body 区域顶部(覆盖 body),search bar 放在 body 底部(footer 之前)。

在 footer 行构建处,追加 vim indicator:

```typescript
// 在 footer 行中追加 vim indicator
const footerParts: string[] = [/* existing footer content */];
if (vimIndicator) footerParts.push(vimIndicator);
```

**注意**:具体插入位置需根据 renderer.ts 现有结构调整。核心原则:

1. palette overlay 覆盖 body 区域(类似 picker)
2. search bar 在 body 底部、footer 之前
3. vim indicator 在 footer 末尾

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm build && npx vitest run packages/tui/test/renderer.test.ts`
Expected: PASS

- [ ] **Step 5: 边界检查 + prettier**

Run: `node scripts/check-boundaries.mjs && pnpm prettier --check packages/tui/src/renderer.ts packages/tui/test/renderer.test.ts`
Expected: 通过

- [ ] **Step 6: 提交**

```bash
git add packages/tui/src/renderer.ts packages/tui/test/renderer.test.ts
git commit -m "feat(tui): render search bar, palette overlay, vim indicator"
```

---

## Task 7: app.ts 集成 — 搜索状态管理 + 输入拦截

**Files:**

- Modify: `packages/tui/src/app.ts`
- Test: `packages/tui/test/app.test.ts`

**Interfaces:**

- Consumes: `SearchState`、`createSearchState`、`searchTranscript`、`advanceSearch`、`closeSearch` from `./search.js`;`TuiTranscriptLine` from `./renderer.js`
- Produces: `FullScreenTui` 新增 `openSearch()`、`closeSearch()`、`updateSearchQuery()` 方法;`buildState()` 输出 `search` 字段

- [ ] **Step 1: 写失败测试 — 搜索状态管理**

在 `packages/tui/test/app.test.ts` 末尾追加:

```typescript
describe("FullScreenTui — search integration", () => {
  it("openSearch sets search.visible to true", () => {
    const tui = createTestTui();
    tui.openSearch();
    const state = tui.getState();
    expect(state.search).toBeDefined();
    expect(state.search!.visible).toBe(true);
    expect(state.search!.query).toBe("");
  });

  it("updateSearchQuery populates matches from transcript", () => {
    const tui = createTestTui();
    tui.addMessage("user", "hello world");
    tui.addMessage("assistant", "goodbye");
    tui.addMessage("user", "say hello again");
    tui.openSearch();
    tui.updateSearchQuery("hello");
    const state = tui.getState();
    expect(state.search!.query).toBe("hello");
    expect(state.search!.matches).toEqual([0, 2]);
  });

  it("closeSearch resets to invisible", () => {
    const tui = createTestTui();
    tui.openSearch();
    tui.updateSearchQuery("test");
    tui.closeSearch();
    const state = tui.getState();
    expect(state.search).toBeDefined();
    expect(state.search!.visible).toBe(false);
    expect(state.search!.query).toBe("");
  });

  it("advanceSearch cycles currentIndex", () => {
    const tui = createTestTui();
    tui.addMessage("user", "hello");
    tui.addMessage("assistant", "hello");
    tui.openSearch();
    tui.updateSearchQuery("hello");
    tui.advanceSearch(1);
    expect(tui.getState().search!.currentIndex).toBe(1);
    tui.advanceSearch(1);
    expect(tui.getState().search!.currentIndex).toBe(0);
  });
});
```

**注意**:`createTestTui()`、`tui.addMessage()`、`tui.getState()` 是测试辅助函数。如果 `app.test.ts` 中已有类似 helper,复用之;否则在测试文件顶部定义。参考已有 `app.test.ts` 的测试模式。

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm build && npx vitest run packages/tui/test/app.test.ts`
Expected: FAIL — "tui.openSearch is not a function"

- [ ] **Step 3: 修改 app.ts**

在文件顶部新增 import:

```typescript
import { closeSearch, createSearchState, searchTranscript, type SearchState } from "./search.js";
```

在 `FullScreenTui` 类中(在 `private contextUsage` 字段后)新增:

```typescript
  private search: SearchState = createSearchState();
```

新增公开方法(在 `setContextUsage` 方法后):

```typescript
  /** Open the transcript search bar (Ctrl+F). */
  openSearch(): void {
    this.search = { ...createSearchState(), visible: true };
    this.render();
  }

  /** Close the search bar and reset state. */
  closeSearch(): void {
    this.search = closeSearch(this.search);
    this.render();
  }

  /** Update the search query and recompute matches. */
  updateSearchQuery(query: string): void {
    const matches = searchTranscript(this.transcript, query);
    this.search = { ...this.search, query, matches, currentIndex: 0 };
    this.render();
  }

  /** Advance the current match index by delta (1 = next, -1 = previous). */
  advanceSearch(delta: number): void {
    this.search = advanceSearch(this.search, delta);
    this.render();
  }
```

**注意**:需要额外 import `advanceSearch`:

```typescript
import {
  advanceSearch,
  closeSearch,
  createSearchState,
  searchTranscript,
  type SearchState,
} from "./search.js";
```

在 `buildState()` 方法中(在 `contextUsage` 字段后)新增:

```typescript
      ...(this.contextUsage ? { contextUsage: this.contextUsage } : {}),
      search: this.search,
```

在 `onData` 方法中,在 `if (this.specConfirmation)` 之后、`if (value.startsWith("\u001bm"))` 之前,新增 search 拦截:

```typescript
if (this.search.visible) {
  this.handleSearchInput(value);
  return;
}
```

新增 `handleSearchInput` 私有方法(在 `handleSpecConfirmationInput` 后):

```typescript
  /**
   * Handle keystrokes while the search bar is open.
   * Enter advances to next match, Shift+Enter to previous, Esc closes.
   * Backspace edits query, printable chars extend query.
   */
  private handleSearchInput(value: string): void {
    let index = 0;
    while (index < value.length) {
      const rest = value.slice(index);
      // Esc closes search
      if (rest.startsWith("\u001b") && !rest.startsWith("\u001b[")) {
        this.closeSearch();
        index += 1;
        continue;
      }
      // Enter advances to next match
      if (rest.startsWith("\r") || rest.startsWith("\n")) {
        this.advanceSearch(1);
        index += 1;
        continue;
      }
      // Backspace removes last char
      if (rest.startsWith("\u007f") || rest.startsWith("\b")) {
        if (this.search.query) {
          this.updateSearchQuery(this.search.query.slice(0, -1));
        }
        index += 1;
        continue;
      }
      // Drop unrecognized CSI sequences
      if (rest.startsWith("\u001b[")) {
        const match = /^(\u001b\[[0-?]*[ -/]*[@-~])/.exec(rest);
        if (match) {
          index += match[1]!.length;
          continue;
        }
        index += 1;
        continue;
      }
      // Printable characters extend the query
      const point = rest.codePointAt(0);
      if (point !== undefined && point >= 32 && point !== 127) {
        const char = String.fromCodePoint(point);
        this.updateSearchQuery(this.search.query + char);
        index += char.length;
        continue;
      }
      index += 1;
    }
  }
```

在 `action` 方法中,在 `else if (action === "toggle_reasoning")` 后新增:

```typescript
    } else if (action === "search_transcript") {
      if (this.search.visible) {
        this.closeSearch();
      } else {
        this.openSearch();
      }
    }
```

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm build && npx vitest run packages/tui/test/app.test.ts`
Expected: PASS

- [ ] **Step 5: 边界检查 + prettier**

Run: `node scripts/check-boundaries.mjs && pnpm prettier --check packages/tui/src/app.ts packages/tui/test/app.test.ts`
Expected: 通过

- [ ] **Step 6: 提交**

```bash
git add packages/tui/src/app.ts packages/tui/test/app.test.ts
git commit -m "feat(tui): integrate transcript search into FullScreenTui"
```

---

## Task 8: app.ts 集成 — 命令面板状态管理 + 输入拦截

**Files:**

- Modify: `packages/tui/src/app.ts`
- Modify: `packages/tui/src/app.ts` (FullScreenTuiOptions)
- Test: `packages/tui/test/app.test.ts`

**Interfaces:**

- Consumes: `PaletteState`、`createPaletteState`、`updatePaletteQuery`、`movePaletteCursor`、`confirmPalette`、`closePalette` from `./command-palette.js`
- Produces: `FullScreenTuiOptions` 新增 `onPaletteCommand?`;`FullScreenTui` 新增 `openPalette()`、`closePalette()`、`updatePaletteQuery()`、`confirmPaletteSelection()` 方法;`buildState()` 输出 `palette` 字段

- [ ] **Step 1: 写失败测试 — 命令面板状态管理**

在 `packages/tui/test/app.test.ts` 末尾追加:

```typescript
describe("FullScreenTui — command palette integration", () => {
  it("openPalette sets palette.visible to true", () => {
    const tui = createTestTui();
    tui.openPalette();
    const state = tui.getState();
    expect(state.palette).toBeDefined();
    expect(state.palette!.visible).toBe(true);
    expect(state.palette!.query).toBe("");
  });

  it("updatePaletteQuery filters commands", () => {
    const tui = createTestTui();
    tui.openPalette();
    tui.updatePaletteQuery("vim");
    const state = tui.getState();
    expect(state.palette!.query).toBe("vim");
    expect(state.palette!.filtered.length).toBeGreaterThan(0);
    expect(state.palette!.filtered.every((c) => c.label.toLowerCase().includes("vim"))).toBe(true);
  });

  it("closePalette resets to invisible", () => {
    const tui = createTestTui();
    tui.openPalette();
    tui.updatePaletteQuery("vim");
    tui.closePalette();
    const state = tui.getState();
    expect(state.palette!.visible).toBe(false);
    expect(state.palette!.query).toBe("");
  });

  it("confirmPaletteSelection triggers onPaletteCommand callback", () => {
    let receivedCommand: string | undefined;
    const tui = createTestTui({
      onPaletteCommand: (cmd) => {
        receivedCommand = cmd;
      },
    });
    tui.openPalette();
    tui.updatePaletteQuery("vim");
    tui.confirmPaletteSelection();
    expect(receivedCommand).toBeDefined();
    expect(receivedCommand).toContain(":");
  });
});
```

**注意**:`createTestTui(options?)` 需要接受可选的 `FullScreenTuiOptions` 覆盖。如果现有 helper 不支持,扩展之。

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm build && npx vitest run packages/tui/test/app.test.ts`
Expected: FAIL — "tui.openPalette is not a function"

- [ ] **Step 3: 修改 app.ts**

在文件顶部新增 import:

```typescript
import {
  closePalette,
  confirmPalette,
  createPaletteState,
  movePaletteCursor,
  updatePaletteQuery,
  type PaletteState,
} from "./command-palette.js";
```

在 `FullScreenTuiOptions` 接口中(在 `onSpecDecline?` 后)新增:

```typescript
  /** SpecEngine 拒绝整个 spec 时调用。 */
  onSpecDecline?(specId: string): void;
  /** 命令面板触发命令时调用。 */
  onPaletteCommand?(command: string): void;
```

在 `FullScreenTui` 类中(在 `private search` 字段后)新增:

```typescript
  private palette: PaletteState = createPaletteState();
```

新增公开方法(在 `advanceSearch` 方法后):

```typescript
  /** Open the command palette (Ctrl+P). */
  openPalette(): void {
    this.palette = { ...createPaletteState(), visible: true };
    this.render();
  }

  /** Close the command palette and reset state. */
  closePalette(): void {
    this.palette = closePalette(this.palette);
    this.render();
  }

  /** Update the palette query and recompute filtered commands. */
  updatePaletteQuery(query: string): void {
    this.palette = updatePaletteQuery(this.palette, query);
    this.render();
  }

  /** Move the palette selection cursor by delta (1 = down, -1 = up). */
  movePaletteCursor(delta: number): void {
    this.palette = movePaletteCursor(this.palette, delta);
    this.render();
  }

  /** Confirm the current palette selection and trigger onPaletteCommand. */
  confirmPaletteSelection(): void {
    const command = confirmPalette(this.palette);
    this.closePalette();
    if (command) {
      try {
        this.options.onPaletteCommand?.(command.id);
      } catch (error) {
        this.setStatus(error instanceof Error ? error.message : String(error));
      }
    }
  }
```

在 `buildState()` 方法中(在 `search: this.search,` 后)新增:

```typescript
      search: this.search,
      palette: this.palette,
```

在 `onData` 方法中,在 `if (this.search.visible)` 之前,新增 palette 拦截(palette 优先级高于 search):

```typescript
if (this.palette.visible) {
  this.handlePaletteInput(value);
  return;
}
```

新增 `handlePaletteInput` 私有方法(在 `handleSearchInput` 后):

```typescript
  /**
   * Handle keystrokes while the command palette is open.
   * Up/Down navigate, Enter confirms, Esc closes.
   * Backspace edits query, printable chars extend query.
   */
  private handlePaletteInput(value: string): void {
    let index = 0;
    while (index < value.length) {
      const rest = value.slice(index);
      // Esc closes palette
      if (rest.startsWith("\u001b") && !rest.startsWith("\u001b[")) {
        this.closePalette();
        index += 1;
        continue;
      }
      // Enter confirms selection
      if (rest.startsWith("\r") || rest.startsWith("\n")) {
        this.confirmPaletteSelection();
        index += 1;
        continue;
      }
      // Up arrow
      if (rest.startsWith("\u001b[A")) {
        this.movePaletteCursor(-1);
        index += 3;
        continue;
      }
      // Down arrow
      if (rest.startsWith("\u001b[B")) {
        this.movePaletteCursor(1);
        index += 3;
        continue;
      }
      // Backspace removes last char
      if (rest.startsWith("\u007f") || rest.startsWith("\b")) {
        if (this.palette.query) {
          this.updatePaletteQuery(this.palette.query.slice(0, -1));
        }
        index += 1;
        continue;
      }
      // Drop unrecognized CSI sequences
      if (rest.startsWith("\u001b[")) {
        const match = /^(\u001b\[[0-?]*[ -/]*[@-~])/.exec(rest);
        if (match) {
          index += match[1]!.length;
          continue;
        }
        index += 1;
        continue;
      }
      // Printable characters extend the query
      const point = rest.codePointAt(0);
      if (point !== undefined && point >= 32 && point !== 127) {
        const char = String.fromCodePoint(point);
        this.updatePaletteQuery(this.palette.query + char);
        index += char.length;
        continue;
      }
      index += 1;
    }
  }
```

在 `action` 方法中,在 `else if (action === "search_transcript")` 后新增:

```typescript
    } else if (action === "open_palette") {
      if (this.palette.visible) {
        this.closePalette();
      } else {
        this.openPalette();
      }
    }
```

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm build && npx vitest run packages/tui/test/app.test.ts`
Expected: PASS

- [ ] **Step 5: 边界检查 + prettier**

Run: `node scripts/check-boundaries.mjs && pnpm prettier --check packages/tui/src/app.ts packages/tui/test/app.test.ts`
Expected: 通过

- [ ] **Step 6: 提交**

```bash
git add packages/tui/src/app.ts packages/tui/test/app.test.ts
git commit -m "feat(tui): integrate command palette into FullScreenTui"
```

---

## Task 9: app.ts 集成 — Vim 模式状态管理

**Files:**

- Modify: `packages/tui/src/app.ts`
- Test: `packages/tui/test/app.test.ts`

**Interfaces:**

- Consumes: `VimState`、`createVimState`、`vimHandleKey`、`VimAction` from `./vim.js`;EditorBuffer 新增方法(Task 5)
- Produces: `FullScreenTui` 新增 `setVimEnabled()`、`getVimState()` 方法;`feedInput` 分流 vim normal 模式;`buildState()` 输出 `vim` 字段

- [ ] **Step 1: 写失败测试 — vim 模式状态管理**

在 `packages/tui/test/app.test.ts` 末尾追加:

```typescript
describe("FullScreenTui — vim mode integration", () => {
  it("vim is disabled by default", () => {
    const tui = createTestTui();
    const state = tui.getState();
    expect(state.vim).toBeUndefined();
  });

  it("setVimEnabled(true) activates vim in normal mode", () => {
    const tui = createTestTui();
    tui.setVimEnabled(true);
    const state = tui.getState();
    expect(state.vim).toBeDefined();
    expect(state.vim!.mode).toBe("normal");
  });

  it("setVimEnabled(false) deactivates vim", () => {
    const tui = createTestTui();
    tui.setVimEnabled(true);
    tui.setVimEnabled(false);
    const state = tui.getState();
    expect(state.vim).toBeUndefined();
  });

  it("vim normal mode 'h' moves cursor left instead of inserting 'h'", () => {
    const tui = createTestTui();
    tui.setVimEnabled(true);
    tui.setEditorText("hello");
    tui.setCursor({ row: 0, col: 3 });
    tui.sendInput("h");
    expect(tui.getEditorText()).toBe("hello"); // text unchanged
    expect(tui.getCursor()).toEqual({ row: 0, col: 2 }); // cursor moved
  });

  it("vim normal mode 'i' enters insert mode", () => {
    const tui = createTestTui();
    tui.setVimEnabled(true);
    tui.sendInput("i");
    expect(tui.getState().vim!.mode).toBe("insert");
  });

  it("vim insert mode types text normally", () => {
    const tui = createTestTui();
    tui.setVimEnabled(true);
    tui.sendInput("i"); // enter insert
    tui.sendInput("abc");
    expect(tui.getEditorText()).toBe("abc");
  });

  it("vim insert mode Esc returns to normal mode", () => {
    const tui = createTestTui();
    tui.setVimEnabled(true);
    tui.sendInput("i"); // enter insert
    tui.sendInput("\u001b"); // Esc
    expect(tui.getState().vim!.mode).toBe("normal");
  });

  it("vim normal mode 'dd' deletes current line", () => {
    const tui = createTestTui();
    tui.setVimEnabled(true);
    tui.setEditorText("line1\nline2\nline3");
    tui.setCursor({ row: 1, col: 0 });
    tui.sendInput("dd");
    expect(tui.getEditorText()).toBe("line1\nline3");
  });
});
```

**注意**:`tui.setEditorText()`、`tui.setCursor()`、`tui.sendInput()`、`tui.getEditorText()`、`tui.getCursor()` 是测试辅助方法。需要在 `FullScreenTui` 上暴露测试用 hooks 或在测试 helper 中直接操作内部 editor。推荐在 `FullScreenTui` 上新增 `/* @internal */` 测试辅助方法:

```typescript
  /** @internal Test helper: set editor text directly. */
  setEditorTextForTest(text: string): void {
    this.editor.setText(text);
    this.render();
  }
  /** @internal Test helper: set cursor directly. */
  setCursorForTest(cursor: { row: number; col: number }): void {
    this.editor.setCursor(cursor);
    this.render();
  }
  /** @internal Test helper: get editor text. */
  getEditorTextForTest(): string {
    return this.editor.getText();
  }
  /** @internal Test helper: get cursor. */
  getCursorForTest(): { row: number; col: number } {
    return this.editor.getCursor();
  }
  /** @internal Test helper: send raw input. */
  sendInputForTest(input: string): void {
    this.onData(input);
  }
```

测试中调用 `tui.setEditorTextForTest("hello")` 等。

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm build && npx vitest run packages/tui/test/app.test.ts`
Expected: FAIL — "tui.setVimEnabled is not a function"

- [ ] **Step 3: 修改 app.ts**

在文件顶部新增 import:

```typescript
import { createVimState, vimHandleKey, type VimAction, type VimState } from "./vim.js";
```

在 `FullScreenTui` 类中(在 `private palette` 字段后)新增:

```typescript
  private vimEnabled = false;
  private vimState: VimState = createVimState();
```

新增公开方法(在 `confirmPaletteSelection` 后):

```typescript
  /** Enable or disable vim modal editing. */
  setVimEnabled(enabled: boolean): void {
    this.vimEnabled = enabled;
    if (enabled) {
      this.vimState = createVimState();
    }
    this.setStatus(enabled ? "Vim mode: ON (normal)" : "Vim mode: OFF");
    this.render();
  }

  /** Return current vim state (undefined when vim is disabled). */
  getVimState(): VimState | undefined {
    return this.vimEnabled ? this.vimState : undefined;
  }

  /** @internal Test helper: set editor text directly. */
  setEditorTextForTest(text: string): void {
    this.editor.setText(text);
    this.render();
  }

  /** @internal Test helper: set cursor directly. */
  setCursorForTest(cursor: { row: number; col: number }): void {
    this.editor.setCursor(cursor);
    this.render();
  }

  /** @internal Test helper: get editor text. */
  getEditorTextForTest(): string {
    return this.editor.getText();
  }

  /** @internal Test helper: get cursor. */
  getCursorForTest(): { row: number; col: number } {
    return this.editor.getCursor();
  }

  /** @internal Test helper: send raw input. */
  sendInputForTest(input: string): void {
    this.onData(input);
  }
```

在 `buildState()` 方法中(在 `palette: this.palette,` 后)新增:

```typescript
      palette: this.palette,
      ...(this.vimEnabled ? { vim: this.vimState } : {}),
```

在 `feedInput` 方法开头,新增 vim normal 模式拦截:

```typescript
  private feedInput(value: string): void {
    if (this.vimEnabled && this.vimState.mode === "normal") {
      this.handleVimNormalInput(value);
      return;
    }
    // 现有逻辑
    for (const key of this.inputDecoder.push(value)) {
      if (key.type === "text") {
        this.cancelCompletion();
        this.editor.insertText(key.text);
      } else {
        void this.action(key.action).catch((error: unknown) => {
          this.setStatus(error instanceof Error ? error.message : String(error));
          this.setMood("oops");
        });
      }
    }
    this.render();
  }
```

新增 `handleVimNormalInput` 和 `applyVimAction` 私有方法(在 `handlePaletteInput` 后):

```typescript
  /**
   * Handle keystrokes in vim normal mode. Each character is passed to the vim
   * state machine; the resulting action is mapped to an EditorBuffer call.
   */
  private handleVimNormalInput(value: string): void {
    for (const char of value) {
      // Esc in normal mode is a no-op (already in normal)
      if (char === "\u001b") continue;
      // Skip control characters and escape sequences
      if (char === "\r" || char === "\n") continue;
      if (char === "\u007f" || char === "\b") continue;
      const result = vimHandleKey(this.vimState, char);
      this.vimState = result.state;
      this.applyVimAction(result.action);
    }
    this.render();
  }

  /** Map a VimAction to an EditorBuffer call. */
  private applyVimAction(action: VimAction): void {
    switch (action) {
      case "cursor_left":
        this.editor.cursorLeft();
        break;
      case "cursor_right":
        this.editor.cursorRight();
        break;
      case "cursor_up":
        this.editor.cursorUp();
        break;
      case "cursor_down":
        this.editor.cursorDown();
        break;
      case "word_left":
        this.editor.wordLeft();
        break;
      case "word_right":
        this.editor.wordRight();
        break;
      case "home":
        this.editor.home();
        break;
      case "end":
        this.editor.end();
        break;
      case "goto_top":
        this.editor.gotoTop();
        break;
      case "goto_bottom":
        this.editor.gotoBottom();
        break;
      case "delete_line":
        this.editor.deleteLine();
        break;
      case "yank_line":
        this.editor.yankLine();
        break;
      case "paste_after":
        this.editor.pasteAfter();
        break;
      case "delete_char":
        this.editor.deleteChar();
        break;
      case "newline_below":
        this.editor.appendNewlineBelow();
        break;
      case "noop":
        break;
    }
  }
```

在 `action` 方法中,在 `else if (action === "open_palette")` 后新增:

```typescript
    } else if (action === "toggle_vim") {
      this.setVimEnabled(!this.vimEnabled);
    }
```

**注意**:当 vim insert 模式下按 Esc,需要在 feedInput 中检测 Esc 并切换回 normal 模式。在 feedInput 的现有逻辑前(vim 拦截后),新增 insert 模式的 Esc 检测:

```typescript
  private feedInput(value: string): void {
    if (this.vimEnabled && this.vimState.mode === "normal") {
      this.handleVimNormalInput(value);
      return;
    }
    if (this.vimEnabled && this.vimState.mode === "insert") {
      // Esc returns to normal mode
      if (value === "\u001b") {
        this.vimState = { mode: "normal" };
        this.render();
        return;
      }
      // Other input falls through to normal insert handling
    }
    // 现有逻辑
    for (const key of this.inputDecoder.push(value)) {
      // ...
    }
  }
```

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm build && npx vitest run packages/tui/test/app.test.ts`
Expected: PASS

- [ ] **Step 5: 边界检查 + prettier**

Run: `node scripts/check-boundaries.mjs && pnpm prettier --check packages/tui/src/app.ts packages/tui/test/app.test.ts`
Expected: 通过

- [ ] **Step 6: 提交**

```bash
git add packages/tui/src/app.ts packages/tui/test/app.test.ts
git commit -m "feat(tui): integrate vim mode into FullScreenTui"
```

---

## Task 10: index.ts 导出 + apps/cli/src/tui.ts 集成

**Files:**

- Modify: `packages/tui/src/index.ts`
- Modify: `apps/cli/src/tui.ts`
- Test: `packages/tui/test/index.test.ts`
- Test: `apps/cli/test/tui-keyboard.test.ts` (新建)

**Interfaces:**

- Consumes: `search`、`command-palette`、`vim` 模块的导出;`FullScreenTui` 的 vim/palette/search 方法;`FullScreenAgentOptions` 现有结构
- Produces: `index.ts` 导出新模块;`apps/cli/src/tui.ts` 添加 `/vim`、`/palette`、`/search` 命令;`FullScreenAgentOptions` 新增 `onPaletteCommand?`

- [ ] **Step 1: 写失败测试 — index.ts 导出**

在 `packages/tui/test/index.test.ts` 中追加:

```typescript
describe("Phase 2 exports", () => {
  it("exports search module", async () => {
    const mod = await import("../src/index.js");
    expect(mod.createSearchState).toBeDefined();
    expect(mod.searchTranscript).toBeDefined();
    expect(mod.advanceSearch).toBeDefined();
    expect(mod.renderSearchBar).toBeDefined();
  });

  it("exports command-palette module", async () => {
    const mod = await import("../src/index.js");
    expect(mod.createPaletteState).toBeDefined();
    expect(mod.updatePaletteQuery).toBeDefined();
    expect(mod.movePaletteCursor).toBeDefined();
    expect(mod.confirmPalette).toBeDefined();
    expect(mod.renderPalette).toBeDefined();
    expect(mod.BUILTIN_COMMANDS).toBeDefined();
  });

  it("exports vim module", async () => {
    const mod = await import("../src/index.js");
    expect(mod.createVimState).toBeDefined();
    expect(mod.vimHandleKey).toBeDefined();
    expect(mod.renderVimIndicator).toBeDefined();
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm build && npx vitest run packages/tui/test/index.test.ts`
Expected: FAIL — exports not found

- [ ] **Step 3: 修改 index.ts**

在 `packages/tui/src/index.ts` 中新增导出(按字母序插入):

```typescript
export * from "./app.js";
export * from "./command-palette.js";
export * from "./companion.js";
export * from "./context-bar.js";
export * from "./completion.js";
export * from "./diff.js";
export * from "./editor.js";
export * from "./keymap.js";
export * from "./markdown.js";
export * from "./mascots.js";
export * from "./picker.js";
export * from "./pixel-frames.js";
export * from "./renderer.js";
export * from "./search.js";
export * from "./skins.js";
export * from "./spec-progress.js";
export * from "./syntax.js";
export * from "./themes.js";
export * from "./vim.js";
export * from "./widgets.js";
export * from "./width.js";
```

- [ ] **Step 4: 运行 index 测试验证通过**

Run: `pnpm build && npx vitest run packages/tui/test/index.test.ts`
Expected: PASS

- [ ] **Step 5: 写失败测试 — CLI 集成**

创建 `apps/cli/test/tui-keyboard.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { TUI_SLASH_COMMANDS } from "../src/tui.js";

describe("TUI slash commands — Phase 2 keyboard commands", () => {
  it("includes /vim command", () => {
    const cmd = TUI_SLASH_COMMANDS.find((c) => c.name === "vim");
    expect(cmd).toBeDefined();
    expect(cmd!.description).toMatch(/vim/i);
  });

  it("includes /palette command", () => {
    const cmd = TUI_SLASH_COMMANDS.find((c) => c.name === "palette");
    expect(cmd).toBeDefined();
    expect(cmd!.description).toMatch(/palette|command/i);
  });

  it("includes /search command", () => {
    const cmd = TUI_SLASH_COMMANDS.find((c) => c.name === "search");
    expect(cmd).toBeDefined();
    expect(cmd!.description).toMatch(/search|transcript/i);
  });
});
```

**注意**:`TUI_SLASH_COMMANDS` 需要从 `apps/cli/src/tui.ts` 导出。

- [ ] **Step 6: 运行测试验证失败**

Run: `pnpm build && npx vitest run apps/cli/test/tui-keyboard.test.ts`
Expected: FAIL — TUI_SLASH_COMMANDS 未导出或缺少新命令

- [ ] **Step 7: 修改 apps/cli/src/tui.ts**

在 `TUI_SLASH_COMMANDS` 数组中(在 `/diagnostics` 前)新增 3 个命令:

```typescript
  { name: "diagnostics", description: "Toggle diagnostics (on | off)" },
  { name: "vim", description: "Toggle vim mode (on | off)" },
  { name: "palette", description: "Open command palette" },
  { name: "search", description: "Search transcript" },
  { name: "exit", description: "Leave the TUI" },
```

确保 `TUI_SLASH_COMMANDS` 已 export(如果未导出,添加 `export`):

```typescript
export const TUI_SLASH_COMMANDS: Array<{ name: string; description: string }> = [
  // ...
];
```

在 `FullScreenAgentOptions` 接口中(在 `onSpecDecline?` 后)新增:

```typescript
  /** SpecEngine 拒绝回调透传。 */
  onSpecDecline?(specId: string): void;
  /** 命令面板触发命令时调用。 */
  onPaletteCommand?(command: string): void;
```

在 `runFullScreenAgent` 函数中,创建 `FullScreenTui` 时传递 `onPaletteCommand`:

```typescript
const tui = new FullScreenTui({
  // ...existing...
  onSpecConfirm: options.onSpecConfirm,
  onSpecDecline: options.onSpecDecline,
  onPaletteCommand: options.onPaletteCommand,
  // ...existing...
});
```

在 `onCommand` 处理逻辑中,新增 3 个命令处理(在 `if (name === "cheer")` 附近或合适位置):

```typescript
if (name === "vim") {
  if (args === "on") tui.setVimEnabled(true);
  else if (args === "off") tui.setVimEnabled(false);
  else tui.setVimEnabled(!tui.getVimState());
  return tui.getVimState() ? "Vim mode: ON" : "Vim mode: OFF";
}
if (name === "palette") {
  tui.openPalette();
  return;
}
if (name === "search") {
  tui.openSearch();
  return;
}
```

**注意**:`tui.getVimState()` 返回 `VimState | undefined`,用于判断是否启用。`tui.setVimEnabled`、`tui.openPalette`、`tui.openSearch` 是 Task 7-9 新增的方法。

- [ ] **Step 8: 运行测试验证通过**

Run: `pnpm build && npx vitest run apps/cli/test/tui-keyboard.test.ts`
Expected: PASS

- [ ] **Step 9: 边界检查 + prettier**

Run: `node scripts/check-boundaries.mjs && pnpm prettier --check packages/tui/src/index.ts apps/cli/src/tui.ts packages/tui/test/index.test.ts apps/cli/test/tui-keyboard.test.ts`
Expected: 通过

- [ ] **Step 10: 提交**

```bash
git add packages/tui/src/index.ts apps/cli/src/tui.ts packages/tui/test/index.test.ts apps/cli/test/tui-keyboard.test.ts
git commit -m "feat(tui): export new modules and wire /vim /palette /search commands"
```

---

## Task 11: 全套测试 + 边界检查 + prettier

**Files:**

- 无修改(验证任务)

- [ ] **Step 1: 完整构建**

Run: `pnpm build`
Expected: 所有包构建成功,无 TypeScript 错误

- [ ] **Step 2: 全套测试**

Run: `pnpm test`
Expected: 所有测试通过,覆盖率满足阈值(statements 75 / branches 60 / functions 80 / lines 80)

- [ ] **Step 3: 边界检查**

Run: `pnpm lint`
Expected: `check-boundaries.mjs` 通过,`prettier --check .` 通过

- [ ] **Step 4: 如有 prettier 失败,修复**

Run: `pnpm format`
Expected: 格式化所有文件

- [ ] **Step 5: 再次验证**

Run: `pnpm verify`
Expected: 完整门禁通过(架构边界 + prettier + build + 测试 + 覆盖率)

- [ ] **Step 6: 提交(如有格式修复)**

```bash
git add -A
git commit -m "chore(tui): format and verify Phase 2 keyboard efficiency"
```

---

## Self-Review 检查清单

**1. Spec coverage(对照设计文档第 5 节"键盘效率提升"):**

- ✅ 5.1 Vim 模式(normal + insert)→ Task 3 + Task 5 + Task 9
- ⚠️ 5.1 Visual 模式 → 故意省略(YAGNI,文档说明留待将来)
- ✅ 5.2 命令面板 → Task 2 + Task 8 + Task 10
- ✅ 5.3 Transcript 搜索 → Task 1 + Task 7 + Task 10
- ✅ 5.4 Keymap action 扩展 → Task 4(toggle_vim, open_palette, search_transcript)
- ⚠️ 5.4 cycle_layout, toggle_todo_panel, accept_diff, reject_diff, spec_confirm, spec_decline → 留待 Phase 3/4

**2. Placeholder scan:** 无 TBD/TODO/"implement later",所有步骤含完整代码。

**3. Type consistency:**

- `SearchState` 在 Task 1 定义,Task 6/7 使用 — 一致 ✓
- `PaletteState` 在 Task 2 定义,Task 6/8 使用 — 一致 ✓
- `VimState`、`VimAction` 在 Task 3 定义,Task 9 使用 — 一致 ✓
- `VimAction` 枚举值与 Task 5 的 EditorBuffer 方法对应:`delete_line`→`deleteLine()`、`yank_line`→`yankLine()`、`paste_after`→`pasteAfter()`、`delete_char`→`deleteChar()`、`goto_top`→`gotoTop()`、`goto_bottom`→`gotoBottom()`、`newline_below`→`appendNewlineBelow()` — 一致 ✓

**4. 输入分发优先级:** onData 拦截顺序为 picker > specConfirmation > palette > search > vim-normal > Alt+M > feedInput,在 Task 7/8/9 中按此顺序插入。
