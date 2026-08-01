import { useEffect, useRef, useCallback } from 'react';
import { useSessionsStore } from '../lib/stores/sessions.js';
import { useUiStore } from '../lib/stores/ui.js';
import { resolveSessionByKey, scopedSessionKey } from '../lib/session-keys.js';
import {
  parseRoute,
  buildPath,
  parseModal,
  buildQuery,
  type RouteState,
} from '../lib/url-nav.js';

/**
 * Applies a parsed route to the stores. Shared by the boot restore and the
 * back/forward handler so the two can never drift — a route variant handled in
 * one and forgotten in the other is exactly how a surface ends up navigable
 * forwards but not backwards.
 *
 * Every branch writes EVERY routed field, including the ones it clears. The
 * channel is the case that makes this mandatory: it outranks the session and
 * the composer in `resolveAppViewMode`, so a `home`/`repo`/`session` route that
 * left `activeChannelId` alone would move the URL while the channel stayed on
 * screen (#1287).
 */
function applyRoute(route: RouteState): void {
  const ui = useUiStore.getState();
  const sessions = useSessionsStore.getState();

  switch (route.view) {
    case 'channel':
      ui.setActiveChannelId(route.channelId);
      ui.setTopicComposerOpen(false);
      ui.setAnalyticsView(null);
      // The session selection is dropped rather than kept underneath: with it
      // still set, closing the channel would drop the operator onto a terminal
      // they never navigated to on this history entry.
      sessions.setActiveSessionId(null);
      break;

    case 'repo':
      ui.setActiveChannelId(null);
      ui.setActiveRepoPath(route.repoPath);
      sessions.setActiveSessionId(null);
      ui.setAnalyticsView(null);
      break;

    case 'session': {
      ui.setActiveChannelId(null);
      ui.setActiveRepoPath(route.repoPath);
      const session = resolveSessionByKey(sessions.sessions, route.sessionId);
      if (session) {
        sessions.setActiveSessionId(scopedSessionKey(session));
      } else {
        // Session no longer exists — fall back to repo view and fix URL
        sessions.setActiveSessionId(null);
      }
      ui.setAnalyticsView(null);
      break;
    }

    case 'analytics':
      ui.setActiveChannelId(null);
      ui.setAnalyticsView('dashboard');
      break;

    case 'analytics-detail':
      ui.setActiveChannelId(null);
      ui.setAnalyticsView({ sessionId: route.sessionId });
      break;

    case 'home':
    default:
      ui.setActiveChannelId(null);
      ui.setActiveRepoPath(null);
      sessions.setActiveSessionId(null);
      ui.setAnalyticsView(null);
      break;
  }
}

/** The URL the current store state would produce. */
function currentStateUrl(): string {
  const ui = useUiStore.getState();
  const sessions = useSessionsStore.getState();
  return (
    buildPath(
      ui.activeRepoPath,
      sessions.activeSessionId,
      ui.analyticsView,
      sessions.repos,
      ui.activeChannelId
    ) + buildQuery(ui.activeModal)
  );
}

/**
 * Whether the store already round-trips to the URL it was just applied from.
 *
 * The push effect only runs when one of its deps changes, so a suppression flag
 * raised for a URL-driven update that turned out to be a no-op would never be
 * consumed — it would silently swallow the NEXT real navigation instead. Asking
 * this question right after applying a route keeps the flag one-shot in fact,
 * not just in intent.
 */
function storeMatchesUrl(): boolean {
  return (
    currentStateUrl() === window.location.pathname + window.location.search
  );
}

/**
 * Syncs browser URL ↔ active repo / session / channel / analytics / modal state.
 *
 * - User navigation pushes history entries automatically
 * - Browser back/forward updates the store without pushing
 * - `restoreFromUrl()` should be called once after initial data fetch
 */
export function useUrlNav() {
  const repos = useSessionsStore((s) => s.repos);
  const activeRepoPath = useUiStore((s) => s.activeRepoPath);
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const activeChannelId = useUiStore((s) => s.activeChannelId);
  const analyticsView = useUiStore((s) => s.analyticsView);
  const activeModal = useUiStore((s) => s.activeModal);

  // When true, the next store-change effect corrects the URL in place instead
  // of pushing — the change came FROM the URL and did not round-trip.
  const suppressPush = useRef(false);
  // Whether initial restore has run (prevents pushing during boot)
  const restored = useRef(false);

  // ── Restore state from URL (call after initial data fetch) ────────────────
  const restoreFromUrl = useCallback(() => {
    const currentRepos = useSessionsStore.getState().repos;
    const route = parseRoute(window.location.pathname, currentRepos);
    const modal = parseModal(window.location.search);

    if (route.view === 'home') {
      // No route in URL — replace URL with current store state
      useUiStore.getState().setActiveModal(modal);
      window.history.replaceState(null, '', currentStateUrl());
    } else {
      // A deep-linked channel is restored on its id alone — the channel list is
      // not loaded yet at boot, and waiting for it would leave the top-priority
      // surface blank behind every other query. `ChannelView` owns the unknown/
      // deleted case: it fetches the channel itself and renders the "this chat
      // no longer exists" recovery, whose back action clears `activeChannelId`
      // and lets the push effect below move the URL off the dead link. A
      // segment that is not a legal topic id never gets that far — `parseRoute`
      // already resolved it to `home`.
      applyRoute(route);
      useUiStore.getState().setActiveModal(modal);
      suppressPush.current = !storeMatchesUrl();
    }

    restored.current = true;
  }, []);

  // ── Push URL whenever routed state changes ────────────────────────────────
  useEffect(() => {
    if (!restored.current) return;

    const path = buildPath(
      activeRepoPath,
      activeSessionId,
      analyticsView,
      repos,
      activeChannelId
    );
    const query = buildQuery(activeModal);
    const url = path + query;
    const current = window.location.pathname + window.location.search;
    if (current === url) {
      suppressPush.current = false;
      return;
    }
    if (suppressPush.current) {
      // The URL asked for something the store could not honour (a session id
      // that no longer resolves, say). Correct the address in place: pushing
      // would add an entry the operator never navigated to, and leaving it
      // stale would re-apply the dead route on the next reload.
      suppressPush.current = false;
      window.history.replaceState(null, '', url);
      return;
    }
    window.history.pushState(null, '', url);
  }, [
    activeRepoPath,
    activeSessionId,
    activeChannelId,
    analyticsView,
    repos,
    activeModal,
  ]);

  // ── Handle browser back / forward ─────────────────────────────────────────
  useEffect(() => {
    const handler = () => {
      const currentRepos = useSessionsStore.getState().repos;
      applyRoute(parseRoute(window.location.pathname, currentRepos));
      // Restore modal state from query params
      useUiStore.getState().setActiveModal(parseModal(window.location.search));
      suppressPush.current = !storeMatchesUrl();
    };

    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, []);

  return { restoreFromUrl };
}
