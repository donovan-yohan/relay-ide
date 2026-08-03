import { useEffect } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { fetchHubNodes } from '../lib/api.js';
import { connectEventSocket } from '../lib/ws.js';
import type { EventMessage } from '../lib/ws.js';
import { useAuthStore } from '../lib/stores/auth.js';
import { resolveSessionByKey } from '../lib/session-keys.js';
import { useSessionsStore } from '../lib/stores/sessions.js';
import { useTelemetryStore } from '../lib/stores/telemetry.js';
import { useUiStore } from '../lib/stores/ui.js';
import { useChannelActivityStore } from '../lib/stores/channel-activity.js';
import {
  channelAgentStatusKey,
  useChannelAgentStatusStore,
} from '../lib/stores/channel-agent-status.js';
import { notifyFromAgentStatus } from '../lib/notify/producers.js';
import { notifyChannelFromTopic } from '../lib/notify/signals.js';
import type { WorkspaceTopic } from '../../../shared/workspace-topics.js';
import type { AccountTelemetry, SessionTelemetry } from '../lib/types.js';
import type { SessionEventScope } from '../../../shared/node-boundary.js';
import type {
  HubNodeStatus,
  HubNodeSummary,
} from '../../../shared/relay-node-protocol.js';

export interface UseEventSocketParams {
  authAuthenticated: boolean;
  queryClient: QueryClient;
  throttledChangedFilesRefresh: () => void;
  setChangedFilesData: (files: string[]) => void;
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/');
}

function normalizeOwnerRepo(value: string): string {
  return value.toLowerCase().replace(/\.git$/, '');
}

function repoNameFromOwnerRepo(value: string): string {
  const normalized = normalizeOwnerRepo(value);
  return normalized.split('/').pop() ?? normalized;
}

function normalizePath(value: string): string {
  if (value === '/') return value;
  return value.replace(/\/+$/, '');
}

function pathIsAtOrUnder(path: string, root: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedRoot = normalizePath(root);
  return (
    normalizedPath === normalizedRoot ||
    normalizedPath.startsWith(`${normalizedRoot}/`)
  );
}

function resolveAbsolutePathToRepoPath(value: string): string[] {
  const state = useSessionsStore.getState();
  const paths = new Set<string>();
  const absolutePath = normalizePath(value);

  for (const worktree of state.worktrees ?? []) {
    if (pathIsAtOrUnder(absolutePath, worktree.path)) {
      paths.add(worktree.repoPath);
    }
  }

  for (const session of state.sessions ?? []) {
    const sessionRoots = [
      session.worktreePath ?? undefined,
      session.cwd,
      session.repoPath,
    ];
    if (
      sessionRoots.some((root) => root && pathIsAtOrUnder(absolutePath, root))
    ) {
      if (session.repoPath) paths.add(session.repoPath);
    }
  }

  for (const repo of state.repos ?? []) {
    if (pathIsAtOrUnder(absolutePath, repo.path)) {
      paths.add(repo.path);
    }
  }

  return paths.size > 0 ? Array.from(paths) : [absolutePath];
}

function resolveRepoPaths(values: string[]): string[] {
  const state = useSessionsStore.getState();
  const knownRepos = state.repos ?? [];
  const paths = new Set<string>();

  for (const value of values) {
    if (!value) continue;
    if (isAbsolutePath(value)) {
      for (const repoPath of resolveAbsolutePathToRepoPath(value)) {
        paths.add(repoPath);
      }
      continue;
    }

    const normalized = normalizeOwnerRepo(value);
    const repoName = repoNameFromOwnerRepo(value);
    for (const repo of knownRepos) {
      const pathName = repo.path.split('/').pop()?.toLowerCase();
      if (
        repo.name.toLowerCase() === normalized ||
        repo.name.toLowerCase() === repoName ||
        pathName === repoName
      ) {
        paths.add(repo.path);
      }
    }
  }

  return Array.from(paths);
}

