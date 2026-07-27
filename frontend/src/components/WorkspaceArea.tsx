import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DEFAULT_LOCAL_NODE_ID } from '../../../shared/identity.js';
import {
  ConflictError,
  fetchHubNodes,
  FileContentConflictError,
  FileContentOversizeError,
} from '../lib/api.js';
import {
  cleanCwd,
  defaultRemoteCwd,
  rememberRemoteCwd,
} from '../lib/remote-node-cwd.js';
import { createLogger } from '../lib/logger.js';
import {
  createTerminalSession,
  getCurrentSessionContext,
} from '../lib/session-utils.js';
import { getOrCreateDmChannel } from '../lib/agent-channels.js';
import type { SummaryNodeInfo } from '../lib/workspace-summary.js';
import { fileTabKey, useUiStore } from '../lib/stores/ui.js';
import { useConfigStore } from '../lib/stores/config.js';
import { useToastStore } from '../lib/stores/toasts.js';
import { TerminalNodePicker } from './TerminalNodePicker.js';
import DialogShell, { type DialogShellHandle } from './dialogs/DialogShell.js';
import TuiButton from './TuiButton.js';
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
import { resolveWorkspaceSessionCloseTarget } from '../lib/workspace-session-close.js';
import {
  FileTabContent,
  languageFromPath,
  type FileTabContentProps,
} from './FileTabContent.js';
import FileFeedbackPanel from './FileFeedbackPanel.js';
import { useFileDiff, useInvalidateFileDiff } from '../hooks/useFileDiff.js';
import {
  useFileContent,
  useInvalidateFileContent,
  useSaveFileContent,
} from '../hooks/useFileContent.js';
import { WorkspaceLayout } from './WorkspaceLayout.js';
import { WorkspaceContentLayer } from './WorkspaceContentLayer.js';
import { Terminal } from './Terminal.js';
import CodeMirrorFileEditor from './CodeMirrorFileEditor.js';
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
  removedTab: WorkspaceTab | undefined,
  onCloseSession: (sessionId: string, nodeId?: string) => void
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
    const closeTarget = resolveWorkspaceSessionCloseTarget(
      removedTab ? [removedTab] : [],
      id,
      useSessionsStore.getState().sessions
    );
    if (closeTarget) onCloseSession(closeTarget.sessionId, closeTarget.nodeId);
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
  const openFileTab = useUiStore((s) => s.openFileTab);
  const openFileTabs = useUiStore((s) => s.openFileTabs);
  const sendToTargetSessionId = useUiStore((s) => s.sendToTargetSessionId);
  const codeTabDirty = useUiStore((s) => s.codeTabDirty);
  const codeTabPendingContent = useUiStore((s) => s.codeTabPendingContent);
  const setCodeTabDirty = useUiStore((s) => s.setCodeTabDirty);
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const sessions = useSessionsStore((s) => s.sessions);
  const [selectedFeedbackLine, setSelectedFeedbackLine] = useState<
    number | null
  >(null);
  const hasActiveSession = (sendToTargetSessionId ?? activeSessionId) !== null;

  const base = useMemo(
    () => diffSourceToBase(fileDiffSource, fileDiffDefaultBranch) ?? null,
    [fileDiffSource, fileDiffDefaultBranch]
  );

  const isDiffMode = tab.tabType === 'diff';
  const isCodeMode = tab.tabType !== 'html' && tab.tabType !== 'diff';
  const currentFileTabKey = fileTabKey(tab.filePath, tab.tabType);
  const isEditorDirty = Boolean(codeTabDirty[currentFileTabKey]);
  const pendingEditorValue = codeTabPendingContent[currentFileTabKey];

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
    mtimeMs,
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
  const invalidateFileContent = useInvalidateFileContent();
  const saveFileContent = useSaveFileContent({
    workspacePath,
    filePath: tab.filePath,
  });
  const [editorValue, setEditorValue] = useState('');
  const [baselineContent, setBaselineContent] = useState('');
  const [baselineMtimeMs, setBaselineMtimeMs] = useState<number | null>(null);
  const [baselineHydrated, setBaselineHydrated] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [diskConflict, setDiskConflict] = useState(false);

  useEffect(() => {
    if (!isCodeMode || contentLoading || contentError || binary || truncated) {
      return;
    }
    if (isEditorDirty) {
      const diskContent = content ?? '';
      if (!baselineHydrated) {
        setBaselineContent(diskContent);
        setBaselineMtimeMs(mtimeMs);
        setBaselineHydrated(true);
        if (pendingEditorValue !== undefined) {
          setEditorValue(pendingEditorValue);
        }
        setSaveError(null);
        setDiskConflict(false);
        return;
      }
      if (
        pendingEditorValue !== undefined &&
        editorValue !== pendingEditorValue
      ) {
        setEditorValue(pendingEditorValue);
      }
      if (diskContent !== baselineContent || mtimeMs !== baselineMtimeMs) {
        setDiskConflict(true);
        setSaveError('file changed on disk');
      } else {
        setDiskConflict(false);
      }
      return;
    }
    setEditorValue(content ?? '');
    setBaselineContent(content ?? '');
    setBaselineMtimeMs(mtimeMs);
    setBaselineHydrated(true);
    setSaveError(null);
    setDiskConflict(false);
    setCodeTabDirty(tab.filePath, tab.tabType, false);
  }, [
    binary,
    baselineContent,
    baselineHydrated,
    baselineMtimeMs,
    content,
    contentError,
    contentLoading,
    editorValue,
    isEditorDirty,
    isCodeMode,
    mtimeMs,
    pendingEditorValue,
    setCodeTabDirty,
    tab.filePath,
    tab.tabType,
    truncated,
  ]);

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
    if (isDiffMode) {
      invalidateFileDiff({ workspacePath, filePath: tab.filePath, base });
    }
    if (isCodeMode) {
      invalidateFileContent({ workspacePath, filePath: tab.filePath });
    }
  }, [
    base,
    invalidateFileContent,
    invalidateFileDiff,
    isCodeMode,
    isDiffMode,
    tab.filePath,
    workspacePath,
  ]);

  const handleCloseTab = useCallback(() => {
    closeFileTab(tab.filePath, tab.tabType);
  }, [closeFileTab, tab.filePath, tab.tabType]);

  // Scoped session that the `relay-ide v1 files read/write` affordance targets.
  // Prefer a session rooted at this workspace; fall back to any live session.
  const commandSessionId = useMemo(() => {
    const inWorkspace = sessions.filter(
      (s) =>
        s.cwd === workspacePath ||
        s.worktreePath === workspacePath ||
        s.repoPath === workspacePath
    );
    return (inWorkspace[0] ?? sessions[0])?.id ?? null;
  }, [sessions, workspacePath]);

  const handleShowChanges = useCallback(() => {
    openFileTab(tab.filePath, true, 'diff');
  }, [openFileTab, tab.filePath]);

  const handleEditorChange = useCallback(
    (next: string) => {
      setEditorValue(next);
      setSaveError(null);
      setDiskConflict(false);
      setCodeTabDirty(
        tab.filePath,
        tab.tabType,
        next !== baselineContent,
        next
      );
    },
    [baselineContent, setCodeTabDirty, tab.filePath, tab.tabType]
  );

  const handleSave = useCallback(
    async (options?: { overwrite?: boolean }) => {
      if (!isCodeMode || saveFileContent.isPending) return;
      setSaveError(null);
      setDiskConflict(false);
      try {
        const expectedMtimeMs = options?.overwrite
          ? undefined
          : (baselineMtimeMs ?? undefined);
        const result = await saveFileContent.mutateAsync(
          expectedMtimeMs === undefined
            ? { content: editorValue }
            : { content: editorValue, expectedMtimeMs }
        );
        setBaselineContent(editorValue);
        setBaselineMtimeMs(result.mtimeMs);
        setBaselineHydrated(true);
        setCodeTabDirty(tab.filePath, tab.tabType, false);
        invalidateFileDiff({ workspacePath, filePath: tab.filePath, base });
      } catch (err) {
        if (err instanceof FileContentConflictError) {
          setDiskConflict(true);
          setSaveError('file changed on disk');
          return;
        }
        if (err instanceof FileContentOversizeError) {
          const mb = err.maxBytes
            ? `${(err.maxBytes / (1024 * 1024)).toFixed(0)}mb`
            : 'server cap';
          setSaveError(`file too large to save (${mb} max)`);
          return;
        }
        setSaveError(
          err instanceof Error ? err.message : 'failed to save file'
        );
      }
    },
    [
      baselineMtimeMs,
      editorValue,
      isCodeMode,
      saveFileContent,
      setCodeTabDirty,
      invalidateFileDiff,
      workspacePath,
      base,
      tab.filePath,
      tab.tabType,
    ]
  );

  const handleReloadDisk = useCallback(() => {
    setDiskConflict(false);
    setSaveError(null);
    setCodeTabDirty(tab.filePath, tab.tabType, false);
    invalidateFileContent({ workspacePath, filePath: tab.filePath });
  }, [
    invalidateFileContent,
    setCodeTabDirty,
    tab.filePath,
    tab.tabType,
    workspacePath,
  ]);

  const editorRenderer = useCallback<
    NonNullable<FileTabContentProps['renderCode']>
  >(
    ({ code, language }) => {
      if (renderCode) return renderCode({ code, language });
      return (
        <CodeMirrorFileEditor
          filePath={tab.filePath}
          value={editorValue}
          language={language}
          wordWrap={fileWordWrap}
          dirty={Boolean(codeTabDirty[currentFileTabKey])}
          saving={saveFileContent.isPending}
          saveError={saveError}
          diskConflict={diskConflict}
          resetKey={`${tab.filePath}:${baselineMtimeMs ?? 'none'}`}
          workspacePath={workspacePath}
          sessionId={commandSessionId}
          isChanged={isChanged}
          onChange={handleEditorChange}
          onSave={() => void handleSave()}
          onReloadDisk={handleReloadDisk}
          onOverwrite={() => void handleSave({ overwrite: true })}
          onShowChanges={handleShowChanges}
        />
      );
    },
    [
      baselineMtimeMs,
      codeTabDirty,
      commandSessionId,
      currentFileTabKey,
      diskConflict,
      editorValue,
      fileWordWrap,
      handleEditorChange,
      handleReloadDisk,
      handleSave,
      handleShowChanges,
      isChanged,
      renderCode,
      saveError,
      saveFileContent.isPending,
      tab.filePath,
      workspacePath,
    ]
  );

  const feedbackPanel =
    isCodeMode && !contentLoading && !contentError && !binary && !truncated ? (
      <FileFeedbackPanel
        filePath={tab.filePath}
        workspacePath={workspacePath}
        content={content ?? ''}
        language={languageFromPath(tab.filePath)}
        sessions={sessions}
        preferredTargetSessionId={sendToTargetSessionId ?? activeSessionId}
        selectedLine={selectedFeedbackLine}
        onSelectedLineConsumed={() => setSelectedFeedbackLine(null)}
      />
    ) : null;

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
      onCodeLineClick={setSelectedFeedbackLine}
      onRetry={handleRetry}
      onCloseTab={handleCloseTab}
      renderDiff={renderDiff}
      renderCode={editorRenderer}
      feedbackPanel={feedbackPanel}
      showSummary={false}
    />
  );
}

