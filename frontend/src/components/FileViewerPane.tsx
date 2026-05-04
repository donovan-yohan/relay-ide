import React, { useCallback, useMemo } from 'react';
import { fileTabKey, useUiStore } from '../lib/stores/ui.js';
import type { OpenFileTab } from '../lib/stores/ui.js';
import { useSessionsStore } from '../lib/stores/sessions.js';
import { diffSourceToBase } from '../lib/diff-utils.js';
import { FileTabContent, type FileTabContentProps } from './FileTabContent.js';
import { useFileDiff, useInvalidateFileDiff } from '../hooks/useFileDiff.js';
import { useFileContent } from '../hooks/useFileContent.js';
import './FileViewerPane.css';

// ── Types ────────────────────────────────────────────────────────────────────

export interface FileViewerPaneProps {
  workspacePath: string;
  onInjectReference?: (reference: string) => void;
  renderDiff?: FileTabContentProps['renderDiff'];
  renderCode?: FileTabContentProps['renderCode'];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const CLOSE_SVG = (
  <svg
    width="10"
    height="10"
    viewBox="0 0 10 10"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="square"
    aria-hidden="true"
  >
    <path d="M2 2l6 6M8 2l-6 6" />
  </svg>
);

const GLOBE_SVG = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 14 14"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="square"
    aria-hidden="true"
  >
    <circle cx="7" cy="7" r="5.5" />
    <path d="M1.5 7h11M7 1.5c-1.5 2-2 3.5-2 5.5s.5 3.5 2 5.5M7 1.5c1.5 2 2 3.5 2 5.5s-.5 3.5-2 5.5" />
  </svg>
);

// ── useActiveSession hook (used for the "send to" pill in the tab bar) ───────

function useActiveSession() {
  const sessions = useSessionsStore((s) => s.sessions);
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const sendToTargetSessionId = useUiStore((s) => s.sendToTargetSessionId);
  const targetId = sendToTargetSessionId ?? activeSessionId;
  const activeSessionName = useMemo(() => {
    if (!targetId) return 'no sessions';
    const session = sessions.find((s) => s.id === targetId);
    return session?.displayName ?? session?.branchName ?? 'session';
  }, [targetId, sessions]);
  return { hasActiveSession: targetId !== null, activeSessionName };
}

// ── Sub-components ────────────────────────────────────────────────────────────

interface TabItemProps {
  tab: OpenFileTab;
  isActive: boolean;
  onTabClick: (tab: OpenFileTab) => void;
  onCloseTab: (tab: OpenFileTab, e: React.MouseEvent) => void;
}

function TabItem({ tab, isActive, onTabClick, onCloseTab }: TabItemProps) {
  return (
    <div
      className={['file-tab', isActive ? 'active' : '']
        .filter(Boolean)
        .join(' ')}
      role="tab"
      tabIndex={0}
      aria-selected={isActive}
      onClick={() => onTabClick(tab)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onTabClick(tab);
      }}
      title={tab.filePath}
    >
      {tab.tabType === 'html' && <span className="tab-icon">{GLOBE_SVG}</span>}
      <span className="tab-name">{tab.fileName}</span>
      {tab.isChanged && <span className="tab-badge">M</span>}
      <button
        className="tab-close"
        onClick={(e) => onCloseTab(tab, e)}
        aria-label={`close ${tab.fileName}`}
      >
        {CLOSE_SVG}
      </button>
    </div>
  );
}

// ── useFileViewerHandlers hook ────────────────────────────────────────────────

function useFileViewerHandlers(
  workspacePath: string,
  activeTab: OpenFileTab | undefined,
  base: string | null
) {
  const closeFileTab = useUiStore((s) => s.closeFileTab);
  const closeAllFileTabs = useUiStore((s) => s.closeAllFileTabs);
  const refreshHtmlTab = useUiStore((s) => s.refreshHtmlTab);
  const setFileDiffViewMode = useUiStore((s) => s.setFileDiffViewMode);
  const setFileWordWrap = useUiStore((s) => s.setFileWordWrap);
  const fileDiffViewMode = useUiStore((s) => s.fileDiffViewMode);
  const fileWordWrap = useUiStore((s) => s.fileWordWrap);
  const invalidateFileDiff = useInvalidateFileDiff();

  const handleCloseTab = useCallback(
    (tab: OpenFileTab, e: React.MouseEvent) => {
      e.stopPropagation();
      closeFileTab(tab.filePath, tab.tabType);
      invalidateFileDiff({ workspacePath, filePath: tab.filePath, base });
    },
    [closeFileTab, invalidateFileDiff, workspacePath, base]
  );

  const handleTabClick = useCallback((tab: OpenFileTab) => {
    useUiStore.setState({
      activeFileTabKey: fileTabKey(tab.filePath, tab.tabType),
    });
  }, []);

  const handleRetry = useCallback(() => {
    if (activeTab) {
      invalidateFileDiff({
        workspacePath,
        filePath: activeTab.filePath,
        base,
      });
    }
  }, [activeTab, base, invalidateFileDiff, workspacePath]);

  const handleRefresh = useCallback(() => {
    if (activeTab?.tabType === 'html' && activeTab.filePath) {
      refreshHtmlTab(activeTab.filePath);
    }
  }, [activeTab, refreshHtmlTab]);

  const handleCloseActiveTab = useCallback(() => {
    if (!activeTab) return;
    closeFileTab(activeTab.filePath, activeTab.tabType);
    invalidateFileDiff({ workspacePath, filePath: activeTab.filePath, base });
  }, [activeTab, base, closeFileTab, invalidateFileDiff, workspacePath]);

  const handleToggleDiffViewMode = useCallback(() => {
    setFileDiffViewMode(
      fileDiffViewMode === 'unified' ? 'side-by-side' : 'unified'
    );
  }, [fileDiffViewMode, setFileDiffViewMode]);

  const handleToggleWordWrap = useCallback(() => {
    setFileWordWrap(!fileWordWrap);
  }, [fileWordWrap, setFileWordWrap]);

  return {
    handleCloseTab,
    handleTabClick,
    handleRetry,
    handleRefresh,
    handleCloseActiveTab,
    handleToggleDiffViewMode,
    handleToggleWordWrap,
    closeAllFileTabs,
    fileDiffViewMode,
    fileWordWrap,
  };
}

