import type { AgentSlashCommandV2 } from './agent-chat-protocol-v2.js';

/** Static, redaction-safe Relay controls. Provider adapters add live commands. */
const CODEX_CONTROLS: AgentSlashCommandV2[] = [
  {
    id: 'relay:clear',
    name: 'new',
    aliases: ['clear', 'reset'],
    description: 'Start a fresh Codex thread',
    source: 'relay',
    sourceLabel: 'Relay',
    dispatch: 'relay-control',
    collisionKey: 'clear',
    destructive: true,
  },
  {
    id: 'relay:resume',
    name: 'continue',
    aliases: ['resume'],
    description: 'Resume a saved Codex thread by id',
    argumentHint: '<threadId>',
    source: 'relay',
    sourceLabel: 'Relay',
    dispatch: 'relay-control',
    collisionKey: 'resume',
  },
  {
    id: 'relay:model',
    name: 'model',
    description: 'Switch model for subsequent Codex responses',
    argumentHint: '<model>',
    source: 'relay',
    sourceLabel: 'Relay',
    dispatch: 'relay-control',
    collisionKey: 'model',
  },
  {
    id: 'relay:effort',
    name: 'effort',
    description: 'Set Codex reasoning effort for subsequent responses',
    argumentHint: '<low|medium|high|xhigh|max|ultra>',
    args: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((value) => ({
      value,
    })),
    source: 'relay',
    sourceLabel: 'Relay',
    dispatch: 'relay-control',
    collisionKey: 'effort',
  },
  {
    id: 'relay:fast',
    name: 'fast',
    description: 'Enable or disable Codex Fast Mode for subsequent responses',
    argumentHint: '<on|off>',
    args: [
      { value: 'on', label: 'on', description: 'Use the fast service tier' },
      {
        value: 'off',
        label: 'off',
        description: 'Use the default service tier',
      },
    ],
    source: 'relay',
    sourceLabel: 'Relay',
    dispatch: 'relay-control',
    collisionKey: 'fast',
  },
  {
    id: 'relay:compact',
    name: 'compact',
    description: 'Compact the current Codex thread context',
    source: 'relay',
    sourceLabel: 'Relay',
    dispatch: 'relay-control',
    collisionKey: 'compact',
  },
  {
    id: 'relay:rollback',
    name: 'rollback',
    description: 'Roll back N turns in the current thread',
    argumentHint: '<n>',
    source: 'relay',
    sourceLabel: 'Relay',
    dispatch: 'relay-control',
    collisionKey: 'rollback',
    destructive: true,
  },
  {
    id: 'relay:archive',
    name: 'archive',
    description: 'Archive the current Codex thread',
    source: 'relay',
    sourceLabel: 'Relay',
    dispatch: 'relay-control',
    collisionKey: 'archive',
    destructive: true,
  },
  {
    id: 'relay:unarchive',
    name: 'unarchive',
    description: 'Unarchive the current Codex thread',
    source: 'relay',
    sourceLabel: 'Relay',
    dispatch: 'relay-control',
    collisionKey: 'unarchive',
  },
  {
    id: 'relay:goal',
    name: 'goal',
    description: 'Get, set, or clear the goal for the current thread',
    argumentHint: 'set <text> | get | clear',
    source: 'relay',
    sourceLabel: 'Relay',
    dispatch: 'relay-control',
    collisionKey: 'goal',
  },
  {
    id: 'relay:review',
    name: 'review',
    description: 'Enter review mode for the current thread',
    source: 'relay',
    sourceLabel: 'Relay',
    dispatch: 'relay-control',
    collisionKey: 'review',
  },
  {
    id: 'relay:fork',
    name: 'fork',
    description: 'Fork the current Codex thread',
    source: 'relay',
    sourceLabel: 'Relay',
    dispatch: 'relay-control',
    collisionKey: 'fork',
  },
];

export function relayControlCatalogForProvider(
  providerId: string
): AgentSlashCommandV2[] {
  return providerId === 'codex'
    ? CODEX_CONTROLS.map((command) => ({ ...command }))
    : [];
}
