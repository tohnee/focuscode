# FocusCode CLI Coding Agent

FocusCode `0.4.0-beta.2` 是一个模型之上的、用户可控且可迁移的 Coding Agent Harness。
本版本把 Kimi、Qwen、GLM、DeepSeek、MiniMax 的模型方言、OIDC/OAuth、全屏 TUI 与七只动态
终端伙伴（含 Foxy 小狐狸九级成长与像素游戏风动画）、图片输入、扩展与签名会话分享、三类
mid-turn queue、Docker/gVisor/VM 隔离、MCP stdio 客户端、LSP 诊断回喂、文件级检查点/undo、
子代理委派、web_fetch/web_search/todo 工具、企业允许列表和防篡改审计接入同一条 CLI/SDK
可运行链路。

它不是某家模型的薄包装。Provider、上下文、会话、工具、权限、执行隔离与扩展资产都有
稳定边界；更换模型不会丢失本地会话与 Harness 资产。Beta 表示接口与安全边界仍可能演进，
也不表示已经在真实任务基准上优于 Pi、Claude Code、Codex 或其他主流 Coding Agent。

## 本阶段能力

| 能力              | 已实现的可执行结果                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OAuth / Provider  | PKCE/device/OIDC/refresh/revoke、AES-256-GCM 凭据库；五系 11 个区域 Profile、四协议、reasoning/Tool continuation、Retry-After 和模型级覆盖                                                                                                                                                                                                                                                                                                        |
| 全屏 TUI          | alternate screen、差分刷新、流式输出、审批/历史/滚动/粘贴、可配置快捷键、6 主题 + 4 套内置皮肤包（sakura/ocean/arcade/matcha）+ 用户导入 skin、7 伙伴（默认 Foxy 小狐狸鼓励师 + 气泡鼓励语 + 9 级尾巴成长 + 像素游戏风帧动画）、Markdown 语法高亮、Model 选择器（Tab 切换 provider / Alt+S session-only / ←→ 切 Low/High/Max reasoning effort）、levelBadge 与 costBar widgets                                                                    |
| 工具系统          | 内置 read/write/edit/apply_patch/grep/find/ls/bash/git_status/git_diff；新增 todo（pending/in_progress/completed 状态机）、web_fetch（http/https + 20s 超时 + 2MB 上限 + HTML→text）、web_search（DuckDuckGo lite 默认，可覆盖 searchEndpoint）、delegate（DI 工厂注入子代理，共享 modelClient/permission，剔除 delegate/bash/todo，内存 SessionStore）；grep/find 走 ripgrep 探测 + 纯 TS fallback（gitignore 子集解析、二进制与 >5MB 文件跳过） |
| MCP 运行时        | stdio JSON-RPC 2.0 行分隔协议客户端；`registerMcpServers` 在启动期发现工具并按 `mcp_<serverId>_<toolName>` 规范命名；`readOnlyHint→read` / `destructiveHint→write` / 其余→network 的 effect 映射；`computeToolPin`/`verifyPins` fail-closed pin 校验；`/mcp list\|reload` TUI 命令                                                                                                                                                                |
| 检查点 / undo     | `CheckpointStore` 在 write/edit/apply_patch 前以相对路径快照文件 + `focuscode-checkpoint.v1` manifest；上限 50 淘汰最旧；目录 0700/文件 0600；`/undo` 与 `fox` API 回滚到上一个文件状态（区别于 session fork 的对话分叉语义）                                                                                                                                                                                                                     |
| LSP 诊断回喂      | `shouldRunDiagnostics`（tsconfig 存在 + node_modules/.bin/tsc 优先）+ `runDiagnostics`（复用 runProcess 环境白名单，截断 8000 字符）；编辑成功后自动追加诊断输出到上下文，形成"改完即看错误"的闭环                                                                                                                                                                                                                                                |
| 图片输入          | PNG/JPEG/WebP/GIF，本地或 HTTPS；CLI/TUI/RPC/SDK；内容验证、Session 持久化、模型能力 Gate；企业模式默认禁止远程 URL                                                                                                                                                                                                                                                                                                                               |
| 扩展与分享        | npm pack/install/list/remove、禁 lifecycle scripts、registry signature check、权限声明、锁文件；Ed25519 签名分享、脱敏、导入、发布、下载与参考分享服务                                                                                                                                                                                                                                                                                            |
| Mid-turn steering | 有界 FIFO；append、generation-only interrupt、final-response 后 follow-up；TUI、RPC、SDK 语义一致                                                                                                                                                                                                                                                                                                                                                 |
| 真实隔离          | 默认 `auto`：gVisor → Docker → fail；企业模式强制非 Host、镜像 digest、`--pull never`；另有严格 SSH disposable-VM adapter                                                                                                                                                                                                                                                                                                                         |
| 费用与模型目录    | `--list-models` 早退打印按 provider 分组的可用模型清单；`--cost` 在 print/json 模式下汇总输入/输出/缓存 token 与估算费用（基于 `pricing.<provider>/<model>` 单价表）；TUI `/cost` 命令随时查看                                                                                                                                                                                                                                                    |
| npm 发布          | `@focuscode/cli` 独立 ESM bundle、全局 bin、clean-install 验证、真实本地 SSE tool-loop 验收与发布清单                                                                                                                                                                                                                                                                                                                                             |

