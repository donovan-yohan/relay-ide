import type { ActionMeta } from '../types.js';

export const sessionNewAgent: ActionMeta = {
  id: 'session.new-agent',
  label: 'new agent session',
  description: 'start claude or codex',
  category: 'session',
  icon: '+',
  shortcut: { key: 'mod+t', global: true },
  when: (ctx) => !!ctx.workspacePath,
};

export const sessionNewTerminal: ActionMeta = {
  id: 'session.new-terminal',
  label: 'new terminal session',
  description: 'open a bare shell',
  category: 'session',
  icon: '+',
  when: (ctx) => !!ctx.workspacePath,
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
  when: (ctx) => !!ctx.workspacePath,
};

export const sessionStartOnTicket: ActionMeta = {
  id: 'session.start-on-ticket',
  label: 'start work on ticket',
  description: 'pick a ticket and start coding',
  category: 'session',
  icon: '◆',
  when: (ctx) => !!ctx.workspacePath,
};

export const sessionCustomize: ActionMeta = {
  id: 'session.customize',
  label: 'customize session',
  description: 'configure agent and flags for a new session',
  category: 'session',
  icon: '>',
  when: (ctx) => !!ctx.workspacePath,
};

export const sessionSwitchToTab: ActionMeta = {
  id: 'session.switch-to-tab',
  label: 'switch to session tab',
  description: 'jump to a specific open session',
  category: 'session',
  icon: '→',
  when: (ctx) => !!ctx.sessionId,
};

export const sessionRename: ActionMeta = {
  id: 'session.rename',
  label: 'rename active session',
  description: 'change the display name of the current session',
  category: 'session',
  icon: '~',
  when: (ctx) => !!ctx.sessionId,
};

export const sessionActions: ActionMeta[] = [
  sessionNewAgent,
  sessionNewTerminal,
  sessionCloseActive,
  sessionKill,
  sessionStartOnRepo,
  sessionStartOnTicket,
  sessionCustomize,
  sessionSwitchToTab,
  sessionRename,
];
