# FocusCode Desktop App 开发计划

> **Date:** 2026-07-29
> **Status:** Plan
> **Scope:** 新建 `apps/desktop` Electron 桌面应用 + 跨平台安装包（Mac .dmg / Windows .exe NSIS）
> **Design Spec:** `focuscode-mascots.design/pages/app.html`、`focuscode-mascots.design/pages/app-personalized.html`、`focuscode-mascots.design/colors_and_type.css`
> **Predecessor:** 现有 CLI/TUI 路径继续保留，桌面应用为新增组合根

---

## 1. Executive Summary

本计划为 FocusCode 构建一个基于 Electron 的桌面 GUI 应用，在 Mac 和 Windows 双平台提供原生安装包。核心决策是采用 **Electron + Vite + React 18 + TypeScript + Tailwind CSS** 技术栈，通过 `packages/sdk` 的 `createCodingAgent()` 和 `runCodingAgent()` API 将现有会话型 Coding Agent 能力桥接到渲染进程。新应用以 `apps/desktop` 作为新的组合根（composition root），不修改任何现有包的架构边界。主进程持有所有敏感资源（Provider secrets、MCP stdio、Sandbox 子进程、OAuth 回调），渲染进程仅通过安全的 IPC 通道接收序列化事件流和发送用户指令。UI 采用已设计的 5 面板布局（Top Bar / Nav Rail / Conversation Canvas / Work Panel / Composer / Status Bar），支持 Foxglow 和 Dreamy 星眠双主题、7 位个性化 Mascot 伙伴、Spec Pipeline 可视化、Audit Chain 展示、Diff/Code 编辑器和完整的 steering/approval 交互。MVP 预计 8-10 周完成核心功能，后续完善平台集成和个性化。

---

## 2. Tech Stack Decision

### 2.1 框架选择：Electron（推荐并选定）

| 维度                         | Electron                                      | Tauri v2                                         | Neutralinojs               |
| ---------------------------- | --------------------------------------------- | ------------------------------------------------ | -------------------------- |
| Node.js 原生集成             | 直接 `require()` 现有所有 `@focuscode/*` 包   | 需 Rust sidecar 或 Node sidecar 模式，增加桥接层 | 需外置 Node 进程，通信复杂 |
| 包体积                       | ~150MB                                        | ~5-10MB                                          | ~10MB                      |
| child_process/dockerode 支持 | 原生支持                                      | 需 Rust 侧 FFI 或 sidecar                        | 有限支持                   |
| 生态成熟度                   | 极高（VS Code、Slack、Discord）               | 成长中，v2 刚稳定                                | 小众                       |
| electron-builder 打包        | 一等公民，DMG/NSIS/AppX 全支持                | tauri-cli/bundler                                | 需自定义                   |
| 自动更新                     | electron-updater 成熟方案                     | tauri-updater                                    | 弱                         |
| 原生菜单/文件关联/Dock       | 完整 API                                      | 部分支持                                         | 弱                         |
| 安全模型                     | contextIsolation + preload 桥接，成熟最佳实践 | 默认可信 IPC，需自行设计                         | 弱                         |

**选择 Electron 的核心理由：**

1. FocusCode 重度依赖 Node.js API（child_process 用于沙箱、dockerode 用于容器、MCP stdio、OAuth 本地服务器回调、加密凭据库），Electron 主进程可直接 `import` 所有现有包，零桥接成本。
2. `packages/sdk` 设计为嵌入式 API，天然适配 Electron 主进程作为 host。
3. electron-builder 对 DMG 签名/公证、NSIS 安装器、自动更新有成熟方案，减少打包工程化工作量。
4. 现有团队对 Node.js/TypeScript 栈完全熟悉，无 Rust 学习成本。
5. 包体积 150MB 在桌面开发工具场景可接受（VS Code 约 300MB+）。

### 2.2 关键依赖清单

**主进程（Main Process）：**

- `electron` — 桌面运行时（建议 `^33.x` 或当时最新 LTS）
- `electron-builder` — 打包与安装器生成（`^25.x`）
- `electron-updater` — 自动更新
- `electron-store` — 设置持久化
- `keytar` — 系统凭据库（Keychain / Credential Manager）
- `@focuscode/sdk`、`@focuscode/auth`、`@focuscode/sandbox`、`@focuscode/ecosystem` — 现有 workspace 包（直接 import）

**渲染进程（Renderer Process）：**

- `react` + `react-dom` — UI 框架（`^18.x`）
- `vite` + `@vitejs/plugin-react` — 开发服务器与构建
- `tailwindcss` + `@tailwindcss/vite` — CSS 框架（v4，匹配 design tokens）
- `@monaco-editor/react` + `monaco-editor` — 代码编辑器与 Diff 查看器
- `zustand` — 轻量状态管理（~1KB，避免 Redux 样板）
- `react-markdown` + `remark-gfm` + `rehype-highlight` — Markdown 渲染
- `lucide-react` — 图标库（2800+ 图标，风格一致）
- `clsx` + `tailwind-merge` — className 工具
- `@tanstack/react-virtual` — 虚拟滚动（长对话）

**开发与测试：**

