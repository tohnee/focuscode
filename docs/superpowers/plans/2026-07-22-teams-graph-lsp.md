# Agent Teams + Graph DAG + LSP 多语言诊断 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-v6-subagent-driven-development (recommended) or superpowers-v6-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 FocusCode agent-runtime 增加多语言诊断适配层（LSP）、任务依赖图调度（Graph DAG）、多代理协作编排（Agent Teams），使其从"功能完整的 Coding Agent Beta"进入"可验证的企业级 Coding Agent Runtime"。

**Architecture:** 三个独立子系统放在 `packages/agent-runtime/src/`，遵循现有架构边界（不依赖 harness-core/model-gateway/persistence/sdk/auth/ecosystem/sandbox/tui）。

- **LSP 多语言诊断**：把 `diagnostics.ts` 从硬编码 `tsc --noEmit` 重构为 `DiagnosticProvider` 注册机制，内置 TypeScript/Python/Go/Rust 四个 provider，每个 provider 运行时探测工具链可用性（fail-quiet），不引入硬依赖。
- **Graph DAG**：新建 `graph.ts`，提供 `TaskGraph` 数据结构（节点+边）、拓扑排序、循环检测、并行执行器（无依赖节点并发，有依赖节点串行）、失败策略（fail-fast / continue-on-error）。与 Loop 集成：每个节点执行器可以是 delegate/loop/普通函数。
- **Agent Teams**：新建 `team.ts`，定义 `AgentRole`（角色+指令+工具子集）、`TeamPlan`（角色+任务列表+依赖）、`runAgentTeam` 编排器。复用 `DelegateContext.createAgent` 机制创建子代理，复用 `runTaskGraph` 调度任务依赖。

三个子系统可独立实施，也可按 Phase 顺序推进。Agent Teams 依赖 Graph DAG（team 内部任务用 graph 调度），Graph DAG 独立于 LSP，LSP 独立于两者。

**Tech Stack:** TypeScript ESM, vitest, 现有 AgentTool/ToolDefinition 接口, 现有 config.ts 配置模式, 现有 delegate.ts DelegateContext 机制。

## Global Constraints

- Node >=22.12.0, pnpm 11.7.0, TypeScript strict（`exactOptionalPropertyTypes: true` — 所有可选属性类型显式加 `| undefined`）
- 遵循 `scripts/check-boundaries.mjs`：agent-runtime 不依赖 harness-core/model-gateway/persistence/sdk/auth/ecosystem/sandbox/tui
- Prettier: printWidth 100, 双引号, semicolon, trailing comma "all"
- 测试位置: `packages/agent-runtime/test/`
- 覆盖率阈值: statements 75 / branches 60 / functions 80 / lines 80
- 全 ESM, 包入口 dist/index.js
- 诊断 provider 运行时探测工具链，不引入硬依赖（missing tool → `{ ran: false }`，fail-quiet）
- config.ts 变更必须向后兼容（现有 `agent.diagnostics: boolean` 仍可用）
- 子代理复用 `DelegateContext.createAgent`，不绕过权限/沙箱边界
- 不引入对 ruff/pyright/gopls/cargo 等外部工具的 npm 依赖

---

## File Structure

### Phase 2A: LSP 多语言诊断

- Create: `packages/agent-runtime/src/diagnostic-providers.ts` — DiagnosticProvider 接口与内置 provider 注册表
- Modify: `packages/agent-runtime/src/diagnostics.ts` — 重构为遍历 provider 注册表，合并结果
- Modify: `packages/agent-runtime/src/config.ts` — 扩展 `agent.diagnostics` 配置（boolean | object 向后兼容）
- Modify: `packages/agent-runtime/src/agent.ts` — 诊断标签从硬编码 `tsc --noEmit` 改为动态 provider id
- Create: `packages/agent-runtime/test/diagnostic-providers.test.ts` — provider 单元测试
- Modify: `packages/agent-runtime/test/config-resources-extensions.test.ts` — 添加多语言诊断配置测试

### Phase 2B: Graph DAG 任务调度

- Create: `packages/agent-runtime/src/graph.ts` — TaskGraph 数据结构、拓扑排序、并行执行器
- Create: `packages/agent-runtime/test/graph.test.ts` — Graph 单元与集成测试
- Modify: `packages/agent-runtime/src/index.ts` — 导出 graph 模块
- Modify: `packages/agent-runtime/src/agent.ts` — 注册 `graph` 工具
- Modify: `packages/agent-runtime/src/config.ts` — 添加 graph 配置字段

### Phase 2C: Agent Teams 多代理协作

- Create: `packages/agent-runtime/src/team.ts` — AgentRole、TeamPlan、runAgentTeam 编排器
- Create: `packages/agent-runtime/test/team.test.ts` — Team 单元与集成测试
- Modify: `packages/agent-runtime/src/index.ts` — 导出 team 模块
- Modify: `packages/agent-runtime/src/agent.ts` — 注册 `team` 工具
- Modify: `packages/agent-runtime/src/config.ts` — 添加 team 配置字段

### Phase 3: 集成验收

- Modify: `packages/agent-runtime/test/config-resources-extensions.test.ts` — 添加 teams/graph 配置测试
- Modify: `docs/superpowers/plans/2026-07-22-teams-graph-lsp.md` — 记录执行进度

---

## Phase 2A: LSP 多语言诊断

当前 `diagnostics.ts` 硬编码 `tsc --noEmit`，仅支持 TypeScript。目标是抽象出 `DiagnosticProvider` 接口，内置多语言 provider，运行时探测工具链可用性。

### Task 1: DiagnosticProvider 接口与 TypeScript provider 重构

**Files:**

- Create: `packages/agent-runtime/src/diagnostic-providers.ts`
- Create: `packages/agent-runtime/test/diagnostic-providers.test.ts`

**Interfaces:**

- Produces: `DiagnosticProvider`, `DiagnosticProviderResult`, `BUILTIN_DIAGNOSTIC_PROVIDERS`, `createTypeScriptProvider`

- [x] **Step 1: 写失败测试**

```typescript
// packages/agent-runtime/test/diagnostic-providers.test.ts
import { describe, expect, it } from "vitest";
import {
  BUILTIN_DIAGNOSTIC_PROVIDERS,
  createTypeScriptProvider,
  type DiagnosticProvider,
} from "../src/diagnostic-providers.js";

describe("diagnostic providers", () => {
  it("creates a TypeScript provider with correct id", () => {
    const provider = createTypeScriptProvider();
    expect(provider.id).toBe("typescript");
    expect(provider.label).toBe("tsc --noEmit");
  });

  it("detects TypeScript project by tsconfig.json", async () => {
    const provider = createTypeScriptProvider();
    // 项目根目录有 tsconfig.json
    expect(await provider.detect(process.cwd())).toBe(true);
  });

  it("does not detect non-TypeScript project", async () => {
    const provider = createTypeScriptProvider();
    // /tmp 没有 tsconfig.json
    expect(await provider.detect("/tmp")).toBe(false);
  });

  it("registers built-in providers", () => {
    const ids = BUILTIN_DIAGNOSTIC_PROVIDERS.map((p) => p.id);
    expect(ids).toContain("typescript");
    expect(ids).toContain("python");
    expect(ids).toContain("go");
    expect(ids).toContain("rust");
  });

  it("runs TypeScript diagnostics and returns output on success", async () => {
    const provider = createTypeScriptProvider();
    // 本仓库是有效的 TypeScript 项目，tsc --noEmit 可能返回 0（无错误）
    // 或非 0（有错误），但 ran 应为 true
    const result = await provider.run(process.cwd(), 60_000);
    expect(result.ran).toBe(true);
    // output 可能有也可能没有（取决于是否有类型错误）
    expect(typeof result.output).toBe("string");
  });
});
```

- [x] **Step 2: 运行测试验证失败**

Run: `pnpm build && npx vitest run packages/agent-runtime/test/diagnostic-providers.test.ts`
Expected: FAIL with "Cannot find module '../src/diagnostic-providers.js'"

- [x] **Step 3: 最小实现**

```typescript
// packages/agent-runtime/src/diagnostic-providers.ts
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { runProcess } from "./tools.js";

export interface DiagnosticProviderResult {
  ran: boolean;
  output?: string | undefined;
}

/**
 * A language-agnostic diagnostic provider. Each provider detects whether the
 * workspace is a project for its language (e.g. tsconfig.json for TypeScript,
 * pyproject.toml for Python) and runs the appropriate linter/type-checker.
 *
 * Providers must be fail-quiet: missing toolchain, spawn failures and timeouts
 * all resolve to `{ ran: false }`, never throw.
 */
export interface DiagnosticProvider {
  /** Stable identifier used in config and diagnostics labels, e.g. "typescript". */
  readonly id: string;
  /** Human-readable label for the diagnostics banner, e.g. "tsc --noEmit". */
  readonly label: string;
  /** True when the workspace looks like a project for this provider's language. */
  detect(cwd: string): Promise<boolean>;
  /** Run diagnostics; never throws. */
  run(cwd: string, timeoutMs?: number): Promise<DiagnosticProviderResult>;
}

const MAX_OUTPUT_CHARS = 8_000;

/** TypeScript provider: `tsc --noEmit --pretty false`. */
export function createTypeScriptProvider(): DiagnosticProvider {
  const tscCache = new Map<string, string | undefined>();

  async function resolveTsc(cwd: string): Promise<string | undefined> {
    if (tscCache.has(cwd)) return tscCache.get(cwd);
    const executable = process.platform === "win32" ? "tsc.cmd" : "tsc";
    let found: string | undefined;
    const local = join(cwd, "node_modules", ".bin", executable);
    if (await exists(local)) {
      found = local;
    } else {
      try {
        const probe = spawnSync(executable, ["--version"], { stdio: "ignore" });
        if (probe.status === 0) found = executable;
      } catch {
        found = undefined;
      }
    }
    tscCache.set(cwd, found);
    return found;
  }

  return {
    id: "typescript",
    label: "tsc --noEmit",
    async detect(cwd) {
      return exists(join(cwd, "tsconfig.json"));
    },
    async run(cwd, timeoutMs = 30_000) {
      if (!(await exists(join(cwd, "tsconfig.json")))) return { ran: false };
      const tsc = await resolveTsc(cwd);
      if (!tsc) return { ran: false };
      try {
        const result = await runProcess(tsc, ["--noEmit", "--pretty", "false"], {
          cwd,
          timeoutMs,
          maxOutputChars: MAX_OUTPUT_CHARS,
          signal: undefined,
        });
        if (result.timedOut) return { ran: true };
        const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
        return output ? { ran: true, output } : { ran: true };
      } catch {
        return { ran: false };
      }
    },
  };
}

/** Python provider: `ruff check --output-format concise` (fallback: `pyright`). */
export function createPythonProvider(): DiagnosticProvider {
  return {
    id: "python",
    label: "ruff check",
    async detect(cwd) {
      return (
        (await exists(join(cwd, "pyproject.toml"))) ||
        (await exists(join(cwd, "setup.py"))) ||
        (await exists(join(cwd, "requirements.txt")))
      );
    },
    async run(cwd, timeoutMs = 30_000) {
      if (!(await exists(join(cwd, "pyproject.toml")))) {
        if (!(await exists(join(cwd, "setup.py")))) {
          if (!(await exists(join(cwd, "requirements.txt")))) return { ran: false };
        }
      }
      const ruff = await resolveBinary("ruff", cwd);
      if (!ruff) return { ran: false };
      try {
        const result = await runProcess(ruff, ["check", "--output-format", "concise", "."], {
          cwd,
          timeoutMs,
          maxOutputChars: MAX_OUTPUT_CHARS,
          signal: undefined,
        });
        if (result.timedOut) return { ran: true };
        const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
        return output ? { ran: true, output } : { ran: true };
      } catch {
        return { ran: false };
      }
    },
  };
}

/** Go provider: `go vet ./...`. */
export function createGoProvider(): DiagnosticProvider {
  return {
    id: "go",
    label: "go vet",
    async detect(cwd) {
      return exists(join(cwd, "go.mod"));
    },
    async run(cwd, timeoutMs = 30_000) {
      if (!(await exists(join(cwd, "go.mod")))) return { ran: false };
      const go = await resolveBinary("go", cwd);
      if (!go) return { ran: false };
      try {
        const result = await runProcess(go, ["vet", "./..."], {
          cwd,
          timeoutMs,
          maxOutputChars: MAX_OUTPUT_CHARS,
          signal: undefined,
        });
        if (result.timedOut) return { ran: true };
        const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
        return output ? { ran: true, output } : { ran: true };
      } catch {
        return { ran: false };
      }
    },
  };
}

/** Rust provider: `cargo check --message-format short`. */
export function createRustProvider(): DiagnosticProvider {
  return {
    id: "rust",
    label: "cargo check",
    async detect(cwd) {
      return exists(join(cwd, "Cargo.toml"));
    },
    async run(cwd, timeoutMs = 60_000) {
      if (!(await exists(join(cwd, "Cargo.toml")))) return { ran: false };
      const cargo = await resolveBinary("cargo", cwd);
      if (!cargo) return { ran: false };
      try {
        const result = await runProcess(cargo, ["check", "--message-format", "short"], {
          cwd,
          timeoutMs,
          maxOutputChars: MAX_OUTPUT_CHARS,
          signal: undefined,
        });
        if (result.timedOut) return { ran: true };
        const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
        return output ? { ran: true, output } : { ran: true };
      } catch {
        return { ran: false };
      }
    },
  };
}

/**
 * All built-in diagnostic providers in priority order. The agent runtime
 * iterates this list, runs `detect()` on each, and collects output from every
 * provider that reports a positive detection.
 */
export const BUILTIN_DIAGNOSTIC_PROVIDERS: DiagnosticProvider[] = [
  createTypeScriptProvider(),
  createPythonProvider(),
  createGoProvider(),
  createRustProvider(),
];

async function resolveBinary(name: string, cwd: string): Promise<string | undefined> {
  const executable = process.platform === "win32" ? `${name}.exe` : name;
  const local = join(cwd, "node_modules", ".bin", executable);
  if (await exists(local)) return local;
  try {
    const probe = spawnSync(executable, ["--version"], { stdio: "ignore" });
    if (probe.status === 0 || probe.status === 1) return executable;
  } catch {
    // fall through
  }
  return undefined;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
```

