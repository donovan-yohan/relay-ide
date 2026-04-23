import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useUiStore, fileTabKey } from '../lib/stores/ui.js';
import type { OpenFileTab } from '../lib/stores/ui.js';
import { useSessionsStore } from '../lib/stores/sessions.js';
import { fetchFileDiff } from '../lib/api.js';
import { diffSourceToBase } from '../lib/diff-utils.js';
import { parseLineReference } from '../lib/file-tree-utils.js';
import DiffViewer from './DiffViewer.js';
import CodeBlock from './CodeBlock.js';
import './FileViewerPane.css';

// ── Types ────────────────────────────────────────────────────────────────────

export interface FileViewerPaneProps {
  workspacePath: string;
  onInjectReference?: (reference: string) => void;
  renderDiff?: (props: {
    diff: string;
    filePath: string;
    mode: 'unified' | 'side-by-side';
    wordWrap: boolean;
  }) => React.ReactNode;
  renderCode?: (props: { code: string; language: string }) => React.ReactNode;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const CLOSE_SVG = (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
    stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" aria-hidden="true">
    <path d="M2 2l6 6M8 2l-6 6" />
  </svg>
);

const GLOBE_SVG = (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none"
    stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" aria-hidden="true">
    <circle cx="7" cy="7" r="5.5" />
    <path d="M1.5 7h11M7 1.5c-1.5 2-2 3.5-2 5.5s.5 3.5 2 5.5M7 1.5c1.5 2 2 3.5 2 5.5s-.5 3.5-2 5.5" />
  </svg>
);

function languageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
    py: 'python', rs: 'rust', go: 'go', rb: 'ruby',
    css: 'css', scss: 'scss', html: 'html', svelte: 'svelte',
    json: 'json', yaml: 'yaml', yml: 'yaml', md: 'markdown',
    sh: 'bash', bash: 'bash', sql: 'sql', graphql: 'graphql',
  };
  return map[ext] ?? 'text';
}

function buildCacheKey(filePath: string, base: string | null): string {
  return `${filePath}::${base ?? 'working'}`;
}

// ── useDiffCache hook ─────────────────────────────────────────────────────────

function useDiffCache(workspacePath: string) {
  const [diffCache, setDiffCache] = useState<Map<string, string>>(new Map());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [errorPaths, setErrorPaths] = useState<Map<string, string>>(new Map());

  const fetchDiff = useCallback((filePath: string, base: string | null) => {
    const key = buildCacheKey(filePath, base);
    if (diffCache.has(key) || loadingPaths.has(key)) return;
    setLoadingPaths((prev) => new Set([...prev, key]));
    fetchFileDiff(workspacePath, filePath, base ?? undefined).then(
      (result) => {
        if (result.error) {
          setErrorPaths((prev) => new Map([...prev, [key, result.error as string]]));
        } else {
          setDiffCache((prev) => new Map([...prev, [key, result.diff]]));
        }
      },
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : 'failed to load diff';
        setErrorPaths((prev) => new Map([...prev, [key, msg]]));
      }
    ).finally(() => {
      setLoadingPaths((prev) => { const next = new Set(prev); next.delete(key); return next; });
    });
  }, [workspacePath, diffCache, loadingPaths]);

  const clearEntry = useCallback((key: string) => {
    setDiffCache((prev) => { const m = new Map(prev); m.delete(key); return m; });
    setErrorPaths((prev) => { const m = new Map(prev); m.delete(key); return m; });
  }, []);

  return { diffCache, loadingPaths, errorPaths, fetchDiff, clearEntry };
}

// ── useActiveSession hook ─────────────────────────────────────────────────────

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
      className={['file-tab', isActive ? 'active' : ''].filter(Boolean).join(' ')}
      role="tab" tabIndex={0} aria-selected={isActive}
      onClick={() => onTabClick(tab)}
      onKeyDown={(e) => { if (e.key === 'Enter') onTabClick(tab); }}
      title={tab.filePath}
    >
      {tab.tabType === 'html' && <span className="tab-icon">{GLOBE_SVG}</span>}
      <span className="tab-name">{tab.fileName}</span>
      {tab.isChanged && <span className="tab-badge">M</span>}
      <button className="tab-close" onClick={(e) => onCloseTab(tab, e)} aria-label={`close ${tab.fileName}`}>{CLOSE_SVG}</button>
    </div>
  );
}

interface HtmlTabViewProps { tab: OpenFileTab; }

