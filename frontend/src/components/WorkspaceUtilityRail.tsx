import React, { useCallback, useEffect, useEffectEvent } from 'react';
import type { SessionSummary } from '../lib/types.js';
import {
  useUiStore,
  type UtilityRailTab,
  type WorkspaceUtilityRailState,
  UTILITY_ICON_RAIL_WIDTH,
} from '../lib/stores/ui.js';
import type { FileTreeHandle } from './FileTree/index.js';
import type {
  UtilityRailDisabledReason,
  UtilityRailResourceContext,
} from '../lib/utility-rail-context.js';
import UtilityRailFilesPanel from './UtilityRailFilesPanel.js';
import UtilityRailGitChangesPanel from './UtilityRailGitChangesPanel.js';
import UtilityRailBranchPanel from './UtilityRailBranchPanel.js';
import UtilityRailReviewPanel from './UtilityRailReviewPanel.js';
import UtilityRailLogsPanel from './UtilityRailLogsPanel.js';
import UtilityRailStatsPanel from './UtilityRailStatsPanel.js';
import Terminal from './Terminal.js';
import Tooltip from './Tooltip.js';
import { getUtilityTerminalTitle } from '../lib/utility-terminals.js';
import { scopedSessionKey } from '../lib/session-keys.js';
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
  {
    id: 'terminal',
    label: 'terminal',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 17l6-6-6-6" />
        <path d="M12 19h8" />
      </svg>
    ),
  },
];

export interface WorkspaceUtilityRailProps {
  /** Key used for persisted rail UI state. */
  workspacePath: string;
  /**
   * Paths/capabilities used by resource-fetching panels. Defaults to
   * workspacePath for local legacy behavior.
   */
  resourceContext?: UtilityRailResourceContext;
  railState: WorkspaceUtilityRailState;
  activeSession?: SessionSummary | undefined;
  workspaceSessions: SessionSummary[];
  utilityTerminalSessions?: SessionSummary[];
  fileTreeSidebarRef?: React.RefObject<FileTreeHandle | null>;
  onCreateUtilityTerminal?: () => void | Promise<void>;
  onSelectUtilityTerminal?: (sessionId: string) => void;
  onCloseUtilityTerminal?: (sessionId: string) => void | Promise<void>;
  onPromoteUtilityTerminal?: (sessionId: string) => void;
  onImageUpload?: (text: string, showInsert: boolean, path?: string) => void;
  onCopyModeChange?: (active: boolean) => void;
  onFilePathClick?: (path: string) => void;
}

interface UtilityRailDisabledStateProps {
  reason: UtilityRailDisabledReason;
  displayWorkspacePath: string;
}

function disabledStateCopy(
  reason: UtilityRailDisabledReason
): { title: string; detail: string } {
  switch (reason) {
    case 'remote-files-unavailable':
      return {
        title: 'remote files unavailable',
        detail: 'remote file browsing is disabled until remote file rpc lands.',
      };
    case 'remote-git-unavailable':
      return {
        title: 'remote git unavailable',
        detail: 'git panels are disabled for remote tabs until remote file rpc lands.',
      };
    case 'no-git-context':
      return {
        title: 'no git context',
        detail: 'git panels are available on repo and worktree tabs.',
      };
    case 'no-workspace-context':
      return {
        title: 'no workspace context',
        detail: 'select a repo, worktree, or local folder tab first.',
      };
  }
}

function UtilityRailDisabledState({
  reason,
  displayWorkspacePath,
}: UtilityRailDisabledStateProps) {
  const copy = disabledStateCopy(reason);
  return (
    <div className="utility-empty" role="status">
      <p>{copy.title}</p>
      <span className="utility-muted">{copy.detail}</span>
      {displayWorkspacePath ? (
        <span className="utility-muted">{displayWorkspacePath}</span>
      ) : null}
    </div>
  );
}

interface UtilityRailTerminalPanelProps {
  workspacePath: string;
  railState: WorkspaceUtilityRailState;
  sessions: SessionSummary[];
  onCreateUtilityTerminal?: () => void | Promise<void>;
  onSelectUtilityTerminal?: (sessionId: string) => void;
  onCloseUtilityTerminal?: (sessionId: string) => void | Promise<void>;
  onPromoteUtilityTerminal?: (sessionId: string) => void;
  onImageUpload?: (text: string, showInsert: boolean, path?: string) => void;
  onCopyModeChange?: (active: boolean) => void;
  onFilePathClick?: (path: string) => void;
}

