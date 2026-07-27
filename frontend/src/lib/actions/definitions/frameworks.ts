import type { FrameworkInfo } from '../../types.js';
import type { ActionMeta } from '../types.js';

export function createFrameworkAction(framework: FrameworkInfo): ActionMeta {
  return {
    id: `session.new-${framework.id}`,
    label: `open ${framework.displayName.toLowerCase()} chat`,
    category: 'session',
    icon: '+',
    when: (ctx) => !!ctx.workspacePath,
  };
}
