# AGENTS.md

本文件面向 AI 编码代理，介绍 FocusCode 仓库的结构、命令与约定。假定读者对本项目一无所知。

## 项目概览

FocusCode（当前 `0.5.0`）是一个模型可移植、策略可控的 Coding Agent Harness，TypeScript
ESM 实现，pnpm monorepo。它不是某个模型的薄包装：Provider、上下文、会话、工具、权限、执行
隔离与扩展资产都有稳定边界，更换模型不会丢失本地会话与 Harness 资产。

已实现能力包括：OAuth/OIDC 与加密凭据库、Kimi/Qwen/GLM/DeepSeek/MiniMax 等五系 Provider 方言
与四种原生协议、全屏 TUI（主题/快捷键/伙伴）、图片输入、npm 扩展与 Ed25519 签名会话分享、
mid-turn steering（append/interrupt/followup）、Host/Docker/gVisor/SSH VM 沙箱、企业 allowlist
与 HMAC 审计。

**两条执行路径必须分清，不可随意合并**（见 `docs/ARCHITECTURE.md`）：

- 会话型 Coding Agent：`packages/agent-runtime`，Session 树 + 工具循环 + 权限 + steering，
  面向低延迟交互；
- 审计型 Focus Kernel：`packages/harness-core`，Intent/Grant/Receipt/Verifier 与确定性完成
  Gate，面向可重放与 Decision/Effect 分离。

## 环境

- Node `>=22.12.0`（CI 固定 22.20.0，pnpm-workspace.yaml `engineStrict: true`）
- pnpm 通过 corepack 固定为 11.7.0：

```bash
corepack enable && corepack prepare pnpm@11.7.0 --activate
pnpm install --frozen-lockfile
```

## 常用命令

- `pnpm verify` —— 必需的本地门禁：架构边界 + schema 导出检查 + prettier check + build + 带覆盖率的测试
- `pnpm build` —— `pnpm -r build`，各包用 `tsc -p tsconfig.json` 编译到 `dist/`
- `pnpm test` —— 先 build 再 `vitest run`；vitest 跑的是构建产物 `dist/`，
  陈旧构建会导致莫名其妙的失败
- 单个测试文件：`pnpm build && npx vitest run packages/<pkg>/test/<file>.test.ts`
- 构建单个包：`pnpm --filter @focuscode/<pkg> build`
- `pnpm lint` —— `node scripts/check-boundaries.mjs && node scripts/export-schemas.mjs --check && prettier --check .`
- `pnpm format` —— 提交前运行；lint 包含 `prettier --check .`，不要手工排版
- `pnpm schemas` —— `packages/contracts` 的契约/schema 变更后必须运行，并提交重新生成的
  `docs/schemas/`
- `pnpm demo` / `pnpm agent:demo` —— 确定性 demo（后者使用本地确定性 SSE Provider，无需 API Key）
- `pnpm npm:bundle` / `pnpm npm:verify` —— 独立 npm CLI bundle 构建与 clean-install 验证
- `pnpm release:check` —— CI 完整门禁 = verify + demo + agent:demo + npm:verify
- `pnpm manifest` —— 重新生成 `SOURCE_MANIFEST.sha256`（交付/发布产物，日常编辑不要动）

## Monorepo 结构

`apps/*` 是组合根（composition roots），`packages/*` 是库。

```text
apps/cli                  npm CLI（@focuscode/cli）与 TUI/print/json/rpc 组合根
apps/share-server         不可变签名会话存储参考服务
apps/control-api          只读控制面入口
apps/action-runtime       工具清单与执行面边界
apps/harness-worker       审计 Kernel worker
packages/agent-runtime    会话循环、Provider、工具、权限、Session、steering、multimodal、
                         MCP client、FallbackModelClient、LspClient、Skills 加载
packages/auth             OAuth 2.0、PKCE/device/refresh、加密凭据库
packages/tui              全屏终端状态机、主题、快捷键与伙伴
packages/sandbox          Host/Docker/gVisor/SSH VM/Seatbelt 执行器
packages/ecosystem        npm 扩展分发与 Ed25519 会话分享
packages/sdk              可嵌入 Coding Agent 与审计 Harness 的组合 API
packages/harness-core     可恢复任务状态机与确定性完成 Gate
packages/model-gateway    Atomic Decision 与声明式 Model Pack
packages/contracts        规范契约（typebox schema）
packages/protocols        协议边界映射
packages/action-*         Intent/Policy/Grant/Receipt 与受控 backend
packages/context-*        Canonical Context 与 Repo Profile
packages/persistence      append-only Fact/Checkpoint
packages/verifier-eval    baseline/target 验证
packages/asset-plane      Memory 与可移植资产
packages/testkit          测试工具（不参与覆盖率统计）
tests/                    进程入口（entrypoint）E2E 测试
scripts/                  构建、边界检查、schema 导出、demo 等脚本
```

