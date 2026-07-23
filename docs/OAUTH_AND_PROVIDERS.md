# OAuth 与原生 Provider 接入

## 1. 认证架构

认证和 Provider 协议是两个独立维度：OAuth 负责获得短期 Bearer Token；Provider adapter
负责请求结构、流式事件、Tool Call、图片和 usage。一个自定义 OAuth Profile 可以配合任意
支持 Bearer Token 的原生或兼容 Provider。

凭据查找优先级：

1. SDK 显式 `accessTokenProvider`；
2. `--oauth-account` 对应的加密凭据与自动 refresh；
3. `--api-key` / `FOCUSCODE_API_KEY`；
4. Provider 的专属环境变量；
5. `authType: none` 不发送认证 Header。

Token 不写入 Session、Prompt、Tool 环境或普通日志。

## 2. OAuth Flow

### Authorization Code + PKCE

```bash
export FOCUSCODE_GOOGLE_CLIENT_ID=...
focuscode auth login google --account work
```

实现使用随机 state、S256 code challenge 和 `127.0.0.1` 随机端口回调。回调只接受
`GET /oauth/callback`；无关 favicon/path 不会完成或破坏登录。浏览器启动失败会关闭 callback
server，而不是留下监听端口。

无浏览器自动打开：

```bash
focuscode auth login google --account work --no-browser
```

### Device Authorization

```bash
focuscode auth login github --device --account work
```

轮询支持 `authorization_pending`、`slow_down`、provider interval 和到期错误。只有 Profile
声明了 device endpoint 才能使用。

### Refresh

模型请求前保留 60 秒过期余量。Access Token 临近过期时用 Refresh Token 更新，并原子重写
凭据库；Provider 未返回新 Refresh Token 时保留旧值。

### OIDC discovery 与 revoke

```bash
focuscode auth login corp \
  --issuer https://login.example.com \
  --client-id "$FOCUSCODE_CORP_CLIENT_ID" \
  --scope openid,profile,offline_access,models
focuscode auth logout corp --account default --revoke
```

Discovery 要求 HTTPS、返回 issuer 必须与配置精确一致，并校验 authorization/token/device/revoke
endpoint。Token endpoint 会在 `none`、`client_secret_basic`、`client_secret_post` 中协商；撤销失败
不会伪装成本地和服务端都已退出。

## 3. 凭据库

默认目录：`~/.focuscode/auth`。

- database：AES-256-GCM envelope，随机 96-bit IV；
- 无 passphrase：随机 256-bit 本地 key，POSIX 权限必须为 `0600`；
- 有 passphrase：scrypt 派生 key，不落地派生结果；
- 写入：临时文件 + rename，database 和 key 权限收紧；
- account key：`provider/account`，支持同 Provider 多身份；
- `auth list` 只显示 Provider、account、scope 和 expiry，不显示 Token。

```bash
export FOCUSCODE_CREDENTIAL_PASSPHRASE='use-a-secret-manager-to-inject-this'
focuscode auth list
focuscode auth logout google --account work
```

相邻本地 key 主要防止误传和宽权限读取，不能抵抗已控制同一 OS 用户的攻击者。高安全环境应
注入 passphrase 或替换为 OS keychain/HSM adapter。

## 4. 内置与自定义 Profile

Google 与 GitHub 提供 endpoint/scopes 默认值。GitHub Profile 主要用于设备流和扩展生态身份，
不意味着 GitHub 是模型 Provider。没有公开、稳定 OAuth 接口的模型服务不会被 FocusCode
伪造为“内置订阅登录”。

自定义 Profile：

```bash
export FOCUSCODE_CORP_CLIENT_ID=...
export FOCUSCODE_CORP_CLIENT_SECRET=...

focuscode auth login corp \
  --authorization-url https://login.example.com/oauth2/authorize \
  --device-url https://login.example.com/oauth2/device \
  --token-url https://login.example.com/oauth2/token \
  --scope models,offline_access \
  --audience https://models.example.com
```

