import { describe, expect, it } from "vitest";
import { renderTui, type TuiRenderState } from "../src/renderer.js";
import { TUI_THEMES } from "../src/themes.js";
import { TUI_MASCOTS } from "../src/mascots.js";
import { createInitialLayout } from "../src/layout.js";
import { createInitialTodoPanel, setTodoItems } from "../src/todo-panel.js";

function baseState(overrides: Partial<TuiRenderState> = {}): TuiRenderState {
  return {
    width: 120,
    height: 40,
    title: "FocusCode",
    model: "test/model",
    session: "s1",
    approval: "ask",
    sandbox: "host",
    busy: false,
    queued: 0,
    mood: "idle",
    tick: 0,
    theme: TUI_THEMES[0]!,
    mascot: TUI_MASCOTS[0]!,
    transcript: [
      { role: "user", text: "Hello" },
      { role: "assistant", text: "Hi there" },
    ],
    input: "",
    inputCursor: { row: 0, col: 0 },
    attachments: [],
    scrollOffset: 0,
    ...overrides,
  };
}

describe("layout snapshot tests", () => {
  it("classic layout renders without sidebar", () => {
    const layout = { ...createInitialLayout(), mode: "classic" as const };
    const frame = renderTui(baseState({ layout }));
    expect(frame).toMatchSnapshot();
  });

  it("minimal layout renders borderless message stream", () => {
    const layout = { ...createInitialLayout(), mode: "minimal" as const };
    const frame = renderTui(
      baseState({
        layout,
        transcript: [
          { role: "user", text: "修复登录 bug" },
          { role: "assistant", text: "我来看一下。" },
          { role: "tool", text: '{"output":"grep 完成，命中 3 处"}' },
        ],
        input: "继续",
      }),
    );
    expect(frame).toMatchSnapshot();
  });

  it("workbench layout renders three columns (nav/chat/preview)", () => {
    const layout = createInitialLayout();
    const frame = renderTui(
      baseState({
        width: 180,
        layout,
        transcript: [
          { role: "user", text: "修复登录 bug" },
          { role: "assistant", text: "我来看一下。" },
          { role: "tool", text: '{"output":"grep 完成，命中 3 处"}' },
        ],
        input: "继续",
        inputCursor: { row: 0, col: 2 },
        todoPanel: setTodoItems(createInitialTodoPanel(), [
          { id: "1", content: "Task A", status: "in_progress", priority: "high" },
          { id: "2", content: "Task B", status: "pending", priority: "medium" },
        ]),
        activePane: "nav",
      }),
    );
    expect(frame).toContain("▌Todo");
    expect(frame).toContain("Task A");
    expect(frame).toContain("[1]Nav");
    expect(frame).toContain("[2]Chat");
    expect(frame).toContain("[3]Preview");
    expect(frame).toMatchSnapshot();
  });

  it("split layout renders sidebar with todo", () => {
    const layout = { ...createInitialLayout(), mode: "split" as const };
    const todoPanel = setTodoItems(createInitialTodoPanel(), [
      { id: "1", content: "Task A", status: "pending", priority: "high" },
      { id: "2", content: "Task B", status: "in_progress", priority: "medium" },
    ]);
    const frame = renderTui(baseState({ layout, todoPanel }));
    expect(frame).toMatchSnapshot();
  });

  it("focus layout hides mascot", () => {
    const layout = { ...createInitialLayout(), mode: "focus" as const };
    const frame = renderTui(baseState({ layout }));
    expect(frame).toMatchSnapshot();
    expect(frame).not.toContain("🦊");
  });

  it("wide layout renders wider sidebar", () => {
    const layout = { ...createInitialLayout(), mode: "wide" as const };
    const todoPanel = setTodoItems(createInitialTodoPanel(), [
      { id: "1", content: "Wide task", status: "pending", priority: "low" },
    ]);
    const frame = renderTui(baseState({ width: 160, height: 40, layout, todoPanel }));
    expect(frame).toMatchSnapshot();
  });

  it("narrow terminal forces classic even with split mode", () => {
    const layout = { ...createInitialLayout(), mode: "split" as const };
    const todoPanel = setTodoItems(createInitialTodoPanel(), [
      { id: "1", content: "Hidden task", status: "pending", priority: "medium" },
    ]);
    const frame = renderTui(baseState({ width: 80, height: 40, layout, todoPanel }));
    expect(frame).not.toContain("Hidden task");
  });

  it("short terminal forces classic even with wide mode", () => {
    const layout = { ...createInitialLayout(), mode: "wide" as const };
    const todoPanel = setTodoItems(createInitialTodoPanel(), [
      { id: "1", content: "Suppressed task", status: "pending", priority: "high" },
    ]);
    const frame = renderTui(baseState({ width: 160, height: 15, layout, todoPanel }));
    expect(frame).not.toContain("Suppressed task");
  });

  it("classic layout without todo panel field stays backward compatible", () => {
    const layout = createInitialLayout();
    const frame = renderTui(baseState({ layout }));
    // classic 模式下不应渲染 todo header
    expect(frame).not.toContain("📋 Todo");
  });

  it("split layout with empty todo panel shows empty hint", () => {
    const layout = { ...createInitialLayout(), mode: "split" as const };
    const todoPanel = createInitialTodoPanel();
    const frame = renderTui(baseState({ layout, todoPanel }));
    expect(frame).toContain("(empty)");
  });
});