## 安装

从交付的 npm tarball 安装不需要 pnpm 或 monorepo：

```bash
npm install --global ./focuscode-cli-0.4.0-beta.2.tgz
focuscode --version
focuscode --help
```

除了 `focuscode`，同一个安装还会注册 `focus`、`fc`、`fox` 三个等价命令；在 TTY 中不带参数
直接运行其中任意一个（例如 `fox`）就会进入全屏 TUI，默认由 Foxy 小狐狸鼓励师陪伴。

拥有 npm scope 发布权限后：

```bash
npm publish ./focuscode-cli-0.4.0-beta.2.tgz --access public --provenance
npm install --global @focuscode/cli@0.4.0-beta.2
```

从源码开发：

```bash
corepack enable
corepack prepare pnpm@11.7.0 --activate
pnpm install --frozen-lockfile
pnpm verify
pnpm agent:demo
pnpm npm:verify
```

需要 Node.js `>=22.12.0`。`agent:demo` 使用本地确定性 SSE Provider，真实执行两轮模型调用
和一次文件写入，不需要外部 API Key。

## 第一次运行

API Provider：

```bash
export OPENAI_API_KEY=...
focuscode --model openai/gpt-5 --approval ask

export ANTHROPIC_API_KEY=...
focuscode --model anthropic/claude-model-id --approval ask

export GEMINI_API_KEY=...
focuscode --model gemini/gemini-model-id --approval ask

export MOONSHOT_API_KEY=...
focuscode --provider kimi --approval ask

export DASHSCOPE_API_KEY=...
focuscode --provider qwen --approval ask

export ZAI_API_KEY=...
focuscode --provider glm --approval ask

export DEEPSEEK_API_KEY=...
focuscode --provider deepseek --approval ask

export MINIMAX_API_KEY=...
focuscode --provider minimax --approval ask
```

本地 OpenAI-compatible Provider：

```bash
focuscode --provider ollama --model qwen3-coder \
  --sandbox docker --approval ask
```

默认沙箱是 `auto`、默认容器断网、默认不允许回退。如果机器没有 Docker/gVisor，可在完全
理解风险后显式使用 `--sandbox host`；CLI 会打印警告。先检查运行时：

```bash
focuscode sandbox doctor --kind auto
focuscode sandbox doctor --kind gvisor
```

## OAuth

Google 与 GitHub 有内置 Profile，标准企业身份服务可通过 OIDC discovery；其他 OAuth 2.0
Provider 也可显式配置端点：

```bash
export FOCUSCODE_GOOGLE_CLIENT_ID=...
focuscode auth login google --device --account default
focuscode auth list

focuscode auth login enterprise \
  --issuer https://identity.example.com \
  --client-id "$FOCUSCODE_ENTERPRISE_CLIENT_ID" \
  --scope openid,profile,offline_access,models

focuscode auth login private-provider \
  --client-id "$FOCUSCODE_PRIVATE_PROVIDER_CLIENT_ID" \
  --authorization-url https://id.example.com/oauth/authorize \
  --token-url https://id.example.com/oauth/token \
  --scope models,offline_access

focuscode --provider private-provider --model model-id \
  --protocol openai-responses --oauth-account default
```

Client Secret 建议放在 `FOCUSCODE_<PROVIDER>_CLIENT_SECRET`，不要写入项目配置或命令历史。

## TUI、图片与 steering

TTY 中默认进入全屏 TUI：

```bash
focuscode --model openai/gpt-5 --theme candy --mascot pico
focuscode --theme .focuscode/team-theme.json --mascot .focuscode/team-mascot.json
fox  # 默认 fox 主题 + Foxy 小狐狸；/cheer 开关鼓励语
focuscode --model anthropic/claude-model-id -i ./screen.png "按截图修复布局"
focuscode mascots
focuscode themes
```

