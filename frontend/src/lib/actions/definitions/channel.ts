import type { ActionMeta } from '../types.js';

export const channelToggleAgentActivity: ActionMeta = {
  id: 'navigation.toggle-agent-activity',
  label: 'toggle agent activity',
  description: 'show or collapse completed agent tool and reasoning activity',
  aliases: ['responses first', 'collapse tool calls', 'show agent activity'],
  category: 'navigation',
  icon: '≡',
  shortcut: { key: 'mod+shift+a' },
  when: (ctx) => ctx.view === 'chat',
};

export const channelActions: ActionMeta[] = [channelToggleAgentActivity];
