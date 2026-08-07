import React, { memo, useEffect, useRef } from 'react';
import {
  workspaceTabId,
  type WorkspacePane as PaneModel,
  type WorkspaceTab,
  type WorkspaceTabId,
} from '../lib/workspace-layout.js';
import {
  registerPaneBodyEl,
  useWorkspaceLayoutStore,
} from '../lib/stores/workspace-layout-store.js';
import {
  summaryForTab,
  type SummaryContext,
  type WorkspaceTabSummary,
} from '../lib/workspace-summary.js';
import { WorkspaceTabBar } from './WorkspaceTabBar.js';
import { WorkspaceDropOverlay } from './WorkspaceDropOverlay.js';
import InterventionStrip from './InterventionStrip.js';
import './WorkspacePane.css';

interface WorkspacePaneSummaryStripProps {
  tab: WorkspaceTab;
  summary: WorkspaceTabSummary;
  summaryContext: SummaryContext;
}

function WorkspacePaneSummaryStrip({
  tab,
  summary,
  summaryContext,
}: WorkspacePaneSummaryStripProps) {
  if (tab.kind === 'file') {
    const segments = summary.breadcrumb?.segments ?? [];
    return (
      <div className="ws-pane__summary ws-pane__summary--file">
        <div className="ws-pane__summary-crumb">
          {summary.breadcrumb?.repoLabel && (
            <span
              className="ws-pane__summary-repo"
              style={
                summary.breadcrumb.repoColor
                  ? { background: summary.breadcrumb.repoColor }
                  : undefined
              }
            >
              {summary.breadcrumb.repoLabel}
            </span>
          )}
          {segments.map((seg, i) => {
            const last = i === segments.length - 1;
            return (
              <React.Fragment key={`${seg}-${i}`}>
                <span
                  className={[
                    'ws-pane__summary-seg',
                    last ? 'ws-pane__summary-seg--name' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  {seg}
                </span>
                {!last && <span className="ws-pane__summary-sep">/</span>}
              </React.Fragment>
            );
          })}
        </div>
        <div className="ws-pane__summary-pills">
          {summary.pills.map((pill, i) => (
            <span
              key={`${pill.label}-${i}`}
              className={`ws-pane__summary-pill ws-pane__summary-pill--${pill.kind}`}
            >
              {pill.kind === 'dirty' && (
                <span className="ws-pane__summary-pill-dot" />
              )}
              {pill.label}
            </span>
          ))}
        </div>
      </div>
    );
  }
  const session = summaryContext.findSession?.(tab.sessionId);
  return (
    <>
      <div className="ws-pane__summary ws-pane__summary--session">
        <span className="ws-pane__summary-title">{summary.primary}</span>
        {summary.meta && (
          <span className="ws-pane__summary-meta">{summary.meta}</span>
        )}
        {summary.dot && (
          <span
            className={`ws-pane__summary-dot ws-pane__summary-dot--${summary.dot}`}
          />
        )}
      </div>
      <InterventionStrip session={session} />
    </>
  );
}

export interface WorkspacePaneProps {
  pane: PaneModel;
  isActive: boolean;
  isDragActive: boolean;
  summaryContext: SummaryContext;
  onAddTabRequest?: (paneId: string) => void;
  renderAddControl?: (paneId: string) => React.ReactNode;
}

function WorkspacePaneImpl({
  pane,
  isActive,
  isDragActive,
  summaryContext,
  onAddTabRequest,
  renderAddControl,
}: WorkspacePaneProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const selectTab = useWorkspaceLayoutStore((s) => s.selectTab);
  const closeTab = useWorkspaceLayoutStore((s) => s.closeTab);
  const setActivePane = useWorkspaceLayoutStore((s) => s.setActivePane);

  useEffect(() => {
    registerPaneBodyEl(pane.id, bodyRef.current);
    return () => registerPaneBodyEl(pane.id, null);
  }, [pane.id]);

  const activeTab = pane.tabs.find(
    (t) => workspaceTabId(t) === pane.activeTabId
  );
  const activeSummary = activeTab
    ? summaryForTab(activeTab, summaryContext)
    : null;

  const handleSelect = (tabId: WorkspaceTabId) => selectTab(pane.id, tabId);
  const handleClose = (tabId: WorkspaceTabId) => {
    closeTab(tabId);
  };

  return (
    <div
      className={['ws-pane', isActive ? 'ws-pane--active' : '']
        .filter(Boolean)
        .join(' ')}
      onMouseDown={() => {
        if (!isActive) setActivePane(pane.id);
      }}
    >
      <WorkspaceTabBar
        pane={pane}
        summaryContext={summaryContext}
        onSelectTab={handleSelect}
        onCloseTab={handleClose}
        {...(onAddTabRequest
          ? { onAddTabRequest: () => onAddTabRequest(pane.id) }
          : {})}
        {...(renderAddControl
          ? { renderAddControl: () => renderAddControl(pane.id) }
          : {})}
      />
      {activeTab && activeSummary && (
        <WorkspacePaneSummaryStrip
          tab={activeTab}
          summary={activeSummary}
          summaryContext={summaryContext}
        />
      )}
      <div className="ws-pane__body-wrap">
        <div className="ws-pane__body" ref={bodyRef} role="tabpanel">
          {!activeTab && (
            <div className="ws-pane__empty">empty pane · drop a tab here</div>
          )}
        </div>
      </div>
      <WorkspaceDropOverlay paneId={pane.id} active={isDragActive} />
    </div>
  );
}

export const WorkspacePane = memo(WorkspacePaneImpl);
export default WorkspacePane;
