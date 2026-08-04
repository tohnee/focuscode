# Cache-First Harness 落地 FocusCode 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-v6-subagent-driven-development (recommended) or superpowers-v6-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把《OpenCache Harness 工程设计方案》中可落地的 cache-first 组件移植进 FocusCode——第一阶段让缓存经济性可见(命中率/节约额)、前缀稳定性可验证(cache epoch 指纹),后续阶段补齐 Provider 缓存协议与工具 schema 经济性。

**Architecture:** FocusCode 已实现 stable/dynamic system 前缀切分、openai-prefix / anthropic-ephemeral 缓存断点注入、四协议 usage 归一化(`cachedInputTokens`)。本计划第一阶段在现有数据通路之上新增：(1) 缓存命中率/节约额聚合与 TUI/CLI 展示(修复 `tui.ts:654` 把 token 数当美元的 bug)；(2) `CacheEpochManifest` 稳定前缀指纹与 churn 追踪。第二阶段补 Kimi `prompt_cache_key` 与 `minPrefixTokens` 生效；第三阶段做工具 schema 稳定化与缓存经济型 compaction。

**Tech Stack:** TypeScript(strict + exactOptionalPropertyTypes + verbatimModuleSyntax)、vitest(跑 `dist/` 构建产物)、pnpm monorepo、typebox 契约。

## Global Constraints

- `packages/agent-runtime` 不得依赖 `harness-core`、`model-gateway`、`persistence`、`sdk`、`auth`、`ecosystem`、`sandbox`、`tui` 或任何 `apps/*`(scripts/check-boundaries.mjs 强制,违反即 CI 失败)。
- `packages/contracts` 不得依赖其他 `@focuscode/*` 包或 Provider SDK。
- 只有 `apps/*` 与 `packages/sdk` 允许组合以上模块;`packages/tui` 是叶子 adapter,不得依赖任何 `@focuscode/*`。
- 契约/schema 变更后必须运行 `pnpm schemas` 并提交 `docs/schemas/`。
- vitest 运行的是 `dist/` 构建产物;任何测试前先 `pnpm --filter <pkg> build`。
- 代码风格:prettier printWidth 100、双引号、semicolon、trailing comma `"all"`;用 `pnpm format` 而非手工排版。
- 覆盖率底线:statements 75 / branches 60 / functions 80 / lines 80。
- TDD:先写失败测试,再实现,再提交;每个 task 独立可合并。

---

## 0. 设计文档 → FocusCode 映射(本计划范围)

| OpenCache 设计组件                  | FocusCode 现状                                                                                                                        | 本计划动作                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| L1 稳定前缀 + Provider prefix cache | ✅ `systemPromptParts` stable/dynamic(agent.ts:1164-1200)+ openai-prefix(model-clients.ts:230-281)/ anthropic-ephemeral(:749-766)注入 | Phase 2: `minPrefixTokens` 生效 + Kimi `prompt_cache_key`  |
| usage/cost 归一化                   | ✅ 四协议→`cachedInputTokens`;`--cost` 面板按 `pricing.cachedInput` 折算(agent-command.ts:807-835)                                    | **Phase 1A**: 命中率/节约额聚合 + 修复 TUI sessionCost bug |
| Cache Epoch / Manifest(设计 §5.3)   | ❌ 零实现                                                                                                                             | **Phase 1B**: 新增 `CacheEpochManifestV1` + churn 追踪     |
| 工具 schema 稳定/懒加载(设计 §8)    | ❌ 每轮全量发送 `registry.definitions()`(agent.ts:414)                                                                                | Phase 3: 稳定工具包 + 经济判定(建议拆分单独 plan)          |
| 经济型 compaction(设计 §7.5)        | ⚠️ 纯 token 压力触发(context.ts:35)                                                                                                   | Phase 3: 注入 miss/hit 价格差(建议拆分)                    |
| tool-result archive(设计 §7.4)      | ⚠️ 工具层截断(tools.ts maxOutputChars),无独立 archive                                                                                 | 不纳入本 plan(独立工程)                                    |
| L3 分布式 KV / Router / LMCache     | ❌ serving 层,与 agent harness 无关                                                                                                   | **不做**(设计文档 §17 承认单机 MVP 不引入)                 |
| Pi / OpenCode / Continue bridges    | ❌ 对外 gateway 化                                                                                                                    | **不做**(超出"落地到 FocusCode 内部")                      |

---

## Phase 1A: Cache Telemetry 经济面板

