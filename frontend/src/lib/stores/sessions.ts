import { create } from 'zustand';
import type { StoreApi } from 'zustand';
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
import {
  isLiveSessionKey,
  resolveSessionByKey,
  resolveSessionKey,
  scopedSessionKey,
} from '../session-keys.js';
import {
  sessionEventMatches,
  type SessionEventScope,
} from '../../../../shared/node-boundary.js';
import type {
  InterventionRecord,
  TabControlEvent,
} from '../../../../shared/control-state.js';
import type { SessionDurabilityState } from '../../../../shared/session-durability.js';
import { useUiStore } from './ui.js';

const NOTIFICATIONS_STORAGE_KEY = 'claude-remote-notifications';
const ACTIVE_SESSION_KEY = 'claude-remote-active-session';
const WORKSPACE_SESSIONS_KEY = 'claude-remote-workspace-sessions';
const logger = createLogger('sessions');

const BOOT_FETCH_TIMEOUT_MS = 10_000;
export const DEFAULT_ENRICHMENT_TTL_MS = 600_000;

export type RepoEnrichmentSource = 'webhook' | 'manual';
export type BackendConnectionStatus =
  | 'connected'
  | 'reconnecting'
  | 'restarting';
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
  reconnectingPtySessionIds: Record<string, true>;
  backendConnectionStatus: BackendConnectionStatus;
  interventionsBySession: Record<string, InterventionRecord[]>;
  // Actions
  setActiveSessionId: (id: string | null) => void;
  rememberSessionForWorkspace: (
    workspacePath: string,
    sessionId: string
  ) => void;
  recallSessionForWorkspace: (workspacePath: string) => string | null;
  ensureFreshAll: (maxAgeMs?: number) => Promise<void>;
  forceRefresh: (
    repoPath: string,
    source?: RepoEnrichmentSource
  ) => Promise<void>;
  forceRefreshRepos: (
    repoPaths: string[],
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
    displayName: string,
    scope?: SessionEventScope
  ) => void;
  handleBranchChanged: (
    sessionId: string,
    branch: string,
    scope?: SessionEventScope
  ) => void;
  handleActivityChanged: (
    sessionId: string,
    timestamp?: string,
    currentActivity?: CurrentActivity | null,
    scope?: SessionEventScope
  ) => void;
  handleBackendStateChanged: (
    sessionId: string,
    backendState: BackendDisplayState,
    permissionType?: 'approval' | 'question',
    scope?: SessionEventScope
  ) => void;
  handleDurabilityChanged: (
    sessionId: string,
    durability: SessionDurabilityState,
    scope?: SessionEventScope
  ) => void;
  handleUserViewed: (sessionId: string, scope?: SessionEventScope) => void;
  handleTabControlEvent: (event: TabControlEvent) => void;
  setNotificationEnabled: (sessionId: string, enabled: boolean) => void;
  initSessionNotification: (sessionId: string, defaultEnabled: boolean) => void;
  getNotificationSessionIds: () => string[];
  setLoading: (key: string) => void;
  clearLoading: (key: string) => void;
  isItemLoading: (key: string) => boolean;
  reorderWorkspaces: (paths: string[]) => Promise<void>;
  setBackendConnectionStatus: (status: BackendConnectionStatus) => void;
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
  for (const session of state.sessions) {
    if (session.repoPath) paths.add(session.repoPath);
  }
  return Array.from(paths);
}

type SessionsSet = StoreApi<SessionsState>['setState'];
type SessionsGet = StoreApi<SessionsState>['getState'];

/**
 * Enrichment requests currently in flight, keyed by repo path.
 *
 * #1447: mount fires `ensureFreshAll(0)` and the navigation effect re-arms
 * `ensureFreshAll()` ~500 ms later — long before a cold batch has landed and
 * stamped freshness metadata — so without this the entire batch is requested
 * twice. Freshness-gated callers (`maxAgeMs > 0`) join the pending promise
 * instead of issuing a duplicate. Callers that explicitly bypass the TTL
 * (`forceRefresh`/`forceRefreshRepos`, `ensureFreshAll(0)`) always issue their
 * own request: a webhook must not be answered by a response that was already
 * in flight when the event arrived.
 */
