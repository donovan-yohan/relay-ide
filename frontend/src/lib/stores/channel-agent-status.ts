// Per-channel, per-agent live status cache (#1167). Fed by the `/ws/events`
// `channel-agent-status` broadcast, which carries `{ channelId, agentId, status,
// sessionId }`. The channel header renders a presence chip (glyph + colored dot,
// with an interrupt affordance while the agent is busy) from this store merged
// with the channel roster query. Structure mirrors `channel-activity.ts`.
import { create } from 'zustand';
import type { ChannelAgentStatus } from '../api.js';

/** Composite key for the status/session maps: `"<channelId> <agentId>"`. */
export function channelAgentStatusKey(
  channelId: string,
  agentId: string
): string {
  return `${channelId} ${agentId}`;
}

interface ChannelAgentStatusState {
  /** Latest status per `${channelId} ${agentId}`. */
  statusByChannelAgent: Record<string, ChannelAgentStatus>;
  /** Backing session id per `${channelId} ${agentId}` (null when unbound). */
  sessionByChannelAgent: Record<string, string | null>;
  /** Record a live status transition for an agent in a channel. */
  recordStatus: (
    channelId: string,
    agentId: string,
    status: ChannelAgentStatus,
    sessionId: string | null
  ) => void;
  /** Drop every agent status/session entry for a channel. */
  clearChannel: (channelId: string) => void;
}

export const useChannelAgentStatusStore = create<ChannelAgentStatusState>(
  (set) => ({
    statusByChannelAgent: {},
    sessionByChannelAgent: {},
    recordStatus: (channelId, agentId, status, sessionId) =>
      set((state) => {
        const key = channelAgentStatusKey(channelId, agentId);
        if (
          state.statusByChannelAgent[key] === status &&
          state.sessionByChannelAgent[key] === sessionId
        ) {
          return state;
        }
        return {
          statusByChannelAgent: {
            ...state.statusByChannelAgent,
            [key]: status,
          },
          sessionByChannelAgent: {
            ...state.sessionByChannelAgent,
            [key]: sessionId,
          },
        };
      }),
    clearChannel: (channelId) =>
      set((state) => {
        const prefix = `${channelId} `;
        const status: Record<string, ChannelAgentStatus> = {};
        const session: Record<string, string | null> = {};
        let changed = false;
        for (const [key, value] of Object.entries(state.statusByChannelAgent)) {
          if (key.startsWith(prefix)) changed = true;
          else status[key] = value;
        }
        for (const [key, value] of Object.entries(
          state.sessionByChannelAgent
        )) {
          if (!key.startsWith(prefix)) session[key] = value;
        }
        if (!changed) return state;
        return {
          statusByChannelAgent: status,
          sessionByChannelAgent: session,
        };
      }),
  })
);
