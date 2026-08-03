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
}

/** Minimal shape of the header chips this projection consumes. */
export interface ChannelPresenceChip {
  agentId: string;
  status: ChannelAgentStatus;
  identity: { label: string; colorVar: string; glyph: KnownAgentGlyph | null };
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
    });
  }
  return rows;
}

/** Lowercase presence copy per DESIGN.md — dim secondary text, no emoji. */
export function channelPresenceCopy(presence: ChannelAgentPresence): string {
  if (presence.status === 'streaming') return `${presence.label} is responding…`;
  if (presence.status === 'waiting')
    return `${presence.label} is waiting for input`;
  // spawning and thinking read the same to an operator: the agent has the turn
  // and nothing has come back yet.
  return `${presence.label} is thinking…`;
}
