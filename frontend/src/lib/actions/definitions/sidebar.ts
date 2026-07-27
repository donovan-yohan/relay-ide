import type { ActionContext, ActionMeta } from '../types.js';
import {
  sessionRenameActionAvailability,
  sessionRenameActionDescriptor,
} from '../session-lifecycle.js';
import {
  worktreeDeleteActionAvailability,
  worktreeDeleteActionDescriptor,
} from '../workspace-lifecycle.js';

// #869: sidebar.rename-session collapses into the sessions.rename descriptor —
// same stable command and executor as session.rename, just a different entry point.
const renameDescriptor = sessionRenameActionDescriptor();
const renameRequiresSession = (ctx: ActionContext) =>
  sessionRenameActionAvailability({ sessionMissing: !ctx.sessionId }).reason;

// #870: sidebar.delete-worktree collapses onto the destructive worktrees.delete
// descriptor — same stable command and executor as handleDeleteWorktree, just a
// different entry point. DeleteWorktreeDialog stays the browser confirmation
// surface layered over the destructive contract.
const deleteWorktreeDescriptor = worktreeDeleteActionDescriptor();
const deleteWorktreeRequiresWorkspace = (ctx: ActionContext) =>
  worktreeDeleteActionAvailability({ workspaceMissing: !ctx.workspacePath })
    .reason;

export const sidebarCollapse: ActionMeta = {
  id: 'sidebar.collapse',
  label: 'toggle sidebar',
  description: 'collapse or expand the sidebar',
  category: 'sidebar',
  icon: '«',
};

export const sidebarNavigateDashboard: ActionMeta = {
  id: 'sidebar.navigate-dashboard',
  label: 'go to workspace dashboard',
  description: 'open the workspace overview',
  category: 'sidebar',
  icon: '■',
  when: (ctx) => !!ctx.workspacePath,
};

export const sidebarWorkspaceSettings: ActionMeta = {
  id: 'sidebar.workspace-settings',
  label: 'workspace settings',
  description: 'configure workspace preferences',
  category: 'sidebar',
  icon: '>',
  when: (ctx) => !!ctx.workspacePath,
};

export const sidebarRenameSession: ActionMeta = {
  id: 'sidebar.rename-session',
  label: 'rename session',
  description: 'change the display name of a session',
  category: 'sidebar',
  icon: '~',
  when: (ctx) => !!ctx.sessionId,
  disabledReason: renameRequiresSession,
  descriptor: renameDescriptor,
};

export const sidebarDeleteWorktree: ActionMeta = {
  id: 'sidebar.delete-worktree',
  label: 'delete worktree',
  description: 'remove a branch worktree',
  category: 'sidebar',
  icon: '×',
  when: (ctx) => !!ctx.workspacePath,
  disabledReason: deleteWorktreeRequiresWorkspace,
  descriptor: deleteWorktreeDescriptor,
};

export const sidebarResumeSession: ActionMeta = {
  id: 'sidebar.resume-session',
  label: 'resume session on worktree',
  description: 'continue a previous session',
  category: 'sidebar',
  icon: '▸',
  when: (ctx) => !!ctx.workspacePath,
};

export const sidebarActions: ActionMeta[] = [
  sidebarCollapse,
  sidebarNavigateDashboard,
  sidebarWorkspaceSettings,
  sidebarRenameSession,
  sidebarDeleteWorktree,
  sidebarResumeSession,
];
