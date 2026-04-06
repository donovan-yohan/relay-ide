import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  useUiStore,
  MIN_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  DEFAULT_SIDEBAR_WIDTH,
  COLLAPSED_SIDEBAR_WIDTH,
} from '../lib/stores/ui.js';
import { useSessionsStore } from '../lib/stores/sessions.js';
import type { Repo, WorktreeInfo, PullRequest } from '../lib/types.js';
import { fetchOrgPrs } from '../lib/api.js';
import WorkspaceGroup from './WorkspaceGroup.js';
import RepoItem from './RepoItem.js';
import { TuiButton } from './TuiButton.js';
import './Sidebar.css';

// ── Resize hook ──

function useSidebarResize() {
  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = useUiStore.getState().sidebarWidth;

    function onMouseMove(ev: MouseEvent) {
      const newWidth = Math.min(
        MAX_SIDEBAR_WIDTH,
        Math.max(MIN_SIDEBAR_WIDTH, startWidth + (ev.clientX - startX))
      );
      useUiStore.setState({ sidebarWidth: newWidth });
    }

    function onMouseUp() {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      useUiStore.getState().saveSidebarWidth();
    }

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const resetWidth = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    useUiStore.setState({ sidebarWidth: DEFAULT_SIDEBAR_WIDTH });
    useUiStore.getState().saveSidebarWidth();
  }, []);

  return { startResize, resetWidth };
}

// ── Ungrouped workspace list (no DnD in React version — order from store) ──

interface UngroupedListProps {
  ungroupedRepos: Repo[];
  activeRepoPath: string | null;
  activeSessionId: string | null;
  worktrees: WorktreeInfo[];
  orgPrs: PullRequest[];
  onSelectWorkspace: (path: string) => void;
  onSelectSession: (id: string) => void;
  onNewWorktree: (workspace: Repo) => void;
  onOpenSettings: (workspace?: Repo) => void;
  onDeleteSession: ((id: string) => void) | undefined;
  onDeleteWorktree: ((wt: WorktreeInfo) => void) | undefined;
  onResumeWorktree: ((wt: WorktreeInfo) => void) | undefined;
  onLaunchRepoSession: ((repoPath: string) => void) | undefined;
}

function UngroupedList({
  ungroupedRepos,
  activeRepoPath,
  activeSessionId,
  worktrees,
  orgPrs,
  onSelectWorkspace,
  onSelectSession,
  onNewWorktree,
  onOpenSettings,
  onDeleteSession,
  onDeleteWorktree,
  onResumeWorktree,
  onLaunchRepoSession,
}: UngroupedListProps) {
  const getSessionsForRepo = useSessionsStore((s) => s.getSessionsForRepo);
  const sidebarItems = useSessionsStore((s) => s.sidebarItems);

  return (
    <div className="sidebar-ungrouped-list">
      {ungroupedRepos.map((repo) => {
        const activeSessions = getSessionsForRepo(repo.path);
        const activeWorktreePaths = new Set(
          activeSessions.map((s) => s.worktreePath).filter(Boolean) as string[]
        );
        const inactiveWorktrees = worktrees.filter(
          (wt) =>
            wt.repoPath === repo.path &&
            wt.path.startsWith(repo.path + '/') &&
            !activeWorktreePaths.has(wt.path)
        );
        const groupedByPath = buildGroupedByPath(repo.path, activeSessions);

        return (
          <div key={repo.path}>
            <RepoItem
              repo={repo}
              sessionGroups={groupedByPath}
              inactiveWorktrees={inactiveWorktrees}
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
              orgPrs={orgPrs}
              sidebarItems={sidebarItems}
            />
          </div>
        );
      })}
    </div>
  );
}

