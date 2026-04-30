import { create } from 'zustand';

// ── Constants ──────────────────────────────────────────────────────────────
const SIDEBAR_WIDTH_KEY = 'claude-remote-sidebar-width';
const SIDEBAR_COLLAPSED_KEY = 'claude-remote-sidebar-collapsed';
const ACTIVE_WORKSPACE_KEY = 'claude-remote-active-workspace';
const ACTIVE_WORKSPACE_GROUP_KEY = 'claude-remote-active-workspace-group';
const TERMINAL_FONT_SIZE_KEY = 'claude-remote-terminal-font-size';
const RIGHT_SIDEBAR_WIDTH_KEY = 'claude-remote-right-sidebar-width';
const RIGHT_SIDEBAR_COLLAPSED_KEY = 'claude-remote-right-sidebar-collapsed';
const UTILITY_RAIL_STATE_KEY_PREFIX = 'relay-utility-rail::';
const FILE_VIEWER_WIDTH_KEY = 'claude-remote-file-viewer-width';
const WORKSPACE_LAYOUT_KEY = 'claude-remote-workspace-layout-enabled';
const DIFF_VIEW_MODE_KEY = 'claude-remote-diff-view-mode';
const WORD_WRAP_KEY = 'claude-remote-word-wrap';
const COLLAPSED_WORKSPACES_KEY = 'claude-remote-collapsed-workspaces';

export const DEFAULT_SIDEBAR_WIDTH = 240;
export const MIN_SIDEBAR_WIDTH = 180;
export const MAX_SIDEBAR_WIDTH = 500;
export const COLLAPSED_SIDEBAR_WIDTH = 44;
export const DEFAULT_TERMINAL_FONT_SIZE = 14;
export const MIN_TERMINAL_FONT_SIZE = 8;
export const MAX_TERMINAL_FONT_SIZE = 28;
export const DEFAULT_RIGHT_SIDEBAR_WIDTH = 220;
export const MIN_RIGHT_SIDEBAR_WIDTH = 160;
export const MAX_RIGHT_SIDEBAR_WIDTH = 400;
export const DEFAULT_FILE_VIEWER_RATIO = 0.35;
export const DEFAULT_UTILITY_RAIL_WIDTH = 320;
export const MIN_UTILITY_RAIL_WIDTH = 220;
export const MAX_UTILITY_RAIL_WIDTH = 640;
export const UTILITY_ICON_RAIL_WIDTH = 48;

export type RightSidebarTab = 'changes' | 'all-files' | 'checks';
export type FileTabType = 'diff' | 'code' | 'html';
export type DiffViewMode = 'unified' | 'side-by-side';
export type UtilityRailTab = 'files' | 'review' | 'logs' | 'stats';
export type UtilitySurfacePlacement =
  | { kind: 'rail' }
  | { kind: 'anchored-pane'; paneId: string };

export interface WorkspaceUtilityRailState {
  visible: boolean;
  selectedRailTab: UtilityRailTab | null;
  width: number;
  anchoredPaneWidths?: Partial<Record<UtilityRailTab, number>>;
  placements?: Partial<Record<UtilityRailTab, UtilitySurfacePlacement>>;
  reviewFilePath?: string;
  filesMode?: 'changes' | 'all-files';
}

export interface OpenUtilityRailTabOptions {
  preserveSelectedTab?: boolean;
}

export const DEFAULT_UTILITY_RAIL_STATE: WorkspaceUtilityRailState = {
  visible: true,
  selectedRailTab: null,
  width: DEFAULT_UTILITY_RAIL_WIDTH,
};

export function fileTabKey(filePath: string, tabType?: FileTabType): string {
  return `${tabType ?? 'code'}::${filePath}`;
}

export interface OpenFileTab {
  filePath: string;
  fileName: string;
  isChanged: boolean;
  tabType?: FileTabType;
  token?: string;
  refreshVersion?: number;
}

// ── localStorage helpers ───────────────────────────────────────────────────
function ls(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function lsSave(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* unavailable */
  }
}
function lsRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* unavailable */
  }
}

function loadSidebarWidth(): number {
  const stored = ls(SIDEBAR_WIDTH_KEY);
  if (stored) {
    const val = parseInt(stored, 10);
    if (val >= MIN_SIDEBAR_WIDTH && val <= MAX_SIDEBAR_WIDTH) return val;
  }
  return DEFAULT_SIDEBAR_WIDTH;
}

