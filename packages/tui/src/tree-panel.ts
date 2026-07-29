/**
 * 会话树可视化侧栏面板。
 *
 * 纯函数模块：管理会话 fork 关系树的构建与渲染。不持有运行时状态。
 * 仅依赖 ./themes.js 的颜色 helper 与 ./width.js 的字符串宽度工具。
 *
 * 数据源为 SessionHeader.forkedFrom 字段，由调用方从 SessionStore 加载后传入。
 * 本模块只负责将扁平的会话列表构建为树形结构并渲染。
 */

import { fg, type TuiTheme } from "./themes.js";
import { stringWidth, stripAnsi, takeWidth } from "./width.js";

/**
 * 扁平输入：调用方从 SessionStore 加载后传入的会话信息。
 * forkedFrom.sessionId 指向父会话；entryId 是 fork 点（仅用于信息展示，不参与树构建）。
 */
export interface SessionTreeInput {
  sessionId: string;
  name?: string;
  model: string;
  createdAt: string;
  forkedFrom?: { sessionId: string; entryId?: string };
}

/**
 * 树节点：构建后的会话树节点，包含 depth（缩进层级）与 children 子树。
 */
export interface SessionTreeNode extends SessionTreeInput {
  depth: number;
  children: SessionTreeNode[];
}

export interface TreePanelState {
  nodes: SessionTreeNode[];
  visible: boolean;
}

export function createInitialTreePanel(): TreePanelState {
  return { nodes: [], visible: false };
}

/**
 * 从扁平的会话列表构建会话树。
 *
 * 算法：
 * 1. 以 sessionId 为键建立 Map
 * 2. 遍历每个会话，若 forkedFrom.sessionId 存在且在 Map 中，挂到父节点的 children
 * 3. 否则作为根节点
 * 4. 递归设置 depth
 *
 * 孤立 fork（父会话不在列表中）作为根节点处理。
 * 多个子会话保持输入顺序。
 */
export function buildSessionTree(sessions: SessionTreeInput[]): SessionTreeNode[] {
  if (sessions.length === 0) return [];

  const nodeMap = new Map<string, SessionTreeNode>();
  for (const session of sessions) {
    nodeMap.set(session.sessionId, { ...session, depth: 0, children: [] });
  }

  const roots: SessionTreeNode[] = [];
  for (const session of sessions) {
    const node = nodeMap.get(session.sessionId)!;
    const parentId = session.forkedFrom?.sessionId;
    if (parentId && nodeMap.has(parentId)) {
      const parent = nodeMap.get(parentId)!;
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // 递归设置 depth
  const setDepth = (node: SessionTreeNode, depth: number): void => {
    node.depth = depth;
    for (const child of node.children) {
      setDepth(child, depth + 1);
    }
  };
  for (const root of roots) {
    setDepth(root, 0);
  }

  return roots;
}

/**
 * 将树形节点扁平化为带缩进的线性列表（深度优先遍历）。
 * 每个条目携带 isLast 标记，用于渲染树形连接符（├─ vs └─）。
 */
interface FlatNode {
  node: SessionTreeNode;
  isLast: boolean;
}

function flattenTree(nodes: SessionTreeNode[]): FlatNode[] {
  const result: FlatNode[] = [];
  const walk = (node: SessionTreeNode, isLast: boolean): void => {
    result.push({ node, isLast });
    const children = node.children;
    for (let i = 0; i < children.length; i++) {
      walk(children[i]!, i === children.length - 1);
    }
  };
  for (let i = 0; i < nodes.length; i++) {
    walk(nodes[i]!, i === nodes.length - 1);
  }
  return result;
}

/**
 * 渲染会话树面板为多行字符串数组。
 *
 * @param state 面板状态
 * @param width 可用列宽
 * @param height 可用行高（含 header）
 * @param theme 主题
 * @returns 渲染行数组；不可见或宽度不足时返回空数组
 */
export function renderTreePanel(
  state: TreePanelState,
  width: number,
  height: number,
  theme: TuiTheme,
): string[] {
  if (!state.visible || width < 10) return [];
  const lines: string[] = [];
  // Header
  lines.push(fg(theme.accent, "🌳 Sessions"));

  const flat = flattenTree(state.nodes);
  const maxItems = Math.max(0, height - 2);
  const visible = flat.slice(0, maxItems);

  for (const { node, isLast } of visible) {
    const indent = "  ".repeat(node.depth);
    const connector = node.depth === 0 ? "" : isLast ? "└─ " : "├─ ";
    const label = node.name ?? node.sessionId;
    const prefix = indent + connector;
    const contentWidth = Math.max(4, width - stringWidth(prefix) - 1);
    const content = truncateContent(label, contentWidth);
    const color = node.depth === 0 ? theme.foreground : theme.secondary;
    lines.push(" " + prefix + fg(color, content));
  }

  if (flat.length > maxItems) {
    lines.push(fg(theme.muted, " …+" + (flat.length - maxItems) + " more"));
  }
  if (flat.length === 0) {
    lines.push(fg(theme.muted, " (empty)"));
  }
  return lines;
}

function truncateContent(text: string, width: number): string {
  const clean = stripAnsi(text);
  if (stringWidth(clean) <= width) return clean;
  return takeWidth(clean, Math.max(1, width - 1)) + "…";
}
