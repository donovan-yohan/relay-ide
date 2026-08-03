// Trailing-hold driver for the in-timeline presence rows (#1277).
//
// `ChannelView` derives "which agents own a live streaming row in the main
// lane" from the reducer on every render. That set drops to empty in the gap
// between two assistant items of the SAME turn, which would strobe the presence
// row at the foot of the timeline. This hook wraps the pure hold state machine
// in `channel-agent-presence.ts` and re-renders exactly once when the hold
// lapses, so the row returns only after a real quiet window.
import { useEffect, useMemo, useState } from 'react';
import {
  advanceStreamingHold,
  nextStreamingHoldExpiry,
  sameStreamingHold,
  PRESENCE_STREAM_HOLD_MS,
  type AgentIdMembership,
} from '../../lib/chat/channel-agent-presence.js';

/**
 * Membership probe that answers "is this agent suppressed?" — true while it owns
 * a live streaming row, and for `holdMs` after that row closes.
 */
export function useStreamingPresenceHold(
  liveStreamingAgentIds: ReadonlySet<string>,
  holdMs: number = PRESENCE_STREAM_HOLD_MS
): AgentIdMembership {
  const [hold, setHold] = useState<ReadonlyMap<string, number>>(
    () => new Map<string, number>()
  );

  useEffect(() => {
    setHold((previous) => {
      const next = advanceStreamingHold(
        previous,
        liveStreamingAgentIds,
        Date.now(),
        holdMs
      );
      return sameStreamingHold(previous, next) ? previous : next;
    });
  }, [liveStreamingAgentIds, holdMs]);

  useEffect(() => {
    const expiry = nextStreamingHoldExpiry(hold);
    if (expiry === null) return;
    const timer = setTimeout(
      () =>
        setHold((previous) => {
          const next = advanceStreamingHold(
            previous,
            liveStreamingAgentIds,
            Date.now(),
            holdMs
          );
          return sameStreamingHold(previous, next) ? previous : next;
        }),
      Math.max(0, expiry - Date.now()) + 1
    );
    return () => clearTimeout(timer);
  }, [hold, liveStreamingAgentIds, holdMs]);

  // Union the live set in at render time: a row that opened this very render is
  // suppressed immediately rather than after the effect commits, so the presence
  // row never double-renders with a fresh block cursor for one frame.
  return useMemo(
    () => ({
      has: (agentId: string) =>
        liveStreamingAgentIds.has(agentId) || hold.has(agentId),
    }),
    [liveStreamingAgentIds, hold]
  );
}

export default useStreamingPresenceHold;
