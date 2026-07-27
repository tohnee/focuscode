import { describe, expect, it } from "vitest";
import {
  addTodoItem,
  clearCompletedTodos,
  createInitialTodoPanel,
  removeTodoItem,
  renderTodoPanel,
  setTodoItems,
  updateTodoStatus,
  type TodoItem,
  type TodoPanelState,
} from "../src/todo-panel.js";
import { TUI_THEMES } from "../src/themes.js";

describe("todo-panel module", () => {
  const theme = TUI_THEMES[0]!;

  it("createInitialTodoPanel has empty items and is visible", () => {
    const state = createInitialTodoPanel();
    expect(state.items).toEqual([]);
    expect(state.visible).toBe(true);
    expect(state.filter).toBe("all");
  });

  it("addTodoItem appends with pending status and medium priority by default", () => {
    const state = createInitialTodoPanel();
    const next = addTodoItem(state, "Write tests");
    expect(next.items).toHaveLength(1);
    expect(next.items[0]?.content).toBe("Write tests");
    expect(next.items[0]?.status).toBe("pending");
    expect(next.items[0]?.priority).toBe("medium");
    expect(next.items[0]?.id).toBeTruthy();
  });

  it("addTodoItem accepts explicit priority", () => {
    const state = createInitialTodoPanel();
    const next = addTodoItem(state, "Urgent", "high");
    expect(next.items[0]?.priority).toBe("high");
  });

  it("addTodoItem does not mutate original state", () => {
    const state = createInitialTodoPanel();
    const next = addTodoItem(state, "Task");
    expect(state.items).toHaveLength(0);
    expect(next.items).toHaveLength(1);
  });

  it("updateTodoStatus transitions pending -> in_progress -> completed", () => {
    const state = createInitialTodoPanel();
    const withItem = addTodoItem(state, "Task");
    const id = withItem.items[0]!.id;
    const inProgress = updateTodoStatus(withItem, id, "in_progress");
    expect(inProgress.items[0]?.status).toBe("in_progress");
    const done = updateTodoStatus(inProgress, id, "completed");
    expect(done.items[0]?.status).toBe("completed");
  });

  it("updateTodoStatus on unknown id is a no-op", () => {
    const state = addTodoItem(createInitialTodoPanel(), "Task");
    const next = updateTodoStatus(state, "nonexistent", "completed");
    expect(next.items).toEqual(state.items);
  });

  it("removeTodoItem removes by id", () => {
    const state = createInitialTodoPanel();
    const withItem = addTodoItem(state, "Task");
    const id = withItem.items[0]!.id;
    const removed = removeTodoItem(withItem, id);
    expect(removed.items).toHaveLength(0);
  });

  it("setTodoItems replaces entire list (used by SpecEngine initialTodos injection)", () => {
    const state = createInitialTodoPanel();
    const items: TodoItem[] = [
      { id: "t1", content: "Step 1", status: "pending", priority: "high" },
      { id: "t2", content: "Step 2", status: "pending", priority: "medium" },
    ];
    const next = setTodoItems(state, items);
    expect(next.items).toHaveLength(2);
    expect(next.items[0]?.id).toBe("t1");
    expect(next.items[1]?.id).toBe("t2");
  });

  it("clearCompletedTodos removes only completed items", () => {
    const state: TodoPanelState = {
      visible: true,
      filter: "all",
      items: [
        { id: "1", content: "Pending", status: "pending", priority: "medium" },
        { id: "2", content: "Done", status: "completed", priority: "medium" },
        { id: "3", content: "Active", status: "in_progress", priority: "medium" },
      ],
    };
    const next = clearCompletedTodos(state);
    expect(next.items).toHaveLength(2);
    expect(next.items.find((i) => i.status === "completed")).toBeUndefined();
  });

  it("renderTodoPanel renders header and items with status icons", () => {
    const state: TodoPanelState = {
      visible: true,
      filter: "all",
      items: [
        { id: "1", content: "Pending task", status: "pending", priority: "high" },
        { id: "2", content: "Active task", status: "in_progress", priority: "medium" },
        { id: "3", content: "Done task", status: "completed", priority: "low" },
      ],
    };
    const lines = renderTodoPanel(state, 30, 10, theme);
    expect(lines.length).toBeGreaterThan(0);
    const joined = lines.join("\n");
    expect(joined).toContain("Todo");
    expect(joined).toContain("Pending task");
    expect(joined).toContain("Active task");
    expect(joined).toContain("Done task");
    expect(joined).toContain("☐"); // pending
    expect(joined).toContain("🔄"); // in_progress
    expect(joined).toContain("✓"); // completed
  });

  it("renderTodoPanel returns empty when not visible", () => {
    const state: TodoPanelState = { visible: false, filter: "all", items: [] };
    expect(renderTodoPanel(state, 30, 10, theme)).toEqual([]);
  });

  it("renderTodoPanel returns empty when width < 10", () => {
    const state: TodoPanelState = {
      visible: true,
      filter: "all",
      items: [{ id: "1", content: "Task", status: "pending", priority: "medium" }],
    };
    expect(renderTodoPanel(state, 8, 10, theme)).toEqual([]);
  });

  it("renderTodoPanel truncates long content to fit width", () => {
    const longContent = "A".repeat(100);
    const state: TodoPanelState = {
      visible: true,
      filter: "all",
      items: [{ id: "1", content: longContent, status: "pending", priority: "medium" }],
    };
    const lines = renderTodoPanel(state, 20, 10, theme);
    // 内容必须被截断（不会出现 100 个 A）
    const joined = lines.join("\n");
    expect(joined).toContain("…");
    // 长度有限制
    expect(joined.length).toBeLessThan(200);
  });

  it("renderTodoPanel respects filter pending", () => {
    const state: TodoPanelState = {
      visible: true,
      filter: "pending",
      items: [
        { id: "1", content: "Pending", status: "pending", priority: "medium" },
        { id: "2", content: "Done", status: "completed", priority: "medium" },
      ],
    };
    const lines = renderTodoPanel(state, 30, 10, theme);
    const joined = lines.join("\n");
    expect(joined).toContain("Pending");
    expect(joined).not.toContain("Done");
  });

  it("renderTodoPanel respects filter completed", () => {
    const state: TodoPanelState = {
      visible: true,
      filter: "completed",
      items: [
        { id: "1", content: "Pending", status: "pending", priority: "medium" },
        { id: "2", content: "Done", status: "completed", priority: "medium" },
      ],
    };
    const lines = renderTodoPanel(state, 30, 10, theme);
    const joined = lines.join("\n");
    expect(joined).toContain("Done");
    expect(joined).not.toContain("Pending");
  });

  it("renderTodoPanel shows (empty) placeholder when no items", () => {
    const state: TodoPanelState = {
      visible: true,
      filter: "all",
      items: [],
    };
    const lines = renderTodoPanel(state, 30, 10, theme);
    expect(lines.join("\n")).toContain("empty");
  });

  it("renderTodoPanel shows +N more when items exceed height", () => {
    const items: TodoItem[] = Array.from({ length: 20 }, (_, i) => ({
      id: String(i),
      content: "Task " + i,
      status: "pending" as const,
      priority: "medium" as const,
    }));
    const state: TodoPanelState = { visible: true, filter: "all", items };
    const lines = renderTodoPanel(state, 30, 5, theme);
    expect(lines.join("\n")).toContain("more");
  });

  it("renderTodoItem preserves activeForm field if provided", () => {
    const state: TodoPanelState = {
      visible: true,
      filter: "all",
      items: [
        {
          id: "1",
          content: "Implement feature",
          status: "pending",
          priority: "high",
          activeForm: "Implementing feature",
        },
      ],
    };
    const lines = renderTodoPanel(state, 40, 10, theme);
    expect(lines.join("\n")).toContain("Implement feature");
  });
});
