import { create } from 'zustand';
import type {
  CurrentActivity,
  SessionSummary,
  WorktreeInfo,
  Repo,
  SidebarItem,
  Workspace,
} from '../types.js';
import { fireNotification, shouldFireNotification } from '../notifications.js';
import * as api from '../api.js';
import { createLogger } from '../logger.js';
import type { BackendDisplayState } from '../state/display-state.js';
import {
  transitionDisplayState,
  shouldNotify,
} from '../state/display-state.js';
import {
  buildSidebarItems,
  deriveBackendState,
} from '../state/sidebar-items.js';
import { shouldMarkUnread } from '../state/unread-logic.js';
import { useUnreadStore } from './unread.js';

const NOTIFICATIONS_STORAGE_KEY = 'claude-remote-notifications';
const ACTIVE_SESSION_KEY = 'claude-remote-active-session';
const WORKSPACE_SESSIONS_KEY = 'claude-remote-workspace-sessions';
const logger = createLogger('sessions');

const BOOT_FETCH_TIMEOUT_MS = 10_000;
export const DEFAULT_ENRICHMENT_TTL_MS = 600_000;

export type RepoEnrichmentSource = 'webhook' | 'manual';
export interface RepoEnrichmentMeta {
  lastEnrichedAt: number;
  source: RepoEnrichmentSource;
}

type BranchEnrichment = {
  pr: import('../types.js').PrInfo | null;
  stale: boolean;
};

// ── localStorage helpers ───────────────────────────────────────────────────
function loadActiveSessionId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_SESSION_KEY);
  } catch {
    return null;
  }
}

function saveActiveSessionId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(ACTIVE_SESSION_KEY);
    else localStorage.setItem(ACTIVE_SESSION_KEY, id);
  } catch {
    /* unavailable */
  }
}

function loadWorkspaceSessions(): Record<string, string> {
  try {
    const stored = localStorage.getItem(WORKSPACE_SESSIONS_KEY);
    if (stored) return JSON.parse(stored);
  } catch {
    /* unavailable */
  }
  return {};
}

function persistWorkspaceSessions(map: Record<string, string>): void {
  try {
    localStorage.setItem(WORKSPACE_SESSIONS_KEY, JSON.stringify(map));
  } catch {
    /* unavailable */
  }
}

function loadNotificationPrefs(): Record<string, boolean> {
  try {
    const stored = localStorage.getItem(NOTIFICATIONS_STORAGE_KEY);
    if (stored) return JSON.parse(stored);
  } catch {
    /* unavailable */
  }
  return {};
}

function saveNotificationPrefs(prefs: Record<string, boolean>): void {
  try {
    localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* unavailable */
  }
}

// ── Timed fetch helper ─────────────────────────────────────────────────────
export type FetchReporter = (
  service: string,
  status: 'loading' | 'ok' | 'fail',
  opts?: { summary?: string; durationMs?: number; error?: string }
) => void;

async function timed<T>(
  service: string,
  fn: () => Promise<T>,
  summarize: (v: T) => string,
  report?: FetchReporter
): Promise<PromiseSettledResult<T>> {
  report?.(service, 'loading');
  const start = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await (report
      ? Promise.race([
          fn(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('timeout')),
              BOOT_FETCH_TIMEOUT_MS
            );
          }),
        ])
      : fn());
    clearTimeout(timer);
    report?.(service, 'ok', {
      summary: summarize(value),
      durationMs: Math.round(performance.now() - start),
    });
    return { status: 'fulfilled' as const, value };
  } catch (reason) {
    clearTimeout(timer);
    const errorMsg = reason instanceof Error ? reason.message : String(reason);
    report?.(service, 'fail', {
      error: errorMsg,
      durationMs: Math.round(performance.now() - start),
    });
    return { status: 'rejected' as const, reason };
  }
}