const inFlightRepoEnrichments = new Map<string, Promise<void>>();

/**
 * Monotonic per-repo run counter. A batch lands at the slowest repo's latency,
 * which is a wider window than the old per-repo request had, so a webhook
 * `forceRefresh` or a `PrTopBar` refresh that starts mid-batch could be
 * clobbered by the batch's older data — and then stamped fresh for the full
 * TTL. A run only writes the repos whose generation it still owns.
 */
const repoEnrichmentGenerations = new Map<string, number>();

function claimRepoEnrichmentGenerations(
  repoPaths: string[]
): Map<string, number> {
  const claimed = new Map<string, number>();
  for (const repoPath of repoPaths) {
    const next = (repoEnrichmentGenerations.get(repoPath) ?? 0) + 1;
    repoEnrichmentGenerations.set(repoPath, next);
    claimed.set(repoPath, next);
  }
  return claimed;
}

/** Repos this run still owns — a newer run has not started for them since. */
function ownedRepoPaths(claimed: Map<string, number>): string[] {
  return [...claimed.entries()]
    .filter(
      ([repoPath, generation]) =>
        repoEnrichmentGenerations.get(repoPath) === generation
    )
    .map(([repoPath]) => repoPath);
}

/** Test seam: module state outlives `useSessionsStore.setState`. */
export function resetRepoEnrichmentRuntime(): void {
  inFlightRepoEnrichments.clear();
  repoEnrichmentGenerations.clear();
}

function repoEnrichmentStamps(
  repoPaths: string[],
  source: RepoEnrichmentSource
): Record<string, RepoEnrichmentMeta> {
  const stampedAt = Date.now();
  const stamps: Record<string, RepoEnrichmentMeta> = {};
  for (const repoPath of repoPaths) {
    stamps[repoPath] = { lastEnrichedAt: stampedAt, source };
  }
  return stamps;
}

/**
 * #1447: enrich every branch of every requested repo in ONE `POST
 * /gh/enrich-branches` call. The server already groups the payload by repo
 * (`server/gh-routes.ts`) and keys its response `${repoPath}::${branchName}`,
 * so the client demuxes by key rather than fanning out one request per repo.
 */
async function runRepoEnrichment(
  set: SessionsSet,
  get: SessionsGet,
  repoPaths: string[],
  source: RepoEnrichmentSource,
  claimed: Map<string, number>
): Promise<void> {
  // Never rejects: joined callers and the fire-and-forget mount call must not
  // see an unhandled rejection.
  try {
    if (repoPaths.length === 0) return;

    const state = get();
    const requested = new Map<
      string,
      ReturnType<typeof repoBranchEntriesFor>
    >();
    for (const repoPath of repoPaths) {
      requested.set(repoPath, repoBranchEntriesFor(state, repoPath));
    }
    const branches = [...requested.values()].flat();

    // Repos with nothing to enrich still count as refreshed, so a webhook for a
    // repo with no local branches does not retry on every subsequent pass.
    if (branches.length === 0) {
      const stamps = repoEnrichmentStamps(ownedRepoPaths(claimed), source);
      set((current) => ({
        repoEnrichmentMeta: { ...current.repoEnrichmentMeta, ...stamps },
      }));
      return;
    }

    const data = await api.enrichBranches(branches);

    // Drop the repos a newer run took over while this request was in flight.
    const owned = ownedRepoPaths(claimed);
    if (owned.length === 0) return;
    const stamps = repoEnrichmentStamps(owned, source);
    // Only repos that actually contributed branches have their previous
    // results replaced; a repo with none keeps whatever it had, exactly as the
    // per-repo path did.
    const prunable = owned
      .filter((repoPath) => (requested.get(repoPath)?.length ?? 0) > 0)
      .map((repoPath) => `${repoPath}::`);
    const ownedPrefixes = owned.map((repoPath) => `${repoPath}::`);

    set((current) => {
      const nextResults: Record<string, BranchEnrichment> = {};
      for (const [key, value] of Object.entries(current.enrichmentResults)) {
        if (!prunable.some((prefix) => key.startsWith(prefix))) {
          nextResults[key] = value;
        }
      }
      for (const [key, value] of Object.entries(data.results)) {
        if (ownedPrefixes.some((prefix) => key.startsWith(prefix))) {
          nextResults[key] = value;
        }
      }
      return {
        enrichmentResults: nextResults,
        repoEnrichmentMeta: { ...current.repoEnrichmentMeta, ...stamps },
      };
    });
  } catch (err) {
    // Leave freshness metadata untouched so the next pass retries.
    logger.warn('branch enrichment failed', err);
  }
}

