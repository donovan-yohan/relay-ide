import { useEffect, useRef, useCallback } from 'react';
import { useSessionsStore } from '../lib/stores/sessions.js';
import { useUiStore } from '../lib/stores/ui.js';
import { resolveSessionByKey, scopedSessionKey } from '../lib/session-keys.js';
import {
  parseRoute,
  buildPath,
  parseModal,
  parseMessageAnchor,
  buildQuery,
  type RouteState,
} from '../lib/url-nav.js';
import { leaveChatSurface } from '../lib/topic-task-room.js';

/**
 * Applies a parsed route to the stores. Shared by the boot restore and the
 * back/forward handler so the two can never drift — a route variant handled in
 * one and forgotten in the other is exactly how a surface ends up navigable
 * forwards but not backwards.
 *
 * Every branch writes EVERY routed field, including the ones it clears. The
 * chat-shell surfaces are the case that makes this mandatory: an open channel
 * outranks the session and the composer in `resolveAppViewMode`, and the
 * composer in turn outranks the session and the repo — so a `home`/`repo`/
 * `session` route that left either latched would move the URL while the old
 * surface stayed on screen (#1287). Non-channel branches therefore go through
 * the shared `leaveChatSurface()` rather than clearing the channel by hand;
 * clearing only half is what made the composer survive a route restore.
 */
function applyRoute(route: RouteState, hash = ''): void {
  const ui = useUiStore.getState();
  const sessions = useSessionsStore.getState();

  switch (route.view) {
    case 'channel': {
      ui.setActiveChannelId(route.channelId);
      ui.setTopicComposerOpen(false);
      ui.setAnalyticsView(null);
      // The session selection is dropped rather than kept underneath: with it
      // still set, closing the channel would drop the operator onto a terminal
      // they never navigated to on this history entry.
      sessions.setActiveSessionId(null);
      // #1308 item 1: `/channel/<id>#msg-<id>` is a channel open PLUS a scroll
      // intent. Written after the open on purpose — `setActiveChannelId` clears
      // any un-consumed anchor so a cancelled navigation cannot fire one later.
      const anchoredMessageId = parseMessageAnchor(hash);
      if (anchoredMessageId !== null) {
        ui.requestChannelMessage(route.channelId, anchoredMessageId);
      }
      break;
    }

    case 'repo':
      leaveChatSurface();
      ui.setActiveRepoPath(route.repoPath);
      sessions.setActiveSessionId(null);
      ui.setAnalyticsView(null);
      break;

    case 'session': {
      leaveChatSurface();
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
      leaveChatSurface();
      ui.setAnalyticsView('dashboard');
      break;

    case 'analytics-detail':
      leaveChatSurface();
      ui.setAnalyticsView({ sessionId: route.sessionId });
      break;

    case 'home':
    default:
      leaveChatSurface();
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
 * Correct the address in place when the store could not honour the URL it was
 * just applied from — a session id that no longer resolves, say. Pushing would
 * add an entry the operator never navigated to; leaving it stale would re-apply
 * the dead route on the next reload.
 *
 * Done eagerly at apply time rather than by arming a flag for the push effect
 * to consume. That effect only runs when one of its deps changes, and a route
 * the store already matched field-for-field changes none of them: `applyRoute`
 * writes the same primitives back through plain `set()` calls, so zustand
 * re-renders nothing. Booting on `/<repo-hash>/gone` with that repo already
 * active is exactly that case — the dead URL went uncorrected AND the flag
 * survived into the operator's NEXT real navigation, turning that push into a
 * replace so the surface they opened created no history entry and Back left the
 * app (#1287).
 */
function correctUrlToStore(): void {
  const url = currentStateUrl();
  if (url === window.location.pathname + window.location.search) return;
  window.history.replaceState(null, '', url);
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
      applyRoute(route, window.location.hash);
      useUiStore.getState().setActiveModal(modal);
      correctUrlToStore();
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
    // A URL-driven change has already been reconciled by `correctUrlToStore`,
    // so anything reaching here is the operator navigating: always a push.
    if (current === url) return;
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
      applyRoute(
        parseRoute(window.location.pathname, currentRepos),
        window.location.hash
      );
      // Restore modal state from query params
      useUiStore.getState().setActiveModal(parseModal(window.location.search));
      correctUrlToStore();
    };

    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, []);

  // ── Re-arm a message anchor typed/pasted onto the SAME channel ────────────
  // A fragment-only change never fires `popstate`, so the handler above cannot
  // see it. Only the anchor is re-applied: the path is unchanged by definition,
  // so re-running `applyRoute` would be a no-op that also cleared the anchor.
  useEffect(() => {
    const handler = () => {
      const currentRepos = useSessionsStore.getState().repos;
      const route = parseRoute(window.location.pathname, currentRepos);
      if (route.view !== 'channel') return;
      const messageId = parseMessageAnchor(window.location.hash);
      if (messageId === null) return;
      useUiStore.getState().requestChannelMessage(route.channelId, messageId);
    };

    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);

  return { restoreFromUrl };
}
