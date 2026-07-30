# FocusCode v0.5.0 全局深度审查报告

> 审查日期：2026-07-29（Asia/Shanghai）
> 审查基线：`main` + 未提交的 P0/P1 修复（HEAD = `62c4642`）
> 审查方式：4 路并行只读深查（agent-runtime / SDK+CLI / persistence+sandbox+auth / 测试+文档）+ 全量验证门禁
> 审查性质：只读审查 + 既有修复验证；本报告不修改生产代码

## 1. 执行摘要

### 总体判断

FocusCode v0.5.0 不是空壳项目：分层 monorepo、严格 TS、1,688 项自动化测试、以及若干正确的安全设计
（WorkspaceGuard realpath 围栏、沙箱 fail-closed 链、凭据 AEAD、Action/Grant/Receipt 合约、
torn-tail truncate 修复）都是真实存在的。上一轮（2026-07-28）审查报告的 4 个 P0 中，
**P0-1（legacy 侧）、P0-2、P0-3、P0-4 已修复并有强测试**；12 个 P1 中的 5 个也已闭环。

但本轮审查发现**一个新的 P0 级缺口，且它是已修复 P0-1 的镜像**：

> **默认 effect spine 路径完全绕过 PrefixRuleEngine。**
> 用户经 `--command-rules` 声明的 prefix deny 规则（如 deny `rm`、`git push --force`）
> 在默认配置（`agent.effectSpine=true`）下**静默失效，无任何告警**。
> legacy 路径修好了"allow 绕过 hard deny"，spine 路径却连整个规则引擎都不接入——
> split-brain 没有消除，只是换了半边。

在 spine 接入 prefixRules 之前，README 宣称的 G8 execpolicy 能力**在默认路径上不成立**，
不建议依赖 `--command-rules` 做任何安全兜底。

### 风险分布（本轮）

| 级别 | 数量 | 含义                                                         |
| ---- | ---: | ------------------------------------------------------------ |
| P0   |    1 | spine 路径 prefixRules 缺失（新发现）                        |
| P1   |   12 | SDK 组装不一致、审计链不完整、流式契约、锁/沙箱/网络残留缺口 |
| P2   |   10 | 体验、文档漂移、边界检查机制、覆盖盲区                       |

### 维度评分

| 维度         |   评分 | 判断                                                                                                |
| ------------ | -----: | --------------------------------------------------------------------------------------------------- |
| 架构分层     | 7.5/10 | 包边界清楚；但组合逻辑下沉不够（buildModelClientChain 在 apps/cli），双路径行为漂移是主要结构性风险 |
| 代码可维护性 | 7.5/10 | 严格 TS、命名清楚；新增修复代码注释质量高                                                           |
| 安全边界     | 5.5/10 | legacy 路径已硬；spine prefixRules、MCP exact allowlist、SSRF DNS、seatbelt PATH/SBPL 是关键缺口    |
| 可靠性/恢复  | 6.0/10 | torn-tail 已修；锁租约无 heartbeat、receipt 无持久化、fallback 归因缺失使承诺打折                   |
| 自动化测试   | 8.0/10 | 1,688 通过、新增回归测试断言强；live Provider/Seatbelt/macOS 集成 CI 盲区仍在                       |
| 文档可信度   | 4.5/10 | 版本号 8 处过期、TEST_REPORT 自相矛盾、execpolicy 子命令超前声明、历史报告无 archive 标记           |
| 发布成熟度   | 6.0/10 | 版本硬编码已修，verify 全绿；但 spine P0 未清前不应标记安全候选                                     |

### 与 2026-07-28 报告的对账

