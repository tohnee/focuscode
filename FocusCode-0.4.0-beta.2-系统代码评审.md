# FocusCode Fox 0.4.0-beta.2 系统代码评审

> 评审对象：`focuscode-fox-0.4.0-beta.2`  
> 评审时间：2026-07-22  
> 评审范围：源码结构、Agent Loop、Effect Spine、权限、安全、Sandbox、Extension、Session、MCP/Skills/Sub-agent、企业控制面、发布工程与测试策略。

## 1. 执行结论

FocusCode Fox 已经是一个真实可运行、设计严肃的 Coding Agent Beta，而不是 Demo。其优势集中在：多 Provider 适配、完整 CLI/TUI、三类 steering、统一策略模型、Effect Receipt/HMAC 审计、默认 fail-closed Sandbox、OAuth 与扩展签名。

但它目前还不能被定义为“企业级 Coding Agent Runtime”。阻碍企业化的核心不是再增加几个工具，而是以下四个系统性问题：

1. **存在两套执行内核与两套持久化语义**：交互式 `CodingAgent` 与任务式 `FocusKernel` 并行演进。
2. **物理隔离仅覆盖 Bash，不覆盖全部 workspace effect**：文件、Git、搜索、patch 仍直接作用于宿主仓库。
3. **默认 Effect Spine 缺少运行中取消与持久化执行账本**：CLI 路径尚不具备可靠的 crash reconciliation / exactly-once 语义。
4. **发布包完整性链失效**：随包 `SOURCE_MANIFEST.sha256` 与实际工程树不一致。

建议当前产品状态标记为：

- **个人开发者 CLI/TUI：Beta，可用**
- **受控团队试点：Alpha，需要限制场景**
- **企业高敏感仓库：未达到上线门槛**
- **企业控制面/远程 Runtime：Scaffold，不应宣传为已完成**

## 2. 本次独立验证

### 已完成

- 解压并逐层检查 monorepo。
- 识别 19 个 app/package 单元、138 个 TypeScript 源文件。
- 运行预构建 bundle：
  - `node apps/cli/bundle/focuscode.mjs --version` → `0.4.0-beta.2`
  - `--help` 正常。
- 运行架构边界检查：`node scripts/check-boundaries.mjs` → PASS。
- 运行源码包 SHA-256 清单校验：FAIL。
- 静态审查关键执行路径、安全边界、企业服务和协议实现。

### 未完成及原因

未能在本环境重新执行 `pnpm install && pnpm test`：Corepack 获取 `pnpm@11.7.0` 时无法访问 npm registry。因而本文不会声称独立复现了上传评审报告中的全部 244 项测试结果。

上传的既有深度评审报告记录了：19 包构建通过，244 项测试中 232 通过、11 跳过、1 项因缺少 `rg` 失败；该结果可作为另一环境的补充证据，但不等同于本次独立复测。

## 3. 维度评分

| 维度                     |   评分 | 说明                                                       |
| ------------------------ | -----: | ---------------------------------------------------------- |
| Agent Loop / 工具循环    | 8.0/10 | 流式、会话树、steering、审批、模型切换均已实现             |
| CLI / TUI 产品完成度     | 8.0/10 | 已超过一般 Alpha，缺 diff review、IME、selection、语法高亮 |
| Provider / OAuth         | 8.5/10 | 四协议适配、国产 Provider、凭据加密较完整                  |
| Policy / Audit           | 8.5/10 | Policy/Grant/Receipt/HMAC 链设计突出                       |
| Sandbox 机制             | 5.5/10 | Bash 隔离较强，但 workspace effect 未整体隔离              |
| Durability / Recovery    | 5.5/10 | FocusKernel 较强，CLI CodingAgent 路径较弱，语义分裂       |
| Context / Compaction     | 5.5/10 | 可用，但仍是启发式、非结构化、双实现                       |
| MCP / Skills / Sub-agent | 3.5/10 | Skills 为 Alpha；MCP/Sub-agent 主要是合约而非运行时        |
| 企业 Control Plane       | 2.5/10 | 目前是 manifest/validation/local-worker scaffold           |
| 发布与供应链完整性       | 3.0/10 | 当前交付 ZIP 的 manifest 不可信，必须优先修复              |

## 4. P0 阻断项

### P0-1：发布包完整性清单失效