function loadRightSidebarWidth(): number {
  const stored = ls(RIGHT_SIDEBAR_WIDTH_KEY);
  if (stored) {
    const val = parseInt(stored, 10);
    if (val >= MIN_RIGHT_SIDEBAR_WIDTH && val <= MAX_RIGHT_SIDEBAR_WIDTH)
      return val;
  }
  return DEFAULT_RIGHT_SIDEBAR_WIDTH;
}

function loadFileViewerRatio(): number {
  const stored = ls(FILE_VIEWER_WIDTH_KEY);
  if (stored) {
    const val = parseFloat(stored);
    if (val >= 0.15 && val <= 0.75) return val;
  }
  return DEFAULT_FILE_VIEWER_RATIO;
}

function loadDiffViewMode(): DiffViewMode {
  const stored = ls(DIFF_VIEW_MODE_KEY);
  if (stored === 'unified' || stored === 'side-by-side') return stored;
  return 'unified';
}

function loadWorkspaceLayoutEnabled(): boolean {
  return ls(WORKSPACE_LAYOUT_KEY) === 'true';
}

function loadTerminalFontSize(): number {
  const stored = ls(TERMINAL_FONT_SIZE_KEY);
  if (stored) {
    const val = parseInt(stored, 10);
    if (
      !Number.isNaN(val) &&
      val >= MIN_TERMINAL_FONT_SIZE &&
      val <= MAX_TERMINAL_FONT_SIZE
    )
      return val;
  }
  return DEFAULT_TERMINAL_FONT_SIZE;
}

function loadCollapsedWorkspaces(): Set<string> {
  try {
    const stored = ls(COLLAPSED_WORKSPACES_KEY);
    if (stored) return new Set(JSON.parse(stored) as string[]);
  } catch {
    /* unavailable */
  }
  return new Set();
}

const UTILITY_RAIL_TABS: UtilityRailTab[] = [
  'files',
  'review',
  'logs',
  'stats',
];

function isUtilityRailTab(value: unknown): value is UtilityRailTab {
  return (
    typeof value === 'string' &&
    UTILITY_RAIL_TABS.includes(value as UtilityRailTab)
  );
}

function clampUtilityRailWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_UTILITY_RAIL_WIDTH;
  return Math.min(
    MAX_UTILITY_RAIL_WIDTH,
    Math.max(MIN_UTILITY_RAIL_WIDTH, Math.round(width))
  );
}

function utilityRailStorageKey(workspacePath: string): string {
  return `${UTILITY_RAIL_STATE_KEY_PREFIX}${workspacePath}`;
}

const utilityRailStateCache = new Map<string, WorkspaceUtilityRailState>();

export function clearUtilityRailStateCacheForTesting(): void {
  utilityRailStateCache.clear();
}

function defaultUtilityRailState(): WorkspaceUtilityRailState {
  return { ...DEFAULT_UTILITY_RAIL_STATE };
}

function normalizeUtilityRailState(
  value: Partial<WorkspaceUtilityRailState> | null | undefined
): WorkspaceUtilityRailState {
  const next = defaultUtilityRailState();
  if (!value) return next;

  next.visible = value.visible ?? next.visible;
  next.selectedRailTab = isUtilityRailTab(value.selectedRailTab)
    ? value.selectedRailTab
    : value.selectedRailTab === null
      ? null
      : next.selectedRailTab;
  next.width = clampUtilityRailWidth(value.width ?? next.width);

  if (value.anchoredPaneWidths) {
    const anchoredPaneWidths: Partial<Record<UtilityRailTab, number>> = {};
    for (const tab of UTILITY_RAIL_TABS) {
      const width = value.anchoredPaneWidths[tab];
      if (typeof width === 'number')
        anchoredPaneWidths[tab] = clampUtilityRailWidth(width);
    }
    if (Object.keys(anchoredPaneWidths).length > 0)
      next.anchoredPaneWidths = anchoredPaneWidths;
  }

  if (value.placements) {
    const placements: Partial<Record<UtilityRailTab, UtilitySurfacePlacement>> =
      {};
    for (const tab of UTILITY_RAIL_TABS) {
      const placement = value.placements[tab];
      if (
        placement &&
        (placement.kind === 'rail' ||
          (placement.kind === 'anchored-pane' &&
            typeof placement.paneId === 'string'))
      ) {
        placements[tab] = placement;
      }
    }
    if (Object.keys(placements).length > 0) next.placements = placements;
  }

  if (typeof value.reviewFilePath === 'string')
    next.reviewFilePath = value.reviewFilePath;
  if (value.filesMode === 'changes' || value.filesMode === 'all-files') {
    next.filesMode = value.filesMode;
  }

  return next;
}

