// Notify-signal derivation for channel notifications (#1308 slice 5 item 1).
//
// PURE. This module decides WHETHER something is worth telling the operator
// about and WHICH tier it earns; it never touches the Notification API, the
// favicon, the title, or any store. Item 2 owns delivery and consumes the
// `NotifyEvent` this returns.
//
// Deliberately `lib/notify/`, not `lib/notifications/`: `lib/notifications.ts`
// already exists and owns the LEGACY per-session web-push lane (service worker
// + VAPID + `PUT /config`). A sibling directory of the same name would resolve
// fine but read as one module in two places. The two lanes are unrelated —
// nothing here registers a service worker, and this slice adds no push infra.
//
// Everything reads streams the client already has:
//   * message rows — the channel chat socket for the open channel, and the
//     `/channels` list summary's `lastMessage` (which carries server-computed
//     `mentions` over the FULL body) for every other channel;
//   * `channel-agent-status` — the per-channel agent status transitions;
//   * `channel-activity` + the read-sync stores (#1308 slice 3) — the read
//     position, which is READ here and never recomputed.
// No new HTTP route, no new gateway verb.
import type { ChannelAgentStatus } from '../api.js';
import type { ChannelMessage } from '../../../../shared/channel-chat-protocol.js';
import type { WorkspaceTopic } from '../../../../shared/workspace-topics.js';
import type { TopicNavItem } from '../state/topic-nav.js';
import { isDmChannel } from '../dm-channels.js';
import {
  CURRENT_OPERATOR_SENDER_ID,
  messageMentionsOperator,
  senderShortLabel,
} from '../channel-sender-label.js';
import type {
  NotifySettingKey,
  NotifySettings,
} from '../stores/notify-settings.js';

/**
 * Why the operator is being told.
 *
 * MENTION exists because `@operator` is a real, already-shipped signal: mention
 * refs resolve against an agent-profile contact set only, so a human mention
 * lands as an unresolved `{ raw: '@operator' }` ref — see
 * `messageMentionsOperator` in `channel-sender-label.ts` for the verification
 * note. It is NOT N/A.
 */
export type NotifyReason = 'mention' | 'dm-reply' | 'turn-complete';

/** The channel a signal is raised against. */
export interface NotifyChannel {
  id: string;
  /**
   * Operator-authored channel title, used VERBATIM in notification copy. Relay
   * copy is lowercase (DESIGN.md) but the operator's own title is their text,
   * not a label this lane gets to restyle.
   */
  title: string;
  /** Derived, never a server marker — see `shared/dm-channels.ts`. */
  isDm: boolean;
}

/** One notify-worthy thing that happened, before any gating. */
export interface NotifySignal {
  reason: NotifyReason;
  channel: NotifyChannel;
  /**
   * Message seq the signal was raised for, or 0 for a status-only signal
   * (turn-complete carries no row). Drives both the replay guard and the
   * read-position gate, so a signal with a real row MUST carry its seq.
   */
  seq: number;
  /** Lowercase-safe short label for the sender/agent (`senderShortLabel`). */
  senderLabel: string;
  at: number;
}

/** Delivery decision for one signal. Consumed by item 2. */
export interface NotifyEvent {
  /**
   * Per-CHANNEL coalesce key. Item 2 passes it as the `Notification` tag so a
   * newer notification for the same channel replaces the previous one in the
   * OS notification centre rather than stacking.
   */
  key: string;
  reason: NotifyReason;
  channelId: string;
  channelTitle: string;
  /**
   * In-app tier (badge / title count). Always true on a returned event: an
   * event only exists once the trigger passed its setting, its replay guard,
   * the read position, and the open-and-focused suppression — a survivor of all
   * four is worth an in-app mark regardless of tab visibility.
   */
  badge: true;
  /**
   * OS Notification tier. True only when the tab is HIDDEN and this channel's
   * rate-limit window is open. A visible tab gets the in-app tier only.
   */
  os: boolean;
  /**
   * Signals this event stands for. `1` normally; `> 1` when the rate limiter
   * held OS notifications back and this one flushes the coalesced run.
   */
  count: number;
  /**
   * Channels the GLOBAL burst budget has held back inside the current window,
   * including this one — or `0` when nothing overflowed. Only ever non-zero
   * when `os` is false, and only on the event that GREW the held-back set, so
   * item 2 can render one collapsed digest per new channel instead of one
   * notification per channel.
   */
  osOverflow: number;
  /**
   * Lowercase-safe short label for the sender/agent, carried through from the
   * signal. Copy is composed by `notify/copy.ts` (item 2) rather than here: the
   * OS tier renders title and body as one unit and needs the channel inside the
   * sentence, so a body baked at gate time would have to be re-cut downstream.
   */
  senderLabel: string;
  seq: number;
  at: number;
}

