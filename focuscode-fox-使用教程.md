# FocusCode Fox 完整使用教程

> 最后更新：2026-07-26 ｜ 适用版本：FocusCode **v0.5.0**
> 难度：入门到中级 ｜ 预计耗时：45 分钟

## 教程概览

FocusCode Fox 是一个模型可移植、策略可控的终端 Coding Agent。学完本教程，你将能够：

- 安装并启动 `fox` 命令进入全屏 TUI
- 接入任意一家大模型（Kimi / Qwen / GLM / DeepSeek / MiniMax / OpenAI / Anthropic / Gemini / 本地 Ollama）
- 让 Agent 在你的仓库里读写代码、执行命令
- 使用 **SpecEngine 需求补全引擎**（v0.5.0 新增）将模糊需求转化为结构化 spec
- 使用 **ACP 模式**接入 Zed / JetBrains 编辑器（v0.5.0 新增）
- 使用 **命令前缀规则**保护危险操作（v0.5.0 新增）
- 掌握会话管理、中途引导（steering）、图片输入、沙箱隔离

全程由小狐狸 **Foxy 小福**（编程配备鼓励师）陪伴。

---

## 1. 前置知识

**必须掌握**：

- 终端基本操作：切换目录、设置环境变量
- 至少一个大模型 API Key：在各厂商开放平台申请

**了解即可**：

- Docker：使用沙箱隔离时需要（推荐但不强制）
- JSON 语法：自定义主题、伙伴、快捷键时用到

---

## 2. 环境搭建

### 2.1 环境清单

| 工具             | 版本要求                   | 用途                     |
| ---------------- | -------------------------- | ------------------------ |
| Node.js          | **>= 22.12.0（硬性要求）** | 运行时                   |
| ripgrep (`rg`)   | 任意近期版本               | grep/find 工具的搜索引擎 |
| Docker 或 gVisor | 可选                       | 命令沙箱隔离             |
| pnpm             | 11.7.0                     | 仅从源码构建时需要       |

### 2.2 安装步骤

**macOS**：

```bash
brew install node@22 ripgrep
```

**Linux (Ubuntu/Debian)**：

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs ripgrep
```

**验证环境**：

```bash
node --version    # 预期：v22.x.x
rg --version      # 预期：ripgrep 14.x.x
```

### 2.3 安装 FocusCode

从 GitHub 克隆并安装：

```bash
git clone https://github.com/tohnee/focuscode.git
cd focuscode
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @focuscode/cli link:global   # 全局安装 fox 命令
```

**验证安装**：

```bash
fox --version
# 预期输出：0.5.0

fox --list-providers
# 预期输出：kimi / qwen / glm / deepseek / minimax / openai / anthropic / gemini 等预设
```

---

## 3. 核心步骤（SOP）

### 步骤 1：配置模型并启动 TUI

**目标**：看到 Foxy 小狐狸的欢迎屏。

以 Kimi 为例（其他厂商见文末速查表）：

```bash
export MOONSHOT_API_KEY="YOUR_API_KEY"   # 在 platform.moonshot.cn 申请
cd YOUR_PROJECT_DIR                       # 进入你的代码仓库
fox                                       # 裸命令进入全屏 TUI
```

**说明**：

- `fox`、`fc`、`focus`、`focuscode` 四个命令完全等价
- TTY 中不带参数运行默认进入 TUI
- 未指定 `--sandbox` 时默认 `auto`（gVisor -> Docker -> 拒绝）。无 Docker 时加 `--sandbox host`

**验证**：屏幕出现全屏界面，左侧是眨眼的小狐狸和欢迎语。

### 步骤 2：完成第一轮对话

**目标**：让 Agent 创建第一个文件。

在 `fox»` 提示符后输入：

```text
创建一个 hello.js，导出一句问候语，并告诉我文件内容
```

**说明**：

- 输入时小狐狸会切换 mood：思考 -> 敲键盘 -> 开心
- 工具调用以 `⚙ ›` 标签展示，助手回复以 `fox ›` 展示
- v0.5.0 新增 **doom-loop 检测**：如果 Agent 反复执行同一失败操作 3 次，会自动停止并提示

**验证**：对话区出现 `⚙ › write · xx ms` 和回复文本；`ls hello.js` 文件存在。

### 步骤 3：掌握审批模式

**目标**：理解四种审批模式。

```text
/approval ask
```

四种模式：

| 模式        | 行为                               | 适用场景    |
| ----------- | ---------------------------------- | ----------- |
| `ask`       | 每个写操作/命令都问你              | 学习期推荐  |
| `auto-edit` | 自动批准文件编辑，危险命令仍需确认 | 日常开发    |
| `full-auto` | 全部自动                           | 隔离环境/CI |
| `deny`      | 全部拒绝，只读分析                 | 代码审查    |

也可用 `--approval ask` 启动参数预设。非交互环境下 `ask` 自动降级为 `deny`。

### 步骤 4：中途引导（steering）

**目标**：Agent 运行中纠偏。

```text
# 1. 排入队列，当前轮完成后生效
别忘了顺便加个 npm script

