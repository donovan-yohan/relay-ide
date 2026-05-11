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

export function createGlobalSessionId(
  nodeId: NodeId,
  localSessionId: LocalSessionId
): GlobalSessionId {
  if (!hasValue(nodeId)) throw new Error('nodeId is required');
  if (!hasValue(localSessionId)) throw new Error('localSessionId is required');
  return `${encodeURIComponent(nodeId)}:${encodeURIComponent(localSessionId)}`;
}

export function parseGlobalSessionId(
  globalSessionId: GlobalSessionId
): { nodeId: NodeId; localSessionId: LocalSessionId } | null {
  const separator = globalSessionId.indexOf(':');
  if (separator <= 0 || separator === globalSessionId.length - 1) return null;

  try {
    const nodeId = decodeURIComponent(globalSessionId.slice(0, separator));
    const localSessionId = decodeURIComponent(globalSessionId.slice(separator + 1));
    if (!hasValue(nodeId) || !hasValue(localSessionId)) return null;
    return { nodeId, localSessionId };
  } catch {
    return null;
  }
}

export function createRepoInstanceId(
  nodeId: NodeId,
  localPath: string
): RepoInstanceId {
  if (!hasValue(nodeId)) throw new Error('nodeId is required');
  if (!hasValue(localPath)) throw new Error('localPath is required');
  return `${nodeId}:${localPath}`;
}

export function createWorktreeInstanceId(
  nodeId: NodeId,
  localPath: string
): WorktreeInstanceId {
  if (!hasValue(nodeId)) throw new Error('nodeId is required');
  if (!hasValue(localPath)) throw new Error('localPath is required');
  return `${nodeId}:${localPath}`;
}
