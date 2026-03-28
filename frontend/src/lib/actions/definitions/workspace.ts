import type { ActionMeta } from '../types.js';

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
  when: (ctx) => !!ctx.workspaceId,
};

export const workspaceActions: ActionMeta[] = [
  workspaceAdd,
  workspaceNewWorktree,
];
