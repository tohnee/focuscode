/**
 * Todo 侧栏面板。
 *
 * 纯函数模块：管理 todo 项的增删改查与渲染。不持有运行时状态。
 * 仅依赖 ./themes.js 的颜色 helper 与 ./width.js 的字符串宽度工具。
 */

import { fg, type ColorValue, type TuiTheme } from "./themes.js";
import { stringWidth, stripAnsi, takeWidth } from "./width.js";

export type TodoStatus = "pending" | "in_progress" | "completed";
export type TodoPriority = "high" | "medium" | "low";

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
  priority: TodoPriority;
  /** SpecEngine 注入的初始 todo 携带的 active form（用于 in_progress 状态显示）。 */
  activeForm?: string;
}

export interface TodoPanelState {
  items: TodoItem[];
  visible: boolean;
  filter: "all" | "pending" | "completed";
}

export function createInitialTodoPanel(): TodoPanelState {
  return { items: [], visible: true, filter: "all" };
}

let todoIdCounter = 0;
function nextTodoId(): string {
  todoIdCounter += 1;
  return "todo_" + todoIdCounter;
}

export function addTodoItem(
  state: TodoPanelState,
  content: string,
  priority: TodoPriority = "medium",
): TodoPanelState {
  const item: TodoItem = {
    id: nextTodoId(),
    content,
    status: "pending",
    priority,
  };
  return { ...state, items: [...state.items, item] };
}

export function updateTodoStatus(
  state: TodoPanelState,
  id: string,
  status: TodoStatus,
): TodoPanelState {
  const exists = state.items.some((item) => item.id === id);
  if (!exists) return state;
  return {
    ...state,
    items: state.items.map((item) => (item.id === id ? { ...item, status } : item)),
  };
}

export function removeTodoItem(state: TodoPanelState, id: string): TodoPanelState {
  return { ...state, items: state.items.filter((item) => item.id !== id) };
}

export function setTodoItems(state: TodoPanelState, items: TodoItem[]): TodoPanelState {
  return { ...state, items: items.map((item) => ({ ...item })) };
}

export function clearCompletedTodos(state: TodoPanelState): TodoPanelState {
  return { ...state, items: state.items.filter((item) => item.status !== "completed") };
}

const STATUS_ICONS: Record<TodoStatus, string> = {
  pending: "☐",
  in_progress: "🔄",
  completed: "✓",
};

function priorityColor(priority: TodoPriority, theme: TuiTheme): ColorValue {
  switch (priority) {
    case "high":
      return theme.danger;
    case "medium":
      return theme.warning;
    case "low":
      return theme.muted;
  }
}

/**
 * 渲染 todo 面板为多行字符串数组。
 *
 * @param state todo 面板状态
 * @param width 可用列宽
 * @param height 可用行高（含 header）
 * @param theme 主题
 * @returns 渲染行数组；不可见或宽度不足时返回空数组
 */
export function renderTodoPanel(
  state: TodoPanelState,
  width: number,
  height: number,
  theme: TuiTheme,
): string[] {
  if (!state.visible || width < 10) return [];
  const lines: string[] = [];
  // Header
  lines.push(fg(theme.accent, "📋 Todo"));
  // Filter items
  const filtered = state.items.filter((item) => {
    if (state.filter === "all") return true;
    if (state.filter === "pending") return item.status !== "completed";
    if (state.filter === "completed") return item.status === "completed";
    return true;
  });
  // Items
  const maxItems = Math.max(0, height - 2);
  const visible = filtered.slice(0, maxItems);
  for (const item of visible) {
    const icon = STATUS_ICONS[item.status];
    const priority = priorityColor(item.priority, theme);
    const prefix = icon + " ";
    const contentWidth = Math.max(4, width - stringWidth(prefix) - 2);
    const content = truncateContent(item.content, contentWidth);
    const line = " " + prefix + fg(priority, content);
    lines.push(line);
  }
  if (filtered.length > maxItems) {
    lines.push(fg(theme.muted, " …+" + (filtered.length - maxItems) + " more"));
  }
  if (filtered.length === 0) {
    lines.push(fg(theme.muted, " (empty)"));
  }
  return lines;
}

function truncateContent(text: string, width: number): string {
  const clean = stripAnsi(text);
  if (stringWidth(clean) <= width) return clean;
  return takeWidth(clean, Math.max(1, width - 1)) + "…";
}