- `electron-vite` — Electron + Vite 集成开发工具
- `@playwright/test` + `playwright` — E2E 测试（Electron 模式）
- `vitest` — 单元测试（复用仓库配置）
- `@testing-library/react` + `@testing-library/user-event` — React 组件测试
- `jsdom` — React 组件测试 DOM 环境
- `cross-env` — 跨平台环境变量
- `electron-builder-notarize` — Mac 公证辅助

---

## 3. Architecture

### 3.1 分层架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│                    Renderer Process (BrowserWindow)             │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  React UI (5-panel layout)                                  │ │
│  │  ┌──────────┬─────────────────────────────────────────┐    │ │
│  │  │ Nav Rail │ Conversation Canvas + Work Panel        │    │ │
│  │  │ 7 icons  │ │ Transcript (mascot + messages)      │ │    │ │
│  │  │          │ │ Spec cards / Approval UI            │ │    │ │
│  │  │          │ ├─────────────────────────────────────┤ │    │ │
│  │  │          │ │ Work Panel (Diff/Code/Spec/Audit)   │ │    │ │
│  │  │          │ ├─────────────────────────────────────┤ │    │ │
│  │  │          │ │ Composer (@mentions /slash /mochi») │ │    │ │
│  │  │          │ └─────────────────────────────────────┘ │    │ │
│  │  └──────────┴─────────────────────────────────────────┘    │ │
│  │  Zustand stores (ui/session/companion/file/settings/auth) │ │
│  └────────────────────────────────────────────────────────────┘ │
│                          │ IPC via contextBridge               │
├──────────────────────────┼──────────────────────────────────────┤
│                    Main Process (Node.js)                       │
│  ┌───────────────────────┼──────────────────────────────────┐  │
│  │  Preload Bridge API   │ (typed IPC channel contract)     │  │
│  └───────────────────────┼──────────────────────────────────┘  │
│  ┌───────────────────────▼──────────────────────────────────┐  │
│  │  Agent Host (packages/sdk)                               │  │
│  │  ┌────────────────────────────────────────────────────┐  │  │
│  │  │ createCodingAgent() / runCodingAgent()            │  │  │
│  │  │ ├─ AgentEvent stream → serialize → IPC → renderer │  │  │
│  │  │ ├─ ApprovalHandler → IPC → UI dialog → response   │  │  │
│  │  │ ├─ Steering: append/interrupt/followup from UI    │  │  │
│  │  │ └─ accessTokenProvider → auth package            │  │  │
│  │  └────────────────────────────────────────────────────┘  │  │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐      │  │
│  │  │ Auth Manager │ │ Sandbox Mgr  │ │ MCP Stdio    │      │  │
│  │  │ (Keychain/   │ │ (gVisor/     │ │ Host (in     │      │  │
│  │  │  CredVault)  │ │  Docker/     │ │  main proc)  │      │  │
│  │  │              │ │  Seatbelt)   │ │              │      │  │
│  │  └──────────────┘ └──────────────┘ └──────────────┘      │  │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐      │  │
│  │  │ Ecosystem    │ │ Session      │ │ Auto Updater │      │  │
│  │  │ Ext Manager  │ │ Store (JSONL)│ │ (GH Releases)│      │  │
│  │  └──────────────┘ └──────────────┘ └──────────────┘      │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 架构边界遵守

关键原则：**不修改任何现有包的依赖方向。**

- `apps/desktop` 作为新的组合根（与 `apps/cli` 平行），是唯一允许同时依赖 `@focuscode/sdk`、`@focuscode/auth`、`@focuscode/sandbox`、`@focuscode/ecosystem` 的地方。
- 不创建新的 `packages/desktop-bridge` 包。桥接逻辑是 Electron 专属（依赖 `electron` IPC），放在 `apps/desktop/src/main/` 和 `apps/desktop/src/preload/` 中。
- 纯 React UI 组件若未来需要复用，可后期提取为 `packages/desktop-ui`（不依赖 electron，不依赖 `@focuscode/*` 核心包），Phase 0 不创建。
- `packages/tui` 继续作为叶子 adapter 不受影响。
- 更新 `scripts/check-boundaries.mjs` 增加规则：`apps/desktop/src/renderer/` 不得出现 `@focuscode/` 或 `node:` 导入。

### 3.3 IPC 通道设计

IPC 采用类型安全通道契约，定义在 `apps/desktop/src/shared/ipc-channels.ts`。

**Main → Renderer（事件推送，`webContents.send`）：**

| Channel                 | Payload                                   | 说明                                                                                  |
| ----------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------- |
| `agent:event`           | `AgentEvent`（序列化）                    | Agent 事件流：text_delta, tool_start/end, approval_required, spec_*, agent_end, error |
| `agent:state-change`    | `{ sessionId, state }`                    | Agent 状态变化                                                                        |
| `session:list-updated`  | `SessionSummary[]`                        | 会话列表变更                                                                          |
| `companion:mood-change` | `{ mascotId, mood, level, bondSegments }` | Mascot 情绪/等级变化                                                                  |
| `sandbox:status`        | `{ available, active, detail? }`          | 沙箱运行时检测结果                                                                    |
| `updater:status`        | `{ status, info? }`                       | 自动更新状态                                                                          |
| `auth:status-changed`   | `{ providers }`                           | 登录状态变化                                                                          |