- [x] **Step 4: 运行测试验证通过**

Run: `pnpm build && npx vitest run packages/agent-runtime/test/diagnostic-providers.test.ts`
Expected: PASS

- [x] **Step 5: 提交**

```bash
git add packages/agent-runtime/src/diagnostic-providers.ts packages/agent-runtime/test/diagnostic-providers.test.ts
git commit -m "feat(agent-runtime): add multi-language diagnostic providers"
```

---

### Task 2: 重构 diagnostics.ts 使用 provider 注册表

**Files:**

- Modify: `packages/agent-runtime/src/diagnostics.ts`
- Modify: `packages/agent-runtime/test/diagnostic-providers.test.ts` (添加集成测试)

**Interfaces:**

- Consumes: `DiagnosticProvider`, `BUILTIN_DIAGNOSTIC_PROVIDERS` from diagnostic-providers.ts
- Produces: `DiagnosticsResult`（保持现有接口不变）, `runDiagnosticsAll`（新函数，返回多 provider 结果）

- [x] **Step 1: 写失败测试**

在 `packages/agent-runtime/test/diagnostic-providers.test.ts` 末尾追加：

```typescript
import { runDiagnostics, runDiagnosticsAll, shouldRunDiagnostics } from "../src/diagnostics.js";

describe("diagnostics integration with providers", () => {
  it("shouldRunDiagnostics returns true when any provider detects", async () => {
    // 本仓库是 TypeScript 项目
    expect(await shouldRunDiagnostics(process.cwd())).toBe(true);
  });

  it("runDiagnostics returns ran:true for TypeScript project", async () => {
    const result = await runDiagnostics(process.cwd(), 60_000);
    expect(result.ran).toBe(true);
  });

  it("runDiagnosticsAll returns results keyed by provider id", async () => {
    const results = await runDiagnosticsAll(process.cwd(), 60_000);
    expect(results.length).toBeGreaterThan(0);
    const tsResult = results.find((r) => r.providerId === "typescript");
    expect(tsResult).toBeDefined();
    expect(tsResult!.ran).toBe(true);
  });

  it("runDiagnosticsAll filters by provider ids when given", async () => {
    const results = await runDiagnosticsAll(process.cwd(), 60_000, ["typescript"]);
    expect(results).toHaveLength(1);
    expect(results[0]!.providerId).toBe("typescript");
  });
});
```

- [x] **Step 2: 运行测试验证失败**

Run: `pnpm build && npx vitest run packages/agent-runtime/test/diagnostic-providers.test.ts`
Expected: FAIL with "runDiagnosticsAll is not a function" or "does not export runDiagnosticsAll"

- [x] **Step 3: 重构 diagnostics.ts**

```typescript
// packages/agent-runtime/src/diagnostics.ts
import { BUILTIN_DIAGNOSTIC_PROVIDERS, type DiagnosticProvider } from "./diagnostic-providers.js";

export interface DiagnosticsResult {
  ran: boolean;
  output?: string | undefined;
}

export interface MultiDiagnosticsResult {
  providerId: string;
  label: string;
  ran: boolean;
  output?: string | undefined;
}

/**
 * True when any registered diagnostic provider detects the workspace as a
 * project for its language. Kept for backward compatibility with agent.ts.
 */
export async function shouldRunDiagnostics(cwd: string): Promise<boolean> {
  for (const provider of BUILTIN_DIAGNOSTIC_PROVIDERS) {
    if (await provider.detect(cwd)) return true;
  }
  return false;
}

/**
 * Run the first detecting provider (backward-compatible: returns a single
 * result like the old tsc-only path). Prefer `runDiagnosticsAll` for
 * multi-language workspaces.
 */
export async function runDiagnostics(cwd: string, timeoutMs = 30_000): Promise<DiagnosticsResult> {
  for (const provider of BUILTIN_DIAGNOSTIC_PROVIDERS) {
    if (!(await provider.detect(cwd))) continue;
    const result = await provider.run(cwd, timeoutMs);
    if (result.ran) return result;
  }
  return { ran: false };
}

/**
 * Run every provider that detects the workspace, optionally filtered by an
 * explicit provider id list. Returns one entry per detecting provider.
 */
export async function runDiagnosticsAll(
  cwd: string,
  timeoutMs = 30_000,
  providerFilter?: string[],
): Promise<MultiDiagnosticsResult[]> {
  const providers = providerFilter
    ? BUILTIN_DIAGNOSTIC_PROVIDERS.filter((p) => providerFilter.includes(p.id))
    : BUILTIN_DIAGNOSTIC_PROVIDERS;
  const results: MultiDiagnosticsResult[] = [];
  for (const provider of providers) {
    if (!(await provider.detect(cwd))) continue;
    const result = await provider.run(cwd, timeoutMs);
    results.push({
      providerId: provider.id,
      label: provider.label,
      ran: result.ran,
      ...(result.output ? { output: result.output } : {}),
    });
  }
  return results;
}

/**
 * Register a custom diagnostic provider at runtime. Composition roots or
 * extensions can use this to add language support without modifying the
 * built-in list.
 */
export function registerDiagnosticProvider(provider: DiagnosticProvider): void {
  if (!BUILTIN_DIAGNOSTIC_PROVIDERS.some((p) => p.id === provider.id)) {
    BUILTIN_DIAGNOSTIC_PROVIDERS.push(provider);
  }
}
```

- [x] **Step 4: 运行测试验证通过**

Run: `pnpm build && npx vitest run packages/agent-runtime/test/diagnostic-providers.test.ts`
Expected: PASS

- [x] **Step 5: 提交**

```bash
git add packages/agent-runtime/src/diagnostics.ts packages/agent-runtime/test/diagnostic-providers.test.ts
git commit -m "refactor(agent-runtime): diagnostics uses provider registry"
```

---

### Task 3: config.ts 与 agent.ts 多语言诊断集成

**Files:**

- Modify: `packages/agent-runtime/src/config.ts`
- Modify: `packages/agent-runtime/src/agent.ts`
- Modify: `packages/agent-runtime/test/config-resources-extensions.test.ts`

**Interfaces:**

- Consumes: `runDiagnosticsAll` from diagnostics.ts
- Produces: `agent.diagnostics` 配置从 boolean 扩展为 `boolean | { providers?: string[] }`（向后兼容）

- [x] **Step 1: 写失败测试**

在 `config-resources-extensions.test.ts` 中追加测试用例：

```typescript
it("supports multi-language diagnostics configuration", () => {
  const resolved = resolveAgentConfig(tmpdir, {
    agent: { diagnostics: { providers: ["typescript", "python"] } },
    apiKey: "k",
    projectTrusted: true,
  });
  expect(resolved.agent.diagnostics).toEqual({
    enabled: true,
    providers: ["typescript", "python"],
  });
});

it("diagnostics boolean true maps to enabled with all providers", () => {
  const resolved = resolveAgentConfig(tmpdir, {
    agent: { diagnostics: true },
    apiKey: "k",
    projectTrusted: true,
  });
  expect(resolved.agent.diagnostics).toEqual({ enabled: true, providers: undefined });
});

it("diagnostics boolean false maps to disabled", () => {
  const resolved = resolveAgentConfig(tmpdir, {
    agent: { diagnostics: false },
    apiKey: "k",
    projectTrusted: true,
  });
  expect(resolved.agent.diagnostics).toEqual({ enabled: false, providers: undefined });
});

it("rejects invalid diagnostics provider id", () => {
  expect(() =>
    resolveAgentConfig(tmpdir, {
      agent: { diagnostics: { providers: ["invalid-lang"] } },
      apiKey: "k",
      projectTrusted: true,
    }),
  ).toThrow(/diagnostics.providers/);
});
```

- [x] **Step 2: 运行测试验证失败**

Run: `pnpm build && npx vitest run packages/agent-runtime/test/config-resources-extensions.test.ts`
Expected: FAIL — `resolved.agent.diagnostics` 仍是 boolean，不匹配 `{ enabled, providers }`

- [x] **Step 3: 修改 config.ts**

在 `AgentConfigFile.agent` 类型中，把 `diagnostics?: boolean` 改为：

```typescript
    /** Append language diagnostics after successful edits. Default true.
     *  boolean: true = auto-detect all providers, false = disabled.
     *  object: explicitly specify provider ids. */
    diagnostics?: boolean | { providers?: string[] };
```

在 `ResolvedAgentConfig.agent` 类型中，把 `diagnostics: boolean` 改为：

```typescript
    diagnostics: { enabled: boolean; providers: string[] | undefined };
```

在 `resolveAgentConfig` 返回对象的 `agent` 字段中，把 `diagnostics: merged.agent?.diagnostics ?? true,` 改为：

```typescript
      diagnostics: resolveDiagnosticsConfig(merged.agent?.diagnostics),
```

在 `validateAgentConfig` 中，把 `validateOptionalBoolean(config.agent.diagnostics, "agent.diagnostics", path);` 改为：

```typescript
if (config.agent.diagnostics !== undefined) {
  const d = config.agent.diagnostics;
  if (typeof d === "boolean") {
    // ok
  } else if (d && typeof d === "object" && !Array.isArray(d)) {
    if (d.providers !== undefined) {
      if (!Array.isArray(d.providers) || !d.providers.every((p) => typeof p === "string")) {
        throw new Error(`agent.diagnostics.providers must be a string array in ${path}`);
      }
      const valid = ["typescript", "python", "go", "rust"];
      for (const p of d.providers) {
        if (!valid.includes(p)) {
          throw new Error(
            `agent.diagnostics.providers contains unknown provider '${p}' in ${path}; valid: ${valid.join(", ")}`,
          );
        }
      }
    }
  } else {
    throw new Error(`agent.diagnostics must be boolean or object in ${path}`);
  }
}
```

在 config.ts 底部添加 helper 函数：

```typescript
function resolveDiagnosticsConfig(value: boolean | { providers?: string[] } | undefined): {
  enabled: boolean;
  providers: string[] | undefined;
} {
  if (value === undefined) return { enabled: true, providers: undefined };
  if (typeof value === "boolean") return { enabled: value, providers: undefined };
  return { enabled: true, providers: value.providers };
}
```

- [x] **Step 4: 修改 agent.ts 诊断调用**

在 agent.ts 中，修改 `systemPrompt` 和诊断调用逻辑。找到诊断调用块（约第 669-676 行）：

把：

