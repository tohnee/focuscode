# FocusCode 使用手册 SOP

> 版本：对应 `0.4.0-beta.2`（仓库 `main` 分支当前状态）
> 范围：面向**终端用户**与**运维工程师**，覆盖从安装、配置、日常使用到企业部署、故障排查的完整标准作业流程（SOP）。
> 配套文档：[API_MANUAL.md](./API_MANUAL.md)（嵌入式 API）、[ARCHITECTURE.md](./ARCHITECTURE.md)（架构）、[SECURITY.md](../SECURITY.md)（安全）。
> 信息来源：`apps/cli/src/index.ts`、`apps/cli/src/agent-args.ts`、`apps/cli/src/agent-command.ts`、`AGENTS.md`、各专题 docs。

---

## 目录

1. [角色与环境前置](#1-角色与环境前置)
2. [安装与首次初始化](#2-安装与首次初始化)
3. [配置体系](#3-配置体系)
4. [会话型 Agent SOP（日常使用）](#4-会话型-agent-sop日常使用)
5. [审计型 Harness SOP（CI/批处理）](#5-审计型-harness-sopcibatch)
6. [Provider 与凭据管理](#6-provider-与凭据管理)
7. [沙箱与执行隔离](#7-沙箱与执行隔离)
8. [扩展与会话分享](#8-扩展与会话分享)
9. [企业部署 SOP](#9-企业部署-sop)
10. [TUI 操作指南](#10-tui-操作指南)
11. [Spec Engine 工作流](#11-spec-engine-工作流)
12. [MCP 集成 SOP](#12-mcp-集成-sop)
13. [Skills 系统使用](#13-skills-系统使用)
14. [故障排查 Runbook](#14-故障排查-runbook)
15. [安全红线清单](#15-安全红线清单)
16. [卸载与清理](#16-卸载与清理)

---

## 1. 角色与环境前置

### 1.1 适用角色

| 角色         | 主要场景                                       | 推荐入口                          |
| ------------ | ---------------------------------------------- | --------------------------------- |
| 个人开发者   | 日常交互式编码、代码审查                       | `focuscode agent` (TUI)           |
| CI/CD 工程师 | 自动化任务、PR 验证                            | `focuscode run` (审计 Harness)    |
| 平台/SRE     | 部署 share-server、control-api、harness-worker | 各 `apps/*` 组合根                |
| 嵌入式集成者 | 把 FocusCode 嵌入自家产品                      | `@focuscode/sdk`                  |
| 扩展开发者   | 编写 FocusCode 扩展                            | `manifest.json` + `ExtensionHost` |

### 1.2 系统要求

| 项           | 要求                                           | 校验命令                            |
| ------------ | ---------------------------------------------- | ----------------------------------- |
| Node.js      | `>=22.12.0`（CI 固定 22.20.0）                 | `node --version`                    |
| pnpm         | corepack 固定 11.7.0（仅源码构建需要）         | `corepack enable && pnpm --version` |
| 操作系统     | macOS / Linux / Windows（WSL2 推荐）           | `uname -a`                          |
| Git          | 任意近期版本（会话恢复依赖 worktree）          | `git --version`                     |
| 沙箱（可选） | Docker / gVisor / seatbelt（仅 macOS）/ SSH VM | 见 §7                               |

> **源码构建**额外要求：`pnpm install --frozen-lockfile` 后 `pnpm verify` 必须通过。详见 [AGENTS.md](file:///Users/tohnee/Trae/Code/focuscode/AGENTS.md)。

### 1.3 首次环境自检

```bash
# 1. Node 版本
node --version  # 应输出 v22.x

# 2. 安装 FocusCode（任选其一）
#    a. 从 npm 安装独立 bundle（推荐终端用户）
npm install -g @focuscode/cli
#    b. 从源码构建（推荐贡献者）
git clone <repo> && cd focuscode
corepack enable && corepack prepare pnpm@11.7.0 --activate
pnpm install --frozen-lockfile
pnpm build

# 3. 验证安装
focuscode help
focuscode doctor
```

`focuscode doctor` 会输出：Node 版本、沙箱可用性、扩展目录、OAuth 状态、配置文件路径。任何 `FAIL` 都需要先解决再使用。

---

## 2. 安装与首次初始化

### 2.1 在仓库中初始化配置

```bash
cd /path/to/your/repo
focuscode init
```

生成两个文件：

- `.focuscode/config.json` —— 仓库级 Harness 配置
- `.focuscode/agent.json` —— Agent 配置（Provider、沙箱、TUI、扩展）

`init` 会自动探测验证命令（pnpm/yarn/bun/npm test、pytest、go test、cargo test）。可覆盖：

```bash
focuscode init --provider kimi --model kimi-k2 --base-url https://api.moonshot.cn/v1
```

### 2.2 企业模式初始化

```bash
focuscode init --enterprise \
  --sandbox-image node:22-bookworm@sha256:<64-hex-digest> \
  --provider kimi --model kimi-k2
```

企业模式额外要求：

- 沙箱镜像必须 pin 到 `@sha256:<digest>`
- 必须设置环境变量 `FOCUSCODE_AUDIT_HMAC_KEY`（≥32 字节）
- 项目级扩展默认禁用（`allowProjectExtensions: false`）
- 远程图片默认禁用（`media.allowRemoteImages: false`）

### 2.3 信任项目配置

`.focuscode/` 中的 Instructions/Skills/Extensions **仅在 `--trust-project` 后加载**：

```bash
focuscode agent --trust-project
```

未带此 flag 时，项目级资源被忽略，仅用户级（`~/.focuscode/`）生效。

---

## 3. 配置体系

### 3.1 配置层级（优先级从高到低）

1. **CLI 参数**：`--provider kimi --model kimi-k2 ...`
2. **环境变量**：`MOONSHOT_API_KEY`、`FOCUSCODE_AUDIT_HMAC_KEY`、`FOCUSCODE_MODEL` 等
3. **项目配置**：`.focuscode/agent.json` + `.focuscode/config.json`
4. **用户配置**：`~/.focuscode/agent.json`
5. **默认值**

### 3.2 `.focuscode/agent.json` 关键字段

```json
{
  "schemaVersion": "focuscode-agent.v1",
  "provider": "kimi",
  "model": "kimi-k2",
  "baseUrl": "https://api.moonshot.cn/v1",
  "apiKeyEnv": "MOONSHOT_API_KEY",
  "approval": "ask",
  "agent": {
    "effectSpine": true,
    "checkpoints": true,
    "diagnostics": true,
    "enableDelegate": true,
    "enableGoal": true,
    "enableGraph": true,
    "enableTeam": true,
    "maxRounds": 40
  },
  "sandbox": {
    "kind": "auto",
    "image": "node:22-bookworm",
    "network": "none",
    "allowHostFallback": false,
    "requireImageDigest": false
  },
  "tui": { "enabled": true, "theme": "foxglow", "mascot": "foxy" },
  "protectedPaths": [".git", ".env", ".npmrc", ".focuscode"],
  "disabledTools": [],
  "media": { "allowRemoteImages": true },
  "mcp": { "servers": [], "pins": [] },
  "skills": { "files": [], "builtin": [] },
  "extensions": { "host": "in-process" },
  "fallbackModels": []
}
```

### 3.3 Provider 预设

FocusCode 内置五系 11 个区域预设（详见 [OAUTH_AND_PROVIDERS.md](./OAUTH_AND_PROVIDERS.md)）：

| Provider                              | 协议          | 默认 BaseURL                                             |
| ------------------------------------- | ------------- | -------------------------------------------------------- |
| `kimi` (Moonshot CN)                  | `openai-chat` | `https://api.moonshot.cn/v1`                             |
| `kimi-global` (Moonshot Global)       | `openai-chat` | `https://api.moonshot.ai/v1`                             |
| `qwen` (DashScope CN)                 | `openai-chat` | `https://dashscope.aliyuncs.com/compatible-mode/v1`      |
| `qwen-intl` (DashScope International) | `openai-chat` | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` |
| `glm` (智谱 BigModel)                 | `openai-chat` | `https://open.bigmodel.cn/api/paas/v4`                   |
| `deepseek`                            | `openai-chat` | `https://api.deepseek.com/v1`                            |
| `minimax`                             | `openai-chat` | `https://api.minimax.chat/v1`                            |

可使用 `focuscode auth login` 走 OAuth 流程，或直接通过 `apiKeyEnv` 注入 API Key。

---

## 4. 会话型 Agent SOP（日常使用）

### 4.1 启动交互式会话

```bash
# 默认 TUI 模式
focuscode agent

# 带初始 prompt
focuscode agent "解释这个仓库的入口文件"

# 指定 Provider/Model（覆盖配置）
focuscode agent --provider kimi --model kimi-k2

# 恢复上次会话
focuscode agent --continue

# 恢复指定会话
focuscode agent --resume --session <sessionId>

# Fork 一个会话（基于某 entryId 分叉）
focuscode agent --fork <entryId>
```

### 4.2 五种运行模式

| 模式          | 启用方式                  | 适用场景                            |
| ------------- | ------------------------- | ----------------------------------- |
| `tui`         | 默认 / `--mode tui`       | 全屏交互（推荐）                    |
| `interactive` | `--mode interactive`      | 行式 REPL                           |
| `print`       | `--mode print` 或 `-p`    | 一次性输出（脚本）                  |
| `json`        | `--mode json` 或 `--json` | NDJSON 流（程序消费）               |
| `rpc`         | `--mode rpc`              | JSON-RPC over stdio（IDE 集成）     |
| `acp`         | `--mode acp`              | Agent Client Protocol（编辑器集成） |

### 4.3 审批模式

```bash
focuscode agent --approval ask        # 默认，每个工具调用询问（需 TTY）
focuscode agent --approval auto-edit  # 自动允许文件编辑，shell 仍询问
focuscode agent --approval full-auto  # 自动允许所有（危险，仅沙箱内使用）
focuscode agent --approval deny       # 全部拒绝（只读模式）
```

> **Fail-closed**：非 TTY 下 `ask` 自动降级为 `deny`。CI 中必须显式指定 `deny` 或 `auto-safe`（Harness 模式）。

### 4.4 Mid-turn Steering

在 TUI/interactive 模式下，agent 正在执行时可以注入指令：

| 操作          | TUI 快捷键        | 含义                             |
| ------------- | ----------------- | -------------------------------- |
| Append        | `Ctrl+A` 然后输入 | 当前轮结束后注入补充说明         |
| Interrupt     | `Ctrl+I` 然后输入 | 立即打断当前轮，下轮注入新指令   |
| Follow-up     | `Ctrl+F` 然后输入 | 当前 submit 完成后自动启动新一轮 |
| List steering | `Ctrl+L`          | 查看队列                         |
| Unsteer       | `Ctrl+U`          | 取消最近一条                     |
| Abort         | `Ctrl+C`          | 完全中止当前 submit              |

编程接口：

```typescript
await agent.steer("补充说明", "append");
await agent.steer("停下来换思路", "interrupt");
agent.listSteering();
await agent.unsteer();
```

### 4.5 会话管理

```bash
focuscode agent --list-sessions          # 列出所有会话
focuscode agent --session <id> --resume  # 恢复指定会话
focuscode agent --export-session <path>  # 导出会话快照
focuscode agent --no-session             # 不持久化（一次性）
focuscode agent --name "feature-x"       # 命名会话
```

会话存储在 `~/.focuscode/sessions/<cwd-hash>/<sessionId>/`，格式为 JSONL（一行一事件）。

### 4.6 上下文压缩

当 token 估算接近上下文窗口时，TUI 会自动提示。手动压缩：

- TUI：`/compact` 命令
- 编程：`await agent.compact()`

压缩生成结构化摘要并写入 `compaction.json`，旧消息从 active branch 移除但保留在历史中（fork 仍可访问）。

### 4.7 Checkpoint 与 Undo

文件级 undo 快照默认开启（`agent.checkpoints: true`），存储在 `~/.focuscode/checkpoints/<sessionId>/`：

- 每次 write/edit/apply_patch 前自动快照
- TUI 中通过 `Ctrl+Z` 或 `/undo` 命令恢复
- 编程接口：通过 `CheckpointStore` 直接操作

### 4.8 图片输入

```bash
focuscode agent --image /path/to/screenshot.png "解释这个 UI"
focuscode agent -i img1.png -i img2.png "对比这两张图"
```

模型必须配置 `capabilities.input: ["text", "image"]`，否则会抛错。

### 4.9 模型切换与会话分支

TUI 中可用 `/model kimi/kimi-k2` 切换模型（仅在非运行时）。会话分支：

```bash
focuscode agent --fork <entryId>   # 从指定 entry 创建分叉会话
```

分支保留原会话历史，新会话独立演化，不影响原会话。

---

## 5. 审计型 Harness SOP（CI/Batch）

### 5.1 一次性任务

```bash
focuscode run \
  --repo /path/to/repo \
  --task "Add unit test for utils.ts" \
  --model kimi-k2 \
  --base-url https://api.moonshot.cn/v1 \
  --api-key $MOONSHOT_API_KEY \
  --approval deny \
  --mode change \
  --profile balanced \
  --task-id ci-$(date +%s) \
  --trust-repo-config
```

参数说明：

| 参数                     | 必填                           | 含义                                            |
| ------------------------ | ------------------------------ | ----------------------------------------------- |
| `--repo`                 | ✓                              | 仓库根                                          |
| `--task`                 | ✓                              | 任务目标文本                                    |
| `--model` + `--base-url` | 二选一                         | 真实模型 或 `--script` 确定性回放               |
| `--approval`             | 默认 `deny`                    | `deny` / `prompt`（需 TTY）/ `auto-safe`        |
| `--mode`                 | 默认 `change`                  | `explore` / `change` / `review` / `verify`      |
| `--profile`              | 默认 `balanced`                | `balanced` / `quality` / `local` / `fast`       |
| `--task-id`              | 可选                           | 指定后可幂等恢复                                |
| `--trust-repo-config`    | 可选                           | 信任 `.focuscode/` 中的 verification 命令白名单 |
| `--state-dir`            | 默认 `<repo>/.focuscode-state` | 状态目录                                        |

退出码：

- `0` —— 任务达到 `REVIEW_READY`
- `2` —— 任务失败或 verifier 拒绝
- `1` —— 配置/参数错误

### 5.2 确定性回放（脚本化模型）

```bash
focuscode run \
  --repo /path/to/repo \
  --task "demo task" \
  --script ./scripted-steps.json \
  --approval deny
```

`scripted-steps.json` 是 `ScriptedStep[]`，每条指定模型应返回的 content/tool_calls/usage。用于：

- Demo / 培训
- 离线测试
- bug 复现（捕获真实模型响应后回放）

### 5.3 任务恢复

进程崩溃或主动中止后：

```bash
focuscode run \
  --repo /path/to/repo \
  --task "（同原任务）" \
  --task-id <original-task-id> \
  --state-dir <original-state-dir>
```

Kernel 从最近 checkpoint 恢复，已落 receipt 的 effects 不会重复执行（幂等）。

### 5.4 任务检视与导出

```bash
# 查看任务 checkpoint 与事件流
focuscode inspect --task-id <id> --state-dir <dir>

# 导出任务全部资产（facts + memory + receipts）
focuscode export --task-id <id> --out ./export-dir --state-dir <dir>
```

### 5.5 GitHub Actions 集成示例

```yaml
# .github/workflows/focuscode-review.yml
name: FocusCode Review
on:
  pull_request:
    types: [opened, synchronize]
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: "22.20.0" }
      - run: npm install -g @focuscode/cli
      - name: Run FocusCode
        env:
          MOONSHOT_API_KEY: ${{ secrets.MOONSHOT_API_KEY }}
        run: |
          focuscode run \
            --repo . \
            --task "Review PR #${{ github.event.pull_request.number }} for issues" \
            --model kimi-k2 \
            --base-url https://api.moonshot.cn/v1 \
            --approval deny \
            --mode review \
            --task-id pr-${{ github.event.pull_request.number }}-${{ github.sha }}
```

---

## 6. Provider 与凭据管理

### 6.1 API Key 方式

```bash
# 通过环境变量
export MOONSHOT_API_KEY=sk-...
focuscode agent --provider kimi --model kimi-k2

# 通过 CLI 参数（不推荐，会进 shell history）
focuscode agent --api-key sk-...

# 通过配置文件
# .focuscode/agent.json: { "apiKeyEnv": "MOONSHOT_API_KEY" }
```

### 6.2 OAuth 流程

```bash
# 列出已登录账户
focuscode auth list

# 登录（PKCE loopback，自动打开浏览器）
focuscode auth login --provider kimi

# 设备码流程（无浏览器环境）
focuscode auth login --provider kimi --device-code

# 登出
focuscode auth logout --provider kimi --account <account>
```

凭据存储在 `~/.focuscode/auth/credentials.enc.json`（AES-256-GCM 加密 + scrypt 派生密钥）。`credentials.key` chmod 0600。

### 6.3 OAuth Account 关联

一个 Provider 可登录多个账户：

```bash
focuscode agent --provider kimi --oauth-account work@example.com
```

`accessTokenProvider` 会自动 refresh token，集成者可通过 SDK 注入：

```typescript
createCodingAgent({
  // ...
  accessTokenProvider: async () => (await oauth.refreshIfNeeded()).accessToken,
});
```

### 6.4 模型 Fallback 链

配置多个 fallback 模型，主模型失败时自动降级：

```json
{
  "provider": "kimi",
  "model": "kimi-k2",
  "fallbackModels": [
    { "provider": "qwen", "model": "qwen-max" },
    { "provider": "glm", "model": "glm-4-plus" }
  ]
}
```

触发条件：HTTP 429/5xx、超时、`stopReason === "error"`。每个 client 独立熔断（`CircuitBreaker`）。

---

## 7. 沙箱与执行隔离

### 7.1 沙箱类型

| 类型       | 隔离强度           | 适用平台        | 启用                          |
| ---------- | ------------------ | --------------- | ----------------------------- |
| `auto`     | 自动选择           | 全平台          | 默认                          |
| `gvisor`   | 强                 | Linux + runsc   | `--sandbox gvisor`            |
| `docker`   | 中                 | Docker          | `--sandbox docker`            |
| `seatbelt` | 中                 | 仅 macOS        | `--sandbox seatbelt`          |
| `vm`       | 强                 | SSH 可达远程 VM | `--sandbox vm`                |
| `host`     | **无**（兼容路径） | 全平台          | 仅 `--allow-host-fallback` 时 |

### 7.2 `auto` 选择链

```
gVisor → Docker → seatbelt (darwin) → Host (仅 allowHostFallback=true) → 抛错
```

> **警告**：`host` **不是沙箱**。生产环境必须 `allowHostFallback: false`。企业模式强制非 Host。

### 7.3 沙箱健康检查

```bash
focuscode sandbox doctor --kind docker
focuscode sandbox doctor --kind gvisor
focuscode sandbox doctor --kind vm --vm-host <host>
```

输出：runtime 可用性、镜像存在性、digest 校验、网络策略。

### 7.4 自定义沙箱镜像

```bash
focuscode agent --sandbox docker --sandbox-image my-registry/focuscode:latest@sha256:<digest>
```

企业模式必须 pin `@sha256:<digest>`，并配置 `--pull never`（镜像预拉取到本地）。

### 7.5 SSH VM 沙箱

```bash
focuscode agent \
  --sandbox vm \
  --vm-host user@remote-host \
  --vm-workspace /home/user/workspace \
  --vm-identity ~/.ssh/id_ed25519
```

VM 沙箱通过 SSH 把工具命令发送到远程执行。Provider/OAuth/Session 留在本地 CLI 进程。

### 7.6 沙箱边界

容器/VM 只包住 Bash 及其子进程。**以下内容不进入沙箱**：

- Provider 凭据
- OAuth 流程
- Session 持久化
- Extension Host（除非 `extensions.host: "process"`）

工具子进程只获得精简环境（无 API Key、无 OAuth token）。

---

## 8. 扩展与会话分享

### 8.1 扩展安装

```bash
focuscode extension install @my-org/focuscode-eslint
focuscode extension install ./local-ext
focuscode extension list
focuscode extension remove @my-org/focuscode-eslint
focuscode extension pack ./my-ext-dir   # 打包为 tarball
```

### 8.2 扩展 Manifest

```json
{
  "apiVersion": "focuscode.extension.v1",
  "entry": "./dist/index.js",
  "displayName": "ESLint Helper",
  "description": "Auto-fix lint issues",
  "permissions": ["tools", "commands", "events"],
  "focuscode": "^0.4.0"
}
```

`permissions`：

- `tools` —— 注册自定义工具
- `commands` —— 注册命令
- `events` —— 订阅 Agent 事件
- `network` —— 高危，企业模式拒绝
- `shell` —— 高危，企业模式拒绝

### 8.3 扩展签名

远程包必须签名验证（Ed25519）：

```bash
focuscode extension install @my-org/ext --require-signature
```

`focuscode-extension-lock.v1` 锁文件记录已安装包的 digest。

### 8.4 会话分享

```bash
# 导出（默认脱敏：去除工具输出、图片、敏感字段）
focuscode share export --session <id> --out ./share.json

# 导入
focuscode share import ./share.json

# 发布到 share-server
focuscode share publish ./share.json --endpoint https://share.example.com

# 从服务器下载
focuscode share download <id> --endpoint https://share.example.com
```

Ed25519 签名证明**完整性**（未被篡改），**不证明身份或内容可信**。导入前请人工审查内容。

### 8.5 share-server 部署

`apps/share-server` 是参考实现：

```bash
pnpm --filter @focuscode/share-server start --port 8787
```

支持 TTL 与 rate limit。生产部署建议放在反向代理后并启用 mTLS。

---

## 9. 企业部署 SOP

### 9.1 企业模式清单

| 项                  | 要求                                  | 校验                                    |
| ------------------- | ------------------------------------- | --------------------------------------- |
| 沙箱                | `docker` / `gvisor` / `vm`（非 Host） | `focuscode doctor --enterprise`         |
| 镜像 digest         | 必须 `@sha256:<64-hex>`               | `init --enterprise --sandbox-image ...` |
| `--pull never`      | 镜像预拉取                            | `focuscode sandbox doctor`              |
| Audit HMAC key      | ≥32 字节                              | `echo -n "$FOCUSCODE_AUDIT_HMAC_KEY"    | wc -c` |
| Provider allowlist  | `enterprise.allowedProviders`         | 配置文件                                |
| Model allowlist     | `enterprise.allowedModels`            | 配置文件                                |
| Extension allowlist | `enterprise.allowedExtensions`        | 配置文件                                |
| 扩展权限            | 不得包含 `network`/`shell`            | 启动时校验                              |
| 扩展签名            | `requireExtensionSignatures: true`    | 启动时校验                              |
| 远程图片            | `media.allowRemoteImages: false`      | 配置文件                                |
| 项目扩展            | `allowProjectExtensions: false`       | 配置文件                                |
| MCP pins            | 所有 MCP tool 必须有 pin              | 启动时 fail-closed                      |

### 9.2 部署 control-api（只读控制面）

```bash
pnpm --filter @focuscode/control-api start --port 8080 --state-dir /var/lib/focuscode
```

提供 REST API 查询任务状态、checkpoint、effect receipt。只读，不修改状态。

### 9.3 部署 harness-worker（Kernel worker）

```bash
pnpm --filter @focuscode/harness-worker start \
  --state-dir /var/lib/focuscode \
  --concurrency 4 \
  --poll-interval 5s
```

从队列拉取任务、运行 Kernel、写回 checkpoint。水平扩展：多实例共享 state-dir（须是共享文件系统）。

### 9.4 审计日志归档

`FileAuditJournal` 写入 `~/.focuscode/audit/audit-<YYYY-MM-DD>.jsonl`，每条 HMAC 签名。归档脚本：

```bash
# 每日归档
find ~/.focuscode/audit -name "audit-*.jsonl" -mtime +30 -exec gzip {} \;
find ~/.focuscode/audit -name "audit-*.jsonl.gz" -mtime +365 -delete
```

### 9.5 合规检查清单

- [ ] 所有 Provider/Model 在 allowlist 内
- [ ] 所有扩展在 allowlist 内且签名验证通过
- [ ] 沙箱强制非 Host
- [ ] 镜像 digest pin
- [ ] Audit HMAC key ≥32 字节且定期轮换
- [ ] 远程图片禁用
- [ ] MCP tool 全部 pin
- [ ] 项目扩展禁用（除非显式允许）
- [ ] share-server 在内网且启用 mTLS
- [ ] control-api 仅只读访问

---

## 10. TUI 操作指南

### 10.1 启动与布局

```bash
focuscode agent             # 默认 TUI
focuscode agent --theme foxglow --mascot foxy
```

四种布局模式（按终端尺寸自适应）：

| 模式      | 终端宽度   | 布局                               |
| --------- | ---------- | ---------------------------------- |
| `classic` | < 100 列   | 单列：messages + input             |
| `split`   | 100-160 列 | 左 messages，右 companion/todo     |
| `focus`   | 任意       | 仅 messages（隐藏 chrome）         |
| `wide`    | > 160 列   | 三列：messages + companion + tools |

手动切换：`/layout classic|split|focus|wide`。

### 10.2 核心快捷键

| 键            | 动作                    |
| ------------- | ----------------------- |
| `Enter`       | 发送消息                |
| `Shift+Enter` | 换行                    |
| `Ctrl+C`      | 中断当前 submit         |
| `Ctrl+L`      | 清屏                    |
| `Ctrl+A`      | Steering: append        |
| `Ctrl+I`      | Steering: interrupt     |
| `Ctrl+F`      | Steering: follow-up     |
| `Ctrl+U`      | 取消最近 steering       |
| `Ctrl+Z`      | Undo（恢复 checkpoint） |
| `Ctrl+P`      | 命令面板                |
| `Ctrl+T`      | 切换主题                |
| `Ctrl+M`      | 切换 mascot             |
| `Ctrl+W`      | 切换布局                |
| `Esc`         | 取消当前输入 / 关闭面板 |
| `Tab`         | 自动补全                |
| `↑` / `↓`     | 历史消息导航            |

可通过 `--keymap ./my-keymap.json` 自定义。

### 10.3 内置命令

在 TUI 输入框中输入 `/` 开头的命令：

| 命令                      | 含义              |
| ------------------------- | ----------------- |
| `/help`                   | 帮助              |
| `/status`                 | 当前会话状态      |
| `/sessions`               | 列出所有会话      |
| `/model <provider/model>` | 切换模型          |
| `/approval <mode>`        | 切换审批模式      |
| `/compact`                | 手动压缩上下文    |
| `/undo`                   | 撤销最近编辑      |
| `/fork <entryId>`         | 从指定 entry 分叉 |
| `/export <path>`          | 导出会话          |
| `/share`                  | 分享当前会话      |
| `/theme <name>`           | 切换主题          |
| `/mascot <name>`          | 切换伙伴          |
| `/layout <mode>`          | 切换布局          |
| `/tools`                  | 列出已注册工具    |
| `/skills`                 | 列出已加载技能    |
| `/diagnostics`            | 切换 LSP 诊断显示 |
| `/exit` 或 `/quit`        | 退出              |

### 10.4 命令面板

`Ctrl+P` 打开命令面板，支持模糊搜索所有命令。比记忆快捷键更友好。

### 10.5 主题与皮肤

```bash
focuscode themes              # 列出内置主题
focuscode mascots             # 列出内置 mascot
focuscode skins list          # 列出已安装皮肤
focuscode skins apply foxy    # 应用皮肤
focuscode skins import ./my-skin.json
focuscode skins export foxy ./foxy.json
focuscode skins remove foxy
```

皮肤是主题 + mascot + 像素帧的打包。

---

## 11. Spec Engine 工作流

### 11.1 启用 Spec Engine

```bash
focuscode agent --spec-engine --spec-auto-trigger
```

或在配置中：

```json
{
  "specEngine": {
    "enabled": true,
    "autoTrigger": true,
    "directory": ".focuscode/specs",
    "maxExplorationRounds": 5,
    "classifierModel": "kimi/kimi-k2-mini",
    "drafterModel": "kimi/kimi-k2"
  }
}
```

### 11.2 五阶段管线

| 阶段              | 模型   | 输入            | 输出                           |
| ----------------- | ------ | --------------- | ------------------------------ |
| Classifier        | 1-2B   | 用户输入        | `vague` / `clear` / `decision` |
| Explorer          | 主模型 | 输入 + 仓库     | 仓库上下文摘要                 |
| Drafter           | 3-7B   | 输入 + 探索结果 | spec 草稿                      |
| Decision Detector | 1-2B   | spec 草稿       | 是否含未决断点                 |
| Enhancer          | 3-7B   | spec + 上下文   | enhanced prompt + 初始 todos   |

### 11.3 使用方式

显式触发：

```
/spec 实现一个用户登录功能
```

自动触发（`--spec-auto-trigger`）：当 classifier 判定输入 "vague" 时自动进入流程。

输出：

- 持久化 spec 文档：`.focuscode/specs/<spec-id>.md`
- enhanced prompt（替换原 prompt 进入主循环）
- 初始 todos（注入 TodoState）

### 11.4 跳过 Spec Engine

```
/raw 直接重构 auth 模块
```

`/raw` 强制跳过 Spec Engine，直接进入主工具循环。

---

## 12. MCP 集成 SOP

### 12.1 配置 MCP Server

`.focuscode/agent.json`：

```json
{
  "mcp": {
    "servers": [
      {
        "id": "filesystem",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        "env": {}
      }
    ],
    "pins": [
      {
        "serverId": "filesystem",
        "serverVersion": "2025.1.0",
        "toolName": "read_file",
        "schemaDigest": "sha256:...",
        "transportDigest": "sha256:..."
      }
    ]
  }
}
```

### 12.2 Pin 验证（Fail-closed）

启动时校验每个 pin：

- `serverId` + `serverVersion` 必须匹配
- `toolName` 必须存在
- `schemaDigest` 必须匹配当前 tool schema 的 sha256
- `transportDigest` 必须匹配当前 transport 配置的 sha256

**任何字段漂移 → 抛 `McpSchemaChangedError`，CLI 非零退出。**

更新 MCP server 后必须重新计算 pin 并更新配置：

```bash
focuscode agent --list-mcp-pins  # 输出当前所有 pin
```

### 12.3 安全边界

- MCP server 在 CLI 主进程通过 stdio 通信
- server 子进程**不接触** Provider token
- 工具注册发生在 `CodingAgent.create()` 之前
- 非 TTY 下 MCP 工具的 `ask` 审批降级为 `deny`

---

## 13. Skills 系统使用

### 13.1 Skill Manifest

`.focuscode/skills/my-skills.json`：

```json
{
  "schemaVersion": "focuscode-skills.v1",
  "skills": [
    {
      "id": "react-component",
      "name": "React Component Generator",
      "triggerKeywords": ["react", "component", "jsx"],
      "prompt": "When creating React components, follow these rules: ...",
      "toolAllowlist": ["read", "write", "edit"]
    }
  ]
}
```

### 13.2 加载 Skill

```json
{
  "skills": {
    "files": ["./.focuscode/skills/my-skills.json"],
    "builtin": ["code-review", "test-generation"]
  }
}
```

或通过 CLI：

```bash
focuscode agent --skills ./my-skills.json
```

### 13.3 匹配机制

每次 `submit()` 调用前：

1. 提取用户输入文本
2. 对每个 skill 检查 `triggerKeywords` 是否命中
3. 命中的 skill prompt 被拼接追加到 system message
4. 工具调用限制在 `toolAllowlist` 内（如果指定）

未命中的 skill 不注入。每轮独立匹配。

### 13.4 内置 Skill

仓库 `packages/agent-runtime/src/skills.ts` 提供内置 skill 加载器。可通过 `builtin: ["..."]` 引用。

---

## 14. 故障排查 Runbook

### 14.1 启动失败

| 症状                                                        | 可能原因            | 解决                                                                    |
| ----------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------- |
| `Enterprise mode rejects non-isolated shell executor: host` | 企业模式沙箱为 host | 改用 docker/gvisor/vm                                                   |
| `Enterprise mode requires a 32+ byte audit key`             | 未设置 HMAC key     | `export FOCUSCODE_AUDIT_HMAC_KEY=$(openssl rand -hex 32)`               |
| `McpSchemaChangedError`                                     | MCP pin 漂移        | 重新计算 pin 并更新配置                                                 |
| `Model system_fingerprint drift`                            | 模型版本变化        | 更新 `expectedSystemFingerprint` 或设 `systemFingerprintPolicy: "warn"` |
| `Sandbox unavailable`                                       | auto 链全部不可用   | 安装 Docker/gVisor 或配置 VM                                            |
| `Unsigned extensions are disabled`                          | 企业模式未签名扩展  | 对扩展签名或从 allowlist 移除                                           |
| `Enterprise extensions may not request network or shell`    | 扩展权限越界        | 移除高危权限或换扩展                                                    |

### 14.2 运行时错误

| 症状                                                | 可能原因                  | 解决                                  |
| --------------------------------------------------- | ------------------------- | ------------------------------------- |
| `Model is not configured for image input`           | 模型不支持多模态          | 切换支持 image 的模型或移除 `--image` |
| `Agent is already processing a prompt`              | 重复调用 submit           | 用 `steer()` 而非 `submit()`          |
| `Cannot change model during a running turn`         | 运行中切换模型            | 先 `abort()` 或等待完成               |
| `Session workspace is X, not requested workspace Y` | cwd 与会话记录不符        | 用 `--cwd` 指定正确目录或新建会话     |
| `Prompt must not be empty`                          | 空输入                    | 提供非空文本或 attachments            |
| `Enterprise policy forbids ad-hoc extension paths`  | 企业模式传 extensionPaths | 通过 allowlist 安装                   |

### 14.3 模型调用失败

| 症状                  | 可能原因                     | 解决                            |
| --------------------- | ---------------------------- | ------------------------------- |
| `ModelHttpError: 401` | API Key 无效                 | 检查环境变量 / 重新登录         |
| `ModelHttpError: 429` | 限流                         | 配置 fallbackModels / 降低并发  |
| `ModelHttpError: 5xx` | Provider 故障                | FallbackModelClient 自动降级    |
| 超时                  | `reliability.timeoutMs` 太短 | 调整为 600000（10 分钟）        |
| 熔断                  | `circuitThreshold` 触发      | 等待 `circuitCooldownMs` 或重启 |

### 14.4 沙箱问题

```bash
# 诊断沙箱
focuscode sandbox doctor --kind docker
focuscode sandbox doctor --kind gvisor
focuscode sandbox doctor --kind vm --vm-host user@host
```

常见问题：

- **Docker daemon 未运行**：`systemctl start docker` 或 `open -a Docker`
- **gVisor runsc 未安装**：`sudo runsc install`，然后配置 Docker runtime
- **镜像不存在**：`docker pull node:22-bookworm`
- **digest 不匹配**：企业模式必须 pin `@sha256:<digest>`，预拉取镜像
- **seatbelt 不可用**：仅 macOS，非 darwin 平台 fail-quiet

### 14.5 会话恢复失败

```bash
# 检查会话文件完整性
focuscode inspect --task-id <id> --state-dir <dir>
```

如果 `checkpoint.json` 损坏：

- 从 `entries.jsonl` 重建（手工或脚本）
- 或从 `~/.focuscode/backups/` 恢复（如果启用）

### 14.6 扩展崩溃

`extensions.host: "process"` 模式下扩展崩溃不影响主进程。日志在 `~/.focuscode/logs/extension-<name>-<timestamp>.log`。

`extensions.host: "in-process"` 模式下扩展崩溃会终止 CLI。建议生产环境用 `process` 模式。

### 14.7 内存与磁盘

- 会话目录：`~/.focuscode/sessions/`，长期使用需定期清理
- Checkpoint 目录：`~/.focuscode/checkpoints/`，每个 sessionId 独立
- 审计日志：`~/.focuscode/audit/`，企业模式增长快
- 状态目录：`<repo>/.focuscode-state/`，CI 中注意 artifact 体积

清理脚本：

```bash
# 清理 30 天前的会话
find ~/.focuscode/sessions -maxdepth 2 -type d -mtime +30 -exec rm -rf {} \;

# 清理 7 天前的 checkpoint
find ~/.focuscode/checkpoints -maxdepth 2 -type d -mtime +7 -exec rm -rf {} \;
```

---

## 15. 安全红线清单

### 15.1 绝对禁止

- ❌ 在企业模式使用 `host` 沙箱
- ❌ 在企业模式允许 `network`/`shell` 扩展权限
- ❌ 在企业模式允许 `allowProjectExtensions`（除非显式审核）
- ❌ 在企业模式允许远程图片
- ❌ 在企业模式使用未签名扩展
- ❌ 在企业模式使用未 pin 的 MCP tool
- ❌ 在企业模式使用未 pin digest 的沙箱镜像
- ❌ 在企业模式使用 < 32 字节的 audit HMAC key
- ❌ 在非 TTY 环境使用 `ask` 审批模式
- ❌ 让 Approval 覆盖组织 hard deny
- ❌ 在工具参数完整解析与 schema 验证前执行工具
- ❌ 信任模型/工具/扩展输出中的终端控制字符
- ❌ 把 Provider secret 写进配置文件或命令历史

### 15.2 强制要求

- ✅ 模型凭据只通过环境变量或加密凭据库传递
- ✅ `client secret` 用 `FOCUSCODE_<PROVIDER>_CLIENT_SECRET` 环境变量
- ✅ 会话分享默认脱敏（去除工具输出、图片、敏感字段）
- ✅ 会话导入/下载必须验 Ed25519 签名
- ✅ 扩展安装使用 `npm install --ignore-scripts`
- ✅ 任何自动授权扩大必须增加绕过测试
- ✅ Provider secret 不进入 Prompt、Session、Tool 环境或普通日志

### 15.3 信任边界

| 边界                                | 信任级别                    | 说明                     |
| ----------------------------------- | --------------------------- | ------------------------ |
| CLI 主进程                          | 完全可信                    | 持有凭据、Session、OAuth |
| 沙箱内进程                          | 不完全可信                  | 仅获得精简环境           |
| MCP server 子进程                   | 不完全可信                  | 不接触 Provider token    |
| 扩展（in-process）                  | 显式可信                    | 与主进程同权限           |
| 扩展（process host）                | 显式可信 + 崩溃隔离         | 子进程崩溃不影响主进程   |
| 项目 Instructions/Skills/Extensions | 仅 `--trust-project` 后可信 | 默认不加载               |
| 会话分享内容                        | 不信任内容                  | 仅验签，导入前人工审查   |

---

## 16. 卸载与清理

### 16.1 卸载 FocusCode

```bash
# npm 全局安装
npm uninstall -g @focuscode/cli

# 源码构建
cd /path/to/focuscode
pnpm clean  # 删除所有 dist/
```

### 16.2 清理用户数据

```bash
# 备份后删除全部用户数据
tar -czf ~/focuscode-backup-$(date +%Y%m%d).tar.gz ~/.focuscode
rm -rf ~/.focuscode
```

### 16.3 清理仓库数据

```bash
cd /path/to/repo
rm -rf .focuscode .focuscode-state
```

### 16.4 撤销 OAuth 授权

```bash
focuscode auth logout --provider kimi --all
# 或到各 Provider 控制台手动撤销应用授权
```

---

## 附录 A：常用命令速查

```bash
# 日常
focuscode agent                                    # 启动 TUI
focuscode agent "prompt"                           # 带 prompt 启动
focuscode agent --continue                         # 恢复上次会话
focuscode agent -p "prompt"                        # print 模式
focuscode agent --json "prompt"                    # JSON 流模式

# 配置
focuscode init                                     # 初始化仓库配置
focuscode init --enterprise --sandbox-image ...    # 企业模式
focuscode doctor                                   # 环境诊断

# Provider
focuscode auth login --provider kimi               # OAuth 登录
focuscode auth list                                # 列出账户
focuscode agent --list-providers                   # 列出预设
focuscode agent --list-models                      # 列出可用模型

# 沙箱
focuscode sandbox doctor --kind docker             # 诊断沙箱
focuscode agent --sandbox gvisor                   # 指定沙箱

# 扩展
focuscode extension install <pkg>
focuscode extension list
focuscode extension remove <pkg>

# 会话
focuscode agent --list-sessions
focuscode agent --export-session <path>
focuscode share export/import/publish/download

# 审计 Harness
focuscode run --repo . --task "..." --model ... --base-url ...
focuscode inspect --task-id <id>
focuscode export --task-id <id> --out <dir>

# 主题
focuscode themes
focuscode mascots
focuscode skins list/apply/import/export/remove
```

## 17. SDK 嵌入式集成 SOP

面向将 `@focuscode/sdk` 作为库依赖嵌入到自有服务、CI runner 或 IDE 后端的集成者。CLI 用户可跳过本节。

### 17.1 环境准备

```bash
# 1. Node >=22.12.0（CI 固定 22.20.0）
node --version

# 2. 安装 SDK
npm install @focuscode/sdk

# 3.（可选）安装沙箱依赖
#    gVisor: 需要 Docker + gVisor 镜像
#    Docker: 需要 Docker daemon
#    Seatbelt: 仅 macOS,无需额外依赖
#    SSH VM: 需要远程 SSH 主机
```

### 17.2 最小示例：会话型 Agent

```typescript
import { createCodingAgent } from "@focuscode/sdk";

const { agent } = await createCodingAgent({
  cwd: process.cwd(),
  provider: "kimi", // kimi | qwen | glm | deepseek | minimax | openai | anthropic | gemini | ollama | custom
  model: "kimi-k2",
  baseUrl: "https://api.moonshot.cn/v1",
  apiKeyEnv: "MOONSHOT_API_KEY", // 仅 env 名,不传 secret 本身
  approval: "ask", // ask | auto-edit | full-auto | deny
  sandbox: { kind: "auto" }, // gvisor | docker | seatbelt | vm | host
});

const result = await agent.submit("解释当前目录下的入口文件");
console.log(result.text);
```

### 17.3 最小示例：审计型 Harness

```typescript
import { createLocalHarness } from "@focuscode/sdk";

const harness = await createLocalHarness({
  repoRoot: "/path/to/repo",
  stateDirectory: "/path/to/.focuscode-state",
  approvalMode: "auto-safe", // deny | prompt | auto-safe
  trustRepoConfig: true, // 信任 .focuscode/config.json 中的验证命令
  model: {
    kind: "openai-compatible",
    modelId: "kimi-k2",
    baseUrl: "https://api.moonshot.cn/v1",
    apiKey: process.env.MOONSHOT_API_KEY,
  },
});

const result = await harness.run({
  schemaVersion: "task-spec.v1",
  repoId: "/path/to/repo",
  baseRef: "HEAD",
  mode: "change",
  objective: "修复 src/math.js 中的加法运算符错误",
  acceptanceCriteria: [{ id: "tests", description: "npm test 通过" }],
});

console.log(result.checkpoint.state); // "REVIEW_READY" | "ACCEPTED" | ...
console.log(result.verification?.conclusion); // "PASS" | "FAIL" | undefined
```

### 17.4 配置与凭据

**凭据注入优先级（高 → 低）**：

1. `accessTokenProvider`（OAuth refresh token 回调）
2. `apiKey`（直接传 secret,仅 SDK 场景）
3. `apiKeyEnv` 指向的环境变量
4. Provider preset 默认值

**安全红线**：

- **永远不要**将 secret 写入配置文件或日志
- CLI 路径禁用 `apiKey` 字段,只接受 `apiKeyEnv`
- OAuth `client_secret` 必须放在 `FOCUSCODE_<PROVIDER>_CLIENT_SECRET` 环境变量
- 企业模式下,`apiKey` 必须通过受管 secret store 注入

### 17.5 工作流：Session 恢复

```typescript
// 第一次调用:创建 session
const first = await createCodingAgent({
  cwd: repoRoot,
  sessionDirectory: "/path/to/sessions",
  persistentSession: true,
  // ...其他选项
});
const sessionId = first.agent.sessionId;

// 后续调用:恢复同一 session
const resumed = await createCodingAgent({
  cwd: repoRoot,
  sessionDirectory: "/path/to/sessions",
  sessionId, // 传入已有 sessionId
  persistentSession: true,
  // ...其他选项
});
expect(resumed.agent.sessionId).toBe(sessionId);
```

**注意事项**：

- `sessionId` 必须在同一个 `sessionDirectory` 下
- 恢复时 `cwd` 必须与原 session 一致,否则抛 `Session workspace is X, not requested workspace Y`
- `persistentSession: false` 时 session 关闭即删,无法恢复

### 17.6 工作流：OAuth Token 注入

```typescript
const { agent } = await createCodingAgent({
  cwd: repoRoot,
  provider: "kimi",
  model: "kimi-k2",
  baseUrl: "https://api.moonshot.cn/v1",
  authType: "bearer", // 启用 OAuth bearer 模式
  accessTokenProvider: async () => {
    // 在这里实现 token 刷新逻辑
    const token = await myOAuthClient.getAccessToken();
    return token;
  },
  // ...
});
```

**行为契约**：

- `accessTokenProvider` 在 `createCodingAgent` 时**不会**被调用
- 每次 `agent.submit()` 触发模型请求时**才会**调用
- `authType: "none"` 时,`accessTokenProvider` 永远不会被调用
- provider 抛错会冒泡到 `submit()` 的 rejection

### 17.7 工作流：自定义审批

```typescript
const { agent } = await createCodingAgent({
  cwd: repoRoot,
  approval: "ask",
  approve: async (request) => {
    // request.tool: ToolDefinition
    // request.arguments: 工具参数
    // request.risk: "low" | "medium" | "high"
    console.log(`审批请求: ${request.tool.name} (${request.risk})`);
    const allowed = await myApprovalUI.confirm(request);
    return allowed;
  },
  // ...
});
```

### 17.8 工作流：事件流订阅

```typescript
const { agent } = await createCodingAgent({
  cwd: repoRoot,
  onEvent: (event) => {
    switch (event.type) {
      case "streaming":
        process.stdout.write(event.delta);
        break;
      case "tool_call":
        console.log(`\n[工具调用] ${event.tool}`);
        break;
      case "approval_required":
        console.log(`\n[审批请求] ${event.tool}`);
        break;
      case "error":
        console.error(`\n[错误] ${event.message}`);
        break;
    }
  },
  // ...
});
```

### 17.9 故障排查

| 症状                                                        | 可能原因                 | 修复                                                      |
| ----------------------------------------------------------- | ------------------------ | --------------------------------------------------------- |
| `Cannot find package '@focuscode/sdk'`                      | 未安装或未构建           | `npm install @focuscode/sdk`;源码场景用 `pnpm build`      |
| `Enterprise mode rejects non-isolated shell executor: host` | 企业模式 + Host 沙箱     | 切换到 `docker`/`gvisor`/`vm`                             |
| `Session workspace is X, not requested workspace Y`         | resume 时 cwd 不匹配     | 确保 `cwd` 与原 session 一致                              |
| `Enterprise mode requires a 32+ byte audit key`             | 缺 HMAC 密钥             | `export FOCUSCODE_AUDIT_HMAC_KEY=$(openssl rand -hex 32)` |
| `Unsupported Model Pack version`                            | modelPackPath 指向坏文件 | 用 `pnpm schemas` 重新生成;或回退默认 pack                |
| `OAuth refresh failed`                                      | accessTokenProvider 抛错 | 在 provider 中加 try/catch + 日志                         |
| `No sandbox available`                                      | `auto` 链路无可用沙箱    | 安装 Docker/gVisor;或显式 `kind: "host"`                  |
| `Duplicate tool: <name>`                                    | 注册表冲突               | 在扩展加载阶段去重                                        |
| 模型请求超时                                                | baseUrl 不可达或网络代理 | 检查 `baseUrl`、代理设置、`apiKey`                        |

### 17.10 测试策略

SDK 自身测试位于 [packages/sdk/test/](file:///Users/tohnee/Trae/Code/focuscode/packages/sdk/test/)：

| 测试文件                       | 覆盖场景                                                 |
| ------------------------------ | -------------------------------------------------------- |
| `e2e.test.ts`                  | Agent 构造、审计循环、企业扩展策略                       |
| `effect-spine.test.ts`         | EffectSpine grant linkage、权限控制                      |
| `session-spine-parity.test.ts` | legacy 路径与 spine 路径行为一致性                       |
| `session-resume.test.ts`       | session resume / missing / cwd-mismatch                  |
| `oauth-token.test.ts`          | accessTokenProvider lazy 调用 / 错误冒泡 / authType=none |
| `model-pack-failure.test.ts`   | Model Pack ENOENT / schema 断言 / 无效 JSON              |

**确定性测试**：使用 `kind: "scripted"` model,无需 API Key：

```typescript
const harness = await createLocalHarness({
  repoRoot,
  stateDirectory,
  model: {
    kind: "scripted",
    steps: [
      { kind: "tool_intent_template", intents: [...] },
      { kind: "completion_candidate", summary: "done", evidence: [], residualRisks: [] },
    ],
  },
});
```

### 17.11 参考文档

- [docs/API_MANUAL.md §3](file:///Users/tohnee/Trae/Code/focuscode/docs/API_MANUAL.md) —— SDK 组合根完整 API
- [examples/sdk/quickstart.mjs](file:///Users/tohnee/Trae/Code/focuscode/examples/sdk/quickstart.mjs) —— 可运行示例
- [packages/sdk/test/](file:///Users/tohnee/Trae/Code/focuscode/packages/sdk/test/) —— 测试用例集
- [docs/schemas/](file:///Users/tohnee/Trae/Code/focuscode/docs/schemas/) —— JSON Schema

---

## 附录 B：环境变量速查

| 变量                                 | 用途                          |
| ------------------------------------ | ----------------------------- |
| `FOCUSCODE_MODEL`                    | 默认模型 ID                   |
| `FOCUSCODE_MODEL_BASE_URL`           | 默认 baseUrl                  |
| `FOCUSCODE_MODEL_API_KEY`            | 默认 API Key                  |
| `FOCUSCODE_AUDIT_HMAC_KEY`           | 企业审计 HMAC key（≥32 字节） |
| `MOONSHOT_API_KEY`                   | Kimi/Moonshot API Key         |
| `DASHSCOPE_API_KEY`                  | Qwen/DashScope API Key        |
| `ZHIPU_API_KEY`                      | GLM/智谱 API Key              |
| `DEEPSEEK_API_KEY`                   | DeepSeek API Key              |
| `MINIMAX_API_KEY`                    | MiniMax API Key               |
| `FOCUSCODE_<PROVIDER>_CLIENT_SECRET` | OAuth client secret           |

## 附录 C：参考文档

- [AGENTS.md](file:///Users/tohnee/Trae/Code/focuscode/AGENTS.md) —— 仓库结构与命令总览
- [docs/ARCHITECTURE.md](file:///Users/tohnee/Trae/Code/focuscode/docs/ARCHITECTURE.md) —— 架构与两条执行路径
- [docs/API_MANUAL.md](file:///Users/tohnee/Trae/Code/focuscode/docs/API_MANUAL.md) —— 系统 API 手册
- [docs/OAUTH_AND_PROVIDERS.md](file:///Users/tohnee/Trae/Code/focuscode/docs/OAUTH_AND_PROVIDERS.md) —— Provider 集成
- [docs/TUI_AND_MULTIMODAL.md](file:///Users/tohnee/Trae/Code/focuscode/docs/TUI_AND_MULTIMODAL.md) —— TUI 与多模态
- [docs/EXTENSIONS_AND_SHARING.md](file:///Users/tohnee/Trae/Code/focuscode/docs/EXTENSIONS_AND_SHARING.md) —— 扩展与分享
- [docs/SANDBOXING.md](file:///Users/tohnee/Trae/Code/focuscode/docs/SANDBOXING.md) —— 沙箱详解
- [docs/V0.4_ENTERPRISE_DEPLOYMENT.md](file:///Users/tohnee/Trae/Code/focuscode/docs/V0.4_ENTERPRISE_DEPLOYMENT.md) —— 企业部署
- [docs/NPM_RELEASE.md](file:///Users/tohnee/Trae/Code/focuscode/docs/NPM_RELEASE.md) —— npm 发布
- [SECURITY.md](file:///Users/tohnee/Trae/Code/focuscode/SECURITY.md) —— 安全策略
- [docs/runbooks/local-alpha.md](file:///Users/tohnee/Trae/Code/focuscode/docs/runbooks/local-alpha.md) —— 本地 Alpha 运维
- [docs/threat-models/alpha-threat-model.md](file:///Users/tohnee/Trae/Code/focuscode/docs/threat-models/alpha-threat-model.md) —— 威胁模型
- [docs/schemas/](file:///Users/tohnee/Trae/Code/focuscode/docs/schemas/) —— JSON Schema

---

> **维护说明**：本文档由代码审查生成，对应仓库 `main` 分支当前状态（`0.4.0-beta.2`）。CLI 参数或工作流变更后请同步更新。如发现文档与代码不一致，以代码为准并提 issue。
