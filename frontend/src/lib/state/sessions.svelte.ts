import type { CurrentActivity, SessionSummary, WorktreeInfo, Repo, SidebarItem, Workspace } from '../types.js';
import { fireNotification, shouldFireNotification } from '../notifications.js';
import * as api from '../api.js';
import type { BackendDisplayState } from './display-state.js';
import { transitionDisplayState, shouldNotify } from './display-state.js';
import { buildSidebarItems, deriveBackendState } from './sidebar-items.js';
import { shouldMarkUnread } from './unread-logic.js';
import { isUnread, markUnread, markRead, pruneUnread } from './unread.svelte.js';

const NOTIFICATIONS_STORAGE_KEY = 'claude-remote-notifications';
const ACTIVE_SESSION_KEY = 'claude-remote-active-session';
const WORKSPACE_SESSIONS_KEY = 'claude-remote-workspace-sessions';

function loadActiveSessionId(): string | null {
  try { return localStorage.getItem(ACTIVE_SESSION_KEY); }
  catch { return null; }
}

function saveActiveSessionId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(ACTIVE_SESSION_KEY);
    else localStorage.setItem(ACTIVE_SESSION_KEY, id);
  } catch { /* localStorage unavailable */ }
}

function loadWorkspaceSessions(): Record<string, string> {
  try {
    const stored = localStorage.getItem(WORKSPACE_SESSIONS_KEY);
    if (stored) return JSON.parse(stored);
  } catch { /* localStorage unavailable */ }
  return {};
}

function saveWorkspaceSessions(): void {
  try {
    localStorage.setItem(WORKSPACE_SESSIONS_KEY, JSON.stringify(workspaceLastSession));
  } catch { /* localStorage unavailable */ }
}

let sessions = $state<SessionSummary[]>([]);
let worktrees = $state<WorktreeInfo[]>([]);
let repos = $state<Repo[]>([]);
let workspaceGroups = $state<Workspace[]>([]);
let activeSessionId = $state<string | null>(loadActiveSessionId());
let workspaceLastSession: Record<string, string> = loadWorkspaceSessions();
let loadingItems = $state<Record<string, boolean>>({});
let notificationSessions = $state<Record<string, boolean>>({});
let sidebarItems = $state<SidebarItem[]>([]);
let enrichmentResults = $state<Record<string, { pr: import('../types.js').PrInfo | null; stale: boolean }>>({});

function loadNotificationPrefs(): void {
  try {
    const stored = localStorage.getItem(NOTIFICATIONS_STORAGE_KEY);
    if (stored) notificationSessions = JSON.parse(stored);
  } catch { /* localStorage unavailable */ }
}

loadNotificationPrefs();

function saveNotificationPrefs(): void {
  try {
    localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, JSON.stringify(notificationSessions));
  } catch { /* localStorage unavailable */ }
}

export function rememberSessionForWorkspace(workspacePath: string, sessionId: string): void {
  workspaceLastSession[workspacePath] = sessionId;
  saveWorkspaceSessions();
}

export function recallSessionForWorkspace(workspacePath: string): string | null {
  const id = workspaceLastSession[workspacePath];
  if (!id) return null;
  // Only return if session still exists
  const exists = sessions.some(s => s.id === id);
  if (!exists) {
    delete workspaceLastSession[workspacePath];
    saveWorkspaceSessions();
    return null;
  }
  return id;
}

export function getSessionState() {
  return {
    get sessions() { return sessions; },
    get worktrees() { return worktrees; },
    get repos() { return repos; },
    get workspaceGroups() { return workspaceGroups; },
    get activeSessionId() { return activeSessionId; },
    set activeSessionId(id: string | null) {
      activeSessionId = id;
      saveActiveSessionId(id);
    },
    get loadingItems() { return loadingItems; },
    get notificationSessions() { return notificationSessions; },
    get sidebarItems() { return sidebarItems; },
  };
}

export type FetchReporter = (
  service: string,
  status: 'loading' | 'ok' | 'fail',
  opts?: { summary?: string; durationMs?: number; error?: string },
) => void;

const BOOT_FETCH_TIMEOUT_MS = 10_000;

async function timed<T>(
  service: string,
  fn: () => Promise<T>,
  summarize: (v: T) => string,
  report?: FetchReporter,
): Promise<PromiseSettledResult<T>> {
  report?.(service, 'loading');
  const start = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await (report
      ? Promise.race([
          fn(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('timeout')), BOOT_FETCH_TIMEOUT_MS);
          }),
        ])
      : fn());
    clearTimeout(timer);
    report?.(service, 'ok', { summary: summarize(value), durationMs: Math.round(performance.now() - start) });
    return { status: 'fulfilled' as const, value };
  } catch (reason) {
    clearTimeout(timer);
    const errorMsg = reason instanceof Error ? reason.message : String(reason);
    report?.(service, 'fail', { error: errorMsg, durationMs: Math.round(performance.now() - start) });
    return { status: 'rejected' as const, reason };
  }
}