| 原报告项                               | 状态                          | 证据                                                                                           |
| -------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------- |
| P0-1 legacy allow 绕过 hard deny       | **已修复**                    | permissions.ts:116-169（deny→engine→allow 顺序）；execpolicy-split-brain.test.ts 7 例          |
| P0-1 spine 侧 execpolicy 传播          | **未修复（新定 P0）**         | effect-spine.ts:36-40/180-193 无 prefixRules；agent.ts:922-923 spine 跳过 PermissionController |
| P0-2 MCP pin serverVersion/annotations | **已修复**                    | mcp.ts:628-668；mcp-pin-serverversion.test.ts 7 例                                             |
| P0-3 torn-tail 不截断                  | **已修复**                    | file-fact-store.ts:189-208、session-store.ts:351-371（truncate+fsync）；两侧字节级测试         |
| P0-4 web_fetch SSRF                    | **已修复（初跳+重定向逐跳）** | web-tools.ts:188-266/329-368；web-tools-ssrf.test.ts 18+ 例。DNS rebinding 残留为 P1           |
| P1-1 fallback model ID/流式隔离        | **已修复**                    | fallback-model-client.ts:83-138；fallback-model-switch.test.ts。winner 归因残留为 P1           |
| P1-4 MCP HTTP 共享 AbortController     | **已修复**                    | mcp.ts:537-598 per-request controller；mcp-http-abort.test.ts 含时序推导并发回归               |
| P1-7 Checkpoint realpath               | **已修复**                    | checkpoints.ts:45-50/62-77/123-136；checkpoint-realpath.test.ts 字节级 symlink 用例            |
| P1-10 release gate 版本硬编码          | **已修复**                    | verify-npm-package.mjs:32-36 从 package.json 读取                                              |
| P1-11 SpecEngine 并发保护              | **已修复**                    | agent.ts:286-287 running 闸门前移；agent-concurrency.test.ts 3 例                              |
| P1-2 preToolUse 双执行                 | **未修复**                    | coding-agent.ts:156-175 veto 管线 + hooks.ts:221-229 tool_start 分发双跑                       |
| P1-3 streamSubmit error 即终止         | **未修复**                    | async-iterable.ts:119、run-coding-agent.ts:89                                                  |
| P1-5 SDK 忽略 process extension host   | **未修复**                    | coding-agent.ts:115 永远 new ExtensionHost                                                     |
| P1-6 spine receipt 仅内存              | **未修复**                    | effect-spine.ts:94-98 不传 journal；FileReceiptJournal 全仓仅测试引用                          |
| P1-8 锁租约无 heartbeat                | **未修复**                    | file-fact-store.ts:129-142 只看年龄；session-store.ts:507-518 TTL 后无条件判死                 |
| P1-9 seatbelt PATH/SBPL                | **未修复**                    | seatbelt.ts:52 裸命令名、:121-139 无转义插值                                                   |
| P1-12 circuit breaker 取消/分类        | **未修复**（本轮未深挖）      | circuit-breaker.ts 维持原状                                                                    |

## 2. 当前能力清单（已验证）

### 2.1 两条执行路径

- **会话型 CodingAgent**（agent-runtime）：Session 树（branch/fork/compaction/JSONL reload/HTML export）、
  工具循环、steering（append/interrupt/follow-up）、doom-loop 检测（指纹=工具名+参数，阈值 3，
  终态保护正确）、输出截断保护（stopReason=length 拒绝半成品 tool call）、
  默认 effect spine（LocalActionRuntime），legacy 路径保留。
- **审计型 Focus Kernel**（harness-core + persistence）：Intent/Grant/Receipt、append-only event log
  （fsync + digest + 乐观版本）、checkpoint（临时文件+rename+目录 sync）、崩溃恢复 UNKNOWN 语义、
  确定性完成 Gate。

### 2.2 安全能力（已验证为真）

- **legacy 权限链**：prefix deny → PolicyEngine hard deny → prefix allow（仅提软决策）→ approval matrix；
  hard deny 不可被 prefix allow 或用户 approval 覆盖。
- **MCP pin**：serverVersion + schemaDigest（含 name/description/inputSchema/annotations）+
  transportDigest 三项全比对，缺失工具 fail-closed；stdio 子进程环境白名单。
- **SSRF 初跳+重定向逐跳防护**：http/https only、禁内嵌凭据、私网/loopback/link-local/云元数据拒绝、
  redirect:"manual" 每跳重校验、5 跳上限、2MB 响应体上限。
