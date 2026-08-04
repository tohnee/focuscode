# FocusCode 前端设计 & TUI & 个性化深度评审报告

**日期**: 2026-08-02
**评审范围**: `focuscode-mascots.design/` 设计原型、`packages/tui/` TUI 包全部模块、个性化系统（mascots/skins/themes/companion）
**构建状态**: ✅ 通过 (`pnpm --filter @focuscode/tui build`)
**测试状态**: ✅ 30 个测试文件 / 723 个用例全部通过

---

## 1. 总览

本次评审覆盖 FocusCode 前端设计资产与 TUI 个性化系统，涉及三大板块：

| 板块                                        | 核心文件数        | 新增代码量  | 测试覆盖               |
| ------------------------------------------- | ----------------- | ----------- | ---------------------- |
| 设计原型 (focuscode-mascots.design)         | 6 个页面 + tokens | CSS ~300 行 | 设计验证通过           |
| TUI 核心 (renderer/layout/app)              | 3 个核心模块      | ~1000 行    | 快照 + 行为测试        |
| 个性化系统 (mascots/skins/themes/companion) | 4 个模块          | ~800 行     | 单元测试 + schema 验证 |

**整体评价**: 代码质量高，架构分层清晰，安全护栏完备，测试覆盖率充分。以下按模块逐项评审。

---

## 2. 设计原型评审 (focuscode-mascots.design/)

### 2.1 设计令牌系统 (`colors_and_type.css`)

**优点**:

- 令牌分层清晰：品牌色 → Dreamy 主题色 → 语义色 → 吉祥物个性色 → 情绪状态色，层层递进
- 支持双主题切换（默认 Foxglow + Dreamy 星眠），通过 `html[data-theme="dreamy"]` 切换
- 吉祥物个性色体系完整：7 个吉祥物各有主色 + 柔和色，共 14 个 CSS 变量
- 语义别名完备：`--focuscode-*` 系列与设计系统 head contract 对齐

**发现问题**:

| 等级  | 问题                                                                       | 位置                         | 建议                                             |
| ----- | -------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------ |
| 🟡 中 | `--brand-500` 与 `--brand` 值相同但定义了两次，存在冗余                    | `colors_and_type.css` L6/L12 | 保留一个作为主定义，另一个用 `var(--brand)` 引用 |
| 🟡 中 | Rosé Pine 主题中 `success` 和 `secondary` 都使用 `#31748f`，语义区分度不足 | `themes.ts` L198-L199        | 建议将 success 调整为偏绿的色调，保持语义一致性  |
| 🟢 低 | `.mascot-art` 硬编码 `font-size: 13px`，响应式适配可能不够                 | `colors_and_type.css` L192   | 可考虑用 `clamp()` 或相对单位                    |

### 2.2 设计页面

**优点**:

- 5 个页面覆盖完整：app.html（主界面）、app-personalized.html（个性化）、architecture.html（架构）、mascots.html（吉祥物详情）、mascots-gallery.html（吉祥物画廊）
- 视觉风格统一，Dreamy 主题与 Foxglow 主题切换演示清晰
- `.design` 文件结构完整，验证报告 (`validation-report.json`) 通过

---

## 3. TUI 核心模块评审

### 3.1 布局引擎 (`layout.ts`)

**架构评价**: 纯函数模块，不持有运行时状态，符合架构边界约束。

**核心设计**:

- 6 种布局模式：`workbench` / `classic` / `split` / `focus` / `wide` / `minimal`
- 逐级降级策略：workbench 在宽度 < 140 隐藏预览栏，< 100 进一步隐藏导航栏
- split/wide 在窄屏（< 100 列或 < 20 行）自动回退 classic
- Pane 配置支持 `side`、`minSize`、`width/height` 比例

**发现问题**:

| 等级  | 问题                                                                                                                                                               | 位置                           | 建议                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ | ----------------------------------------------------- |
| 🟢 低 | `createInitialLayout()` 中 panes 定义了 `nav` 和 `preview` 吗？没有——workbench 模式的 nav/preview 是硬编码在 `computeWorkbenchLayout` 中的，与 pane 配置体系不一致 | `layout.ts` L70-83 vs L149-164 | 考虑将 nav/preview 也纳入 PaneConfig 体系，保持一致性 |
| 🟢 低 | `WORKBENCH_NAV_WIDTH = 32` 和 `WORKBENCH_PREVIEW_WIDTH = 38` 是硬编码常量，用户无法调整                                                                            | `layout.ts` L140-141           | 未来可考虑作为配置项暴露                              |
| ✅ 优 | 降级逻辑完善，任何尺寸下都有可用回退                                                                                                                               | —                              | 保持                                                  |

