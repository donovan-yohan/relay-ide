// Queued-send marks (#1308 slice 4 item 2a). When the operator posts while the
// bound agent is mid-turn, the server queues that post behind the live turn
// instead of opening a second one. Nothing about the durable row says so — the
// steering intent is deliberately NOT persisted (`channel-chat-router`), so a
// replay of history can never re-announce it — which leaves the operator staring
// at a message that looks sent but produced no reply.
//
// This store is the client's own memory of "I sent that one into a busy agent".
//
// ── the chosen signal ────────────────────────────────────────────────────────
// A mark is created from the SEND-TIME agent status (the same `agentChips`
// signal the header and presence rows already use) and retired by the queue
// DRAIN GENERATION published with `channel-agent-status` (`queuedCount`, item
// 1c). Concretely:
//
//   1. before issuing the POST, snapshot `queueDrainSeqByChannelAgent` for every
//      agent that is busy right now;
//   2. when the POST resolves, register the mark against the returned message id
//      — but only if no snapshotted generation has moved in the meantime;
//   3. the chip renders for exactly as long as every snapshotted generation is
//      still current.
//
// The generation moves on any transition that reports an EMPTY queue, which is
// what `finishTurn` → `pump` emits (`queuedCount 0`) the instant the queued run
// is spliced out and immediately before the next turn starts. So the chip clears
// precisely when the next turn begins consuming the message.
//
// Two deliberate imprecisions, both failing toward silence rather than a lie:
//   • step 2's guard drops the mark when a drain raced the POST round-trip. A
//     send that really did queue can therefore miss its chip; a send that was
//     already consumed can never keep one.
//   • the mark targets the agents that were BUSY at send time, not the agents
//     the server's mention routing actually triggered — the client does not
//     re-derive routing. In a group channel a message that addresses nobody can
//     briefly show the chip; it retires at that agent's very next transition,
//     because an idle-turn transition also reports `queuedCount 0`.
import { create } from 'zustand';
import {
  channelAgentStatusKey,
  useChannelAgentStatusStore,
} from './channel-agent-status.js';

export interface ChannelQueuedSendMark {
  /** Channel the send belongs to — scopes `clearChannel`. */
  channelId: string;
  /** Profile Actor ids this send is waiting behind. */
  agentIds: readonly string[];
  /**
   * Row copy, resolved at send time so the chip never needs the roster again
   * (a mark outlives the identity lookup that produced it).
   */
  label: string;
  /** `queueDrainSeqByChannelAgent` value per agent key when the send was issued. */
  drainSeqs: Readonly<Record<string, number>>;
}

interface ChannelQueuedSendsState {
  marksByMessageId: Record<string, ChannelQueuedSendMark>;
  /** Record a durable message id as "sent into a busy agent". */
  markQueuedSend: (messageId: string, mark: ChannelQueuedSendMark) => void;
  /** Drop every mark for a channel (channel switch / unmount). */
  clearChannel: (channelId: string) => void;
}

export const useChannelQueuedSendsStore = create<ChannelQueuedSendsState>(
  (set) => ({
    marksByMessageId: {},
    markQueuedSend: (messageId, mark) =>
      set((state) => ({
        marksByMessageId: { ...state.marksByMessageId, [messageId]: mark },
      })),
    clearChannel: (channelId) =>
      set((state) => {
        const next: Record<string, ChannelQueuedSendMark> = {};
        let changed = false;
        for (const [messageId, mark] of Object.entries(
          state.marksByMessageId
        )) {
          if (mark.channelId === channelId) changed = true;
          else next[messageId] = mark;
        }
        return changed ? { marksByMessageId: next } : state;
      }),
  })
);

/** Snapshot the drain generation of every agent a send is about to wait behind. */
export function snapshotQueueDrainSeqs(
  channelId: string,
  agentIds: readonly string[],
  drainSeqByChannelAgent: Readonly<Record<string, number>>
): Record<string, number> {
  const snapshot: Record<string, number> = {};
  for (const agentId of agentIds) {
    const key = channelAgentStatusKey(channelId, agentId);
    snapshot[key] = drainSeqByChannelAgent[key] ?? 0;
  }
  return snapshot;
}

/**
 * True while every snapshotted generation is still current — i.e. no agent this
 * send is waiting behind has reported an empty queue since it was issued.
 *
 * `every`, not `some`: once ANY addressed agent has drained, the message is no
 * longer merely waiting, and a chip that outlives the turn it named is worse
 * than one that clears a beat early.
 */
export function queuedSendStillWaiting(
  mark: ChannelQueuedSendMark,
  drainSeqByChannelAgent: Readonly<Record<string, number>>
): boolean {
  if (mark.agentIds.length === 0) return false;
  for (const [key, seq] of Object.entries(mark.drainSeqs)) {
    if ((drainSeqByChannelAgent[key] ?? 0) !== seq) return false;
  }
  return true;
}

/**
 * Chip copy for one row, or `null` when that row is not (or no longer) waiting.
 *
 * Read by `ChannelMessageRow` directly rather than drilled from `ChannelView`,
 * so the main lane, the thread panel and any future row surface all pick the
 * chip up from one place. Both selectors collapse to primitives — a label and a
 * boolean — so the ~every-transition churn of the drain map re-renders only the
 * rows whose answer actually changed, not every row in the timeline.
 */
export function useQueuedSendNotice(messageId: string): string | null {
  const label = useChannelQueuedSendsStore(
    (state) => state.marksByMessageId[messageId]?.label ?? null
  );
  const waiting = useChannelAgentStatusStore((state) => {
    const mark =
      useChannelQueuedSendsStore.getState().marksByMessageId[messageId];
    return (
      mark !== undefined &&
      queuedSendStillWaiting(mark, state.queueDrainSeqByChannelAgent)
    );
  });
  return waiting ? label : null;
}

/** Lowercase chip copy per DESIGN.md — no emoji, no title case. */
export function queuedSendCopy(busyLabels: readonly string[]): string {
  const first = busyLabels[0];
  if (busyLabels.length === 1 && first) {
    return `queued — ${first} is mid-turn`;
  }
  return 'queued — agents are mid-turn';
}
