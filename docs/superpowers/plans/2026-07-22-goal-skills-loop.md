# Goal + Skills + Loop 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-v6-subagent-driven-development (recommended) or superpowers-v6-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 FocusCode agent-runtime 增加 Goal 状态机、声明式 Skills、自迭代 Loop，使其具备"目标驱动+可复用能力+自动收敛"的执行模型。

**Architecture:** 三个独立模块（goal.ts/skills.ts/loop.ts）放在 `packages/agent-runtime/src/`，遵循现有架构边界（不依赖 harness-core/model-gateway 等）。Goal 提供目标状态与验证器；Skills 是声明式 JSON 配置加载器（触发条件+prompt 注入+工具白名单）；Loop 是 Goal 驱动的自迭代循环，叠加 maxIterations 与 token 预算硬上限。

**Tech Stack:** TypeScript ESM, vitest, 现有 AgentTool/ToolDefinition 接口, 现有 config.ts 配置模式。

## Global Constraints

- Node >=22.12.0, pnpm 11.7.0, TypeScript strict
- 遵循 `scripts/check-boundaries.mjs`：agent-runtime 不依赖 harness-core/model-gateway/persistence/sdk/auth/ecosystem/sandbox/tui
- Prettier: printWidth 100, 双引号, semicolon, trailing comma "all"
- 测试位置: `packages/agent-runtime/test/`
- 覆盖率阈值: statements 75 / branches 60 / functions 80 / lines 80
- 全 ESM, 包入口 dist/index.js

---

## File Structure

- Create: `packages/agent-runtime/src/goal.ts` — Goal 状态机与验证器接口
- Create: `packages/agent-runtime/src/skills.ts` — 声明式 Skill 加载器
- Create: `packages/agent-runtime/src/loop.ts` — Goal 驱动的自迭代循环
- Create: `packages/agent-runtime/test/goal.test.ts` — Goal 单元测试
- Create: `packages/agent-runtime/test/skills.test.ts` — Skills 单元测试
- Create: `packages/agent-runtime/test/loop.test.ts` — Loop 集成测试
- Modify: `packages/agent-runtime/src/config.ts` — 添加 skills/loop 配置
- Modify: `packages/agent-runtime/src/agent.ts` — 注册 goal 工具、注入 skills、暴露 loop 入口
- Modify: `packages/agent-runtime/src/index.ts` — 导出新模块

---

### Task 1: Goal 状态机与验证器

**Files:**

- Create: `packages/agent-runtime/src/goal.ts`
- Test: `packages/agent-runtime/test/goal.test.ts`

**Interfaces:**

- Produces: `Goal`, `GoalVerifier`, `GoalState`, `createGoalTool`

- [x] **Step 1: 写失败测试**

```typescript
// packages/agent-runtime/test/goal.test.ts
import { describe, expect, it } from "vitest";
import {
  type Goal,
  type GoalState,
  createGoalState,
  createGoalTool,
  type GoalVerifier,
} from "../src/goal.js";

describe("goal state machine", () => {
  it("transitions pending→in_progress→done", () => {
    const state = createGoalState("Implement feature X");
    expect(state.status).toBe("pending");
    state.start();
    expect(state.status).toBe("in_progress");
    state.complete();
    expect(state.status).toBe("done");
  });

  it("rejects invalid transitions", () => {
    const state = createGoalState("Goal");
    state.complete();
    expect(() => state.start()).toThrow(/Cannot start a done goal/);
  });

  it("captures verifier result with evidence", () => {
    const verifier: GoalVerifier = async () => ({
      satisfied: true,
      evidence: "tests pass",
    });
    const state = createGoalState("Goal", verifier);
    state.start();
    return state.verify().then((result) => {
      expect(result.satisfied).toBe(true);
      expect(result.evidence).toBe("tests pass");
      expect(state.status).toBe("done");
    });
  });

  it("stays in_progress when verifier not satisfied", async () => {
    const verifier: GoalVerifier = async () => ({ satisfied: false });
    const state = createGoalState("Goal", verifier);
    state.start();
    const result = await state.verify();
    expect(result.satisfied).toBe(false);
    expect(state.status).toBe("in_progress");
  });
});

describe("goal tool", () => {
  it("exposes definition with write effect", () => {
    const tool = createGoalTool();
    expect(tool.definition.name).toBe("goal");
    expect(tool.definition.effect).toBe("write");
    expect(tool.definition.parameters).toHaveProperty("action");
  });
});
```