运行中直接提交新文字会排入 append steering；需要立即改变当前生成方向时使用
`/interrupt <instruction>`；需要当前响应完成后再追加工作时使用 `/followup <instruction>`。
`/image <path-or-url>` 给下一条消息添加图片。常用命令包括
`/status`、`/tools`、`/compact`、`/sessions`、`/resume`、`/fork`、`/model`、
`/approval`、`/image`、`/reload` 和 `/export`。

### v0.4.0-beta.2 新增的 TUI 命令

| 命令                              | 作用                                                                                                                                                                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/model`                          | 打开 **Model 选择器**：顶部模糊搜索、Tab 切换 provider、Alt+M 唤起、↑↓ 导航、Enter 确认、Alt+S 仅当前会话切换（不写入配置）、←→ 切 Low/High/Max reasoning effort；切换会触发提示「Switching models invalidates the existing prompt cache」 |
| `/character [list\|<id>]`         | 切换 7 只伙伴之一（foxy/mochi/byte/nori/pico/bubu/kumo），每只都有 8 种 mood 与像素游戏风帧动画                                                                                                                                            |
| `/skin [import\|export\|builtin]` | 一键换肤：`/skin builtin sakura` 切内置皮肤；`/skin import ./my-skin.json` 导入用户自建皮肤包（focuscode-skin.v1 格式，canonical JSON + 严格校验）；`/skin export ./out.json` 导出当前皮肤；`/skin` 不带参数列出所有皮肤                   |
| `/init`                           | 在当前仓库生成 `.focuscode/agent.json` 模板（含 schemaVersion、provider、sandbox、tui 等字段），首次接入仓库时使用                                                                                                                         |
| `/undo`                           | 回滚最近一次 write/edit/apply_patch 操作（基于 CheckpointStore 的快照）                                                                                                                                                                    |
| `/cost`                           | 查看当前会话的 token 用量与估算费用汇总（输入/输出/缓存分别统计）                                                                                                                                                                          |
| `/todo [add\|done\|clear]`        | 维护任务清单：`add` 添加（content ≤200，items ≤50）、`done <id>` 标记完成、`clear` 清空；todo 状态会进入 system prompt，模型能看到 checkbox 渲染                                                                                           |
| `/mcp [list\|reload]`             | 列出或重载已注册的 MCP server 与工具；每个工具按 `mcp_<server>_<tool>` 命名，pin 校验 fail-closed                                                                                                                                          |
| `/diagnostics [on\|off]`          | 开关 LSP 诊断回喂：开启后每次 write/edit/apply_patch 成功会自动追加 tsc 诊断输出到上下文                                                                                                                                                   |

### CLI 子命令（fox 命令）

```bash
fox skins list                       # 列出所有可用皮肤（内置 + 用户导入）
fox skins apply sakura               # 应用名为 sakura 的皮肤
fox skins import ./my-skin.json       # 导入用户自建皮肤包
fox skins export ./out.json           # 导出当前皮肤
fox skins remove my-skin              # 移除已导入的皮肤

fox character list                   # 列出 7 只伙伴
fox character foxy                    # 切换默认伙伴为 foxy

fox companion                        # 查看 Foxy 当前等级、XP、尾巴数与累计 turns
fox companion reset                  # 重置伙伴成长状态（重新从 1 级开始）

fox --list-models                    # 早退打印按 provider 分组的可用模型清单
fox --cost                           # print/json 模式下追加费用汇总
```

伙伴成长系统：每完成一轮对话（model round）+1 XP，工具调用 +2 XP，关键里程碑（如完成 100
turns、levelup）有奖励加成。9 个等级对应的尾巴数从 1 → 9 递增，等级名称依次为：幼尾小福 →
二尾小福 → 三尾小福 → … → 九尾天福。levelup 时小狐狸会切换到 `celebrating` mood 持续 3 秒后
回退到当前实际 mood，状态栏右侧渲染 `levelBadge`。状态持久化到 `~/.focuscode/companion.json`。

### 自定义皮肤包格式

皮肤包是 canonical JSON 文档，schema 版本 `focuscode-skin.v1`：

```json
{
  "schemaVersion": "focuscode-skin.v1",
  "id": "my-theme",
  "name": "我的皮肤",
  "theme": { "bg": 233, "fg": 255, "accent": 208, "muted": 240, "border": 235 },
  "mascot": { "id": "foxy", "frameSet": "pixel" },
  "signature": "可选 Ed25519 风格签名"
}
```

`fox skins import` 会校验 `schemaVersion`、必需字段与 ANSI 控制字符注入；签名是可选的（与扩展
签名策略不同——皮肤包不执行代码，仅影响渲染）。

快捷键可写入 `.focuscode/agent.json`，也可用 `--keymap keymap.json` 覆盖：

```json
{
  "schemaVersion": "focuscode-agent.v1",
  "tui": {
    "enabled": true,
    "theme": "aurora",
    "mascot": "mochi",
    "keymap": { "ctrl+x": "abort", "ctrl+g": "cycle_mascot" }
  }
}
```

## 扩展与会话分享

```bash
focuscode extension pack examples/extension-hello --out ./dist
focuscode extension install ./dist/focuscode-example-hello-extension-0.1.0.tgz \
  --allow-unsigned
