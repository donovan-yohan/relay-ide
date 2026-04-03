import { useEffect, useRef, useCallback } from 'react';
import { useSessionsStore } from '../lib/stores/sessions.js';
import { useUiStore } from '../lib/stores/ui.js';
import type { ModalRoute } from '../lib/url-nav.js';
import { parseRoute, buildPath, parseModal, buildQuery } from '../lib/url-nav.js';

/**
 * Syncs browser URL ↔ active repo / session / analytics / modal state.
 *
 * - User navigation pushes history entries automatically
 * - Browser back/forward updates the store without pushing
 * - `restoreFromUrl()` should be called once after initial data fetch
 */
export function useUrlNav() {
  const repos = useSessionsStore((s) => s.repos);
  const activeRepoPath = useUiStore((s) => s.activeRepoPath);
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const analyticsView = useUiStore((s) => s.analyticsView);
  const activeModal = useUiStore((s) => s.activeModal);

  // When true, the next store-change effect skips pushing URL
  const suppressPush = useRef(false);
  // Whether initial restore has run (prevents pushing during boot)
  const restored = useRef(false);

  // ── Restore state from URL (call after initial data fetch) ────────────────
  const restoreFromUrl = useCallback(() => {
    const currentRepos = useSessionsStore.getState().repos;
    const route = parseRoute(window.location.pathname, currentRepos);
    const modal = parseModal(window.location.search);

    suppressPush.current = true;

    if (route.view === 'home') {
      // No route in URL — replace URL with current store state
      const rp = useUiStore.getState().activeRepoPath;
      const sid = useSessionsStore.getState().activeSessionId;
      const av = useUiStore.getState().analyticsView;
      const url = buildPath(rp, sid, av, currentRepos) + buildQuery(modal);
      window.history.replaceState(null, '', url);
    } else {
      applyRoute(route, modal);
    }

    restored.current = true;
  }, []);

  // ── Push URL whenever routed state changes ────────────────────────────────
  useEffect(() => {
    if (!restored.current) return;
    if (suppressPush.current) {
      suppressPush.current = false;
      return;
    }

    const path = buildPath(activeRepoPath, activeSessionId, analyticsView, repos);
    const query = buildQuery(activeModal);
    const url = path + query;
    const current = window.location.pathname + window.location.search;
    if (current !== url) {
      window.history.pushState(null, '', url);
    }
  }, [activeRepoPath, activeSessionId, analyticsView, repos, activeModal]);

  // ── Handle browser back / forward ─────────────────────────────────────────
  useEffect(() => {
    const handler = () => {
      suppressPush.current = true;
      const currentRepos = useSessionsStore.getState().repos;
      const route = parseRoute(window.location.pathname, currentRepos);
      const modal = parseModal(window.location.search);

      if (route.view === 'home') {
        useUiStore.getState().setActiveRepoPath(null);
        useSessionsStore.getState().setActiveSessionId(null);
        useUiStore.getState().setAnalyticsView(null);
      } else {
        applyRoute(route, modal);
      }

      useUiStore.getState().setActiveModal(modal);
    };

    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, []);

  return { restoreFromUrl };
}

// ── Shared route dispatcher ─────────────────────────────────────────────────
// Used by both restoreFromUrl and the popstate handler to avoid duplication.
function applyRoute(
  route: Exclude<ReturnType<typeof parseRoute>, { view: 'home' }>,
  modal: ModalRoute
) {
  const currentSessions = useSessionsStore.getState().sessions;

  switch (route.view) {
    case 'repo':
      useUiStore.getState().setActiveRepoPath(route.repoPath);
      useSessionsStore.getState().setActiveSessionId(null);
      useUiStore.getState().setAnalyticsView(null);
      break;

    case 'session':
      useUiStore.getState().setActiveRepoPath(route.repoPath);
      if (currentSessions.some((s) => s.id === route.sessionId)) {
        useSessionsStore.getState().setActiveSessionId(route.sessionId);
      } else {
        useSessionsStore.getState().setActiveSessionId(null);
      }
      useUiStore.getState().setAnalyticsView(null);
      break;

    case 'analytics':
      useUiStore.getState().setAnalyticsView('dashboard');
      break;

    case 'analytics-detail':
      useUiStore.getState().setAnalyticsView({
        sessionId: route.sessionId,
      });
      break;
  }

  useUiStore.getState().setActiveModal(modal);
}