# 2. 立即打断当前模型生成
/interrupt 不要用 lodash，改成原生实现

# 3. 等当前响应完成后再追加
/followup 写完之后把 README 也更新一下
```

**说明**：`/interrupt` 只打断模型生成，不撤销已执行的工具效果。`/unsteer` 移除队列条目。

### 步骤 5：会话管理

```bash
fox --list-sessions        # 列出当前仓库的所有会话
fox -c                     # 继续最近一次会话
fox -r                     # 从列表选择恢复
```

TUI 内斜杠命令：

```text
/sessions      # 列出会话
/resume <id>   # 恢复指定会话
/fork          # 从当前节点分叉
/tree          # 查看会话树
/export        # 导出 HTML
```

会话存储在 `~/.focuscode/sessions/<仓库哈希>/`，换模型、换机器都不丢。

### 步骤 6：图片输入

```bash
fox -i ./design.png "按这张截图修复登录页布局"
```

TUI 内：

```text
/image ./design.png        # 附加图片（macOS 不带参数读剪贴板）
/images                    # 查看待发送图片
/image clear               # 清空
```

支持 PNG/JPEG/WebP/GIF，本地路径或 HTTPS URL。

### 步骤 7：SpecEngine 需求补全（v0.5.0 新增）

**目标**：把模糊需求转化为结构化 spec + 增强 prompt。

**什么场景需要**：当你的需求比较模糊（如"让系统更健壮"），SpecEngine 会先帮你探索代码库、生成结构化规格、识别关键决策点、确认后再执行。

```bash
# 最简用法：所有阶段用主模型
fox --spec-engine "/spec add user authentication with JWT"

# 完整用法：指定小模型降低成本
fox --spec-engine \
  --spec-auto-trigger \
  --spec-classifier-model ollama/qwen2.5:1.5b \
  --spec-drafter-model ollama/qwen2.5:7b \
  --spec-dir docs/specs \
  --spec-max-exploration-rounds 4 \
  "/spec 重构权限系统，支持 RBAC"
```

**SpecEngine 参数说明**：

| 参数                            | 作用                                            | 默认值       |
| ------------------------------- | ----------------------------------------------- | ------------ |
| `--spec-engine`                 | 启用 SpecEngine                                 | 关闭         |
| `--spec-auto-trigger`           | 自动判断是否需要补全（不指定则仅 `/spec` 触发） | 仅 `/spec`   |
| `--spec-classifier-model`       | 分类/检测阶段使用的小模型（1B-2B）              | 主模型       |
| `--spec-drafter-model`          | 草稿/增强阶段使用的中模型（3B-7B）              | 主模型       |
| `--spec-dir`                    | spec 持久化目录                                 | `docs/specs` |
| `--spec-max-exploration-rounds` | 代码探索最大轮次                                | 6            |

**5 阶段 pipeline**：

```
用户输入 "/spec add auth"
  ↓
