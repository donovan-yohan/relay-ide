// Mounts the channel-notification delivery surfaces (#1308 slice 5 item 2).
//
// One hook, called once from `App`, owning three things:
//   1. the MENTION / DM-REPLY producer, fed by the `/channels` summary payload;
//   2. the favicon dot + title count, both derived from the badge store and the
//      slice-3 read position — never from a second unread implementation;
//   3. a narrowly-scoped background refresh so the OS tier is not dead while
//      the tab is hidden.
//
// Nothing here requests notification permission. That happens on the first
// event that would actually notify (`os-notification.ts`) or from the explicit
// button in Settings › notifications.
//
// It reads the query CACHE and takes the client as an argument rather than
// calling `useQuery`/`useQueryClient`: `App` renders `QueryClientProvider` in
// its own JSX, so the component body itself is outside the context — the same
// reason `useEventSocket` is handed the client. Reading the cache is also the
// cheaper shape: the rail already fetches both payloads, and a second observer
// would only add fetch policy this lane has no opinion about.
import { useEffect, useRef, useState } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import {
  createFaviconBadge,
  type FaviconBadge,
} from '../lib/notify/favicon-badge.js';
import { notifyPermissionState } from '../lib/notify/os-notification.js';
import {
  ensureNotifySummaryCaches,
  refreshChannelSummaries,
  watchChannelSummaries,
} from '../lib/notify/summary-watch.js';
import {
  createTitleBadge,
  type TitleBadge,
} from '../lib/notify/title-badge.js';
import { useChannelActivityStore } from '../lib/stores/channel-activity.js';
import {
  countAttentionChannels,
  useNotifyBadgeStore,
} from '../lib/stores/notify-badge.js';
import { currentNotifySettings } from '../lib/stores/notify-settings.js';

/**
 * Trailing window for the hidden-tab summary refresh.
 *
 * Long — an order of magnitude above the rail's own foreground throttle. This
 * lane exists to keep OS notifications alive for a tab nobody is looking at, and
 * `GET /channels` is O(channels) server-side, so it buys latency down to ten
 * seconds and no more.
 */
const HIDDEN_SUMMARY_REFRESH_MS = 10_000;

/**
 * True when a summary refresh could actually produce an OS notification.
 *
 * The refresh is gated on this rather than run unconditionally, so the hub pays
 * nothing extra for an operator who never granted permission or switched every
 * message trigger off. Turn-complete is excluded on purpose: it is fed by the
 * socket and needs no fetch.
 */
function osTierReachable(): boolean {
  if (notifyPermissionState() !== 'granted') return false;
  const settings = currentNotifySettings();
  return settings.mentions || settings.dmReplies;
}

export function useNotifyDelivery(
  enabled: boolean,
  queryClient: QueryClient
): void {
  // ── mention / DM-reply producer ────────────────────────────────────────────
  useEffect(() => {
    if (!enabled) return;
    // Watch FIRST, then ensure: a payload that lands between the two calls is
    // seen by the subscription rather than missed in the gap.
    const stop = watchChannelSummaries(queryClient);
    void ensureNotifySummaryCaches(queryClient);
    return stop;
  }, [enabled, queryClient]);

  // ── favicon + title ────────────────────────────────────────────────────────
  // Both stores are subscribed IMPERATIVELY rather than through selectors: the
  // count is derived from two of them at once, so a selector on either would
  // re-render `App` — the whole tree — every time any channel's read mark moved
  // or any flag was raised. Recomputing into `useState` renders only when the
  // NUMBER changes, which is the only thing these surfaces draw.
  const [attentionCount, setAttentionCount] = useState(0);
  useEffect(() => {
    const recompute = (): void => {
      setAttentionCount(
        countAttentionChannels(
          useNotifyBadgeStore.getState().flagByChannel,
          useChannelActivityStore.getState().lastReadByChannel
        )
      );
    };
    recompute();
    const unsubscribeFlags = useNotifyBadgeStore.subscribe(recompute);
    const unsubscribeReads = useChannelActivityStore.subscribe(recompute);
    return () => {
      unsubscribeFlags();
      unsubscribeReads();
    };
  }, []);

  const surfaces = useRef<{ favicon: FaviconBadge; title: TitleBadge } | null>(
    null
  );
  useEffect(() => {
    // Constructed inside an effect, never at module scope: both capture the
    // document's ORIGINAL favicon href and title, which must be read after the
    // page exists and before this lane has written to either.
    surfaces.current = {
      favicon: createFaviconBadge(),
      title: createTitleBadge(),
    };
    return () => {
      surfaces.current?.favicon.reset();
      surfaces.current?.title.reset();
      surfaces.current = null;
    };
  }, []);

  useEffect(() => {
    const current = surfaces.current;
    if (!current) return;
    const count = enabled ? attentionCount : 0;
    current.title.set(count);
    current.favicon.set(count > 0);
  }, [enabled, attentionCount]);

  // ── hidden-tab summary refresh ─────────────────────────────────────────────
  useEffect(() => {
    if (!enabled) return;
    const doc = typeof document === 'undefined' ? null : document;
    if (!doc) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = useChannelActivityStore.subscribe((state, previous) => {
      if (state.latestSeqByChannel === previous.latestSeqByChannel) return;
      // Visible tabs are already covered: the rail refetches the summary list on
      // its own (tighter) throttle, and this lane's producer runs off whatever
      // payload that produces. A HIDDEN tab is the gap — the rail deliberately
      // suppresses its refresh there, which is exactly when the OS tier is the
      // only tier there is.
      if (!doc.hidden) return;
      if (!osTierReachable()) return;
      if (timer !== undefined) return;
      // Trailing, and NOT reset by later activity: an agent streaming a long
      // turn must not be able to starve the refresh it is the reason for.
      timer = setTimeout(() => {
        timer = undefined;
        void refreshChannelSummaries(queryClient);
      }, HIDDEN_SUMMARY_REFRESH_MS);
    });
    return () => {
      unsubscribe();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [enabled, queryClient]);
}
