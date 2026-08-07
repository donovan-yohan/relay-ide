import type { ActionMeta } from '../types.js';

export const navPreviousTab: ActionMeta = {
  id: 'navigation.previous-tab',
  label: 'previous tab',
  description: 'switch to the previous session tab',
  category: 'navigation',
  icon: '←',
  shortcut: { key: 'mod+shift+[' },
  when: (ctx) => !!ctx.sessionId,
};

export const navNextTab: ActionMeta = {
  id: 'navigation.next-tab',
  label: 'next tab',
  description: 'switch to the next session tab',
  category: 'navigation',
  icon: '→',
  shortcut: { key: 'mod+shift+]' },
  when: (ctx) => !!ctx.sessionId,
};

export const navSwitchToTab: ActionMeta = {
  id: 'navigation.switch-to-tab',
  label: 'switch to tab by number',
  description: 'jump to a specific session tab (1-9)',
  aliases: ['tab 1', 'tab 2', 'tab 3'],
  category: 'navigation',
  icon: '#',
};

export const navOpenFile: ActionMeta = {
  id: 'navigation.open-file',
  label: 'open file...',
  description: 'search and open a file in the current repo',
  category: 'navigation',
  icon: '◇',
  shortcut: { key: 'mod+o' },
  when: (ctx) => !!ctx.sessionId,
};

export const navNextAttentionWork: ActionMeta = {
  id: 'navigation.next-attention-work',
  label: 'jump to next attention-needed work',
  description:
    'activate the highest-priority actionable WorkContext session from Active Work',
  aliases: [
    'next active work',
    'active work attention',
    'workcontext attention',
    'jump to workcontext',
  ],
  category: 'navigation',
  icon: '◆',
};

// #1058: the chat/topic spine is the default no-session/no-repo landing;
// this keeps the legacy WorkContext cockpit (PRs, tickets, nodes, audit)
// reachable rather than deleting it outright.
export const navOpenWorkCockpit: ActionMeta = {
  id: 'navigation.open-work-cockpit',
  label: 'open work cockpit',
  description:
    'switch to the WorkContext cockpit — active work, prs, tickets, nodes, and audit across all workspaces',
  aliases: ['org dashboard', 'active work cockpit', 'work cockpit'],
  category: 'navigation',
  icon: '▦',
};

// #1058: advanced-mode substrate surfaces (nodes dashboard, analytics, active
// work detail) are hidden from primary chrome by default (Settings >
// advanced). These are the one-off palette escape hatches — each opens its
// surface without flipping the persistent `advancedMode` flag.
export const navOpenNodesDashboard: ActionMeta = {
  id: 'navigation.open-nodes-dashboard',
  label: 'open nodes dashboard',
  description:
    'jump to the nodes tab of the work cockpit without enabling advanced mode',
  aliases: ['nodes', 'node dashboard', 'hub nodes'],
  category: 'navigation',
  icon: '▦',
};

export const navOpenAnalytics: ActionMeta = {
  id: 'navigation.open-analytics',
  label: 'open analytics',
  description: 'jump to the analytics dashboard without enabling advanced mode',
  aliases: ['analytics', 'usage stats'],
  category: 'navigation',
  icon: '▦',
};

export const navOpenActiveWork: ActionMeta = {
  id: 'navigation.open-active-work',
  label: 'open active work detail',
  description:
    'jump to the active work tab of the work cockpit without enabling advanced mode',
  aliases: ['active work', 'work cockpit active work'],
  category: 'navigation',
  icon: '▦',
};

export const navigationActions: ActionMeta[] = [
  navPreviousTab,
  navNextTab,
  navSwitchToTab,
  navOpenFile,
  navNextAttentionWork,
  navOpenWorkCockpit,
  navOpenNodesDashboard,
  navOpenAnalytics,
  navOpenActiveWork,
];
