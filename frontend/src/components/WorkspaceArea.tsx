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
import type { SessionSummary } from '../lib/types.js';
import { FileTabContent, type FileTabContentProps } from './FileTabContent.js';
import { useFileDiff, useInvalidateFileDiff } from '../hooks/useFileDiff.js';
import { WorkspaceLayout } from './WorkspaceLayout.js';
import { WorkspaceContentLayer } from './WorkspaceContentLayer.js';
import { Terminal } from './Terminal.js';
import { ChatView } from './chat/ChatView.js';
import './WorkspaceArea.css';

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

function sessionToWorkspaceTab(session: SessionSummary): WorkspaceTab {
  return {
    kind: 'session',
    sessionId: session.id,
    sessionType: session.type,
  };
}

function sessionTabId(session: SessionSummary): string {
  return `session::${session.id}`;
}

// ── File tab content bridge ──────────────────────────────────────────────────

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

  const { diff, loading, error } = useFileDiff(
    { workspacePath, filePath: tab.filePath, base },
    { enabled: tab.tabType !== 'html' }
  );
  const invalidateFileDiff = useInvalidateFileDiff();

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
    invalidateFileDiff({ workspacePath, filePath: tab.filePath, base });
  }, [invalidateFileDiff, workspacePath, tab.filePath, base]);

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

// ── Session tab content mount ────────────────────────────────────────────────

interface SessionContentMountProps {
  session: SessionSummary;
  onImageUpload: (text: string, showInsert: boolean, path?: string) => void;
  onCopyModeChange: (active: boolean) => void;
  onFilePathClick: (path: string) => void;
}

function SessionContentMount({
  session,
  onImageUpload,
  onCopyModeChange,
  onFilePathClick,
}: SessionContentMountProps) {
  if (session.mode === 'web') {
    return (
      <div className="ws-session-mount ws-session-mount--web">
        <ChatView sessionId={session.id} />
      </div>
    );
  }
  return (
    <div className="ws-session-mount ws-session-mount--pty">
      <Terminal
        sessionId={session.id}
        useTmux={session.useTmux !== false}
        onImageUpload={onImageUpload}
        onCopyModeChange={onCopyModeChange}
        onFilePathClick={onFilePathClick}
      />
    </div>
  );
}

// ── Main WorkspaceArea component ─────────────────────────────────────────────

export interface WorkspaceAreaProps {
  workspacePath: string;
  sessions: SessionSummary[];
  onInjectReference?: (reference: string) => void;
  onImageUpload: (text: string, showInsert: boolean, path?: string) => void;
  onCopyModeChange: (active: boolean) => void;
  onFilePathClick: (path: string) => void;
  renderDiff?: FileTabContentProps['renderDiff'];
  renderCode?: FileTabContentProps['renderCode'];
}