- [x] **Step 2: 运行测试验证失败**

Run: `pnpm build && npx vitest run packages/agent-runtime/test/goal.test.ts`
Expected: FAIL with "Cannot find module '../src/goal.js'"

- [x] **Step 3: 最小实现**

```typescript
// packages/agent-runtime/src/goal.ts
import type {
  AgentTool,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./types.js";

export type GoalStatus = "pending" | "in_progress" | "done" | "failed";

export interface GoalVerifyResult {
  satisfied: boolean;
  evidence?: string;
}

export type GoalVerifier = () => Promise<GoalVerifyResult>;

export interface Goal {
  description: string;
  status: GoalStatus;
  verifier?: GoalVerifier;
  attempts: number;
  lastEvidence?: string;
}

export interface GoalState {
  readonly description: string;
  readonly status: GoalStatus;
  readonly attempts: number;
  readonly lastEvidence?: string;
  start(): void;
  complete(): void;
  fail(): void;
  verify(): Promise<GoalVerifyResult>;
}

export function createGoalState(description: string, verifier?: GoalVerifier): GoalState {
  let status: GoalStatus = "pending";
  let attempts = 0;
  let lastEvidence: string | undefined;
  return {
    get description() {
      return description;
    },
    get status() {
      return status;
    },
    get attempts() {
      return attempts;
    },
    get lastEvidence() {
      return lastEvidence;
    },
    start() {
      if (status !== "pending" && status !== "in_progress") {
        throw new Error(`Cannot start a ${status} goal`);
      }
      status = "in_progress";
    },
    complete() {
      if (status === "done" || status === "failed") {
        throw new Error(`Cannot complete a ${status} goal`);
      }
      status = "done";
    },
    fail() {
      status = "failed";
    },
    async verify() {
      if (!verifier) {
        return { satisfied: true };
      }
      attempts += 1;
      const result = await verifier();
      lastEvidence = result.evidence;
      if (result.satisfied) {
        status = "done";
      }
      return result;
    },
  };
}

const goalToolDefinition: ToolDefinition = {
  name: "goal",
  label: "Goal",
  description:
    "Set, update, or query the current goal. Actions: set|start|complete|status. " +
    "Use this to declare intent before executing, and to mark completion with evidence.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["set", "start", "complete", "status"] },
      description: { type: "string", description: "Goal description (for 'set' action)" },
      evidence: { type: "string", description: "Completion evidence (for 'complete' action)" },
    },
    required: ["action"],
  },
  effect: "write",
};

export function createGoalTool(): AgentTool {
  return {
    definition: goalToolDefinition,
    async execute(
      args: Record<string, unknown>,
      _context: ToolExecutionContext,
    ): Promise<ToolExecutionResult> {
      const action = String(args.action ?? "");
      if (action === "status") {
        return { content: "goal tool: no active goal state in tool-only mode" };
      }
      return {
        content: `goal action '${action}' recorded; use GoalState API for stateful tracking`,
      };
    },
  };
}
```

- [x] **Step 4: 运行测试验证通过**

Run: `pnpm build && npx vitest run packages/agent-runtime/test/goal.test.ts`
Expected: PASS

- [x] **Step 5: 提交**

```bash
git add packages/agent-runtime/src/goal.ts packages/agent-runtime/test/goal.test.ts
git commit -m "feat(agent-runtime): add goal state machine and verifier"
```

---

### Task 2: 声明式 Skills 加载器

**Files:**

- Create: `packages/agent-runtime/src/skills.ts`
- Test: `packages/agent-runtime/test/skills.test.ts`

**Interfaces:**

