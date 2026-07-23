# FocusCode Fox 完整使用教程

> 最后更新：2026-07-21 ｜ 适用版本：focuscode-fox 0.4.0-beta.2（含能力缺口补齐增量）
> 难度：入门到中级 ｜ 预计耗时：40 分钟

## 教程概览

FocusCode Fox 是一个模型可移植、策略可控的终端 Coding Agent。学完本教程，你将能够：安装并启动 `fox` 命令进入全屏 TUI；接入任意一家大模型（Kimi / Qwen / GLM / DeepSeek / MiniMax / OpenAI / Anthropic / Gemini / 本地 Ollama）；让 Agent 在你的仓库里读写代码、执行命令；使用会话管理、中途引导（steering）、图片输入；并按团队要求进行沙箱隔离与企业化配置。全程由小狐狸 **Foxy 小福**（编程配备鼓励师）陪伴。

---

## 1. 前置知识

**必须掌握**：

- 终端基本操作：所有交互都在终端完成，需要会切换目录、设置环境变量
- 至少一个大模型 API Key：Agent 本身不带模型，需要你提供任一厂商的 Key（在各厂商开放平台申请）

**了解即可**：

- Docker：只有想用「沙箱隔离执行」时才需要安装（推荐但不强制）
- JSON 语法：自定义主题、伙伴、快捷键时会写简单的 JSON 文件

---

## 2. 环境搭建

### 2.1 环境清单

| 工具             | 版本要求                   | 用途                                            |
| ---------------- | -------------------------- | ----------------------------------------------- |
| Node.js          | **>= 22.12.0（硬性要求）** | 运行时                                          |
| ripgrep (`rg`)   | 任意近期版本               | grep/find 工具的底层搜索引擎，**强烈建议安装**  |
| Docker 或 gVisor | 可选                       | 命令沙箱隔离；没有则只能显式用 `--sandbox host` |
| pnpm             | 11.7.0                     | 仅从源码重新构建时才需要                        |

### 2.2 安装步骤

**macOS**：

```bash
# 安装 Node 22（通过 Homebrew）
brew install node@22
# 安装 ripgrep（Agent 的文件搜索依赖它）
brew install ripgrep
```

**Linux (Ubuntu/Debian)**：

```bash
# 安装 Node 22（通过 NodeSource 官方仓库）
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
# 安装 ripgrep
sudo apt install -y ripgrep
```

**验证环境**：

```bash
node --version    # 预期输出：v22.x.x（低于 v22.12.0 会直接拒绝运行）
rg --version      # 预期输出：ripgrep 14.x.x
```

### 2.3 安装 FocusCode Fox

解压你拿到的工程包后，有两种使用方式：

```bash
# 方式一（推荐）：全局安装，获得 fox / fc / focus / focuscode 四个命令
cd focuscode-fox/apps/cli
npm install --global .

# 方式二：免安装直接运行内置 bundle（已随包构建好）
node focuscode-fox/apps/cli/bundle/focuscode.mjs --version
```

**验证安装**：

```bash
fox --version
# 预期输出：0.4.0-beta.2
fox --list-providers
# 预期输出：kimi / qwen / glm / deepseek / minimax / openai / anthropic / gemini / ollama 等预设列表
```

> 如需从源码重新构建：`corepack enable && corepack prepare pnpm@11.7.0 --activate`，然后在工程根目录执行 `pnpm install --frozen-lockfile && pnpm build && pnpm test`。

---

## 3. 核心步骤

#### 步骤 1：配置模型并第一次启动 TUI

**目标**：看到 Foxy 小狐狸的欢迎屏。

**操作**（以 Kimi 为例，其他厂商见文末速查表）：

```bash
export MOONSHOT_API_KEY="YOUR_MOONSHOT_API_KEY"   # 在 platform.moonshot.cn 申请
cd YOUR_PROJECT_DIR                                # 你想让 Agent 工作的代码仓库
fox                                                # 裸命令直接进入全屏 TUI
```

**解释**：