/** Batch-enrich all sidebar worktree branches with PR + staleness data from /gh/enrich-branches. */
export async function enrichSidebarBranches(): Promise<void> {
  const branches = worktrees.map(wt => ({ repoPath: wt.repoPath, branchName: wt.branchName }));
  if (branches.length === 0) return;
  try {
    const data = await api.enrichBranches(branches);
    enrichmentResults = data.results;
  } catch (err) {
    console.warn('[enrichSidebarBranches] failed:', err);
  }
}

export function getEnrichment(repoPath: string, branchName: string): { pr: import('../types.js').PrInfo | null; stale: boolean } | undefined {
  return enrichmentResults[`${repoPath}::${branchName}`];
}

export async function refreshAll(report?: FetchReporter): Promise<void> {
  const [sResult, wResult, wsResult, wgResult] = await Promise.all([
    timed('sessions', api.fetchSessions, v => `${v.length} active`, report),
    timed('worktrees', () => api.fetchWorktrees(), v => `${v.length} ${v.length === 1 ? 'tree' : 'trees'}`, report),
    timed('workspaces', api.fetchWorkspaces, v => `${v.length} ${v.length === 1 ? 'repo' : 'repos'}`, report),
    timed('groups', api.fetchWorkspaceGroups, v => `${v.length} ${v.length === 1 ? 'group' : 'groups'}`, report),
  ]);

  if (sResult.status === 'fulfilled') sessions = sResult.value;
  else console.error('[refreshAll] failed to fetch sessions:', sResult.reason);

  if (wResult.status === 'fulfilled') worktrees = wResult.value;
  else console.error('[refreshAll] failed to fetch worktrees:', wResult.reason);

  if (wsResult.status === 'fulfilled') repos = wsResult.value;
  else console.error('[refreshAll] failed to fetch repos:', wsResult.reason);

  if (wgResult.status === 'fulfilled') workspaceGroups = wgResult.value;
  else console.error('[refreshAll] failed to fetch workspace groups:', wgResult.reason);

  // Validate restored activeSessionId — clear if the session no longer exists
  const activeIds = new Set(sessions.map(sess => sess.id));
  if (activeSessionId !== null && !activeIds.has(activeSessionId)) {
    activeSessionId = null;
    saveActiveSessionId(null);
  }

  // Prune stale notification prefs
  let notifPruned = false;
  for (const id of Object.keys(notificationSessions)) {
    if (!activeIds.has(id)) {
      delete notificationSessions[id];
      notifPruned = true;
    }
  }
  if (notifPruned) saveNotificationPrefs();

  // Prune stale workspace-session mappings
  let wsPruned = false;
  for (const [path, id] of Object.entries(workspaceLastSession)) {
    if (!activeIds.has(id)) {
      delete workspaceLastSession[path];
      wsPruned = true;
    }
  }
  if (wsPruned) saveWorkspaceSessions();

  // Rebuild sidebar items, reconciling displayState against existing items
  sidebarItems = buildSidebarItems(sessions, worktrees, repos, sidebarItems, isUnread);

  // Prune stale unread entries from localStorage
  pruneUnread(new Set(sidebarItems.map(i => i.id)));
}

export function getSessionsForRepo(repoPath: string): SessionSummary[] {
  return sessions.filter(s => s.repoPath === repoPath);
}

export function getSessionsForWorkspaceGroup(workspaceId: string): SessionSummary[] {
  const directSessions = sessions.filter(s => s.workspaceId === workspaceId);
  const workspace = workspaceGroups.find(w => w.id === workspaceId);
  if (!workspace) return directSessions;
  const repoSet = new Set(workspace.repos);
  const repoSessions = sessions.filter(s => !s.workspaceId && repoSet.has(s.repoPath));
  return [...directSessions, ...repoSessions];
}

export function renameSession(sessionId: string, branchName: string, displayName: string): void {
  const session = sessions.find(s => s.id === sessionId);
  if (session) {
    session.branchName = branchName;
    session.displayName = displayName;
  }
}

export function handleBranchChanged(sessionId: string, branch: string): void {
  const session = sessions.find(s => s.id === sessionId);
  if (session) {
    session.branchName = branch;
  } else {
    console.debug('[sessions] handleBranchChanged: session not found', sessionId);
  }

  const item = sidebarItems.find(i => i.sessions.some(s => s.id === sessionId));
  if (item) {
    item.branchName = branch;
  } else {
    console.debug('[sessions] handleBranchChanged: sidebar item not found for session', sessionId);
  }
}

