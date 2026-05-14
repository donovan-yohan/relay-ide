import { parseGlobalSessionId } from '../../../shared/identity.js';
import type { SessionSummary } from './types.js';
import type { WorkspaceTab, WorkspaceTabId } from './workspace-layout.js';
import { workspaceTabId } from './workspace-layout.js';
import { resolveSessionByKey } from './session-keys.js';

export interface WorkspaceSessionCloseTarget {
  sessionId: string;
  nodeId?: string;
}

export function resolveWorkspaceSessionCloseTarget(
  tabs: WorkspaceTab[],
  tabId: WorkspaceTabId,
  sessions: Pick<SessionSummary, 'id' | 'nodeId' | 'globalSessionId'>[]
): WorkspaceSessionCloseTarget | null {
  if (!tabId.startsWith('session::')) return null;

  const sessionKey = tabId.slice('session::'.length);
  const tab = tabs.find((t) => workspaceTabId(t) === tabId);
  const tabNodeId = tab?.kind === 'session' ? tab.nodeId : undefined;
  const session = resolveSessionByKey(sessions, sessionKey);
  const nodeId = session?.nodeId ?? tabNodeId;
  const parsedTabSession = tabNodeId ? parseGlobalSessionId(sessionKey) : null;
  const fallbackSessionId =
    parsedTabSession && parsedTabSession.nodeId === tabNodeId
      ? parsedTabSession.localSessionId
      : sessionKey;

  return {
    sessionId: session?.id ?? fallbackSessionId,
    ...(nodeId ? { nodeId } : {}),
  };
}
