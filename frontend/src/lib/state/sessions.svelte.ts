import type { SessionSummary, WorktreeInfo, Repo, SidebarItem } from '../types.js';
import { fireNotification, shouldFireNotification } from '../notifications.js';
import * as api from '../api.js';
import type { BackendDisplayState } from './display-state.js';
import { transitionDisplayState, shouldNotify } from './display-state.js';
import { buildSidebarItems } from './sidebar-items.js';

const NOTIFICATIONS_STORAGE_KEY = 'claude-remote-notifications';
const ACTIVE_SESSION_KEY = 'claude-remote-active-session';

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

let sessions = $state<SessionSummary[]>([]);
let worktrees = $state<WorktreeInfo[]>([]);
let repos = $state<Repo[]>([]);
let activeSessionId = $state<string | null>(loadActiveSessionId());
let loadingItems = $state<Record<string, boolean>>({});
let notificationSessions = $state<Record<string, boolean>>({});
let sidebarItems = $state<SidebarItem[]>([]);

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

export function getSessionState() {
  return {
    get sessions() { return sessions; },
    get worktrees() { return worktrees; },
    get repos() { return repos; },
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

export async function refreshAll(): Promise<void> {
  const [sResult, wResult, wsResult] = await Promise.allSettled([
    api.fetchSessions(),
    api.fetchWorktrees(),
    api.fetchWorkspaces(),
  ]);

  if (sResult.status === 'fulfilled') sessions = sResult.value;
  else console.error('[refreshAll] failed to fetch sessions:', sResult.reason);

  if (wResult.status === 'fulfilled') worktrees = wResult.value;
  else console.error('[refreshAll] failed to fetch worktrees:', wResult.reason);

  if (wsResult.status === 'fulfilled') repos = wsResult.value;
  else console.error('[refreshAll] failed to fetch repos:', wsResult.reason);

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

  // Rebuild sidebar items, reconciling displayState against existing items
  sidebarItems = buildSidebarItems(sessions, worktrees, repos, sidebarItems);
}

export function getSessionsForRepo(repoPath: string): SessionSummary[] {
  return sessions.filter(s => s.repoPath === repoPath);
}

export function renameSession(sessionId: string, branchName: string, displayName: string): void {
  const session = sessions.find(s => s.id === sessionId);
  if (session) {
    session.branchName = branchName;
    session.displayName = displayName;
  }
}

export function handleBackendStateChanged(sessionId: string, backendState: BackendDisplayState): void {
  // Keep session fields in sync so that refreshAll()/buildSidebarItems() reconciliation
  // sees the latest state if a full refresh arrives while real-time events are in flight.
  const session = sessions.find(s => s.id === sessionId);
  if (session) {
    session.idle = backendState === 'idle';
    switch (backendState) {
      case 'running':      session.agentState = 'processing'; break;
      case 'idle':         session.agentState = 'idle'; break;
      case 'permission':   session.agentState = 'permission-prompt'; break;
      case 'initializing': session.agentState = 'initializing'; break;
    }
  }

  // Find the SidebarItem containing this session
  const item = sidebarItems.find(i => i.sessions.some(s => s.id === sessionId));
  if (!item) return;

  // Update lastKnownBackendState
  const oldDisplayState = item.displayState;
  item.lastKnownBackendState = backendState;

  // Apply transition
  const newDisplayState = transitionDisplayState(item.displayState, { type: 'backend-state-changed', state: backendState });
  if (newDisplayState !== oldDisplayState) {
    item.displayState = newDisplayState;

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
