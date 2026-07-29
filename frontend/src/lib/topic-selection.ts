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
