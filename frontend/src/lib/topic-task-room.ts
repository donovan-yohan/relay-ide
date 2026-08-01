import { useUiStore } from './stores/ui.js';

export const TOPIC_COMPOSER_FOCUS_EVENT = 'relay:focus-topic-composer';

/**
 * #1287: drop BOTH chat-shell surfaces. `resolveAppViewMode` ranks
 * `hasActiveChannel` and then `topicComposerOpen` above every non-chat
 * destination, so any navigation that names a different surface — cockpit,
 * dashboard, evidence, a restored URL route — has to clear both or it is a
 * silent no-op: the screen never changes, and the latched flag later fires as a
 * surprise navigation the moment the operator closes the channel. That exact
 * pathology shipped twice (slice 1's cockpit hatches, then #1287's new-chat
 * button), each time because a new entry point hand-rolled half the invariant.
 * One named helper so the next entry point inherits it instead of re-deriving
 * it; `test/chat-surface-navigation.test.ts` enumerates the callers.
 *
 * Session/repo pointers are deliberately NOT touched here — each caller owns
 * whether its destination keeps them (the cockpit clears them, a URL route
 * replaces them, the composer inherits them).
 */
export function leaveChatSurface(): void {
  const ui = useUiStore.getState();
  ui.setActiveChannelId(null);
  ui.setTopicComposerOpen(false);
}

/**
 * #1058: shared "start a topic" entry point. The composer IS the landing view
 * (TopicComposer inside ChatHome). Starting a topic sets the transient
 * `topicComposerOpen` flag — `resolveAppViewMode` routes to the chat landing
 * WITHOUT clearing the active session/repo selection, so the composer inherits
 * that context (node/repo/worktree/cwd) as live routing defaults and nothing
 * about the operator's selection (including the persisted active-workspace
 * key) is lost by merely opening and abandoning the composer. The flag clears
 * when a session becomes active (launch or sidebar selection) or on Escape.
 * A focus event covers the already-on-the-landing case, where no remount
 * happens and textarea autoFocus never re-fires. On mobile the sidebar drawer
 * is closed so the main pane is actually visible.
 *
 * #1287: an open channel outranks the composer at BOTH decision points —
 * `resolveAppViewMode` returns 'chat' on `hasActiveChannel` before it reads
 * `topicComposerOpen`, and inside 'chat' mode `ChatHome` renders `ChannelView`
 * whenever `activeChannelId` is set and only mounts `TopicComposer` in the else
 * branch. Latching the flag without clearing the channel is therefore a silent
 * no-op (the focus event fires at a composer that is not mounted, and no
 * request ever leaves the browser) that later fires as a surprise composer when
 * the operator closes the channel. Same pathology the cockpit escape hatches
 * fixed in slice 1; this is the mirror-image entry point.
 *
 * `activeSessionId` is deliberately left alone: the composer inheriting the
 * session/repo context is designed behaviour, and `topicComposerOpen` already
 * outranks `hasActiveSession` in the resolver.
 */
export function openTopicTaskRoom(): void {
  const ui = useUiStore.getState();
  ui.setActiveChannelId(null);
  ui.setTopicComposerOpen(true);
  ui.setAnalyticsView(null);
  ui.setForceOrgCockpit(false);
  ui.closeSidebar();
  window.setTimeout(
    () => window.dispatchEvent(new Event(TOPIC_COMPOSER_FOCUS_EVENT)),
    0
  );
}
