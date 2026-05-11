export type NodeId = string;
export type LocalSessionId = string;
export type GlobalSessionId = string;
export type RepoIdentity = string;
export type RepoInstanceId = string;
export type WorktreeInstanceId = string;

export const DEFAULT_LOCAL_NODE_ID: NodeId = 'local';

function hasValue(value: string): boolean {
  return value.trim().length > 0;
}

function createScopedId(
  nodeId: NodeId,
  localId: string,
  localIdName: string
): string {
  if (!hasValue(nodeId)) throw new Error('nodeId is required');
  if (!hasValue(localId)) throw new Error(`${localIdName} is required`);
  return `${encodeURIComponent(nodeId)}:${encodeURIComponent(localId)}`;
}

function parseScopedId(
  scopedId: string
): { nodeId: NodeId; localId: string } | null {
  const separator = scopedId.indexOf(':');
  if (
    separator <= 0 ||
    separator === scopedId.length - 1 ||
    separator !== scopedId.lastIndexOf(':')
  ) {
    return null;
  }

  try {
    const nodeId = decodeURIComponent(scopedId.slice(0, separator));
    const localId = decodeURIComponent(scopedId.slice(separator + 1));
    if (!hasValue(nodeId) || !hasValue(localId)) return null;
    return { nodeId, localId };
  } catch {
    return null;
  }
}

export function createGlobalSessionId(
  nodeId: NodeId,
  localSessionId: LocalSessionId
): GlobalSessionId {
  return createScopedId(nodeId, localSessionId, 'localSessionId');
}

export function parseGlobalSessionId(
  globalSessionId: GlobalSessionId
): { nodeId: NodeId; localSessionId: LocalSessionId } | null {
  const parsed = parseScopedId(globalSessionId);
  if (!parsed) return null;
  return { nodeId: parsed.nodeId, localSessionId: parsed.localId };
}

export function createRepoInstanceId(
  nodeId: NodeId,
  localPath: string
): RepoInstanceId {
  return createScopedId(nodeId, localPath, 'localPath');
}

export function parseRepoInstanceId(
  repoInstanceId: RepoInstanceId
): { nodeId: NodeId; localPath: string } | null {
  const parsed = parseScopedId(repoInstanceId);
  if (!parsed) return null;
  return { nodeId: parsed.nodeId, localPath: parsed.localId };
}

export function createWorktreeInstanceId(
  nodeId: NodeId,
  localPath: string
): WorktreeInstanceId {
  return createScopedId(nodeId, localPath, 'localPath');
}

export function parseWorktreeInstanceId(
  worktreeInstanceId: WorktreeInstanceId
): { nodeId: NodeId; localPath: string } | null {
  const parsed = parseScopedId(worktreeInstanceId);
  if (!parsed) return null;
  return { nodeId: parsed.nodeId, localPath: parsed.localId };
}
