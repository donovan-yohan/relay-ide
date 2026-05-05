import React, { useCallback } from 'react';
import type { SessionSummary } from '../lib/types.js';
import {
  useUiStore,
  type UtilityRailTab,
  type WorkspaceUtilityRailState,
  UTILITY_ICON_RAIL_WIDTH,
} from '../lib/stores/ui.js';
import type { FileTreeHandle } from './FileTree/index.js';
import UtilityRailFilesPanel from './UtilityRailFilesPanel.js';
import UtilityRailGitChangesPanel from './UtilityRailGitChangesPanel.js';
import UtilityRailBranchPanel from './UtilityRailBranchPanel.js';
import UtilityRailReviewPanel from './UtilityRailReviewPanel.js';
import UtilityRailLogsPanel from './UtilityRailLogsPanel.js';
import UtilityRailStatsPanel from './UtilityRailStatsPanel.js';
import Tooltip from './Tooltip.js';
import './WorkspaceUtilityRail.css';

const TAB_META: Array<{
  id: UtilityRailTab;
  label: string;
  actionId?: string;
  icon: React.ReactNode;
}> = [
  {
    id: 'files',
    label: 'file browser',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 3h10l4 4v14H5z" />
        <path d="M15 3v5h5" />
      </svg>
    ),
  },
  {
    id: 'changes',
    label: 'git changes',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="6" cy="6" r="2.5" />
        <circle cx="6" cy="18" r="2.5" />
        <circle cx="18" cy="12" r="2.5" />
        <path d="M6 8.5v7" />
        <path d="M6 6h6a4 4 0 0 1 4 4v.5" />
      </svg>
    ),
  },
  {
    id: 'branch',
    label: 'git branch',
    actionId: 'workspace.open-branch-divergence',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="7" cy="6" r="2.5" />
        <circle cx="17" cy="18" r="2.5" />
        <path d="M7 8.5v9.5" />
        <path d="M7 12h4a6 6 0 0 1 6 6" />
      </svg>
    ),
  },
  {
    id: 'review',
    label: 'git diff',
    actionId: 'workspace.open-diff-view',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7 4v16" />
        <path d="M17 4v16" />
        <path d="M7 8h10" />
        <path d="M7 16h10" />
      </svg>
    ),
  },
  {
    id: 'logs',
    label: 'logs',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 5h14" />
        <path d="M5 12h14" />
        <path d="M5 19h10" />
      </svg>
    ),
  },
  {
    id: 'stats',
    label: 'stats',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 19V9" />
        <path d="M12 19V5" />
        <path d="M19 19v-7" />
      </svg>
    ),
  },
];

export interface WorkspaceUtilityRailProps {
  workspacePath: string;
  railState: WorkspaceUtilityRailState;
  activeSession?: SessionSummary | undefined;
  workspaceSessions: SessionSummary[];
  fileTreeSidebarRef?: React.RefObject<FileTreeHandle | null>;
}

export function utilityRailRenderedWidth(
  state: WorkspaceUtilityRailState
): number {
  if (!state.visible) return 0;
  return UTILITY_ICON_RAIL_WIDTH + (state.selectedRailTab ? state.width : 0);
}