- **沙箱**：auto 链 gVisor→Docker→seatbelt→（仅显式允许时）Host，否则 fail；
  Docker 容器 `--read-only --cap-drop ALL no-new-privileges --network none 资源限额 非 root --init`；
  企业模式强制非 Host + digest 镜像 + `--pull never`。
- **凭据**：AES-256-GCM、0600、独占创建密钥、临时文件 rename。
- **Checkpoint**：capture/restore 均过 WorkspaceGuard realpath，逃逸 symlink 跳过；0700/0600。
- **fallback**：模型 ID 按链环重写、流式事件 attempt 级缓冲（winner 确认后才 flush）、
  408/409/425/429/5xx/熔断可 failover，Abort/Timeout 不消耗预算。
- **MCP HTTP**：per-request AbortController + AbortSignal.any 合并 close 信号，单请求超时不污染连接。
- **SpecEngine 并发**：submit 的 running 闸门在所有 I/O 与模型调用之前。

### 2.3 工程能力

- 全量测试：**150 文件通过 / 1,688 用例通过 / 11 跳过 / 0 失败**（pnpm build && vitest run）。
- 覆盖率 Gate 通过：lines 82.07 / statements 79.01 / functions 85.16 / branches 69.72。
- `pnpm verify`（边界检查 + schema 同步检查 + prettier + build + 覆盖率）全绿。
- 新增 8 个 P0/P1 回归测试文件全部通过，断言为字节级/事件序列级行为验证（非冒烟）。

## 3. P0：发布前必须修复

### P0（新）：effect spine 路径不传播 prefixRules，execpolicy 在默认配置下静默失效

**证据链**

1. `packages/sdk/src/effect-spine.ts:36-40` — `SessionEffectSpineOptions.permission` 只有
   `mode/projectTrusted/protectedPaths`，结构上不接受 prefixRules。
2. `packages/sdk/src/effect-spine.ts:180-193` — `sessionPolicyConfig` 不含 prefixRules；
   `action-domain` 的 `PolicyConfig`（policy.ts:25-46）也没有该字段，PolicyEngine 不引用
   PrefixRuleEngine（shell-policy.ts:506 独立存在）。
3. `apps/cli/src/agent-command.ts:311` — prefixRules 只放进 `CodingAgent.permission`；
   同文件 276-289 创建 spine 时不传。
4. `packages/agent-runtime/src/agent.ts:922-923` — spine 启用时走 `executeCallViaSpine`，
   注释（agent.ts:968）明确"The local PermissionController is skipped"，而 prefix 规则只活在
   PermissionController 里（permissions.ts:82,116-169）。
5. `agent-runtime/src/config.ts:848` — `effectSpine: merged.agent?.effectSpine ?? true`，
   **默认开启**，即默认路径下规则必然不生效。
6. 连带：`effect-spine.ts:213-217` 的 `policySnapshot = sha256({mode, projectTrusted, protectedPaths})`
   不含规则集 digest——规则既不执行，receipt/audit 也无法证明其在场。

**影响**

- 用户显式配置的 deny 规则（企业最常见的"禁 rm -rf、禁 force push"诉求）在默认配置下完全失效，
  且无任何启动告警。
- README 的 G8 execpolicy 声明与 `--command-rules` 帮助文本在默认路径上构成虚假承诺。
- legacy/spine 同输入不同判的 split-brain 仍然存在（方向与修复前相反）。

**修复方向**

1. `SessionEffectSpineOptions.permission` 增加 `prefixRules`；在 spine 决策链（submit 前或
   PolicyEngine 内）接入 PrefixRuleEngine，语义与 permissions.ts:116-169 完全对齐
   （deny 短路优先；allow 不得覆盖 hard deny，仅提 approval_required→grant）。
   更优：把 PrefixRuleEngine 下沉为 PolicyEngine 的附加约束层，两条路径天然同判。
