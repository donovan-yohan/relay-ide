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
   * Posts waiting to trigger this binding's NEXT turn (#1308 slice 4), per
   * `${channelId} ${agentId}`. Absent means the socket has said nothing yet —
   * NOT zero, so the roster snapshot can still win the reconciliation.
   */
  queuedCountByChannelAgent: Record<string, number>;
  /**
   * Monotonic "this agent's trigger queue was observed empty" generation, per
   * `${channelId} ${agentId}` (#1308 slice 4).
   *
   * The queued-send chip needs an edge, not a level: `queuedCount` is a shared
   * aggregate (any operator, any device), so "is anything queued right now"
   * cannot say whether THIS message is still waiting. A generation counter can:
   * a send snapshots it, and the chip survives only while the snapshot is still
   * current. Every recorded transition that reports an empty queue bumps it,
   * which covers both the real drain (`finishTurn` → `pump` emits `queuedCount
   * 0` before the next turn starts) and the case where the post never enqueued
   * at all (the agent's next transition still reports zero).
   */
  queueDrainSeqByChannelAgent: Record<string, number>;
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
    runtimeId: string | null,
    queuedCount?: number
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
    queuedCountByChannelAgent: {},
    queueDrainSeqByChannelAgent: {},
    updatedAtByChannelAgent: {},
    recordStatus: (channelId, agentId, status, runtimeId, queuedCount = 0) =>
      set((state) => {
        const key = channelAgentStatusKey(channelId, agentId);
        if (
          state.statusByChannelAgent[key] === status &&
          state.runtimeByChannelAgent[key] === runtimeId &&
          state.queuedCountByChannelAgent[key] === queuedCount
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
          queuedCountByChannelAgent: {
            ...state.queuedCountByChannelAgent,
            [key]: queuedCount,
          },
          // Bumped on the transition itself, not on a later read: an empty queue
          // reported by ANY transition retires every send that was waiting for
          // this agent when it was recorded.
          queueDrainSeqByChannelAgent:
            queuedCount === 0
              ? {
                  ...state.queueDrainSeqByChannelAgent,
                  [key]: (state.queueDrainSeqByChannelAgent[key] ?? 0) + 1,
                }
              : state.queueDrainSeqByChannelAgent,
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
        const queued: Record<string, number> = {};
        const drainSeq: Record<string, number> = {};
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
          state.queuedCountByChannelAgent
        )) {
          if (!key.startsWith(prefix)) queued[key] = value;
        }
        for (const [key, value] of Object.entries(
          state.queueDrainSeqByChannelAgent
        )) {
          if (!key.startsWith(prefix)) drainSeq[key] = value;
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
          queuedCountByChannelAgent: queued,
          queueDrainSeqByChannelAgent: drainSeq,
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

/**
 * Same precedence rule as `resolveEffectiveAgentStatus`, applied to the queue
 * depth (#1308 slice 4). Kept as a sibling rather than folded into the status
 * resolver so every existing caller of that function is untouched; both read the
 * same `(socketUpdatedAt >= rosterUpdatedAt)` tie-break, so the presence row can
 * never pair one lane's status with the other lane's count.
 *
 * There is no `streaming` upgrade here: a reducer-derived stream says an agent
 * is talking, and says nothing at all about what is waiting behind it.
 */
export function resolveEffectiveQueuedCount(input: {
  socketQueuedCount: number | undefined;
  socketUpdatedAt: number | undefined;
  rosterQueuedCount: number | undefined;
  rosterUpdatedAt: number;
}): number {
  const { socketQueuedCount, socketUpdatedAt, rosterQueuedCount } = input;
  if (
    socketQueuedCount !== undefined &&
    socketUpdatedAt !== undefined &&
    socketUpdatedAt >= input.rosterUpdatedAt
  ) {
    return socketQueuedCount;
  }
  return rosterQueuedCount ?? 0;
}