- `fox`、`fc`、`focus`、`focuscode` 四个命令完全等价；TTY 中不带参数运行默认进入 TUI
- 未指定 `--sandbox` 时默认 `auto`（gVisor → Docker → 拒绝）。如果机器没有 Docker，需要显式加 `--sandbox host`，CLI 会打印安全警告，这是设计使然
- 想用别家模型，换成对应的 Key 和 `--provider` 即可，例如 `fox --provider qwen`（配 `DASHSCOPE_API_KEY`）

**验证**：屏幕进入全屏界面，左侧是眨眼的小狐狸，对话区有一幅狐狸 ASCII 画和「🦊 Foxy 小福 · Focus 小狐狸」欢迎语。

#### 步骤 2：完成第一轮对话

**目标**：让 Agent 在仓库里创建第一个文件。

**操作**：在 `fox»` 提示符后直接输入：

```text
创建一个 hello.js，导出一句问候语，并告诉我文件内容
```

**解释**：

- 输入时左侧小狐狸会切换 mood：思考（?）→ 敲键盘（⌨）→ 开心（✨）
- 忙的时候状态栏有 Braille 转圈动画；工具调用以 `⚙ ›` 标签展示，助手回复以 `fox ›` 展示
- 每个关键时刻 Foxy 都会说一句鼓励话；觉得吵可以输入 `/cheer off` 关闭，`/cheer on` 重新开启

**验证**：对话区出现 ` ⚙ › write · xx ms` 和「写好了」的回复；`ls hello.js` 文件真实存在。

#### 步骤 3：掌握审批模式（安全闸门）

**目标**：理解并切换四种审批模式。

**操作**：在 TUI 中输入：

```text
/approval ask
```

**解释**：

- `ask`：每个写文件/执行命令操作都问你一次（输入 `y` + 回车批准）——学习期推荐
- `auto-edit`：自动批准文件编辑，危险 shell 命令仍需确认
- `full-auto`：全部自动，适合隔离环境
- `deny`：全部拒绝，只读分析
- 也可以用启动参数 `--approval ask` 预设。**注意**：管道/CI 等非交互环境下 `ask` 会自动降级为 `deny`，不会卡死等待

**验证**：切到 `ask` 后再让 Agent 改文件，状态栏会出现审批提问。

#### 步骤 4：中途引导（steering）——Agent 运行中纠偏

**目标**：学会三种不中断会话的纠偏方式。

**操作**：

```text
# 1. Agent 正在工作时，直接输入新文字回车 → 排入追加队列，当前轮边界处生效
别忘了顺便加个 npm script

# 2. 立即打断当前模型生成，换方向
/interrupt 不要用 lodash，改成原生实现

# 3. 等当前响应全部完成后再追加工作
/followup 写完之后把 README 也更新一下
```

**解释**：三类 steering 共用容量 32 的有界队列；`/interrupt` 只打断模型生成，**不会撤销已执行的工具效果**（已写入的文件不会回滚）；`/unsteer` 可以移除队列中的条目。

**验证**：状态栏出现 `queued N` 计数和「Steering applied.」提示。

#### 步骤 5：会话管理——暂停、恢复、分叉

**目标**：关闭 TUI 后能找回之前的工作现场。

**操作**：

```bash
fox --list-sessions        # 列出当前仓库的所有会话
fox -c                     # 继续最近一次会话
fox -r                     # 从列表选择恢复
```

TUI 内也可以用斜杠命令：

```text
/sessions      # 列出会话
/resume <id>   # 切换到指定会话
/fork          # 从当前节点分叉一个新分支（放心试错）
/tree          # 查看会话树结构
/export        # 导出为 HTML 存档
```

**解释**：会话以 JSONL 形式存在 `~/.focuscode/sessions/<仓库哈希>/`，按工作目录隔离；换模型、换机器都不会丢本地会话。

**验证**：退出 TUI 后执行 `fox -c`，之前的对话记录完整重现。

#### 步骤 6：图片输入——按截图改代码

**目标**：把一张 UI 截图喂给 Agent。