2. 规则集内容 digest 并入 `policySnapshot`。
3. 过渡期护栏：effectSpine + commandRulesPath 同时出现时启动告警（或直接报错），禁止静默。
4. 阻断测试：spine=true/false 下 `allow rm + rm -rf /`、`deny git + git status` 必须同判。

## 4. P1：高优先级缺口

### P1-A SDK 组装与 CLI 不一致（三处）

1. **fallback chain 被丢弃**：sdk/coding-agent.ts:225-228 只 `createModelClient(config.model)`，
   从不引用 `config.fallbackModels`，也无 CircuitBreaking 包装；`buildModelClientChain` 定义在
   apps/cli（model-client-wiring.ts:35-54），SDK 无法复用——组合逻辑放在了错误的层。
2. **`extensions.host:"process"` 被忽略**：coding-agent.ts:115 永远 `new ExtensionHost`；
   而 config.ts:1770-1772 企业模式**强制** process host。SDK 嵌入方企业部署直接违背策略意图。
   `CreatedCodingAgent.extensions` 类型固化为具体类，需放宽为 ExtensionHostLike。
3. **修复方向**：buildModelClientChain 上移到 agent-runtime 或 sdk，SDK/CLI/ACP 三处统一。

### P1-B preToolUse 每次工具调用执行两次

SDK 把 hook 经 `registerBeforeToolHook` 接入 veto 管线（coding-agent.ts:156-175，两条执行路径都会
调 checkBeforeTool），同时 `tool_start` 事件又经 hooks.ts:221-229 再调一次同一 hook 且丢弃返回值。
副作用型 hook（计费、遥测、外部通知）全部翻倍；且 veto 拒绝后 tool_start 仍发出，语义不对称。
修复：preToolUse 只走 veto 管线，tool_start 分发跳过它。

### P1-C streamSubmit/runCodingAgent 把可恢复 error 当终态

async-iterable.ts:119 与 run-coding-agent.ts:89 对任何 `type:"error"` 事件 return；
但 agent.ts:494-511（截断恢复）与 544-550（doom-loop）的 error 事件后 agent 仍会继续到 agent_end。
消费者在可恢复 error 处被截断，丢失后续事件流。另有死代码 `rejectNext`（赋值从未调用）、
streamSubmit 缺 unhandled-rejection 防护、事件队列无上限无 backpressure（P2）。
修复：仅以 agent_end 或 submit settle 为终态；error 分级（recoverable/fatal）。

### P1-D spine receipt 仅内存，无 ReceiptJournal 注入

effect-spine.ts:94-98 创建 LocalActionRuntime 不传第 5 参 journal；local-action-runtime.ts:52-54
无 journal 时 `journalReceipts()` 返回 []；FileReceiptJournal 全仓仅测试引用。
进程重启后审计链断裂，"Policy→Grant→Receipt"在 session spine 上只是进程内可观测性。
修复：组合根注入 FileReceiptJournal（如 `~/.focuscode/receipts/<sessionId>.jsonl`），
文档同步明确 durability 边界。

### P1-E ACP 组装与 CLI 严重背离

acp-server.ts:103-128 的 createAgent：无 spine、无 extensionHost、无 MCP、无 enterpriseAuditJournal
（企业审计 fail-open）、permission 无 approve handler 却广告 `approval:"coarse"`、
stdin 循环 `await handleMessage` 被 session/prompt 阻塞导致 `session/cancel` 回合中失效却广告
`cancel:true`、事件归属用全局 currentSessionId（多 session 串扰）、忽略 --command-rules。
修复：ACP 与 agent-command 收敛到同一组装函数；prompt 处理不阻塞消息循环。

### P1-F 锁租约模型（persistence + session-store）

- FileFactStore.tryStealStaleLock（file-fact-store.ts:129-142）只看 acquiredAt，写入的 pid 从不使用；
  withTaskLock 的 finally 无条件 unlink 锁（:119-122），锁被偷后会删掉第三方新锁。
