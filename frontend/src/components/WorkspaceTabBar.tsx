import React from 'react';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import {
  workspaceTabId,
  type WorkspacePane,
  type WorkspaceTab,
  type WorkspaceTabId,
} from '../lib/workspace-layout.js';
import {
  summaryForTab,
  type SummaryContext,
  type WorkspaceTabSummary,
} from '../lib/workspace-summary.js';
import { scopedSessionKey } from '../lib/session-keys.js';
import { SessionMailboxBadge } from './SessionMailboxPanel.js';
import './WorkspaceTabBar.css';

const ICON_GLYPH: Record<WorkspaceTabSummary['icon'], string> = {
  'session-terminal': '›_',
  'file-tsx': '⟨⟩',
  'file-ts': 'TS',
  'file-jsx': '⟨⟩',
  'file-js': 'JS',
  'file-py': 'PY',
  'file-rs': 'RS',
  'file-go': 'GO',
  'file-css': '#',
  'file-html': '<>',
  'file-md': 'MD',
  'file-json': '{}',
  'file-generic': '·',
  'file-diff': '±',
  'file-html-preview': '⌬',
};

interface WorkspaceTabItemProps {
  tab: WorkspaceTab;
  paneId: string;
  isActive: boolean;
  summary: WorkspaceTabSummary;
  summaryContext: SummaryContext;
  onSelect: () => void;
  onClose: () => void;
}

function WorkspaceTabItem({
  tab,
  paneId,
  isActive,
  summary,
  summaryContext,
  onSelect,
  onClose,
}: WorkspaceTabItemProps) {
  const tabId = workspaceTabId(tab);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: tabId,
    data: { type: 'tab', tabId, sourcePaneId: paneId },
  });

  const className = [
    'ws-tab',
    isActive ? 'ws-tab--active' : '',
    isDragging ? 'ws-tab--dragging' : '',
    `ws-tab--${tab.kind}`,
  ]
    .filter(Boolean)
    .join(' ');
  const session =
    tab.kind === 'session'
      ? summaryContext.findSession?.(tab.sessionId)
      : undefined;

  return (
    <div
      ref={setNodeRef}
      className={className}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      title={summary.primary}
      {...attributes}
      {...listeners}
      role="tab"
      tabIndex={0}
      aria-selected={isActive}
    >
      <span
        className={`ws-tab__icon ws-tab__icon--${summary.icon}`}
        aria-hidden
      >
        {ICON_GLYPH[summary.icon]}
      </span>
      <span className="ws-tab__name">{summary.primary}</span>
      {summary.meta && <span className="ws-tab__meta">{summary.meta}</span>}
      {tab.kind === 'session' && session && (
        <SessionMailboxBadge
          targetSessionId={scopedSessionKey(session)}
          label="inbox"
        />
      )}
      {summary.nodeBadge && (
        <span
          className={`ws-tab__node ws-tab__node--${summary.nodeBadge.status}`}
          title={`node: ${summary.nodeBadge.label} (${summary.nodeBadge.status})`}
        >
          <span
            className={`ws-tab__node-dot ws-tab__node-dot--${summary.nodeBadge.status}`}
            aria-hidden
          />
          <span className="ws-tab__node-label">{summary.nodeBadge.label}</span>
        </span>
      )}
      {summary.dot && (
        <span
          className={`ws-tab__dot ws-tab__dot--${summary.dot}`}
          aria-hidden
        />
      )}
      <button
        type="button"
        className="ws-tab__close"
        aria-label={`close ${summary.primary}`}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.stopPropagation();
            e.preventDefault();
            onClose();
          }
        }}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        ×
      </button>
    </div>
  );
}

export interface WorkspaceTabBarProps {
  pane: WorkspacePane;
  summaryContext: SummaryContext;
  onSelectTab: (tabId: WorkspaceTabId) => void;
  onCloseTab: (tabId: WorkspaceTabId) => void;
  onAddTabRequest?: () => void;
  /** Optional render-prop for the add-tab control (e.g. a node picker). */
  renderAddControl?: () => React.ReactNode;
}

export function WorkspaceTabBar({
  pane,
  summaryContext,
  onSelectTab,
  onCloseTab,
  onAddTabRequest,
  renderAddControl,
}: WorkspaceTabBarProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: `tabbar:${pane.id}`,
    data: { type: 'tabbar', paneId: pane.id },
  });

  return (
    <div
      ref={setNodeRef}
      className={['ws-tabs', isOver ? 'ws-tabs--drop-target' : '']
        .filter(Boolean)
        .join(' ')}
      role="tablist"
    >
      {pane.tabs.map((tab) => {
        const tabId = workspaceTabId(tab);
        const summary = summaryForTab(tab, summaryContext);
        return (
          <WorkspaceTabItem
            key={tabId}
            tab={tab}
            paneId={pane.id}
            isActive={pane.activeTabId === tabId}
            summary={summary}
            summaryContext={summaryContext}
            onSelect={() => onSelectTab(tabId)}
            onClose={() => onCloseTab(tabId)}
          />
        );
      })}
      {renderAddControl
        ? renderAddControl()
        : onAddTabRequest && (
            <button
              type="button"
              className="ws-tabs__add"
              aria-label="add tab"
              onClick={onAddTabRequest}
            >
              +
            </button>
          )}
      <span className="ws-tabs__spacer" aria-hidden />
    </div>
  );
}

export default WorkspaceTabBar;