**操作**：

```bash
fox -i ./design.png "按这张截图修复登录页布局"
```

或在 TUI 内：

```text
/image ./design.png        # 附加图片（macOS 上不带参数则读剪贴板）
/images                    # 查看待发送图片
/image clear               # 清空
```

**解释**：支持 PNG/JPEG/WebP/GIF，本地路径或 HTTPS URL；模型不支持图片时会被明确拦截并报错，而不是静默丢弃。企业模式默认禁止远程 URL。

**验证**：回复中出现对截图内容的描述。

#### 步骤 7：个性化——主题、伙伴、快捷键

**目标**：打造自己的终端氛围。

**操作**：

```bash
fox mascots                 # 查看 7 只伙伴（foxy/mochi/byte/nori/pico/bubu/kumo）
fox themes                  # 查看 7 套主题（fox/foxglow/aurora/candy/forest/midnight/mono）
fox --theme candy --mascot pico
```

写入项目配置（`.focuscode/agent.json`），团队共享：

```json
{
  "schemaVersion": "focuscode-agent.v1",
  "tui": {
    "theme": "fox",
    "mascot": "foxy",
    "keymap": { "ctrl+x": "abort", "ctrl+g": "cycle_mascot" }
  }
}
```

**解释**：`Ctrl+G` 运行时轮换伙伴、`Ctrl+T` 轮换主题；自定义主题/伙伴 JSON 会经过严格校验（拒绝 ANSI 控制字符注入）。**`fox` 主题为 v0.4.0-beta.2 起的默认主题**（谐音 focus，深暖黑底配亮橙与暖金）。

**验证**：`fox --theme aurora` 启动后界面变为蓝绿色调。

#### 步骤 7.5：一键换肤与皮肤包导入（v0.4.0-beta.2 新增）

**目标**：像 codexskin.cn 那样一键切换整套视觉风格，并支持用户自建皮肤包导入。

**操作**：

```bash
fox skins list                  # 列出所有可用皮肤（内置 + 用户导入）
fox skins apply sakura          # 应用名为 sakura 的内置皮肤
fox skins apply ocean           # 应用 ocean 海蓝皮肤
fox skins apply arcade          # 应用 arcade 街机风皮肤
fox skins apply matcha          # 应用 matcha 抹茶绿皮肤
```

TUI 内也可以一键切换：

```text
/skin                       # 列出所有皮肤
/skin builtin sakura         # 切到内置皮肤 sakura
/skin import ./my-skin.json  # 导入用户自建皮肤包
/skin export ./out.json     # 导出当前皮肤
```

**自建皮肤包格式**（`focuscode-skin.v1`）：

```json
{
  "schemaVersion": "focuscode-skin.v1",
  "id": "my-theme",
  "name": "我的皮肤",
  "theme": { "bg": 233, "fg": 255, "accent": 208, "muted": 240, "border": 235 },
  "mascot": { "id": "foxy", "frameSet": "pixel" },
  "signature": "可选签名"
}
```

**解释**：皮肤包是 canonical JSON 文档，导入时会严格校验 `schemaVersion`、必需字段、ANSI
注入；签名可选（与扩展签名策略不同——皮肤包仅影响渲染，不执行代码）。导入后存到
`~/.focuscode/skins/<id>.json`，`fox skins remove <id>` 可移除。

**验证**：`fox skins apply sakura` 后界面立即变为樱花粉色调。

#### 步骤 7.6：Foxy 九级成长系统（v0.4.0-beta.2 新增）

**目标**：让 Foxy 真正"陪伴"你成长——每次对话、每次工具调用都给她 XP，9 个等级对应 9 个尾巴。

**操作**：

```bash
fox companion                 # 查看 Foxy 当前等级、XP、尾巴数、累计 turns
```

TUI 内无需手动操作——每完成一轮对话 +1 XP，每次工具调用 +2 XP，达到里程碑（如 100 turns）
有奖励加成。**levelup 时 Foxy 会切换到 `celebrating` mood 持续 3 秒后回退**，状态栏右侧渲染
`levelBadge`（等级徽章）。

