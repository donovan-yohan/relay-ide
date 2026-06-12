import type { AnalyticsView } from '../stores/ui.js';

export type AppViewMode = 'empty' | 'org' | 'dashboard' | 'session' | 'analytics';

export interface ResolveAppViewModeInput {
  analyticsView: AnalyticsView;
  hasActiveSession: boolean;
  reposLength: number;
  activeRepoPath: string | null;
  isNodesTab: boolean;
}

export function resolveAppViewMode({
  analyticsView,
  hasActiveSession,
  reposLength,
  activeRepoPath,
  isNodesTab,
}: ResolveAppViewModeInput): AppViewMode {
  if (analyticsView !== null) return 'analytics';
  if (hasActiveSession) return 'session';
  if (!reposLength) {
    return !activeRepoPath && isNodesTab ? 'org' : 'empty';
  }
  if (!activeRepoPath) return 'org';
  return 'dashboard';
}