- Consumes: `ToolDefinition` from types.ts
- Produces: `Skill`, `SkillManifest`, `loadSkills`, `selectSkills`, `buildSkillPrompt`

- [x] **Step 1: 写失败测试**

```typescript
// packages/agent-runtime/test/skills.test.ts
import { describe, expect, it } from "vitest";
import { loadSkills, selectSkills, buildSkillPrompt, type SkillManifest } from "../src/skills.js";

describe("skills loader", () => {
  it("loads skills from manifest", () => {
    const manifest: SkillManifest = {
      schemaVersion: "focuscode-skills.v1",
      skills: [
        {
          name: "tdd",
          description: "Test-driven development",
          trigger: { keywords: ["test", "tdd", "spec"] },
          prompt: "Always write failing test first, then implement.",
          allowedTools: ["read", "write", "edit", "bash"],
        },
      ],
    };
    const skills = loadSkills(manifest);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe("tdd");
  });

  it("selects skills by keyword match", () => {
    const manifest: SkillManifest = {
      schemaVersion: "focuscode-skills.v1",
      skills: [
        {
          name: "tdd",
          description: "TDD",
          trigger: { keywords: ["test"] },
          prompt: "TDD prompt",
          allowedTools: [],
        },
        {
          name: "refactor",
          description: "Refactor",
          trigger: { keywords: ["refactor", "clean"] },
          prompt: "Refactor prompt",
          allowedTools: [],
        },
      ],
    };
    const skills = loadSkills(manifest);
    const selected = selectSkills(skills, "please test this function");
    expect(selected.map((s) => s.name)).toEqual(["tdd"]);
  });

  it("builds prompt from selected skills", () => {
    const manifest: SkillManifest = {
      schemaVersion: "focuscode-skills.v1",
      skills: [
        {
          name: "tdd",
          description: "TDD",
          trigger: { keywords: ["test"] },
          prompt: "Write test first.",
          allowedTools: ["read", "write"],
        },
      ],
    };
    const skills = loadSkills(manifest);
    const selected = selectSkills(skills, "test please");
    const prompt = buildSkillPrompt(selected);
    expect(prompt).toContain("Write test first.");
    expect(prompt).toContain("Allowed tools: read, write");
  });

  it("rejects manifest with invalid schema version", () => {
    expect(() => loadSkills({ schemaVersion: "invalid", skills: [] })).toThrow(
      /Unsupported skills schema/,
    );
  });
});
```

- [x] **Step 2: 运行测试验证失败**

Run: `pnpm build && npx vitest run packages/agent-runtime/test/skills.test.ts`
Expected: FAIL

- [x] **Step 3: 最小实现**

```typescript
// packages/agent-runtime/src/skills.ts
export interface SkillTrigger {
  keywords?: string[];
  toolNames?: string[];
}

export interface Skill {
  name: string;
  description: string;
  trigger: SkillTrigger;
  prompt: string;
  allowedTools: string[];
}

export interface SkillManifest {
  schemaVersion: "focuscode-skills.v1";
  skills: Skill[];
}

export function loadSkills(manifest: SkillManifest): Skill[] {
  if (manifest.schemaVersion !== "focuscode-skills.v1") {
    throw new Error(
      `Unsupported skills schema: ${manifest.schemaVersion}; expected focuscode-skills.v1`,
    );
  }
  return manifest.skills.map((skill) => ({ ...skill, trigger: { ...skill.trigger } }));
}

export function selectSkills(skills: Skill[], userInput: string): Skill[] {
  const lower = userInput.toLowerCase();
  return skills.filter((skill) => {
    const keywords = skill.trigger.keywords ?? [];
    return keywords.some((keyword) => lower.includes(keyword.toLowerCase()));
  });
}

export function buildSkillPrompt(selected: Skill[]): string {
  if (selected.length === 0) return "";
  const parts = selected.map((skill) => {
    const tools =
      skill.allowedTools.length > 0 ? `Allowed tools: ${skill.allowedTools.join(", ")}` : "";
    return `## Skill: ${skill.name}\n${skill.prompt}\n${tools}`;
  });
  return parts.join("\n\n");
}
```

- [x] **Step 4: 运行测试验证通过**

Run: `pnpm build && npx vitest run packages/agent-runtime/test/skills.test.ts`
Expected: PASS

- [x] **Step 5: 提交**

```bash
git add packages/agent-runtime/src/skills.ts packages/agent-runtime/test/skills.test.ts
git commit -m "feat(agent-runtime): add declarative skills loader"
```

---

### Task 3: Goal 驱动的自迭代 Loop

**Files:**

- Create: `packages/agent-runtime/src/loop.ts`
- Test: `packages/agent-runtime/test/loop.test.ts`

**Interfaces:**

- Consumes: `GoalState`, `GoalVerifier` from goal.ts, `CodingAgent` from agent.ts
- Produces: `LoopOptions`, `LoopResult`, `runGoalLoop`

- [x] **Step 1: 写失败测试**

```typescript
// packages/agent-runtime/test/loop.test.ts
import { describe, expect, it } from "vitest";
import { runGoalLoop, type LoopOptions } from "../src/loop.js";
import { createGoalState } from "../src/goal.js";

