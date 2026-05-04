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

export function useEventSocket({
  authAuthenticated,
  queryClient,
  throttledChangedFilesRefresh,
  setChangedFilesData,
}: UseEventSocketParams): void {
  useEffect(() => {
    if (!authAuthenticated) return;

    const refChangedTimers = new Map<string, ReturnType<typeof setTimeout>>();
    let pollInvalidateTimer: ReturnType<typeof setTimeout> | null = null;

    function invalidatePrData(): void {
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['org-prs'] });
      useSessionsStore.getState().enrichSidebarBranches();
    }

    /** Throttled invalidation for poll-based events (pr-updated/ci-updated).
     *  Schedules one invalidation 500ms after the first event; subsequent
     *  events within the window are dropped. */
    function throttledPollInvalidate(): void {
      if (pollInvalidateTimer) return;
      pollInvalidateTimer = setTimeout(() => {
        pollInvalidateTimer = null;
        invalidatePrData();
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
        useSessionsStore
          .getState()
          .renameSession(msg.sessionId, msg.branchName, msg.displayName);
        invalidatePrData();
      },
      'session-branch-changed': (msg) => {
        useSessionsStore
          .getState()
          .handleBranchChanged(msg.sessionId, msg.branch);
      },
      'session-ended': () => {
        invalidatePrData();
        useSessionsStore.getState().refreshAll();
      },
      'ref-changed': (msg) => {
        const key = msg.cwdPath;
        const existing = refChangedTimers.get(key);
        if (existing) clearTimeout(existing);
        refChangedTimers.set(
          key,
          setTimeout(() => {
            refChangedTimers.delete(key);
            invalidatePrData();
          }, 5000)
        );
      },
      'pr-updated': () => {
        throttledPollInvalidate();
      },
      'ci-updated': () => {
        throttledPollInvalidate();
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
        void useTelemetryStore.getState().refreshTelemetry();
      },
      () => {
        useAuthStore.getState().deauthenticate();
      }
    );

    return () => {
      for (const timer of refChangedTimers.values()) clearTimeout(timer);
      refChangedTimers.clear();
      if (pollInvalidateTimer) {
        clearTimeout(pollInvalidateTimer);
        pollInvalidateTimer = null;
      }
    };
  }, [authAuthenticated]);
}
