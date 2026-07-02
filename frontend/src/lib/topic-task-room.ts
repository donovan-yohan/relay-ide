import { useSessionsStore } from './stores/sessions.js';
import { useUiStore } from './stores/ui.js';
import { resolveSessionByKey } from './session-keys.js';

/** Routing context captured from the surface the user started the topic from. */
export interface TopicComposerSeed {
  nodeId?: string | undefined;
  repoPath?: string | undefined;
  worktreePath?: string | undefined;
  cwd?: string | undefined;
}

let composerSeed: TopicComposerSeed | null = null;

/** One-shot read of the seed captured by the last openTopicTaskRoom() call. */
export function takeTopicComposerSeed(): TopicComposerSeed | null {
  const seed = composerSeed;
  composerSeed = null;
  return seed;
}

export const TOPIC_COMPOSER_FOCUS_EVENT = 'relay:focus-topic-composer';

/**
 * #1058: shared "start a topic" entry point. The composer IS the landing view
 * (TopicComposer inside ChatHome), so starting a topic means navigating to the
 * landing: clear the active session/repo/analytics selection and drop any
 * forced cockpit so resolveAppViewMode returns 'chat'. The active session's
 * routing context (node/repo/worktree/cwd) is captured as a one-shot seed
 * BEFORE clearing so the composer keeps launching into the workspace the user
 * came from. A focus event covers the already-on-the-landing case, where no
 * remount happens and textarea autoFocus never re-fires. On mobile the sidebar
 * drawer is closed so the main pane is actually visible.
 */
export function openTopicTaskRoom(): void {
  const sessions = useSessionsStore.getState();
  const ui = useUiStore.getState();
  const active = resolveSessionByKey(
    sessions.sessions,
    sessions.activeSessionId
  );
  composerSeed = {
    nodeId: active?.nodeId ?? undefined,
    repoPath: active?.repoPath ?? ui.activeRepoPath ?? undefined,
    worktreePath: active?.worktreePath ?? undefined,
    cwd: active?.cwd ?? undefined,
  };
  sessions.setActiveSessionId(null);
  ui.setActiveRepoPath(null);
  ui.setAnalyticsView(null);
  ui.setForceOrgCockpit(false);
  ui.closeSidebar();
  window.setTimeout(
    () => window.dispatchEvent(new Event(TOPIC_COMPOSER_FOCUS_EVENT)),
    0
  );
}
