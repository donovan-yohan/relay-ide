import React, { useMemo } from 'react';
import type { SessionSummary, WorktreeInfo, RepoInfo, GitStatus } from '../lib/types.js';
import { formatRelativeTime } from '../lib/utils.js';
import StatusDot from './StatusDot.js';
import CipherText from './CipherText.js';
import MarqueeText from './MarqueeText.js';
import './SessionItem.css';

export interface MenuItem {
  label: string;
  action: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export type ActiveVariant = {
  kind: 'active';
  session: SessionSummary;
  status: 'running' | 'idle' | 'attention';
  isSelected: boolean;
};

const KIND_INACTIVE_WORKTREE = 'inactive-worktree' as const;

export type InactiveWorktreeVariant = {
  kind: typeof KIND_INACTIVE_WORKTREE;
  worktree: WorktreeInfo;
};

export type IdleRepoVariant = {
  kind: 'idle-repo';
  repo: RepoInfo;
};

export type ItemVariant = ActiveVariant | InactiveWorktreeVariant | IdleRepoVariant;

export interface SessionItemProps {
  variant: ItemVariant;
  gitStatus?: GitStatus | undefined;
  isLoading?: boolean;
  onClick: () => void;
  menuItems?: MenuItem[];
}

function deriveDisplayName(variant: ItemVariant): string {
  switch (variant.kind) {
    case 'active': {
      if (variant.session.worktreePath === null) {
        const wasRenamed = variant.session.displayName && variant.session.displayName !== variant.session.repoName;
        return wasRenamed ? variant.session.displayName : 'default';
      }
      return variant.session.displayName || variant.session.repoName || variant.session.id;
    }
    case KIND_INACTIVE_WORKTREE: return variant.worktree.displayName || variant.worktree.name;
    case 'idle-repo': return 'default';
  }
}

function deriveBranchName(variant: ItemVariant): string {
  switch (variant.kind) {
    case 'active': return variant.session.branchName || '';
    case KIND_INACTIVE_WORKTREE: return variant.worktree.branchName || '';
    case 'idle-repo': return variant.repo.defaultBranch || '';
  }
}

function deriveLastActivity(variant: ItemVariant): string {
  switch (variant.kind) {
    case 'active': return formatRelativeTime(variant.session.lastActivity);
    case KIND_INACTIVE_WORKTREE: return formatRelativeTime(variant.worktree.lastActivity);
    case 'idle-repo': return '';
  }
}

function derivePrDisplay(gitStatus: GitStatus | undefined): { icon: string; cls: string } {
  if (!gitStatus) return { icon: '', cls: '' };
  const icons: Record<string, string> = { open: '○', merged: '⬤', closed: '⊗' };
  const classes: Record<string, string> = { open: 'pr-icon pr-open', merged: 'pr-icon pr-merged', closed: 'pr-icon pr-closed' };
  const state = gitStatus.prState ?? '';
  return { icon: icons[state] ?? '', cls: classes[state] ?? '' };
}

export function SessionItem({ variant, gitStatus, isLoading = false, onClick }: SessionItemProps) {
  const displayName = useMemo(() => deriveDisplayName(variant), [variant]);
  const branchName = useMemo(() => deriveBranchName(variant), [variant]);
  const lastActivity = useMemo(() => deriveLastActivity(variant), [variant]);
  const { icon: prIcon, cls: prIconClass } = useMemo(() => derivePrDisplay(gitStatus), [gitStatus]);

  const isSelected = variant.kind === 'active' && variant.isSelected;
  const isActive = variant.kind === 'active';
  const displayState = isActive ? variant.status : 'disconnected';

  const liClass = ['session-item', isActive ? 'active-session' : KIND_INACTIVE_WORKTREE, isSelected && 'selected', isLoading && 'loading']
    .filter(Boolean).join(' ');

  return (
    <li className={liClass} onClick={onClick}>
      <div className="session-info">
        <div className="session-row-1">
          <span className="status-dot-wrap">
            <StatusDot status={displayState as 'running' | 'idle' | 'attention' | 'disconnected'} size={8} />
          </span>
          <span className="session-name">
            <MarqueeText>
              <span className="session-name-text"><CipherText text={displayName} loading={isLoading} /></span>
            </MarqueeText>
          </span>
        </div>
        <div className="session-row-2">
          {lastActivity ? <span className="session-time">{lastActivity}</span> : null}
          {branchName ? <span className="session-branch">{branchName}</span> : null}
          {prIcon ? <span className={prIconClass}>{prIcon}</span> : null}
          {gitStatus && (gitStatus.additions || gitStatus.deletions) ? (
            <span className="git-diff">
              {gitStatus.additions ? <span className="diff-add">+{gitStatus.additions}</span> : null}
              {gitStatus.deletions ? <span className="diff-del">-{gitStatus.deletions}</span> : null}
            </span>
          ) : null}
        </div>
      </div>
    </li>
  );
}

export default SessionItem;