### Task 1A-1: 纯函数 `cacheMetrics` + `estimateCostUsd`

**Files:**

- Create: `packages/agent-runtime/src/cost.ts`
- Test: `packages/agent-runtime/test/cost.test.ts`

**Interfaces:**

- Consumes: `TokenUsage`(`types.ts:45-49`)、`ModelPricing`(`config.ts:246-250`)
- Produces:
  - `export function cacheMetrics(usage: TokenUsage): { hitRatio: number; uncachedInputTokens: number }`
  - `export function estimateCostUsd(usage: TokenUsage, pricing: ModelPricing | undefined): { inputUsd: number; outputUsd: number; cachedUsd: number; totalUsd: number }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { cacheMetrics, estimateCostUsd } from "../src/cost.js";
import type { TokenUsage } from "../src/types.js";

describe("cacheMetrics", () => {
  it("hitRatio = cachedInputTokens / inputTokens", () => {
    const usage: TokenUsage = { inputTokens: 100, outputTokens: 50, cachedInputTokens: 40 };
    expect(cacheMetrics(usage).hitRatio).toBe(0.4);
  });

  it("uncachedInputTokens subtracts cached from input", () => {
    const usage: TokenUsage = { inputTokens: 100, outputTokens: 50, cachedInputTokens: 40 };
    expect(cacheMetrics(usage).uncachedInputTokens).toBe(60);
  });

  it("hitRatio is 0 when inputTokens is 0", () => {
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    expect(cacheMetrics(usage).hitRatio).toBe(0);
  });
});

describe("estimateCostUsd", () => {
  const pricing = { input: 2.0, output: 8.0, cachedInput: 0.2 };

  it("prices input on the uncached portion, cached on the cache price", () => {
    const usage: TokenUsage = {
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cachedInputTokens: 400_000,
    };
    const c = estimateCostUsd(usage, pricing);
    expect(c.inputUsd).toBeCloseTo(1.2);
    expect(c.outputUsd).toBeCloseTo(4.0);
    expect(c.cachedUsd).toBeCloseTo(0.08);
    expect(c.totalUsd).toBeCloseTo(5.28);
  });

  it("treats all input as uncached when no pricing is given", () => {
    const usage: TokenUsage = { inputTokens: 100, outputTokens: 50, cachedInputTokens: 40 };
    const c = estimateCostUsd(usage, undefined);
    expect(c.totalUsd).toBe(0);
    expect(c.inputUsd).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @focuscode/agent-runtime build && npx vitest run packages/agent-runtime/test/cost.test.ts -v`
Expected: FAIL with "Cannot find module .../cost.js"

- [ ] **Step 3: Write minimal implementation**

```ts
import type { ModelPricing } from "./config.js";
import type { TokenUsage } from "./types.js";

/** 缓存命中率与未命中输入 token 的派生指标。 */
export function cacheMetrics(usage: TokenUsage): { hitRatio: number; uncachedInputTokens: number } {
  const cached = usage.cachedInputTokens ?? 0;
  const hitRatio = usage.inputTokens > 0 ? cached / usage.inputTokens : 0;
  return { hitRatio, uncachedInputTokens: Math.max(0, usage.inputTokens - cached) };
}

/**
 * 按每百万 token 定价折算成本（USD）。input 计费按未命中部分计，
 * cached 段按缓存价计，二者互斥（cachedInputTokens 已包含在 inputTokens 内）。
 * 无 pricing 时全部为 0（与现有 --cost 面板的 "no pricing" 行为一致）。
 */
export function estimateCostUsd(
  usage: TokenUsage,
  pricing: ModelPricing | undefined,
): { inputUsd: number; outputUsd: number; cachedUsd: number; totalUsd: number } {
  if (!pricing) return { inputUsd: 0, outputUsd: 0, cachedUsd: 0, totalUsd: 0 };
  const { uncachedInputTokens } = cacheMetrics(usage);
  const inputUsd = (uncachedInputTokens / 1_000_000) * pricing.input;
  const outputUsd = (usage.outputTokens / 1_000_000) * pricing.output;
  const cachedUsd =
    pricing.cachedInput !== undefined
      ? ((usage.cachedInputTokens ?? 0) / 1_000_000) * pricing.cachedInput
      : 0;
  return { inputUsd, outputUsd, cachedUsd, totalUsd: inputUsd + outputUsd + cachedUsd };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @focuscode/agent-runtime build && npx vitest run packages/agent-runtime/test/cost.test.ts -v`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add packages/agent-runtime/src/cost.ts packages/agent-runtime/test/cost.test.ts
