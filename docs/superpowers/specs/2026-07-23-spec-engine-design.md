# Spec Engine 设计文档

- **日期**: 2026-07-23
- **主题**: 为 FocusCode 添加需求补全引擎（SpecEngine）
- **状态**: 已批准，待实施
- **方案**: 方案 C — SpecEngine 模块 + 小模型 Pipeline

## 概述

FocusCode 当前的 `CodingAgent.submit()` 直接将用户输入送入工具循环，缺少中间的
需求结构化与澄清层。当用户输入模糊时（如"让系统更健壮"），agent 只能基于不完整
理解执行，导致偏差。

SpecEngine 是一个可选的预处理模块，插入在 `submit()` 早期阶段（prompt 解析后、
工具循环前），通过多阶段小模型 pipeline 将模糊输入转化为结构化 spec + 增强 prompt

- 初始 todo，再进入正常执行。

### 核心决策

1. **双模式触发**: 默认智能判断输入清晰度；用户可用 `/spec` 强制触发补全，`/raw`
   显式跳过
2. **关键点确认**: agent 自主补全大部分细节，只在关键决策点（架构选择、破坏性变更、
   不可逆操作）暂停等待用户确认
3. **持久化 spec + prompt + todo**: 补全产物持久化到 `docs/specs/`，增强 prompt
   替换原始输入，todo 注入 todoState

### "过程不重要，输出结果才重要"理念

用户无需关心 pipeline 各阶段的执行细节，只需在关键决策点做选择。SpecEngine 自动
补全中间过程（意图识别、代码库探索、spec 草稿、决策检测、prompt 增强），最终输出
一个可直接执行的增强 prompt。

## §1 架构边界与集成点

### 位置

`packages/agent-runtime/src/spec-engine.ts`，与 `checkpoints.ts`、`steering.ts`、
`todo.ts` 同级，作为 `CodingAgent` 的可选协作模块。

### 边界合规性

- 仅依赖 `./types.js`、`./tools.js`、`./context.js`、`./skills.js` 等同包模块
- 不依赖 harness-core/model-gateway/persistence/sdk/auth/ecosystem/sandbox/tui/任何
  apps
- 不引入外部 npm 依赖（YAML 等用自写解析器，沿用 skills.ts 模式）
- 不出现 `node:child_process`/`fetch(`，与 harness-core 红线一致
- spec 写入通过注入的 `writeFile` 回调（来自 apps/cli 的 `node:fs/promises`），
  保持 agent-runtime 无 fs 直接依赖

### submit() 集成

在 `agent.ts` 的 `submit()` 方法中，prompt 解析后、`sessionStore.appendMessage` 前
插入可选的 clarify 阶段：

```typescript
async submit(input, externalSignal?) {
  let prompt = (typeof input === "string" ? input : input.text).trim();
  const attachments = typeof input === "string" ? undefined : input.attachments;
  if (!prompt && attachments?.length) prompt = "Analyze the attached image(s).";
  if (!prompt) throw new Error("Prompt must not be empty");
  // === 新增：SpecEngine 预处理 ===
  if (this.specEngine) {
    const result = await this.specEngine.clarify({
      prompt, attachments, cwd: this.options.cwd,
      sessionBranch: activeBranch(this.session),
      modelClient: this.modelClient, model: this.model,
      toolRegistry: this.registry, eventSink: this.eventSink,
      externalSignal,
    });
    if (result.action === "abort") return { stopped: "aborted", ... };
    if (result.action === "skip") {
      // /raw 或智能判断无需补全：原样执行
    } else {
      // /spec 或智能判断需要补全：用增强 prompt 替换
      prompt = result.enhancedPrompt;
      if (result.initialTodos?.length) this.todoState.seed(result.initialTodos);
      this.currentSpecId = result.specId;
    }
  }
  // === 原有流程不变 ===
  if (this.running) throw new Error("Agent is already processing a prompt");
  ...
}
```

### CodingAgentOptions 扩展

```typescript
export interface CodingAgentOptions extends AgentRuntimeOptions {
  // ... 原有字段 ...
  /**
   * 需求补全引擎：在 submit() 工具循环前对模糊输入做结构化补全，
   * 产出持久化 spec + 增强 prompt + 初始 todo。undefined 时该特性关闭。
   */
  specEngine?: SpecEngineOptions;
}
```

### SpecEngineOptions（初始设计，已被 §1.5 升级）

> **注意**：本节为初始设计，保留以展示设计演进。**最终实施以 §1.5 的 `SpecEngineOptions`
> 为准**（`classifierModel` 升级为 `pipeline: SpecPipeline`）。下方代码仅作参考，请勿
> 据此实现。

```typescript
// 初始版本（已废弃，见 §1.5 最终版本）
export interface SpecEngineOptions {
  enabled: boolean;
  autoTrigger: boolean;
  specDirectory: string;
  /** @deprecated 已被 §1.5 的 pipeline.classifier 取代 */
  classifierModel?: Partial<ModelProfile>;
  keyDecisionRules: KeyDecisionRule[];
  maxExplorationRounds: number;
}

export interface KeyDecisionRule {
  /** 规则名，如 "destructive-change" / "arch-decision" / "new-dependency" */
  name: string;
  /** 描述触发条件，由 classifier 模型判断 */
  description: string;
}
```

### 文件结构

```
packages/agent-runtime/src/
  spec-engine.ts          # SpecEngine 主类与类型
  spec-classifier.ts      # 输入清晰度判断（轻量模型调用）
  spec-collector.ts       # 代码库上下文收集（只读工具执行）
  spec-drafter.ts         # spec 草稿生成（结构化输出）
  spec-store.ts           # spec 持久化（通过注入的 fs 回调）
  spec-types.ts           # SpecDocument / SpecEvent / SpecResult 类型
```

## §1.5 小模型 Pipeline 增强

### 核心理念

将 SpecEngine 的各阶段任务按复杂度路由到最合适的模型大小：

| 阶段           | 任务类型      | 推荐模型 | 理由                          |
| -------------- | ------------- | -------- | ----------------------------- |
| 意图分类       | 二分类/多分类 | 1B-2B    | "是否需要补全"是低复杂度判断  |
| 关键决策点检测 | 规则匹配+分类 | 1B-2B    | 识别破坏性变更/架构决策等模式 |
| spec 草稿生成  | 结构化提取    | 3B-7B    | 需要理解语义但不需要代码执行  |
| prompt 增强    | 文本重写      | 3B-7B    | 将 spec 转化为执行级指令      |
| 代码库探索     | 工具调用+推理 | 主模型   | 需要工具调用能力和深度推理    |

### 更新后的 SpecEngineOptions