**Renderer → Main（请求-响应，`ipcRenderer.invoke`）：**

| Channel                                      | 说明                                            |
| -------------------------------------------- | ----------------------------------------------- |
| `agent:create`                               | 创建/启动 Agent 实例                            |
| `agent:submit`                               | 提交用户消息（事件通过 agent:event 流回传）     |
| `agent:steer`                                | Mid-turn steering（append/interrupt/follow-up） |
| `agent:abort`                                | 中止当前运行                                    |
| `agent:approve`                              | 响应审批请求                                    |
| `agent:fork`                                 | Fork 会话                                       |
| `session:list/load/delete/export`            | 会话 CRUD                                       |
| `file:read/tree`                             | 文件内容/文件树                                 |
| `diff:get` / `spec:get` / `audit:get-chain`  | Work Panel 数据获取                             |
| `mcp:list/toggle` / `extension:list/install` | MCP/扩展管理                                    |
| `companion:set-active/get-state`             | Mascot 选择与状态                               |
| `settings:get/set`                           | 设置读写                                        |
| `auth:login/logout`                          | OAuth 登录/退出                                 |
| `dialog:open-folder/open-file`               | 原生对话框                                      |
| `updater:check/download/install`             | 自动更新操作                                    |
| `app:get-version/open-external`              | 应用信息与外部链接                              |

**安全设计：**

- `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`
- preload 通过 `contextBridge.exposeInMainWorld("focuscode", api)` 暴露白名单 API
- 所有 IPC payload 在 main 进程校验类型（TypeBox schema）
- 文件系统访问通过 main 代理，renderer 不直接接触 Node.js fs
- Provider secrets 只存在 main 进程内存和系统 keychain
- Approval 通过 IPC 请求-响应模式

### 3.4 Agent 生命周期管理

主进程维护 `AgentInstanceManager`（以 cwd 为 key），每个 `AgentInstance` 封装：

- `createCodingAgent()` 返回值（agent, sessions, extensions, resources, config）
- Event bridge 将 `onEvent` 转发到 `webContents.send("agent:event", ...)`
- `runCodingAgent()` AsyncGenerator 消费
- Approval handler 桥接（pending promise 等待 renderer 响应）
- 错误隔离：单个实例崩溃不影响其他实例

### 3.5 渲染进程状态管理

Zustand stores 划分：

- **`useUiStore`**：主题、活动面板、Work Panel tab、侧边栏折叠
- **`useSessionStore`**：当前会话、transcript、agent 状态、pending approval、streaming buffer、spec pipeline、audit chain
- **`useCompanionStore`**：当前 mascot、mood、level、bond、voice line 队列
- **`useFileStore`**：文件树、当前打开文件、diff 数据
- **`useSettingsStore`**：模型、sandbox、approval mode、MCP、扩展
- **`useAuthStore`**：provider 登录状态、当前模型

---

## 4. Project Structure

### 4.1 新增目录

```
apps/desktop/
├── package.json
├── tsconfig.json
├── electron-builder.yml
├── electron.vite.config.ts
├── resources/
│   ├── icon.png                # 1024x1024
│   ├── icon.icns               # Mac 图标
│   ├── icon.ico                # Windows 图标
│   ├── entitlements.mac.plist
│   ├── entitlements.mac.inherit.plist
│   └── mascots/                # 7 mascots × 8 moods SVG
├── src/
│   ├── main/                   # 主进程
│   │   ├── index.ts            # Electron app 入口
│   │   ├── window.ts           # BrowserWindow 管理
│   │   ├── menu.ts             # 原生菜单
│   │   ├── ipc-handlers.ts     # ipcMain.handle 注册
│   │   ├── agent-manager.ts    # AgentInstanceManager
│   │   ├── agent-instance.ts   # 单 cwd agent 封装
│   │   ├── auth-manager.ts     # OAuth + keytar
│   │   ├── sandbox-detector.ts # 启动时沙箱检测
│   │   ├── file-service.ts     # 文件代理
│   │   ├── session-service.ts  # 会话 CRUD
│   │   ├── mcp-service.ts      # MCP 管理
│   │   ├── extension-service.ts
│   │   ├── settings-service.ts
│   │   ├── companion-store.ts  # Mascot 状态持久化
│   │   ├── updater.ts
│   │   ├── protocol.ts         # focuscode:// 深链接
│   │   └── security.ts         # CSP、权限验证
│   ├── preload/
│   │   ├── index.ts            # contextBridge 入口
│   │   └── api.ts              # window.focuscode 类型定义
│   ├── renderer/               # React 渲染进程
│   │   ├── index.html
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── styles/
│   │   │   ├── tailwind.css
│   │   │   ├── themes.css      # Foxglow/Dreamy CSS 变量
│   │   │   └── mascots.css
│   │   ├── components/
│   │   │   ├── layout/         # TopBar, NavRail, StatusBar, WindowControls
│   │   │   ├── conversation/   # ConversationCanvas, MascotColumn, Transcript, MessageBubble, ToolCallCard, SpecCard, ApprovalDialog
│   │   │   ├── work-panel/     # WorkPanel, DiffViewer, CodeEditor, SpecPipeline, AuditChain
│   │   │   ├── composer/       # Composer, MentionDropdown, SlashCommandMenu, MascotPrefix, AttachmentPreview, SendButton
│   │   │   ├── companion/      # MascotAvatar, MascotSelector, BondProgress, MoodIndicator, LevelBadge, VoiceLine
│   │   │   ├── panels/         # SessionsPanel, FileTreePanel, SpecsPanel, McpPanel, ExtensionsPanel, SettingsPanel
│   │   │   └── shared/         # Badge, Button, Chevron, Markdown, Spinner
│   │   ├── stores/             # ui-store, session-store, companion-store, file-store, settings-store, auth-store
│   │   ├── hooks/              # useIpc, useAgentStream, useTheme, useMascot, useKeyboard
│   │   ├── lib/                # ipc-contract, event-parser, mascot-data, markdown-utils, platform
│   │   └── types/              # ipc.d.ts, events.d.ts, mascot.d.ts
│   └── shared/                 # main/preload/renderer 共享
│       ├── ipc-channels.ts
│       └── types.ts
└── test/
    ├── unit/
    └── e2e/
```

