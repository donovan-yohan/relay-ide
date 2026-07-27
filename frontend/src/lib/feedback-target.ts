import type { SessionSummary } from './types.js';
import { resolveSessionByKey, scopedSessionKey } from './session-keys.js';

export function initialFeedbackTarget(
  sessions: SessionSummary[],
  preferredTargetSessionId: string | null
): string {
  const preferredTarget = resolveSessionByKey(
    sessions,
    preferredTargetSessionId
  );
  if (preferredTarget) return scopedSessionKey(preferredTarget);

  return sessions[0] ? scopedSessionKey(sessions[0]) : '';
}

export function resolveFeedbackTarget(
  sessions: SessionSummary[],
  preferredTargetSessionId: string | null,
  currentTargetSessionId: string
): string {
  const currentTarget = resolveSessionByKey(sessions, currentTargetSessionId);
  return currentTarget
    ? scopedSessionKey(currentTarget)
    : initialFeedbackTarget(sessions, preferredTargetSessionId);
}
