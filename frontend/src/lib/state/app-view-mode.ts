import type { AnalyticsView } from '../stores/ui.js';

export type AppViewMode =
  | 'chat'
  | 'org'
  | 'dashboard'
  | 'session'
  | 'analytics';

export interface ResolveAppViewModeInput {
  analyticsView: AnalyticsView;
  hasActiveSession: boolean;
  activeRepoPath: string | null;
  /**
   * #1058: explicit escape hatch back to the legacy WorkContext cockpit
   * (`OrgDashboard`), set via the "open work cockpit" command-palette
   * action. Only relevant for the no-session/no-repo landing path — an
   * explicit repo/project selection still resolves to `dashboard`.
   */
  forceOrgCockpit?: boolean;
}

export function resolveAppViewMode({
  analyticsView,
  hasActiveSession,
  activeRepoPath,
  forceOrgCockpit = false,
}: ResolveAppViewModeInput): AppViewMode {
  if (analyticsView !== null) return 'analytics';
  if (hasActiveSession) return 'session';

  // The no-session / no-explicit-project landing path defaults to the
  // chat/topic spine (#1058). The legacy WorkContext cockpit remains
  // reachable via forceOrgCockpit. RepoDashboard remains reserved for an
  // explicit repo/project selection.
  if (!activeRepoPath) return forceOrgCockpit ? 'org' : 'chat';
  return 'dashboard';
}