```typescript
export interface SpecEngineOptions {
  enabled: boolean;
  autoTrigger: boolean;
  specDirectory: string;
  maxExplorationRounds: number;
  keyDecisionRules: KeyDecisionRule[];

  /**
   * 小模型 pipeline 配置。每个阶段独立配置 ModelClient + ModelProfile。
   * 任一阶段 undefined 时，该阶段降级到主 modelClient（保证可用性）。
   */
  pipeline: SpecPipeline;
}

export interface SpecPipeline {
  /**
   * 意图分类器（1B-2B 推荐）：判断输入清晰度、是否需要补全。
   * 输入：用户原始 prompt + 简短上下文摘要
   * 输出：{ needsClarification: boolean, confidence: number, reason: string }
   * 推荐：Qwen2.5-1.5B / Llama-3.2-1B / Phi-3.5-mini (本地 via Ollama)
   */
  classifier?: SpecStageModel;

  /**
   * 关键决策点检测器（1B-2B 推荐）：从 spec 草稿中识别需要用户确认的决策点。
   * 输入：spec 草稿 + keyDecisionRules
   * 输出：{ decisions: { point, severity, options }[] }
   */
  decisionDetector?: SpecStageModel;

  /**
   * spec 草稿生成器（3B-7B 推荐）：结构化提取目标/约束/验收/任务拆解。
   * 输入：用户 prompt + 代码库探索结果
   * 输出：SpecDocument 草稿（JSON）
   * 推荐：Qwen2.5-7B / Llama-3.1-8B / Mistral-7B (本地或 API)
   */
  drafter?: SpecStageModel;

  /**
   * prompt 增强器（3B-7B 推荐）：将定稿 spec 转化为执行级 prompt。
   * 输入：定稿 SpecDocument
   * 输出：增强后的 prompt 文本
   */
  enhancer?: SpecStageModel;
}

export interface SpecStageModel {
  /** 该阶段的模型 profile（provider/model/protocol/baseUrl 等） */
  profile: ModelProfile;
  /** 该阶段的模型客户端（已配置好认证/传输） */
  client: ModelClient;
  /**
   * Fallback 策略：
   * - "primary"（默认）：该阶段失败时降级到主 modelClient
   * - "strict"：该阶段失败时中止整个 SpecEngine，原样执行输入
   * - "skip"：该阶段失败时跳过该阶段，用上一阶段输出继续
   */
  fallback: "primary" | "strict" | "skip";
}
```

### SpecEngine 构造参数（注入项）

`SpecEngine` 除 `SpecEngineOptions` 外，还通过构造函数接收以下注入项（来自
`CodingAgent.create()`，保持 agent-runtime 无 fs 直接依赖）：

```typescript
export interface SpecEngineDeps {
  /** 检测项目类型，apps/cli 注入（读 package.json 等）；返回如 "typescript-monorepo" */
  detectProjectType: (cwd: string) => string;
  /** 项目指令（AGENTS.md/CONTRIBUTING.md 内容），来自 AgentRuntimeOptions.instructions */
  instructions: string[];
  /** spec 持久化的写入回调，apps/cli 注入 node:fs/promises 的 writeFile */
  writeFile: (path: string, content: string) => Promise<void>;
  /** spec 持久化的读取回调（用于 load/list），apps/cli 注入 node:fs/promises */
  readFile: (path: string) => Promise<string>;
  /** spec 持久化的列目录回调，apps/cli 注入 node:fs/promises */
  listDir: (dir: string) => Promise<string[]>;
}
```

> **注**：`SpecEngineDeps` 使 SpecEngine 可测试——测试中注入 mock 回调即可，
> 无需真实文件系统。

### Pipeline 执行流程

```
用户输入
   │
   ├─ /raw? ──────────────────────────────────────→ 跳过，原样执行
   ├─ /spec? ────────────────────────────────────→ 强制进入 pipeline
   │
   ▼
[1] classifier (1B-2B)
   │  needsClarification: false? ─────────────────→ 跳过，原样执行
   │  needsClarification: true?
   ▼
[2] 主模型探索代码库 (只读工具: read/grep/glob)
   │  收集现有模式、约束、相关文件
   ▼
[3] drafter (3B-7B)
   │  生成 spec 草稿 (JSON: 目标/约束/验收/任务拆解)
   ▼
[4] decisionDetector (1B-2B)
   │  识别关键决策点
   │  有关键决策点? ─────────────────────────────→ eventSink 发出 spec_confirmation
   │                                                  等待用户确认/修改
   ▼
[5] enhancer (3B-7B)
   │  将定稿 spec 转化为执行级 prompt
   ▼
持久化 spec 到 docs/specs/<date>-<topic>.md
返回: { enhancedPrompt, initialTodos, specId }
   │
   ▼
submit() 继续正常工具循环
```

### 本地小模型集成

FocusCode 的 `ModelProfile.protocol` 支持 `"openai-chat"`，可直连 Ollama（兼容
OpenAI API）：

```typescript
// 配置示例（在 apps/cli 或 config.ts 中）
const classifierModel: SpecStageModel = {
  profile: {
    provider: "ollama",
    model: "qwen2.5:1.5b",
    protocol: "openai-chat",
    baseUrl: "http://localhost:11434/v1",
    authType: "none",
    contextWindow: 32768,
    maxOutputTokens: 256, // 分类任务只需短输出
    temperature: 0.1, // 分类任务低温度
    toolMode: "auto",
    reasoningEffort: "minimal",
    capabilities: { input: ["text"], reasoning: false, toolCalling: false },
    compatibility: {},
    reliability: {
      timeoutMs: 5000,
      maxRetries: 2,
      retryBaseDelayMs: 500,
      retryMaximumDelayMs: 5000,
    },
  },
  client: createModelClient(/* from existing factory */),
  fallback: "primary", // 本地模型不可用时降级到主模型
};
```

### 成本/延迟优化

1. **分类任务极低延迟**：1B 模型本地推理 <100ms，判断"是否需要补全"几乎无感知
2. **草稿生成中等延迟**：3B-7B 模型 1-3s，但只在需要补全时触发
3. **主模型只做重活**：代码库探索（需要工具调用）+ 最终执行
4. **缓存层（P2 扩展）**：相似意图的分类结果可缓存（如"修typo"这类高频简单意图），
   避免重复调用 classifier

### 进一步扩展点

1. **模型路由器（P1）**：根据输入复杂度动态选择模型大小——简单输入用 1B 分类即可
   跳过，复杂输入触发完整 pipeline
2. **本地模型健康检查（P1）**：SpecEngine 启动时 ping 本地 Ollama，不可用时自动
   降级到 API 小模型或主模型
3. **spec 模板学习（P2）**：从历史 spec 中学习项目特定的模式（如"这个项目总是
   需要考虑 boundary 检查"）
4. **多语言意图识别（P2）**：classifier 支持中英文混合输入的意图识别
5. **批量分类（P2）**：多个候选补全方向时，classifier 一次性评估多个选项

### 与方案 C 的关系

无冲突，是 §1 的增强：

- §1 的架构边界、submit() 集成点、文件结构全部保留
- `classifierModel?: Partial<ModelProfile>` 升级为 `pipeline: SpecPipeline`
- 新增 `spec-classifier.ts` 内部分离为 `classifier`/`detector`/`drafter`/
  `enhancer` 四个纯函数模块
- `SpecEngine.clarify()` 编排 pipeline 各阶段，处理 fallback

### 更新后的文件结构

```
packages/agent-runtime/src/
  spec-engine.ts          # SpecEngine 主类：编排 pipeline，管理状态
  spec-pipeline.ts        # Pipeline 阶段定义与执行编排
  spec-classifier.ts      # 阶段1+4：意图分类 + 关键决策点检测（1B-2B）
  spec-drafter.ts         # 阶段3：spec 草稿生成（3B-7B）
  spec-enhancer.ts        # 阶段5：prompt 增强（3B-7B）
  spec-explorer.ts        # 阶段2：代码库探索（主模型，只读工具）
  spec-store.ts           # spec 持久化
  spec-types.ts           # SpecDocument / SpecEvent / SpecResult / SpecStageModel
```