**9 个等级与尾巴对应**：

| 等级 | 名称     | 尾巴数 | 累计 XP |
| ---- | -------- | ------ | ------- |
| 1    | 幼尾小福 | 1      | 0       |
| 2    | 二尾小福 | 2      | 50      |
| 3    | 三尾小福 | 3      | 150     |
| 4    | 四尾小福 | 4      | 300     |
| 5    | 五尾小福 | 5      | 500     |
| 6    | 六尾小福 | 6      | 800     |
| 7    | 七尾小福 | 7      | 1200    |
| 8    | 八尾小福 | 8      | 1800    |
| 9    | 九尾天福 | 9      | 2500    |

**8 种 mood 与像素游戏风帧动画**：idle / thinking / working / happy / oops / sleeping /
celebrating / levelup——每只伙伴都有 2 帧动画，使用块字符 `█▀▄░▒▓` 渲染像素游戏风。

**状态持久化**：`~/.focuscode/companion.json` 保存 Foxy 的等级、XP、总 turns，跨会话不丢失。
想从头开始可以 `fox companion reset`。

**验证**：连续让 Agent 干几轮活后，状态栏右侧出现等级徽章；`fox companion` 命令显示当前
等级和尾巴数。

#### 步骤 7.7：Model 选择器与思考强度切换（v0.4.0-beta.2 新增）

**目标**：在 TUI 中随时切换模型与 reasoning effort，无需重启会话。

**操作**：在 TUI 中按 `Alt+M`（或 `Ctrl+M`）唤起 Model 选择器：

```text
Select a model (type to search)

Tab toggle provider · ↑↓ navigate · Enter select · Alt+S session-only · Esc cancel
Note: Switching models invalidates the existing prompt cache. Use /new to avoid extra token costs.

All
  Kimi Code
    K2.7 Coding
    K2.7 Coding Highspeed
    K3                        ← current
  Kimi Code

Thinking  (←→ to switch)
  Low
  [ High ]
  Max
```

**解释**：

- **Tab**：切换 provider 分组（All / Kimi / Qwen / GLM / DeepSeek / MiniMax / OpenAI / Anthropic / Gemini）
- **↑↓**：在当前分组内导航
- **Enter**：确认切换（默认写入配置）
- **Alt+S**：仅当前会话切换，不写入配置（适合临时试用别的模型）
- **←→**：在 Low / High / Max 三档 reasoning effort 之间切换
- **Esc**：取消

**验证**：切换后 TUI 头部显示新模型名；下一次对话使用新模型。

#### 步骤 7.8：新工具命令（v0.4.0-beta.2 新增）

**目标**：掌握 8 个新 slash 命令，覆盖初始化、回滚、费用、任务清单、MCP、诊断等场景。

**操作**：

```text
/init                       # 在当前仓库生成 .focuscode/agent.json 模板
/undo                       # 回滚最近一次 write/edit/apply_patch
/cost                       # 查看当前会话 token 用量与估算费用
/todo add 实现登录页        # 添加任务
/todo done <id>             # 标记任务完成
/todo clear                 # 清空任务清单
/mcp list                   # 列出已注册的 MCP server 与工具
/mcp reload                 # 重载 MCP server 配置
/diagnostics on             # 开启 LSP 诊断回喂（默认开启）
/diagnostics off            # 关闭
```

**对应 CLI 长选项**：

```bash
fox --list-models           # 早退打印按 provider 分组的可用模型清单
fox --cost                  # print/json 模式下追加费用汇总
fox -p --cost --sandbox host "修复失败的测试"
```

**解释**：

