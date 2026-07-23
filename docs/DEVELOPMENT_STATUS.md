# FocusCode v0.4 Beta2 开发进度

报告日期：2026-07-20  
版本：`0.4.0-beta.2`  
阶段判断：六项指定差距均已有可运行实现和自动化证据，mid-turn steering 随队列取回与
delivery mode 落地已完全关闭；TUI 补齐六个组件，扩展新增进程外宿主（可靠性隔离，非安全
沙箱），Kernel 内环闭环。本轮对照企业 HA 实施计划完成代码层可闭环的修复：会话副作用链
收敛为单一默认 spine（规则语义单源 `action-domain`，legacy 直执为显式逃生门），文件
持久化全路径 fsync 并落实崩溃窗口 B/C 语义，Provider 增加熔断/并发信号量与 revision
pin，harness-worker 去除明文 apiKey，剪贴板图片经真实系统剪贴板端到端实测。Provider
live contract、真实隔离、Pi 同条件基准和扩展安全 containment 尚未通过，因此当前仍是
企业预生产 Beta，不是可无条件推广的生产正式版。

## 1. 交付规模

- 17 个 package、5 个 app/process entrypoint、1 个 root workspace；
- 105 个非测试 TypeScript/MJS 源文件，约 19,200 行；
- 38 个测试文件（37 通过 + 1 个 env 门控 live-provider 脚手架默认跳过）、244 项测试
  （234 通过 + 10 跳过），测试约 7,800 行；
- 覆盖率 Statements 79.26% / Branches 69.05% / Functions 84.02% / Lines 83.06%
  （阈值 75/60/80/80）；
- 10 个内置 Coding Tool；
- 4 个原生模型协议、Kimi/Qwen/GLM/DeepSeek/MiniMax 等 Provider profile 与模型级覆盖；
- TUI/interactive/print/JSON/RPC/SDK 六类接入；
- 5 个主题、6 只多状态终端伙伴，并支持经过校验的自定义 JSON；
- Host/Docker/gVisor/VM 四种 Sandbox backend 和 fail-closed auto selector；
- 252 项可校验源码 manifest（含 docs/reviews 与 reports/npm 制品）。

`dist`、npm bundle、`node_modules`、coverage HTML 和临时 clean-install 目录不计入源码规模。

## 2. 用户指定范围完成度

| Epic                      | 工程状态       | 已交付                                                                                                                                                                                                          | 剩余 Gate                                                     |
| ------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| OAuth 与五类模型          | Beta           | PKCE/device/OIDC/refresh/revoke/加密账号库；五系区域 profile；模型能力、reasoning、重试与 continuation state                                                                                                    | 五家真实凭据 smoke、订阅 OAuth 官方授权、recorded stream 证书 |
| 全屏 TUI/主题/keymap/伙伴 | Beta           | alternate screen、差分更新、审批/历史/滚动、多行、5 主题、6 伙伴、自定义 JSON；EditorBuffer（undo/kill ring/grapheme 光标）、tab 补全、EAW 宽字符、Markdown 渲染、diff 视图、剪贴板图片（真实系统剪贴板已实测） | IME preedit（终端协议不支持）、编辑器深度与组件生态仍落后 Pi  |
| 图片/多模态               | Beta           | 本地/HTTPS 图片、magic/digest/限制、四协议映射、模型能力 Gate、企业 egress deny、macOS 剪贴板图片（/image，osascript 端到端已实测）                                                                             | 拖入、音视频、真实视觉模型矩阵                                |
| 扩展分发/会话分享         | Beta           | npm exact/signature/integrity/lock；Ed25519 share；auth/trust/age/rate server；进程外宿主模式（崩溃隔离/60s 超时/env 白名单，非安全沙箱）                                                                       | WASI/capability 沙箱、撤销服务、OIDC/ACL/HA 存储              |
| Mid-turn steering         | Beta，差距关闭 | append/interrupt/follow-up FIFO、上限、TUI/RPC/SDK 一致；队列取回（listSteering/unsteer、steering_removed、RPC/TUI /unsteer）与 all/one-at-a-time delivery mode                                                 | —                                                             |
| Docker/gVisor/VM          | 驱动完成       | digest pin、pull-never、无网络/IPC/log、资源限制、auto no-fallback、doctor                                                                                                                                      | 目标主机 adversarial CI、VM lifecycle/attestation             |
| npm 发布安装              | Beta           | standalone tarball、bin、clean install、安装后真实本地 tool loop                                                                                                                                                | npm scope 所有权与 registry 正式发布                          |