## §2 核心数据结构

### SpecDocument（持久化产物）

```typescript
// spec-types.ts

/**
 * 完整的需求补全产物。一份 spec 对应一次 submit() 的需求理解，
 * 贯穿"理解→确认→执行→完成"全生命周期。持久化到
 * docs/specs/<date>-<topic>.md。
 */
export interface SpecDocument {
  /** 唯一 ID，格式 `spec_<timestamp>_<random6>`，如 `spec_1784767951_a3f2c1` */
  id: string;
  /** 创建时间 ISO 8601 */
  createdAt: string;
  /** 最后更新时间 */
  updatedAt: string;
  /** 主题摘要（5-15 词），用于文件名和列表展示 */
  topic: string;
  /** 触发方式：auto=智能触发, explicit=/spec 命令触发 */
  trigger: "auto" | "explicit";

  /** 用户原始输入（未修改） */
  originalInput: string;

  /** 需求理解结果 */
  understanding: SpecUnderstanding;

  /** 任务拆解（DAG 结构，复用 graph.ts 的节点设计） */
  taskBreakdown: SpecTaskNode[];

  /** 关键决策点（需用户确认的） */
  keyDecisions: SpecKeyDecision[];

  /** 增强后的执行级 prompt */
  enhancedPrompt: string;

  /** 从 taskBreakdown 提取的初始 todo 列表 */
  initialTodos: SpecInitialTodo[];

  /** 生命周期状态 */
  status: SpecStatus;

  /** pipeline 各阶段的执行元数据（调试/审计用） */
  pipelineTrace: SpecPipelineTrace;
}

export interface SpecUnderstanding {
  /** 用户想要达成的目标（1-2 句话） */
  goal: string;
  /** 显式约束（用户提到的）+ 隐式约束（从代码库推断的） */
  constraints: SpecConstraint[];
  /** 验收标准：怎样算完成 */
  acceptanceCriteria: SpecAcceptanceCriterion[];
  /** 受影响的代码区域（文件/模块/层） */
  affectedAreas: SpecAffectedArea[];
  /** 识别到的歧义点（已自动补全或需用户确认） */
  ambiguities: SpecAmbiguity[];
}

export interface SpecConstraint {
  /** 约束来源：user=用户显式提出, codebase=从代码库推断, convention=项目约定 */
  source: "user" | "codebase" | "convention";
  /** 约束内容 */
  description: string;
  /** 是否硬性约束（hard 不可违反, soft 可协商） */
  severity: "hard" | "soft";
}

export interface SpecAcceptanceCriterion {
  /** 验收条件描述 */
  description: string;
  /** 验证方式：test=跑测试, lint=过 lint, build=能构建, manual=人工验证 */
  verification: "test" | "lint" | "build" | "manual";
  /** 关联的命令或文件（如 "pnpm test packages/agent-runtime"） */
  verificationTarget?: string;
}

export interface SpecAffectedArea {
  /** 文件或目录路径（相对于 cwd） */
  path: string;
  /** 影响类型：modify=修改, create=新建, delete=删除, review=需审查 */
  impact: "modify" | "create" | "delete" | "review";
  /** 简述影响原因 */
  reason: string;
}

export interface SpecAmbiguity {
  /** 歧义点描述 */
  description: string;
  /** 补全方式：auto=小模型自主补全, user=用户确认 */
  resolvedBy: "auto" | "user";
  /** 补全结果（auto 时是小模型的判断，user 时是用户的选择） */
  resolution: string;
}

export interface SpecTaskNode {
  /** 节点 ID，如 "t1", "t2" */
  id: string;
  /** 任务描述 */
  description: string;
  /** 依赖的任务节点 ID 列表（空数组=无依赖，可并行） */
  dependsOn: string[];
  /** 预估涉及的文件 */
  files: string[];
  /** 任务类型：design=设计, implement=实现, test=测试, refactor=重构, doc=文档 */
  kind: "design" | "implement" | "test" | "refactor" | "doc";
}

export interface SpecKeyDecision {
  /** 决策点 ID */
  id: string;
  /** 决策描述 */
  point: string;
  /** 可选项 */
  options: { label: string; description: string; tradeoffs: string }[];
  /** 用户选择的结果（undefined=未确认） */
  chosen?: string;
  /** 选择理由 */
  rationale?: string;
  /** 严重程度：决定是否必须暂停等用户 */
  severity: "critical" | "major" | "minor";
}

export interface SpecInitialTodo {
  /** 对应 SpecTaskNode.id */
  taskId: string;
  /** todo 文本 */
  content: string;
  /** 优先级 */
  priority: "high" | "medium" | "low";
}

export type SpecStatus =
  | "draft" // 草稿生成中
  | "confirming" // 等待用户确认关键决策点
  | "confirmed" // 已确认，准备执行
  | "executing" // 已进入 submit() 工具循环
  | "completed" // 执行完成
  | "superseded" // 被新 spec 替代
  | "aborted"; // 用户中止

export interface SpecPipelineTrace {
  /** 各阶段执行记录 */
  stages: SpecStageTrace[];
  /** 总耗时 ms */
  totalMs: number;
  /** 是否有阶段降级（小模型失败→主模型） */
  hadFallback: boolean;
}

export interface SpecStageTrace {
  /** 阶段名（"persist" 仅用于 trace 记录持久化降级，不对应 pipeline 阶段） */
  name: "classify" | "explore" | "draft" | "detect-decisions" | "enhance" | "persist";
  /** 使用的模型（provider/model） */
  model: string;
  /** 耗时 ms */
  durationMs: number;
  /** 是否降级 */
  fellBack: boolean;
  /** 降级原因（如有） */
  fallbackReason?: string;
  /** 输入 token 数（近似） */
  inputTokens?: number;
  /** 输出 token 数 */
  outputTokens?: number;
}
```

### SpecEvent（eventSink 通信）

```typescript
// 新增到 types.ts 的 AgentEvent 联合类型
export type AgentEvent =
  | { type: "agent_start"; sessionId: string; turn: number }
  // ... 原有事件 ...
  // === 新增 SpecEngine 事件 ===
  | { type: "spec_start"; input: string; trigger: "auto" | "explicit" }
  | { type: "spec_stage"; stage: string; model: string; durationMs: number; fellBack: boolean }
  | { type: "spec_draft_ready"; specId: string; topic: string; understanding: unknown }
  | {
      type: "spec_confirmation_required";
      specId: string;
      decisions: SpecKeyDecision[];
    }
  | { type: "spec_confirmed"; specId: string; decisions: SpecKeyDecision[] }
  | { type: "spec_skipped"; reason: string }
  | { type: "spec_completed"; specId: string; enhancedPrompt: string };
```

### SpecResult（clarify() 返回值）

```typescript
export type SpecClarifyResult =
  | { action: "skip"; reason: string } // 无需补全或 /raw
  | { action: "abort"; reason: string } // 用户中止
  | {
      action: "apply"; // 补全完成，应用结果
      specId: string;
      enhancedPrompt: string;
      initialTodos: SpecInitialTodo[];
      specPath: string; // 持久化路径
    };
```

### SpecClarifyInput（clarify() 入参）