[1] 分类器    - 判断是否需要补全
[2] 探索器    - 主模型只读探索代码库
[3] 起草器    - 生成结构化 spec
[4] 检测器    - 识别关键决策点 → TUI 弹出确认
[5] 增强器    - 转化为执行级 prompt
  ↓
持久化 spec + 注入 todo + 替换 prompt → 工具循环
```

**跳过 SpecEngine**：输入 `/raw` 前缀直接执行。

### 步骤 8：ACP 模式 - 编辑器接入（v0.5.0 新增）

**目标**：从 Zed / JetBrains 编辑器内使用 FocusCode。

```bash
fox --mode acp
```

ACP（Agent Client Protocol）通过 JSON-RPC 2.0 over stdio 让编辑器直接驱动 Agent。支持的协议方法：

| 方法             | 作用                      |
| ---------------- | ------------------------- |
| `initialize`     | 能力协商                  |
| `session/new`    | 创建新会话                |
| `session/load`   | 加载已有会话              |
| `session/list`   | 列出可用会话              |
| `session/prompt` | 发送 prompt，流式返回事件 |
| `session/cancel` | 取消当前操作              |
| `shutdown`       | 关闭服务器                |

**Zed 配置示例**（`~/.config/zed/settings.json`）：

```json
{
  "agent": {
    "providers": {
      "focuscode": {
        "command": "fox",
        "args": ["--mode", "acp"]
      }
    }
  }
}
```

### 步骤 9：命令前缀规则（v0.5.0 新增）

**目标**：用可自测的前缀规则保护危险命令。

创建规则文件 `rules.json`：

```json
[
  {
    "prefix": "git push --force",
    "effect": "deny",
    "reason": "Force push 会覆盖远程历史",
    "match": ["git push --force origin main"],
    "notMatch": ["git push", "git status"]
  },
  {
    "prefix": "npm publish",
    "effect": "deny",
    "reason": "发布不可撤销",
    "match": ["npm publish"],
    "notMatch": ["npm install", "npm test"]
  }
]
```

启动时加载：

```bash
fox --command-rules rules.json
```

**说明**：

- 每条规则的 `match`/`notMatch` 在**加载时自测**：规则写错了启动即报错
- `deny` 规则在所有其他权限检查之前执行
- `allow` 规则跳过 shell 风险分类，但仍受保护路径检查
- 内置 3 条默认规则（deny `git push --force`、allow `git push --force-with-lease`、deny `npm publish`）

### 步骤 10：个性化 - 主题、伙伴、快捷键

```bash
fox mascots                 # 查看 7 只伙伴
fox themes                  # 查看 7 套主题
fox --theme candy --mascot pico
```

项目配置 `.focuscode/agent.json`：

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

**一键换肤**：

```bash
fox skins list              # 列出所有皮肤
fox skins apply sakura      # 应用樱花皮肤
fox skins import ./my.json  # 导入自建皮肤
```

**Foxy 九级成长系统**：

```bash
fox companion               # 查看等级、XP、尾巴数
fox companion reset         # 重置成长状态
```

每完成一轮对话 +1 XP，每次工具调用 +2 XP。9 个等级对应 1-9 个尾巴。

### 步骤 11：自动化集成

```bash
# 一次性执行并退出
fox -p --approval auto-edit --sandbox host "修复失败的测试"

# JSON 事件流（程序消费）
fox --mode json -p "review 这个仓库" | jq -r 'select(.type=="text_delta") | .delta'

# JSON-RPC 长连接
fox --mode rpc --approval deny

# ACP 编辑器接入
fox --mode acp
```

五种模式（tui / interactive / print / json / rpc / acp）共享同一个 Agent 内核。

### 步骤 12：自建模型网关接入

编辑 `~/.focuscode/config.json`：

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
    "agi/deepseek-v4-pro-fp4": { "contextWindow": 256000, "maxOutputTokens": 16384 }
  }
}
```

