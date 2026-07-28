/**
 * Pane 布局引擎。
 *
 * 纯函数模块：根据当前 {@link LayoutState} 与终端尺寸计算每个 pane 的几何信息。
 * 不持有任何运行时状态，仅依赖 TypeScript 标准类型与本包内部模块。
 */

export type PaneId = "transcript" | "input" | "todo" | "spec" | "context";

export type LayoutMode = "classic" | "split" | "focus" | "wide";

export const LAYOUT_MODES: readonly LayoutMode[] = ["classic", "split", "focus", "wide"] as const;

export interface PaneConfig {
  id: PaneId;
  visible: boolean;
  /** 列宽占比 0..1，undefined 表示自适应。 */
  width?: number;
  /** 行高占比 0..1，undefined 表示自适应。 */
  height?: number;
  side: "left" | "right" | "bottom" | "main";
  /** 最小宽度/高度（列或行）。 */
  minSize?: number;
}

export interface LayoutState {
  mode: LayoutMode;
  panes: PaneConfig[];
  activePane: PaneId;
}

/** 渲染时计算出的 pane 几何信息。 */
export interface ComputedLayout {
  mode: LayoutMode;
  main: PaneGeometry;
  sidebar?: PaneGeometry;
  /** focus 模式下隐藏吉祥物。 */
  hideMascot: boolean;
  /** sidebar 可见的具体 pane id 列表（按渲染顺序）。 */
  sidebarPanes: PaneId[];
}

export interface PaneGeometry {
  width: number;
  height: number;
  /** 起始列（0-based）。 */
  col: number;
  /** 起始行（0-based）。 */
  row: number;
}

/**
 * 创建初始 LayoutState：classic 模式，所有侧栏 pane 不可见。
 * classic 模式必须保持与重构前完全一致的渲染输出（向后兼容黄金路径）。
 */
export function createInitialLayout(): LayoutState {
  return {
    mode: "classic",
    activePane: "transcript",
    panes: [
      { id: "transcript", visible: true, side: "main" },
      { id: "input", visible: true, side: "bottom" },
      { id: "todo", visible: false, side: "right" },
      { id: "spec", visible: false, side: "right" },
      { id: "context", visible: false, side: "right" },
    ],
  };
}

/** 循环切换布局模式：classic → split → focus → wide → classic。 */
export function cycleLayoutMode(mode: LayoutMode): LayoutMode {
  const idx = LAYOUT_MODES.indexOf(mode);
  return LAYOUT_MODES[(idx + 1) % LAYOUT_MODES.length]!;
}

/**
 * 切换到指定布局模式，并相应调整 sidebar pane 可见性。
 * split / wide 模式下显示 todo/spec/context 侧栏；classic / focus 模式下隐藏。
 */
export function setLayoutMode(state: LayoutState, mode: LayoutMode): LayoutState {
  const showSidebar = mode === "split" || mode === "wide";
  const panes = state.panes.map((pane) => {
    if (pane.side === "right") {
      return { ...pane, visible: showSidebar };
    }
    return pane;
  });
  return { ...state, mode, panes };
}

/**
 * 根据当前 LayoutState 和终端尺寸计算 pane 几何。
 *
 * 强制回退条件：
 * - 宽度 < 100 列 → classic（侧栏太窄无意义）
 * - 高度 < 20 行 → classic（侧栏内容显示不足）
 *
 * 回退时 mode 字段也返回 "classic"，让 renderer 能正确分派。
 */
export function computeLayout(state: LayoutState, width: number, height: number): ComputedLayout {
  if (width < 100 || height < 20) {
    return computeClassicLayout(width, height);
  }
  switch (state.mode) {
    case "classic":
      return computeClassicLayout(width, height);
    case "split":
      return computeSplitLayout(width, height, state);
    case "focus":
      return computeFocusLayout(width, height);
    case "wide":
      return computeWideLayout(width, height, state);
    default:
      return computeClassicLayout(width, height);
  }
}

function computeClassicLayout(width: number, height: number): ComputedLayout {
  return {
    mode: "classic",
    main: { width: Math.max(40, width - 4), height: Math.max(10, height - 6), col: 2, row: 2 },
    hideMascot: false,
    sidebarPanes: [],
  };
}

function computeSplitLayout(width: number, height: number, state: LayoutState): ComputedLayout {
  // 70/30 比例，sidebar 最小 20 列
  const sidebarWidth = Math.max(20, Math.floor(width * 0.3));
  const mainWidth = Math.max(40, width - sidebarWidth - 4);
  const bodyHeight = Math.max(10, height - 6);
  const sidebarPanes = visibleSidebarPanes(state);
  return {
    mode: "split",
    main: { width: mainWidth, height: bodyHeight, col: 2, row: 2 },
    sidebar: {
      width: sidebarWidth,
      height: bodyHeight,
      col: mainWidth + 3,
      row: 2,
    },
    hideMascot: false,
    sidebarPanes,
  };
}

function computeFocusLayout(width: number, height: number): ComputedLayout {
  return {
    mode: "focus",
    main: { width: Math.max(40, width - 4), height: Math.max(10, height - 6), col: 2, row: 2 },
    hideMascot: true,
    sidebarPanes: [],
  };
}

function computeWideLayout(width: number, height: number, state: LayoutState): ComputedLayout {
  // 60/40 比例，sidebar 最小 30 列
  const sidebarWidth = Math.max(30, Math.floor(width * 0.4));
  const mainWidth = Math.max(40, width - sidebarWidth - 4);
  const bodyHeight = Math.max(10, height - 6);
  const sidebarPanes = visibleSidebarPanes(state);
  return {
    mode: "wide",
    main: { width: mainWidth, height: bodyHeight, col: 2, row: 2 },
    sidebar: {
      width: sidebarWidth,
      height: bodyHeight,
      col: mainWidth + 3,
      row: 2,
    },
    hideMascot: false,
    sidebarPanes,
  };
}

function visibleSidebarPanes(state: LayoutState): PaneId[] {
  const order: PaneId[] = ["todo", "spec", "context"];
  return order.filter((id) => state.panes.find((p) => p.id === id)?.visible);
}

/**
 * Toggle visibility of a single sidebar pane (todo/spec/context).
 * Does not change the layout mode; only flips the pane's own visible flag.
 * In classic/focus mode the sidebar is hidden regardless of pane visibility.
 */
export function toggleSidebarPane(state: LayoutState, paneId: PaneId): LayoutState {
  const panes = state.panes.map((p) => (p.id === paneId ? { ...p, visible: !p.visible } : p));
  return { ...state, panes };
}

/** Set visibility of a single sidebar pane. */
export function setSidebarPaneVisible(state: LayoutState, paneId: PaneId, visible: boolean): LayoutState {
  const panes = state.panes.map((p) => (p.id === paneId ? { ...p, visible } : p));
  return { ...state, panes };
}