/**
 * One OS notification per channel per minute. Long enough that a streaming
 * agent cannot machine-gun the notification centre, short enough that a real
 * back-and-forth still pings.
 */
export const NOTIFY_OS_RATE_LIMIT_MS = 60_000;

/**
 * GLOBAL burst budget: at most this many OS notifications across ALL channels
 * inside `NOTIFY_OS_BURST_WINDOW_MS`.
 *
 * The per-channel limit above says nothing about a pass that walks a WHOLE
 * `/channels` payload. A hidden tab whose socket reconnects refetches the
 * summary list, and under the #1242 orchestrator epic — one DM channel per
 * agent profile — fifteen DM rows can each carry a fresh agent reply: fifteen
 * channels, fifteen untouched 60s windows, fifteen notification-centre entries
 * at once, none of which replaces another because the tag is per channel. That
 * is the normal shape of a reconnect, not an edge case.
 *
 * Overflow is not dropped: the held-back channels are counted and reported on
 * `osOverflow`, which item 2 renders as ONE collapsed notification. The in-app
 * badge tier is untouched — every held-back channel still gets its dot.
 */
export const NOTIFY_OS_BURST_LIMIT = 3;
export const NOTIFY_OS_BURST_WINDOW_MS = 10_000;

/**
 * Busy statuses whose fall to `idle` is a completed TURN.
 *
 * `spawning` is excluded on purpose: `spawning → idle` without ever thinking is
 * a runtime that failed to come up, which is not a turn the operator was
 * waiting on the result of.
 */
const TURN_BUSY_STATUSES: readonly ChannelAgentStatus[] = [
  'thinking',
  'streaming',
  'waiting',
];

const SETTING_BY_REASON: Readonly<Record<NotifyReason, NotifySettingKey>> = {
  mention: 'mentions',
  'dm-reply': 'dmReplies',
  'turn-complete': 'turnComplete',
};

/** True when the operator has this trigger switched on. */
export function notifyReasonEnabled(
  settings: NotifySettings,
  reason: NotifyReason
): boolean {
  return settings[SETTING_BY_REASON[reason]];
}

/** Derive the channel descriptor a signal needs from a persisted topic record. */
export function notifyChannelFromTopic(
  topic: Pick<
    WorkspaceTopic,
    'id' | 'display' | 'workspaceId' | 'routingDefaults'
  >
): NotifyChannel {
  return {
    id: topic.id,
    title: topic.display.title,
    isDm: isDmChannel(topic) !== null,
  };
}

/**
 * Same descriptor from the rail's derived nav model, which has already resolved
 * DM-ness and the display title. Preferred by any caller that holds a nav item:
 * re-deriving `isDmChannel` off a second shape is how the two lanes drift.
 */
export function notifyChannelFromNavItem(
  item: Pick<TopicNavItem, 'id' | 'title' | 'isDirectMessage'>
): NotifyChannel {
  return { id: item.id, title: item.title, isDm: item.isDirectMessage };
}

/**
 * The row shape both message streams reduce to. Structurally satisfied as-is by
 * the channel-list summary's `lastMessage`; `notifyRowFromMessage` maps a live
 * `ChannelMessage` onto it.
 */
export interface NotifyMessageRow {
  seq: number;
  senderId: string;
  senderKind: 'human' | 'agent' | 'system';
  senderDisplayName?: string | undefined;
  providerId?: string | undefined;
  mentions?: readonly { raw: string }[] | undefined;
  /** Truncated body text. Only read when `mentions` is absent. */
  preview: string;
}

/** Flatten a live channel message onto the shared row shape. */
export function notifyRowFromMessage(
  message: ChannelMessage
): NotifyMessageRow {
  return {
    seq: message.seq,
    senderId: message.sender.id,
    senderKind: message.sender.kind,
    ...(message.sender.displayName !== undefined
      ? { senderDisplayName: message.sender.displayName }
      : {}),
    ...(message.sender.providerId !== undefined
      ? { providerId: message.sender.providerId }
      : {}),
    ...(message.mentions !== undefined ? { mentions: message.mentions } : {}),
    preview: message.body.text,
  };
}

/**
 * MENTION and DM-REPLY, from one incoming row. At most ONE signal per row, with
 * mention winning: an agent that both replies in a DM and writes `@operator` is
 * one event, and the stronger reason is the one addressed at the operator.
 *
 * Returns null for the operator's own rows (this device's post is echoed back
 * over the socket) and for system rows (join/leave/approval scaffolding is
 * timeline furniture, not a message someone sent).
 */
