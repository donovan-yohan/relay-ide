// Per-channel, per-agent live status cache (#1167). Fed by the `/ws/events`
// `channel-agent-status` broadcast, which carries `{ channelId, agentId, status,
// runtimeId }`. The channel header renders a presence chip (glyph + colored dot,
// with an interrupt affordance while the agent is busy) from this store merged
// with the channel roster query. Structure mirrors `channel-activity.ts`.
import { create } from 'zustand';
import type { ChannelAgentStatus } from '../api.js';

/** Composite key for the status/runtime maps: `"<channelId> <agentId>"`. */
export function channelAgentStatusKey(
  channelId: string,
  agentId: string
): string {
  return `${channelId} ${agentId}`;
}

interface ChannelAgentStatusState {
  /** Latest status per `${channelId} ${agentId}`. */
  statusByChannelAgent: Record<string, ChannelAgentStatus>;
  /** Backing runtime id per `${channelId} ${agentId}` (null when unbound). */
  runtimeByChannelAgent: Record<string, string | null>;
  /**
   * Wall-clock time (ms) of the last live transition per `${channelId}
   * ${agentId}`. Compared against the roster query's `dataUpdatedAt` so a fresh
   * roster snapshot can win over a stale socket status the client never saw go
   * idle (reconnect / tab-sleep dropped the terminal transition — #1167).
   */
  updatedAtByChannelAgent: Record<string, number>;
  /** Record a live status transition for an agent in a channel. */
  recordStatus: (
    channelId: string,
    agentId: string,
    status: ChannelAgentStatus,
    runtimeId: string | null
  ) => void;
  /** Drop every agent status/runtime entry for a channel. */
  clearChannel: (channelId: string) => void;
}

/** Injectable clock (overridable in tests). */
const nowMs = (): number =>
  typeof Date.now === 'function' ? Date.now() : new Date().getTime();

export const useChannelAgentStatusStore = create<ChannelAgentStatusState>(
  (set) => ({
    statusByChannelAgent: {},
    runtimeByChannelAgent: {},
    updatedAtByChannelAgent: {},
    recordStatus: (channelId, agentId, status, runtimeId) =>
      set((state) => {
        const key = channelAgentStatusKey(channelId, agentId);
        if (
          state.statusByChannelAgent[key] === status &&
          state.runtimeByChannelAgent[key] === runtimeId
        ) {
          return state;
        }
        return {
          statusByChannelAgent: {
            ...state.statusByChannelAgent,
            [key]: status,
          },
          runtimeByChannelAgent: {
            ...state.runtimeByChannelAgent,
            [key]: runtimeId,
          },
          updatedAtByChannelAgent: {
            ...state.updatedAtByChannelAgent,
            [key]: nowMs(),
          },
        };
      }),
    clearChannel: (channelId) =>
      set((state) => {
        const prefix = `${channelId} `;
        const status: Record<string, ChannelAgentStatus> = {};
        const runtime: Record<string, string | null> = {};
        const updatedAt: Record<string, number> = {};
        let changed = false;
        for (const [key, value] of Object.entries(state.statusByChannelAgent)) {
          if (key.startsWith(prefix)) changed = true;
          else status[key] = value;
        }
        for (const [key, value] of Object.entries(
          state.runtimeByChannelAgent
        )) {
          if (!key.startsWith(prefix)) runtime[key] = value;
        }
        for (const [key, value] of Object.entries(
          state.updatedAtByChannelAgent
        )) {
          if (!key.startsWith(prefix)) updatedAt[key] = value;
        }
        if (!changed) return state;
        return {
          statusByChannelAgent: status,
          runtimeByChannelAgent: runtime,
          updatedAtByChannelAgent: updatedAt,
        };
      }),
  })
);

/**
 * Reconcile a live socket status with a freshly-fetched roster snapshot. The
 * socket carries transition-only events (no replay on `/ws/events` reconnect),
 * so a missed terminal 'idle' would otherwise pin the header chip at
 * thinking/streaming/waiting forever. Resolution:
 *   • socket wins ONLY when its last transition is at least as new as the roster
 *     snapshot (a genuine live update the roster hasn't observed yet);
 *   • otherwise the roster snapshot is authoritative (fixes the stuck-busy case);
 *   • reducer-derived streaming still upgrades a resolved idle (graceful degrade
 *     when the events socket lags), never downgrades.
 */
export function resolveEffectiveAgentStatus(input: {
  socketStatus: ChannelAgentStatus | undefined;
  socketUpdatedAt: number | undefined;
  rosterStatus: ChannelAgentStatus | undefined;
  rosterUpdatedAt: number;
  streaming: boolean;
}): ChannelAgentStatus {
  const { socketStatus, socketUpdatedAt, rosterStatus, rosterUpdatedAt } =
    input;
  let status: ChannelAgentStatus;
  if (
    socketStatus !== undefined &&
    socketUpdatedAt !== undefined &&
    socketUpdatedAt >= rosterUpdatedAt
  ) {
    status = socketStatus;
  } else {
    status = rosterStatus ?? 'idle';
  }
  if (status === 'idle' && input.streaming) status = 'streaming';
  return status;
}
