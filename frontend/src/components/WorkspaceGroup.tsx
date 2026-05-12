import React, { useMemo } from 'react';
import type {
  Workspace,
  Repo,
  SessionSummary,
  WorktreeInfo,
  PullRequest,
} from '../lib/types.js';
import { useSessionsStore } from '../lib/stores/sessions.js';
import { scopedSessionKey } from '../lib/session-keys.js';
import { deriveColor } from '../lib/colors.js';
import CipherText from './CipherText.js';
import TuiButton from './TuiButton.js';
import TuiProgress from './TuiProgress.js';
import RepoItem from './RepoItem.js';
import './WorkspaceGroup.css';

const EMPTY_SET = new Set<string>();
const EMPTY_ARRAY: never[] = [];

export interface WorkspaceGroupProps {
  workspace: Workspace;
  repos: Repo[];
  sessions?: SessionSummary[];
  worktrees?: WorktreeInfo[];
  loading?: boolean;
  collapsed?: boolean;
  launching?: boolean;
  activeRepoPath?: string | null;
  activeSessionId?: string | null;
  onToggleCollapse: () => void;
  onLaunchSession: (workspaceId: string) => void;
  onSelectSession: (id: string) => void;
  onSelectWorkspace: (path: string) => void;
  onNewWorktree: (workspace: Repo) => void;
  onOpenSettings: (workspace?: Repo) => void;
  onDeleteSession?: ((id: string) => void) | undefined;
  onDeleteWorktree?: ((wt: WorktreeInfo) => void) | undefined;
  onResumeWorktree?: ((wt: WorktreeInfo) => void) | undefined;
  onLaunchRepoSession?: ((repoPath: string) => void) | undefined;
  onViewHistory?: ((repoPath: string) => void) | undefined;
  orgPrs?: PullRequest[] | undefined;
  loadingItems?: Set<string> | undefined;
}

function getSessionGroupsForRepo(
  repo: Repo,
  sessions: SessionSummary[]
): Map<string, SessionSummary[]> {
  const map = new Map<string, SessionSummary[]>();
  map.set(repo.path, []);
  for (const s of sessions) {
    if (s.repoPath !== repo.path) continue;
    const key = s.worktreePath ?? repo.path;
    const existing = map.get(key) ?? [];
    existing.push(s);
    map.set(key, existing);
  }
  return map;
}

function getInactiveWorktreesForRepo(
  repo: Repo,
  sessions: SessionSummary[],
  worktrees: WorktreeInfo[]
): WorktreeInfo[] {
  const activeWorktreePaths = new Set(
    sessions
      .filter((s) => s.repoPath === repo.path && s.worktreePath !== null)
      .map((s) => s.worktreePath as string)
  );
  return worktrees.filter(
    (wt) => wt.repoPath === repo.path && !activeWorktreePaths.has(wt.path)
  );
}

export function WorkspaceGroup({
  workspace,
  repos,
  sessions = EMPTY_ARRAY,
  worktrees = EMPTY_ARRAY,
  loading = false,
  collapsed = false,
  launching = false,
  activeRepoPath = null,
  activeSessionId = null,
  onToggleCollapse,
  onLaunchSession,
  onSelectSession,
  onSelectWorkspace,
  onNewWorktree,
  onOpenSettings,
  onDeleteSession,
  onDeleteWorktree,
  onResumeWorktree,
  onLaunchRepoSession,
  onViewHistory,
  orgPrs,
  loadingItems = EMPTY_SET,
}: WorkspaceGroupProps) {
  const sidebarItems = useSessionsStore((s) => s.sidebarItems);
  const themeColor = workspace.themeColor ?? deriveColor(workspace.name);
  const accentBorder = `color-mix(in srgb, ${themeColor} 30%, transparent)`;
  const workspaceSessions = useMemo(
    () => sessions.filter((s) => s.workspaceId === workspace.id),
    [sessions, workspace.id]
  );
  const sessionCount = sessions.length;

  return (
    <div
      className={['workspace-group', collapsed && 'collapsed']
        .filter(Boolean)
        .join(' ')}
      style={{
        ['--theme-color' as string]: themeColor,
        ['--accent-border' as string]: accentBorder,
      }}
    >
      <div className="group-header" onClick={onToggleCollapse}>
        <div className="header-left">
          <span className="chevron">{collapsed ? '›' : '⌄'}</span>
          <span className="group-name">
            <CipherText text={workspace.name} loading={loading} />
          </span>
          {collapsed && sessionCount > 0 ? (
            <span className="session-count">{sessionCount}</span>
          ) : null}
        </div>
      </div>
      {!collapsed ? (
        <div className="group-body">
          {workspaceSessions.length > 0 ? (
            <ul className="workspace-sessions">
              {workspaceSessions.map((session) => (
                <li
                  key={scopedSessionKey(session)}
                  className="ws-session-row"
                  onClick={() => onSelectSession(scopedSessionKey(session))}
                >
                  <span className="ws-badge">workspace</span>
                  <span className="ws-session-name">{session.displayName}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="launch-row">
            <TuiButton
              variant="primary"
              disabled={launching ?? false}
              onClick={(e) => {
                e.stopPropagation();
                onLaunchSession(workspace.id);
              }}
            >
              {launching ? (
                <>
                  <TuiProgress variant="braille" />
                  &nbsp;launching...
                </>
              ) : (
                '> launch workspace session'
              )}
            </TuiButton>
          </div>
          {repos.length === 0 ? (
            <div className="empty-repos">no repos</div>
          ) : (
            repos.map((repo) => (
              <RepoItem
                key={repo.path}
                repo={repo}
                sessionGroups={getSessionGroupsForRepo(repo, sessions)}
                inactiveWorktrees={getInactiveWorktreesForRepo(
                  repo,
                  sessions,
                  worktrees
                )}
                isActive={activeRepoPath === repo.path && !activeSessionId}
                activeSessionId={activeSessionId ?? null}
                onSelectWorkspace={onSelectWorkspace}
                onSelectSession={onSelectSession}
                onNewWorktree={onNewWorktree}
                onOpenSettings={onOpenSettings}
                onDeleteSession={onDeleteSession}
                onDeleteWorktree={onDeleteWorktree}
                onResumeWorktree={onResumeWorktree}
                onLaunchRepoSession={onLaunchRepoSession}
                onViewHistory={onViewHistory}
                orgPrs={orgPrs ?? []}
                loadingItems={loadingItems}
                sidebarItems={sidebarItems}
              />
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

export default WorkspaceGroup;