// ── State interface ────────────────────────────────────────────────────────
export interface SessionsState {
  sessions: SessionSummary[];
  worktrees: WorktreeInfo[];
  repos: Repo[];
  workspaceGroups: Workspace[];
  activeSessionId: string | null;
  workspaceLastSession: Record<string, string>;
  loadingItems: Record<string, boolean>;
  notificationSessions: Record<string, boolean>;
  sidebarItems: SidebarItem[];
  enrichmentResults: Record<string, BranchEnrichment>;
  repoEnrichmentMeta: Record<string, RepoEnrichmentMeta>;
  reconnectingPtySessionId: string | null;
  // Actions
  setActiveSessionId: (id: string | null) => void;
  rememberSessionForWorkspace: (
    workspacePath: string,
    sessionId: string
  ) => void;
  recallSessionForWorkspace: (workspacePath: string) => string | null;
  enrichSidebarBranches: () => Promise<void>;
  ensureFresh: (repoPath: string, maxAgeMs?: number) => Promise<void>;
  ensureFreshAll: (maxAgeMs?: number) => Promise<void>;
  forceRefresh: (
    repoPath: string,
    source?: RepoEnrichmentSource
  ) => Promise<void>;
  getEnrichment: (
    repoPath: string,
    branchName: string
  ) => { pr: import('../types.js').PrInfo | null; stale: boolean } | undefined;
  refreshAll: (report?: FetchReporter) => Promise<void>;
  getSessionsForRepo: (repoPath: string) => SessionSummary[];
  getSessionsForWorkspaceGroup: (workspaceId: string) => SessionSummary[];
  renameSession: (
    sessionId: string,
    branchName: string,
    displayName: string
  ) => void;
  handleBranchChanged: (sessionId: string, branch: string) => void;
  handleActivityChanged: (
    sessionId: string,
    timestamp?: string,
    currentActivity?: CurrentActivity | null
  ) => void;
  handleBackendStateChanged: (
    sessionId: string,
    backendState: BackendDisplayState,
    permissionType?: 'approval' | 'question'
  ) => void;
  handleUserViewed: (sessionId: string) => void;
  setNotificationEnabled: (sessionId: string, enabled: boolean) => void;
  initSessionNotification: (sessionId: string, defaultEnabled: boolean) => void;
  getNotificationSessionIds: () => string[];
  setLoading: (key: string) => void;
  clearLoading: (key: string) => void;
  isItemLoading: (key: string) => boolean;
  reorderWorkspaces: (paths: string[]) => Promise<void>;
  beginPtyReconnect: (sessionId: string) => void;
  clearPtyReconnect: (sessionId?: string) => void;
}

function repoBranchEntriesFor(
  state: Pick<SessionsState, 'sessions' | 'worktrees'>,
  repoPath: string
): Array<{ repoPath: string; branchName: string }> {
  const seen = new Set<string>();
  const branches: Array<{ repoPath: string; branchName: string }> = [];
  const add = (branchName: string | null | undefined) => {
    if (!branchName) return;
    const key = `${repoPath}::${branchName}`;
    if (seen.has(key)) return;
    seen.add(key);
    branches.push({ repoPath, branchName });
  };

  for (const wt of state.worktrees) {
    if (wt.repoPath === repoPath) add(wt.branchName);
  }
  for (const session of state.sessions) {
    if (session.repoPath === repoPath) add(session.branchName);
  }
  return branches;
}

function visibleRepoPaths(
  state: Pick<SessionsState, 'repos' | 'sessions' | 'worktrees'>
): string[] {
  const paths = new Set<string>();
  for (const repo of state.repos) paths.add(repo.path);
  for (const wt of state.worktrees) paths.add(wt.repoPath);
  for (const session of state.sessions) paths.add(session.repoPath);
  return Array.from(paths);
}

