import {
  createGlobalSessionId,
  parseGlobalSessionId,
} from '../../../shared/identity.js';
import type { SessionSummary } from './types.js';

type SessionIdentity = Pick<
  SessionSummary,
  'id' | 'nodeId' | 'globalSessionId'
>;

export function scopedSessionKey(session: SessionIdentity): string {
  if (session.globalSessionId) return session.globalSessionId;
  if (session.nodeId) return createGlobalSessionId(session.nodeId, session.id);
  return session.id;
}

export function sessionKeyMatches(
  session: SessionIdentity,
  sessionKey: string
): boolean {
  if (scopedSessionKey(session) === sessionKey) return true;
  if (session.nodeId || session.globalSessionId) return false;
  return session.id === sessionKey;
}

export function resolveSessionByKey<T extends SessionIdentity>(
  sessions: T[],
  sessionKey: string | null | undefined
): T | undefined {
  if (!sessionKey) return undefined;

  const scopedMatch = sessions.find(
    (session) => scopedSessionKey(session) === sessionKey
  );
  if (scopedMatch) return scopedMatch;

  const legacyMatches = sessions.filter((session) => session.id === sessionKey);
  if (legacyMatches.length === 1) return legacyMatches[0];

  const matchingNodes = new Set(
    legacyMatches.flatMap((session) => (session.nodeId ? [session.nodeId] : []))
  );
  return matchingNodes.size <= 1 ? legacyMatches[0] : undefined;
}

export interface SessionCloseTarget<T extends SessionIdentity> {
  session: T | undefined;
  sessionId: string;
  nodeId?: string;
}

export function resolveSessionCloseTarget<T extends SessionIdentity>(
  sessions: T[],
  sessionKey: string,
  nodeId?: string
): SessionCloseTarget<T> {
  const session = resolveSessionByKey(sessions, sessionKey);
  let sessionId = session?.id ?? sessionKey;
  let targetNodeId = session?.nodeId ?? nodeId;

  if (!session) {
    const parsed = parseGlobalSessionId(sessionKey);
    if (parsed && (!targetNodeId || parsed.nodeId === targetNodeId)) {
      sessionId = parsed.localSessionId;
      targetNodeId = parsed.nodeId;
    }
  }

  return targetNodeId
    ? { session, sessionId, nodeId: targetNodeId }
    : { session, sessionId };
}

export function resolveSessionKey(
  sessions: SessionIdentity[],
  sessionKey: string
): string {
  const session = resolveSessionByKey(sessions, sessionKey);
  return session ? scopedSessionKey(session) : sessionKey;
}

export function isLiveSessionKey(
  sessions: SessionIdentity[],
  sessionKey: string
): boolean {
  return resolveSessionByKey(sessions, sessionKey) !== undefined;
}
