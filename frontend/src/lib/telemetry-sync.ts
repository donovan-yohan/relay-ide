import type { AccountTelemetry, SessionTelemetry } from './types.js';

function parseUpdatedAt(value: string | null | undefined): number {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function pickNewerSessionTelemetry(
  current: SessionTelemetry | undefined,
  incoming: SessionTelemetry,
): SessionTelemetry {
  if (!current) return incoming;
  return parseUpdatedAt(incoming.updatedAt) >= parseUpdatedAt(current.updatedAt) ? incoming : current;
}

export function pickNewerAccountTelemetry(
  current: AccountTelemetry | null,
  incoming: AccountTelemetry,
): AccountTelemetry {
  if (!current) return incoming;
  return parseUpdatedAt(incoming.updatedAt) >= parseUpdatedAt(current.updatedAt) ? incoming : current;
}

export function mergeSessionTelemetrySnapshot(
  currentSessions: Record<string, SessionTelemetry>,
  incomingSessions: SessionTelemetry[],
  requestStartedAt: string,
): Record<string, SessionTelemetry> {
  const requestStartedMs = parseUpdatedAt(requestStartedAt);
  const next: Record<string, SessionTelemetry> = {};
  const incomingIds = new Set<string>();

  for (const incoming of incomingSessions) {
    incomingIds.add(incoming.sessionId);
    next[incoming.sessionId] = pickNewerSessionTelemetry(currentSessions[incoming.sessionId], incoming);
  }

  for (const [sessionId, current] of Object.entries(currentSessions)) {
    if (incomingIds.has(sessionId)) continue;
    if (parseUpdatedAt(current.updatedAt) > requestStartedMs) {
      next[sessionId] = current;
    }
  }

  return next;
}

export function mergeAccountTelemetrySnapshot(
  current: AccountTelemetry | null,
  incoming: AccountTelemetry | null,
  requestStartedAt: string,
): AccountTelemetry | null {
  if (incoming) return pickNewerAccountTelemetry(current, incoming);
  if (!current) return null;
  return parseUpdatedAt(current.updatedAt) > parseUpdatedAt(requestStartedAt) ? current : null;
}
