# FocusCode CLI / TUI / SDK 深度审查报告

> 审查日期：2026-07-30
> 审查范围：`apps/cli`、`packages/tui`、`packages/sdk` 的设计与实现
> 对比对象：Claude Code、OpenCode
> 审查方法：TRAE-code-review skill + 架构边界检查 + 代码精读

---

## 摘要

FocusCode 在架构野心上明显超越 Claude Code 和 OpenCode：双路径（Session Agent + Audited Kernel）、审计 spine、模型可移植、沙箱隔离、steering、6 种 I/O 模式，这些都是同类工具没有的。但实现成熟度有落差：CLI 和 SDK 的组合逻辑分裂、多个 God Function、命令三处重复、类型碰撞。这些不是设计问题，而是收敛不足 — 架构已定义清晰边界（AGENTS.md + check-boundaries），但 CLI 层未充分复用 SDK 层。

**关键发现**：

| 编号 | 问题                                                       | 严重性 | 类型     |
| ---- | ---------------------------------------------------------- | ------ | -------- |
| P0   | CLI 未复用 SDK `createCodingAgent`，两套平行组合逻辑       | HIGH   | 架构分裂 |
| C1   | CLI 入口用 deny-list 路由，新增子命令易破坏 agent 调用     | HIGH   | 脆弱性   |
| C2   | `runAgentCommand` 350+ 行 God Function                     | HIGH   | 可维护性 |
| C4   | Slash 命令在 interactive/tui/rpc 三处分别实现              | MEDIUM | 重复     |
| C5   | SpecEngine 确认在 eventSink 包装层中拦截，时序耦合         | MEDIUM | 耦合     |
| T1   | 自研渲染器维护成本高（对比 Ink 生态）                      | MEDIUM | 技术债   |
| T2   | `runFullScreenAgent` 1228+ 行 God Function                 | HIGH   | 可维护性 |
| T3   | Foxy 鼓励师逻辑耦合在 CLI 桥接层                           | LOW    | 内聚     |
| S1   | CLI 与 SDK 组合逻辑分裂（P0 的具体表现）                   | HIGH   | 架构     |
| S2   | `ApprovalMode` 类型碰撞（Kernel vs Session）               | MEDIUM | 类型安全 |
| S3   | `runCodingAgent` sink 恢复时序边缘                         | LOW    | 资源泄漏 |
| S4   | `AgentHooks` 与 Claude SDK 命名对齐但 fail-open 语义有差异 | LOW    | 兼容性   |

---

## 一、架构总览

### 1.1 三层组合关系

```
┌─────────────────────────────────────────────────────────────┐
│ apps/cli (组合根)                                            │
│  ├── index.ts          子命令路由器                          │
│  ├── agent-command.ts  896 行 God function（C2）            │
│  ├── tui.ts            1228 行 TUI 桥接（T2）               │
│  ├── interactive.ts    readline REPL                        │
│  └── rpc.ts            JSON-RPC over stdio                  │
├─────────────────────────────────────────────────────────────┤
│ packages/sdk (SDK 组合层)                                    │
│  ├── coding-agent.ts   createCodingAgent() factory         │
│  ├── run-coding-agent  runCodingAgent() AsyncGenerator     │
│  ├── hooks.ts          AgentHooks lifecycle                 │
│  ├── effect-spine.ts   createSessionEffectSpine()          │
│  └── local-harness.ts  createLocalHarness() Kernel 路径    │
├─────────────────────────────────────────────────────────────┤
│ packages/tui (终端 UI)                                      │
│  ├── app.ts            FullScreenTui 状态机                 │
│  ├── renderer.ts       自研渲染（T1）                       │
│  ├── vim/palette/...   功能模块                            │
│  └── mascots/companion Foxy 鼓励师                          │
├─────────────────────────────────────────────────────────────┤
│ packages/agent-runtime                                      │
│  ├── CodingAgent       会话主循环                           │
│  ├── SessionStore      append-only tree                     │
│  └── ToolRegistry      工具注册                             │
└─────────────────────────────────────────────────────────────┘
```

**核心问题**：CLI 的 `runAgentCommand` 和 SDK 的 `createCodingAgent` 是两套平行的组合逻辑，而非 CLI 调用 SDK。这是当前架构最大的分裂点（P0/S1）。

### 1.2 双路径架构

FocusCode 保留两条明确的组合路径（见 `docs/ARCHITECTURE.md`）：

