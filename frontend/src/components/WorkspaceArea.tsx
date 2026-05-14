import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DEFAULT_LOCAL_NODE_ID } from '../../../shared/identity.js';
import { ConflictError, fetchHubNodes } from '../lib/api.js';
import { defaultRemoteCwd } from '../lib/remote-node-cwd.js';
import { createLogger } from '../lib/logger.js';
import {
  createAgentSession,
  getCurrentSessionContext,
} from '../lib/session-utils.js';
import type { SummaryNodeInfo } from '../lib/workspace-summary.js';
import { fileTabKey, useUiStore } from '../lib/stores/ui.js';
import { useToastStore } from '../lib/stores/toasts.js';
import { TerminalNodePicker } from './TerminalNodePicker.js';
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
import { resolveSessionByKey, scopedSessionKey } from '../lib/session-keys.js';
import { FileTabContent, type FileTabContentProps } from './FileTabContent.js';
import { useFileDiff, useInvalidateFileDiff } from '../hooks/useFileDiff.js';
import { useFileContent } from '../hooks/useFileContent.js';
import { WorkspaceLayout } from './WorkspaceLayout.js';
import { WorkspaceContentLayer } from './WorkspaceContentLayer.js';
import { Terminal } from './Terminal.js';
import { ChatView } from './chat/ChatView.js';
import './WorkspaceArea.css';

const workspaceLogger = createLogger('workspace-area');

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
    sessionId: scopedSessionKey(session),
    sessionType: session.type,
    ...(session.nodeId ? { nodeId: session.nodeId } : {}),
  };
}

function sessionTabId(session: SessionSummary): string {
  return `session::${scopedSessionKey(session)}`;
}

