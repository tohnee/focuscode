import { describe, expect, it } from "vitest";
import { renderTui, type TuiRenderState } from "../src/renderer.js";
import { TUI_THEMES } from "../src/themes.js";
import { TUI_MASCOTS } from "../src/mascots.js";
import { createInitialLayout } from "../src/layout.js";
import { stripAnsi } from "../src/width.js";

/** 渲染输出带主题色码；需要纯文本断言时先 stripAnsi。 */
function plain(state: TuiRenderState): string {
  return stripAnsi(renderTui(state));
}

function baseState(overrides: Partial<TuiRenderState> = {}): TuiRenderState {
  return {
    width: 100,
    height: 30,
    title: "FocusCode",
    model: "deepseek/deepseek-v4-flash",
    session: "s1",
    approval: "ask",
    sandbox: "seatbelt",
    busy: false,
    queued: 0,
    mood: "idle",
    tick: 0,
    theme: TUI_THEMES[0]!,
    mascot: TUI_MASCOTS[0]!,
    transcript: [],
    input: "",
    inputCursor: { row: 0, col: 0 },
    attachments: [],
    scrollOffset: 0,
    layout: { ...createInitialLayout(), mode: "minimal" as const },
    ...overrides,
  };
}

describe("renderMinimal (minimal layout)", () => {
  it("renders user messages with a > label and no borders", () => {
    const frame = plain(baseState({ transcript: [{ role: "user", text: "修复登录 bug" }] }));
    expect(frame).toContain("> 修复登录 bug");
    // 无边框：不出现 classic 的框线字符
    expect(frame).not.toContain("╭");
    expect(frame).not.toContain("╰");
    expect(frame).not.toContain("│");
  });

  it("renders assistant content and tool calls as compact lines", () => {
    const frame = plain(
      baseState({
        transcript: [
          { role: "assistant", text: "我来看一下。" },
          { role: "tool", text: '{"output":"grep 命中 3 处"}' },
        ],
      }),
    );
    expect(frame).toContain("我来看一下");
    // 工具输出折叠为单行紧凑摘要
    expect(frame).toContain("✓ ");
    expect(frame).toContain("grep 命中 3 处");
  });

  it("extracts error messages from tool JSON output", () => {
    const frame = plain(
      baseState({ transcript: [{ role: "tool", text: '{"error":"command not found: pnpm"}' }] }),
    );
    expect(frame).toContain("✗ command not found: pnpm");
    // 错误行不带重复的 ✓ 前缀
    expect(frame).not.toContain("✓ ✗");
  });

  it("falls back to raw truncated text for non-JSON tool output", () => {
    const long = "x".repeat(500);
    const frame = plain(baseState({ transcript: [{ role: "tool", text: long }] }));
    expect(frame).toContain("…");
    // 单行摘要：无换行注入，宽度受限
    expect(frame.split("\n").find((line) => line.includes("xxx"))?.length).toBeLessThan(100);
  });

  it("sanitizes terminal control sequences in messages and footer", () => {
    const hostile = "evil\u001b[2J\u001b]0;owned\u0007text";
    const frame = plain(
      baseState({ transcript: [{ role: "user", text: hostile }], model: hostile }),
    );
    expect(frame).not.toContain("\u001b[2J");
    expect(frame).not.toContain("\u001b]");
    expect(frame).not.toContain("\u0007");
    expect(frame).toContain("evil");
    expect(frame).toContain("text");
  });

  it("renders a compact footer without mascot/XP badges", () => {
    const frame = plain(baseState({ sessionCost: 0.0032 }));
    expect(frame).toContain("deepseek/deepseek-v4-flash");
    expect(frame).toContain("ask");
    expect(frame).toContain("seatbelt");
    expect(frame).toContain("$0.0032");
    expect(frame).not.toContain("Lv ");
    expect(frame).not.toContain("xp");
  });

  it("adapts to narrow terminals without forced classic fallback", () => {
    const frame = plain(
      baseState({
        width: 50,
        height: 12,
        transcript: [{ role: "user", text: "窄终端消息" }],
      }),
    );
    // minimal 布局在窄终端仍生效（无边框、消息可见）
    expect(frame).toContain("窄终端消息");
    expect(frame).not.toContain("╭");
  });

  it("renders the single-line input prompt", () => {
    const frame = plain(baseState({ input: "继续排查", inputCursor: { row: 0, col: 2 } }));
    expect(frame).toContain("> 继续排查");
  });
});
