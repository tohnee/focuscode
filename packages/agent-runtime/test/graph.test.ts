import { describe, expect, it } from "vitest";
import {
  createTaskGraph,
  topologicalSort,
  GraphCycleError,
  runTaskGraph,
  type TaskNode,
} from "../src/graph.js";

describe("task graph", () => {
  it("sorts nodes in topological order", () => {
    const graph = createTaskGraph([
      { id: "c", executor: async () => "c", dependencies: ["a", "b"] },
      { id: "a", executor: async () => "a", dependencies: [] },
      { id: "b", executor: async () => "b", dependencies: ["a"] },
    ]);
    const sorted = topologicalSort(graph);
    const ids = sorted.map((n) => n.id);
    expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("b"));
    expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("c"));
    expect(ids.indexOf("b")).toBeLessThan(ids.indexOf("c"));
  });

  it("detects cycles and throws GraphCycleError", () => {
    const graph = createTaskGraph([
      { id: "a", executor: async () => "a", dependencies: ["b"] },
      { id: "b", executor: async () => "b", dependencies: ["a"] },
    ]);
    expect(() => topologicalSort(graph)).toThrow(GraphCycleError);
  });

  it("detects missing dependency", () => {
    const graph = createTaskGraph([
      { id: "a", executor: async () => "a", dependencies: ["nonexistent"] },
    ]);
    expect(() => topologicalSort(graph)).toThrow(/nonexistent/);
  });

  it("handles empty graph", () => {
    const graph = createTaskGraph([]);
    expect(topologicalSort(graph)).toEqual([]);
  });

  it("handles single node", () => {
    const graph = createTaskGraph([{ id: "solo", executor: async () => "done", dependencies: [] }]);
    const sorted = topologicalSort(graph);
    expect(sorted).toHaveLength(1);
    expect(sorted[0]!.id).toBe("solo");
  });

  it("preserves node executor references after sort", () => {
    const executor = async () => "result";
    const graph = createTaskGraph([{ id: "a", executor, dependencies: [] }]);
    const sorted = topologicalSort(graph);
    expect(sorted[0]!.executor).toBe(executor);
  });

  it("rejects duplicate node ids at construction", () => {
    expect(() =>
      createTaskGraph([
        { id: "a", executor: async () => "a", dependencies: [] },
        { id: "a", executor: async () => "a2", dependencies: [] },
      ]),
    ).toThrow(/Duplicate/);
  });
});

describe("runTaskGraph executor", () => {
  it("executes nodes in dependency order and collects results", async () => {
    const graph = createTaskGraph([
      { id: "a", executor: async () => "result-a", dependencies: [] },
      { id: "b", executor: async (ctx) => `b after ${ctx.results.get("a")}`, dependencies: ["a"] },
    ]);
    const result = await runTaskGraph(graph, {});
    expect(result.completed).toBe(true);
    expect(result.reason).toBe("all_succeeded");
    expect(result.results.get("a")).toBe("result-a");
    expect(result.results.get("b")).toBe("b after result-a");
  });

  it("runs independent nodes in parallel", async () => {
    let startCount = 0;
    let maxConcurrent = 0;
    const graph = createTaskGraph([
      {
        id: "a",
        executor: async () => {
          startCount++;
          maxConcurrent = Math.max(maxConcurrent, startCount);
          await new Promise((r) => setTimeout(r, 50));
          startCount--;
          return "a";
        },
        dependencies: [],
      },
      {
        id: "b",
        executor: async () => {
          startCount++;
          maxConcurrent = Math.max(maxConcurrent, startCount);
          await new Promise((r) => setTimeout(r, 50));
          startCount--;
          return "b";
        },
        dependencies: [],
      },
    ]);
    const result = await runTaskGraph(graph, {});
    expect(result.completed).toBe(true);
    expect(maxConcurrent).toBeGreaterThanOrEqual(2);
  });

  it("stops on failure by default (fail-fast)", async () => {
    const graph = createTaskGraph([
      {
        id: "a",
        executor: async () => {
          throw new Error("boom");
        },
        dependencies: [],
      },
      { id: "b", executor: async () => "b", dependencies: ["a"] },
    ]);
    const result = await runTaskGraph(graph, {});
    expect(result.completed).toBe(false);
    expect(result.reason).toBe("node_failed");
    expect(result.results.has("b")).toBe(false);
    expect(result.errors.get("a")?.message).toBe("boom");
  });

  it("continues on failure with continueOnError", async () => {
    let bRan = false;
    const graph = createTaskGraph([
      {
        id: "a",
        executor: async () => {
          throw new Error("boom");
        },
        dependencies: [],
      },
      {
        id: "b",
        executor: async () => {
          bRan = true;
          return "b";
        },
        dependencies: [],
      },
      {
        id: "c",
        executor: async (ctx) => `c(${ctx.results.get("b") ?? "skipped"})`,
        dependencies: ["b"],
      },
    ]);
    const result = await runTaskGraph(graph, { continueOnError: true });
    expect(result.completed).toBe(false);
    expect(result.reason).toBe("node_failed");
    expect(bRan).toBe(true);
    expect(result.results.get("b")).toBe("b");
    expect(result.results.get("c")).toBe("c(b)");
  });

  it("skips dependents of failed nodes even with continueOnError", async () => {
    let cRan = false;
    const graph = createTaskGraph([
      {
        id: "a",
        executor: async () => {
          throw new Error("boom");
        },
        dependencies: [],
      },
      { id: "b", executor: async () => "b", dependencies: ["a"] },
      {
        id: "c",
        executor: async () => {
          cRan = true;
          return "c";
        },
        dependencies: [],
      },
    ]);
    const result = await runTaskGraph(graph, { continueOnError: true });
    expect(result.results.get("c")).toBe("c");
    expect(result.results.has("b")).toBe(false);
    expect(cRan).toBe(true);
  });

  it("respects maxConcurrency limit", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const nodes: TaskNode[] = ["a", "b", "c", "d"].map((id) => ({
      id,
      executor: async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 30));
        concurrent--;
        return id;
      },
      dependencies: [],
    }));
    const graph = createTaskGraph(nodes);
    await runTaskGraph(graph, { maxConcurrency: 2 });
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it("propagates abort signal", async () => {
    const controller = new AbortController();
    const graph = createTaskGraph([
      {
        id: "a",
        executor: async (ctx) => {
          // Wait for abort
          while (!ctx.signal?.aborted) {
            await new Promise((r) => setTimeout(r, 10));
          }
          return "aborted";
        },
        dependencies: [],
      },
    ]);
    setTimeout(() => controller.abort(), 50);
    const result = await runTaskGraph(graph, { signal: controller.signal });
    expect(result.completed).toBe(false);
    expect(result.reason).toBe("aborted");
  });
});