## 3. 本轮关键修复

- Provider 从“endpoint + protocol”升级为可版本化的 capability/compatibility/reliability profile；
- 修复 Session 校验丢弃 reasoning continuation state：OpenAI `reasoning_content` 与 Anthropic
  thinking/signature block 可完整持久化和工具轮回放，分享时无条件移除；
- Kimi K3、Qwen、GLM、DeepSeek V4、MiniMax M3 的 reasoning/tool 方言采用条件字段，不再粗暴
  共用同一 OpenAI-compatible payload；
- 引入有界网络/429/5xx 重试与 `Retry-After`，并输出可观测 retry event；
- 企业配置对 Provider、model、extension、remote media、Sandbox 和 audit fail-closed；
- HMAC-SHA-256 链式审计只记录摘要/大小等必要元数据，不复制 Prompt 或 Tool output；
- Share Server 默认认证，增加 constant-time token、可信 signer、最大年龄和限流；
- CLI/SDK 使用同一隔离和扩展策略，并由 `focuscode doctor` 汇总 readiness；
- Mid-turn steering 差距完全关闭：`SteeringQueue.remove/removeLatest/drainOne`、
  `CodingAgent.listSteering()/unsteer(id?)` 与 `steering_removed` 事件，RPC 暴露
  `unsteer`/`steering_list`，TUI 增加 `/unsteer [id]`；新增
  `AgentRuntimeOptions.steeringDelivery: "all" | "one-at-a-time"`（默认 all），配置/CLI/SDK
  全透传；
- Kernel 主链内环闭环：`EffectReceiptV1` 新增可选 `grant` 字段（additive 契约变更，
  `docs/schemas/` 已重生成），LocalActionRuntime 不再丢弃 grant，Kernel 在 EffectObserved 前
  落 `GrantIssued`/`ActionStarted` 且 resume 幂等；`pnpm lint` 新增
  `export-schemas.mjs --check` 漂移门禁（11 个 schema 解析后深比较）；
- 会话路径主链收敛第一步：`agent-runtime` 新增 `effect-gateway.ts`
  （`buildActionIntent`/`receiptToToolResult`，effect→capability 映射），`CodingAgent` 可选
  注入 `EffectPort`（`effectPort`/`effectContext`），开启后 executeCall 走
  Policy→Grant→Receipt、跳过 PermissionController 单次审批，`tool_end` metadata 携带
  grantId/receiptDigest 进入 HMAC 审计；SDK 提供 `createSessionEffectSpine()` 组合 helper，
  开关 `agent.effectSpine` 当时默认 false 保持 legacy（本轮已翻转为默认 true 并完成
  Policy 单源化，见下文本轮条目）；
- TUI 六组件：`EditorBuffer`（多行、undo、kill ring、grapheme 光标）、tab 补全（斜杠命令/
  skills/prompts/扩展命令/文件路径）、EAW 宽字符列宽（修 CJK 错位）、sanitize 后渲染的
  assistant Markdown、edit 工具 diff 视图（红绿 +/- 折叠）、macOS 剪贴板图片（`/image` 无参，
  pngpaste/osascript，未真实 GUI 实测）；新增 Home/End、Ctrl+A/E、Alt+B/F、Ctrl+Z undo、
  Tab complete、Ctrl+K/Y 键绑定；
- 扩展进程外宿主：`process-extension-host.ts` + `extension-runner.ts`，每扩展一个 Node 子
  进程，stdio JSON-RPC（registerTool/Command/appendSystemPrompt/onEvent 注册，toolExecute/
  commandExecute/event/cancel 调度），崩溃隔离、60s 工具超时、env 白名单与 dispose；
  `ExtensionHostLike` 统一两种宿主，`extensions.host: "in-process" | "process"`（默认
  in-process）。这是可靠性隔离与权限运行时强制挂点，不是安全沙箱。
