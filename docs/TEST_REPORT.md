# FocusCode v0.4 Beta2 测试报告

报告日期：2026-07-20  
被测版本：`0.4.0-beta.2`  
结论：本轮 `pnpm verify` 全部通过，包括架构边界、schema 同步、Format、Build 和带覆盖率的
Unit/Integration；两类 Demo 与 npm clean-install/tool-loop 在同版本早前已随
`pnpm release:check` 执行通过。真实 Provider、Docker/gVisor/VM 和 Pi 实任务胜率不在本地
自动化证据范围内。

## 1. 环境

| 项目                          | 实际值                                                       |
| ----------------------------- | ------------------------------------------------------------ |
| OS                            | macOS arm64 本机（本轮）；CI 为 ubuntu + Node 22.20.0        |
| Node.js                       | `v22.23.1`；项目最低 `>=22.12.0`                             |
| pnpm                          | `11.7.0`                                                     |
| TypeScript                    | `5.9.3`                                                      |
| Vitest                        | `4.1.10`                                                     |
| Provider fixtures             | Scripted + 本地 SSE/JSON + evals/protocol 32 个手写 fixtures |
| External model requests       | 无                                                           |
| Docker/runsc/Firecracker/QEMU | 当前机器未安装                                               |
| SSH VM                        | 未配置远端测试 VM                                            |

## 2. 自动化结果

执行：`pnpm test:coverage`。

| 指标                |                   结果 | Gate |
| ------------------- | ---------------------: | ---: |
| Workspace projects  |            23/23 build | PASS |
| Test files          |    37 PASS + 1 skipped | PASS |
| Tests               |  234 PASS + 10 skipped | PASS |
| Statements          |                 79.26% | ≥75% |
| Branches            |                 69.05% | ≥60% |
| Functions           |                 84.02% | ≥80% |
| Lines               |                 83.06% | ≥80% |
| Audited Kernel demo |                   PASS | PASS |
| Agent demo          | PASS（2 model rounds） | PASS |
| npm clean install   |                   PASS | PASS |
| Installed tool loop | PASS（2 model rounds） | PASS |

本轮 `pnpm release:check`（= verify + demo + agent:demo + npm:verify）全部通过。机器可读 coverage：
`reports/coverage/coverage-summary.json`；HTML：`reports/coverage/index.html`；npm 验证：
`reports/npm/verification.json`。生成 tarball 为
`focuscode-cli-0.4.0-beta.2.tgz`，158,111 bytes，SHA-256
`55750634062e090c57a48b4945831cf1b92ba018952fe8fc835bb4756e04c9ad`。

## 3. 本轮新增回归范围

### Provider / continuation / OAuth

- 五系区域 profile、默认模型、model override 和 enterprise allowlist；
- Qwen/ZAI/DeepSeek thinking 字段、Kimi/DeepSeek reasoning effort、条件 request 字段；
- OpenAI `reasoning_content` 与 Anthropic thinking/signature block 的 capture、Session 持久化和
  tool-loop 原样回放；
- 分享 bundle 强制剥离 Provider 私有 continuation state；
- 408/409/425/429/5xx/网络错误重试与 Retry-After；
- OIDC discovery、issuer/endpoint 检查、client_secret_basic 和 revoke。

### Enterprise / TUI / media / queue

- HMAC 审计追加、内容最小化、链验证和篡改检测；
- 自定义主题/伙伴 JSON 的颜色、尺寸、帧和控制字符验证；
- 远程图片 enterprise deny 与模型 image capability gate；
- append/interrupt/follow-up 顺序和队列上限；
- 企业 Provider/model/extension/sandbox/media 配置 fail-closed。

### Sandbox / ecosystem

- digest pin、pull-never、IPC/log/网络参数与 workspace 参数注入防护；
- share auth、可信 signer、过期、限流、不可变存储和 Ed25519 验签；
- unsigned/非 allowlisted/特权扩展拒绝。

### Steering / Kernel / effect spine

- 队列取回 remove/removeLatest/drainOne、`unsteer(id?)`/`steering_removed` 事件与
  all/one-at-a-time delivery mode（steering 新增 4 项）；
- Kernel grant 断言扩展：`EffectReceipt.grant` 透传、`GrantIssued`/`ActionStarted` 落在
  EffectObserved 前、resume 幂等；
