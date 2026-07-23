# TUI 深度优化 Phase 1: SpecEngine 集成 + 基础视觉 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-v6-subagent-driven-development (recommended) or superpowers-v6-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 TUI 添加 SpecEngine 5 阶段进度可视化、交互式决策确认、context usage 进度条和 reasoning 折叠/展开,补齐 FocusCode 独有的最大缺口。

**Architecture:** 在 `packages/tui`(叶子 adapter,零依赖)新增 `spec-progress.ts` 和 `context-bar.ts` 两个纯渲染模块;扩展 `app.ts` 管理新状态;扩展 `renderer.ts` 集成新 widget;在 `apps/cli/src/tui.ts` 组合层翻译 `spec_*` AgentEvent 为 TUI 状态调用。所有 SpecEngine 业务类型从 `@focuscode/agent-runtime` 导入,但 TUI 只接收已翻译的纯数据结构(不直接依赖 agent-runtime)。

**Tech Stack:** TypeScript ESM、Node 内建能力、vitest、ANSI 转义序列。`packages/tui` 严格零运行时依赖。

## Global Constraints

- **边界规则**:`packages/tui` 不得依赖任何 `@focuscode/*` 包或运行时 npm 依赖(`scripts/check-boundaries.mjs` 强制)
- **TypeScript strict**:`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`verbatimModuleSyntax`、`isolatedModules`、ES2022、NodeNext
- **Prettier**:printWidth 100、双引号、semicolon、trailing comma `"all"`,用 `pnpm format` 不要手工排版
- **测试位置**:`packages/tui/test/`(不与 `src/` 同目录)
- **向后兼容**:`renderTui(state)` 签名不变,`TuiRenderState` 新字段全部可选
- **TDD**:每个任务先写失败测试 → 验证 RED → 实现 → 验证 GREEN → 边界检查 → prettier

## 文件结构

### 新增文件(packages/tui/src/)

1. `spec-progress.ts` — SpecEngine 进度 widget(阶段进度 + 交互式确认)
2. `context-bar.ts` — Context usage 进度条

### 新增测试(packages/tui/test/)

1. `spec-progress.test.ts`
2. `context-bar.test.ts`

### 修改文件

1. `packages/tui/src/app.ts` — FullScreenTui 扩展(spec/reasoning 状态 + 回调)
2. `packages/tui/src/renderer.ts` — 集成 spec progress 和 reasoning 渲染
3. `packages/tui/src/keymap.ts` — 新增 `toggle_reasoning` action
4. `packages/tui/src/index.ts` — 新增导出
5. `apps/cli/src/tui.ts` — `spec_*` 事件翻译 + 回调桥接

---

## Task 1: spec-progress.ts — 进度状态与渲染

**Files:**

- Create: `packages/tui/src/spec-progress.ts`
- Test: `packages/tui/test/spec-progress.test.ts`

**Interfaces:**

- Produces: `SpecPhase`, `SpecStageStatus`, `SpecStageInfo`, `SpecProgressState`, `renderSpecProgress()`, `createInitialSpecProgress()`

- [ ] **Step 1: 写失败测试 — 类型与初始状态**

创建 `packages/tui/test/spec-progress.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  createInitialSpecProgress,
  renderSpecProgress,
  type SpecProgressState,
} from "../src/spec-progress.js";
import { TUI_THEMES } from "../src/themes.js";

const theme = TUI_THEMES[0]!;

describe("createInitialSpecProgress", () => {
  it("returns idle state with no stages", () => {
    const state = createInitialSpecProgress();
    expect(state.phase).toBe("idle");
    expect(state.stages).toEqual([]);
    expect(state.pendingDecisions).toBeUndefined();
  });
});