- `/init` 会写入最小可用的配置模板，包含 `schemaVersion`、`provider`、`sandbox`、`tui` 等字段
- `/undo` 基于文件级 CheckpointStore，**只回滚文件操作不回滚对话**；session fork 用于对话分叉
- `/cost` 基于 `pricing.<provider>/<model>` 单价表估算，未配置单价的模型只显示 token 数
- `/todo` 状态会进入 system prompt，模型能看到 Markdown checkbox 渲染并自跟踪进度
- `/mcp` 工具按 `mcp_<server>_<tool>` 命名，pin 校验 fail-closed
- `/diagnostics` 在 tsconfig 存在 + `node_modules/.bin/tsc` 可用时自动调用 tsc，截断 8000 字符

**验证**：`/cost` 显示当前 token 累计；`/todo add` 后状态栏出现任务计数。

#### 步骤 7.9：伙伴与皮肤 CLI 子命令（v0.4.0-beta.2 新增）

**目标**：从命令行管理伙伴、皮肤和成长状态（适合在脚本或 CI 中预设）。

**操作**：

```bash
fox character list          # 列出 7 只伙伴
fox character foxy          # 切换默认伙伴为 foxy
fox character pico          # 切换为 pico

fox skins list              # 列出所有皮肤
fox skins apply sakura      # 应用 sakura 皮肤
fox skins import ./my.json  # 导入用户皮肤包
fox skins export ./out.json # 导出当前皮肤
fox skins remove my-skin    # 移除已导入皮肤

fox companion               # 查看 Foxy 等级、XP、尾巴数、总 turns
fox companion reset         # 重置成长状态
```

**验证**：`fox character pico` 后启动 `fox`，TUI 显示 pico 伙伴动画。

#### 步骤 8：自动化集成——print / json / rpc 模式

**目标**：在脚本和 CI 中使用 FocusCode。

**操作**：

```bash
# 一次性执行并退出（脚本友好）
fox -p --approval auto-edit --sandbox host "修复失败的测试并总结原因"

# NDJSON 事件流（程序消费）
fox --mode json -p "review 这个仓库" | jq -r 'select(.type=="text_delta") | .delta' | tr -d '\n'

# JSON-RPC 长连接（嵌入自己的工具）
fox --mode rpc --approval deny
```

**解释**：五种模式共享同一个 Agent 内核，只是事件渲染器和审批回调不同；`--no-session` 可不落盘。

**验证**：`-p` 模式下命令执行完自动退出并返回结果文本。

#### 步骤 9：接入自建模型网关（多模型 + 各自 context）

**目标**：把一个 OpenAI 兼容的自建网关（Token 套餐）接入 fox，网关下多个模型各有不同的上下文窗口，一次配置、随处可用。

**场景设定**：网关 `http://agi-gateway/v1`，API Key 一个，可用模型 `deepseek-v4-flash`、`qwen3.6-35b-a3b`、`deepseek-v4-pro-fp4`、`glm-5.2`，每个模型 context 不同。

**操作**：编辑全局配置 `~/.focuscode/config.json`：

```json
{
  "schemaVersion": "focuscode-agent.v1",
  "provider": "agi",
  "model": "deepseek-v4-pro-fp4",
  "providers": {
    "agi": {
      "protocol": "openai-chat",
      "baseUrl": "http://agi-gateway/v1",
      "apiKeyEnv": "AGI_API_KEY"
    }
  },
  "models": {
    "agi/deepseek-v4-flash": { "contextWindow": 128000, "maxOutputTokens": 8192 },
    "agi/qwen3.6-35b-a3b": { "contextWindow": 128000, "maxOutputTokens": 8192 },
    "agi/deepseek-v4-pro-fp4": { "contextWindow": 256000, "maxOutputTokens": 16384 },
    "agi/glm-5.2": { "contextWindow": 200000, "maxOutputTokens": 16384 }
  }
}
```

然后：

```bash
export AGI_API_KEY="YOUR_API_KEY"   # 网关控制台发放的 Key
fox                                  # 裸启动即用默认模型 deepseek-v4-pro-fp4
fox --model qwen3.6-35b-a3b          # 临时换模型，自动应用对应的 context 配置
```

**解释**：