```typescript
/** SpecEngine.clarify() 的输入，由 submit() 构造并传入。 */
export interface SpecClarifyInput {
  /** 用户原始 prompt（已 trim，未剥离 /spec /raw 命令前缀） */
  prompt: string;
  /** 附件（图片等），可选 */
  attachments?: AgentAttachment[];
  /** 当前工作目录 */
  cwd: string;
  /** 当前 session 的活动分支消息（供 spec 引用历史上下文，未来扩展用） */
  sessionBranch: AgentMessage[];
  /** 主模型客户端（explorer 阶段及 fallback 使用） */
  modelClient: ModelClient;
  /** 主模型 profile */
  model: ModelProfile;
  /** 工具注册表（explorer 阶段从中取只读工具） */
  toolRegistry: AgentToolRegistry;
  /** 事件回调（发射 spec_* 事件） */
  eventSink?: (event: AgentEvent) => void | Promise<void>;
  /** 外部 abort 信号（来自 submit() 的 externalSignal） */
  externalSignal?: AbortSignal;
}
```

### SpecDraft（阶段 3 产出，阶段 4/5 输入）

```typescript
/**
 * Drafter 阶段产出的 spec 草稿。比 SpecDocument 少了 enhancedPrompt /
 * initialTodos / status / pipelineTrace（这些在后续阶段或组装时填充）。
 * Drafter 只负责 understanding + taskBreakdown + keyDecisions(初值)。
 */
export interface SpecDraft {
  /** 临时 ID（drafter 生成，后续 assembleDocument 可能改写为正式 ID） */
  id: string;
  topic: string;
  understanding: SpecUnderstanding;
  taskBreakdown: SpecTaskNode[];
  /** Detector 阶段填充，初值为空数组 */
  keyDecisions: SpecKeyDecision[];
}
```

### ExplorerResult（阶段 2 产出）

```typescript
/** Explorer 阶段从代码库收集的上下文，供 Drafter 使用。 */
export interface ExplorerResult {
  /** 入口文件及角色，如 ["packages/agent-runtime/src/agent.ts:main-entry"] */
  entryPoints: string[];
  /** 现有模式，如 ["tool-registry-pattern:AgentToolRegistry registers tools"] */
  patterns: string[];
  /** 测试约定描述（位置/命名/框架） */
  testConventions: string;
  /** 架构约束（boundary rules / dependency limits） */
  constraints: string[];
  /** 探索过程中识别的相关文件路径 */
  relevantFiles: string[];
}

/** 空的 ExplorerResult，explorer 失败时使用 */
function emptyExplorerResult(): ExplorerResult {
  return { entryPoints: [], patterns: [], testConventions: "", constraints: [], relevantFiles: [] };
}
```

### SpecStore（持久化）

```typescript
// spec-store.ts

export interface SpecStore {
  /**
   * 持久化 spec 文档。写入 docs/specs/<date>-<topic>.md，
   * frontmatter 存元数据，正文存 SpecDocument 的可读形式。
   */
  save(doc: SpecDocument): Promise<string>; // 返回文件路径
  /** 按 ID 加载 */
  load(specId: string): Promise<SpecDocument | undefined>;
  /** 列出最近 N 个 spec */
  list(limit?: number): Promise<SpecSummary[]>;
  /** 更新状态（如 confirmed→executing） */
  updateStatus(specId: string, status: SpecStatus): Promise<void>;
}

export interface SpecSummary {
  id: string;
  topic: string;
  createdAt: string;
  status: SpecStatus;
  trigger: "auto" | "explicit";
}
```

**持久化文件格式**（`docs/specs/2026-07-23-add-spec-engine.md`）：

```markdown
---
id: spec_1784767951_a3f2c1
createdAt: 2026-07-23T10:25:51Z
updatedAt: 2026-07-23T10:26:03Z
topic: add-spec-engine
trigger: explicit
status: confirmed
---

# Spec: Add Spec Engine

## Goal

为 FocusCode 添加需求补全引擎，在 submit() 前结构化用户输入...

## Constraints

- [hard|codebase] agent-runtime 不得依赖外部包
- [hard|convention] TypeScript strict mode
- [soft|user] 优先使用本地小模型

## Acceptance Criteria

- [test] `pnpm test packages/agent-runtime/test/spec-engine.test.ts` 全绿
- [lint] `pnpm lint` 通过
- [build] `pnpm build` 无错误

## Affected Areas

- [modify] packages/agent-runtime/src/agent.ts — submit() 集成点
- [create] packages/agent-runtime/src/spec-engine.ts — 主模块
  ...

## Task Breakdown

1. [design] t1: 设计 SpecDocument 数据结构
2. [implement] t2: 实现 spec-types.ts (dependsOn: t1)
3. [implement] t3: 实现 spec-classifier.ts (dependsOn: t1)
   ...

## Key Decisions

- [critical] d1: 小模型通过 Ollama 还是 API？
  - Option A: Ollama 本地（低延迟，需用户安装）
  - Option B: API（无依赖，有成本）
  - Chosen: A
```

## §3 Pipeline 各阶段 Prompt 设计

每个阶段的 prompt 遵循三个原则：**输出必须是 JSON（便于程序解析）**、**指令极简
（适配小模型能力）**、**包含 few-shot 示例（提升小模型准确率）**。

### 阶段 1：Classifier（1B-2B 模型）

**目标**：判断用户输入是否需要需求补全。

**输入**：用户原始 prompt（截断到 500 字符）+ 项目类型摘要（1 行）

> **项目类型摘要获取方式**：SpecEngine 初始化时通过注入的 `detectProjectType(cwd)` 回调
> 获取（apps/cli 注入实现，读 `package.json` 的 `workspaces` 字段 + 根目录是否存在
> `pnpm-workspace.yaml`/`turbo.json`/`lerna.json` 判断）。返回值如
> `"typescript-monorepo"` / `"python-package"` / `"go-module"` / `"unknown"`。
> agent-runtime 内不直接读 fs。

**System Prompt**：

```
You are an intent classifier for a coding agent. Decide whether the user's
request is clear enough to execute directly, or needs clarification first.

Respond ONLY with a JSON object, no other text.

Classification rules:
- "execute": The request is specific enough to act on. Examples: fixing a
  named bug, running a known command, editing a specified file, answering a
  factual question.
- "clarify": The request is vague, ambiguous, or describes a goal without
  enough detail. Examples: "improve performance", "add tests", "refactor
  this", "make it better", multi-system features without scope.

Confidence scale:
- 0.9+: Very clear, almost certainly execute
- 0.7-0.9: Likely execute
- 0.5-0.7: Uncertain, lean clarify
- below 0.5: Likely clarify

Example inputs and outputs:

Input: "Fix the typo in README.md line 42"
{"needsClarification": false, "confidence": 0.95, "reason": "specific file and line"}

Input: "Add unit tests for the auth module"
{"needsClarification": true, "confidence": 0.7, "reason": "scope unclear: which functions, what coverage target"}

Input: "Why is my build failing?"
{"needsClarification": false, "confidence": 0.85, "reason": "investigation request, agent can explore"}

Input: "Make the agent runtime more robust"
{"needsClarification": true, "confidence": 0.95, "reason": "vague goal, no measurable criteria"}

Input: "Refactor spec-engine.ts to use async generators"
{"needsClarification": false, "confidence": 0.8, "reason": "specific file and technique"}

Now classify this input:
```