function buildGroupedByPath(
  workspacePath: string,
  activeSessions: ReturnType<typeof useSessionsStore.getState>['sessions']
): Map<string, typeof activeSessions> {
  const unsorted = new Map<string, typeof activeSessions>();
  unsorted.set(workspacePath, []);
  for (const s of activeSessions) {
    const groupKey = s.worktreePath ?? s.repoPath;
    const existing = unsorted.get(groupKey);
    if (existing) existing.push(s);
    else unsorted.set(groupKey, [s]);
  }
  const sorted = new Map<string, typeof activeSessions>();
  const rootSessions = unsorted.get(workspacePath);
  if (rootSessions) sorted.set(workspacePath, rootSessions);
  const worktreeKeys = [...unsorted.keys()]
    .filter((k) => k !== workspacePath)
    .sort();
  for (const k of worktreeKeys) sorted.set(k, unsorted.get(k)!);
  return sorted;
}

interface WorkspaceGroupsListProps {
  sortedGroups: ReturnType<typeof useSessionsStore.getState>['workspaceGroups'];
  reposByPath: Map<string, Repo>;
  worktrees: WorktreeInfo[];
  activeRepoPath: string | null;
  activeSessionId: string | null;
  orgPrs: PullRequest[];
  collapsedGroups: Record<string, boolean>;
  onToggleGroupCollapse: (id: string) => void;
  onSelectWorkspace: (path: string) => void;
  onSelectSession: (id: string) => void;
  onNewWorktree: (repo: Repo) => void;
  onOpenSettings: (repo?: Repo) => void;
  onDeleteSession: ((id: string) => void) | undefined;
  onDeleteWorktree: ((wt: WorktreeInfo) => void) | undefined;
  onResumeWorktree: ((wt: WorktreeInfo) => void) | undefined;
  onLaunchWorkspaceSession: ((workspaceId: string) => void) | undefined;
  onLaunchRepoSession: ((repoPath: string) => void) | undefined;
}

function WorkspaceGroupsList({
  sortedGroups,
  reposByPath,
  worktrees,
  activeRepoPath,
  activeSessionId,
  orgPrs,
  collapsedGroups,
  onToggleGroupCollapse,
  onSelectWorkspace,
  onSelectSession,
  onNewWorktree,
  onOpenSettings,
  onDeleteSession,
  onDeleteWorktree,
  onResumeWorktree,
  onLaunchWorkspaceSession,
  onLaunchRepoSession,
}: WorkspaceGroupsListProps) {
  const getSessionsForWorkspaceGroup = useSessionsStore(
    (s) => s.getSessionsForWorkspaceGroup
  );

  return (
    <>
      {sortedGroups.map((ws) => {
        const wsRepos = ws.repos
          .map((p: string) => reposByPath.get(p))
          .filter((r): r is Repo => r !== undefined);
        const wsSessions = getSessionsForWorkspaceGroup(ws.id);
        const wsWorktrees = worktrees.filter((wt) =>
          ws.repos.includes(wt.repoPath)
        );
        return (
          <WorkspaceGroup
            key={ws.id}
            workspace={ws}
            repos={wsRepos}
            sessions={wsSessions}
            worktrees={wsWorktrees}
            activeRepoPath={activeRepoPath}
            activeSessionId={activeSessionId ?? null}
            onToggleCollapse={() => onToggleGroupCollapse(ws.id)}
            collapsed={collapsedGroups[ws.id] ?? false}
            onLaunchSession={(id) => onLaunchWorkspaceSession?.(id)}
            onSelectSession={onSelectSession}
            onSelectWorkspace={onSelectWorkspace}
            onNewWorktree={onNewWorktree}
            onOpenSettings={onOpenSettings}
            onDeleteSession={(id) => onDeleteSession?.(id)}
            onDeleteWorktree={(wt) => onDeleteWorktree?.(wt)}
            onResumeWorktree={(wt) => onResumeWorktree?.(wt)}
            {...(onLaunchRepoSession ? { onLaunchRepoSession } : {})}
            orgPrs={orgPrs}
          />
        );
      })}
    </>
  );
}

