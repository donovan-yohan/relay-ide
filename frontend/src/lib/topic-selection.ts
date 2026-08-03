import type { ChannelMessageId } from '../../../shared/channel-chat-protocol.js';
import {
  resolveTopicActiveContext,
  type WorkspaceTopic,
} from '../../../shared/workspace-topics.js';
import { useUiStore } from './stores/ui.js';

/**
 * Establish the active workspace/repo context a topic selection implies so
 * terminals, agents, and the workspace pane operate in the topic's repo. A
 * pure-thread topic resolves no repo path and leaves the current one untouched.
 */
export function applyTopicActiveContext(
  topic: WorkspaceTopic | undefined
): void {
  if (!topic) return;
  const context = resolveTopicActiveContext(topic);
  const ui = useUiStore.getState();
  ui.setActiveWorkspaceId(context.workspaceId);
  if (context.repoPath) ui.setActiveRepoPath(context.repoPath);
}

/**
 * Route an explicit user selection of a topic: apply its workspace/repo context
 * and, for a persisted topic, open its channel in the main pane and close the
 * composer (#1166). Only persisted topics are backed by a channel — derived
 * topics have none, so they move workspace/repo context only.
 *
 * Shared by the sidebar row and the command palette (#1287) so both entry
 * points land the user on the same surface and the gate cannot drift.
 */
export function openTopicSelection(topic: WorkspaceTopic | undefined): void {
  applyTopicActiveContext(topic);
  if (topic?.source !== 'persisted') return;
  const ui = useUiStore.getState();
  ui.setActiveChannelId(topic.id);
  ui.setTopicComposerOpen(false);
}

/**
 * Command-palette selection (#1287): the same routing plus dismissing the mobile
 * sidebar drawer the palette may have been opened over. Named rather than an
 * inline arrow in App.tsx so the wired behaviour is what the regression test
 * exercises — App passes this by reference.
 */
export function openTopicSelectionFromPalette(
  topic: WorkspaceTopic | undefined
): void {
  openTopicSelection(topic);
  useUiStore.getState().closeSidebar();
}

/**
 * Open a channel AND ask it to land on ONE message (#1308 slice 2): the
 * disposition of every message-search hit, wherever it was clicked — the sidebar
 * `messages` section (item 2) and the command palette's `messages` category
 * (item 3). Shared rather than written twice because the ORDER below is a
 * contract, not a style choice, and a second copy is free to get it backwards.
 *
 * Nothing here resolves, scrolls, or paginates. `ChannelView` already owns the
 * bounded backwards walk, the not-in-recent-history toast, the jump emphasis,
 * and the reply → thread-panel mapping shipped in slice 1; a second scroll path
 * here could only disagree with the `#msg-…` deep link.
 *
 * The channel is opened by its own id rather than by `topic.id`: a hit's channel
 * is routinely absent from whatever topic corpus the caller has (chat-title
 * search returns the chats it matched, and a message can match in a channel
 * whose title did not), and it is nonetheless a real channel — the message came
 * out of its log. A topic, when the caller does resolve one, only contributes
 * the workspace/repo context a rail row would have applied.
 *
 * The drawer closes because a jump always changes the main pane, and on mobile
 * both entry points float over it. On desktop `sidebarOpen` is already false, so
 * that write is a no-op there.
 */
export function openChannelMessageSelection(input: {
  channelId: string;
  messageId: ChannelMessageId;
  topic?: WorkspaceTopic | undefined;
}): void {
  applyTopicActiveContext(input.topic);
  const ui = useUiStore.getState();
  ui.setActiveChannelId(input.channelId);
  ui.setTopicComposerOpen(false);
  // AFTER the open, never before: `setActiveChannelId` clears an un-consumed
  // anchor, so the other order erases the intent it has just recorded (the same
  // contract the `#msg-` deep link in `useUrlNav` and `openThread` follow).
  ui.requestChannelMessage(input.channelId, input.messageId);
  ui.closeSidebar();
}
