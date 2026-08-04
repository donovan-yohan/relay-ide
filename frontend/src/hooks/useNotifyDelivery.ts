// Mounts the channel-notification delivery surfaces (#1308 slice 5 item 2).
//
// One hook, called once from `App`, owning three things:
//   1. the MENTION / DM-REPLY producer, fed by the `/channels` summary payload;
//   2. the favicon dot + title count, both derived from the badge store and the
//      slice-3 read position — never from a second unread implementation;
//   3. a narrowly-scoped summary refresh for the two cases the rail cannot
//      cover — a hidden tab (where the rail suppresses its own refresh) and a
//      collapsed sidebar (where the rail is not mounted at all).
//
// Nothing here requests notification permission. That happens in the runtime,
// from the first gate-approved event (`notify/runtime.ts`), or from the explicit
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
import { resetNotifyRuntime } from '../lib/notify/runtime.js';
import {
  channelSummariesHaveObserver,
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
 * Trailing window for the summary refresh while the tab is HIDDEN.
 *
 * `GET /channels` is O(channels) server-side, so this buys notification latency
 * down to ten seconds and no more.
 */
const HIDDEN_SUMMARY_REFRESH_MS = 10_000;

/**
 * Trailing window while the tab is VISIBLE.
 *
 * Deliberately longer. A visible tab usually has the rail mounted, in which case
 * this lane stands down entirely (see `channelSummariesHaveObserver`); the only
 * case it covers is a COLLAPSED sidebar, where nothing else fetches the summary
 * list and the operator would otherwise get no mention or DM badge at all — the
 * exact hole `ensureNotifySummaryCaches` only plugs once, at boot.
 */
const VISIBLE_SUMMARY_REFRESH_MS = 45_000;

/**
 * True when a summary refresh could produce anything the operator would see.
 *
 * PERMISSION IS NOT CHECKED HERE, and that is the point: a refresh feeds the
 * in-app badge tier (favicon dot, title count) as well as the OS tier, and the
 * badge tier needs no grant. Gating this on `granted` made the OS tier
 * unreachable on a fresh browser — the only lane that can produce a payload
 * while hidden refused to run until permission existed, and permission was only
 * ever requested from an event that lane produced.
 *
 * Turn-complete is excluded on purpose: it is fed by the socket and needs no
 * fetch.
 */
function messageTriggersEnabled(): boolean {
  const settings = currentNotifySettings();
  return settings.mentions || settings.dmReplies;
}

/**
 * How long a refresh must wait, decided at FIRE time.
 *
 * A HIDDEN tab is only worth the short window when the OS tier can actually
 * fire, because that tier is the only thing a hidden tab can show. Permission
 * still does NOT gate whether the refresh happens — `default` must keep the
 * short cadence or the lazy grant is unreachable (see `messageTriggersEnabled`)
 * — but `denied`, and a browser with no Notification API at all (an iOS Safari
 * tab outside an installed PWA), can produce nothing but a favicon dot nobody
 * is looking at. Those wait the long window rather than holding the hub at a
 * ten-second `GET /channels` cadence, times every open tab, for the whole
 * length of an agent turn.
 */
function summaryRefreshDelayMs(doc: Document): number {
  if (!doc.hidden) return VISIBLE_SUMMARY_REFRESH_MS;
  const permission = notifyPermissionState();
  return permission === 'denied' || permission === 'unsupported'
    ? VISIBLE_SUMMARY_REFRESH_MS
    : HIDDEN_SUMMARY_REFRESH_MS;
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
    return () => {
      stop();
      // Stopping the watcher is not enough. The gate's per-channel seq ledger,
      // its OS rate-limit windows and the badge flags all outlive it, so after
      // an auth expiry and a re-auth every seq already recorded would be
      // permanently replay-suppressed — a message the operator never read could
      // not raise its badge again on this tab.
      resetNotifyRuntime();
    };
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

  // ── self-sufficient summary refresh ────────────────────────────────────────
  //
  // Two lanes the rail cannot cover, and it owns the ONLY activity-driven
  // `['channels']` refetch:
  //   * HIDDEN tab — the rail deliberately suppresses its refresh there, which
  //     is exactly when the OS tier is the only tier there is;
  //   * COLLAPSED sidebar — `TopicSidebarShell` is unmounted, so its
  //     `invalidateQueries(['channels'])` refetches nothing (invalidation is
  //     `refetchType: 'active'`) and no observer exists to fetch on its own.
  //     Without this the operator gets no mention or DM badge, dot, title count
  //     or notification at all after the boot seed.
  //
  // BOTH the stand-down and the WINDOW are decided at FIRE time, not schedule
  // time: the rail can mount or unmount inside the window, and the tab can be
  // switched away from inside it. An operator who generates activity with the
  // tab visible (long window armed) and then switches away is exactly the case
  // where the OS tier becomes the only tier — waiting out the window the tab
  // no longer deserves would delay that first notification by up to 45s.
  useEffect(() => {
    if (!enabled) return;
    const doc = typeof document === 'undefined' ? null : document;
    if (!doc) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let armedAt = 0;
    const fire = (): void => {
      timer = undefined;
      const required = summaryRefreshDelayMs(doc);
      const elapsed = Date.now() - armedAt;
      // Re-armed for the REMAINDER, never restarted from now: the trailing
      // guarantee below is measured from the activity that armed the window, so
      // a tab that went visible mid-window waits out the rest of the long one
      // and no more.
      if (elapsed < required) {
        timer = setTimeout(fire, required - elapsed);
        return;
      }
      // Standing down applies to a VISIBLE tab only. The rail keeps its
      // observer mounted while hidden but deliberately suppresses its own
      // refetch there, so an observer on a hidden tab means nobody is
      // fetching at all — which is the gap this lane exists to fill.
      if (!doc.hidden && channelSummariesHaveObserver(queryClient)) return;
      void refreshChannelSummaries(queryClient);
    };
    const unsubscribe = useChannelActivityStore.subscribe((state, previous) => {
      if (state.latestSeqByChannel === previous.latestSeqByChannel) return;
      if (!messageTriggersEnabled()) return;
      // Trailing, and NOT reset by later activity: an agent streaming a long
      // turn must not be able to starve the refresh it is the reason for.
      if (timer !== undefined) return;
      armedAt = Date.now();
      // Always the SHORT tick first. It is only a wake-up, not a fetch: `fire`
      // re-arms for the remainder when the window it finds is the longer one,
      // which is what lets the decision be made late without ever being late.
      timer = setTimeout(fire, HIDDEN_SUMMARY_REFRESH_MS);
    });
    return () => {
      unsubscribe();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [enabled, queryClient]);
}
