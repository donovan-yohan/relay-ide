import React, { useCallback, useMemo } from 'react';
import {
  derivePrAction,
  buildPrStateInput,
  colorToVariant,
} from '../lib/pr-state.js';
import { prRoleLabel } from '../lib/pr-utils.js';
import { formatRelativeTime } from '../lib/utils.js';
import { derivePrDotStatus } from '../lib/pr-status.js';
import { deriveColor } from '../lib/colors.js';
import type { PullRequest } from '../lib/types.js';
import StatusDot from './StatusDot.js';
import { TuiButton } from './TuiButton.js';
import './PrRow.css';

export interface PrRowProps {
  pr: PullRequest;
  /** Called when the row is clicked (open worktree session) */
  onOpen: (pr: PullRequest) => void;
  /** Called for the derived action button (review, fix conflicts, etc.) */
  onAction?: (pr: PullRequest) => void;
  /** Ticket ID to display as a chip */
  ticketId?: string | null;
  /** Show repo chip (org-wide view) */
  showRepo?: boolean;
  /** Show CI status column */
  showCi?: boolean;
}

function CiIcon({ pr }: { pr: PullRequest }) {
  if (!pr.ciStatus) return null;
  if (pr.ciStatus === 'SUCCESS')
    return <span className="pr-row-ci ci-pass">{'✓'}</span>;
  if (pr.ciStatus === 'FAILURE' || pr.ciStatus === 'ERROR')
    return <span className="pr-row-ci ci-fail">{'✗'}</span>;
  if (pr.ciStatus === 'PENDING')
    return <span className="pr-row-ci ci-pending">{'○'}</span>;
  return null;
}

function ExternalLinkIcon() {
  return (
    <svg
      className="pr-row__external-icon"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="square"
      width="12"
      height="12"
      aria-hidden="true"
    >
      <path d="M6 2H2v12h12v-4" />
      <path d="M9 1h6v6" />
      <path d="M15 1L7 9" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="square"
      width="12"
      height="12"
      aria-hidden="true"
    >
      <path d="M6 3l5 5-5 5" />
    </svg>
  );
}

function branchIdentity(pr: PullRequest): {
  head: string;
  base: string;
  label: string;
} {
  const head = pr.headRefName.trim();
  const base = pr.baseRefName.trim();
  const label = head && base ? `${head} → ${base}` : head || base;
  return { head, base, label };
}

export function PrRow({
  pr,
  onOpen,
  onAction,
  ticketId,
  showRepo = false,
  showCi = false,
}: PrRowProps) {
  const action = useMemo(() => derivePrAction(buildPrStateInput(pr)), [pr]);
  const repoName = pr.repoName ?? '';
  const chipColor = showRepo ? deriveColor(repoName) : undefined;
  const updatedAgo = formatRelativeTime(pr.updatedAt);
  const { head: headRef, base: baseRef, label: branchLabel } =
    branchIdentity(pr);

  const handleRowClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('a, button')) return;
      onOpen(pr);
    },
    [onOpen, pr]
  );

  const handleRowKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onOpen(pr);
      }
    },
    [onOpen, pr]
  );

  const stopProp = useCallback(
    (e: React.MouseEvent) => e.stopPropagation(),
    []
  );

  return (
    <div
      className="pr-row"
      onClick={handleRowClick}
      onKeyDown={handleRowKeyDown}
      role="button"
      tabIndex={0}
      aria-label={`Open ${pr.title}`}
    >
      <div className="pr-row__status">
        <StatusDot status={derivePrDotStatus(pr)} />
      </div>

      <div className="pr-row__title">
        <div className="pr-row__title-line">
          <a
            className="pr-row__link"
            href={pr.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={stopProp}
          >
            {pr.title}
            <ExternalLinkIcon />
          </a>
        </div>
        <div className="pr-row__meta">
          <span className="pr-row__meta-text">#{pr.number}</span>
          {ticketId && (
            <>
              <span className="pr-row__sep">&middot;</span>
              <span className="pr-row__ticket">{ticketId}</span>
            </>
          )}
          <span className="pr-row__sep">&middot;</span>
          {branchLabel && (
            <>
              <span
                className="pr-row__branch"
                title={`branch ${branchLabel}`}
                aria-label={`branch ${branchLabel}`}
              >
                <span className="pr-row__branch-ref">{headRef}</span>
                {headRef && baseRef && (
                  <span className="pr-row__branch-arrow">→</span>
                )}
                <span className="pr-row__branch-ref">{baseRef}</span>
              </span>
              <span className="pr-row__sep">&middot;</span>
            </>
          )}
          <span className="pr-row__meta-text">{prRoleLabel(pr)}</span>
          <span className="pr-row__sep">&middot;</span>
          <span className="pr-row__meta-text">{updatedAgo}</span>
        </div>
      </div>

      {showRepo && repoName && (
        <div className="pr-row__repo">
          <span
            className="pr-row__repo-chip"
            style={{ background: chipColor }}
            title={pr.repoPath ?? repoName}
          >
            {repoName}
          </span>
        </div>
      )}

      <div className="pr-row__role">
        <span className="pr-row__role-text">
          {pr.role === 'author' ? 'author' : 'review'}
        </span>
      </div>

      {showCi && (
        <div className="pr-row__ci">
          <CiIcon pr={pr} />
        </div>
      )}

      <div className="pr-row__age">
        <span className="pr-row__age-text">{updatedAgo}</span>
      </div>

      <div className="pr-row__actions" onClick={stopProp}>
        {onAction && action.type !== 'none' && action.label && (
          <TuiButton
            variant={colorToVariant(action.color)}
            size="sm"
            onClick={() => onAction(pr)}
            title={action.label}
            disabled={action.type === 'checks-running'}
          >
            {action.label}
          </TuiButton>
        )}
        <TuiButton
          variant="ghost"
          size="sm"
          onClick={() => onOpen(pr)}
          title="Open in worktree session"
        >
          open <ChevronIcon />
        </TuiButton>
      </div>
    </div>
  );
}

export default PrRow;