- `providers.agi` 定义网关：协议、地址、Key 从哪个环境变量读（配置里**不存明文 Key**）
- `models` 表按 `provider/模型名` 为每个模型单独声明 `contextWindow` / `maxOutputTokens`；省略的模型回落到 provider 默认（128k/16k）。**表中的数值只是占位示例，请按你套餐文档里每个模型的真实上下文填写**——填错会导致压缩时机错误（填小了浪费上下文，填大了会被网关截断报错）
- 顶层 `provider`/`model` 是默认值，配好后裸 `fox` 直接可用；TUI 内 `/model deepseek-v4-flash` 中途切换同样会重新解析这套配置
- `models` 条目还能覆盖更多字段：`toolMode`（开源模型不稳时设 `"prompt-json"`）、`temperature`、`reasoningEffort`、`capabilities`（如声明支持图片）、`extraHeaders`（网关要求自定义头时）

**验证**：

```bash
fox -p --sandbox host --approval full-auto "用一个字回答：好"
# 预期输出：好
fox
# TUI 头部显示当前模型；/model 切换后头部同步变化
```

---

## 4. 常见报错与排查

**报错 1：`No isolated sandbox is available; install Docker/gVisor or configure a VM. Host fallback is disabled.`**

原因：默认 `--sandbox auto` 找不到 Docker/gVisor，且**设计上拒绝静默回退到宿主机**。

解决方案（二选一）：

```bash
# 方案 A：安装 Docker（推荐，获得真实隔离）后重试
docker info
# 方案 B：理解风险后显式使用宿主机执行
fox --sandbox host
```

验证修复：`fox sandbox doctor --kind auto` 返回可用。

**报错 2：工具调用报 `spawn rg ENOENT`**

原因：没装 ripgrep，grep/find 工具硬依赖它。

解决方案：`brew install ripgrep` 或 `sudo apt install -y ripgrep`；验证 `rg --version` 有输出。

**报错 3：`Full-screen TUI requires a TTY`**

原因：在管道、重定向或某些 CI 环境中启动了 TUI 模式。

解决方案：非交互场景改用 `fox -p "..."` 或 `--mode json`；本地请直接在终端里运行 `fox` 而不是 `fox | cat`。

**报错 4：引擎版本拒绝（engines node >=22.12.0）**

原因：Node 版本过低，`Intl.Segmenter` 等特性缺失。

解决方案：`node --version` 确认；用 brew / NodeSource / nvm 升到 22.12+。

**报错 5：审批模式被自动改成 deny，并看到 stderr 警告**

原因：这是安全特性——非 TTY 输入无法回答审批，系统拒绝「非交互静默提权」。

解决方案：自动化场景显式声明意图：`fox -p --approval auto-edit ...`。

**报错 6：`Unknown option: --xxx`**

原因：参数名拼写错误；CLI 对未知参数是严格报错的（防手滑提权）。

解决方案：`fox --help` 对照完整参数表。

**报错 7：模型返回 401 / 鉴权失败**

原因：环境变量名与厂商不匹配（例如把 Kimi 的 Key 放进了 `OPENAI_API_KEY`）。

解决方案：对照速查表中的「厂商 → 环境变量」映射；也可用 OAuth：`fox auth login google --device`。

---

## 5. 进阶拓展

**方向 1：沙箱隔离执行** ｜ 难度：中级

默认 `auto` 模式按 gVisor → Docker 顺序探测，容器默认断网。生产环境建议构建带工具链的专用镜像并用 digest 固定：`fox --sandbox docker --sandbox-image registry.example.com/focus/node22@sha256:YOUR_DIGEST`。还可通过 SSH 接入一次性 VM（`--sandbox vm --vm-host ...`）。

**方向 2：OAuth 与企业身份** ｜ 难度：中级

支持 PKCE / Device Flow / OIDC discovery，凭据存进 AES-256-GCM 加密库，多账号切换：`fox auth login enterprise --issuer https://YOUR_IDP --client-id YOUR_CLIENT_ID`，然后 `fox --oauth-account default`。

**方向 3：扩展生态** ｜ 难度：高级

