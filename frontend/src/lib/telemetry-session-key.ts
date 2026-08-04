import {
  createGlobalSessionId,
  type GlobalSessionId,
  type LocalSessionId,
  type NodeId,
} from '../../../shared/identity.js';
import {
  sessionScopeFromEvent,
  type SessionEventScope,
} from '../../../shared/node-boundary.js';
import type { SessionSummary, SessionTelemetry } from './types.js';

export type TelemetrySessionScope = Pick<
  SessionTelemetry,
  'sessionId' | 'localSessionId' | 'nodeId' | 'globalSessionId'
>;

function scopedKeyFor(
  localSessionId: LocalSessionId,
  nodeId?: NodeId,
  globalSessionId?: GlobalSessionId
): string {
  if (globalSessionId) return globalSessionId;
  if (nodeId) return createGlobalSessionId(nodeId, localSessionId);
  return localSessionId;
}

export function telemetrySessionKeyFromScope(
  sessionId: string,
  scope?: SessionEventScope
): string {
  const normalized = sessionScopeFromEvent({ sessionId, ...(scope ?? {}) });
  const localSessionId = normalized.localSessionId ?? normalized.sessionId;
  if (!localSessionId) return sessionId;
  return scopedKeyFor(
    localSessionId,
    normalized.nodeId,
    normalized.globalSessionId
  );
}

export function telemetrySessionKeyFromSession(
  session: Pick<SessionSummary, 'id' | 'nodeId' | 'globalSessionId'>
): string {
  return scopedKeyFor(session.id, session.nodeId, session.globalSessionId);
}

export function telemetrySessionKeyFromTelemetry(
  telemetry: TelemetrySessionScope
): string {
  return telemetrySessionKeyFromScope(telemetry.sessionId, telemetry);
}