### 3.2 渲染器 (`renderer.ts`)

**架构评价**: 经典单窗格渲染器，向后兼容良好。新布局通过分派到 `renderWorkbench` / `renderMinimal` 实现扩展。

**核心设计**:

- `renderTui()` 作为统一入口，根据 `state.layout` 分派到不同渲染器
- Overlay（picker/palette/spec-history）始终使用 classic 渲染，因为它们占满全屏
- Toast 通知覆盖层独立于布局模式

**发现问题**:

| 等级  | 问题                                                                                                                          | 位置                   | 建议                                                                                    |
| ----- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------- |
| 🟡 中 | `renderClassicFrame` 函数体过长（~200 行），职责过多（header/body/footer/spec/reasoning/search 全在一个函数里）               | `renderer.ts` L191-356 | 建议拆分为 `renderClassicHeader` / `renderClassicBody` / `renderClassicFooter` 等子函数 |
| 🟢 低 | `glyph` 变量只检查 `"foxy"`，其他吉祥物统一显示 emoji 前缀在 workbench 模式用 `🐾`，但 classic 模式的 glyph 只有 foxy 有 `🦊` | `renderer.ts` L200     | 建议与 workbench 保持一致，非 foxy 吉祥物也显示对应 emoji 或统一使用 `🐾`               |
| ✅ 优 | 所有模型派生文本（status/reasoning/speech 等）都经过 `sanitizeTerminalText`                                                   | —                      | 安全意识强                                                                              |

### 3.3 Workbench 渲染器 (`renderer-workbench.ts`)

**架构评价**: 三栏工作台（yazi × tmux 风格），信息密度高，结构清晰。

**核心设计**:

- 左导航栏：Todo 列表 + Session 信息 + Partner 区块
- 中对话流：消息 + 工具紧凑行，assistant 消息带吉祥物前缀
- 右预览栏：进度条 + 最近工具输出 + 上下文用量 + 成本 + 输入实时预览
- 底部：输入行 + tmux 风格状态栏

**发现问题**:

| 等级  | 问题                                                                                                                   | 位置                              | 建议                                                                    |
| ----- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------- |
| 🟡 中 | `renderNavPanel` 的 Todo 项高度计算 `Math.max(2, height - 12)` 是硬编码的，当 Partner 区块内容变化时可能溢出或留白过多 | `renderer-workbench.ts` L90       | 建议改为动态计算各区块高度占比，或使用 flex 式分配                      |
| 🟡 中 | 输入行 `MAX_WORKBENCH_INPUT_ROWS = 4` 是硬编码在函数内部的常量                                                         | `renderer-workbench.ts` L292      | 建议提升为模块级常量，与 `renderer.ts` 的 `MAX_INPUT_ROWS = 5` 统一管理 |
| 🟢 低 | `wrapPreview` 使用 `logical.slice(offset, offset + width)` 按字节截断，不考虑 CJK 字符宽度                             | `renderer-workbench.ts` L278-L281 | 建议使用 `takeWidth` 确保显示宽度正确                                   |
| 🟢 低 | 状态栏右侧 `rightText` 可能在窄屏下被截断，但左侧面板段始终完整显示                                                    | `renderer-workbench.ts` L377-L383 | 窄屏时可考虑优先保证系统信息可见                                        |
| ✅ 优 | 所有用户/模型派生内容都经过 sanitize                                                                                   | —                                 | 安全护栏完善                                                            |
| ✅ 优 | 行宽不溢出测试覆盖充分                                                                                                 | —                                 | 质量保障到位                                                            |

### 3.4 Minimal 渲染器 (`renderer-minimal.ts`)

**架构评价**: Codex/Zed 风格的极简流式界面，去除一切装饰。

**核心设计**:

- 无边框、无吉祥物、无侧栏
- 消息流 + 单行输入 + 一行状态 footer
- 工具输出折叠为单行紧凑摘要（解析 JSON 提取 message/error 字段）

**发现问题**:

| 等级  | 问题                                                                                                           | 位置                           | 建议                                |
| ----- | -------------------------------------------------------------------------------------------------------------- | ------------------------------ | ----------------------------------- |
| 🟢 低 | `wrapMinimal` 使用 `charWidth(char.codePointAt(0)!)` 逐个字符计算，对于长文本性能略逊于 `stringWidth` 批量计算 | `renderer-minimal.ts` L194-203 | 可考虑优化为批量计算，但影响极小    |
| 🟢 低 | `toolSummary` 只提取 `message`/`error`/`output` 字段，对于结构化更强的工具输出（如数组）展示不够友好           | `renderer-minimal.ts` L121-131 | 可考虑增加对数组/嵌套对象的摘要逻辑 |
| ✅ 优 | 极简模式下仍保留完整的安全 sanitize                                                                            | —                              | 安全意识强                          |

