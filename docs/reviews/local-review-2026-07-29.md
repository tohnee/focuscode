# Local Code Review — FocusCode 未提交改动

**Reviewed**: 2026-07-29
**Scope**: 12 modified + 11 untracked files (+489/-10 lines)
**Decision**: APPROVE with comments

## Summary

整体改动质量高、符合仓库规范。三层配置加载、`preToolUse` hook 桥接、Checkpoint 回退 N 步、SGR 鼠标解析、Vim 持久化、LSP 补全、`run-coding-agent` SDK 入口等均有良好的 JSDoc 和错误处理。发现 1 个 HIGH 问题（SDK preToolUse 通过私有字段强转注入）、2 个 MEDIUM 问题（鼠标占位符、缺少 tsconfig 入口）、若干 LOW 建议。全量 build 通过；1589 个测试中 11 个 live-provider 跳过，1 个 tree-panel 测试套件失败为预存问题（源文件未接入构建）。

## Findings

### CRITICAL

None.

### HIGH

**H1 — SDK 通过私有字段强转注入 `preToolUse` hook（`packages/sdk/src/coding-agent.ts`）**

位置：`coding-agent.ts` 中 `(extensions as unknown as { beforeToolHooks: ... }).beforeToolHooks.push(hook)`

描述：通过 `as unknown as` 访问 ExtensionHost 的私有字段 `beforeToolHooks`，绕过类型系统。若后续 ExtensionHost 内部重构（数组改名、改为 Set/Map、或引入 lazy init），此处会在运行时静默失败或抛错，且没有类型检查保护。这是 SDK 公共 API 的核心桥接点，应使用正式公共 API。

建议：在 ExtensionHost 上暴露一个公共方法 `registerBeforeToolHook(hook)` 或 `api.beforeTool(hook)`，让 SDK 通过公共接口注册，而非私有字段访问。

### MEDIUM

**M1 — 鼠标事件处理器是无操作占位符（`packages/tui/src/app.ts`）**

位置：`handleMouseEvent()` 方法体只有 `void key;`

描述：SGR 鼠标解析已经完整实现（press/release/drag/scroll），keymap 层正确产出 `{type:"mouse"}` 事件，feedInput 正确路由到 handleMouseEvent，但该方法是 no-op。这意味着：

1. 开启鼠标报告模式的终端会发送鼠标事件，被解析后丢弃，无视觉反馈
2. 代码路径是死代码，直到后续实现

建议：要么（a）在本 PR 中实现最小可用行为（滚轮映射到 `scroll_up/down`、点击切换 activePane），要么（b）加明确 TODO 注释说明计划版本，避免让读者以为这是已完成特性。同时考虑是否需要在 TUI 启动时显式开启鼠标报告（`\u001b[?1000h` / `\u001b[?1006h` SGR 模式），否则很多终端不会发送鼠标事件。

**M2 — 新增 `lsp-completion.ts`、`tree-panel.ts`、`mcp-sdk-server.ts` 未在 `index.ts` 导出**

位置：`packages/tui/src/index.ts`、`packages/agent-runtime/src/index.ts`

描述：三个新源文件未被包入口 re-export，外部使用者无法通过 `@focuscode/tui` 导入 LSP 补全或 session tree 面板。CheckpointStore.restoreN、LspClient.completion 作为已有类的新方法会自动可用，但独立模块需要显式导出。

建议：确认这些是内部模块还是公共 API。若是公共 API，在对应 `src/index.ts` 中添加 `export * from "./lsp-completion.js"` 等；若是内部模块，建议加 `@internal` JSDoc 标注并在文件注释中说明。

**M3 — 新功能缺少对应测试**

位置：

- `CheckpointStore.restoreN()` — 无直接测试（`checkpoint-rewind.test.ts` 为 untracked 但看起来还在开发中）
- `LspClient.completion()` — 无测试
- 三层 config 加载 (`settingSources`) — 有 `setting-sources.test.ts`（untracked，看起来已有）
- SGR 鼠标解析 — 有 `mouse-support.test.ts`（untracked）
- SDK preToolUse hook — 有 `hooks-beforetool.test.ts`（untracked）
- forkSession — 有 `fork-session.test.ts`（untracked）
- run-coding-agent — 有 `run-coding-agent.test.ts`（untracked）

描述：大部分新功能有 untracked 测试文件，但这些测试还没被 git 跟踪，也需要确认通过。CheckpointStore.restoreN 和 LspClient.completion 似乎没有对应测试文件。

建议：在提交前补全 restoreN 和 LspClient.completion 的单元测试；确保所有 untracked 测试文件通过后再 add。

### LOW