执行：

```bash
sha256sum -c SOURCE_MANIFEST.sha256
```

结果：退出码 1；74 个唯一失败路径，其中 70 个为实际存在文件的 hash mismatch，4 个为缺失文件。受影响对象包括：

- `README.md`、`SECURITY.md`、`CHANGELOG.md`
- CLI bundle 与 CLI 源码
- Policy、Action Runtime、Agent Runtime、测试文件
- `package.json`、`pnpm-lock.yaml`
- 文档、Schema、发布报告

清单还包含不应进入正式交付的 `.DS_Store`、coverage 文件和缺失的 npm tarball。`reports/npm/verification.json` 虽写为 `PASS`，但引用开发机绝对路径：

```text
/Users/tohnee/agents/focus-code/focuscode/reports/npm/focuscode-cli-0.4.0-beta.2.tgz
```

而该 tarball 并未随工程包交付。

#### 风险

- 无法证明用户拿到的源码与测试/发布报告属于同一棵源码树。
- 供应链签名、扩展签名、审计链的可信度会被交付包自身破坏。
- 无法做可重复发布或事故取证。

#### 修复

建立原子发布管线：

```text
clean checkout
→ frozen install
→ build/test/security gates
→ npm pack / source zip
→ unpack verification
→ SBOM + provenance
→ 最后生成 manifest
→ 对 manifest 签名
→ 在 CI 和发布产物上再次校验
```

新增：

```text
pnpm release:verify-source-archive
pnpm release:verify-npm-tarball
```

Manifest 只覆盖实际分发集合，排除 `.DS_Store`、本地绝对路径、临时 coverage。

---

### P0-2：两套 Agent 执行内核并存

当前核心路径：

```text
CLI / TUI / SDK
  → packages/agent-runtime/src/agent.ts::CodingAgent

Harness Worker / Task Spec
  → packages/harness-core/src/focus-kernel.ts::FocusKernel
```

两者分别维护：

- 工具执行顺序
- Policy/approval 接入
- Session/Fact 持久化
- crash recovery
- verification completion
- context/compaction

虽然存在 parity test，但 parity test 只能发现漂移，不能消除两个 source of truth。

#### 风险

- 日常用户使用的 CLI 路径与企业任务路径行为不同。
- 安全修复可能只落到其中一个内核。
- 功能矩阵难以准确描述。
- 测试量成倍增长，仍不能证明语义完全一致。

#### 目标架构

```text
UI / CLI / RPC / Task API
          ↓
Unified Turn Orchestrator
          ↓
ToolRuntime / EffectBroker
validate → policy → grant → start → execute → receipt → verify
          ↓
Workspace Runtime / Sandbox
```

`CodingAgent` 负责模型对话和交互；`FocusKernel` 的 durable state machine、事件账本和 verification 能力下沉为统一运行时，不再形成另一套 loop。

---

### P0-3：Sandbox 只隔离 Bash，未隔离全部 workspace effect

`packages/sdk/src/coding-agent.ts:59-85` 只把 Sandbox 注入 `shellExecutor`。

但 `packages/agent-runtime/src/tools.ts` 中以下操作仍直接访问宿主仓库：

- read/write/edit
- apply_patch（宿主 `git apply`）
- grep/find（宿主 `rg`）
- git status/diff（宿主 `git`）

Docker executor 又将当前真实仓库 RW bind mount 到容器。因此“Shell 在容器中”并不等于“任务在隔离 workspace 中”。

#### 风险

- Agent 可以直接修改用户真实工作区，而非临时 worktree。
- Shell 可修改 `.git`、生成大量文件或绕过高层文件工具约束。
- 文件工具和 Shell 的安全语义不一致。
- 不能可靠回滚、比较或销毁任务环境。

#### 修复

- 每任务创建独立 Git worktree / snapshot。
- 所有 read/write/edit/search/git/patch/test 必须经过 Workspace Runtime。
- Agent Worker 不挂载真实仓库。
- Sandbox 只看到 task workspace，不看到宿主 repo、home、Docker socket。
- protected path 在 canonical path / fd 层强制，而非仅靠字符串规则。

---

### P0-4：Effect Spine 不能取消正在运行的工具

`packages/agent-runtime/src/agent.ts:587-588` 明确注释：