| 路径                        | 入口                                     | 优化目标                                 | 核心状态                                               |
| --------------------------- | ---------------------------------------- | ---------------------------------------- | ------------------------------------------------------ |
| Conversational Coding Agent | TUI/interactive/print/JSON/RPC/SDK       | 低延迟、多轮探索、即时 steering          | Session tree、Context、Tool loop、Permission           |
| Audited Focus Kernel        | `focuscode run` / `createLocalHarness()` | 可重放、Decision/Effect 分离、验证后完成 | TaskSpec、Checkpoint、Intent、Grant、Receipt、Verifier |

会话 Agent 在 `packages/agent-runtime`；审计 Kernel 在 `packages/harness-core`。两者通过受控工具、权限和明确完成条件工作，但当前不会把同一次调用同时写入两套状态机。

### 1.3 架构边界（`pnpm lint` 强制）

`scripts/check-boundaries.mjs` 按禁止 token 扫描源码，以下红线不得引入：

- `contracts`：不得依赖其他 `@focuscode/*` 包或 Provider SDK
- `harness-core`：不得出现 `node:fs`、`node:child_process`、`fetch(`，不得依赖 action-backends、model-gateway
- `model-gateway`：不得依赖 action-backends、action-domain；不授予权限、不判定任务成败
- `agent-runtime`：不得依赖 harness-core、model-gateway、persistence、sdk、auth、ecosystem、sandbox、tui 或任何 apps
- `auth`、`ecosystem`、`sandbox`、`tui`：叶子 adapter，不得依赖任何 `@focuscode/*`
- 只有 `apps/*` 和 `packages/sdk` 允许组合以上模块

---

## 二、CLI 审查（apps/cli）

### 2.1 设计意图

CLI 是 FocusCode 的唯一用户入口，承担三种角色：

1. **子命令路由器**（`init/run/inspect/export/auth/extension/share/sandbox/doctor/mascots/themes/skins/character/companion`）
2. **Coding Agent 主入口**（默认路径，无子命令前缀时触发）
3. **多模式适配器**（`tui/interactive/print/json/rpc/acp` 六种输出模式）

### 2.2 实现问题

#### P0/S1：CLI 未复用 SDK `createCodingAgent`（HIGH，架构分裂）

**问题描述**：`apps/cli/src/agent-command.ts` 的 `runAgentCommand` 和 `packages/sdk/src/coding-agent.ts` 的 `createCodingAgent` 做几乎相同的事，但 CLI 没有调用 SDK。

**对比两套组合逻辑**：

| 步骤           | `createCodingAgent` (SDK)                        | `runAgentCommand` (CLI)                                          |
| -------------- | ------------------------------------------------ | ---------------------------------------------------------------- |
| Config 解析    | `resolveAgentConfig(cwd, options)`               | `resolveAgentConfig(cwd, configOverrides(...))`                  |
| Sandbox 创建   | `createSandbox({...})`                           | `createSandbox({...})` — 相同                                    |
| Tool registry  | `createCodingToolRegistry(cwd, {shellExecutor})` | `createCodingToolRegistry(cwd, {shellExecutor, searchEndpoint})` |
| Extension 加载 | `extensions.load([...])`                         | `extensions.load([...])` — 几乎相同                              |
| Session 预创建 | `sessions.create({cwd, model})`                  | `sessions.create({cwd, model, name})` — 相同                     |
| Spine 创建     | `createSessionEffectSpine({...})`                | `createSessionEffectSpine({...})` — 几乎相同                     |
| Agent 创建     | `CodingAgent.create({...})`                      | `CodingAgent.create({...})` — 几乎相同                           |

**CLI 多出的**：MCP wiring、fallback model chain、spec engine、audit journal、enterprise 校验、6 种输出模式适配。

**后果**：

- 任何 spine/extension/session 逻辑变更需同步两处
- SDK 的 `forkSession` 选项和 CLI 的 `--fork` 参数走不同代码路径
- SDK 的 `hooks` 选项在 CLI 中不可用（CLI 用自己的 eventSink 包装）
- 行为漂移风险（两处实现可能随时间不一致）

**修复方向**：`createCodingAgent` 扩展为支持 CLI 所需的 MCP/fallback/spec/audit/mode 选项，CLI 调用它作为唯一组合点。

#### C1：双入口路由脆弱（HIGH）

**文件**：`apps/cli/src/index.ts:135-139`

**问题**：用排除列表（deny-list）判断是否为 agent 调用：

```typescript
export function isAgentInvocation(argv: string[]): boolean {
  const first = argv[0];
  return !first || ![...14 个子命令...].includes(first);
}
```

