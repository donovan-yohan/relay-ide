import React, { useCallback, useEffect, useMemo } from 'react';
import { fileTabKey, useUiStore } from '../lib/stores/ui.js';
import type { OpenFileTab } from '../lib/stores/ui.js';
import { useSessionsStore } from '../lib/stores/sessions.js';
import { diffSourceToBase } from '../lib/diff-utils.js';
import {
  buildCacheKey,
  FileTabContent,
  useFileDiffCache,
  type FileTabContentProps,
} from './FileTabContent.js';
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
  activeTab: OpenFileTab | undefined,
  base: string | null,
  clearEntry: (key: string) => void
) {
  const closeFileTab = useUiStore((s) => s.closeFileTab);
  const closeAllFileTabs = useUiStore((s) => s.closeAllFileTabs);
  const refreshHtmlTab = useUiStore((s) => s.refreshHtmlTab);
  const setFileDiffViewMode = useUiStore((s) => s.setFileDiffViewMode);
  const setFileWordWrap = useUiStore((s) => s.setFileWordWrap);
  const fileDiffViewMode = useUiStore((s) => s.fileDiffViewMode);
  const fileWordWrap = useUiStore((s) => s.fileWordWrap);

  const handleCloseTab = useCallback(
    (tab: OpenFileTab, e: React.MouseEvent) => {
      e.stopPropagation();
      closeFileTab(tab.filePath, tab.tabType);
      clearEntry(buildCacheKey(tab.filePath, base));
    },
    [closeFileTab, clearEntry, base]
  );

  const handleTabClick = useCallback((tab: OpenFileTab) => {
    useUiStore.setState({
      activeFileTabKey: fileTabKey(tab.filePath, tab.tabType),
    });
  }, []);

  const handleRetry = useCallback(() => {
    if (activeTab) clearEntry(buildCacheKey(activeTab.filePath, base));
  }, [activeTab, base, clearEntry]);

  const handleRefresh = useCallback(() => {
    if (activeTab?.tabType === 'html' && activeTab.filePath) {
      refreshHtmlTab(activeTab.filePath);
    }
  }, [activeTab, refreshHtmlTab]);

  const handleCloseActiveTab = useCallback(() => {
    if (activeTab) closeFileTab(activeTab.filePath, activeTab.tabType);
  }, [activeTab, closeFileTab]);

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

  const { diffCache, loadingPaths, errorPaths, fetchDiff, clearEntry } =
    useFileDiffCache(workspacePath);
  const { hasActiveSession, activeSessionName } = useActiveSession();
  const handlers = useFileViewerHandlers(activeTab, base, clearEntry);
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

  const activeCacheKey = activeTab
    ? buildCacheKey(activeTab.filePath, base)
    : null;
  const activeDiff = activeCacheKey
    ? (diffCache.get(activeCacheKey) ?? '')
    : '';
  const activeLoading = activeCacheKey
    ? loadingPaths.has(activeCacheKey)
    : false;
  const activeError = activeCacheKey
    ? (errorPaths.get(activeCacheKey) ?? null)
    : null;

  useEffect(() => {
    if (!activeTab || activeTab.tabType === 'html') return;
    fetchDiff(activeTab.filePath, base);
  }, [activeTab?.filePath, activeTab?.tabType, base, fetchDiff]);

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