---

## 4. 个性化系统评审

### 4.1 吉祥物系统 (`mascots.ts`)

**架构评价**: 7 个内置吉祥物，8 种情绪状态，ASCII art 动画帧。设计精巧。

**核心设计**:

- `MascotMood`: 8 种情绪 — idle/thinking/working/happy/oops/sleeping/celebrating/levelup
- 每只吉祥物有独立的 id/name/species/catchphrase（品牌个性）
- `MASCOT_FRAME_LIMITS` 约束：每情绪最多 8 帧、每帧最多 10 行、每行最多 40 码点
- `validateTuiMascot()` 严格校验：控制字符过滤、id 格式、帧尺寸限制
- 缺省 mood 自动回退到 idle 帧

**发现问题**:

| 等级  | 问题                                                                                 | 位置                  | 建议                                                             |
| ----- | ------------------------------------------------------------------------------------ | --------------------- | ---------------------------------------------------------------- |
| 🟡 中 | `validateTuiMascot` 对 `name`/`species`/`catchphrase` 的长度没有限制，理论上可以很长 | `mascots.ts` L181-189 | 建议增加合理的长度上限（如 name ≤ 32, catchphrase ≤ 100）        |
| 🟢 低 | `getMascotFrames` 的回退链只有一层（mood → idle），如果 idle 也缺失返回空数组        | `mascots.ts` L229-231 | 虽然 validate 保证了 idle 必须存在，但运行时防御可以再加一层保底 |
| ✅ 优 | 控制字符过滤严格（`\u0000-\u001f\u007f\u001b`）                                      | —                     | 终端注入防护到位                                                 |
| ✅ 优 | `structuredClone` 确保验证后的数据与输入隔离                                         | —                     | 防御性编程好                                                     |

### 4.2 皮肤包系统 (`skins.ts`)

**架构评价**: 可分享的皮肤包，包含主题色 + 自定义吉祥物 + 像素风格开关。Schema 校验严格。

**核心设计**:

- `SkinPack` schema: schemaVersion + id + name + author + homepage + theme(partial) + mascot + pixel
- 安全约束：200KB 大小上限、8 层嵌套深度、未知字段拒绝
- 4 个内置皮肤：Sakura 樱花 / Ocean 海蓝 / Arcade 街机 / Matcha 抹茶
- `skinToTheme()` 以 Fox Glow 为基底合并皮肤主题
- `parseSkinPack()` 解析 JSON 时报告行号列号，用户体验好

**发现问题**:

| 等级  | 问题                                                                                                                               | 位置                | 建议                                                                |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------- |
| 🟡 中 | `assertDepthAndSize` 先 `JSON.stringify` 再判断长度，对于接近 200KB 的输入会有额外的序列化开销                                     | `skins.ts` L51-53   | 可考虑先检查 `jsonText.length`（在 parse 阶段），但当前实现简单直接 |
| 🟢 低 | `BUILTIN_SKINS` 中的皮肤全部带 `pixel: true`，但非像素皮肤的 mascot 应该使用文本艺术帧而非像素帧——目前像素帧和文本帧是两套独立系统 | `skins.ts` L163-276 | 文档中应明确 pixel 标志的作用范围和渲染差异                         |
| ✅ 优 | 未知字段直接抛错（fail-closed），不静默忽略                                                                                        | —                   | 安全设计好                                                          |
| ✅ 优 | homepage 强制 `https://` 协议                                                                                                      | —                   | 供应链安全意识强                                                    |
| ✅ 优 | 内置皮肤在模块加载时通过 validate 自校验                                                                                           | —                   | 自测试意识好                                                        |

### 4.3 主题系统 (`themes.ts`)

**架构评价**: 13 个内置主题（7 个 256 色 + 6 个真彩色），支持三种颜色值表示方式，自动降级机制完善。

**核心设计**:

- `ColorValue` 联合类型：number (0-255) | `#rrggbb` | `[r,g,b]` 元组
- 真彩色检测：`COLORTERM` + `TERM` 环境变量
- 自动降级：hex/RGB → 最近 256 色调色板项
- `setColorMode()` / `initColorModeFromEnv()` 支持 `FOCUSCODE_COLOR_MODE` 环境变量
- 13 个主题：Fox Fire / Fox Glow / Aurora / Candy Pop / Tiny Forest / Midnight Byte / Paper Terminal / Aurora Glow TC / Crimson Tide TC / Tokyo Night / Catppuccin Mocha / Rosé Pine / Gruvbox Material