每新增一个子命令必须同步更新排除列表，否则该子命令会被误判为 agent prompt。这是负向列表，违反"新增不破坏现有"原则。

**修复方向**：改为正向匹配 — agent 调用使用显式前缀（如 `focuscode agent` 或 `focuscode --`），或用 `--` 分隔符。

#### C2：`runAgentCommand` 是 God Function（HIGH）

**文件**：`apps/cli/src/agent-command.ts:55-400+`

**问题**：单函数 350+ 行，承担：arg 解析 → config 解析 → sandbox 创建 → tool registry → extension 加载 → MCP wiring → session 选择 → model client chain → event sink 组合 → approval handler → spine 创建 → spec engine → agent 创建 → 模式分发。

**影响**：

- 维护成本高
- 难以单独测试各阶段
- 与 SDK 的 `createCodingAgent` 重复（P0）

**修复方向**：CLI 应调用 `createCodingAgent` 作为唯一组合点，仅保留 CLI 特有的 arg 解析、output mode 适配、TUI/interactive/rpc 桥接逻辑。解决 P0 后 C2 自动大幅简化。

#### C4：Slash 命令在三个地方分别实现（MEDIUM）

**文件**：

- `apps/cli/src/interactive.ts:91-185`（interactive 模式）
- `apps/cli/src/tui.ts:175-400+`（tui 模式）
- `apps/cli/src/rpc.ts:71-130`（rpc 模式）

**问题**：三套命令名空间不一致：

| 命令      | interactive | tui                                 | rpc                               |
| --------- | ----------- | ----------------------------------- | --------------------------------- |
| 新建会话  | `/new`      | `/new`                              | `new_session`                     |
| 切换会话  | `/resume`   | `/resume`                           | `switch_session`                  |
| Fork 会话 | `/fork`     | `/fork`                             | `fork_session`                    |
| 列出会话  | `/sessions` | `/sessions`                         | `list_sessions`                   |
| 审批模式  | `/approval` | `/approval`                         | `set_approval`                    |
| 中断      | ❌          | `/interrupt`                        | `abort`                           |
| Steering  | ❌          | `/interrupt`/`/followup`/`/unsteer` | `steer`/`unsteer`/`steering_list` |

**修复方向**：抽出 `SlashCommandRegistry`，定义命令元数据（name、aliases、args、modes），各模式仅提供 dispatcher。

#### C5：SpecEngine 确认在 eventSink 中拦截（MEDIUM）

**文件**：`apps/cli/src/agent-command.ts:185-205`

**问题**：在 eventSink 包装层中拦截 `spec_confirmation_required` 事件，直接调用 `agent.specEngineInstance`。这绕过了 agent 自身的事件处理，且 `agent` 变量在闭包中是 `let`（可空），存在时序耦合。

### 2.3 亮点

- **多模式输出**（print/json/rpc/tui/interactive/acp）覆盖完整，每种模式有独立的 eventSink 适配
- **MCP pin 校验** fail-closed，schema/transport 漂移即退出
- **企业模式**沙箱拒绝 Host fallback、强制 audit HMAC、扩展签名校验
- **Fallback model chain** 带熔断和 per-request 超时隔离
- **Session 管理**：fork/resume/continue/branch/tree 完整

---

## 三、TUI 审查（packages/tui）

### 3.1 设计意图

FocusCode TUI 是自研渲染的全屏终端状态机，不使用 Ink（React for terminal）或 blessed。25 个模块覆盖：渲染、主题、吉祥物、vim、补全、picker、palette、搜索、tree panel、todo panel、spec progress、context bar、diff、markdown、syntax、LSP 补全、pixel frames。

### 3.2 实现问题

#### T1：自研渲染器维护成本高（MEDIUM）

**文件**：`packages/tui/src/renderer.ts`

**问题**：自研 diff 渲染（`lastFrame` 对比），未使用成熟库。

**对比**：

- Claude Code 用 Ink（React 声明式，社区成熟）
- OpenCode（TS 版）也用 Ink
- FocusCode 自研命令式渲染

**影响**：布局/焦点/滚动/重绘逻辑全部自管，500+ 行渲染状态机。优点是零依赖、完全可控；缺点是新增组件成本高，edge case 多。

**修复方向**：若团队不打算长期投入终端渲染框架，考虑迁移到 Ink。否则需补齐渲染器的边界测试（resize、alt-screen、color fallback）。本报告不强制修复 T1，列为长期技术债。

#### T2：`runFullScreenAgent` 桥接层过重（HIGH）

**文件**：`apps/cli/src/tui.ts`，1228+ 行

