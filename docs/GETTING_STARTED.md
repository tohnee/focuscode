# FocusCode v0.4 Beta 使用指南

## 1. 安装与检查

```bash
npm install --global ./focuscode-cli-0.4.0-beta.2.tgz
focuscode --version
focuscode --list-providers
focuscode themes
focuscode mascots
focuscode sandbox doctor --kind auto
focuscode doctor
```

Node.js 需要 `>=22.12.0`。默认 Sandbox 是 `auto` 且禁止 Host fallback；没有 Docker/gVisor
时会明确失败。

## 2. 初始化项目

```bash
cd /path/to/repo
focuscode init --provider ollama --model qwen3-coder
```

生成：

- `.focuscode/agent.json`：模型、权限、TUI、Sandbox、工具和资源；
- `.focuscode/config.json`：审计 Kernel 的注册验证命令。

项目指令、Skills 和 Extensions 只有 `--trust-project` 后加载。提交前审阅这两个文件。

企业模板要求不可变镜像 digest，并默认开启模型/扩展 allowlist、审计、远程图片阻断与物理隔离：

```bash
focuscode init --enterprise \
  --provider deepseek --model deepseek-v4-pro \
  --sandbox-image registry.example.com/focuscode-runner@sha256:<64-hex-digest>
export FOCUSCODE_AUDIT_HMAC_KEY="$(openssl rand -hex 32)"
focuscode doctor
```

`doctor` 必须返回 ready 才能视为该主机通过企业启动检查。完整示例见
`examples/config/enterprise-agent.json`；其中全零 digest 只是待替换占位符。

## 3. 模型配置

```bash
export DEEPSEEK_API_KEY=...
focuscode --model deepseek/deepseek-v4-pro

export MOONSHOT_API_KEY=...
focuscode --model kimi/kimi-k3

export DASHSCOPE_API_KEY=...
focuscode --model qwen/qwen3-coder-plus

export ZAI_API_KEY=...
focuscode --model glm/glm-5.2

export MINIMAX_API_KEY=...
focuscode --model minimax/MiniMax-M3

export GEMINI_API_KEY=...
focuscode --model gemini/gemini-model-id

focuscode --provider ollama --model qwen3-coder --auth-type none
```

`provider/model` 只在第一个 `/` 分隔，因此带 namespace 的模型 ID 可以保留在右侧。自定义：

```bash
focuscode --provider custom --model coder \
  --protocol openai-chat --base-url http://127.0.0.1:8000/v1 \
  --auth-type none
```

OAuth 见 [OAUTH_AND_PROVIDERS.md](OAUTH_AND_PROVIDERS.md)。

## 4. 权限

| mode        | 行为                                                |
| ----------- | --------------------------------------------------- |
| `ask`       | 写、Shell 等需要 TTY 一次审批                       |
| `auto-edit` | 普通 workspace 编辑自动；Shell/高风险仍受限         |
| `full-auto` | 扩大普通自动化范围；critical 与保护路径仍 hard deny |
| `deny`      | 只允许安全读取                                      |

非 TTY 中 `ask` 自动变为 `deny`，不会静默放权。

```bash
focuscode -p --model openai/gpt-5 --approval auto-edit \
  "修复失败测试，运行最相关检查并总结 diff"
```

## 5. 隔离

```bash
focuscode --sandbox gvisor
focuscode --sandbox docker --sandbox-image node:22-bookworm
focuscode --sandbox vm --vm-host focus@vm --vm-workspace /mnt/workspace
```

需要网络的 test/install：

```bash
focuscode --sandbox docker --sandbox-network bridge
```

这会给仓库代码网络访问，应显式审批。完整说明见 [SANDBOXING.md](SANDBOXING.md)。

## 6. TUI 与图片

TTY 默认全屏 TUI；保留旧 readline：

```bash
focuscode --mode interactive
focuscode --theme candy --mascot pico
focuscode --theme examples/tui/team-theme.json \
  --mascot examples/tui/team-mascot.json
focuscode -i screenshot.png "按截图修复"
```

TUI 中：

- `/image PATH` 添加下一条图片；
- busy 时直接输入是 append steering；
- `/interrupt TEXT` 立即中断当前 generation 并继续同一 turn；
- `/followup TEXT` 等当前响应完成后按 FIFO 开始下一轮；
- `Ctrl+C` abort turn；`Ctrl+D` exit；
- `Ctrl+T` 主题；`Ctrl+G` 伙伴；`Ctrl+O` 多行。

## 7. 会话

```bash
focuscode -c                         # 最近一次
focuscode -r                         # TTY 选择
focuscode --session SESSION_ID
focuscode --fork SESSION_ID:ENTRY_ID
focuscode --list-sessions
focuscode --session SESSION_ID --export-session review.html
```

TUI：`/sessions`、`/resume`、`/new`、`/fork`、`/tree`、`/compact`、`/export`。

Session 保存图片 base64 和 Tool Result。敏感一次性任务使用 `--no-session`。

## 8. RPC

```bash
focuscode --mode rpc --model openai/gpt-5 --approval auto-edit
```

方法：`prompt`、`steer`、`abort`、`status`、`compact`、`new_session`、`switch_session`、
`fork_session`、`list_sessions`、`set_approval`、`shutdown`。Agent events 以 JSON-RPC notification
发送。`steer`/`abort` 不排入普通 request serializer，因此可在 prompt 尚未完成时生效。

## 9. 扩展和分享

```bash
focuscode extension install @org/focuscode-tools@1.0.0
focuscode share export --session SESSION_ID
```

详见 [EXTENSIONS_AND_SHARING.md](EXTENSIONS_AND_SHARING.md)。

## 10. SDK

```ts
import { createCodingAgent } from "@focuscode/sdk";

const { agent } = await createCodingAgent({
  cwd: process.cwd(),
  provider: "ollama",
  model: "qwen3-coder",
  authType: "none",
  approval: "auto-edit",
  sandbox: { kind: "docker", network: "none" },
  onEvent: (event) => console.log(event.type),
});

await agent.submit({ text: "修复测试", attachments: [] });
```

SDK 默认也使用配置中的 Sandbox 和 Extension signature policy，不会绕回旧 Host Bash。可注入
企业自己的 `shellExecutor` 和 `accessTokenProvider`。

## 11. 常见错误

- `No isolated sandbox is available`：安装 Docker/runsc、配置 VM，或明确选择 Host；
- `requires API key`：设置对应环境变量或 OAuth account；
- `project config ignored`：审阅后加 `--trust-project`；
- `Unsigned extensions are disabled`：使用签名包；本地开发才关闭策略；
- `Image ... invalid`：文件扩展名正确不代表 magic bytes 是受支持图片；
- `Agent is already processing`：新要求使用 `steer()`，不要并发第二次 `submit()`。
