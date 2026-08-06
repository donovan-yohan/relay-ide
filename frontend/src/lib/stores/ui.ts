import { create } from 'zustand';
import type { ChannelMessageId } from '../../../../shared/channel-chat-protocol.js';
import {
  LOCAL_WORKSPACE_ID,
  isLegacyWorkspaceIdSentinel,
  isWorkspaceIdGrammar,
} from '../../../../shared/workspace.js';

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
// #1287 slice 5: operator-owned fold state for the chat rail. The desktop rail
// records per-topic expansion, the mobile cockpit records per-workspace-group
// collapse. Both used to be component-local `useState`, so every rebuild of the
// nav model (one per activity/status/branch/rename WS event) re-expanded the
// rail and a reload forgot the fold entirely.
const TOPIC_RAIL_EXPANSION_KEY = 'claude-remote-topic-rail-expansion';
const COLLAPSED_TOPIC_GROUPS_KEY = 'claude-remote-collapsed-topic-groups';
// #1058: persistent "advanced mode" toggle (Settings). Hides mechanics-heavy
// substrate surfaces (nodes/active-work tabs, analytics icon) from primary
// chrome by default; each surface stays reachable one-off via a palette action.
const ADVANCED_MODE_KEY = 'relay-advanced-mode';

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
/**
 * Cap on remembered chat-rail folds (#1287 slice 5). The record only grows when
 * the operator folds a row, and nothing prunes it when a channel is deleted, so
 * bound it and drop the least recently touched ids. Eviction is safe by
 * construction: a dropped id falls back to its structural default (roots open)
 * rather than to a stale fold.
 */
export const MAX_TOPIC_RAIL_FOLDS = 500;

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

export type OrgDashboardTab =
  | 'active-work'
  | 'nodes'
  | 'prs'
  | 'tickets'
  | 'audit';

export type RepoDashboardTab = 'overview' | 'tickets' | 'evidence';

export interface RepoDashboardTabIntent {
  repoPath: string;
  tab: RepoDashboardTab;
}

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

/**
 * Decide what the mobile utility-rail affordance (the MobileHeader "files"
 * button) should do given the current rail state. On mobile the rail renders as
 * a full-screen overlay that only slides in when a tab is actually selected
 * (`visible && selectedRailTab !== null`). The default fresh state is
 * `{ visible: true, selectedRailTab: null }`, so a plain `visible` toggle never
 * opened the overlay — the button was dead. This returns an explicit action so
 * the button can open the overlay on a real tab (restoring the last-selected
 * tab, else `files`) and close it when already open. Pure + exported for tests.
 */
export function nextMobileUtilityRailAction(
  railState: WorkspaceUtilityRailState | undefined
): { kind: 'close' } | { kind: 'open'; tab: UtilityRailTab } {
  const overlayOpen =
    railState?.visible === true &&
    (railState?.selectedRailTab ?? null) !== null;
  if (overlayOpen) return { kind: 'close' };
  return { kind: 'open', tab: railState?.selectedRailTab ?? 'files' };
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

/**
 * #1287 slice 2: coerce a persisted active-workspace selection onto the id
 * space the workspace rail can actually resolve.
 *
 * `claude-remote-active-workspace-group` is the only localStorage slot that
 * holds a workspace id, and it was never validated — so it accumulated TWO
 * incompatible id spaces. Before the channel era the launch handler wrote
 * `config.workspaces` GROUP UUIDs into it; the channel-era rail writes IA
 * workspace ids (`ws:<localId>`, minted only by `createWorkspaceId`). The
 * retired `workspace:local` / `ws:derived` sentinels could land here too.
 *
 * Anything outside the `ws:<localId>` grammar can never match an
 * `ia_workspaces` row, and it is not inert: every channel-create path resolves
 * its workspace from `activeWorkspaceId`, so a stale group UUID mints channels
 * (including DMs, whose id is DERIVED from it) inside a workspace that does not
 * exist. After item 1 of this slice a local workspace is always seeded, so
 * `LOCAL_WORKSPACE_ID` is the only legal fallback.
 *
 * An absent/blank slot stays `null` — that means "no lane selected", which is a
 * legal state the rail renders as the unscoped view.
 */
export function normalizePersistedWorkspaceId(
  raw: string | null
): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // `ws:derived` satisfies the `ws:<localId>` grammar by accident, so the
  // sentinel check has to come first or it would survive as a real id.
  if (isLegacyWorkspaceIdSentinel(trimmed)) return LOCAL_WORKSPACE_ID;
  return isWorkspaceIdGrammar(trimmed) ? trimmed : LOCAL_WORKSPACE_ID;
}