**问题**：`runFullScreenAgent` 是另一个 God Function：

- 50+ 行的 `onCommand` switch 处理 35+ slash 命令
- 内嵌 clipboard 图片读取、project scaffold、todo 子命令、layout 子命令、mcp 描述、mascot 描述
- 直接操作 `tui` 实例的 20+ 个方法（`setModel`/`setStatus`/`setSpeech`/`setAttachments`/`setQueued`/`setSession`/`setApproval`/`showToast`/`submitText`/`openPalette`/`openSearch`/`openPicker`/`setVimEnabled`/`setLayoutMode`/`toggleTodoPanel`/...）

**修复方向**：拆分为三层：

1. 命令路由表（声明式命令定义）
2. 业务处理器（可测试的纯函数）
3. UI 状态适配器（薄封装 tui 实例方法）

#### T3：Foxy 鼓励师系统耦合在 TUI 桥接层（LOW）

**文件**：`apps/cli/src/tui.ts:14-36`

**问题**：`FOX_CHEERS` 和 `pickCheer` 硬编码在 tui.ts 中，而非 tui 包。这导致吉祥物逻辑分散在 CLI 桥接层和 TUI 包两处。

**修复方向**：将 Foxy 鼓励师逻辑移入 `@focuscode/tui` 包。

### 3.3 亮点

- **功能丰富**：vim 模式、命令面板（Ctrl+P）、transcript 搜索、4 种 layout（classic/split/focus/wide）、tree panel、todo panel、spec progress 可视化、model picker（Alt+M）、context usage bar
- **Foxy 鼓励师**：独特的情感陪伴系统，6 种情绪（idle/thinking/working/happy/oops/done）+ 随机鼓励语，是差异化亮点
- **Mascot/Skin 系统**：可定制角色和皮肤，支持导入导出
- **LSP 补全集成**：`lsp-completion.ts` 提供真实语言服务器补全
- **主题系统**：多主题 + 自定义 keymap

---

## 四、SDK 审查（packages/sdk）

### 4.1 设计意图

SDK 是 FocusCode 的可嵌入组合 API，对标 Claude Agent SDK。提供两条路径：

1. `createCodingAgent()` — 工厂模式，返回 `{ agent, sessions, extensions, resources, config }`
2. `runCodingAgent()` — AsyncGenerator 流式 API，对标 Claude SDK 的 `query()`
3. `createLocalHarness()` — 审计 Kernel 路径

### 4.2 实现问题

#### S1：CLI 与 SDK 组合逻辑分裂（HIGH）

见 P0。这是 P0 在 SDK 侧的具体表现。

#### S2：`ApprovalMode` 类型碰撞（MEDIUM）

**文件**：`packages/sdk/src/local-harness.ts:46-49`

**问题**：SDK 的 `ApprovalMode`（`deny|prompt|auto-safe`）与 agent-runtime 的 `ApprovalMode`（`ask|auto-edit|full-auto|deny`）语义不同但同名。

```typescript
export type HarnessApprovalMode = "deny" | "prompt" | "auto-safe";
/** @deprecated Use HarnessApprovalMode to avoid colliding with agent-runtime's ApprovalMode. */
export type ApprovalMode = HarnessApprovalMode;
```

两条路径的审批模型不统一：

- Kernel 路径：`deny|prompt|auto-safe`（deny 默认，prompt 需 TTY，auto-safe 需隔离）
- Session 路径：`ask|auto-edit|full-auto|deny`（ask 需 TTY，否则降级 deny）

**修复方向**：统一为单一 `ApprovalMode` 枚举，或显式命名（`KernelApprovalMode` / `SessionApprovalMode`）并移除 deprecated alias。

#### S3：`runCodingAgent` 的 sink 恢复时序（LOW）

**文件**：`packages/sdk/src/run-coding-agent.ts:36-40`

**问题**：在 `submit()` 之前安装 sink，但 `closeStream` 在 `resultPromise` 的 then/catch 中恢复。若 `submit()` 同步抛出（非 Promise reject），`closeStream` 不会执行，sink 不会恢复。

实际 `agent.submit()` 返回 Promise，所以同步抛出场景罕见，但仍是潜在泄漏点。

#### S4：`AgentHooks` 与 Claude SDK 的命名差异（LOW）

