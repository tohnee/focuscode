# FocusCode 系统 API 手册

> 版本：对应 `0.4.0-beta.2`（仓库 `main` 分支当前状态）
> 范围：面向**嵌入式集成者**与**扩展开发者**，覆盖 `@focuscode/*` 全部公共包的稳定接口。
> 不包括：CLI 交互层（参见 [USAGE_SOP.md](./USAGE_SOP.md)）、内部 `*.js` 实现细节。
> 信息来源：仓库源码 `packages/*/src/index.ts`、`packages/contracts/src/schemas.ts`、`docs/schemas/*.schema.json`、`docs/ARCHITECTURE.md`。

---

## 目录

1. [包总览与依赖边界](#1-包总览与依赖边界)
2. [核心抽象：Ports 与 Schemas](#2-核心抽象ports-与-schemas)
3. [SDK 组合根（`@focuscode/sdk`）](#3-sdk-组合根focuscodesdk)
4. [会话型 Agent Runtime（`@focuscode/agent-runtime`）](#4-会话型-agent-runtimefocuscodeagent-runtime)
5. [审计型 Harness Kernel（`@focuscode/harness-core`）](#5-审计型-harness-kernelfocuscodeharness-core)
6. [Model Gateway（`@focuscode/model-gateway`）](#6-model-gatewayfocuscodemodel-gateway)
7. [Action 域与后端（`@focuscode/action-domain` / `action-backends`）](#7-action-域与后端focuscodeaction-domain--action-backends)
8. [Contracts 与 Protocols](#8-contracts-与-protocols)
9. [Persistence 与 Asset Plane](#9-persistence-与-asset-plane)
10. [Auth（`@focuscode/auth`）](#10-authfocuscodeauth)
11. [Sandbox（`@focuscode/sandbox`）](#11-sandboxfocuscodesandbox)
12. [Ecosystem（`@focuscode/ecosystem`）](#12-ecosystemfocuscodeecosystem)
13. [TUI（`@focuscode/tui`）](#13-tuifocuscodetui)
14. [Verifier Eval（`@focuscode/verifier-eval`）](#14-verifier-evalfocuscodeverifier-eval)
15. [Context Compiler（`@focuscode/context-compiler`）](#15-context-compilerfocuscodecontext-compiler)
16. [扩展开发契约](#16-扩展开发契约)
17. [错误码与失败模式](#17-错误码与失败模式)
18. [版本与稳定性策略](#18-版本与稳定性策略)

---

## 1. 包总览与依赖边界

FocusCode 是 pnpm monorepo，`apps/*` 是组合根（不发布为库），`packages/*` 是可被外部依赖的库。所有包以 ESM 发布，入口 `dist/index.js`，类型在 `dist/index.d.ts`。

| 包                            | 角色                       | 关键导出                                                                                               |
| ----------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------ |
| `@focuscode/contracts`        | 规范契约（typebox schema） | `TaskSpecV1`、`EffectPort`、`DecisionPort`、`Execution*`、`*Schema`、`assertSchema`                    |
| `@focuscode/protocols`        | 协议边界映射               | `McpToolPinV1`、`assertMcpToolPin`、`negotiateAcpCapabilities`、`DelegationSpecV1`                     |
| `@focuscode/action-domain`    | 策略域（纯函数）           | `PolicyEngine`、`ApprovalMode`、`CommandPrefixRule`、`EffectLedger`                                    |
| `@focuscode/action-backends`  | 本地工具执行面             | `LocalActionRuntime`、`ToolRegistry`、`SafeCommandRunner`、`WorkspaceGuard`、`createLocalToolRegistry` |
| `@focuscode/harness-core`     | 可恢复 Kernel              | `FocusKernel`、`KernelRunResult`、状态机                                                               |
| `@focuscode/model-gateway`    | Atomic Decision            | `GatewayDecisionPort`、`OpenAICompatibleTransport`、`loadModelPack`、`createDevelopmentModelRef`       |
| `@focuscode/agent-runtime`    | 会话循环                   | `CodingAgent`、`SessionStore`、`ModelClient`、`ModelProfile`、Provider 客户端、Spec Engine             |
| `@focuscode/persistence`      | append-only 事实           | `FileFactStore`                                                                                        |
| `@focuscode/asset-plane`      | 记忆与可移植资产           | `FileMemoryStore`                                                                                      |
| `@focuscode/context-compiler` | Canonical Context          | `ContextCompiler`、`buildRepoProfile`、`RepoProfileV1`                                                 |
| `@focuscode/verifier-eval`    | baseline/target 验证       | `RegisteredCommandVerifier`                                                                            |
| `@focuscode/auth`             | OAuth/加密凭据             | `OAuthClient`、`EncryptedCredentialStore`、`OAuthProfile`、Provider 预设                               |
| `@focuscode/sandbox`          | 执行隔离                   | `createSandbox`、`SandboxExecutor`、`SandboxConfig`                                                    |
| `@focuscode/ecosystem`        | 扩展与会话分享             | `ExtensionPackageManager`、`SessionShareService`                                                       |
| `@focuscode/tui`              | 终端 UI                    | `App`、`Renderer`、`Themes`、`Companion`、`Skins`                                                      |
| `@focuscode/sdk`              | 组合 API                   | `createLocalHarness`、`createCodingAgent`、`createSessionEffectSpine`                                  |
| `@focuscode/testkit`          | 测试工具（不计入覆盖率）   | `ScriptedDecisionPort`、`ScriptedStep`                                                                 |

### 依赖边界（`scripts/check-boundaries.mjs` 强制）

- `contracts` 不依赖任何 `@focuscode/*` 或 Provider SDK
- `harness-core` 禁止 `node:fs`、`node:child_process`、`fetch(`、action-backends、model-gateway
- `model-gateway` 禁止依赖 action-backends、action-domain
- `agent-runtime` 禁止依赖 harness-core、model-gateway、persistence、sdk、auth、ecosystem、sandbox、tui
- `auth`、`ecosystem`、`sandbox`、`tui` 是叶子 adapter，禁止依赖任何 `@focuscode/*`
- 只有 `apps/*` 和 `packages/sdk` 可以组合以上模块

> **集成者警告**：在 `@focuscode/sdk` 之外直接组合底层包会绕过这些边界。请优先使用 SDK 入口。

---

## 2. 核心抽象：Ports 与 Schemas

来源：[packages/contracts/src/ports.ts](file:///Users/tohnee/Trae/Code/focuscode/packages/contracts/src/ports.ts)、[packages/contracts/src/schemas.ts](file:///Users/tohnee/Trae/Code/focuscode/packages/contracts/src/schemas.ts)。

### 2.1 Port 接口

Harness Kernel 通过 Ports 与外界通信。所有 Port 都是接口（非类），可由任意后端实现。

```typescript
// 来自 @focuscode/contracts（packages/contracts/src/ports.ts）
export interface DecisionPort {
  decide(input: TurnInputV1, model: CertifiedModelRefV1): Promise<AtomicDecisionResultV1>;
}

export interface EffectContextV1 {
  execution: ExecutionContextV1;
  model: CertifiedModelRefV1;
  workerId: string;
}

export interface EffectPort {
  submit(
    intents: ActionIntentV1[],
    context: EffectContextV1,
    signal?: AbortSignal,
  ): Promise<EffectReceiptV1[]>;
}

export interface AppendRequestV1 {
  taskId: string;
  expectedVersion: number; // 乐观并发：必须匹配 facts 当前最新 seq
  events: NewDomainEventV1[];
}

export interface AppendAckV1 {
  firstSeq: number;
  lastSeq: number;
  events: DomainEventV1[]; // 已落盘并补完 eventId/seq 的事件
}

export interface FactPort {
  append(request: AppendRequestV1): Promise<AppendAckV1>;
  loadEvents(taskId: string, afterSeq?: number): Promise<DomainEventV1[]>;
  loadCheckpoint(taskId: string): Promise<KernelCheckpointV1 | undefined>;
  saveCheckpoint(checkpoint: KernelCheckpointV1): Promise<void>;
}

export interface VerificationRequestV1 {
  taskId: string;
  phase: "baseline" | "target";
  baseline?: VerificationReportV1; // target 阶段用于回归比对
}

export interface VerifyPort {
  verify(request: VerificationRequestV1): Promise<VerificationReportV1>;
}
```

- **`DecisionPort`**：纯决策输入/输出，不接触网络或文件系统。入参 `TurnInputV1` 携带 task/execution/state/turn/publicPlan/recentEffects/recentEvents/tools 等上下文；出参 `AtomicDecisionResultV1` 含 `status`/`decision`/`usage`/`parserDiagnostics`。`GatewayDecisionPort`（model-gateway）与 `ScriptedDecisionPort`（testkit）是两个官方实现。
- **`EffectPort`**：受控副作用执行面。`submit()` 接收意图列表，返回收据列表，**一一对应**。`signal` 会贯穿到底层工具执行，可中途取消；意图之间的取消总是立即生效。
- **`FactPort`**：append-only 事实存储，`append()` 走乐观并发（`expectedVersion` 必须等于当前最新 `seq`，否则抛 `VersionConflictError`）。`FileFactStore`（persistence）是默认实现。
- **`VerifyPort`**：baseline/target 两阶段验证入口。target 阶段可携带 `baseline` 比对失败是否回归（`REGRESSION`）。`RegisteredCommandVerifier`（verifier-eval）是默认实现。

### 2.2 Schema 与验证

所有跨边界数据用 typebox schema 描述，导出在 `@focuscode/contracts`。JSON Schema 形式落在 `docs/schemas/`：

- `TaskSpecSchema` → `task-spec.v1.schema.json`
- `ActionIntentSchema` → `action-intent.v1.schema.json`
- `CapabilityGrantSchema` → `capability-grant.v1.schema.json`
- `DomainEventSchema` → `domain-event.v1.schema.json`
- `EffectReceiptSchema` → `effect-receipt.v1.schema.json`
- `ExecutionContextSchema` → `execution-context.v1.schema.json`
- `KernelCheckpointSchema` → `kernel-checkpoint.v1.schema.json`
- `MemoryRecordSchema` → `memory-record.v1.schema.json`
- `ModelDecisionSchema` → `model-decision.v1.schema.json`
- `TurnInputSchema` → `turn-input.v1.schema.json`
- `VerificationReportSchema` → `verification-report.v1.schema.json`

```typescript
import { TaskSpecSchema, assertSchema } from "@focuscode/contracts";

assertSchema(TaskSpecSchema, task, "task spec"); // 失败抛错
```

### 2.3 标识与摘要工具

```typescript
export function newId(prefix: string): string; // 如 "task_a1b2c3..."
export function sha256Digest(value: unknown): Digest; // 规范化 JSON 后 sha256
```

`Digest` 是 string 别名，用于 `policySnapshot`、`McpToolPinV1.schemaDigest` 等。

---

## 3. SDK 组合根（`@focuscode/sdk`）

来源：[packages/sdk/src/index.ts](file:///Users/tohnee/Trae/Code/focuscode/packages/sdk/src/index.ts)。

`@focuscode/sdk` 是**唯一的组合入口**，外部库应当只依赖它。它把 harness-core、agent-runtime、model-gateway、action-backends、persistence、asset-plane、context-compiler、verifier-eval、sandbox、ecosystem 串成两条执行路径。

### 3.1 `createLocalHarness` —— 审计型 Harness

来源：[packages/sdk/src/local-harness.ts](file:///Users/tohnee/Trae/Code/focuscode/packages/sdk/src/local-harness.ts)。

```typescript
import { createLocalHarness, type LocalHarnessOptions } from "@focuscode/sdk";

const harness = await createLocalHarness({
  repoRoot: "/path/to/repo",
  stateDirectory: "/path/to/.focuscode-state",
  approvalMode: "deny", // "deny" | "prompt" | "auto-safe"
  // approval: myApprovalPort,     // 可选：自定义 ApprovalPort
  // trustRepoConfig: true,        // 信任 .focuscode/ 中的 verification 命令白名单
  // workerId: "ci-runner-1",
  // modelPackPath: "/path/to/pack.json",
  model: {
    kind: "openai-compatible",
    modelId: "kimi-k2",
    baseUrl: "https://api.moonshot.cn/v1",
    apiKey: process.env.MOONSHOT_API_KEY, // 可选
    extraHeaders: { "X-Custom": "value" }, // 可选
  },
});

// 或者：kind: "scripted"，使用 ScriptedStep[] 驱动确定性测试
```

`LocalHarness` 公开成员：

```typescript
class LocalHarness {
  readonly facts: FileFactStore;
  readonly memory: FileMemoryStore;
  readonly actions: LocalActionRuntime;
  readonly profile: RepoProfileV1;
  readonly model: CertifiedModelRefV1;

  run(task: TaskSpecV1, options?: RunTaskOptions): Promise<KernelRunResult>;
  inspect(taskId: string): Promise<KernelCheckpointV1 | undefined>;
}
```

`RunTaskOptions`：

| 字段        | 类型                          | 默认            | 说明                      |
| ----------- | ----------------------------- | --------------- | ------------------------- |
| `taskId`    | `string?`                     | `newId("task")` | 任务 ID；指定后可幂等恢复 |
| `tenantId`  | `string?`                     | `"local"`       | 多租户隔离键              |
| `actorId`   | `string?`                     | `"local-user"`  | 触发者 ID                 |
| `dataClass` | `"standard" \| "restricted"?` | `"standard"`    | 数据敏感度等级            |
| `budget`    | `Partial<BudgetV1>?`          | 见下            | 资源预算                  |

默认预算：

```typescript
{
  maxTurns: 20,
  maxActions: 40,
  maxWallTimeMs: 20 * 60_000,    // 20 分钟
  maxChangedFiles: 20,            // 可被 task.scope.maxFiles 覆盖
  maxChangedLines: 1_000,         // 可被 task.scope.maxChangedLines 覆盖
}
```

`KernelRunResult` 字段（来源：[packages/harness-core/src/focus-kernel.ts](file:///Users/tohnee/Trae/Code/focuscode/packages/harness-core/src/focus-kernel.ts#L37-L41)）：

```typescript
interface KernelRunResult {
  checkpoint: KernelCheckpointV1; // 任务终态快照（含 status / budget / model）
  events: DomainEventV1[]; // 本次 run 产生的全部 DomainEvent
  verification?: VerificationReportV1; // 注册验证命令的结果（未配置则缺省）
}
```

> 任务状态通过 `checkpoint.state` 读取（`TaskStateV1` 枚举共 17 个值：`"CREATED" | "PREFLIGHT" | "WAITING_INPUT" | "READY" | "RUNNING" | "WAITING_APPROVAL" | "PAUSED" | "VERIFYING" | "REVIEW_READY" | "RECONCILING" | "BLOCKED" | "ACCEPTED" | "REJECTED" | "CANCELLING" | "CANCELLED" | "FAILED" | "EXPIRED"`）；`taskId` 在 `checkpoint.taskId` 与每个 `DomainEvent.taskId` 中。Effect 收据作为 `DomainEventV1` 包含在 `events` 数组里。终态：`ACCEPTED` / `REJECTED` / `CANCELLED` / `FAILED` / `EXPIRED`。

#### 3.1.1 `LocalHarnessOptions` 完整参数表

来源：[packages/sdk/src/local-harness.ts](file:///Users/tohnee/Trae/Code/focuscode/packages/sdk/src/local-harness.ts#L54-L78)。

**基类字段（`LocalHarnessBaseOptions`，两种 model 变体共享）**

| 字段              | 类型                                 | 默认                                        | 必填 | 说明                                                                                             |
| ----------------- | ------------------------------------ | ------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------ |
| `repoRoot`        | `string`                             | —                                           | ✅   | 待审计仓库根目录（绝对路径）                                                                     |
| `stateDirectory`  | `string`                             | —                                           | ✅   | FactStore/MemoryStore 持久化目录（append-only）                                                  |
| `modelPackPath`   | `string?`                            | 内置 `model-packs/generic-openai/pack.json` | ❌   | Model Pack 路径，覆盖默认 pack                                                                   |
| `approvalMode`    | `"deny" \| "prompt" \| "auto-safe"?` | `"deny"`                                    | ❌   | 策略审批模式：`deny`=全部拒绝；`prompt`=交互式（仅 TTY）；`auto-safe`=自动放行安全写入与注册命令 |
| `approval`        | `ApprovalPort?`                      | `denyApproval`                              | ❌   | 自定义审批端口，优先级高于 `approvalMode`                                                        |
| `trustRepoConfig` | `boolean?`                           | `false`                                     | ❌   | 是否信任仓库 `.focuscode/config.json` 中的 `verificationCommandIds`                              |
| `workerId`        | `string?`                            | `local-worker:${process.pid}`               | ❌   | worker 标识，写入审计上下文                                                                      |

**model 变体（联合类型，二选一）**

| 变体                           | 字段                                                                                                                      | 类型                      | 必填                                                         | 说明 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------ | ---- |
| `ScriptedHarnessOptions.model` | `{ kind: "scripted"; steps: ScriptedStep[] }`                                                                             | ✅                        | 确定性回放，无网络调用；用于测试与 demo                      |
| `OpenAIHarnessOptions.model`   | `{ kind: "openai-compatible"; modelId: string; baseUrl: string; apiKey?: string; extraHeaders?: Record<string, string> }` | ✅ `kind/modelId/baseUrl` | OpenAI 兼容协议；`apiKey` 可缺省（由 transport 从 env 推导） |

#### 3.1.2 `createLocalHarness` 错误模式

| 触发条件                                                         | 错误信息                                                                            | 修复建议                                                                                                                     |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `repoRoot` 不存在或不可读                                        | `WorkspaceGuard.create` 抛 `ENOENT`/`EACCES`                                        | 检查路径权限，使用绝对路径                                                                                                   |
| `stateDirectory` 不可写                                          | `FileFactStore` 构造抛 `EACCES`/`EROFS`                                             | 确保目录可写且为 append-only 文件系统                                                                                        |
| `modelPackPath` 指向不存在的 pack                                | `loadModelPack` 抛 `ENOENT` 或 schema 校验错误                                      | 用 `pnpm schemas` 重新生成；或回退默认 pack                                                                                  |
| `options.model.kind === "openai-compatible"` 且 `baseUrl` 不可达 | `OpenAICompatibleTransport` 在 `decide()` 阶段抛 `fetch failed`/`ECONNREFUSED`      | 检查 `baseUrl`、网络代理、`apiKey`                                                                                           |
| `approvalMode === "prompt"` 且非 TTY                             | `ApprovalPort.request` 永远返回 `false`，任务进入 `WAITING_APPROVAL` 后转 `BLOCKED` | 改用 `auto-safe` 或自定义 `approval` 端口                                                                                    |
| `task` 未通过 `TaskSpecSchema` 校验                              | `assertSchema` 抛 `SchemaError`，列出违规字段                                       | 参考 [docs/schemas/task-spec.v1.schema.json](file:///Users/tohnee/Trae/Code/focuscode/docs/schemas/task-spec.v1.schema.json) |
| `budget` 超限                                                    | `FocusKernel` 在 `RECONCILING` 后转入 `FAILED`，`checkpoint.state === "FAILED"`     | 调高 `RunTaskOptions.budget` 或缩小任务范围                                                                                  |

### 3.2 `createCodingAgent` —— 会话型 Agent

来源：[packages/sdk/src/coding-agent.ts](file:///Users/tohnee/Trae/Code/focuscode/packages/sdk/src/coding-agent.ts)。

```typescript
import { createCodingAgent } from "@focuscode/sdk";

interface CreateCodingAgentOptions extends AgentConfigOverrides {
  cwd: string;
  sessionDirectory?: string;
  sessionId?: string;
  sessionName?: string;
  persistentSession?: boolean;
  extensionPaths?: string[];
  approve?: ApprovalHandler;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
  accessTokenProvider?: () => Promise<string | undefined>;
  shellExecutor?: ShellExecutor;
  effectSpine?: boolean; // 默认 config.agent.effectSpine (true)
}

const created = await createCodingAgent({
  cwd: "/path/to/repo",
  // AgentConfigOverrides 字段：provider/model/apiKeyEnv/approval/sandbox/...
});

interface CreatedCodingAgent {
  agent: CodingAgent;
  sessions: SessionStore;
  extensions: ExtensionHost;
  resources: AgentResources;
  config: ResolvedAgentConfig;
}
const { agent, sessions, config } = created;
```

工作流：解析配置 → 加载仓库资源 → 创建沙箱 → 注册工具 → 加载扩展（企业模式过滤高危权限）→ 创建 SessionStore → 可选创建 EffectSpine → `CodingAgent.create()`。

企业模式额外检查：

- 沙箱必须为 `docker`/`gvisor`/`vm`，否则抛 `Enterprise mode rejects non-isolated shell executor`
- 拒绝 `extensionPaths`（不允许 ad-hoc 扩展）
- 扩展 `permissions` 不得包含 `network`/`shell`
- 未签名扩展被拒绝（当 `requireExtensionSignatures` 为真）
- 必须设置 `FOCUSCODE_AUDIT_HMAC_KEY`（≥32 字节）

> 注意：CLI 通过 `apps/cli/src/agent-command.ts` 内部组装 `CodingAgent.create()`；SDK 暴露的 `createCodingAgent` 是其可编程等价物。底层都走 `CodingAgent.create()`，参数同形（见 §4.1）。

#### 3.2.1 `CreateCodingAgentOptions` 完整参数表

来源：[packages/sdk/src/coding-agent.ts](file:///Users/tohnee/Trae/Code/focuscode/packages/sdk/src/coding-agent.ts#L26-L39)、[packages/agent-runtime/src/config.ts](file:///Users/tohnee/Trae/Code/focuscode/packages/agent-runtime/src/config.ts#L66-L211)。

**SDK 自身字段**

| 字段                  | 类型                                            | 默认                                     | 必填 | 说明                                                       |
| --------------------- | ----------------------------------------------- | ---------------------------------------- | ---- | ---------------------------------------------------------- |
| `cwd`                 | `string`                                        | —                                        | ✅   | Agent 工作目录（绝对路径）                                 |
| `sessionDirectory`    | `string?`                                       | `~/.focuscode/sessions/<cwd-hash>`       | ❌   | Session JSONL 持久化目录                                   |
| `sessionId`           | `string?`                                       | 自动创建                                 | ❌   | 恢复已有 session；与 `persistentSession` 配合可实现 resume |
| `sessionName`         | `string?`                                       | 时间戳                                   | ❌   | 可读的 session 名称                                        |
| `persistentSession`   | `boolean?`                                      | `true`                                   | ❌   | `false` 时 session 关闭即删                                |
| `extensionPaths`      | `string[]?`                                     | `[]`                                     | ❌   | ad-hoc 扩展路径；企业模式下抛错                            |
| `approve`             | `ApprovalHandler?`                              | 配置驱动                                 | ❌   | 自定义审批处理器，覆盖 `approval` 配置                     |
| `onEvent`             | `(event: AgentEvent) => void \| Promise<void>?` | —                                        | ❌   | 事件回调（streaming、approval_required、tool_call 等）     |
| `accessTokenProvider` | `() => Promise<string \| undefined>?`           | —                                        | ❌   | OAuth access token 注入点（用于 Provider 鉴权）            |
| `shellExecutor`       | `ShellExecutor?`                                | `createSandbox(config.sandbox)`          | ❌   | 自定义沙箱执行器；企业模式必须是 `docker`/`gvisor`/`vm`    |
| `effectSpine`         | `boolean?`                                      | `config.agent.effectSpine` (默认 `true`) | ❌   | 是否将会话工具循环桥接到审计 EffectPort                    |

**`AgentConfigOverrides` 字段（继承自 `AgentConfigFile`）—— 常用项**

| 字段                | 类型                                                    | 默认                           | 说明                                                                                                    |
| ------------------- | ------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `provider`          | `string?`                                               | —                              | Provider 标识：`kimi`/`qwen`/`glm`/`deepseek`/`minimax`/`openai`/`anthropic`/`gemini`/`ollama`/`custom` |
| `model`             | `string?`                                               | —                              | 模型 ID，如 `kimi-k2`                                                                                   |
| `revision`          | `string?`                                               | —                              | 模型版本指纹；与 `expectedSystemFingerprint` 联动做供应链校验                                           |
| `baseUrl`           | `string?`                                               | Provider preset                | OpenAI 兼容端点                                                                                         |
| `apiKeyEnv`         | `string?`                                               | Provider preset                | API Key 环境变量名（**仅 env 名，不传 secret 本身**）                                                   |
| `apiKey`            | `string?`                                               | —                              | 直接传 secret；仅用于 SDK 嵌入式场景，CLI 路径禁用                                                      |
| `authType`          | `"api-key" \| "oauth" \| "none"?`                       | Provider preset                | 鉴权方式                                                                                                |
| `oauthAccount`      | `string?`                                               | —                              | OAuth 账号标识，配合 `@focuscode/auth`                                                                  |
| `protocol`          | `"openai" \| "anthropic" \| "gemini" \| "qwen"?`        | Provider preset                | 原生协议选择                                                                                            |
| `approval`          | `ApprovalMode?`                                         | `"ask"`                        | `ask`/`auto-edit`/`full-auto`/`deny`                                                                    |
| `maxRounds`         | `number?`                                               | 50                             | 单轮对话最大轮次                                                                                        |
| `steeringMaximum`   | `number?`                                               | 3                              | mid-turn steering 最大次数                                                                              |
| `steeringDelivery`  | `"all" \| "one-at-a-time"?`                             | `"all"`                        | steering 消息投递策略                                                                                   |
| `protectedPaths`    | `string[]?`                                             | `[".git", ".focuscode"]`       | 受保护路径，写入需审批                                                                                  |
| `instructions`      | `string[]?`                                             | —                              | 附加系统 prompt                                                                                         |
| `enabledTools`      | `string[]?`                                             | 全部                           | 工具白名单                                                                                              |
| `disabledTools`     | `string[]?`                                             | `[]`                           | 工具黑名单（优先级高于 `enabledTools`）                                                                 |
| `fallbackModels`    | `FallbackModelPreset[]?`                                | `[]`                           | 主模型失败时的回退链                                                                                    |
| `sandbox`           | 见下                                                    | `{ kind: "auto" }`             | 沙箱配置                                                                                                |
| `enterprise`        | 见下                                                    | `{ enabled: false }`           | 企业模式配置                                                                                            |
| `mcp`               | `{ servers?: McpServerSpec[]; pins?: McpToolPinV1[] }?` | —                              | MCP 服务器与 fail-closed pins                                                                           |
| `skills`            | `{ manifest?: string \| SkillManifest }?`               | —                              | Skills 清单                                                                                             |
| `loop`              | `{ maxIterations?; tokenBudget? }?`                     | —                              | 自迭代循环上限                                                                                          |
| `graph`             | `{ maxConcurrency?; continueOnError? }?`                | —                              | 任务图执行上限                                                                                          |
| `team`              | `{ maxConcurrency?; continueOnError?; maxTasks? }?`     | —                              | 多 Agent 团队上限                                                                                       |
| `pricing`           | `Record<string, ModelPricing>?`                         | —                              | 成本核算（USD/1M tokens）                                                                               |
| `projectTrusted`    | `boolean?`                                              | `false`                        | 是否信任项目级配置/Skills/Extensions                                                                    |
| `globalConfigPath`  | `string?`                                               | `~/.focuscode/config.json`     | 全局配置路径（测试用）                                                                                  |
| `projectConfigPath` | `string?`                                               | `<cwd>/.focuscode/config.json` | 项目配置路径（测试用）                                                                                  |

**`sandbox` 子表**

| 字段                 | 类型                                                              | 默认            | 说明                                                  |
| -------------------- | ----------------------------------------------------------------- | --------------- | ----------------------------------------------------- |
| `kind`               | `"host" \| "docker" \| "gvisor" \| "vm" \| "seatbelt" \| "auto"?` | `"auto"`        | 沙箱类型；`auto` 按可用性降级                         |
| `image`              | `string?`                                                         | —               | Docker 镜像（企业模式必须为 `name@sha256:<64>` 形式） |
| `network`            | `"none" \| "bridge"?`                                             | `"none"`        | 网络策略；默认断网                                    |
| `allowHostFallback`  | `boolean?`                                                        | `false`         | `auto` 链路终点是否回退 Host（不推荐）                |
| `requireImageDigest` | `boolean?`                                                        | `false`         | 强制镜像 digest（企业模式隐式为 `true`）              |
| `vmHost`             | `string?`                                                         | —               | SSH VM 主机                                           |
| `vmWorkspace`        | `string?`                                                         | —               | SSH VM 远程工作目录                                   |
| `vmIdentityFile`     | `string?`                                                         | `~/.ssh/id_rsa` | SSH 身份文件                                          |

**`enterprise` 子表**

| 字段                     | 类型        | 默认                         | 说明               |
| ------------------------ | ----------- | ---------------------------- | ------------------ |
| `enabled`                | `boolean?`  | `false`                      | 启用企业模式       |
| `allowedProviders`       | `string[]?` | 全部                         | Provider 白名单    |
| `allowedModels`          | `string[]?` | 全部                         | 模型白名单         |
| `requireIsolatedSandbox` | `boolean?`  | `true`（当 `enabled`）       | 强制非 Host 沙箱   |
| `auditDirectory`         | `string?`   | `~/.focuscode/audit`         | HMAC 审计日志目录  |
| `auditHmacKeyEnv`        | `string?`   | `"FOCUSCODE_AUDIT_HMAC_KEY"` | HMAC 密钥 env 名   |
| `allowProjectExtensions` | `boolean?`  | `false`                      | 是否加载项目级扩展 |
| `allowedExtensions`      | `string[]?` | `[]`                         | 扩展包白名单       |

#### 3.2.2 `createCodingAgent` 错误模式

| 触发条件                                            | 错误信息                                                                    | 修复建议                                                                 |
| --------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `cwd` 不存在                                        | `resolveAgentConfig` 抛 `ENOENT`                                            | 使用存在的绝对路径                                                       |
| `config.sandbox.kind === "auto"` 且无可用沙箱       | `createSandbox` 抛 `No sandbox available`                                   | 安装 Docker/gVisor；或显式 `kind: "host"` 并设 `allowHostFallback: true` |
| 企业模式 + 沙箱非 `docker`/`gvisor`/`vm`            | `Enterprise mode rejects non-isolated shell executor: <kind>`               | 切换沙箱类型或关闭企业模式                                               |
| 企业模式 + `extensionPaths` 非空                    | `Enterprise policy forbids ad-hoc extension paths`                          | 通过 `allowedExtensions` + 锁文件安装                                    |
| `requireExtensionSignatures` + 未签名扩展           | `Unsigned extensions are disabled`                                          | 用 `focuscode extensions sign` 重新签名                                  |
| 企业模式 + 扩展声明 `network`/`shell` 权限          | `Enterprise extensions may not request network or shell permissions`        | 移除敏感权限或换扩展                                                     |
| 企业模式 + 缺 `FOCUSCODE_AUDIT_HMAC_KEY`            | `Enterprise mode requires a 32+ byte audit key in FOCUSCODE_AUDIT_HMAC_KEY` | 设置 ≥32 字节 HMAC 密钥                                                  |
| `mcp.pins` 声明后 schema/transport 漂移             | `MCP tool pin mismatch: <detail>`                                           | 更新 pin 或回滚 server                                                   |
| `provider` 未在 `providers` preset 中且无 `baseUrl` | `resolveAgentConfig` 抛 `Unknown provider`                                  | 显式传 `baseUrl` 或注册 preset                                           |
| `oauthAccount` 指向未登录账号                       | `createModelClient` 抛 `OAuth account not authenticated`                    | 运行 `focuscode login <provider>`                                        |
| `accessTokenProvider` 抛错                          | 错误冒泡至 `agent.submit()` 调用方                                          | 在 provider 中加 try/catch 并返回 `undefined`                            |

### 3.3 `createSessionEffectSpine` —— 策略执行脊

来源：[packages/sdk/src/effect-spine.ts](file:///Users/tohnee/Trae/Code/focuscode/packages/sdk/src/effect-spine.ts)。

把会话工具循环桥接到审计型 `EffectPort`，让会话路径也走 Policy → Grant → Receipt。Rule 语义单一来源是 `action-domain` 的 `PolicyEngine`，与会话旧路径决策一致。

```typescript
import { createSessionEffectSpine } from "@focuscode/sdk";

interface SessionEffectSpineOptions {
  cwd: string;
  registry: AgentToolRegistry; // 会话工具注册表
  taskId: string; // 稳定任务 ID（一般用 sessionId）
  model: ModelProfile;
  permission: {
    mode: ApprovalMode;
    projectTrusted: boolean;
    protectedPaths: string[];
  };
  approve?: ApprovalHandler; // 桥接 PolicyEngine 审批到会话处理器
  onApprovalRequired?: (req: PermissionRequest) => void | Promise<void>;
  workerId?: string;
}

const spine = createSessionEffectSpine({
  cwd,
  registry,
  taskId: sessionId,
  model: profile,
  permission: { mode, projectTrusted, protectedPaths },
  approve,
  onApprovalRequired: (req) => agent?.notifyApprovalRequired(req),
});

agent = await CodingAgent.create({
  // ...
  effectPort: spine.effectPort,
  effectContext: spine.effectContext,
  onApprovalModeChange: (mode) => spine.setApprovalMode(mode),
});
```

返回：

```typescript
interface SessionEffectSpine {
  effectPort: EffectPort; // 注入 CodingAgent.effectPort
  effectContext: EffectContextV1; // 注入 CodingAgent.effectContext
  runtime: LocalActionRuntime; // 内部 LocalActionRuntime（可观测）
  setApprovalMode(mode: ApprovalMode): void; // 模式切换时同步 PolicyEngine
}
```

会话级预算宽裕（`maxTurns: 200`、`maxActions: 2000`、`maxChangedFiles: 1000`），硬拒绝来自 PolicyEngine 矩阵本身（受保护路径、critical 命令）。

#### 3.3.1 `SessionEffectSpineOptions` 完整参数表

来源：[packages/sdk/src/effect-spine.ts](file:///Users/tohnee/Trae/Code/focuscode/packages/sdk/src/effect-spine.ts#L29-L50)。

| 字段                        | 类型                                                 | 默认                            | 必填 | 说明                                                                |
| --------------------------- | ---------------------------------------------------- | ------------------------------- | ---- | ------------------------------------------------------------------- |
| `cwd`                       | `string`                                             | —                               | ✅   | 工作目录（传给 `tool.execute({ cwd })`）                            |
| `registry`                  | `AgentToolRegistry`                                  | —                               | ✅   | 会话工具注册表；spine 会 `sync()` 其所有工具到内部 `ToolRegistry`   |
| `taskId`                    | `string`                                             | —                               | ✅   | 稳定任务 ID（通常用 `sessionId`）；写入 `ExecutionContextV1.taskId` |
| `model`                     | `ModelProfile`                                       | —                               | ✅   | 模型画像；用于派生 `CertifiedModelRefV1`（development fingerprint） |
| `permission.mode`           | `ApprovalMode`                                       | —                               | ✅   | 策略审批模式：`ask`/`auto-edit`/`full-auto`/`deny`                  |
| `permission.projectTrusted` | `boolean`                                            | —                               | ✅   | 是否信任项目级配置；影响 `autoGrant*` 矩阵                          |
| `permission.protectedPaths` | `string[]`                                           | —                               | ✅   | 受保护路径列表；写入策略配置                                        |
| `approve`                   | `ApprovalHandler?`                                   | `undefined`（deny）             | ❌   | 桥接 PolicyEngine 审批到会话处理器；缺省则全部 deny                 |
| `onApprovalRequired`        | `(req: PermissionRequest) => void \| Promise<void>?` | —                               | ❌   | 审批触发前的回调（用于 emit `approval_required` 事件）              |
| `workerId`                  | `string?`                                            | `session-worker:${process.pid}` | ❌   | worker 标识                                                         |

**派生的 `EffectContextV1`（由 spine 构造，不可注入）**

| 字段        | 来源                                                    | 说明                                                |
| ----------- | ------------------------------------------------------- | --------------------------------------------------- |
| `execution` | 由 `taskId`/`permission` 派生                           | `ExecutionContextV1`，包含宽裕预算                  |
| `model`     | 由 `options.model` 派生                                 | `CertifiedModelRefV1`，使用 `sha256Digest` 作为指纹 |
| `workerId`  | `options.workerId ?? \`session-worker:${process.pid}\`` | worker 标识                                         |

**会话级默认预算（hard-coded in `sessionPolicyConfig`/`sessionEffectContext`）**

```typescript
{
  maxTurns: 200,
  maxActions: 2_000,
  maxWallTimeMs: 3_600_000,    // 1 小时
  maxChangedFiles: 1_000,
  maxChangedLines: 1_000_000,
}
```

#### 3.3.2 `createSessionEffectSpine` 错误模式

| 触发条件                                           | 错误信息                                                               | 修复建议                                  |
| -------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------- |
| `registry` 中存在同名工具                          | `ToolRegistry.register` 抛 `Duplicate tool: <name>`                    | 在扩展加载阶段去重                        |
| `approve` 缺省且 `permission.mode === "ask"`       | 所有写入工具被 deny，会话卡在 `WAITING_APPROVAL`                       | 注入 `ApprovalHandler` 或改用 `auto-edit` |
| `onApprovalRequired` 抛错                          | 错误冒泡至 `effectPort.submit()`，工具执行失败                         | 在回调中加 try/catch                      |
| `permission.protectedPaths` 与工具参数 `path` 冲突 | PolicyEngine 直接 deny，返回 `EffectReceiptV1` 带 `denied` disposition | 调整 `protectedPaths` 或工具参数          |
| `taskId` 不稳定（每次 submit 变化）                | 审计日志无法关联，`EffectLedger` 快照混乱                              | 用 `sessionId` 作为 `taskId`              |
| `model.provider`/`model.model` 为空字符串          | `CertifiedModelRefV1.modelId` 为 `"/"`，审计不可读                     | 确保 `ModelProfile` 完整                  |

---

## 4. 会话型 Agent Runtime（`@focuscode/agent-runtime`）

来源：[packages/agent-runtime/src/index.ts](file:///Users/tohnee/Trae/Code/focuscode/packages/agent-runtime/src/index.ts)。

这是 `apps/cli` 的核心，也是嵌入式集成最常用的库。它包含：会话循环、Provider 客户端、工具注册、权限控制器、Session 持久化、Steering、Skills、Spec Engine、LSP 客户端、MCP 客户端。

### 4.1 `CodingAgent`

来源：[packages/agent-runtime/src/agent.ts](file:///Users/tohnee/Trae/Code/focuscode/packages/agent-runtime/src/agent.ts)。

```typescript
class CodingAgent {
  static create(options: CodingAgentOptions): Promise<CodingAgent>;

  get sessionId(): string;
  get specEngineInstance(): SpecEngine | undefined;

  // 主循环
  submit(input: string | AgentPromptInput, externalSignal?: AbortSignal): Promise<AgentRunResult>;

  // 中断当前 submit()
  abort(reason?: string): boolean;

  // Steering（mid-turn 控制）：mode = "append" | "interrupt" | "follow-up"
  steer(text: string, mode?: "append" | "interrupt" | "follow-up"): Promise<SteeringReceipt>;
  listSteering(): SteeringItem[];
  unsteer(id?: string): Promise<SteeringItem[]>;

  // 上下文压缩
  compact(): Promise<{ summary: string; droppedMessages: number }>;

  // 状态与会话管理
  status(): Promise<AgentStatus>;
  nameSession(name: string): Promise<void>;
  moveLeaf(entryId: string): Promise<void>;
  changeModel(profile: ModelProfile, client: ModelClient): Promise<void>;
  changeApproval(mode: ApprovalMode): void;

  // 内部钩子（被 EffectSpine 调用）
  notifyApprovalRequired(request: PermissionRequest): Promise<void>;
}
```

`abort` 立即中止当前 `submit()`，返回是否成功触发；`steer(mode="interrupt")` 也会中止当前模型生成并在下一轮注入文本。`compact()` 强制触发结构化上下文压缩。`changeModel` / `changeApproval` 在运行中调用会抛错。

**`CodingAgentOptions`**（继承 `AgentRuntimeOptions`）：

| 字段                   | 类型                                                               | 必填    | 说明                                                  |
| ---------------------- | ------------------------------------------------------------------ | ------- | ----------------------------------------------------- |
| `cwd`                  | `string`                                                           | ✓       | 工作区根                                              |
| `model`                | `ModelProfile`                                                     | ✓       | 模型描述符                                            |
| `modelClient`          | `ModelClient`                                                      | ✓       | 模型调用客户端                                        |
| `tools`                | `AgentTool[]`                                                      | ✓       | 工具列表                                              |
| `toolRegistry`         | `AgentToolRegistry?`                                               |         | 自定义注册表；省略则用 `new AgentToolRegistry(tools)` |
| `permission`           | `{ mode, projectTrusted, protectedPaths, approve?, prefixRules? }` | ✓       | 权限配置                                              |
| `sessionStore`         | `SessionStore`                                                     | ✓       | 会话持久化                                            |
| `sessionId`            | `string?`                                                          |         | 加载已有会话；不传则新建                              |
| `sessionName`          | `string?`                                                          |         | 会话名                                                |
| `systemPrompt`         | `string?`                                                          |         | 覆盖默认 system prompt                                |
| `instructions`         | `string[]?`                                                        |         | 追加到 system prompt                                  |
| `maxRounds`            | `number?`                                                          | `40`    | 单次 `submit()` 的最大轮数                            |
| `steeringMaximum`      | `number?`                                                          | `32`    | Steering 队列上限                                     |
| `steeringDelivery`     | `"all" \| "one-at-a-time"?`                                        | `"all"` | Steering 投递模式                                     |
| `eventSink`            | `(event: AgentEvent) => void \| Promise<void>?`                    |         | 事件订阅                                              |
| `extensionHost`        | `ExtensionHostLike?`                                               |         | 扩展宿主                                              |
| `auditJournal`         | `AuditJournal?`                                                    |         | HMAC 审计日志                                         |
| `onApprovalRequired`   | `(req: PermissionRequest) => void \| Promise<void>?`               |         | 审批提示钩子                                          |
| `onApprovalModeChange` | `(mode: ApprovalMode) => void?`                                    |         | 模式切换通知                                          |
| `effectPort`           | `EffectPort?`                                                      |         | 启用策略执行脊                                        |
| `effectContext`        | `EffectContextV1?`                                                 |         | 启用执行脊时必填                                      |
| `checkpoints`          | `boolean?`                                                         | `true`  | 文件级 undo 快照                                      |
| `checkpointDirectory`  | `string?`                                                          |         | 默认 `~/.focuscode/checkpoints/<sessionId>`           |
| `diagnostics`          | `{ enabled: boolean; providers: string[] \| undefined }?`          |         | 编辑后追加 LSP 诊断                                   |
| `enableDelegate`       | `boolean?`                                                         | `true`  | 子代理工具                                            |
| `enableGoal`           | `boolean?`                                                         | `true`  | 目标状态工具                                          |
| `enableGraph`          | `boolean?`                                                         | `true`  | 任务图 DAG 工具                                       |
| `graph`                | `{ maxConcurrency, continueOnError }?`                             |         | 图工具默认值                                          |
| `enableTeam`           | `boolean?`                                                         | `true`  | Agent Team 工具                                       |
| `team`                 | `{ maxConcurrency, continueOnError, maxTasks }?`                   |         | Team 工具默认值                                       |
| `skills`               | `Skill[]?`                                                         |         | 声明式技能注入                                        |
| `specEngine`           | `SpecEngineOptions?`                                               |         | 需求澄清引擎                                          |
| `specEngineDeps`       | `SpecEngineDeps?`                                                  |         | 启用 specEngine 时必填                                |

**`AgentPromptInput`**：

```typescript
interface AgentPromptInput {
  text: string;
  attachments?: AgentAttachment[]; // ImageAttachment[]
}
```

**`AgentRunResult`**：

```typescript
interface AgentRunResult {
  sessionId: string;
  entryId: string;
  content: string;
  rounds: number;
  toolCalls: number;
  usage: TokenUsage; // { inputTokens, outputTokens, cachedInputTokens? }
  stopped: ModelStopReason | "max_rounds";
  // ModelStopReason = "stop" | "tool_use" | "length" | "aborted" | "error"
}
```

### 4.2 `ModelProfile` 与 Provider 客户端

来源：[packages/agent-runtime/src/types.ts](file:///Users/tohnee/Trae/Code/focuscode/packages/agent-runtime/src/types.ts)、[packages/agent-runtime/src/model-clients.ts](file:///Users/tohnee/Trae/Code/focuscode/packages/agent-runtime/src/model-clients.ts)。

```typescript
interface ModelProfile {
  provider: string; // "kimi" | "qwen" | "glm" | "deepseek" | "minimax" | 自定义
  model: string; // 模型别名
  revision?: string; // 版本 pin
  expectedSystemFingerprint?: string; // OpenAI-compatible system_fingerprint
  systemFingerprintPolicy?: "fail" | "warn" | "off";
  protocol: "openai-chat" | "openai-responses" | "anthropic-messages" | "google-gemini";
  baseUrl: string;
  apiKey?: string;
  apiKeyEnv?: string;
  authType?: "api-key" | "bearer" | "none";
  oauthAccount?: string; // OAuth 账户名
  extraHeaders?: Record<string, string>;
  contextWindow: number;
  maxOutputTokens: number;
  temperature: number;
  toolMode: "native" | "prompt-json" | "auto";
  reasoningEffort: ReasoningEffort; // "off"|"minimal"|"low"|"medium"|"high"|"max"
  capabilities: ModelCapabilities;
  compatibility: ProviderCompatibility;
  reliability: ModelReliabilityPolicy;
}
```

`ModelClient` 接口：

```typescript
interface ModelClient {
  readonly protocol: string;
  complete(
    request: ModelRequest,
    onEvent?: (event: ModelStreamEvent) => void,
  ): Promise<ModelResponse>;
}
```

`agent-runtime` 内置五系 Provider 方言客户端：

| Provider         | 协议          | 关键差异                                |
| ---------------- | ------------- | --------------------------------------- |
| Kimi (Moonshot)  | `openai-chat` | 6-letter prefix、tool-argument 任意分片 |
| Qwen (DashScope) | `openai-chat` | `enable_search`、`tool_choice` 兼容     |
| GLM (智谱)       | `openai-chat` | `thinking` 格式、zai tool stream        |
| DeepSeek         | `openai-chat` | `reasoning_content` 字段                |
| MiniMax          | `openai-chat` | 多模态扩展                              |

原生协议客户端：

- `OpenAIResponsesClient` —— OpenAI Responses API（`openai-responses`）
- `GeminiClient` —— Google Gemini（`google-gemini`）
- Anthropic Messages 协议由 `openai-chat` 兼容路径覆盖

辅助类：

```typescript
class ModelHttpError extends Error {
  constructor(message: string, readonly status: number, readonly body: string);
}

class ModelResponseDriftError extends Error {
  constructor(readonly expected: string, readonly observed: string | undefined);
}

class FallbackModelClient implements ModelClient {
  // 串联多个 ModelClient，按可靠性策略降级
  // 当主 client 抛 retryable 错误（HTTP 429/5xx、超时）或 stopReason==="error" 时切到下一个
}
```

### 4.3 `SessionStore`

来源：[packages/agent-runtime/src/session-store.ts](file:///Users/tohnee/Trae/Code/focuscode/packages/agent-runtime/src/session-store.ts)。

```typescript
class SessionStore {
  constructor(directory: string, persistenceEnabled?: boolean);

  create(options: { cwd: string; model: ModelProfile; name?: string; forkedFrom?: ... }): Promise<SessionSnapshot>;
  load(sessionId: string): Promise<SessionSnapshot>;
  list(): Promise<SessionListItem[]>;
  importSnapshot(snapshot: SessionSnapshot, options: { cwd: string; model: ...; name?: string }): Promise<SessionSnapshot>;
  delete(sessionId: string): Promise<void>;
  append(sessionId: string, entry: SessionEntry): Promise<void>;
  fork(sessionId: string, entryId?: string): Promise<SessionSnapshot>;
  compact(sessionId: string, upToEntryId: string, summary: SessionCompaction): Promise<void>;
}
```

会话格式 `focuscode-session.v1`，存储为 JSONL（一行一事件）。每个会话独占目录 `<sessionId>/`，含 `header.jsonl`、`entries.jsonl`、`leaf.json`、`metadata.json`、可选 `compaction.json`。

`SessionSnapshot`：

```typescript
interface SessionSnapshot {
  header: SessionHeader; // sessionId, cwd, createdAt, updatedAt, name?, model, forkedFrom?
  entries: SessionEntry[]; // 树形：entryId, parentId?, message, usage?
  activeLeafId?: string;
  compaction?: SessionCompaction;
}
```

### 4.4 工具与权限

来源：[packages/agent-runtime/src/tools.ts](file:///Users/tohnee/Trae/Code/focuscode/packages/agent-runtime/src/tools.ts)、[packages/agent-runtime/src/permissions.ts](file:///Users/tohnee/Trae/Code/focuscode/packages/agent-runtime/src/permissions.ts)。

```typescript
class AgentToolRegistry {
  constructor(tools?: AgentTool[]);
  register(tool: AgentTool): void;
  unregister(name: string): void;
  get(name: string): AgentTool | undefined;
  definitions(): ToolDefinition[];
  specs(): ToolSpecV1[];
}

interface AgentTool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolExecutionResult>;
}

interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  effect: "read" | "write" | "shell" | "git" | "network";
}
```

`PermissionController`：

```typescript
class PermissionController {
  constructor({ cwd, mode, projectTrusted, protectedPaths, approve?, prefixRules? });
  authorize(request: PermissionRequest): Promise<PermissionDecision>;
  changeMode(mode: ApprovalMode): void;
  setApprove(handler: ApprovalHandler): void;
}

type ApprovalMode = "ask" | "auto-edit" | "full-auto" | "deny";
```

非 TTY 下 `ask` 自动降级为 `deny`（fail-closed）。

### 4.5 Steering（mid-turn 控制）

来源：[packages/agent-runtime/src/steering.ts](file:///Users/tohnee/Trae/Code/focuscode/packages/agent-runtime/src/steering.ts)。

```typescript
class SteeringQueue {
  constructor(maximum?: number);

  append(text: string): string;        // 在当前轮结束后注入
  interrupt(text: string): string;     // 立即打断当前轮
  followUp(text: string): string;      // 当前 submit() 完成后注入下一轮
  retrieve(queue?: "append" | "interrupt" | "follow-up"): SteeringItem[];
  remove(id: string): boolean;
  clear(queue?: ...): void;
}

interface SteeringItem {
  id: string;
  text: string;
  mode: "append" | "interrupt" | "follow-up";
  queuedAt: number;
}
```

投递策略：`steeringDelivery: "all"`（默认）一次注入全部；`"one-at-a-time"` 每轮注入一条。

### 4.6 Spec Engine（需求澄清）

来源：[packages/agent-runtime/src/spec-engine.ts](file:///Users/tohnee/Trae/Code/focuscode/packages/agent-runtime/src/spec-engine.ts)。

5 阶段小模型管线：classifier → explorer → drafter → decision-detector → enhancer。把模糊需求澄清为持久化 spec + enhanced prompt + 初始 todos。

```typescript
interface SpecEngineOptions {
  enabled?: boolean;                  // 默认 true
  classifierModel?: ModelProfile;
  drafterModel?: ModelProfile;
  enhancerModel?: ModelProfile;
  // ...
}

interface SpecEngineDeps {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string, options?: { recursive: boolean }): Promise<void>;
  // ...
}

class SpecEngine {
  constructor(options: SpecEngineOptions, deps: SpecEngineDeps);
  clarify(input: {
    prompt: string;
    attachments?: AgentAttachment[];
    cwd: string;
    sessionBranch: AgentMessage[];
    modelClient: ModelClient;
    model: ModelProfile;
    toolRegistry: AgentToolRegistry;
    eventSink?: ...;
    externalSignal?: AbortSignal;
  }): Promise<SpecEngineResult>;
}
```

### 4.7 MCP 客户端

来源：[packages/agent-runtime/src/mcp.ts](file:///Users/tohnee/Trae/Code/focuscode/packages/agent-runtime/src/mcp.ts)。

```typescript
interface McpServerSpec {
  id: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  disabled?: boolean;
}

// 加载与 pin 验证：
const mcpTools = await loadMcpTools(config.mcp.servers, {
  pins: config.mcp.pins, // McpToolPinV1[]
  // 失败时抛 McpSchemaChangedError，CLI 非零退出
});
```

`McpToolPinV1` 字段：`serverId`、`serverVersion`、`toolName`、`schemaDigest`、`transportDigest`。任何字段漂移即 fail-closed。MCP server 子进程**不接触** Provider token。

### 4.8 Skills 系统

来源：[packages/agent-runtime/src/skills.ts](file:///Users/tohnee/Trae/Code/focuscode/packages/agent-runtime/src/skills.ts)。

```typescript
interface Skill {
  id: string;
  name: string;
  triggerKeywords: string[];
  prompt: string;
  toolAllowlist?: string[];
}

interface SkillManifest {
  schemaVersion: "focuscode-skills.v1";
  skills: Skill[];
}

function loadSkills(source: string | SkillManifest): Promise<Skill[]>;
function selectSkills(skills: Skill[], input: string): Skill[];
function buildSkillPrompt(selected: Skill[]): string;
```

每次 `submit()` 调用前根据输入文本匹配 trigger keywords，把命中的 skill prompt 追加到 system message。

### 4.9 其他 Agent Runtime 模块

- **`AuditJournal`**：HMAC 签名的 append-only 审计日志。企业模式要求 32 字节 key。
- **`CheckpointStore`**：文件级 undo 快照，按 sessionId 分目录。
- **`LspClient` / `LspDiagnosticProvider`**：内置 TS/Python/Go/Rust 诊断。
- **`CircuitBreaker`**：Provider 级熔断。
- **`FallbackModelClient`**：多模型降级链。
- **`ProcessExtensionHost`**：进程级扩展隔离（不是沙箱）。
- **`TeamTool` / `GraphTool` / `DelegateTool` / `GoalTool` / `TodoTool`**：内置高级工具。

---

## 5. 审计型 Harness Kernel（`@focuscode/harness-core`）

来源：[packages/harness-core/src/focus-kernel.ts](file:///Users/tohnee/Trae/Code/focuscode/packages/harness-core/src/focus-kernel.ts)、[packages/harness-core/src/state-machine.ts](file:///Users/tohnee/Trae/Code/focuscode/packages/harness-core/src/state-machine.ts)。

Kernel 是**可恢复、可重放**的任务状态机。状态转换由 `DecisionPort` 输出驱动，副作用通过 `EffectPort` 执行，事实写入 `FactPort`（注意：是 `FactPort` 不是 `FactStore`）。

```typescript
// 来自 packages/harness-core/src/focus-kernel.ts
export interface FocusKernelDependencies {
  decision: DecisionPort;
  effects: EffectPort;
  facts: FactPort; // 注意：FactPort（不是 FactStore）
  verifier: VerifyPort; // 注意：VerifyPort（不是 VerifierPort）
  tools: ToolSpecV1[];
  workerId: string; // 必填，非可选
  now?: () => Date; // 注入时钟用于测试
}

export interface KernelRunRequest {
  task: TaskSpecV1;
  execution: ExecutionContextV1;
  model: CertifiedModelRefV1;
}

export class FocusKernel {
  constructor(dependencies: FocusKernelDependencies);
  async run(request: KernelRunRequest): Promise<KernelRunResult>;
  // 注意：FocusKernel 没有公开的 resume(taskId) 方法。
  // 恢复机制：再次调用 run()，传入相同 taskId 的 ExecutionContext；
  // FocusKernel 会从 FactPort.loadCheckpoint() 与 loadEvents() 重建状态。
}

export interface KernelRunResult {
  checkpoint: KernelCheckpointV1; // 任务终态快照（含 state/turn/actionCount/budget/model）
  events: DomainEventV1[]; // 本次 run 产生的全部 DomainEvent（含 effect 收据）
  verification?: VerificationReportV1; // 注册验证命令的结果（未配置则缺省）
}
```

### 完成 Gate

Kernel 在标记任务 `ACCEPTED` 前必须通过：

1. **Decision Gate**：模型决策输出 `completion_candidate`（声明任务完成）
2. **Effect Gate**：所有声明的 effects 已落 `EffectReceiptV1`（写入 `events`）
3. **Verifier Gate**：`VerifyPort.verify({ phase: "target", baseline })` 返回 `conclusion === "PASS"`

任何 Gate 失败 → 任务进入 `REJECTED` / `FAILED` / `BLOCKED` 等状态（具体由 `state-machine.ts` 决定），checkpoint 落盘等待下次 `run()` 恢复。

### 状态机

实际状态枚举见 `TaskStateSchema`（共 17 个值，已在 §3.1 列出）。典型转换路径：

```
CREATED → PREFLIGHT → READY → RUNNING
  → WAITING_APPROVAL（PolicyEngine disposition=approval_required）
  → RUNNING（ApprovalPort.request 返回 true）
  → VERIFYING（Decision 输出 completion_candidate）
  → REVIEW_READY（target 验证通过）/ RECONCILING（验证发现回归）
  → ACCEPTED（Verifier Gate 通过）/ REJECTED（回归未消解）
  → 或 BLOCKED / FAILED / CANCELLING → CANCELLED / EXPIRED
```

crash-boundary：进程崩溃后再次调用 `run()` 传入相同 `taskId`，Kernel 从 `FactPort.loadCheckpoint()` 重建状态、从 `loadEvents()` 重放未 checkpoint 的事件。已落 receipt 的 effects 通过 `EffectLedger` 幂等去重，不会重复执行。`focus-kernel.ts` 还内置 crash window 检测：若 `checkpoint.eventVersion` 超过 event log 最大 seq（checkpoint 落盘成功但后续 event append 未提交），Kernel 会丢弃 checkpoint 从 event log 重建，避免永久版本冲突。

---

## 6. Model Gateway（`@focuscode/model-gateway`）

来源：[packages/model-gateway/src/index.ts](file:///Users/tohnee/Trae/Code/focuscode/packages/model-gateway/src/index.ts)。

把模型调用封装成**原子决策**：一个 `decide()` 调用 = 一次完整的模型响应 + 工具调用解析。

### 6.1 `GatewayDecisionPort`

```typescript
class GatewayDecisionPort implements DecisionPort {
  constructor({
    loadedPack: LoadedModelPack,
    contextCompiler: ContextCompiler,
    transport: OpenAICompatibleTransport,
  });

  // 来自 DecisionPort（packages/contracts/src/ports.ts）
  decide(input: TurnInputV1, model: CertifiedModelRefV1): Promise<AtomicDecisionResultV1>;
}
```

> 注意：`decide()` 的入参是 `TurnInputV1`（不是 `DecisionInput`，该类型不存在），返回 `AtomicDecisionResultV1`（不是 `ModelDecisionV1`，后者是 `AtomicDecisionResultV1.decision` 字段的类型）。

### 6.2 `OpenAICompatibleTransport`

```typescript
class OpenAICompatibleTransport {
  constructor({
    baseUrl: string;
    apiKey?: string;
    extraHeaders?: Record<string, string>;
  });

  complete(request: ModelRequest): Promise<ModelResponse>;
}
```

### 6.3 Model Pack

声明式模型描述包：

```typescript
function loadModelPack(path: string): Promise<LoadedModelPack>;
function createDevelopmentModelRef(pack: LoadedModelPack, modelId: string): CertifiedModelRefV1;
```

`generic-openai/pack.json` 是默认包，仓库 `model-packs/` 下提供。

### 6.4 Atomic Parser

`atomic-parser.ts` 把流式 SSE 切片解析为原子 `ModelDecisionV1`。处理任意分片、JSON fallback、tool-argument 拼接、usage 字段。

---

## 7. Action 域与后端（`@focuscode/action-domain` / `action-backends`）

### 7.1 `PolicyEngine`（action-domain）

来源：[packages/action-domain/src/policy.ts](file:///Users/tohnee/Trae/Code/focuscode/packages/action-domain/src/policy.ts)。

```typescript
// 来自 packages/action-domain/src/policy.ts
export type PolicyDisposition = "grant" | "approval_required" | "deny";

export interface PolicyDecision {
  disposition: PolicyDisposition; // 不是 kind，值也不是 "prompt" 而是 "approval_required"
  reason: string;
  riskScore: number; // 数值风险分，不是 "low"|"medium"|"high"|"critical" 枚举
}

export interface PolicyConfig {
  protectedPaths: string[];
  maxChangedFiles: number;
  maxChangedLines: number;
  maxRiskScore: number;
  allowNetwork: boolean;
  allowSecrets: boolean;
  autoGrantRegisteredCommands: boolean;
  autoGrantSafeWrites: boolean;
  approvalMode?: ApprovalMode; // 会话审批矩阵选择器（会话路径用，Kernel 路径不设）
  projectTrusted?: boolean; // 仓库验证命令信任闸门（仅 approvalMode="auto-edit" 时相关）
}

export interface ApprovalRequest {
  intent: ActionIntentV1;
  tool: ToolSpecV1;
  reason: string;
  currentLedger: EffectLedgerSnapshot;
  projectedRiskScore: number;
}

export interface ApprovalPort {
  request(request: ApprovalRequest): Promise<boolean>; // 入参是单个 ApprovalRequest 对象
}

export class PolicyEngine {
  constructor(config: PolicyConfig);
  evaluate(
    intent: ActionIntentV1,
    tool: ToolSpecV1,
    ledger: EffectLedgerSnapshot,
    projectedRiskScore: number,
  ): PolicyDecision;
  setApprovalMode(mode: ApprovalMode): void;
}
```

> **重要**：`evaluate()` 入参是 `(intent, tool, ledger, projectedRiskScore)` 四个参数，不是 `(intent, context)` 两个参数。`PolicyDecision` 字段是 `disposition` 不是 `kind`，值是 `"approval_required"` 不是 `"prompt"`，风险用 `riskScore: number` 不是字符串枚举。

`ShellPolicy`（[action-domain/src/shell-policy.ts](file:///Users/tohnee/Trae/Code/focuscode/packages/action-domain/src/shell-policy.ts)）提供命令前缀白名单和危险 token 检测。

### 7.2 `LocalActionRuntime`（action-backends）

来源：[packages/action-backends/src/local-action-runtime.ts](file:///Users/tohnee/Trae/Code/focuscode/packages/action-backends/src/local-action-runtime.ts)。

```typescript
export class LocalActionRuntime implements EffectPort {
  constructor(
    registry: ToolRegistry,
    policy: PolicyEngine,
    approval: ApprovalPort,
    now?: () => Date, // 注入时钟用于测试
    journal?: ReceiptJournal, // 可选审计日志（HMAC journal）
  );

  submit(
    intents: ActionIntentV1[],
    context: EffectContextV1,
    signal?: AbortSignal,
  ): Promise<EffectReceiptV1[]>;
}
```

### 7.3 工具与命令

- `ToolRegistry`：工具注册表
- `SafeCommandRunner`：受限命令执行器，按 `commands` 白名单匹配
- `WorkspaceGuard`：工作区根保护
- `createLocalToolRegistry(workspace, runner)`：注册内置工具（read/write/edit/apply_patch/glob/grep/bash/git_status 等）
- `ReceiptJournal`：append-only 收据日志

### 7.4 `EffectLedger`

来源：[packages/action-domain/src/effect-ledger.ts](file:///Users/tohnee/Trae/Code/focuscode/packages/action-domain/src/effect-ledger.ts)。

把 intents → grants → receipts 三段记录在内存中，用于一致性检查与 reconciliation。

---

## 8. Contracts 与 Protocols

### 8.1 `@focuscode/contracts`

仅含 typebox schema、类型、纯函数（`newId`、`sha256Digest`、`assertSchema`、路径工具）。无任何运行时依赖。

### 8.2 `@focuscode/protocols`

来源：[packages/protocols/src/index.ts](file:///Users/tohnee/Trae/Code/focuscode/packages/protocols/src/index.ts)。

协议边界语义映射，不直接写 fact。

**MCP Pin 验证**：

```typescript
interface McpToolPinV1 {
  serverId: string;
  serverVersion: string;
  toolName: string;
  schemaDigest: Digest;
  transportDigest: Digest;
}

function assertMcpToolPin(expected: McpToolPinV1, observed: McpToolPinV1): void;
// 失败抛 McpSchemaChangedError
```

**ACP 能力协商**：

```typescript
function negotiateAcpCapabilities(
  client: ProtocolCapabilitiesV1,
  server: ProtocolCapabilitiesV1,
): CapabilityNegotiationResultV1;
```

**A2A Delegation**：

```typescript
interface DelegationSpecV1 {
  schemaVersion: "delegation-spec.v1";
  delegationId: string;
  objective: string;
  inputs: ArtifactRefV1[];
  allowedData: string[];
  allowedCapabilities: string[];
  outputSchemaDigest: Digest;
  maxTurns: number;
  deadline: string;
  maxDelegationDepth: number;
}

function assertReadOnlyDelegation(spec: DelegationSpecV1): void;
// Alpha A2A 网关：拒绝写能力，maxDelegationDepth ≤ 1
```

**Native Capsule 信任分级**：

```typescript
type NativeCapsuleTrustLevel = "C0" | "C1" | "C2" | "C3";

function classifyNativeCapsule(manifest: NativeCapsuleManifestV1): NativeCapsuleTrustLevel;
// C0 = 全部能力，C3 = 最少约束
```

---

## 9. Persistence 与 Asset Plane

### 9.1 `FileFactStore`（`@focuscode/persistence`）

来源：[packages/persistence/src/file-fact-store.ts](file:///Users/tohnee/Trae/Code/focuscode/packages/persistence/src/file-fact-store.ts)。

```typescript
// 来自 packages/persistence/src/file-fact-store.ts
export class VersionConflictError extends Error {
  constructor(
    readonly expected: number,   // 客户端期望的 seq
    readonly actual: number,     // 当前实际 seq
  );
}

export interface FileFactStoreOptions {
  /** 孤立 append 锁被视为 stale 被回收的阈值 */
  lockTtlMs?: number;            // 默认 30_000
  lockRetryAttempts?: number;    // 默认 200
  lockRetryDelayMs?: number;     // 默认 10
}

export class FileFactStore implements FactPort {
  constructor(
    readonly rootDirectory: string,
    options?: FileFactStoreOptions,
  );

  // FactPort 实现
  append(request: AppendRequestV1): Promise<AppendAckV1>;
  loadEvents(taskId: string, afterSeq?: number): Promise<DomainEventV1[]>;
  loadCheckpoint(taskId: string): Promise<KernelCheckpointV1 | undefined>;
  saveCheckpoint(checkpoint: KernelCheckpointV1): Promise<void>;

  // 额外的运维方法（非 FactPort 接口）
  listTaskIds(): Promise<string[]>;
}
```

**存储布局**：

- `<rootDirectory>/tasks/<taskId>/events.jsonl` —— append-only JSONL，每行一个 `DomainEventV1`
- `<rootDirectory>/tasks/<taskId>/checkpoint.json` —— 同一目录下的 checkpoint 文件
- `<rootDirectory>/tasks/<taskId>/.append.lock` —— 进程级 append 锁（含 `pid` + `acquiredAt`，超 TTL 后可被 steal）

**关键性质**：

1. **乐观并发**：`append(request)` 用 `request.expectedVersion` 校验当前 events 数量，不匹配抛 `VersionConflictError`。
2. **持久化**：`appendFileDurable()` 调用 `fsync()` 后才返回；`saveCheckpoint()` 走 `temp → rename → syncDirectory` 原子替换。
3. **完整性**：`loadEvents()` 对每行验证 `sha256Digest` 与事件体内的 `digest` 一致；中间行损坏立即抛错，最末行截断则降级丢弃。
4. **任务 ID 校验**：`/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/`，防止路径穿越。
5. **空 append**：`request.events.length === 0` 时返回 `{ firstSeq: expectedVersion, lastSeq: expectedVersion, events: [] }`，**不**持有锁。

> 注意：接口名是 `FactPort`（不是 `FactStore`）。`FileFactStore` 是 `@focuscode/persistence` 的实现类，方法名是 `append` / `loadEvents`（不是 `record` / `listTasks`）。`listTaskIds()` 是非 Port 的运维辅助方法。

### 9.2 `FileMemoryStore`（`@focuscode/asset-plane`）

来源：[packages/asset-plane/src/memory-store.ts](file:///Users/tohnee/Trae/Code/focuscode/packages/asset-plane/src/memory-store.ts)。

记忆系统是**提案驱动**（propose → accept），不是直接读写键值。所有写入先落 `proposals.jsonl`，由用户或外部审计显式 `accept()` 后才进入 `records.jsonl`。inferred 置信度的记录必须带 `acceptedBy` 才能落 records。

```typescript
// 来自 packages/asset-plane/src/memory-store.ts
export class FileMemoryStore {
  constructor(rootDirectory: string);

  /** 提交一条记忆提案，落 proposals.jsonl（mode 0o600） */
  propose(proposal: MemoryWriteProposalV1): Promise<void>;

  /** 接受提案，写入 records.jsonl + acceptances.jsonl；inferred 置信度必须带 acceptedBy */
  accept(proposalId: string, acceptedBy: string): Promise<MemoryRecordV1>;

  listProposals(): Promise<MemoryWriteProposalV1[]>;
  listRecords(): Promise<MemoryRecordV1[]>;
}
```

**存储布局**（`<rootDirectory>/memory/` 下）：

- `proposals.jsonl` —— 待决/已决提案
- `records.jsonl` —— 已接受的记忆记录
- `acceptances.jsonl` —— `{ proposalId, memoryId, acceptedBy }` 审计链

`MemoryRecordV1` 与 `MemoryWriteProposalV1` 的 schema 见 `docs/schemas/memory-record.v1.schema.json`。所有读写都过 `assertSchema()` 强校验。

> 注意：没有 `read(key)` / `write(key, record)` / `delete(key)` 方法。记忆不可删除，只能通过新增记录覆盖语义。

---

## 10. Auth（`@focuscode/auth`）

来源：[packages/auth/src/index.ts](file:///Users/tohnee/Trae/Code/focuscode/packages/auth/src/index.ts)。

### 10.1 `OAuthClient`

来源：[packages/auth/src/oauth.ts](file:///Users/tohnee/Trae/Code/focuscode/packages/auth/src/oauth.ts)。

支持 PKCE、Device Code、Refresh、Revoke 四种流程。

```typescript
class OAuthClient {
  constructor(profile: OAuthProfile, options?: OAuthFetchOptions);

  createAuthorizationRequest(redirectUri: string): AuthorizationRequest;
  authorizeWithLoopback(options?: { open?; timeoutMs?; port? }): Promise<OAuthTokenSet>;
  exchangeAuthorizationCode(code: string, request: Pick<AuthorizationRequest, "verifier" | "redirectUri">): Promise<OAuthTokenSet>;
  requestDeviceAuthorization(): Promise<DeviceAuthorization>;
  authorizeWithDeviceCode(onCode?: (auth: DeviceAuthorization) => void | Promise<void>): Promise<OAuthTokenSet>;
  refresh(refreshToken: string): Promise<OAuthTokenSet>;
  revoke(token: string, tokenTypeHint?: "access_token" | "refresh_token"): Promise<void>;
}

class OAuthProtocolError extends Error {
  constructor(message: string, readonly code: string, readonly status?: number);
}
```

`OAuthProfile` 字段：`id`、`clientId`、`clientSecret?`、`authorizationEndpoint?`、`tokenEndpoint`、`deviceAuthorizationEndpoint?`、`revocationEndpoint?`、`scopes`、`audience?`、`extraAuthorizationParams?`、`extraTokenParams?`、`tokenEndpointAuthMethod?`。

`OAuthTokenSet`：`accessToken`、`tokenType`、`refreshToken?`、`scope?`、`expiresAt?`、`idToken?`。

### 10.2 `EncryptedCredentialStore`

来源：[packages/auth/src/credential-store.ts](file:///Users/tohnee/Trae/Code/focuscode/packages/auth/src/credential-store.ts)。

AES-256-GCM 加密 + scrypt 派生密钥。

```typescript
class EncryptedCredentialStore {
  constructor(options: { directory: string; passphrase?: string; now?: () => Date });

  set(
    provider: string,
    account: string,
    value: Omit<StoredCredential, "provider" | "account" | "createdAt" | "updatedAt">,
  ): Promise<StoredCredential>;
  get(provider: string, account?: string): Promise<StoredCredential | undefined>;
  delete(provider: string, account?: string): Promise<boolean>;
  list(): Promise<Array<Omit<StoredCredential, "token"> & { expiresAt?: number }>>;
}
```

凭据文件 `credentials.enc.json` 持久化加密 envelope，`credentials.key` 持久化派生密钥（chmod 0600）。

### 10.3 Provider 预设

`packages/auth/src/profiles.ts` 内置 Kimi/Qwen/GLM/DeepSeek/MiniMax 等五系 11 个区域预设（包括 Moonshot CN/Global、DashScope CN/International、智谱 BigModel 等）。可通过 `providers` 配置覆盖。

---

## 11. Sandbox（`@focuscode/sandbox`）

来源：[packages/sandbox/src/factory.ts](file:///Users/tohnee/Trae/Code/focuscode/packages/sandbox/src/factory.ts)、[packages/sandbox/src/types.ts](file:///Users/tohnee/Trae/Code/focuscode/packages/sandbox/src/types.ts)。

```typescript
// 来自 packages/sandbox/src/types.ts
export type SandboxKind = "host" | "docker" | "gvisor" | "vm" | "seatbelt" | "auto";

export interface SandboxLimits {
  memory: string; // 如 "512m"
  cpus: number;
  pids: number;
  maxOutputChars: number;
}

export interface SandboxCommand {
  command: string;
  cwd: string;
  workspaceRoot: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface SandboxResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  backend: Exclude<SandboxKind, "auto">;
  invocation?: { executable: string; arguments: string[] };
}

export interface SandboxHealth {
  available: boolean;
  backend: Exclude<SandboxKind, "auto">;
  detail: string;
  isolation?: "none" | "container" | "kernel" | "vm";
}

export interface SandboxExecutor {
  readonly kind: Exclude<SandboxKind, "auto">;
  execute(command: SandboxCommand): Promise<SandboxResult>;
  health(): Promise<SandboxHealth>;
  dispose?(): Promise<void>;
}

export interface SandboxConfig {
  kind: SandboxKind;
  workspaceRoot: string;
  image?: string;
  network?: "none" | "bridge";
  readOnlyWorkspace?: boolean;
  requireImageDigest?: boolean;
  allowHostFallback?: boolean;
  vm?: Omit<VmSandboxOptions, "workspaceRoot">;
  limits?: Partial<SandboxLimits>;
}

// 来自 packages/sandbox/src/factory.ts
export async function createSandbox(config: SandboxConfig): Promise<SandboxExecutor>;
```

**`SandboxConfig` 字段说明**：

| 字段                 | 默认          | 说明                                        |
| -------------------- | ------------- | ------------------------------------------- |
| `kind`               | —             | 沙箱类型；`auto` 按选择链降级               |
| `workspaceRoot`      | —             | 工作区根路径，bind-mount 到沙箱内           |
| `image`              | 见 Dockerfile | Docker/gVisor 镜像；企业模式要求 digest pin |
| `network`            | `"none"`      | `"none"` 禁网 / `"bridge"` 允许容器网络     |
| `readOnlyWorkspace`  | `false`       | 工作区只读 mount                            |
| `requireImageDigest` | `false`       | 强制镜像 digest 验证（企业模式必开）        |
| `allowHostFallback`  | `false`       | `auto` 降级时是否允许落到 Host              |
| `vm`                 | —             | VM 模式必填，见 `VmSandboxOptions`          |
| `limits`             | 见 Dockerfile | 资源限制覆盖                                |

`VmSandboxOptions`：`workspaceRoot`、`host`、`remoteWorkspace`、`sshBinary?`、`identityFile?`、`port?`、`strictHostKeyChecking?`、`processRunner?`、`limits?`。

### `auto` 选择链

`gVisor → Docker → seatbelt (darwin only) → Host (仅 allowHostFallback=true) → 抛错`

每一步调用 `health()`，`available === true` 即返回；`allowHostFallback` 为 false 时拒绝降级到 Host 并抛 `"No isolated sandbox is available; install Docker/gVisor or configure a VM. Host fallback is disabled."`。

> **安全警告**：`host` **不是沙箱**，只是兼容路径。企业模式强制非 Host、digest 镜像、`--pull never`。`requireAvailable()` 在 `docker`/`gvisor`/`seatbelt`/`vm` 显式 kind 下也会先 `health()`，unavailable 直接抛错。

### 各执行器

- `HostSandbox`：直接 spawn，无隔离（`isolation: "none"`）
- `DockerSandbox`：Docker 容器；`runtime: "runsc"` 切换到 gVisor（`isolation: "container"` 或 `"kernel"`）
- `SeatbeltSandbox`：macOS `sandbox-exec` + seatbelt profile（`(deny default)` 基线 + 显式 allow），非 darwin fail-quiet 返回 `available: false`
- `SshVmSandbox`：远程 SSH VM（`isolation: "vm"`）

### 沙箱边界

容器只包住 Bash 及其子进程。**Provider/OAuth/Session/Extension Host 留在 CLI 主进程**，模型凭据不进入不可信执行环境，Tool 子进程只获得精简环境。

---

## 12. Ecosystem（`@focuscode/ecosystem`）

来源：[packages/ecosystem/src/extensions.ts](file:///Users/tohnee/Trae/Code/focuscode/packages/ecosystem/src/extensions.ts)、[packages/ecosystem/src/share.ts](file:///Users/tohnee/Trae/Code/focuscode/packages/ecosystem/src/share.ts)。

### 12.1 `ExtensionPackageManager`

来源：[packages/ecosystem/src/extensions.ts](file:///Users/tohnee/Trae/Code/focuscode/packages/ecosystem/src/extensions.ts)。

```typescript
// 来自 packages/ecosystem/src/extensions.ts
export interface FocusCodeExtensionManifest {
  apiVersion: "focuscode.extension.v1";
  entry: string; // 必须是包内相对路径（不能是绝对路径）
  displayName?: string;
  description?: string;
  permissions?: Array<"tools" | "commands" | "events" | "network" | "shell">;
  focuscode?: string;
}

export interface InstalledExtension {
  name: string;
  version: string;
  path: string;
  entryPath: string;
  integrity?: string; // 来自 package-lock.json 的 subresource integrity
  signed: boolean; // 是否通过 npm audit signatures
  manifest: FocusCodeExtensionManifest;
}

export interface ExtensionManagerOptions {
  directory: string; // 扩展安装根目录
  npmBinary?: string; // 默认 "npm"
  runner?: CommandRunner; // 可注入自定义执行器
}

export type CommandRunner = (
  executable: string,
  argumentsValue: string[],
  cwd: string,
) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;

export class ExtensionPackageManager {
  constructor(options: ExtensionManagerOptions);

  install(
    spec: string,
    options?: {
      requireSignature?: boolean; // 默认 = 远程包 true
      allowedPermissions?: FocusCodeExtensionManifest["permissions"]; // 默认 ["tools","commands","events"]
    },
  ): Promise<InstalledExtension>;

  remove(name: string): Promise<boolean>;
  list(): Promise<InstalledExtension[]>;
  pack(directory: string, destination?: string): Promise<string>;
  entryPaths(options?: { requireSignature?: boolean }): Promise<string[]>;
  // 注意：inspect() 是 private 方法，外部不可调用。
  // 想检查已安装扩展请用 list()；想校验未安装目录请用 validateExtensionPackage()。
}

// 模块级函数
export function validateExtensionPackage(directory: string): Promise<FocusCodeExtensionManifest>;
```

- `install` 使用 `npm install --ignore-scripts --save-exact`（**禁用 install scripts**）
- 远程包必须通过 `npm audit signatures` 验证（除非显式 `requireSignature: false`）
- `permissions` 必须在 `allowedPermissions` 内，否则拒绝
- 锁文件 `focuscode-extension-lock.v1`（`focuscode-lock.json`）
- `entryPaths({ requireSignature: true })` 用于企业模式：发现未签名扩展直接抛错
- `pack()` 内部调用 `npm pack --json`，返回生成的 tarball 绝对路径
- `validateExtensionPackage()` 校验未安装的源目录，返回 manifest

> **安全说明**：扩展是**显式可信代码**，不是沙箱化代码。`extensions.host: "process"` 提供进程级崩溃隔离但不是 containment。npm 签名与权限声明是供应链/同意控制。

### 12.2 `SessionShareService`

来源：[packages/ecosystem/src/share.ts](file:///Users/tohnee/Trae/Code/focuscode/packages/ecosystem/src/share.ts)。

```typescript
// 来自 packages/ecosystem/src/share.ts
export interface SessionShareBundle {
  schemaVersion: "focuscode-share.v1";
  shareId: string; // "share_" + UUID
  createdAt: string;
  workspaceHint: string; // 默认为 cwd basename
  session: Record<string, unknown>; // 脱敏后的 session 快照
  attachments?: Array<{ name: string; mediaType: string; data: string }>;
  redactions: number; // 脱敏字段计数
  signer: { algorithm: "Ed25519"; publicKey: string };
  signature: string; // base64 Ed25519 签名
}

export interface SessionShareOptions {
  identityDirectory: string; // Ed25519 密钥对存储目录
  fetchImplementation?: typeof fetch; // 默认 globalThis.fetch
  now?: () => Date; // 注入时钟用于测试
}

export class SessionShareService {
  constructor(options: SessionShareOptions);

  create(
    session: Record<string, unknown>,
    options?: {
      workspace?: string;
      attachments?: Array<{ name: string; mediaType: string; data: string }>;
      includeToolOutput?: boolean; // 默认 false（脱敏）
      includeImages?: boolean; // 默认 false（脱敏）
    },
  ): Promise<SessionShareBundle>;

  verify(bundle: SessionShareBundle): boolean; // 同步验签
  import(bundle: SessionShareBundle, workspace: string): Record<string, unknown>;
  write(bundle: SessionShareBundle, path: string): Promise<void>;
  read(path: string): Promise<SessionShareBundle>;
  publish(
    bundle: SessionShareBundle,
    endpoint: string,
    token?: string,
  ): Promise<{ id: string; url?: string }>;
  download(id: string, endpoint: string, token?: string): Promise<SessionShareBundle>;
}

// 模块级函数
export function verifySessionShareBundle(value: unknown): value is SessionShareBundle;
```

**关键性质**：

- **Ed25519 签名**：证明完整性，**不**证明身份或内容可信。`verify()` 同步返回 boolean；`import()` / `read()` / `download()` / `publish()` 在使用前都强制 `verify()`。
- **密钥持久化**：`<identityDirectory>/share-ed25519-private.pem`（0o600）+ `share-ed25519-public.pem`（0o644）；首次缺失时自动生成。
- **默认脱敏**：去除 `providerState`、tool 输出（`message.role === "tool"`）、图片附件；用正则替换 `sk-...`/`Bearer ...`/`api_key=...` 等敏感 token；`cwd` 替换为 `"$WORKSPACE"`。
- **附件限制**：`name` 必须匹配 `/^[\w .-]{1,160}$/`，`mediaType` 仅允许 `image/(png|jpeg|webp|gif)`，附件总大小 ≤ 20 MB；整个 bundle 序列化后 ≤ 20 MB。
- **服务器端**：通过 `publish()` POST 到 `/v1/shares`，`download()` GET `/v1/shares/<id>`；服务器实现参考 `apps/share-server`，支持 TTL 与 rate limit。
- **导入语义**：`import()` 会重写 `header.cwd` 为目标 workspace，删除 `sessionId` 与 `forkedFrom`（强制生成新会话）。

> 注意：bundle 类型是 `SessionShareBundle`（不是 `ShareBundle`）。`create()` 第一个参数是 session 对象，第二个参数是 options 对象（`workspace` 等都是可选的，不是必填）。

---

## 13. TUI（`@focuscode/tui`）

来源：[packages/tui/src/index.ts](file:///Users/tohnee/Trae/Code/focuscode/packages/tui/src/index.ts)。

TUI 是纯渲染层，**不直接调用** Provider 或工具。CLI 通过 `eventSink` 把 Agent 事件喂给 TUI。

主要导出：

- `App` —— TUI 主应用
- `Renderer` —— 终端渲染器
- `Themes`（`TUI_THEMES`）、`Mascots`（`TUI_MASCOTS`）、`Skins`（`BUILTIN_SKINS`、`parseSkinPack`、`serializeSkinPack`）
- `Companion`（`CompanionState`、`initialCompanion`、`parseCompanion`、`serializeCompanion`、`mascotFrame`、`progressToNext`、`levelName`）
- `Keymap`、`Layout`、`Picker`、`Editor`、`Diff`、`Markdown`、`Syntax`、`Search`、`CommandPalette`、`TodoPanel`、`Vim`、`Widgets`、`Width`、`ContextBar`、`SpecProgress`

四种布局模式：`classic` / `split` / `focus` / `wide`，按终端尺寸自适应。

---

## 14. Verifier Eval（`@focuscode/verifier-eval`）

来源：[packages/verifier-eval/src/registered-verifier.ts](file:///Users/tohnee/Trae/Code/focuscode/packages/verifier-eval/src/registered-verifier.ts)。

```typescript
// 来自 packages/verifier-eval/src/registered-verifier.ts
export class RegisteredCommandVerifier implements VerifyPort {
  constructor(
    private readonly runner: SafeCommandRunner,    // @focuscode/action-backends
    private readonly commandIds: string[],          // RepoProfileV1.verificationCommandIds
  );

  verify(request: {
    taskId: string;
    phase: "baseline" | "target";
    baseline?: VerificationReportV1;
  }): Promise<VerificationReportV1>;
}
```

`VerifyPort.verify()` 的入参是 `VerificationRequestV1`（见 §2.1），**不是** `{ taskId, checkpoint }`，也不存在 `evaluate()` 方法。

### 14.1 `VerificationReportV1` 真实结构

```typescript
interface VerificationReportV1 {
  schemaVersion: "verification-report.v1";
  conclusion: "PASS" | "BASELINE_FAIL" | "REGRESSION" | "BLOCKED" | "PARTIAL";
  phase: "baseline" | "target";
  results: Array<{
    commandId: string;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    durationMs: number;
    digest: Digest;
  }>;
  summary: string;
}
```

字段含义：

| 字段         | 说明                                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------------- |
| `conclusion` | 不是 `pass: boolean`，而是 5 值枚举                                                                   |
| `phase`      | `"baseline"` 或 `"target"`，与 request 一致                                                           |
| `results`    | 不是 `checks`；每项含 `commandId`、`exitCode`、`stdout`、`stderr`、`timedOut`、`durationMs`、`digest` |
| `summary`    | 人类可读总结                                                                                          |

### 14.2 `conclusion` 判定逻辑

| 条件                                            | conclusion                    |
| ----------------------------------------------- | ----------------------------- |
| `commandIds.length === 0`                       | `"PARTIAL"`（无注册命令）     |
| 任一 `exitCode === null`（命令无法启动）        | `"BLOCKED"`                   |
| 全部 `exitCode === 0 && !timedOut`              | `"PASS"`                      |
| `phase === "baseline"` 且存在失败               | `"BASELINE_FAIL"`             |
| `phase === "target"` 且失败与 baseline 完全一致 | `"BASELINE_FAIL"`（不算回归） |
| `phase === "target"` 且失败模式有变化           | `"REGRESSION"`                |

`hadSameFailures()` 比对 baseline 与 target 的 `(commandId, exitCode)` 集合；只要 target 失败集是 baseline 失败集的子集且非空，就判 `BASELINE_FAIL`。

### 14.3 异常处理

`runner.run(commandId)` 抛错时降级为 `{ exitCode: null, stdout: "", stderr: error.message, timedOut: false }`，digest 用 `sha256Digest(raw)` 计算。这会让 `conclusion` 走到 `"BLOCKED"` 路径，触发 fail-closed。

> 注意：`RegisteredCommandVerifier` 实现的是 `VerifyPort`（不是 `VerifierPort`）。`commandIds` 来自 `RepoProfileV1.verificationCommandIds`，仅在 `trustRepoConfig: true` 时由 LocalHarness 装载。

---

## 15. Context Compiler（`@focuscode/context-compiler`）

来源：[packages/context-compiler/src/context-compiler.ts](file:///Users/tohnee/Trae/Code/focuscode/packages/context-compiler/src/context-compiler.ts)、[packages/context-compiler/src/repo-profile.ts](file:///Users/tohnee/Trae/Code/focuscode/packages/context-compiler/src/repo-profile.ts)。

```typescript
// 来自 packages/context-compiler/src/context-compiler.ts
export interface CompiledContextV1 {
  frames: CanonicalFrameV1[];
  stablePrefixDigest: `sha256:${string}`;     // harness.contract + policy.snapshot + tools.schemas + repo.profile
  fullContextDigest: `sha256:${string}`;       // 全部保留 frames 的 digest
  droppedFrameKinds: string[];                 // 因 token 限制被丢弃的 frame 类型
}

export class ContextCompiler {
  constructor(
    private readonly repoProfile: RepoProfileV1,
    private readonly now?: () => Date,         // 默认 () => new Date()
  );

  compile(
    input: TurnInputV1,
    pack: ModelPackV1,
  ): CompiledContextV1;
}

// 来自 packages/context-compiler/src/repo-profile.ts
function buildRepoProfile(repoRoot: string): Promise<RepoProfileV1>;
```

`compile()` 入参是 `(input, pack)` 两个参数：

- `input: TurnInputV1` —— Kernel 喂进来的 task/execution/state/turn/publicPlan/recentEffects/recentEvents/tools
- `pack: ModelPackV1` —— Model Pack，提供 `contextEnvelope.maxInputChars` 与 `maxToolOutputChars`

**返回的 `CompiledContextV1`** 不是 `CompiledContext`，且只含 `frames` / `stablePrefixDigest` / `fullContextDigest` / `droppedFrameKinds` 四个字段（不含 `task` / `execution`）。

### 15.1 Frame 组成

按 priority 降序排列的 8 个 frame（priority 越高越不可丢弃）：

| Frame kind         | Priority | Trust  | 内容                                            |
| ------------------ | -------- | ------ | ----------------------------------------------- |
| `harness.contract` | 100      | system | 5 条不可变约束                                  |
| `policy.snapshot`  | 100      | system | policySnapshot / dataClass / budget             |
| `tools.schemas`    | 95       | system | toolSpecs JSON                                  |
| `repo.profile`     | 90       | owner  | languages / manifests / protectedPaths / digest |
| `task`             | 100      | owner  | task spec JSON                                  |
| `kernel.state`     | 90       | system | state / turn / publicPlan                       |
| `recent.effects`   | 85       | tool   | 截断到 `maxToolOutputChars`                     |
| `recent.events`    | 70       | system | 截断到 `maxToolOutputChars`                     |

### 15.2 溢出回收策略

当全部 frames 总长度超过 `pack.contextEnvelope.maxInputChars` 时，按 priority 升序丢弃可移除 frame（`harness.contract` 与 `policy.snapshot` 永不丢弃），被丢弃的 frame 类型记入 `droppedFrameKinds`。

### 15.3 `RepoProfileV1`

```typescript
interface RepoProfileV1 {
  schemaVersion: "repo-profile.v1";
  digest: Digest;
  root: string;
  languages: string[];
  manifests: Record<string, string>; // package.json/tsconfig/go.mod/Cargo.toml 等
  protectedPaths: string[];
  verificationCommandIds: string[];
  // ...
}
```

`buildRepoProfile` 扫描仓库，生成稳定 profile。其 `digest` 进入 `ExecutionContextV1.policySnapshot`，确保策略可重放。

---

## 16. 扩展开发契约

### 16.1 扩展清单

`manifest.json`：

```json
{
  "apiVersion": "focuscode.extension.v1",
  "entry": "./dist/index.js",
  "displayName": "My Extension",
  "description": "...",
  "permissions": ["tools", "commands", "events"],
  "focuscode": "^0.4.0"
}
```

`permissions` 必须在安装时被 `allowedPermissions` 包含，否则拒绝。`network` 和 `shell` 是高危权限，企业模式默认拒绝。

### 16.2 扩展入口

扩展 entry 默认在 CLI 主进程内运行（`extensions.host: "in-process"`）。`extensions.host: "process"` 切换到子进程隔离（崩溃隔离，非沙箱）。

入口模块导出：

```typescript
export function activate(context: ExtensionContext): void;
export function deactivate?(): void | Promise<void>;
```

`ExtensionContext` 提供：工具注册、命令注册、事件订阅、Agent 钩子。

### 16.3 项目 Instructions / Skills / Extensions

仅在 `--trust-project` 后加载。非 TTY 下 `ask` 降级为 `deny`。

---

## 17. 错误码与失败模式

| 错误                            | 来源                       | 含义                                                                       | 处理                                       |
| ------------------------------- | -------------------------- | -------------------------------------------------------------------------- | ------------------------------------------ |
| `OAuthProtocolError`            | `@focuscode/auth`          | OAuth 流程错误（`authorization_pending`、`slow_down`、`expired_token` 等） | Device Code 自动重试，其他抛出             |
| `ModelHttpError`                | `@focuscode/agent-runtime` | 模型 HTTP 错误，含 status 与 body                                          | 按 `reliability` 重试，超过阈值熔断        |
| `ModelResponseDriftError`       | `@focuscode/agent-runtime` | `system_fingerprint` 漂移                                                  | 按 `systemFingerprintPolicy` fail/warn/off |
| `McpSchemaChangedError`         | `@focuscode/protocols`     | MCP tool schema/transport 漂移                                             | fail-closed，CLI 非零退出                  |
| `assertReadOnlyDelegation` 抛错 | `@focuscode/protocols`     | A2A 写能力或深度超限                                                       | Alpha 网关拒绝                             |
| Kernel `verifier-rejected`      | `@focuscode/harness-core`  | Verifier 评估未通过                                                        | 任务标记 failed，可 resume                 |
| `Sandbox unavailable`           | `@focuscode/sandbox`       | `auto` 链全部不可用且未允许 Host fallback                                  | 抛错；安装 Docker/gVisor 或配置 VM         |

### Fail-closed 边界

- 非 TTY 下 `ask` → `deny`
- MCP pin 漂移 → 启动失败
- 企业模式无 audit HMAC key（< 32 字节）→ 启动失败
- 企业模式 Host sandbox → 启动失败
- 企业模式未签名扩展 → 启动失败
- 扩展权限超出 `allowedPermissions` → 安装失败

---

## 18. 版本与稳定性策略

- 包版本与仓库版本一致（当前 `0.4.0-beta.2`）
- `schemaVersion` 字段（如 `"task-spec.v1"`、`"focuscode-session.v1"`）是稳定契约锚点，跨大版本才变更
- 向后兼容测试：契约/schema 变更必须有 golden + 向后兼容测试（见 [AGENTS.md](file:///Users/tohnee/Trae/Code/focuscode/AGENTS.md) 测试策略）
- `pnpm schemas` 在契约变更后必须运行，并提交 `docs/schemas/`
- 发布产物是独立 ESM bundle，安装侧不需要 pnpm 或 monorepo

### 不稳定 API

以下 API 可能在 minor 版本变更：

- `SpecEngine` 内部阶段（classifier/drafter/enhancer）签名
- `TUI` 渲染层（`App`、`Renderer`）内部实现
- `Model Pack` 文件格式（除 `generic-openai/pack.json` 外）
- 未在本文档列出但导出的内部模块

### 稳定 API

- `@focuscode/contracts` 所有 schema 与类型
- `@focuscode/sdk` 的 `createLocalHarness` / `createCodingAgent` / `createSessionEffectSpine`
- `CodingAgent` 的 `submit` / Steering / `status` / `exportSnapshot`
- `SessionStore` 的 `create` / `load` / `list` / `append` / `fork` / `compact`
- `EncryptedCredentialStore` 全部方法
- `OAuthClient` 全部方法
- `createSandbox` / `SandboxConfig` 形状
- `ExtensionPackageManager` 全部方法

---

## 附录：快速参考

### A.1 最小可运行示例

```typescript
import { createCodingAgent } from "@focuscode/sdk";

// CreateCodingAgentOptions 继承 AgentConfigOverrides，可直接传入
// provider/model/apiKeyEnv/approval 等字段（详见 packages/sdk/src/coding-agent.ts）。
const { agent } = await createCodingAgent({
  cwd: process.cwd(),
  provider: "kimi",
  model: "kimi-k2",
  apiKeyEnv: "MOONSHOT_API_KEY",
  approval: "ask",
});

const result = await agent.submit("解释这个仓库的入口文件");
console.log(result.content);
```

### A.2 审计型 Harness 示例

```typescript
import { createLocalHarness } from "@focuscode/sdk";
import { resolve } from "node:path";

const harness = await createLocalHarness({
  repoRoot: resolve("/repo"),
  stateDirectory: resolve("/state"),
  model: {
    kind: "openai-compatible",
    modelId: "kimi-k2",
    baseUrl: "https://api.moonshot.cn/v1",
    apiKey: process.env.MOONSHOT_API_KEY,
  },
});

// TaskSpecV1 字段必须满足 contracts 的 TaskSpecSchema（详见 docs/schemas/task-spec.v1.schema.json）。
const result = await harness.run({
  schemaVersion: "task-spec.v1",
  repoId: resolve("/repo"),
  baseRef: "WORKTREE",
  mode: "change",
  objective: "为 utils.ts 增加单元测试",
  acceptanceCriteria: [
    { id: "owner-objective", description: "为 utils.ts 增加单元测试" },
    { id: "registered-verification", description: "pnpm test 通过" },
  ],
  scope: { maxFiles: 3, maxChangedLines: 200 },
  requestedProfile: "balanced",
});

// KernelRunResult 形状：{ checkpoint, events, verification? }
console.log(result.checkpoint.state, result.verification?.conclusion);
console.log("turns:", result.checkpoint.turn, "actions:", result.checkpoint.actionCount);
```

### A.3 自定义 ApprovalHandler

`ApprovalHandler` 通过 `CodingAgent.create({ permission: { approve } })` 或 `createCodingAgent({ approve })` 注入：

```typescript
const { agent } = await createCodingAgent({
  cwd: process.cwd(),
  approve: async (req) => {
    // req: PermissionRequest { tool, arguments, reason, risk }
    if (req.risk === "critical") return false;
    // 自定义 UI / 外部审批系统调用...
    return true;
  },
});
```

### A.4 Steering 示例

```typescript
const promise = agent.submit("重构 auth 模块");

// 5 秒后追加补充说明（下一轮开始前注入）
setTimeout(() => void agent.steer("别忘了更新 docs/OAUTH_AND_PROVIDERS.md", "append"), 5_000);

// 立即打断当前模型生成，下一轮注入新指令
await agent.steer("停下来，先看一下现有的测试覆盖率", "interrupt");

// 列出当前队列
const queued = agent.listSteering();

// 取消最近一条
await agent.unsteer();

const result = await promise;
```

### A.5 事件订阅

```typescript
// AgentEvent 是判别联合，完整定义见 packages/agent-runtime/src/types.ts
agent = await CodingAgent.create({
  // ...
  eventSink: (event) => {
    switch (event.type) {
      case "tool_start":
        // event.call: AgentToolCall
        console.log("→", event.call.name);
        break;
      case "tool_end":
        // event.result: ToolExecutionResult, event.durationMs: number
        console.log("←", event.call.name, `(${event.durationMs}ms)`);
        break;
      case "approval_required":
        // event.request: PermissionRequest
        break;
      case "agent_end":
        // event.response: AgentRunResult（不是 event.result）
        console.log("done", event.response.usage);
        break;
      case "spec_draft_ready":
        // event.specId / topic / understanding
        break;
    }
  },
});
```

---

> **维护说明**：本文档由代码审查生成，对应仓库 `main` 分支当前状态。契约变更后请同步更新本文档与 `docs/schemas/`。如发现文档与代码不一致，以代码为准并提 issue。