function repoPathsFromPrOrCiMessage(
  msg: Extract<EventMessage, { type: 'pr-updated' | 'ci-updated' }>
): string[] {
  return resolveRepoPaths([
    ...(msg.workspacePaths ?? []),
    ...(msg.repos ?? []),
    ...(msg.repo ? [msg.repo] : []),
  ]);
}

function sessionRepoPath(
  sessionId: string | undefined,
  scope?: SessionEventScope
): string | undefined {
  if (!sessionId) return undefined;
  return useSessionsStore.getState().sessions.find((session) => {
    if (scope?.globalSessionId) {
      return session.globalSessionId === scope.globalSessionId;
    }
    if (scope?.nodeId) {
      return session.id === sessionId && session.nodeId === scope.nodeId;
    }
    return session.id === sessionId;
  })?.repoPath;
}

function eventSessionScope(msg: {
  nodeId?: string;
  globalSessionId?: string;
  localSessionId?: string;
  sessionId?: string;
}): SessionEventScope {
  const localSessionId = msg.localSessionId ?? msg.sessionId;
  return {
    ...(localSessionId ? { sessionId: localSessionId, localSessionId } : {}),
    ...(msg.nodeId ? { nodeId: msg.nodeId } : {}),
    ...(msg.globalSessionId ? { globalSessionId: msg.globalSessionId } : {}),
  };
}

function invalidatePrQueries(queryClient: QueryClient): void {
  queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  queryClient.invalidateQueries({ queryKey: ['org-prs'] });
}

function invalidateReconnectQueries(queryClient: QueryClient): void {
  invalidatePrQueries(queryClient);
  queryClient.invalidateQueries({ queryKey: ['files-list'] });
  queryClient.invalidateQueries({ queryKey: ['changedFiles'] });
  queryClient.invalidateQueries({ queryKey: ['fileDiff'] });
  // Cross-device read sync (#1308 slice 3) has exactly one live lane — the
  // `channel-read-state` broadcast — so every mark another device published
  // while this socket was down was simply missed, and the boot seed is cached
  // for five minutes behind a query that never refetches on focus. Refetching
  // it here is what makes convergence survive a sleep, a network drop, or a hub
  // restart. One small row per marked channel, merged monotonic-up and behind
  // the same clamp fence, so a redundant refetch costs a dot nothing.
  queryClient.invalidateQueries({ queryKey: ['channel-read-state'] });
}

/**
 * Trailing-edge window for the nav-spine refetch triggered by activity on a
 * channel the client holds no row for. Agent-created implementation channels
 * (#1242) arrive in bursts as the orchestrator fans work out, and one refetch
 * per burst is enough to materialize every new row.
 */
const UNKNOWN_CHANNEL_LIST_REFRESH_MS = 750;
/**
 * Back-off before a channel a completed refresh FAILED to materialize is allowed
 * to schedule another one. `GET /channels` and `/workspace-topics` are both
 * capped list windows, so a channel outside that window can never be pulled in
 * by refetching — without this the lane would re-fire on every subsequent badge
 * (one per message create / stream open / stream complete) for the whole turn,
 * on every open client, and still never render the row.
 */
const UNKNOWN_CHANNEL_REFRESH_BACKOFF_MS = 60_000;
/** Hard cap on remembered unresolved channels so the map cannot grow unbounded. */
const UNKNOWN_CHANNEL_BACKOFF_MAX_ENTRIES = 256;
/**
 * Trailing-edge window for per-channel roster refetches. An agent turn walks
 * spawning → thinking → streaming → waiting → idle, so debouncing collapses a
 * whole turn into the single refetch that matters: the one after it settles.
 */
const AGENT_STATUS_ROSTER_REFRESH_MS = 750;
/**
 * Ceiling on how long a continuous status burst may keep pushing the roster
 * debounce out. Without it a turn that emits a transition faster than the window
 * would starve the refetch forever; with it the roster lands at least this often
 * mid-burst and once more after it settles.
 */
const AGENT_STATUS_ROSTER_MAX_WAIT_MS = 5_000;