| FocusCode Hook     | Claude Agent SDK Hook | 语义 |
| ------------------ | --------------------- | ---- |
| `preToolUse`       | `PreToolUse`          | 一致 |
| `postToolUse`      | `PostToolUse`         | 一致 |
| `sessionStart`     | `SessionStart`        | 一致 |
| `sessionEnd`       | `SessionEnd`          | 一致 |
| `stop`             | `Stop`                | 一致 |
| `preCompact`       | `PreCompact`          | 一致 |
| `userPromptSubmit` | `UserPromptSubmit`    | 一致 |
| `subagentStop`     | `SubagentStop`        | 一致 |
| `notification`     | `Notification`        | 一致 |

命名基本对齐 Claude SDK，这是优点（降低迁移成本）。但 `preToolUse` 返回 `PreToolResult | undefined`（fail-open），Claude SDK 的 `PreToolUse` 返回 `PreToolUseResult`（默认 allow）— 语义有细微差异。

### 4.3 亮点

- **`runCodingAgent` AsyncGenerator API**：直接对标 Claude SDK `query()`，`for await ... of` + `result` promise 双通道，设计干净
- **`createSessionEffectSpine`**：将 session tool loop 接入审计 spine，是 FocusCode 独有的"会话 + 审计"双路径统一，Claude SDK 和 OpenCode 都没有
- **`AgentHooks` 完整生命周期**：9 个 hook 点，覆盖 tool/session/compact/prompt/subagent/notification
- **`forkSession` 选项**：对标 Claude SDK 的 `forkSession`
- **`composeEventSink`**：将 `onEvent` + `hooks` 组合为单一 sink，零开销（仅 `onEvent` 时直接返回）

---

## 五、与 Claude Code、OpenCode 的深度对比

### 5.1 定位与架构

| 维度               | FocusCode                                     | Claude Code             | OpenCode                     |
| ------------------ | --------------------------------------------- | ----------------------- | ---------------------------- |
| **定位**           | 模型可移植 + 审计 Kernel 的 Agent Harness     | Claude 专属 CLI（闭源） | 多模型开源 CLI（Go/TS 双版） |
| **架构核心**       | 双路径：Session Agent + Audited Kernel        | 单路径：Agent loop      | 单路径：Agent loop           |
| **Effect Spine**   | ✅ Policy→Grant→Receipt 审计链                | ❌                      | ❌                           |
| **模型可移植**     | ✅ 5 系 Provider + 4 协议 + Model Pack        | ❌ 仅 Claude            | ✅ 多 Provider               |
| **Fallback Chain** | ✅ 主模型失败自动切换 + 熔断                  | ❌                      | ❌/有限                      |
| **Sandbox**        | ✅ gVisor/Docker/seatbelt/VM/Host             | ❌ 依赖 OS 权限         | ❌                           |
| **审计 Kernel**    | ✅ Intent/Grant/Receipt/Verifier + Checkpoint | ❌                      | ❌                           |
| **MCP**            | ✅ stdio + pin 校验 fail-closed               | ✅                      | ✅                           |
| **OAuth/OIDC**     | ✅ 5 系 Provider 内置                         | ✅ Claude OAuth         | 有限                         |

### 5.2 CLI 对比

| 维度                  | FocusCode                                  | Claude Code               | OpenCode                  |
| --------------------- | ------------------------------------------ | ------------------------- | ------------------------- |
| **入口模式**          | 6 种（tui/interactive/print/json/rpc/acp） | 2 种（interactive/print） | 2 种（interactive/print） |
| **子命令**            | 14 个 + agent 默认路径                     | 少量（config/mcp）        | 少量                      |
| **JSON-RPC**          | ✅ 完整 stdio JSON-RPC                     | ❌                        | ❌                        |
| **ACP**               | ✅ Agent Client Protocol                   | ❌                        | ❌                        |
| **Session fork/tree** | ✅ 完整树 + fork + branch                  | ✅ fork                   | 有限                      |
| **Steering**          | ✅ append/interrupt/followup mid-turn      | ✅ interrupt              | ❌/有限                   |
| **Cost tracking**     | ✅ per-session + budget                    | ✅                        | ❌                        |
| **Checkpoint/undo**   | ✅ file-level checkpoint + restore         | ❌                        | ❌                        |

### 5.3 TUI 对比