### 4.2 根 package.json 新增 scripts

```json
{
  "scripts": {
    "desktop:dev": "pnpm --filter @focuscode/desktop dev",
    "desktop:build": "pnpm --filter @focuscode/desktop build",
    "desktop:package": "pnpm --filter @focuscode/desktop package",
    "desktop:package:mac": "pnpm --filter @focuscode/desktop package:mac",
    "desktop:package:win": "pnpm --filter @focuscode/desktop package:win",
    "desktop:test": "pnpm --filter @focuscode/desktop test",
    "desktop:test:e2e": "pnpm --filter @focuscode/desktop test:e2e"
  }
}
```

---

## 5. Phased Development Plan

### Phase 0: 项目脚手架与基础设施（1 周）

**目标：** Electron + Vite + React 骨架，能启动空窗口，CI 绿色。

**交付物：**

- `apps/desktop/` 完整目录结构
- electron-vite 三端构建配置（main/preload/renderer）
- BrowserWindow 创建，加载 React 页面，contextIsolation 启用
- preload 暴露最小 API（`window.focuscode.ping()`）
- TypeScript strict 通过
- `pnpm dev` 开发热重载、`pnpm build` 编译三端
- electron-builder 基础配置（无签名，本地生成 unpacked 目录）
- 更新 `scripts/check-boundaries.mjs` 增加 renderer 禁则
- CI workflow 新增 desktop job（ubuntu + macos + windows 矩阵，仅 build 验证）

**验收标准：**

- `pnpm desktop:dev` 启动显示空窗口
- `pnpm build` 成功
- `pnpm lint` 边界检查通过
- `pnpm desktop:package --dir` 在 `release/` 生成可运行应用
- CI 三个平台均 build 成功

---

### Phase 1: Core Shell — UI 骨架 + 主题 + Mascot 选择（1.5 周）

**目标：** 5 面板静态布局，主题切换，Mascot 选择器，状态栏，导航切换。不连接真实 Agent。

**交付物：**

- **TopBar**：mascot 头像+下拉选择器、Foxglow/Dreamy 主题切换、面包屑、sandbox/model/companion 徽章组、窗口控制
- **NavRail**：7 图标按钮（Search/Sessions/Specs/Companion/Files/MCP/Settings），active 高亮
- **StatusBar**：vim-airline chevron 风格分段（mode/path/git/model/sandbox/ln:col/bond）
- **ConversationCanvas 占位**：静态 mascot 列 + 欢迎消息 + 空 composer
- **WorkPanel 占位**：4 tab 切换（Diff/Code/Spec/Audit），静态内容
- **Composer 占位**：多行文本框、发送按钮、Enter/Shift+Enter 键盘事件
- **主题系统**：CSS variables 从 design CSS 完整移植，`<html data-theme="dreamy">` 切换，Tailwind v4 映射 tokens
- **Mascot 选择器**：7 伙伴头像网格，点击联动 TopBar/Composer 前缀/mascot 列
- **快捷键基础**：Cmd/Ctrl+K 搜索、Cmd/Ctrl+, 设置、Cmd/Ctrl+N 新会话
- 最小窗口尺寸 1024x680

**验收标准：**

- 完整 5 面板布局渲染
- Foxglow/Dreamy 切换所有面板颜色正确，无硬编码颜色
- Mascot 切换联动正确（头像、前缀、颜色）
- NavRail 切换面板、StatusBar chevron 正确
- 控制台无 React 错误/warning

---

### Phase 2: Session Bridge — IPC + Agent 事件流 + Transcript（2 周）

**目标：** 打通主进程到渲染进程的 Agent 通信，实现真实对话流。

**交付物：**

- **主进程 AgentManager**：`createCodingAgent()` 封装、event bridge、approval handler、accessTokenProvider、session 生命周期
- **IPC 通道实现**：agent:* 和 session:* 核心通道
- **Renderer useAgentStream hook**：订阅 `agent:event`，更新 Zustand session store
- **Transcript 渲染**：
  - text_delta 累积 + 打字机效果
  - reasoning_delta 折叠面板
  - tool_start/tool_end 工具调用卡片（可展开参数/结果/时长）
  - approval_required 弹出 ApprovalDialog
  - error/usage/model_retry 事件处理