```typescript
    if (this.options.diagnostics === false || result.isError) return result;
    if (!["write", "edit", "apply_patch"].includes(call.name)) return result;
    try {
      if (!(await shouldRunDiagnostics(this.options.cwd))) return result;
      const diagnostics = await runDiagnostics(this.options.cwd);
      if (!diagnostics.ran || !diagnostics.output?.trim()) return result;
      const output = diagnostics.output.trim().split("\n").slice(0, 20).join("\n");
      return { ...result, content: `${result.content}\n\n[diagnostics: tsc --noEmit]\n${output}` };
```

改为：

```typescript
    const diagConfig = this.options.diagnostics ?? { enabled: true, providers: undefined };
    if (!diagConfig.enabled || result.isError) return result;
    if (!["write", "edit", "apply_patch"].includes(call.name)) return result;
    try {
      const allResults = await runDiagnosticsAll(
        this.options.cwd,
        30_000,
        diagConfig.providers,
      );
      const withOutput = allResults.filter((r) => r.ran && r.output?.trim());
      if (withOutput.length === 0) return result;
      const banners = withOutput.map((r) => {
        const output = r.output!.trim().split("\n").slice(0, 20).join("\n");
        return `[diagnostics: ${r.label}]\n${output}`;
      });
      return { ...result, content: `${result.content}\n\n${banners.join("\n\n")}` };
```

同时修改 `CodingAgentOptions` 中 `diagnostics` 字段类型：

把：

```typescript
  /** Append `tsc --noEmit` output after successful edits; default true. */
  diagnostics?: boolean;
```

改为：

```typescript
  /** Append language diagnostics after successful edits; default enabled. */
  diagnostics?: { enabled: boolean; providers: string[] | undefined };
```

修改构造函数中 `this.options.diagnostics` 的默认值处理（确保 undefined 时默认为 enabled）。

- [x] **Step 5: 运行测试验证通过**

Run: `pnpm build && npx vitest run packages/agent-runtime/test/config-resources-extensions.test.ts`
Expected: PASS

- [x] **Step 6: 运行全量测试确认无回归**

Run: `pnpm build && npx vitest run`
Expected: 全部 PASS（如有 agent.ts 相关测试因 diagnostics 类型变更失败，需同步修复）

- [x] **Step 7: 提交**

```bash
git add packages/agent-runtime/src/config.ts packages/agent-runtime/src/agent.ts \
        packages/agent-runtime/test/config-resources-extensions.test.ts
git commit -m "feat(agent-runtime): multi-language diagnostics config and agent integration"
```

---

## Phase 2B: Graph DAG 任务调度

### Task 4: TaskGraph 数据结构与拓扑排序

**Files:**

- Create: `packages/agent-runtime/src/graph.ts`
- Create: `packages/agent-runtime/test/graph.test.ts`

**Interfaces:**

- Produces: `TaskNode`, `TaskGraph`, `GraphCycleError`, `topologicalSort`, `createTaskGraph`

- [x] **Step 1: 写失败测试**

```typescript
// packages/agent-runtime/test/graph.test.ts
import { describe, expect, it } from "vitest";
import { createTaskGraph, topologicalSort, GraphCycleError, type TaskNode } from "../src/graph.js";

describe("task graph", () => {
  it("sorts nodes in topological order", () => {
    const graph = createTaskGraph([
      { id: "c", executor: async () => "c", dependencies: ["a", "b"] },
      { id: "a", executor: async () => "a", dependencies: [] },
      { id: "b", executor: async () => "b", dependencies: ["a"] },
    ]);
    const sorted = topologicalSort(graph);
    const ids = sorted.map((n) => n.id);
    expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("b"));
    expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("c"));
    expect(ids.indexOf("b")).toBeLessThan(ids.indexOf("c"));
  });

  it("detects cycles and throws GraphCycleError", () => {
    const graph = createTaskGraph([
      { id: "a", executor: async () => "a", dependencies: ["b"] },
      { id: "b", executor: async () => "b", dependencies: ["a"] },
    ]);
    expect(() => topologicalSort(graph)).toThrow(GraphCycleError);
  });

  it("detects missing dependency", () => {
    const graph = createTaskGraph([
      { id: "a", executor: async () => "a", dependencies: ["nonexistent"] },
    ]);
    expect(() => topologicalSort(graph)).toThrow(/nonexistent/);
  });

  it("handles empty graph", () => {
    const graph = createTaskGraph([]);
    expect(topologicalSort(graph)).toEqual([]);
  });

  it("handles single node", () => {
    const graph = createTaskGraph([{ id: "solo", executor: async () => "done", dependencies: [] }]);
    const sorted = topologicalSort(graph);
    expect(sorted).toHaveLength(1);
    expect(sorted[0]!.id).toBe("solo");
  });

  it("preserves node executor references after sort", () => {
    const executor = async () => "result";
    const graph = createTaskGraph([{ id: "a", executor, dependencies: [] }]);
    const sorted = topologicalSort(graph);
    expect(sorted[0]!.executor).toBe(executor);
  });
});
```

- [x] **Step 2: 运行测试验证失败**

Run: `pnpm build && npx vitest run packages/agent-runtime/test/graph.test.ts`
Expected: FAIL with "Cannot find module '../src/graph.js'"

- [x] **Step 3: 最小实现**

```typescript
// packages/agent-runtime/src/graph.ts
export interface TaskNode {
  readonly id: string;
  readonly executor: (context: TaskExecutionContext) => Promise<string>;
  readonly dependencies: readonly string[];
}

export interface TaskExecutionContext {
  readonly nodeId: string;
  readonly results: ReadonlyMap<string, string>;
  readonly signal: AbortSignal | undefined;
}

export interface TaskGraph {
  readonly nodes: readonly TaskNode[];
  readonly nodeMap: ReadonlyMap<string, TaskNode>;
}

export class GraphCycleError extends Error {
  constructor(readonly cycle: string[]) {
    super(`Cycle detected in task graph: ${cycle.join(" → ")}`);
    this.name = "GraphCycleError";
  }
}

export function createTaskGraph(nodes: TaskNode[]): TaskGraph {
  const nodeMap = new Map<string, TaskNode>();
  for (const node of nodes) {
    if (nodeMap.has(node.id)) {
      throw new Error(`Duplicate task node id: ${node.id}`);
    }
    nodeMap.set(node.id, node);
  }
  return { nodes, nodeMap };
}

/**
 * Kahn's algorithm: returns nodes in an order where every node appears after
 * all of its dependencies. Throws GraphCycleError if a cycle exists, or Error
 * if a dependency references a non-existent node.
 */
export function topologicalSort(graph: TaskGraph): TaskNode[] {
  const { nodeMap } = graph;
  // Validate dependencies
  for (const node of graph.nodes) {
    for (const dep of node.dependencies) {
      if (!nodeMap.has(dep)) {
        throw new Error(`Task '${node.id}' depends on non-existent task '${dep}'`);
      }
    }
  }
  // Compute in-degrees
  const inDegree = new Map<string, number>();
  for (const node of graph.nodes) {
    inDegree.set(node.id, node.dependencies.length);
  }
  // Initialize queue with zero-in-degree nodes (preserve input order)
  const queue: string[] = graph.nodes.filter((n) => n.dependencies.length === 0).map((n) => n.id);
  const sorted: TaskNode[] = [];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    const node = nodeMap.get(id)!;
    sorted.push(node);
    visited.add(id);
    // Find nodes that depend on this one
    for (const candidate of graph.nodes) {
      if (candidate.dependencies.includes(id)) {
        const newDegree = (inDegree.get(candidate.id) ?? 0) - 1;
        inDegree.set(candidate.id, newDegree);
        if (newDegree === 0 && !visited.has(candidate.id)) {
          queue.push(candidate.id);
        }
      }
    }
  }
  if (sorted.length !== graph.nodes.length) {
    // Remaining nodes are in a cycle
    const cycleNodes = graph.nodes.filter((n) => !visited.has(n.id)).map((n) => n.id);
    throw new GraphCycleError(cycleNodes);
  }
  return sorted;
}
```

- [x] **Step 4: 运行测试验证通过**

Run: `pnpm build && npx vitest run packages/agent-runtime/test/graph.test.ts`
Expected: PASS

- [x] **Step 5: 提交**

```bash
git add packages/agent-runtime/src/graph.ts packages/agent-runtime/test/graph.test.ts
git commit -m "feat(agent-runtime): add task graph with topological sort and cycle detection"
```

---

### Task 5: runTaskGraph 并行执行器

**Files:**

- Modify: `packages/agent-runtime/src/graph.ts`
- Modify: `packages/agent-runtime/test/graph.test.ts`

**Interfaces:**

- Consumes: `TaskGraph`, `topologicalSort` from graph.ts
- Produces: `GraphExecutionOptions`, `GraphExecutionResult`, `NodeResult`, `runTaskGraph`

- [x] **Step 1: 写失败测试**

在 `graph.test.ts` 末尾追加：

```typescript
import { runTaskGraph, type GraphExecutionOptions } from "../src/graph.js";

describe("runTaskGraph executor", () => {
  it("executes nodes in dependency order and collects results", async () => {
    const graph = createTaskGraph([
      { id: "a", executor: async () => "result-a", dependencies: [] },
      { id: "b", executor: async (ctx) => `b after ${ctx.results.get("a")}`, dependencies: ["a"] },
    ]);
    const result = await runTaskGraph(graph, {});
    expect(result.completed).toBe(true);
    expect(result.reason).toBe("all_succeeded");
    expect(result.results.get("a")).toBe("result-a");
    expect(result.results.get("b")).toBe("b after result-a");
  });

  it("runs independent nodes in parallel", async () => {
    let startCount = 0;
    let maxConcurrent = 0;
    const graph = createTaskGraph([
      {
        id: "a",
        executor: async () => {
          startCount++;
          maxConcurrent = Math.max(maxConcurrent, startCount);
          await new Promise((r) => setTimeout(r, 50));
          startCount--;
          return "a";
        },
        dependencies: [],
      },
      {
        id: "b",
        executor: async () => {
          startCount++;
          maxConcurrent = Math.max(maxConcurrent, startCount);
          await new Promise((r) => setTimeout(r, 50));
          startCount--;
          return "b";
        },
        dependencies: [],
      },
    ]);
    const result = await runTaskGraph(graph, {});
    expect(result.completed).toBe(true);
    expect(maxConcurrent).toBeGreaterThanOrEqual(2);
  });

  it("stops on failure by default (fail-fast)", async () => {
    const graph = createTaskGraph([
      {
        id: "a",
        executor: async () => {
          throw new Error("boom");
        },
        dependencies: [],
      },
      { id: "b", executor: async () => "b", dependencies: ["a"] },
    ]);
    const result = await runTaskGraph(graph, {});
    expect(result.completed).toBe(false);
    expect(result.reason).toBe("node_failed");
    expect(result.results.has("b")).toBe(false);
    expect(result.errors.get("a")?.message).toBe("boom");
  });

  it("continues on failure with continueOnError", async () => {
    let bRan = false;
    const graph = createTaskGraph([
      {
        id: "a",
        executor: async () => {
          throw new Error("boom");
        },
        dependencies: [],
      },
      {
        id: "b",
        executor: async () => {
          bRan = true;
          return "b";
        },
        dependencies: [],
      },
      {
        id: "c",
        executor: async (ctx) => `c(${ctx.results.get("b") ?? "skipped"})`,
        dependencies: ["b"],
      },
    ]);
    const result = await runTaskGraph(graph, { continueOnError: true });
    expect(result.completed).toBe(false);
    expect(result.reason).toBe("node_failed");
    expect(bRan).toBe(true);
    expect(result.results.get("b")).toBe("b");
    expect(result.results.get("c")).toBe("c(b)");
  });

  it("skips dependents of failed nodes even with continueOnError", async () => {
    let cRan = false;
    const graph = createTaskGraph([
      {
        id: "a",
        executor: async () => {
          throw new Error("boom");
        },
        dependencies: [],
      },
      { id: "b", executor: async () => "b", dependencies: ["a"] },
      {
        id: "c",
        executor: async () => {
          cRan = true;
          return "c";
        },
        dependencies: [],
      },
    ]);
    const result = await runTaskGraph(graph, { continueOnError: true });
    expect(result.results.get("c")).toBe("c");
    expect(result.results.has("b")).toBe(false);
    expect(cRan).toBe(true);
  });

  it("respects maxConcurrency limit", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const nodes: TaskNode[] = ["a", "b", "c", "d"].map((id) => ({
      id,
      executor: async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 30));
        concurrent--;
        return id;
      },
      dependencies: [],
    }));
    const graph = createTaskGraph(nodes);
    await runTaskGraph(graph, { maxConcurrency: 2 });
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it("propagates abort signal", async () => {
    const controller = new AbortController();
    const graph = createTaskGraph([
      {
        id: "a",
        executor: async (ctx) => {
          // Wait for abort
          while (!ctx.signal?.aborted) {
            await new Promise((r) => setTimeout(r, 10));
          }
          return "aborted";
        },
        dependencies: [],
      },
    ]);
    setTimeout(() => controller.abort(), 50);
    const result = await runTaskGraph(graph, { signal: controller.signal });
    expect(result.completed).toBe(false);
    expect(result.reason).toBe("aborted");
  });
});
```