function propagateLayoutSideRemoval(
  id: string,
  onCloseSession: (sessionId: string) => void
): void {
  if (id.startsWith('file::')) {
    const ftKey = id.slice('file::'.length);
    const uiState = useUiStore.getState();
    const uiTab = uiState.openFileTabs.find(
      (t) => fileTabKey(t.filePath, t.tabType) === ftKey
    );
    if (uiTab) uiState.closeFileTab(uiTab.filePath, uiTab.tabType);
    return;
  }

  if (id.startsWith('session::')) {
    onCloseSession(id.slice('session::'.length));
  }
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
  const reviewState = useUiStore(
    (s) => s.utilityRailByWorkspace[workspacePath]?.review
  );
  const globalFileDiffSource = useUiStore((s) => s.fileDiffSource);
  const globalFileDiffDefaultBranch = useUiStore(
    (s) => s.fileDiffDefaultBranch
  );
  const fileDiffSource = reviewState?.diffSource ?? globalFileDiffSource;
  const fileDiffDefaultBranch =
    reviewState?.defaultBranch ?? globalFileDiffDefaultBranch;
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

  const isDiffMode = tab.tabType === 'diff';
  const isCodeMode = tab.tabType !== 'html' && tab.tabType !== 'diff';

  const {
    diff,
    loading: diffLoading,
    error: diffError,
  } = useFileDiff(
    { workspacePath, filePath: tab.filePath, base },
    { enabled: isDiffMode }
  );
  const {
    content,
    binary,
    truncated,
    loading: contentLoading,
    error: contentError,
  } = useFileContent(
    { workspacePath, filePath: tab.filePath },
    { enabled: isCodeMode }
  );
  const loading = isDiffMode
    ? diffLoading
    : isCodeMode
      ? contentLoading
      : false;
  const error = isDiffMode ? diffError : isCodeMode ? contentError : null;
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
      content={content}
      binary={binary}
      truncated={truncated}
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
        sessionKey={scopedSessionKey(session)}
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
  onCloseSession: (sessionId: string) => void;
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
  onCloseSession,
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

    // Propagate layout-side removals (workspace × button) to the owning store.
    for (const id of removedFromLayout) {
      propagateLayoutSideRemoval(id, onCloseSession);
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

    // Close layout items that ui no longer has (e.g., legacy ui-side close
    // handlers removed only the file-tab store entry).
    for (const id of wsIds) {
      if (!liveUiIds.has(id)) closeTab(id);
    }
  }, [
    openFileTabs,
    sessions,
    layout,
    activePaneId,
    addTab,
    closeTab,
    onCloseSession,
  ]);

  // Sync ui.activeFileTabKey → workspace selection. Triggered ONLY when
  // activeFileTabKey changes — not on layout changes — otherwise this effect
  // and the activeSessionId effect fight to select different tabs in the
  // same pane after openFileTab (Maximum update depth crash).
  useEffect(() => {
    if (!activeFileTabKey) return;
    const targetId = `file::${activeFileTabKey}`;
    const currentLayout = useWorkspaceLayoutStore.getState().layout;
    for (const pane of listPanes(currentLayout)) {
      if (pane.tabs.some((t) => workspaceTabId(t) === targetId)) {
        if (pane.activeTabId !== targetId) {
          selectTab(pane.id, targetId);
        }
        return;
      }
    }
  }, [activeFileTabKey, selectTab]);

  // Sync sessionsStore.activeSessionId → workspace selection. Same shape as
  // activeFileTabKey effect — fires only when its own dep changes.
  useEffect(() => {
    if (!activeSessionId) return;
    const targetId = `session::${activeSessionId}`;
    const currentLayout = useWorkspaceLayoutStore.getState().layout;
    for (const pane of listPanes(currentLayout)) {
      if (pane.tabs.some((t) => workspaceTabId(t) === targetId)) {
        if (pane.activeTabId !== targetId) {
          selectTab(pane.id, targetId);
        }
        return;
      }
    }
  }, [activeSessionId, selectTab]);

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

  const hubNodesQuery = useQuery({
    queryKey: ['hub-nodes'],
    queryFn: fetchHubNodes,
    refetchInterval: 15_000,
    refetchOnWindowFocus: false,
  });
  const hubNodes = hubNodesQuery.data;

  const nodeIndex = useMemo<Map<string, SummaryNodeInfo>>(() => {
    const map = new Map<string, SummaryNodeInfo>();
    if (!hubNodes) return map;
    for (const node of hubNodes) {
      map.set(node.nodeId, {
        label: node.displayName || node.nodeId,
        status: node.status,
      });
    }
    return map;
  }, [hubNodes]);

  const summaryContext = useMemo<SummaryContext>(() => {
    const changed = new Set(
      openFileTabs.filter((t) => t.isChanged).map((t) => t.filePath)
    );
    const findSession = (id: string) => resolveSessionByKey(sessions, id);
    return {
      isFileChanged: (path) => changed.has(path),
      findSession,
      findNode: (id) => nodeIndex.get(id),
    };
  }, [openFileTabs, sessions, nodeIndex]);

  const setActivePane = useWorkspaceLayoutStore((s) => s.setActivePane);
  const renderAddControl = useCallback(
    (paneId: string) => (
      <TerminalNodePicker
        onSelect={async (nodeId) => {
          // Resolve repoPath + worktreePath from the live session context.
          // workspacePath is the active worktree's cwd, which the
          // `/sessions` route would reject as a repoPath; mirror the same
          // split that handleQuickTerminal uses.
          const { currentActiveWorkspace, currentWorktreePath } =
            getCurrentSessionContext();
          if (!currentActiveWorkspace) {
            workspaceLogger.warn(
              'no active workspace — cannot create terminal'
            );
            return;
          }
          // The new session lands in whichever pane is active; activate
          // the pane whose `+` was used before the create call so the
          // layout reconciler routes the tab to the correct pane.
          setActivePane(paneId);
          const isRemoteNode = nodeId !== DEFAULT_LOCAL_NODE_ID;
          const remoteCwd = isRemoteNode
            ? defaultRemoteCwd(
                hubNodes?.find((node) => node.nodeId === nodeId)?.homeDir,
                nodeId
              )
            : '';
          if (isRemoteNode && !remoteCwd) {
            workspaceLogger.warn(
              'remote terminal node has no remembered cwd or homeDir',
              { nodeId }
            );
            useToastStore
              .getState()
              .showToast('remote cwd is required for this node');
            return;
          }
          const { session, error } = await createAgentSession(
            isRemoteNode
              ? {
                  type: 'terminal',
                  nodeId,
                  cwd: remoteCwd,
                  sessionLane: 'remote-cwd',
                }
              : {
                  repoPath: currentActiveWorkspace.path,
                  worktreePath: currentWorktreePath,
                  type: 'terminal',
                  sessionLane: 'local-repo',
                }
          );
          if (error && !(error instanceof ConflictError)) {
            workspaceLogger.error('failed to create terminal session', error);
            useToastStore
              .getState()
              .showToast(
                error instanceof Error
                  ? error.message
                  : 'failed to create terminal session'
              );
          }
          if (session?.id) {
            useSessionsStore.getState().setActiveSessionId(session.id);
          }
        }}
      />
    ),
    [setActivePane, hubNodes]
  );

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
      const session = resolveSessionByKey(sessions, tab.sessionId);
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
      <WorkspaceLayout
        summaryContext={summaryContext}
        renderAddControl={renderAddControl}
      />
      <WorkspaceContentLayer renderTab={renderTab} />
    </div>
  );
}

export default WorkspaceArea;