export const useSessionsStore = create<SessionsState>()((set, get) => ({
  sessions: [],
  worktrees: [],
  repos: [],
  workspaceGroups: [],
  activeSessionId: loadActiveSessionId(),
  workspaceLastSession: loadWorkspaceSessions(),
  loadingItems: {},
  notificationSessions: loadNotificationPrefs(),
  sidebarItems: [],
  enrichmentResults: {},
  repoEnrichmentMeta: {},
  reconnectingPtySessionId: null,

  setActiveSessionId: (id) => {
    saveActiveSessionId(id);
    set({ activeSessionId: id });
  },

  rememberSessionForWorkspace: (workspacePath, sessionId) => {
    const next = { ...get().workspaceLastSession, [workspacePath]: sessionId };
    persistWorkspaceSessions(next);
    set({ workspaceLastSession: next });
  },

  recallSessionForWorkspace: (workspacePath) => {
    const { workspaceLastSession, sessions } = get();
    const id = workspaceLastSession[workspacePath];
    if (!id) return null;
    if (!sessions.some((s) => s.id === id)) {
      const next = { ...workspaceLastSession };
      delete next[workspacePath];
      persistWorkspaceSessions(next);
      set({ workspaceLastSession: next });
      return null;
    }
    return id;
  },

  enrichSidebarBranches: async () => {
    await get().ensureFreshAll(0);
  },

  ensureFresh: async (repoPath, maxAgeMs = DEFAULT_ENRICHMENT_TTL_MS) => {
    const meta = get().repoEnrichmentMeta[repoPath];
    if (meta && maxAgeMs > 0 && Date.now() - meta.lastEnrichedAt < maxAgeMs) {
      return;
    }
    await get().forceRefresh(repoPath, 'manual');
  },

  ensureFreshAll: async (maxAgeMs = DEFAULT_ENRICHMENT_TTL_MS) => {
    const repos = visibleRepoPaths(get());
    await Promise.all(repos.map((repoPath) => get().ensureFresh(repoPath, maxAgeMs)));
  },

  forceRefresh: async (repoPath, source = 'manual') => {
    const branches = repoBranchEntriesFor(get(), repoPath);
    if (branches.length === 0) {
      set((state) => ({
        repoEnrichmentMeta: {
          ...state.repoEnrichmentMeta,
          [repoPath]: { lastEnrichedAt: Date.now(), source },
        },
      }));
      return;
    }

    try {
      const data = await api.enrichBranches(branches);
      set((state) => {
        const prefix = `${repoPath}::`;
        const nextResults: Record<string, BranchEnrichment> = {};
        for (const [key, value] of Object.entries(state.enrichmentResults)) {
          if (!key.startsWith(prefix)) nextResults[key] = value;
        }
        return {
          enrichmentResults: { ...nextResults, ...data.results },
          repoEnrichmentMeta: {
            ...state.repoEnrichmentMeta,
            [repoPath]: { lastEnrichedAt: Date.now(), source },
          },
        };
      });
    } catch (err) {
      logger.warn('forceRefresh failed', err);
    }
  },

  getEnrichment: (repoPath, branchName) =>
    get().enrichmentResults[`${repoPath}::${branchName}`],

  refreshAll: async (report) => {
    const [sResult, wResult, wsResult, wgResult] = await Promise.all([
      timed('sessions', api.fetchSessions, (v) => `${v.length} active`, report),
      timed(
        'worktrees',
        () => api.fetchWorktrees(),
        (v) => `${v.length} ${v.length === 1 ? 'tree' : 'trees'}`,
        report
      ),
      timed(
        'workspaces',
        api.fetchWorkspaces,
        (v) => `${v.length} ${v.length === 1 ? 'repo' : 'repos'}`,
        report
      ),
      timed(
        'groups',
        api.fetchWorkspaceGroups,
        (v) => `${v.length} ${v.length === 1 ? 'group' : 'groups'}`,
        report
      ),
    ]);

    const state = get();
    let {
      sessions,
      worktrees,
      repos,
      workspaceGroups,
      activeSessionId,
      notificationSessions,
      workspaceLastSession,
    } = state;

    if (sResult.status === 'fulfilled') sessions = sResult.value;
    else logger.error('refreshAll failed to fetch sessions', sResult.reason);

    if (wResult.status === 'fulfilled') worktrees = wResult.value;
    else logger.error('refreshAll failed to fetch worktrees', wResult.reason);

    if (wsResult.status === 'fulfilled') repos = wsResult.value;
    else logger.error('refreshAll failed to fetch repos', wsResult.reason);

    if (wgResult.status === 'fulfilled') workspaceGroups = wgResult.value;
    else
      logger.error(
        'refreshAll failed to fetch workspace groups',
        wgResult.reason
      );

    const activeIds = new Set(sessions.map((s) => s.id));

    if (activeSessionId !== null && !activeIds.has(activeSessionId)) {
      activeSessionId = null;
      saveActiveSessionId(null);
    }

    let notifPruned = false;
    notificationSessions = { ...notificationSessions };
    for (const id of Object.keys(notificationSessions)) {
      if (!activeIds.has(id)) {
        delete notificationSessions[id];
        notifPruned = true;
      }
    }
    if (notifPruned) saveNotificationPrefs(notificationSessions);

    let wsPruned = false;
    workspaceLastSession = { ...workspaceLastSession };
    for (const [path, id] of Object.entries(workspaceLastSession)) {
      if (!activeIds.has(id)) {
        delete workspaceLastSession[path];
        wsPruned = true;
      }
    }
    if (wsPruned) persistWorkspaceSessions(workspaceLastSession);

    const { isUnread } = useUnreadStore.getState();
    // Read sidebarItems from current state to avoid race conditions with
    // handleUserViewed / handleBackendStateChanged that may have updated
    // them while we were awaiting the fetch.
    const sidebarItems = buildSidebarItems(
      sessions,
      worktrees,
      repos,
      get().sidebarItems,
      isUnread
    );

    useUnreadStore
      .getState()
      .pruneUnread(new Set(sidebarItems.map((i) => i.id)));

    set({
      sessions,
      worktrees,
      repos,
      workspaceGroups,
      activeSessionId,
      notificationSessions,
      workspaceLastSession,
      sidebarItems,
    });
  },

  getSessionsForRepo: (repoPath) =>
    get().sessions.filter((s) => s.repoPath === repoPath),

  getSessionsForWorkspaceGroup: (workspaceId) => {
    const { sessions, workspaceGroups } = get();
    const directSessions = sessions.filter(
      (s) => s.workspaceId === workspaceId
    );
    const workspace = workspaceGroups.find((w) => w.id === workspaceId);
    if (!workspace) return directSessions;
    const repoSet = new Set(workspace.repos);
    const repoSessions = sessions.filter(
      (s) => !s.workspaceId && repoSet.has(s.repoPath)
    );
    return [...directSessions, ...repoSessions];
  },

  renameSession: (sessionId, branchName, displayName) => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, branchName, displayName } : s
      ),
      sidebarItems: state.sidebarItems.map((item) => {
        if (!item.sessions.some((s) => s.id === sessionId)) return item;
        return {
          ...item,
          branchName,
          displayName,
          sessions: item.sessions.map((s) =>
            s.id === sessionId ? { ...s, branchName, displayName } : s
          ),
        };
      }),
    }));
  },

  handleBranchChanged: (sessionId, branch) => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, branchName: branch } : s
      ),
      sidebarItems: state.sidebarItems.map((item) =>
        item.sessions.some((s) => s.id === sessionId)
          ? { ...item, branchName: branch }
          : item
      ),
    }));
    if (!get().sessions.some((s) => s.id === sessionId)) {
      logger.debug('handleBranchChanged: session not found', sessionId);
    }
  },

  handleActivityChanged: (sessionId, timestamp, currentActivity) => {
    const now = timestamp || new Date().toISOString();
    set((state) => ({
      sessions: state.sessions.map((s) => {
        if (s.id !== sessionId) return s;
        const updated = { ...s, lastActivity: now };
        if (currentActivity !== undefined)
          updated.currentActivity = currentActivity ?? undefined;
        return updated;
      }),
      sidebarItems: state.sidebarItems.map((item) =>
        item.sessions.some((s) => s.id === sessionId)
          ? { ...item, lastActivity: now }
          : item
      ),
    }));
  },

  handleBackendStateChanged: (sessionId, backendState, permissionType) => {
    set((state) => {
      const agentStateMap: Record<
        BackendDisplayState,
        SessionSummary['agentState']
      > = {
        running: 'processing',
        idle: 'idle',
        permission: 'permission-prompt',
        error: 'error',
        initializing: 'initializing',
      };
      const sessions = state.sessions.map((s) => {
        if (s.id !== sessionId) return s;
        return {
          ...s,
          idle: backendState === 'idle',
          agentState: agentStateMap[backendState],
        };
      });

      const { activeSessionId, notificationSessions } = state;
      const sidebarItems = state.sidebarItems.map((item) => {
        if (!item.sessions.some((s) => s.id === sessionId)) return item;

        const updatedSessions = sessions.filter((s) =>
          item.sessions.some((is) => is.id === s.id)
        );
        const aggregateState = deriveBackendState(updatedSessions);
        if (aggregateState === item.lastKnownBackendState) return item;

        const oldDisplayState = item.displayState;
        const effectivePermissionType =
          aggregateState === 'permission' ? permissionType : undefined;
        const newDisplayState = transitionDisplayState(
          item.displayState,
          effectivePermissionType
            ? {
                type: 'backend-state-changed' as const,
                state: aggregateState,
                permissionType: effectivePermissionType,
              }
            : { type: 'backend-state-changed' as const, state: aggregateState }
        );

        let isUnread = item.isUnread;
        if (newDisplayState !== oldDisplayState) {
          const isViewing = item.sessions.some((s) => s.id === activeSessionId);
          if (isViewing) {
            useUnreadStore.getState().markRead(item.id);
            isUnread = false;
          } else if (shouldMarkUnread(oldDisplayState, newDisplayState, false)) {
            useUnreadStore.getState().markUnread(item.id);
            isUnread = true;
          }
          if (shouldNotify(oldDisplayState, newDisplayState)) {
            const notifySession =
              item.sessions.find((s) => s.id === sessionId) ??
              item.sessions.find((s) => notificationSessions[s.id]);
            if (
              notifySession &&
              notificationSessions[notifySession.id] &&
              shouldFireNotification()
            ) {
              fireNotification(notifySession);
            }
          }
        }

        return {
          ...item,
          lastKnownBackendState: aggregateState,
          displayState: newDisplayState,
          isUnread,
        } as SidebarItem;
      });

      return { sessions, sidebarItems };
    });
  },

  handleUserViewed: (sessionId) => {
    set((state) => ({
      sidebarItems: state.sidebarItems.map((item) => {
        if (!item.sessions.some((s) => s.id === sessionId)) return item;
        useUnreadStore.getState().markRead(item.id);
        return {
          ...item,
          displayState: transitionDisplayState(item.displayState, {
            type: 'user-viewed',
          }),
          isUnread: false,
        };
      }),
    }));
  },

  setNotificationEnabled: (sessionId, enabled) => {
    const next = { ...get().notificationSessions, [sessionId]: enabled };
    saveNotificationPrefs(next);
    set({ notificationSessions: next });
  },

  initSessionNotification: (sessionId, defaultEnabled) => {
    const { notificationSessions } = get();
    if (!(sessionId in notificationSessions)) {
      const next = { ...notificationSessions, [sessionId]: defaultEnabled };
      saveNotificationPrefs(next);
      set({ notificationSessions: next });
    }
  },

  getNotificationSessionIds: () =>
    Object.entries(get().notificationSessions)
      .filter(([, enabled]) => enabled)
      .map(([id]) => id),

  setLoading: (key) =>
    set((state) => ({ loadingItems: { ...state.loadingItems, [key]: true } })),

  clearLoading: (key) =>
    set((state) => {
      const next = { ...state.loadingItems };
      delete next[key];
      return { loadingItems: next };
    }),

  isItemLoading: (key) => !!get().loadingItems[key],

  reorderWorkspaces: async (paths) => {
    const updated = await api.reorderWorkspaces(paths);
    set({ repos: updated });
  },

  beginPtyReconnect: (sessionId: string) => {
    set({ reconnectingPtySessionId: sessionId });
  },

  clearPtyReconnect: (sessionId?: string) => {
    const current = get().reconnectingPtySessionId;
    if (sessionId === undefined || current === sessionId) {
      set({ reconnectingPtySessionId: null });
    }
  },
}));
