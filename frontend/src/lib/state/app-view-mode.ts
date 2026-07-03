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
   * #1058/#1123: explicit escape hatch back to the legacy WorkContext/session
   * cockpit, set via the "open work cockpit" command-palette action. Primary
   * start/resume/message flows stay in the chat shell even after a session is
   * selected so raw terminal/workspace chrome is never the default landing.
   */
  forceOrgCockpit?: boolean;
  /**
   * #1058: the main-pane topic composer was opened explicitly (sidebar
   * "+ task", palette, cockpit CTA). Routes to the chat landing WITHOUT
   * requiring the session/repo selection to be cleared, so the composer can
   * inherit that context as routing defaults.
   */
  topicComposerOpen?: boolean;
}

export function resolveAppViewMode({
  analyticsView,
  hasActiveSession,
  activeRepoPath,
  forceOrgCockpit = false,
  topicComposerOpen = false,
}: ResolveAppViewModeInput): AppViewMode {
  if (analyticsView !== null) return 'analytics';
  if (topicComposerOpen) return 'chat';
  if (hasActiveSession) return forceOrgCockpit ? 'session' : 'chat';

  // The no-session / no-explicit-project landing path defaults to the
  // chat/topic spine (#1058). The legacy WorkContext cockpit remains
  // reachable via forceOrgCockpit. RepoDashboard remains reserved for an
  // explicit repo/project selection.
  if (!activeRepoPath) return forceOrgCockpit ? 'org' : 'chat';
  return 'dashboard';
}