**发现问题**:

| 等级  | 问题                                                                                                 | 位置                     | 建议                                                                                     |
| ----- | ---------------------------------------------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------- |
| 🟡 中 | `validateTuiTheme` 中 `border` 只检查了码点数为 1，但未检查是否为控制字符或可打印字符                | `themes.ts` L255         | 应增加控制字符过滤，与 mascot/skin 的校验保持一致                                        |
| 🟡 中 | Rosé Pine 主题的 `success` 和 `secondary` 颜色相同（`#31748f`），语义上成功色应该是绿色系            | `themes.ts` L198-L199    | 建议调整 success 为偏绿色，如 `#9ccfd8` 或 `#3e8fb0`                                     |
| 🟢 低 | `colorMode` 默认值是 `"truecolor"`，但根据 `initColorModeFromEnv` 的注释，默认行为应该是检测终端能力 | `themes.ts` L305 vs L352 | 建议默认设为 `"auto"`，与文档描述一致；或在 app.ts 启动时统一调用 `initColorModeFromEnv` |
| ✅ 优 | `ansi256ToRgb` ↔ `rgbToAnsi256` 对称，roundtrip 精确                                                 | —                        | 算法质量高                                                                               |
| ✅ 优 | `dim()` 函数始终走真彩色路径再降级，确保 256 色主题也能获得一致的 dimming 效果                       | —                        | 细节考虑周到                                                                             |

### 4.4 伙伴成长系统 (`companion.ts`)

**架构评价**: XP/等级/情绪映射，纯函数实现，数据可序列化。

**核心设计**:

- 9 个等级：幼尾小福 → 学徒狐 → 机灵狐 → 猎码狐 → 灵尾狐 → 幻尾狐 → 玄尾狐 → 天尾狐 → 九尾天福
- XP 阈值曲线：0 → 50 → 150 → 300 → 500 → 800 → 1200 → 1800 → 2500（递增合理）
- 每次 turn +10 XP，每次工具成功 +2 XP
- `CompanionEvent` → `MascotMood` 映射表
- `parseCompanion()` 容错解析，坏数据回退到初始状态

**发现问题**:

| 等级  | 问题                                                                                           | 位置                  | 建议                       |
| ----- | ---------------------------------------------------------------------------------------------- | --------------------- | -------------------------- |
| 🟢 低 | `levelForXp` 使用线性扫描（for 循环），虽然只有 9 级无所谓，但如果未来等级增多可改用二分查找   | `companion.ts` L49-55 | 保持现状即可               |
| 🟢 低 | `suggestMood` 的参数 `_state` 未使用（下划线前缀标记），但未来可能需要根据等级/XP 调整情绪表现 | `companion.ts` L130   | 可在注释中说明预留设计意图 |
| ✅ 优 | XP 计算使用 `Math.max(0, Math.floor(...))` 防止负值/非整数                                     | —                     | 输入防御好                 |
| ✅ 优 | 序列化/反序列化完整，版本号校验                                                                | —                     | 数据兼容性好               |

---

## 5. 安全评审：终端注入防护

### 5.1 防护机制总览

终端注入是 TUI 系统的核心安全风险。本次评审确认以下防护机制完备：

| 防护层级   | 实现位置                                                            | 覆盖范围              |
| ---------- | ------------------------------------------------------------------- | --------------------- |
| 基础过滤   | `sanitizeTerminalText()` (width.ts)                                 | 移除 CSI/OSC/bare ESC |
| 输入验证   | `validateTuiMascot()` / `validateSkinPack()` / `validateTuiTheme()` | 控制字符正则过滤      |
| 渲染层防御 | 所有 renderer 中的用户/模型派生文本                                 | 统一走 sanitize       |
| 测试保障   | `terminal-injection.test.ts`                                        | 5 个场景全覆盖        |

### 5.2 安全测试覆盖

`terminal-injection.test.ts` 覆盖了 5 个关键注入路径：

1. ✅ SpecEngine 进度文本
2. ✅ Spec 确认决策/选项字符串
3. ✅ Todo 面板内容（SpecEngine 注入）
4. ✅ Diff 渲染的文件内容
5. ✅ `sanitizeTerminalText` 基础函数

**新增渲染器的安全测试**:

