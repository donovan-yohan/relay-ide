// In-timeline agent presence rows (#1277 slice 13). Slack renders "X is
// typing…" at the foot of the conversation; Relay renders "hermes is thinking…"
// there for every agent that is busy but has NOT yet opened a streaming row.
//
// No new transport: this is a pure projection of the header presence chips
// (`ChannelView` `agentChips`, itself `resolveEffectiveAgentStatus` over the
// roster query + the `channel-agent-status` socket store), so the row survives
// reload exactly as the chips do.
//
// The suppression rule is the load-bearing part. Once the bridge opens a
// streaming message row, `ChannelMessageRow` already draws the live block-cursor
// (DESIGN.md motion effect 4) — a presence row on top of it would double-render
// the same agent. Suppression therefore keys on "does a streaming ROW exist for
// this agent", not on "is the agent's status streaming": a provider whose status
// flipped to `streaming` before its first row lands still earns a row, and a
// non-streaming provider (Hermes) keeps the row for its whole thinking window,
// which is the entire point of the feature.
//
// Suppression also needs a TRAILING HOLD. The bridge finalizes every assistant
// item independently (`finalize(stream, 'complete', …)` per terminal
// `agent-item-updated-v2`), while the binder keeps the binding `streaming` for
// the whole turn. So a normal Claude turn (text → tool → text → tool → text) has
// gaps between item N closing and item N+1 opening in which no row is streaming.
// Without a hold the presence row would flash in and out at every one of those
// boundaries, each toggle growing/shrinking the timeline foot and re-firing the
// follow-scroll ResizeObserver. `advanceStreamingHold` keeps a just-closed row
// suppressing for `PRESENCE_STREAM_HOLD_MS` so an intra-turn gap stays silent.
import type { ChannelAgentStatus } from '../api.js';
import type { KnownAgentGlyph } from './sender-identity.js';

/** Busy statuses that earn a presence row (`idle` never does). */
export type ChannelPresenceStatus = Exclude<ChannelAgentStatus, 'idle'>;

export interface ChannelAgentPresence {
  /** AgentProfile actor id — the same identity namespace as roster/status. */
  agentId: string;
  status: ChannelPresenceStatus;
  label: string;
  /** `var(--sender-*)` token or hash-derived hex from `resolveSenderIdentity`. */
  colorVar: string;
  glyph: KnownAgentGlyph | null;
  /** Posts waiting to trigger this agent's NEXT turn (#1308 slice 4). */
  queuedCount: number;
  /** Posts accepted by this agent's native safe-boundary steering lane. */
  steeringCount: number;
}

/** Minimal shape of the header chips this projection consumes. */
export interface ChannelPresenceChip {
  agentId: string;
  status: ChannelAgentStatus;
  identity: { label: string; colorVar: string; glyph: KnownAgentGlyph | null };
  /** Absent on surfaces that predate the queue signal — treated as zero. */
  queuedCount?: number;
  steeringCount?: number;
}

/** Membership probe — satisfied by both `Set` and `Map` of agent ids. */
export interface AgentIdMembership {
  has(agentId: string): boolean;
}

/**
 * Project header chips to presence rows: drop idle agents, drop any agent that
 * already owns a live streaming row in the timeline.
 */
export function selectChannelAgentPresence(
  chips: readonly ChannelPresenceChip[],
  streamingRowAgentIds: AgentIdMembership
): ChannelAgentPresence[] {
  const rows: ChannelAgentPresence[] = [];
  for (const chip of chips) {
    if (chip.status === 'idle') continue;
    if (streamingRowAgentIds.has(chip.agentId)) continue;
    rows.push({
      agentId: chip.agentId,
      status: chip.status,
      label: chip.identity.label,
      colorVar: chip.identity.colorVar,
      glyph: chip.identity.glyph,
      queuedCount: chip.queuedCount ?? 0,
      steeringCount: chip.steeringCount ?? 0,
    });
  }
  return rows;
}

/**
 * How long a closed streaming row keeps suppressing its agent's presence row.
 * Long enough to swallow the bridge's item→item gap inside one turn, short
 * enough that a genuinely finished turn re-announces promptly if the binder is
 * still busy (e.g. a follow-up tool phase that produces no text).
 */
export const PRESENCE_STREAM_HOLD_MS = 600;

/**
 * Advance the trailing-hold map one step.
 *
 * Live streaming agents map to `Infinity` (suppressed for as long as the row is
 * open). The step an agent leaves the live set, its entry becomes a finite
 * `now + holdMs` deadline; entries past their deadline are dropped. Pure so the
 * timing rule is testable without a component or fake DOM.
 */
export function advanceStreamingHold(
  previousHold: ReadonlyMap<string, number>,
  liveStreamingAgentIds: Iterable<string>,
  now: number,
  holdMs: number = PRESENCE_STREAM_HOLD_MS
): Map<string, number> {
  const live = new Set(liveStreamingAgentIds);
  const next = new Map<string, number>();
  for (const [agentId, expiresAt] of previousHold) {
    if (live.has(agentId)) continue; // re-added as live below
    if (expiresAt === Number.POSITIVE_INFINITY) {
      next.set(agentId, now + holdMs); // row just closed — start the hold
    } else if (expiresAt > now) {
      next.set(agentId, expiresAt); // hold still running
    }
    // otherwise the hold lapsed: drop it and let the row come back
  }
  for (const agentId of live) next.set(agentId, Number.POSITIVE_INFINITY);
  return next;
}

/**
 * Earliest finite hold deadline, or `null` when nothing is pending. Callers use
 * it to schedule exactly one wake-up instead of polling.
 */
export function nextStreamingHoldExpiry(
  hold: ReadonlyMap<string, number>
): number | null {
  let earliest: number | null = null;
  for (const expiresAt of hold.values()) {
    if (!Number.isFinite(expiresAt)) continue;
    if (earliest === null || expiresAt < earliest) earliest = expiresAt;
  }
  return earliest;
}

/** Entry-wise equality so an unchanged step can reuse the previous map. */
export function sameStreamingHold(
  a: ReadonlyMap<string, number>,
  b: ReadonlyMap<string, number>
): boolean {
  if (a.size !== b.size) return false;
  for (const [agentId, expiresAt] of a) {
    if (b.get(agentId) !== expiresAt) return false;
  }
  return true;
}

/** Lowercase presence copy per DESIGN.md — dim secondary text, no emoji. */
export function channelPresenceCopy(presence: ChannelAgentPresence): string {
  return `${presenceActivityCopy(presence)}${steeringSuffix(presence.steeringCount)}${queuedSuffix(presence.queuedCount)}`;
}

function presenceActivityCopy(presence: ChannelAgentPresence): string {
  if (presence.status === 'streaming')
    return `${presence.label} is responding…`;
  if (presence.status === 'waiting')
    return `${presence.label} is waiting for input`;
  // spawning and thinking read the same to an operator: the agent has the turn
  // and nothing has come back yet.
  return `${presence.label} is thinking…`;
}

/**
 * "(n queued)" tail (#1308 slice 4 item 2c). The presence row is the one place
 * that already says what the agent is doing, so the depth of what is waiting
 * behind it belongs here rather than in a control of its own. Suffix only —
 * an empty queue leaves the sentence exactly as it was.
 */
function queuedSuffix(queuedCount: number): string {
  return queuedCount > 0 ? ` (${queuedCount} queued)` : '';
}

function steeringSuffix(steeringCount: number): string {
  return steeringCount > 0 ? ` (${steeringCount} steering pending)` : '';
}