## 架构边界（`pnpm lint` 强制，违反即失败）

`scripts/check-boundaries.mjs` 按禁止 token 扫描源码，以下红线不得引入：

- `contracts`：不得依赖其他 `@focuscode/*` 包或 Provider SDK（fastify/dockerode/openai 等）
- `harness-core`：不得出现 `node:fs`、`node:child_process`、`fetch(`，不得依赖
  action-backends、model-gateway
- `model-gateway`：不得依赖 action-backends、action-domain；不授予权限、不判定任务成败
- `agent-runtime`：不得依赖 harness-core、model-gateway、persistence、sdk、auth、ecosystem、
  sandbox、tui 或任何 apps
- `auth`、`ecosystem`、`sandbox`、`tui`：叶子 adapter，不得依赖任何 `@focuscode/*`
- `protocols`：不得依赖 persistence、action-backends、harness-core
- 只有 `apps/*` 和 `packages/sdk` 允许组合以上模块

其他架构规则（来自 CONTRIBUTING.md）：action-backends 不编译 prompt、不拥有任务状态；
protocols 只映射边界语义、不直接写 fact；Model Pack 保持声明式；CLI 扩展是显式可信代码，
不得描述为沙箱化；抽象只在第二个实现证明确有差异后才引入。

## 代码风格

- Prettier：printWidth 100、双引号、semicolon、trailing comma `"all"`（`.prettierrc.json`），
  用 `pnpm format` 而不是手工排版
