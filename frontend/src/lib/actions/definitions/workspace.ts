import type { ActionContext, ActionMeta } from '../types.js';
import {
  worktreeCreateActionAvailability,
  worktreeCreateActionDescriptor,
  workspaceLaunchActionAvailability,
  workspaceLaunchActionDescriptor,
} from '../workspace-lifecycle.js';

// #870: workspace.new-worktree bridges its createWorktree step to the stable
// worktrees.create descriptor (the createAgentSession tail stays the #867
// sessions.create path). Availability gates on an active workspace, mirroring
// the existing `when` predicate.
const newWorktreeDescriptor = worktreeCreateActionDescriptor();
const newWorktreeRequiresWorkspace = (ctx: ActionContext) =>
  worktreeCreateActionAvailability({ workspaceMissing: !ctx.workspacePath })
    .reason;

// #870: workspaces.launch is the stable verb behind launching a configured
// workspace group's session(s). The Command Center surface carries the
// descriptor so agents/operators discover it as a stable contract.
const workspaceLaunchDescriptor = workspaceLaunchActionDescriptor();
const workspaceLaunchRequiresWorkspace = (ctx: ActionContext) =>
  workspaceLaunchActionAvailability({ workspaceMissing: !ctx.workspacePath })
    .reason;

// #870 UI-only exception: workspace.add stays a dialog opener. AddWorkspaceDialog
// does multi-path bulk add, while the stable repos.add verb is single-path; the
// bulk-add parity is deferred (named in docs/refactor/860-action-contract-follow-up-map.md).
// Do NOT attach the repos.add descriptor here until that parity work lands.
export const workspaceAdd: ActionMeta = {
  id: 'workspace.add',
  label: 'add workspace',
  description: 'connect a repo',
  category: 'workspace',
  icon: '+',
};

export const workspaceNewWorktree: ActionMeta = {
  id: 'workspace.new-worktree',
  label: 'new worktree',
  description: 'create a branch and start coding',
  category: 'workspace',
  icon: '+',
  when: (ctx) => !!ctx.workspacePath,
  disabledReason: newWorktreeRequiresWorkspace,
  descriptor: newWorktreeDescriptor,
};

export const workspaceLaunch: ActionMeta = {
  id: 'workspace.launch',
  label: 'launch workspace',
  description: 'start sessions for a configured workspace',
  category: 'workspace',
  icon: '▸',
  when: (ctx) => !!ctx.workspacePath,
  disabledReason: workspaceLaunchRequiresWorkspace,
  descriptor: workspaceLaunchDescriptor,
};

export const workspaceActions: ActionMeta[] = [
  workspaceAdd,
  workspaceNewWorktree,
  workspaceLaunch,
];