// ── Session tab content mount ────────────────────────────────────────────────

interface SessionContentMountProps {
  session: SessionSummary;
  isActive: boolean;
  onImageUpload: (text: string, showInsert: boolean, path?: string) => void;
  onCopyModeChange: (active: boolean) => void;
  onFilePathClick: (path: string) => void;
}

function SessionContentMount({
  session,
  isActive,
  onImageUpload,
  onCopyModeChange,
  onFilePathClick,
}: SessionContentMountProps) {
  return (
    <div className="ws-session-mount ws-session-mount--pty">
      <Terminal
        sessionId={session.id}
        sessionKey={scopedSessionKey(session)}
        isActive={isActive}
        onImageUpload={onImageUpload}
        onCopyModeChange={onCopyModeChange}
        onFilePathClick={onFilePathClick}
      />
    </div>
  );
}

type RemoteTerminalLane = 'remote-cwd' | 'remote-home';

interface PendingRemoteTerminal {
  nodeId: string;
  label: string;
  homeDir?: string | undefined;
}

interface RemoteTerminalCwdDialogProps {
  request: PendingRemoteTerminal | null;
  creating: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (cwd: string, lane: RemoteTerminalLane) => void;
}

function RemoteTerminalCwdDialog({
  request,
  creating,
  error,
  onClose,
  onSubmit,
}: RemoteTerminalCwdDialogProps) {
  const shellRef = useRef<DialogShellHandle>(null);
  const [cwd, setCwd] = useState('');
  const homeDir = cleanCwd(request?.homeDir);
  const nodeLabel = request?.label ?? 'remote node';

  useEffect(() => {
    if (!request) {
      shellRef.current?.close();
      return;
    }
    setCwd(defaultRemoteCwd(homeDir, request.nodeId));
    shellRef.current?.open();
  }, [homeDir, request]);

  const footer = (
    <div className="ws-remote-terminal-footer">
      <TuiButton variant="ghost" onClick={onClose} disabled={creating}>
        cancel
      </TuiButton>
      <TuiButton
        variant="ghost"
        data-track="workspace.remote-terminal.start-home"
        onClick={() => onSubmit(homeDir, 'remote-home')}
        disabled={!homeDir || creating}
      >
        start in home
      </TuiButton>
      <TuiButton
        variant="primary"
        data-track="workspace.remote-terminal.create"
        onClick={() => onSubmit(cwd, 'remote-cwd')}
        disabled={!cleanCwd(cwd) || creating}
      >
        {creating ? 'starting...' : 'start terminal'}
      </TuiButton>
    </div>
  );

  return (
    <DialogShell
      ref={shellRef}
      width="460px"
      title="remote terminal cwd"
      footer={footer}
      onClose={onClose}
    >
      <div className="ws-remote-terminal-fields">
        {error && (
          <div className="ws-remote-terminal-error" role="alert">
            {error}
          </div>
        )}
        <div className="ws-remote-terminal-copy">
          choose the node-local directory before creating a terminal on{' '}
          {nodeLabel}.
        </div>
        <div className="ws-remote-terminal-field">
          <label className="ws-remote-terminal-label" htmlFor="ws-remote-cwd">
            cwd on {nodeLabel}
          </label>
          <input
            id="ws-remote-cwd"
            type="text"
            className="ws-remote-terminal-input"
            data-track="workspace.remote-terminal.cwd"
            placeholder={homeDir || 'absolute path on remote node'}
            value={cwd}
            onChange={(event) => setCwd(event.currentTarget.value)}
            autoComplete="off"
          />
          <div className="ws-remote-terminal-note">
            remote terminals start directly in this directory. use start in home
            to skip remembering a cwd.
          </div>
        </div>
      </div>
    </DialogShell>
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
  onCloseSession: (sessionId: string, nodeId?: string) => void;
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
  const codeTabDirty = useUiStore((s) => s.codeTabDirty);
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
  const prevLayoutTabsRef = useRef<Map<string, WorkspaceTab>>(new Map());
  useEffect(() => {
    if (!initializedRef.current) return;

    const wsIds = new Set<string>();
    const wsTabs = new Map<string, WorkspaceTab>();
    for (const pane of listPanes(layout)) {
      for (const t of pane.tabs) {
        const id = workspaceTabId(t);
        wsIds.add(id);
        wsTabs.set(id, t);
      }
    }
    const prev = prevLayoutTabIdsRef.current;
    const prevTabs = prevLayoutTabsRef.current;
    const removedFromLayout = new Set<string>();
    for (const id of prev) {
      if (!wsIds.has(id)) removedFromLayout.add(id);
    }
    prevLayoutTabIdsRef.current = wsIds;
    prevLayoutTabsRef.current = wsTabs;

    // Propagate layout-side removals (workspace × button) to the owning store.
    // Use the previous tab object so remote session removals still retain
    // nodeId/local-session fallback data after refreshAll drops them from
    // useSessionsStore.
    for (const id of removedFromLayout) {
      propagateLayoutSideRemoval(id, prevTabs.get(id), onCloseSession);
    }

    // Re-read after potential ui mutation above.
    const currentOpenFileTabs = useUiStore.getState().openFileTabs;
    const fileUiIds = new Set(currentOpenFileTabs.map(uiTabId));
    const sessionUiIds = new Set(sessions.map(sessionTabId));
    const liveUiIds = new Set([...fileUiIds, ...sessionUiIds]);

    const panes = listPanes(layout);
    const validActivePaneId =
      activePaneId && panes.some((pane) => pane.id === activePaneId)
        ? activePaneId
        : null;
    const targetPane =
      validActivePaneId ?? (layout.type === 'pane' ? layout.id : panes[0]?.id);

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
    staleTime: Infinity,
    refetchOnWindowFocus: 'always',
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
      openFileTabs
        .filter(
          (t) => t.isChanged || codeTabDirty[fileTabKey(t.filePath, t.tabType)]
        )
        .map((t) => t.filePath)
    );
    const findSession = (id: string) => resolveSessionByKey(sessions, id);
    return {
      isFileChanged: (path) => changed.has(path),
      findSession,
      findNode: (id) => nodeIndex.get(id),
    };
  }, [codeTabDirty, openFileTabs, sessions, nodeIndex]);

  const setActivePane = useWorkspaceLayoutStore((s) => s.setActivePane);
  const [pendingRemoteTerminal, setPendingRemoteTerminal] =
    useState<PendingRemoteTerminal | null>(null);
  const [remoteTerminalCreating, setRemoteTerminalCreating] = useState(false);
  const [remoteTerminalError, setRemoteTerminalError] = useState<string | null>(
    null
  );

  const closeRemoteTerminalDialog = useCallback(() => {
    if (remoteTerminalCreating) return;
    setPendingRemoteTerminal(null);
    setRemoteTerminalError(null);
  }, [remoteTerminalCreating]);

  const createRemoteTerminal = useCallback(
    async (cwd: string, lane: RemoteTerminalLane) => {
      if (!pendingRemoteTerminal || remoteTerminalCreating) return;
      const remoteCwd = cleanCwd(cwd);
      if (!remoteCwd) {
        setRemoteTerminalError('cwd is required for remote terminal sessions');
        return;
      }
      setRemoteTerminalCreating(true);
      setRemoteTerminalError(null);
      try {
        const { session, error } = await createTerminalSession({
          nodeId: pendingRemoteTerminal.nodeId,
          cwd: remoteCwd,
          sessionLane: lane,
        });
        if (error && !(error instanceof ConflictError)) {
          const message =
            error instanceof Error
              ? error.message
              : 'failed to create terminal session';
          workspaceLogger.error(
            'failed to create remote terminal session',
            error
          );
          setRemoteTerminalError(message);
          useToastStore.getState().showToast(message);
          return;
        }
        if (lane === 'remote-cwd') {
          rememberRemoteCwd(pendingRemoteTerminal.nodeId, remoteCwd);
        }
        setPendingRemoteTerminal(null);
        if (session?.id) {
          useSessionsStore.getState().setActiveSessionId(session.id);
        }
      } finally {
        setRemoteTerminalCreating(false);
      }
    },
    [pendingRemoteTerminal, remoteTerminalCreating]
  );

  // The pane-header '+chat' button opens a Hermes DM channel through the same
  // channel entry point as TopicComposer and CustomizeSessionDialog. A channel
  // is a full-surface view, so this activates ChannelView directly.
  const spawnHermesBeside = useCallback(
    async (paneId: string) => {
      const { currentActiveWorkspace } = getCurrentSessionContext();
      if (!currentActiveWorkspace) {
        useUiStore.getState().setActiveModal({ modal: 'env-picker' });
        return;
      }
      setActivePane(paneId);
      try {
        const framework = useConfigStore
          .getState()
          .frameworks.find((f) => f.id === 'hermes');
        const topic = await getOrCreateDmChannel({
          providerId: 'hermes',
          providerDisplayName: framework?.displayName ?? 'Hermes',
          workspaceId: useUiStore.getState().activeWorkspaceId,
        });
        useUiStore.getState().setActiveChannelId(topic.id);
      } catch (error) {
        workspaceLogger.error('failed to open hermes chat', error);
        useToastStore
          .getState()
          .showToast(
            error instanceof Error
              ? error.message
              : 'failed to open hermes chat'
          );
      }
    },
    [setActivePane]
  );

  const renderAddControl = useCallback(
    (paneId: string) => (
      <span className="ws-pane-add">
        <button
          type="button"
          className="ws-pane-add__chat"
          title="new hermes chat beside"
          aria-label="new hermes chat beside"
          onClick={() => {
            void spawnHermesBeside(paneId);
          }}
        >
          +chat
        </button>
        <TerminalNodePicker
          onSelect={async (nodeId) => {
            // Resolve repoPath + worktreePath from the live session context.
            // workspacePath is the active worktree's cwd, which the
            // `/sessions` route would reject as a repoPath; mirror the same
            // split that handleQuickTerminal uses.
            const { currentActiveWorkspace, currentWorktreePath } =
              getCurrentSessionContext();
            if (!currentActiveWorkspace) {
              // #862: no active workspace (repo-less hub) — route through the
              // env-picker so the user can pick a node/cwd to launch a terminal
              // against, instead of silently bailing. The picker derives its
              // options from the canonical env inventory and launches a bare
              // terminal (launchOverrides={{ type: 'terminal' }} wired in App).
              useUiStore.getState().setActiveModal({ modal: 'env-picker' });
              return;
            }
            // The new session lands in whichever pane is active; activate
            // the pane whose `+` was used before the create call so the
            // layout reconciler routes the tab to the correct pane.
            setActivePane(paneId);
            const isRemoteNode = nodeId !== DEFAULT_LOCAL_NODE_ID;
            if (isRemoteNode) {
              const node = hubNodes?.find(
                (candidate) => candidate.nodeId === nodeId
              );
              setRemoteTerminalError(null);
              setPendingRemoteTerminal({
                nodeId,
                label: node?.displayName || nodeId,
                ...(node?.homeDir ? { homeDir: node.homeDir } : {}),
              });
              return;
            }
            const { session, error } = await createTerminalSession({
              repoPath: currentActiveWorkspace.path,
              worktreePath: currentWorktreePath,
              sessionLane: 'local-repo',
            });
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
      </span>
    ),
    [setActivePane, hubNodes, spawnHermesBeside]
  );

  const renderTab = useCallback(
    (tab: WorkspaceTab, isActive: boolean) => {
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
          isActive={isActive}
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
      <RemoteTerminalCwdDialog
        request={pendingRemoteTerminal}
        creating={remoteTerminalCreating}
        error={remoteTerminalError}
        onClose={closeRemoteTerminalDialog}
        onSubmit={(cwd, lane) => void createRemoteTerminal(cwd, lane)}
      />
    </div>
  );
}

export default WorkspaceArea;
