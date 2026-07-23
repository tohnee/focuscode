# FocusCode v0.4 Beta2 测试报告

报告日期：2026-07-20  
被测版本：`0.4.0-beta.2`  
结论：`pnpm release:check` 全部通过，包括 Build、Unit/Integration、Coverage、Architecture、
Format、两类 Demo 和 npm clean-install/tool-loop。真实 Provider、Docker/gVisor/VM 和 Pi 实任务
胜率不在本地自动化证据范围内。

## 1. 环境

| 项目                          | 实际值                                                     |
| ----------------------------- | ---------------------------------------------------------- |
| OS                            | Linux x86_64 容器                                          |
| Node.js                       | `v24.14.0`；项目最低 `>=22.12.0`                           |
| pnpm                          | `11.7.0`                                                   |
| TypeScript                    | `5.9.3`                                                    |
| Vitest                        | `4.1.10`                                                   |
| Provider fixtures             | Scripted + 本地 OpenAI/Anthropic/Responses/Gemini SSE/JSON |
| External model requests       | 无                                                         |
| Docker/runsc/Firecracker/QEMU | 当前机器未安装                                             |
| SSH VM                        | 未配置远端测试 VM                                          |

## 2. 自动化结果

执行：`pnpm test:coverage`。

| 指标                |                   结果 | Gate |
| ------------------- | ---------------------: | ---: |
| Workspace projects  |            23/23 build | PASS |
| Test files          |                  26/26 | PASS |
| Tests               |                  93/93 | PASS |
| Statements          |    77.53%（3383/4363） | ≥75% |
| Branches            |    65.24%（2414/3700） | ≥60% |
| Functions           |      82.75%（624/754） | ≥80% |
| Lines               |    81.85%（3181/3886） | ≥80% |
| Audited Kernel demo |                   PASS | PASS |
| Agent demo          | PASS（2 model rounds） | PASS |
| npm clean install   |                   PASS | PASS |
| Installed tool loop | PASS（2 model rounds） | PASS |

机器可读 coverage：`reports/coverage/coverage-summary.json`；HTML：
`reports/coverage/index.html`；npm 验证：`reports/npm/verification.json`。生成 tarball 为
`focuscode-cli-0.4.0-beta.2.tgz`，139,035 bytes，SHA-256
`2f819898ecb804afb7177ae0b664d25a973cc1a7b2fcc6c6380b9b2106eeb9bf`。

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

## 4. 完整 Gate

```bash
pnpm lint
pnpm test:coverage
pnpm demo
pnpm agent:demo
pnpm npm:verify
```

聚合命令：`pnpm release:check`。本次已实际执行并通过。`npm:verify` 重新 bundle、打包、在临时
目录禁脚本洁净安装，核对文件 allowlist 和版本，并让已安装 CLI 通过本地 SSE Provider 完成
两轮 Tool loop。

## 5. 不能从本报告推断

- 五家外部 API 的当前 live contract、配额、订阅 OAuth 或真实模型质量；
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
6. Session crash/WAL/migration/repair 与 Effect kill-point matrix；
7. 24h long-session/compaction/SLO soak；
8. Windows/macOS terminal 与 npm global-install matrix。