- [x] **Step 2: 运行测试验证失败**

Run: `pnpm build && npx vitest run packages/agent-runtime/test/graph.test.ts`
Expected: FAIL with "runTaskGraph is not a function"

- [x] **Step 3: 实现 runTaskGraph**

在 `graph.ts` 末尾追加：

```typescript
export interface NodeResult {
  readonly nodeId: string;
  readonly status: "succeeded" | "failed" | "skipped";
  readonly output?: string | undefined;
  readonly error?: string | undefined;
}

export interface GraphExecutionOptions {
  /** Continue executing independent nodes after a failure; default false (fail-fast). */
  continueOnError?: boolean;
  /** Maximum number of nodes executing concurrently; default 4. */
  maxConcurrency?: number;
  /** Abort signal; when triggered, pending nodes are skipped. */
  signal?: AbortSignal;
}

export interface GraphExecutionResult {
  /** True if every node succeeded. */
  completed: boolean;
  /** Why execution stopped: all_succeeded | node_failed | aborted. */
  reason: "all_succeeded" | "node_failed" | "aborted";
  /** Successful node outputs keyed by node id. */
  results: Map<string, string>;
  /** Failed node errors keyed by node id. */
  errors: Map<string, Error>;
  /** Nodes that were skipped (dependents of failed nodes or aborted). */
  skipped: string[];
}

export async function runTaskGraph(
  graph: TaskGraph,
  options: GraphExecutionOptions,
): Promise<GraphExecutionResult> {
  const { continueOnError = false, maxConcurrency = 4, signal } = options;
  const sorted = topologicalSort(graph);
  const results = new Map<string, string>();
  const errors = new Map<string, Error>();
  const skipped: string[] = [];
  const failed = new Set<string>();
  let aborted = false;

  // Group nodes into "levels" — nodes at the same level have no inter-dependency
  // and can run in parallel. We compute levels by repeatedly taking nodes whose
  // dependencies are all completed.
  const pending = new Set(sorted.map((n) => n.id));

  while (pending.size > 0) {
    if (signal?.aborted) {
      aborted = true;
      break;
    }
    // Find all pending nodes whose dependencies are all resolved (succeeded or failed-and-skipped)
    const ready: TaskNode[] = [];
    for (const id of pending) {
      const node = graph.nodeMap.get(id)!;
      const deps = node.dependencies;
      const allResolved = deps.every((dep) => results.has(dep) || failed.has(dep));
      if (allResolved) {
        // Check if any dependency failed — if so, skip this node
        const depFailed = deps.some((dep) => failed.has(dep));
        if (depFailed) {
          pending.delete(id);
          skipped.push(id);
          failed.add(id); // mark as failed so dependents also skip
          continue;
        }
        ready.push(node);
      }
    }
    for (const node of ready) pending.delete(node.id);

    if (ready.length === 0) {
      // No ready nodes but pending remain — shouldn't happen after topo sort,
      // but guard against infinite loop
      break;
    }

    // Execute ready nodes with concurrency limit
    const batches: TaskNode[][] = [];
    for (let i = 0; i < ready.length; i += maxConcurrency) {
      batches.push(ready.slice(i, i + maxConcurrency));
    }

    let hadFailure = false;
    for (const batch of batches) {
      if (signal?.aborted) {
        aborted = true;
        break;
      }
      const execResults = await Promise.allSettled(
        batch.map(async (node) => {
          const ctx: TaskExecutionContext = {
            nodeId: node.id,
            results,
            signal,
          };
          return node.executor(ctx);
        }),
      );
      for (let i = 0; i < batch.length; i++) {
        const node = batch[i]!;
        const r = execResults[i]!;
        if (r.status === "fulfilled") {
          results.set(node.id, r.value);
        } else {
          const error = r.reason instanceof Error ? r.reason : new Error(String(r.reason));
          errors.set(node.id, error);
          failed.add(node.id);
          hadFailure = true;
        }
      }
      if (hadFailure && !continueOnError) break;
    }
    if (hadFailure && !continueOnError) break;
    if (aborted) break;
  }

  // Remaining pending nodes are skipped due to abort or fail-fast
  for (const id of pending) {
    skipped.push(id);
  }

  const completed = errors.size === 0 && !aborted && skipped.length === 0;
  const reason = aborted ? "aborted" : errors.size > 0 ? "node_failed" : "all_succeeded";
  return { completed, reason, results, errors, skipped };
}
```

- [x] **Step 4: 运行测试验证通过**

Run: `pnpm build && npx vitest run packages/agent-runtime/test/graph.test.ts`
Expected: PASS

- [x] **Step 5: 提交**

```bash
git add packages/agent-runtime/src/graph.ts packages/agent-runtime/test/graph.test.ts
git commit -m "feat(agent-runtime): add parallel task graph executor with fail-fast and continue-on-error"
```

---

### Task 6: graph 工具与 agent.ts 集成

**Files:**

- Modify: `packages/agent-runtime/src/index.ts`
- Modify: `packages/agent-runtime/src/agent.ts`
- Modify: `packages/agent-runtime/src/config.ts`
- Modify: `packages/agent-runtime/test/config-resources-extensions.test.ts`

**Interfaces:**

- Consumes: `runTaskGraph`, `createTaskGraph`, `TaskNode` from graph.ts
- Produces: `graph` 工具（让模型可以声明任务图并执行）, config `graph` 字段

- [x] **Step 1: 修改 index.ts 导出 graph 模块**

在 index.ts 中按字母序添加：

```typescript
export * from "./graph.js";
```

- [x] **Step 2: 修改 config.ts 添加 graph 配置**

在 `AgentConfigFile` 中添加（在 `loop` 之后）：

```typescript
  /**
   * Task graph execution defaults. The agent runtime enforces these as hard
   * upper bounds when the model invokes the `graph` tool.
   */
  graph?: {
    maxConcurrency?: number;
    continueOnError?: boolean;
  };
```

在 `ResolvedAgentConfig` 中添加：

```typescript
graph: {
  maxConcurrency: number;
  continueOnError: boolean;
}
```

在 `resolveAgentConfig` 返回对象中添加（在 `loop` 之后）：

```typescript
    graph: {
      maxConcurrency: boundedInteger(merged.graph?.maxConcurrency, 4, 1, 32),
      continueOnError: merged.graph?.continueOnError ?? false,
    },
```

在 `validateAgentConfig` 中添加（在 `loop` 验证之后）：

```typescript
if (config.graph !== undefined) {
  if (!config.graph || typeof config.graph !== "object" || Array.isArray(config.graph)) {
    throw new Error(`graph must be an object in ${path}`);
  }
  if (
    config.graph.maxConcurrency !== undefined &&
    (typeof config.graph.maxConcurrency !== "number" ||
      !Number.isFinite(config.graph.maxConcurrency))
  ) {
    throw new Error(`graph.maxConcurrency must be a finite number in ${path}`);
  }
  if (
    config.graph.continueOnError !== undefined &&
    typeof config.graph.continueOnError !== "boolean"
  ) {
    throw new Error(`graph.continueOnError must be boolean in ${path}`);
  }
}
```

- [x] **Step 3: 写失败测试 — graph 工具集成**

创建测试文件 `packages/agent-runtime/test/graph-integration.test.ts`：

```typescript
import { describe, expect, it } from "vitest";
import { createTestDirectory } from "@focuscode/testkit";
import {
  CodingAgent,
  SessionStore,
  createCodingToolRegistry,
  type ModelClient,
  type ModelProfile,
  type ModelRequest,
  type ModelResponse,
} from "../src/index.js";

const model: ModelProfile = {
  provider: "fixture",
  model: "fixture",
  protocol: "openai-chat",
  baseUrl: "http://fixture",
  contextWindow: 16_000,
  maxOutputTokens: 1_000,
  temperature: 0,
  toolMode: "native",
  reasoningEffort: "off",
  capabilities: { input: ["text"], reasoning: false, toolCalling: true },
  compatibility: {},
  reliability: {
    timeoutMs: 30_000,
    maxRetries: 0,
    retryBaseDelayMs: 100,
    retryMaximumDelayMs: 1_000,
  },
};

describe("graph tool integration", () => {
  it("registers the graph tool alongside delegate and goal", async () => {
    const root = await createTestDirectory("graph-tools");
    const registry = await createCodingToolRegistry(root);
    const agent = await CodingAgent.create({
      cwd: root,
      model,
      modelClient: new QueueModelClient([]),
      tools: registry.values(),
      toolRegistry: registry,
      permission: { mode: "auto-edit", projectTrusted: true, protectedPaths: [] },
      sessionStore: new SessionStore("unused", false),
      checkpoints: false,
    });
    expect(agent.toolDefinitions().map((t) => t.name)).toContain("graph");
  });

  it("executes a simple graph and returns results", async () => {
    const root = await createTestDirectory("graph-exec");
    const registry = await createCodingToolRegistry(root);
    const modelClient = new QueueModelClient([
      {
        content: "",
        toolCalls: [
          {
            id: "g1",
            name: "graph",
            arguments: {
              nodes: [
                { id: "a", task: "Step A", dependencies: [] },
                { id: "b", task: "Step B", dependencies: ["a"] },
              ],
            },
          },
        ],
        usage: { inputTokens: 10, outputTokens: 4 },
        stopReason: "tool_use",
      },
      {
        content: "graph done",
        toolCalls: [],
        usage: { inputTokens: 6, outputTokens: 3 },
        stopReason: "stop",
      },
    ]);
    const agent = await CodingAgent.create({
      cwd: root,
      model,
      modelClient,
      tools: registry.values(),
      toolRegistry: registry,
      permission: { mode: "auto-edit", projectTrusted: true, protectedPaths: [] },
      sessionStore: new SessionStore("unused", false),
      checkpoints: false,
      maxRounds: 4,
    });
    const result = await agent.submit("run the graph");
    expect(result.content).toBe("graph done");
    // The graph tool result should appear in the session
    const toolMessage = agent
      .snapshot()
      .entries.map((e) => e.message)
      .find((m) => m.role === "tool" && m.toolName === "graph");
    expect(toolMessage?.content).toContain("completed");
    expect(toolMessage?.content).toContain("a");
    expect(toolMessage?.content).toContain("b");
  });
});

class QueueModelClient implements ModelClient {
  readonly protocol = "fixture";
  readonly requests: ModelRequest[] = [];
  constructor(private readonly responses: ModelResponse[]) {}
  async complete(
    request: ModelRequest,
    onEvent?: Parameters<ModelClient["complete"]>[1],
  ): Promise<ModelResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) throw new Error("No scripted response");
    if (response.content) onEvent?.({ type: "text_delta", delta: response.content });
    return response;
  }
}
```

- [x] **Step 4: 运行测试验证失败**

Run: `pnpm build && npx vitest run packages/agent-runtime/test/graph-integration.test.ts`
Expected: FAIL — graph 工具未注册

- [x] **Step 5: 实现 graph 工具并注册到 agent.ts**

在 agent.ts 顶部添加 import：

```typescript
import { createTaskGraph, runTaskGraph, type TaskNode } from "./graph.js";
```

在 `CodingAgent` 构造函数中，在 goal 工具注册之后添加：

