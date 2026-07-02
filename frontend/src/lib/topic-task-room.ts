import { useSessionsStore } from './stores/sessions.js';
import { useUiStore } from './stores/ui.js';

/**
 * #1058: shared "start a topic" entry point. The composer IS the landing view
 * (TopicComposer inside ChatHome), so starting a topic means navigating to the
 * landing: clear the active session/repo/analytics selection and drop any
 * forced cockpit so resolveAppViewMode returns 'chat'. The composer autofocuses
 * its message box on mount. On mobile the sidebar drawer is closed so the main
 * pane is actually visible.
 */
export function openTopicTaskRoom(): void {
  useSessionsStore.getState().setActiveSessionId(null);
  const ui = useUiStore.getState();
  ui.setActiveRepoPath(null);
  ui.setAnalyticsView(null);
  ui.setForceOrgCockpit(false);
  ui.closeSidebar();
}