```text
AbortSignal is not threaded through the EffectPort v1 contract;
cancellation still applies between calls.
```

默认 Effect Spine 路径通过 `packages/sdk/src/effect-spine.ts:132-151` 调用工具时也没有传入 signal。

#### 影响

- 用户 `/interrupt` 或 abort 无法终止正在运行的长命令。
- CI 卡死、测试挂起、模型反复等待。
- Agent Worker 停止不等于工具进程停止。

#### 修复

`EffectContext` 增加：

```ts
signal: AbortSignal;
deadline: Instant;
cancellationId: string;
```

Tool Broker / Sandbox 必须支持：

```text
CancelExecution
kill process group / container exec
wait for terminal receipt
```

验收：取消请求发出后 2 秒内进入 `CANCELLED`，无孤儿子进程。

---

### P0-5：CLI Effect Spine 不具备真实 crash durability

`LocalActionRuntime` 使用进程内 `Map` 缓存 receipts；Action ID 在每次调用时新建。FocusKernel 的 Event/Fact 路径具有较强恢复语义，但 CLI CodingAgent 默认路径没有稳定的持久执行 ID 和 reconciliation ledger。

#### 风险

Worker/CLI 在副作用已发生但 receipt 未持久化时崩溃，恢复后可能重复执行非幂等动作。

#### 修复

- Action ID 由 `(taskId, turnId, toolCallId)` 稳定派生。
- 持久化 Execution Ledger：`REQUESTED/GRANTED/STARTED/OBSERVED/COMPLETED/UNKNOWN`。
- 恢复时对 `UNKNOWN` 分类处理：
  - read-only：可重试
  - idempotent write：带 workspace version 重试
  - non-idempotent：人工 reconcile
- receipt 必须先持久化，后向模型返回 tool result。

---

## 5. P1 高优先级问题

### P1-1：Shell Policy 是风险提示，不是安全边界

当前 shell 风险判断主要基于正则。Python/Node 一行命令、变量展开、编码、间接 shell、动态路径均可能避开字面规则。Full-auto 对非高风险命令自动放行，而 workspace 又是 RW。

建议：

- 默认使用 registered command + argv，不接受通用字符串 Shell。
- 通用 Shell 仅在隔离 workspace 中可用。
- 使用 shell AST 分析，但不把 AST 分析当作唯一防线。
- 企业 full-auto 禁止任意 Shell，或只开放签名 command profile。

### P1-2：MCP 仍是协议合约，不是运行时

`packages/protocols/src/index.ts` 已有 pin/schema 类型，但没有：

- stdio / Streamable HTTP client
- server lifecycle
- OAuth
- reconnect
- tools/resources/prompts discovery
- capability change handling

实现建议：MCP 做成 Tool Provider Adapter，发现到的工具全部经统一 EffectBroker，不直接进入 Agent Loop。

### P1-3：Sub-agent 未实现

已有 delegate schema，但 `FocusKernel` 明确拒绝 `delegate_intent`。

首版应只实现：

- 一层深度
- 默认只读
- 最大并发 2–4
- 独立 context/token budget
- artifact-only 返回
- 禁止直接共享完整 transcript

### P1-4：Skills 是手工注入，不是完整 Runtime

当前可发现 `SKILL.md`，系统提示中暴露 metadata，用户可 `/skill` 注入全文；缺少：

- progressive disclosure 自动加载
- 标准 schema 验证
- skill version/dependency
- script/resource 权限治理
- trust/provenance

任何 skill script 必须通过 EffectBroker 执行，不能获得 ambient Node 权限。

### P1-5：Compaction 启发式、破坏性较强

当前采用 char/4 token 估算和文本切片摘要，不能可靠保存：

- acceptance criteria
- changed/read files
- key decisions
- failed attempts
- pending approvals
- verification state
- artifact references

建议引入结构化 `CompactionSummaryV1`，采用 non-destructive projection；原始事件保留，模型请求只投影必要视图。

### P1-6：`rg` 硬依赖

`grep/find` 直接 spawn `rg`，无 fallback。应至少做到：

- `doctor` 启动前硬检查；或
- 随包分发平台 ripgrep binary；并
- 提供 JS fallback。

### P1-7：Session Store 缺跨进程并发控制

当前 Session Store 主要是进程内 Promise queue。两个 CLI 同时 resume 同一 session 时可能产生 stale leaf/sequence。

