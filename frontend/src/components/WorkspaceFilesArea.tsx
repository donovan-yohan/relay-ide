import { useCallback, useEffect, useMemo, useRef } from 'react';
import { fileTabKey, useUiStore } from '../lib/stores/ui.js';
import type { OpenFileTab } from '../lib/stores/ui.js';
import { useSessionsStore } from '../lib/stores/sessions.js';
import { diffSourceToBase } from '../lib/diff-utils.js';
import {
  listPanes,
  workspaceTabId,
  type WorkspaceTab,
} from '../lib/workspace-layout.js';
import { useWorkspaceLayoutStore } from '../lib/stores/workspace-layout-store.js';
import type { SummaryContext } from '../lib/workspace-summary.js';
import {
  buildCacheKey,
  FileTabContent,
  useFileDiffCache,
  type FileTabContentProps,
} from './FileTabContent.js';
import { WorkspaceLayout } from './WorkspaceLayout.js';
import { WorkspaceContentLayer } from './WorkspaceContentLayer.js';
import './WorkspaceFilesArea.css';

function uiTabToWorkspaceTab(tab: OpenFileTab): WorkspaceTab {
  return {
    kind: 'file',
    filePath: tab.filePath,
    tabType: tab.tabType ?? 'code',
    ...(tab.token ? { token: tab.token } : {}),
  };
}

function uiTabId(tab: OpenFileTab): string {
  return `file::${fileTabKey(tab.filePath, tab.tabType)}`;
}

interface FileTabContentBridgeProps {
  tab: Extract<WorkspaceTab, { kind: 'file' }>;
  workspacePath: string;
  onInjectReference?: ((reference: string) => void) | undefined;
  renderDiff?: FileTabContentProps['renderDiff'];
  renderCode?: FileTabContentProps['renderCode'];
}

function FileTabContentBridge({
  tab,
  workspacePath,
  onInjectReference,
  renderDiff,
  renderCode,
}: FileTabContentBridgeProps) {
  const fileDiffSource = useUiStore((s) => s.fileDiffSource);
  const fileDiffDefaultBranch = useUiStore((s) => s.fileDiffDefaultBranch);
  const fileDiffViewMode = useUiStore((s) => s.fileDiffViewMode);
  const fileWordWrap = useUiStore((s) => s.fileWordWrap);
  const closeFileTab = useUiStore((s) => s.closeFileTab);
  const openFileTabs = useUiStore((s) => s.openFileTabs);
  const sendToTargetSessionId = useUiStore((s) => s.sendToTargetSessionId);
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const hasActiveSession = (sendToTargetSessionId ?? activeSessionId) !== null;

  const base = useMemo(
    () => diffSourceToBase(fileDiffSource, fileDiffDefaultBranch) ?? null,
    [fileDiffSource, fileDiffDefaultBranch]
  );

  const cache = useFileDiffCache(workspacePath);
  const cacheKey = buildCacheKey(tab.filePath, base);
  const diff = cache.diffCache.get(cacheKey) ?? '';
  const loading = cache.loadingPaths.has(cacheKey);
  const error = cache.errorPaths.get(cacheKey) ?? null;

  useEffect(() => {
    if (tab.tabType === 'html') return;
    cache.fetchDiff(tab.filePath, base);
  }, [tab.filePath, tab.tabType, base, cache]);

  const uiMatch = openFileTabs.find(
    (t) =>
      fileTabKey(t.filePath, t.tabType) ===
      fileTabKey(tab.filePath, tab.tabType)
  );
  const fileName =
    uiMatch?.fileName ?? tab.filePath.split('/').pop() ?? tab.filePath;
  const isChanged = uiMatch?.isChanged ?? false;
  const refreshVersion = uiMatch?.refreshVersion;

  const handleRetry = useCallback(() => {
    cache.clearEntry(cacheKey);
  }, [cache, cacheKey]);

  const handleCloseTab = useCallback(() => {
    closeFileTab(tab.filePath, tab.tabType);
  }, [closeFileTab, tab.filePath, tab.tabType]);

  return (
    <FileTabContent
      filePath={tab.filePath}
      fileName={fileName}
      tabType={tab.tabType}
      token={tab.token}
      isChanged={isChanged}
      refreshVersion={refreshVersion}
      diff={diff}
      loading={loading}
      error={error}
      diffViewMode={fileDiffViewMode}
      wordWrap={fileWordWrap}
      hasActiveSession={hasActiveSession}
      onInjectReference={onInjectReference}
      onRetry={handleRetry}
      onCloseTab={handleCloseTab}
      renderDiff={renderDiff}
      renderCode={renderCode}
      showSummary={false}
    />
  );
}

export interface WorkspaceFilesAreaProps {
  workspacePath: string;
  onInjectReference?: (reference: string) => void;
  renderDiff?: FileTabContentProps['renderDiff'];
  renderCode?: FileTabContentProps['renderCode'];
}