- ✅ `renderer-minimal.test.ts` — 包含 `sanitizes terminal control sequences in messages and footer`
- ✅ `renderer-workbench.test.ts` — 包含两个安全测试：消息/todo 注入 + 模型/会话/工具输出注入

### 5.3 安全建议

| 等级  | 建议                                                                              | 原因                                                                           |
| ----- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 🟡 中 | 在 `validateTuiTheme` 的 `border` 字段校验中增加控制字符过滤                      | 目前只检查了长度为 1，但 `\u001b` 也是一个码点，理论上可以被注入为 border 字符 |
| 🟢 低 | 考虑在 `width.ts` 中增加 `sanitizeTerminalText` 的模糊测试（property-based test） | 确保各种 Unicode 组合下都不会漏过控制序列                                      |

---

## 6. 测试质量评审

### 6.1 测试统计

- **测试文件**: 30 个
- **测试用例**: 723 个（全部通过 ✅）
- **覆盖模块**: themes / mascots / skins / companion / layout / renderer / renderer-minimal / renderer-workbench / spec-progress / todo-panel / search / command-palette / vim / context-bar / diff / markdown / width / keymap / editor / app / index / terminal-injection / truecolor-detection / layout-snapshot / renderer-snapshot / app 等

### 6.2 测试质量评价

| 维度     | 评价    | 说明                               |
| -------- | ------- | ---------------------------------- |
| 单元测试 | ✅ 优秀 | 每个模块都有对应的测试文件         |
| 快照测试 | ✅ 良好 | layout / renderer 都有快照测试     |
| 安全测试 | ✅ 优秀 | 终端注入专项测试覆盖完整           |
| 边界测试 | ✅ 良好 | 窄屏降级、空输入、错误数据都有覆盖 |
| 集成测试 | 🟡 一般 | app.ts 的集成测试相对较少          |

---

## 7. 架构边界合规性检查

根据 `AGENTS.md` 中的架构边界规则：

> `tui`：叶子 adapter，不得依赖任何 `@focuscode/*`

| 检查项                       | 结果    | 说明                                                          |
| ---------------------------- | ------- | ------------------------------------------------------------- |
| 不依赖其他 `@focuscode/*` 包 | ✅ 合规 | `packages/tui/package.json` 中无内部包依赖                    |
| 不依赖 `harness-core`        | ✅ 合规 | 纯 TUI 渲染/状态管理                                          |
| 不依赖 `model-gateway`       | ✅ 合规 | —                                                             |
| 不依赖 `agent-runtime`       | ✅ 合规 | —                                                             |
| 纯函数 + 副作用隔离          | ✅ 良好 | 渲染器/布局/主题/吉祥物都是纯函数；只有 `app.ts` 管理终端 I/O |

---

## 8. 改进建议汇总

### 高优先级 (🔴)

本次评审未发现高优先级问题。

### 中优先级 (🟡)

1. **`validateTuiTheme` 的 border 字段缺少控制字符过滤** — 安全一致性问题
2. **Rosé Pine 主题 success 与 secondary 颜色相同** — 语义混淆
3. **`renderClassicFrame` 函数体过长（~200 行）** — 可维护性
4. **Workbench nav panel 高度计算硬编码** — 布局灵活性
5. **`validateTuiMascot` 缺少名称/口号长度限制** — 输入防御
6. **`colorMode` 默认值与文档不一致** — 默认是 `truecolor` 而非 `auto`

### 低优先级 (🟢)

1. `--brand` 与 `--brand-500` 冗余定义
2. `wrapPreview` 未使用 `takeWidth` 处理 CJK
3. `.mascot-art` 硬编码 13px 字号
4. Workbench 状态栏窄屏优先级问题
5. 吉祥物 id 回退链的双层防御
6. `toolSummary` 对数组/嵌套对象的摘要不够友好

---

## 9. 结论

**整体评级：优秀（A-）**

FocusCode TUI 与个性化系统展现了很高的工程质量：

- **架构清晰**：纯函数渲染、布局引擎与渲染分离、叶子 adapter 合规
- **安全到位**：终端注入防护层层设防，测试覆盖完整
- **个性化系统完善**：吉祥物/皮肤/主题/成长系统形成完整闭环
- **测试充分**：723 个用例全通过，快照/安全/边界测试齐全
- **设计原型质量高**：令牌体系完整，多主题切换演示清晰

主要改进空间集中在代码组织（大函数拆分）、个别主题的语义色一致性、以及少量输入防御的细节完善。整体可直接进入下一阶段迭代。

---

_评审人：Trae Design · 2026-08-02_