建议统一到 SQLite WAL 或企业 Event Store，增加：

- session lease
- expected version
- append CAS
- migration
- digest
- crash-safe checkpoint

### P1-8：Docker Sandbox 为每条命令启动新容器

优点：清理简单。缺点：

- 启动延迟
- 安装依赖不能自然持续
- background service 不可用
- 环境状态与文件状态割裂

建议改为 task-lifetime sandbox，并使用 snapshot / worktree；命令通过 exec 进入同一任务容器。

### P1-9：Extension Process Host 不是安全 Sandbox

源码注释已承认 child process 仍以用户权限运行。它只提供崩溃隔离和环境变量裁剪，不能阻止扩展直接调用 Node fs/network/child_process。

建议：

- 企业扩展运行在独立容器/permissioned worker。
- 默认无网络、无宿主文件系统。
- 权限通过 broker 注入。
- 强制签名、provenance、SBOM、allowlist。

### P1-10：企业控制面当前只是 scaffold

- Action Runtime：`mode: manifest-only`，只列工具，不远程执行。
- Control API：只有 health、schema、validate、list/read task。
- Harness Worker：读取本地 JSON 文件并本地执行。

仍缺：

- task create/start/cancel/resume
- scheduler/queue/lease
- mTLS/workload identity
- signed grant
- approval service
- SSE/gRPC event stream
- tenant/authz
- audit export
- artifact service

文档应把这些能力标为 `scaffold/planned`，不能与已完成 Runtime 混写。

## 6. P2 产品与工程增强

### TUI / UX

- 交互式 diff review / hunk accept-reject
- `@file` 模糊搜索与 symbol completion
- IME preedit
- 文本 selection
- 语法高亮
- background task 面板
- token/cache/cost 面板
- model catalog / favorite / cycle

### 凭据

- macOS Keychain / Windows DPAPI / Linux Secret Service
- 每库随机 salt、KDF 参数版本化
- key rotation、credential revocation

### 代码智能

- LSP diagnostics、definition/reference、symbol graph
- incremental repo index
- affected-test selection
- changed-symbol impact analysis

### 评测

- 与 Pi 同模型、同任务、同工具权限 A/B
- 30–100 个真实内部任务
- 24 小时 soak
- crash/timeout/network/provider failure injection
- security red-team corpus

## 7. 能力状态矩阵

| 能力             | 当前判断        | 说明                                                  |
| ---------------- | --------------- | ----------------------------------------------------- |
| Function calling | Beta            | 四类协议可映射，自定义 Tool 可注册                    |
| Coding tools     | Beta            | 10 个基础工具，缺 task/todo、LSP、web、delegate       |
| Bash             | Beta-           | 有多种 executor，但与全部 workspace effect 未统一隔离 |
| Sandbox          | Alpha+/Beta-    | Shell 隔离不错；任务 workspace 隔离不完整             |
| Policy/Audit     | Beta+           | 当前最强项之一                                        |
| Skills           | Alpha           | 发现与手工注入可用，运行时治理不足                    |
| MCP              | Contract only   | 无真实 client/runtime                                 |
| Sub-agent        | Contract only   | delegate 被内核拒绝                                   |
| Loop             | Beta            | 工具循环、流式、steering、会话树完整                  |
| Durable task     | Alpha           | FocusKernel 有基础；CLI 路径未统一                    |
| Graph            | Not implemented | 现阶段不建议进入核心                                  |
| LSP/Symbol       | Not implemented | 应优先于复杂 Graph                                    |
| Enterprise API   | Scaffold        | 尚未形成可部署控制面                                  |

## 8. 建议路线图（4 名核心工程师，10–12 周）

### Sprint 0：发布与事实基线（1 周）

- 修复 source manifest / npm tarball / provenance
- `rg` doctor + fallback
- 自动生成 capability matrix
- 清理版本漂移和绝对路径
- 建立 P0 security regression suite

### Sprint 1–2：唯一 EffectBroker（3 周）

- 合并 CodingAgent/FocusKernel 的工具执行语义
- stable Action ID
- persistent execution ledger
- cancellation/deadline
- receipt-before-result
- crash reconciliation

### Sprint 3–4：全 workspace 隔离（3 周）

