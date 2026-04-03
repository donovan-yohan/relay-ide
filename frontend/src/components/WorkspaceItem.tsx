import React, { useMemo, useRef } from 'react';
import type { Repo, SessionSummary, WorktreeInfo, PullRequest } from '../lib/types.js';
import type { DisplayState } from '../lib/state/display-state.js';
import { isAttentionState } from '../lib/state/display-state.js';
import { deriveColor } from '../lib/colors.js';
import { derivePrDotStatus } from '../lib/pr-status.js';
import { formatRelativeTimeCompact } from '../lib/utils.js';
import StatusDot from './StatusDot.js';
import { MarqueeText } from './MarqueeText.js';
import './WorkspaceItem.css';

export interface SidebarItem {
  id: string;
  repoPath: string;
  displayState: DisplayState;
}

export interface WorkspaceItemProps {
  workspace: Repo;
  sessionGroups: Map<string, SessionSummary[]>;
  inactiveWorktrees?: WorktreeInfo[];
  isActive: boolean;
  activeSessionId?: string | null;
  onSelectWorkspace: (path: string) => void;
  onSelectSession: (id: string) => void;
  onNewWorktree: (workspace: Repo) => void;
  onOpenSettings: (workspace?: Repo) => void;
  onDeleteSession?: (id: string) => void;
  onDeleteWorktree?: (wt: WorktreeInfo) => void;
  onResumeWorktree?: (wt: WorktreeInfo) => void;
  orgPrs?: PullRequest[];
  sidebarItems?: SidebarItem[];
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  loadingItems?: Set<string>;
}

const settingsSvg = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" width="14" height="14">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1-1.51V15H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

export function groupDisplayName(groupPath: string, workspacePath: string, sessions: SessionSummary[]): string {
  const isRepoRoot = groupPath === workspacePath;
  if (isRepoRoot) {
    const repoSession = sessions.find((s) => s.worktreePath === null);
    if (repoSession) {
      const wasRenamed = repoSession.displayName && repoSession.displayName !== repoSession.repoName;
      return wasRenamed ? repoSession.displayName : 'default';
    }
    return 'default';
  }
  const branch = sessions.find((s) => s.branchName)?.branchName;
  const cwdName = sessions[0]?.cwd.split('/').pop();
  return branch || cwdName || sessions[0]?.repoName || 'unknown';
}

interface PrStatusBadgeProps { pr: PullRequest }
function PrStatusBadge({ pr }: PrStatusBadgeProps) {
  return (
    <span className="sidebar-pr-status">
      <StatusDot status={derivePrDotStatus(pr) as 'running' | 'idle' | 'attention' | 'disconnected'} size={5} />
      {pr.ciStatus === 'SUCCESS' ? (
        <span className="ci-pass"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" width="9" height="9"><polyline points="20 6 9 17 4 12" /></svg></span>
      ) : pr.ciStatus === 'FAILURE' || pr.ciStatus === 'ERROR' ? (
        <span className="ci-fail"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" width="9" height="9"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg></span>
      ) : pr.ciStatus === 'PENDING' ? (
        <span className="ci-pending" style={{ fontSize: '9px' }}>●</span>
      ) : null}
    </span>
  );
}

