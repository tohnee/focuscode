# npm 发布、安装与验收

## 1. 包结构

发布包名：`@focuscode/cli`，版本：`0.4.0-beta.2`。

安装包只包含：

```text
LICENSE
README.md
bundle/focuscode.mjs
model-packs/generic-openai/README.md
model-packs/generic-openai/pack.json
package.json
```

`bundle/focuscode.mjs` 使用 esbuild 将 CLI 及运行期 workspace 模块打成 Node 22 ESM，并保留
`#!/usr/bin/env node` 和可执行权限。安装方不需要 pnpm、TypeScript、esbuild 或 monorepo 内部包。

## 2. 本地打包

```bash
pnpm install --frozen-lockfile
pnpm npm:bundle
npm pack ./apps/cli
```

`prepack` 会重新生成 bundle，避免发布旧构建。

完整验证：

```bash
pnpm npm:verify
```

该脚本在系统临时目录完成：

1. `npm pack --json`；
2. 使用 `--ignore-scripts --no-audit --no-fund` clean install tarball；
3. 从已安装 bundle 执行 `focuscode --version`；
4. 执行 `focuscode mascots`；
5. 对发布文件做 allowlist；
6. 用已安装 CLI 启动本地 SSE Provider，完成 write Tool 的两轮 coding loop；
7. 将 tarball 和 SHA-256 报告写到 `reports/npm`。

## 3. 本地安装

```bash
npm install --global ./reports/npm/focuscode-cli-0.4.0-beta.2.tgz
focuscode --version
```

也可以不全局安装：

```bash
npm install ./reports/npm/focuscode-cli-0.4.0-beta.2.tgz
npx focuscode --help
```

## 4. Registry 发布

需要 npm 账号拥有 `@focuscode` scope 权限。代码已配置 public access 和 provenance：

```bash
pnpm release:check
npm publish ./reports/npm/focuscode-cli-0.4.0-beta.2.tgz \
  --access public --provenance --tag beta
```

本工程不会在测试或交付过程中自动执行外部 publish；这是有供应链影响的人工 release 操作。

建议 GitHub Actions 使用 npm trusted publishing/OIDC，不在 repository secret 长期保存 npm token。

## 5. Release Gate

`pnpm release:check` 必须全部通过：

- architecture boundaries；
- Prettier；
- 所有 workspace TypeScript build；
- Vitest 与 coverage floors；
- Audited Kernel demo；
- Conversational Agent demo；
- npm pack/clean install/installed coding loop。

发布后再执行：

```bash
npm install --global @focuscode/cli@alpha
focuscode --version
focuscode sandbox doctor --kind auto
```

## 6. 版本与兼容策略

- Beta 可改变配置和 Extension API，但必须在 Changelog 标记；
- `focuscode-agent.v1`、`focuscode-extension.v1`、`focuscode-share.v1` 不允许静默改变语义；
- 破坏 schema 的变更创建新版本，而不是按运行时猜测；
- CLI bundle 与源码 root 使用同一版本；
- npm tarball 的 SHA-256 与 clean-install report 一起交付；
- 不把 `node_modules`、测试 secret、Session 或本地凭据打进包。