`fox extension pack/install/list/remove` 支持 npm 包形式分发扩展，带签名校验、权限声明（network/shell 需显式 `--allow-*`）和锁文件；扩展可运行在独立进程，崩溃不拖垮主会话。参考 `examples/extension-hello`。

**方向 4：签名会话分享** ｜ 难度：高级

`fox share export --session SESSION_ID` 导出 Ed25519 签名、默认脱敏（去除工具输出/图片二进制/常见凭据）的会话包，同事 `fox share import` 前会验签——适合 Code Review 和事故复盘。

**方向 5：企业模式** ｜ 难度：高级

`fox init --enterprise --sandbox-image IMAGE@sha256:DIGEST` 生成 fail-closed 配置：Provider/模型/扩展/远程图片/沙箱全部走允许列表，`fox doctor` 返回 `"ready": true` 才允许进入冒烟测试。

**最佳实践**：

- 学习期用 `--approval ask` + `--sandbox docker`；CI 用 `-p --approval auto-edit` 并明确 `--tools` 白名单
- `--exclude-tools bash` 可做纯只读代码评审
- 项目级配置放 `.focuscode/agent.json`，注意它只在 `--trust-project` 时生效——不信任的仓库不会偷塞配置

---

## 6. Cheatsheet 速查表

### 环境信息

| 项目          | 命令/路径                           |
| ------------- | ----------------------------------- |
| 安装          | `npm install --global ./apps/cli`   |
| 版本检查      | `fox --version`                     |
| 会话存储      | `~/.focuscode/sessions/<仓库哈希>/` |
| 项目配置      | `<仓库>/.focuscode/agent.json`      |
| 全局扩展      | `~/.focuscode/extensions/`          |
| 用户皮肤包    | `~/.focuscode/skins/<id>.json`      |
| Foxy 成长状态 | `~/.focuscode/companion.json`       |

### 厂商 → 环境变量

| 厂商               | 环境变量            | 启动                                                                                                                      |
| ------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Kimi               | `MOONSHOT_API_KEY`  | `fox --provider kimi`                                                                                                     |
| Qwen               | `DASHSCOPE_API_KEY` | `fox --provider qwen`                                                                                                     |
| GLM                | `ZAI_API_KEY`       | `fox --provider glm`                                                                                                      |
| DeepSeek           | `DEEPSEEK_API_KEY`  | `fox --provider deepseek`                                                                                                 |
| MiniMax            | `MINIMAX_API_KEY`   | `fox --provider minimax`                                                                                                  |
| OpenAI             | `OPENAI_API_KEY`    | `fox --model openai/gpt-5`                                                                                                |
| Anthropic          | `ANTHROPIC_API_KEY` | `fox --model anthropic/MODEL_ID`                                                                                          |
| Gemini             | `GEMINI_API_KEY`    | `fox --model gemini/MODEL_ID`                                                                                             |
| Ollama 本地        | 无需                | `fox --provider ollama --model qwen3-coder --sandbox host`                                                                |
| 自建网关（自定义） | `AGI_API_KEY`       | `fox --provider agi --model deepseek-v4-pro-fp4`（需在 `~/.focuscode/config.json` 配置 `providers` + `models`，见步骤 9） |

### 配置文件关键字段（`~/.focuscode/config.json`）

| 字段                                                        | 作用                                              |
| ----------------------------------------------------------- | ------------------------------------------------- |
| `provider` / `model`                                        | 默认 provider 与模型（裸 `fox` 生效）             |
| `providers.<id>.baseUrl` / `.apiKeyEnv` / `.protocol`       | 自定义网关地址、Key 环境变量、协议                |
| `models.<provider/模型>.contextWindow` / `.maxOutputTokens` | 按模型单独声明上下文与输出上限                    |
| `models.<id>.toolMode`                                      | `native` / `prompt-json` / `auto`（开源模型兜底） |
| `tui.theme` / `tui.mascot` / `tui.keymap`                   | 界面个性化                                        |

### TUI 斜杠命令（按使用频率）