```typescript
if (this.registry.get("graph") === undefined) {
  this.registry.register({
    definition: {
      name: "graph",
      label: "Task graph",
      description:
        "Declare a DAG of sub-tasks and execute them in dependency order. " +
        "Each node is delegated to a child agent. Returns per-node results.",
      parameters: {
        type: "object",
        required: ["nodes"],
        properties: {
          nodes: {
            type: "array",
            items: {
              type: "object",
              required: ["id", "task"],
              properties: {
                id: { type: "string", minLength: 1, maxLength: 64 },
                task: { type: "string", minLength: 1, maxLength: 4_000 },
                dependencies: {
                  type: "array",
                  items: { type: "string" },
                },
              },
            },
          },
          continueOnError: { type: "boolean" },
        },
      },
      effect: "write",
    },
    async execute(args, context) {
      const rawNodes = Array.isArray(args.nodes) ? args.nodes : [];
      if (rawNodes.length === 0) {
        return { content: "graph: no nodes provided", isError: true };
      }
      if (rawNodes.length > 20) {
        return { content: "graph: too many nodes (max 20)", isError: true };
      }
      const continueOnError = args.continueOnError === true;
      // Build TaskNode executors that delegate to child agents
      const delegateContext =
        options.enableDelegate !== false
          ? undefined // delegate is registered, we'll use it indirectly
          : undefined;
      const taskNodes: TaskNode[] = rawNodes.map(
        (raw: { id: string; task: string; dependencies?: string[] }) => ({
          id: raw.id,
          dependencies: raw.dependencies ?? [],
          executor: async (execCtx) => {
            // Use the delegate tool if available, otherwise return a placeholder
            const delegateTool = execCtx.results.size >= 0 ? null : null;
            if (delegateTool) {
              return "delegated";
            }
            // For graph integration, we run each node as a child agent
            // via the same createAgent mechanism as delegate
            const child = await childFactory({
              cwd: options.cwd,
              model,
              modelClient,
              tools: registry
                .values()
                .filter((t) => !["delegate", "bash", "todo", "graph"].includes(t.definition.name)),
              toolRegistry: new AgentToolRegistry(
                registry
                  .values()
                  .filter(
                    (t) => !["delegate", "bash", "todo", "graph"].includes(t.definition.name),
                  ),
              ),
              permission: options.permission,
              sessionStore: new SessionStore("graph", false),
              maxRounds: 8,
            });
            const childResult = await child.submit(raw.task, execCtx.signal);
            return childResult.content.slice(0, 4_000);
          },
        }),
      );
      const graph = createTaskGraph(taskNodes);
      const result = await runTaskGraph(graph, {
        continueOnError,
        maxConcurrency: 4,
        signal: context.signal,
      });
      const lines: string[] = [
        `graph: ${result.completed ? "completed" : "incomplete"} (${result.reason})`,
        `succeeded: ${result.results.size}, failed: ${result.errors.size}, skipped: ${result.skipped.length}`,
      ];
      for (const [id, output] of result.results) {
        const trimmed = output.length > 500 ? `${output.slice(0, 500)}...` : output;
        lines.push(`  ✓ ${id}: ${trimmed}`);
      }
      for (const [id, error] of result.errors) {
        lines.push(`  ✗ ${id}: ${error.message}`);
      }
      for (const id of result.skipped) {
        lines.push(`  ⊘ ${id}: skipped`);
      }
      return { content: lines.join("\n") };
    },
  });
}
```

**注意**：上面的 graph 工具实现需要访问 agent 的 `model`、`modelClient`、`registry`、`options` 等私有字段。由于工具 execute 函数在 agent 实例上下文中注册，需要通过闭包捕获这些引用。实际实现时应在构造函数内部定义，使用 `this.model`、`this.modelClient`、`this.registry`、`this.options`。

更简洁的实现方式：把 graph 工具的 executor 抽取为独立函数 `createGraphTool(getAgentContext)`，类似 delegate 的模式。修改如下：

在 agent.ts 中，把 graph 工具注册改为：

```typescript
if (this.registry.get("graph") === undefined) {
  this.registry.register(
    createGraphTool(() => ({
      cwd: this.options.cwd,
      model: this.model,
      modelClient: this.modelClient,
      registry: this.registry,
      permission: this.options.permission,
      createAgent: (childOptions) =>
        CodingAgent.create({
          ...childOptions,
          enableDelegate: false,
          checkpoints: false,
          enableGoal: false,
        }),
    })),
  );
}
```

然后在 `graph.ts` 中添加 `createGraphTool` 函数（见 Step 6）。

- [x] **Step 6: 在 graph.ts 中添加 createGraphTool**

在 graph.ts 末尾追加：

```typescript
import { SessionStore } from "./session-store.js";
import { AgentToolRegistry } from "./tools.js";
import type {
  AgentTool,
  AgentRuntimeOptions,
  ModelClient,
  ModelProfile,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./types.js";

/** Tools never handed to a graph child agent. */
const GRAPH_EXCLUDED_TOOLS = new Set(["delegate", "bash", "todo", "graph"]);

export interface GraphToolContext {
  cwd: string;
  model: ModelProfile;
  modelClient: ModelClient;
  registry: AgentToolRegistry;
  permission: AgentRuntimeOptions["permission"];
  createAgent(options: AgentRuntimeOptions): Promise<{
    submit(input: string, signal?: AbortSignal): Promise<{ content: string }>;
  }>;
}

export function createGraphTool(getContext: () => GraphToolContext): AgentTool {
  return {
    definition: {
      name: "graph",
      label: "Task graph",
      description:
        "Declare a DAG of sub-tasks and execute them in dependency order. " +
        "Each node runs in a child agent. Returns per-node results.",
      parameters: {
        type: "object",
        required: ["nodes"],
        properties: {
          nodes: {
            type: "array",
            items: {
              type: "object",
              required: ["id", "task"],
              properties: {
                id: { type: "string", minLength: 1, maxLength: 64 },
                task: { type: "string", minLength: 1, maxLength: 4_000 },
                dependencies: {
                  type: "array",
                  items: { type: "string" },
                },
              },
            },
          },
          continueOnError: { type: "boolean" },
        },
      },
      effect: "write",
    },
    async execute(
      args: Record<string, unknown>,
      context: ToolExecutionContext,
    ): Promise<ToolExecutionResult> {
      const rawNodes = Array.isArray(args.nodes) ? args.nodes : [];
      if (rawNodes.length === 0) {
        return { content: "graph: no nodes provided", isError: true };
      }
      if (rawNodes.length > 20) {
        return { content: "graph: too many nodes (max 20)", isError: true };
      }
      const continueOnError = args.continueOnError === true;
      const ctx = getContext();
      const childRegistry = new AgentToolRegistry(
        ctx.registry.values().filter((t) => !GRAPH_EXCLUDED_TOOLS.has(t.definition.name)),
      );
      const taskNodes: TaskNode[] = rawNodes.map(
        (raw: { id: string; task: string; dependencies?: string[] }) => ({
          id: raw.id,
          dependencies: raw.dependencies ?? [],
          executor: async (execCtx) => {
            const child = await ctx.createAgent({
              cwd: ctx.cwd,
              model: ctx.model,
              modelClient: ctx.modelClient,
              tools: childRegistry.values(),
              toolRegistry: childRegistry,
              permission: ctx.permission,
              sessionStore: new SessionStore("graph", false),
              maxRounds: 8,
            });
            const childResult = await child.submit(raw.task, execCtx.signal);
            return childResult.content.slice(0, 4_000);
          },
        }),
      );
      const graph = createTaskGraph(taskNodes);
      const result = await runTaskGraph(graph, {
        continueOnError,
        maxConcurrency: 4,
        signal: context.signal,
      });
      const lines: string[] = [
        `graph: ${result.completed ? "completed" : "incomplete"} (${result.reason})`,
        `succeeded: ${result.results.size}, failed: ${result.errors.size}, skipped: ${result.skipped.length}`,
      ];
      for (const [id, output] of result.results) {
        const trimmed = output.length > 500 ? `${output.slice(0, 500)}...` : output;
        lines.push(`  ok ${id}: ${trimmed}`);
      }
      for (const [id, error] of result.errors) {
        lines.push(`  fail ${id}: ${error.message}`);
      }
      for (const id of result.skipped) {
        lines.push(`  skip ${id}: skipped`);
      }
      return { content: lines.join("\n") };
    },
  };
}
```

- [x] **Step 7: 运行测试验证通过**

Run: `pnpm build && npx vitest run packages/agent-runtime/test/graph-integration.test.ts`
Expected: PASS

- [x] **Step 8: 提交**

```bash
git add packages/agent-runtime/src/graph.ts packages/agent-runtime/src/index.ts \
        packages/agent-runtime/src/agent.ts packages/agent-runtime/src/config.ts \
        packages/agent-runtime/test/graph-integration.test.ts \
        packages/agent-runtime/test/config-resources-extensions.test.ts
git commit -m "feat(agent-runtime): add graph tool with DAG execution and config integration"
```

---

## Phase 2C: Agent Teams 多代理协作

### Task 7: AgentRole 与 TeamPlan 数据结构

**Files:**

- Create: `packages/agent-runtime/src/team.ts`
- Create: `packages/agent-runtime/test/team.test.ts`

**Interfaces:**

- Produces: `AgentRole`, `TeamPlan`, `TeamTask`, `TeamResult`, `validateTeamPlan`

- [x] **Step 1: 写失败测试**

```typescript
// packages/agent-runtime/test/team.test.ts
import { describe, expect, it } from "vitest";
import { validateTeamPlan, type AgentRole, type TeamPlan } from "../src/team.js";

describe("team plan validation", () => {
  const validRoles: AgentRole[] = [
    { name: "planner", instructions: "You are a planner.", allowedTools: ["read"], maxRounds: 5 },
    {
      name: "coder",
      instructions: "You are a coder.",
      allowedTools: ["read", "write", "edit"],
      maxRounds: 12,
    },
    {
      name: "reviewer",
      instructions: "You are a reviewer.",
      allowedTools: ["read", "bash"],
      maxRounds: 8,
    },
  ];

  it("accepts a valid team plan", () => {
    const plan: TeamPlan = {
      roles: validRoles,
      tasks: [
        { id: "t1", roleId: "planner", input: "Plan the feature", dependencies: [] },
        { id: "t2", roleId: "coder", input: "Implement step 1", dependencies: ["t1"] },
        { id: "t3", roleId: "reviewer", input: "Review the code", dependencies: ["t2"] },
      ],
    };
    expect(() => validateTeamPlan(plan)).not.toThrow();
  });

  it("rejects duplicate role names", () => {
    const plan: TeamPlan = {
      roles: [
        ...validRoles,
        { name: "planner", instructions: "dup", allowedTools: [], maxRounds: 1 },
      ],
      tasks: [],
    };
    expect(() => validateTeamPlan(plan)).toThrow(/duplicate role.*planner/i);
  });

  it("rejects task with unknown roleId", () => {
    const plan: TeamPlan = {
      roles: validRoles,
      tasks: [{ id: "t1", roleId: "unknown", input: "x", dependencies: [] }],
    };
    expect(() => validateTeamPlan(plan)).toThrow(/unknown role.*unknown/i);
  });

  it("rejects duplicate task ids", () => {
    const plan: TeamPlan = {
      roles: validRoles,
      tasks: [
        { id: "t1", roleId: "planner", input: "a", dependencies: [] },
        { id: "t1", roleId: "coder", input: "b", dependencies: [] },
      ],
    };
    expect(() => validateTeamPlan(plan)).toThrow(/duplicate task.*t1/i);
  });

  it("rejects task dependency on non-existent task", () => {
    const plan: TeamPlan = {
      roles: validRoles,
      tasks: [{ id: "t1", roleId: "planner", input: "a", dependencies: ["nonexistent"] }],
    };
    expect(() => validateTeamPlan(plan)).toThrow(/non-existent.*nonexistent/i);
  });

  it("rejects empty roles", () => {
    const plan: TeamPlan = { roles: [], tasks: [] };
    expect(() => validateTeamPlan(plan)).toThrow(/at least one role/i);
  });

  it("rejects role with empty name", () => {
    const plan: TeamPlan = {
      roles: [{ name: "", instructions: "x", allowedTools: [], maxRounds: 1 }],
      tasks: [],
    };
    expect(() => validateTeamPlan(plan)).toThrow(/role name/i);
  });

  it("rejects maxRounds out of range", () => {
    const plan: TeamPlan = {
      roles: [{ name: "r", instructions: "x", allowedTools: [], maxRounds: 0 }],
      tasks: [],
    };
    expect(() => validateTeamPlan(plan)).toThrow(/maxRounds/i);
  });
});
```

- [x] **Step 2: 运行测试验证失败**