function UtilityRailTerminalPanel({
  workspacePath,
  railState,
  sessions,
  onCreateUtilityTerminal,
  onSelectUtilityTerminal,
  onCloseUtilityTerminal,
  onPromoteUtilityTerminal,
  onImageUpload,
  onCopyModeChange,
  onFilePathClick,
}: UtilityRailTerminalPanelProps) {
  const selectedSession =
    sessions.find(
      (session) => session.id === railState.selectedUtilityTerminalId
    ) ?? sessions[0];
  const notifyCopyModeInactive = useEffectEvent(() => {
    onCopyModeChange?.(false);
  });

  useEffect(() => {
    return () => notifyCopyModeInactive();
  }, []);

  const handleTerminalTabKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
      if (sessions.length === 0) return;
      let nextIndex: number | null = null;
      if (event.key === 'ArrowRight') {
        nextIndex = (index + 1) % sessions.length;
      } else if (event.key === 'ArrowLeft') {
        nextIndex = (index - 1 + sessions.length) % sessions.length;
      } else if (event.key === 'Home') {
        nextIndex = 0;
      } else if (event.key === 'End') {
        nextIndex = sessions.length - 1;
      }
      if (nextIndex === null) return;
      event.preventDefault();
      const nextSession = sessions[nextIndex];
      if (!nextSession) return;
      onSelectUtilityTerminal?.(nextSession.id);
      requestAnimationFrame(() => {
        document
          .getElementById(`utility-terminal-tab-${nextSession.id}`)
          ?.focus();
      });
    },
    [onSelectUtilityTerminal, sessions]
  );

  return (
    <div className="utility-terminal-panel">
      <div className="utility-terminal-toolbar">
        <div
          className="utility-terminal-tabs"
          role="tablist"
          aria-label="utility terminals"
        >
          {sessions.map((session, index) => {
            const title = getUtilityTerminalTitle(
              session,
              index,
              workspacePath
            );
            const selected = session.id === selectedSession?.id;
            return (
              <div
                key={session.id}
                className={[
                  'utility-terminal-tab-shell',
                  selected && 'utility-terminal-tab-shell--active',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <button
                  id={`utility-terminal-tab-${session.id}`}
                  className="utility-terminal-tab"
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-label={title}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => onSelectUtilityTerminal?.(session.id)}
                  onKeyDown={(event) => handleTerminalTabKeyDown(event, index)}
                >
                  <span className="utility-terminal-title">{title}</span>
                </button>
                <button
                  className="utility-terminal-close"
                  type="button"
                  aria-label={`close ${title}`}
                  onClick={() => void onCloseUtilityTerminal?.(session.id)}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
        <button
          className="utility-panel-btn"
          type="button"
          onClick={() => void onCreateUtilityTerminal?.()}
        >
          + terminal
        </button>
      </div>
      {selectedSession ? (
        <>
          <div className="utility-terminal-actions">
            <button
              className="utility-panel-btn"
              type="button"
              onClick={() => onPromoteUtilityTerminal?.(selectedSession.id)}
            >
              promote
            </button>
          </div>
          <div className="utility-terminal-body">
            <Terminal
              sessionId={selectedSession.id}
              sessionKey={scopedSessionKey(selectedSession)}
              useTmux={selectedSession.useTmux !== false}
              {...(onImageUpload ? { onImageUpload } : {})}
              {...(onCopyModeChange ? { onCopyModeChange } : {})}
              {...(onFilePathClick ? { onFilePathClick } : {})}
            />
          </div>
        </>
      ) : (
        <div className="utility-empty">
          <p>no utility terminals yet.</p>
          <button
            className="utility-panel-btn"
            type="button"
            onClick={() => void onCreateUtilityTerminal?.()}
          >
            + terminal
          </button>
        </div>
      )}
    </div>
  );
}

export function utilityRailRenderedWidth(
  state: WorkspaceUtilityRailState
): number {
  if (!state.visible) return 0;
  return UTILITY_ICON_RAIL_WIDTH + (state.selectedRailTab ? state.width : 0);
}

export function WorkspaceUtilityRail({
  workspacePath,
  resourceContext,
  railState,
  activeSession,
  workspaceSessions,
  utilityTerminalSessions = [],
  fileTreeSidebarRef,
  onCreateUtilityTerminal,
  onSelectUtilityTerminal,
  onCloseUtilityTerminal,
  onPromoteUtilityTerminal,
  onImageUpload,
  onCopyModeChange,
  onFilePathClick,
}: WorkspaceUtilityRailProps) {
  const setSelectedUtilityRailTab = useUiStore(
    (s) => s.setSelectedUtilityRailTab
  );
  const openUtilityRailTab = useUiStore((s) => s.openUtilityRailTab);
  const fullPageDiff = useUiStore((s) => s.fullPageDiff);
  const selectedTab = railState.selectedRailTab;
  const displayWorkspacePath =
    resourceContext?.displayWorkspacePath ?? workspacePath;
  const anchorLabel = resourceContext?.anchorLabel ?? displayWorkspacePath;
  const fileWorkspacePath = resourceContext?.files.workspacePath ?? workspacePath;
  const fileDisabledReason = resourceContext?.files.disabledReason ?? null;
  const gitWorkspacePath = resourceContext?.git.workspacePath ?? workspacePath;
  const gitDisabledReason = resourceContext?.git.disabledReason ?? null;
  const repoBadge =
    resourceContext?.repoBadge ?? (gitWorkspacePath ? 'repo' : null);

  const renderFilesPanel = () => {
    if (fileDisabledReason) {
      return (
        <UtilityRailDisabledState
          reason={fileDisabledReason}
          displayWorkspacePath={displayWorkspacePath}
        />
      );
    }
    return (
      <UtilityRailFilesPanel
        workspacePath={fileWorkspacePath}
        stateKey={workspacePath}
        {...(fileTreeSidebarRef ? { fileTreeSidebarRef } : {})}
      />
    );
  };

  const renderGitPanel = (
    panel: 'changes' | 'branch' | 'review'
  ): React.ReactNode => {
    if (gitDisabledReason) {
      return (
        <UtilityRailDisabledState
          reason={gitDisabledReason}
          displayWorkspacePath={displayWorkspacePath}
        />
      );
    }
    if (panel === 'changes') {
      return (
        <UtilityRailGitChangesPanel
          workspacePath={gitWorkspacePath}
          stateKey={workspacePath}
        />
      );
    }
    if (panel === 'branch') {
      return (
        <UtilityRailBranchPanel
          workspacePath={gitWorkspacePath}
          stateKey={workspacePath}
        />
      );
    }
    return (
      <UtilityRailReviewPanel
        workspacePath={gitWorkspacePath}
        stateKey={workspacePath}
        reviewState={railState.review}
        active={selectedTab === 'review' && !fullPageDiff}
      />
    );
  };

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
        <div className="utility-pane-context" title={displayWorkspacePath}>
          <span>{anchorLabel}</span>
          {repoBadge ? (
            <span className="utility-repo-badge">[{repoBadge}]</span>
          ) : null}
        </div>
        <div className="utility-pane-body">
          <div
            id="utility-rail-panel-files"
            className="utility-pane-panel"
            role="tabpanel"
            aria-labelledby="utility-rail-tab-files"
            tabIndex={selectedTab === 'files' ? 0 : -1}
            hidden={selectedTab !== 'files'}
          >
            {renderFilesPanel()}
          </div>
          <div
            id="utility-rail-panel-changes"
            className="utility-pane-panel"
            role="tabpanel"
            aria-labelledby="utility-rail-tab-changes"
            tabIndex={selectedTab === 'changes' ? 0 : -1}
            hidden={selectedTab !== 'changes'}
          >
            {renderGitPanel('changes')}
          </div>
          <div
            id="utility-rail-panel-branch"
            className="utility-pane-panel"
            role="tabpanel"
            aria-labelledby="utility-rail-tab-branch"
            tabIndex={selectedTab === 'branch' ? 0 : -1}
            hidden={selectedTab !== 'branch'}
          >
            {renderGitPanel('branch')}
          </div>
          <div
            id="utility-rail-panel-review"
            className="utility-pane-panel"
            role="tabpanel"
            aria-labelledby="utility-rail-tab-review"
            tabIndex={selectedTab === 'review' ? 0 : -1}
            hidden={selectedTab !== 'review'}
          >
            {renderGitPanel('review')}
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
          <div
            id="utility-rail-panel-terminal"
            className="utility-pane-panel"
            role="tabpanel"
            aria-labelledby="utility-rail-tab-terminal"
            tabIndex={selectedTab === 'terminal' ? 0 : -1}
            hidden={selectedTab !== 'terminal'}
          >
            {selectedTab === 'terminal' && (
              <UtilityRailTerminalPanel
                workspacePath={workspacePath}
                railState={railState}
                sessions={utilityTerminalSessions}
                {...(onCreateUtilityTerminal
                  ? { onCreateUtilityTerminal }
                  : {})}
                {...(onSelectUtilityTerminal
                  ? { onSelectUtilityTerminal }
                  : {})}
                {...(onCloseUtilityTerminal ? { onCloseUtilityTerminal } : {})}
                {...(onPromoteUtilityTerminal
                  ? { onPromoteUtilityTerminal }
                  : {})}
                {...(onImageUpload ? { onImageUpload } : {})}
                {...(onCopyModeChange ? { onCopyModeChange } : {})}
                {...(onFilePathClick ? { onFilePathClick } : {})}
              />
            )}
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