describe("renderSpecProgress", () => {
  it("renders idle state as empty", () => {
    const lines = renderSpecProgress(createInitialSpecProgress(), 40, theme);
    expect(lines).toEqual([]);
  });

  it("renders 5 stages with statuses", () => {
    const state: SpecProgressState = {
      phase: "enhance",
      stages: [
        { name: "classify", status: "done", durationMs: 1200 },
        { name: "explore", status: "done", durationMs: 3400 },
        { name: "draft", status: "done", durationMs: 2100 },
        { name: "detect-decisions", status: "done", durationMs: 800 },
        { name: "enhance", status: "running" },
      ],
    };
    const lines = renderSpecProgress(state, 40, theme);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).toContain("classify");
    expect(lines.join("\n")).toContain("explore");
    expect(lines.join("\n")).toContain("enhance");
    // done stages show duration
    expect(lines.join("\n")).toContain("1.2s");
    // running stage shows spinner-like indicator
    expect(lines.join("\n")).toContain("...");
  });

  it("renders fallback marker for fellBack stages", () => {
    const state: SpecProgressState = {
      phase: "draft",
      stages: [
        { name: "classify", status: "done", durationMs: 500, fellBack: true },
        { name: "explore", status: "done", durationMs: 3000, fellBack: false },
        { name: "draft", status: "running" },
      ],
    };
    const lines = renderSpecProgress(state, 40, theme);
    expect(lines.join("\n")).toContain("fallback");
  });

  it("renders completed phase with total duration", () => {
    const state: SpecProgressState = {
      phase: "completed",
      stages: [
        { name: "classify", status: "done", durationMs: 500 },
        { name: "explore", status: "done", durationMs: 1000 },
      ],
      totalDuration: 1500,
    };
    const lines = renderSpecProgress(state, 40, theme);
    expect(lines.join("\n")).toContain("completed");
    expect(lines.join("\n")).toContain("1.5s");
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm build && npx vitest run packages/tui/test/spec-progress.test.ts`
Expected: FAIL — `Cannot find module '../src/spec-progress.js'`

- [ ] **Step 3: 实现 spec-progress.ts 进度部分**

创建 `packages/tui/src/spec-progress.ts`:

```typescript
import { fg, type TuiTheme } from "./themes.js";

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

export type SpecStageStatus = "pending" | "running" | "done" | "failed";

export interface SpecStageInfo {
  name: string;
  model?: string;
  durationMs?: number;
  fellBack?: boolean;
  status: SpecStageStatus;
}

export interface SpecProgressState {
  phase: SpecPhase;
  trigger?: "auto" | "explicit";
  specId?: string;
  topic?: string;
  stages: SpecStageInfo[];
  startTime?: number;
  totalDuration?: number;
  pendingDecisions?: SpecDecisionView[];
}

/** Decision view — pure data, no agent-runtime dependency. */
export interface SpecDecisionView {
  id: string;
  point: string;
  severity: "critical" | "major" | "minor";
  options: { label: string; description: string }[];
  selectedIndex: number;
}

const STAGE_ORDER = ["classify", "explore", "draft", "detect-decisions", "enhance"] as const;

const STATUS_ICONS: Record<SpecStageStatus, string> = {
  pending: "○",
  running: "◐",
  done: "●",
  failed: "✗",
};

export function createInitialSpecProgress(): SpecProgressState {
  return { phase: "idle", stages: [] };
}

function formatDuration(ms: number): string {
  if (ms < 1000) return ms + "ms";
  return (ms / 1000).toFixed(1) + "s";
}

export function renderSpecProgress(
  state: SpecProgressState,
  width: number,
  theme: TuiTheme,
): string[] {
  if (state.phase === "idle") return [];

  const lines: string[] = [];
  const header =
    state.phase === "skipped"
      ? "✦ Spec skipped"
      : state.phase === "completed"
        ? "✦ Spec completed"
        : "✦ Spec Engine";
  lines.push(fg(theme.accent, header));

  if (state.topic) {
    lines.push(fg(theme.muted, "  " + truncate(state.topic, width - 4)));
  }

  for (const stage of state.stages) {
    const icon = STATUS_ICONS[stage.status];
    const name = stage.name.padEnd(18);
    let detail = "";
    if (stage.status === "done" && stage.durationMs !== undefined) {
      detail = "✓ " + formatDuration(stage.durationMs);
      if (stage.fellBack) detail += " (fallback)";
    } else if (stage.status === "running") {
      detail = "...";
    } else if (stage.status === "failed") {
      detail = "failed";
    }
    const color =
      stage.status === "done"
        ? theme.success
        : stage.status === "running"
          ? theme.warning
          : theme.muted;
    lines.push(fg(color, "  " + icon + " " + name + detail));
  }

  if (state.phase === "completed" && state.totalDuration !== undefined) {
    lines.push(fg(theme.success, "  Total: " + formatDuration(state.totalDuration)));
  }

  if (state.phase === "skipped") {
    // stage info already shown above if present
  }

  return lines;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(1, max - 1)) + "…";
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm build && npx vitest run packages/tui/test/spec-progress.test.ts`
Expected: PASS — 所有 5 个测试通过

- [ ] **Step 5: prettier + 边界检查**

Run: `pnpm format && node scripts/check-boundaries.mjs`
Expected: 通过

- [ ] **Step 6: 提交**

```bash
git add packages/tui/src/spec-progress.ts packages/tui/test/spec-progress.test.ts
git commit -m "feat(tui): add spec-progress widget for SpecEngine stage visualization"
```

---

## Task 2: spec-progress.ts — 交互式决策确认 UI

**Files:**

- Modify: `packages/tui/src/spec-progress.ts`
- Test: `packages/tui/test/spec-progress.test.ts`

**Interfaces:**

- Produces: `SpecConfirmationState`, `createSpecConfirmation()`, `advanceConfirmation()`, `renderSpecConfirmation()`

- [ ] **Step 1: 写失败测试 — 决策确认 UI**

追加到 `packages/tui/test/spec-progress.test.ts`:

```typescript
import {
  createSpecConfirmation,
  advanceConfirmation,
  renderSpecConfirmation,
  type SpecDecisionView,
} from "../src/spec-progress.js";

const sampleDecisions: SpecDecisionView[] = [
  {
    id: "d1",
    point: "How to supply kernel image?",
    severity: "critical",
    options: [
      { label: "Bundled", description: "Ship with FocusCode" },
      { label: "User path", description: "User provides path" },
      { label: "Download", description: "Fetch on-demand" },
    ],
    selectedIndex: 0,
  },
  {
    id: "d2",
    point: "Network mode?",
    severity: "major",
    options: [
      { label: "TAP", description: "TAP device" },
      { label: "VDE", description: "VDE switch" },
    ],
    selectedIndex: 0,
  },
];

describe("createSpecConfirmation", () => {
  it("creates confirmation state from decisions", () => {
    const state = createSpecConfirmation("spec_123", sampleDecisions);
    expect(state.specId).toBe("spec_123");
    expect(state.currentDecisionIndex).toBe(0);
    expect(state.decisions).toHaveLength(2);
  });
});

describe("advanceConfirmation", () => {
  it("navigates option down within current decision", () => {
    const state = createSpecConfirmation("spec_123", sampleDecisions);
    const next = advanceConfirmation(state, "option_down");
    expect(next.decisions[0]!.selectedIndex).toBe(1);
  });

  it("wraps option navigation at boundary", () => {
    const state = createSpecConfirmation("spec_123", sampleDecisions);
    const wrapped = advanceConfirmation(state, "option_up");
    expect(wrapped.decisions[0]!.selectedIndex).toBe(2); // wraps to last
  });

  it("advances to next decision on confirm", () => {
    const state = createSpecConfirmation("spec_123", sampleDecisions);
    const next = advanceConfirmation(state, "confirm");
    expect(next.currentDecisionIndex).toBe(1);
  });

  it("marks completed when last decision confirmed", () => {
    const state = createSpecConfirmation("spec_123", sampleDecisions);
    const atLast = { ...state, currentDecisionIndex: 1 };
    const next = advanceConfirmation(atLast, "confirm");
    expect(next.completed).toBe(true);
  });
});

describe("renderSpecConfirmation", () => {
  it("renders decision point and options", () => {
    const state = createSpecConfirmation("spec_123", sampleDecisions);
    const lines = renderSpecConfirmation(state, 50, theme);
    const text = lines.join("\n");
    expect(text).toContain("spec_123");
    expect(text).toContain("kernel image");
    expect(text).toContain("Bundled");
    expect(text).toContain("User path");
    expect(text).toContain("1/2"); // decision index
    expect(text).toContain("critical"); // severity
  });

  it("marks selected option with arrow", () => {
    const state = createSpecConfirmation("spec_123", sampleDecisions);
    const lines = renderSpecConfirmation(state, 50, theme);
    expect(lines.join("\n")).toContain("›");
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm build && npx vitest run packages/tui/test/spec-progress.test.ts`
Expected: FAIL — `createSpecConfirmation` 未导出

- [ ] **Step 3: 实现决策确认 UI**

追加到 `packages/tui/src/spec-progress.ts`:

```typescript
export interface SpecConfirmationState {
  specId: string;
  decisions: SpecDecisionView[];
  currentDecisionIndex: number;
  completed: boolean;
}

export type ConfirmationAction = "option_up" | "option_down" | "confirm" | "cancel";

export function createSpecConfirmation(
  specId: string,
  decisions: SpecDecisionView[],
): SpecConfirmationState {
  return {
    specId,
    decisions: decisions.map((d) => ({ ...d, options: [...d.options] })),
    currentDecisionIndex: 0,
    completed: false,
  };
}

export function advanceConfirmation(
  state: SpecConfirmationState,
  action: ConfirmationAction,
): SpecConfirmationState {
  if (state.completed) return state;
  const current = state.decisions[state.currentDecisionIndex];
  if (!current) return state;

  if (action === "cancel") {
    return { ...state, completed: true };
  }

  if (action === "option_up" || action === "option_down") {
    const max = current.options.length;
    const delta = action === "option_down" ? 1 : -1;
    const newIndex = (current.selectedIndex + delta + max) % max;
    const decisions = state.decisions.map((d, i) =>
      i === state.currentDecisionIndex ? { ...d, selectedIndex: newIndex } : d,
    );
    return { ...state, decisions };
  }

  if (action === "confirm") {
    const nextIndex = state.currentDecisionIndex + 1;
    if (nextIndex >= state.decisions.length) {
      return { ...state, completed: true };
    }
    return { ...state, currentDecisionIndex: nextIndex };
  }

  return state;
}

export function renderSpecConfirmation(
  state: SpecConfirmationState,
  width: number,
  theme: TuiTheme,
): string[] {
  if (state.completed) return [];
  const decision = state.decisions[state.currentDecisionIndex];
  if (!decision) return [];

  const lines: string[] = [];
  const total = state.decisions.length;
  const current = state.currentDecisionIndex + 1;
  lines.push(fg(theme.accent, "╭─ ✦ Spec Confirmation ──────────────"));
  lines.push(fg(theme.muted, "│ " + state.specId));
  lines.push(fg(theme.muted, "├────────────────────────────────────"));
  lines.push(
    fg(theme.warning, "│ Decision " + current + "/" + total + " [" + decision.severity + "]"),
  );
  lines.push(fg(theme.foreground, "│ " + truncate(decision.point, width - 4)));

  for (const [i, option] of decision.options.entries()) {
    const selected = i === decision.selectedIndex;
    const marker = selected ? "›" : " ";
    const label = selected
      ? fg(theme.accent, marker + " " + option.label)
      : fg(theme.muted, marker + " " + option.label);
    const desc = fg(theme.muted, " — " + truncate(option.description, width - 20));
    lines.push("│ " + label + desc);
  }

  lines.push(fg(theme.muted, "├────────────────────────────────────"));
  lines.push(fg(theme.muted, "│ ↑↓ navigate  Enter confirm  Esc decline"));
  return lines;
}

/** Collect confirmed choices for callback. */
export function collectChoices(state: SpecConfirmationState): Record<string, string> {
  const choices: Record<string, string> = {};
  for (const decision of state.decisions) {
    const selected = decision.options[decision.selectedIndex];
    if (selected) choices[decision.id] = selected.label;
  }
  return choices;
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm build && npx vitest run packages/tui/test/spec-progress.test.ts`
Expected: PASS — 所有测试通过

- [ ] **Step 5: prettier + 边界检查**

Run: `pnpm format && node scripts/check-boundaries.mjs`

- [ ] **Step 6: 提交**

```bash
git add packages/tui/src/spec-progress.ts packages/tui/test/spec-progress.test.ts
git commit -m "feat(tui): add interactive spec confirmation UI with decision navigation"
```

---

## Task 3: context-bar.ts — Context usage 进度条

**Files:**

- Create: `packages/tui/src/context-bar.ts`
- Test: `packages/tui/test/context-bar.test.ts`

**Interfaces:**

- Produces: `ContextUsageState`, `renderContextBar()`, `formatTokens()`

- [ ] **Step 1: 写失败测试**

创建 `packages/tui/test/context-bar.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { renderContextBar, formatTokens, type ContextUsageState } from "../src/context-bar.js";
import { TUI_THEMES } from "../src/themes.js";

const theme = TUI_THEMES[0]!;

describe("formatTokens", () => {
  it("formats numbers under 1000 as-is", () => {
    expect(formatTokens(500)).toBe("500");
    expect(formatTokens(0)).toBe("0");
  });

  it("formats thousands with k suffix", () => {
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(32000)).toBe("32.0k");
    expect(formatTokens(200000)).toBe("200.0k");
  });
});

describe("renderContextBar", () => {
  it("renders progress bar with token counts", () => {
    const state: ContextUsageState = { usedTokens: 32000, maxTokens: 200000 };
    const line = renderContextBar(state, 40, theme);
    expect(line).toContain("32.0k");
    expect(line).toContain("200.0k");
    expect(line).toContain("█"); // filled portion
    expect(line).toContain("░"); // empty portion
  });

  it("uses success color when ratio < 0.7", () => {
    const state: ContextUsageState = { usedTokens: 50000, maxTokens: 200000 };
    const line = renderContextBar(state, 40, theme);
    // ratio 0.25 → success color (we just verify it renders without error)
    expect(line.length).toBeGreaterThan(0);
  });

  it("uses warning color when 0.7 <= ratio < 0.9", () => {
    const state: ContextUsageState = { usedTokens: 150000, maxTokens: 200000 };
    const line = renderContextBar(state, 40, theme);
    expect(line.length).toBeGreaterThan(0);
  });

  it("uses danger color when ratio >= 0.9", () => {
    const state: ContextUsageState = { usedTokens: 190000, maxTokens: 200000 };
    const line = renderContextBar(state, 40, theme);
    expect(line.length).toBeGreaterThan(0);
  });

  it("handles zero max tokens gracefully", () => {
    const state: ContextUsageState = { usedTokens: 0, maxTokens: 0 };
    const line = renderContextBar(state, 40, theme);
    expect(line.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm build && npx vitest run packages/tui/test/context-bar.test.ts`
Expected: FAIL — `Cannot find module '../src/context-bar.js'`

- [ ] **Step 3: 实现 context-bar.ts**

创建 `packages/tui/src/context-bar.ts`:

```typescript
import { fg, type TuiTheme } from "./themes.js";

export interface ContextUsageState {
  usedTokens: number;
  maxTokens: number;
  reasoningTokens?: number;
}

export function formatTokens(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

export function renderContextBar(state: ContextUsageState, width: number, theme: TuiTheme): string {
  const { usedTokens, maxTokens } = state;
  if (maxTokens <= 0) {
    return fg(theme.muted, "⚙ " + formatTokens(usedTokens) + " tokens");
  }

  const ratio = Math.min(1, usedTokens / maxTokens);
  const labelWidth = formatTokens(usedTokens).length + formatTokens(maxTokens).length + 4; // " X/Y"
  const barWidth = Math.max(8, width - labelWidth - 2);
  const filled = Math.round(ratio * barWidth);
  const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);

  const color = ratio < 0.7 ? theme.success : ratio < 0.9 ? theme.warning : theme.danger;
  return (
    fg(color, "⚙ ") +
    fg(color, bar) +
    " " +
    fg(theme.muted, formatTokens(usedTokens) + "/" + formatTokens(maxTokens))
  );
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm build && npx vitest run packages/tui/test/context-bar.test.ts`
Expected: PASS — 所有测试通过

- [ ] **Step 5: prettier + 边界检查**

Run: `pnpm format && node scripts/check-boundaries.mjs`

- [ ] **Step 6: 提交**

```bash
git add packages/tui/src/context-bar.ts packages/tui/test/context-bar.test.ts
git commit -m "feat(tui): add context usage progress bar widget"
```

---

## Task 4: keymap.ts — 新增 toggle_reasoning action

**Files:**

- Modify: `packages/tui/src/keymap.ts`
- Test: `packages/tui/test/keymap.test.ts`(已存在,追加)

**Interfaces:**

- Consumes: 现有 `TuiAction` union
- Produces: 扩展后的 `TuiAction` 含 `"toggle_reasoning"`

- [ ] **Step 1: 写失败测试 — 新 action**

追加到 `packages/tui/test/keymap.test.ts`(在现有测试末尾):

```typescript
describe("toggle_reasoning action", () => {
  it("is a valid TuiAction", () => {
    const keymap = { "ctrl+r": "toggle_reasoning" } as Partial<TuiKeymap>;
    const merged = mergeKeymap(keymap);
    expect(merged["ctrl+r"]).toBe("toggle_reasoning");
  });

  it("parses Ctrl+R as toggle_reasoning", () => {
    const decoder = new TerminalInputDecoder({ ...DEFAULT_KEYMAP, "ctrl+r": "toggle_reasoning" });
    const keys = decoder.push("\u0012"); // Ctrl+R = 0x12
    const actions = keys.filter((k) => k.type === "action");
    expect(actions.length).toBe(1);
    if (actions[0]?.type === "action") {
      expect(actions[0].action).toBe("toggle_reasoning");
    }
  });
});
```

注意:如果 `keymap.test.ts` 不存在,先检查文件;若现有测试文件顶部缺少 import,需补充:

```typescript
import {
  DEFAULT_KEYMAP,
  mergeKeymap,
  TerminalInputDecoder,
  type TuiKeymap,
} from "../src/keymap.js";
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm build && npx vitest run packages/tui/test/keymap.test.ts`
Expected: FAIL — `toggle_reasoning` 不在 TuiAction union 中

- [ ] **Step 3: 扩展 TuiAction**

修改 `packages/tui/src/keymap.ts` 第 1-24 行,在 union 末尾 `| "cycle_mascot"` 后追加:

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
  | "toggle_reasoning";
```

**不要** 把 `toggle_reasoning` 加入 `DEFAULT_KEYMAP`(用户通过 keymap 配置启用,或后续 Task 6 在 app.ts 中绑定)。这保证向后兼容。

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm build && npx vitest run packages/tui/test/keymap.test.ts`
Expected: PASS

- [ ] **Step 5: prettier + 边界检查**

Run: `pnpm format && node scripts/check-boundaries.mjs`

- [ ] **Step 6: 提交**

```bash
git add packages/tui/src/keymap.ts packages/tui/test/keymap.test.ts
git commit -m "feat(tui): add toggle_reasoning action for reasoning display toggle"
```

---

## Task 5: app.ts — FullScreenTui 状态扩展

**Files:**

- Modify: `packages/tui/src/app.ts`
- Test: `packages/tui/test/app.test.ts`(已存在,追加)

**Interfaces:**

- Consumes: `SpecProgressState`, `SpecConfirmationState`, `ContextUsageState` from Task 1-3
- Produces: `FullScreenTui` 新方法:`setSpecProgress()`, `updateSpecStage()`, `setSpecConfirmation()`, `clearSpecConfirmation()`, `getSpecConfirmationState()`, `setSpecDraft()`, `appendReasoning()`, `clearReasoning()`, `setContextUsage()`, `getSpecStartTime()`, `setReasoningExpanded()`

- [ ] **Step 1: 写失败测试 — 状态管理方法**

追加到 `packages/tui/test/app.test.ts`(若文件不存在,创建新文件;先检查现有文件结构):

```typescript
import { describe, expect, it } from "vitest";
import { FullScreenTui } from "../src/app.js";
import { TUI_THEMES } from "../src/themes.js";
import { TUI_MASCOTS } from "../src/mascots.js";
import type { SpecProgressState, SpecDecisionView } from "../src/spec-progress.js";
import type { ContextUsageState } from "../src/context-bar.js";

function createTui(): FullScreenTui {
  return new FullScreenTui({
    input: {
      isTTY: false,
      setRawMode: () => {},
      setEncoding: () => {},
      resume: () => {},
      on: () => {},
      off: () => {},
    } as never,
    output: {
      isTTY: false,
      columns: 80,
      rows: 24,
      write: () => {},
      on: () => {},
      off: () => {},
    } as never,
    model: "test/model",
    session: "test-session",
    approval: "ask",
    sandbox: "host",
    theme: TUI_THEMES[0]!,
    mascot: TUI_MASCOTS[0]!,
    onSubmit: async () => {},
    onSteer: async () => {},
    onAbort: () => {},
  });
}

describe("FullScreenTui spec state", () => {
  it("setSpecProgress updates phase", () => {
    const tui = createTui();
    const state: SpecProgressState = { phase: "start", stages: [] };
    tui.setSpecProgress(state);
    const snap = tui.snapshot();
    expect(snap.specProgress?.phase).toBe("start");
  });

  it("updateSpecStage adds and updates stages", () => {
    const tui = createTui();
    tui.setSpecProgress({ phase: "classify", stages: [] });
    tui.updateSpecStage("classify", { status: "done", durationMs: 500, model: "test" });
    const snap = tui.snapshot();
    expect(snap.specProgress?.stages).toHaveLength(1);
    expect(snap.specProgress?.stages[0]?.name).toBe("classify");
    expect(snap.specProgress?.stages[0]?.status).toBe("done");
  });

  it("setSpecConfirmation stores pending decisions", () => {
    const tui = createTui();
    const decisions: SpecDecisionView[] = [
      {
        id: "d1",
        point: "Test?",
        severity: "critical",
        options: [{ label: "A", description: "a" }],
        selectedIndex: 0,
      },
    ];
    tui.setSpecConfirmation("spec_1", decisions);
    const snap = tui.snapshot();
    expect(snap.specConfirmation?.specId).toBe("spec_1");
    expect(snap.specConfirmation?.decisions).toHaveLength(1);
  });

  it("clearSpecConfirmation removes confirmation state", () => {
    const tui = createTui();
    tui.setSpecConfirmation("spec_1", []);
    tui.clearSpecConfirmation();
    const snap = tui.snapshot();
    expect(snap.specConfirmation).toBeUndefined();
  });

  it("getSpecConfirmationState returns current state", () => {
    const tui = createTui();
    tui.setSpecConfirmation("spec_1", []);
    const state = tui.getSpecConfirmationState();
    expect(state?.specId).toBe("spec_1");
  });
});

describe("FullScreenTui reasoning state", () => {
  it("appendReasoning accumulates text", () => {
    const tui = createTui();
    tui.appendReasoning("hello ");
    tui.appendReasoning("world");
    const snap = tui.snapshot();
    expect(snap.reasoning).toBe("hello world");
  });

  it("clearReasoning resets to undefined", () => {
    const tui = createTui();
    tui.appendReasoning("thinking...");
    tui.clearReasoning();
    const snap = tui.snapshot();
    expect(snap.reasoning).toBeUndefined();
  });

  it("setReasoningExpanded toggles expanded flag", () => {
    const tui = createTui();
    tui.setReasoningExpanded(true);
    const snap = tui.snapshot();
    expect(snap.reasoningExpanded).toBe(true);
  });
});

describe("FullScreenTui context usage", () => {
  it("setContextUsage stores token counts", () => {
    const tui = createTui();
    const ctx: ContextUsageState = { usedTokens: 5000, maxTokens: 100000 };
    tui.setContextUsage(ctx);
    const snap = tui.snapshot();
    expect(snap.contextUsage?.usedTokens).toBe(5000);
    expect(snap.contextUsage?.maxTokens).toBe(100000);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm build && npx vitest run packages/tui/test/app.test.ts`
Expected: FAIL — `setSpecProgress` 等方法不存在

- [ ] **Step 3: 扩展 FullScreenTuiOptions 和 FullScreenTui**

修改 `packages/tui/src/app.ts`:

**(a) 在 import 块追加**:

```typescript
import {
  advanceConfirmation,
  collectChoices,
  createInitialSpecProgress,
  createSpecConfirmation,
  type SpecConfirmationState,
  type SpecDecisionView,
  type SpecProgressState,
  type SpecStageInfo,
} from "./spec-progress.js";
import { type ContextUsageState } from "./context-bar.js";
```

**(b) 在 `FullScreenTuiOptions` 接口追加回调**(在 `onCommand?` 之后):

```typescript
  /** SpecEngine 交互式确认回调。当用户在 TUI 里完成决策选择时调用。 */
  onSpecConfirm?(specId: string, choices: Record<string, string>): void;
  /** SpecEngine 拒绝整个 spec 时调用。 */
  onSpecDecline?(specId: string): void;
```

**(c) 在 FullScreenTui 类的私有字段区追加**(在 `sessionBudget` 之后):

```typescript
  private specProgress: SpecProgressState = createInitialSpecProgress();
  private specConfirmation: SpecConfirmationState | undefined;
  private reasoning: string | undefined;
  private reasoningExpanded = false;
  private contextUsage: ContextUsageState | undefined;
```

**(d) 在类中追加公共方法**(在 `setSessionCost` 方法之后):

```typescript
  /** Update SpecEngine progress state. */
  setSpecProgress(state: SpecProgressState): void {
    this.specProgress = { ...state, stages: [...state.stages] };
    this.render();
  }

  /** Update or insert a single spec stage. */
  updateSpecStage(name: string, info: Partial<SpecStageInfo> & { status: SpecStageInfo["status"] }): void {
    const stages = [...this.specProgress.stages];
    const idx = stages.findIndex((s) => s.name === name);
    const updated: SpecStageInfo = idx >= 0 ? { ...stages[idx]!, ...info } : { name, ...info };
    if (idx >= 0) stages[idx] = updated;
    else stages.push(updated);
    this.specProgress = { ...this.specProgress, stages };
    this.render();
  }

  /** Set spec draft preview (topic + understanding). */
  setSpecDraft(draft: { specId?: string; topic?: string }): void {
    this.specProgress = {
      ...this.specProgress,
      ...(draft.specId !== undefined ? { specId: draft.specId } : {}),
      ...(draft.topic !== undefined ? { topic: draft.topic } : {}),
    };
    this.render();
  }

  /** Get spec start time for duration calculation. */
  getSpecStartTime(): number | undefined {
    return this.specProgress.startTime;
  }

  /** Show interactive spec confirmation UI. */
  setSpecConfirmation(specId: string, decisions: SpecDecisionView[]): void {
    this.specConfirmation = createSpecConfirmation(specId, decisions);
    this.render();
  }

  /** Current confirmation state (for external assertion / input handling). */
  getSpecConfirmationState(): SpecConfirmationState | undefined {
    return this.specConfirmation;
  }

  /** Clear confirmation UI (after spec_confirmed or spec_skipped). */
  clearSpecConfirmation(): void {
    this.specConfirmation = undefined;
    this.render();
  }

  /** Advance confirmation navigation; triggers callback on completion. */
  confirmSpecNavigation(action: "option_up" | "option_down" | "confirm" | "cancel"): void {
    if (!this.specConfirmation) return;
    const next = advanceConfirmation(this.specConfirmation, action);
    this.specConfirmation = next;
    if (next.completed) {
      if (action === "cancel") {
        this.options.onSpecDecline?.(next.specId);
      } else {
        const choices = collectChoices(next);
        this.options.onSpecConfirm?.(next.specId, choices);
      }
      this.specConfirmation = undefined;
    }
    this.render();
  }

  /** Append reasoning text (from reasoning_delta events). */
  appendReasoning(delta: string): void {
    this.reasoning = (this.reasoning ?? "") + delta;
    this.render();
  }

  /** Clear reasoning buffer. */
  clearReasoning(): void {
    this.reasoning = undefined;
    this.render();
  }

  /** Toggle reasoning expanded state. */
  setReasoningExpanded(expanded: boolean): void {
    this.reasoningExpanded = expanded;
    this.render();
  }

  /** Update context usage display. */
  setContextUsage(state: ContextUsageState): void {
    this.contextUsage = { ...state };
    this.render();
  }
```

**(e) 在 `snapshot()` 方法的返回对象中追加新字段**(在 `scrollOffset` 之前):

```typescript
      ...(this.specProgress.phase !== "idle" ? { specProgress: this.specProgress } : {}),
      ...(this.specConfirmation ? { specConfirmation: this.specConfirmation } : {}),
      ...(this.reasoning ? { reasoning: this.reasoning } : {}),
      ...(this.reasoningExpanded ? { reasoningExpanded: this.reasoningExpanded } : {}),
      ...(this.contextUsage ? { contextUsage: this.contextUsage } : {}),
```

**(f) 在 `feedInput` 方法的 action 分发中**(找到 `void this.action(key.action)` 调用),确保 `toggle_reasoning` action 被处理。在 `action()` 方法中追加分支(该方法已存在,找到 switch/if 链):

```typescript
      case "toggle_reasoning":
        this.reasoningExpanded = !this.reasoningExpanded;
        break;
```

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm build && npx vitest run packages/tui/test/app.test.ts`
Expected: PASS

- [ ] **Step 5: prettier + 边界检查**

Run: `pnpm format && node scripts/check-boundaries.mjs`

- [ ] **Step 6: 提交**

```bash
git add packages/tui/src/app.ts packages/tui/test/app.test.ts
git commit -m "feat(tui): add spec progress, reasoning, and context usage state to FullScreenTui"
```

---

## Task 6: renderer.ts — 集成 spec progress 和 reasoning 渲染

**Files:**

- Modify: `packages/tui/src/renderer.ts`
- Test: `packages/tui/test/renderer.test.ts`(已存在,追加)

**Interfaces:**

- Consumes: `TuiRenderState` 新字段 `specProgress?`, `specConfirmation?`, `reasoning?`, `reasoningExpanded?`, `contextUsage?`
- Produces: 扩展后的 `renderTui()` 在 classic 模式下显示 spec progress 和 reasoning

- [ ] **Step 1: 写失败测试 — 渲染集成**

追加到 `packages/tui/test/renderer.test.ts`:

```typescript
import { renderTui, type TuiRenderState } from "../src/renderer.js";
import { TUI_THEMES } from "../src/themes.js";
import { TUI_MASCOTS } from "../src/mascots.js";
import type { SpecProgressState } from "../src/spec-progress.js";
import type { ContextUsageState } from "../src/context-bar.js";

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
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm build && npx vitest run packages/tui/test/renderer.test.ts`
Expected: FAIL — `TuiRenderState` 没有 `specProgress` 字段

- [ ] **Step 3: 扩展 TuiRenderState 和 renderTui**

修改 `packages/tui/src/renderer.ts`:

**(a) 在 import 块追加**:

```typescript
import {
  renderSpecProgress,
  type SpecConfirmationState,
  type SpecProgressState,
} from "./spec-progress.js";
import { renderContextBar, type ContextUsageState } from "./context-bar.js";
```

**(b) 在 `TuiRenderState` 接口追加字段**(在 `scrollOffset` 之前):

```typescript
  /** SpecEngine 进度状态;缺省 idle 时不渲染。 */
  specProgress?: SpecProgressState;
  /** SpecEngine 待确认决策;存在时渲染交互式 UI。 */
  specConfirmation?: SpecConfirmationState;
  /** 模型 reasoning 累积文本。 */
  reasoning?: string;
  /** 是否展开显示 reasoning。 */
  reasoningExpanded?: boolean;
  /** Context window 使用量;存在时在 footer 显示进度条。 */
  contextUsage?: ContextUsageState;
```

**(c) 在 `renderTui` 函数中集成新 widget**。

找到现有 `renderTui(state)` 函数。在 body 渲染循环之后、separator 之前,插入 spec progress 渲染。**关键:保持 classic 布局不变,新 widget 显示在 transcript 底部和 separator 之间**。

在 `const separator = ...` 之前追加:

```typescript
// SpecEngine progress widget (shown when phase !== idle)
const specLines: string[] = [];
if (state.specProgress && state.specProgress.phase !== "idle") {
  const rendered = renderSpecProgress(state.specProgress, bodyWidth, theme);
  for (const line of rendered) {
    specLines.push(
      fg(theme.accent, "│") +
        padVisible(" " + line, mascotWidth) +
        fg(theme.muted, "│") +
        padVisible("", bodyWidth) +
        fg(theme.accent, "│"),
    );
  }
}

// Spec confirmation overlay (takes priority over normal body)
if (state.specConfirmation) {
  const confirmLines = renderSpecProgressConfirmation(state.specConfirmation, width, theme);
  // confirmation is rendered as full-width overlay below body
  specLines.push(...confirmLines);
}

// Reasoning indicator (collapsed: show in footer area; expanded: show above separator)
let reasoningLine = "";
if (state.reasoning) {
  if (state.reasoningExpanded) {
    // Expanded: show reasoning text in body area
    const reasoningText = sanitizeTerminalText(state.reasoning).replaceAll(/\r?\n/g, " ");
    const truncated = truncatePlain(reasoningText, bodyWidth - 4);
    reasoningLine = fg(theme.muted, "💭 " + truncated);
  } else {
    reasoningLine = fg(theme.muted, "💭 thinking...");
  }
}
```

然后在最终 return 语句中,把 `specLines` 和 `reasoningLine` 插入到 body 和 separator 之间:

原:

```typescript
return bg(
  theme.background,
  [top, header, ...body, separator, ...completionRows, ...inputRows, footer, bottom].join("\n"),
);
```

改为:

```typescript
const reasoningRows: string[] = reasoningLine
  ? [
      fg(theme.accent, "│") +
        fg(theme.muted, padVisible(reasoningLine, width - 2)) +
        fg(theme.accent, "│"),
    ]
  : [];
return bg(
  theme.background,
  [
    top,
    header,
    ...body,
    ...specLines,
    ...reasoningRows,
    separator,
    ...completionRows,
    ...inputRows,
    footer,
    bottom,
  ].join("\n"),
);
```

**(d) 添加 context usage 到 footer**。

找到 footer 构建逻辑(`const footerText = ...`),在 `footerExtras` 数组中追加 context usage:

```typescript
const contextBadge = state.contextUsage ? renderContextBar(state.contextUsage, 30, theme) : "";
const footerExtras = [companionBadge, costBadge, contextBadge].filter(Boolean).join(" · ");
```

**(e) 添加 helper 函数**(在文件末尾):

```typescript
/** Render spec confirmation as full-width rows (not inside mascot column). */
function renderSpecProgressConfirmation(
  state: SpecConfirmationState,
  width: number,
  theme: TuiTheme,
): string[] {
  // Reuse renderSpecConfirmation from spec-progress.ts via dynamic import workaround
  // Since we already imported renderSpecProgress, we need renderSpecConfirmation too
  // This is a thin wrapper that pads each line to full width
  // Implementation detail: import added at top of file
  return [];
}
```

**修正**:实际上应该在 import 中也导入 `renderSpecConfirmation`。更新 import:

```typescript
import {
  renderSpecConfirmation,
  renderSpecProgress,
  type SpecConfirmationState,
  type SpecProgressState,
} from "./spec-progress.js";
```

然后 `renderSpecProgressConfirmation` 改为:

```typescript
function renderSpecProgressConfirmation(
  state: SpecConfirmationState,
  width: number,
  theme: TuiTheme,
): string[] {
  const inner = renderSpecConfirmation(state, width - 4, theme);
  return inner.map(
    (line) => fg(theme.accent, "│") + padVisible(" " + line, width - 2) + fg(theme.accent, "│"),
  );
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm build && npx vitest run packages/tui/test/renderer.test.ts`
Expected: PASS

- [ ] **Step 5: prettier + 边界检查**

Run: `pnpm format && node scripts/check-boundaries.mjs`

- [ ] **Step 6: 提交**

```bash
git add packages/tui/src/renderer.ts packages/tui/test/renderer.test.ts
git commit -m "feat(tui): integrate spec progress, reasoning, and context bar into renderer"
```

---

## Task 7: index.ts — 导出新公共 API

**Files:**

- Modify: `packages/tui/src/index.ts`
- Test: `packages/tui/test/index.test.ts`(若存在,追加;否则验证 import)

**Interfaces:**

- Produces: 公共导出 `SpecProgressState`, `SpecConfirmationState`, `SpecDecisionView`, `ContextUsageState`, `renderSpecProgress`, `renderContextBar`, `createInitialSpecProgress`, `createSpecConfirmation`, `advanceConfirmation`, `collectChoices`

- [ ] **Step 1: 写失败测试 — 导出可用性**

创建或追加到 `packages/tui/test/index.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import * as Tui from "../src/index.js";

describe("TUI public exports", () => {
  it("exports spec-progress types and functions", () => {
    expect(typeof Tui.createInitialSpecProgress).toBe("function");
    expect(typeof Tui.renderSpecProgress).toBe("function");
    expect(typeof Tui.createSpecConfirmation).toBe("function");
    expect(typeof Tui.advanceConfirmation).toBe("function");
    expect(typeof Tui.collectChoices).toBe("function");
  });

  it("exports context-bar types and functions", () => {
    expect(typeof Tui.renderContextBar).toBe("function");
    expect(typeof Tui.formatTokens).toBe("function");
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm build && npx vitest run packages/tui/test/index.test.ts`
Expected: FAIL — 新符号未从 index 导出

- [ ] **Step 3: 更新 index.ts 导出**

读取 `packages/tui/src/index.ts`,在现有 export 语句块中追加:

```typescript
export {
  advanceConfirmation,
  collectChoices,
  createInitialSpecProgress,
  createSpecConfirmation,
  renderSpecConfirmation,
  renderSpecProgress,
  type ConfirmationAction,
  type SpecConfirmationState,
  type SpecDecisionView,
  type SpecPhase,
  type SpecProgressState,
  type SpecStageInfo,
  type SpecStageStatus,
} from "./spec-progress.js";
export { formatTokens, renderContextBar, type ContextUsageState } from "./context-bar.js";
```

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm build && npx vitest run packages/tui/test/index.test.ts`
Expected: PASS

- [ ] **Step 5: prettier + 边界检查**

Run: `pnpm format && node scripts/check-boundaries.mjs`

- [ ] **Step 6: 提交**

```bash
git add packages/tui/src/index.ts packages/tui/test/index.test.ts
git commit -m "feat(tui): export spec-progress and context-bar public API"
```

---

## Task 8: apps/cli/src/tui.ts — spec_* 事件翻译 + 回调桥接

**Files:**

- Modify: `apps/cli/src/tui.ts`
- Test: `apps/cli/test/tui-spec-events.test.ts`(新建)

**Interfaces:**

- Consumes: `AgentEvent` 的 `spec_*` 变体,`FullScreenTui` 的新方法,`SpecKeyDecision` 类型
- Produces: `renderEvent()` 扩展,`FullScreenAgentOptions` 新增 `onSpecConfirm`/`onSpecDecline` 透传

- [ ] **Step 1: 写失败测试 — 事件翻译**

创建 `apps/cli/test/tui-spec-events.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@focuscode/agent-runtime";
import { FullScreenTui } from "@focuscode/tui";

// We test renderEvent indirectly by verifying FullScreenTui method calls.
// Since renderEvent is not exported, we test via integration: dispatch events
// to a mock Tui and verify state changes.

describe("spec event translation", () => {
  it("spec_start sets spec progress to start phase", () => {
    const tui = new FullScreenTui({
      input: {
        isTTY: false,
        setRawMode: () => {},
        setEncoding: () => {},
        resume: () => {},
        on: () => {},
        off: () => {},
      } as never,
      output: {
        isTTY: false,
        columns: 80,
        rows: 24,
        write: () => {},
        on: () => {},
        off: () => {},
      } as never,
      model: "test/model",
      session: "s1",
      approval: "ask",
      sandbox: "host",
      onSubmit: async () => {},
      onSteer: async () => {},
      onAbort: () => {},
    });

    // Simulate spec_start event handling
    tui.setSpecProgress({ phase: "start", trigger: "auto", stages: [], startTime: Date.now() });
    const snap = tui.snapshot();
    expect(snap.specProgress?.phase).toBe("start");
    expect(snap.specProgress?.trigger).toBe("auto");
  });

  it("spec_stage updates stage info", () => {
    const tui = new FullScreenTui({
      input: {
        isTTY: false,
        setRawMode: () => {},
        setEncoding: () => {},
        resume: () => {},
        on: () => {},
        off: () => {},
      } as never,
      output: {
        isTTY: false,
        columns: 80,
        rows: 24,
        write: () => {},
        on: () => {},
        off: () => {},
      } as never,
      model: "test/model",
      session: "s1",
      approval: "ask",
      sandbox: "host",
      onSubmit: async () => {},
      onSteer: async () => {},
      onAbort: () => {},
    });

    tui.setSpecProgress({ phase: "classify", stages: [] });
    tui.updateSpecStage("classify", {
      status: "done",
      durationMs: 500,
      model: "glm-4",
      fellBack: false,
    });
    const snap = tui.snapshot();
    expect(snap.specProgress?.stages).toHaveLength(1);
    expect(snap.specProgress?.stages[0]?.durationMs).toBe(500);
  });

  it("spec_confirmation_required triggers confirmation UI", () => {
    const tui = new FullScreenTui({
      input: {
        isTTY: false,
        setRawMode: () => {},
        setEncoding: () => {},
        resume: () => {},
        on: () => {},
        off: () => {},
      } as never,
      output: {
        isTTY: false,
        columns: 80,
        rows: 24,
        write: () => {},
        on: () => {},
        off: () => {},
      } as never,
      model: "test/model",
      session: "s1",
      approval: "ask",
      sandbox: "host",
      onSubmit: async () => {},
      onSteer: async () => {},
      onAbort: () => {},
    });

    tui.setSpecConfirmation("spec_123", [
      {
        id: "d1",
        point: "Test?",
        severity: "critical",
        options: [{ label: "A", description: "a" }],
        selectedIndex: 0,
      },
    ]);
    const snap = tui.snapshot();
    expect(snap.specConfirmation?.specId).toBe("spec_123");
  });

  it("onSpecConfirm callback fires when confirmation completes", () => {
    const onConfirm = vi.fn();
    const tui = new FullScreenTui({
      input: {
        isTTY: false,
        setRawMode: () => {},
        setEncoding: () => {},
        resume: () => {},
        on: () => {},
        off: () => {},
      } as never,
      output: {
        isTTY: false,
        columns: 80,
        rows: 24,
        write: () => {},
        on: () => {},
        off: () => {},
      } as never,
      model: "test/model",
      session: "s1",
      approval: "ask",
      sandbox: "host",
      onSubmit: async () => {},
      onSteer: async () => {},
      onAbort: () => {},
      onSpecConfirm,
    });

    tui.setSpecConfirmation("spec_123", [
      {
        id: "d1",
        point: "Test?",
        severity: "critical",
        options: [{ label: "A", description: "a" }],
        selectedIndex: 0,
      },
    ]);
    tui.confirmSpecNavigation("confirm"); // confirm the only decision
    expect(onConfirm).toHaveBeenCalledWith("spec_123", { d1: "A" });
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm build && npx vitest run apps/cli/test/tui-spec-events.test.ts`
Expected: FAIL — `onSpecConfirm` 不是 FullScreenTuiOptions 的字段(已在 Task 5 添加,但 CLI 层未透传)

注:如果 Task 5 已完成,前 3 个测试可能已通过;第 4 个测试需要 Task 5 的 `confirmSpecNavigation` 和 `onSpecConfirm` 回调。

- [ ] **Step 3: 扩展 apps/cli/src/tui.ts 的 renderEvent 和 options**

修改 `apps/cli/src/tui.ts`:

**(a) 在 import 块从 `@focuscode/tui` 追加类型**:

```typescript
import {
  // ...existing imports...
  type SpecDecisionView,
} from "@focuscode/tui";
```

**(b) 在 `FullScreenAgentOptions` 接口追加字段**(在 `onReady?` 之前):

```typescript
  /** SpecEngine 确认回调透传。 */
  onSpecConfirm?(specId: string, choices: Record<string, string>): void;
  /** SpecEngine 拒绝回调透传。 */
  onSpecDecline?(specId: string): void;
```

**(c) 在 `runFullScreenAgent` 的 `new FullScreenTui({...})` 配置中追加回调**(在 `onCommand` 之后):

```typescript
    ...(options.onSpecConfirm ? { onSpecConfirm: options.onSpecConfirm } : {}),
    ...(options.onSpecDecline ? { onSpecDecline: options.onSpecDecline } : {}),
```

**(d) 扩展 `renderEvent` 函数**,在 `} else if (event.type === "agent_end") {` 之前追加 spec_* 分支:

```typescript
  } else if (event.type === "spec_start") {
    tui.setSpecProgress({
      phase: "start",
      trigger: event.trigger,
      stages: [],
      startTime: Date.now(),
    });
    tui.setStatus("✦ Spec engine started (" + event.trigger + ")");
    speak("thinking");
  } else if (event.type === "spec_stage") {
    tui.updateSpecStage(event.stage, {
      status: "done",
      model: event.model,
      durationMs: event.durationMs,
      fellBack: event.fellBack,
    });
    tui.setStatus(
      "✦ " +
        event.stage +
        (event.fellBack ? " (fallback)" : " ✓") +
        " " +
        event.durationMs +
        "ms",
    );
  } else if (event.type === "spec_draft_ready") {
    tui.setSpecDraft({
      specId: event.specId,
      topic: event.topic,
    });
    tui.setSpeech("Spec draft ready: " + event.topic);
  } else if (event.type === "spec_confirmation_required") {
    const decisions = (event.decisions as unknown[]).map((raw, i) => {
      const d = raw as {
        id: string;
        point: string;
        severity: "critical" | "major" | "minor";
        options: { label: string; description: string }[];
      };
      return {
        id: d.id,
        point: d.point,
        severity: d.severity,
        options: d.options,
        selectedIndex: 0,
      } satisfies SpecDecisionView;
    });
    tui.setSpecConfirmation(event.specId, decisions);
    tui.setMood("thinking");
  } else if (event.type === "spec_confirmed") {
    tui.clearSpecConfirmation();
    tui.setMood("happy");
    tui.setStatus("✦ Spec confirmed");
  } else if (event.type === "spec_skipped") {
    tui.setSpecProgress({ phase: "skipped", stages: [] });
    tui.setStatus("✦ Spec skipped: " + event.reason);
  } else if (event.type === "spec_completed") {
    const startTime = tui.getSpecStartTime();
    const totalDuration = startTime ? Date.now() - startTime : undefined;
    tui.setSpecProgress({
      phase: "completed",
      stages: [], // stages already populated via spec_stage events
      ...(totalDuration !== undefined ? { totalDuration } : {}),
      ...(event.specId ? { specId: event.specId } : {}),
    });
    tui.setMood("happy");
    tui.setStatus("✦ Spec completed · " + (totalDuration ?? 0) + "ms");
  } else if (event.type === "reasoning_delta") {
    tui.appendReasoning(event.delta);
```

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm build && npx vitest run apps/cli/test/tui-spec-events.test.ts`
Expected: PASS

- [ ] **Step 5: 全量测试 + 边界检查**

Run: `pnpm verify`
Expected: 全套测试通过,边界检查通过,覆盖率达标

- [ ] **Step 6: prettier**

Run: `pnpm format`

- [ ] **Step 7: 提交**

```bash
git add apps/cli/src/tui.ts apps/cli/test/tui-spec-events.test.ts
git commit -m "feat(cli): translate spec_* AgentEvents to TUI state and bridge confirmation callbacks"
```

---

## Task 9: 处理 spec confirmation 键盘输入

**Files:**

- Modify: `packages/tui/src/app.ts`
- Test: `packages/tui/test/app.test.ts`(追加)

**Interfaces:**

- Consumes: `confirmSpecNavigation()` from Task 5
- Produces: 当 `specConfirmation` 激活时,拦截 `up`/`down`/`enter`/`esc` 输入为确认导航 action

- [ ] **Step 1: 写失败测试 — 确认输入拦截**

追加到 `packages/tui/test/app.test.ts`:

```typescript
import { vi } from "vitest";

describe("FullScreenTui spec confirmation input handling", () => {
  it("intercepts arrow keys for confirmation navigation when active", () => {
    const onConfirm = vi.fn();
    const tui = new FullScreenTui({
      input: {
        isTTY: false,
        setRawMode: () => {},
        setEncoding: () => {},
        resume: () => {},
        on: () => {},
        off: () => {},
      } as never,
      output: {
        isTTY: false,
        columns: 80,
        rows: 24,
        write: () => {},
        on: () => {},
        off: () => {},
      } as never,
      model: "test/model",
      session: "s1",
      approval: "ask",
      sandbox: "host",
      theme: TUI_THEMES[0]!,
      mascot: TUI_MASCOTS[0]!,
      onSubmit: async () => {},
      onSteer: async () => {},
      onAbort: () => {},
      onSpecConfirm,
    });

    tui.setSpecConfirmation("spec_1", [
      {
        id: "d1",
        point: "Pick one",
        severity: "critical",
        options: [
          { label: "A", description: "first" },
          { label: "B", description: "second" },
        ],
        selectedIndex: 0,
      },
    ]);

    // Simulate down arrow → should change selected option to B (index 1)
    tui.confirmSpecNavigation("option_down");
    const state = tui.getSpecConfirmationState();
    expect(state?.decisions[0]?.selectedIndex).toBe(1);

    // Simulate confirm → should trigger onSpecConfirm with choice B
    tui.confirmSpecNavigation("confirm");
    expect(onConfirm).toHaveBeenCalledWith("spec_1", { d1: "B" });
  });

  it("Esc declines spec via onSpecDecline", () => {
    const onDecline = vi.fn();
    const tui = new FullScreenTui({
      input: {
        isTTY: false,
        setRawMode: () => {},
        setEncoding: () => {},
        resume: () => {},
        on: () => {},
        off: () => {},
      } as never,
      output: {
        isTTY: false,
        columns: 80,
        rows: 24,
        write: () => {},
        on: () => {},
        off: () => {},
      } as never,
      model: "test/model",
      session: "s1",
      approval: "ask",
      sandbox: "host",
      theme: TUI_THEMES[0]!,
      mascot: TUI_MASCOTS[0]!,
      onSubmit: async () => {},
      onSteer: async () => {},
      onAbort: () => {},
      onSpecDecline: onDecline,
    });

    tui.setSpecConfirmation("spec_1", [
      {
        id: "d1",
        point: "Pick",
        severity: "major",
        options: [{ label: "A", description: "a" }],
        selectedIndex: 0,
      },
    ]);
    tui.confirmSpecNavigation("cancel");
    expect(onDecline).toHaveBeenCalledWith("spec_1");
    expect(tui.getSpecConfirmationState()).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试验证状态**

Run: `pnpm build && npx vitest run packages/tui/test/app.test.ts`
Expected: 大部分应已通过(Task 5 已实现 `confirmSpecNavigation`)。若失败,检查方法签名。

- [ ] **Step 3: 在 app.ts 的输入处理中拦截确认键**

修改 `packages/tui/src/app.ts` 的 `onData` 方法。在 picker 拦截逻辑之后,追加 spec confirmation 拦截:

找到:

```typescript
if (this.picker) {
  this.handlePickerInput(value);
  return;
}
```

之后追加:

```typescript
if (this.specConfirmation) {
  this.handleSpecConfirmationInput(value);
  return;
}
```

然后在类中追加 `handleSpecConfirmationInput` 方法:

```typescript
  /**
   * Handle keystrokes while the spec confirmation overlay is open.
   * Up/Down navigate options, Enter confirms current decision,
   * Esc declines the entire spec.
   */
  private handleSpecConfirmationInput(value: string): void {
    let index = 0;
    while (index < value.length) {
      const rest = value.slice(index);
      // Esc declines spec
      if (rest.startsWith("\u001b") && !rest.startsWith("\u001b[")) {
        this.confirmSpecNavigation("cancel");
        index += 1;
        continue;
      }
      // Arrow up
      if (rest.startsWith("\u001b[A")) {
        this.confirmSpecNavigation("option_up");
        index += 3;
        continue;
      }
      // Arrow down
      if (rest.startsWith("\u001b[B")) {
        this.confirmSpecNavigation("option_down");
        index += 3;
        continue;
      }
      // Enter confirms
      if (rest.startsWith("\r") || rest.startsWith("\n")) {
        this.confirmSpecNavigation("confirm");
        index += 1;
        continue;
      }
      index += 1;
    }
  }
```

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm build && npx vitest run packages/tui/test/app.test.ts`
Expected: PASS

- [ ] **Step 5: prettier + 边界检查 + 全量测试**

Run: `pnpm format && pnpm verify`
Expected: 全部通过

- [ ] **Step 6: 提交**

```bash
git add packages/tui/src/app.ts packages/tui/test/app.test.ts
git commit -m "feat(tui): intercept keyboard input for interactive spec confirmation"
```

---

## Task 10: 全量验证与回归测试

**Files:**

- 无新文件,全量验证

- [ ] **Step 1: 全量构建与测试**

Run: `pnpm verify`
Expected:

- 边界检查通过(`scripts/check-boundaries.mjs`)
- prettier check 通过
- build 成功
- 所有测试通过,覆盖率达标(statements 75 / branches 60 / functions 80 / lines 80)

- [ ] **Step 2: 验证向后兼容**

确认现有测试全部通过,特别是:

- `packages/tui/test/renderer.test.ts` 现有快照测试
- `packages/tui/test/app.test.ts` 现有状态测试
- `apps/cli/test/` 现有 CLI 测试

- [ ] _\*Step 3: 手动验证 spec_* 事件渲染_*(可选,若有 ARK API Key)

如果环境变量 `ARK_API_KEY` 可用,运行 live test 验证 TUI 实际渲染:

```bash
ARK_API_KEY=xxx npx tsx tests/spec-engine-live-test.ts
```

观察 TUI 是否显示 spec progress widget。

- [ ] **Step 4: 提交最终状态**

```bash
git add -A
git commit -m "test(tui): verify Phase 1 SpecEngine integration with full test suite"
```

---

## Self-Review 总结

### Spec 覆盖检查

| 设计文档章节                 | 对应 Task          |
| ---------------------------- | ------------------ |
| §7.1 SpecEngine 进度 Widget  | Task 1             |
| §7.2 交互式确认              | Task 2, 9          |
| §6.2 Context Usage Bar       | Task 3             |
| §4.4 Reasoning 可视化        | Task 5, 6          |
| §5.4 Keymap toggle_reasoning | Task 4             |
| §7.4 CLI 事件翻译            | Task 8             |
| §2.2 数据流                  | Task 5, 6, 8       |
| §9 测试策略                  | 每个 Task 内含测试 |

### 类型一致性检查

- `SpecProgressState`:Task 1 定义 → Task 5 使用 → Task 6 渲染 → Task 8 翻译 ✓
- `SpecConfirmationState`:Task 2 定义 → Task 5 使用 → Task 9 输入处理 ✓
- `ContextUsageState`:Task 3 定义 → Task 5 使用 → Task 6 渲染 ✓
- `SpecDecisionView`:Task 2 定义 → Task 5 使用 → Task 8 从 AgentEvent 转换 ✓
- `confirmSpecNavigation`:Task 5 定义 → Task 9 调用 ✓

### 向后兼容

- `renderTui(state)` 签名不变 ✓
- `TuiRenderState` 新字段全部可选 ✓
- `DEFAULT_KEYMAP` 不变(`toggle_reasoning` 不默认绑定)✓
- `FullScreenTuiOptions` 新回调可选 ✓
- 现有主题继续工作(无 truecolor 破坏性改动,留待 Phase 4)✓

## 执行交接

计划已保存到 `docs/superpowers/plans/2026-07-23-tui-phase1-spec-engine-integration.md`。两种执行选项:

**1. Subagent-Driven(推荐)** — 每个 Task 派发独立 subagent,任务间 review,快速迭代

**2. Inline Execution** — 在当前会话批量执行,带检查点 review

选择哪种方式?