**User Message**：

```
Project type: typescript-monorepo
Input: {user_prompt_truncated}
```

**预期输出**：

```json
{ "needsClarification": true, "confidence": 0.7, "reason": "scope unclear" }
```

**容错处理**：

- 输出非 JSON → 重试一次（temperature 降到 0）
- 二次失败 → 按 `fallback` 策略处理（默认降级到主模型，再失败则 `action: "skip"`）
- `confidence < 0.6` 且 `needsClarification: false` → 强制进入 clarify（宁可多问）

### 阶段 2：Explorer（主模型，只读工具）

**目标**：探索代码库，收集与用户输入相关的上下文。

**不使用独立 prompt**，而是复用主模型在一个受限工具循环中执行。这是唯一需要工具调用
的阶段。

**实现方式**：创建临时 `AgentToolRegistry`，只注册只读工具：

```typescript
// spec-explorer.ts
const readOnlyTools = [
  registry.get("read")!, // 读文件
  registry.get("grep")!, // 搜索内容
  registry.get("glob")!, // 搜索文件名
  registry.get("ls")!, // 列目录
].filter(Boolean);
```

**Explorer System Prompt**：

```
You are exploring a codebase to gather context for a requirement. You have
read-only tools: read, grep, glob, ls. Do NOT modify any files.

Goal: Understand the current code structure, patterns, and constraints
relevant to this request. Focus on:
1. Entry points and main modules related to the request
2. Existing patterns the new work should follow
3. Test conventions (where tests live, naming, framework)
4. Architectural constraints (boundary rules, dependency limits)

Explore efficiently: 3-6 tool calls maximum. Prioritize breadth over depth.

After exploration, summarize findings as a JSON object:
{
  "entryPoints": ["path:role", ...],
  "patterns": ["pattern:description", ...],
  "testConventions": "description",
  "constraints": ["constraint", ...],
  "relevantFiles": ["path", ...]
}

Request: {user_prompt}
```

**限制**：

- `maxRounds: 6`（来自 `SpecEngineOptions.maxExplorationRounds`）
- 无 steering（explorer 不接受用户中断）
- 无 todo/goal/graph/team/delegate 工具（纯探索）
- 结果取最后一轮的 `content`，解析为 JSON

### 阶段 3：Drafter（3B-7B 模型）

**目标**：基于用户输入 + 探索结果，生成结构化 spec 草稿。

**System Prompt**：

```
You are a requirements drafter for a coding agent. Given a user request and
codebase context, produce a structured specification.

Respond ONLY with a JSON object matching this schema:
{
  "topic": "5-15 word slug describing the feature",
  "understanding": {
    "goal": "1-2 sentence statement of what the user wants",
    "constraints": [
      {"source": "user|codebase|convention", "description": "...", "severity": "hard|soft"}
    ],
    "acceptanceCriteria": [
      {"description": "...", "verification": "test|lint|build|manual", "verificationTarget": "command or file"}
    ],
    "affectedAreas": [
      {"path": "relative/path", "impact": "modify|create|delete|review", "reason": "..."}
    ],
    "ambiguities": [
      {"description": "what is unclear", "resolvedBy": "auto|user", "resolution": "best guess or empty"}
    ]
  },
  "taskBreakdown": [
    {"id": "t1", "description": "...", "dependsOn": [], "files": ["path"], "kind": "design|implement|test|refactor|doc"}
  ]
}

Rules:
- Constraints from codebase context must have source "codebase"
- Project conventions (from AGENTS.md, CONTRIBUTING.md) have source "convention"
- Mark ambiguities you can reasonably infer as resolvedBy "auto" with your best guess
- Mark ambiguities requiring user input as resolvedBy "user" with empty resolution
- Task breakdown should be 3-8 tasks, ordered by dependency
- Keep descriptions concise (1 sentence each)

Example output (abbreviated):
{"topic":"add-spec-engine","understanding":{"goal":"Add a requirement clarification engine...","constraints":[{"source":"codebase","description":"agent-runtime cannot depend on external packages","severity":"hard"}],...},"taskBreakdown":[{"id":"t1","description":"Design SpecDocument types","dependsOn":[],"files":["packages/agent-runtime/src/spec-types.ts"],"kind":"design"},...]}

Now draft a spec for:
```

**User Message**：

```
User request: {original_prompt}

Codebase context:
{explorer_result_json}

Project conventions (from AGENTS.md):
{instructions_summary}
```

> **instructionsSummary 获取方式**：SpecEngine 初始化时接收 `instructions: string[]`
> （来自 `AgentRuntimeOptions.instructions`，apps/cli 在启动时已从 AGENTS.md /
> CONTRIBUTING.md 读取并注入）。SpecEngine 将其截断到 2000 字符作为
> `instructionsSummary` 传入 Drafter。若 instructions 为空，传入空字符串。

**容错**：JSON 解析失败 → 重试一次（追加 "Output must be valid JSON, no markdown
fences"）；二次失败 → `fallback: "primary"` 用主模型重试。

### 阶段 4：Decision Detector（1B-2B 模型）

**目标**：从 spec 草稿中识别需要用户确认的关键决策点。

**System Prompt**：

```
You are a decision detector. Given a specification draft, identify decisions
that should be confirmed by the user before execution begins.

Respond ONLY with a JSON array of decisions.

Detection rules (check each):
1. "destructive-change": Any task that deletes files, drops database tables,
   or removes existing functionality.
2. "arch-decision": Choice between fundamentally different approaches
   (e.g., new module vs. extend existing, REST vs. GraphQL).
3. "new-dependency": Introduction of a new npm/package dependency.
4. "breaking-change": Changes to public API, exported interfaces, or config
   schema that consumers depend on.
5. "security-sensitive": Changes to auth, permissions, crypto, or sandbox.
6. "irreversible": Operations that cannot be undone (migrations, publishes).

For each detected decision, output:
{
  "id": "d1",
  "point": "what needs to be decided",
  "options": [
    {"label": "A", "description": "...", "tradeoffs": "..."},
    {"label": "B", "description": "...", "tradeoffs": "..."}
  ],
  "severity": "critical|major|minor"
}

severity guide:
- critical: destructive, irreversible, security-sensitive
- major: arch-decision, breaking-change, new-dependency
- minor: style choices, naming, minor scope

If no decisions need confirmation, output: []

Example:
[{"id":"d1","point":"Use Ollama local model or API for small models?","options":[{"label":"Ollama","description":"Local inference","tradeoffs":"Low latency, requires install"},{"label":"API","description":"Remote inference","tradeoffs":"No setup, has cost"}],"severity":"major"}]

Now analyze this spec:
```

**User Message**：

```
{spec_draft_json}
```

**过滤规则**：

- `severity: "minor"` 的决策点不暂停，自动选第一个 option
- 只有 `critical` 或 `major` 才触发 `spec_confirmation_required` 事件
- 若所有决策点都是 minor → 跳过用户确认，直接进入 enhance

### 阶段 5：Enhancer（3B-7B 模型）

**目标**：将定稿 spec 转化为执行级 prompt，替换原始用户输入进入 submit() 工具循环。

**System Prompt**：