// ── Main Sidebar ──

export interface SidebarProps {
  onSelectSession: (id: string) => void;
  onOpenSettings: (workspace?: Repo) => void;
  onNewWorktree: (workspace: Repo) => void;
  onAddWorkspace: () => void;
  onDeleteSession?: (id: string) => void;
  onDeleteWorktree?: (wt: WorktreeInfo) => void;
  onResumeWorktree?: (wt: WorktreeInfo) => void;
  onLaunchWorkspaceSession?: (workspaceId: string) => void;
  onLaunchRepoSession?: (repoPath: string) => void;
  onOpenAnalytics: () => void;
}

export function Sidebar({
  onSelectSession,
  onOpenSettings,
  onNewWorktree,
  onAddWorkspace,
  onDeleteSession,
  onDeleteWorktree,
  onResumeWorktree,
  onLaunchWorkspaceSession,
  onLaunchRepoSession,
  onOpenAnalytics,
}: SidebarProps) {
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const activeRepoPath = useUiStore((s) => s.activeRepoPath);
  const closeSidebar = useUiStore((s) => s.closeSidebar);
  const toggleSidebarCollapsed = useUiStore((s) => s.toggleSidebarCollapsed);
  const repos = useSessionsStore((s) => s.repos);
  const worktrees = useSessionsStore((s) => s.worktrees);
  const workspaceGroups = useSessionsStore((s) => s.workspaceGroups);
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const { startResize, resetWidth } = useSidebarResize();
  const effectiveWidth = sidebarCollapsed
    ? COLLAPSED_SIDEBAR_WIDTH
    : sidebarWidth;
  const { data: orgData } = useQuery({
    queryKey: ['org-prs'],
    queryFn: fetchOrgPrs,
    staleTime: 60_000,
  });
  const orgPrs: PullRequest[] = orgData?.prs ?? [];
  const groupedRepoPaths = useMemo(
    () => new Set(workspaceGroups.flatMap((ws) => ws.repos)),
    [workspaceGroups]
  );
  const ungroupedRepos = useMemo(
    () => repos.filter((r) => !groupedRepoPaths.has(r.path)),
    [repos, groupedRepoPaths]
  );
  const reposByPath = useMemo(
    () => new Map(repos.map((r) => [r.path, r])),
    [repos]
  );
  const handleSelectWorkspace = useCallback((path: string) => {
    useUiStore.setState({ activeRepoPath: path });
    useSessionsStore.getState().setActiveSessionId(null);
    closeSidebar();
  }, [closeSidebar]);
  const handleHomeBrand = useCallback(() => {
    useUiStore.getState().setActiveRepoPath(null);
    useUiStore.getState().setAnalyticsView(null);
    useSessionsStore.getState().setActiveSessionId(null);
    closeSidebar();
  }, [closeSidebar]);
  const sortedGroups = useMemo(
    () => [...workspaceGroups].sort((a, b) => a.order - b.order),
    [workspaceGroups]
  );
  const [collapsedGroups, setCollapsedGroups] = useState<
    Record<string, boolean>
  >({});
  const handleToggleGroupCollapse = useCallback((id: string) => {
    setCollapsedGroups((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  return (
    <aside
      className={[
        'sidebar',
        sidebarOpen ? 'open' : '',
        sidebarCollapsed ? 'collapsed' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ width: effectiveWidth, minWidth: effectiveWidth }}
    >
      <div className="sidebar-header">
        <button
          className="sidebar-collapse-btn"
          aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={toggleSidebarCollapsed}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="square"
            width="16"
            height="16"
          >
            <rect x="3" y="3" width="18" height="18" />
            <line x1="9" y1="3" x2="9" y2="21" />
            {sidebarCollapsed && (
              <>
                <line x1="14" y1="10" x2="18" y2="12" />
                <line x1="14" y1="14" x2="18" y2="12" />
              </>
            )}
            {!sidebarCollapsed && (
              <>
                <line x1="18" y1="10" x2="14" y2="12" />
                <line x1="18" y1="14" x2="14" y2="12" />
              </>
            )}
          </svg>
        </button>
        {!sidebarCollapsed && (
          <button className="sidebar-brand" onClick={handleHomeBrand}>
            Relay
          </button>
        )}
        <button
          className="sidebar-icon-btn"
          aria-label="Close sidebar"
          onClick={closeSidebar}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="square"
            width="14"
            height="14"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      {!sidebarCollapsed && (
        <>
          <div className="sidebar-workspace-list">
            <WorkspaceGroupsList
              sortedGroups={sortedGroups}
              reposByPath={reposByPath}
              worktrees={worktrees}
              activeRepoPath={activeRepoPath}
              activeSessionId={activeSessionId ?? null}
              orgPrs={orgPrs}
              collapsedGroups={collapsedGroups}
              onToggleGroupCollapse={handleToggleGroupCollapse}
              onSelectWorkspace={handleSelectWorkspace}
              onSelectSession={onSelectSession}
              onNewWorktree={onNewWorktree}
              onOpenSettings={onOpenSettings}
              onDeleteSession={onDeleteSession}
              onDeleteWorktree={onDeleteWorktree}
              onResumeWorktree={onResumeWorktree}
              onLaunchWorkspaceSession={onLaunchWorkspaceSession}
              onLaunchRepoSession={onLaunchRepoSession}
            />
            {ungroupedRepos.length > 0 && (
              <>
                {workspaceGroups.length > 0 && (
                  <div className="sidebar-ungrouped-label">ungrouped</div>
                )}
                <UngroupedList
                  ungroupedRepos={ungroupedRepos}
                  activeRepoPath={activeRepoPath}
                  activeSessionId={activeSessionId ?? null}
                  worktrees={worktrees}
                  orgPrs={orgPrs}
                  onSelectWorkspace={handleSelectWorkspace}
                  onSelectSession={onSelectSession}
                  onNewWorktree={onNewWorktree}
                  onOpenSettings={onOpenSettings}
                  onDeleteSession={onDeleteSession}
                  onDeleteWorktree={onDeleteWorktree}
                  onResumeWorktree={onResumeWorktree}
                  onLaunchRepoSession={onLaunchRepoSession}
                />
              </>
            )}
            {repos.length === 0 && (
              <div className="sidebar-empty-state">
                <span>no repos</span>
              </div>
            )}
            {workspaceGroups.length === 0 &&
              ungroupedRepos.length === 0 &&
              repos.length > 0 && (
                <div className="sidebar-empty-workspace-hint">
                  <span>no workspaces yet</span>
                </div>
              )}
          </div>
          <div className="sidebar-footer-row">
            <TuiButton
              variant="primary"
              onClick={onAddWorkspace}
              style={{ flex: 1 }}
            >
              + add repo
            </TuiButton>
            <button
              className="sidebar-settings-icon-btn"
              data-track="sidebar.analytics"
              onClick={onOpenAnalytics}
              aria-label="Analytics"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="square"
                width="14"
                height="14"
              >
                <rect x="3" y="12" width="4" height="9" />
                <rect x="10" y="7" width="4" height="14" />
                <rect x="17" y="3" width="4" height="18" />
              </svg>
            </button>
            <button
              className="sidebar-settings-icon-btn"
              data-track="sidebar.settings"
              onClick={() => onOpenSettings()}
              aria-label="Settings"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="square"
                width="14"
                height="14"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1-1.51V15H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          </div>
          <div
            className="sidebar-resize-handle"
            onMouseDown={startResize}
            onDoubleClick={resetWidth}
          />
        </>
      )}
      <div className="sidebar-scanline-overlay" aria-hidden="true" />
    </aside>
  );
}

export default Sidebar;
