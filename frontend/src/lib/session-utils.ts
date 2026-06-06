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

export interface CreateAgentSessionOptions {
  nodeId?: NodeId | undefined;
  repoPath?: string | undefined;
  worktreePath?: string | null | undefined;
  cwd?: string | undefined;
  type?: 'agent' | 'terminal' | undefined;
  mode?: 'pty' | 'web' | undefined;
  continue?: boolean | undefined;
  branchName?: string | undefined;
  claudeArgs?: string[] | undefined;
  yolo?: boolean | undefined;
  agent?: string | undefined;
  terminalBackend?: 'relay-pty' | 'tmux-compat' | undefined;
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
  ticketContext?: {
    ticketId: string;
    title: string;
    description?: string;
    url: string;
    source: 'github' | 'jira';
    repoPath: string;
    repoName: string;
  };
}

export interface CurrentSessionContext {
  currentRepoPath: string | null;
  currentActiveWorkspace: Repo | undefined;
  currentActiveSession: SessionSummary | undefined;
  currentWorktreePath: string | null;
}

export interface CreateAgentSessionResult {
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
  options: CreateAgentSessionOptions
): Promise<CreateAgentSessionResult> {
  const before = useSessionsStore.getState();
  const activeSessionId = before.activeSessionId;
  const workspaceLastSession = { ...before.workspaceLastSession };
  const action = await executeSessionCreateAction(options);

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

export async function createAgentSession(
  options: CreateAgentSessionOptions
): Promise<CreateAgentSessionResult> {
  const action = await executeSessionCreateAction(options);

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