```
You are a prompt enhancer. Transform a confirmed specification into an
executable prompt for a coding agent.

The enhanced prompt must:
1. Start with a clear objective statement
2. List concrete constraints (not goals)
3. Specify acceptance criteria as checkable conditions
4. Reference affected files with their paths
5. Suggest execution order based on task dependencies
6. Be self-contained (the agent should not need to re-clarify)

Do NOT include:
- The specification JSON itself
- Meta-commentary about the clarification process
- Instructions to ask the user questions (decisions are already confirmed)

Format:
## Objective
<1-2 sentences>

## Constraints
- <constraint 1>
- <constraint 2>

## Acceptance Criteria
- [ ] <criterion 1>
- [ ] <criterion 2>

## Files
- <path>: <what to do>

## Execution Order
1. <task 1>
2. <task 2> (after 1)

Begin working on the tasks above. Verify each acceptance criterion before
claiming completion.

Example (abbreviated):
## Objective
Add a SpecEngine module to agent-runtime that clarifies vague user inputs
before execution.

## Constraints
- agent-runtime must not depend on external packages
- TypeScript strict mode
...
```

**User Message**：

```
Confirmed specification:
{spec_document_json}

User's confirmed decisions:
{decisions_with_chosen_options}
```

**输出**：纯文本（非 JSON），直接作为 `enhancedPrompt` 返回。

### Prompt 设计的共性原则

1. **JSON 优先**：阶段 1/3/4 输出 JSON，便于解析；阶段 5 输出文本，直接用
2. **Few-shot 示例**：每个 prompt 包含 2-5 个示例，显著提升小模型准确率
3. **角色明确**：每个 prompt 开头定义角色（"You are a classifier/drafter/detector/
   enhancer"）
4. **约束输出**：明确禁止多余文本（"Respond ONLY with..."）
5. **容错重试**：解析失败时追加修正指令重试一次，二次失败走 fallback
6. **上下文精简**：小模型 prompt 总长度控制在 2000 token 以内（输入+输出），避免
   超出小模型 contextWindow

### 阶段间数据流

```
用户输入
  │
  ▼
[1 Classifier] ← 用户输入(500字) + 项目类型(1行)
  │ needsClarification: true
  ▼
[2 Explorer] ← 用户输入(全文) + 只读工具
  │ explorerResult: {entryPoints, patterns, testConventions, constraints, relevantFiles}
  ▼
[3 Drafter] ← 用户输入 + explorerResult + instructions摘要
  │ specDraft: {topic, understanding, taskBreakdown}
  ▼
[4 Detector] ← specDraft + keyDecisionRules
  │ keyDecisions: [{point, options, severity}]
  │ (critical/major? → 暂停等用户)
  ▼
[5 Enhancer] ← 定稿spec(含用户决策)
  │ enhancedPrompt: 文本
  ▼
返回 submit()
```

## §4 错误处理与 Fallback 策略

### 错误分类与处理矩阵

| 错误类型                      | 发生阶段                    | 处理策略                                       | 用户感知                                    |
| ----------------------------- | --------------------------- | ---------------------------------------------- | ------------------------------------------- |
| 小模型不可达（Ollama 未启动） | 任何小模型阶段              | 按 `fallback: "primary"` 降级到主模型          | eventSink 发出 `spec_stage.fellBack: true`  |
| 小模型超时（>5s）             | classifier/detector         | 降级到主模型                                   | 同上                                        |
| 小模型返回非 JSON             | classifier/drafter/detector | 重试一次（temperature=0），二次失败走 fallback | 同上                                        |
| 主模型也失败                  | 任何阶段                    | `action: "skip"`，原样执行用户输入             | `spec_skipped` 事件，原因 "pipeline failed" |
| Explorer 工具调用异常         | 阶段2                       | 跳过探索，用空 context 进入 drafter            | `spec_stage.fellBack: true`                 |
| 用户中止确认                  | 阶段4 确认中                | `action: "abort"`                              | `spec_skipped` 事件，原因 "user aborted"    |
| spec 写入失败                 | 持久化                      | 内存中保留 spec，记录警告，不阻断执行          | `spec_stage.fellBack: true`                 |
| spec 文件冲突（同名）         | 持久化                      | 文件名追加 `-2`/`-3` 后缀                      | 无                                          |

### Fallback 链详解

```
小模型阶段失败
  │
  ├─ fallback: "primary" (默认)
  │   └─ 降级到主 modelClient 重试该阶段
  │       ├─ 成功 → 继续 pipeline，记录 fellBack: true
  │       └─ 失败 → action: "skip"（原样执行）
  │
  ├─ fallback: "strict"
  │   └─ 立即中止 pipeline → action: "skip"
  │
  └─ fallback: "skip"
      └─ 跳过该阶段，用上一阶段输出继续
          ├─ classifier 失败 → 假设 needsClarification: false，原样执行
          ├─ drafter 失败 → 用原始 prompt + explorerResult 作为 enhancedPrompt
          ├─ detector 失败 → 无关键决策点，直接 enhance
          └─ enhancer 失败 → 用 spec JSON 的 goal + taskBreakdown 拼接为 prompt
```

### 关键不变量（fail-safe 原则）

1. **SpecEngine 永不阻断用户执行**：任何失败最终都收敛到 `action: "skip"`，用户输入
   原样进入工具循环。SpecEngine 是增强层，不是门控层。
2. **小模型失败不影响主模型可用性**：小模型调用与主模型完全隔离，小模型异常不会
   污染主模型状态。
3. **spec 持久化失败不阻断 pipeline**：写入失败时 spec 仅存内存，pipeline 继续推进。
4. **用户中止可随时发生**：确认阶段用户拒绝 → `abort`；任何阶段 externalSignal
   abort → `abort`。

### SpecEngine.clarify() 主流程伪代码

