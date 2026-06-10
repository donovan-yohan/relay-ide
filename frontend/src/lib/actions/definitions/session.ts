import type { ActionContext, ActionMeta } from '../types.js';
import {
  sessionCreateActionAvailability,
  sessionCreateActionDescriptor,
} from '../session-create.js';
import {
  sessionKillActionAvailability,
  sessionKillActionDescriptor,
  sessionRenameActionAvailability,
  sessionRenameActionDescriptor,
} from '../session-lifecycle.js';
import {
  ticketStartWorkActionAvailability,
  ticketStartWorkActionDescriptor,
} from '../start-work-lifecycle.js';

const launchDescriptor = sessionCreateActionDescriptor();
const launchRequiresContext = (ctx: ActionContext) =>
  sessionCreateActionAvailability({
    ...(ctx.workspacePath ? { workspacePath: ctx.workspacePath } : {}),
    ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
  }).reason;

// #869: session.kill is the stable destructive lifecycle verb. session.close-active
// bridges to the SAME descriptor — close is kill plus tab-selection UI, with no
// separate sessions.close command in the manifest.
const killDescriptor = sessionKillActionDescriptor();
const killRequiresSession = (ctx: ActionContext) =>
  sessionKillActionAvailability({ sessionMissing: !ctx.sessionId }).reason;

const renameDescriptor = sessionRenameActionDescriptor();
const renameRequiresSession = (ctx: ActionContext) =>
  sessionRenameActionAvailability({ sessionMissing: !ctx.sessionId }).reason;

// #871/#876: session.start-on-ticket is the ticket start-work entry point
// (StartWorkModal). It carries the composite tickets.startWork descriptor so
// agents/operators discover the stable contract; availability gates on an
// active workspace, mirroring the existing `when` predicate (and #870).
const ticketStartWorkDescriptor = ticketStartWorkActionDescriptor();
const ticketStartWorkRequiresWorkspace = (ctx: ActionContext) =>
  ticketStartWorkActionAvailability({ workspaceMissing: !ctx.workspacePath })
    .reason;

export const sessionNewAgent: ActionMeta = {
  id: 'session.new-agent',
  label: 'new agent session',
  description: 'start claude or codex',
  category: 'session',
  icon: '+',
  shortcut: { key: 'mod+t', global: true },
  when: (ctx) => !!ctx.workspacePath,
  disabledReason: launchRequiresContext,
  descriptor: launchDescriptor,
};

export const sessionNewTerminal: ActionMeta = {
  id: 'session.new-terminal',
  label: 'new terminal session',
  description: 'open a bare shell',
  category: 'session',
  icon: '+',
  when: (ctx) => !!ctx.workspacePath,
  disabledReason: launchRequiresContext,
  descriptor: launchDescriptor,
};

export const sessionCloseActive: ActionMeta = {
  id: 'session.close-active',
  label: 'close active session',
  description: 'close the current tab',
  category: 'session',
  icon: '×',
  shortcut: { key: 'mod+w' },
  when: (ctx) => !!ctx.sessionId,
  disabledReason: killRequiresSession,
  descriptor: killDescriptor,
};

export const sessionKill: ActionMeta = {
  id: 'session.kill',
  label: 'kill session',
  description: 'terminate the active session process',
  category: 'session',
  icon: '■',
  when: (ctx) => !!ctx.sessionId,
  disabledReason: killRequiresSession,
  descriptor: killDescriptor,
};

export const sessionStartOnRepo: ActionMeta = {
  id: 'session.start-on-repo',
  label: 'start session on repo',
  description: 'open agent on current workspace',
  category: 'session',
  icon: '▸',
  when: (ctx) => !!ctx.workspacePath,
  disabledReason: launchRequiresContext,
  descriptor: launchDescriptor,
};

export const sessionStartOnTicket: ActionMeta = {
  id: 'session.start-on-ticket',
  label: 'start work on ticket',
  description: 'pick a ticket and start coding',
  category: 'session',
  icon: '◆',
  when: (ctx) => !!ctx.workspacePath,
  disabledReason: ticketStartWorkRequiresWorkspace,
  descriptor: ticketStartWorkDescriptor,
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
  disabledReason: renameRequiresSession,
  descriptor: renameDescriptor,
};

// #630: command-palette entry that opens the EnvironmentPicker (#627) and
// launches against the chosen Node/RepoInstance/Bench via the shared launch
// hook. Distinct from `sessionNewAgent` / `sessionNewTerminal`: those launch
// against the active workspace's implicit node, while this one explicitly
// makes the environment a first-class choice the user makes BEFORE launch.
// Aliases mirror Wave's "connection picker" vocabulary so users searching for
// "environment", "node", "where" all find it.
export const sessionStartWorkInEnv: ActionMeta = {
  id: 'session.start-work-in-env',
  label: 'start work in environment…',
  description: 'pick a node / repo / worktree, then launch a terminal',
  aliases: [
    'start work',
    'environment',
    'env',
    'node',
    'where',
    'pick env',
    'terminal',
    'start-work',
    'launch',
    'shell',
  ],
  category: 'session',
  icon: '▸',
  descriptor: launchDescriptor,
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
  sessionStartWorkInEnv,
];