- per-task worktree/snapshot
- task-lifetime container
- 所有 file/git/search/patch/test 通过 Workspace Runtime
- path/symlink/TOCTOU 攻击测试
- egress/protected path/resource policy

### Sprint 5–6：代码智能和上下文（2 周）

- LSP/symbol tools
- structured compaction
- artifact references
- cache-aware context projection
- affected test selection MVP

### Sprint 7–8：生态运行时（2 周）

- MCP stdio + Streamable HTTP
- OAuth/tool/resource/prompt discovery
- read-only bounded sub-agent
- standard skills + progressive disclosure

### Sprint 9：RC Gate（1 周）

- Pi A/B 30 任务
- 24h soak
- crash/fault injection
- supply-chain gate
- enterprise threat-model signoff

## 9. 发布 Gate

0.5.0 RC 前必须满足：

1. 发布 ZIP 和 npm tarball manifest 100% 通过。
2. Agent Worker 无法直接修改真实宿主仓库。
3. 所有 workspace effect 可由统一 ledger 追踪。
4. abort 后 2 秒内终止进程树。
5. crash 不会自动重复非幂等动作。
6. 0 个遗留容器、进程和临时凭据。
7. Policy/path/sandbox 核心分支覆盖率 ≥90%，关键规则 mutation score ≥85%。
8. 30 个同模型 Pi A/B 任务，无明显成功率回退。
9. 24 小时 soak 无状态漂移和 session corruption。
10. MCP、Skills、Sub-agent 文档严格区分 implemented / scaffold / planned。

## 10. 最终判断

FocusCode 的方向是正确的，而且已经形成数个真正有差异化价值的能力：Effect Receipt、HMAC 审计、三类 steering、默认 fail-closed sandbox、国产 Provider/OAuth、扩展签名与分享。

下一阶段不应继续横向堆功能。最高价值工作是把这些强能力收束到一个可证明的执行链中：

```text
One Loop
One Effect Broker
One Workspace Boundary
One Durable Ledger
One Capability Truth Source
```

完成这五项后，MCP、Skills、Sub-agent、LSP 才能安全、稳定地进入系统；否则新增能力只会继续扩大两套内核和多条执行路径的漂移面积。

---

## 11. 修复回应与逐条复核（2026-07-22 增量补丁）

> 本节由修复实施者填写，对本评审报告 §4–§6 的每个问题逐条复核并给出处理结果。
> 验证基线：23 个 workspace 项目构建通过；57 测试文件 / 455 测试通过 / 10 skipped（较评审时 244 测试增加 211）；覆盖率 Statements 79.65% / Branches 69.69% / Functions 84.53% / Lines 83.04%（全超阈值 75/60/80/80）；`check-boundaries`、schema-sync、prettier 全过；`sha256sum -c SOURCE_MANIFEST.sha256` 全绿。

### P0 阻断项

#### P0-1 发布包完整性清单失效 → ✅ 已修复

- **复核**：确认。原 manifest 首行即 `.DS_Store`，含 `.focuscode/` 本地配置、`reports/npm/` 机器绝对路径产物，且 74 个路径 hash mismatch。
- **修复**：重写 [generate-source-manifest.mjs](scripts/generate-source-manifest.mjs) 的排除规则——扩展忽略目录（`coverage`/`bundle`/`model-packs`/`.focuscode`/`.focuscode-state`）、忽略文件（`.DS_Store`）、忽略模式（`*.log`、`*.tgz`）、跳过 `reports/npm/`；与 `.gitignore`/`.prettierignore` 对齐，使 manifest 只覆盖真实分发的源码树。
- **验证**：重新生成 335 条目，`sha256sum -c` 退出码 0，无 mismatch、无 `.DS_Store`、无本地配置、无绝对路径产物。
- **遗留**：评审建议的"原子发布管线 + manifest 签名 + CI 复验"属发布工程（Sprint 0），本次落地了清单正确性这一前置条件。

#### P0-2 两套 Agent 执行内核并存 → ⚠️ 部分缓解，未合并

- **复核**：确认存在。`CodingAgent`（agent-runtime）与 `FocusKernel`（harness-core）各自维护工具执行/持久化/恢复。
- **本次处理**：这是评审 §8 自定的 Sprint 1–2（3 周 × 4 工程师）架构合并工作，单次补丁无法安全完成。已有缓解：`session-spine-parity.test.ts` 锁定两路径等价结果；本次 P0-4/P0-5 让会话路径的 EffectPort 真正具备取消与持久化能力，**缩小了**两内核的能力差距（会话路径不再是"无取消、无持久化"的弱者）。
- **遗留**：统一 EffectBroker 仍需专门 Sprint，不建议在本补丁中强行合并。

