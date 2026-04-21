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

export const navigationActions: ActionMeta[] = [
  navPreviousTab,
  navNextTab,
  navSwitchToTab,
  navOpenFile,
];
