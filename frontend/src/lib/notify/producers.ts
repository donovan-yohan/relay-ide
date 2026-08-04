// Signal producers: the two streams the client already receives, reduced to
// item-1 signals and pushed through the shared runtime (#1308 slice 5 item 2).
//
// NO NEW HTTP ROUTE AND NO NEW GATEWAY VERB. Both carriers already exist:
//   * `GET /channels` — the rail's summary list. Its `lastMessage` is the only
//     stream that carries sender identity and server-computed mention refs, so
//     it is the ONLY possible source for the mention and DM-reply triggers. The
//     `channel-activity` broadcast carries `{ channelId, latestSeq }` and
//     nothing else, so it can say a channel moved but never who moved it.
//   * `channel-agent-status` on `/ws/events` — a complete transition stream, so
//     turn-complete needs no fetch at all.
import type { ChannelAgentStatus } from '../api.js';
import { senderShortLabel } from '../channel-sender-label.js';
import type { WorkspaceTopic } from '../../../../shared/workspace-topics.js';
import { deliverNotifySignal } from './runtime.js';
import {
  deriveMessageSignal,
  deriveTurnCompleteSignal,
  notifyChannelFromTopic,
  type NotifyChannel,
  type NotifyEvent,
  type NotifyMessageRow,
} from './signals.js';

/** The subset of a `/channels` row this lane reads. */
export interface NotifySummaryRow {
  id: string;
  lastMessage: NotifyMessageRow | null;
}

/**
 * Channel descriptors by id, from the topic list the rail already fetches.
 *
 * The topic record is what carries DM-ness (`routingDefaults.providerId` +
 * `workspaceId`, recomputed through `isDmChannel`) and the operator's title;
 * the `/channels` summary carries neither. A channel with no cached topic is
 * skipped rather than guessed at — a DM misidentified as a plain channel would
 * silently drop the DM-reply trigger, and the reverse would notify on every
 * agent message in a busy implementation channel.
 */
export type NotifyTopicRecord = Pick<
  WorkspaceTopic,
  'id' | 'display' | 'workspaceId' | 'routingDefaults'
>;

export function notifyChannelIndex(
  topics: readonly NotifyTopicRecord[]
): Map<string, NotifyChannel> {
  const index = new Map<string, NotifyChannel>();
  for (const topic of topics)
    index.set(topic.id, notifyChannelFromTopic(topic));
  return index;
}

export interface NotifySummaryPassInput {
  rows: readonly NotifySummaryRow[];
  channels: ReadonlyMap<string, NotifyChannel>;
  /** False for the first payload after mount — see `DeliverNotifyOptions`. */
  osTier?: boolean;
  at?: number;
}

/**
 * MENTION + DM-REPLY, from one `/channels` payload.
 *
 * Idempotent by construction: the payload is refetched on reconnect, on focus,
 * and whenever an unknown channel shows activity, and the gate's per-channel
 * replay guard is what stops the same `lastMessage` notifying twice. This
 * function therefore does not need — and deliberately does not keep — a
 * "rows I have already seen" ledger of its own.
 */
export function notifyFromChannelSummaries(
  input: NotifySummaryPassInput
): NotifyEvent[] {
  const at = input.at ?? Date.now();
  const delivered: NotifyEvent[] = [];
  for (const row of input.rows) {
    if (!row.lastMessage) continue;
    const channel = input.channels.get(row.id);
    if (!channel) continue;
    const signal = deriveMessageSignal(row.lastMessage, channel, at);
    if (!signal) continue;
    const event = deliverNotifySignal(signal, {
      now: at,
      ...(input.osTier === undefined ? {} : { osTier: input.osTier }),
    });
    if (event) delivered.push(event);
  }
  return delivered;
}

export interface NotifyAgentStatusInput {
  channel: NotifyChannel;
  agentId: string;
  /** Status held BEFORE this transition — read before the store records it. */
  previous: ChannelAgentStatus | undefined;
  next: ChannelAgentStatus;
  at?: number;
}

/** TURN COMPLETE, from one `channel-agent-status` transition. */
export function notifyFromAgentStatus(
  input: NotifyAgentStatusInput
): NotifyEvent | null {
  const at = input.at ?? Date.now();
  const signal = deriveTurnCompleteSignal({
    channel: input.channel,
    // The agent id is a profile Actor id, so it goes through the shared label
    // resolver — never split for a name (#1234).
    agentLabel: senderShortLabel({ senderId: input.agentId }),
    previous: input.previous,
    next: input.next,
    at,
  });
  if (!signal) return null;
  return deliverNotifySignal(signal, { now: at });
}