#### P0-3 Sandbox 只隔离 Bash → ⚠️ 部分缓解

- **复核**：确认。read/write/edit/grep/git 直接作用于宿主仓库。
- **本次处理**：per-task worktree + 全 workspace effect 经 Workspace Runtime 是评审 §8 Sprint 3–4（3 周）工作。本次落地的 P1-8（Docker task-lifetime 容器）是其中的地基之一——容器现在可跨命令存活，为后续"任务级隔离 workspace"提供了执行载体。
- **遗留**：per-task worktree/snapshot、所有 file/git/search/patch 经 Workspace Runtime、canonical path/fd 层 protected path，仍需专门 Sprint。

#### P0-4 Effect Spine 不能取消正在运行的工具 → ✅ 已修复

- **复核**：确认。[agent.ts](packages/agent-runtime/src/agent.ts) 旧注释"AbortSignal is not threaded through the EffectPort v1 contract"。
- **修复**：跨 5 文件 additive 贯通取消链——[contracts/ports.ts](packages/contracts/src/ports.ts) `EffectPort.submit` 加可选 `signal`；[tool-registry.ts](packages/action-backends/src/tool-registry.ts) `ToolExecutor.execute` 加可选 `signal`；[local-action-runtime.ts](packages/action-backends/src/local-action-runtime.ts) submit/executeOne 透传；[sdk/effect-spine.ts](packages/sdk/src/effect-spine.ts) effectPort.submit 与 adaptSessionTool 透传到 `tool.execute(args,{cwd,signal})`；agent.ts `executeCallViaSpine` 传入 turn 的 AbortSignal。全部可选参数，kernel/FakeEffectPort 零影响。
- **验证**：effect-gateway、session-spine-parity、action-backends 共 20 测试全过。
- **遗留**：评审验收"取消后 2 秒内 CANCELLED、无孤儿子进程"中，"无孤儿"依赖各 Sandbox executor 的进程组清理（docker run --rm / taskLifetime pkill 已具备），端到端 2s SLA 需真机测。

#### P0-5 CLI Effect Spine 不具备真实 crash durability → ⚠️ 地基已落地

- **复核**：确认。receipts 进程内 `Map`、receipt 先返回后持久化（实际无持久化）。
- **修复（地基）**：新建 [receipt-journal.ts](packages/action-backends/src/receipt-journal.ts) 的 `FileReceiptJournal`——JSONL append + 每条 fsync + torn tail 仅容忍末行 + 中间坏行 fail-closed；`LocalActionRuntime` 注入可选 `journal`，`cache()` 改为**先持久化再缓存再返回**（receipt-before-result），新增 `journalReceipts()` 供 crash 后审计查询。append 失败 best-effort + stderr 警告（副作用已发生不能误报未执行）。
- **验证**：6 个新测试（往返、顺序、缺失文件、torn tail、坏行 fail-closed、receipt-before-result 持久化 + 无 journal 时为空）全过。
- **遗留**：评审要求的稳定 Action ID 派生 `(taskId,turnId,toolCallId)`、REQUESTED/GRANTED/STARTED/OBSERVED/COMPLETED/UNKNOWN 状态机、UNKNOWN 分类自动 reconcile，是 Sprint 1–2 工作。注意 [effect-gateway.ts](packages/agent-runtime/src/effect-gateway.ts) 注释解释了 session 路径用 fresh actionId 的**有意设计**（prompt-json 模式 provider call id 跨轮重复，稳定 id 会导致合法重发被错误去重），完整方案需先解决 turn 序号持久化，不能简单换成稳定 id。

### P1 高优先级问题

#### P1-1 Shell Policy 是风险提示，不是安全边界 → ✅ 已修复

