import { useCallback, type MouseEvent as ReactMouseEvent } from 'react';
import {
  useUiStore,
  MIN_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  DEFAULT_SIDEBAR_WIDTH,
  COLLAPSED_SIDEBAR_WIDTH,
} from '../lib/stores/ui.js';
import { useSessionsStore } from '../lib/stores/sessions.js';
import type { Repo, WorktreeInfo } from '../lib/types.js';
import { TopicSidebarShell } from './TopicSidebarShell.js';
import { ViewSpineTree } from './ViewSpineTree.js';
import type { BenchCreatePayload } from '../lib/state/view-tree.js';
import { TuiButton } from './TuiButton.js';
import './Sidebar.css';

// ── Resize hook ──

function useSidebarResize() {
  const startResize = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = useUiStore.getState().sidebarWidth;

    function onMouseMove(ev: globalThis.MouseEvent) {
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

  const resetWidth = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    useUiStore.setState({ sidebarWidth: DEFAULT_SIDEBAR_WIDTH });
    useUiStore.getState().saveSidebarWidth();
  }, []);

  return { startResize, resetWidth };
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
  /** #731: create an agent Tab anchored to a view-spine Bench. Payload carries
   *  the node anchor + the configured repo/worktree context the backend
   *  validates (`BenchCreatePayload`). */
  onViewSpineCreateTab?: (payload: BenchCreatePayload) => void;
  onOpenAnalytics: () => void;
}

export function Sidebar({
  onSelectSession,
  onOpenSettings,
  onAddWorkspace,
  onViewSpineCreateTab,
  onOpenAnalytics,
}: SidebarProps) {
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const analyticsView = useUiStore((s) => s.analyticsView);
  const viewSpineEnabled = useUiStore((s) => s.viewSpineEnabled);
  const advancedMode = useUiStore((s) => s.advancedMode);
  const closeSidebar = useUiStore((s) => s.closeSidebar);
  const toggleSidebarCollapsed = useUiStore((s) => s.toggleSidebarCollapsed);
  const { startResize, resetWidth } = useSidebarResize();
  const effectiveWidth = sidebarCollapsed
    ? COLLAPSED_SIDEBAR_WIDTH
    : sidebarWidth;
  const handleHomeBrand = useCallback(() => {
    useUiStore.getState().setActiveRepoPath(null);
    useUiStore.getState().setAnalyticsView(null);
    useUiStore.getState().setOrgDashboardTab('active-work');
    useSessionsStore.getState().setActiveSessionId(null);
    closeSidebar();
  }, [closeSidebar]);

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
          {viewSpineEnabled ? (
            // Preserved opt-in six-layer navigation tree. The repo/worktree
            // compatibility sidebar fallback was removed after topic-shell
            // parity/dogfood cleared #1027/#1032.
            <div className="sidebar-workspace-list">
              <ViewSpineTree
                onCreateTab={onViewSpineCreateTab}
                onSelectTab={onSelectSession}
              />
            </div>
          ) : (
            <div className="sidebar-workspace-list">
              <TopicSidebarShell onSelectSession={onSelectSession} />
            </div>
          )}
          <div className="sidebar-footer-row">
            <TuiButton
              variant="primary"
              onClick={onAddWorkspace}
              style={{ flex: 1 }}
            >
              + add project
            </TuiButton>
            {advancedMode && (
              <button
                className={[
                  'sidebar-settings-icon-btn',
                  analyticsView !== null && 'active',
                ]
                  .filter(Boolean)
                  .join(' ')}
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
            )}
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
