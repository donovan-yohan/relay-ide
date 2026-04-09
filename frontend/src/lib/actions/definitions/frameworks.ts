import type { FrameworkInfo } from '../../types.js';
import type { ActionMeta } from '../types.js';

export function createFrameworkAction(framework: FrameworkInfo): ActionMeta {
  return {
    id: `session.new-${framework.id}`,
    label: `new ${framework.displayName.toLowerCase()} session`,
    category: 'session',
    icon: '+',
    when: (ctx) => !!ctx.workspacePath,
  };
}
