import type { ChannelAgentStatus } from '../api.js';
import type {
  ChannelRailNode,
  ChannelRailSection,
  ChannelRailTree,
  TopicNavItem,
} from './topic-nav.js';

const UNREAD_BONUS = 300;
const MENTION_BONUS = 250;
const MAX_RECENCY_BONUS = 100;
const NEEDS_INPUT_PRIORITY = 900;
const MAX_PENDING_INBOX_COUNT = 4;

export interface CockpitRosterAttention {
  needsAttention: boolean;
  pendingInboxCount: number;
}

export interface CockpitAttentionScoreContext {
  unread: boolean;
  mentionsMe?: boolean;
  effectiveStatus?: ChannelAgentStatus;
  pendingInboxCount?: number;
  /** Injectable wall clock for deterministic ranking tests. */
  nowMs?: number;
}

export interface CockpitAttentionSelectionContext {
  unreadByChannel: Readonly<Record<string, boolean>>;
  statusByChannelAgent: Readonly<Record<string, ChannelAgentStatus>>;
  /** Precomputed newest-message mention signal; text parsing stays upstream. */
  mentionsMeByChannel?: Readonly<Record<string, boolean>>;
  /**
   * Roster attention keyed by a TopicNavSessionRef id or selectKey. Each topic
   * joins its own sessions and caps their combined inbox contribution.
   */
  rosterAttentionBySessionKey?: Readonly<
    Record<string, CockpitRosterAttention>
  >;
  /** Injectable wall clock for deterministic ranking tests. */
  nowMs?: number;
}

function recencyBonus(updatedAt: string, nowMs: number): number {
  const updatedAtMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedAtMs)) return 0;
  const minutes = (nowMs - updatedAtMs) / 60_000;
  return Math.max(0, Math.min(MAX_RECENCY_BONUS, 100 - minutes));
}

function boundedPendingInboxCount(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_PENDING_INBOX_COUNT, Math.max(0, Math.trunc(value ?? 0)));
}

/**
 * Score a shared topic-nav row for the mobile cockpit attention lane. The base
 * priority and unread/recency weights intentionally mirror `attention.ts`.
 */
export function computeCockpitAttentionScore(
  item: TopicNavItem,
  ctx: CockpitAttentionScoreContext
): number {
  const nowMs = ctx.nowMs ?? Date.now();
  // TODO(#1171): wire mentionsMe from the newest unread channel message.
  const mentionBonus = ctx.mentionsMe ? MENTION_BONUS : 0;
  const pendingInboxBonus = boundedPendingInboxCount(ctx.pendingInboxCount);
  const basePriority =
    ctx.effectiveStatus === 'waiting'
      ? Math.max(item.attentionPriority, NEEDS_INPUT_PRIORITY)
      : item.attentionPriority;
  return (
    basePriority +
    (ctx.unread ? UNREAD_BONUS : 0) +
    mentionBonus +
    recencyBonus(item.updatedAt, nowMs) +
    pendingInboxBonus * 25
  );
}

function rosterAttentionForItem(
  item: TopicNavItem,
  rosterAttentionBySessionKey:
    | Readonly<Record<string, CockpitRosterAttention>>
    | undefined
): CockpitRosterAttention {
  if (!rosterAttentionBySessionKey) {
    return { needsAttention: false, pendingInboxCount: 0 };
  }
  let needsAttention = false;
  let pendingInboxCount = 0;
  for (const session of item.sessions) {
    // Prefer the collision-safe selectKey; fall back to the local id for
    // backward-compatible roster snapshots. Count each session only once.
    const attention =
      rosterAttentionBySessionKey[session.selectKey] ??
      rosterAttentionBySessionKey[session.id];
    if (!attention) continue;
    needsAttention ||= attention.needsAttention;
    pendingInboxCount = boundedPendingInboxCount(
      pendingInboxCount + boundedPendingInboxCount(attention.pendingInboxCount)
    );
  }
  return { needsAttention, pendingInboxCount };
}

function flattenSection(section: ChannelRailSection): ChannelRailNode[] {
  const rows: ChannelRailNode[] = [];
  const visit = (node: ChannelRailNode): void => {
    rows.push(node);
    node.children.forEach(visit);
  };
  section.channels.forEach(visit);
  section.directMessages.forEach(visit);
  return rows;
}

function statusesForChannel(
  channelId: string,
  statusByChannelAgent: Readonly<Record<string, ChannelAgentStatus>>
): ChannelAgentStatus[] {
  const prefix = `${channelId} `;
  return Object.entries(statusByChannelAgent).flatMap(([key, status]) =>
    key.startsWith(prefix) ? [status] : []
  );
}

function updatedAtMs(item: TopicNavItem): number {
  const value = Date.parse(item.updatedAt);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Flatten the one shared channel rail, promote actionable rows, and rank them.
 * Muted rows remain in the canonical tree but never enter this attention lane.
 */
export function selectCockpitAttentionRows(
  tree: ChannelRailTree,
  ctx: CockpitAttentionSelectionContext
): ChannelRailNode[] {
  const nowMs = ctx.nowMs ?? Date.now();
  const flattened = [
    ...tree.groups.flatMap(flattenSection),
    ...flattenSection(tree.orphans),
  ];

  const ranked = flattened.flatMap((node, originalIndex) => {
    const unread = ctx.unreadByChannel[node.item.id] ?? node.unread;
    const mentionsMe = ctx.mentionsMeByChannel?.[node.item.id] ?? false;
    const statuses = statusesForChannel(node.item.id, ctx.statusByChannelAgent);
    const waiting = statuses.includes('waiting');
    const rosterAttention = rosterAttentionForItem(
      node.item,
      ctx.rosterAttentionBySessionKey
    );
    const eligible =
      !node.item.muted &&
      (unread ||
        mentionsMe ||
        node.item.tone === 'attention' ||
        node.item.tone === 'error' ||
        waiting ||
        rosterAttention.needsAttention ||
        rosterAttention.pendingInboxCount > 0);
    if (!eligible) return [];

    const effectiveStatus = waiting ? 'waiting' : statuses[0];
    const resolvedNode = unread === node.unread ? node : { ...node, unread };
    return [
      {
        node: resolvedNode,
        originalIndex,
        score: computeCockpitAttentionScore(node.item, {
          unread,
          mentionsMe,
          ...(effectiveStatus ? { effectiveStatus } : {}),
          pendingInboxCount: rosterAttention.pendingInboxCount,
          nowMs,
        }),
      },
    ];
  });

  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      Number(b.node.item.pinned) - Number(a.node.item.pinned) ||
      updatedAtMs(b.node.item) - updatedAtMs(a.node.item) ||
      a.node.item.title.localeCompare(b.node.item.title) ||
      a.originalIndex - b.originalIndex
  );
  return ranked.map(({ node }) => node);
}