/** Runs one batched enrichment and publishes it as the in-flight request. */
function enrichRepos(
  set: SessionsSet,
  get: SessionsGet,
  repoPaths: string[],
  source: RepoEnrichmentSource
): Promise<void> {
  if (repoPaths.length === 0) return Promise.resolve();

  const claimed = claimRepoEnrichmentGenerations(repoPaths);
  const run = runRepoEnrichment(set, get, repoPaths, source, claimed);
  for (const repoPath of repoPaths) {
    inFlightRepoEnrichments.set(repoPath, run);
  }
  void run
    .finally(() => {
      for (const repoPath of repoPaths) {
        if (inFlightRepoEnrichments.get(repoPath) === run) {
          inFlightRepoEnrichments.delete(repoPath);
        }
      }
    })
    .catch(() => {});
  return run;
}

function isRepoEnrichmentFresh(
  state: Pick<SessionsState, 'repoEnrichmentMeta'>,
  repoPath: string,
  maxAgeMs: number
): boolean {
  if (maxAgeMs <= 0) return false;
  const meta = state.repoEnrichmentMeta[repoPath];
  return !!meta && Date.now() - meta.lastEnrichedAt < maxAgeMs;
}

function sessionMatchesEventScope(
  session: SessionSummary,
  sessionId: string,
  scope?: SessionEventScope
): boolean {
  return sessionEventMatches(session, {
    sessionId,
    ...(scope ?? {}),
  });
}

function sessionsShareScopedIdentity(
  left: SessionSummary,
  right: SessionSummary
): boolean {
  if (left.globalSessionId && right.globalSessionId) {
    return left.globalSessionId === right.globalSessionId;
  }

  if (left.nodeId && right.nodeId) {
    return left.nodeId === right.nodeId && left.id === right.id;
  }

  if (
    left.globalSessionId ||
    right.globalSessionId ||
    left.nodeId ||
    right.nodeId
  ) {
    return false;
  }

  return left.id === right.id;
}

function isLegacyLocalSessionIdUnambiguous(
  sessions: SessionSummary[],
  sessionId: string
): boolean {
  const matchingNodes = new Set<string>();
  let matches = 0;
  for (const session of sessions) {
    if (session.id !== sessionId) continue;
    matches += 1;
    if (session.nodeId) matchingNodes.add(session.nodeId);
  }
  return matches <= 1 || matchingNodes.size <= 1;
}

function storedSessionIdMatchesSession(
  session: SessionSummary,
  storedId: string,
  sessions: SessionSummary[]
): boolean {
  if (
    (session.globalSessionId || session.nodeId) &&
    storedId === scopedSessionKey(session)
  ) {
    return true;
  }

  return (
    session.id === storedId &&
    isLegacyLocalSessionIdUnambiguous(sessions, storedId)
  );
}

