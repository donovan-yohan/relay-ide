import { create } from 'zustand';
import {
  DEFAULT_VIEW_LENS,
  type SavedView,
  type ViewLens,
} from '../state/view-tree.js';

// ── Constants ──────────────────────────────────────────────────────────────
const SIDEBAR_WIDTH_KEY = 'claude-remote-sidebar-width';
const SIDEBAR_COLLAPSED_KEY = 'claude-remote-sidebar-collapsed';
const ACTIVE_WORKSPACE_KEY = 'claude-remote-active-workspace';
const ACTIVE_WORKSPACE_GROUP_KEY = 'claude-remote-active-workspace-group';
const TERMINAL_FONT_SIZE_KEY = 'claude-remote-terminal-font-size';
const RIGHT_SIDEBAR_WIDTH_KEY = 'claude-remote-right-sidebar-width';
const RIGHT_SIDEBAR_COLLAPSED_KEY = 'claude-remote-right-sidebar-collapsed';
const UTILITY_RAIL_STATE_KEY_PREFIX = 'relay-utility-rail::';
const DIFF_VIEW_MODE_KEY = 'claude-remote-diff-view-mode';
const WORD_WRAP_KEY = 'claude-remote-word-wrap';
const COLLAPSED_WORKSPACES_KEY = 'claude-remote-collapsed-workspaces';
// #732: view-spine MVP feature flag. Default OFF. When OFF the sidebar render
// is byte-identical to today; ON swaps in the client-derived read-only tree.
// Dev-only affordance: set `localStorage.relay-view-spine = '1'` and reload.
const VIEW_SPINE_KEY = 'relay-view-spine';
// #738: persistent View layer (FE-only, localStorage). All three ride the same
// `ls`/`lsSave`/`lsRemove` helpers + fail-soft pattern as the flag above.
//   - active lens, restored across reload (the #727 lens was ephemeral).
//   - pinned ids (mixed Project/Bench/Workspace stable ids) — pinned-to-top.
//   - saved/named Views (an array of {id,name,lens}).
const VIEW_SPINE_LENS_KEY = 'relay-view-spine-lens';
const VIEW_SPINE_PINS_KEY = 'relay-view-spine-pins';
const VIEW_SPINE_SAVED_VIEWS_KEY = 'relay-view-spine-saved-views';

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
export const DEFAULT_UTILITY_RAIL_WIDTH = 320;
export const MIN_UTILITY_RAIL_WIDTH = 220;
export const MAX_UTILITY_RAIL_WIDTH = 640;
export const UTILITY_ICON_RAIL_WIDTH = 48;

export type RightSidebarTab = 'changes' | 'all-files' | 'checks';
export type FileTabType = 'diff' | 'code' | 'html';
export type DiffSource = 'working' | 'staged' | 'branch';
export type DiffViewMode = 'unified' | 'side-by-side';
export type UtilityRailTab =
  | 'files'
  | 'changes'
  | 'branch'
  | 'review'
  | 'logs'
  | 'stats'
  | 'terminal';

export interface WorkspaceReviewState {
  activeFilePath: string | null;
  diffSource: DiffSource;
  defaultBranch: string;
  currentHunkIndex: number;
}

export interface OpenReviewWorkspaceOptions {
  filePath?: string;
  base?: string;
  preserveSelectedTab?: boolean;
  preserveFullPageDiff?: boolean;
}
export type UtilitySurfacePlacement =
  | { kind: 'rail' }
  | { kind: 'anchored-pane'; paneId: string };

export interface WorkspaceUtilityRailState {
  visible: boolean;
  selectedRailTab: UtilityRailTab | null;
  width: number;
  anchoredPaneWidths?: Partial<Record<UtilityRailTab, number>>;
  placements?: Partial<Record<UtilityRailTab, UtilitySurfacePlacement>>;
  review?: WorkspaceReviewState;
  /** @deprecated migrated into review.activeFilePath */
  reviewFilePath?: string;
  filesMode?: 'changes' | 'all-files';
  branchBase?: string;
  utilityTerminalIds?: string[];
  selectedUtilityTerminalId?: string | null;
}