- **Composer 提交**：IPC `agent:submit`，即时追加 user 消息
- **Abort/Stop**：运行中显示 Stop 按钮
- **会话列表（基础版）**：列出当前 cwd 会话，切换/新建
- **初始项目选择**：首次启动 "Open Folder" 对话框
- **Markdown 渲染**：react-markdown + remark-gfm + 代码块高亮
- **虚拟滚动**：长会话流畅

**验收标准：**

- 使用确定性 SSE Provider 完成完整对话（发消息→流式输出→工具调用→结束）
- Approval 弹窗 Allow/Deny 后 agent 继续
- 切换会话加载历史消息
- 100+ 消息滚动流畅
- TypeScript IPC 类型安全无 any 逃逸

---

### Phase 3: Work Panels — Diff / Code / Spec / Audit（1.5 周）

**目标：** Work Panel 4 个 Tab 展示真实数据。

**交付物：**

- **DiffViewer**：Monaco DiffEditor，文件修改工具后自动展示，多文件切换，语法高亮
- **CodeEditor（只读）**：Monaco Editor，点击 File Tree 打开，多文件标签页
- **SpecPipeline**：5 阶段进度条（Discover→Plan→Confirm→Execute→Verify），spec_draft_ready 展示卡片，spec_confirmation_required 展示确认 UI，阶段转换动画
- **AuditChain**：Intent→Grant→Tool Started→Effect Receipt→Verification 时间线，风险级别、变更文件数、HMAC 状态
- **Work Panel 与 Transcript 联动**：点击工具卡片切换对应 tab
- **FileTree 面板**：可展开/折叠目录，点击文件在 Code tab 打开，忽略 node_modules/.git

**验收标准：**

- 文件写入后 Diff tab 自动显示左右对照
- 点击 .ts 文件 Code tab 显示语法高亮只读内容
- Spec 模式下 5 阶段进度正确反映状态
- Audit 时间线显示完整调用链
- Monaco 在 Mac/Win 正确渲染（DPI 缩放正常）

---

### Phase 4: Composer & Interactions — 富交互（1.5 周）

**目标：** @mentions、slash commands、附件、steering、approval 完善。

**交付物：**

- **@mentions**：输入 `@` 弹出下拉搜索（文件/会话/MCP工具），chip 插入，提交时解析为 attachments/context
- **Slash Commands**：`/help /new /clear /compact /model /sandbox /approve /fork /export /mcp /theme`，上下箭头导航，本地命令直接执行
- **附件**：拖拽文件、粘贴图片、文件选择对话框、缩略图预览、移除
- **Mid-turn Steering**：运行中 Composer 可用，Append/Interrupt/Follow-up 模式切换
- **Approval 完善**：Allow Once/Deny Once/Always Allow/Always Deny、Y/N/A 快捷键、"Always" 持久化
- **会话管理完善**：Fork（消息旁按钮）、session tree 可视化、重命名、导出 Markdown/JSON、搜索
- **全局快捷键**：Cmd/Ctrl+Enter 发送、Escape 中断/关弹窗、Cmd/Ctrl+Shift+N 新会话、Cmd/Ctrl+F 搜索
- **右键菜单**：复制、fork from here、重新生成

**验收标准：**

- `@` 搜索文件选中后 chip 正确插入，agent 收到文件上下文
- `/model` 切换模型生效
- 运行中 append steering 消息正常处理
- Always Allow 后同类工具不再弹窗
- 拖拽文件到 Composer 添加附件正确

---

### Phase 5: Companion Personalization — 7 Mascots + Dreamy + 成长（1.5 周）

**目标：** 7 位伙伴的表情动画、等级成长、亲密度、语音台词、持久化。

**交付物：**

- **7 Mascot SVG 资源**：Foxy/Mochi/Byte/Nori/Pico/Bubu/Kumo，每只 8 mood 变体（idle/thinking/working/happy/oops/sleeping/celebrating/levelup），纯 CSS/SVG 动画（blink、float、tailGlow），无 Lottie
- **Mood 状态机**：idle↔thinking↔working→happy/oops→celebrating，idle→sleeping（5 分钟超时），any→levelup（bond 满），过渡动画
- **等级与亲密度**：9 等级（Lv.1-9）、4 段 ◆/◇ bond、成功交互+1 bond、4 段满升级+levelup 动画，electron-store 持久化
- **Voice Lines**：按 mood 和触发点（greeting/toolSuccess/toolFail/taskComplete/levelUp/approval/idle/error/interrupted）分类台词库，随机选取，speech bubble 3-5 秒自动消失，性格一致
- **Companion 面板**：当前 Mascot 大图、等级、bond、mood、近期台词、切换 Mascot（各 Mascot 独立保存进度）
- **Dreamy 主题完善**：Dreamy 下 Mascot 颜色/speech bubble 适配
- **Composer 前缀动态化**：`foxy» / mochi» / byte» / nori» / pico» / bubu» / kumo»`，Mascot 主题色
- **持久化**：选中 Mascot、各 Mascot level/bond/exp 跨重启恢复

**验收标准：**