function HtmlTabView({ tab }: HtmlTabViewProps) {
  const [sandboxDismissed, setSandboxDismissed] = useState(false);
  const [lastPath, setLastPath] = useState('');
  useEffect(() => {
    if (tab.filePath !== lastPath) { setLastPath(tab.filePath); setSandboxDismissed(false); }
  }, [tab.filePath, lastPath]);
  useEffect(() => {
    if (!sandboxDismissed) {
      const timer = setTimeout(() => setSandboxDismissed(true), 4000);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [sandboxDismissed]);
  const src = `/browser-content/${tab.token}/${tab.fileName}${tab.refreshVersion ? `?v=${tab.refreshVersion}` : ''}`;
  return (
    <div className="html-viewer">
      {!sandboxDismissed && (
        <div className="sandbox-notice">
          <span className="notice-text">rendered in sandbox · some web features may not work</span>
          <button className="notice-dismiss" onClick={() => setSandboxDismissed(true)} aria-label="dismiss notice">×</button>
        </div>
      )}
      <iframe src={src} sandbox="allow-scripts" title={`HTML preview: ${tab.fileName}`} className="html-iframe" />
    </div>
  );
}

interface ContentAreaProps {
  activeTab: OpenFileTab | undefined;
  activeLoading: boolean;
  activeError: string | null;
  activeDiff: string;
  diffViewMode: 'unified' | 'side-by-side';
  wordWrap: boolean;
  onRetry: () => void;
  onCloseActiveTab: () => void;
  onDiffClick: (e: React.MouseEvent) => void;
  renderDiff?: FileViewerPaneProps['renderDiff'];
  renderCode?: FileViewerPaneProps['renderCode'];
}

function ContentArea({
  activeTab, activeLoading, activeError, activeDiff, diffViewMode, wordWrap,
  onRetry, onCloseActiveTab, onDiffClick, renderDiff, renderCode,
}: ContentAreaProps) {
  if (!activeTab) return <div className="empty-viewer">select a file from the sidebar</div>;
  if (activeLoading) return <div className="loading-viewer"><span className="spinner">&#x280B;</span> loading {activeTab.fileName}...</div>;
  if (activeError) {
    return (
      <div className="error-viewer">
        <div className="error-text">failed to load diff: {activeError}</div>
        <div className="error-actions">
          <button className="retry-btn" onClick={onRetry}>retry</button>
          <button className="close-btn" onClick={onCloseActiveTab}>close tab</button>
        </div>
      </div>
    );
  }
  if (activeTab.tabType === 'html' && activeTab.token) return <HtmlTabView tab={activeTab} />;
  if (activeTab.isChanged && activeDiff) {
    return (
      <div className="diff-wrapper" onClick={onDiffClick}>
        {renderDiff ? renderDiff({ diff: activeDiff, filePath: activeTab.filePath, mode: diffViewMode, wordWrap })
          : <DiffViewer diff={activeDiff} filePath={activeTab.filePath} mode={diffViewMode} wordWrap={wordWrap} />}
      </div>
    );
  }
  if (!activeTab.isChanged) {
    return (
      <div className={['raw-file', wordWrap ? 'word-wrap' : ''].filter(Boolean).join(' ')}>
        {renderCode ? renderCode({ code: activeDiff || '(empty file)', language: languageFromPath(activeTab.filePath) })
          : <CodeBlock code={activeDiff || '(empty file)'} language={languageFromPath(activeTab.filePath)} />}
      </div>
    );
  }
  return <div className="empty-viewer">no diff available</div>;
}

// ── useFileViewerHandlers hook ────────────────────────────────────────────────

function useFileViewerHandlers(
  activeTab: OpenFileTab | undefined,
  base: string | null,
  hasActiveSession: boolean,
  onInjectReference: ((r: string) => void) | undefined,
  clearEntry: (key: string) => void,
) {
  const closeFileTab = useUiStore((s) => s.closeFileTab);
  const closeAllFileTabs = useUiStore((s) => s.closeAllFileTabs);
  const refreshHtmlTab = useUiStore((s) => s.refreshHtmlTab);
  const setFileDiffViewMode = useUiStore((s) => s.setFileDiffViewMode);
  const setFileWordWrap = useUiStore((s) => s.setFileWordWrap);
  const fileDiffViewMode = useUiStore((s) => s.fileDiffViewMode);
  const fileWordWrap = useUiStore((s) => s.fileWordWrap);

  const handleCloseTab = useCallback((tab: OpenFileTab, e: React.MouseEvent) => {
    e.stopPropagation();
    closeFileTab(tab.filePath, tab.tabType);
    clearEntry(buildCacheKey(tab.filePath, base));
  }, [closeFileTab, clearEntry, base]);

  const handleTabClick = useCallback((tab: OpenFileTab) => {
    useUiStore.setState({ activeFileTabKey: fileTabKey(tab.filePath, tab.tabType) });
  }, []);

  const handleDiffClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const lineEl = target.closest('.line-number, .d2h-code-linenumber');
    if (!lineEl || !activeTab || !hasActiveSession) return;
    const lineNum = parseInt(lineEl.textContent?.trim() ?? '', 10);
    if (!Number.isNaN(lineNum) && lineNum > 0) {
      onInjectReference?.(parseLineReference(activeTab.filePath, lineNum));
    }
  }, [activeTab, hasActiveSession, onInjectReference]);

  const handleRetry = useCallback(() => {
    if (activeTab) clearEntry(buildCacheKey(activeTab.filePath, base));
  }, [activeTab, base, clearEntry]);

  const handleRefresh = useCallback(() => {
    if (activeTab?.tabType === 'html' && activeTab.filePath) refreshHtmlTab(activeTab.filePath);
  }, [activeTab, refreshHtmlTab]);

  const handleCloseActiveTab = useCallback(() => {
    if (activeTab) closeFileTab(activeTab.filePath, activeTab.tabType);
  }, [activeTab, closeFileTab]);

  const handleToggleDiffViewMode = useCallback(() => {
    setFileDiffViewMode(fileDiffViewMode === 'unified' ? 'side-by-side' : 'unified');
  }, [fileDiffViewMode, setFileDiffViewMode]);

  const handleToggleWordWrap = useCallback(() => {
    setFileWordWrap(!fileWordWrap);
  }, [fileWordWrap, setFileWordWrap]);

  return {
    handleCloseTab, handleTabClick, handleDiffClick, handleRetry, handleRefresh,
    handleCloseActiveTab, handleToggleDiffViewMode, handleToggleWordWrap, closeAllFileTabs,
    fileDiffViewMode, fileWordWrap,
  };
}

