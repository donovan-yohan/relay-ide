// Feeds the mention / DM-reply producer from the query cache (#1308 slice 5
// item 2).
//
// A plain subscription, not a `useQuery`: `App` renders `QueryClientProvider`
// inside its own JSX, so the component body that mounts this lane is outside
// the context (the same reason `useEventSocket` is handed the client). Reading
// the cache is also the cheaper shape — the rail already fetches both payloads,
// so this adds an observer's worth of nothing.
import type { QueryClient } from '@tanstack/react-query';
import { fetchChannels, fetchWorkspaceTopics } from '../api.js';
import { useNotifyBadgeStore } from '../stores/notify-badge.js';
import { notifyChannelIndex, notifyFromChannelSummaries } from './producers.js';
import type { NotifySummaryRow, NotifyTopicRecord } from './producers.js';

/** `GET /channels` — the only stream carrying sender identity + mention refs. */
export const NOTIFY_CHANNELS_QUERY_KEY = 'channels';
/** `GET /workspace-topics` — carries DM-ness and the operator's channel title. */
export const NOTIFY_TOPICS_QUERY_KEY = 'workspace-topics';

/** Same staleness the rail declares for each key, so this never double-fetches. */
const CHANNELS_STALE_MS = 5 * 60_000;
const TOPICS_STALE_MS = 30_000;

/**
 * Make sure both payloads exist, fetching only what is missing or stale.
 *
 * The rail is the normal producer of both caches, but it UNMOUNTS with a
 * collapsed sidebar — and an operator who collapsed it would otherwise get no
 * channel notifications at all, silently. `ensureQueryData` respects the same
 * staleTime the rail declares, so on the common path (rail mounted, data fresh)
 * this costs zero requests.
 */
export async function ensureNotifySummaryCaches(
  queryClient: QueryClient
): Promise<void> {
  await Promise.allSettled([
    queryClient.ensureQueryData({
      queryKey: [NOTIFY_CHANNELS_QUERY_KEY],
      queryFn: fetchChannels,
      staleTime: CHANNELS_STALE_MS,
    }),
    queryClient.ensureQueryData({
      queryKey: [NOTIFY_TOPICS_QUERY_KEY],
      queryFn: () => fetchWorkspaceTopics(),
      staleTime: TOPICS_STALE_MS,
    }),
  ]);
}

/**
 * True when something is already OBSERVING `['channels']` — in practice the
 * rail, which refetches the summary list on its own throttle.
 *
 * The notify lane's refresh exists to cover the rail being unmounted (collapsed
 * sidebar) or deliberately suppressed (hidden tab). When the rail IS mounted and
 * visible it is the cheaper producer and already runs, so this lane must stand
 * down rather than double the hub's `GET /channels` load — which is O(channels)
 * server-side.
 */
export function channelSummariesHaveObserver(
  queryClient: QueryClient
): boolean {
  const query = queryClient
    .getQueryCache()
    .find({ queryKey: [NOTIFY_CHANNELS_QUERY_KEY], exact: true });
  return (query?.getObserversCount() ?? 0) > 0;
}

/**
 * Force a fresh `/channels` payload into the cache.
 *
 * `fetchQuery`, not `invalidateQueries`: invalidation only refetches queries
 * that have an ACTIVE observer, so with the rail unmounted it would mark the
 * cache stale and nothing would ever fetch it. Fetching writes the same cache
 * entry, so `watchChannelSummaries` sees it and a later rail mount reads it too.
 */
export async function refreshChannelSummaries(
  queryClient: QueryClient
): Promise<void> {
  try {
    await queryClient.fetchQuery({
      queryKey: [NOTIFY_CHANNELS_QUERY_KEY],
      queryFn: fetchChannels,
      staleTime: 0,
    });
  } catch {
    // Best effort. A missed refresh costs one delayed notification; the next
    // activity burst arms another window.
  }
}

/**
 * Run the producer over whatever is cached now, then on every later update of
 * either payload. Returns the unsubscribe.
 *
 * The FIRST pass badges without notifying: it describes everything that happened
 * while this client was away, so a tab restored into the background would
 * otherwise fire one notification per unread channel at once. Those rows are
 * genuinely unread and earn their in-app badge; none of them is news.
 *
 * Re-running on an update that changed nothing is free — the gate's per-channel
 * replay guard is what makes the pass idempotent, which is also why this lane
 * keeps no "rows I have already seen" ledger of its own.
 */
/**
 * Drop badge flags for channels the active topic list no longer contains.
 *
 * `['workspace-topics']` (the exact key, which is always the ACTIVE view — the
 * archived one rides a distinct key) is the closest thing this lane has to a
 * channel-deleted signal: a flagged channel that has left it was deleted or
 * archived, and neither should keep pulling the operator's eye to a tab.
 *
 * Skipped on a TRUNCATED payload, which is a page of the corpus rather than the
 * whole of it — pruning against it would clear flags for channels that exist.
 */
function pruneBadgesForMissingChannels(
  channels: ReadonlyMap<string, unknown>,
  truncated: boolean
): void {
  if (truncated) return;
  const badges = useNotifyBadgeStore.getState();
  for (const channelId of Object.keys(badges.flagByChannel)) {
    if (!channels.has(channelId)) badges.clearChannel(channelId);
  }
}

export function watchChannelSummaries(queryClient: QueryClient): () => void {
  let seeded = false;

  function runPass(): void {
    const rows = queryClient.getQueryData<NotifySummaryRow[]>([
      NOTIFY_CHANNELS_QUERY_KEY,
    ]);
    const topics = queryClient.getQueryData<{
      topics?: NotifyTopicRecord[];
      truncated?: boolean;
    }>([NOTIFY_TOPICS_QUERY_KEY]);
    // The PRUNE runs before the notify guard, and is keyed on the topic payload
    // EXISTING rather than being non-empty. Deleting or archiving the last
    // remaining channel empties that list — which is at once the only case
    // where every cached badge is provably stale and a case the notify pass has
    // nothing to do, so a prune behind its guard would leave the favicon dot
    // and title count pinned for the life of the tab.
    const channels = topics?.topics ? notifyChannelIndex(topics.topics) : null;
    if (channels) {
      pruneBadgesForMissingChannels(channels, topics?.truncated === true);
    }
    // BOTH payloads are required for the notify pass, and either can land
    // second on a cold boot — which is why the subscription below watches both
    // keys rather than just the channel list.
    if (!rows || !channels || channels.size === 0) return;
    const osTier = seeded;
    seeded = true;
    notifyFromChannelSummaries({ rows, channels, osTier });
  }

  runPass();
  return queryClient.getQueryCache().subscribe((event) => {
    const key = event.query.queryKey;
    if (!Array.isArray(key)) return;
    if (
      key[0] !== NOTIFY_CHANNELS_QUERY_KEY &&
      key[0] !== NOTIFY_TOPICS_QUERY_KEY
    ) {
      return;
    }
    runPass();
  });
}