export function WorkspaceArea({
  workspacePath,
  sessions,
  onInjectReference,
  onImageUpload,
  onCopyModeChange,
  onFilePathClick,
  renderDiff,
  renderCode,
}: WorkspaceAreaProps) {
  const openFileTabs = useUiStore((s) => s.openFileTabs);
  const activeFileTabKey = useUiStore((s) => s.activeFileTabKey);
  const setUiState = useUiStore.setState;
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const setActiveSessionId = useSessionsStore((s) => s.setActiveSessionId);

  const layout = useWorkspaceLayoutStore((s) => s.layout);
  const activePaneId = useWorkspaceLayoutStore((s) => s.activePaneId);
  const addTab = useWorkspaceLayoutStore((s) => s.addTab);
  const closeTab = useWorkspaceLayoutStore((s) => s.closeTab);
  const selectTab = useWorkspaceLayoutStore((s) => s.selectTab);
  const resetLayout = useWorkspaceLayoutStore((s) => s.resetLayout);

  // Initialize layout from current sessions + openFileTabs on first mount.
  const initializedRef = useRef(false);
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    const initialTabs: WorkspaceTab[] = [
      ...sessions.map(sessionToWorkspaceTab),
      ...openFileTabs.map(uiTabToWorkspaceTab),
    ];
    resetLayout(initialTabs);
  }, [resetLayout, sessions, openFileTabs]);

  // Single reconciler: keeps layout aligned with ui.openFileTabs + sessions[].
  // Reads stores via getState() so a mutation earlier in the same effect
  // (closeFileTab on layout-driven removal) is visible to the rest of the
  // body. Removes in the layout that are NOT in ui+sessions are propagated
  // back to ui (workspace × button case); items in ui+sessions missing from
  // layout get added to the active pane. No long-lived suppression set —
  // the per-cycle `removedThisCycle` set is rebuilt from prev vs current.
  const prevLayoutTabIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!initializedRef.current) return;

    const wsIds = new Set<string>();
    for (const pane of listPanes(layout)) {
      for (const t of pane.tabs) wsIds.add(workspaceTabId(t));
    }
    const prev = prevLayoutTabIdsRef.current;
    const removedFromLayout = new Set<string>();
    for (const id of prev) {
      if (!wsIds.has(id)) removedFromLayout.add(id);
    }
    prevLayoutTabIdsRef.current = wsIds;

    // Propagate layout-side removals (workspace × button) to ui store.
    for (const id of removedFromLayout) {
      if (!id.startsWith('file::')) continue;
      const ftKey = id.slice('file::'.length);
      const uiState = useUiStore.getState();
      const uiTab = uiState.openFileTabs.find(
        (t) => fileTabKey(t.filePath, t.tabType) === ftKey
      );
      if (uiTab) uiState.closeFileTab(uiTab.filePath, uiTab.tabType);
    }

    // Re-read after potential ui mutation above.
    const currentOpenFileTabs = useUiStore.getState().openFileTabs;
    const fileUiIds = new Set(currentOpenFileTabs.map(uiTabId));
    const sessionUiIds = new Set(sessions.map(sessionTabId));
    const liveUiIds = new Set([...fileUiIds, ...sessionUiIds]);

    const targetPane =
      activePaneId ??
      (layout.type === 'pane' ? layout.id : listPanes(layout)[0]?.id);

    // Add ui items missing from layout — but skip anything we just removed
    // this cycle (otherwise a workspace × close immediately re-adds).
    for (const t of currentOpenFileTabs) {
      const id = uiTabId(t);
      if (wsIds.has(id)) continue;
      if (removedFromLayout.has(id)) continue;
      if (targetPane) addTab(targetPane, uiTabToWorkspaceTab(t));
    }
    for (const s of sessions) {
      const id = sessionTabId(s);
      if (wsIds.has(id)) continue;
      if (removedFromLayout.has(id)) continue;
      if (targetPane) addTab(targetPane, sessionToWorkspaceTab(s));
    }

    // Close layout items that ui no longer has (e.g., FileViewerPane × button
    // closed only the ui-side tab).
    for (const id of wsIds) {
      if (!liveUiIds.has(id)) closeTab(id);
    }
  }, [openFileTabs, sessions, layout, activePaneId, addTab, closeTab]);

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

  // Sync sessionsStore.activeSessionId → workspace selection.
  useEffect(() => {
    if (!activeSessionId) return;
    const targetId = `session::${activeSessionId}`;
    for (const pane of listPanes(layout)) {
      if (pane.tabs.some((t) => workspaceTabId(t) === targetId)) {
        if (pane.activeTabId !== targetId) {
          selectTab(pane.id, targetId);
        }
        return;
      }
    }
  }, [activeSessionId, layout, selectTab]);

  // Workspace pane active tab → store sync (file or session).
  useEffect(() => {
    let activeTabId: string | null = null;
    for (const pane of listPanes(layout)) {
      if (pane.id === activePaneId && pane.activeTabId) {
        activeTabId = pane.activeTabId;
        break;
      }
    }
    if (!activeTabId) return;
    if (activeTabId.startsWith('file::')) {
      const ftKey = activeTabId.slice('file::'.length);
      if (useUiStore.getState().activeFileTabKey !== ftKey) {
        setUiState({ activeFileTabKey: ftKey });
      }
    } else if (activeTabId.startsWith('session::')) {
      const id = activeTabId.slice('session::'.length);
      if (useSessionsStore.getState().activeSessionId !== id) {
        setActiveSessionId(id);
      }
    }
  }, [layout, activePaneId, setUiState, setActiveSessionId]);

  const summaryContext = useMemo<SummaryContext>(() => {
    const changed = new Set(
      openFileTabs.filter((t) => t.isChanged).map((t) => t.filePath)
    );
    const findSession = (id: string) => sessions.find((s) => s.id === id);
    return {
      isFileChanged: (path) => changed.has(path),
      findSession,
    };
  }, [openFileTabs, sessions]);

  const renderTab = useCallback(
    (tab: WorkspaceTab) => {
      if (tab.kind === 'file') {
        return (
          <FileTabContentBridge
            tab={tab}
            workspacePath={workspacePath}
            onInjectReference={onInjectReference}
            renderDiff={renderDiff}
            renderCode={renderCode}
          />
        );
      }
      const session = sessions.find((s) => s.id === tab.sessionId);
      if (!session) {
        return (
          <div className="ws-session-mount ws-session-mount--missing">
            session {tab.sessionId} no longer exists
          </div>
        );
      }
      return (
        <SessionContentMount
          session={session}
          onImageUpload={onImageUpload}
          onCopyModeChange={onCopyModeChange}
          onFilePathClick={onFilePathClick}
        />
      );
    },
    [
      workspacePath,
      onInjectReference,
      renderDiff,
      renderCode,
      sessions,
      onImageUpload,
      onCopyModeChange,
      onFilePathClick,
    ]
  );

  return (
    <div className="ws-area">
      <WorkspaceLayout summaryContext={summaryContext} />
      <WorkspaceContentLayer renderTab={renderTab} />
    </div>
  );
}

export default WorkspaceArea;