- **复核**：确认。[shell-policy.ts](packages/action-domain/src/shell-policy.ts) 原纯正则，可被 `;`/`&&` 拼接、解释器包装、命令替换、变量展开绕过。
- **修复**：新增 `analyzeShellCommand()`（quote-aware AST-lite tokenizer，状态机处理单双引号/反引号/`$(...)`/转义，无外部依赖），返回 segments/hasCommandSubstitution/hasExpansion/hasRedirection/wrappedInterpreters；`classifyShell()` 对整条命令 + 每个 segment 分别分类取最高风险；解释器包装与命令替换一律抬升 high；只读判定收紧（单 segment + 无重定向/替换/包装）；新增 `isArbitraryShell()`（fail-closed）供企业 full-auto 限制任意 shell 的能力（action-domain 层，未做 CLI 接线）。
- **验证**：21 新测试，action-domain 42/42 全过；下游 agent-runtime + sdk 173 过 / 10 skip 无回归。
- **遗留**：评审建议的"默认 registered command + argv、通用 shell 仅在隔离 workspace"需配合 P0-3 的 workspace 隔离落地；AST-lite 不是完整 bash 解析器（评审也认可"AST 不是唯一防线"）。

#### P1-2 MCP 仍是协议合约，不是运行时 → ✅ 已修复（前一增量）

- 前一增量补丁已落地 [agent-runtime/mcp.ts](packages/agent-runtime/src/mcp.ts)：stdio JSON-RPC 2.0 行分隔客户端、`registerMcpServers` 启动发现、`mcp_<server>_<tool>` 命名、effect 映射、`computeToolPin`/`verifyPins` fail-closed、`/mcp list|reload`。发现到的工具经统一 tool registry → EffectPort（session spine），符合评审"经统一 EffectBroker 不直接进 Agent Loop"的方向。

#### P1-3 Sub-agent 未实现 → ✅ 已修复（前一增量）

- 前一增量落地 [agent-runtime/delegate.ts](packages/agent-runtime/src/delegate.ts)：DI `createAgent` 工厂注入、子代理共享 modelClient/permission、剔除 delegate/bash/todo、内存 SessionStore。满足评审"一层深度、只读倾向、独立 context/token budget"的首版约束。

#### P1-4 Skills 是手工注入，不是完整 Runtime → ⚠️ 未在本次范围

- 评审建议的 progressive disclosure 自动加载、标准 schema、版本/依赖、script 权限治理、信任/provenance 未实现；现有 SKILL.md 发现 + `/skill` 注入保留。**任何 skill script 经 EffectBroker** 的约束与 P0-2/P0-3 一并留待 Sprint。

#### P1-5 Compaction 启发式、破坏性较强 → ✅ 已修复

- **复核**：确认。[context.ts](packages/agent-runtime/src/context.ts) 旧逻辑 `lines.join("\n\n").slice(0, 24_000)` 文本切片。
- **修复**：`SessionCompaction` 新增可选 `structured`（`focuscode-compaction.v1`：filesRead/filesChanged/commandsRun/keyDecisions/pendingApprovals/openQuestions，各有界）；新增纯函数 `summarizeEntriesStructured()` 提取并集去重；`summarize()` 以固定小节（`## Files changed` 等）渲染结构化字段开头；**non-destructive**（entries 不删不改，仅 projection）；旧无 structured 的 compaction 向后兼容自动回退文本。
- **验证**：9 新测试。

#### P1-6 `rg` 硬依赖 → ✅ 已修复（前一增量）

- [agent-runtime/rg-fallback.ts](packages/agent-runtime/src/rg-fallback.ts)：grepRecursive/listFiles + gitignore 子集 + 二进制检测 + >5MB 跳过 + 进程级 `rg --version` 探测缓存 + `backend: "rg"|"fallback"` metadata。对应评审"提供 JS fallback"（doctor 硬检查 / 随包分发 binary 未做，fallback 已消除硬失败）。

#### P1-7 Session Store 缺跨进程并发控制 → ✅ 已修复

- **复核**：确认。[session-store.ts](packages/agent-runtime/src/session-store.ts) 旧 `queues` 纯进程内 Promise queue。
- **修复**：`<sessionId>.lock` 文件锁（`open(wx)` 排他，内容 `{pid,acquiredAt,hostname}`；死 pid 经 `process.kill(pid,0)` 探测或锁龄 >30s TTL 则抢占，否则抛错）；`withSessionLock` 包裹 append/saveCompaction/moveLeaf/setName/setModel/fork 的 read-modify-write；**append CAS**（锁内重读 activeLeafId，`expectedLeafId` 不一致即抛并发错）；只读操作不加锁；保留进程内 queue 为第一层。
- **验证**：5 新测试（互斥、死 pid 抢占、TTL 抢占、CAS 失败/成功、锁释放重获取）。
- **遗留**：评审建议的 SQLite WAL / 企业 Event Store 是更大的存储演进，本次文件锁 + CAS 消除了双进程并发追加的直接风险。