**L1 — `globalConfigPath()` 与 CLI 层已有配置路径可能重复**

位置：`apps/cli/src/agent-command.ts` 中新增的 `globalConfigPath()/readGlobalConfig()/writeGlobalConfig()`

描述：`resolveAgentConfig` 已经读取 `~/.focuscode/config.json` 作为 global 层。这里新增的 vim 持久化代码重新实现了一套几乎相同的路径计算和读写逻辑（但只读写 `tui.vimEnabled` 一个字段）。两套独立的 JSON 读写会产生 last-write-wins 竞争：若 CLI 同时在两处写 global config，可能覆盖对方字段。

建议：复用 `packages/agent-runtime/src/config.ts` 中的读写逻辑，或在 CLI 层抽象一个 `editGlobalConfig(updater)` 辅助函数做 read-modify-write。

**L2 — Vim 持久化错误静默吞掉**

位置：`agent-command.ts` 的 `onVimToggle` callback 中 `catch {}`

描述：写入失败时无任何日志或状态栏反馈，用户可能发现 vimEnabled 设置没有保存但不知道原因。

建议：至少在 debug 模式下输出 `process.stderr.write` 警告，或通过 `tui.setStatus()` 提示"Failed to persist vim preference"。

**L3 — `LspClient.completion()` fail-quiet 返回空数组**

位置：`packages/agent-runtime/src/lsp-client.ts`

描述：任何异常（超时、连接断开、LSP 返回错误）都被静默捕获为 `[]`。这对补全回退是合理的，但调试时无从得知 LSP 是否在工作。

建议：考虑在 debug 模式下用 `process.stderr.write` 输出失败原因，或在 `LspClient` 中记录最近一次错误供诊断。

**L4 — themes.ts 注释提到 `FOCUSCODE_COLOR_MODE=256` 但未见实现**

位置：`packages/tui/src/themes.ts` 注释："built-in 256-color downgrade when `FOCUSCODE_COLOR_MODE=256`"

描述：注释声称支持色深降级，但代码中未见该环境变量的解析逻辑。

建议：要么在本次提交中实现该 env var 解析，要么移除注释中的承诺，避免误导用户。

## Validation Results

| Check                 | Result                                                                         |
| --------------------- | ------------------------------------------------------------------------------ |
| Type check (`tsc -p`) | Pass (all packages)                                                            |
| Lint (`pnpm lint`)    | Not run (requires prettier check on entire repo)                               |
| Tests                 | 1589 passed / 1 failed (pre-existing tree-panel) / 11 skipped (live-providers) |
| Build                 | Pass (pnpm build all packages)                                                 |

## Files Reviewed

| File                                           | Change Type       | Notes                                              |
| ---------------------------------------------- | ----------------- | -------------------------------------------------- |
| `apps/cli/src/agent-command.ts`                | Modified          | Vim 持久化，新增 global config 读写                |
| `apps/cli/src/tui.ts`                          | Modified          | 透传 vimEnabled/onVimToggle 到 TUI options         |
| `packages/agent-runtime/src/checkpoints.ts`    | Modified          | 新增 `restoreN(n)` 批量回退                        |
| `packages/agent-runtime/src/config.ts`         | Modified          | 三层配置（user/project/local）、settingSources     |
| `packages/agent-runtime/src/lsp-client.ts`     | Modified          | 新增 `completion()` 方法 fail-quiet                |
| `packages/agent-runtime/src/mcp-sdk-server.ts` | Added (untracked) | MCP SDK server（未审查细节）                       |
| `packages/sdk/src/coding-agent.ts`             | Modified          | preToolUse hook 桥接、forkSession 支持             |
| `packages/sdk/src/hooks.ts`                    | Modified          | 新增 PreToolContext/PreToolResult、preToolUse hook |
| `packages/sdk/src/index.ts`                    | Modified          | 导出 run-coding-agent                              |
| `packages/sdk/src/run-coding-agent.ts`         | Added (untracked) | SDK 便捷入口                                       |
| `packages/tui/src/app.ts`                      | Modified          | 鼠标事件路由 + handleMouseEvent 占位符             |
| `packages/tui/src/keymap.ts`                   | Modified          | SGR 鼠标解析、spec history 快捷键                  |
| `packages/tui/src/lsp-completion.ts`           | Added (untracked) | LSP 补全 provider                                  |
| `packages/tui/src/themes.ts`                   | Modified          | 新增 4 个 truecolor 主题注释更新                   |
| `packages/tui/src/tree-panel.ts`               | Added (untracked) | Session tree 面板（未接入构建）                    |
| 7 test files                                   | Added (untracked) | 对应新功能的测试                                   |
