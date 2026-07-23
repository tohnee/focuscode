# 扩展包分发与会话分享

## 1. 扩展包格式

扩展是普通 npm package，并在 `package.json` 声明 FocusCode manifest：

```json
{
  "name": "@example/focuscode-tools",
  "version": "1.2.3",
  "type": "module",
  "focuscode": {
    "apiVersion": "focuscode.extension.v1",
    "entry": "./dist/index.mjs",
    "displayName": "Example tools",
    "permissions": ["tools", "commands", "events"]
  }
}
```

允许的声明：`tools`、`commands`、`events`、`network`、`shell`。`network` 和 `shell` 安装时
默认拒绝，必须分别使用 `--allow-network` / `--allow-shell`。

入口默认导出 factory：

```js
export default function activate(api) {
  api.registerCommand({
    name: "hello",
    description: "Say hello",
    execute: (args) => `Hello ${args || "coder"}`,
  });
  api.appendSystemPrompt("Use this extension only when relevant.");
}
```

完整示例在 `examples/extension-hello`。

## 2. 生命周期

```bash
focuscode extension pack ./my-extension --out ./dist
focuscode extension install @example/focuscode-tools@1.2.3
focuscode extension list
focuscode extension remove @example/focuscode-tools
```

安装流程：

1. 拒绝以 `-` 开头、含换行/NUL 的 spec；
2. 使用 `npm install --ignore-scripts --save-exact`，防止安装期 lifecycle 执行；
3. 对 registry package 执行 `npm audit signatures --json`；
4. 验证 package name/version、FocusCode API、相对入口和权限；
5. 读取 npm lock integrity；
6. 写入 `focuscode-lock.json`；
7. 任一步失败就卸载刚安装的 package，避免半安装状态。

本地目录/tarball 没有 registry signature，必须显式 `--allow-unsigned`。即使已经安装，
`requireExtensionSignatures: true` 的运行配置也拒绝加载 unsigned package。

```json
{
  "schemaVersion": "focuscode-agent.v1",
  "requireExtensionSignatures": true,
  "extensionDirectory": "/controlled/path/focuscode-extensions"
}
```

项目内 `.focuscode/extensions` 仍需要 `--trust-project`；命令行 `--extension PATH` 是当前用户的
显式一次加载。

企业模式进一步采用 fail-closed 策略：只加载 `enterprise.allowedExtensions` 中的精确包名，
强制 registry signature，默认关闭项目扩展，并拒绝临时 `--extension PATH`。声明 `network`
或 `shell` 的扩展即使在 allowlist 中也不加载。该策略降低供应链暴露面，但不等同于运行时隔离。

## 3. 扩展安全边界

Extension Tool 会经过同一个 Permission Controller。默认 `extensions.host: "in-process"` 下，
extension factory、command 和 event listener 在 CLI Node 进程内运行；设为 `"process"` 后每个
扩展在独立 Node 子进程中运行，经 stdio JSON-RPC 注册 tool/command/prompt 并接收事件：

```json
{
  "schemaVersion": "focuscode-agent.v1",
  "extensions": { "host": "process" }
}
```

进程模式提供可靠性隔离（扩展崩溃只把该扩展标记为 dead，不拖垮宿主与其他扩展）和权限运行时
强制的挂点，但不是安全沙箱：子进程拥有当前用户完整权限，仅继承最小环境变量白名单
（PATH/HOME/LANG 等，不含模型凭据）。manifest permission 是安装同意与审计信息，不是系统
调用拦截。签名证明 registry artifact provenance，也不证明代码安全。

因此：

- 只安装经过代码审阅或组织 allowlist 的扩展；
- 生产环境固定 exact version、integrity 和 registry；
- 不对不可信扩展设置 `requireExtensionSignatures: false`；
- 不把 shell/network 权限当作 capability sandbox；
- 不把进程模式当作不可信代码的隔离手段；下一 Gate 是 WASI 级 containment、能力代理与撤销列表。

## 4. 会话分享格式

`focuscode-share.v1` 包含 portable session、workspace hint、创建时间、脱敏数、Ed25519 public key
和 signature。签名输入使用 key-sorted canonical JSON，避免属性顺序影响验证。

```bash
focuscode share export --session SESSION_ID --out review.focuscode-share.json
focuscode share import review.focuscode-share.json --repo /new/workspace
```

默认策略：

- `cwd` 改为 `$WORKSPACE`；
- API key、Bearer Token、password、authorization 等常见模式替换为 `[REDACTED]`；
- Tool message content 替换为 `[TOOL OUTPUT OMITTED]`；
- 图片 attachment 删除；
- 模型私有 continuation state（reasoning/thinking/signature block）始终删除，任何开关都不能保留；
- bundle 上限 20 MB；
- 导入时删除旧 session id/fork provenance，重定位 cwd 并生成本地新 id；
- SessionStore 重新校验所有消息和附件。

显式保留：

```bash
focuscode share export --session SESSION_ID \
  --include-tool-output --include-images --out full.focuscode-share.json
```

这可能泄漏源码、日志、图片和凭据；应在导出后人工检查。

## 5. 远程分享服务

启动参考服务：

```bash
export FOCUSCODE_SHARE_TOKEN=replace-me
export FOCUSCODE_SHARE_DIRECTORY=/srv/focuscode-shares
export FOCUSCODE_SHARE_PORT=4319
export FOCUSCODE_SHARE_TRUSTED_SIGNERS=sha256-fingerprint-1,sha256-fingerprint-2
export FOCUSCODE_SHARE_MAX_AGE_DAYS=30
export FOCUSCODE_SHARE_RATE_MAX=60
export FOCUSCODE_SHARE_RATE_WINDOW_MS=60000
pnpm share-server
```

发布和下载：

```bash
focuscode share publish review.focuscode-share.json \
  --endpoint http://127.0.0.1:4319 --token "$FOCUSCODE_SHARE_TOKEN"

focuscode share download SHARE_ID \
  --endpoint http://127.0.0.1:4319 --token "$FOCUSCODE_SHARE_TOKEN"
```

参考 server：

- `GET /health`；
- `POST /v1/shares`：body 上限 25 MB、验 Ed25519 signature、`O_EXCL` 不可变写入；
- `GET /v1/shares/:id`；
- 可执行入口默认要求 Bearer Token；只有显式关闭认证才允许匿名模式；
- Bearer 比较采用 constant-time；可配置允许的签名公钥 fingerprint、最大 bundle 年龄和限流；
- nosniff、no-store、deny-all CSP；
- 默认只监听 `127.0.0.1`，生产应放在 TLS reverse proxy 后。

服务仍不提供 OIDC 身份目录、租户 ACL、数据库索引、删除/保留工作流、配额计费或内容审查；
年龄校验也不是后台自动清理。它是可自托管的安全参考实现，不是公共多租户 SaaS。

## 6. 信任语义

自签 Ed25519 的正确含义是“下载内容与签名时相同，签名者控制该私钥”。它不自动回答：

- 签名者是谁；
- 该用户/组织是否可信；
- 分享 Session 中的历史 Prompt 是否安全；
- 恢复后模型是否会服从恶意历史内容。

导入外部 Session 后应先用 `--approval deny` 审阅，确认后再允许写或 Shell。