```bash
export AGI_API_KEY="YOUR_API_KEY"
fox                                  # 裸启动即用默认模型
fox --model deepseek-v4-flash        # 临时换模型
```

---

## 4. 常见报错与排查

| 症状                               | 原因                            | 解决方案                                        |
| ---------------------------------- | ------------------------------- | ----------------------------------------------- |
| `No isolated sandbox is available` | 无 Docker 且 auto 拒绝回退      | `fox --sandbox host` 或安装 Docker              |
| `spawn rg ENOENT`                  | 缺 ripgrep                      | `brew install ripgrep` 或 `apt install ripgrep` |
| `Full-screen TUI requires a TTY`   | 管道中开 TUI                    | 改用 `fox -p` 或 `--mode json`                  |
| 审批被降级 deny                    | 非交互环境安全设计              | 显式 `--approval auto-edit`                     |
| Node 版本拒绝                      | < 22.12                         | 升级 Node 22                                    |
| `Unknown option: --xxx`            | 参数拼写错误                    | `fox --help` 查看完整参数表                     |
| 模型返回 401                       | 环境变量名不匹配                | 对照速查表检查 Key 映射                         |
| SpecEngine 卡住                    | spec_confirmation 等待确认      | TUI 模式用确认 UI；非 TUI 会自动拒绝            |
| Doom-loop stopped                  | Agent 反复执行同一失败操作 3 次 | 检查最后一次工具输出，调整指令后重试            |

---

## 5. 进阶拓展

**沙箱隔离** ｜ 默认 `auto`（gVisor -> Docker -> 拒绝），容器默认断网。生产环境用 `--sandbox docker --sandbox-image IMAGE@sha256:DIGEST`。

**OAuth 企业身份** ｜ `fox auth login enterprise --issuer https://YOUR_IDP --client-id YOUR_CLIENT_ID`

**扩展生态** ｜ `fox extension pack/install/list/remove`，npm 包形式分发，带 Ed25519 签名验证。扩展可注册 `beforeTool` 钩子拦截工具执行（v0.5.0 新增）。

**签名会话分享** ｜ `fox share export --session ID` 导出 Ed25519 签名、默认脱敏的会话包。

**企业模式** ｜ `fox init --enterprise` 生成 fail-closed 配置：Provider/模型/扩展/沙箱全部走 allowlist + HMAC 审计。

**插件 beforeTool 钩子**（v0.5.0 新增）：

```javascript
// my-extension.mjs
export default function (api) {
  api.beforeTool((ctx) => {
    if (ctx.toolName === "bash" && ctx.arguments.command?.includes("rm")) {
      return { allow: false, reason: "此扩展禁止 rm 命令" };
    }
    return { allow: true };
  });
}
```

---

## 6. Cheatsheet 速查表

### 环境信息

| 项目          | 命令/路径                                  |
| ------------- | ------------------------------------------ |
| 安装          | `pnpm --filter @focuscode/cli link:global` |
| 版本检查      | `fox --version`                            |
| 会话存储      | `~/.focuscode/sessions/<仓库哈希>/`        |
| 项目配置      | `<仓库>/.focuscode/agent.json`             |
| 全局配置      | `~/.focuscode/config.json`                 |
| 全局扩展      | `~/.focuscode/extensions/`                 |
| 用户皮肤包    | `~/.focuscode/skins/<id>.json`             |
| Foxy 成长状态 | `~/.focuscode/companion.json`              |

### 厂商 -> 环境变量

