import React, { useCallback } from 'react';
import type { SessionSummary } from '../lib/types.js';
import {
  useUiStore,
  type UtilityRailTab,
  type WorkspaceUtilityRailState,
  UTILITY_ICON_RAIL_WIDTH,
} from '../lib/stores/ui.js';
import type { FileTreeSidebarHandle } from './FileTreeSidebar.js';
import UtilityRailFilesPanel from './UtilityRailFilesPanel.js';
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
  changedFilesData: string[];
  onFileSelect: (filePath: string, isChanged: boolean) => void;
  activeSession?: SessionSummary | undefined;
  workspaceSessions: SessionSummary[];
  fileTreeSidebarRef?: React.RefObject<FileTreeSidebarHandle | null>;
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
  changedFilesData,
  onFileSelect,
  activeSession,
  workspaceSessions,
  fileTreeSidebarRef,
}: WorkspaceUtilityRailProps) {
  const setSelectedUtilityRailTab = useUiStore(
    (s) => s.setSelectedUtilityRailTab
  );
  const openUtilityRailTab = useUiStore((s) => s.openUtilityRailTab);

  const handleTabClick = useCallback(
    (tab: UtilityRailTab) => {
      if (railState.selectedRailTab === tab) {
        setSelectedUtilityRailTab(workspacePath, null);
      } else {
        openUtilityRailTab(workspacePath, tab);
      }
    },
    [
      openUtilityRailTab,
      railState.selectedRailTab,
      setSelectedUtilityRailTab,
      workspacePath,
    ]
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
      {railState.selectedRailTab ? (
        <div className="utility-selected-pane">
          <div className="utility-pane-header">
            <span className="utility-pane-title">
              {TAB_META.find((tab) => tab.id === railState.selectedRailTab)
                ?.label ?? railState.selectedRailTab}
            </span>
          </div>
          <div className="utility-pane-body">
            {railState.selectedRailTab === 'files' ? (
              <UtilityRailFilesPanel
                workspacePath={workspacePath}
                changedFilesData={changedFilesData}
                onFileSelect={onFileSelect}
                {...(fileTreeSidebarRef ? { fileTreeSidebarRef } : {})}
              />
            ) : null}
            {railState.selectedRailTab === 'review' ? (
              <UtilityRailReviewPanel workspacePath={workspacePath} />
            ) : null}
            {railState.selectedRailTab === 'logs' ? (
              <UtilityRailLogsPanel activeSession={activeSession} />
            ) : null}
            {railState.selectedRailTab === 'stats' ? (
              <UtilityRailStatsPanel
                activeSession={activeSession}
                workspaceSessions={workspaceSessions}
              />
            ) : null}
          </div>
        </div>
      ) : null}
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
                className={[
                  'utility-icon-btn',
                  railState.selectedRailTab === tab.id && 'active',
                ]
                  .filter(Boolean)
                  .join(' ')}
                type="button"
                role="tab"
                aria-selected={railState.selectedRailTab === tab.id}
                aria-label={tab.label}
                onClick={() => handleTabClick(tab.id)}
              >
                {tab.icon}
              </button>
            </Tooltip>
          ))}
        </div>
        <Tooltip label="more utility tools" side="left">
          <button
            className="utility-icon-btn utility-icon-btn--bottom"
            type="button"
            aria-label="more utility tools"
          >
            ...
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

export default WorkspaceUtilityRail;