function notificationEnabledForSession(
  session: SessionSummary,
  notificationSessions: Record<string, boolean>,
  sessions: SessionSummary[]
): boolean {
  if (
    (session.globalSessionId || session.nodeId) &&
    notificationSessions[scopedSessionKey(session)]
  ) {
    return true;
  }

  return (
    notificationSessions[session.id] === true &&
    isLegacyLocalSessionIdUnambiguous(sessions, session.id)
  );
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
  reconnectingPtySessionIds: {},
  backendConnectionStatus: 'connected',
  interventionsBySession: {},

  setActiveSessionId: (id) => {
    const key = id === null ? null : resolveSessionKey(get().sessions, id);
    if (key !== null) {
      // `forceOrgCockpit` is a one-off escape hatch for the explicit Work
      // cockpit commands. Any normal session activation should return to the
      // chat/session shell instead of inheriting a stale forced cockpit mode.
      useUiStore.getState().setForceOrgCockpit(false);
    }
    saveActiveSessionId(key);
    set({ activeSessionId: key });
  },

  rememberSessionForWorkspace: (workspacePath, sessionId) => {
    const key = resolveSessionKey(get().sessions, sessionId);
    const next = { ...get().workspaceLastSession, [workspacePath]: key };
    persistWorkspaceSessions(next);
    set({ workspaceLastSession: next });
  },

  recallSessionForWorkspace: (workspacePath) => {
    const { workspaceLastSession, sessions } = get();
    const id = workspaceLastSession[workspacePath];
    if (!id) return null;
    if (!isLiveSessionKey(sessions, id)) {
      const next = { ...workspaceLastSession };
      delete next[workspacePath];
      persistWorkspaceSessions(next);
      set({ workspaceLastSession: next });
      return null;
    }
    return resolveSessionKey(sessions, id);
  },

  ensureFreshAll: async (maxAgeMs = DEFAULT_ENRICHMENT_TTL_MS) => {
    const state = get();
    const joins: Array<Promise<void>> = [];
    const stale: string[] = [];
    for (const repoPath of visibleRepoPaths(state)) {
      if (isRepoEnrichmentFresh(state, repoPath, maxAgeMs)) continue;
      const inFlight =
        maxAgeMs > 0 ? inFlightRepoEnrichments.get(repoPath) : undefined;
      if (inFlight) {
        joins.push(inFlight);
        continue;
      }
      stale.push(repoPath);
    }
    // #1447: one request for every stale repo, not one request per repo.
    joins.push(enrichRepos(set, get, stale, 'manual'));
    await Promise.all(joins);
  },

  forceRefresh: async (repoPath, source = 'manual') => {
    await get().forceRefreshRepos([repoPath], source);
  },

  /**
   * #1457: force-refresh several repos in ONE request. A webhook burst names
   * every repo it touched, so enriching them together is one `POST
   * /gh/enrich-branches` instead of one per repo.
   *
   * Force semantics are identical to `forceRefresh`: no TTL check, and never a
   * join onto a pending batch, so a webhook is never answered by a response
   * that was already in flight when the event arrived. The per-repo generation
   * guard keeps a slower batch from clobbering what this run wrote.
   */
  forceRefreshRepos: async (repoPaths, source = 'manual') => {
    await enrichRepos(set, get, repoPaths, source);
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

    const hasSessionIdentity = (id: string): boolean =>
      sessions.some((session) =>
        storedSessionIdMatchesSession(session, id, sessions)
      );

    if (activeSessionId !== null) {
      if (!hasSessionIdentity(activeSessionId)) {
        activeSessionId = null;
        saveActiveSessionId(null);
      } else {
        const resolved = resolveSessionKey(sessions, activeSessionId);
        if (resolved !== activeSessionId) {
          activeSessionId = resolved;
          saveActiveSessionId(resolved);
        }
      }
    }

    let notifPruned = false;
    notificationSessions = { ...notificationSessions };
    for (const id of Object.keys(notificationSessions)) {
      if (!hasSessionIdentity(id)) {
        delete notificationSessions[id];
        notifPruned = true;
      }
    }
    if (notifPruned) saveNotificationPrefs(notificationSessions);

    let wsPruned = false;
    workspaceLastSession = { ...workspaceLastSession };
    for (const [path, id] of Object.entries(workspaceLastSession)) {
      if (!hasSessionIdentity(id)) {
        delete workspaceLastSession[path];
        wsPruned = true;
      } else {
        const resolved = resolveSessionKey(sessions, id);
        if (resolved !== id) {
          workspaceLastSession[path] = resolved;
          wsPruned = true;
        }
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
    const repoSet = new Set(
      Array.isArray(workspace.repos) ? workspace.repos : []
    );
    const repoSessions = sessions.filter(
      (s) => !s.workspaceId && !!s.repoPath && repoSet.has(s.repoPath)
    );
    return [...directSessions, ...repoSessions];
  },

  renameSession: (sessionId, branchName, displayName, scope) => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        sessionMatchesEventScope(s, sessionId, scope)
          ? { ...s, branchName, displayName }
          : s
      ),
      sidebarItems: state.sidebarItems.map((item) => {
        if (
          !item.sessions.some((s) =>
            sessionMatchesEventScope(s, sessionId, scope)
          )
        )
          return item;
        return {
          ...item,
          branchName,
          displayName,
          sessions: item.sessions.map((s) =>
            sessionMatchesEventScope(s, sessionId, scope)
              ? { ...s, branchName, displayName }
              : s
          ),
        };
      }),
    }));
  },

  handleBranchChanged: (sessionId, branch, scope) => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        sessionMatchesEventScope(s, sessionId, scope)
          ? { ...s, branchName: branch }
          : s
      ),
      sidebarItems: state.sidebarItems.map((item) =>
        item.sessions.some((s) => sessionMatchesEventScope(s, sessionId, scope))
          ? { ...item, branchName: branch }
          : item
      ),
    }));
    if (
      !get().sessions.some((s) => sessionMatchesEventScope(s, sessionId, scope))
    ) {
      logger.debug('handleBranchChanged: session not found', sessionId);
    }
  },

  handleActivityChanged: (sessionId, timestamp, currentActivity, scope) => {
    const now = timestamp || new Date().toISOString();
    set((state) => ({
      sessions: state.sessions.map((s) => {
        if (!sessionMatchesEventScope(s, sessionId, scope)) return s;
        const updated = { ...s, lastActivity: now };
        if (currentActivity !== undefined)
          updated.currentActivity = currentActivity ?? undefined;
        return updated;
      }),
      sidebarItems: state.sidebarItems.map((item) =>
        item.sessions.some((s) => sessionMatchesEventScope(s, sessionId, scope))
          ? { ...item, lastActivity: now }
          : item
      ),
    }));
  },

  handleBackendStateChanged: (
    sessionId,
    backendState,
    permissionType,
    scope
  ) => {
    set((state) => {
      const activityStateMap: Record<
        BackendDisplayState,
        SessionSummary['activityState']
      > = {
        running: 'processing',
        idle: 'idle',
        permission: 'permission-prompt',
        error: 'error',
        initializing: 'initializing',
      };
      const sessions = state.sessions.map((s) => {
        if (!sessionMatchesEventScope(s, sessionId, scope)) return s;
        return {
          ...s,
          idle: backendState === 'idle',
          activityState: activityStateMap[backendState],
        };
      });

      const { activeSessionId, notificationSessions } = state;
      const sidebarItems = state.sidebarItems.map((item) => {
        if (
          !item.sessions.some((s) =>
            sessionMatchesEventScope(s, sessionId, scope)
          )
        )
          return item;

        const updatedSessions = sessions.filter((s) =>
          item.sessions.some((is) => sessionsShareScopedIdentity(is, s))
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
          const isViewing =
            activeSessionId !== null &&
            item.sessions.some((s) =>
              storedSessionIdMatchesSession(s, activeSessionId, state.sessions)
            );
          if (isViewing) {
            useUnreadStore.getState().markRead(item.id);
            isUnread = false;
          } else if (
            shouldMarkUnread(oldDisplayState, newDisplayState, false)
          ) {
            useUnreadStore.getState().markUnread(item.id);
            isUnread = true;
          }
          if (shouldNotify(oldDisplayState, newDisplayState)) {
            const notifySession =
              item.sessions.find((s) =>
                sessionMatchesEventScope(s, sessionId, scope)
              ) ??
              item.sessions.find((s) =>
                notificationEnabledForSession(
                  s,
                  notificationSessions,
                  state.sessions
                )
              );
            if (
              notifySession &&
              notificationEnabledForSession(
                notifySession,
                notificationSessions,
                state.sessions
              ) &&
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

  handleDurabilityChanged: (sessionId, durability, scope) => {
    set((state) => {
      let changed = false;
      const sessions = state.sessions.map((s) => {
        if (!sessionMatchesEventScope(s, sessionId, scope)) return s;
        if (s.durability === durability) return s;
        changed = true;
        return { ...s, durability };
      });
      if (!changed) return state;
      return { ...state, sessions };
    });
  },

  handleUserViewed: (sessionId, scope) => {
    set((state) => {
      const viewedSession = resolveSessionByKey(state.sessions, sessionId);
      const matchesViewedSession = (session: SessionSummary): boolean =>
        viewedSession
          ? sessionsShareScopedIdentity(session, viewedSession)
          : sessionMatchesEventScope(session, sessionId, scope);

      return {
        sidebarItems: state.sidebarItems.map((item) => {
          if (!item.sessions.some(matchesViewedSession)) return item;
          useUnreadStore.getState().markRead(item.id);
          return {
            ...item,
            displayState: transitionDisplayState(item.displayState, {
              type: 'user-viewed',
            }),
            isUnread: false,
          };
        }),
      };
    });
  },

  handleTabControlEvent: (event) => {
    const identity = event.identity;
    const scope: SessionEventScope = {
      sessionId: identity.sessionId,
      localSessionId: identity.sessionId,
      ...(identity.nodeId ? { nodeId: identity.nodeId } : {}),
      ...(identity.globalSessionId
        ? { globalSessionId: identity.globalSessionId }
        : {}),
    };
    const cacheKey =
      identity.globalSessionId ?? `${identity.nodeId}:${identity.sessionId}`;
    set((state) => {
      const sessions = state.sessions.map((session): SessionSummary => {
        if (!sessionMatchesEventScope(session, identity.sessionId, scope)) {
          return session;
        }
        const updated: SessionSummary = {
          ...session,
        };
        if (event.type === 'tab.intervention') {
          updated.lastInterventionAt = event.intervention.timestamp;
          updated.lastInterventionBy = event.intervention.author;
          updated.lastInterventionEventId = event.intervention.id;
        }
        return updated;
      });
      if (event.type !== 'tab.intervention') return { sessions };
      const previous = state.interventionsBySession[cacheKey] ?? [];
      const next = [
        event.intervention,
        ...previous.filter((record) => record.id !== event.intervention.id),
      ].slice(0, 12);
      return {
        sessions,
        interventionsBySession: {
          ...state.interventionsBySession,
          [cacheKey]: next,
        },
      };
    });
  },

  setNotificationEnabled: (sessionId, enabled) => {
    const key = resolveSessionKey(get().sessions, sessionId);
    const next = { ...get().notificationSessions, [key]: enabled };
    saveNotificationPrefs(next);
    set({ notificationSessions: next });
  },

  initSessionNotification: (sessionId, defaultEnabled) => {
    const { notificationSessions } = get();
    const key = resolveSessionKey(get().sessions, sessionId);
    if (!(key in notificationSessions)) {
      const next = { ...notificationSessions, [key]: defaultEnabled };
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

  setBackendConnectionStatus: (status) => {
    set((state) => {
      if (state.backendConnectionStatus === status) return state;
      return { backendConnectionStatus: status };
    });
  },

  beginPtyReconnect: (sessionId: string) => {
    set((state) => {
      if (state.reconnectingPtySessionIds[sessionId]) return state;
      return {
        reconnectingPtySessionIds: {
          ...state.reconnectingPtySessionIds,
          [sessionId]: true,
        },
      };
    });
  },

  clearPtyReconnect: (sessionId?: string) => {
    set((state) => {
      if (sessionId === undefined) {
        if (Object.keys(state.reconnectingPtySessionIds).length === 0) {
          return state;
        }
        return { reconnectingPtySessionIds: {} };
      }

      if (!state.reconnectingPtySessionIds[sessionId]) return state;
      const next = { ...state.reconnectingPtySessionIds };
      delete next[sessionId];
      return { reconnectingPtySessionIds: next };
    });
  },
}));
