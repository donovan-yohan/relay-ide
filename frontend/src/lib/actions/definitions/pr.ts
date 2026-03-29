import type { ActionMeta } from '../types.js';

export const prCreate: ActionMeta = {
  id: 'pr.create',
  label: 'create pull request',
  description: 'open a PR for this branch',
  aliases: ['pr', 'pull request', 'open pr'],
  category: 'pr',
  icon: '⇗',
  // TODO Phase 4: add prState gating once actionContext populates it
  when: (ctx) => !!ctx.workspacePath,
};

export const prPushBranch: ActionMeta = {
  id: 'pr.push-branch',
  label: 'push branch',
  description: 'push to remote',
  aliases: ['push', 'git push'],
  category: 'pr',
  icon: '↑',
  when: (ctx) => !!ctx.workspacePath,
};

export const prSwitchBranch: ActionMeta = {
  id: 'pr.switch-branch',
  label: 'switch branch',
  description: 'check out a different branch',
  aliases: ['checkout', 'branch'],
  category: 'pr',
  icon: '⇄',
  when: (ctx) => !!ctx.workspacePath,
};

export const prActions: ActionMeta[] = [
  prCreate,
  prPushBranch,
  prSwitchBranch,
];