Run: `pnpm build && npx vitest run packages/agent-runtime/test/team.test.ts`
Expected: FAIL with "Cannot find module '../src/team.js'"

- [x] **Step 3: 最小实现**

```typescript
// packages/agent-runtime/src/team.ts
export interface AgentRole {
  /** Role identifier, e.g. "planner", "coder", "reviewer". */
  readonly name: string;
  /** System prompt instructions for this role. */
  readonly instructions: string;
  /** Tool names this role is allowed to use (subset of the parent registry). */
  readonly allowedTools: readonly string[];
  /** Maximum rounds for this role's child agent. */
  readonly maxRounds: number;
}

export interface TeamTask {
  readonly id: string;
  /** Which role executes this task. */
  readonly roleId: string;
  /** The task prompt sent to the child agent. */
  readonly input: string;
  /** Other task ids that must complete before this one starts. */
  readonly dependencies: readonly string[];
}

export interface TeamPlan {
  readonly roles: readonly AgentRole[];
  readonly tasks: readonly TeamTask[];
}

export interface TeamTaskResult {
  readonly taskId: string;
  readonly roleId: string;
  readonly status: "succeeded" | "failed" | "skipped";
  readonly output?: string | undefined;
  readonly error?: string | undefined;
}

export interface TeamResult {
  readonly completed: boolean;
  readonly reason: "all_succeeded" | "task_failed" | "aborted";
  readonly taskResults: readonly TeamTaskResult[];
}

const MAX_TASK_INPUT_CHARS = 4_000;
const MAX_ROLE_INSTRUCTIONS_CHARS = 8_000;
const MAX_ROUNDS_LIMIT = 20;

export function validateTeamPlan(plan: TeamPlan): void {
  if (plan.roles.length === 0) {
    throw new Error("Team plan must have at least one role");
  }
  const roleNames = new Set<string>();
  for (const role of plan.roles) {
    if (!role.name || typeof role.name !== "string") {
      throw new Error("Team role name must be a non-empty string");
    }
    if (roleNames.has(role.name)) {
      throw new Error(`Duplicate role name: ${role.name}`);
    }
    roleNames.add(role.name);
    if (!role.instructions || typeof role.instructions !== "string") {
      throw new Error(`Role ${role.name} instructions must be a non-empty string`);
    }
    if (role.instructions.length > MAX_ROLE_INSTRUCTIONS_CHARS) {
      throw new Error(
        `Role ${role.name} instructions exceed ${MAX_ROLE_INSTRUCTIONS_CHARS} characters`,
      );
    }
    if (
      !Number.isInteger(role.maxRounds) ||
      role.maxRounds < 1 ||
      role.maxRounds > MAX_ROUNDS_LIMIT
    ) {
      throw new Error(`Role ${role.name} maxRounds must be an integer 1..${MAX_ROUNDS_LIMIT}`);
    }
  }
  const taskIds = new Set<string>();
  for (const task of plan.tasks) {
    if (!task.id || typeof task.id !== "string") {
      throw new Error("Team task id must be a non-empty string");
    }
    if (taskIds.has(task.id)) {
      throw new Error(`Duplicate task id: ${task.id}`);
    }
    taskIds.add(task.id);
    if (!roleNames.has(task.roleId)) {
      throw new Error(`Task ${task.id} references unknown role: ${task.roleId}`);
    }
    if (!task.input || typeof task.input !== "string") {
      throw new Error(`Task ${task.id} input must be a non-empty string`);
    }
    if (task.input.length > MAX_TASK_INPUT_CHARS) {
      throw new Error(`Task ${task.id} input exceeds ${MAX_TASK_INPUT_CHARS} characters`);
    }
    for (const dep of task.dependencies) {
      if (!taskIds.has(dep) && !plan.tasks.some((t) => t.id === dep)) {
        throw new Error(`Task ${task.id} depends on non-existent task: ${dep}`);
      }
    }
  }
  // Check for cycles (reuse graph's topological sort conceptually)
  // We do a simple DFS cycle check here
  const visited = new Map<string, "visiting" | "done">();
  function hasCycle(id: string): boolean {
    const state = visited.get(id);
    if (state === "visiting") return true;
    if (state === "done") return false;
    visited.set(id, "visiting");
    const task = plan.tasks.find((t) => t.id === id);
    if (task) {
      for (const dep of task.dependencies) {
        if (hasCycle(dep)) return true;
      }
    }
    visited.set(id, "done");
    return false;
  }
  for (const task of plan.tasks) {
    if (hasCycle(task.id)) {
      throw new Error(`Cycle detected in team plan involving task: ${task.id}`);
    }
  }
}
```

- [x] **Step 4: 运行测试验证通过**

Run: `pnpm build && npx vitest run packages/agent-runtime/test/team.test.ts`
Expected: PASS

- [x] **Step 5: 提交**

```bash
git add packages/agent-runtime/src/team.ts packages/agent-runtime/test/team.test.ts
git commit -m "feat(agent-runtime): add agent team plan validation and data structures"
```

---

### Task 8: runAgentTeam 编排器

**Files:**

- Modify: `packages/agent-runtime/src/team.ts`
- Modify: `packages/agent-runtime/test/team.test.ts`

**Interfaces:**

- Consumes: `TeamPlan`, `validateTeamPlan` from team.ts, `runTaskGraph`, `createTaskGraph` from graph.ts, `DelegateContext.createAgent` pattern
- Produces: `TeamExecutorOptions`, `runAgentTeam`

- [x] **Step 1: 写失败测试**

在 `team.test.ts` 末尾追加：

```typescript
import { runAgentTeam, type TeamExecutorOptions } from "../src/team.js";

describe("runAgentTeam executor", () => {
  it("executes a simple team plan sequentially", async () => {
    const plan: TeamPlan = {
      roles: [
        { name: "worker", instructions: "You are a worker.", allowedTools: [], maxRounds: 3 },
      ],
      tasks: [
        { id: "t1", roleId: "worker", input: "Do task 1", dependencies: [] },
        { id: "t2", roleId: "worker", input: "Do task 2", dependencies: ["t1"] },
      ],
    };
    const calls: string[] = [];
    const options: TeamExecutorOptions = {
      createAgentForRole: async (role) => ({
        submit: async (input: string) => {
          calls.push(`${role.name}:${input}`);
          return { content: `result for ${input}` };
        },
      }),
    };
    const result = await runAgentTeam(plan, options);
    expect(result.completed).toBe(true);
    expect(result.reason).toBe("all_succeeded");
    expect(result.taskResults).toHaveLength(2);
    expect(result.taskResults[0]!.status).toBe("succeeded");
    expect(result.taskResults[0]!.output).toContain("result for Do task 1");
    expect(calls).toEqual(["worker:Do task 1", "worker:Do task 2"]);
  });

  it("passes role-specific instructions and tools to child agent factory", async () => {
    const plan: TeamPlan = {
      roles: [
        {
          name: "coder",
          instructions: "Write clean code.",
          allowedTools: ["read", "write"],
          maxRounds: 8,
        },
      ],
      tasks: [{ id: "t1", roleId: "coder", input: "Write a function", dependencies: [] }],
    };
    let capturedRole: AgentRole | undefined;
    const options: TeamExecutorOptions = {
      createAgentForRole: async (role) => {
        capturedRole = role;
        return { submit: async () => ({ content: "done" }) };
      },
    };
    await runAgentTeam(plan, options);
    expect(capturedRole?.name).toBe("coder");
    expect(capturedRole?.instructions).toBe("Write clean code.");
    expect(capturedRole?.allowedTools).toEqual(["read", "write"]);
    expect(capturedRole?.maxRounds).toBe(8);
  });

  it("stops on task failure by default", async () => {
    const plan: TeamPlan = {
      roles: [{ name: "worker", instructions: "x", allowedTools: [], maxRounds: 1 }],
      tasks: [
        { id: "t1", roleId: "worker", input: "fail", dependencies: [] },
        { id: "t2", roleId: "worker", input: "skip me", dependencies: ["t1"] },
      ],
    };
    const options: TeamExecutorOptions = {
      createAgentForRole: async () => ({
        submit: async (input: string) => {
          if (input === "fail") throw new Error("task failed");
          return { content: "ok" };
        },
      }),
    };
    const result = await runAgentTeam(plan, options);
    expect(result.completed).toBe(false);
    expect(result.reason).toBe("task_failed");
    expect(result.taskResults.find((r) => r.taskId === "t1")?.status).toBe("failed");
    expect(result.taskResults.find((r) => r.taskId === "t2")?.status).toBe("skipped");
  });

  it("runs independent tasks in parallel", async () => {
    const plan: TeamPlan = {
      roles: [{ name: "worker", instructions: "x", allowedTools: [], maxRounds: 1 }],
      tasks: [
        { id: "t1", roleId: "worker", input: "a", dependencies: [] },
        { id: "t2", roleId: "worker", input: "b", dependencies: [] },
      ],
    };
    let concurrent = 0;
    let maxConcurrent = 0;
    const options: TeamExecutorOptions = {
      createAgentForRole: async () => ({
        submit: async () => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise((r) => setTimeout(r, 30));
          concurrent--;
          return { content: "done" };
        },
      }),
    };
    await runAgentTeam(plan, options);
    expect(maxConcurrent).toBeGreaterThanOrEqual(2);
  });

  it("propagates abort signal", async () => {
    const controller = new AbortController();
    const plan: TeamPlan = {
      roles: [{ name: "worker", instructions: "x", allowedTools: [], maxRounds: 1 }],
      tasks: [{ id: "t1", roleId: "worker", input: "long", dependencies: [] }],
    };
    const options: TeamExecutorOptions = {
      signal: controller.signal,
      createAgentForRole: async () => ({
        submit: async (_input: string, signal?: AbortSignal) => {
          while (!signal?.aborted) {
            await new Promise((r) => setTimeout(r, 10));
          }
          return { content: "aborted" };
        },
      }),
    };
    setTimeout(() => controller.abort(), 50);
    const result = await runAgentTeam(plan, options);
    expect(result.completed).toBe(false);
    expect(result.reason).toBe("aborted");
  });
});
```

- [x] **Step 2: 运行测试验证失败**

Run: `pnpm build && npx vitest run packages/agent-runtime/test/team.test.ts`
Expected: FAIL with "runAgentTeam is not a function"

- [x] **Step 3: 实现 runAgentTeam**

在 `team.ts` 顶部添加 import：

```typescript
import {
  createTaskGraph,
  runTaskGraph,
  type TaskNode,
  type TaskExecutionContext,
} from "./graph.js";
```

在 `team.ts` 末尾追加：

```typescript
export interface TeamAgentRunner {
  submit(input: string, signal?: AbortSignal): Promise<{ content: string }>;
}

export interface TeamExecutorOptions {
  /** Factory: create a child agent for the given role. */
  createAgentForRole(role: AgentRole): Promise<TeamAgentRunner>;
  /** Abort signal for the entire team execution. */
  signal?: AbortSignal;
  /** Continue executing independent tasks after a failure; default false. */
  continueOnError?: boolean;
  /** Maximum concurrent tasks; default 4. */
  maxConcurrency?: number;
}

export async function runAgentTeam(
  plan: TeamPlan,
  options: TeamExecutorOptions,
): Promise<TeamResult> {
  validateTeamPlan(plan);
  const { createAgentForRole, signal, continueOnError = false, maxConcurrency = 4 } = options;

  // Pre-create agents for each role (one agent per role, reused across tasks)
  const roleAgents = new Map<string, TeamAgentRunner>();
  for (const role of plan.roles) {
    roleAgents.set(role.name, await createAgentForRole(role));
  }

  // Build TaskGraph from TeamPlan
  const taskNodes: TaskNode[] = plan.tasks.map((task) => ({
    id: task.id,
    dependencies: task.dependencies,
    executor: async (execCtx: TaskExecutionContext) => {
      const agent = roleAgents.get(task.roleId)!;
      const result = await agent.submit(task.input, execCtx.signal);
      return result.content;
    },
  }));

  const graph = createTaskGraph(taskNodes);
  const graphResult = await runTaskGraph(graph, {
    continueOnError,
    maxConcurrency,
    signal,
  });

  const taskResults: TeamTaskResult[] = plan.tasks.map((task) => {
    if (graphResult.results.has(task.id)) {
      return {
        taskId: task.id,
        roleId: task.roleId,
        status: "succeeded" as const,
        output: graphResult.results.get(task.id),
      };
    }
    if (graphResult.errors.has(task.id)) {
      return {
        taskId: task.id,
        roleId: task.roleId,
        status: "failed" as const,
        error: graphResult.errors.get(task.id)?.message,
      };
    }
    return {
      taskId: task.id,
      roleId: task.roleId,
      status: "skipped" as const,
    };
  });

  const completed = graphResult.completed;
  const reason: TeamResult["reason"] =
    graphResult.reason === "all_succeeded"
      ? "all_succeeded"
      : graphResult.reason === "aborted"
        ? "aborted"
        : "task_failed";

  return { completed, reason, taskResults };
}
```