- TypeScript strict：`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、
  `verbatimModuleSyntax`、`isolatedModules`，target ES2022，module/moduleResolution NodeNext
  （`tsconfig.base.json`，各包继承）
- 全 ESM（`"type": "module"`）；包入口为 `dist/index.js` + 类型声明

## 测试策略

- 测试位置：`packages/*/test/`、`apps/*/test/`（不与 `src/` 同目录），根 `tests/` 覆盖进程入口
- vitest 配置见 `vitest.config.ts`：超时 15s，coverage 用 v8，报告输出到 `reports/coverage`
  （`reports/` 是生成产物）
- 覆盖率阈值是仓库底线而非目标：statements 75 / branches 60 / functions 80 / lines 80，
  只统计 `packages/*/src`（排除 `src/index.ts` 与 testkit）。高风险模块即使全局 Gate 通过
  也可能要求更高的局部覆盖率
- 按改动类型遵循 CONTRIBUTING.md 的必备测试：
  - 契约/schema：golden + 向后兼容测试
  - parser：任意分片 differential、截断、非法 schema 测试
  - 会话 Provider：SSE 任意分片、JSON fallback、tool-argument、usage 测试
  - 工具：路径/属性、审批、观测 effect 与 reconciliation 测试
  - Session：JSONL reload、tree/fork、compaction、export 测试
  - 扩展：project trust、reload、permission-path 测试
  - Kernel：确定性状态与 crash-boundary 测试
  - 安全：威胁路径与 fail-closed 测试
  - Model Pack：generic-vs-specific ablation fixture
- PR 范围：Harness 代码、Model Pack、Tool Registry、Policy、schema 变更尽量可拆分；说明兼容
  性影响、信任边界影响、回滚与证据；不要把无关依赖升级与安全敏感改动混在一起

## 安全注意事项

详见 `SECURITY.md`。要点：

- `--sandbox host` 不是安全沙箱，只是兼容路径；默认 `auto`（gVisor → Docker → seatbelt
  [仅 darwin] → Host [仅 `allowHostFallback` 时] → fail），不允许回退 Host
- `--sandbox seatbelt` 使用 macOS `sandbox-exec` 与 seatbelt profile language
  （`(deny default)` 基线 + 进程执行白名单 + **写仅限 workspace**，读为全局允许、
  默认无网络），无需 Docker 即可获得 OS-level 写隔离；沙箱内固定以 POSIX
  `sh` 模式执行（交互式 zsh/bash 在 hardened profile 下 SIGABRT）；非 darwin
  平台 `health()` fail-quiet 返回 unavailable。`health()` 用最小 profile 真实
  执行探测（`-h` 在 macOS 25 上退出码 64，不可用作探测）
- 容器只包住 Bash 及其子进程；Provider/OAuth/Session/Extension Host 留在 CLI 进程，
  模型凭据不进入不可信执行环境，Tool 子进程只获得精简环境
- MCP server 在 CLI 主进程通过 stdio 通信，工具注册发生在 `CodingAgent.create` 之前；
  `mcp.pins`（`McpToolPinV1` = serverId + serverVersion + toolName + schemaDigest
  - transportDigest）声明后 fail-closed，任何 schema/transport 漂移或缺失 tool 抛错
    并使 CLI 非零退出；server 子进程不接触 Provider token
- 扩展默认进程内运行，是显式可信代码；`extensions.host: "process"` 提供进程级崩溃隔离但不是
  沙箱；npm 签名与权限声明是供应链/同意控制，不是运行时 containment
- 项目 Instructions/Skills/Extensions 仅在 `--trust-project` 后加载；非 TTY 下 `ask` 降级为 `deny`
- Provider secret 不进入 Prompt、Session、Tool 环境或普通日志；client secret 用
  `FOCUSCODE_<PROVIDER>_CLIENT_SECRET` 环境变量，不要写进配置或命令历史
- 会话分享默认脱敏并省略工具输出与图片，导入/下载/服务器均验 Ed25519 签名（证明完整性，
  不证明身份或内容可信）
- 企业模式对 Provider/model/extension、远程图片、Sandbox（强制非 Host、digest 镜像、
  `--pull never`）和 32 字节+ audit HMAC key 全部 fail closed
- 贡献者规则：不让 Approval 覆盖组织 hard deny；工具参数完整解析与 schema 验证前不执行；
  任何自动授权扩大必须增加绕过测试；不信任模型/工具/扩展输出中的终端控制字符

## 发布与部署

- 交付物是独立 ESM bundle 的 npm tarball（`pnpm npm:bundle` 构建，`pnpm npm:verify` 做
  clean-install + 真实本地 SSE tool-loop 验收），安装侧不需要 pnpm 或 monorepo
- 完整发布门禁：`pnpm release:check`
- CI（`.github/workflows/ci.yml`）：ubuntu + Node 22.20.0 + pnpm 11.7.0，依次跑
  verify、demo、agent:demo、npm:verify，并上传 coverage/npm 报告 artifact
- 契约变更后跑 `pnpm schemas` 并提交 `docs/schemas/`；`SOURCE_MANIFEST.sha256` 只在发布/交付
  变更时用 `pnpm manifest` 重新生成

## 文档索引（docs/ 是权威深入资料，优先于按文件名猜测）

- `ARCHITECTURE.md` —— 两条执行路径与分层
- `DEVELOPMENT_STATUS.md`、`TEST_REPORT.md` —— 进度与测试现状
- `OAUTH_AND_PROVIDERS.md`、`TUI_AND_MULTIMODAL.md`、`EXTENSIONS_AND_SHARING.md`、
  `SANDBOXING.md`、`NPM_RELEASE.md` —— 各子系统专题
- `SDK_GUIDE.md`、`API_MANUAL.md` —— SDK 组合 API 与运行手册
- `V0.4_ENTERPRISE_DEPLOYMENT.md` —— 企业接入与发布 Gate
- `docs/adr/`、`docs/threat-models/`、`docs/runbooks/`、`docs/schemas/` —— 决策记录、
  威胁模型、运维手册、导出 schema