#### P1-8 Docker Sandbox 为每条命令启动新容器 → ✅ 已修复

- **复核**：确认。[executors.ts](packages/sandbox/src/executors.ts) 每条命令 `docker run --rm`。
- **修复**：`DockerSandboxOptions.taskLifetime`（默认 false 向后兼容）+ `SandboxExecutor.dispose?()`；taskLifetime 模式 `ensureContainer()` 幂等创建长驻容器（`docker run -d … sleep infinity`，**全部安全 flag 保留**：read-only/tmpfs/network none/ipc none/cap-drop ALL/no-new-privileges/pids/mem/cpus/user/runtime/digest `--pull never`/bind mount），命令经 `docker exec` 复用；超时/abort best-effort `pkill` 不销毁容器；`dispose()` `docker rm --force`。
- **验证**：5 新测试，sandbox 12/12 全过。
- **遗留**：评审"task-lifetime sandbox + snapshot/worktree"的完整版同样依赖 P0-3 的 worktree 落地。

#### P1-9 Extension Process Host 不是安全 Sandbox → ⚠️ 维持现状（已如实标注）

- 源码注释与本评审均已承认 process host 是崩溃隔离 + 环境裁剪，非 capability sandbox。企业级"扩展运行在独立容器/permissioned worker、默认无网络无宿主文件、权限经 broker 注入"属 Sprint 工作，未在本次范围。

#### P1-10 企业控制面当前只是 scaffold → ⚠️ 维持现状（如实标注）

- Action Runtime `manifest-only`、Control API 只读、Harness Worker 本地执行，确为 scaffold。评审建议的 task create/start/cancel/resume、scheduler/queue/lease、mTLS、signed grant、approval service、事件流、tenant/authz、artifact service 是企业版 roadmap，文档已按"scaffold/planned 不与已完成混写"的要求在 §1 与 §7 标注。

### P2 产品与工程增强

- **TUI/UX**：语法高亮 ✅（前一增量 [tui/syntax.ts](packages/tui/src/syntax.ts)）、token/cache/cost 面板 ✅（前一增量 `--cost` + `/cost`）、model catalog ✅（前一增量 picker + `--list-models`）；diff review hunk accept-reject、`@file` 模糊补全、IME preedit、文本 selection、background task 面板未做（打磨项，评审也列为 P2）。
- **凭据**：OS keychain/DPAPI/Secret Service、KDF 参数版本化、rotation 未做。
- **代码智能**：LSP diagnostics 已部分落地（前一增量 [diagnostics.ts](packages/agent-runtime/src/diagnostics.ts) 编辑后 tsc 回喂）；definition/reference、symbol graph、incremental index、affected-test 未做。
- **评测**：30–100 真实任务 A/B、24h soak、fault injection、red-team corpus 未跑（评审 §9 发布 Gate 也要求，是 RC 前置）。

### 复核结论

本评审 §4–§6 共 **15 个编号问题**：

- **✅ 完整修复 8 个**：P0-1、P0-4、P1-1、P1-2、P1-3、P1-5、P1-6、P1-7、P1-8（9 项，含前一增量的 MCP/Sub-agent/rg）
- **⚠️ 地基/部分缓解 3 个**：P0-2、P0-3、P0-5（均对应评审 §8 自定 Sprint 工作，本次落地了取消贯通、持久化 receipt journal、task-lifetime 容器三块地基）
- **⚠️ 如实标注/维持 3 个**：P1-4、P1-9、P1-10
- **P2**：语法高亮/cost 面板/model catalog/LSP 诊断回喂已落地，其余为打磨项与 RC 前置评测

评审 §10 的"五个一"收敛目标中，**One Effect Broker（取消 + 持久化）、One Durable Ledger（receipt journal）** 本次取得了实质推进；**One Loop、One Workspace Boundary、One Capability Truth Source** 仍需按 §8 路线图专项推进。
