import type { SessionEvent } from './types.js';
import type { NodeId } from '../shared/identity.js';

export type SessionCategory = 'repo' | 'worktree' | 'free';

export interface SessionAttributionSource {
  id: string;
  repoPath?: string | null;
  worktreePath?: string | null;
  branchName?: string | null;
  nodeId?: NodeId | string;
}

export interface BuildSessionEventOptions {
  eventType: string;
  eventData?: Record<string, unknown>;
  timestamp?: string;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function getSessionCategory(
  session: Pick<SessionAttributionSource, 'repoPath' | 'worktreePath'>
): SessionCategory {
  if (!nonEmptyString(session.repoPath)) return 'free';
  return nonEmptyString(session.worktreePath) ? 'worktree' : 'repo';
}

/**
 * A concrete repo binding means git operations can safely use the session cwd.
 * `worktreePath === null` is an intentional repo-root session; `undefined`
 * means the tab is not repo-bound at all.
 */
export function hasConcreteRepoBinding(
  session: Pick<SessionAttributionSource, 'repoPath' | 'worktreePath'> & {
    cwd?: string | null;
  }
): boolean {
  return (
    nonEmptyString(session.repoPath) &&
    session.worktreePath !== undefined &&
    (session.worktreePath === null || nonEmptyString(session.worktreePath)) &&
    nonEmptyString(session.cwd)
  );
}

export function buildSessionEvent(
  session: SessionAttributionSource,
  options: BuildSessionEventOptions
): SessionEvent {
  const event: SessionEvent = {
    session_id: session.id,
    ...(nonEmptyString(session.nodeId) ? { node_id: session.nodeId } : {}),
    ...(nonEmptyString(session.repoPath) ? { repo_path: session.repoPath } : {}),
    ...(session.worktreePath === null
      ? { worktree_path: null }
      : nonEmptyString(session.worktreePath)
        ? { worktree_path: session.worktreePath }
        : {}),
    ...(nonEmptyString(session.branchName)
      ? { branch_name: session.branchName }
      : {}),
    session_category: getSessionCategory(session),
    event_type: options.eventType,
    ...(options.eventData !== undefined ? { event_data: options.eventData } : {}),
    timestamp: options.timestamp ?? new Date().toISOString(),
  };
  return event;
}