| 厂商        | 环境变量            | 启动命令                                                   |
| ----------- | ------------------- | ---------------------------------------------------------- |
| Kimi        | `MOONSHOT_API_KEY`  | `fox --provider kimi`                                      |
| Qwen        | `DASHSCOPE_API_KEY` | `fox --provider qwen`                                      |
| GLM         | `ZAI_API_KEY`       | `fox --provider glm`                                       |
| DeepSeek    | `DEEPSEEK_API_KEY`  | `fox --provider deepseek`                                  |
| MiniMax     | `MINIMAX_API_KEY`   | `fox --provider minimax`                                   |
| OpenAI      | `OPENAI_API_KEY`    | `fox --model openai/gpt-5`                                 |
| Anthropic   | `ANTHROPIC_API_KEY` | `fox --model anthropic/MODEL_ID`                           |
| Gemini      | `GEMINI_API_KEY`    | `fox --model gemini/MODEL_ID`                              |
| Ollama 本地 | 无需                | `fox --provider ollama --model qwen3-coder --sandbox host` |
| 自建网关    | `AGI_API_KEY`       | 见步骤 12                                                  |

### TUI 斜杠命令

| 命令                                  | 作用                               |
| ------------------------------------- | ---------------------------------- |
| `/help`                               | 全部命令速览                       |
| `/cheer on\|off`                      | Foxy 鼓励师开关                    |
| `/interrupt <指令>`                   | 立即打断当前生成并转向             |
| `/followup <指令>`                    | 本轮完成后追加工作                 |
| `/approval <模式>`                    | ask / auto-edit / full-auto / deny |
| `/model`                              | 打开 Model 选择器（Alt+M 唤起）    |
| `/init`                               | 生成 `.focuscode/agent.json` 模板  |
| `/undo`                               | 回滚最近一次文件操作               |
| `/cost`                               | 查看当前会话 token 与费用          |
| `/todo [add\|done\|clear]`            | 任务清单                           |
| `/mcp [list\|reload]`                 | MCP server 管理                    |
| `/diagnostics [on\|off]`              | LSP 诊断回喂开关                   |
| `/compact`                            | 压缩上下文                         |
| `/image <路径>`                       | 附加图片                           |
| `/skin [import\|export\|builtin]`     | 一键换肤                           |
| `/sessions` `/resume` `/fork` `/tree` | 会话管理                           |
| `/export`                             | 导出 HTML                          |
| `/exit`                               | 退出                               |

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

### v0.5.0 新增 CLI 参数

| 参数                              | 作用                                |
| --------------------------------- | ----------------------------------- |
| `--spec-engine`                   | 启用 SpecEngine 需求补全            |
| `--spec-auto-trigger`             | 自动触发（不指定则仅 `/spec` 触发） |
| `--spec-classifier-model`         | 分类阶段小模型（1B-2B）             |
| `--spec-drafter-model`            | 草稿阶段中模型（3B-7B）             |
| `--spec-dir PATH`                 | spec 持久化目录                     |
| `--spec-max-exploration-rounds N` | 探索最大轮次                        |
| `--command-rules PATH`            | 命令前缀规则文件                    |
| `--mode acp`                      | ACP 编辑器接入模式                  |

---

## 附录

**术语表**

| 术语          | 解释                                                            |
| ------------- | --------------------------------------------------------------- |
| Harness       | 模型之外的工程外壳：工具、权限、会话、沙箱的总称                |
| Steering      | 不打断会话的中途引导（append / interrupt / follow-up 三类）     |
| Approval mode | 工具执行的审批闸门，四档                                        |
| Sandbox       | bash 工具的执行隔离层（host / docker / gVisor / vm / seatbelt） |
| Session tree  | JSONL 会话树，支持 fork 分支与任意节点恢复                      |
| SpecEngine    | 需求补全引擎，5 阶段 pipeline 将模糊需求转化为结构化 spec       |
| ACP           | Agent Client Protocol，编辑器 ↔ agent 的 JSON-RPC 协议          |
| beforeTool    | 扩展拦截钩子，可在工具执行前 veto                               |
| Doom-loop     | Agent 反复执行同一失败操作的循环，v0.5.0 新增自动检测           |
| cache_control | Prompt 缓存断点，v0.5.0 新增 Anthropic 支持                     |

**参考资源**：`README.md`、`docs/TUI_AND_MULTIMODAL.md`、`docs/OAUTH_AND_PROVIDERS.md`、`docs/SANDBOXING.md`、`docs/compare/focuscode-v0.5.0-gap-review.md`
