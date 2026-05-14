import type { NodeId } from '../../../shared/identity.js';

const REMOTE_NODE_CWD_STORAGE_PREFIX = 'relay-ide.remote-node-cwd.';

export function cleanCwd(value: string | undefined): string {
  return value?.trim() ?? '';
}

export function remoteNodeCwdStorageKey(nodeId: NodeId): string {
  return `${REMOTE_NODE_CWD_STORAGE_PREFIX}${nodeId}`;
}

export function readRememberedRemoteCwd(nodeId: NodeId): string | null {
  try {
    const remembered = window.localStorage.getItem(
      remoteNodeCwdStorageKey(nodeId)
    );
    return remembered?.trim() ? remembered : null;
  } catch {
    return null;
  }
}

export function rememberRemoteCwd(nodeId: NodeId, cwd: string): void {
  const trimmed = cleanCwd(cwd);
  if (!trimmed) return;
  try {
    window.localStorage.setItem(remoteNodeCwdStorageKey(nodeId), trimmed);
  } catch {
    // localStorage can be unavailable in private contexts; launching still works.
  }
}

export function defaultRemoteCwd(
  homeDir: string | undefined,
  nodeId: NodeId
): string {
  return readRememberedRemoteCwd(nodeId) ?? cleanCwd(homeDir);
}
