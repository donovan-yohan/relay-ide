export type StatusDotStatus =
  | 'draft'
  | 'open'
  | 'approved'
  | 'changes-requested'
  | 'review-requested'
  | 'merged'
  | 'closed'
  | 'unknown'
  | 'in-progress'
  | 'code-review'
  | 'ready-for-qa'
  | 'unmapped'
  | 'running'
  | 'idle'
  | 'attention'
  | 'permission-prompt'
  | 'connected'
  | 'disconnected'
  | 'warning'
  | 'initializing';

interface StatusDotProps {
  status: StatusDotStatus;
  size?: number;
}

export function StatusDot({ status, size = 7 }: StatusDotProps) {
  const shouldPulse = status === 'attention' || status === 'permission-prompt';

  return (
    <span
      className={`status-dot status-dot--${status}${shouldPulse ? ' pulse' : ''}`}
      style={{ width: `${size}px`, height: `${size}px` }}
      role="img"
      aria-label={`${status} status`}
    />
  );
}

export default StatusDot;