git commit -m "feat(agent-runtime): add cacheMetrics and estimateCostUsd pure functions"
```

### Task 1A-2: `--cost` 面板增强命中率与节约额

**Files:**

- Modify: `apps/cli/src/agent-command.ts:807-835`(`printCostPanel`)
- Test: `apps/cli/test/cost-panel.test.ts`(新建)

**Interfaces:**

- Consumes: `cacheMetrics`/`estimateCostUsd`(Task 1A-1)、`TokenUsage`、`ResolvedAgentConfig.pricing`
- Produces: `printCostPanel` 输出追加 `· cache hit 40% (saved $0.720000)` 段

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { printCostPanel } from "../src/agent-command.js";
import type { TokenUsage } from "@focuscode/agent-runtime";

describe("printCostPanel", () => {
  const pricing = {
    "fixture/model": { input: 2.0, output: 8.0, cachedInput: 0.2 },
  };

  it("reports cache hit ratio and saved USD when cached tokens exist", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const usage: TokenUsage = {
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cachedInputTokens: 400_000,
    };
    printCostPanel(usage, { model: { provider: "fixture", model: "model" }, pricing } as never);
    const out = err.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("cache hit 40%");
    expect(out).toContain("saved $0.800000");
    err.mockRestore();
  });

  it("omits cache segment when no cached tokens", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const usage: TokenUsage = { inputTokens: 1_000_000, outputTokens: 500_000 };
    printCostPanel(usage, { model: { provider: "fixture", model: "model" }, pricing } as never);
    const out = err.mock.calls.map((c) => String(c[0])).join("");
    expect(out).not.toContain("cache hit");
    err.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && npx vitest run apps/cli/test/cost-panel.test.ts -v`
Expected: FAIL — output lacks "cache hit 40%"

- [ ] **Step 3: Write minimal implementation**(替换 `printCostPanel` 的尾部输出)

```ts
export function printCostPanel(usage: TokenUsage, config: ResolvedAgentConfig): void {
  const modelKey = `${config.model.provider}/${config.model.model}`;
  const pricing = config.pricing[modelKey] ?? config.pricing[config.model.model];
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  const cached = usage.cachedInputTokens ?? 0;
  if (!pricing) {
    process.stderr.write(
      `Cost: ${input} input / ${output} output / ${cached} cached tokens — no pricing configured for ${modelKey} (set config.pricing in agent.json)\n`,
    );
    return;
  }
  const { hitRatio } = cacheMetrics(usage);
  const { inputUsd, outputUsd, cachedUsd, totalUsd } = estimateCostUsd(usage, pricing);
  const uncached = Math.max(0, input - cached);
  const savedUsd = hitRatio > 0 ? (input / 1_000_000) * pricing.input - inputUsd : 0;
  const cacheLine =
    hitRatio > 0
      ? ` · cache hit ${Math.round(hitRatio * 100)}% (${cached} cached, saved $${savedUsd.toFixed(6)})`
      : "";
  process.stderr.write(
    `Cost: $${totalUsd.toFixed(6)} (input $${inputUsd.toFixed(6)} @ $${pricing.input.toFixed(2)}/M` +
      ` · output $${outputUsd.toFixed(6)} @ $${pricing.output.toFixed(2)}/M` +
      (pricing.cachedInput !== undefined
        ? ` · cached $${cachedUsd.toFixed(6)} @ $${pricing.cachedInput.toFixed(2)}/M`
        : "") +
      `) — ${uncached} in / ${output} out / ${cached} cached tokens` +
      cacheLine +
      "\n",
  );
}
```

> 注:`savedUsd` 定义 = 若全部按 input 原价计费所需金额 − 实际按 uncached 价计的 input 金额 = `(cached/1M) * pricing.input`。测试断言 `saved $0.800000` = `400000/1M * 2.0`。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && npx vitest run apps/cli/test/cost-panel.test.ts -v`
Expected: PASS, 2 tests

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/agent-command.ts apps/cli/test/cost-panel.test.ts
git commit -m "feat(cli): --cost panel reports cache hit ratio and saved USD"
```

### Task 1A-3: 修复 TUI sessionCost 用 token 数当美元的 bug

**Files:**

- Modify: `apps/cli/src/tui.ts:650-656`(usage 事件 handler)
- Test: `apps/cli/test/tui-cost.test.ts`(新建,或扩展既有)

**Interfaces:**

