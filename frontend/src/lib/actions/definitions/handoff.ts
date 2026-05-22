import type { ActionMeta } from '../types.js';

export const sessionHandoffToHub: ActionMeta = {
  id: 'session.handoff-to-hub',
  label: 'handoff to hub…',
  description: 'open a fixture dry-run plan; never transfers immediately',
  aliases: ['handoff', 'move to hub', 'laptop closing', 'continue on hub'],
  category: 'session',
  icon: '>',
  when: (ctx) => !!ctx.sessionId,
  disabledReason: (ctx) =>
    ctx.sessionId ? undefined : 'select a session before planning a hub handoff',
  mobile: { showInSheet: true, label: 'handoff' },
};