- [x] **Step 4: 运行测试验证通过**

Run: `pnpm build && npx vitest run packages/agent-runtime/test/team.test.ts`
Expected: PASS

- [x] **Step 5: 提交**

```bash
git add packages/agent-runtime/src/team.ts packages/agent-runtime/test/team.test.ts
git commit -m "feat(agent-runtime): add runAgentTeam orchestrator with graph-based execution"
```

---

### Task 9: team 工具与 agent.ts 集成

**Files:**

- Modify: `packages/agent-runtime/src/index.ts`
- Modify: `packages/agent-runtime/src/agent.ts`
- Modify: `packages/agent-runtime/src/config.ts`
- Create: `packages/agent-runtime/test/team-integration.test.ts`
- Modify: `packages/agent-runtime/test/config-resources-extensions.test.ts`

**Interfaces:**

- Consumes: `runAgentTeam`, `TeamPlan`, `AgentRole` from team.ts, `DelegateContext.createAgent` pattern
- Produces: `team` 工具, config `team` 字段

- [x] **Step 1: 修改 index.ts 导出 team 模块**

按字母序添加：

```typescript
export * from "./team.js";
```

- [x] **Step 2: 修改 config.ts 添加 team 配置**

在 `AgentConfigFile` 中添加（在 `graph` 之后）：

```typescript
  /**
   * Agent team execution defaults. The agent runtime enforces these as hard
   * upper bounds when the model invokes the `team` tool.
   */
  team?: {
    maxConcurrency?: number;
    continueOnError?: boolean;
    maxTasks?: number;
  };
```

在 `ResolvedAgentConfig` 中添加：

```typescript
team: {
  maxConcurrency: number;
  continueOnError: boolean;
  maxTasks: number;
}
```

在 `resolveAgentConfig` 返回对象中添加（在 `graph` 之后）：

```typescript
    team: {
      maxConcurrency: boundedInteger(merged.team?.maxConcurrency, 4, 1, 16),
      continueOnError: merged.team?.continueOnError ?? false,
      maxTasks: boundedInteger(merged.team?.maxTasks, 10, 1, 50),
    },
```

在 `validateAgentConfig` 中添加（在 `graph` 验证之后）：

```typescript
if (config.team !== undefined) {
  if (!config.team || typeof config.team !== "object" || Array.isArray(config.team)) {
    throw new Error(`team must be an object in ${path}`);
  }
  for (const [label, value] of [
    ["maxConcurrency", config.team.maxConcurrency],
    ["maxTasks", config.team.maxTasks],
  ] as const) {
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
      throw new Error(`team.${label} must be a finite number in ${path}`);
    }
  }
  if (
    config.team.continueOnError !== undefined &&
    typeof config.team.continueOnError !== "boolean"
  ) {
    throw new Error(`team.continueOnError must be boolean in ${path}`);
  }
}
```

- [x] **Step 3: 写失败测试 — team 工具集成**

创建 `packages/agent-runtime/test/team-integration.test.ts`：

```typescript
import { describe, expect, it } from "vitest";
import { createTestDirectory } from "@focuscode/testkit";
import {
  CodingAgent,
  SessionStore,
  createCodingToolRegistry,
  type ModelClient,
  type ModelProfile,
  type ModelRequest,
  type ModelResponse,
} from "../src/index.js";

const model: ModelProfile = {
  provider: "fixture",
  model: "fixture",
  protocol: "openai-chat",
  baseUrl: "http://fixture",
  contextWindow: 16_000,
  maxOutputTokens: 1_000,
  temperature: 0,
  toolMode: "native",
  reasoningEffort: "off",
  capabilities: { input: ["text"], reasoning: false, toolCalling: true },
  compatibility: {},
  reliability: {
    timeoutMs: 30_000,
    maxRetries: 0,
    retryBaseDelayMs: 100,
    retryMaximumDelayMs: 1_000,
  },
};

describe("team tool integration", () => {
  it("registers the team tool", async () => {
    const root = await createTestDirectory("team-tools");
    const registry = await createCodingToolRegistry(root);
    const agent = await CodingAgent.create({
      cwd: root,
      model,
      modelClient: new QueueModelClient([]),
      tools: registry.values(),
      toolRegistry: registry,
      permission: { mode: "auto-edit", projectTrusted: true, protectedPaths: [] },
      sessionStore: new SessionStore("unused", false),
      checkpoints: false,
    });
    expect(agent.toolDefinitions().map((t) => t.name)).toContain("team");
  });

  it("executes a team plan and returns results", async () => {
    const root = await createTestDirectory("team-exec");
    const registry = await createCodingToolRegistry(root);
    const modelClient = new QueueModelClient([
      {
        content: "",
        toolCalls: [
          {
            id: "t1",
            name: "team",
            arguments: {
              roles: [
                {
                  name: "researcher",
                  instructions: "You research code.",
                  allowedTools: ["read"],
                  maxRounds: 5,
                },
              ],
              tasks: [
                { id: "r1", roleId: "researcher", input: "Find all exports", dependencies: [] },
              ],
            },
          },
        ],
        usage: { inputTokens: 10, outputTokens: 4 },
        stopReason: "tool_use",
      },
      {
        content: "team done",
        toolCalls: [],
        usage: { inputTokens: 6, outputTokens: 3 },
        stopReason: "stop",
      },
    ]);
    const agent = await CodingAgent.create({
      cwd: root,
      model,
      modelClient,
      tools: registry.values(),
      toolRegistry: registry,
      permission: { mode: "auto-edit", projectTrusted: true, protectedPaths: [] },
      sessionStore: new SessionStore("unused", false),
      checkpoints: false,
      maxRounds: 4,
    });
    const result = await agent.submit("run the team");
    expect(result.content).toBe("team done");
    const toolMessage = agent
      .snapshot()
      .entries.map((e) => e.message)
      .find((m) => m.role === "tool" && m.toolName === "team");
    expect(toolMessage?.content).toContain("completed");
    expect(toolMessage?.content).toContain("r1");
  });
});

class QueueModelClient implements ModelClient {
  readonly protocol = "fixture";
  readonly requests: ModelRequest[] = [];
  constructor(private readonly responses: ModelResponse[]) {}
  async complete(
    request: ModelRequest,
    onEvent?: Parameters<ModelClient["complete"]>[1],
  ): Promise<ModelResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) throw new Error("No scripted response");
    if (response.content) onEvent?.({ type: "text_delta", delta: response.content });
    return response;
  }
}
```

- [x] **Step 4: 运行测试验证失败**

Run: `pnpm build && npx vitest run packages/agent-runtime/test/team-integration.test.ts`
Expected: FAIL — team 工具未注册

- [x] **Step 5: 在 team.ts 中添加 createTeamTool**

在 team.ts 末尾追加：

```typescript
import { SessionStore } from "./session-store.js";
import { AgentToolRegistry } from "./tools.js";
import type {
  AgentTool,
  AgentRuntimeOptions,
  ModelClient,
  ModelProfile,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./types.js";

const TEAM_EXCLUDED_TOOLS = new Set(["delegate", "bash", "todo", "graph", "team"]);

export interface TeamToolContext {
  cwd: string;
  model: ModelProfile;
  modelClient: ModelClient;
  registry: AgentToolRegistry;
  permission: AgentRuntimeOptions["permission"];
  createAgent(options: AgentRuntimeOptions): Promise<{
    submit(input: string, signal?: AbortSignal): Promise<{ content: string }>;
  }>;
}

export function createTeamTool(getContext: () => TeamToolContext): AgentTool {
  return {
    definition: {
      name: "team",
      label: "Agent team",
      description:
        "Orchestrate multiple role-specialized child agents to collaboratively " +
        "complete a set of tasks with dependencies. Each role gets its own " +
        "instructions and tool subset.",
      parameters: {
        type: "object",
        required: ["roles", "tasks"],
        properties: {
          roles: {
            type: "array",
            items: {
              type: "object",
              required: ["name", "instructions", "maxRounds"],
              properties: {
                name: { type: "string", minLength: 1, maxLength: 64 },
                instructions: { type: "string", minLength: 1, maxLength: 8_000 },
                allowedTools: { type: "array", items: { type: "string" } },
                maxRounds: { type: "integer", minimum: 1, maximum: 20 },
              },
            },
          },
          tasks: {
            type: "array",
            items: {
              type: "object",
              required: ["id", "roleId", "input"],
              properties: {
                id: { type: "string", minLength: 1, maxLength: 64 },
                roleId: { type: "string" },
                input: { type: "string", minLength: 1, maxLength: 4_000 },
                dependencies: { type: "array", items: { type: "string" } },
              },
            },
          },
          continueOnError: { type: "boolean" },
        },
      },
      effect: "write",
    },
    async execute(
      args: Record<string, unknown>,
      context: ToolExecutionContext,
    ): Promise<ToolExecutionResult> {
      const roles = Array.isArray(args.roles) ? args.roles : [];
      const tasks = Array.isArray(args.tasks) ? args.tasks : [];
      if (roles.length === 0) {
        return { content: "team: no roles provided", isError: true };
      }
      if (tasks.length === 0) {
        return { content: "team: no tasks provided", isError: true };
      }
      if (tasks.length > 50) {
        return { content: "team: too many tasks (max 50)", isError: true };
      }
      const plan: TeamPlan = {
        roles: roles.map((r: Record<string, unknown>) => ({
          name: String(r.name ?? ""),
          instructions: String(r.instructions ?? ""),
          allowedTools: Array.isArray(r.allowedTools) ? r.allowedTools.map(String) : [],
          maxRounds: typeof r.maxRounds === "number" ? r.maxRounds : 8,
        })),
        tasks: tasks.map((t: Record<string, unknown>) => ({
          id: String(t.id ?? ""),
          roleId: String(t.roleId ?? ""),
          input: String(t.input ?? ""),
          dependencies: Array.isArray(t.dependencies) ? t.dependencies.map(String) : [],
        })),
      };
      try {
        validateTeamPlan(plan);
      } catch (error) {
        return {
          content: `team: invalid plan — ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }
      const ctx = getContext();
      const childRegistry = new AgentToolRegistry(
        ctx.registry.values().filter((t) => !TEAM_EXCLUDED_TOOLS.has(t.definition.name)),
      );
      const continueOnError = args.continueOnError === true;
      const result = await runAgentTeam(plan, {
        continueOnError,
        signal: context.signal,
        createAgentForRole: async (role) => {
          const roleTools = childRegistry
            .values()
            .filter((t) => role.allowedTools.includes(t.definition.name));
          const roleRegistry = new AgentToolRegistry(roleTools);
          const child = await ctx.createAgent({
            cwd: ctx.cwd,
            model: ctx.model,
            modelClient: ctx.modelClient,
            tools: roleRegistry.values(),
            toolRegistry: roleRegistry,
            permission: ctx.permission,
            sessionStore: new SessionStore("team", false),
            maxRounds: role.maxRounds,
            ...(role.instructions ? { instructions: [role.instructions] } : {}),
          });
          return child;
        },
      });
      const lines: string[] = [
        `team: ${result.completed ? "completed" : "incomplete"} (${result.reason})`,
        `tasks: ${result.taskResults.filter((r) => r.status === "succeeded").length} succeeded, ${result.taskResults.filter((r) => r.status === "failed").length} failed, ${result.taskResults.filter((r) => r.status === "skipped").length} skipped`,
      ];
      for (const tr of result.taskResults) {
        const icon = tr.status === "succeeded" ? "ok" : tr.status === "failed" ? "fail" : "skip";
        const detail =
          tr.status === "succeeded"
            ? (tr.output ?? "").slice(0, 500)
            : tr.status === "failed"
              ? (tr.error ?? "unknown error")
              : "skipped";
        lines.push(`  ${icon} ${tr.taskId} [${tr.roleId}]: ${detail}`);
      }
      return { content: lines.join("\n") };
    },
  };
}
```

- [x] **Step 6: 在 agent.ts 中注册 team 工具**

在 agent.ts 顶部添加 import：

```typescript
import { createTeamTool } from "./team.js";
```

在构造函数中，在 graph 工具注册之后添加：

```typescript
if (this.registry.get("team") === undefined) {
  this.registry.register(
    createTeamTool(() => ({
      cwd: this.options.cwd,
      model: this.model,
      modelClient: this.modelClient,
      registry: this.registry,
      permission: this.options.permission,
      createAgent: (childOptions) =>
        CodingAgent.create({
          ...childOptions,
          enableDelegate: false,
          checkpoints: false,
          enableGoal: false,
        }),
    })),
  );
}
```

- [x] **Step 7: 运行测试验证通过**

Run: `pnpm build && npx vitest run packages/agent-runtime/test/team-integration.test.ts`
Expected: PASS

- [x] **Step 8: 提交**

```bash
git add packages/agent-runtime/src/team.ts packages/agent-runtime/src/index.ts \
        packages/agent-runtime/src/agent.ts packages/agent-runtime/src/config.ts \
        packages/agent-runtime/test/team-integration.test.ts \
        packages/agent-runtime/test/config-resources-extensions.test.ts
