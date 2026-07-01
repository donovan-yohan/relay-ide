import { create } from 'zustand';
import {
  addTabToPane,
  closeLayoutTab,
  collectSplitIds,
  createDefaultWorkspaceLayout,
  listPanes,
  moveTabToPane,
  selectLayoutTab,
  splitPaneWithTab,
  workspaceTabId,
  type SplitDirection,
  type SplitPlacement,
  type WorkspaceLayoutNode,
  type WorkspaceTab,
  type WorkspaceTabId,
} from '../workspace-layout.js';

export type SplitSizes = Record<string, number[]>;

interface WorkspaceLayoutState {
  layout: WorkspaceLayoutNode;
  activePaneId: string | null;
  splitSizes: SplitSizes;

  selectTab: (paneId: string, tabId: WorkspaceTabId) => void;
  setActivePane: (paneId: string) => void;
  closeTab: (tabId: WorkspaceTabId) => void;
  moveTab: (
    tabId: WorkspaceTabId,
    targetPaneId: string,
    targetIndex?: number
  ) => void;
  splitWithTab: (
    sourcePaneId: string,
    tabId: WorkspaceTabId,
    direction: SplitDirection,
    placement: SplitPlacement
  ) => void;
  addTab: (
    paneId: string,
    tab: WorkspaceTab,
    opts?: { activate?: boolean; index?: number }
  ) => void;
  /**
   * Open a tab in a new pane beside the active pane (splitting it). If the
   * active pane is empty the tab simply opens in place. Idempotent against the
   * WorkspaceArea reconciler: a tab already present elsewhere is moved beside
   * rather than duplicated.
   */
  openTabBeside: (tab: WorkspaceTab, direction?: SplitDirection) => void;
  setSplitSizes: (splitId: string, sizes: number[]) => void;
  resetLayout: (tabs: WorkspaceTab[]) => void;
  setLayout: (layout: WorkspaceLayoutNode) => void;
}

function ensureValidActivePane(
  layout: WorkspaceLayoutNode,
  current: string | null
): string | null {
  const panes = listPanes(layout);
  if (panes.length === 0) return null;
  if (current && panes.some((p) => p.id === current)) return current;
  return panes[0]?.id ?? null;
}

function gcSplitSizes(
  layout: WorkspaceLayoutNode,
  prev: SplitSizes
): SplitSizes {
  const liveIds = new Set(collectSplitIds(layout));
  let changed = false;
  const next: SplitSizes = {};
  for (const id of Object.keys(prev)) {
    if (liveIds.has(id)) {
      next[id] = prev[id]!;
    } else {
      changed = true;
    }
  }
  return changed ? next : prev;
}

const INITIAL_LAYOUT: WorkspaceLayoutNode = createDefaultWorkspaceLayout([]);