function loadUtilityRailState(
  workspacePath: string
): WorkspaceUtilityRailState {
  const cached = utilityRailStateCache.get(workspacePath);
  if (cached) return cached;
  const stored = ls(utilityRailStorageKey(workspacePath));
  if (!stored) {
    const state = defaultUtilityRailState();
    utilityRailStateCache.set(workspacePath, state);
    return state;
  }
  try {
    const state = normalizeUtilityRailState(
      JSON.parse(stored) as Partial<WorkspaceUtilityRailState>
    );
    utilityRailStateCache.set(workspacePath, state);
    return state;
  } catch {
    const state = defaultUtilityRailState();
    utilityRailStateCache.set(workspacePath, state);
    return state;
  }
}

function persistUtilityRailState(
  workspacePath: string,
  state: WorkspaceUtilityRailState
): void {
  lsSave(utilityRailStorageKey(workspacePath), JSON.stringify(state));
}

function mutateUtilityRailState(
  workspacePath: string,
  currentState: WorkspaceUtilityRailState | undefined,
  mutate: (state: WorkspaceUtilityRailState) => void,
  persist = true
): WorkspaceUtilityRailState {
  const next = normalizeUtilityRailState(
    currentState ?? loadUtilityRailState(workspacePath)
  );
  mutate(next);
  const normalized = normalizeUtilityRailState(next);
  utilityRailStateCache.set(workspacePath, normalized);
  if (persist) persistUtilityRailState(workspacePath, normalized);
  return normalized;
}

export type AnalyticsView = 'dashboard' | { sessionId: string } | null;

export type ActiveModal =
  | { modal: 'settings'; scrollToId: string | null }
  | { modal: 'add-repo' }
  | null;

// ── State interface ────────────────────────────────────────────────────────
export interface UiState {
  sidebarOpen: boolean;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  searchQuery: string;
  activeRepoPath: string | null;
  activeWorkspaceId: string | null;
  terminalFontSize: number;
  hasHardwareKeyboard: boolean;
  keyboardOpen: boolean;
  fullPageDiff: { workspacePath: string; file?: string; base?: string } | null;
  fileDiffSource: 'working' | 'staged' | 'branch';
  fileDiffDefaultBranch: string;
  fileDiffViewMode: DiffViewMode;
  fileWordWrap: boolean;
  rightSidebarVisible: boolean;
  rightSidebarCollapsed: boolean;
  rightSidebarWidth: number;
  rightSidebarTab: RightSidebarTab;
  workspaceLayoutEnabled: boolean;
  setWorkspaceLayoutEnabled: (enabled: boolean) => void;
  utilityRailByWorkspace: Record<string, WorkspaceUtilityRailState>;
  getUtilityRailState: (workspacePath: string) => WorkspaceUtilityRailState;
  hydrateUtilityRailState: (workspacePath: string) => void;
  setSelectedUtilityRailTab: (
    workspacePath: string,
    tab: UtilityRailTab | null
  ) => void;
  openUtilityRailTab: (
    workspacePath: string,
    tab: UtilityRailTab,
    options?: OpenUtilityRailTabOptions
  ) => void;
  setUtilityRailVisible: (workspacePath: string, visible: boolean) => void;
  toggleUtilityRailVisible: (workspacePath: string) => void;
  setUtilityRailWidth: (workspacePath: string, width: number) => void;
  saveUtilityRailState: (workspacePath: string) => void;
  setAnchoredUtilityPaneWidth: (
    workspacePath: string,
    tab: UtilityRailTab,
    width: number
  ) => void;
  setUtilitySurfacePlacement: (
    workspacePath: string,
    tab: UtilityRailTab,
    placement: UtilitySurfacePlacement
  ) => void;
  openFileTabs: OpenFileTab[];
  activeFileTabKey: string | null;
  fileViewerRatio: number;
  sendToTargetSessionId: string | null;
  lastChangedFiles: string[];
  analyticsView: AnalyticsView;
  activeModal: ActiveModal;
  collapsedWorkspaces: Set<string>;
  // Actions
  openSidebar: () => void;
  closeSidebar: () => void;
  saveSidebarWidth: () => void;
  toggleSidebarCollapsed: () => void;
  saveTerminalFontSize: () => void;
  setActiveRepoPath: (v: string | null) => void;
  setActiveWorkspaceId: (id: string | null) => void;
  setFileDiffViewMode: (v: DiffViewMode) => void;
  setFileWordWrap: (v: boolean) => void;
  toggleRightSidebarCollapsed: () => void;
  saveRightSidebarWidth: () => void;
  saveFileViewerRatio: () => void;
  openFileTab: (
    filePath: string,
    isChanged: boolean,
    tabType?: FileTabType,
    token?: string
  ) => void;
  closeFileTab: (filePath: string, tabType?: FileTabType) => void;
  closeAllFileTabs: () => void;
  openHtmlTab: (filePath: string, token: string) => void;
  refreshHtmlTab: (filePath: string) => void;
  setRightSidebarTab: (tab: RightSidebarTab) => void;
  setFileDiffSource: (source: 'working' | 'staged' | 'branch') => void;
  setFileDiffDefaultBranch: (branch: string) => void;
  setLastChangedFiles: (files: string[]) => void;
  setAnalyticsView: (v: AnalyticsView) => void;
  setActiveModal: (v: ActiveModal) => void;
  toggleWorkspaceCollapse: (path: string) => void;
  isWorkspaceCollapsed: (path: string) => boolean;
}

