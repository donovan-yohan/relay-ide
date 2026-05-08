import type { KeyboardEvent } from 'react';
import type { RepoWebhookStatus } from '../lib/types.js';
import './RepoSourceDot.css';

export type RepoSourceStatus = RepoWebhookStatus;

export interface RepoSourceDotProps {
  status: RepoWebhookStatus;
  error?: string | undefined;
  onManualSetup?: (() => void) | undefined;
  onRetry?: (() => void) | undefined;
  className?: string | undefined;
}

function labelFor(status: RepoSourceStatus, error?: string): string {
  if (status === 'live') return 'live via webhook';
  if (status === 'manual') return 'manual fetch · enable webhook for live updates';
  if (status === 'limited') return 'manual fetch · no admin on this repo';
  return `webhook broken: ${error || 'setup failed'} · click to retry`;
}

function glyphFor(status: RepoSourceStatus): string {
  if (status === 'live') return '●';
  if (status === 'error') return '!';
  if (status === 'limited') return '○';
  return '○';
}

export function RepoSourceDot({
  status,
  error,
  onManualSetup,
  onRetry,
  className,
}: RepoSourceDotProps) {
  const label = labelFor(status, error);
  const actionable =
    (status === 'manual' && onManualSetup) || (status === 'error' && onRetry);
  const handleAction = () => {
    if (status === 'manual') onManualSetup?.();
    else if (status === 'error') onRetry?.();
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (!actionable) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    event.stopPropagation();
    handleAction();
  };

  return (
    <span
      className={[
        'repo-source-dot',
        `repo-source-dot--${status}`,
        actionable && 'repo-source-dot--clickable',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      data-testid="repo-source-dot"
      title={label}
      aria-label={label}
      role={actionable ? 'button' : 'img'}
      tabIndex={actionable ? 0 : undefined}
      onClick={(event) => {
        if (!actionable) return;
        event.stopPropagation();
        handleAction();
      }}
      onKeyDown={handleKeyDown}
    >
      {glyphFor(status)}
      {status === 'limited' ? (
        <svg
          className="repo-source-dot__lock"
          viewBox="0 0 8 8"
          aria-hidden="true"
        >
          <rect x="1.5" y="3.5" width="5" height="3" fill="none" />
          <path d="M2.5 3.5V2.5a1.5 1.5 0 0 1 3 0v1" fill="none" />
        </svg>
      ) : null}
    </span>
  );
}

export default RepoSourceDot;