- SessionStore.isLockLive（session-store.ts:507-518）超 30s 无条件判死，无 heartbeat；
  fork() 持锁 O(n²) 复制极易超租约。
- append O(n)：每次完整 load+逐行 digest 校验（file-fact-store.ts:149），大日志单次 append 即可超
  租约，与锁缺陷耦合成重复 seq 的静默损坏。
- torn-tail truncate 对**无锁只读调用方**（control-api:69、SessionStore.load/list）有破坏活文件的
  风险——truncate 应仅在持锁时执行，无锁路径只容错读。

### P1-G seatbelt 三处

1. seatbelt.ts:52 默认裸 `"sandbox-exec"` 走 PATH（safeEnvironment 透传 PATH），伪造二进制可静默
   取消全部 containment——应固定 `/usr/bin/sandbox-exec`。
2. buildProfile（:121-139）workspace/nodeBin/shell 直接插值 SBPL 双引号字符串，无转义——路径含
   引号可注入 `(allow ...)` 规则逃逸。
3. health() 用 `sandbox-exec --version` 探测（:84-85），真实 macOS 不支持该参数，集成测试自认
   "skip gracefully"——auto 链上 seatbelt 很可能恒 unavailable。

### P1-H 进程组未终止

process-runner.ts:25-28 terminate 只 kill 直接子进程，未设 detached/无 process group kill，
Host/Seatbelt 下 `sh -lc '... &'` 超时后孙进程残留写 workspace（Docker 路径已由 rm --force 补偿）。
修复：POSIX detached + kill(-pgid)，Windows Job Object。

### P1-I OIDC formRequest 无 timeout/响应上限

oauth.ts:190-222 的 token/device/revoke 请求无 signal、response.text() 无上限（discovery.ts 已有
15s/1MB，未复用）；device 轮询期间单请求挂死无超时。另有 loopback 豁免
`startsWith("http://127.0.0.1")` 可被 `http://127.0.0.1@evil.com` userinfo 绕过（P2）。

### P1-J control-api 非 loopback 无鉴权

apps/control-api/src/index.ts 无任何 auth/TLS/bind 检查，FOCUSCODE_CONTROL_HOST=0.0.0.0 即公开
任务列表与全量 events（可含敏感代码/对话）；且其无锁 loadEvents 会触发 P1-F 的 truncate 联动，
一次查询可能损坏 worker 正在写的日志。修复：复用 share-server 的 token 模式，非 loopback fail-closed。

### P1-K MCP 额外工具仍注册（exact allowlist 缺失）

registerMcpServers（mcp.ts:717-725）在 pin 校验后注册**所有**观测到的工具，pins 只是子集校验。
被升级/攻陷的 server 新增任意工具可无校验进入注册表；enterprise 策略（config.ts:1735-1775）也无
MCP 精确 allowlist 项。修复：`mcp.exactPins`（企业默认 true），对观测-声明差集 fail-closed。

### P1-L 其余单项

- **fallback winner 归因缺失**：ModelResponse 无 servedModel 字段，model_start 恒报 primary，
  usage/成本全部错误归因 primary，onFallback 仅写 stderr 不进审计。
- **web_fetch 无 DNS 校验**：isPrivateAddress 只查 hostname 字面量，公网域名解析到私网可直穿
  （DNS rebinding）；修复需 lookup 后校验全部 A/AAAA 并以解析 IP 直连。

## 5. P2：设计债与盲区