export function WorkspaceFilesArea({
  workspacePath,
  onInjectReference,
  renderDiff,
  renderCode,
}: WorkspaceFilesAreaProps) {
  const openFileTabs = useUiStore((s) => s.openFileTabs);
  const activeFileTabKey = useUiStore((s) => s.activeFileTabKey);
  const setUiState = useUiStore.setState;

  const layout = useWorkspaceLayoutStore((s) => s.layout);
  const activePaneId = useWorkspaceLayoutStore((s) => s.activePaneId);
  const addTab = useWorkspaceLayoutStore((s) => s.addTab);
  const closeTab = useWorkspaceLayoutStore((s) => s.closeTab);
  const selectTab = useWorkspaceLayoutStore((s) => s.selectTab);
  const resetLayout = useWorkspaceLayoutStore((s) => s.resetLayout);

  // Initialize layout from current openFileTabs on first mount.
  const initializedRef = useRef(false);
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    resetLayout(openFileTabs.map(uiTabToWorkspaceTab));
  }, [resetLayout, openFileTabs]);

  // Workspace tab close → ui.closeFileTab (detect tabs removed from layout).
  // Runs BEFORE the ui → workspace sync effect below so the recently-removed
  // id set is populated before that effect would otherwise re-add the tab in
  // the same commit (stale openFileTabs closure).
  const prevLayoutTabIdsRef = useRef<Set<string>>(new Set());
  const recentlyRemovedIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const currentIds = new Set<string>();
    for (const pane of listPanes(layout)) {
      for (const t of pane.tabs) currentIds.add(workspaceTabId(t));
    }
    const prev = prevLayoutTabIdsRef.current;
    const removed: string[] = [];
    for (const id of prev) {
      if (!currentIds.has(id)) removed.push(id);
    }
    prevLayoutTabIdsRef.current = currentIds;

    for (const id of removed) {
      if (!id.startsWith('file::')) continue;
      recentlyRemovedIdsRef.current.add(id);
      const ftKey = id.slice('file::'.length);
      const uiTab = useUiStore
        .getState()
        .openFileTabs.find((t) => fileTabKey(t.filePath, t.tabType) === ftKey);
      if (uiTab) {
        useUiStore.getState().closeFileTab(uiTab.filePath, uiTab.tabType);
      }
    }
  }, [layout]);

  // Sync ui.openFileTabs → workspace tabs (add/remove).
  useEffect(() => {
    if (!initializedRef.current) return;
    const wsIds = new Set<string>();
    for (const pane of listPanes(layout)) {
      for (const t of pane.tabs) wsIds.add(workspaceTabId(t));
    }
    const uiIds = new Set(openFileTabs.map(uiTabId));

    for (const t of openFileTabs) {
      const id = uiTabId(t);
      if (wsIds.has(id)) continue;
      // Suppress re-add for ids we just removed from layout — the ui store
      // close has been dispatched but openFileTabs in this closure is stale.
      if (recentlyRemovedIdsRef.current.has(id)) continue;
      const targetPane =
        activePaneId ??
        (layout.type === 'pane' ? layout.id : listPanes(layout)[0]?.id);
      if (targetPane) addTab(targetPane, uiTabToWorkspaceTab(t));
    }
    for (const id of wsIds) {
      if (!uiIds.has(id)) closeTab(id);
    }

    // Once the ui store has caught up (the id is gone from openFileTabs),
    // drop the suppression so future re-adds of the same path are allowed.
    for (const id of Array.from(recentlyRemovedIdsRef.current)) {
      if (!uiIds.has(id)) recentlyRemovedIdsRef.current.delete(id);
    }
  }, [openFileTabs, layout, activePaneId, addTab, closeTab]);

  // Sync ui.activeFileTabKey → workspace selection.
  useEffect(() => {
    if (!activeFileTabKey) return;
    const targetId = `file::${activeFileTabKey}`;
    for (const pane of listPanes(layout)) {
      if (pane.tabs.some((t) => workspaceTabId(t) === targetId)) {
        if (pane.activeTabId !== targetId) {
          selectTab(pane.id, targetId);
        }
        return;
      }
    }
  }, [activeFileTabKey, layout, selectTab]);

  // Workspace pane active tab change → ui.activeFileTabKey.
  useEffect(() => {
    let activeFileTabId: string | null = null;
    for (const pane of listPanes(layout)) {
      if (pane.id === activePaneId && pane.activeTabId) {
        activeFileTabId = pane.activeTabId;
        break;
      }
    }
    if (!activeFileTabId || !activeFileTabId.startsWith('file::')) return;
    const ftKey = activeFileTabId.slice('file::'.length);
    if (useUiStore.getState().activeFileTabKey !== ftKey) {
      setUiState({ activeFileTabKey: ftKey });
    }
  }, [layout, activePaneId, setUiState]);

  const summaryContext = useMemo<SummaryContext>(() => {
    const changed = new Set(
      openFileTabs.filter((t) => t.isChanged).map((t) => t.filePath)
    );
    return {
      isFileChanged: (path) => changed.has(path),
    };
  }, [openFileTabs]);

  const renderTab = useCallback(
    (tab: WorkspaceTab) => {
      if (tab.kind !== 'file') return null;
      return (
        <FileTabContentBridge
          tab={tab}
          workspacePath={workspacePath}
          onInjectReference={onInjectReference}
          renderDiff={renderDiff}
          renderCode={renderCode}
        />
      );
    },
    [workspacePath, onInjectReference, renderDiff, renderCode]
  );

  return (
    <div className="ws-files-area">
      <WorkspaceLayout summaryContext={summaryContext} />
      <WorkspaceContentLayer renderTab={renderTab} />
    </div>
  );
}

export default WorkspaceFilesArea;
