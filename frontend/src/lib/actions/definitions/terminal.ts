import type { ActionMeta } from '../types.js';

export const terminalScrollTop: ActionMeta = {
  id: 'terminal.scroll-top',
  label: 'scroll to top',
  description: 'scroll terminal output to the top',
  category: 'terminal',
  icon: '↑',
  when: (ctx) => !!ctx.sessionId,
};

export const terminalScrollBottom: ActionMeta = {
  id: 'terminal.scroll-bottom',
  label: 'scroll to bottom',
  description: 'scroll terminal output to the bottom',
  category: 'terminal',
  icon: '↓',
  when: (ctx) => !!ctx.sessionId,
};

export const terminalActions: ActionMeta[] = [
  terminalScrollTop,
  terminalScrollBottom,
];