// ── Main Component ────────────────────────────────────────────────────────────

export function FileViewerPane({
  workspacePath,
  onInjectReference,
  renderDiff,
  renderCode,
}: FileViewerPaneProps) {
  const openFileTabs = useUiStore((s) => s.openFileTabs);
  const activeFileTabKey = useUiStore((s) => s.activeFileTabKey);
  const fileDiffSource = useUiStore((s) => s.fileDiffSource);
  const fileDiffDefaultBranch = useUiStore((s) => s.fileDiffDefaultBranch);
  const base = useMemo(
    () => diffSourceToBase(fileDiffSource, fileDiffDefaultBranch) ?? null,
    [fileDiffSource, fileDiffDefaultBranch]
  );
  const activeTab = useMemo(
    () =>
      openFileTabs.find(
        (t) => fileTabKey(t.filePath, t.tabType) === activeFileTabKey
      ),
    [openFileTabs, activeFileTabKey]
  );

  const { hasActiveSession, activeSessionName } = useActiveSession();
  const handlers = useFileViewerHandlers(workspacePath, activeTab, base);
  const {
    handleCloseTab,
    handleTabClick,
    handleRetry,
    handleRefresh,
    handleCloseActiveTab,
    handleToggleDiffViewMode,
    handleToggleWordWrap,
    closeAllFileTabs,
    fileDiffViewMode,
    fileWordWrap,
  } = handlers;

  const isDiffActive = activeTab?.tabType === 'diff';
  const isCodeActive =
    Boolean(activeTab) &&
    activeTab?.tabType !== 'html' &&
    activeTab?.tabType !== 'diff';

  const {
    diff: activeDiff,
    loading: diffLoading,
    error: diffError,
  } = useFileDiff(
    {
      workspacePath,
      filePath: activeTab?.filePath ?? '',
      base,
    },
    { enabled: isDiffActive }
  );
  const {
    content: activeContent,
    binary: activeBinary,
    truncated: activeTruncated,
    loading: contentLoading,
    error: contentError,
  } = useFileContent(
    { workspacePath, filePath: activeTab?.filePath ?? '' },
    { enabled: isCodeActive }
  );
  const activeLoading = isDiffActive
    ? diffLoading
    : isCodeActive
      ? contentLoading
      : false;
  const activeError = isDiffActive
    ? diffError
    : isCodeActive
      ? contentError
      : null;

  return (
    <div className="file-viewer">
      <div className="file-tab-bar">
        <div className="tabs-scroll">
          {openFileTabs.map((tab) => (
            <TabItem
              key={fileTabKey(tab.filePath, tab.tabType)}
              tab={tab}
              isActive={
                activeFileTabKey === fileTabKey(tab.filePath, tab.tabType)
              }
              onTabClick={handleTabClick}
              onCloseTab={handleCloseTab}
            />
          ))}
        </div>
        <div className="tab-bar-actions">
          <button className="diff-mode-btn" onClick={handleToggleWordWrap}>
            {fileWordWrap ? '[nowrap]' : '[wrap]'}
          </button>
          {activeTab?.isChanged && (
            <button
              className="diff-mode-btn"
              onClick={handleToggleDiffViewMode}
            >
              {fileDiffViewMode === 'unified' ? '[split]' : '[unified]'}
            </button>
          )}
          {activeTab?.tabType === 'html' && (
            <button className="refresh-btn" onClick={handleRefresh}>
              [refresh]
            </button>
          )}
          {openFileTabs.length > 1 && (
            <button className="close-all-btn" onClick={closeAllFileTabs}>
              close all
            </button>
          )}
          <div
            className={['send-to-pill', !hasActiveSession ? 'disabled' : '']
              .filter(Boolean)
              .join(' ')}
          >
            <span className="send-to-label">send to:</span>
            <span className="send-to-target">{activeSessionName}</span>
          </div>
        </div>
      </div>
      {activeTab ? (
        <FileTabContent
          filePath={activeTab.filePath}
          fileName={activeTab.fileName}
          tabType={activeTab.tabType}
          token={activeTab.token}
          isChanged={activeTab.isChanged}
          refreshVersion={activeTab.refreshVersion}
          diff={activeDiff}
          content={activeContent}
          binary={activeBinary}
          truncated={activeTruncated}
          loading={activeLoading}
          error={activeError}
          diffViewMode={fileDiffViewMode}
          wordWrap={fileWordWrap}
          hasActiveSession={hasActiveSession}
          onInjectReference={onInjectReference}
          onRetry={handleRetry}
          onCloseTab={handleCloseActiveTab}
          renderDiff={renderDiff}
          renderCode={renderCode}
          showSummary={false}
        />
      ) : (
        <div className="file-content" role="tabpanel">
          <div className="empty-viewer">select a file from the sidebar</div>
        </div>
      )}
    </div>
  );
}

export default FileViewerPane;
