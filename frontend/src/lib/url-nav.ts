import type { Repo } from './types.js';
import type { AnalyticsView } from './stores/ui.js';

/**
 * Stable hash of a string → 6-char base36 token.
 * Uses djb2; collisions are astronomically unlikely for local repo paths.
 */
export function hashPath(path: string): string {
  let h = 5381;
  for (let i = 0; i < path.length; i++) {
    h = ((h << 5) + h + path.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36).padStart(6, '0').slice(0, 6);
}

// ── Modal route (query params) ───────────────────────────────────────────────

export type ModalRoute =
  | { modal: 'settings'; scrollToId: string | null }
  | { modal: 'add-repo' }
  // #630: env-picker is a transient palette-driven dialog. It is included in
  // the ModalRoute union so the activeModal store shape stays compatible with
  // ActiveModal, but it is intentionally NOT persisted to the URL — opening
  // it via deep link would race the env-inventory feed.
  | { modal: 'env-picker' }
  // #692: handoff dry-run is also transient/in-memory. Deep-linking a fixture
  // modal would imply live #691 planner availability that does not exist yet.
  | { modal: 'handoff-plan' }
  | null;

/** Parse `window.location.search` into a ModalRoute. */
export function parseModal(search: string): ModalRoute {
  const params = new URLSearchParams(search);
  if (params.has('settings')) {
    const val = params.get('settings');
    return { modal: 'settings', scrollToId: val || null };
  }
  if (params.has('add-repo')) {
    return { modal: 'add-repo' };
  }
  return null;
}

/** Build a query string from modal state. */
export function buildQuery(modal: ModalRoute): string {
  if (!modal) return '';
  if (modal.modal === 'settings') {
    return modal.scrollToId ? `?settings=${modal.scrollToId}` : '?settings';
  }
  if (modal.modal === 'add-repo') return '?add-repo';
  // #630: env-picker is in-memory only; no URL representation.
  if (modal.modal === 'env-picker') return '';
  // #692: handoff dry-run is in-memory only until live planner APIs land.
  if (modal.modal === 'handoff-plan') return '';
  return '';
}

// ── Route state ──────────────────────────────────────────────────────────────

export type RouteState =
  | { view: 'home' }
  | { view: 'repo'; repoPath: string }
  | { view: 'session'; repoPath: string; sessionId: string }
  | { view: 'analytics' }
  | { view: 'analytics-detail'; sessionId: string };

/** Parse `window.location.pathname` into a RouteState. */
export function parseRoute(pathname: string, repos: Repo[]): RouteState {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length === 0) return { view: 'home' };

  // /analytics or /analytics/<sessionId>
  if (parts[0] === 'analytics') {
    if (parts[1]) return { view: 'analytics-detail', sessionId: parts[1] };
    return { view: 'analytics' };
  }

  // /<hash> or /<hash>/<sessionId>
  const lookup = new Map(repos.map((r) => [hashPath(r.path), r.path]));
  const repoPath = lookup.get(parts[0]!);
  if (!repoPath) return { view: 'home' };
  if (parts[1]) return { view: 'session', repoPath, sessionId: parts[1] };
  return { view: 'repo', repoPath };
}

/** Build a URL path from app state. */
export function buildPath(
  repoPath: string | null,
  sessionId: string | null,
  analyticsView: AnalyticsView,
  repos: Repo[]
): string {
  // Analytics routes take priority
  if (analyticsView === 'dashboard') return '/analytics';
  if (analyticsView !== null && typeof analyticsView === 'object') {
    return `/analytics/${analyticsView.sessionId}`;
  }

  if (!repoPath) return '/';
  if (!repos.some((r) => r.path === repoPath)) return '/';
  const h = hashPath(repoPath);
  return sessionId ? `/${h}/${sessionId}` : `/${h}`;
}
