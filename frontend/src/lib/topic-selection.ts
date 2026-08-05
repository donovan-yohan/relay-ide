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
  const ui = useUiStore.getState();
  const context = topic ? resolveTopicActiveContext(topic) : null;
  // #1303: this navigation is now the newest routing statement, so it REPLACES
  // the lane stamp rather than merely surviving it — a lane the operator picked
  // earlier must not outrank the row they just opened, and a row that names a
  // repo must not be undercut by session context on the next create (the repo
  // pointer alone sits below `activeSession` in the create hook's chain).
  //
  // Written BEFORE the `!topic` bail on purpose: `openChannelMessageSelection`
  // routinely opens a channel whose topic the caller could not resolve, and
  // `select(id, fallbackTopic)` can too. The main pane still changes, so a
  // stamp minted for some other lane is just as stale there — clearing it is
  // the honest answer, and the ordinary inheritance chain takes over.
  ui.setLaneRepoRouting(
    context?.repoPath
      ? { workspaceId: context.workspaceId, repoPath: context.repoPath }
      : null
  );
  if (!context) return;
  ui.setActiveWorkspaceId(context.workspaceId);
  if (context.repoPath) ui.setActiveRepoPath(context.repoPath);
}

/**
 * #1287: a workspace lane carries the repo anchor `ensureProjectWorkspace`
 * stamps on every add-project workspace, and a create needs BOTH halves of that
 * routing decision — `useTopicRoomCreate` files the channel by
 * `activeWorkspaceId` and derives `routingDefaults.repoPath`/`cwd` from the repo
 * anchor. Moving only the lane pointer files the chat in the newly chosen
 * project while still pointing it at the ABANDONED project's repo: a split
 * across two projects, strictly worse than the consistent-but-stale state it
 * replaced.
 *
 * Applied on the CREATE paths only, never on a bare lane click:
 * `resolveAppViewMode` returns 'dashboard' the moment `activeRepoPath` is set
 * and nothing above it is, so writing the repo pointer outside a create would
 * silently turn selecting a lane into a navigation off the chat landing onto
 * RepoDashboard. On a create the composer opens immediately after and outranks
 * it.
 *
 * #1303: the pointer alone cannot carry the choice — it sits BELOW the active
 * session in the create hook's inheritance chain, so a terminal still open in
 * the abandoned project outranked it and the create landed back there anyway.
 * The lane is therefore recorded as itself, and the hook ranks that above
 * session context. An anchorless lane (or none) records nothing and leaves the
 * pointer alone: that is the documented inheritance fallback
 * (`activeSession ?? activeRepoPath ?? repos[0]`). Only the path anchor moves —
 * a lane has no node of its own, so session node inheritance is untouched.
 */
export function applyLaneRepoRouting(
  workspaceId: string | null,
  laneRepoPathById: (workspaceId: string) => string | null | undefined
): void {
  const ui = useUiStore.getState();
  const laneRepoPath = workspaceId ? laneRepoPathById(workspaceId) : undefined;
  if (!workspaceId || !laneRepoPath) {
    // Drop any stamp an earlier lane left, or the create would route at THAT
    // lane's repo while being filed in this one.
    ui.setLaneRepoRouting(null);
    return;
  }
  ui.setActiveRepoPath(laneRepoPath);
  ui.setLaneRepoRouting({ workspaceId, repoPath: laneRepoPath });
}

/**
 * Resolve where a NEW chat runs, at the moment its composer is opened — the one
 * body behind every new-chat entry point in the rail (#1287: the header button
 * and each lane's own start-chat button share it so they cannot drift).
 *
 * #1287: the still-highlighted row may belong to a lane the operator has since
 * navigated away from (select a fresh, empty lane while a channel from the old
 * workspace stays selected). `applyTopicActiveContext` stamps
 * `activeWorkspaceId` from the topic, so re-applying it then would file the new
 * chat back in the OLD lane. An explicit lane selection is the more recent
 * intent and wins.
 *
 * #1303: when the row IS in the active lane, applying its context is necessary
 * but NOT sufficient, and that is the shape the bug actually ships in. Opening a
 * channel never clears `activeSessionId` (App's effect fires on CHANGE only), so
 * a terminal from a different project stays the active session while the
 * operator works in this lane — and the row they have highlighted is typically a
 * DM, whose `routingDefaults` carries `providerId` alone
 * (`dmChannelCreateInput`). It names no repo, leaves no stamp, and the create
 * falls through to that stale session. So: whenever nothing has answered the
 * routing question FOR THE LANE THIS CHAT IS BEING FILED IN, the lane's own
 * anchor answers it. A row that names a repo of its own is more specific than
 * its lane and keeps its stamp.
 *
 * The answer is derived from THIS interaction alone — whether the row applied
 * above named a repo — never from whatever stamp happens to be lying in the
 * store. Reading the existing stamp would make the decision depend on an
 * earlier, possibly abandoned create in the same lane, which is exactly the
 * state this function exists to overwrite.
 *
 * The live store is re-read rather than trusting the caller's props: lane
 * selection writes straight to the store, so a prop can lag the operator's
 * newest choice within one interaction, and `applyTopicActiveContext` may have
 * moved the lane a line earlier.
 */
export function applyCreateRoutingContext(input: {
  selectedTopic: WorkspaceTopic | undefined;
  laneRepoPathById: (workspaceId: string) => string | null | undefined;
}): void {
  const activeLaneId = useUiStore.getState().activeWorkspaceId;
  const rowIsInActiveLane =
    activeLaneId === null || input.selectedTopic?.workspaceId === activeLaneId;
  const rowRepoPath =
    rowIsInActiveLane && input.selectedTopic
      ? resolveTopicActiveContext(input.selectedTopic).repoPath
      : null;
  if (rowIsInActiveLane) applyTopicActiveContext(input.selectedTopic);
  if (!rowRepoPath) {
    applyLaneRepoRouting(
      useUiStore.getState().activeWorkspaceId,
      input.laneRepoPathById
    );
  }
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
 * Disposition of a clicked OS notification (#1308 slice 5 item 2).
 *
 * The channel is opened by ID ALONE — deliberately not routed through a topic
 * lookup. A notification can be clicked minutes later, from a tab whose topic
 * corpus has since been refetched, filtered, or never loaded at all (the click
 * may be the event that wakes a discarded tab), and a lookup miss must not turn
 * into "clicked the notification, nothing happened". `ChannelView` already owns
 * the unknown/deleted case, exactly as it does for a `/channel/<id>` deep link.
 *
 * No message anchor: the notification body deliberately carries no message
 * text, and the event that raised it may have been coalesced with others, so
 * the honest destination is the channel at its live bottom.
 *
 * The drawer closes for the same reason the other openers close it — the main
 * pane just changed, and on mobile the drawer floats over it.
 */
export function openChannelFromNotification(channelId: string): void {
  const ui = useUiStore.getState();
  ui.setActiveChannelId(channelId);
  ui.setTopicComposerOpen(false);
  ui.closeSidebar();
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
