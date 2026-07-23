import { describe, expect, it } from "vitest";
import { TodoState, createTodoTool, renderTodoItems, type TodoItem } from "../src/index.js";

const item = (id: string, status: TodoItem["status"] = "pending"): TodoItem => ({
  id,
  content: `do ${id}`,
  status,
});

describe("TodoState", () => {
  it("sets, lists and counts items", () => {
    const state = new TodoState();
    state.set([item("a"), item("b", "in_progress"), item("c", "completed")]);
    expect(state.list().map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    expect(state.counts()).toEqual({ pending: 1, inProgress: 1, completed: 1 });
    state.set([]);
    expect(state.list()).toEqual([]);
    expect(state.counts()).toEqual({ pending: 0, inProgress: 0, completed: 0 });
  });

  it("replaces the whole list on set", () => {
    const state = new TodoState();
    state.set([item("a"), item("b")]);
    state.set([item("c")]);
    expect(state.list().map((entry) => entry.id)).toEqual(["c"]);
  });

  it("rejects duplicate ids, empty or oversized content and too many items", () => {
    const state = new TodoState();
    expect(() => state.set([item("a"), item("a")])).toThrow(/Duplicate todo item id/);
    expect(() => state.set([{ id: "a", content: "", status: "pending" }])).toThrow(/content/);
    expect(() => state.set([{ id: "a", content: "x".repeat(201), status: "pending" }])).toThrow(
      /content/,
    );
    expect(() => state.set(Array.from({ length: 51 }, (_, index) => item(`i${index}`)))).toThrow(
      /50/,
    );
    expect(() =>
      state.set([{ id: "a", content: "x", status: "bogus" as TodoItem["status"] }]),
    ).toThrow(/invalid status/);
  });
});

describe("todo tool", () => {
  it("round-trips set and list with checkbox rendering", async () => {
    const state = new TodoState();
    const tool = createTodoTool(state);
    expect(tool.definition.effect).toBe("read");
    const set = await tool.execute(
      { action: "set", items: [item("a"), item("b", "completed")] },
      { cwd: "." },
    );
    expect(set.content).toContain("2 item(s)");
    expect(set.content).toContain("- [ ] a: do a");
    expect(set.content).toContain("- [x] b: do b");
    const list = await tool.execute({ action: "list" }, { cwd: "." });
    expect(list.content).toContain("- [ ] a: do a");
    expect(list.content).toContain("- [x] b: do b");
    expect(list.metadata).toMatchObject({ items: 2 });
    expect(renderTodoItems(state.list())).toContain("- [ ] a: do a");
  });

  it("renders an empty list and rejects invalid input", async () => {
    const tool = createTodoTool(new TodoState());
    expect((await tool.execute({ action: "list" }, { cwd: "." })).content).toBe(
      "Task list is empty",
    );
    await expect(tool.execute({ action: "set" }, { cwd: "." })).rejects.toThrow(/items array/);
    await expect(tool.execute({ action: "bogus" }, { cwd: "." })).rejects.toThrow(
      /Unknown todo action/,
    );
    await expect(
      tool.execute({ action: "set", items: [item("x"), item("x")] }, { cwd: "." }),
    ).rejects.toThrow(/Duplicate/);
  });
});