| #     | 问题                                                                                                 | 证据/说明                                                                                            |
| ----- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| P2-1  | abort() 在 SpecEngine clarify 阶段无效                                                               | agent.ts:344 controller 在 clarify 后创建，clarify 只收 externalSignal；5 级小模型流水线期间无法取消 |
| P2-2  | fallback 流式体验退化                                                                                | 配置 fallback 链后，winner buffer 在 complete() resolve 后才 flush，TUI 逐字流变整段倾倒             |
| P2-3  | IPv4-mapped IPv6 绕过 SSRF 检查                                                                      | `[::ffff:127.0.0.1]` 规范化后不匹配 ::1/fc00/fe80 任一规则                                           |
| P2-4  | checkpoint manifest 无 digest/形状校验；capture 失败记 existed=false 会致 restore 误删原文件         | checkpoints.ts:63-77/196-202                                                                         |
| P2-5  | extension-runner.ts 0% 覆盖（子进程测量盲区）；tui/app.ts branches 39.28%；workspace.ts lines 65.62% | coverage-summary.json；建议对安全边界文件设 per-file 阈值                                            |
| P2-6  | 鼠标解析是死代码                                                                                     | app.ts:1585-1598 handler no-op；全仓无 `?1000h/1006h` 上报开启序列                                   |
| P2-7  | check-boundaries.mjs 是字符串 includes() 扫描                                                        | 相对路径/间接动态 import 可绕过；6 个包无规则；注释会误报。建议 TS compiler API / dependency-cruiser |
| P2-8  | live Provider（11）与 Seatbelt 集成（2）、macOS 剪贴板（1）CI 恒跳                                   | live-providers.test.ts:42；seatbelt-sandbox.test.ts:202,224。建议 nightly live 矩阵                  |
| P2-9  | 文档漂移（见第 6 节）                                                                                | 8 处版本号过期、TEST_REPORT 自相矛盾、execpolicy 子命令超前声明、14 份历史文档无 archive 标记        |
| P2-10 | OAuth loopback 豁免 userinfo 绕过；凭据库 save 无 fsync；share-server 非 loopback 无 TLS 告警        | oauth.ts:273-279；credential-store.ts:134-136                                                        |

## 6. 文档一致性核查

| 文档声明                                                                                    | 实际                                                                                                 | 判断                           |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------ |
| README G8 execpolicy（声明式规则 + --command-rules）                                        | 规则引擎与 CLI flag 真实存在，但**默认 spine 路径不生效**；`focuscode execpolicy check` 子命令不存在 | **部分虚假**                   |
| SDK_GUIDE `"execpolicy"` 配置键                                                             | config.ts 无解析                                                                                     | **超前于代码**                 |
| TEST_REPORT.md "本轮 release:check 全部通过"                                                | 同文件另一节自述本轮只跑了 verify；覆盖率/测试数/引用 tgz 均过期                                     | **自相矛盾，需由 CI 自动生成** |
| AGENTS.md（0.4.0-beta.2）、SECURITY.md（beta1）、DEVELOPMENT_STATUS.md（v0.4 Beta2）等 8 处 | 代码 0.5.0                                                                                           | **过期**                       |
| SECURITY.md 未提 seatbelt                                                                   | AGENTS.md 已记录 seatbelt 能力                                                                       | **过期**                       |
| "Session 无 fsync"（SECURITY.md）                                                           | 当前代码已 fsync                                                                                     | **过时表述**                   |
| docs/compare、docs/reviews 14 份历史报告                                                    | 无一份有 archive 标记（deep-review 自己建议过却未执行）                                              | **待整理**                     |
| mouse 支持                                                                                  | 文档侧无虚假声明（如实记录为未实现）；代码侧解析层为死代码                                           | **表述克制，代码待清理或完成** |

## 7. 测试质量评估

### 正面信号

- 新增 8 个回归测试文件全部为行为级断言：字节级（torn-tail 截断后逐字节相等）、事件序列级
  （fallback LEAKED-PARTIAL 不外泄且事件数组精确相等）、时序推导级（mcp-http-abort 的
  T=0/50/200/230/250ms 并发窗口）、symlink 攻击面级（checkpoint 外部 victim 字节不变）。
- 无任何 TODO 式禁用测试；skip 全部是 env/平台门控且有注释说明。
- property-based、SSE 分片、权限 differential、crash-window、extension process、TUI snapshot 均有覆盖。

### 盲区

1. spine 路径无 execpolicy 测试（正是 P0 漏网原因）——spine=true/false 同判测试必须进 release gate。
2. web-tools-ssrf 只测 URL 字面量判定，未测 DNS rebinding 与重定向到私网的纵深（重定向逐跳在
   实现中已做，测试只覆盖字面量层）。
