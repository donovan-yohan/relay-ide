import {
  DEFAULT_LOCAL_NODE_ID,
  createGlobalSessionId,
  createRepoInstanceId,
  createWorktreeInstanceId,
  type GlobalSessionId,
  type LocalSessionId,
  type NodeId,
  type RepoInstanceId,
  type WorktreeInstanceId,
} from './identity.js';

export type EnvironmentId = string;
export type EnvironmentAuthority = 'local-node';

export const DEFAULT_LOCAL_ENVIRONMENT_ID: EnvironmentId = 'local';

export interface NodeEventAuthority {
  nodeId: NodeId;
  environmentId: EnvironmentId;
  authority: EnvironmentAuthority;
}

export interface NodeScopedSessionEvent extends NodeEventAuthority {
  sessionId: LocalSessionId;
  localSessionId: LocalSessionId;
  globalSessionId: GlobalSessionId;
}

export interface NodeScopedFileEvent extends NodeEventAuthority {
  workspacePath: string;
  repoInstanceId?: RepoInstanceId;
  worktreePath?: string;
  worktreeInstanceId?: WorktreeInstanceId;
}

export interface SessionScopeCandidate {
  id?: LocalSessionId;
  sessionId?: LocalSessionId;
  localSessionId?: LocalSessionId;
  nodeId?: NodeId;
  globalSessionId?: GlobalSessionId;
}

export interface SessionEventScope {
  sessionId?: LocalSessionId;
  localSessionId?: LocalSessionId;
  nodeId?: NodeId;
  globalSessionId?: GlobalSessionId;
}

export function nodeSessionWebSocketPath(
  nodeId: NodeId,
  sessionId: LocalSessionId
): string {
  return `/nodes/${encodeURIComponent(nodeId)}/ws/sessions/${encodeURIComponent(
    sessionId
  )}`;
}

export function createLocalEventAuthority(
  overrides: Partial<Pick<NodeEventAuthority, 'nodeId' | 'environmentId'>> = {}
): NodeEventAuthority {
  return {
    nodeId: overrides.nodeId ?? DEFAULT_LOCAL_NODE_ID,
    environmentId: overrides.environmentId ?? DEFAULT_LOCAL_ENVIRONMENT_ID,
    authority: 'local-node',
  };
}

export function createNodeScopedSessionEvent(
  sessionId: LocalSessionId,
  overrides: Partial<Pick<NodeEventAuthority, 'nodeId' | 'environmentId'>> = {}
): NodeScopedSessionEvent {
  const authority = createLocalEventAuthority(overrides);
  return {
    ...authority,
    sessionId,
    localSessionId: sessionId,
    globalSessionId: createGlobalSessionId(authority.nodeId, sessionId),
  };
}

export function createNodeScopedFileEvent({
  workspacePath,
  worktreePath,
  nodeId,
  environmentId,
}: {
  workspacePath: string;
  worktreePath?: string | null;
  nodeId?: NodeId;
  environmentId?: EnvironmentId;
}): NodeScopedFileEvent {
  const authority = createLocalEventAuthority({
    ...(nodeId !== undefined ? { nodeId } : {}),
    ...(environmentId !== undefined ? { environmentId } : {}),
  });
  return {
    ...authority,
    workspacePath,
    ...(workspacePath
      ? {
          repoInstanceId: createRepoInstanceId(authority.nodeId, workspacePath),
        }
      : {}),
    ...(worktreePath
      ? {
          worktreePath,
          worktreeInstanceId: createWorktreeInstanceId(
            authority.nodeId,
            worktreePath
          ),
        }
      : {}),
  };
}

function localSessionIdOf(
  value: SessionScopeCandidate | SessionEventScope
): string | undefined {
  return (
    value.localSessionId ??
    value.sessionId ??
    ('id' in value ? value.id : undefined)
  );
}

export function sessionEventMatches(
  candidate: SessionScopeCandidate,
  event: SessionEventScope
): boolean {
  if (event.globalSessionId) {
    return candidate.globalSessionId === event.globalSessionId;
  }

  const candidateLocalId = localSessionIdOf(candidate);
  const eventLocalId = localSessionIdOf(event);
  if (!candidateLocalId || !eventLocalId || candidateLocalId !== eventLocalId) {
    return false;
  }

  if (event.nodeId) {
    return candidate.nodeId === event.nodeId;
  }

  return true;
}

export function sessionScopeFromEvent(
  event: SessionEventScope
): SessionEventScope {
  const localSessionId = localSessionIdOf(event);
  return {
    ...(localSessionId ? { sessionId: localSessionId, localSessionId } : {}),
    ...(event.nodeId ? { nodeId: event.nodeId } : {}),
    ...(event.globalSessionId
      ? { globalSessionId: event.globalSessionId }
      : {}),
  };
}