export function handleActivityChanged(sessionId: string, timestamp?: string, currentActivity?: CurrentActivity | null): void {
  const now = timestamp || new Date().toISOString();
  const session = sessions.find(s => s.id === sessionId);
  if (session) {
    session.lastActivity = now;
    if (currentActivity !== undefined) {
      session.currentActivity = currentActivity ?? undefined;
    }
  }
  const item = sidebarItems.find(i => i.sessions.some(s => s.id === sessionId));
  if (item) item.lastActivity = now;
}

export function handleBackendStateChanged(sessionId: string, backendState: BackendDisplayState, permissionType?: 'approval' | 'question'): void {
  // Keep session fields in sync so that refreshAll()/buildSidebarItems() reconciliation
  // sees the latest state if a full refresh arrives while real-time events are in flight.
  const session = sessions.find(s => s.id === sessionId);
  if (session) {
    session.idle = backendState === 'idle';
    switch (backendState) {
      case 'running':      session.agentState = 'processing'; break;
      case 'idle':         session.agentState = 'idle'; break;
      case 'permission':   session.agentState = 'permission-prompt'; break;
      case 'error':        session.agentState = 'error'; break;
      case 'initializing': session.agentState = 'initializing'; break;
    }
  }

  // Find the SidebarItem containing this session
  const item = sidebarItems.find(i => i.sessions.some(s => s.id === sessionId));
  if (!item) return;

  // Re-derive the aggregate backend state from ALL sessions in the group
  // (the individual session's fields were already updated above).
  // Using the single session's state would be wrong for multi-session groups:
  // one session going idle shouldn't flip the group to idle if another is still running.
  const aggregateState = deriveBackendState(item.sessions);

  // If the aggregate hasn't changed, no transition needed. This prevents spurious
  // transitions (e.g., needs-answer → permission when a non-permission session changes
  // state but the group's highest-priority state remains permission without permissionType).
  if (aggregateState === item.lastKnownBackendState) return;

  const oldDisplayState = item.displayState;
  item.lastKnownBackendState = aggregateState;

  // Apply transition using the aggregate state.
  // Only pass permissionType when the aggregate state is 'permission' and the
  // triggering event provided it (i.e., this session is the one driving the permission state).
  const effectivePermissionType = aggregateState === 'permission' ? permissionType : undefined;
  const newDisplayState = transitionDisplayState(
    item.displayState,
    effectivePermissionType
      ? { type: 'backend-state-changed' as const, state: aggregateState, permissionType: effectivePermissionType }
      : { type: 'backend-state-changed' as const, state: aggregateState },
  );
  if (newDisplayState !== oldDisplayState) {
    item.displayState = newDisplayState;

    // Track unread — mark unread unless the user is viewing a session in this group
    const isViewing = item.sessions.some(s => s.id === activeSessionId);
    if (shouldMarkUnread(oldDisplayState, newDisplayState, isViewing)) {
      markUnread(item.id);
      item.isUnread = true;
    }

    // Fire notification if appropriate
    if (shouldNotify(oldDisplayState, newDisplayState)) {
      // Prefer the session that triggered this event; fall back to any with notifications enabled
      const notifySession = item.sessions.find(s => s.id === sessionId)
        ?? item.sessions.find(s => notificationSessions[s.id]);
      if (notifySession && notificationSessions[notifySession.id] && shouldFireNotification()) {
        fireNotification(notifySession);
      }
    }
  }
}

export function handleUserViewed(sessionId: string): void {
  // Find the SidebarItem containing this session
  const item = sidebarItems.find(i => i.sessions.some(s => s.id === sessionId));
  if (item) {
    item.displayState = transitionDisplayState(item.displayState, { type: 'user-viewed' });
    markRead(item.id);
    item.isUnread = false;
  }
}

export function setNotificationEnabled(sessionId: string, enabled: boolean): void {
  notificationSessions[sessionId] = enabled;
  saveNotificationPrefs();
}

export function initSessionNotification(sessionId: string, defaultEnabled: boolean): void {
  if (!(sessionId in notificationSessions)) {
    notificationSessions[sessionId] = defaultEnabled;
    saveNotificationPrefs();
  }
}

export function getNotificationSessionIds(): string[] {
  return Object.entries(notificationSessions)
    .filter(([, enabled]) => enabled)
    .map(([id]) => id);
}

export function setLoading(key: string): void {
  loadingItems[key] = true;
}

export function clearLoading(key: string): void {
  delete loadingItems[key];
}

export function isItemLoading(key: string): boolean {
  return !!loadingItems[key];
}

export async function reorderWorkspaces(paths: string[]): Promise<void> {
  const updated = await api.reorderWorkspaces(paths);
  repos = updated;
}
