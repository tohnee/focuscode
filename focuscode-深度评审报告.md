# FocusCode 深度代码评审与对标研究报告

**评审对象**：[tohnee/focuscode](https://github.com/tohnee/focuscode) `0.4.0-beta.2`（commit `59becb4`，2026-07-21）
**评审方法**：不是只读 README——在沙箱中实际克隆、用 Node 22 完整构建、跑全部测试套件、用伪终端真实驱动全屏 TUI 完成一次模型往返，并逐文件审读 agent 循环、工具集、权限、TUI、CLI 源码后得出结论。
**对标基线**：Pi（`@earendil-works/pi-coding-agent` 0.8x，pi.dev 官方文档）与 opencode（sst/anomaly，v1.17.x，约 18 万 star）。

---

## 一、实测验证记录（先看证据）

| 验证项                                                                               | 结果                                                                                                     |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` + `pnpm build`（19 个包，Node ≥22.12）              | ✅ 全部编译通过，零错误                                                                                  |
| `pnpm test`（38 个测试文件，244 用例）                                               | ✅ **232 通过 / 11 跳过 / 1 失败**；唯一失败是沙箱环境缺 `rg`（ripgrep）二进制，非代码缺陷               |
| `pnpm agent:demo`（本地确定性 SSE Provider 跑真实 CLI 进程）                         | ✅ PASS：2 轮模型调用 + 1 次真实文件写入，token 统计正常                                                 |
| 伪终端驱动全屏 TUI（aurora 主题 + mochi 伙伴）                                       | ✅ alternate screen、差分刷新、流式回复渲染、伙伴 mood 动画、steer 队列指示、`/status`、`/exit` 全部工作 |
| CLI `--help` / 子命令（auth/extension/share/sandbox/doctor/init/run/inspect/export） | ✅ 完整、自洽、文档一致                                                                                  |

**工程规模**：138 个 TS 源文件、约 2.74 万行代码、pnpm monorepo（13 packages + 5 apps + model-packs + evals）。测试覆盖面（OAuth、四协议、steering、TUI、扩展签名、沙箱契约、E2E）在这个体量下属于异常扎实的一档。

---

## 二、架构评审：这是一个设计严肃的 Harness，不是玩具

### 2.1 架构分层（实际代码验证）

```
apps/cli            → 组合根：TUI / print / json / rpc 四模式
packages/agent-runtime → CodingAgent 会话循环（744 行，职责清晰）
packages/tui        → 全屏终端状态机（EditorBuffer/grapheme 光标/undo/kill ring）
packages/sandbox    → Host / Docker / gVisor / SSH-VM 四类执行器
packages/auth       → OAuth2 PKCE/device/refresh + AES-256-GCM 凭据库
packages/action-*   → Intent/Policy/Grant/Receipt 审计内核（Effect Spine）
packages/harness-core / model-gateway → 可恢复状态机 + Atomic Decision
packages/ecosystem  → npm 扩展分发 + Ed25519 签名会话分享
```

几个值得点名的好评：

1. **系统提示词质量高**（`agent.ts`）：明确写入"工具调用独立鉴权""被拒绝的工具不代表效果已发生""不得用等价命令重试被拒的破坏性操作""不暴露隐藏 CoT"——这是踩过坑的 harness 才会写的措辞。
2. **PolicyEngine 单源化**：审批矩阵（shell 分类、受保护资源、ask/auto-edit/full-auto/deny 四模式）收口在 `action-domain`，TUI/CLI/SDK 语义一致，避免了三处实现漂移的经典 bug。
3. **安全默认值激进且诚实**：默认 `--sandbox auto`（gVisor→Docker→fail，**无静默回退 Host**），默认容器断网，企业模式强制镜像 digest pin + `--pull never`。Host 模式每次打印明确警告（实测可见）。
4. **三类 mid-turn steering**（append / generation-only interrupt / final-response follow-up）有界 FIFO + 收据，TUI/RPC/SDK 语义一致——这一点 Pi 和 opencode 都只做了部分。
5. **审计主链**（HMAC 链式审计 + Effect Receipt + 确定性完成 Gate）是同赛道里独一份的方向。

### 2.2 发现的实际代码问题

| 问题                                     | 严重度 | 说明                                                                                                                         |
| ---------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| grep/find 工具**硬依赖外部 `rg` 二进制** | 中     | 无 fallback、无前置探测；无 rg 的环境工具直接抛 `spawn rg ENOENT`（实测复现）。应内置 JS 实现或启动时 doctor 检查            |
| 无 MCP **运行时**客户端                  | 中     | 只有协议 schema 映射（`McpToolPinV1`），agent-runtime/cli 中 grep 不到任何 MCP 连接代码。README 措辞"协议映射已落地"容易误读 |
| 内置工具仅 10 个                         | 中     | read/write/edit/apply_patch/grep/find/ls/bash/git_status/git_diff。**没有** todo/task、web_fetch/web_search、子代理委派      |
| 官方对标文档轻微过时                     | 低     | `V0.4_PI_PARITY_ANALYSIS.md` 称"无中途切换模型"，但代码里 `/model` + `changeModel()` 已实现                                  |
| npm 发布形态是独立 ESM bundle            | 低     | 利于安装但牺牲了可 hack 性，与 Pi"源码即扩展"哲学相反（属定位选择，非缺陷）                                                  |

---

## 三、TUI 与 CLI 评审：完善且合理吗？

**结论：是的，超出"可用"线，达到"完整 Alpha+ "水准，且实测可跑。**

### TUI（packages/tui + apps/cli/tui.ts）

- ✅ 全屏 alternate screen + 差分刷新（`diff.ts`），实测无闪烁
- ✅ 编辑器：undo 栈、kill ring、grapheme 感知光标（`Intl.Segmenter`，宽字符/中文正确处理）
- ✅ 5 内置主题 + 校验过的自定义主题 JSON；6 只多 mood 动态 ANSI 伙伴（差异化趣味能力）
- ✅ 可配置 keymap、Tab 补全（slash 命令/文件路径/skills）、bracketed paste 跨 chunk 处理（CHANGELOG 显示修过真实 bug）
- ✅ 20+ slash 命令：/status /tools /compact /interrupt /followup /unsteer /image /approval /model /new /resume /fork /sessions /tree /export /reload /skills
- ❌ 缺：文本 selection、IME preedit、完整代码语法高亮、diff review 交互 UI、@file 模糊匹配、拖入图片

### CLI（apps/cli）

- ✅ 四种输出模式：tui / interactive / print(-p) / json / rpc（JSON-RPC 事件流，可嵌入 CI）
- ✅ 会话管理完整：-c/-r/--session/--fork/--export-session/--no-session，JSONL session tree
- ✅ Provider 四协议（openai-chat / openai-responses / anthropic-messages / google-gemini）+ tool-mode native/prompt-json/auto（开源模型 tool-calling 兜底）
- ✅ OAuth 子命令（login/list，PKCE/device 流）、extension 子命令（pack/install/list/remove + 签名校验）、share 子命令（Ed25519 导出/导入/脱敏）、sandbox doctor、doctor（企业 fail-closed 体检）
- ❌ 缺：`--list-models` 式模型目录、费用/缓存用量面板、后台任务

**横向定位**：CLI 的完备度已经**接近 Pi**（Pi 也有 print/JSON/RPC/SDK 四模式），明显强于"玩具 CLI"，但 TUI 打磨深度（高亮、diff review、IME）落后于 Pi 和 opencode 的 Bubble Tea TUI。

---

## 四、对标 Pi：同哲学赛道，各有所长

Pi 的信条是 _"Primitives, not features"_——极小内核 + 极深扩展；FocusCode 的信条是 _"强契约 + Policy 收口 + 可审计"_。两者都是 harness 而非模型薄包装，是真正可比的同类。

| 维度                                         | FocusCode 0.4                                             | Pi 0.8x                                                                                           | 判定                                                        |
| -------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Agent 循环 / Session tree / fork / HTML 导出 | ✅                                                        | ✅                                                                                                | **对等**                                                    |
| 运行模式（TUI/print/JSON/RPC/SDK）           | ✅ 四模式                                                 | ✅ 四模式                                                                                         | **对等**                                                    |
| Steering 队列                                | 三类 + 收据 + unsteer                                     | 消息队列                                                                                          | **FocusCode 略优**                                          |
| 中途换模型                                   | `/model` + changeModel ✅（官方文档此处过时）             | `/model`、Ctrl+L/P 循环                                                                           | **Pi 优**（收藏/循环）                                      |
| Provider 广度                                | 5 系国产 + OpenAI/Anthropic/Gemini/自定义                 | 15+（含 Bedrock/Azure/Groq/Cerebras/OpenRouter…）                                                 | **Pi 大幅领先**                                             |
| 扩展 API 深度                                | 工具/命令/事件；有**进程外宿主**（崩溃隔离，Pi 没有）     | 拦截/改写 tool_call/result、自定义 UI widget、持久状态、覆盖内置工具、注册 Provider、50+ 官方示例 | **Pi 大幅领先**（深度与生态），FocusCode 在隔离模型上更先进 |
| Compaction                                   | 有界摘要                                                  | 结构化自动压缩 + 分支摘要                                                                         | **Pi 领先**                                                 |
| MCP                                          | 仅 schema 映射                                            | 官方拒绝内置、扩展可实现                                                                          | 皆无内置，**平手**                                          |
| OAuth/凭据安全                               | PKCE/device/OIDC + AES-256-GCM 加密库                     | API key / OAuth                                                                                   | **FocusCode 大幅领先**                                      |
| 沙箱                                         | Docker/gVisor/SSH-VM 四驱动 + digest pin + 断网默认       | 无内置（SSH 扩展示例）                                                                            | **FocusCode 大幅领先**                                      |
| 审计/企业模式                                | HMAC 链 + Effect Receipt + allowlist fail-closed + doctor | 无                                                                                                | **FocusCode 大幅领先**                                      |
| 分享                                         | Ed25519 签名 + 脱敏 + 参考服务器                          | HTML 导出 / gist                                                                                  | **FocusCode 更安全**，对等偏优                              |
| 社区/生态/真实使用                           | 近乎为零                                                  | 活跃社区、pi.dev 包市场、第三方集成                                                               | **Pi 大幅领先**                                             |

**小结**：FocusCode 在**企业安全与审计维度已对 Pi 形成结构性领先**；在**日常开发者体验与扩展生态维度明显落后**。它更像是"Pi 的架构 + 企业合规内核"，而不是 Pi 的替代品。

---

## 五、对标 opencode：差距是全方位的，但不在同一战场

opencode（~18 万 star，750 万月活开发者）是当前事实上的开源 coding agent 标杆。逐项对比：

| 能力                       | opencode v1.17                            | FocusCode 0.4                           | 差距                    |
| -------------------------- | ----------------------------------------- | --------------------------------------- | ----------------------- |
| Provider                   | 75+（models.dev 目录自动更新）            | 5 系 + 自定义                           | 🔴 数量级差距           |
| TUI                        | Bubble Tea 打磨多年，语法高亮/diff/多会话 | 自绘差分渲染，功能全但糙                | 🔴 成熟度差距           |
| LSP 反馈                   | 编辑后真实编译诊断回喂模型                | 无                                      | 🔴 关键能力缺失         |
| 子代理                     | build/plan 双 agent + 后台 subagents      | 无                                      | 🔴 关键能力缺失         |
| MCP 客户端                 | ✅ 内置                                   | ❌ 仅 schema                            | 🔴 关键能力缺失         |
| 撤销/检查点                | git snapshot + /undo                      | session fork（无文件级回滚）            | 🟡                      |
| 会话存储                   | SQLite                                    | JSONL（够用但弱）                       | 🟡                      |
| 沙箱/审计/企业 allowlist   | 无                                        | ✅ 四类驱动 + HMAC 审计                 | 🟢 **FocusCode 独有**   |
| OAuth 加密凭据库           | 无此级别                                  | ✅                                      | 🟢 **FocusCode 独有**   |
| SKILL.md / 项目资源        | ✅                                        | ✅（AGENTS/skills/prompts/reload）      | ⚪ 对等                 |
| 开源模型 tool-calling 兜底 | 一般                                      | prompt-json/auto 模式 + Model Pack 方言 | 🟢 FocusCode 思路更系统 |

**小结**：作为"日常 coding agent"，FocusCode 目前**不能**与 opencode 对标——缺 LSP、子代理、MCP、provider 广度这四块是硬性功能缺口，且没有任何真实任务基准（SWE-bench / Terminal-Bench）证据。但 opencode 完全没有 FocusCode 的隔离执行与审计内核，两者定位几乎不重叠：**opencode 优化"模型改代码的效率"，FocusCode 优化"agent 行为可控可审计"**。

---

## 六、最终结论

1. **TUI 和 CLI 是否完善合理？** —— **是**。经实际构建、244 测试用例、伪终端驱动验证：TUI/CLI 是完整、自洽、可运行的，工程质量在同类个人项目中属于上乘。残留问题（rg 硬依赖、无语法高亮深度、无 IME）是打磨度问题，不是架构问题。

2. **能否与 Pi 对标？** —— **能力面已基本具备直接 A/B 的条件**（这一点仓库自己的 PI_PARITY 文档结论克制且正确）。架构成熟度与 Pi 同档，安全/审计/隔离维度领先，provider 广度、扩展生态、compaction 质量、社区维度落后。综合判定：**互有胜负的可比对手，但生态差距短期内无法弥合**。

3. **能否与 opencode 对标？** —— **目前不能**。缺 LSP 反馈、子代理、MCP 运行时、75+ provider 四个硬能力，也没有基准测试成绩。FocusCode 正确的问题是"企业敢不敢让 agent 跑"，opencode 回答的问题是"开发者爱不爱用"——要真正坐上同一张牌桌，FocusCode 至少需要补上：MCP 运行时客户端、LSP 诊断回喂、todo/subagent 工具、以及一份公开的真实任务 A/B 基准报告。

4. **最被低估的一点**：这个仓库的**自我认知异常诚实**——README 明确写"不表示已经在真实任务基准上优于 Pi、Claude Code、Codex"，SECURITY.md 明确写"Host 模式不是安全沙箱、扩展不是运行时 containment"。在 AI 编码工具普遍过度宣称的 2026 年，这种工程诚实本身就是稀缺资产。

### 若作者继续迭代，优先级建议

1. 修 `rg` 硬依赖（内置 fallback 或 doctor 前置检查）——半天工作量，消除唯一测试失败
2. MCP 运行时客户端（协议层已就位，差最后一公里）
3. LSP 诊断回喂 + todo 工具（对真实 coding 成功率影响最大）
4. 用仓库自带的公平 A/B 方法论（PI_PARITY.md §4）跑 10–30 个真实 repo 任务并公开数据
5. 更新 V0.4 parity 文档中已过时的 `/model` 结论

---

## 七、勘误：v0.4.0-beta.2 增量补丁已补齐的缺口

> 追加于 2026-07-21：本节由增量补丁实施者填写，用以修订上文第六章结论与迭代优先级建议。

原报告第六章「最终结论」中关于 opencode 对标的"四个硬能力缺口"以及"迭代优先级建议"
中第 1–3 项与第 5 项（`/model` 部分）已在 v0.4.0-beta.2 的增量补丁中补齐：

| 原缺口                                              | 补齐情况（v0.4.0-beta.2）                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rg` 硬依赖无 fallback（迭代优先级 #1）             | ✅ 已补齐。`packages/agent-runtime/src/rg-fallback.ts` 提供 `grepRecursive`/`listFiles`，含 gitignore 子集解析、二进制检测（8KB NUL 探测）、>5MB 文件跳过；进程级缓存探测 `spawnSync rg --version`，metadata 标 `backend: "rg"\|"fallback"`；`grep`/`find` 工具先探测再 fallback，不再硬失败                              |
| 无 MCP 运行时（迭代优先级 #2）                      | ✅ 已补齐。`packages/agent-runtime/src/mcp.ts` 实现 stdio JSON-RPC 2.0 行分隔协议客户端；`registerMcpServers` 启动期发现工具并按 `mcp_<serverId>_<toolName>` 命名；effect 映射 `readOnlyHint→read`/`destructiveHint→write`/其余→network；`computeToolPin`/`verifyPins` fail-closed pin 校验；`/mcp list\|reload` TUI 命令 |
| 无 LSP 诊断回喂（迭代优先级 #3，半项）              | ✅ 已补齐。`packages/agent-runtime/src/diagnostics.ts` 的 `shouldRunDiagnostics`（tsconfig 存在 + `node_modules/.bin/tsc` 优先）+ `runDiagnostics`（复用 runProcess 环境白名单，截断 8000 字符）；每次 write/edit/apply_patch 成功后自动追加诊断输出到上下文                                                              |
| 无 todo/task 工具（迭代优先级 #3，半项）            | ✅ 已补齐。`packages/agent-runtime/src/todo.ts` 提供 `TodoState`（pending/in_progress/completed 状态机）+ `createTodoTool`（effect:"read"），校验 id 唯一、content ≤200、items ≤50；todo 状态以 Markdown checkbox 进入 system prompt                                                                                      |
| 无子代理委派（结论 §3 硬能力缺口之一）              | ✅ 已补齐。`packages/agent-runtime/src/delegate.ts` 用 DI 方案（`DelegateContext.createAgent` 工厂注入）；子代理共享 modelClient/permission，剔除 delegate/bash/todo 工具，使用内存 SessionStore，规避循环依赖                                                                                                            |
| 无 web_fetch / web_search                           | ✅ 已补齐。`packages/agent-runtime/src/web-tools.ts`：`web_fetch` 仅 http/https、拒绝内嵌凭据、20s 超时、2MB 上限、HTML→text；`web_search` 默认 DuckDuckGo lite，`searchEndpoint` 可覆盖                                                                                                                                  |
| 无文件级检查点/undo（原报告 §13 第 5 项）           | ✅ 已补齐。`packages/agent-runtime/src/checkpoints.ts` 的 `CheckpointStore` 在 write/edit/apply_patch 前以相对路径快照文件 + `focuscode-checkpoint.v1` manifest，上限 50 淘汰最旧，目录 0700/文件 0600；`/undo` 命令与 `CodingAgent.undoCheckpoint()` API 回滚到上一个文件状态（区别于 session fork 的对话分叉语义）      |
| TUI 缺语法高亮深度（原报告 §13 第 6 项）            | ✅ 已补齐。`packages/tui/src/syntax.ts` 的 `highlightCode(text, lang, theme)` 支持 ts/js/json/bash/markdown，先 sanitize 再高亮；集成进 `markdown.ts` 渲染 ```fence 代码块                                                                                                                                                |
| TUI 缺 Model 选择器（迭代优先级 #5 部分）           | ✅ 已补齐。`packages/tui/src/picker.ts` 完整实现：顶部模糊搜索、Tab 切 provider、Alt+S session-only、↑↓ 导航、Enter 确认、←→ 切 Low/High/Max reasoning effort；UI 顶部提示「Switching models invalidates the existing prompt cache」；`Alt+M`/`Ctrl+M` 唤起；绕过 keymap.ts 限制直接拦截 `ESC m`/`ESC s` 字节序列         |
| CLI 缺 --list-models 模型目录（原报告 §13 第 6 项） | ✅ 已补齐。`apps/cli/src/agent-command.ts` 的 `--list-models` 早退分支 `printModels()` 按 provider 分组输出                                                                                                                                                                                                               |
| CLI 缺费用面板（原报告 §13 第 6 项）                | ✅ 已补齐。`--cost` 在 print/json 模式下打印费用汇总 `printCostPanel(usage, config)`，基于 `pricing.<provider>/<model>` 单价表；TUI `/cost` 命令随时查看                                                                                                                                                                  |

### 同时完成的扩展能力（原报告未列入缺口，但与对标能力相关）

- **9 级伙伴成长系统**：`CompanionState` + `XP_LEVELS = [0, 50, 150, 300, 500, 800, 1200, 1800, 2500]` + `LEVEL_NAMES`（幼尾小福 → 九尾天福），每级对应 1–9 个尾巴；`applyTurnReward` 每 model round +1 XP、每 tool call +2 XP；状态持久化到 `~/.focuscode/companion.json`；`fox companion` 与 `fox companion reset` CLI 子命令
- **8 mood 像素游戏风帧动画**：`MascotMood` 从 5 种扩到 8 种（`idle`/`thinking`/`working`/`happy`/`oops`/`sleeping`/`celebrating`/`levelup`）；`PIXEL_FOXY_FRAMES` 与 `PIXEL_MASCOT_FRAMES` 使用块字符 `█▀▄░▒▓`；所有 7 只伙伴补齐 sleeping/celebrating/levelup 帧
- **fox 默认主题**：谐音 focus，深暖黑底配亮橙与暖金（233/208/221），`DEFAULT_THEME_ID = "fox"`
- **皮肤包格式**：`focuscode-skin.v1` canonical JSON + 严格校验；4 套内置皮肤（sakura/ocean/arcade/matcha）+ 用户导入；`fox skins list/apply/import/export/remove` 完整生命周期；TUI `/skin [import|export|builtin]` 一键切换
- **8 个新 slash 命令**：`/init`、`/undo`、`/cost`、`/todo [add|done|clear]`、`/mcp [list|reload]`、`/diagnostics [on|off]`、`/character [list|<id>]`、`/skin [import|export|builtin]`
- **CLI 子命令扩展**：`fox skins`、`fox character`、`fox companion`；`fox doctor` 增强检查 MCP 连通性、checkpoint 目录可写、companion 文件完整性
- **TUI widgets**：`progressBar`/`costBar`/`levelBadge` 纯函数；`renderer.ts` 渲染到状态栏
- **companion 持久化**：levelup mood + 3 秒回退 + `~/.focuscode/companion.json`

### 仍待完成（与原报告一致）

- **真实任务 A/B 基准报告**（迭代优先级 #4）：仍未跑，是判定"是否真能与 Pi/opencode 对标"的最后一块证据
- **V0.4 parity 文档勘误**：`/model` 选择器已实现，但 `docs/V0.4_PI_PARITY_ANALYSIS.md` 文档本身尚未更新
- **75+ provider 广度**：仍只支持五系国产 + OpenAI/Anthropic/Gemini/Ollama，opencode 的 75+ provider 短期内无法弥合
- **IME preedit / 文本 selection**：TUI 仍未实现输入法预编辑和文本选择（属打磨度问题，不影响 coding 能力）

### 验证结果

- 23 个 workspace 项目全部构建通过
- 53 个测试文件 / 404 个测试通过 / 10 skipped
- 覆盖率：Statements 78.8% / Branches 68.62% / Functions 84.11% / Lines 82.35%（全部超阈值 75/60/80/80）
- 新增模块覆盖率：`mcp.ts` 85.83%、`rg-fallback.ts` 91.11%、`todo.ts` 95.65%、`web-tools.ts` 81.37%、`companion.ts` 100%、`picker.ts` 97.7%、`pixel-frames.ts` 100%、`skins.ts` 92.7%、`syntax.ts` 92.24%、`widgets.ts` 95.83%
- 架构边界（`scripts/check-boundaries.mjs`）、schema-sync、prettier 全部通过

### 结论修订

原报告第六章 §3 的结论"**目前不能**与 opencode 对标"中的"四个硬能力缺口"已缩减为
**两个**：provider 广度（75+ vs 9）与基准测试成绩。**MCP 运行时、LSP 诊断回喂、
todo/subagent 工具三块均已补齐**。原报告"作为日常 coding agent 不能与 opencode 对标"
的判断需要修订为：**作为日常 coding agent，FocusCode 的硬能力已基本具备直接对标的
条件**，最终能否真对标取决于公开基准测试成绩与 provider 广度——这两块仍是 opencode 的
护城河，但已不是 FocusCode 的硬能力缺口。

原报告第六章 §1 关于"TUI/CLI 是完整、自洽、可运行的"判断仍然成立；rg 硬依赖、
无语法高亮深度两项打磨度问题已修复；IME preedit 与文本 selection 仍未实现，属已知
打磨度缺口。