- 副作用链完全收敛（HA 对照问题 1）：规则语义单源于 `action-domain`（新增
  `shell-policy.ts`：classifyShell/commandReferencesPath/apply_patch 路径提取，
  ApprovalMode 矩阵进入 PolicyConfig）；内核盲区修复——Shell 命令文本引用保护路径
  （如 `cat ~/.ssh/id_rsa`）内核侧同样 deny；`PermissionController` 降级为本地 adapter；
  `agent.effectSpine` 默认翻为 true，legacy 直执降为显式逃生门（`effectSpine: false`）；
  spine 路径补 `approval_required` 事件（载荷与 legacy 一致，事件顺序的结构性差异已
  注释），`changeApproval` 热切换穿透 spine；differential 平价测试
  `packages/sdk/test/session-spine-parity.test.ts` 6 例锁定两路径等价；
- 持久化硬化与崩溃语义（HA 对照问题 2 文件层）：FileFactStore/SessionStore/AuditJournal
  append 全部 fsync；checkpoint tmp fsync→rename→目录 fsync；loadEvents 逐条 digest 重验
  （篡改 fail-closed）；torn-tail 仅容忍最后一行；stale 锁带 pid+时间戳 TTL 抢占（修复
  崩溃后永久 2s 超时死锁）；崩溃窗口 B（checkpoint 新于 events）从 events 重建不再 wedge；
  窗口 C 按 HA 计划 §4.2 落地——`ActionStarted` 先落盘，恢复发现 started-without-receipt
  时落 `EffectUnknown` 事件且不自动重执行；
- Provider 可靠性（HA 对照问题 6 代码层）：`circuit-breaker.ts`（per provider/model 熔断，
  阈值 5、30s 冷却 half-open 探测、per provider 并发信号量 8 排队）；退避加 jitter；
  maxRetries 默认统一为 2；企业 allowlist 支持 `provider/model@revision` pin（无 revision
  fail closed），五系 preset 填占位 revision（注释"生产必须替换为实测 revision"）；
  `system_fingerprint` 漂移检测（fail/warn/off，企业默认 warn，缺失计 drift）；
  `CertifiedModelRefSchema` 加可选 `expiresAt`，kernel 过期 fail-closed；32 个协议
  fixtures（evals/protocol 五系 text/reasoning/tool/usage/abort/overflow，kimi/minimax
  含 image，按公开文档手写非真实录制）+ 任意分片回放；env 门控 live 脚手架
  （FOCUSCODE_LIVE_PROVIDERS，默认跳过）；deepseek-specific ablation 对照 pack；
- 控制面/安全（HA 对照问题 3 部分）：harness-worker job 改 `apiKeyEnv`（明文 apiKey
  fail-closed 拒绝，摘要不含 secret）；企业模式强制扩展进程宿主（默认 process，显式
  in-process fail-closed，`init --enterprise` 模板写入）；审计 KeyProvider seam
  （EnvAuditKeyProvider，KMS 接缝）+ keyId 记录 + 轮换容忍 verify + gap 检出测试；
- 剪贴板图片遗留实测闭环：本机 macOS 真实系统剪贴板端到端验证（osascript 写 PNG →
  readClipboardImage 读回 → sha256 一致），`apps/cli/test/clipboard-image.test.ts`
  （darwin+osascript 门控）。

## 4. Apple-to-Apple 结论

| 维度                                      | 当前领先方 | 判断                                                    |
| ----------------------------------------- | ---------- | ------------------------------------------------------- |
| 个人终端 UX、Provider 目录、会话/扩展生态 | Pi         | Pi 0.80.10 更成熟，FocusCode 尚未达到其编辑器和生态深度 |
| 默认权限、保护路径、隔离 fail-closed      | FocusCode  | 架构和代码更完整，但真实基础设施 Gate 未跑完            |
| 企业审计与允许列表                        | FocusCode  | HMAC 链、模型/扩展/media policy 是明确差异化            |
| Compaction、长期稳定性、实战证据          | Pi         | FocusCode 缺长期使用和同模型 Repo A/B 证据              |
| 总体 Coding 成功率                        | 未证实     | 没有相同模型、预算、仓库和验收脚本的数据，不能宣称领先  |