// ── Main Component ────────────────────────────────────────────────────────────

export function FileViewerPane({ workspacePath, onInjectReference, renderDiff, renderCode }: FileViewerPaneProps) {
  const openFileTabs = useUiStore((s) => s.openFileTabs);
  const activeFileTabKey = useUiStore((s) => s.activeFileTabKey);
  const fileDiffSource = useUiStore((s) => s.fileDiffSource);
  const fileDiffDefaultBranch = useUiStore((s) => s.fileDiffDefaultBranch);
  const base = useMemo(() => diffSourceToBase(fileDiffSource, fileDiffDefaultBranch) ?? null, [fileDiffSource, fileDiffDefaultBranch]);
  const activeTab = useMemo(
    () => openFileTabs.find((t) => fileTabKey(t.filePath, t.tabType) === activeFileTabKey),
    [openFileTabs, activeFileTabKey]
  );
  const { diffCache, loadingPaths, errorPaths, fetchDiff, clearEntry } = useDiffCache(workspacePath);
  const { hasActiveSession, activeSessionName } = useActiveSession();
  const handlers = useFileViewerHandlers(activeTab, base, hasActiveSession, onInjectReference, clearEntry);
  const { handleCloseTab, handleTabClick, handleDiffClick, handleRetry, handleRefresh,
    handleCloseActiveTab, handleToggleDiffViewMode, handleToggleWordWrap, closeAllFileTabs,
    fileDiffViewMode, fileWordWrap } = handlers;

  const activeCacheKey = activeTab ? buildCacheKey(activeTab.filePath, base) : null;
  const activeDiff = activeCacheKey ? diffCache.get(activeCacheKey) ?? '' : '';
  const activeLoading = activeCacheKey ? loadingPaths.has(activeCacheKey) : false;
  const activeError = activeCacheKey ? errorPaths.get(activeCacheKey) ?? null : null;

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
              tab={tab} isActive={activeFileTabKey === fileTabKey(tab.filePath, tab.tabType)}
              onTabClick={handleTabClick} onCloseTab={handleCloseTab}
            />
          ))}
        </div>
        <div className="tab-bar-actions">
          <button className="diff-mode-btn" onClick={handleToggleWordWrap}>{fileWordWrap ? '[nowrap]' : '[wrap]'}</button>
          {activeTab?.isChanged && (
            <button className="diff-mode-btn" onClick={handleToggleDiffViewMode}>
              {fileDiffViewMode === 'unified' ? '[split]' : '[unified]'}
            </button>
          )}
          {activeTab?.tabType === 'html' && (
            <button className="refresh-btn" onClick={handleRefresh}>[refresh]</button>
          )}
          {openFileTabs.length > 1 && <button className="close-all-btn" onClick={closeAllFileTabs}>close all</button>}
          <div className={['send-to-pill', !hasActiveSession ? 'disabled' : ''].filter(Boolean).join(' ')}>
            <span className="send-to-label">send to:</span>
            <span className="send-to-target">{activeSessionName}</span>
          </div>
        </div>
      </div>
      <div className="file-content" role="tabpanel">
        <ContentArea
          activeTab={activeTab} activeLoading={activeLoading} activeError={activeError}
          activeDiff={activeDiff} diffViewMode={fileDiffViewMode} wordWrap={fileWordWrap}
          onRetry={handleRetry} onCloseActiveTab={handleCloseActiveTab} onDiffClick={handleDiffClick}
          renderDiff={renderDiff} renderCode={renderCode}
        />
      </div>
    </div>
  );
}

export default FileViewerPane;
