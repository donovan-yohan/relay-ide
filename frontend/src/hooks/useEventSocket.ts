import { useEffect } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { connectEventSocket } from '../lib/ws.js';
import type { EventMessage } from '../lib/ws.js';
import { useAuthStore } from '../lib/stores/auth.js';
import { useSessionsStore } from '../lib/stores/sessions.js';
import { useTelemetryStore } from '../lib/stores/telemetry.js';
import { useUiStore } from '../lib/stores/ui.js';
import type { AccountTelemetry, SessionTelemetry } from '../lib/types.js';

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
      paths.add(session.repoPath);
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

function sessionRepoPath(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  return useSessionsStore
    .getState()
    .sessions.find((session) => session.id === sessionId)?.repoPath;
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
    let eventSocketOpened = false;
    const pendingWebhookRepos = new Set<string>();

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

    const handlers: {
      [K in EventMessage['type']]?: (
        msg: Extract<EventMessage, { type: K }>
      ) => void;
    } = {
      'worktrees-changed': () => {
        useSessionsStore.getState().refreshAll();
      },
      'session-backend-state-changed': (msg) => {
        useSessionsStore
          .getState()
          .handleBackendStateChanged(
            msg.sessionId,
            msg.state,
            msg.permissionType
          );
      },
      'session-renamed': (msg) => {
        const repoPath = sessionRepoPath(msg.sessionId);
        useSessionsStore
          .getState()
          .renameSession(msg.sessionId, msg.branchName, msg.displayName);
        if (repoPath) invalidateScopedPrData([repoPath], 'manual');
      },
      'session-branch-changed': (msg) => {
        const repoPaths = resolveRepoPaths([
          msg.cwdPath ?? '',
          sessionRepoPath(msg.sessionId) ?? '',
        ]);
        useSessionsStore
          .getState()
          .handleBranchChanged(msg.sessionId, msg.branch);
        if (repoPaths.length > 0) invalidateScopedPrData(repoPaths, 'manual');
      },
      'session-ended': (msg) => {
        const repoPaths = resolveRepoPaths([
          msg.cwd ?? '',
          sessionRepoPath(msg.sessionId) ?? '',
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
        const currentActiveSessionId =
          useSessionsStore.getState().activeSessionId;
        const currentActiveSession = currentActiveSessionId
          ? useSessionsStore
              .getState()
              .sessions.find((s) => s.id === currentActiveSessionId)
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
        useSessionsStore
          .getState()
          .handleActivityChanged(
            msg.sessionId,
            msg.timestamp,
            msg.currentActivity ?? undefined
          );
      },
      'session-telemetry': (msg) => {
        useTelemetryStore
          .getState()
          .handleSessionTelemetryEvent(
            msg.sessionId,
            msg.data as SessionTelemetry | Record<string, unknown>
          );
      },
      'account-telemetry': (msg) => {
        useTelemetryStore
          .getState()
          .handleAccountTelemetryEvent(
            msg.data as AccountTelemetry | Record<string, unknown> | null
          );
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
          const activeSession = state.sessions.find(
            (s) => s.id === activeSessionId
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
          useSessionsStore
            .getState()
            .setBackendConnectionStatus('connected');
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
      if (pollInvalidateTimer) {
        clearTimeout(pollInvalidateTimer);
        pollInvalidateTimer = null;
      }
    };
  }, [authAuthenticated]);
}