/** Topic-list caches the sidebar renders rows from (active + archived views). */
const TOPIC_LIST_QUERY_KEYS: string[][] = [
  ['workspace-topics'],
  ['workspace-topics', 'with-archived'],
];

/**
 * True when a rendered list already covers this channel. Reads the two caches
 * the rail joins its rows from — the `/channels` summary list (#1287 Slice 1)
 * and `/workspace-topics` — without fetching. When neither has loaded there is
 * no rail to be missing a row, so the channel counts as known and no refetch is
 * scheduled.
 */
function hasCachedChannelRow(
  queryClient: QueryClient,
  channelId: string
): boolean {
  let sawCachedList = false;
  const channels = queryClient.getQueryData<{ id: string }[]>(['channels']);
  if (Array.isArray(channels)) {
    sawCachedList = true;
    if (channels.some((row) => row.id === channelId)) return true;
  }
  for (const queryKey of TOPIC_LIST_QUERY_KEYS) {
    const topics = queryClient.getQueryData<{ topics?: { id: string }[] }>(
      queryKey
    );
    if (!Array.isArray(topics?.topics)) continue;
    sawCachedList = true;
    if (topics.topics.some((topic) => topic.id === channelId)) return true;
  }
  return !sawCachedList;
}

/**
 * Channel descriptor for the notify lane (#1308 slice 5), resolved from the
 * topic caches this module already reads for `hasCachedChannelRow`.
 *
 * Cache-only, never a fetch: a turn-complete signal for a channel no list has
 * loaded has no title to name and no DM-ness to derive, and the honest answer is
 * to raise no signal rather than notify about `topic:01j…`.
 */
function cachedNotifyChannel(
  queryClient: QueryClient,
  channelId: string
): ReturnType<typeof notifyChannelFromTopic> | null {
  for (const queryKey of TOPIC_LIST_QUERY_KEYS) {
    const topics = queryClient.getQueryData<{ topics?: WorkspaceTopic[] }>(
      queryKey
    );
    const topic = topics?.topics?.find((row) => row.id === channelId);
    if (topic) return notifyChannelFromTopic(topic);
  }
  return null;
}

const HUB_NODE_REVERSE_LINK_ROUTE = 'reverse-link';

function hubNodeConnectionSummary(
  status: HubNodeStatus
): HubNodeSummary['connection'] {
  if (status === 'online') {
    return { route: HUB_NODE_REVERSE_LINK_ROUTE, status: 'connected' };
  }
  if (status === 'stale') {
    return { route: HUB_NODE_REVERSE_LINK_ROUTE, status: 'stale heartbeat' };
  }
  if (status === 'offline') {
    return { route: HUB_NODE_REVERSE_LINK_ROUTE, status: 'offline' };
  }
  return { route: HUB_NODE_REVERSE_LINK_ROUTE, status: 'revoked' };
}

function applyHubNodeStatusEvent(
  queryClient: QueryClient,
  msg: Extract<EventMessage, { type: 'node.status' }>
): void {
  let matchedCachedNode = false;
  queryClient.setQueryData<HubNodeSummary[]>(['hub-nodes'], (nodes) => {
    if (!nodes) return nodes;
    return nodes.map((node) => {
      if (node.nodeId !== msg.nodeId) return node;
      matchedCachedNode = true;
      return {
        ...node,
        ...(msg.manifest
          ? {
              hostname: msg.manifest.hostname,
              ...(msg.manifest.homeDir
                ? { homeDir: msg.manifest.homeDir }
                : {}),
              platform: msg.manifest.platform,
              arch: msg.manifest.arch,
              relayVersion: msg.manifest.relayVersion,
            }
          : {}),
        status: msg.status,
        connection: hubNodeConnectionSummary(msg.status),
        lastSeenAt: msg.lastSeenAt,
      };
    });
  });
  if (!matchedCachedNode) {
    queryClient.invalidateQueries({ queryKey: ['hub-nodes'] });
  }
}

