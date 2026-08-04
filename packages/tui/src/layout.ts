/**
 * Pane 布局引擎。
 *
 * 纯函数模块：根据当前 {@link LayoutState} 与终端尺寸计算每个 pane 的几何信息。
 * 不持有任何运行时状态，仅依赖 TypeScript 标准类型与本包内部模块。
 */

export type PaneId =
  "transcript" | "input" | "todo" | "spec" | "context" | "tree" | "nav" | "preview";

export type LayoutMode = "workbench" | "classic" | "split" | "focus" | "wide" | "minimal";

export const LAYOUT_MODES: readonly LayoutMode[] = [
  "workbench",
  "classic",
  "split",
  "focus",
  "wide",
  "minimal",
] as const;

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
  /** workbench 缩放态（tmux Ctrl+B z）：隐藏导航/预览栏，对话流全宽。 */
  zoom?: boolean;
}

/** 渲染时计算出的 pane 几何信息。 */
export interface ComputedLayout {
  mode: LayoutMode;
  main: PaneGeometry;
  sidebar?: PaneGeometry;
  /** workbench 模式的左侧导航栏几何；窄屏降级时缺省。 */
  nav?: PaneGeometry;
  /** workbench 模式的右侧预览栏几何；窄屏降级时缺省。 */
  preview?: PaneGeometry;
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
 * 创建初始 LayoutState：workbench 模式（yazi × tmux 风格三栏工作台，默认体验）。
 * 所有侧栏 pane 不可见；classic/minimal 保留在 /layout 循环中。
 */
export function createInitialLayout(): LayoutState {
  return {
    mode: "workbench",
    activePane: "transcript",
    panes: [
      { id: "transcript", visible: true, side: "main" },
      { id: "input", visible: true, side: "bottom" },
      { id: "todo", visible: false, side: "right" },
      { id: "spec", visible: false, side: "right" },
      { id: "context", visible: false, side: "right" },
      { id: "tree", visible: false, side: "right" },
    ],
  };
}

/** 循环切换布局模式：workbench → classic → split → focus → wide → minimal → workbench。 */
export function cycleLayoutMode(mode: LayoutMode): LayoutMode {
  const idx = LAYOUT_MODES.indexOf(mode);
  return LAYOUT_MODES[(idx + 1) % LAYOUT_MODES.length]!;
}

/**
 * 切换到指定布局模式，并相应调整 sidebar pane 可见性。
 * split / wide 模式下显示 todo/spec/context 侧栏；classic / focus / minimal 模式下隐藏。
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
 * 强制回退/降级规则：
 * - workbench 在宽度 < 140 时隐藏预览栏；< 100 时进一步隐藏导航栏
 *   （退化为经典单栏，保证任何终端都可用）
 * - split / wide 在宽度 < 100 或高度 < 20 时回退 classic（侧栏太窄无意义）
 *
 * classic / focus / minimal 无侧栏，任何尺寸都按自身计算。
 * 回退时 mode 字段返回实际生效的模式，让 renderer 能正确分派。
 */
export function computeLayout(state: LayoutState, width: number, height: number): ComputedLayout {
  if (state.mode === "workbench") {
    return computeWorkbenchLayout(width, height, state.zoom);
  }
  if ((width < 100 || height < 20) && (state.mode === "split" || state.mode === "wide")) {
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
    case "minimal":
      return computeMinimalLayout(width, height);
    default:
      return computeClassicLayout(width, height);
  }
}

const WORKBENCH_NAV_WIDTH = 32;
const WORKBENCH_PREVIEW_WIDTH = 38;
const WORKBENCH_MIN_PREVIEW_WIDTH = 140;
const WORKBENCH_MIN_NAV_WIDTH = 100;

/**
 * workbench（三栏工作台）几何：左导航 + 对话流 + 右预览，全高无边框损耗。
 * 宽度 < 140 隐藏预览、< 100 隐藏导航（逐级降级）；zoom 时两者都隐藏。
 */
function computeWorkbenchLayout(width: number, height: number, zoom?: boolean): ComputedLayout {
  const bodyHeight = Math.max(8, height - 4); // 输入行 + 状态栏占 2 行 + 分隔
  const navWidth = !zoom && width >= WORKBENCH_MIN_NAV_WIDTH ? WORKBENCH_NAV_WIDTH : 0;
  const previewWidth = !zoom && width >= WORKBENCH_MIN_PREVIEW_WIDTH ? WORKBENCH_PREVIEW_WIDTH : 0;
  const mainWidth = Math.max(20, width - navWidth - previewWidth);
  return {
    mode: "workbench",
    main: { width: mainWidth, height: bodyHeight, col: navWidth, row: 0 },
    ...(navWidth > 0 ? { nav: { width: navWidth, height: bodyHeight, col: 0, row: 0 } } : {}),
    ...(previewWidth > 0
      ? { preview: { width: previewWidth, height: bodyHeight, col: navWidth + mainWidth, row: 0 } }
      : {}),
    hideMascot: true,
    sidebarPanes: [],
  };
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

/**
 * minimal（极简流式）布局：主区占满全宽、无边框损耗、隐藏 mascot 与侧栏。
 * 留给 renderer-minimal 模块按消息流渲染。
 */
function computeMinimalLayout(width: number, height: number): ComputedLayout {
  return {
    mode: "minimal",
    main: { width, height: Math.max(10, height - 3), col: 0, row: 0 },
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
  const order: PaneId[] = ["todo", "spec", "context", "tree"];
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
export function setSidebarPaneVisible(
  state: LayoutState,
  paneId: PaneId,
  visible: boolean,
): LayoutState {
  const panes = state.panes.map((p) => (p.id === paneId ? { ...p, visible } : p));
  return { ...state, panes };
}