| 维度                | FocusCode                           | Claude Code | OpenCode    |
| ------------------- | ----------------------------------- | ----------- | ----------- |
| **渲染框架**        | 自研命令式                          | Ink (React) | Ink (React) |
| **Vim 模式**        | ✅ NORMAL/INSERT                    | ✅          | ❌          |
| **命令面板**        | ✅ Ctrl+P                           | ✅ Ctrl+P   | ❌          |
| **Transcript 搜索** | ✅                                  | ✅          | ❌          |
| **Layout 模式**     | ✅ 4 种（classic/split/focus/wide） | 1 种        | 1 种        |
| **Tree panel**      | ✅ session tree 可视化              | ❌          | ❌          |
| **Todo panel**      | ✅ 内置 todo                        | ❌          | ❌          |
| **Model picker**    | ✅ Alt+M 全屏 picker                | ✅ /model   | ✅ /model   |
| **Spec progress**   | ✅ spec 阶段可视化                  | ❌          | ❌          |
| **Context bar**     | ✅ token usage bar                  | ✅          | ✅          |
| **Diff viewer**     | ✅ 内置 diff                        | ✅          | ❌          |
| **LSP 补全**        | ✅ 真实 LSP over stdio              | ❌          | ✅          |
| **图片输入**        | ✅ clipboard + file + URL           | ✅          | ❌          |
| **吉祥物/伙伴**     | ✅ Foxy 鼓励师 + 皮肤系统           | ❌          | ❌          |
| **主题**            | ✅ 多主题                           | ✅          | ✅          |

### 5.4 SDK 对比

| 维度               | FocusCode SDK                     | Claude Agent SDK         | OpenCode      |
| ------------------ | --------------------------------- | ------------------------ | ------------- |
| **流式 API**       | `runCodingAgent()` AsyncGenerator | `query()` AsyncGenerator | 无独立 SDK    |
| **工厂 API**       | `createCodingAgent()`             | `createAgent()`          | —             |
| **Hooks**          | 9 个生命周期 hook                 | 9 个（命名对齐）         | —             |
| **Fork session**   | ✅ `forkSession` 选项             | ✅ `forkSession`         | —             |
| **审计 Kernel**    | ✅ `createLocalHarness()`         | ❌                       | ❌            |
| **Effect Spine**   | ✅ `createSessionEffectSpine()`   | ❌                       | ❌            |
| **Sandbox 注入**   | ✅ `shellExecutor` 选项           | ❌                       | —             |
| **Extension host** | ✅ 进程内/进程隔离                | ✅                       | —             |
| **MCP**            | ✅ pin 校验                       | ✅                       | —             |
| **可嵌入**         | ✅ SDK 包独立                     | ✅                       | ❌ 无独立 SDK |

### 5.5 差异化总结

**FocusCode 独有优势**：

1. **审计 Kernel**：Intent/Grant/Receipt/Verifier + Checkpoint，适合企业合规场景
2. **模型可移植 + Fallback**：5 系 Provider + 熔断 fallback chain，不锁定单一模型
3. **沙箱隔离**：gVisor/Docker/seatbelt/VM 多后端，Tool 子进程隔离
4. **Steering**：mid-turn append/interrupt/followup，不中断当前回合
5. **Foxy 鼓励师**：情感陪伴系统，独特差异化
6. **Session 树 + Fork**：完整分支语义，支持探索式工作流
7. **双路径统一**：Session Agent 和 Audited Kernel 共享 Policy→Grant→Receipt spine
8. **JSON-RPC / ACP**：支持 IDE 集成和 Agent 协议

**Claude Code 优势**：

1. **Ink 生态**：React 声明式 TUI，组件复用成熟
2. **Claude 深度优化**：与 Claude 模型能力深度对齐（thinking、artifacts、computer use）
3. **用户基数**：社区大、文档全
4. **轻量**：单路径，无 Kernel 复杂度

**OpenCode 优势**：

1. **极简**：代码量小，易理解
2. **Go 版性能**：Bubble Tea 渲染快
3. **多模型**：开箱即用多 Provider

---

## 六、改进建议（优先级排序）

| 优先级     | 编号  | 建议                                                                  | 预期收益                                  | TDD 策略                                     |
| ---------- | ----- | --------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------- |
| **P0**     | S1/P0 | CLI 调用 SDK `createCodingAgent` 作为唯一组合点，消除两套平行组合逻辑 | 消除 God Function，行为一致，维护成本减半 | 特征化测试：先写集成测试锁定现有行为，再重构 |
| **P0**     | C2    | `runAgentCommand` 拆分（依赖 P0 解决）                                | 350 行 → 多个可测试函数                   | 随 P0 一起                                   |
| **HIGH**   | T2    | `runFullScreenAgent` 拆分为命令路由表 + 业务处理器 + UI 适配器        | 1228 行 → 3 个 ~300 行模块                | 特征化测试 + 命令路由表单元测试              |
| **MEDIUM** | C4    | 统一 slash 命令注册表，三模式共享命令定义                             | 消除命令名空间不一致                      | 命令注册表单元测试                           |
| **MEDIUM** | S2    | 统一 `ApprovalMode` 类型，消除 Kernel/Session 命名碰撞                | 消除 deprecated alias，类型安全           | 类型兼容性测试                               |
| **MEDIUM** | C1    | CLI 入口改为正向路由                                                  | 新增子命令不破坏 agent 调用               | 路由单元测试                                 |
| **LOW**    | T3    | Foxy 鼓励师逻辑移入 tui 包                                            | 内聚                                      | 行为保持测试                                 |
| **LOW**    | S3    | `runCodingAgent` sink 恢复加 finally                                  | 边缘场景泄漏修复                          | 同步抛出场景测试                             |

