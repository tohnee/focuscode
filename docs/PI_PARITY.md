# FocusCode v0.3 与 Pi 的能力对照（历史基线）

> 此文档保留 v0.3 Alpha 的原始验收边界。当前逐项结论、Pi 0.80.10 取证和 v0.4 修复状态以
> [V0.4_PI_APPLE_TO_APPLE_REVIEW.md](V0.4_PI_APPLE_TO_APPLE_REVIEW.md) 为准。

本表回答“能否对同一 Coding 任务做直接 A/B”，不是未经基准的优劣排名。Pi 的具体版本会变化；
对比前应固定 Pi 版本、模型、endpoint、Prompt、权限、仓库 commit 和预算。

## 1. 可观察能力面

| 能力面            | FocusCode v0.3                                                     | 当前判断                                             |
| ----------------- | ------------------------------------------------------------------ | ---------------------------------------------------- |
| 持续 coding loop  | 流式模型 → Tool → Result → 模型；多轮与预算                        | 已具备直接 A/B 条件                                  |
| 基础 coding tools | read/write/edit/patch/grep/find/ls/bash/git status/diff            | 已具备；工具语义需任务验证                           |
| Provider          | Responses、Chat、Anthropic、Gemini；兼容/本地 preset               | 原生面较完整，不代表所有方言已认证                   |
| OAuth             | PKCE、device、refresh、多 account、加密 store、自定义 Profile      | 已实现开放标准；不伪造私有订阅 OAuth                 |
| 开源模型适配      | native/prompt-json/auto、custom endpoint/profile                   | 已具备模型差异化开关；缺正式质量证书                 |
| TUI               | 全屏、流式、审批、状态、历史、滚动、keymap/theme                   | 已具备完整 Alpha TUI                                 |
| 趣味伙伴          | 6 只多 mood 动态 ANSI 伙伴、运行时轮换                             | FocusCode 差异能力；非生产指标                       |
| 多模态            | 本地/HTTPS 图片；CLI/TUI/RPC/SDK；四协议映射                       | 已实现；受具体模型限制                               |
| Session           | JSONL、resume/fork/tree/compact/HTML                               | 已具备；durability 不及数据库                        |
| Steering          | append/interrupt bounded FIFO，generation-only interrupt           | 已具备；Tool effect 不做中途抢占                     |
| Project resources | AGENTS、Skills、Prompts、Extensions、reload                        | 已具备                                               |
| 扩展分发          | npm pack/install/remove/list、signature/integrity/permissions/lock | 已具备 Alpha；Extension 无运行时 sandbox             |
| Session share     | Ed25519、脱敏、导入/发布/下载、参考 server                         | 已具备 Alpha；无组织身份/ACL                         |
| 隔离              | 默认 gVisor→Docker→fail；SSH VM；显式 Host                         | 架构上更强调可替换隔离；本机未做真实 runtime 验证    |
| npm 安装          | 独立 bundle、global bin、clean-install coding-loop test            | 已具备                                               |
| SDK/RPC/JSON      | TypeScript SDK、JSON-RPC、JSON event stream                        | 已具备                                               |
| 审计 Kernel       | Decision/Effect、Grant/Receipt、Verifier Gate                      | FocusCode 独立优势方向；尚未贯通所有会话 Tool effect |

## 2. 之前未覆盖、v0.3 已补齐

v0.2 的主要缺口是：OAuth、Responses/Gemini、图片、完整 TUI/keymap/theme、扩展 package
lifecycle、会话分享、mid-turn queue 和物理 Sandbox driver。v0.3 已逐项落到接口、CLI、SDK、
测试和文档，而不是只写 roadmap。

本轮额外发现并修复的非显性问题：

- config 中的 TUI keymap/enabled 先前没有真正进入 CLI；
- SDK 先前可能绕过 CLI 的 Sandbox/Extension 组合；
- steering 收据与快速消费有 race，自定义 Provider 抛 AbortError 时不能恢复；
- Ctrl+M 与 Enter 同字节，原 mascot shortcut 不可达；
- bracketed paste 跨 chunk 和多行会污染/误提交输入；
- TUI/Human output 可被模型 ANSI control sequence 操纵；
- RPC 图片只检查 `type=image`，缺少大小、MIME、digest 运行时验证；
- 分享 server 先前只检查“有 signature 字段”，没有密码学验签；
- Extension post-install validation 失败可能残留 package；
- `requireExtensionSignatures` 配置先前没有约束运行时加载；
- Docker timeout 后需要按唯一 container name 强制清理；
- 默认 Host 不符合 Harness 的安全定位，现改为无静默回退的 `auto`。

## 3. 不能宣称的结论

仅凭功能数量不能证明 FocusCode 优于 Pi。当前没有证据支持：

- 更高的 Accepted & Verified 或更低 regression；
- 更低 Token/时间/成本；
- 更好的长上下文压缩质量；
- 更高的真实开源模型 Tool Calling 成功率；
- 已通过 Docker/gVisor/VM 实机安全红队；
- Extension/Session 已达到企业多租户生产要求。

## 4. 公平 A/B 方法

每个任务固定：

- Repo commit 和相同未提交初始状态；
- 相同 model revision、serving engine、chat template、temperature 和输出预算；
- 相同网络、Sandbox、权限与可用工具；
- 相同用户 Prompt 和 acceptance tests；
- 不把某一方的模型专属 Harness 优化错误归因给模型。

至少记录：

- Accepted & Verified；
- regression count；
- 首次正确 patch 时间；
- model/tool rounds；
- input/output/cached tokens；
- 用户审批与人工纠正次数；
- sandbox/permission denial；
- retry、Provider error 和 context compaction；
- 最终 diff size 与可审阅性。

在 10–30 个真实 Repo、多类任务和多次重复之前，产品表述应保持“具备直接对标能力面”，而
不是“已经优于主流 Agent”。