export function WorkspaceUtilityRail({
  workspacePath,
  railState,
  activeSession,
  workspaceSessions,
  fileTreeSidebarRef,
}: WorkspaceUtilityRailProps) {
  const setSelectedUtilityRailTab = useUiStore(
    (s) => s.setSelectedUtilityRailTab
  );
  const openUtilityRailTab = useUiStore((s) => s.openUtilityRailTab);
  const selectedTab = railState.selectedRailTab;

  const handleTabClick = useCallback(
    (tab: UtilityRailTab) => {
      if (selectedTab === tab) {
        setSelectedUtilityRailTab(workspacePath, null);
      } else {
        openUtilityRailTab(workspacePath, tab);
      }
    },
    [openUtilityRailTab, selectedTab, setSelectedUtilityRailTab, workspacePath]
  );

  const handleTabKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, tab: UtilityRailTab) => {
      const currentIndex = TAB_META.findIndex((item) => item.id === tab);
      let nextIndex: number | null = null;
      if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
        nextIndex = (currentIndex + 1) % TAB_META.length;
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
        nextIndex = (currentIndex - 1 + TAB_META.length) % TAB_META.length;
      } else if (event.key === 'Home') {
        nextIndex = 0;
      } else if (event.key === 'End') {
        nextIndex = TAB_META.length - 1;
      }
      if (nextIndex === null) return;
      event.preventDefault();
      const nextTab = TAB_META[nextIndex]?.id;
      if (!nextTab) return;
      openUtilityRailTab(workspacePath, nextTab);
      requestAnimationFrame(() => {
        document.getElementById(`utility-rail-tab-${nextTab}`)?.focus();
      });
    },
    [openUtilityRailTab, workspacePath]
  );

  if (!railState.visible) return null;

  return (
    <div
      className={[
        'workspace-utility-rail',
        !railState.selectedRailTab && 'workspace-utility-rail--icons-only',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="utility-selected-pane">
        <div className="utility-pane-body">
          <div
            id="utility-rail-panel-files"
            className="utility-pane-panel"
            role="tabpanel"
            aria-labelledby="utility-rail-tab-files"
            tabIndex={selectedTab === 'files' ? 0 : -1}
            hidden={selectedTab !== 'files'}
          >
            <UtilityRailFilesPanel
              workspacePath={workspacePath}
              {...(fileTreeSidebarRef ? { fileTreeSidebarRef } : {})}
            />
          </div>
          <div
            id="utility-rail-panel-changes"
            className="utility-pane-panel"
            role="tabpanel"
            aria-labelledby="utility-rail-tab-changes"
            tabIndex={selectedTab === 'changes' ? 0 : -1}
            hidden={selectedTab !== 'changes'}
          >
            <UtilityRailGitChangesPanel workspacePath={workspacePath} />
          </div>
          <div
            id="utility-rail-panel-branch"
            className="utility-pane-panel"
            role="tabpanel"
            aria-labelledby="utility-rail-tab-branch"
            tabIndex={selectedTab === 'branch' ? 0 : -1}
            hidden={selectedTab !== 'branch'}
          >
            <UtilityRailBranchPanel workspacePath={workspacePath} />
          </div>
          <div
            id="utility-rail-panel-review"
            className="utility-pane-panel"
            role="tabpanel"
            aria-labelledby="utility-rail-tab-review"
            tabIndex={selectedTab === 'review' ? 0 : -1}
            hidden={selectedTab !== 'review'}
          >
            <UtilityRailReviewPanel
              workspacePath={workspacePath}
              reviewFilePath={railState.reviewFilePath}
            />
          </div>
          <div
            id="utility-rail-panel-logs"
            className="utility-pane-panel"
            role="tabpanel"
            aria-labelledby="utility-rail-tab-logs"
            tabIndex={selectedTab === 'logs' ? 0 : -1}
            hidden={selectedTab !== 'logs'}
          >
            <UtilityRailLogsPanel activeSession={activeSession} />
          </div>
          <div
            id="utility-rail-panel-stats"
            className="utility-pane-panel"
            role="tabpanel"
            aria-labelledby="utility-rail-tab-stats"
            tabIndex={selectedTab === 'stats' ? 0 : -1}
            hidden={selectedTab !== 'stats'}
          >
            <UtilityRailStatsPanel
              activeSession={activeSession}
              workspaceSessions={workspaceSessions}
            />
          </div>
        </div>
      </div>
      <div
        className="utility-icon-rail"
        style={{ width: UTILITY_ICON_RAIL_WIDTH }}
        role="tablist"
        aria-label="utility rail"
      >
        <div className="utility-icon-group">
          {TAB_META.map((tab) => (
            <Tooltip
              key={tab.id}
              label={tab.label}
              {...(tab.actionId ? { actionId: tab.actionId } : {})}
              side="left"
            >
              <button
                id={`utility-rail-tab-${tab.id}`}
                className={[
                  'utility-icon-btn',
                  selectedTab === tab.id && 'active',
                ]
                  .filter(Boolean)
                  .join(' ')}
                type="button"
                role="tab"
                aria-selected={selectedTab === tab.id}
                aria-controls={`utility-rail-panel-${tab.id}`}
                aria-label={tab.label}
                onClick={() => handleTabClick(tab.id)}
                onKeyDown={(event) => handleTabKeyDown(event, tab.id)}
              >
                {tab.icon}
              </button>
            </Tooltip>
          ))}
        </div>
      </div>
    </div>
  );
}

export default WorkspaceUtilityRail;