export function deriveMessageSignal(
  row: NotifyMessageRow,
  channel: NotifyChannel,
  at: number
): NotifySignal | null {
  if (row.senderId === CURRENT_OPERATOR_SENDER_ID) return null;
  if (row.senderKind === 'system') return null;
  const senderLabel = senderShortLabel({
    senderId: row.senderId,
    senderDisplayName: row.senderDisplayName,
    providerId: row.providerId,
  });
  const base = { channel, seq: row.seq, senderLabel, at };
  if (messageMentionsOperator(row)) return { reason: 'mention', ...base };
  if (channel.isDm && row.senderKind === 'agent') {
    return { reason: 'dm-reply', ...base };
  }
  return null;
}

/**
 * TURN COMPLETE, from a `channel-agent-status` transition.
 *
 * SIMPLIFICATION (sanctioned by the slice brief): this does not correlate the
 * turn back to a trigger message the operator sent. The binder's turn id is
 * `chturn-<triggerMessageId>-<profileActorId>` and the status broadcast does not
 * carry it, so the correlation would need a per-turn client-side ledger that the
 * open/hidden gate plus the turn-complete setting (default OFF) buy for free.
 * What IS enforced: a real busy→idle edge, and — through the gate — a channel
 * the operator is not currently looking at.
 */
export function deriveTurnCompleteSignal(input: {
  channel: NotifyChannel;
  agentLabel: string;
  previous: ChannelAgentStatus | undefined;
  next: ChannelAgentStatus;
  at: number;
}): NotifySignal | null {
  if (input.next !== 'idle') return null;
  if (input.previous === undefined) return null;
  if (!TURN_BUSY_STATUSES.includes(input.previous)) return null;
  return {
    reason: 'turn-complete',
    channel: input.channel,
    seq: 0,
    senderLabel: input.agentLabel,
    at: input.at,
  };
}

/** Everything outside the signal that decides its fate. */
export interface NotifyGateContext {
  settings: NotifySettings;
  /** `useUiStore.activeChannelId` — the channel open in the timeline. */
  activeChannelId: string | null;
  /** `document.hidden`. */
  documentHidden: boolean;
  /** `document.hasFocus()`. */
  windowFocused: boolean;
  /**
   * The operator's last-read seq for this signal's channel, read from the
   * read-sync stores (#1308 slice 3). Unread arithmetic is NOT reimplemented
   * here — this only refuses a signal for a row the operator has already read,
   * which is how a mark set on another device silences this one.
   */
  lastReadSeq?: number | undefined;
  now: number;
}

export interface NotifyGate {
  /** Decide one signal. Returns null when nothing should be shown. */
  evaluate: (
    signal: NotifySignal,
    ctx: NotifyGateContext
  ) => NotifyEvent | null;
  /**
   * Hand back the OS budget an event consumed when the notification was never
   * actually shown.
   *
   * `evaluate` charges the per-channel window and the global burst slot at
   * DECISION time, because that is the only place the ledgers live — but the
   * delivery downstream can still drop the event (permission `denied` or
   * `unsupported`, a `Notification` constructor that throws, a `default`
   * permission request the operator dismisses, or another tab holding the
   * cross-tab lease). Without a refund the first, never-displayed event burns
   * a 60s slot and the next real message in that channel is swallowed as a
   * coalesce increment that shows nothing.
   *
   * The replay guard is deliberately NOT refunded: the row was evaluated and
   * did earn its in-app badge, so re-raising it would double-badge.
   */
  refundOs: (event: Pick<NotifyEvent, 'channelId' | 'count'>) => void;
  /** Forget every per-channel ledger entry (sign-out, tests). */
  reset: () => void;
}

/**
 * Per-channel gate state. Kept in a closure rather than a module singleton so
 * one test case cannot leak into the next and so a signed-out client can drop
 * it wholesale.
 */