---

## 七、TDD 修复计划

### 7.1 方法论

采用特征化测试（Characterization Tests）+ 垂直切片 TDD：

1. **特征化测试**：先写集成测试锁定现有行为（这些测试在重构前应 PASS）
2. **重构**：修改实现，测试应仍 PASS
3. **新增单元测试**：为新抽象（如 SlashCommandRegistry）写 TDD 测试

### 7.2 修复顺序

按依赖关系排序：

1. **S2（类型碰撞）**：最小、最独立，先修复
2. **C4（命令注册表）**：为新抽象写 TDD，然后三模式接入
3. **P0/C2（CLI 复用 SDK）**：最大重构，依赖前两步
4. **T2（TUI 拆分）**：依赖 C4 的命令注册表
5. **C1（正向路由）**：独立小修复

### 7.3 验收标准

每个修复阶段：

- `pnpm build` 通过
- `pnpm lint` 通过（架构边界 + prettier）
- 相关测试全部通过
- 无行为回归（特征化测试仍 PASS）

---

## 八、结论

FocusCode 在架构野心上明显超越 Claude Code 和 OpenCode：双路径（Session + Kernel）、审计 spine、模型可移植、沙箱隔离、steering、6 种 I/O 模式，这些都是同类工具没有的。

但实现成熟度有落差：CLI 和 SDK 的组合逻辑分裂（P0）、多个 God Function（C2/T2）、命令三处重复（C4）、类型碰撞（S2）。这些不是设计问题，而是收敛不足 — 架构已定义清晰边界（AGENTS.md + check-boundaries），但 CLI 层未充分复用 SDK 层。

**核心建议**：优先解决 P0（CLI 复用 SDK），其余问题会随之简化。FocusCode 的差异化优势（审计 Kernel + 模型可移植 + 沙箱 + steering + Foxy）足以支撑其作为企业级 Agent Harness 的定位，但需要收敛实现才能兑现架构承诺。

---

## 九、修复进度（2026-07-30 更新）

### 9.1 已完成（TDD）

| 编号 | 状态        | 测试数 | 说明                                                                                               |
| ---- | ----------- | ------ | -------------------------------------------------------------------------------------------------- |
| S2   | ✅ 完成     | 4      | 移除 SDK `ApprovalMode` alias，统一 `HarnessApprovalMode`                                          |
| C4   | ✅ 核心抽象 | 9      | `SlashCommandRegistry` — 单一命令注册表，三模式共享                                                |
| P0-1 | ✅ SDK 扩展 | 5      | `createCodingAgent` 接受 `searchEndpoint/extensionHostKind/fallbackModels/eventSinkWrapper`        |
| C1   | ✅ 完成     | 5      | `SUBCOMMANDS` 常量 + ReadonlySet 替代 deny-list                                                    |
| T2-1 | ✅ 8 命令   | 10     | status/tools/approval/model/new/resume/fork/sessions 提取到 registry                               |
| C5   | ✅ 完成     | 4      | `specConfirmationHandler` 选项，agent 内部处理，移除 eventSink 拦截                                |
| T2-2 | ✅ 14 命令  | 17     | export/reload/skills/undo/cost/diagnostics/vim/palette/search/layout/todopanel/character/skin/init |

累计新增测试 54 个，全部通过，零回归。

### 9.2 C5 详细说明（SpecEngine 确认移入 agent）

**原问题**：CLI 在 eventSink 包装层拦截 `spec_confirmation_required`，通过 `agent?.specEngineInstance` 调用 `resolveDecisions`/`declineSpec`。`agent` 是 `let`（可空），存在时序耦合 — 若事件在 agent 构造前到达，拦截器静默失败。

**修复**：