```typescript
async clarify(input: SpecClarifyInput): Promise<SpecClarifyResult> {
  const trace = new PipelineTrace();
  const controller = new AbortController();
  if (input.externalSignal) {
    if (input.externalSignal.aborted) return { action: "abort", reason: "external signal" };
    input.externalSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  // === 阶段 0: 触发判断 ===
  const trimmed = input.prompt.trim();
  if (trimmed.startsWith("/raw")) {
    return { action: "skip", reason: "user forced /raw" };
  }
  const forced = trimmed.startsWith("/spec");
  const prompt = forced ? trimmed.slice(5).trim() : trimmed;
  if (!prompt) return { action: "skip", reason: "empty prompt after command" };

  // === 阶段 1: Classifier ===
  let needsClarification = true;
  if (this.options.autoTrigger && !forced) {
    try {
      const result = await this.runStage("classify", async (client, profile) => {
        return classifyIntent(client, profile, prompt, this.projectType);
      }, trace, controller.signal);
      needsClarification = result.needsClarification;
      if (!needsClarification && result.confidence >= 0.6) {
        return { action: "skip", reason: `classifier: ${result.reason}` };
      }
    } catch (error) {
      // fallback: "skip" → 假设无需补全；fallback: "primary" → 已在 runStage 内重试
      if (this.options.pipeline.classifier?.fallback === "skip") {
        return { action: "skip", reason: "classifier failed, assuming execute" };
      }
      // fallback: "primary" 或 "strict" 已在 runStage 处理，这里只在 strict 失败后到达
      return { action: "skip", reason: "classifier stage failed" };
    }
  }

  await this.emit({ type: "spec_start", input: prompt, trigger: forced ? "explicit" : "auto" });

  // === 阶段 2: Explorer ===
  let explorerResult: ExplorerResult = emptyExplorerResult();
  try {
    explorerResult = await this.runStage("explore", async () => {
      return exploreCodebase({
        prompt, cwd: input.cwd,
        modelClient: input.modelClient, model: input.model,
        readOnlyTools: this.readOnlyTools(input.toolRegistry),
        maxRounds: this.options.maxExplorationRounds,
        signal: controller.signal,
      });
    }, trace, controller.signal);
  } catch {
    // explorer 失败不阻断，用空 context 继续
    trace.recordFallback("explore", "exploration failed, continuing with empty context");
  }

  // === 阶段 3: Drafter ===
  let draft: SpecDraft;
  try {
    draft = await this.runStage("draft", async (client, profile) => {
      return draftSpec(client, profile, {
        prompt, explorerResult,
        instructionsSummary: this.instructionsSummary,
      });
    }, trace, controller.signal);
  } catch {
    // drafter 失败 → 无法生成 spec，原样执行
    return { action: "skip", reason: "drafter failed" };
  }

  // === 阶段 4: Decision Detector ===
  let keyDecisions: SpecKeyDecision[] = [];
  try {
    keyDecisions = await this.runStage("detect-decisions", async (client, profile) => {
      return detectDecisions(client, profile, draft, this.options.keyDecisionRules);
    }, trace, controller.signal);
  } catch {
    // detector 失败 → 无关键决策点，直接 enhance
    trace.recordFallback("detect-decisions", "detector failed, assuming no key decisions");
  }

  // 过滤：只有 critical/major 才暂停
  const blockingDecisions = keyDecisions.filter(
    (d) => d.severity === "critical" || d.severity === "major",
  );
  let confirmedDecisions = keyDecisions.map((d) => ({
    ...d,
    chosen: d.severity === "minor" ? d.options[0]?.label : undefined,
  }));

  if (blockingDecisions.length > 0) {
    await this.emit({
      type: "spec_confirmation_required",
      specId: draft.id,
      decisions: blockingDecisions,
    });
    confirmedDecisions = await this.waitForConfirmation(
      draft.id, blockingDecisions, controller.signal,
    );
    if (confirmedDecisions === null) {
      return { action: "abort", reason: "user declined spec" };
    }
  }

  // === 阶段 5: Enhancer ===
  let enhancedPrompt: string;
  try {
    enhancedPrompt = await this.runStage("enhance", async (client, profile) => {
      return enhancePrompt(client, profile, { draft, confirmedDecisions });
    }, trace, controller.signal);
  } catch {
    // enhancer 失败 → 用 spec JSON 手动拼接
    enhancedPrompt = this.fallbackEnhance(draft, confirmedDecisions);
    trace.recordFallback("enhance", "enhancer failed, using manual fallback");
  }

  // === 持久化 ===
  const doc = this.assembleDocument(
    draft, confirmedDecisions, enhancedPrompt, trace, forced,
  );
  let specPath = "";
  try {
    specPath = await this.store.save(doc);
  } catch (error) {
    // 持久化失败不阻断
    trace.recordFallback(
      "persist",
      `save failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  await this.emit({ type: "spec_completed", specId: doc.id, enhancedPrompt });

  return {
    action: "apply",
    specId: doc.id,
    enhancedPrompt,
    initialTodos: doc.initialTodos,
    specPath,
  };
}
```

### waitForConfirmation 机制

```typescript
/**
 * 等待用户确认关键决策点。通过 Promise + 回调实现：
 * - eventSink 发出 spec_confirmation_required 事件
 * - CLI/TUI 层展示决策选项，收集用户选择
 * - 通过 resolveDecisions(specId, choices) 回调 resolve Promise
 *
 * 超时策略：默认无超时（等用户），但 externalSignal abort 时 reject。
 * 未来可扩展 SpecEngineOptions.confirmationTimeoutMs。
 */
private waitForConfirmation(
  specId: string,
  decisions: SpecKeyDecision[],
  signal: AbortSignal,
): Promise<SpecKeyDecision[] | null> {
  return new Promise((resolve) => {
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      this.confirmationResolvers.delete(specId);
    };
    const onAbort = () => {
      cleanup();
      resolve(null);
    };
    signal.addEventListener("abort", onAbort, { once: true });

    this.confirmationResolvers.set(specId, (choices: Record<string, string>) => {
      cleanup();
      const resolved = decisions.map((d) => ({
        ...d,
        chosen: choices[d.id] ?? d.options[0]?.label,
        rationale: choices[`${d.id}:rationale`],
      }));
      resolve(resolved);
    });
  });
}

/** 外部（CLI/TUI）调用：提交用户的决策选择 */
resolveDecisions(specId: string, choices: Record<string, string>): void {
  const resolver = this.confirmationResolvers.get(specId);
  if (resolver) resolver(choices);
}
```

### CLI 层集成（apps/cli）

```typescript
// agent-command.ts 中
const specEngineRef: { current: SpecEngine | undefined } = { current: undefined };

const agent = await CodingAgent.create({
  ...options,
  specEngine,
  // 通过 eventSink 监听 spec 事件（CodingAgent 不使用 EventEmitter）
  eventSink: async (event) => {
    if (event.type === "spec_confirmation_required") {
      // 展示决策点，收集用户选择
      const choices = await promptUserForDecisions(event.decisions);
      specEngineRef.current?.resolveDecisions(event.specId, choices);
    } else if (event.type === "spec_start") {
      console.error(`\n[spec] Analyzing request...`);
    } else if (event.type === "spec_stage") {
      const fallbackMark = event.fellBack ? " (fallback)" : "";
      console.error(
        `[spec] ${event.stage} via ${event.model}${fallbackMark} ${event.durationMs}ms`,
      );
    } else if (event.type === "spec_skipped") {
      console.error(`[spec] Skipped: ${event.reason}`);
    } else if (event.type === "spec_completed") {
      console.error(`[spec] Enhanced prompt ready (${event.specId})\n`);
    }
    // 其他原有事件转发给上层 handler（如有）
  },
});

// SpecEngine 实例由 CodingAgent.create 内部构造，通过 getter 暴露引用
specEngineRef.current = agent.specEngine;
```

## §5 测试策略

遵循 `AGENTS.md` 的测试要求：TDD、覆盖率阈值、高风险模块更高局部覆盖。

### 测试文件布局

```
packages/agent-runtime/test/
  spec-types.test.ts              # 类型与 schema 验证
  spec-classifier.test.ts         # 阶段1: 意图分类
  spec-explorer.test.ts           # 阶段2: 代码库探索
  spec-drafter.test.ts            # 阶段3: spec 草稿生成
  spec-decision-detector.test.ts  # 阶段4: 关键决策检测
  spec-enhancer.test.ts           # 阶段5: prompt 增强
  spec-store.test.ts              # 持久化
  spec-engine.test.ts             # 主流程编排 + fallback + 中止
  spec-engine-integration.test.ts # 与 CodingAgent.submit() 集成