- Consumes: `estimateCostUsd`(Task 1A-1)、`ResolvedAgentConfig.pricing`
- Produces: `sessionCost` 变量现在持有 **USD 金额**而非 token 数;`tui.setSessionCost(sessionCost, sessionBudget)` 语义保持(见 `packages/tui/src/app.ts:368-373`)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { createTuiCostTracker } from "../src/tui.js"; // 提取出的纯逻辑,见 Step 3
import type { TokenUsage } from "@focuscode/agent-runtime";

describe("tui cost tracking", () => {
  it("converts usage to USD using pricing, not raw token counts", () => {
    const pricing = { input: 2.0, output: 8.0, cachedInput: 0.2 };
    const tracker = createTuiCostTracker({ pricing });
    const usage: TokenUsage = {
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cachedInputTokens: 400_000,
    };
    tracker.add(usage);
    expect(tracker.usd).toBeCloseTo(6.08);
  });

  it("zero cost when no pricing configured", () => {
    const tracker = createTuiCostTracker({ pricing: {} });
    tracker.add({ inputTokens: 100, outputTokens: 50, cachedInputTokens: 40 });
    expect(tracker.usd).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && npx vitest run apps/cli/test/tui-cost.test.ts -v`
Expected: FAIL — `createTuiCostTracker` 不存在

- [ ] **Step 3: Write minimal implementation**

在 `apps/cli/src/tui.ts` 新增纯逻辑并让 usage handler 使用它:

```ts
/** 追踪 TUI 会话成本(USD)。pricing 按 "provider/model" 或裸 model id 解析。 */
export function createTuiCostTracker(config: {
  pricing: Record<string, ModelPricing>;
  modelKey: string;
  modelId: string;
}): { add(usage: TokenUsage): void; usd: number } {
  let usd = 0;
  const pricing = config.pricing[config.modelKey] ?? config.pricing[config.modelId];
  return {
    add(usage: TokenUsage) {
      usd += estimateCostUsd(usage, pricing).totalUsd;
    },
    get usd() {
      return usd;
    },
  };
}
```

在 `tui.ts` 的 usage 事件 handler 中替换 `:654`:

```ts
if (event.type === "usage") {
  sessionCostTracker.add(event.session);
  sessionCost = sessionCostTracker.usd;
  tui.setSessionCost(sessionCost, sessionBudget);
  return;
}
```

并将 `sessionCost` 初始化与 `createTuiCostTracker` 的接线放在 `tui.ts` 顶部(`:201` 附近),`modelKey`/`modelId` 从 `options`/config 取。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && npx vitest run apps/cli/test/tui-cost.test.ts -v`
Expected: PASS, 2 tests

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/tui.ts apps/cli/test/tui-cost.test.ts
git commit -m "fix(cli): TUI session cost now tracks USD via pricing instead of raw token count"
```

### Task 1A-4: workbench Cost 区块显示命中率与节约额

**Files:**

- Modify: `packages/tui/src/renderer-workbench.ts:224-236`(Cost 区块)
- Modify: `packages/tui/src/renderer.ts:51-122`(`TuiRenderState` 增加可选字段)
- Test: `packages/tui/test/renderer-workbench.test.ts`(追加用例)

**Interfaces:**

- Consumes: `TuiRenderState.sessionCost`(USD)、新增可选 `TuiRenderState.cacheMetrics?: { hitRatio: number; savedUsd: number }`
- Produces: Cost 区块在命中率>0 时追加一行 `  ⚡ cache hit 40% · saved $0.72`

- [ ] **Step 1: Write the failing test**(追加到 renderer-workbench.test.ts)

```ts
it("renders cache hit metrics in the Cost block when provided", () => {
  const frame = plain(
    workbenchState({
      sessionCost: 6.08,
      cacheMetrics: { hitRatio: 0.4, savedUsd: 0.72 },
    }),
  );
  expect(frame).toContain("▌Cost");
  expect(frame).toContain("$6.0800");
  expect(frame).toContain("cache hit 40%");
  expect(frame).toContain("saved $0.72");
});

it("omits cache line when no cache metrics", () => {
  const frame = plain(workbenchState({ sessionCost: 0.0032 }));
  expect(frame).toContain("$0.0032");
  expect(frame).not.toContain("cache hit");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @focuscode/tui build && npx vitest run packages/tui/test/renderer-workbench.test.ts -t "Cost block" -v`
Expected: FAIL — "cache hit" 不存在

- [ ] **Step 3: Write minimal implementation**

`renderer.ts` 的 `TuiRenderState` 增加:

```ts
/** 缓存命中率与估算节约额;由 CLI 层用 cacheMetrics/estimateCostUsd 计算后注入。 */
cacheMetrics?: { hitRatio: number; savedUsd: number };
```

`renderer-workbench.ts` 的 Cost 区块:

```ts
if (state.sessionCost !== undefined) {
  lines.push(bold(fg(theme.accent, " ▌Cost")));
  lines.push(
    fg(
      theme.success,
      "  $" +
        state.sessionCost.toFixed(4) +
        (state.sessionBudget ? " / $" + state.sessionBudget.toFixed(2) : ""),
    ),
  );
  if (state.cacheMetrics && state.cacheMetrics.hitRatio > 0) {
    lines.push(
      fg(
        theme.secondary,
        "  ⚡ cache hit " +
          Math.round(state.cacheMetrics.hitRatio * 100) +
          "% · saved $" +
          state.cacheMetrics.savedUsd.toFixed(2),
      ),
    );
  }
}
```

`apps/cli/src/tui.ts` usage handler 中注入:`tui.setSessionCost(sessionCost, sessionBudget)` 之后追加 `tui.setCacheMetrics?.({ hitRatio, savedUsd })`(TUI app 增加同名 setter,见 Step 3 可选——若 `FullScreenTui` 无此 setter,先加一个 `setCacheMetrics(metrics: { hitRatio: number; savedUsd: number })` 到 `packages/tui/src/app.ts`)。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @focuscode/tui build && npx vitest run packages/tui/test/renderer-workbench.test.ts -t "Cost block" -v`
Expected: PASS, 2 tests

- [ ] **Step 5: Commit**

```bash
git add packages/tui/src/renderer.ts packages/tui/src/renderer-workbench.ts packages/tui/src/app.ts apps/cli/src/tui.ts packages/tui/test/renderer-workbench.test.ts
git commit -m "feat(tui): workbench Cost block shows cache hit ratio and saved USD"
```

---

## Phase 1B: Cache Epoch + 稳定前缀指纹

### Task 1B-1: contracts 新增 `CacheEpochManifestV1`

**Files:**

- Modify: `packages/contracts/src/schemas.ts`(追加 schema)
- Test: `packages/contracts/test/cache-epoch.test.ts`(新建)

**Interfaces:**

- Produces: `export const CacheEpochManifestSchema = Type.Object({...})`、`export type CacheEpochManifestV1 = Static<typeof CacheEpochManifestSchema>`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { CacheEpochManifestSchema, type CacheEpochManifestV1 } from "../src/schemas.js";
import { Type } from "@sinclair/typebox";

describe("CacheEpochManifestV1", () => {
  const manifest: CacheEpochManifestV1 = {
    schemaVersion: "cache-epoch.v1",
    modelRevision: "kimi-k3-2026-06-15",
    chatTemplateHash: "a1b2",
    toolBundleHash: "c3d4",
    systemHash: "e5f6",
    reasoningProtocol: "openai",
    toolProtocol: "openai-chat",
    cacheMode: "openai-prefix",
  };

  it("validates a well-formed manifest", () => {
    expect(() => Type.Clone(CacheEpochManifestSchema).parse(manifest)).not.toThrow();
  });

  it("accepts optional protocol fields omitted", () => {
    const minimal: CacheEpochManifestV1 = {
      schemaVersion: "cache-epoch.v1",
      modelRevision: "m",
      toolBundleHash: "x",
      systemHash: "y",
    };
    expect(() => Type.Clone(CacheEpochManifestSchema).parse(minimal)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @focuscode/contracts build && npx vitest run packages/contracts/test/cache-epoch.test.ts -v`
Expected: FAIL — schema 不存在

- [ ] **Step 3: Write minimal implementation**(追加到 schemas.ts,紧邻 `UsageRecordSchema`)

```ts
export const CacheEpochManifestSchema = Type.Object(
  {
    schemaVersion: Type.Literal("cache-epoch.v1"),
    /** 模型 revision;来自 ModelProfile.revision。 */
    modelRevision: Type.String({ minLength: 1 }),
    /** chat template 指纹;暂用 provider+protocol 组合的 hash 占位。 */
    chatTemplateHash: Type.Optional(Type.String()),
    /** 核心工具 schema 的稳定指纹(JSON canonical sha256)。 */
    toolBundleHash: Type.String({ minLength: 1 }),
    /** stable system 段(含 instructions/extensionPrompt)的 sha256。 */
    systemHash: Type.String({ minLength: 1 }),
    /** thinkingFormat 方言("openai"|"deepseek"|"qwen"|"zai")。 */
    reasoningProtocol: Type.Optional(Type.String()),
    /** wire protocol("openai-chat"|"anthropic-messages"|...)。 */
    toolProtocol: Type.Optional(Type.String()),
    /** cacheControl.mode("openai-prefix"|"anthropic-ephemeral"|"none")。 */
    cacheMode: Type.Optional(Type.String()),
  },
  Strict,
);
export type CacheEpochManifestV1 = Static<typeof CacheEpochManifestSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @focuscode/contracts build && npx vitest run packages/contracts/test/cache-epoch.test.ts -v`
Expected: PASS, 2 tests

- [ ] **Step 5: Regenerate schemas + commit**

```bash
pnpm schemas
git add packages/contracts/src/schemas.ts packages/contracts/test/cache-epoch.test.ts docs/schemas/
git commit -m "feat(contracts): CacheEpochManifestV1 schema for stable-prefix fingerprints"
```

### Task 1B-2: agent-runtime 新增 `cache-epoch.ts`

**Files:**

- Create: `packages/agent-runtime/src/cache-epoch.ts`
- Test: `packages/agent-runtime/test/cache-epoch.test.ts`(新建)

**Interfaces:**

- Consumes: `CacheEpochManifestV1`(Task 1B-1)、`ToolDefinition`/`ModelProfile`/`ProviderCompatibility`(`types.ts`)、`systemPromptParts` 的 stable 段
- Produces:
  - `export function stableHash(value: string): string`(sha256 前 16 hex)
  - `export function computeEpochManifest(args: { modelRevision: string; systemStable: string; toolDefinitions: ToolDefinition[]; compatibility: ProviderCompatibility | undefined }): CacheEpochManifestV1`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { computeEpochManifest, stableHash } from "../src/cache-epoch.js";
import type { ProviderCompatibility, ToolDefinition } from "../src/types.js";

describe("stableHash", () => {
  it("is deterministic and length-bounded", () => {
    const h1 = stableHash("stable system prompt");
    expect(h1).toBe(stableHash("stable system prompt"));
    expect(h1).toMatch(/^[0-9a-f]{16}$/);
    expect(h1).not.toBe(stableHash("stable system prompt "));
  });
});

describe("computeEpochManifest", () => {
  const tools: ToolDefinition[] = [
    {
      name: "read",
      label: "Read",
      description: "read file",
      parameters: { type: "object" },
      effect: "read",
    },
  ];

  it("produces identical manifest for identical inputs", () => {
    const a = computeEpochManifest({
      modelRevision: "r1",
      systemStable: "S",
      toolDefinitions: tools,
    });
    const b = computeEpochManifest({
      modelRevision: "r1",
      systemStable: "S",
      toolDefinitions: tools,
    });
    expect(a).toEqual(b);
  });

  it("changes toolBundleHash when tool schema changes", () => {
    const a = computeEpochManifest({
      modelRevision: "r1",
      systemStable: "S",
      toolDefinitions: tools,
    });
    const b = computeEpochManifest({
      modelRevision: "r1",
      systemStable: "S",
      toolDefinitions: [
        ...tools,
        { name: "write", label: "Write", description: "w", parameters: {}, effect: "write" },
      ],
    });
    expect(a.toolBundleHash).not.toBe(b.toolBundleHash);
    expect(a.systemHash).toBe(b.systemHash);
  });

  it("changes systemHash when stable system changes", () => {
    const a = computeEpochManifest({
      modelRevision: "r1",
      systemStable: "S",
      toolDefinitions: tools,
    });
    const b = computeEpochManifest({
      modelRevision: "r1",
      systemStable: "S2",
      toolDefinitions: tools,
    });
    expect(a.systemHash).not.toBe(b.systemHash);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @focuscode/agent-runtime build && npx vitest run packages/agent-runtime/test/cache-epoch.test.ts -v`
Expected: FAIL — module 不存在

- [ ] **Step 3: Write minimal implementation**

```ts
import { createHash } from "node:crypto";
import type { CacheEpochManifestV1 } from "@focuscode/contracts";
import type { ProviderCompatibility, ToolDefinition } from "./types.js";

/** sha256 前 16 位 hex;用于稳定前缀指纹(非安全用途,仅内容寻址比较)。 */
export function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** 计算当前 cache epoch 的兼容性指纹。任一输入变化都产生新 epoch。 */
export function computeEpochManifest(args: {
  modelRevision: string;
  systemStable: string;
  toolDefinitions: ToolDefinition[];
  compatibility: ProviderCompatibility | undefined;
}): CacheEpochManifestV1 {
  const toolBundle = JSON.stringify(
    args.toolDefinitions.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      effect: t.effect,
    })),
  );
  const compat = args.compatibility;
  return {
    schemaVersion: "cache-epoch.v1",
    modelRevision: args.modelRevision || "unknown",
    chatTemplateHash: stableHash(compat?.thinkingFormat ?? "default"),
    toolBundleHash: stableHash(toolBundle),
    systemHash: stableHash(args.systemStable),
    reasoningProtocol: compat?.thinkingFormat,
    toolProtocol: undefined, // 由调用方从 ModelProfile.protocol 填充
    cacheMode: compat?.cacheControl?.mode,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @focuscode/agent-runtime build && npx vitest run packages/agent-runtime/test/cache-epoch.test.ts -v`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add packages/agent-runtime/src/cache-epoch.ts packages/agent-runtime/test/cache-epoch.test.ts
git commit -m "feat(agent-runtime): cache epoch manifest with stable-prefix fingerprints"
```

### Task 1B-3: CodingAgent 每轮追踪 epoch churn

**Files:**

- Modify: `packages/agent-runtime/src/agent.ts`(在 `submit`/round 循环中计算 manifest,记录 churn)
- Modify: `packages/agent-runtime/src/types.ts`(`CodingAgentOptions` 或 agent 状态,暴露诊断)
- Test: `packages/agent-runtime/test/cache-epoch.test.ts`(追加)

**Interfaces:**

- Consumes: `computeEpochManifest`(Task 1B-2)、`systemPromptParts().stable`
- Produces:
  - `getCacheDiagnostics(): { current: CacheEpochManifestV1; lastChanged: number; churnReasons: string[] }`
  - agent 每次 `submit`/round 计算一次 manifest;与上次比对,若 `toolBundleHash`/`systemHash`/`modelRevision` 变化则 push 一条 churn reason 并更新时间戳。

- [ ] **Step 1: Write the failing test**(追加到 cache-epoch.test.ts)

```ts
it("agent tracks epoch churn when tools change between rounds", async () => {
  // 构造一个 agent:先注册 1 个工具,submit 一轮;再注册第 2 个工具,再 submit 一轮。
  // 断言 getCacheDiagnostics().churnReasons 至少包含一次 tool bundle 变化。
  // (具体构造依赖 CodingAgent 的 submit/event sink 接线,按现有 agent.test.ts 的 fixture 模式搭建。)
});
```

> 说明:此测试依赖现有 `CodingAgent` 测试夹具。若 agent.test.ts 的 fixture 构造成本过高,可降级为对 `computeEpochManifest` 的两个快照断言 + 手动调用 `trackEpochChange(prev, next)` 纯函数的单元测试。实现时优先纯函数:`export function diffEpochs(prev: CacheEpochManifestV1, next: CacheEpochManifestV1): string[]`(返回变化的字段名列表)。

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @focuscode/agent-runtime build && npx vitest run packages/agent-runtime/test/cache-epoch.test.ts -v`
Expected: FAIL — `diffEpochs` 未定义

- [ ] **Step 3: Write minimal implementation**(cache-epoch.ts 追加)

```ts
/** 返回 prev→next 之间变化的字段名(用于 churn 诊断)。无变化返回空数组。 */
export function diffEpochs(prev: CacheEpochManifestV1, next: CacheEpochManifestV1): string[] {
  const fields = [
    "modelRevision",
    "chatTemplateHash",
    "toolBundleHash",
    "systemHash",
    "reasoningProtocol",
    "toolProtocol",
    "cacheMode",
  ] as const;
  return fields.filter((field) => prev[field] !== next[field]);
}
```

并在 `agent.ts` 的 round 循环入口(调用 `systemPromptParts` 之后)接入:

```ts
const epoch = computeEpochManifest({
  modelRevision: this.model.revision ?? this.model.model,
  systemStable: parts.stable,
  toolDefinitions: this.registry.definitions(),
  compatibility: this.model.compatibility,
});
const changed = this.lastEpoch ? diffEpochs(this.lastEpoch, epoch) : [];
if (changed.length > 0) {
  this.epochChurn.push({ at: Date.now(), changed });
}
this.lastEpoch = epoch;
```

并暴露 `getCacheDiagnostics()`(返回 `{ current, lastChanged, churnReasons }`)。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @focuscode/agent-runtime build && npx vitest run packages/agent-runtime/test/cache-epoch.test.ts -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/agent-runtime/src/cache-epoch.ts packages/agent-runtime/src/agent.ts packages/agent-runtime/test/cache-epoch.test.ts
git commit -m "feat(agent-runtime): track cache epoch churn per round"
```

---

## Phase 2: Provider 缓存协议补丁(建议拆分单独 plan)

范围与关键接口(不展开 TDD steps,执行时按本计划模板补全):

- **Task 2-1: Kimi `prompt_cache_key`** — 在 `config.ts` kimi/kimi-cn preset 的 `compatibility` 增加 `promptCacheKeyField?: string`;`buildOpenAIRequest` 在 openai-prefix 分支把稳定 session/task id 写入 `body.prompt_cache_key`(session id 来自调用方传入,需在 `ModelRequest` 增加 `cacheKey?: string`)。Kimi 官方文档:稳定 session/task ID 作 `prompt_cache_key`,恢复会话保持不变。
- **Task 2-2: `minPrefixTokens` 生效** — `buildOpenAIRequest` 在 `mode==="openai-prefix"` 时若 `systemPromptParts.stable` 估算 token 低于 `minPrefixTokens`,退化为单块 system prompt(不切分),避免小请求白增加首条 message 开销。估算复用 `context.ts` 的 `estimateMessage` 思路(字符数/4)。
- **Task 2-3: 工具 schema 稳定化诊断** — 在 Task 1B-3 的 `getCacheDiagnostics` 基础上,输出每轮 `toolSchemaChars` 变化,标识哪些轮次因 MCP 连接/工具注册变化导致 epoch churn。

## Phase 3: 工具 schema 经济性 + 经济型 compaction(建议拆分单独 plan)

范围与关键接口:

- **Task 3-1: 稳定工具包固定** — `createCodingToolRegistry` 产出的核心 12 工具 schema 冻结(JSON 序列化顺序稳定),扩展工具(MCP/skills/team)按 `task stage` 批量进入新 epoch 而非每轮增删。验收:同一会话内 `toolBundleHash` 在无工具注册变化时不漂移(用 Task 1B-2 的 `computeEpochManifest` 断言)。
- **Task 3-2: 经济型 compaction gate** — `ConversationContext.compile`(`context.ts:35`)的 `shouldCompact` 增加定价参数:`shouldCompact(estimatedTokens, usable, branchLength, { missPrice, hitPrice, expectedRemainingTurns })`,当 `missCostSavings > summaryCost + warmupCost + riskMargin` 时提前压缩。`estimateCostUsd`(Task 1A-1)提供价格基数。
- **Task 3-3: (后续) tool_search/describe/invoke MVP** — 设计文档 §8 策略 A:顶层固定 3 个代理工具,具体工具 schema 按需 `tool_describe` 注入。这是独立大工程,建议单独 plan。

---

## Self-Review

**Spec coverage(对照设计文档):**

- §13 可观测性 → Phase 1A(cache hit ratio / saved USD / cost-per-turn 的前置纯函数)+ 1B(prefix churn reason)✓
- §5.3 Cache Epoch → Phase 1B ✓
- §9.1 Kimi prompt_cache_key → Phase 2-1(拆分)✓
- §8 工具 schema 稳定 → Phase 3-1/3-3(拆分)✓
- §7.5 经济 compaction → Phase 3-2(拆分)✓
- §3.3/3.4 分布式 KV/LMCache、§10.2-10.5 外部 Agent bridges → 明确不做(超出 FocusCode 内部)✓
- §5.1 Canonical IR(存 ProviderRaw)→ FocusCode 已有 `AgentMessage.providerState` 原生保存原始 reasoning/thinking 块,不重复建设 ✓

**Placeholder scan:** Phase 1A/1B 全部步骤含完整代码;Phase 2/3 明确标注"拆分单独 plan",仅给接口方向,不含"TBD"占位。Task 1B-3 的集成测试标注了降级方案(纯函数 `diffEpochs`),非占位。

**Type consistency:** `cacheMetrics`/`estimateCostUsd`/`computeEpochManifest`/`diffEpochs`/`CacheEpochManifestV1` 名称与签名在 Task 间一致;`sessionCost` 语义在 Task 1A-3 后统一为 USD(与 `--cost` 面板一致)。