describe("goal loop", () => {
  it("terminates when goal satisfied on first iteration", async () => {
    let calls = 0;
    const options: LoopOptions = {
      goal: createGoalState("Done immediately"),
      maxIterations: 5,
      tokenBudget: 10_000,
      execute: async () => {
        calls += 1;
        return { tokensUsed: 100, output: "done" };
      },
      verify: async () => ({ satisfied: true, evidence: "verified" }),
    };
    const result = await runGoalLoop(options);
    expect(result.iterations).toBe(1);
    expect(result.satisfied).toBe(true);
    expect(calls).toBe(1);
  });

  it("iterates until satisfied within maxIterations", async () => {
    let calls = 0;
    const options: LoopOptions = {
      goal: createGoalState("Needs 3 iterations"),
      maxIterations: 5,
      tokenBudget: 10_000,
      execute: async () => {
        calls += 1;
        return { tokensUsed: 100, output: `iter ${calls}` };
      },
      verify: async () => ({ satisfied: calls >= 3 }),
    };
    const result = await runGoalLoop(options);
    expect(result.iterations).toBe(3);
    expect(result.satisfied).toBe(true);
  });

  it("stops at maxIterations when not satisfied", async () => {
    const options: LoopOptions = {
      goal: createGoalState("Never satisfied"),
      maxIterations: 2,
      tokenBudget: 10_000,
      execute: async () => ({ tokensUsed: 100, output: "iter" }),
      verify: async () => ({ satisfied: false }),
    };
    const result = await runGoalLoop(options);
    expect(result.iterations).toBe(2);
    expect(result.satisfied).toBe(false);
    expect(result.reason).toBe("max_iterations");
  });

  it("stops when token budget exhausted", async () => {
    const options: LoopOptions = {
      goal: createGoalState("Token heavy"),
      maxIterations: 100,
      tokenBudget: 250,
      execute: async () => ({ tokensUsed: 200, output: "expensive" }),
      verify: async () => ({ satisfied: false }),
    };
    const result = await runGoalLoop(options);
    expect(result.iterations).toBeLessThanOrEqual(2);
    expect(result.satisfied).toBe(false);
    expect(result.reason).toBe("token_budget");
  });

  it("propagates execute errors with fail reason", async () => {
    const options: LoopOptions = {
      goal: createGoalState("Will error"),
      maxIterations: 5,
      tokenBudget: 10_000,
      execute: async () => {
        throw new Error("boom");
      },
      verify: async () => ({ satisfied: false }),
    };
    const result = await runGoalLoop(options);
    expect(result.satisfied).toBe(false);
    expect(result.reason).toBe("error");
    expect(result.error).toBe("boom");
  });
});
```

- [x] **Step 2: 运行测试验证失败**

Run: `pnpm build && npx vitest run packages/agent-runtime/test/loop.test.ts`
Expected: FAIL

- [x] **Step 3: 最小实现**

```typescript
// packages/agent-runtime/src/loop.ts
import type { GoalState, GoalVerifyResult } from "./goal.js";

