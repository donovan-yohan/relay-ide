import type { NodeBadge } from '../lib/workspace-summary.js';
import type { SessionSummary } from '../lib/types.js';
import { controlBadgeView } from '../lib/control-display.js';
import './TabControlBadge.css';

export interface TabControlBadgeProps {
  session?: SessionSummary | undefined;
  nodeBadge?: NodeBadge | undefined;
  compact?: boolean;
}

export function TabControlBadge({
  session,
  nodeBadge,
  compact = false,
}: TabControlBadgeProps) {
  const view = controlBadgeView(session, nodeBadge);
  return (
    <span
      className={[
        'tab-control-badge',
        `tab-control-badge--${view.mode}`,
        compact ? 'tab-control-badge--compact' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      title={view.title}
      aria-label={view.ariaLabel}
      data-control-mode={view.mode}
    >
      <span className="tab-control-badge__label">{view.label}</span>
    </span>
  );
}

export default TabControlBadge;