| 命令                                  | 作用                                 |
| ------------------------------------- | ------------------------------------ |
| `/help`                               | 全部命令速览                         |
| `/cheer on\|off`                      | Foxy 鼓励师开关                      |
| `/interrupt <指令>`                   | 立即打断当前生成并转向               |
| `/followup <指令>`                    | 本轮完成后追加工作                   |
| `/approval <模式>`                    | ask / auto-edit / full-auto / deny   |
| `/model`                              | 打开 Model 选择器（Alt+M 唤起）      |
| `/character [list\|<id>]`             | 切换 7 只伙伴之一                    |
| `/skin [import\|export\|builtin]`     | 一键换肤或导入皮肤包                 |
| `/init`                               | 生成 `.focuscode/agent.json` 模板    |
| `/undo`                               | 回滚最近一次文件操作                 |
| `/cost`                               | 查看当前会话 token 与费用            |
| `/todo [add\|done\|clear]`            | 任务清单（pending/in_progress/done） |
| `/mcp [list\|reload]`                 | MCP server 与工具管理                |
| `/diagnostics [on\|off]`              | LSP 诊断回喂开关                     |
| `/compact`                            | 压缩上下文                           |
| `/image <路径>`                       | 附加图片                             |
| `/sessions` `/resume` `/fork` `/tree` | 会话管理                             |
| `/export`                             | 导出 HTML                            |
| `/exit`                               | 退出                                 |

### 快捷键

| 键位                | 作用                          |
| ------------------- | ----------------------------- |
| `Enter` / `Ctrl+O`  | 提交 / 换行                   |
| `Ctrl+C` / `Ctrl+D` | 中止当前轮 / 退出             |
| `Tab`               | 命令与文件路径补全            |
| `Ctrl+G` / `Ctrl+T` | 轮换伙伴 / 主题               |
| `Alt+M` / `Ctrl+M`  | 唤起 Model 选择器             |
| `Alt+S`（选择器内） | 仅当前会话切换模型            |
| `Tab`（选择器内）   | 切换 provider 分组            |
| `←` `→`（选择器内） | 切 Low / High / Max reasoning |
| `↑` `↓`             | 历史输入 / 选择器导航         |

### 快速排错

| 症状                        | 原因                          | 快速修复                                                                    |
| --------------------------- | ----------------------------- | --------------------------------------------------------------------------- |
| No isolated sandbox         | 无 Docker 且 auto 拒绝回退    | `--sandbox host`                                                            |
| `spawn rg ENOENT`           | 缺 ripgrep（已自动 fallback） | 可装 `apt/brew install ripgrep`，未装也能用                                 |
| requires a TTY              | 管道中开 TUI                  | 改用 `-p` 或 `--mode json`                                                  |
| 审批被降级 deny             | 非交互环境安全设计            | 显式 `--approval auto-edit`                                                 |
| Node 版本拒绝               | < 22.12                       | 升级 Node 22                                                                |
| `/undo` 报 not available    | 上游未启用 checkpoints        | 在 `.focuscode/agent.json` 加 `"agent": {"checkpoints": {"enabled": true}}` |
| `/cost` 只显示 token 没价格 | 未配置 pricing 表             | 在 `~/.focuscode/config.json` 加 `pricing.<provider>/<model>` 单价          |

## 附录

**术语表**

| 术语          | 解释                                                        |
| ------------- | ----------------------------------------------------------- |
| Harness       | 模型之外的工程外壳：工具、权限、会话、沙箱的总称            |
| Steering      | 不打断会话的中途引导（append / interrupt / follow-up 三类） |
| Approval mode | 工具执行的审批闸门，四档                                    |
| Sandbox       | bash 工具的执行隔离层（host / docker / gVisor / vm）        |
| Session tree  | JSONL 会话树，支持 fork 分支与任意节点恢复                  |

**参考资源**：工程包内 `README.md`、`docs/TUI_AND_MULTIMODAL.md`、`docs/OAUTH_AND_PROVIDERS.md`、`docs/SANDBOXING.md`、`CHANGELOG.md`