export function WorkspaceItem({ workspace, sessionGroups, inactiveWorktrees = [], isActive, activeSessionId = null, onSelectWorkspace, onSelectSession, onNewWorktree, onOpenSettings, onDeleteSession, onDeleteWorktree, onResumeWorktree, orgPrs = [], sidebarItems = [], collapsed = false, onToggleCollapse, loadingItems = new Set() }: WorkspaceItemProps) {
  const initialColor = useMemo(() => deriveColor(workspace.name), [workspace.name]);
  const initial = workspace.name.charAt(0).toUpperCase();
  const allSessions = useMemo(() => [...sessionGroups.values()].flat(), [sessionGroups]);
  const totalItems = allSessions.length + inactiveWorktrees.length;
  const sidebarItemById = useMemo(() => new Map(sidebarItems.map((i) => [i.id, i])), [sidebarItems]);
  const hasAttention = useMemo(() => sidebarItems.filter((i) => i.repoPath === workspace.path).some((i) => isAttentionState(i.displayState)), [sidebarItems, workspace.path]);
  const creatingWorktree = loadingItems.has(`new-worktree:${workspace.path}`);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function cancelLongPress() {
    if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
  }

  function findPr(branchName: string) {
    return orgPrs?.find((pr) => pr.headRefName === branchName && pr.state === 'OPEN' && pr.repoPath === workspace.path);
  }

  return (
    <div className={['workspace-item', isActive && 'active'].filter(Boolean).join(' ')}>
      <div className={['workspace-header', hasAttention && 'attention'].filter(Boolean).join(' ')} data-track="sidebar.workspace.click" onClick={() => onSelectWorkspace(workspace.path)}>
        <div className="workspace-left">
          <span className={['collapse-chevron', collapsed && 'collapsed'].filter(Boolean).join(' ')} onClick={(e) => { e.stopPropagation(); onToggleCollapse?.(); }}>
            {collapsed ? '›' : '⌄'}
          </span>
          <span className="initial-block" style={{ background: initialColor }}>{initial}</span>
          <span className="workspace-name"><MarqueeText>{workspace.name}</MarqueeText></span>
          {collapsed && totalItems > 0 ? <span className="collapse-count">{totalItems}</span> : null}
        </div>
        <div className="workspace-actions">
          <button className="action-btn" title="Settings" type="button" onClick={(e) => { e.stopPropagation(); onOpenSettings(workspace); }}>{settingsSvg}</button>
        </div>
      </div>
      {!collapsed ? (
        <ul className="session-list">
          {[...sessionGroups.entries()].map(([groupPath, groupSessions]) => {
            const sorted = [...groupSessions].sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
            const rep = sorted[0];
            const isRepoRoot = groupPath === workspace.path;
            if (rep) {
              const matchedPr = findPr(groupSessions[0]?.branchName ?? '');
              const isSelected = groupSessions.some((s) => activeSessionId === s.id);
              const attention = (sidebarItemById.get(groupPath) !== undefined) && isAttentionState(sidebarItemById.get(groupPath)!.displayState);
              const dotState = sidebarItemById.get(groupPath)?.displayState ?? 'inactive';
              return (
                <li key={groupPath} className={['session-row', isSelected && 'selected', attention && 'attention'].filter(Boolean).join(' ')} data-track="sidebar.session.click" onClick={() => onSelectSession(rep.id)} onTouchEnd={cancelLongPress} onTouchMove={cancelLongPress}>
                  <div className="session-row-primary">
                    <span className={`status-dot status-dot--${dotState}`} />
                    <span className={['session-name', attention && 'bold'].filter(Boolean).join(' ')}><MarqueeText>{groupDisplayName(groupPath, workspace.path, groupSessions)}</MarqueeText></span>
                    {groupSessions.length > 1 ? <span className="session-count-badge">{groupSessions.length}</span> : null}
                    {matchedPr ? <PrStatusBadge pr={matchedPr} /> : null}
                  </div>
                  <div className="session-row-secondary">
                    <span className="secondary-time">{formatRelativeTimeCompact(rep.lastActivity)}</span>
                    {rep.branchName ? <span className="secondary-branch"><MarqueeText>{rep.branchName}</MarqueeText></span> : null}
                  </div>
                </li>
              );
            } else if (isRepoRoot) {
              const repoLoadingKey = `repo-session:${workspace.path}`;
              const isLoading = loadingItems.has(repoLoadingKey);
              return (
                <li key={groupPath} className={['session-row', 'inactive', isLoading && 'loading'].filter(Boolean).join(' ')} data-track="sidebar.repo.click" onClick={() => { if (!isLoading) onSelectWorkspace(workspace.path); }}>
                  <div className="session-row-primary">
                    <span className="dot dot-inactive" />
                    <span className="session-name"><MarqueeText>{isLoading ? 'starting...' : 'default'}</MarqueeText></span>
                  </div>
                  {workspace.defaultBranch ? <div className="session-row-secondary"><span className="secondary-branch"><MarqueeText>{workspace.defaultBranch}</MarqueeText></span></div> : null}
                </li>
              );
            }
            return null;
          })}
          {inactiveWorktrees.map((wt) => {
            const isLoading = loadingItems.has(wt.path);
            return (
              <li key={wt.path} className={['session-row', 'inactive', isLoading && 'loading'].filter(Boolean).join(' ')} data-track="sidebar.worktree.click" onClick={() => { if (!isLoading) onResumeWorktree?.(wt); }} onTouchEnd={cancelLongPress} onTouchMove={cancelLongPress}>
                <div className="session-row-primary">
                  <span className="dot dot-inactive" />
                  <span className="session-name"><MarqueeText>{isLoading ? 'resuming...' : wt.branchName || wt.displayName || wt.name}</MarqueeText></span>
                </div>
                <div className="session-row-secondary">
                  <span className="secondary-time">{formatRelativeTimeCompact(wt.lastActivity)}</span>
                  {wt.branchName ? <span className="secondary-branch"><MarqueeText>{wt.branchName}</MarqueeText></span> : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      {!collapsed ? (
        <div className={['add-worktree-row', creatingWorktree && 'disabled'].filter(Boolean).join(' ')} data-track="sidebar.new-worktree" onClick={() => { if (!creatingWorktree) onNewWorktree(workspace); }}>
          <button className="add-worktree-btn" type="button" tabIndex={-1}>{creatingWorktree ? 'creating...' : '+ new worktree'}</button>
        </div>
      ) : null}
      <div className="workspace-divider" />
    </div>
  );
}

export default WorkspaceItem;
