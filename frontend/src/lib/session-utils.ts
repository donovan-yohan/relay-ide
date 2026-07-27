import { useSessionsStore } from './stores/sessions.js';
import { useUiStore } from './stores/ui.js';
import { resolveSessionByKey } from './session-keys.js';
import type { Repo, SessionSummary } from './types.js';
import type { NodeId } from '../../../shared/identity.js';
import type { SessionLane } from '../../../shared/session-lane.js';
import {
  executeSessionCreateAction,
  type SessionCreateActionFailure,
} from './actions/session-create.js';

export interface CreateTerminalSessionOptions {
  nodeId?: NodeId | undefined;
  repoPath?: string | undefined;
  worktreePath?: string | null | undefined;
  cwd?: string | undefined;
  mode?: 'pty' | undefined;
  branchName?: string | undefined;
  terminalBackend?: 'relay-pty' | undefined;
  cols?: number | undefined;
  rows?: number | undefined;
  needsBranchRename?: boolean | undefined;
  newWorktree?: boolean | undefined;
  branchRenamePrompt?: string | undefined;
  sessionLane?: SessionLane | undefined;
  /** #740: env overrides inherited from the anchoring Bench, applied additively
   *  to the spawned PTY env. The backend refuses reserved keys (`PATH`,
   *  `RELAY_*`). */
  envOverrides?: Record<string, string> | undefined;
}

export interface CurrentSessionContext {
  currentRepoPath: string | null;
  currentActiveWorkspace: Repo | undefined;
  currentActiveSession: SessionSummary | undefined;
  currentWorktreePath: string | null;
}

export interface CreateTerminalSessionResult {
  session: SessionSummary | undefined;
  error: unknown;
}

function conflictSessionIdFromFailure(
  failure: SessionCreateActionFailure
): string | undefined {
  const stableSessionId = failure.error.details?.sessionId;
  if (
    failure.error.code === 'SESSION_CONFLICT' &&
    typeof stableSessionId === 'string'
  ) {
    return stableSessionId;
  }

  return undefined;
}

export function getCurrentSessionContext(): CurrentSessionContext {
  const sessionsStore = useSessionsStore.getState();
  const currentRepoPath = useUiStore.getState().activeRepoPath;
  const currentActiveWorkspace = currentRepoPath
    ? sessionsStore.repos.find(
        (workspace) => workspace.path === currentRepoPath
      )
    : undefined;
  const currentActiveSession = sessionsStore.activeSessionId
    ? resolveSessionByKey(sessionsStore.sessions, sessionsStore.activeSessionId)
    : undefined;

  return {
    currentRepoPath,
    currentActiveWorkspace,
    currentActiveSession,
    currentWorktreePath: currentActiveSession?.worktreePath ?? null,
  };
}

function restoreSessionPlacement(
  activeSessionId: string | null,
  workspaceLastSession: Record<string, string>
): void {
  const liveSessions = useSessionsStore.getState().sessions;
  useSessionsStore.setState({
    activeSessionId:
      activeSessionId && resolveSessionByKey(liveSessions, activeSessionId)
        ? activeSessionId
        : null,
    workspaceLastSession: Object.fromEntries(
      Object.entries(workspaceLastSession).filter(([, id]) =>
        Boolean(resolveSessionByKey(liveSessions, id))
      )
    ),
  });
}

export async function createSessionWithoutActivation(
  options: CreateTerminalSessionOptions
): Promise<CreateTerminalSessionResult> {
  const before = useSessionsStore.getState();
  const activeSessionId = before.activeSessionId;
  const workspaceLastSession = { ...before.workspaceLastSession };
  const action = await executeSessionCreateAction({
    ...options,
    type: 'terminal',
  });

  if (action.ok) {
    let refreshError: unknown = null;
    try {
      await useSessionsStore.getState().refreshAll();
    } catch (error) {
      refreshError = error;
    }
    restoreSessionPlacement(activeSessionId, workspaceLastSession);
    return { session: action.data, error: refreshError };
  }

  const failure = action as SessionCreateActionFailure;
  const error = failure.error;
  const conflictingSessionId = conflictSessionIdFromFailure(failure);
  if (conflictingSessionId) {
    let refreshError: unknown = null;
    try {
      await useSessionsStore.getState().refreshAll();
    } catch (caughtRefreshError) {
      refreshError = caughtRefreshError;
    }
    const session = conflictingSessionId
      ? resolveSessionByKey(
          useSessionsStore.getState().sessions,
          conflictingSessionId
        )
      : undefined;
    restoreSessionPlacement(activeSessionId, workspaceLastSession);
    return { session, error: refreshError ?? error };
  }

  return { session: undefined, error };
}

export async function createTerminalSession(
  options: CreateTerminalSessionOptions
): Promise<CreateTerminalSessionResult> {
  const action = await executeSessionCreateAction({
    ...options,
    type: 'terminal',
  });

  if (action.ok) {
    let refreshError: unknown = null;
    try {
      await useSessionsStore.getState().refreshAll();
    } catch (error) {
      refreshError = error;
    }
    useSessionsStore.getState().setActiveSessionId(action.data.id);
    return { session: action.data, error: refreshError };
  }

  const failure = action as SessionCreateActionFailure;
  const error = failure.error;
  const conflictingSessionId = conflictSessionIdFromFailure(failure);
  if (conflictingSessionId) {
    let refreshError: unknown = null;
    try {
      await useSessionsStore.getState().refreshAll();
    } catch (caughtRefreshError) {
      refreshError = caughtRefreshError;
    }
    const session = conflictingSessionId
      ? resolveSessionByKey(
          useSessionsStore.getState().sessions,
          conflictingSessionId
        )
      : undefined;
    if (conflictingSessionId) {
      useSessionsStore.getState().setActiveSessionId(conflictingSessionId);
    }
    return { session, error: refreshError ?? error };
  }

  return { session: undefined, error };
}