- 7 Mascot 切换正确，形象/颜色正确
- Agent 运行时 mood 跟随状态正确转换
- 对话后 bond 增长，4 段满触发 levelup 动画和台词
- 重启后 Mascot 选择和等级/bond 恢复
- 台词正确触发不重复
- Dreamy 下所有 Mascot/UI 显示正常

---

### Phase 6: Platform Integration — Mac DMG + Windows NSIS + 原生体验（1 周）

**目标：** 平台打包、代码签名、自动更新、原生菜单、文件关联、Dock/Taskbar。

**交付物：**

- **electron-builder 配置**：Mac dmg+zip universal、Windows nsis、appId/productName、图标、asar、extraResources
- **Mac 签名与公证**：Developer ID 证书签名、hardened runtime、entitlements（JIT/unsigned-executable-memory/library-validation/network client+server）、electron-builder-notarize afterSign、staple
- **Windows 签名**：EV/OV 代码签名、NSIS 安装器（per-user 默认、可选 per-machine、桌面/开始菜单快捷方式、多语言、静默安装）
- **自动更新**：electron-updater + GitHub Releases、启动检查+手动检查、后台下载+安装重启、beta channel 支持
- **原生菜单**：App/File/Edit/View/Session/Help，Mac About/Preferences，快捷键绑定
- **Dock/Taskbar**：自定义图标、Dock 菜单/JumpList、badge（pending approvals）、approval 请求时 bounce/flash
- **深链接**：`focuscode://` 协议（open project、auth callback）
- **窗口状态持久化**：位置/大小/最大化、上次项目
- **文件关联**：`.focuscode-session` 双击导入

**验收标准：**

- Mac 生成签名+公证 DMG，Gatekeeper 无警告打开
- Windows 生成签名 NSIS 安装器，安装/卸载正常
- 自动更新检测→提示→下载→安装重启成功
- 原生菜单符合平台惯例
- Dock/Taskbar 图标正确，badge/JumpList 工作
- 窗口状态重启恢复

**打包产物：**

- Mac: `release/FocusCode-0.5.0-universal.dmg`、`release/FocusCode-0.5.0-mac.zip`
- Windows: `release/FocusCode Setup 0.5.0.exe`

---

### Phase 7: Sandbox & Security — 沙箱适配 + 安全加固（1 周）

**目标：** 跨平台沙箱适配、凭据安全存储、安全加固。

**交付物：**

- **跨平台沙箱检测**：
  - Mac：Docker Desktop → Seatbelt（原生 `sandbox-exec`）→ Host（需 allowHostFallback）
  - Windows：Docker Desktop（WSL2 backend）→ Windows Sandbox（增强项）→ Host（MVP 默认，带安全提示）
  - 检测结果在 StatusBar/Settings 显示，Docker 未安装时引导
  - Mac Seatbelt profile 打包到 resources
- **凭据安全存储**：keytar/safeStorage 存储到 Keychain/Credential Manager；实现 `ElectronCredentialStore` 替代 `FileCredentialStore`；OAuth PKCE flow 不依赖 client secret
- **渲染进程安全加固**：contextIsolation/nodeIntegration/sandbox/webSecurity 正确配置；严格 CSP（script-src 'self'）；preload 最小暴露；`shell.openExternal` URL 白名单（http/https 仅）；不加载远程 URL
- **Workspace Trust**：首次打开项目提示信任（信任后加载 Instructions/Skills/Extensions），类似 VS Code
- **MCP 安全**：stdio 在主进程、McpToolPin fail-closed、新增 server 需用户确认
- **企业模式**：强制非 Host 沙箱、扩展 allowlist、HMAC audit、审计日志导出
- **网络安全**：SSRF 防护（保留现有）、系统代理检测、自定义 CA 证书支持

**验收标准：**

- Mac 上 Seatbelt 正常工作（不装 Docker 也能安全执行）
- Windows 上 Host 模式+Docker 检测逻辑正确
- Token 存储在 Keychain/Credential Manager，不明文存文件
- DevTools 中无法访问 require/process/fs
- 注入 inline script 被 CSP 阻止
- Workspace trust 首次打开项目显示

---

## 6. Packaging Strategy

### 6.1 Mac 打包

```yaml
# electron-builder.yml
appId: "com.focuscode.app"
productName: "FocusCode"
copyright: "Copyright © 2026 FocusCode"

mac:
  category: "public.app-category.developer-tools"
  target:
    - target: "dmg"
      arch: ["universal"]
    - target: "zip"
      arch: ["universal"]
  icon: "resources/icon.icns"
  hardenedRuntime: true
  entitlements: "resources/entitlements.mac.plist"
  entitlementsInherit: "resources/entitlements.mac.inherit.plist"
  gatekeeperAssess: false
  darkModeSupport: true
  minimumSystemVersion: "11.0"

dmg:
  contents:
    - { x: 130, y: 220 }
    - { x: 410, y: 220, type: "link", path: "/Applications" }
  sign: true
  window: { width: 540, height: 380 }
```

**Entitlements 要点：**

- `com.apple.security.cs.allow-jit: true`（V8 JIT）
- `com.apple.security.cs.allow-unsigned-executable-memory: true`
- `com.apple.security.cs.disable-library-validation: true`（native 模块）
- `com.apple.security.network.client/server: true`（API + OAuth 回调）

