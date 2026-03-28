import type { ActionMeta } from '../types.js';

export const sessionNewAgent: ActionMeta = {
  id: 'session.new-agent',
  label: 'new agent session',
  description: 'start claude or codex',
  category: 'session',
  icon: '+',
  shortcut: { key: 'mod+t', global: true },
  when: (ctx) => !!ctx.workspaceId,
};

export const sessionNewTerminal: ActionMeta = {
  id: 'session.new-terminal',
  label: 'new terminal session',
  description: 'open a bare shell',
  category: 'session',
  icon: '+',
  when: (ctx) => !!ctx.workspaceId,
};

export const sessionCloseActive: ActionMeta = {
  id: 'session.close-active',
  label: 'close active session',
  description: 'close the current tab',
  category: 'session',
  icon: '×',
  shortcut: { key: 'mod+w' },
  when: (ctx) => !!ctx.sessionId,
};

export const sessionKill: ActionMeta = {
  id: 'session.kill',
  label: 'kill session',
  description: 'terminate the active session process',
  category: 'session',
  icon: '■',
  when: (ctx) => !!ctx.sessionId,
};

export const sessionStartOnRepo: ActionMeta = {
  id: 'session.start-on-repo',
  label: 'start session on repo',
  description: 'open agent on current workspace',
  category: 'session',
  icon: '▸',
  when: (ctx) => !!ctx.workspaceId,
};

export const sessionStartOnTicket: ActionMeta = {
  id: 'session.start-on-ticket',
  label: 'start work on ticket',
  description: 'pick a ticket and start coding',
  category: 'session',
  icon: '◆',
  when: (ctx) => !!ctx.workspaceId,
};

export const sessionActions: ActionMeta[] = [
  sessionNewAgent,
  sessionNewTerminal,
  sessionCloseActive,
  sessionKill,
  sessionStartOnRepo,
  sessionStartOnTicket,
];
