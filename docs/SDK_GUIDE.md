# FocusCode SDK 指南

> **版本**：`@focuscode/sdk@0.5.0`
> **状态**：生产可用（Apache-2.0）
> **信息来源**：`packages/sdk/src/*.ts`、`packages/sdk/test/*.ts`、`examples/sdk/`
> **最后更新**：2026-07-28

---

## 目录

1. [安装](#1-安装)
2. [30 秒快速开始](#2-30-秒快速开始)
3. [核心概念：双路径架构](#3-核心概念双路径架构)
4. [会话型路径：createCodingAgent](#4-会话型路径createcodingagent)
5. [审计型路径：createLocalHarness](#5-审计型路径createlocalharness)
6. [流式输出：streamSubmit](#6-流式输出streamsubmit)
7. [自定义工具：tool() DSL](#7-自定义工具tool-dsl)
8. [生命周期钩子：hooks](#8-生命周期钩子hooks)
9. [权限与审批](#9-权限与审批)
10. [OAuth 凭据管理](#10-oauth-凭据管理)
11. [沙箱隔离](#11-沙箱隔离)
12. [扩展系统](#12-扩展系统)
13. [企业模式](#13-企业模式)
14. [端口注入](#14-端口注入)
15. [错误处理](#15-错误处理)
16. [Cookbook 示例索引](#16-cookbook-示例索引)
17. [API 参考](#17-api-参考)
18. [与竞品 SDK 对比](#18-与竞品-sdk-对比)
19. [FAQ](#19-faq)

---

## 1. 安装

```bash
npm install @focuscode/sdk
# 或
pnpm add @focuscode/sdk
# 或
yarn add @focuscode/sdk
```

**前置要求**：

- Node.js `>=22.12.0`
- ESM 项目（`"type": "module"` in `package.json`）

**验证安装**：

```typescript
import {
  createCodingAgent,
  createLocalHarness,
  streamSubmit,
  tool,
  createHooks,
} from "@focuscode/sdk";
console.log("FocusCode SDK loaded ✓");
```

---

## 2. 30 秒快速开始

### 2.1 审计型 Harness（无需 API Key）

```typescript
import { createLocalHarness } from "@focuscode/sdk";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 1. 准备最小仓库
const repoRoot = await mkdtemp(join(tmpdir(), "demo-"));
await mkdir(join(repoRoot, ".focuscode"), { recursive: true });
await mkdir(join(repoRoot, "src"), { recursive: true });
await writeFile(join(repoRoot, "src", "math.js"), "export function add(a, b) { return a - b; }\n");
await writeFile(
  join(repoRoot, ".focuscode", "config.json"),
  JSON.stringify({
    schemaVersion: "focuscode-repo.v1",
    protectedPaths: [".git", ".focuscode"],
    commands: [{ id: "test", argv: [process.execPath, "--test"], timeoutMs: 30_000 }],
    verificationCommandIds: ["test"],
  }),
);

// 2. 构造 Harness（scripted 模型，确定性回放）
const harness = await createLocalHarness({
  repoRoot,
  stateDirectory: await mkdtemp(join(tmpdir(), "state-")),
  approvalMode: "auto-safe",
  trustRepoConfig: true,
  model: {
    kind: "scripted",
    steps: [
      {
        kind: "tool_intent_template",
        intents: [
          {
            toolId: "apply_edit_ir",
            arguments: {
              path: "src/math.js",
              edits: [{ search: "a - b", replace: "a + b", expectedOccurrences: 1 }],
            },
            expectedEffects: [
              { class: "file_write", resource: "src/math.js", description: "Fix operator" },
            ],
            justification: "Unique one-line repair",
          },
        ],
      },
      { kind: "completion_candidate", summary: "fixed", evidence: [], residualRisks: [] },
    ],
  },
});

// 3. 提交任务
const result = await harness.run(
  {
    schemaVersion: "task-spec.v1",
    repoId: repoRoot,
    baseRef: "WORKTREE",
    mode: "change",
    objective: "Fix the add function",
    acceptanceCriteria: [{ id: "test", description: "Tests pass" }],
  },
  { taskId: "demo-001" },
);

console.log("State:", result.checkpoint.state); // REVIEW_READY
console.log("Verification:", result.verification?.conclusion); // PASS
```

### 2.2 会话型 Agent（需 API Key）

```typescript
import { createCodingAgent } from "@focuscode/sdk";

const { agent } = await createCodingAgent({
  cwd: process.cwd(),
  provider: "openai",
  model: "gpt-4o",
  baseUrl: "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY,
  approval: "auto-edit",
  sandbox: { kind: "docker" },
});

const result = await agent.submit("Refactor utils.ts to use async/await");
console.log("Response:", result.content);
console.log("Stopped:", result.stopped);
console.log("Tool calls:", result.toolCalls);
```

---

## 3. 核心概念：双路径架构

FocusCode SDK 是唯一同时提供**两条执行路径**的 Coding Agent SDK：

```
                    ┌─ createCodingAgent ──→ 会话型 Coding Agent
                    │                         ├─ 低延迟交互
                    │                         ├─ Mid-turn steering
                    │                         ├─ 工具循环 + 权限
                    │                         └─ Session JSONL 持久化
@focuscode/sdk ─────┤
                    │                         ├─ 可重放审计
                    └─ createLocalHarness ──→ 审计型 Focus Kernel
                                              ├─ Intent → Grant → Receipt → Verifier
                                              ├─ 确定性完成 Gate
                                              ├─ Effect Ledger
                                              └─ Crash-safe resume
```

| 维度         | 会话型（createCodingAgent）  | 审计型（createLocalHarness）                      |
| ------------ | ---------------------------- | ------------------------------------------------- |
| **延迟**     | 低（流式 token）             | 高（完整 round-trip）                             |
| **用途**     | 交互式编程助手、IDE 集成     | CI/CD 自动化、合规审计、企业批量任务              |
| **完成**     | 无确定性 Gate（靠模型 stop） | 确定性完成 Gate（Verifier 验证后才 REVIEW_READY） |
| **重放**     | Session JSONL 可回放         | Fact Store append-only 可重放                     |
| **审计**     | 可选 EffectSpine             | 强制 Intent→Grant→Receipt→Verifier 全链路         |
| **Steering** | ✅ append/interrupt/followup | ❌（任务一次性提交）                              |

**选择建议**：

- 构建 **IDE 插件 / 聊天助手** → 用 `createCodingAgent`
- 构建 **CI 自动修复 / 合规审计管线** → 用 `createLocalHarness`
- **两者结合** → 用 `createCodingAgent` + `effectSpine: true`（会话型 + 审计脊）

---

## 4. 会话型路径：createCodingAgent

### 4.1 基本用法

```typescript
import { createCodingAgent } from "@focuscode/sdk";

const created = await createCodingAgent({
  cwd: "/path/to/repo",
  provider: "kimi", // 支持 kimi/qwen/glm/deepseek/minimax/openai/anthropic/gemini/ollama
  model: "k2",
  apiKey: process.env.KIMI_API_KEY,
  approval: "auto-edit", // "deny" | "prompt" | "auto-edit" | "full-auto"
  sandbox: { kind: "docker" }, // "auto" | "docker" | "gvisor" | "seatbelt" | "vm" | "host"
  maxRounds: 40,
});

const { agent, sessions, extensions, resources, config } = created;

// 提交 prompt
const result = await agent.submit("Add unit tests for src/math.ts");
console.log(result.content);
console.log(result.toolCalls); // 工具调用次数
console.log(result.stopped); // "stop" | "tool_use" | "length" | "max_rounds" | "aborted" | "error"
```

### 4.2 返回值

```typescript
interface CreatedCodingAgent {
  agent: CodingAgent; // 核心 Agent 实例
  sessions: SessionStore; // 会话存储（JSONL 持久化）
  extensions: ExtensionHost; // 扩展宿主
  resources: AgentResources; // 加载的 Instructions/Skills/Extensions
  config: ResolvedAgentConfig; // 解析后的完整配置
}
```

### 4.3 恢复已有会话

```typescript
const { agent } = await createCodingAgent({
  cwd: "/path/to/repo",
  sessionId: "existing-session-id", // 恢复已有会话
  persistentSession: true, // 持久化到 JSONL
});
```

### 4.4 Mid-turn Steering

```typescript
// 在 agent 执行过程中追加输入
agent.steer({ type: "append", content: "Also fix the subtract function" });

// 中断当前执行
agent.steer({ type: "interrupt", content: "Stop, let's rethink" });

// 后续追问
agent.steer({ type: "followup", content: "What about division?" });
```

### 4.5 关键选项

| 选项                  | 类型                    | 说明                                                           |
| --------------------- | ----------------------- | -------------------------------------------------------------- |
| `cwd`                 | `string`                | 工作目录（必需）                                               |
| `provider`            | `string`                | Provider 标识（`kimi`/`openai`/`anthropic`/...）               |
| `model`               | `string`                | 模型标识                                                       |
| `apiKey`              | `string`                | API Key（也可用环境变量）                                      |
| `baseUrl`             | `string`                | 自定义 API 端点                                                |
| `approval`            | `ApprovalMode`          | 审批模式                                                       |
| `sandbox`             | `{ kind: SandboxKind }` | 沙箱类型                                                       |
| `sessionId`           | `string`                | 恢复已有会话                                                   |
| `sessionName`         | `string`                | 会话名称                                                       |
| `persistentSession`   | `boolean`               | 是否持久化会话（默认 `true`）                                  |
| `extensionPaths`      | `string[]`              | 额外扩展路径                                                   |
| `approve`             | `ApprovalHandler`       | 自定义审批处理器                                               |
| `onEvent`             | `(event) => void`       | 事件回调                                                       |
| `hooks`               | `AgentHooks`            | 生命周期钩子                                                   |
| `accessTokenProvider` | `() => Promise<string>` | OAuth token 提供器                                             |
| `shellExecutor`       | `ShellExecutor`         | 自定义 Shell 执行器                                            |
| `effectSpine`         | `boolean`               | 是否启用 EffectSpine 审计脊（默认 `config.agent.effectSpine`） |

---

## 5. 审计型路径：createLocalHarness

### 5.1 基本用法

```typescript
import { createLocalHarness } from "@focuscode/sdk";

const harness = await createLocalHarness({
  repoRoot: "/path/to/repo",
  stateDirectory: "/path/to/state", // Fact Store + Memory 持久化目录
  approvalMode: "auto-safe", // "deny" | "prompt" | "auto-safe"
  trustRepoConfig: true, // 信任 .focuscode/config.json
  model: {
    kind: "openai-compatible",
    provider: "kimi",
    model: "k2",
    baseUrl: "https://api.moonshot.cn/v1",
    apiKey: process.env.KIMI_API_KEY,
  },
});

const result = await harness.run(
  {
    schemaVersion: "task-spec.v1",
    repoId: "/path/to/repo",
    baseRef: "WORKTREE",
    mode: "change",
    objective: "Fix the failing test in src/math.ts",
    acceptanceCriteria: [{ id: "test", description: "npm test passes" }],
  },
  { taskId: "fix-math-001" },
);
```

### 5.2 返回值

```typescript
interface LocalHarness {
  facts: FileFactStore; // Fact Store（append-only 事件日志）
  memory: FileMemoryStore; // Memory Store
  actions: LocalActionRuntime; // Action Runtime（执行工具调用）
  profile: RepoProfileV1; // 仓库 Profile
  model: CertifiedModelRefV1; // 模型引用
  kernel: FocusKernel; // Focus Kernel 实例
  run(spec: TaskSpecV1, options?: { taskId?: string }): Promise<KernelResult>;
}
```

### 5.3 任务状态机

```
PENDING → PLANNING → EXECUTING → VERIFYING → REVIEW_READY
                ↓         ↓          ↓
              FAILED   FAILED    FAILED
```

- `REVIEW_READY`：Verifier 通过，等待人工 review
- `FAILED`：任何阶段失败，可查看 `result.checkpoint.error`

### 5.4 确定性测试（无需 API Key）

```typescript
const harness = await createLocalHarness({
  repoRoot,
  stateDirectory,
  model: {
    kind: "scripted",  // 回放预录制的决策序列
    steps: [
      { kind: "tool_intent_template", intents: [...] },
      { kind: "completion_candidate", summary: "done", evidence: [], residualRisks: [] },
    ],
  },
  // 可选：注入 always-pass verifier 使 CI 确定性通过
  verifier: {
    async verify(request) {
      return { schemaVersion: "verification-report.v1", conclusion: "PASS", phase: request.phase, results: [], summary: "scripted pass" };
    },
  },
});
```

---

## 6. 流式输出：streamSubmit

把 `agent.submit()` 的 Promise + eventSink 回调包装为原生 `AsyncIterable<AgentEvent>`，对齐 Claude Agent SDK 的流式接口。

```typescript
import { createCodingAgent, streamSubmit } from "@focuscode/sdk";

const { agent } = await createCodingAgent({
  cwd: process.cwd(),
  provider: "kimi",
  model: "k2",
  apiKey: process.env.KIMI_API_KEY,
});

// 方式 1：原生 AsyncIterable
const stream = streamSubmit(agent, "Refactor utils.ts");
for await (const event of stream) {
  switch (event.type) {
    case "text_delta":
      process.stdout.write(event.delta);
      break;
    case "tool_start":
      console.log("\n→ Tool:", event.call.name);
      break;
    case "tool_end":
      console.log("  Result:", event.result.content.slice(0, 100));
      break;
    case "agent_end":
      console.log("\n✓ Done");
      break;
  }
}

// 获取最终结果（Promise 兼容）
const result = await stream.result;
console.log("Stopped:", result.stopped);
```

### 6.1 事件类型

| 事件类型            | 触发时机             | 关键字段                                 |
| ------------------- | -------------------- | ---------------------------------------- |
| `agent_start`       | 每次 `submit()` 开始 | `sessionId`, `turn`                      |
| `text_delta`        | 模型输出 token       | `delta`                                  |
| `tool_start`        | 工具调用开始         | `call.id`, `call.name`, `call.arguments` |
| `tool_end`          | 工具调用结束         | `call`, `result`, `durationMs`           |
| `approval_required` | 需要用户审批         | `request`                                |
| `agent_end`         | 每次 `submit()` 结束 | `response` (AgentRunResult)              |
| `error`             | 错误发生             | `error`                                  |

### 6.2 AbortSignal 支持

```typescript
const controller = new AbortController();
const stream = streamSubmit(agent, "Long running task", { signal: controller.signal });

// 5 秒后取消
setTimeout(() => controller.abort(), 5000);

for await (const event of stream) {
  if (event.type === "error" && event.error.name === "AbortError") {
    console.log("Task aborted");
    break;
  }
}
```

---

## 7. 自定义工具：tool() DSL

一行式定义进程内工具，对齐 Claude Agent SDK 的 `tool(name, schema, handler)`。

```typescript
import { createCodingAgent, tool } from "@focuscode/sdk";

const myTool = tool(
  "search_docs",
  {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      limit: { type: "number", description: "Max results", default: 5 },
    },
    required: ["query"],
  },
  async (args, context) => {
    // args 已通过 JSON Schema 校验
    // context.cwd 是工作目录
    const results = await mySearchEngine.search(args.query, args.limit);
    return {
      content: JSON.stringify(results, null, 2),
      // 可选元数据
      metadata: { count: results.length },
    };
  },
);

const { agent } = await createCodingAgent({
  cwd: process.cwd(),
  provider: "kimi",
  model: "k2",
  apiKey: process.env.KIMI_API_KEY,
  // 注入自定义工具
  tools: [myTool],
});
```

### 7.1 工具接口

```typescript
interface AgentTool {
  definition: {
    name: string;
    description: string;
    parameters: JSONSchema; // JSON Schema for argument validation
  };
  execute(
    argumentsValue: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult>;
}

interface ToolExecutionResult {
  content: string; // 返回给模型的内容
  isError?: boolean; // 标记为错误结果
  metadata?: Record<string, unknown>; // 可选元数据
}
```

---

## 8. 生命周期钩子：hooks

SDK 提供 4 类生命周期钩子，与现有 `beforeTool` veto hook 互补：

| Hook           | 触发时机                  | 参数                                     |
| -------------- | ------------------------- | ---------------------------------------- |
| `postToolUse`  | 工具执行完毕后            | `PostToolContext`, `ToolExecutionResult` |
| `sessionStart` | 会话创建（集成者调用）    | `SessionContext`                         |
| `sessionEnd`   | 会话结束（集成者调用）    | `SessionContext`                         |
| `stop`         | Agent 停止（每次 submit） | `StopReason`                             |

```typescript
import { createCodingAgent, createHooks } from "@focuscode/sdk";

const { agent } = await createCodingAgent({
  cwd: process.cwd(),
  provider: "kimi",
  model: "k2",
  apiKey: process.env.KIMI_API_KEY,
  hooks: createHooks({
    postToolUse: async (ctx, result) => {
      metrics.recordTool(ctx.toolName, ctx.durationMs);
      if (result.isError) {
        telemetry.error("tool_failed", { tool: ctx.toolName });
      }
    },
    stop: async (reason) => {
      if (reason === "max_rounds") console.warn("⚠ Round ceiling hit");
      if (reason === "length") console.warn("⚠ Output truncated");
    },
    sessionStart: async (ctx) => {
      console.log(`Session ${ctx.sessionId} started on ${ctx.model}`);
    },
    sessionEnd: async (ctx) => {
      console.log(`Session ${ctx.sessionId} ended`);
    },
  }),
});

// 手动触发 sessionStart/sessionEnd
await agent.options?.hooks?.sessionStart?.({
  sessionId: agent.sessionId,
  cwd: process.cwd(),
  model: "kimi/k2",
});
```

### 8.1 onEvent 与 hooks 的关系

`onEvent` 和 `hooks` 可以同时使用，**叠加而非互斥**：

```typescript
const { agent } = await createCodingAgent({
  cwd: process.cwd(),
  onEvent: (event) => logger.debug(event.type), // 所有事件
  hooks: createHooks({
    postToolUse: async (ctx) => audit.log(ctx.toolName), // 仅 tool_end
  }),
});
```

调用顺序：`onEvent` 先执行，然后 `hooks` 分发。

---

## 9. 权限与审批

### 9.1 审批模式

| 模式        | 说明                                | 适用场景   |
| ----------- | ----------------------------------- | ---------- |
| `deny`      | 所有需要审批的操作直接拒绝          | CI/CD      |
| `prompt`    | 通过 `ApprovalHandler` 回调询问用户 | 交互式 IDE |
| `auto-edit` | 自动允许文件编辑，其他操作需审批    | 半自动     |
| `full-auto` | 自动允许所有操作（危险）            | 受信任沙箱 |

### 9.2 自定义审批处理器

```typescript
const { agent } = await createCodingAgent({
  cwd: process.cwd(),
  approval: "prompt",
  approve: async (request) => {
    // request.toolName, request.arguments, request.cwd
    const userChoice = await showVSCodeDialog(
      `Allow ${request.toolName} with ${JSON.stringify(request.arguments)}?`,
    );
    return userChoice ? "allow" : "deny";
  },
});
```

### 9.3 execpolicy 前缀规则

在 `.focuscode/config.json` 中声明 Bash 命令前缀白名单：

```json
{
  "execpolicy": {
    "allowedPrefixes": ["git status", "npm test", "pnpm build"],
    "deniedPrefixes": ["rm -rf", "curl", "wget"]
  }
}
```

deny-first 顺序求值：denied 优先于 allowed。

---

## 10. OAuth 凭据管理

FocusCode SDK 内置完整的 OAuth 2.0 / PKCE / device flow / refresh 支持：

```typescript
import { createCodingAgent } from "@focuscode/sdk";

const { agent } = await createCodingAgent({
  cwd: process.cwd(),
  provider: "kimi",
  model: "k2",
  authType: "oauth", // 使用 OAuth 而非 API Key
  accessTokenProvider: async () => {
    // SDK 会自动管理 token 刷新
    // 这里可以集成你自己的凭据库
    return getStoredToken("kimi");
  },
});
```

**支持的 Provider OAuth**：Kimi、Qwen、GLM、DeepSeek、MiniMax

**凭据安全**：

- Provider secret 不进入 Prompt / Session / Tool 环境或普通日志
- client secret 走 `FOCUSCODE_<PROVIDER>_CLIENT_SECRET` 环境变量
- 凭据库使用 AES-256-GCM 加密

---

## 11. 沙箱隔离

SDK 提供四类 OS 级沙箱，默认断网：

| 沙箱类型   | 平台   | 隔离级别   | 适用场景                           |
| ---------- | ------ | ---------- | ---------------------------------- |
| `gvisor`   | Linux  | 内核级     | 生产环境（推荐）                   |
| `docker`   | 全平台 | 容器级     | 开发/CI                            |
| `seatbelt` | macOS  | 系统调用级 | 本地开发（无需 Docker）            |
| `vm`       | 全平台 | 虚拟机级   | 最高隔离要求                       |
| `host`     | 全平台 | 无隔离     | **仅兼容路径，非安全沙箱**         |
| `auto`     | -      | 自动选择   | 默认（gVisor → Docker → seatbelt） |

```typescript
const { agent } = await createCodingAgent({
  cwd: process.cwd(),
  sandbox: {
    kind: "docker",
    image: "node:22-slim", // 指定镜像
    network: false, // 默认断网
    requireImageDigest: true, // 企业模式：强制镜像 digest pin
  },
});

// 或自定义 Shell 执行器
const { agent: agent2 } = await createCodingAgent({
  cwd: process.cwd(),
  shellExecutor: {
    kind: "custom",
    execute: async (command, context) => {
      // 自定义执行逻辑
      return { exitCode: 0, stdout: "done", stderr: "", timedOut: false, durationMs: 100 };
    },
  },
});
```

**安全保证**：

- 容器只包住 Bash 及其子进程
- Provider/OAuth/Session/Extension Host 留在 CLI 进程
- 模型凭据不进入不可信执行环境
- Tool 子进程只获得精简环境

---

## 12. 扩展系统

### 12.1 创建扩展

```javascript
// my-extension.mjs
export default function (api) {
  // 注册工具
  api.registerTool({
    definition: {
      name: "my_tool",
      description: "My custom tool",
      parameters: { type: "object", properties: { input: { type: "string" } } },
    },
    async execute(args) {
      return { content: `Processed: ${args.input}` };
    },
  });

  // 注册命令
  api.registerCommand({
    name: "my_command",
    description: "My custom command",
    async execute(args, context) {
      console.log(`Running in ${context.cwd}`);
    },
  });

  // 追加 System Prompt
  api.appendSystemPrompt("Always use TypeScript strict mode.");

  // 事件监听
  api.onEvent((event) => {
    if (event.type === "tool_end") {
      console.log(`Tool ${event.call.name} took ${event.durationMs}ms`);
    }
  });

  // beforeTool veto
  api.beforeTool((ctx) => {
    if (ctx.toolName === "bash" && ctx.arguments.command?.includes("rm -rf")) {
      return { allow: false, reason: "Destructive command blocked" };
    }
    return { allow: true };
  });
}
```

### 12.2 加载扩展

```typescript
const { agent } = await createCodingAgent({
  cwd: process.cwd(),
  extensionPaths: ["./my-extension.mjs"],
  // 或从 npm 安装
  // 扩展默认从 ~/.focuscode/extensions/ 加载
});
```

### 12.3 npm 扩展签名

```bash
# 发布签名扩展
npm publish --sign  # 使用 Ed25519 密钥对签名
```

```typescript
// 强制要求签名
const { agent } = await createCodingAgent({
  cwd: process.cwd(),
  requireExtensionSignatures: true,
});
```

---

## 13. 企业模式

企业模式提供 fail-closed 硬约束：

```typescript
const { agent } = await createCodingAgent({
  cwd: process.cwd(),
  enterprise: {
    enabled: true,
    allowedExtensions: ["@company/safe-tools"], // 扩展白名单
    allowProjectExtensions: false, // 禁止项目级扩展
    auditHmacKeyEnv: "FOCUSCODE_AUDIT_HMAC_KEY", // HMAC 密钥环境变量名
    auditDirectory: "/var/log/focuscode/audit", // 审计日志目录
  },
  sandbox: {
    kind: "docker",
    image: `internal/agent@sha256:${"a".repeat(64)}`, // 强制 digest pin
    requireImageDigest: true,
  },
});
```

**企业模式约束**：

- ✅ 强制非 Host sandbox（docker/gvisor/vm）
- ✅ 镜像 digest pin + `--pull never`
- ✅ HMAC 审计密钥（32 字节+）
- ✅ 扩展白名单 + 签名要求
- ✅ 扩展不得请求 `network`/`shell` 权限
- ✅ 禁止 ad-hoc 扩展路径
- ❌ 无 HMAC key → 启动失败
- ❌ 未签名扩展 → 启动失败
- ❌ Host sandbox → 启动失败

---

## 14. 端口注入

`createLocalHarness` 支持注入自定义端口，实现外部存储和自定义验证逻辑：

```typescript
import { createLocalHarness } from "@focuscode/sdk";

const harness = await createLocalHarness({
  repoRoot: "/path/to/repo",
  stateDirectory: "/path/to/state",
  model: {/* ... */},

  // 自定义 Fact Store（如 Postgres）
  factStore: {
    async append(event) {
      /* 写入 Postgres */
    },
    async loadEvents(taskId) {
      /* 从 Postgres 读取 */
    },
    async snapshot(taskId) {
      /* 返回 checkpoint */
    },
  },

  // 自定义验证器
  verifier: {
    async verify(request) {
      const testResult = await runTestSuite(request.repoRoot);
      return {
        schemaVersion: "verification-report.v1",
        conclusion: testResult.passed ? "PASS" : "FAIL",
        phase: request.phase,
        results: testResult.results,
        summary: testResult.summary,
      };
    },
  },

  // 自定义决策端口
  decisionPort: {
    async decide(request) {
      // 自定义模型决策逻辑
      return {/* AtomicDecisionResultV1 */};
    },
  },
});
```

---

## 15. 错误处理

### 15.1 常见错误

| 错误                                                                 | 原因                        | 处理方式                                    |
| -------------------------------------------------------------------- | --------------------------- | ------------------------------------------- |
| `Enterprise mode rejects non-isolated shell executor`                | 企业模式使用了 Host sandbox | 改用 docker/gvisor/vm                       |
| `Enterprise mode requires a 32+ byte audit key`                      | 未设置 HMAC 密钥            | 设置 `FOCUSCODE_AUDIT_HMAC_KEY`             |
| `Unsigned extensions are disabled`                                   | 未签名扩展被拒绝            | 签名扩展或关闭 `requireExtensionSignatures` |
| `Enterprise extensions may not request network or shell permissions` | 扩展权限违规                | 移除扩展的 network/shell 权限               |
| `Enterprise policy forbids ad-hoc extension paths`                   | 企业模式禁止临时扩展路径    | 使用 `allowedExtensions` 白名单             |
| `Extension must export a default function`                           | 扩展模块格式错误            | 添加 `export default function(api) {}`      |
| `stopReason: length`                                                 | 模型输出被截断              | 增大 `maxTokens` 或拆分任务                 |
| `doom-loop detected`                                                 | 同一工具连续失败 3 次       | 检查工具参数或环境                          |

### 15.2 错误恢复

```typescript
try {
  const result = await agent.submit("Complex refactoring task");
  if (result.stopped === "max_rounds") {
    // 轮次耗尽，继续会话
    const continued = await agent.submit("Continue from where you left off");
  }
} catch (error) {
  if (error.name === "AbortError") {
    console.log("Task was cancelled");
  } else if (error.message.includes("rate_limit")) {
    // 429 限流，Fallback 装饰器会自动切换模型
    console.log("Rate limited, fallback model activated");
  } else {
    throw error;
  }
}
```

---

## 16. Cookbook 示例索引

| 示例                                                                                    | 场景                                   | API Key |
| --------------------------------------------------------------------------------------- | -------------------------------------- | ------- |
| [quickstart.mjs](../examples/sdk/quickstart.mjs)                                        | 审计型 Harness 快速开始                | 不需要  |
| [01-scripted-harness.mjs](../examples/sdk/cookbook/01-scripted-harness.mjs)             | 确定性 CI 测试（ScriptedDecisionPort） | 不需要  |
| [02-openai-compatible.mjs](../examples/sdk/cookbook/02-openai-compatible.mjs)           | OpenAI 兼容 Provider                   | 需要    |
| [03-custom-fact-store.mjs](../examples/sdk/cookbook/03-custom-fact-store.mjs)           | 自定义 Fact Store（端口注入）          | 不需要  |
| [04-custom-verifier.mjs](../examples/sdk/cookbook/04-custom-verifier.mjs)               | 自定义验证器                           | 不需要  |
| [05-coding-agent-streaming.mjs](../examples/sdk/cookbook/05-coding-agent-streaming.mjs) | 会话型 Agent + 事件流                  | 不需要  |

**运行方式**：

```bash
pnpm build
node examples/sdk/quickstart.mjs
# 或
node examples/sdk/cookbook/01-scripted-harness.mjs
```

---

## 17. API 参考

### 17.1 工厂函数

| 函数                                    | 用途                    | 返回类型                 |
| --------------------------------------- | ----------------------- | ------------------------ |
| `createCodingAgent(opts)`               | 创建会话型 Coding Agent | `CreatedCodingAgent`     |
| `createLocalHarness(opts)`              | 创建审计型 Harness      | `LocalHarness`           |
| `createSessionEffectSpine(opts)`        | 创建策略执行脊          | `SessionEffectSpine`     |
| `streamSubmit(agent, input, opts)`      | 流式输出包装            | `StreamSubmitResult`     |
| `tool(name, schema, handler)`           | 工具定义 DSL            | `AgentTool`              |
| `createHooks(hooks)`                    | 创建生命周期钩子        | `AgentHooks`             |
| `composeEventSink(opts)`                | 组合 onEvent + hooks    | `EventSink \| undefined` |
| `dispatchAgentEvent(hooks, event, ctx)` | 事件路由                | `Promise<void>`          |

### 17.2 核心类型

```typescript
// 会话型
interface CreatedCodingAgent {
  agent: CodingAgent;
  sessions: SessionStore;
  extensions: ExtensionHost;
  resources: AgentResources;
  config: ResolvedAgentConfig;
}

// 审计型
interface LocalHarness {
  facts: FileFactStore;
  memory: FileMemoryStore;
  actions: LocalActionRuntime;
  profile: RepoProfileV1;
  model: CertifiedModelRefV1;
  kernel: FocusKernel;
  run(spec: TaskSpecV1, options?: { taskId?: string }): Promise<KernelResult>;
}

// 流式
interface StreamSubmitResult extends AsyncIterable<AgentEvent> {
  result: Promise<AgentRunResult>;
}

// 钩子
interface AgentHooks {
  postToolUse?: (ctx: PostToolContext, result: ToolExecutionResult) => void | Promise<void>;
  sessionStart?: (ctx: SessionContext) => void | Promise<void>;
  sessionEnd?: (ctx: SessionContext) => void | Promise<void>;
  stop?: (reason: StopReason) => void | Promise<void>;
}

// Agent 运行结果
interface AgentRunResult {
  sessionId: string;
  entryId: string;
  content: string;
  rounds: number;
  toolCalls: number;
  usage: { inputTokens: number; outputTokens: number };
  stopped: "stop" | "tool_use" | "length" | "max_rounds" | "aborted" | "error";
}
```

---

## 18. 与竞品 SDK 对比

| 维度                  | FocusCode SDK                                         | Claude Agent SDK                 | OpenCode SDK         |
| --------------------- | ----------------------------------------------------- | -------------------------------- | -------------------- |
| **核心范式**          | in-process 组合根（双路径）                           | in-process async generator       | HTTP client/server   |
| **Streaming**         | ✅ `streamSubmit` AsyncIterable                       | ✅ `AsyncGenerator<SDKMessage>`  | ✅ SSE events        |
| **Mid-turn Steering** | ✅ append/interrupt/followup                          | ✅ `prompt` as AsyncIterable     | ❌                   |
| **自定义工具**        | ✅ `tool()` DSL                                       | ✅ `tool(name, schema, handler)` | ⚠ 仅 MCP server      |
| **Hooks**             | ✅ beforeTool + postToolUse + stop + sessionStart/End | ✅ 9 类 hook                     | ⚠ server events      |
| **Sandbox**           | ✅ 四类 OS 级沙箱                                     | ❌                               | ❌                   |
| **OAuth**             | ✅ 完整 OAuth 2.0 + AES 凭据库                        | ❌ 仅 API key                    | ❌ 仅 API key        |
| **企业模式**          | ✅ fail-closed 硬约束                                 | ❌                               | ❌                   |
| **审计型路径**        | ✅ Focus Kernel + Verifier                            | ❌                               | ❌                   |
| **Provider 解耦**     | ✅ 五系国产 + 国际模型                                | ❌ 绑定 Claude                   | ✅ provider-agnostic |
| **开源协议**          | ✅ Apache-2.0                                         | ❌ Anthropic Commercial Terms    | ✅ MIT               |

---

## 19. FAQ

### Q: 如何选择会话型 vs 审计型？

**A**: 会话型（`createCodingAgent`）适合交互式场景（IDE 插件、聊天助手），低延迟流式输出。审计型（`createLocalHarness`）适合 CI/CD 自动化、合规审计，有确定性完成 Gate。两者可通过 `effectSpine: true` 结合使用。

### Q: 是否必须用 Docker？

**A**: 不是。沙箱默认 `auto`，会按 gVisor → Docker → seatbelt（macOS）→ Host（仅 `allowHostFallback` 时）顺序选择。macOS 开发可只用 seatbelt，无需 Docker。

### Q: 如何在 CI 中无 API Key 测试？

**A**: 使用 `model.kind = "scripted"`，回放预录制的决策序列。参见 [Cookbook 01](../examples/sdk/cookbook/01-scripted-harness.mjs)。

### Q: hooks 和 onEvent 有什么区别？

**A**: `onEvent` 接收所有 `AgentEvent`，需要自己解析事件类型。`hooks` 是结构化的生命周期回调，SDK 自动路由 `tool_end` → `postToolUse`，`agent_end` → `stop`。两者可以同时使用（叠加）。

### Q: 企业模式的 HMAC 密钥怎么生成？

**A**:

```bash
# 生成 32 字节随机密钥
openssl rand -hex 32
# 设置环境变量
export FOCUSCODE_AUDIT_HMAC_KEY="$(openssl rand -hex 32)"
```

### Q: 如何自定义 Fact Store 为 Postgres？

**A**: 通过端口注入，参见 [Cookbook 03](../examples/sdk/cookbook/03-custom-fact-store.mjs) 和 [§14 端口注入](#14-端口注入)。

### Q: streamSubmit 会修改 agent 的 eventSink 吗？

**A**: 会临时替换 eventSink，流结束后自动恢复之前的 sink。链式 sink（如 audit journal）不会中断。

### Q: tool() DSL 和 AgentTool 接口有什么区别？

**A**: `tool()` 是 `AgentTool` 的语法糖，简化了定义流程。内部生成的 `AgentTool` 完全等价。推荐使用 `tool()` DSL。

---

## 附录：文档索引

| 文档                                                                   | 用途                         |
| ---------------------------------------------------------------------- | ---------------------------- |
| [API_MANUAL.md](./API_MANUAL.md)                                       | 系统 API 完整手册（18 章节） |
| [USAGE_SOP.md](./USAGE_SOP.md)                                         | CLI 使用 SOP（16 章节）      |
| [ARCHITECTURE.md](./ARCHITECTURE.md)                                   | 架构设计文档                 |
| [OAUTH_AND_PROVIDERS.md](./OAUTH_AND_PROVIDERS.md)                     | OAuth 与 Provider 详解       |
| [SANDBOXING.md](./SANDBOXING.md)                                       | 沙箱隔离详解                 |
| [EXTENSIONS_AND_SHARING.md](./EXTENSIONS_AND_SHARING.md)               | 扩展与会话分享               |
| [V0.4_ENTERPRISE_DEPLOYMENT.md](./V0.4_ENTERPRISE_DEPLOYMENT.md)       | 企业部署指南                 |
| [reviews/sdk-review-2026-07-28.md](./reviews/sdk-review-2026-07-28.md) | SDK 深度 Review 报告         |

---

> **维护说明**：本文档随 `@focuscode/sdk` 版本同步更新。如有疑问，请先查阅 [API_MANUAL.md](./API_MANUAL.md) 和 [reviews/sdk-review-2026-07-28.md](./reviews/sdk-review-2026-07-28.md)。