**CI 环境变量（secrets）：**

- `CSC_LINK`（base64 p12）、`CSC_KEY_PASSWORD`
- `APPLE_ID`、`APPLE_ID_PASSWORD`（app-specific）、`APPLE_TEAM_ID`

### 6.2 Windows 打包

```yaml
win:
  target:
    - target: "nsis"
      arch: ["x64"]
  icon: "resources/icon.ico"
  signingHashAlgorithms: ["sha256"]

nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true
  allowElevation: true
  installerLanguages: ["en-US", "zh-CN", "zh-TW", "ja-JP"]
  language: "2052"
  shortcuts:
    - { name: "FocusCode", description: "FocusCode Desktop" }
  uninstallDisplayName: "FocusCode"
  deleteAppDataOnUninstall: false
```

- EV 代码签名证书最佳（避免 SmartScreen 警告），OV 证书需声誉积累
- 默认 per-user 安装（`%LOCALAPPDATA%\Programs\focuscode`），免管理员权限
- 支持静默安装 `/S`（企业部署）

### 6.3 自动更新

```yaml
publish:
  provider: "github"
  owner: "focuscode-dev"
  repo: "focuscode"
  private: false
```

- 启动检查更新，设置面板手动检查按钮
- `autoDownload: false`（用户确认后下载）
- 下载完成提示安装重启
- 支持 prerelease beta channel

### 6.4 CI/CD 构建矩阵

新增 `.github/workflows/desktop-release.yml`，触发条件：`push: tags: [v*]` + workflow_dispatch。

Jobs：

- `build-mac`（macos-latest）：checkout → setup-node 22.20.0 → corepack pnpm → install → pnpm build → pnpm desktop:build → pnpm desktop:package:mac（带签名/公证 secrets）→ upload-artifact dmg+zip
- `build-windows`（windows-latest）：同上 → pnpm desktop:package:win（带签名 secrets）→ upload-artifact exe

---

## 7. Risk Register

| #   | 风险                                | 影响                     | 概率 | 缓解                                                                                                 |
| --- | ----------------------------------- | ------------------------ | ---- | ---------------------------------------------------------------------------------------------------- |
| R1  | Electron 包体积大（~150MB）         | 下载/磁盘                | 高   | 开发工具可接受；electron-builder 排除不必要 locales；未来可评估 Tauri                                |
| R2  | Windows 无 gVisor/Seatbelt 原生沙箱 | Win 安全降级             | 高   | MVP Host 模式+安全提示+路径白名单；Phase 7 研究 Windows Sandbox；企业模式强制 Docker                 |
| R3  | 代码签名证书成本/流程               | 发布阻塞/Gatekeeper 警告 | 中   | 提前申请 Apple ID ($99/年) + EV 证书（$200-400/年）；开发阶段无签名内部测试                          |
| R4  | Monaco worker 加载问题              | 编辑器不工作             | 中   | vite-plugin-monaco-editor 打包 workers 为本地 assets；CI 加 worker 加载测试                          |
| R5  | 高频 text_delta 致 UI 卡顿          | 输入延迟/掉帧            | 中   | main 微批处理（16ms rAF 节奏）；renderer 虚拟滚动；ref 累积文本+间隔 setState                        |
| R6  | keytar/native 模块 ABI 不兼容       | 运行时崩溃               | 中   | electron-rebuild；锁定 electron 版本；CI 验证打包后可启动                                            |
| R7  | Agent 崩溃拖垮主进程                | 崩溃/数据丢失            | 低   | try/catch 包裹 agent；实时持久化（现有 SessionStore）；未来考虑 utility process 隔离                 |
| R8  | 架构边界被破坏                      | 可维护性下降             | 中   | check-boundaries.mjs 增加 electron/ipc 禁则；renderer 禁 import `@focuscode/*`；code review 重点检查 |
| R9  | Tailwind v4 与 CSP 冲突             | 样式不加载               | 中   | Tailwind v4 build 时生成静态 CSS；CSP 允许 `style-src 'self' 'unsafe-inline'`                        |
| R10 | OAuth 本地回调端口冲突/防火墙阻止   | 登录失败                 | 中   | 随机端口；custom protocol `focuscode://auth/callback` 备选；主进程启动 localhost HTTP 服务器         |
| R11 | MCP stdio 打包后 PATH 受限          | MCP 工具不加载           | 中   | MCP 命令用绝对路径；main 进程补充 PATH（Mac Finder 启动 PATH 不含 brew）                             |
| R12 | 多窗口复杂度                        | 架构复杂                 | 低   | MVP 单窗口单项目；AgentInstanceManager 支持多实例但 UI 单实例                                        |

---

## 8. Timeline & Milestones

| 阶段              | 交付                  | 里程碑                                   |
| ----------------- | --------------------- | ---------------------------------------- |
| Phase 0（1 周）   | 项目脚手架            | 应用启动空窗口，CI 绿色                  |
| Phase 1（1.5 周） | UI 骨架+主题+Mascot   | 5 面板静态布局完整，主题切换             |
| Phase 2（2 周）   | Agent 桥接+Transcript | 用确定性 demo 完成真实对话               |
| Phase 3（1.5 周） | Work Panels           | Diff/Code/Spec/Audit 展示真实数据        |
| Phase 4（1.5 周） | Composer 富交互       | @mentions/slash/steering/approval 全功能 |
| Phase 5（1.5 周） | Mascot 个性化         | 7 Mascots + mood/level/bond/voice lines  |
| Phase 6（1 周）   | 平台打包              | Mac DMG + Win NSIS，自动更新             |
| Phase 7（1 周）   | 安全沙箱              | 跨平台沙箱+凭据安全+加固                 |