export interface OpenUtilityRailTabOptions {
  preserveSelectedTab?: boolean;
  branchBase?: string | null;
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

function loadDiffViewMode(): DiffViewMode {
  const stored = ls(DIFF_VIEW_MODE_KEY);
  if (stored === 'unified' || stored === 'side-by-side') return stored;
  return 'unified';
}

function loadViewSpineEnabled(): boolean {
  // Truthy only for the explicit opt-in value so a stale '0'/'false' reads OFF.
  return ls(VIEW_SPINE_KEY) === '1';
}

// ── #738: View-layer persistence (lens / pins / saved Views) ─────────────────
// All fail soft: missing/corrupt localStorage → safe defaults, never throw.

const VIEW_LENSES: ReadonlyArray<ViewLens> = ['recent', 'all', 'this-host'];

function isViewLens(value: unknown): value is ViewLens {
  return typeof value === 'string' && VIEW_LENSES.includes(value as ViewLens);
}

/** Restore the persisted active lens; default `recent` on missing/unknown. */
export function loadViewSpineLens(): ViewLens {
  const stored = ls(VIEW_SPINE_LENS_KEY);
  return isViewLens(stored) ? stored : DEFAULT_VIEW_LENS;
}

/** Restore the persisted pinned-id set; empty on missing/corrupt. Drops any
 *  non-string / blank entry so a malformed record can't poison the set. */
export function loadViewSpinePins(): Set<string> {
  try {
    const stored = ls(VIEW_SPINE_PINS_KEY);
    if (!stored) return new Set();
    const parsed = JSON.parse(stored) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter((id): id is string => typeof id === 'string' && id.length > 0)
    );
  } catch {
    return new Set();
  }
}

/** A persisted saved View is well-formed only when it has a non-blank id + name
 *  and a recognized lens. Anything else is dropped (fail soft). */
function normalizeSavedView(value: unknown): SavedView | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  if (!id || !name) return null;
  if (!isViewLens(record.lens)) return null;
  return { id, name, lens: record.lens };
}

/** Restore the persisted saved Views; empty on missing/corrupt. Drops malformed
 *  entries and de-dupes by id (first wins). */
