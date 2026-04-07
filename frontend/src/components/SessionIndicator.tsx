import type { DisplayState } from '../lib/state/display-state.js';
import './SessionIndicator.css';

interface SessionIndicatorProps {
  state: DisplayState;
}

export const config: Record<
  DisplayState,
  { char: string; colorClass: string; bold: boolean }
> = {
  initializing: { char: '●', colorClass: 'ind-green-dim', bold: false },
  running: { char: '●', colorClass: 'ind-green', bold: false },
  'unseen-idle': { char: '▶', colorClass: 'ind-yellow', bold: true },
  'seen-idle': { char: '▶', colorClass: 'ind-yellow-muted', bold: false },
  permission: { char: '◆', colorClass: 'ind-red', bold: true },
  'needs-answer': { char: '◇', colorClass: 'ind-red', bold: true },
  error: { char: '■', colorClass: 'ind-red', bold: true },
  inactive: { char: '─', colorClass: 'ind-gray', bold: false },
};

export function SessionIndicator({ state }: SessionIndicatorProps) {
  const cfg = config[state];
  const { char, colorClass, bold } = cfg;

  const pulseClass =
    state === 'permission' || state === 'needs-answer'
      ? 'pulse-fast'
      : state === 'unseen-idle'
        ? 'pulse-slow'
        : '';

  const label =
    state === 'permission'
      ? 'needs approval'
      : state === 'needs-answer'
        ? 'needs answer'
        : state === 'unseen-idle'
          ? 'idle, unread'
          : state === 'seen-idle'
            ? 'idle'
            : state;

  return (
    <span
      className={`session-indicator ${colorClass} ${pulseClass}`.trim()}
      style={bold ? { fontWeight: 700 } : undefined}
      role="img"
      aria-label={label}
    >
      {char}
    </span>
  );
}