所有远端 OAuth endpoint 必须 HTTPS；只为 loopback 测试允许 `http://127.0.0.1`。

## 5. 原生协议选择

```json
{
  "schemaVersion": "focuscode-agent.v1",
  "provider": "corp",
  "model": "coder-v3",
  "protocol": "openai-responses",
  "baseUrl": "https://models.example.com/v1",
  "oauthAccount": "work",
  "contextWindow": 128000,
  "maxOutputTokens": 16384,
  "toolMode": "native"
}
```

| protocol             | endpoint suffix                                         | Tool dialect                      | 图片                  |
| -------------------- | ------------------------------------------------------- | --------------------------------- | --------------------- |
| `openai-responses`   | `/responses`                                            | top-level function tools/items    | `input_image`         |
| `openai-chat`        | `/chat/completions`                                     | `tools[].function` / `tool_calls` | content part/data URL |
| `anthropic-messages` | base 已含 `/v1` 时加 `/messages`，否则加 `/v1/messages` | `tool_use` / `tool_result`        | base64 或 URL source  |
| `google-gemini`      | `/models/{id}:streamGenerateContent?alt=sse`            | functionDeclaration/Call/Response | inlineData/fileData   |

若 endpoint 已包含最终 suffix，adapter 不会重复追加。所有 HTTP error 只返回截断响应体，不
输出请求 Header。

## 6. 开源模型适配

内置默认值：

| Provider | 默认模型           | 关键方言                                                                             |
| -------- | ------------------ | ------------------------------------------------------------------------------------ |
| Kimi     | `kimi-k3`          | 顶层 `reasoning_effort=max`、完整 `reasoning_content` 回放、图像                     |
| Qwen     | `qwen3-coder-plus` | `enable_thinking`、stream usage、模型级能力覆盖                                      |
| GLM      | `glm-5.2`          | `thinking`、`reasoning_effort`、`tool_stream`、reasoning 回放                        |
| DeepSeek | `deepseek-v4-pro`  | thinking、high/max effort、无 `tool_choice`、tool-call state 回放                    |
| MiniMax  | `MiniMax-M3`       | Anthropic `/v1/messages`、adaptive thinking、thinking/signature block 原样回放、图像 |

这些是 2026-07-19 的版本化默认值。模型 ID、区域和字段会变化，生产配置必须 pin revision 并跑
recorded/live contract test；不能把“OpenAI-compatible”理解为行为完全相同。

`toolMode` 是模型能力开关，不与 Provider 品牌绑定：

- `native`：只信任协议原生 Tool Call；
- `prompt-json`：不发送原生工具，把定义写入稳定 Prompt，只接受完整 JSON envelope；
- `auto`：优先原生调用，也识别完整 JSON fallback。

不要仅因为某 endpoint 声称 OpenAI-compatible 就假定 streaming/tool/image/reasoning 全兼容。
生产配置应固定模型 revision、chat template、serving engine 和 Tool Mode，并保存 recorded
stream 回归样本。

推理 Provider 的 continuation state 会经过 Session 运行时校验并持久化，下一次 Tool round 原样
回放。分享包始终移除该 state，避免把不可见推理链作为协作内容传播。

## 7. SDK

```ts
import { createCodingAgent } from "@focuscode/sdk";

const { agent } = await createCodingAgent({
  cwd: process.cwd(),
  provider: "corp",
  model: "coder-v3",
  protocol: "anthropic-messages",
  baseUrl: "https://models.example.com/v1",
  authType: "bearer",
  accessTokenProvider: async () => obtainShortLivedToken(),
  sandbox: { kind: "gvisor" },
});

await agent.submit("修复测试");
```

SDK 不要求使用 FocusCode 本地凭据库；企业可以注入 Workload Identity、Vault 或 Secret Broker。