3. extension-runner 无进程内单测；tui/app.ts 交互路径大面积未测。
4. Seatbelt 真实隔离与 live Provider 契约 CI 无保障。

## 8. 验证结果

| 检查                                           | 结果                                                                         |
| ---------------------------------------------- | ---------------------------------------------------------------------------- |
| 架构边界检查（check-boundaries + schema sync） | 通过                                                                         |
| prettier --check                               | 通过                                                                         |
| pnpm build（22 包）                            | 通过                                                                         |
| 全量测试                                       | 150 文件 / 1,688 用例通过，0 失败                                            |
| 覆盖率 Gate（75/60/80/80）                     | 通过（79.01/69.72/85.16/82.07）                                              |
| pnpm demo / agent:demo / npm:verify            | 本轮未重跑（版本硬编码已修，verify-npm-package.mjs:32-36 改读 package.json） |

## 9. 整改建议（按优先级）

### 立即（发布阻断）

1. **spine 接入 prefixRules**（P0）：规则下沉 PolicyEngine 或经 SessionEffectSpineOptions 传入，
   deny 优先/allow 不越 hard deny，digest 入 policySnapshot，spine=true/false 同判测试进 gate；
   过渡期 effectSpine+commandRules 同现即告警。

### 本周

2. buildModelClientChain 上移到可复用层，SDK/CLI/ACP 统一组装（连带修 SDK fallback 缺失）。
3. SDK 按 config.extensions.host 选择 ProcessExtensionHost；extensions 类型放宽为 ExtensionHostLike。
4. preToolUse 单点触发（保留 veto 管线）。
5. streamSubmit 终态只认 agent_end/submit settle；队列加 backpressure；删 rejectNext 死代码。
6. ACP 与 agent-command 收敛同一组装函数（spine/扩展/MCP/审计/审批桥），prompt 不阻塞 cancel。
7. 锁与 truncate：两个 store 的 truncate 仅持锁执行（无锁只容错读）；锁加 pid 查活+heartbeat；
   append 用缓存计数替代全量 load。
8. seatbelt：固定 /usr/bin/sandbox-exec、SBPL 插值白名单校验、health 探测改 `sandbox-exec -n /usr/bin/true` 类真实探针。

### 本月

9. spine 注入 FileReceiptJournal；MCP exactPins 企业默认；web_fetch DNS 解析校验+解析 IP 直连。
10. control-api token 鉴权 + 非 loopback fail-closed；OIDC formRequest 统一 bounded transport。
11. fallback servedModel 归因（Response 字段 + AgentEvent + usage 按模型维度）。
12. 文档：版本号统一 0.5.0、TEST_REPORT 由 CI 生成、历史报告加 archive 标记、README/SDK_GUIDE
    删除或实现 execpolicy 超前声明。
13. check-boundaries 升级为 AST/import graph；安全边界文件设 per-file 覆盖率阈值；
    nightly live-provider + macOS seatbelt 矩阵。

## 10. 结论

上一轮审查指出的"跨层组合没有被测试为一个产品"仍然是核心症结，本轮以镜像形式再现：
legacy 权限链修得越硬，默认 spine 路径绕过 PrefixRuleEngine 的缺口就越刺眼。
代码单点质量在稳步提高（本轮 9 项修复全部带强测试且全量回归绿灯），
但**组合根的一致性**（CLI/SDK/ACP 三处组装漂移）与**默认路径的策略完整性**
是 v0.5.0 走向安全发布候选前必须跨过的两道门槛。

建议发布决策：

- 开发/研究/受控本地 Beta：**有条件通过**（不使用 --command-rules 做安全兜底时）。
- 依赖 execpolicy、企业审计、SDK 嵌入、ACP 集成的场景：**不通过**（先清 P0 + P1-A/B/D/E）。
- 企业生产/HA/审计合规基线：**不通过**（另需 receipt 持久化、锁模型重构、live 矩阵）。