export function createNotifyGate(): NotifyGate {
  /** Highest seq already evaluated per channel — the replay guard. */
  const lastSeqByChannel = new Map<string, number>();
  /** When this channel last fired an OS notification. */
  const lastOsAtByChannel = new Map<string, number>();
  /** OS notifications this channel swallowed since its last fire. */
  const coalescedByChannel = new Map<string, number>();
  /** Timestamps of the OS grants inside the current burst window, oldest first. */
  const osFiredAt: number[] = [];
  /** Channels the burst budget has held back in the current window. */
  const overflowChannels = new Set<string>();

  /**
   * Drop burst grants that have aged out. The held-back set is cleared with
   * them: once the window is empty the burst is over, and the next overflow is
   * a new one that starts counting at one.
   */
  function pruneBurstLedger(now: number): void {
    while (osFiredAt.length > 0) {
      const oldest = osFiredAt[0];
      if (oldest === undefined || now - oldest < NOTIFY_OS_BURST_WINDOW_MS) {
        break;
      }
      osFiredAt.shift();
    }
    if (osFiredAt.length === 0) overflowChannels.clear();
  }

  function evaluate(
    signal: NotifySignal,
    ctx: NotifyGateContext
  ): NotifyEvent | null {
    const channelId = signal.channel.id;

    // 1. Operator setting. An off trigger is off in BOTH tiers — the in-app
    //    badge lane is "regardless of tab visibility", not "regardless of what
    //    the operator asked for". Unread dots are a separate, always-on surface.
    if (!notifyReasonEnabled(ctx.settings, signal.reason)) return null;

    // 2. Replay guard. The list payload that carries `lastMessage` is refetched
    //    on reconnect, on focus, and whenever an unknown channel shows activity
    //    — without this every refetch would re-notify the same row.
    if (signal.seq > 0) {
      const seen = lastSeqByChannel.get(channelId);
      if (seen !== undefined && seen >= signal.seq) return null;
      lastSeqByChannel.set(channelId, signal.seq);
    }

    // 3. Already read — including read on ANOTHER device, which is exactly what
    //    slice 3 made knowable.
    if (
      signal.seq > 0 &&
      ctx.lastReadSeq !== undefined &&
      signal.seq <= ctx.lastReadSeq
    ) {
      return null;
    }

    // 4. The operator is looking straight at it. Open AND visible AND focused —
    //    an open channel in a background tab is not being watched.
    const watching =
      channelId === ctx.activeChannelId &&
      !ctx.documentHidden &&
      ctx.windowFocused;
    if (watching) return null;

    // 5. Tiering. OS notifications are for a hidden tab only; a visible tab
    //    already has the in-app badge in view.
    let os = ctx.documentHidden;
    let count = 1;
    let osOverflow = 0;
    if (os) {
      const lastOsAt = lastOsAtByChannel.get(channelId);
      const withinChannelWindow =
        lastOsAt !== undefined && ctx.now - lastOsAt < NOTIFY_OS_RATE_LIMIT_MS;
      pruneBurstLedger(ctx.now);
      // Checked BEFORE anything is charged: a refusal must leave both ledgers
      // exactly as it found them.
      const burstExhausted = osFiredAt.length >= NOTIFY_OS_BURST_LIMIT;
      if (withinChannelWindow || burstExhausted) {
        // Held back: swallow the OS tier and remember the miss so the next fire
        // can say how many piled up.
        coalescedByChannel.set(
          channelId,
          (coalescedByChannel.get(channelId) ?? 0) + 1
        );
        os = false;
        // A channel the per-channel limiter would have swallowed anyway is not
        // burst overflow — it already has a live notification of its own, and
        // counting it would inflate the digest with channels the operator can
        // see.
        if (burstExhausted && !withinChannelWindow) {
          const before = overflowChannels.size;
          overflowChannels.add(channelId);
          // Only the event that GREW the set reports overflow: a channel that
          // overflows twice in one window must not re-alert the digest.
          if (overflowChannels.size > before)
            osOverflow = overflowChannels.size;
        }
      } else {
        count = (coalescedByChannel.get(channelId) ?? 0) + 1;
        coalescedByChannel.delete(channelId);
        lastOsAtByChannel.set(channelId, ctx.now);
        osFiredAt.push(ctx.now);
      }
    }

    return {
      key: notifyChannelKey(channelId),
      reason: signal.reason,
      channelId,
      channelTitle: signal.channel.title,
      badge: true,
      os,
      count,
      osOverflow,
      senderLabel: signal.senderLabel,
      seq: signal.seq,
      at: signal.at,
    };
  }

  function refundOs(event: Pick<NotifyEvent, 'channelId' | 'count'>): void {
    lastOsAtByChannel.delete(event.channelId);
    // The undelivered event stood for `count` signals — itself plus whatever it
    // was flushing — and none of them was seen, so all of them go back on the
    // coalesce pile rather than evaporating.
    coalescedByChannel.set(event.channelId, event.count);
    // Give the burst slot back too. The most recent grant is popped rather than
    // matched by timestamp: refunds are same-window and the ledger is a COUNT,
    // so which entry leaves it only shifts the window edge by microseconds.
    osFiredAt.pop();
  }

  return {
    evaluate,
    refundOs,
    reset: () => {
      lastSeqByChannel.clear();
      lastOsAtByChannel.clear();
      coalescedByChannel.clear();
      osFiredAt.length = 0;
      overflowChannels.clear();
    },
  };
}

/** Notification tag: one live notification per channel. */
export function notifyChannelKey(channelId: string): string {
  return `relay-channel:${channelId}`;
}
