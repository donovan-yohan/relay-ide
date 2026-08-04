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
  description: 'open a branch in agent chat',
  aliases: ['checkout', 'branch'],
  category: 'pr',
  icon: '⇄',
  when: (ctx) => !!ctx.workspacePath,
};

export const prFixConflicts: ActionMeta = {
  id: 'pr.fix-conflicts',
  label: 'fix conflicts',
  description: 'resolve merge conflicts on current branch',
  category: 'pr',
  icon: '!',
  when: (ctx) => !!ctx.workspacePath,
};

export const prArchiveBranch: ActionMeta = {
  id: 'pr.archive-branch',
  label: 'archive branch',
  description: 'archive the current branch',
  category: 'pr',
  icon: '—',
  when: (ctx) => !!ctx.workspacePath,
};

export const prRenameBranch: ActionMeta = {
  id: 'pr.rename-branch',
  label: 'rename branch',
  description: 'change the current branch name',
  category: 'pr',
  icon: '~',
  when: (ctx) => !!ctx.workspacePath,
};

// #871/#876 UI-only exceptions: pr.copy-branch-name (clipboard) and
// pr.open-external (external link) stay descriptor-free — they are browser
// chrome with no stable agent contract, per the #860 parity rule.
export const prCopyBranchName: ActionMeta = {
  id: 'pr.copy-branch-name',
  label: 'copy branch name',
  description: 'copy current branch name to clipboard',
  category: 'pr',
  icon: '⎘',
  when: (ctx) => !!ctx.workspacePath,
};

export const prOpenExternal: ActionMeta = {
  id: 'pr.open-external',
  label: 'open pr externally',
  description: 'view pull request in browser',
  aliases: ['github', 'open pr'],
  category: 'pr',
  icon: '⇗',
  when: (ctx) => !!ctx.workspacePath,
};

export const prRefresh: ActionMeta = {
  id: 'pr.refresh',
  label: 'refresh pr data',
  description: 'reload pr status and ci checks',
  category: 'pr',
  icon: '↻',
  when: (ctx) => !!ctx.workspacePath,
};

export const prChangeTarget: ActionMeta = {
  id: 'pr.change-target',
  label: 'change target branch',
  description: 'set a different base branch for the pr',
  category: 'pr',
  icon: '⇄',
  when: (ctx) => !!ctx.workspacePath,
};

export const prSkipChecks: ActionMeta = {
  id: 'pr.skip-checks',
  label: 'skip checks',
  description: 'bypass ci checks for this pr',
  category: 'pr',
  icon: '»',
  when: (ctx) => !!ctx.workspacePath,
};

export const prActions: ActionMeta[] = [
  prCreate,
  prPushBranch,
  prSwitchBranch,
  prFixConflicts,
  prArchiveBranch,
  prRenameBranch,
  prCopyBranchName,
  prOpenExternal,
  prRefresh,
  prChangeTarget,
  prSkipChecks,
];