/**
 * Read + migrate the persisted active workspace. The coercion is written back
 * so it is paid once rather than on every boot, and so nothing else can read a
 * dead id out of the slot afterwards.
 */
export function loadPersistedActiveWorkspaceId(): string | null {
  const raw = ls(ACTIVE_WORKSPACE_GROUP_KEY);
  const normalized = normalizePersistedWorkspaceId(raw);
  if (raw !== null && normalized !== raw) {
    if (normalized === null) lsRemove(ACTIVE_WORKSPACE_GROUP_KEY);
    else lsSave(ACTIVE_WORKSPACE_GROUP_KEY, normalized);
  }
  return normalized;
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

function loadAdvancedMode(): boolean {
  // Truthy only for the explicit opt-in value so a stale '0'/'false' reads OFF.
  return ls(ADVANCED_MODE_KEY) === '1';
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

function loadStringSet(key: string): Set<string> {
  try {
    const stored = ls(key);
    if (stored) {
      const parsed: unknown = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        return new Set(
          parsed.filter((v): v is string => typeof v === 'string')
        );
      }
    }
  } catch {
    /* unavailable */
  }
  return new Set();
}

/**
 * #1287 slice 5: the rail's fold record. PRESENCE of an id is the "the operator
 * has decided about this row" mark and the VALUE is the decision, so an
 * untouched row keeps its structural default (roots open, nested rows closed)
 * while a touched row keeps exactly what the operator left. That single map
 * removes the need for a separate "seeded roots" ledger: a collapsed root is
 * `false` here forever, so no amount of nav-model churn can re-expand it.
 */
function loadTopicRailExpansion(): Record<string, boolean> {
  try {
    const stored = ls(TOPIC_RAIL_EXPANSION_KEY);
    if (stored) {
      const parsed: unknown = JSON.parse(stored);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const entries = Object.entries(parsed as Record<string, unknown>)
          .filter((entry): entry is [string, boolean] => {
            return typeof entry[1] === 'boolean';
          })
          .slice(-MAX_TOPIC_RAIL_FOLDS);
        return Object.fromEntries(entries);
      }
    }
  } catch {
    /* unavailable */
  }
  return {};
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
  if (
    typeof value.activeFilePath === 'string' ||
    value.activeFilePath === null
  ) {
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
  const placements: Partial<Record<UtilityRailTab, UtilitySurfacePlacement>> =
    {};
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

  const anchoredPaneWidths = normalizeAnchoredPaneWidths(
    value.anchoredPaneWidths
  );
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

  const utilityTerminalIds = normalizeUtilityTerminalIds(
    value.utilityTerminalIds
  );
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

function syncSelectedUtilityTerminal(state: WorkspaceUtilityRailState): void {
  const ids = state.utilityTerminalIds ?? [];
  if (ids.length === 0) {
    delete state.utilityTerminalIds;
    delete state.selectedUtilityTerminalId;
    return;
  }
  if (
    !state.selectedUtilityTerminalId ||
    !ids.includes(state.selectedUtilityTerminalId)
  ) {
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

/**
 * #1303: the repo anchor of the routing statement that opened the CURRENT
 * composer — a lane the operator just selected, or the channel row they just
 * opened — carried together with the lane it came from.
 *
 * Deliberately not another `activeRepoPath`: that pointer is persisted, is
 * written by repo-dashboard navigation, and cannot say WHO wrote it — so it can
 * never answer "did the operator just choose a lane?". This one is
 * session-transient (no localStorage slot) because the intent it records is,
 * and it is keyed by `workspaceId` so it self-invalidates the moment the active
 * lane moves somewhere else instead of following the operator into a lane it
 * was never about.
 *
 * SINGLE-USE. It is written immediately before the composer opens and spent
 * when that composer goes away (`setTopicComposerOpen(false)`, below) or when a
 * create commits. A stamp that outlived its composer would keep outranking
 * session context on every later create in the same lane — including creates
 * the operator reached from the command palette without touching a lane at all
 * — which is a different, louder bug than the one it fixes.
 */
export interface LaneRepoRouting {
  workspaceId: string;
  repoPath: string;
}

/**
 * One-use project choice made by a creation affordance. Unlike a lane repo
 * anchor, this stays meaningful when the project deliberately has no repo and
 * carries the node default that must outrank an unrelated active terminal.
 */
export interface ProjectCreateRouting {
  workspaceId: string;
  repoPath: string | null;
  nodeId: string | null;
}

// ── State interface ────────────────────────────────────────────────────────
export interface UiState {
  sidebarOpen: boolean;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  searchQuery: string;
  activeRepoPath: string | null;
  activeWorkspaceId: string | null;
  laneRepoRouting: LaneRepoRouting | null;
  projectCreateRouting: ProjectCreateRouting | null;
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
  /**
   * #338: editor unsaved-changes flag per code file tab, keyed by
   * `fileTabKey(filePath, tabType)`. Drives the close-tab discard confirmation
   * and the "unsaved" tab pill. Separate from `OpenFileTab.isChanged`, which is
   * the git working-tree status, not editor dirtiness.
   */
  codeTabDirty: Record<string, boolean>;
  /**
   * #338: pending editor text per dirty code file tab, keyed by
   * `fileTabKey(filePath, tabType)`, so unsaved CodeMirror buffers survive tab
   * component remounts until save, reload-disk, or confirmed close.
   */
  codeTabPendingContent: Record<string, string>;
  sendToTargetSessionId: string | null;
  lastChangedFiles: string[];
  analyticsView: AnalyticsView;
  orgDashboardTab: OrgDashboardTab;
  /** One-shot, repo-scoped handoff into an existing RepoDashboard tab. */
  repoDashboardTabIntent: RepoDashboardTabIntent | null;
  /**
   * #1058: the chat/topic spine is the default no-session/no-repo landing.
   * The legacy WorkContext cockpit (`OrgDashboard`) stays reachable via the
   * "open work cockpit" command-palette action, which sets this flag so
   * `resolveAppViewMode` routes there instead of the chat home/session shell.
   * Session-transient; never persisted.
   */
  forceOrgCockpit: boolean;
  /**
   * #1058: the main-pane topic composer is open. Set by openTopicTaskRoom()
   * so `resolveAppViewMode` shows the chat landing WITHOUT clearing the
   * active session/repo selection — the composer inherits that context as
   * its routing defaults. Cleared when a session becomes active (launch or
   * sidebar selection). Session-transient; never persisted.
   */
  topicComposerOpen: boolean;
  /**
   * #1166: the id of the channel (persisted workspace_topic) currently open in
   * the main chat pane. Takes priority over topicComposerOpen and any active
   * terminal session. Mutually exclusive with an active session (App.tsx clears
   * one when the other is set). Session-transient; never persisted.
   */
  activeChannelId: string | null;
  /** #1170: currently open channel thread. Session-transient; never persisted. */
  activeThreadRootId: ChannelMessageId | null;
  /**
   * #1287 slice 5 item 18: a rail click asking a channel to open WITH one of its
   * threads already showing. It cannot be expressed as `activeThreadRootId`
   * directly — `setActiveChannelId` clears that field, and `ChannelView` clears
   * it again on every channel switch, so a value written alongside the channel
   * open is always destroyed before the panel mounts. This is the intent
   * `ChannelView` consumes once it is the channel in question, mirroring
   * `repoDashboardTabIntent`. Session-transient; never persisted.
   */
  pendingChannelThread: {
    channelId: string;
    rootMessageId: ChannelMessageId;
  } | null;
  /**
   * #1308 slice 1: a `#msg-…` deep link (or, later, a search result) asking a
   * channel to open scrolled to ONE message. Same shape and lifecycle as
   * `pendingChannelThread` and for the same reason — the target row does not
   * exist yet when the channel open is written, and it may still be outside the
   * loaded history window when `ChannelView` mounts. `ChannelView` consumes the
   * intent once and owns the bounded backfill walk that resolves it.
   * Session-transient; never persisted.
   */
  pendingChannelMessage: {
    channelId: string;
    messageId: ChannelMessageId;
  } | null;
  activeModal: ActiveModal;
  collapsedWorkspaces: Set<string>;
  /**
   * #1287 slice 5: per-topic fold state for the desktop chat rail, backed by
   * localStorage. Only ids the operator has actually toggled are recorded;
   * `selectExpandedRailIds()` supplies the structural default for the rest.
   */
  topicRailExpansion: Record<string, boolean>;
  /**
   * #1287 slice 5: workspace-group ids the operator folded in the mobile
   * cockpit, backed by localStorage. Groups default to expanded.
   */
  collapsedTopicGroups: Set<string>;
  /**
   * #1058: hides mechanics-heavy substrate surfaces (nodes/active-work tabs
   * in the work cockpit, sidebar analytics icon) from primary chrome.
   * Default false; backed by localStorage. Each gated surface stays
   * reachable one-off via a command-palette action regardless of this flag.
   */
  advancedMode: boolean;

  // Actions
  openSidebar: () => void;
  closeSidebar: () => void;
  saveSidebarWidth: () => void;
  toggleSidebarCollapsed: () => void;
  saveTerminalFontSize: () => void;
  setActiveRepoPath: (v: string | null) => void;
  setActiveWorkspaceId: (id: string | null) => void;
  setLaneRepoRouting: (routing: LaneRepoRouting | null) => void;
  setProjectCreateRouting: (routing: ProjectCreateRouting | null) => void;
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
  /** #338: mark/clear a code tab's editor unsaved state. */
  setCodeTabDirty: (
    filePath: string,
    tabType: FileTabType | undefined,
    dirty: boolean,
    pendingContent?: string
  ) => void;
  openHtmlTab: (filePath: string, token: string) => void;
  refreshHtmlTab: (filePath: string) => void;
  setRightSidebarTab: (tab: RightSidebarTab) => void;
  setFileDiffSource: (source: 'working' | 'staged' | 'branch') => void;
  setFileDiffDefaultBranch: (branch: string) => void;
  setLastChangedFiles: (files: string[]) => void;
  setAnalyticsView: (v: AnalyticsView) => void;
  setOrgDashboardTab: (tab: OrgDashboardTab) => void;
  requestRepoDashboardTab: (repoPath: string, tab: RepoDashboardTab) => void;
  consumeRepoDashboardTabIntent: (repoPath: string) => void;
  setForceOrgCockpit: (v: boolean) => void;
  setTopicComposerOpen: (v: boolean) => void;
  setActiveChannelId: (v: string | null) => void;
  setActiveThreadRootId: (v: ChannelMessageId | null) => void;
  /** #1287 item 18: ask `channelId` to open with `rootMessageId`'s thread shown. */
  requestChannelThread: (
    channelId: string,
    rootMessageId: ChannelMessageId
  ) => void;
  /** Drop the pending intent once the target channel has consumed it. */
  consumeChannelThreadIntent: (channelId: string) => void;
  /** #1308 item 1: ask `channelId` to open scrolled to `messageId`. */
  requestChannelMessage: (
    channelId: string,
    messageId: ChannelMessageId
  ) => void;
  /** Drop the pending anchor once the target channel has consumed it. */
  consumeChannelMessageIntent: (channelId: string) => void;
  setActiveModal: (v: ActiveModal) => void;
  toggleWorkspaceCollapse: (path: string) => void;
  isWorkspaceCollapsed: (path: string) => boolean;
  setTopicRailExpanded: (topicId: string, expanded: boolean) => void;
  toggleTopicGroupCollapsed: (workspaceId: string) => void;
  setAdvancedMode: (enabled: boolean) => void;
  toggleAdvancedMode: () => void;
}

export const useUiStore = create<UiState>()((set, get) => ({
  sidebarOpen: false,
  sidebarWidth: loadSidebarWidth(),
  sidebarCollapsed: ls(SIDEBAR_COLLAPSED_KEY) === 'true',
  searchQuery: '',
  activeRepoPath: ls(ACTIVE_WORKSPACE_KEY),
  activeWorkspaceId: loadPersistedActiveWorkspaceId(),
  // #1303: no `ls(...)` here on purpose — see `LaneRepoRouting`. A reload has
  // no "just selected" lane, so a fresh tab starts with session inheritance.
  laneRepoRouting: null,
  projectCreateRouting: null,
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
  codeTabDirty: {},
  codeTabPendingContent: {},
  sendToTargetSessionId: null,
  analyticsView: null,
  // #1058: 'active-work' is a substrate tab hidden unless advancedMode is on;
  // default to 'prs' so a fresh session never lands on a hidden tab's content.
  orgDashboardTab: loadAdvancedMode() ? 'active-work' : 'prs',
  repoDashboardTabIntent: null,
  forceOrgCockpit: false,
  topicComposerOpen: false,
  activeChannelId: null,
  activeThreadRootId: null,
  pendingChannelThread: null,
  pendingChannelMessage: null,
  activeModal: null,
  lastChangedFiles: [],
  collapsedWorkspaces: loadStringSet(COLLAPSED_WORKSPACES_KEY),
  topicRailExpansion: loadTopicRailExpansion(),
  collapsedTopicGroups: loadStringSet(COLLAPSED_TOPIC_GROUPS_KEY),
  advancedMode: loadAdvancedMode(),

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

  setLaneRepoRouting: (routing) => set({ laneRepoRouting: routing }),
  setProjectCreateRouting: (routing) => set({ projectCreateRouting: routing }),

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
        const current = normalizeReviewState(
          state.review,
          state.reviewFilePath
        );
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
          currentHunkIndex: shouldResetHunkIndex
            ? -1
            : current.currentHunkIndex,
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
        const current = normalizeReviewState(
          state.review,
          state.reviewFilePath
        );
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
        const current = normalizeReviewState(
          state.review,
          state.reviewFilePath
        );
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
        const current = normalizeReviewState(
          state.review,
          state.reviewFilePath
        );
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
        const current = normalizeReviewState(
          state.review,
          state.reviewFilePath
        );
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
        state.utilityTerminalIds = (state.utilityTerminalIds ?? []).filter(
          (id) => liveTerminalSessionIds.has(id)
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
  setOrgDashboardTab: (tab) => set({ orgDashboardTab: tab }),
  requestRepoDashboardTab: (repoPath, tab) =>
    set({ repoDashboardTabIntent: { repoPath, tab } }),
  consumeRepoDashboardTabIntent: (repoPath) => {
    if (get().repoDashboardTabIntent?.repoPath === repoPath) {
      set({ repoDashboardTabIntent: null });
    }
  },
  setForceOrgCockpit: (v) => set({ forceOrgCockpit: v }),
  // #1303: closing the composer SPENDS the lane stamp. The stamp means "the
  // routing statement that opened THIS composer", and every way out of the
  // composer runs through here — Escape, a channel/URL/notification navigation,
  // a launch that selects a session. Enforced in the setter rather than asked
  // of each caller because the bug this guards against is precisely a caller
  // that forgets: the eight existing exits would each have to remember, and the
  // ninth would not. Opening never clears — `openTopicTaskRoom` runs AFTER the
  // stamp is written.
  setTopicComposerOpen: (v) =>
    set(
      v
        ? { topicComposerOpen: true }
        : {
            topicComposerOpen: false,
            laneRepoRouting: null,
            projectCreateRouting: null,
          }
    ),
  setActiveChannelId: (v) =>
    set({
      activeChannelId: v,
      activeThreadRootId: null,
      // A plain channel open cancels any un-consumed thread intent, so a
      // never-mounted target (deleted channel, cancelled navigation) can't fire
      // as a surprise thread panel later. `requestChannelThread` is always
      // called AFTER the channel open, so the rail's own path is unaffected.
      pendingChannelThread: null,
      // Same contract for the #1308 message anchor: a deep link writes the
      // channel open first and the anchor second, so clearing here only ever
      // discards an anchor whose channel never mounted.
      pendingChannelMessage: null,
      // #1287: an open channel outranks `forceOrgCockpit` in resolveAppViewMode,
      // so a channel activation must also drop the one-off cockpit escape hatch
      // (as sessions.setActiveSessionId does) — otherwise a latched flag fires
      // as a surprise cockpit navigation when the channel is later closed.
      ...(v !== null ? { forceOrgCockpit: false } : {}),
    }),
  setActiveThreadRootId: (v) => set({ activeThreadRootId: v }),
  requestChannelThread: (channelId, rootMessageId) =>
    set({ pendingChannelThread: { channelId, rootMessageId } }),
  consumeChannelThreadIntent: (channelId) => {
    if (get().pendingChannelThread?.channelId !== channelId) return;
    set({ pendingChannelThread: null });
  },
  requestChannelMessage: (channelId, messageId) =>
    set({ pendingChannelMessage: { channelId, messageId } }),
  consumeChannelMessageIntent: (channelId) => {
    if (get().pendingChannelMessage?.channelId !== channelId) return;
    set({ pendingChannelMessage: null });
  },
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
    const {
      openFileTabs,
      activeFileTabKey,
      codeTabDirty,
      codeTabPendingContent,
    } = get();
    const removed = tabType
      ? openFileTabs.filter(
          (t) => t.filePath === filePath && t.tabType === tabType
        )
      : openFileTabs.filter((t) => t.filePath === filePath);
    // #338: confirm before discarding a code tab with unsaved editor changes.
    // Bail without mutating so the layout reconciler re-adds the survivor tab.
    const removedKeys = removed.map((t) => fileTabKey(t.filePath, t.tabType));
    const hasDirty = removedKeys.some((k) => codeTabDirty[k]);
    if (
      hasDirty &&
      typeof window !== 'undefined' &&
      typeof window.confirm === 'function' &&
      !window.confirm('discard unsaved changes to this file?')
    ) {
      return;
    }
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
    let nextDirty = codeTabDirty;
    if (removedKeys.some((k) => k in codeTabDirty)) {
      nextDirty = { ...codeTabDirty };
      for (const k of removedKeys) delete nextDirty[k];
    }
    let nextPendingContent = codeTabPendingContent;
    if (removedKeys.some((k) => k in codeTabPendingContent)) {
      nextPendingContent = { ...codeTabPendingContent };
      for (const k of removedKeys) delete nextPendingContent[k];
    }
    set({
      openFileTabs: next,
      activeFileTabKey: newActiveKey,
      codeTabDirty: nextDirty,
      codeTabPendingContent: nextPendingContent,
    });
  },

  setCodeTabDirty: (filePath, tabType, dirty, pendingContent) => {
    const { codeTabDirty, codeTabPendingContent } = get();
    const key = fileTabKey(filePath, tabType);
    const hasPendingContent = key in codeTabPendingContent;
    const pendingChanged =
      pendingContent !== undefined &&
      codeTabPendingContent[key] !== pendingContent;
    if (
      Boolean(codeTabDirty[key]) === dirty &&
      !pendingChanged &&
      (dirty || !hasPendingContent)
    )
      return;
    const next = { ...codeTabDirty };
    const nextPendingContent = { ...codeTabPendingContent };
    if (dirty) next[key] = true;
    else delete next[key];
    if (dirty && pendingContent !== undefined) {
      nextPendingContent[key] = pendingContent;
    } else if (!dirty) {
      delete nextPendingContent[key];
    }
    set({ codeTabDirty: next, codeTabPendingContent: nextPendingContent });
  },

  closeAllFileTabs: () => {
    const { codeTabDirty } = get();
    const hasDirty = Object.values(codeTabDirty).some(Boolean);
    if (
      hasDirty &&
      typeof window !== 'undefined' &&
      typeof window.confirm === 'function' &&
      !window.confirm('discard unsaved changes to all open files?')
    ) {
      return;
    }
    set({
      openFileTabs: [],
      activeFileTabKey: null,
      codeTabDirty: {},
      codeTabPendingContent: {},
    });
  },

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

  setTopicRailExpanded: (topicId, expanded) => {
    const current = get().topicRailExpansion;
    // Identity must not churn on a no-op write: the rail derives a memoized Set
    // from this record and would re-render every row.
    if (current[topicId] === expanded) return;
    const next = { ...current };
    // Re-insert last so key order doubles as recency for the cap below.
    delete next[topicId];
    next[topicId] = expanded;
    const ids = Object.keys(next);
    for (const stale of ids.slice(
      0,
      Math.max(0, ids.length - MAX_TOPIC_RAIL_FOLDS)
    )) {
      delete next[stale];
    }
    lsSave(TOPIC_RAIL_EXPANSION_KEY, JSON.stringify(next));
    set({ topicRailExpansion: next });
  },

  toggleTopicGroupCollapsed: (workspaceId) => {
    const next = new Set(get().collapsedTopicGroups);
    if (next.has(workspaceId)) next.delete(workspaceId);
    else next.add(workspaceId);
    lsSave(COLLAPSED_TOPIC_GROUPS_KEY, JSON.stringify(Array.from(next)));
    set({ collapsedTopicGroups: next });
  },

  setAdvancedMode: (enabled) => {
    if (enabled) lsSave(ADVANCED_MODE_KEY, '1');
    else lsRemove(ADVANCED_MODE_KEY);
    // #1058: correct away from a substrate tab the moment advanced mode is
    // turned off, so the work cockpit never lingers on a now-hidden tab —
    // one-off palette deep links set the tab afresh and aren't affected by
    // this (they run after advancedMode is already settled).
    const current = get().orgDashboardTab;
    const fallbackTab =
      !enabled && (current === 'active-work' || current === 'nodes')
        ? 'prs'
        : current;
    set({ advancedMode: enabled, orgDashboardTab: fallbackTab });
  },
  toggleAdvancedMode: () => {
    get().setAdvancedMode(!get().advancedMode);
  },
}));