export interface LoopIterationResult {
  tokensUsed: number;
  output: string;
}

export interface LoopOptions {
  goal: GoalState;
  maxIterations: number;
  tokenBudget: number;
  execute: (iteration: number) => Promise<LoopIterationResult>;
  verify: () => Promise<GoalVerifyResult>;
}

export interface LoopResult {
  satisfied: boolean;
  iterations: number;
  totalTokens: number;
  reason: "satisfied" | "max_iterations" | "token_budget" | "error";
  error?: string;
  finalOutput?: string;
}

export async function runGoalLoop(options: LoopOptions): Promise<LoopResult> {
  const { goal, maxIterations, tokenBudget, execute, verify } = options;
  if (maxIterations < 1) {
    throw new Error("maxIterations must be at least 1");
  }
  if (tokenBudget < 1) {
    throw new Error("tokenBudget must be at least 1");
  }
  goal.start();
  let totalTokens = 0;
  let finalOutput: string | undefined;
  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    let iterResult: LoopIterationResult;
    try {
      iterResult = await execute(iteration);
    } catch (error) {
      goal.fail();
      return {
        satisfied: false,
        iterations: iteration,
        totalTokens,
        reason: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    totalTokens += iterResult.tokensUsed;
    finalOutput = iterResult.output;
    if (totalTokens >= tokenBudget) {
      return {
        satisfied: false,
        iterations: iteration,
        totalTokens,
        reason: "token_budget",
        finalOutput,
      };
    }
    const verifyResult = await verify();
    if (verifyResult.satisfied) {
      goal.complete();
      return {
        satisfied: true,
        iterations: iteration,
        totalTokens,
        reason: "satisfied",
        finalOutput,
      };
    }
  }
  return {
    satisfied: false,
    iterations: maxIterations,
    totalTokens,
    reason: "max_iterations",
    finalOutput,
  };
}
```

- [x] **Step 4: 运行测试验证通过**

Run: `pnpm build && npx vitest run packages/agent-runtime/test/loop.test.ts`
Expected: PASS

- [x] **Step 5: 提交**

```bash
git add packages/agent-runtime/src/loop.ts packages/agent-runtime/test/loop.test.ts
git commit -m "feat(agent-runtime): add goal-driven self-iterating loop"
```

---

### Task 4: 配置与导出集成

**Files:**

- Modify: `packages/agent-runtime/src/config.ts` — 添加 skills/loop 配置
- Modify: `packages/agent-runtime/src/index.ts` — 导出新模块

- [x] **Step 1: 在 config.ts 的 AgentConfigFile 添加 skills 与 loop 字段**

在 `AgentConfigFile` 接口的 `mcp` 字段后添加：

```typescript
  skills?: {
    /** Path to skills manifest JSON (focuscode-skills.v1 schema). */
    manifestPath?: string;
    /** Inline skills manifest, overrides manifestPath. */
    inline?: import("./skills.js").SkillManifest;
    /** Enable skill-based prompt injection. Default true when manifest present. */
    enabled?: boolean;
  };
  loop?: {
    /** Default max iterations for goal-driven loops. Default 5. */
    maxIterations?: number;
    /** Default token budget for goal-driven loops. Default 50000. */
    tokenBudget?: number;
    /** Enable loop tool exposure. Default false (opt-in). */
    enabled?: boolean;
  };
```

在 `ResolvedAgentConfig` 添加：

```typescript
  skills: {
    enabled: boolean;
    manifestPath?: string;
    inline?: import("./skills.js").SkillManifest;
  };
  loop: {
    enabled: boolean;
    maxIterations: number;
    tokenBudget: number;
  };
```

在 `resolveAgentConfig` 返回对象中添加（紧跟 `mcp` 后）：

```typescript
    skills: {
      enabled: merged.skills?.enabled ?? (!!merged.skills?.inline || !!merged.skills?.manifestPath),
      ...(merged.skills?.manifestPath ? { manifestPath: merged.skills.manifestPath } : {}),
      ...(merged.skills?.inline ? { inline: merged.skills.inline } : {}),
    },
    loop: {
      enabled: merged.loop?.enabled ?? false,
      maxIterations: boundedInteger(merged.loop?.maxIterations, 5, 1, 50),
      tokenBudget: boundedInteger(merged.loop?.tokenBudget, 50_000, 1_000, 1_000_000),
    },
```

在 `validateAgentConfig` 函数末尾添加验证：

```typescript
if (config.skills !== undefined) {
  if (!config.skills || typeof config.skills !== "object" || Array.isArray(config.skills)) {
    throw new Error(`skills must be an object in ${path}`);
  }
  validateOptionalBoolean(config.skills.enabled, "skills.enabled", path);
  validateOptionalString(config.skills.manifestPath, "skills.manifestPath", path);
  if (config.skills.inline !== undefined) {
    if (!config.skills.inline || typeof config.skills.inline !== "object") {
      throw new Error(`skills.inline must be an object in ${path}`);
    }
    if (config.skills.inline.schemaVersion !== "focuscode-skills.v1") {
      throw new Error(`skills.inline.schemaVersion must be focuscode-skills.v1 in ${path}`);
    }
  }
}
if (config.loop !== undefined) {
  if (!config.loop || typeof config.loop !== "object" || Array.isArray(config.loop)) {
    throw new Error(`loop must be an object in ${path}`);
  }
  validateOptionalBoolean(config.loop.enabled, "loop.enabled", path);
}
```

- [x] **Step 2: 在 index.ts 添加导出**

```typescript
export * from "./goal.js";
export * from "./skills.js";
export * from "./loop.js";
```

- [x] **Step 3: 运行全部测试**

Run: `pnpm build && npx vitest run packages/agent-runtime/test/`
Expected: PASS（包括新测试与现有测试）

- [x] **Step 4: 提交**

```bash
git add packages/agent-runtime/src/config.ts packages/agent-runtime/src/index.ts
git commit -m "feat(agent-runtime): wire skills and loop config"
```

---

### Task 5: pnpm verify 全量验收

- [x] **Step 1: 运行完整门禁**

Run: `pnpm verify`
Expected: 架构边界检查 + prettier check + build + 带覆盖率测试全部通过

- [x] **Step 2: 检查覆盖率未回归**

确认 statements >= 75 / branches >= 60 / functions >= 80 / lines >= 80

- [x] **Step 3: 最终提交**

```bash
git add docs/superpowers/plans/2026-07-22-goal-skills-loop.md
git commit -m "docs: add goal+skills+loop implementation plan"
```

---

## Self-Review

**1. Spec coverage:** Goal 状态机 ✓ Skills 加载器 ✓ Loop 自迭代 ✓ 配置集成 ✓ 全量验收 ✓

**2. Placeholder scan:** 无 TBD/TODO，每步有完整代码。

**3. Type consistency:** `GoalState`/`GoalVerifier` 在 goal.ts 定义，loop.ts 消费，签名一致。`SkillManifest` 在 skills.ts 定义，config.ts 引用，一致。

## Execution Handoff

计划已保存。按 superpowers-v6-executing-plans 内联执行。

---

## 执行进度记录（Phase 1 完成）

### Task 1: Goal 状态机 ✓

- 实现：[packages/agent-runtime/src/goal.ts](../../../packages/agent-runtime/src/goal.ts)
- 测试：[packages/agent-runtime/test/goal.test.ts](../../../packages/agent-runtime/test/goal.test.ts) — 12 个测试用例
- 关键决策：`verify()` 在无 verifier 时直接置 `status = "done"` 并返回 `{ satisfied: true }`，使无 verifier 的 goal 也能正确状态转换

### Task 2: Skills 加载器 ✓

- 实现：[packages/agent-runtime/src/skills.ts](../../../packages/agent-runtime/src/skills.ts)
- 测试：[packages/agent-runtime/test/skills.test.ts](../../../packages/agent-runtime/test/skills.test.ts) — 10 个测试用例
- 关键决策：`loadSkills` 返回防御性拷贝（keywords/allowedTools 数组重新创建），避免外部修改污染 manifest

### Task 3: 自迭代 Loop ✓

- 实现：[packages/agent-runtime/src/loop.ts](../../../packages/agent-runtime/src/loop.ts)
- 测试：[packages/agent-runtime/test/loop.test.ts](../../../packages/agent-runtime/test/loop.test.ts) — 11 个测试用例
- 关键决策：`maxIterations` 与 `tokenBudget` 双硬上限；execute 抛错时 `goal.fail()` 后返回 `reason: "error"`

### Task 4: 配置与导出集成 ✓

- 修改 [packages/agent-runtime/src/config.ts](../../../packages/agent-runtime/src/config.ts)：
  - `AgentConfigFile` 添加 `skills?: { manifest?: string | SkillManifest }` 与 `loop?: { maxIterations?: number; tokenBudget?: number }`
  - `ResolvedAgentConfig` 添加对应必填字段
  - `resolveAgentConfig` 返回对象加入 `skills` 与 `loop`（默认 maxIterations=8, tokenBudget=200_000，boundedInteger 在 [1,100] 与 [1_000,10_000_000] 区间钳位）
  - `validateAgentConfig` 加入 schemaVersion、数组结构、数字字段验证
- 修改 [packages/agent-runtime/src/index.ts](../../../packages/agent-runtime/src/index.ts) 添加三行 `export * from "./goal.js"` / `"./loop.js"` / `"./skills.js"`
- 修改 [packages/agent-runtime/src/agent.ts](../../../packages/agent-runtime/src/agent.ts)：
  - `CodingAgentOptions` 添加 `enableGoal?: boolean` 与 `skills?: Skill[]`
  - 构造函数注册 `createGoalTool()`（默认启用，`enableGoal: false` 可关闭）
  - `submit()` 入口调用 `selectSkills(skills, prompt)` 计算 `currentSkillPrompt`
  - `systemPrompt()` 拼入 `currentSkillPrompt`
  - delegate 子代理继承父代理的 skills 配置
- 新增集成测试 [packages/agent-runtime/test/goal-skills-integration.test.ts](../../../packages/agent-runtime/test/goal-skills-integration.test.ts) — 5 个测试用例
- 新增 config 集成测试 7 个用例（在 config-resources-extensions.test.ts 中）

### Task 5: pnpm verify 全量验收 ✓

```text
Test Files  61 passed | 1 skipped (62)
     Tests  494 passed | 10 skipped (504)
All files   79.82 | 69.85 | 84.78 | 83.18   (statements/branches/functions/lines)
```

覆盖率全部超过阈值 75/60/80/80。架构边界检查、prettier、build、测试全部通过。

### 类型修复记录

实施过程中遇到 `exactOptionalPropertyTypes: true` 引发的 TS2375 错误，已将以下接口的可选属性类型显式加上 `| undefined`：

- `GoalVerifyResult.evidence`
- `Goal.verifier` / `Goal.lastEvidence`
- `GoalState.lastEvidence`
- `LoopResult.error` / `LoopResult.finalOutput`

### 测试用例修复

`goal.test.ts` 中 `exposes definition with write effect` 用例原期望 `parameters` 顶层有 `action` 属性，实际 JSON schema 把字段放在 `parameters.properties` 里。修复为检查 `parameters.properties.action/description/evidence`，与 native-providers.test.ts 的工具定义约定一致。

### Phase 1 总结

新增三个核心模块（goal/skills/loop）共 248 行实现代码 + 33 个单元测试 + 12 个集成测试，全量 pnpm verify 通过。Skills 是声明式 JSON 配置（非可执行代码），无需进程隔离；Loop 提供硬上限保证不会失控；Goal 状态机为外部组合根（如 SDK、CLI）提供 `runGoalLoop` 入口实现目标驱动循环。

后续 Phase 2/3 可在此基础上扩展 Agent teams（多 CodingAgent 协作）、Graph（DAG 任务依赖）、LSP 多语言扩展（当前 diagnostics.ts 仅支持 tsc --noEmit）。