async function resyncHubNodesAfterReconnect(
  queryClient: QueryClient
): Promise<void> {
  try {
    queryClient.setQueryData(['hub-nodes'], await fetchHubNodes());
  } catch {
    queryClient.invalidateQueries({ queryKey: ['hub-nodes'] });
  }
}

function forceRefreshRepos(repoPaths: string[], source: 'webhook' | 'manual') {
  for (const repoPath of repoPaths) {
    void useSessionsStore.getState().forceRefresh(repoPath, source);
  }
}

export function useEventSocket({
  authAuthenticated,
  queryClient,
  throttledChangedFilesRefresh,
  setChangedFilesData,
}: UseEventSocketParams): void {
  useEffect(() => {
    if (!authAuthenticated) return;

    let pollInvalidateTimer: ReturnType<typeof setTimeout> | null = null;
    let channelListRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    let rosterInvalidateTimer: ReturnType<typeof setTimeout> | null = null;
    let rosterBurstStartedAt = 0;
    let eventSocketOpened = false;
    const pendingWebhookRepos = new Set<string>();
    const pendingRosterChannels = new Set<string>();
    /** Channels the pending refresh is expected to materialize. */
    const pendingUnknownChannels = new Set<string>();
    /** Channel id → timestamp of the last refresh that failed to produce its row. */
    const unresolvedChannelAttempts = new Map<string, number>();

    function invalidateScopedPrData(
      repoPaths: string[],
      source: 'webhook' | 'manual'
    ): void {
      invalidatePrQueries(queryClient);
      forceRefreshRepos(repoPaths, source);
    }

    async function refreshAfterReconnect(): Promise<void> {
      const sessions = useSessionsStore.getState();
      sessions.setBackendConnectionStatus('connected');
      await sessions.refreshAll();
      await resyncHubNodesAfterReconnect(queryClient);
      invalidateReconnectQueries(queryClient);
      throttledChangedFilesRefresh();
      void sessions.ensureFreshAll(0);
      void useTelemetryStore.getState().refreshTelemetry();
    }

    /** Throttled invalidation for bursty webhook PR/CI events. */
    function throttledWebhookInvalidate(repoPaths: string[]): void {
      for (const repoPath of repoPaths) pendingWebhookRepos.add(repoPath);
      if (pollInvalidateTimer) return;
      pollInvalidateTimer = setTimeout(() => {
        pollInvalidateTimer = null;
        const repos = Array.from(pendingWebhookRepos);
        pendingWebhookRepos.clear();
        invalidateScopedPrData(repos, 'webhook');
      }, 500);
    }

    /**
     * Refetch the lists the sidebar builds rows from. Deliberately an
     * invalidation and not a store write: the refreshed `/channels` payload
     * re-enters the activity store through the rail's `seedChannelActivity`
     * effect, so the per-channel clamp-epoch fence (#1287 Slice 1) still gates
     * every head seq. This lane never touches `latestSeqByChannel` itself.
     */
    function scheduleChannelListRefresh(channelId: string): void {
      const now = Date.now();
      // A previous refresh already ran for this channel and the row still is not
      // cached — the channel sits outside the list windows, so retrying now
      // would burn the same O(channels) query for the same empty result.
      const lastAttempt = unresolvedChannelAttempts.get(channelId);
      if (
        lastAttempt !== undefined &&
        now - lastAttempt < UNKNOWN_CHANNEL_REFRESH_BACKOFF_MS
      ) {
        return;
      }
      pendingUnknownChannels.add(channelId);
      if (channelListRefreshTimer) return;
      channelListRefreshTimer = setTimeout(() => {
        channelListRefreshTimer = null;
        const attemptedAt = Date.now();
        for (const attemptedChannelId of pendingUnknownChannels) {
          unresolvedChannelAttempts.set(attemptedChannelId, attemptedAt);
        }
        pendingUnknownChannels.clear();
        pruneUnresolvedChannelAttempts(attemptedAt);
        queryClient.invalidateQueries({ queryKey: ['workspace-topics'] });
        queryClient.invalidateQueries({ queryKey: ['channels'] });
      }, UNKNOWN_CHANNEL_LIST_REFRESH_MS);
    }

    /**
     * Drop expired back-off marks, then oldest-first down to the cap. A channel
     * whose row DID materialize never reaches the map lookup again anyway
     * (`hasCachedChannelRow` short-circuits), so eviction only costs one extra
     * refresh in the worst case.
     */
    function pruneUnresolvedChannelAttempts(now: number): void {
      for (const [channelId, attemptedAt] of unresolvedChannelAttempts) {
        if (now - attemptedAt >= UNKNOWN_CHANNEL_REFRESH_BACKOFF_MS) {
          unresolvedChannelAttempts.delete(channelId);
        }
      }
      while (
        unresolvedChannelAttempts.size > UNKNOWN_CHANNEL_BACKOFF_MAX_ENTRIES
      ) {
        const oldest = unresolvedChannelAttempts.keys().next();
        if (oldest.done) break;
        unresolvedChannelAttempts.delete(oldest.value);
      }
    }

    /**
     * Debounced per-channel roster refetch, batched across a status burst. Only
     * channels the client already holds a roster for are scheduled: a status
     * event for a channel no surface has queried has nothing to refresh. The
     * debounce RESETS on each status so a walking turn lands one refetch after
     * it settles, capped by `AGENT_STATUS_ROSTER_MAX_WAIT_MS` so a continuous
     * burst cannot starve it.
     */
    function scheduleRosterRefresh(channelId: string): void {
      if (
        queryClient.getQueryData(['channel-roster', channelId]) === undefined
      ) {
        return;
      }
      pendingRosterChannels.add(channelId);
      const now = Date.now();
      if (!rosterInvalidateTimer) rosterBurstStartedAt = now;
      else if (now - rosterBurstStartedAt >= AGENT_STATUS_ROSTER_MAX_WAIT_MS) {
        // Burst has run past the max wait — let the armed timer fire.
        return;
      } else {
        clearTimeout(rosterInvalidateTimer);
      }
      rosterInvalidateTimer = setTimeout(() => {
        rosterInvalidateTimer = null;
        const channelIds = Array.from(pendingRosterChannels);
        pendingRosterChannels.clear();
        for (const pendingChannelId of channelIds) {
          queryClient.invalidateQueries({
            queryKey: ['channel-roster', pendingChannelId],
          });
        }
      }, AGENT_STATUS_ROSTER_REFRESH_MS);
    }

    const handlers: {
      [K in EventMessage['type']]?: (
        msg: Extract<EventMessage, { type: K }>
      ) => void;
    } = {
      'worktrees-changed': () => {
        useSessionsStore.getState().refreshAll();
      },
      'session-backend-state-changed': (msg) => {
        queryClient.invalidateQueries({ queryKey: ['active-work'] });
        useSessionsStore
          .getState()
          .handleBackendStateChanged(
            msg.sessionId,
            msg.state,
            msg.permissionType,
            eventSessionScope(msg)
          );
      },
      'session-durability-changed': (msg) => {
        // Push the transition into the session store so badges + disabled
        // controls update without refetching the whole list. The hub
        // emits one event per real change, so this is a thin handler.
        queryClient.invalidateQueries({ queryKey: ['active-work'] });
        useSessionsStore
          .getState()
          .handleDurabilityChanged(
            msg.sessionId,
            msg.to,
            eventSessionScope(msg)
          );
      },
      'session-renamed': (msg) => {
        const scope = eventSessionScope(msg);
        const repoPath = sessionRepoPath(msg.sessionId, scope);
        useSessionsStore
          .getState()
          .renameSession(msg.sessionId, msg.branchName, msg.displayName, scope);
        if (repoPath) invalidateScopedPrData([repoPath], 'manual');
      },
      'session-branch-changed': (msg) => {
        const scope = eventSessionScope(msg);
        const repoPaths = resolveRepoPaths([
          msg.cwdPath ?? '',
          sessionRepoPath(msg.sessionId, scope) ?? '',
        ]);
        useSessionsStore
          .getState()
          .handleBranchChanged(msg.sessionId, msg.branch, scope);
        if (repoPaths.length > 0) invalidateScopedPrData(repoPaths, 'manual');
      },
      'session-created': () => {
        queryClient.invalidateQueries({ queryKey: ['active-work'] });
        useSessionsStore.getState().refreshAll();
      },
      'session-ended': (msg) => {
        queryClient.invalidateQueries({ queryKey: ['active-work'] });
        const scope = eventSessionScope(msg);
        const repoPaths = resolveRepoPaths([
          msg.cwd ?? '',
          sessionRepoPath(msg.sessionId, scope) ?? '',
        ]);
        if (repoPaths.length > 0) invalidateScopedPrData(repoPaths, 'manual');
        useSessionsStore.getState().refreshAll();
      },
      'ref-changed': (msg) => {
        invalidateScopedPrData(resolveRepoPaths([msg.cwdPath]), 'manual');
      },
      'pr-updated': (msg) => {
        throttledWebhookInvalidate(repoPathsFromPrOrCiMessage(msg));
      },
      'ci-updated': (msg) => {
        throttledWebhookInvalidate(repoPathsFromPrOrCiMessage(msg));
      },
      'files-changed': (msg) => {
        const sessionsState = useSessionsStore.getState();
        const currentActiveSessionId = sessionsState.activeSessionId;
        const currentActiveSession = currentActiveSessionId
          ? resolveSessionByKey(sessionsState.sessions, currentActiveSessionId)
          : undefined;
        const activeWs =
          currentActiveSession?.worktreePath ?? currentActiveSession?.repoPath;
        if (activeWs === msg.workspacePath) {
          throttledChangedFilesRefresh();
          queryClient.invalidateQueries({ queryKey: ['files-list'] });
          queryClient.invalidateQueries({
            queryKey: ['changedFiles', msg.workspacePath],
          });
          queryClient.invalidateQueries({
            queryKey: ['fileDiff', msg.workspacePath],
          });
          if (msg.changedFiles) {
            setChangedFilesData(msg.changedFiles);
          }
        }
      },
      'session-activity-changed': (msg) => {
        queryClient.invalidateQueries({ queryKey: ['active-work'] });
        useSessionsStore
          .getState()
          .handleActivityChanged(
            msg.sessionId,
            msg.timestamp,
            msg.currentActivity ?? undefined,
            eventSessionScope(msg)
          );
      },
      'session-telemetry': (msg) => {
        useTelemetryStore
          .getState()
          .handleSessionTelemetryEvent(
            msg.sessionId,
            msg.data as SessionTelemetry | Record<string, unknown>,
            eventSessionScope(msg)
          );
      },
      'tab-control-event': (msg) => {
        useSessionsStore.getState().handleTabControlEvent(msg.event);
        queryClient.invalidateQueries({ queryKey: ['session-interventions'] });
        queryClient.invalidateQueries({ queryKey: ['active-work'] });
      },
      'node.status': (msg) => {
        applyHubNodeStatusEvent(queryClient, msg);
        queryClient.invalidateQueries({ queryKey: ['active-work'] });
      },
      'account-telemetry': (msg) => {
        useTelemetryStore
          .getState()
          .handleAccountTelemetryEvent(
            msg.data as AccountTelemetry | Record<string, unknown> | null
          );
      },
      'channel-activity': (msg) => {
        useChannelActivityStore
          .getState()
          .recordActivity(msg.channelId, msg.latestSeq);
        // An agent- or orchestrator-created channel (#1242) has no row in any
        // cached list, so the seq just recorded is inert: nothing renders it and
        // the lists only refetch on blur/refocus — never on a tab left focused.
        // Pull the new row in instead of waiting for a window event.
        if (!hasCachedChannelRow(queryClient, msg.channelId)) {
          scheduleChannelListRefresh(msg.channelId);
        }
      },
      'channel-read-state': (msg) => {
        // The operator moved their mark on another device (#1308 slice 3).
        // Straight through the SAME fence-aware monotonic-up merge the boot
        // seed uses, so live convergence cannot acquire semantics the seed does
        // not have. Stamped with receipt time because a broadcast is by
        // construction newer than any clamp this device has already applied —
        // and the hub clamps to head before emitting, so the value it carries
        // is a real seq in the channel's CURRENT life, not a resurrected one.
        useChannelActivityStore
          .getState()
          .mergeReadState(
            [{ channelId: msg.channelId, lastReadSeq: msg.lastReadSeq }],
            Date.now()
          );
      },
      'channel-agent-status': (msg) => {
        // Read BEFORE the store records the new value: turn-complete is a
        // busy→idle EDGE, and the previous status is gone the instant
        // `recordStatus` lands.
        const previous =
          useChannelAgentStatusStore.getState().statusByChannelAgent[
            channelAgentStatusKey(msg.channelId, msg.agentId)
          ];
        useChannelAgentStatusStore.getState().recordStatus(
          msg.channelId,
          msg.agentId,
          msg.status,
          msg.runtimeId,
          // A hub that predates #1308 slice 4 omits the field; absent means
          // "nothing queued", which is also what an unqueued binding reports.
          msg.queuedCount ?? 0
        );
        // #1308 slice 5: the ONE trigger the socket carries end to end. Default
        // OFF, so this is inert until the operator opts in from Settings.
        const notifyChannel = cachedNotifyChannel(queryClient, msg.channelId);
        if (notifyChannel) {
          notifyFromAgentStatus({
            channel: notifyChannel,
            agentId: msg.agentId,
            previous,
            next: msg.status,
          });
        }
        // The status store alone cannot carry a binding: a newly bound agent's
        // chip is dropped the moment it goes idle (the header keeps a chip for
        // an unbound agent only while it is busy), and a remotely-designated
        // orchestrator leaves a stale "designate orchestrator" button. Both read
        // the roster snapshot, so refetch it.
        scheduleRosterRefresh(msg.channelId);
      },
      'browser-tab-opened': (msg) => {
        useUiStore.getState().openHtmlTab(msg.filePath, msg.token);
      },
      'browser-tab-refreshed': (msg) => {
        useUiStore.getState().refreshHtmlTab(msg.filePath);
      },
      'server-restarting': () => {
        const state = useSessionsStore.getState();
        state.setBackendConnectionStatus('restarting');
        const activeSessionId = state.activeSessionId;
        if (activeSessionId) {
          const activeSession = resolveSessionByKey(
            state.sessions,
            activeSessionId
          );
          if (activeSession && activeSession.mode === 'pty') {
            state.beginPtyReconnect(activeSessionId);
          }
        }
      },
    };

    connectEventSocket(
      (msg) => {
        const handler = handlers[msg.type];
        if (handler) (handler as (msg: EventMessage) => void)(msg);
      },
      () => {
        if (eventSocketOpened) {
          void refreshAfterReconnect();
        } else {
          useSessionsStore.getState().setBackendConnectionStatus('connected');
          void useTelemetryStore.getState().refreshTelemetry();
        }
        eventSocketOpened = true;
      },
      () => {
        useAuthStore.getState().deauthenticate();
      },
      (status) => {
        const sessions = useSessionsStore.getState();
        if (
          status === 'reconnecting' &&
          sessions.backendConnectionStatus === 'restarting'
        ) {
          return;
        }
        sessions.setBackendConnectionStatus(status);
      }
    );

    return () => {
      pendingWebhookRepos.clear();
      pendingRosterChannels.clear();
      pendingUnknownChannels.clear();
      unresolvedChannelAttempts.clear();
      if (pollInvalidateTimer) {
        clearTimeout(pollInvalidateTimer);
        pollInvalidateTimer = null;
      }
      if (channelListRefreshTimer) {
        clearTimeout(channelListRefreshTimer);
        channelListRefreshTimer = null;
      }
      if (rosterInvalidateTimer) {
        clearTimeout(rosterInvalidateTimer);
        rosterInvalidateTimer = null;
      }
    };
  }, [authAuthenticated]);
}
