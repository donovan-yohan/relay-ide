import { useUiStore } from './stores/ui.js';

/**
 * #1058: shared "start a topic" entry point used by both the work-cockpit
 * empty state and the chat-first landing home. The topic create panel lives
 * in TopicSidebarShell, which is unmounted while the sidebar is collapsed —
 * so un-collapse + open first, then dispatch on the next tick once the shell
 * has mounted and registered its listener (otherwise the event fires into
 * the void and the CTA is a no-op in collapsed mode).
 */
export function openTopicTaskRoom(): void {
  const ui = useUiStore.getState();
  if (ui.sidebarCollapsed) ui.toggleSidebarCollapsed();
  ui.openSidebar();
  window.setTimeout(
    () => window.dispatchEvent(new Event('relay:open-topic-task-room')),
    0
  );
}