- `CodingAgentOptions` 新增 `specConfirmationHandler` 选项
- handler 签名：`(event) => Promise<Record<string,string> | undefined>`（返回 choices=resolve，undefined=decline）
- agent 通过 `specConfirmationHandler` getter 暴露已安装的 handler
- CLI 构造 handler 函数并作为选项传入，不再包装 eventSink
- TUI 模式不安装 handler（确认 UI 由 TUI bridge 驱动）

**收益**：消除 `let agent` 闭包，确认逻辑与 agent 生命周期绑定，handler 可独立测试。

### 9.3 T1/T3 长期技术债评估

#### T1：TUI 渲染层 Ink 迁移评估

**现状**：`packages/tui` 是自研全屏终端状态机（`FullScreenTui` 类），直接操作 ANSI escape codes、管理滚动缓冲区、输入处理、布局计算。1228 行的 `tui.ts` 中 `runFullScreenAgent` 是 God Function，但底层 TUI 引擎本身是稳定的。

**Ink 迁移收益**：

- 声明式 UI（JSX）替代命令式 ANSI 操作
- 自动处理终端 resize、滚动、交替屏幕缓冲区
- 丰富的组件生态（flexbox 布局、focus 管理、列表虚拟化）
- 与 React 生态对齐，降低贡献门槛

**Ink 迁移风险**：

- **性能**：Ink 的 reconciliation 在高频更新（流式 token、spinners）下可能引入 jank；当前自研引擎直接 write ANSI，零开销
- **颜色/主题**：FocusCode 有 5 套主题 + mascot + skin 系统，Ink 的 styled-components 需重新映射
- **vim 模式**：当前 vim 状态机深度集成在输入处理层，Ink 的 input handling 需重新设计
- **companion/speech overlay**：Foxy 鼓励师的动画层依赖时序控制，Ink 的 render 模型不同
- **架构边界**：`packages/tui` 是叶子 adapter（不依赖任何 `@focuscode/*`），Ink 引入 React 依赖不违反边界，但增加了叶子包的复杂度

**建议**：**不迁移**。当前自研 TUI 已稳定，迁移收益（声明式）不抵风险（性能/主题/vim/动画重写）。应优先继续 T2 的命令提取（已完成 22/35 命令），降低 `runFullScreenAgent` 复杂度。若未来贡献者反馈 TUI 维护困难，再评估 Ink 迁移。

#### T3：Foxy 鼓励师内聚

**现状**：Foxy 逻辑分散在三处：

1. `apps/cli/src/tui.ts` — `cheerEnabled` 状态、`pickCheer("idle")` 调用、`/cheer` 命令
2. `apps/cli/src/mascots.ts`（推测）— mascot 加载、cheer 文案
3. `packages/tui` — companion 渲染、speech overlay

**问题**：`/cheer on|off` 命令、`cheerEnabled` 状态、`pickCheer` 调用都在 `tui.ts`，但 mascot 数据和渲染在别处。修改 cheer 行为需跨文件协调。

**建议**：**低优先级，随 T2 step 3 一起处理**。当 `image/cheer/todo/mcp/skill/tree` 命令迁移到 registry 时，将 `cheerEnabled` 状态和 `/cheer` 命令一并提取到 `tui-commands.ts` 的 `TuiCommandState`，与 mascot 数据结构对齐。不建议单独重构 Foxy — 它是体验层装饰，当前分散程度可接受。

### 9.4 P0 step 2 剩余工作

**为何未完成**：CLI `runAgentCommand` 有 350 行、13 步组合逻辑（sandbox、tool registry filter、extensions、MCP、spine、renderer、prompter、event sink、approve、session selection）。完全切换到 `createCodingAgent` 需要 SDK 扩展支持：sandbox options、enabledTools/disabledTools filter、mcpServers 列表、renderer 模式选择、prompter 注入。

每个 SDK 扩展都需 TDD（RED→GREEN→REFACTOR），且需先写 CLI 特征化测试锁定现有行为（13 步组合的边界条件）。这是安全的单次会话工作量的上限。

**已完成的前提**：SDK 已支持 `searchEndpoint/extensionHostKind/fallbackModels/eventSinkWrapper/specConfirmationHandler`。C5 已移除 eventSink 拦截。这些为 step 2 铺平了道路。

**下一步计划**：分 3 个垂直切片推进——

1. SDK 添加 `sandbox` 选项（TDD：测试 sandbox 配置传入）
2. SDK 添加 `enabledTools/disabledTools` 选项（TDD：测试 tool filter）
3. CLI `runAgentCommand` 用 `createCodingAgent` 替换组合逻辑，feature flag 控制（`--use-sdk-composition`），特征化测试验证行为一致后默认开启