focuscode extension list

focuscode share export --session SESSION_ID --out review.focuscode-share.json
focuscode share import review.focuscode-share.json --repo /path/to/repo
```

默认分享会移除工具输出、图片二进制和常见凭据。只有明确指定
`--include-tool-output` / `--include-images` 才会保留；导入前会验证 Ed25519 签名。签名证明
内容未被修改，不代表你信任签名者或其中的 Prompt。

## Monorepo

```text
apps/cli                  npm CLI 与 TUI/print/json/rpc 组合根
apps/share-server         不可变签名会话存储参考服务
apps/control-api          只读控制面入口
apps/action-runtime       工具清单与执行面边界
packages/agent-runtime    会话循环、Provider、工具、权限、Session、steering、multimodal
packages/auth             OAuth 2.0、PKCE/device/refresh、加密凭据库
packages/tui              全屏终端状态机、主题、快捷键与伙伴
packages/sandbox          Host/Docker/gVisor/SSH VM 执行器
packages/ecosystem        npm 扩展分发与 Ed25519 会话分享
packages/sdk              可嵌入 Coding Agent 与审计 Harness 组合 API
packages/harness-core     可恢复任务状态机与确定性完成 Gate
packages/model-gateway    Atomic Decision 与声明式 Model Pack
packages/action-*         Intent/Policy/Grant/Receipt 与受控 backend
packages/context-*        Canonical Context 与 Repo Profile
packages/persistence      append-only Fact/Checkpoint
packages/verifier-eval    baseline/target 验证
packages/asset-plane      Memory 与可移植资产
```

会话型 Coding Agent 与审计型 Focus Kernel 是两个组合策略：前者优化日常低延迟编程，后者
优化可重放、Effect Receipt 和确定性完成 Gate。Provider、TUI、OAuth、沙箱和生态都是端口
适配器，不进入核心决策内核。

## 企业模式

```bash
focuscode init --enterprise \
  --provider deepseek --model deepseek-v4-pro \
  --sandbox-image registry.example.com/focuscode/node22@sha256:<64-hex-digest>
export FOCUSCODE_AUDIT_HMAC_KEY="$(openssl rand -base64 48)"
focuscode doctor --repo .
```

企业模式会对 Provider/model/extension、远程图片、Sandbox 和审计 key fail closed。只有
`doctor` 返回 `"ready": true` 才应进入 smoke test；这不替代目标 Docker/runsc/VM 攻击验收。

## 验证与边界

```bash
pnpm build
pnpm lint
pnpm test
pnpm test:coverage
pnpm release:check
```

自动化覆盖四类原生协议、五系 Provider 方言、reasoning state 回放、OAuth/OIDC、图片验证、
三类 steering、全屏 TUI、自定义主题/伙伴、扩展签名策略、会话分享与服务器、沙箱命令契约、真实 Host
进程 timeout/abort、CLI 进程 E2E、SDK 和 npm clean install。

本仓库已实现 Docker/gVisor/VM 驱动与对抗性命令构造测试；是否真的获得物理隔离仍取决于
部署机安装并正确配置相应运行时。Host 模式不是安全沙箱。扩展仍是进程内可信代码，npm
签名与权限声明不是运行时 containment。详见 [SECURITY.md](SECURITY.md)。

## 文档

- [v0.4 Pi Apple-to-Apple 审查](docs/V0.4_PI_APPLE_TO_APPLE_REVIEW.md)
- [v0.4 企业接入与发布 Gate](docs/V0.4_ENTERPRISE_DEPLOYMENT.md)
- [v0.3 历史能力与架构](docs/V0.3_CAPABILITY_ARCHITECTURE.md)
- [OAuth 与 Provider](docs/OAUTH_AND_PROVIDERS.md)
- [TUI 与多模态](docs/TUI_AND_MULTIMODAL.md)
- [扩展与会话分享](docs/EXTENSIONS_AND_SHARING.md)
- [隔离与部署](docs/SANDBOXING.md)
- [npm 发布与安装](docs/NPM_RELEASE.md)
- [开发进度](docs/DEVELOPMENT_STATUS.md)
- [测试报告](docs/TEST_REPORT.md)
- [Pi 能力对照](docs/PI_PARITY.md)
- [一手实现参考](docs/REFERENCES.md)

## License

Apache-2.0。