- kernel-crash-recovery：FileFactStore 跨实例 resume 不重复执行；
- effect-gateway（10 项）与 effect-spine（3 项）：effect→capability 映射、
  receipt→tool_result、注入 EffectPort 后走 Policy→Grant→Receipt、`tool_end` metadata 带
  grantId/receiptDigest；
- session-persistence：真实 JSONL 跨实例 reload、损坏行 fail-closed；
- process-extension-host（8 项）：子进程注册/调度、崩溃隔离、60s 超时、env 白名单；
- ecosystem 权限拒绝（3 项）与 sdk 企业权限拒绝（2 项）；
- SSE 任意分片 property 测试（2 项，各 100 次随机分片，含多字节字符）；
- TUI 新增 16 项：EditorBuffer、tab 补全、EAW 宽字符、Markdown、diff 与键绑定。

### HA 对照修复（本轮）

- session-spine differential parity 6 项（`packages/sdk/test/session-spine-parity.test.ts`）：
  spine 与 legacy 主链结果平价，含 `approval_required` 事件与 `changeApproval` 热切换；
- 协议 fixtures 回放 32 个（evals/protocol，五系 text/reasoning/tool/usage/abort/overflow，
  kimi/minimax 含 image；按公开文档手写，非真实录制）+ 任意分片重放；
- circuit-breaker 8 项：阈值 5 熔断、30s 冷却 half-open 探测、per provider 并发信号量 8
  排队、退避 jitter；
- kernel 崩溃窗口 B（checkpoint 新于 events → 从 events 重建）与窗口 C
  （started-without-receipt → `EffectUnknown`、不自动重执行）；
- persistence 9 项：append fsync、checkpoint tmp→rename→目录 fsync、digest 加载重验篡改
  fail-closed、torn-tail 仅容忍最后一行、stale 锁 pid+时间戳 TTL 抢占；
- audit 8 项：EnvAuditKeyProvider、keyId 记录、轮换容忍 verify、gap 检出；
- 剪贴板 1 项（darwin+osascript 门控）：真实系统剪贴板写 PNG → readClipboardImage 读回
  sha256 一致；
- model-packs/deepseek-specific ablation 对照 2 项；
- live-providers env 门控脚手架 10 项（`FOCUSCODE_LIVE_PROVIDERS` 未设，默认跳过）。

## 4. 完整 Gate

```bash
pnpm lint
pnpm test:coverage
pnpm demo
pnpm agent:demo
pnpm npm:verify
```

聚合命令：`pnpm release:check`（同版本早前已实际执行并通过；本轮执行的是
`pnpm test:coverage`/`pnpm verify`）。`npm:verify` 重新 bundle、打包、在临时
目录禁脚本洁净安装，核对文件 allowlist 和版本，并让已安装 CLI 通过本地 SSE Provider 完成
两轮 Tool loop。

## 5. 不能从本报告推断

- 五家外部 API 的当前 live contract、配额、订阅 OAuth 或真实模型质量（32 个协议 fixtures
  为按公开文档手写回放、非真实录制；live 脚手架 env 门控默认跳过，证书签发未做）；
- Docker/gVisor/VM 在目标节点隔离网络、secret、daemon、OOM 和 kernel attack；
- FocusCode 实任务成功率高于 Pi、Claude Code、Codex 或其他 Agent；
- Extension 已被安全 containment；
- Session/Effect 达到数据库级 durability 或 exactly-once；
- Share Server 达到公共多租户合规要求；
- npm registry scope 已发布或由当前 Owner 控制；
- Windows/macOS TTY、path 和 Docker Desktop 全矩阵通过。

## 6. 下一测试 Gate

1. 五系真实 endpoint smoke + 脱敏 recorded-stream differential；
2. Docker/runsc network/secret/path/socket/fork-bomb/OOM/abort suite；
3. disposable VM provision/attestation/destroy；
4. Pi 同模型、同预算、同 Repo 的 10–30 项 A/B；
5. Extension sandbox escape、registry compromise 和 revocation；
6. Session crash/WAL/migration/repair 与 Effect kill-point matrix（已部分覆盖：跨实例恢复
   与崩溃窗口 B/C 已测——窗口 C"effect 已执行 receipt 未落盘"已有确定 UNKNOWN 语义；
   WAL/migration/repair 与 kill-point 矩阵全项自动化仍未做）；
7. 24h long-session/compaction/SLO soak；
8. Windows/macOS terminal 与 npm global-install matrix。
