# CLI Agent 工程设计与扩展接口

## 1. Composition

CLI 的创建顺序固定，任何新入口应复用 `@focuscode/sdk.createCodingAgent()` 或保持同一顺序：

1. 解析全局配置；
2. 只有显式信任后才合并项目配置；
3. 解析 Provider/Model Profile，并绑定 API Key 或 OAuth access-token callback；
4. 创建 Host/Docker/gVisor/VM SandboxExecutor；
5. 创建 Workspace Tool Registry，把 Sandbox 注入 Bash；
6. 应用 Tool allowlist/denylist；
7. 发现可信 Instructions/Skills/Prompts，并按签名策略加载 npm/项目 Extensions；
8. 创建 Session Store 或恢复/Fork Session；
9. 创建 Model Client、Permission Controller 和 Coding Agent；
10. 绑定 TUI、Interactive、Print、JSON 或 RPC Renderer。

安全相关步骤不可交换：Extension 必须在项目信任后加载；Tool Filter 必须在模型看到 schema
之前生效；API Key 只进入 Model Client，不能进入 Tool Process 环境。

## 2. 关键源码

| 文件                                  | 职责                                                         |
| ------------------------------------- | ------------------------------------------------------------ |
| `packages/agent-runtime/src/agent.ts` | 多轮 loop、并行规则、Session append、压缩、Abort             |
| `model-clients.ts`                    | OpenAI Chat/Anthropic HTTP 与 SSE anti-corruption            |
| `native-provider-clients.ts`          | OpenAI Responses/Gemini 原生协议                             |
| `tools.ts`                            | Tool Registry 和十个内置 Coding Tool                         |
| `permissions.ts`                      | Path、Shell 风险和 Approval                                  |
| `session-store.ts`                    | JSONL Event、Tree、Fork、Export                              |
| `context.ts`                          | token 估计、active branch、压缩、Prompt Tool fallback        |
| `config.ts`                           | Global/Project merge、Provider preset、Credential resolution |
| `resources.ts`                        | AGENTS、Skill、Prompt、Extension discovery                   |
| `extensions.ts`                       | Tool/Command/Event/Prompt Extension API 与 reload            |
| `apps/cli/src/agent-command.ts`       | CLI composition root 和模式选择                              |
| `apps/cli/src/interactive.ts`         | REPL、Slash Command、direct shell                            |
| `media.ts`                            | 图片加载与运行时内容验证                                     |
| `steering.ts`                         | 有界 mid-turn 输入队列                                       |
| `packages/auth`                       | OAuth、PKCE/device/refresh、凭据库                           |
| `packages/sandbox`                    | Docker/gVisor/VM/Host executor                               |
| `packages/tui`                        | 全屏终端状态机、主题、keymap、伙伴                           |
| `packages/ecosystem`                  | npm Extension 和 Ed25519 Share                               |
| `apps/cli/src/rpc.ts`                 | JSON-RPC 2.0 stdin/stdout + 并发 steer/abort                 |

## 3. 新 Provider

OpenAI-compatible Provider 只需配置：

```json
{
  "schemaVersion": "focuscode-agent.v1",
  "provider": "my-local-provider",
  "model": "coder-model",
  "providers": {
    "my-local-provider": {
      "protocol": "openai-chat",
      "baseUrl": "http://127.0.0.1:9000/v1",
      "apiKeyEnv": "MY_MODEL_API_KEY",
      "defaultContextWindow": 65536,
      "defaultMaxOutputTokens": 8192
    }
  }
}
```

非兼容协议实现 `ModelClient`，不要把 Provider 条件写进 `CodingAgent`。Client 必须：

- 把所有流式 chunk 组装成一个确定的 `ModelResponse`；
- 未完成的 Tool JSON 不得成为可执行调用；
- 保留 Provider usage；
- 接受 AbortSignal；
- 对 HTTP error 截断响应体，不能泄漏请求 Header；
- 把 Provider stop reason 映射为 FocusCode 枚举。

## 4. 新 Tool

```ts
import type { AgentTool } from "@focuscode/agent-runtime";

export const symbolTool: AgentTool = {
  definition: {
    name: "symbol_search",
    label: "Symbol search",
    description: "Find definitions without changing the workspace.",
    parameters: {
      type: "object",
      required: ["symbol"],
      properties: { symbol: { type: "string" } },
      additionalProperties: false,
    },
    effect: "read",
  },
  async execute(args, context) {
    return { content: `Search ${String(args.symbol)} in ${context.cwd}` };
  },
};
```

Tool 必须输出有界文本；大结果应保存 Artifact 并返回引用。写工具需要 base/digest 或其他
并发保护；远程和 Secret Tool 必须扩展 Permission/Grant，而不能伪装成 `read`。

## 5. Extension

`.focuscode/extensions/example.mjs`：

```js
export default function setup(api) {
  api.appendSystemPrompt("Before completing, inspect git diff.");
  api.registerCommand({
    name: "checklist",
    description: "Show project checklist",
    execute: () => "1. tests\n2. diff\n3. residual risk",
  });
  api.onEvent((event) => {
    if (event.type === "agent_end") {
      // Emit local telemetry or update a UI.
    }
  });
}
```

Extension 是代码执行插件，不是数据文件。项目 Extension 只有 `--trust-project` 后加载；显式
`--extension` 表示当前调用直接信任该文件。

## 6. RPC

请求：

```json
{ "jsonrpc": "2.0", "id": 1, "method": "prompt", "params": { "text": "fix tests" } }
```

运行中事件：

```json
{
  "jsonrpc": "2.0",
  "method": "event",
  "params": {
    "type": "tool_start",
    "call": { "id": "...", "name": "read", "arguments": { "path": "src/a.ts" } }
  }
}
```

支持方法：`prompt`、`steer`、`abort`、`status`、`compact`、`new_session`、`switch_session`、
`fork_session`、`list_sessions`、`set_approval`、`shutdown`。普通请求顺序执行，避免两个写
Turn 并发修改同一 Worktree；`steer` 和 `abort` 绕过 serializer，才能在 prompt 运行中生效。

## 7. Session 兼容规则

- 只追加新 Event Type；不要修改旧行；
- 未识别 Event 在未来版本应可跳过，Header major version 不兼容才拒绝；
- Entry ID 全局唯一，Parent 只引用同一 Session；
- Fork 必须复制 Active Branch 并保存 provenance；
- Compaction 不得删除或覆写 Entry；
- Export 只包含用户可见消息，不包含 API Key、Header 或隐藏 reasoning。

## 8. Definition of Done

CLI Agent 修改必须至少通过：

```bash
pnpm lint
pnpm test:coverage
pnpm agent:demo
pnpm npm:verify
```

涉及 Provider：增加 JSON fallback + SSE arbitrary chunk fixtures。涉及 Tool：增加 workspace escape、
保护路径、Abort/timeout 和真实临时仓库 E2E。涉及 Session：增加 reload/fork/compaction roundtrip。