```

### 测试分层

#### 单元测试（纯函数，快）

每个阶段是一个纯函数 `(client, profile, input) => Promise<output>`，用 mock
ModelClient 测试：

```typescript
// spec-classifier.test.ts
describe("classifyIntent", () => {
  it("returns needsClarification=false for specific bug fix", async () => {
    const client = mockClient(JSON.stringify({
      needsClarification: false, confidence: 0.95, reason: "specific file and line",
    }));
    const result = await classifyIntent(
      client, profile, "Fix typo in README.md line 42", "typescript-monorepo",
    );
    expect(result.needsClarification).toBe(false);
    expect(result.confidence).toBe(0.95);
  });

  it("returns needsClarification=true for vague goal", async () => { ... });

  it("retries once on non-JSON output", async () => {
    const client = mockClientSequence([
      "not json",
      '{"needsClarification":true,"confidence":0.7,"reason":"vague"}',
    ]);
    const result = await classifyIntent(client, profile, "make it better", "typescript");
    expect(result.needsClarification).toBe(true);
  });

  it("throws on second non-JSON output", async () => {
    const client = mockClientSequence(["not json", "still not json"]);
    await expect(
      classifyIntent(client, profile, "test", "typescript"),
    ).rejects.toThrow();
  });

  it("respects temperature override on retry", async () => { ... });
  it("truncates long input to 500 chars", async () => { ... });
});
```

#### Pipeline 编排测试（SpecEngine 主类）

```typescript
// spec-engine.test.ts
describe("SpecEngine.clarify", () => {
  it("returns skip when prompt starts with /raw", async () => { ... });
  it("returns skip when prompt starts with /spec but is empty after command", async () => { ... });
  it("forces pipeline when prompt starts with /spec", async () => { ... });

  it("skips when classifier returns needsClarification=false with high confidence", async () => { ... });
  it("proceeds when classifier returns needsClarification=false but low confidence (<0.6)", async () => { ... });

  it("falls back to primary model when classifier stage fails (fallback=primary)", async () => { ... });
  it("skips when classifier stage fails (fallback=skip)", async () => { ... });
  it("aborts when classifier stage fails (fallback=strict)", async () => { ... });

  it("continues with empty context when explorer fails", async () => { ... });
  it("skips when drafter fails", async () => { ... });
  it("continues without decisions when detector fails", async () => { ... });
  it("uses manual fallback when enhancer fails", async () => { ... });

  it("does not pause for minor severity decisions", async () => { ... });
  it("pauses for critical/major decisions and waits for confirmation", async () => { ... });
  it("aborts when user declines spec", async () => { ... });
  it("resolves with chosen options when user confirms", async () => { ... });

  it("aborts on external signal", async () => { ... });
  it("continues when spec persistence fails", async () => { ... });
  it("appends suffix on filename conflict", async () => { ... });

  it("records pipeline trace with all stages", async () => { ... });
  it("marks hadFallback=true when any stage fell back", async () => { ... });
});
```

#### 集成测试（与 CodingAgent）

```typescript
// spec-engine-integration.test.ts
describe("CodingAgent.submit with SpecEngine", () => {
  it("does not activate SpecEngine when specEngine option is undefined", async () => {
    // 验证原有行为不变
    const agent = await CodingAgent.create({ ...minimalOptions });
    const result = await agent.submit("fix typo");
    expect(result.stopped).toBe("stop");
    // 不应有 spec_* 事件
  });

  it("activates SpecEngine on /spec command", async () => {
    const events: AgentEvent[] = [];
    const agent = await CodingAgent.create({
      ...minimalOptions,
      specEngine: { enabled: true, autoTrigger: false, ... },
      eventSink: (e) => events.push(e),
    });
    await agent.submit("/spec add a new tool");
    expect(events.some((e) => e.type === "spec_start")).toBe(true);
  });

  it("skips SpecEngine on /raw command", async () => { ... });

  it("auto-triggers SpecEngine when autoTrigger=true and input is vague", async () => { ... });
  it("does not auto-trigger for specific input", async () => { ... });

  it("injects enhancedPrompt into tool loop", async () => { ... });
  it("seeds initialTodos into todoState", async () => { ... });
  it("emits spec_confirmation_required and waits", async () => { ... });

  it("preserves original behavior when SpecEngine fails completely", async () => {
    // SpecEngine 所有 fallback 都失败 → 原样执行
    const agent = await CodingAgent.create({
      ...minimalOptions,
      specEngine: { ...allStagesRiggedToFail },
    });
    const result = await agent.submit("fix typo in README.md");
    expect(result.stopped).toBe("stop");
    // 原始 prompt 被使用
  });
});
```

#### 确定性测试（无真实模型调用）

所有测试使用 mock ModelClient，遵循 agent-runtime 现有测试模式：

```typescript
function mockClient(response: string): ModelClient {
  return {
    protocol: "openai-chat",
    complete: async () => ({
      content: response,
      stopReason: "stop" as const,
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 20 },
    }),
  };
}

function mockClientSequence(responses: string[]): ModelClient {
  let i = 0;
  return {
    protocol: "openai-chat",
    complete: async () => ({
      content: responses[i++] ?? responses[responses.length - 1]!,
      stopReason: "stop" as const,
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 20 },
    }),
  };
}
```

### 覆盖率目标

SpecEngine 是高风险模块（修改 submit() 核心路径），局部覆盖率要求高于仓库底线：

| 模块               | 语句 | 分支 | 函数 | 行  |
| ------------------ | ---- | ---- | ---- | --- |
| 仓库底线           | 75%  | 60%  | 80%  | 80% |
| spec-engine.ts     | 90%  | 80%  | 90%  | 90% |
| spec-classifier.ts | 90%  | 85%  | 100% | 90% |
| spec-store.ts      | 85%  | 75%  | 85%  | 85% |
| 其他 spec-*.ts     | 85%  | 75%  | 85%  | 85% |

### 测试清单总结

| 类别        | 测试数  | 关注点                                               |
| ----------- | ------- | ---------------------------------------------------- |
| 类型/schema | ~8      | SpecDocument 结构验证、JSON 序列化、frontmatter 往返 |
| Classifier  | ~12     | 分类准确性、JSON 容错、重试、截断、fallback          |
| Explorer    | ~6      | 工具调用、maxRounds 限制、只读约束、空结果           |
| Drafter     | ~8      | JSON 生成、字段完整性、ambiguity 标注、重试          |
| Detector    | ~8      | 规则匹配、severity 分级、空结果、minor 过滤          |
| Enhancer    | ~6      | 文本格式、自包含性、fallback 拼接                    |
| Store       | ~8      | 写入、读取、列表、状态更新、文件名冲突、frontmatter  |
| Engine 编排 | ~20     | 触发判断、各阶段 fallback、中止、确认流程、trace     |
| 集成        | ~10     | submit() 集成、事件发射、todo 注入、原有行为保持     |
| **合计**    | **~86** |                                                      |

## 不在范围内

以下内容明确排除在本设计之外，留待未来迭代：

- **Spec 跨会话引用**：当前 spec 是一次性的，不支持后续会话引用历史 spec
- **Spec 模板复用**：不支持将一个项目的 spec 模板应用到另一个项目
- **Pipeline 阶段并行化**：5 个阶段严格串行，未来可探索 explorer 与 drafter 并行
- **用户自定义阶段**：pipeline 阶段是固定的 5 个，不支持用户注入自定义阶段
- **Spec 版本管理**：spec 修改不保留历史版本（只有 status 流转）
- **多用户协作**：spec 确认是单用户交互，不支持多人同时审阅