export const useUiStore = create<UiState>()((set, get) => ({
  sidebarOpen: false,
  sidebarWidth: loadSidebarWidth(),
  sidebarCollapsed: ls(SIDEBAR_COLLAPSED_KEY) === 'true',
  searchQuery: '',
  activeRepoPath: ls(ACTIVE_WORKSPACE_KEY),
  activeWorkspaceId: ls(ACTIVE_WORKSPACE_GROUP_KEY),
  terminalFontSize: loadTerminalFontSize(),
  hasHardwareKeyboard: false,
  keyboardOpen: false,
  fullPageDiff: null,
  fileDiffSource: 'working',
  fileDiffDefaultBranch: 'main',
  fileDiffViewMode: loadDiffViewMode(),
  fileWordWrap: ls(WORD_WRAP_KEY) === 'true',
  rightSidebarVisible: true,
  rightSidebarCollapsed: ls(RIGHT_SIDEBAR_COLLAPSED_KEY) === 'true',
  rightSidebarWidth: loadRightSidebarWidth(),
  rightSidebarTab: 'changes',
  workspaceLayoutEnabled: loadWorkspaceLayoutEnabled(),
  utilityRailByWorkspace: {},
  openFileTabs: [],
  activeFileTabKey: null,
  fileViewerRatio: loadFileViewerRatio(),
  sendToTargetSessionId: null,
  analyticsView: null,
  activeModal: null,
  lastChangedFiles: [],
  collapsedWorkspaces: loadCollapsedWorkspaces(),

  openSidebar: () => set({ sidebarOpen: true }),
  closeSidebar: () => set({ sidebarOpen: false }),

  setWorkspaceLayoutEnabled: (enabled) => {
    if (enabled) lsSave(WORKSPACE_LAYOUT_KEY, 'true');
    else lsRemove(WORKSPACE_LAYOUT_KEY);
    set({ workspaceLayoutEnabled: enabled });
  },

  saveSidebarWidth: () => lsSave(SIDEBAR_WIDTH_KEY, String(get().sidebarWidth)),

  toggleSidebarCollapsed: () => {
    const next = !get().sidebarCollapsed;
    lsSave(SIDEBAR_COLLAPSED_KEY, String(next));
    set({ sidebarCollapsed: next });
  },

  saveTerminalFontSize: () =>
    lsSave(TERMINAL_FONT_SIZE_KEY, String(get().terminalFontSize)),

  setActiveRepoPath: (v) => {
    if (v === null) lsRemove(ACTIVE_WORKSPACE_KEY);
    else lsSave(ACTIVE_WORKSPACE_KEY, v);
    set({ activeRepoPath: v });
  },

  setActiveWorkspaceId: (id) => {
    if (id === null) lsRemove(ACTIVE_WORKSPACE_GROUP_KEY);
    else lsSave(ACTIVE_WORKSPACE_GROUP_KEY, id);
    set({ activeWorkspaceId: id });
  },

  setFileDiffViewMode: (v) => {
    lsSave(DIFF_VIEW_MODE_KEY, v);
    set({ fileDiffViewMode: v });
  },

  setFileWordWrap: (v) => {
    lsSave(WORD_WRAP_KEY, String(v));
    set({ fileWordWrap: v });
  },

  toggleRightSidebarCollapsed: () => {
    const next = !get().rightSidebarCollapsed;
    lsSave(RIGHT_SIDEBAR_COLLAPSED_KEY, String(next));
    set({ rightSidebarCollapsed: next });
  },

  setRightSidebarTab: (tab) => set({ rightSidebarTab: tab }),
  getUtilityRailState: (workspacePath) =>
    get().utilityRailByWorkspace[workspacePath] ??
    loadUtilityRailState(workspacePath),
  hydrateUtilityRailState: (workspacePath) => {
    if (!workspacePath || get().utilityRailByWorkspace[workspacePath]) return;
    const next = loadUtilityRailState(workspacePath);
    set({
      utilityRailByWorkspace: {
        ...get().utilityRailByWorkspace,
        [workspacePath]: next,
      },
    });
  },
  setSelectedUtilityRailTab: (workspacePath, tab) => {
    const next = mutateUtilityRailState(
      workspacePath,
      get().utilityRailByWorkspace[workspacePath],
      (state) => {
        state.selectedRailTab = tab;
      }
    );
    set({
      utilityRailByWorkspace: {
        ...get().utilityRailByWorkspace,
        [workspacePath]: next,
      },
    });
  },
  openUtilityRailTab: (workspacePath, tab, options) => {
    const next = mutateUtilityRailState(
      workspacePath,
      get().utilityRailByWorkspace[workspacePath],
      (state) => {
        state.visible = true;
        if (!options?.preserveSelectedTab) state.selectedRailTab = tab;
      }
    );
    set({
      utilityRailByWorkspace: {
        ...get().utilityRailByWorkspace,
        [workspacePath]: next,
      },
    });
  },
  setUtilityRailVisible: (workspacePath, visible) => {
    const next = mutateUtilityRailState(
      workspacePath,
      get().utilityRailByWorkspace[workspacePath],
      (state) => {
        state.visible = visible;
      }
    );
    set({
      utilityRailByWorkspace: {
        ...get().utilityRailByWorkspace,
        [workspacePath]: next,
      },
    });
  },
  toggleUtilityRailVisible: (workspacePath) => {
    const next = mutateUtilityRailState(
      workspacePath,
      get().utilityRailByWorkspace[workspacePath],
      (state) => {
        state.visible = !state.visible;
      }
    );
    set({
      utilityRailByWorkspace: {
        ...get().utilityRailByWorkspace,
        [workspacePath]: next,
      },
    });
  },
  setUtilityRailWidth: (workspacePath, width) => {
    const next = mutateUtilityRailState(
      workspacePath,
      get().utilityRailByWorkspace[workspacePath],
      (state) => {
        state.width = clampUtilityRailWidth(width);
      },
      false
    );
    set({
      utilityRailByWorkspace: {
        ...get().utilityRailByWorkspace,
        [workspacePath]: next,
      },
    });
  },
  saveUtilityRailState: (workspacePath) => {
    const state =
      get().utilityRailByWorkspace[workspacePath] ??
      loadUtilityRailState(workspacePath);
    persistUtilityRailState(workspacePath, state);
  },
  setAnchoredUtilityPaneWidth: (workspacePath, tab, width) => {
    const nextState = mutateUtilityRailState(
      workspacePath,
      get().utilityRailByWorkspace[workspacePath],
      (state) => {
        const next = state.anchoredPaneWidths
          ? { ...state.anchoredPaneWidths }
          : {};
        next[tab] = clampUtilityRailWidth(width);
        state.anchoredPaneWidths = next;
      }
    );
    set({
      utilityRailByWorkspace: {
        ...get().utilityRailByWorkspace,
        [workspacePath]: nextState,
      },
    });
  },
  setUtilitySurfacePlacement: (workspacePath, tab, placement) => {
    const nextState = mutateUtilityRailState(
      workspacePath,
      get().utilityRailByWorkspace[workspacePath],
      (state) => {
        const next = state.placements ? { ...state.placements } : {};
        next[tab] = placement;
        state.placements = next;
      }
    );
    set({
      utilityRailByWorkspace: {
        ...get().utilityRailByWorkspace,
        [workspacePath]: nextState,
      },
    });
  },
  setFileDiffSource: (source) => set({ fileDiffSource: source }),
  setFileDiffDefaultBranch: (branch) => set({ fileDiffDefaultBranch: branch }),
  setLastChangedFiles: (files) => set({ lastChangedFiles: files }),
  setAnalyticsView: (v) => set({ analyticsView: v }),
  setActiveModal: (v) => set({ activeModal: v }),

  saveRightSidebarWidth: () =>
    lsSave(RIGHT_SIDEBAR_WIDTH_KEY, String(get().rightSidebarWidth)),

  saveFileViewerRatio: () =>
    lsSave(FILE_VIEWER_WIDTH_KEY, String(get().fileViewerRatio)),

  openFileTab: (filePath, isChanged, tabType, token) => {
    const { openFileTabs } = get();
    const fileName = filePath.split('/').pop() ?? filePath;
    const matchType = tabType ?? (isChanged ? 'diff' : 'code');
    const existing = openFileTabs.find(
      (t) =>
        t.filePath === filePath &&
        (t.tabType ?? (t.isChanged ? 'diff' : 'code')) === matchType
    );
    if (!existing) {
      const newTab: OpenFileTab = {
        filePath,
        fileName,
        isChanged,
        tabType: matchType,
      };
      if (token) newTab.token = token;
      set({
        openFileTabs: [...openFileTabs, newTab],
        activeFileTabKey: fileTabKey(filePath, matchType),
      });
    } else if (existing.isChanged !== isChanged || existing.token !== token) {
      set({
        openFileTabs: openFileTabs.map((t) => {
          if (
            t.filePath !== filePath ||
            (t.tabType ?? (t.isChanged ? 'diff' : 'code')) !== matchType
          )
            return t;
          const updated: OpenFileTab = { ...t, isChanged, tabType: matchType };
          if (token !== undefined) updated.token = token;
          return updated;
        }),
        activeFileTabKey: fileTabKey(filePath, matchType),
      });
    } else {
      set({ activeFileTabKey: fileTabKey(filePath, matchType) });
    }
  },

  closeFileTab: (filePath, tabType) => {
    const { openFileTabs, activeFileTabKey } = get();
    const next = tabType
      ? openFileTabs.filter(
          (t) => !(t.filePath === filePath && t.tabType === tabType)
        )
      : openFileTabs.filter((t) => t.filePath !== filePath);
    const key = tabType ? fileTabKey(filePath, tabType) : null;
    const wasActive = key
      ? activeFileTabKey === key
      : activeFileTabKey?.endsWith('::' + filePath);
    const newActiveKey = wasActive
      ? next.length > 0
        ? fileTabKey(
            next[next.length - 1]!.filePath,
            next[next.length - 1]!.tabType
          )
        : null
      : activeFileTabKey;
    set({ openFileTabs: next, activeFileTabKey: newActiveKey });
  },

  closeAllFileTabs: () => set({ openFileTabs: [], activeFileTabKey: null }),

  openHtmlTab: (filePath, token) =>
    get().openFileTab(filePath, false, 'html', token),

  refreshHtmlTab: (filePath) => {
    const { openFileTabs } = get();
    const tab = openFileTabs.find(
      (t) => t.filePath === filePath && t.tabType === 'html'
    );
    if (tab) {
      set({
        openFileTabs: openFileTabs.map((t) =>
          t.filePath === filePath && t.tabType === 'html'
            ? { ...t, refreshVersion: (t.refreshVersion ?? 0) + 1 }
            : t
        ),
        activeFileTabKey: fileTabKey(filePath, 'html'),
      });
    }
  },

  toggleWorkspaceCollapse: (path) => {
    const { collapsedWorkspaces } = get();
    const next = new Set(collapsedWorkspaces);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    try {
      localStorage.setItem(COLLAPSED_WORKSPACES_KEY, JSON.stringify([...next]));
    } catch {
      /* unavailable */
    }
    set({ collapsedWorkspaces: next });
  },

  isWorkspaceCollapsed: (path) => get().collapsedWorkspaces.has(path),
}));
