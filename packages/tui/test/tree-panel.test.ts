import { describe, expect, it } from "vitest";
import {
  buildSessionTree,
  createInitialTreePanel,
  renderTreePanel,
  type SessionTreeInput,
  type TreePanelState,
} from "../src/tree-panel.js";
import { DEFAULT_THEME_ID, getTheme } from "../src/themes.js";

const theme = getTheme(DEFAULT_THEME_ID);

/**
 * P1-4: 会话树可视化 pane
 *
 * 渲染 fork 关系形成的会话树，支持缩进展示父子关系。
 * 数据源为 SessionHeader 的 forkedFrom 字段，由调用方从 SessionStore 加载后传入。
 */
describe("tree-panel", () => {
  function makeSession(
    id: string,
    opts: { name?: string; model?: string; createdAt?: string; forkedFrom?: string } = {},
  ): SessionTreeInput {
    return {
      sessionId: id,
      ...(opts.name ? { name: opts.name } : {}),
      model: opts.model ?? "ollama/main",
      createdAt: opts.createdAt ?? "2026-07-29T00:00:00Z",
      ...(opts.forkedFrom ? { forkedFrom: { sessionId: opts.forkedFrom } } : {}),
    };
  }

  describe("createInitialTreePanel", () => {
    it("returns empty state with visible=false", () => {
      const state = createInitialTreePanel();
      expect(state.nodes).toEqual([]);
      expect(state.visible).toBe(false);
    });
  });

  describe("buildSessionTree", () => {
    it("returns empty array for no sessions", () => {
      expect(buildSessionTree([])).toEqual([]);
    });

    it("returns single root node with depth 0", () => {
      const nodes = buildSessionTree([makeSession("s1")]);
      expect(nodes).toHaveLength(1);
      expect(nodes[0]!.sessionId).toBe("s1");
      expect(nodes[0]!.depth).toBe(0);
      expect(nodes[0]!.children).toEqual([]);
    });

    it("builds parent-child relationship via forkedFrom", () => {
      const nodes = buildSessionTree([
        makeSession("parent"),
        makeSession("child", { forkedFrom: "parent" }),
      ]);
      expect(nodes).toHaveLength(1);
      expect(nodes[0]!.sessionId).toBe("parent");
      expect(nodes[0]!.children).toHaveLength(1);
      expect(nodes[0]!.children[0]!.sessionId).toBe("child");
      expect(nodes[0]!.children[0]!.depth).toBe(1);
    });

    it("supports multi-level fork chain", () => {
      const nodes = buildSessionTree([
        makeSession("root"),
        makeSession("branch1", { forkedFrom: "root" }),
        makeSession("leaf1", { forkedFrom: "branch1" }),
      ]);
      expect(nodes).toHaveLength(1);
      expect(nodes[0]!.sessionId).toBe("root");
      expect(nodes[0]!.children[0]!.sessionId).toBe("branch1");
      expect(nodes[0]!.children[0]!.children[0]!.sessionId).toBe("leaf1");
      expect(nodes[0]!.children[0]!.children[0]!.depth).toBe(2);
    });

    it("treats orphaned fork (parent missing) as root", () => {
      const nodes = buildSessionTree([makeSession("orphan", { forkedFrom: "missing" })]);
      expect(nodes).toHaveLength(1);
      expect(nodes[0]!.sessionId).toBe("orphan");
      expect(nodes[0]!.depth).toBe(0);
    });

    it("supports multiple independent roots", () => {
      const nodes = buildSessionTree([
        makeSession("rootA"),
        makeSession("rootB"),
        makeSession("childA", { forkedFrom: "rootA" }),
      ]);
      expect(nodes).toHaveLength(2);
      const rootA = nodes.find((n) => n.sessionId === "rootA");
      const rootB = nodes.find((n) => n.sessionId === "rootB");
      expect(rootA?.children).toHaveLength(1);
      expect(rootB?.children).toEqual([]);
    });

    it("supports multiple children of same parent", () => {
      const nodes = buildSessionTree([
        makeSession("parent"),
        makeSession("child1", { forkedFrom: "parent" }),
        makeSession("child2", { forkedFrom: "parent" }),
      ]);
      expect(nodes).toHaveLength(1);
      expect(nodes[0]!.children).toHaveLength(2);
      expect(nodes[0]!.children.map((c) => c.sessionId)).toEqual(["child1", "child2"]);
    });
  });

  describe("renderTreePanel", () => {
    it("returns empty array when not visible", () => {
      const state: TreePanelState = {
        nodes: [buildSessionTree([makeSession("s1")])[0]!],
        visible: false,
      };
      expect(renderTreePanel(state, 30, 10, theme)).toEqual([]);
    });

    it("returns empty array when width too narrow", () => {
      const state: TreePanelState = { nodes: [], visible: true };
      expect(renderTreePanel(state, 9, 10, theme)).toEqual([]);
    });

    it("renders header and empty placeholder", () => {
      const state = createInitialTreePanel();
      const visible: TreePanelState = { ...state, visible: true };
      const lines = renderTreePanel(visible, 30, 10, theme);
      expect(lines.length).toBeGreaterThan(0);
      // Should contain header "Sessions" and "(empty)" placeholder
      const joined = lines.join("\n");
      expect(joined).toContain("Sessions");
      expect(joined).toContain("(empty)");
    });

    it("renders single session node", () => {
      const nodes = buildSessionTree([makeSession("s1", { name: "My Session" })]);
      const state: TreePanelState = { nodes, visible: true };
      const lines = renderTreePanel(state, 30, 10, theme);
      const joined = lines.join("\n");
      expect(joined).toContain("My Session");
    });

    it("renders fork children with indentation", () => {
      const nodes = buildSessionTree([
        makeSession("parent", { name: "Parent" }),
        makeSession("child", { name: "Child", forkedFrom: "parent" }),
      ]);
      const state: TreePanelState = { nodes, visible: true };
      const lines = renderTreePanel(state, 30, 10, theme);
      const joined = lines.join("\n");
      expect(joined).toContain("Parent");
      expect(joined).toContain("Child");
      // Child line should have more leading whitespace than parent
      const parentLine = lines.find((l) => l.includes("Parent"));
      const childLine = lines.find((l) => l.includes("Child"));
      expect(parentLine).toBeDefined();
      expect(childLine).toBeDefined();
      const parentIndent = parentLine!.match(/^\s*/)?.[0].length ?? 0;
      const childIndent = childLine!.match(/^\s*/)?.[0].length ?? 0;
      expect(childIndent).toBeGreaterThan(parentIndent);
    });

    it("truncates when height is limited and shows more indicator", () => {
      const sessions = Array.from({ length: 10 }, (_, i) =>
        makeSession("s" + i, { name: "Session " + i }),
      );
      const nodes = buildSessionTree(sessions);
      const state: TreePanelState = { nodes, visible: true };
      const lines = renderTreePanel(state, 30, 5, theme);
      // height=5 → header + 3 items + "more" line
      const joined = lines.join("\n");
      expect(joined).toContain("more");
    });

    it("renders session id when name is absent", () => {
      const nodes = buildSessionTree([makeSession("abc123")]);
      const state: TreePanelState = { nodes, visible: true };
      const lines = renderTreePanel(state, 30, 10, theme);
      const joined = lines.join("\n");
      expect(joined).toContain("abc123");
    });

    it("renders tree connectors for children", () => {
      const nodes = buildSessionTree([
        makeSession("parent", { name: "P" }),
        makeSession("child", { name: "C", forkedFrom: "parent" }),
      ]);
      const state: TreePanelState = { nodes, visible: true };
      const lines = renderTreePanel(state, 40, 10, theme);
      const childLine = lines.find((l) => l.includes("C"));
      expect(childLine).toBeDefined();
      // Child line should contain a tree connector character (├ or └ or └─)
      expect(childLine!).toMatch(/[├└]/);
    });
  });
});
