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
  /**
   * #1166: a channel (persisted workspace_topic) is open in the main chat pane.
   * Channel view is part of the chat shell and takes priority over the composer
   * and any active session — selecting a channel row always shows the channel,
   * never a stale composer or a leftover session surface.
   */
  hasActiveChannel?: boolean;
  /**
   * Transport mode of the active session. Web-mode chat sessions stay in the
   * chat shell (`ChatView`); live PTY agent/terminal sessions surface their
   * real terminal (viewMode 'session') so the user can watch and drive the
   * TUI it spawned. Undefined/legacy sessions are treated as PTY terminals,
   * matching ChatHome's own `mode === 'web'` gate.
   */
  activeSessionMode?: 'pty' | 'web' | undefined;
}

export function resolveAppViewMode({
  analyticsView,
  hasActiveSession,
  activeRepoPath,
  forceOrgCockpit = false,
  topicComposerOpen = false,
  hasActiveChannel = false,
  activeSessionMode,
}: ResolveAppViewModeInput): AppViewMode {
  if (analyticsView !== null) return 'analytics';
  // Channel takes priority within 'chat' mode — checked before topicComposerOpen
  // and any active session so a channel selection always wins.
  if (hasActiveChannel) return 'chat';
  if (topicComposerOpen) return 'chat';
  if (hasActiveSession) {
    // Explicit legacy cockpit escape hatch still wins.
    if (forceOrgCockpit) return 'session';
    // Web chat sessions render inside the chat shell; a live PTY session
    // (Claude/Codex/Hermes TUI, or a bare terminal) renders its terminal so
    // it is actually reachable and watchable from the web UI.
    return activeSessionMode === 'web' ? 'chat' : 'session';
  }

  // The no-session / no-explicit-project landing path defaults to the
  // chat/topic spine (#1058). The legacy WorkContext cockpit remains
  // reachable via forceOrgCockpit. RepoDashboard remains reserved for an
  // explicit repo/project selection.
  if (!activeRepoPath) return forceOrgCockpit ? 'org' : 'chat';
  return 'dashboard';
}