export const useWorkspaceLayoutStore = create<WorkspaceLayoutState>()(
  (set) => ({
    layout: INITIAL_LAYOUT,
    activePaneId: INITIAL_LAYOUT.type === 'pane' ? INITIAL_LAYOUT.id : null,
    splitSizes: {},

    selectTab: (paneId, tabId) =>
      set((state) => ({
        layout: selectLayoutTab(state.layout, paneId, tabId),
        activePaneId: paneId,
      })),

    setActivePane: (paneId) => set({ activePaneId: paneId }),

    closeTab: (tabId) =>
      set((state) => {
        const next = closeLayoutTab(state.layout, tabId);
        return {
          layout: next,
          activePaneId: ensureValidActivePane(next, state.activePaneId),
          splitSizes: gcSplitSizes(next, state.splitSizes),
        };
      }),

    moveTab: (tabId, targetPaneId, targetIndex) =>
      set((state) => {
        const next = moveTabToPane(
          state.layout,
          tabId,
          targetPaneId,
          targetIndex
        );
        return {
          layout: next,
          activePaneId: ensureValidActivePane(next, targetPaneId),
          splitSizes: gcSplitSizes(next, state.splitSizes),
        };
      }),

    splitWithTab: (sourcePaneId, tabId, direction, placement) =>
      set((state) => {
        const next = splitPaneWithTab(
          state.layout,
          sourcePaneId,
          tabId,
          direction,
          placement
        );
        return {
          layout: next,
          activePaneId: ensureValidActivePane(next, state.activePaneId),
          splitSizes: gcSplitSizes(next, state.splitSizes),
        };
      }),

    addTab: (paneId, tab, opts) =>
      set((state) => {
        const next = addTabToPane(state.layout, paneId, tab, opts);
        return {
          layout: next,
          activePaneId: opts?.activate === false ? state.activePaneId : paneId,
        };
      }),

    openTabBeside: (tab, direction = 'horizontal') =>
      set((state) => {
        const paneId =
          state.activePaneId ?? listPanes(state.layout)[0]?.id ?? null;
        if (!paneId) return state;
        const tabId = workspaceTabId(tab);
        // Ensure the tab exists in the active pane (moves it there if it was
        // already added elsewhere, e.g. by the WorkspaceArea reconciler).
        const withTab = addTabToPane(state.layout, paneId, tab, {
          activate: true,
        });
        // Split it out beside the active pane. A single-tab active pane is a
        // no-op split, so the first agent just opens in place.
        const next = splitPaneWithTab(
          withTab,
          paneId,
          tabId,
          direction,
          'after'
        );
        let activePaneId = paneId;
        for (const pane of listPanes(next)) {
          if (pane.tabs.some((t) => workspaceTabId(t) === tabId)) {
            activePaneId = pane.id;
            break;
          }
        }
        return {
          layout: next,
          activePaneId,
          splitSizes: gcSplitSizes(next, state.splitSizes),
        };
      }),

    setSplitSizes: (splitId, sizes) =>
      set((state) => {
        const prev = state.splitSizes[splitId];
        if (
          prev &&
          prev.length === sizes.length &&
          prev.every((v, i) => v === sizes[i])
        ) {
          return state;
        }
        return {
          splitSizes: { ...state.splitSizes, [splitId]: sizes },
        };
      }),

    resetLayout: (tabs) => {
      const layout = createDefaultWorkspaceLayout(tabs);
      set({ layout, activePaneId: layout.id, splitSizes: {} });
    },

    setLayout: (layout) =>
      set((state) => ({
        layout,
        activePaneId: ensureValidActivePane(layout, state.activePaneId),
        splitSizes: gcSplitSizes(layout, state.splitSizes),
      })),
  })
);

const paneBodyElements = new Map<string, HTMLElement | null>();
const paneBodyListeners = new Set<() => void>();

export function registerPaneBodyEl(
  paneId: string,
  el: HTMLElement | null
): void {
  if (el === null) {
    paneBodyElements.delete(paneId);
  } else {
    paneBodyElements.set(paneId, el);
  }
  paneBodyListeners.forEach((fn) => fn());
}

export function getPaneBodyEl(paneId: string): HTMLElement | null {
  return paneBodyElements.get(paneId) ?? null;
}

export function subscribeToPaneBodyEls(fn: () => void): () => void {
  paneBodyListeners.add(fn);
  return () => paneBodyListeners.delete(fn);
}

export function getAllPaneBodyEls(): ReadonlyMap<string, HTMLElement | null> {
  return paneBodyElements;
}

export function getActiveTabIdForPane(
  state: WorkspaceLayoutState,
  paneId: string
): WorkspaceTabId | null {
  const panes = listPanes(state.layout);
  const pane = panes.find((p) => p.id === paneId);
  return pane?.activeTabId ?? null;
}

export function findPaneIdForTab(
  state: WorkspaceLayoutState,
  tabId: WorkspaceTabId
): string | null {
  for (const pane of listPanes(state.layout)) {
    if (pane.tabs.some((t) => workspaceTabId(t) === tabId)) return pane.id;
  }
  return null;
}