完整逐项证据见 [V0.4_PI_APPLE_TO_APPLE_REVIEW.md](V0.4_PI_APPLE_TO_APPLE_REVIEW.md)。

## 5. 原工程 Epic 映射

| Epic                    | 当前状态       | 说明                                                                                                                                             |
| ----------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| E01 Canonical Contracts | Beta           | 11 Schema、digest、ports、strict validation                                                                                                      |
| E02 Focus Kernel        | Alpha/Beta     | 状态、预算、atomic rejection、checkpoint、verification gate                                                                                      |
| E03 Action Runtime      | 部分           | 本地 Policy/Receipt/Ledger；崩溃窗口 C 落 EffectUnknown 不盲重试；无 durable reconciliation/remote 写路径                                        |
| E04 Event/Asset         | 部分           | File Fact/Checkpoint/Memory/Session/share；文件层已全路径 fsync、digest 加载重验、torn-tail 容忍与窗口 B/C 语义；无 PostgreSQL/事务/outbox       |
| E05 Model Gateway       | Beta，单 spine | 审计 JSON Pack + 会话四协议 native streaming；会话工具调用默认走 Policy→Grant→Receipt spine，规则语义单源 action-domain，legacy 直执为显式逃生门 |
| E06/E07 Open Model Pack | Beta profile   | 五系 profile/方言；无 live revision 质量证书                                                                                                     |
| E08 Context             | 部分           | branch/compaction/multimodal/provider state；无 symbol/LSP retrieval                                                                             |
| E09 Edit/Verify         | 部分           | edit/patch/bash/git；无 affected-test planner/LSP                                                                                                |
| E10 CLI                 | Beta           | 六入口、TUI、OAuth、多模态、npm；无 VS Code/ACP client                                                                                           |
| E11 Enterprise Memory   | 基础           | asset/share/audit；未接长期 retrieval/ranking                                                                                                    |
| E12 Protocol Gateways   | 合约级         | MCP/ACP/A2A 非完整认证网络实现                                                                                                                   |
| E13 Native Capsules     | 未开始         | manifest classification，无 signed runtime capsule                                                                                               |
| E14 FocusBench          | 测试底座       | 无真实多模型 Repo 矩阵/证书                                                                                                                      |
| E15 SRE/Release         | Beta           | CI/coverage/npm/doctor；无 SBOM/canary/SLO/production image attestation                                                                          |

## 6. Stop conditions

- 目标平台未实跑 physical Sandbox 前，不宣称可安全执行不可信仓库；
- Extension 未进独立 capability sandbox 前，不开放默认自动安装的公共市场；
- 无 durable receipt/reconciliation 前，不开放多 Worker 自动写和高价值外部副作用；
- 无组织身份/ACL/retention 前，不把 Share Server 当成公共多租户服务；
- 无真实同模型 A/B 前，不宣称总体优于 Pi；
- npm scope 未由 Owner 正式发布前，只承诺 tarball clean install。

## 7. 下一阶段优先级

1. HA 计划剩余外部 Gate：PostgreSQL/事务/RLS/outbox（HA-101-103）、Temporal durable
   workflow（HA-104/105）、K8s 多副本/PDB（HA-203/207）与 remote 写路径（HA-2xx，未开始）、
   真实 OIDC IdP/RBAC 落地、SPIFFE/KMS/WORM（HA-305/306/309）、OTel/SLO（HA-501/502）；
2. 五系 Provider live smoke 与固定模型 revision 证书签发（协议 fixtures 回放已落地，
   live 脚手架 env 门控；preset 占位 revision 必须替换为实测值）；
3. Docker/runsc CI 攻击矩阵和 disposable VM provision/attest/destroy（HA-302，本机无
   docker）；
4. Extension WASI/capability 安全沙箱（HA-308；进程模式已提供崩溃隔离，但非安全
   containment）；
5. Effect kill-point 矩阵全项自动化与 Session WAL/migration/repair（窗口 B/C 语义已确定
   并测试，矩阵其余项未自动化）；
6. Pi 10–30 Repo 同模型 A/B（HA-508）、24h soak 和性能预算；
7. Pi 级编辑器深度（selection/IME/组件生态）、结构化 compaction 与 LSP retrieval。
