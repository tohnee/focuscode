# 全屏 TUI、终端伙伴与多模态输入

## 1. TUI 状态机

`@focuscode/tui` 不依赖 Agent Runtime，是纯终端状态机。CLI adapter 只把 `AgentEvent` 映射为
transcript、mood、status、queue 和 approval。

Renderer 对相同尺寸 Frame 做逐行 diff，只重绘变化行；resize 或进入 alternate screen 时才完整
刷新。这减少长输出期间的闪烁和终端 I/O，但当前编辑器仍不是 Pi 级组件系统。

启动时进入 alternate screen、隐藏系统光标并启用 bracketed paste；退出、异常关闭和 `/exit`
都会恢复 raw mode、光标与主屏幕。界面包含：

- 当前模型、Session、审批与 Sandbox；
- 可滚动 transcript 和 Tool Result；
- 流式 assistant 输出；
- 可见输入光标、多行输入、历史和单词删除；
- 下一条消息的图片附件；
- busy/steering queue、审批请求和运行状态；
- 500 ms 动画 tick 的终端伙伴。

模型和 Tool 输出在渲染前移除终端控制字符，避免不可信文本注入 ANSI 清屏、改标题或伪造
界面。括号粘贴支持跨 stdin chunk，不会把粘贴中的换行误当作立即提交。

## 2. 主题与伙伴

主题：`aurora`、`candy`、`forest`、`midnight`、`mono`。

伙伴：

| id      | 名称  | 设定       | 性格                         |
| ------- | ----- | ---------- | ---------------------------- |
| `mochi` | Mochi | 云朵猫     | 喜欢把复杂任务揉成小团子     |
| `byte`  | Byte  | 像素小狐   | 找 bug 像追发光萤火虫        |
| `nori`  | Nori  | 薄荷六角龙 | 每次测试通过都会长一片小叶子 |
| `pico`  | Pico  | 布丁企鹅   | 滑过长日志并挑出最重要一行   |
| `bubu`  | Bubu  | 奶油小熊   | 擅长守住权限边界和未提交改动 |
| `kumo`  | Kumo  | 代码水豚   | 遇到 flaky test 也保持镇定   |

每只伙伴有 idle/thinking/working/happy/oops 多状态帧。它们只消费 UI 状态，不读取 Prompt、
Token 或文件内容，因此不会成为新的数据出口。

```bash
focuscode mascots
focuscode themes
focuscode --theme forest --mascot kumo
focuscode --theme .focuscode/team-theme.json --mascot .focuscode/team-mascot.json
```

自定义 JSON 会校验 ANSI 0–255 色值、单字符边框、ID、五种 mood、每种 1–8 帧、每帧最多 8 行
和 40 字符，并拒绝控制字符。可直接参考 `examples/tui/team-theme.json` 与
`examples/tui/team-mascot.json`。

运行中 `Ctrl+T` 轮换主题、`Ctrl+G` 轮换伙伴。

## 3. 快捷键

默认：

| 按键            | action                              |
| --------------- | ----------------------------------- |
| Enter           | `submit`                            |
| Ctrl+O          | `newline`                           |
| Ctrl+C          | `abort`                             |
| Ctrl+D          | `exit`（busy 时先 abort）           |
| Ctrl+L          | `clear`                             |
| Ctrl+W          | `delete_word`                       |
| Left/Right      | `cursor_left` / `cursor_right`      |
| Up/Down         | `history_previous` / `history_next` |
| PageUp/PageDown | `scroll_up` / `scroll_down`         |
| Ctrl+T          | `cycle_theme`                       |
| Ctrl+G          | `cycle_mascot`                      |

项目配置或独立 JSON 文件均可覆盖。给某个 action 绑定新 key 时会移除旧绑定，避免同一 action
意外有多个快捷键。无效 key/action 在启动前报错。

```json
{
  "ctrl+x": "abort",
  "ctrl+j": "newline",
  "ctrl+g": "cycle_mascot"
}
```

```bash
focuscode --keymap ./focuscode-keymap.json
```

## 4. 图片输入

支持：PNG、JPEG、WebP、GIF；每张本地图片默认最大 20 MB，每条消息最多 10 张、总计 40 MB。

```bash
focuscode -i screenshot.png -i diagram.webp "比较实现与设计图"
focuscode -i https://static.example.com/reference.png "解释错误位置"
```

TUI：

```text
/image ./screenshot.png
/images
/image clear
```

本地图片使用 magic bytes 判断 MIME，不信任文件扩展名；持久化 SHA-256。RPC 传入的 base64
会校验 base64 语法、声明大小、magic bytes、MIME 和可选摘要。HTTPS URL 禁止嵌入用户名和
密码。Session 读取时再次校验附件，外部修改的畸形附件不会进入模型请求。

不同 Provider 的映射由 adapter 负责；模型是否真正支持某种图片格式、分辨率和数量仍取决于
其具体版本。发送前还会检查当前 `ModelProfile.capabilities.input`，不会把图像静默发给纯文本
模型。

## 5. 图片隐私

- base64 图片会以明文存入本地 Session JSONL；敏感图片使用 `--no-session`；
- URL 图片可能由模型 Provider 远程获取，URL 本身会发送给 Provider；
- 企业模式默认 `media.allowRemoteImages=false`，只允许 workspace 内本地图片；
- HTML 导出允许 data/HTTPS 图片、禁止脚本并设置 no-referrer；打开远程图片仍会产生网络访问；
- Session Share 默认移除图片，只有 `--include-images` 才保留；
- Tool 子进程不会获得图片数据，除非用户明确把图片文件路径交给 Bash。

## 6. Steering UX

TUI busy 时提交普通文字：排入 append queue。界面显示接受收据与 queue size；当前模型/Tool
安全边界结束后，文字作为新的 user message 按 FIFO 合入。

```text
/interrupt 不要改 API，改为只修测试
```

`/interrupt` 取消当前 Provider generation，但不撤销已经完成的 Tool effect，也不创建第二个
并发 Agent。`Ctrl+C` 是完整 turn abort，语义不同。

```text
/followup 当前修改完成后，再补一份迁移说明
```

follow-up 不打断当前 generation/Tool loop，只在模型给出 final response 后作为下一条 user
message 进入同一 Session。

RPC 示例：

```json
{"jsonrpc":"2.0","id":1,"method":"prompt","params":{"text":"重构模块"}}
{"jsonrpc":"2.0","id":2,"method":"steer","params":{"text":"保留兼容 API","mode":"interrupt"}}
{"jsonrpc":"2.0","id":3,"method":"steer","params":{"text":"最后补文档","mode":"follow-up"}}
```

SDK：

```ts
const running = agent.submit("重构模块");
await agent.steer("保留兼容 API", "interrupt");
await running;
```
