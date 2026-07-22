// Pure timeline layout for the channel view (#1166). Groups consecutive
// same-sender messages, inserts day dividers and the client-local unread line.
// Deliberately React-free so grouping/divider logic is unit-testable without
// mounting components (see test/components/channel-timeline-grouping.test.ts).
//
// Grouping rules (spec §5.1): a new group starts when the message is a system
// message (never grouped), the sender changes, the local calendar day changes
// (which also emits a day-divider), the first-unread boundary is crossed (which
// also emits the unread line), or the gap since the previous message in the
// running group exceeds GROUP_WINDOW_MS.
import type {
  ChannelMessage,
  ChannelMessageId,
  ChannelSenderRef,
} from '../../../../shared/channel-chat-protocol.js';

/** Slack-standard grouping window: same-sender messages within 5 minutes group. */
export const GROUP_WINDOW_MS = 5 * 60 * 1000;

/** Main-lane projection. Replies remain in reducer state for gap accounting. */
export function selectTopLevel(messages: ChannelMessage[]): ChannelMessage[] {
  return messages.filter((message) => message.threadId === null);
}

export interface DerivedReplyCount {
  /** Number of reply rows currently loaded in the reducer/backfill projection. */
  count: number;
  /** Newest loaded reply timestamp, if it parses later than earlier replies. */
  lastReplyAt?: string;
}

/** Derive live reply activity from loaded child rows without mutating roots. */
export function deriveReplyCounts(
  messages: ChannelMessage[]
): Map<ChannelMessageId, DerivedReplyCount> {
  const counts = new Map<ChannelMessageId, DerivedReplyCount>();
  for (const message of messages) {
    if (message.threadId === null) continue;
    // Detail cards live in the thread (with a thread_id) for cold-resume
    // rendering but are not conversational replies — mirror the store's
    // reply-count SQL so live growth does not re-inflate the root count.
    if (message.agentDetail) continue;
    const current = counts.get(message.threadId);
    const count = (current?.count ?? 0) + 1;
    let lastReplyAt = current?.lastReplyAt;
    if (
      lastReplyAt === undefined ||
      timestampOrder(message.createdAt) > timestampOrder(lastReplyAt)
    ) {
      lastReplyAt = message.createdAt;
    }
    counts.set(message.threadId, {
      count,
      ...(lastReplyAt !== undefined ? { lastReplyAt } : {}),
    });
  }
  return counts;
}

/** Persisted count is a floor because older replies may not be loaded. */
export function displayedReplyCount(
  root: ChannelMessage,
  loaded: DerivedReplyCount | undefined,
  liveGrowth = 0
): number {
  return Math.max((root.replyCount ?? 0) + liveGrowth, loaded?.count ?? 0);
}

function timestampOrder(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

export type TimelineNode =
  | { kind: 'day-divider'; date: string /* YYYY-MM-DD local */ }
  | { kind: 'group'; sender: ChannelSenderRef; messages: ChannelMessage[] }
  | { kind: 'system'; message: ChannelMessage }
  | { kind: 'unread-line' };

function localDayKeyFromDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Local-calendar day key (YYYY-MM-DD) for an ISO timestamp. */
export function localDayKey(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return localDayKeyFromDate(date);
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
] as const;

/**
 * Day-divider label: `today` / `yesterday` when applicable, else `ddd, mmm d`.
 * Always lowercase (DESIGN.md casing law) — never relies on locale casing.
 */
export function formatDayLabel(
  dateKey: string,
  now: Date = new Date()
): string {
  const todayKey = localDayKeyFromDate(now);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const yesterdayKey = localDayKeyFromDate(yesterday);
  if (dateKey === todayKey) return 'today';
  if (dateKey === yesterdayKey) return 'yesterday';
  const parts = dateKey.split('-').map((part) => Number(part));
  const year = parts[0] ?? 1970;
  const month = parts[1] ?? 1;
  const day = parts[2] ?? 1;
  const date = new Date(year, month - 1, day);
  return `${WEEKDAYS[date.getDay()]}, ${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

interface RunningGroup {
  sender: ChannelSenderRef;
  messages: ChannelMessage[];
  lastCreatedMs: number;
}

/**
 * Build the ordered node list for a seq-ascending message array. `lastReadSeq`
 * of `null` (never read) draws no unread line — a first-ever open shows no
 * "everything is unread" marker.
 */
export function buildTimelineNodes(
  messages: ChannelMessage[],
  lastReadSeq: number | null
): TimelineNode[] {
  const nodes: TimelineNode[] = [];
  let group: RunningGroup | null = null;
  let prevDay: string | null = null;
  let unreadInserted = lastReadSeq === null;

  const flush = (): void => {
    if (group) {
      nodes.push({
        kind: 'group',
        sender: group.sender,
        messages: group.messages,
      });
      group = null;
    }
  };

  for (const message of messages) {
    const day = localDayKey(message.createdAt);
    const createdMs = Date.parse(message.createdAt);
    const createdMsSafe = Number.isNaN(createdMs) ? 0 : createdMs;

    if (day !== prevDay) {
      flush();
      nodes.push({ kind: 'day-divider', date: day });
      prevDay = day;
    }

    if (!unreadInserted && lastReadSeq !== null && message.seq > lastReadSeq) {
      flush();
      nodes.push({ kind: 'unread-line' });
      unreadInserted = true;
    }

    if (message.kind === 'system') {
      flush();
      nodes.push({ kind: 'system', message });
      continue;
    }

    if (group) {
      const sameSender =
        group.sender.kind === message.sender.kind &&
        group.sender.id === message.sender.id;
      const withinWindow =
        createdMsSafe - group.lastCreatedMs <= GROUP_WINDOW_MS;
      if (!sameSender || !withinWindow) flush();
    }

    if (!group) {
      group = {
        sender: message.sender,
        messages: [],
        lastCreatedMs: createdMsSafe,
      };
    }
    group.messages.push(message);
    group.lastCreatedMs = createdMsSafe;
  }

  flush();
  return nodes;
}