git commit -m "feat(agent-runtime): add team tool with multi-agent orchestration and config"
```

---

## Phase 3: 集成验收

### Task 10: pnpm verify 全量验收与文档更新

**Files:**

- Run: `pnpm verify`
- Modify: `docs/superpowers/plans/2026-07-22-teams-graph-lsp.md` — 添加执行进度记录

- [x] **Step 1: 运行 pnpm verify**

Run: `pnpm verify`
Expected:

- check-boundaries.mjs 通过（agent-runtime 不依赖禁止包）
- prettier --check . 通过
- pnpm build 通过
- vitest run 全部通过
- coverage 阈值全部超过 75/60/80/80

- [x] **Step 2: 如有失败，修复后重新验证**

常见问题：

- `exactOptionalPropertyTypes` 错误：所有可选属性类型加 `| undefined`
- prettier 格式：运行 `pnpm format`
- 架构边界：检查是否误引入了对 harness-core/model-gateway 等的依赖
- 测试超时：vitest 超时 15s，graph/team 测试中的 setTimeout 不要超过 5s

- [x] **Step 3: 更新计划文档执行进度**

在本文档末尾添加"执行进度记录"章节，记录：

- 每个 Task 的完成状态
- 关键决策与类型修复
- 最终 pnpm verify 结果（test files / tests / coverage）
- Phase 2/3 总结

- [x] **Step 4: 提交**

```bash
git add docs/superpowers/plans/2026-07-22-teams-graph-lsp.md
git commit -m "docs: record Phase 2/3 execution progress"
```

---

## 自审清单

### 规格覆盖

- [x] LSP 多语言诊断：Task 1-3 覆盖 DiagnosticProvider 接口、4 个内置 provider（TS/Python/Go/Rust）、config 集成、agent.ts 诊断标签动态化
- [x] Graph DAG：Task 4-6 覆盖 TaskGraph 数据结构、拓扑排序、循环检测、并行执行器、fail-fast/continueOnError、graph 工具
- [x] Agent Teams：Task 7-9 覆盖 AgentRole/TeamPlan 数据结构、validateTeamPlan、runAgentTeam 编排器、team 工具
- [x] 集成验收：Task 10 覆盖 pnpm verify 全量门禁

### 架构边界合规

- [x] 所有新文件在 `packages/agent-runtime/src/`，不依赖 harness-core/model-gateway/persistence/sdk/auth/ecosystem/sandbox/tui
- [x] diagnostic-providers.ts 使用 `node:child_process`（diagnostics.ts 已有先例）和 `node:fs`（已有先例）
- [x] graph.ts 和 team.ts 不使用 node:fs/node:child_process，纯逻辑模块
- [x] team.ts 依赖 graph.ts（同包内依赖，允许）
- [x] graph 工具和 team 工具复用 DelegateContext.createAgent 模式，不绕过权限/沙箱

### 向后兼容

- [x] `agent.diagnostics` 从 boolean 扩展为 `boolean | { providers?: string[] }`，现有配置仍可用
- [x] `runDiagnostics` 和 `shouldRunDiagnostics` 保持原有签名，agent.ts 现有调用点可平滑迁移
- [x] 新增 config 字段（graph/team）都有默认值，不破坏现有配置

### 类型一致性

- [x] `DiagnosticProviderResult.output` 类型为 `string | undefined`（与 `DiagnosticsResult.output` 一致）
- [x] `TaskNode.executor` 返回 `Promise<string>`，graph 工具和 team 工具中都一致
- [x] `TeamTaskResult.status` 枚举 "succeeded" | "failed" | "skipped"，与 `NodeResult.status` 一致
- [x] `GraphExecutionResult.reason` 和 `TeamResult.reason` 使用各自独立的枚举（graph 有 "all_succeeded" | "node_failed" | "aborted"，team 映射为 "all_succeeded" | "task_failed" | "aborted"）

---

## 执行进度记录

### Phase 2A: LSP 多语言诊断 (Task 1-3) — ✅ 完成

- `packages/agent-runtime/src/diagnostic-providers.ts`：实现 `DiagnosticProvider` 接口与 4 个内置 provider（TypeScript `tsc --noEmit`、Python `pyright`/`ruff`、Go `go build`、Rust `cargo check`），运行时探测工具链可用性（fail-quiet）。
- `packages/agent-runtime/src/diagnostics.ts`：从硬编码 `tsc --noEmit` 重构为 provider 注册机制，`runDiagnosticsAll` 遍历所有 provider 并合并结果。
- `packages/agent-runtime/src/config.ts`：`AgentConfigFile.diagnostics` 扩展为 `{ enabled: boolean; providers: string[] | undefined }`，`validateAgentConfig` 增加 providers 数组校验。
- `packages/agent-runtime/src/agent.ts`：`CodingAgentOptions.diagnostics` 同步扩展，system prompt 诊断标签根据 enabled providers 动态生成。
- `packages/agent-runtime/test/diagnostic-providers.test.ts`：覆盖 provider 注册、可用性探测、结果合并、config 集成。
- 架构边界合规：仅使用 `node:child_process` 与 `node:fs`（diagnostics.ts 已有先例）。

### Phase 2B: Graph DAG (Task 4-6) — ✅ 完成

- `packages/agent-runtime/src/graph.ts`：实现 `TaskGraph`（nodes + nodeMap）、`createTaskGraph`（重复 id 检测）、`topologicalSort`（Kahn 算法 + 依赖完整性校验 + `GraphCycleError`）、`runTaskGraph`（level-batched 并发执行，maxConcurrency/continueOnError/abort signal）。
- `createGraphTool`：`GraphToolContext` 接口（复用 DelegateContext.createAgent 模式）、`GRAPH_EXCLUDED_TOOLS = Set(["graph","delegate","bash"])` 子代理工具裁剪、`graphDefaults` config 级默认值（maxConcurrency 作为硬上限，continueOnError 可被 tool 参数覆盖）。
- `packages/agent-runtime/src/agent.ts`：添加 `enableGraph?` 和 `graph?` 选项，构造函数中注册 graph 工具（在 goal 之后），子代理 `enableGraph: false`。
- `packages/agent-runtime/src/config.ts`：添加 `graph` 配置字段（maxConcurrency 默认 4/范围 1-16，continueOnError 默认 false）。
- `apps/cli/src/agent-command.ts`：传递 `graph: config.graph`。
- `packages/agent-runtime/test/graph.test.ts` + `graph-integration.test.ts`：覆盖拓扑排序、循环检测、并行执行、fail-fast/continueOnError、工具注册/禁用、DAG 端到端执行、子代理工具裁剪。

### Phase 2C: Agent Teams (Task 7-9) — ✅ 完成

- `packages/agent-runtime/src/team.ts`：
  - `TeamRole`（name + instructions + allowedTools + maxRounds）、`TeamTask`（id + roleId + input + dependencies）、`TeamPlan`、`TeamTaskResult`、`TeamResult` 数据结构。
  - `validateTeamPlan`：非空 roles、唯一 role/task id、已知 role 引用、有效依赖边、DFS 循环检测。
  - `runAgentTeam`：按 role 创建子代理（每 role 一个，复用）→ 构建 TaskGraph → 复用 `runTaskGraph` 调度 → 映射回 `TeamResult`。
  - `createTeamTool`：`TeamToolContext` 接口、`TEAM_EXCLUDED_TOOLS = Set(["team","graph","delegate","bash"])`（比 graph 多排除 team 和 graph，防止嵌套）、`teamDefaults` config 级默认值（maxConcurrency/maxTasks 硬上限，continueOnError 可被 tool 参数覆盖）、每个 role 获得独立 childRegistry 并按 `role.allowedTools` 进一步过滤。
- `packages/agent-runtime/src/agent.ts`：添加 `enableTeam?` 和 `team?` 选项，构造函数中注册 team 工具（在 graph 之后），子代理 `enableTeam: false, enableGraph: false`。
- `packages/agent-runtime/src/config.ts`：添加 `team` 配置字段（maxConcurrency 默认 4/范围 1-16，continueOnError 默认 false，maxTasks 默认 10/范围 1-50）。
- `packages/agent-runtime/src/index.ts`：导出 `team.js`。
- `apps/cli/src/agent-command.ts`：传递 `team: config.team`。
- `packages/agent-runtime/test/team.test.ts` + `team-integration.test.ts`：覆盖 validateTeamPlan、runAgentTeam、team 工具注册/禁用、DAG 端到端执行、子代理工具裁剪（role allowedTools=["read"] 时子代理只有 read，不含 team/graph/delegate/bash/write）、无效计划错误处理。

### Phase 3: 集成验收 (Task 10) — ✅ 完成

**pnpm verify 结果（2026-07-22）：**

- ✅ `pnpm lint`：Architecture boundary check passed / All 11 canonical schemas in sync / All matched files use Prettier code style
- ✅ `pnpm build`：全部 17 个包编译通过（agent-runtime、cli、sdk、harness-worker 等）
- ✅ `pnpm test:coverage`：
  - Test Files: **66 passed | 1 skipped (67)**
  - Tests: **547 passed | 10 skipped (557)** — 0 failed
  - Coverage: statements **80.33** / branches **69.85** / functions **85.56** / lines **83.59** — 全部超过阈值 75/60/80/80

**关键决策与类型修复：**

- `exactOptionalPropertyTypes: true` 要求所有可选属性在条件展开时使用 `...(cond ? { field: value } : {})` 模式，避免 `undefined` 显式赋值。
- `TEAM_EXCLUDED_TOOLS` 比 `GRAPH_EXCLUDED_TOOLS` 多排除 `"team"` 和 `"graph"`，防止 team 子代理嵌套调用 team 或 graph（避免无限递归和上下文爆炸）。
- `teamDefaults.maxTasks` 作为硬上限（不像 continueOnError 可被 tool 参数覆盖），因为 maxTasks 是安全边界而非执行策略。
- graph 和 team 的 `createAgent` 回调都设置 `enableDelegate: false, enableGraph: false, enableTeam: false`（team 子代理），确保子代理不能再创建子代理。
- `TeamResult.reason` 使用 `"task_failed"`（而 graph 是 `"node_failed"`），语义更贴合 team 语境。

### Phase 2/3 总结

三个子系统（LSP 多语言诊断、Graph DAG、Agent Teams）全部按 TDD 流程实现并通过 pnpm verify 全量门禁。FocusCode agent-runtime 现在具备：

1. **多语言诊断**：不限于 TypeScript，支持 Python/Go/Rust，运行时探测工具链，fail-quiet 不阻塞。
2. **任务依赖图**：模型可声明 DAG 子任务，并行调度无依赖节点，串行等待依赖，支持 fail-fast 和 continue-on-error。
3. **多代理协作**：模型可声明多角色团队（每角色独立指令和工具子集）和任务 DAG，team 编排器按角色创建子代理并复用 runTaskGraph 调度。

所有新增代码遵守 agent-runtime 架构边界（不依赖 harness-core/model-gateway/persistence/sdk/auth/ecosystem/sandbox/tui），复用现有 DelegateContext.createAgent 模式，不绕过权限/沙箱。
