import type { AnalyticsView } from '../stores/ui.js';

export type AppViewMode = 'org' | 'dashboard' | 'session' | 'analytics';

export interface ResolveAppViewModeInput {
  analyticsView: AnalyticsView;
  hasActiveSession: boolean;
  activeRepoPath: string | null;
}

export function resolveAppViewMode({
  analyticsView,
  hasActiveSession,
  activeRepoPath,
}: ResolveAppViewModeInput): AppViewMode {
  if (analyticsView !== null) return 'analytics';
  if (hasActiveSession) return 'session';

  // The no-session / no-explicit-project landing path is the WorkContext
  // cockpit, even before a local repo has been added. RepoDashboard remains
  // reserved for an explicit repo/project selection.
  if (!activeRepoPath) return 'org';
  return 'dashboard';
}