export function loadViewSpineSavedViews(): SavedView[] {
  try {
    const stored = ls(VIEW_SPINE_SAVED_VIEWS_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored) as unknown;
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const views: SavedView[] = [];
    for (const raw of parsed) {
      const view = normalizeSavedView(raw);
      if (!view || seen.has(view.id)) continue;
      seen.add(view.id);
      views.push(view);
    }
    return views;
  } catch {
    return [];
  }
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
  'changes',
  'branch',
  'review',
  'logs',
  'stats',
  'terminal',
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

function defaultReviewState(): WorkspaceReviewState {
  return {
    activeFilePath: null,
    diffSource: 'working',
    defaultBranch: 'main',
    currentHunkIndex: -1,
  };
}

function defaultUtilityRailState(): WorkspaceUtilityRailState {
  return { ...DEFAULT_UTILITY_RAIL_STATE, review: defaultReviewState() };
}

function deriveReviewStateFromBase(
  base: string | undefined,
  current: WorkspaceReviewState
): Pick<WorkspaceReviewState, 'diffSource' | 'defaultBranch'> {
  if (base === undefined) {
    return {
      diffSource: current.diffSource,
      defaultBranch: current.defaultBranch,
    };
  }
  if (base === 'cached') {
    return { diffSource: 'staged', defaultBranch: current.defaultBranch };
  }
  if (base) {
    return { diffSource: 'branch', defaultBranch: base };
  }
  return { diffSource: 'working', defaultBranch: current.defaultBranch };
}

function normalizeReviewState(
  value: Partial<WorkspaceReviewState> | null | undefined,
  legacyFilePath?: string
): WorkspaceReviewState {
  const next = defaultReviewState();
  if (typeof legacyFilePath === 'string') next.activeFilePath = legacyFilePath;
  if (!value) return next;
  if (typeof value.activeFilePath === 'string' || value.activeFilePath === null) {
    next.activeFilePath = value.activeFilePath;
  }
  if (
    value.diffSource === 'working' ||
    value.diffSource === 'staged' ||
    value.diffSource === 'branch'
  ) {
    next.diffSource = value.diffSource;
  }
  if (typeof value.defaultBranch === 'string' && value.defaultBranch.trim()) {
    next.defaultBranch = value.defaultBranch;
  }
  if (typeof value.currentHunkIndex === 'number') {
    next.currentHunkIndex = Math.max(-1, Math.trunc(value.currentHunkIndex));
  }
  return next;
}

function normalizeAnchoredPaneWidths(
  value: Partial<Record<UtilityRailTab, number>> | undefined
): Partial<Record<UtilityRailTab, number>> | undefined {
  if (!value) return undefined;
  const anchoredPaneWidths: Partial<Record<UtilityRailTab, number>> = {};
  for (const tab of UTILITY_RAIL_TABS) {
    const width = value[tab];
    if (typeof width === 'number') {
      anchoredPaneWidths[tab] = clampUtilityRailWidth(width);
    }
  }
  return Object.keys(anchoredPaneWidths).length > 0
    ? anchoredPaneWidths
    : undefined;
}

function isUtilitySurfacePlacement(
  placement: UtilitySurfacePlacement | undefined
): placement is UtilitySurfacePlacement {
  return (
    !!placement &&
    (placement.kind === 'rail' ||
      (placement.kind === 'anchored-pane' &&
        typeof placement.paneId === 'string'))
  );
}

function normalizePlacements(
  value: Partial<Record<UtilityRailTab, UtilitySurfacePlacement>> | undefined
): Partial<Record<UtilityRailTab, UtilitySurfacePlacement>> | undefined {
  if (!value) return undefined;
  const placements: Partial<Record<UtilityRailTab, UtilitySurfacePlacement>> = {};
  for (const tab of UTILITY_RAIL_TABS) {
    const placement = value[tab];
    if (isUtilitySurfacePlacement(placement)) placements[tab] = placement;
  }
  return Object.keys(placements).length > 0 ? placements : undefined;
}

function normalizeUtilityTerminalIds(ids: unknown): string[] | undefined {
  if (!Array.isArray(ids)) return undefined;
  const uniqueTerminalIds = Array.from(
    new Set(
      ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
    )
  );
  return uniqueTerminalIds.length > 0 ? uniqueTerminalIds : undefined;
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

  const anchoredPaneWidths = normalizeAnchoredPaneWidths(value.anchoredPaneWidths);
  if (anchoredPaneWidths) next.anchoredPaneWidths = anchoredPaneWidths;
  const placements = normalizePlacements(value.placements);
  if (placements) next.placements = placements;

  next.review = normalizeReviewState(value.review, value.reviewFilePath);
  if (next.review.activeFilePath !== null) {
    next.reviewFilePath = next.review.activeFilePath;
  }
  if (value.filesMode === 'changes' || value.filesMode === 'all-files') {
    next.filesMode = value.filesMode;
  }
  if (typeof value.branchBase === 'string' && value.branchBase.trim()) {
    next.branchBase = value.branchBase;
  }

  const utilityTerminalIds = normalizeUtilityTerminalIds(value.utilityTerminalIds);
  if (utilityTerminalIds) {
    next.utilityTerminalIds = utilityTerminalIds;
    next.selectedUtilityTerminalId = utilityTerminalIds.includes(
      value.selectedUtilityTerminalId ?? ''
    )
      ? (value.selectedUtilityTerminalId ?? null)
      : utilityTerminalIds[0]!;
  }

  return next;
}

function syncSelectedUtilityTerminal(
  state: WorkspaceUtilityRailState
): void {
  const ids = state.utilityTerminalIds ?? [];
  if (ids.length === 0) {
    delete state.utilityTerminalIds;
    delete state.selectedUtilityTerminalId;
    return;
  }
  if (!state.selectedUtilityTerminalId || !ids.includes(state.selectedUtilityTerminalId)) {
    state.selectedUtilityTerminalId = ids[0]!;
  }
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
  // #630: command-palette entry "start work in environment…" sets this
  // variant; App renders the EnvPickerDialog which embeds EnvironmentPicker.
  | { modal: 'env-picker' }
  // #692: fixture-backed hub handoff dry-run surface. This is intentionally
  // modal-only until the live #691 execute API is wired.
  | { modal: 'handoff-plan' }
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
  setUtilityBranchBase: (workspacePath: string, base: string | null) => void;
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
  openReviewWorkspace: (
    workspacePath: string,
    options?: OpenReviewWorkspaceOptions
  ) => void;
  setReviewActiveFile: (workspacePath: string, filePath: string | null) => void;
  setReviewDiffSource: (workspacePath: string, source: DiffSource) => void;
  setReviewDefaultBranch: (workspacePath: string, branch: string) => void;
  setReviewCurrentHunkIndex: (workspacePath: string, index: number) => void;
  addUtilityTerminal: (workspacePath: string, sessionId: string) => void;
  selectUtilityTerminal: (workspacePath: string, sessionId: string) => void;
  removeUtilityTerminal: (workspacePath: string, sessionId: string) => void;
  promoteUtilityTerminal: (workspacePath: string, sessionId: string) => void;
  reconcileUtilityTerminals: (
    workspacePath: string,
    liveTerminalSessionIds: Set<string>
  ) => void;
  openFileTabs: OpenFileTab[];
  activeFileTabKey: string | null;
  sendToTargetSessionId: string | null;
  lastChangedFiles: string[];
  analyticsView: AnalyticsView;
  activeModal: ActiveModal;
  collapsedWorkspaces: Set<string>;
  /** #732: view-spine MVP flag. Default false; backed by localStorage. */
  viewSpineEnabled: boolean;
  /** #738: active Views lens, persisted across reload (default `recent`). */
  viewSpineLens: ViewLens;
  /** #738: pinned Project/Bench/Workspace stable ids (pinned-to-top). */
  viewSpinePins: Set<string>;
  /** #738: user-saved, named Views (each captures a lens). */
  viewSpineSavedViews: SavedView[];
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
  setViewSpineEnabled: (enabled: boolean) => void;
  toggleViewSpineEnabled: () => void;
  /** #738: persist + set the active lens. */
  setViewSpineLens: (lens: ViewLens) => void;
  /** #738: toggle a pin by stable id (Project/Bench/Workspace); persists. */
  toggleViewSpinePin: (id: string) => void;
  /** #738: save the current lens as a named View; persists. No-op on a blank
   *  name (trimmed). Returns the created View, or null when the name was blank. */
  saveViewSpineView: (name: string) => SavedView | null;
  /** #738: delete a saved View by id; persists. */
  deleteViewSpineView: (id: string) => void;
  /** #738: apply a saved View (restores its lens). No-op on an unknown id. */
  applyViewSpineSavedView: (id: string) => void;
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
  utilityRailByWorkspace: {},
  openFileTabs: [],
  activeFileTabKey: null,
  sendToTargetSessionId: null,
  analyticsView: null,
  activeModal: null,
  lastChangedFiles: [],
  collapsedWorkspaces: loadCollapsedWorkspaces(),
  viewSpineEnabled: loadViewSpineEnabled(),
  viewSpineLens: loadViewSpineLens(),
  viewSpinePins: loadViewSpinePins(),
  viewSpineSavedViews: loadViewSpineSavedViews(),

  openSidebar: () => set({ sidebarOpen: true }),
  closeSidebar: () => set({ sidebarOpen: false }),

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
        if (options?.branchBase !== undefined) {
          if (options.branchBase?.trim()) state.branchBase = options.branchBase;
          else delete state.branchBase;
        }
      }
    );
    set({
      utilityRailByWorkspace: {
        ...get().utilityRailByWorkspace,
        [workspacePath]: next,
      },
    });
  },
  setUtilityBranchBase: (workspacePath, base) => {
    const next = mutateUtilityRailState(
      workspacePath,
      get().utilityRailByWorkspace[workspacePath],
      (state) => {
        if (base?.trim()) state.branchBase = base;
        else delete state.branchBase;
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
  openReviewWorkspace: (workspacePath, options) => {
    const nextState = mutateUtilityRailState(
      workspacePath,
      get().utilityRailByWorkspace[workspacePath],
      (state) => {
        state.visible = true;
        if (!options?.preserveSelectedTab) state.selectedRailTab = 'review';
        const current = normalizeReviewState(state.review, state.reviewFilePath);
        const derived = deriveReviewStateFromBase(options?.base, current);
        const activeFilePath = options?.filePath ?? current.activeFilePath;
        const shouldResetHunkIndex =
          activeFilePath !== current.activeFilePath ||
          derived.diffSource !== current.diffSource ||
          derived.defaultBranch !== current.defaultBranch;
        state.review = {
          ...current,
          ...derived,
          activeFilePath,
          currentHunkIndex: shouldResetHunkIndex ? -1 : current.currentHunkIndex,
        };
        if (state.review.activeFilePath) {
          state.reviewFilePath = state.review.activeFilePath;
        } else {
          delete state.reviewFilePath;
        }
      }
    );
    set({
      ...(options?.preserveFullPageDiff ? {} : { fullPageDiff: null }),
      utilityRailByWorkspace: {
        ...get().utilityRailByWorkspace,
        [workspacePath]: nextState,
      },
    });
  },
  setReviewActiveFile: (workspacePath, filePath) => {
    const nextState = mutateUtilityRailState(
      workspacePath,
      get().utilityRailByWorkspace[workspacePath],
      (state) => {
        const current = normalizeReviewState(state.review, state.reviewFilePath);
        state.review = {
          ...current,
          activeFilePath: filePath,
          currentHunkIndex: -1,
        };
        if (filePath) state.reviewFilePath = filePath;
        else delete state.reviewFilePath;
      }
    );
    set({
      utilityRailByWorkspace: {
        ...get().utilityRailByWorkspace,
        [workspacePath]: nextState,
      },
    });
  },
  setReviewDiffSource: (workspacePath, source) => {
    const nextState = mutateUtilityRailState(
      workspacePath,
      get().utilityRailByWorkspace[workspacePath],
      (state) => {
        const current = normalizeReviewState(state.review, state.reviewFilePath);
        state.review = { ...current, diffSource: source, currentHunkIndex: -1 };
      }
    );
    set({
      utilityRailByWorkspace: {
        ...get().utilityRailByWorkspace,
        [workspacePath]: nextState,
      },
    });
  },
  setReviewDefaultBranch: (workspacePath, branch) => {
    const nextState = mutateUtilityRailState(
      workspacePath,
      get().utilityRailByWorkspace[workspacePath],
      (state) => {
        const current = normalizeReviewState(state.review, state.reviewFilePath);
        state.review = {
          ...current,
          defaultBranch: branch || 'main',
          currentHunkIndex: -1,
        };
      }
    );
    set({
      utilityRailByWorkspace: {
        ...get().utilityRailByWorkspace,
        [workspacePath]: nextState,
      },
    });
  },
  setReviewCurrentHunkIndex: (workspacePath, index) => {
    const nextState = mutateUtilityRailState(
      workspacePath,
      get().utilityRailByWorkspace[workspacePath],
      (state) => {
        const current = normalizeReviewState(state.review, state.reviewFilePath);
        state.review = {
          ...current,
          currentHunkIndex: Math.max(-1, Math.trunc(index)),
        };
      }
    );
    set({
      utilityRailByWorkspace: {
        ...get().utilityRailByWorkspace,
        [workspacePath]: nextState,
      },
    });
  },
  addUtilityTerminal: (workspacePath, sessionId) => {
    const nextState = mutateUtilityRailState(
      workspacePath,
      get().utilityRailByWorkspace[workspacePath],
      (state) => {
        const ids = state.utilityTerminalIds
          ? [...state.utilityTerminalIds]
          : [];
        if (!ids.includes(sessionId)) ids.push(sessionId);
        state.utilityTerminalIds = ids;
        state.selectedUtilityTerminalId ??= ids[0] ?? sessionId;
        state.visible = true;
        state.selectedRailTab = 'terminal';
        syncSelectedUtilityTerminal(state);
      }
    );
    set({
      utilityRailByWorkspace: {
        ...get().utilityRailByWorkspace,
        [workspacePath]: nextState,
      },
    });
  },
  selectUtilityTerminal: (workspacePath, sessionId) => {
    const nextState = mutateUtilityRailState(
      workspacePath,
      get().utilityRailByWorkspace[workspacePath],
      (state) => {
        if (state.utilityTerminalIds?.includes(sessionId)) {
          state.selectedUtilityTerminalId = sessionId;
          state.visible = true;
          state.selectedRailTab = 'terminal';
        }
      }
    );
    set({
      utilityRailByWorkspace: {
        ...get().utilityRailByWorkspace,
        [workspacePath]: nextState,
      },
    });
  },
  removeUtilityTerminal: (workspacePath, sessionId) => {
    const nextState = mutateUtilityRailState(
      workspacePath,
      get().utilityRailByWorkspace[workspacePath],
      (state) => {
        state.utilityTerminalIds = (state.utilityTerminalIds ?? []).filter(
          (id) => id !== sessionId
        );
        if (state.selectedUtilityTerminalId === sessionId) {
          state.selectedUtilityTerminalId = state.utilityTerminalIds[0] ?? null;
        }
        syncSelectedUtilityTerminal(state);
      }
    );
    set({
      utilityRailByWorkspace: {
        ...get().utilityRailByWorkspace,
        [workspacePath]: nextState,
      },
    });
  },
  promoteUtilityTerminal: (workspacePath, sessionId) => {
    get().removeUtilityTerminal(workspacePath, sessionId);
  },
  reconcileUtilityTerminals: (workspacePath, liveTerminalSessionIds) => {
    const current = get().utilityRailByWorkspace[workspacePath];
    const loaded = current ?? loadUtilityRailState(workspacePath);
    if (!loaded.utilityTerminalIds?.length) return;
    const nextState = mutateUtilityRailState(
      workspacePath,
      current,
      (state) => {
        state.utilityTerminalIds = (state.utilityTerminalIds ?? []).filter((id) =>
          liveTerminalSessionIds.has(id)
        );
        syncSelectedUtilityTerminal(state);
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
      localStorage.setItem(
        COLLAPSED_WORKSPACES_KEY,
        JSON.stringify(Array.from(next))
      );
    } catch {
      /* unavailable */
    }
    set({ collapsedWorkspaces: next });
  },

  isWorkspaceCollapsed: (path) => get().collapsedWorkspaces.has(path),

  setViewSpineEnabled: (enabled) => {
    if (enabled) lsSave(VIEW_SPINE_KEY, '1');
    else lsRemove(VIEW_SPINE_KEY);
    set({ viewSpineEnabled: enabled });
  },

  toggleViewSpineEnabled: () => {
    get().setViewSpineEnabled(!get().viewSpineEnabled);
  },

  setViewSpineLens: (lens) => {
    lsSave(VIEW_SPINE_LENS_KEY, lens);
    set({ viewSpineLens: lens });
  },

  toggleViewSpinePin: (id) => {
    if (!id) return;
    const next = new Set(get().viewSpinePins);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    if (next.size === 0) lsRemove(VIEW_SPINE_PINS_KEY);
    else lsSave(VIEW_SPINE_PINS_KEY, JSON.stringify([...next]));
    set({ viewSpinePins: next });
  },

  saveViewSpineView: (name) => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const view: SavedView = {
      // Local id; crypto.randomUUID where available, else a time+rand fallback.
      id:
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `sv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: trimmed,
      lens: get().viewSpineLens,
    };
    const next = [...get().viewSpineSavedViews, view];
    lsSave(VIEW_SPINE_SAVED_VIEWS_KEY, JSON.stringify(next));
    set({ viewSpineSavedViews: next });
    return view;
  },

  deleteViewSpineView: (id) => {
    const next = get().viewSpineSavedViews.filter((v) => v.id !== id);
    if (next.length === get().viewSpineSavedViews.length) return;
    if (next.length === 0) lsRemove(VIEW_SPINE_SAVED_VIEWS_KEY);
    else lsSave(VIEW_SPINE_SAVED_VIEWS_KEY, JSON.stringify(next));
    set({ viewSpineSavedViews: next });
  },

  applyViewSpineSavedView: (id) => {
    const match = get().viewSpineSavedViews.find((v) => v.id === id);
    if (!match) return;
    get().setViewSpineLens(match.lens);
  },
}));
