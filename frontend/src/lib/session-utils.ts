import { ConflictError, createSession as createSessionApi } from './api.js';
import { useSessionsStore } from './stores/sessions.js';
import { useUiStore } from './stores/ui.js';
import type { Repo, SessionSummary } from './types.js';

export interface CreateAgentSessionOptions {
  repoPath: string;
  worktreePath?: string | null | undefined;
  type?: 'agent' | 'terminal' | undefined;
  mode?: 'pty' | 'web' | undefined;
  continue?: boolean | undefined;
  branchName?: string | undefined;
  claudeArgs?: string[] | undefined;
  yolo?: boolean | undefined;
  agent?: string | undefined;
  useTmux?: boolean | undefined;
  cols?: number | undefined;
  rows?: number | undefined;
  needsBranchRename?: boolean | undefined;
  newWorktree?: boolean | undefined;
  branchRenamePrompt?: string | undefined;
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

export function getCurrentSessionContext(): CurrentSessionContext {
  const sessionsStore = useSessionsStore.getState();
  const currentRepoPath = useUiStore.getState().activeRepoPath;
  const currentActiveWorkspace = currentRepoPath
    ? sessionsStore.repos.find(
        (workspace) => workspace.path === currentRepoPath
      )
    : undefined;
  const currentActiveSession = sessionsStore.activeSessionId
    ? sessionsStore.sessions.find(
        (session) => session.id === sessionsStore.activeSessionId
      )
    : undefined;

  return {
    currentRepoPath,
    currentActiveWorkspace,
    currentActiveSession,
    currentWorktreePath: currentActiveSession?.worktreePath ?? null,
  };
}

export async function createAgentSession(
  options: CreateAgentSessionOptions
): Promise<CreateAgentSessionResult> {
  try {
    const session = await createSessionApi(options);
    await useSessionsStore.getState().refreshAll();
    useSessionsStore.getState().setActiveSessionId(session.id);
    return { session, error: null };
  } catch (error) {
    if (error instanceof ConflictError) {
      await useSessionsStore.getState().refreshAll();
      const conflictingSessionId = error.sessionId;
      const session = conflictingSessionId
        ? useSessionsStore
            .getState()
            .sessions.find((existing) => existing.id === conflictingSessionId)
        : undefined;
      if (conflictingSessionId) {
        useSessionsStore.getState().setActiveSessionId(conflictingSessionId);
      }
      return { session, error };
    }

    return { session: undefined, error };
  }
}