**总计约 10-11 周**（并行开发 UI 和主进程桥接可压缩至 8-9 周）。

**关键里程碑：**

- **M1（Skeleton）**：Phase 0+1，UI 完整无真实对话
- **M2（Alpha）**：Phase 2，能与 agent 真实对话
- **M3（Beta）**：Phase 3+4，功能完整
- **M4（RC）**：Phase 5，个性化体验完整
- **M5（Release）**：Phase 6+7，可公开发布的安装包

---

## 9. Testing Strategy

### 9.1 单元测试（Vitest + jsdom）

- **主进程逻辑**：event-parser、companion-logic（mood 状态机/level/bond 计算）、sandbox-detector（mock child_process）、ipc-handlers 参数验证
- **React 组件**（@testing-library/react）：MascotAvatar、Transcript、Composer、SpecPipeline、ApprovalDialog、StatusBar
- **Zustand stores**：状态转换逻辑
- 覆盖率目标：关键逻辑 100%，组件/逻辑层 statements 70%+

### 9.2 E2E 测试（Playwright for Electron）

- **app-launch**：启动、5 面板渲染、默认 mascot/主题
- **theme-switching**：Dreamy 切换 CSS 变量
- **agent-conversation**（确定性 SSE Provider）：发消息→流式回复→工具卡片→结束
- **settings**：设置修改持久化
- **mascot-selection**：切换 Mochi 后前缀/颜色变化
- **session-management**：新建/fork/切换
- **diff-viewer**：文件修改后 Diff tab 显示变更
- 使用 headless 模式（CI Linux xvfb）；关键路径覆盖，不过度测 UI 细节

### 9.3 打包验证

- 干净 Mac/Windows VM 安装启动
- Mac `spctl -a -v /Applications/FocusCode.app` 验证公证
- 自动更新本地测试（预发布 tag）
- 沙箱在目标平台正确降级/启用

### 9.4 CI 集成

- PR：lint + typecheck + unit tests
- Main branch：加 build + E2E（Linux headless）
- Release tag：完整打包 Mac+Win，签名，发布 GitHub Releases

---

## 10. Open Questions

1. **应用名称与 App ID**：继续 "FocusCode" / `com.focuscode.app`？
2. **自定义标题栏**：Phase 1 先用原生标题栏（frame: true），Phase 6 再自定义？还是一开始就自定义？（建议先用原生降低复杂度）
3. **编辑器选型**：Monaco（~3MB，生态好）vs CodeMirror 6（轻量，配置复杂）？（建议 Monaco）
4. **状态管理**：Zustand vs Jotai vs Redux Toolkit？（建议 Zustand）
5. **Mac App Store**：是否上架 MAS？MAS 要求 App Sandbox 限制 child_process/网络，架构改动大。（建议先 DMG 直接下载）
6. **Windows 版本**：Electron 33+ 仅支持 Win10+，是否需要 Win7/8？（建议 Win10 21H2+）
7. **Linux 支持**：MVP 是否包含 AppImage/deb？（建议 MVP Mac+Win，Linux 后续）
8. **Telemetry**：是否集成 Sentry 崩溃上报？（建议 opt-in）
9. **Mascot 美术**：7 伙伴精细 SVG 由设计师提供还是 Phase 5 先用 CSS 占位？（建议 CSS 占位后续替换）
10. **Electron Node 版本**：Electron 33 内置 Node 22.x，需确认满足 `>=22.12.0`
11. **多窗口**：MVP 是否支持多项目窗口？（建议单窗口）
12. **终端面板**：Work Panel 是否需要集成终端（node-pty + xterm.js）？（建议 MVP 不做，后续添加）
13. **代码编辑写入**：Code 面板是否支持编辑写入磁盘？（建议 MVP 只读+通过 agent 写入）
14. **配置存储**：设置/mascot 状态用 electron-store（userData 目录）还是复用 `.focuscode/config.json`？（建议 electron-store，CLI 配置可迁移）

---

## 附录 A：关键参考文件

- SDK 入口：`packages/sdk/src/coding-agent.ts` — `createCodingAgent()`
- SDK 流式 API：`packages/sdk/src/run-coding-agent.ts` — AsyncGenerator
- SDK Hooks：`packages/sdk/src/hooks.ts` — AgentHooks 接口
- AgentEvent 类型：`packages/agent-runtime/src/types.ts`
- 架构边界检查：`scripts/check-boundaries.mjs`
- 沙箱工厂：`packages/sandbox/src/factory.ts`
- CLI 组合根参考：`apps/cli/src/index.ts`
- 设计 tokens：`focuscode-mascots.design/colors_and_type.css`
- CI 配置：`.github/workflows/ci.yml`
- TypeScript 基础：`tsconfig.base.json`
