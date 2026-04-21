import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAuthStore } from './lib/stores/auth.js';
import { useUiStore } from './lib/stores/ui.js';
import { useSessionsStore } from './lib/stores/sessions.js';
import { useConfigStore } from './lib/stores/config.js';
import { useBootStateStore } from './lib/stores/boot-state.js';
import { useTelemetryStore } from './lib/stores/telemetry.js';
import { sendPtyData } from './lib/ws.js';
import {
  useOnboardingHints,
  HINT_NO_REPOS,
  HINT_REPO_ADDED_NO_SESSIONS,
} from './hooks/useOnboardingHints.js';
import { useHintsStore } from './lib/stores/hints.js';
import { Hint } from './components/Hint.js';
import {
  initNotifications,
  initPushNotifications,
  resubscribeIfNeeded,
} from './lib/notifications.js';
import type { Repo, PullRequest } from './lib/types.js';
import { initAnalytics, destroyAnalytics, track } from './lib/analytics.js';
import type { ActionContext } from './lib/actions/types.js';
import { useEventSocket } from './hooks/useEventSocket.js';
import { useAppShortcuts } from './hooks/useAppShortcuts.js';
import { useActionRegistry } from './hooks/useActionRegistry.js';
import { useSessionHandlers } from './hooks/useSessionHandlers.js';
import { useUrlNav } from './hooks/useUrlNav.js';

import BootScreen from './components/BootScreen.js';
import PinGate from './components/PinGate.js';
import Sidebar from './components/Sidebar.js';
import Terminal from './components/Terminal.js';
import { ChatView } from './components/chat/ChatView.js';
import type { TerminalHandle } from './components/Terminal.js';
import PrTopBar from './components/PrTopBar.js';
import SessionTabBar from './components/SessionTabBar.js';
import RepoDashboard from './components/RepoDashboard.js';
import OrgDashboard from './components/OrgDashboard.js';
import EmptyState from './components/EmptyState.js';
import Toolbar from './components/Toolbar.js';
import MobileHeader from './components/MobileHeader.js';
import SessionStatusBar from './components/SessionStatusBar.js';
import UpdateToast from './components/UpdateToast.js';
import { showImageToast } from './components/ImageToast.js';
import ErrorToast from './components/ErrorToast.js';
import NotificationStack from './components/NotificationStack.js';
import InstallBanner from './components/InstallBanner.js';
import CommandPalette from './components/CommandPalette.js';
import OpenPicker from './components/OpenPicker.js';
import FilePicker from './components/FilePicker.js';
import CustomizeSessionDialog from './components/dialogs/CustomizeSessionDialog.js';
import type { CustomizeSessionDialogHandle } from './components/dialogs/CustomizeSessionDialog.js';
import SettingsDialog from './components/dialogs/SettingsDialog.js';
import type { SettingsDialogHandle } from './components/dialogs/SettingsDialog.js';
import DeleteWorktreeDialog from './components/dialogs/DeleteWorktreeDialog.js';
import type { DeleteWorktreeDialogHandle } from './components/dialogs/DeleteWorktreeDialog.js';
import AddWorkspaceDialog from './components/dialogs/AddWorkspaceDialog.js';
import type { AddWorkspaceDialogHandle } from './components/dialogs/AddWorkspaceDialog.js';
import WorkspaceSettingsDialog from './components/dialogs/WorkspaceSettingsDialog.js';
import type { WorkspaceSettingsDialogHandle } from './components/dialogs/WorkspaceSettingsDialog.js';
import AnalyticsDashboard from './components/AnalyticsDashboard.js';
import SessionDetail from './components/SessionDetail.js';
import FullPageDiff from './components/FullPageDiff.js';
import FileViewerPane from './components/FileViewerPane.js';
import { SplitPaneLayout } from './components/SplitPaneLayout.js';
import {
  FileTreeSidebar,
  type FileTreeSidebarHandle,
} from './components/FileTreeSidebar.js';

import './App.css';

// QueryClient is created at module level (outside the component)
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60 * 1000,
      gcTime: 10 * 60 * 1000,
      refetchOnWindowFocus: true,
    },
  },
});

// initNotifications is called at module level.
// We forward calls to the live navigateToSession function via a ref.
let _navigateToSessionFn:
  | ((sessionId: string, sessionType: string) => void)
  | null = null;
initNotifications((sessionId: string, sessionType: string) => {
  _navigateToSessionFn?.(sessionId, sessionType);
});

// ─── useTerminalOnboardingHints ───────────────────────────────────────────────
// Tracks session/repo count transitions and returns onboarding hint state.
// Extracted to reduce TerminalAreaContent's cyclomatic complexity.

function useTerminalOnboardingHints(
  reposLength: number,
  sessionsLength: number
) {
  const prevSessionsRef = useRef(sessionsLength);
  const prevReposRef = useRef(reposLength);
  const [sessionJustStarted, setSessionJustStarted] = useState(false);
  const markHintSeen = useHintsStore((s) => s.markSeen);

  useEffect(() => {
    const prev = prevSessionsRef.current;
    if (sessionsLength > prev) {
      setSessionJustStarted(true);
      const timeoutId = setTimeout(() => setSessionJustStarted(false), 100);
      prevSessionsRef.current = sessionsLength;
      return () => {
        clearTimeout(timeoutId);
      };
    }
    if (prev === 0 && sessionsLength > 0) {
      markHintSeen(HINT_REPO_ADDED_NO_SESSIONS);
    }
    prevSessionsRef.current = sessionsLength;
  }, [sessionsLength, markHintSeen]);

  useEffect(() => {
    if (prevReposRef.current === 0 && reposLength > 0) {
      markHintSeen(HINT_NO_REPOS);
    }
    prevReposRef.current = reposLength;
  }, [reposLength, markHintSeen]);

  return { sessionJustStarted };
}

// ─── resolveTerminalFilePath ──────────────────────────────────────────────────
// Converts an absolute or relative terminal file path to a repo-relative path.
// Returns null if the path cannot be resolved within the cwd.

function resolveTerminalFilePath(
  clickedPath: string,
  cwd: string
): string | null {
  if (!cwd) return null;
  let relative = clickedPath;
  if (clickedPath.startsWith(cwd + '/')) {
    relative = clickedPath.slice(cwd.length + 1);
  } else if (clickedPath.startsWith('/')) {
    return null;
  } else if (clickedPath.startsWith('./')) {
    relative = clickedPath.slice(2);
  }
  while (relative.startsWith('./')) {
    relative = relative.slice(2);
  }
  return relative;
}

// ─── useTerminalDerivedState ──────────────────────────────────────────────────
// Computes derived session/workspace values used by TerminalAreaContent.

function useTerminalDerivedState() {
  const activeRepoPath = useUiStore((s) => s.activeRepoPath);
  const openFileTabs = useUiStore((s) => s.openFileTabs);
  const analyticsView = useUiStore((s) => s.analyticsView);
  const sessions = useSessionsStore((s) => s.sessions);
  const repos = useSessionsStore((s) => s.repos);
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);

  const activeWorkspace = useMemo(
    () =>
      activeRepoPath ? repos.find((w) => w.path === activeRepoPath) : undefined,
    [activeRepoPath, repos]
  );

  const activeSession = useMemo(
    () =>
      activeSessionId
        ? sessions.find((s) => s.id === activeSessionId)
        : undefined,
    [activeSessionId, sessions]
  );

  const allWorkspaceSessions = useMemo(
    () =>
      activeRepoPath
        ? useSessionsStore.getState().getSessionsForRepo(activeRepoPath)
        : [],
    [activeRepoPath, sessions]
  );

  const workspaceSessions = useMemo(
    () =>
      (activeSession
        ? allWorkspaceSessions.filter((s) => s.cwd === activeSession.cwd)
        : allWorkspaceSessions
      ).toSorted(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      ),
    [activeSession, allWorkspaceSessions]
  );

  const hasActiveSession = useMemo(
    () =>
      !!activeSession &&
      !!activeRepoPath &&
      activeSession.repoPath === activeRepoPath,
    [activeSession, activeRepoPath]
  );

  const sessionTitle = useMemo(
    () => activeSession?.displayName || activeWorkspace?.name || 'Relay',
    [activeSession, activeWorkspace]
  );

  const activeSessionMode = useMemo(() => activeSession?.mode, [activeSession]);
  const activeSessionUseTmux = useMemo(
    () => activeSession?.useTmux ?? false,
    [activeSession]
  );
  const activeWorkspaceCwd = useMemo(
    () => activeSession?.worktreePath ?? activeSession?.repoPath ?? '',
    [activeSession]
  );
  const fileViewerOpen = useMemo(() => openFileTabs.length > 0, [openFileTabs]);

  const viewMode = useMemo<
    'empty' | 'org' | 'dashboard' | 'session' | 'analytics'
  >(() => {
    if (analyticsView !== null) return 'analytics';
    if (!repos.length) return 'empty';
    if (!activeRepoPath) return 'org';
    if (!hasActiveSession) return 'dashboard';
    return 'session';
  }, [analyticsView, repos.length, activeRepoPath, hasActiveSession]);

  return {
    activeRepoPath,
    activeSessionId,
    activeSession,
    activeWorkspace,
    workspaceSessions,
    sessionTitle,
    activeSessionMode,
    activeSessionUseTmux,
    activeWorkspaceCwd,
    fileViewerOpen,
    viewMode,
    analyticsView,
    repos,
    sessions,
  };
}

// ─── AnalyticsViewContent ─────────────────────────────────────────────────────
// Renders the analytics or session-detail view. Extracted to reduce complexity.

function AnalyticsViewContent() {
  const analyticsView = useUiStore((s) => s.analyticsView);
  const setAnalyticsView = useUiStore((s) => s.setAnalyticsView);
  if (
    typeof analyticsView === 'object' &&
    analyticsView !== null &&
    'sessionId' in analyticsView
  ) {
    return (
      <SessionDetail
        sessionId={analyticsView.sessionId}
        onBack={() => setAnalyticsView('dashboard')}
      />
    );
  }
  return (
    <AnalyticsDashboard
      onSelectSession={(id) => setAnalyticsView({ sessionId: id })}
      onClose={() => setAnalyticsView(null)}
    />
  );
}

// ─── SessionContent ──────────────────────────────────────────────────────────
// Routes between ChatView (web sessions) and Terminal (PTY sessions).

function SessionContent({
  mode,
  sessionId,
  terminalRef,
  onImageUpload,
  useTmux,
  onCopyModeChange,
  onFilePathClick,
}: {
  mode?: 'pty' | 'web' | undefined;
  sessionId: string | null;
  terminalRef: React.RefObject<TerminalHandle | null>;
  onImageUpload: (text: string, showInsert: boolean, path?: string) => void;
  useTmux: boolean;
  onCopyModeChange: (active: boolean) => void;
  onFilePathClick: (path: string) => void;
}) {
  if (mode === 'web') {
    return <ChatView sessionId={sessionId} />;
  }
  return (
    <Terminal
      ref={terminalRef}
      sessionId={sessionId}
      onImageUpload={onImageUpload}
      useTmux={useTmux}
      onCopyModeChange={onCopyModeChange}
      onFilePathClick={onFilePathClick}
    />
  );
}

// ─── TerminalAreaContent ──────────────────────────────────────────────────────
// Extracted to reduce App's cyclomatic complexity. Accesses Zustand stores
// directly to avoid a large prop surface; only truly local state/refs are passed.

interface TerminalAreaContentProps {
  setSpotlightOpen: React.Dispatch<React.SetStateAction<boolean>>;
  changedFilesData: string[];
  terminalRef: React.RefObject<TerminalHandle | null>;
  fileTreeSidebarRef: React.RefObject<FileTreeSidebarHandle | null>;
  onAddWorkspace: () => void;
  onImageUpload: (text: string, showInsert: boolean, path?: string) => void;
  onQuickAgent: () => Promise<void>;
  onQuickTerminal: () => Promise<void>;
  onCustomize: () => void;
  onNewWorktree: (workspace: Repo) => Promise<void>;
  onFixConflicts: (pr: PullRequest) => Promise<void>;
  onPrAction: (pr: PullRequest) => void;
  onOpenPrSession: (pr: PullRequest) => void;
  onArchive: () => Promise<void>;
  onSelectSession: (id: string) => void;
  onCloseSession: (sessionId: string) => void;
}

function TerminalAreaContent({
  setSpotlightOpen,
  changedFilesData,
  terminalRef,
  fileTreeSidebarRef,
  onAddWorkspace,
  onImageUpload,
  onQuickAgent,
  onQuickTerminal,
  onCustomize,
  onNewWorktree,
  onFixConflicts,
  onPrAction,
  onOpenPrSession,
  onArchive,
  onSelectSession,
  onCloseSession,
}: TerminalAreaContentProps) {
  // Store access (layout / sidebar values not in derived state hook)
  const openSidebar = useUiStore((s) => s.openSidebar);
  const keyboardOpen = useUiStore((s) => s.keyboardOpen);
  const rightSidebarCollapsed = useUiStore((s) => s.rightSidebarCollapsed);
  const rightSidebarWidth = useUiStore((s) => s.rightSidebarWidth);
  const saveRightSidebarWidth = useUiStore((s) => s.saveRightSidebarWidth);
  const fileViewerRatio = useUiStore((s) => s.fileViewerRatio);
  const saveFileViewerRatio = useUiStore((s) => s.saveFileViewerRatio);
  const openFileTab = useUiStore((s) => s.openFileTab);
  const isItemLoading = useSessionsStore((s) => s.isItemLoading);

  // ── Derived state ──────────────────────────────────────────────────────────
  const {
    activeRepoPath,
    activeSessionId,
    activeSession,
    activeWorkspace,
    workspaceSessions,
    sessionTitle,
    activeSessionMode,
    activeSessionUseTmux,
    activeWorkspaceCwd,
    fileViewerOpen,
    viewMode,
    repos,
    sessions,
  } = useTerminalDerivedState();

  // ── Onboarding hints ──────────────────────────────────────────────────────
  const { sessionJustStarted } = useTerminalOnboardingHints(
    repos.length,
    sessions.length
  );

  // ── Copy mode ─────────────────────────────────────────────────────────────
  const [copyModeActive, setCopyModeActive] = useState(false);

  const onboardingHints = useOnboardingHints({
    hasRepos: repos.length > 0,
    hasActiveSessions: sessions.length > 0,
    sessionJustStarted,
    commandPaletteJustOpened: false,
  });

  const handleSendKey = useCallback((key: string) => {
    sendPtyData(key);
  }, []);
  const handleFlushComposedText = useCallback(() => {
    /* xterm.js handles natively */
  }, []);
  const handleClearInput = useCallback(() => {
    /* xterm.js manages textarea */
  }, []);
  const handleInjectReference = useCallback((reference: string) => {
    sendPtyData(reference + ' ');
  }, []);
  const handleCopyModeChange = useCallback((active: boolean) => {
    setCopyModeActive(active);
  }, []);
  const handleExitCopyMode = useCallback(() => {
    terminalRef.current?.exitCopyMode();
  }, [terminalRef]);
  const handleRefocusMobileInput = useCallback(() => {
    terminalRef.current?.focusTerm();
  }, [terminalRef]);
  const handleUploadImage = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) terminalRef.current?.handleImageUpload(file, file.type);
    };
    input.click();
  }, [terminalRef]);
  const handleFileSelect = useCallback(
    (filePath: string, isChanged: boolean) => {
      openFileTab(filePath, isChanged);
    },
    [openFileTab]
  );
  const handleTerminalFilePathClick = useCallback(
    (clickedPath: string) => {
      const currentActiveSessionId =
        useSessionsStore.getState().activeSessionId;
      const currentActiveSession = currentActiveSessionId
        ? useSessionsStore
            .getState()
            .sessions.find((s) => s.id === currentActiveSessionId)
        : undefined;
      const cwd =
        currentActiveSession?.worktreePath ??
        currentActiveSession?.repoPath ??
        '';
      const relative = resolveTerminalFilePath(clickedPath, cwd);
      if (relative !== null) openFileTab(relative, false);
    },
    [openFileTab]
  );

  return (
    <div className="terminal-area">
      <MobileHeader
        title={sessionTitle}
        onMenuClick={openSidebar}
        onCommandClick={() => setSpotlightOpen(true)}
        hidden={keyboardOpen}
      />

      {viewMode === 'empty' && (
        <EmptyState
          heading="add a repo to get started"
          description="point to any folder on your machine. git repos get pr tracking and branch management."
          actionLabel="+ add repo"
          onAction={onAddWorkspace}
          hint={
            onboardingHints.showNoReposHint ? (
              <Hint id={HINT_NO_REPOS} variant="inline-text">
                relay-ide manages claude code sessions across your repos.
              </Hint>
            ) : undefined
          }
        />
      )}

      {viewMode === 'org' && (
        <OrgDashboard
          onOpenPrSession={onOpenPrSession}
          onPrAction={onPrAction}
        />
      )}

      {viewMode === 'analytics' && <AnalyticsViewContent />}

      {viewMode === 'dashboard' && (
        <RepoDashboard
          repoPath={activeRepoPath ?? ''}
          workspaceName={activeWorkspace?.name ?? ''}
          creatingWorktree={isItemLoading(
            `new-worktree:${activeRepoPath ?? ''}`
          )}
          onNewSession={() => onQuickAgent()}
          onNewWorktree={() => {
            if (activeWorkspace) onNewWorktree(activeWorkspace);
          }}
          onFixConflicts={onFixConflicts}
          onPrAction={onPrAction}
          onOpenPrSession={onOpenPrSession}
          hint={
            onboardingHints.showRepoAddedHint ? (
              <Hint id={HINT_REPO_ADDED_NO_SESSIONS} variant="border">
                start a session to begin working with claude code in this repo.
              </Hint>
            ) : undefined
          }
        />
      )}

      {viewMode === 'session' && (
        <>
          <PrTopBar
            workspacePath={activeRepoPath ?? ''}
            branchName={activeSession?.branchName ?? ''}
            sessionId={activeSessionId}
            agentRunning={activeSession?.agentState === 'processing'}
            onArchive={onArchive}
          />
          <SplitPaneLayout
            fileViewerOpen={fileViewerOpen}
            rightSidebarCollapsed={rightSidebarCollapsed}
            rightSidebarWidth={rightSidebarWidth}
            fileViewerRatio={fileViewerRatio}
            onRightSidebarWidthChange={saveRightSidebarWidth}
            onFileViewerRatioChange={saveFileViewerRatio}
            terminal={
              <>
                <SessionTabBar
                  sessions={workspaceSessions}
                  activeSessionId={activeSessionId}
                  onSelectSession={onSelectSession}
                  onCloseSession={onCloseSession}
                  onNewAgent={() => onQuickAgent()}
                  onNewTerminal={() => onQuickTerminal()}
                  onCustomize={() => onCustomize()}
                  hidden={keyboardOpen}
                />

                <SessionContent
                  mode={activeSessionMode}
                  sessionId={activeSessionId}
                  terminalRef={terminalRef}
                  onImageUpload={onImageUpload}
                  useTmux={activeSessionUseTmux}
                  onCopyModeChange={handleCopyModeChange}
                  onFilePathClick={handleTerminalFilePathClick}
                />

                {activeSessionId && (
                  <SessionStatusBar
                    sessionId={activeSessionId}
                    currentActivity={activeSession?.currentActivity ?? null}
                    framework={activeSession?.agent}
                  />
                )}

                <Toolbar
                  onSendKey={handleSendKey}
                  onFlushComposedText={handleFlushComposedText}
                  onClearInput={handleClearInput}
                  onUploadImage={handleUploadImage}
                  onRefocusMobileInput={handleRefocusMobileInput}
                  inCopyMode={copyModeActive}
                  onExitCopyMode={handleExitCopyMode}
                />
              </>
            }
            fileViewer={
              <FileViewerPane
                workspacePath={activeWorkspaceCwd}
                onInjectReference={handleInjectReference}
              />
            }
            rightSidebar={
              <FileTreeSidebar
                ref={fileTreeSidebarRef}
                workspacePath={activeWorkspaceCwd}
                changedFilesData={changedFilesData}
                onFileSelect={handleFileSelect}
              />
            }
          />
        </>
      )}
    </div>
  );
}

// ─── App Component ────────────────────────────────────────────────────────────

export default function App() {
  // ── Auth store ─────────────────────────────────────────────────────────────
  const authChecking = useAuthStore((s) => s.checking);
  const authAuthenticated = useAuthStore((s) => s.authenticated);
  const authNeedsSetup = useAuthStore((s) => s.needsSetup);
  const checkExistingAuth = useAuthStore((s) => s.checkExistingAuth);
  const loadFrameworks = useConfigStore((s) => s.loadFrameworks);

  // ── UI store ───────────────────────────────────────────────────────────────
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const closeSidebar = useUiStore((s) => s.closeSidebar);
  const activeRepoPath = useUiStore((s) => s.activeRepoPath);
  const setActiveRepoPath = useUiStore((s) => s.setActiveRepoPath);
  const fullPageDiff = useUiStore((s) => s.fullPageDiff);
  const lastChangedFiles = useUiStore((s) => s.lastChangedFiles);
  const openFileTabs = useUiStore((s) => s.openFileTabs);

  const openFileTab = useUiStore((s) => s.openFileTab);

  // ── Sessions store ─────────────────────────────────────────────────────────
  const sessions = useSessionsStore((s) => s.sessions);
  const repos = useSessionsStore((s) => s.repos);
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const setActiveSessionId = useSessionsStore((s) => s.setActiveSessionId);
  const recallSessionForWorkspace = useSessionsStore(
    (s) => s.recallSessionForWorkspace
  );

  // ── Boot store ─────────────────────────────────────────────────────────────
  const bootComplete = useBootStateStore((s) => s.bootComplete);
  const startBoot = useBootStateStore((s) => s.startBoot);
  const reportFetch = useBootStateStore((s) => s.reportFetch);
  const finishBoot = useBootStateStore((s) => s.finishBoot);

  // ── Local state ────────────────────────────────────────────────────────────
  const [bootScreenVisible, setBootScreenVisible] = useState(true);
  const [spotlightOpen, setSpotlightOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [changedFilesData, setChangedFilesData] = useState<string[]>([]);
  const setAnalyticsView = useUiStore((s) => s.setAnalyticsView);
  const activeModal = useUiStore((s) => s.activeModal);
  const setActiveModal = useUiStore((s) => s.setActiveModal);

  // ── Refs ───────────────────────────────────────────────────────────────────
  const terminalRef = useRef<TerminalHandle>(null);
  const customizeDialogRef = useRef<CustomizeSessionDialogHandle>(null);
  const settingsDialogRef = useRef<SettingsDialogHandle>(null);
  const deleteWorktreeDialogRef = useRef<DeleteWorktreeDialogHandle>(null);
  const addWorkspaceDialogRef = useRef<AddWorkspaceDialogHandle>(null);
  const workspaceSettingsDialogRef =
    useRef<WorkspaceSettingsDialogHandle>(null);
  const mainAppRef = useRef<HTMLDivElement>(null);
  const fileTreeSidebarRef = useRef<FileTreeSidebarHandle>(null);
  const changedFilesThrottleTimer = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const bootRefreshDone = useRef(false);

  // ── Derived state ──────────────────────────────────────────────────────────
  // activeSession and activeWorkspaceCwd are needed for FilePicker
  const activeSession = useMemo(
    () =>
      activeSessionId
        ? sessions.find((s) => s.id === activeSessionId)
        : undefined,
    [activeSessionId, sessions]
  );

  // Active workspace cwd — use worktreePath/repoPath (stable root), not cwd which can drift
  const activeWorkspaceCwd = useMemo(
    () => activeSession?.worktreePath ?? activeSession?.repoPath ?? '',
    [activeSession]
  );

  // ── Action context ─────────────────────────────────────────────────────────
  const actionContext = useMemo<ActionContext>(() => {
    if (activeSessionId) {
      const ctx: ActionContext = {
        view: 'session',
        sessionId: activeSessionId,
      };
      if (activeRepoPath) ctx.workspacePath = activeRepoPath;
      return ctx;
    }
    if (activeRepoPath) {
      return { view: 'workspace', workspacePath: activeRepoPath };
    }
    return { view: 'dashboard' };
  }, [activeSessionId, activeRepoPath]);

  // Keep actionContext in a ref so registry callbacks (set up once on mount) always read current value
  const actionContextRef = useRef(actionContext);
  useEffect(() => {
    actionContextRef.current = actionContext;
  }, [actionContext]);

  // ── Session handlers (extracted hook) ──────────────────────────────────────
  const {
    navigateToDashboard,
    navigateToSession,
    handleRenameActiveSession,
    handleSelectSession,
    handleQuickAgent,
    handleQuickTerminal,
    handleCustomize,
    handleOpenSettings,
    handleNewWorktree,
    handleLaunchWorkspaceSession,
    handleLaunchRepoSession,
    handleFixConflicts,
    handleOpenPrBranch,
    handleArchive,
    handlePrAction,
    handleOpenPrSession,
    handleDeleteWorktree,
    handleResumeWorktree,
    handleNewSessionCreated,
    handleCloseSession,
  } = useSessionHandlers({
    terminalRef,
    customizeDialogRef,
    deleteWorktreeDialogRef,
    workspaceSettingsDialogRef,
    setAnalyticsView,
  });

  const { restoreFromUrl } = useUrlNav();

  // ── Drive dialogs from activeModal store state ─────────────────────────────
  useEffect(() => {
    if (activeModal?.modal === 'settings') {
      settingsDialogRef.current?.open(activeModal.scrollToId ?? undefined);
    } else if (activeModal?.modal === 'add-repo') {
      addWorkspaceDialogRef.current?.open();
    } else {
      settingsDialogRef.current?.close();
      addWorkspaceDialogRef.current?.close();
    }
  }, [activeModal]);

  const handleModalClose = useCallback(() => {
    setActiveModal(null);
  }, [setActiveModal]);

  // Wire the module-level notifications forwarder to the live navigateToSession
  useEffect(() => {
    _navigateToSessionFn = navigateToSession;
    return () => {
      _navigateToSessionFn = null;
    };
  }, [navigateToSession]);

  const handleImageUpload = useCallback(
    (text: string, showInsert: boolean, path?: string) => {
      showImageToast(text, showInsert, path);
    },
    []
  );

  const handlePaletteSelectPr = useCallback(
    (pr: PullRequest) => {
      if (pr.repoPath) {
        useUiStore.getState().setActiveRepoPath(pr.repoPath);
        useSessionsStore.getState().setActiveSessionId(null);
      }
      handleOpenPrBranch(pr);
    },
    [handleOpenPrBranch]
  );

  const handleAddWorkspace = useCallback(() => {
    setActiveModal({ modal: 'add-repo' });
  }, [setActiveModal]);

  const handleWorkspacesAdded = useCallback(async (paths: string[]) => {
    await useSessionsStore.getState().refreshAll();
    // Auto-select the first newly added workspace
    if (paths.length > 0) {
      useUiStore.getState().setActiveRepoPath(paths[0]!);
    }
  }, []);

  // ── File tree helpers ──────────────────────────────────────────────────────
  const throttledChangedFilesRefresh = useCallback(() => {
    if (changedFilesThrottleTimer.current) return;
    changedFilesThrottleTimer.current = setTimeout(() => {
      changedFilesThrottleTimer.current = null;
      fileTreeSidebarRef.current?.refresh();
    }, 2000);
  }, []);

  // ── Analytics ──────────────────────────────────────────────────────────────
  const openAnalytics = useCallback(() => {
    setAnalyticsView('dashboard');
  }, []);

  // ── Boot screen: hide 300ms after completion ───────────────────────────────
  useEffect(() => {
    if (bootComplete) {
      const timer = setTimeout(() => setBootScreenVisible(false), 300);
      return () => clearTimeout(timer);
    }
  }, [bootComplete]);

  // ── Cleanup changedFilesThrottleTimer on unmount ───────────────────────────
  useEffect(() => {
    return () => {
      if (changedFilesThrottleTimer.current) {
        clearTimeout(changedFilesThrottleTimer.current);
      }
    };
  }, []);

  // ── Navigation tracking ────────────────────────────────────────────────────
  const prevActiveSessionIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    // Skip the initial mount — only track real navigation transitions
    if (prevActiveSessionIdRef.current === undefined) {
      prevActiveSessionIdRef.current = activeSessionId;
      return;
    }
    if (activeSessionId === prevActiveSessionIdRef.current) return;
    prevActiveSessionIdRef.current = activeSessionId;
    if (activeSessionId) {
      track('navigation', 'page.view', '/terminal', undefined, activeSessionId);
    } else {
      track('navigation', 'page.view', '/dashboard', {
        workspace: useUiStore.getState().activeRepoPath,
      });
    }
  }, [activeSessionId]);

  // ── Auth effect: refresh when authenticated ────────────────────────────────
  useEffect(() => {
    if (!authAuthenticated) return;

    void loadFrameworks();

    const isInitialBoot = !bootRefreshDone.current;
    if (isInitialBoot) {
      bootRefreshDone.current = true;
      reportFetch('auth', 'ok');
    }

    const runRefresh = async () => {
      await useSessionsStore
        .getState()
        .refreshAll(isInitialBoot ? reportFetch : undefined);
      await useTelemetryStore.getState().refreshTelemetry();

      if (isInitialBoot) {
        finishBoot();
        // Backfill PR info and staleness via batch enrichment
        useSessionsStore.getState().enrichSidebarBranches();
      }

      // Restore navigation state from the URL path (or fall back to ?session= for legacy links)
      const params = new URLSearchParams(window.location.search);
      const sessionParam = params.get('session');
      if (sessionParam) {
        window.history.replaceState({}, '', '/');
        navigateToSession(sessionParam, 'repo');
      } else {
        restoreFromUrl();
      }

      // Auto-select if exactly one session exists and none is selected
      const currentSessions = useSessionsStore.getState().sessions;
      const currentActiveSessionId =
        useSessionsStore.getState().activeSessionId;
      if (
        !currentActiveSessionId &&
        !sessionParam &&
        currentSessions.length === 1
      ) {
        handleSelectSession(currentSessions[0]!.id);
      }

      // Initialize notifications for existing sessions
      for (const s of useSessionsStore.getState().sessions) {
        useSessionsStore
          .getState()
          .initSessionNotification(
            s.id,
            useConfigStore.getState().defaultNotifications
          );
      }

      initPushNotifications().then(() => {
        resubscribeIfNeeded(
          useSessionsStore.getState().getNotificationSessionIds()
        );
      });
    };

    runRefresh();
  }, [authAuthenticated, loadFrameworks]);

  // ── Event socket ───────────────────────────────────────────────────────────
  useEventSocket({
    authAuthenticated,
    queryClient,
    throttledChangedFilesRefresh,
    setChangedFilesData,
  });

  // ── Action registry (extracted hook) ────────────────────────────────────────
  useActionRegistry({
    handleQuickAgent,
    handleQuickTerminal,
    handleCloseSession,
    handleSelectSession,
    handleNewWorktree,
    handleOpenSettings,
    handleRenameActiveSession,
    handleArchive,
    navigateToDashboard,
    customizeDialogRef,
    deleteWorktreeDialogRef,
    workspaceSettingsDialogRef,
    terminalRef,
    setFilePickerOpen,
  });

  // ── Keyboard shortcuts, mobile viewport, edge swipe (extracted hook) ──────
  useAppShortcuts({
    handleSelectSession,
    setSpotlightOpen,
    setPickerOpen,
    setFilePickerOpen,
    mainAppRef,
    terminalRef,
    actionContextRef,
  });

  // ── Mount: analytics, boot, auth check ────────────────────────────────────
  useEffect(() => {
    initAnalytics(() => useSessionsStore.getState().activeSessionId);
    startBoot();
    checkExistingAuth();
    return () => {
      destroyAnalytics();
    };
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────────
  if (authChecking || (authAuthenticated && bootScreenVisible)) {
    return <BootScreen />;
  }

  if (!authAuthenticated || authNeedsSetup) {
    return <PinGate />;
  }

  return (
    <QueryClientProvider client={queryClient}>
      <div className="main-app" ref={mainAppRef}>
        {/* Sidebar overlay (mobile) */}
        {sidebarOpen && (
          <div className="sidebar-overlay" onClick={closeSidebar} />
        )}

        <Sidebar
          onSelectSession={handleSelectSession}
          onOpenSettings={handleOpenSettings}
          onNewWorktree={handleNewWorktree}
          onAddWorkspace={handleAddWorkspace}
          onDeleteSession={handleCloseSession}
          onDeleteWorktree={handleDeleteWorktree}
          onResumeWorktree={handleResumeWorktree}
          onLaunchWorkspaceSession={handleLaunchWorkspaceSession}
          onLaunchRepoSession={handleLaunchRepoSession}
          onOpenAnalytics={openAnalytics}
        />

        <TerminalAreaContent
          setSpotlightOpen={setSpotlightOpen}
          changedFilesData={changedFilesData}
          terminalRef={terminalRef}
          fileTreeSidebarRef={fileTreeSidebarRef}
          onAddWorkspace={handleAddWorkspace}
          onImageUpload={handleImageUpload}
          onQuickAgent={handleQuickAgent}
          onQuickTerminal={handleQuickTerminal}
          onCustomize={handleCustomize}
          onNewWorktree={handleNewWorktree}
          onFixConflicts={handleFixConflicts}
          onPrAction={handlePrAction}
          onOpenPrSession={handleOpenPrSession}
          onArchive={handleArchive}
          onSelectSession={handleSelectSession}
          onCloseSession={handleCloseSession}
        />
      </div>

      {/* Dialogs & overlays */}
      <CustomizeSessionDialog
        ref={customizeDialogRef}
        onSessionCreated={handleNewSessionCreated}
      />
      <SettingsDialog ref={settingsDialogRef} onClose={handleModalClose} />
      <DeleteWorktreeDialog ref={deleteWorktreeDialogRef} />
      <AddWorkspaceDialog
        ref={addWorkspaceDialogRef}
        onWorkspacesAdded={handleWorkspacesAdded}
        onClose={handleModalClose}
      />
      <WorkspaceSettingsDialog
        ref={workspaceSettingsDialogRef}
        onRemoveWorkspace={async (p) => {
          await fetch('/workspaces', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: p }),
          });
          await useSessionsStore.getState().refreshAll();
          if (useUiStore.getState().activeRepoPath === p) {
            useUiStore.getState().setActiveRepoPath(null);
          }
        }}
      />

      {/* Full-page diff overlay */}
      {fullPageDiff && (
        <div className="full-page-diff-overlay">
          <FullPageDiff
            workspacePath={fullPageDiff.workspacePath}
            {...(fullPageDiff.file !== undefined
              ? { initialFile: fullPageDiff.file }
              : {})}
            {...(fullPageDiff.base !== undefined
              ? { initialBase: fullPageDiff.base }
              : {})}
            onClose={() => useUiStore.setState({ fullPageDiff: null })}
          />
        </div>
      )}

      {/* Command palette */}
      <CommandPalette
        open={spotlightOpen}
        workspaces={repos}
        sessions={sessions}
        actionContext={actionContext}
        onClose={() => setSpotlightOpen(false)}
        onSelectWorkspace={(path) => {
          setActiveRepoPath(path);
          setActiveSessionId(recallSessionForWorkspace(path));
          closeSidebar();
        }}
        onSelectSession={(id) => handleSelectSession(id)}
        onSelectPr={handlePaletteSelectPr}
        onOpenSettings={(sectionId) => {
          setSpotlightOpen(false);
          setActiveModal({ modal: 'settings', scrollToId: sectionId ?? null });
        }}
      />

      {/* Open Picker (/ or Cmd+K)
          TODO: The React OpenPicker.tsx is a generic stub; port the Svelte session-intent
          picker (OpenPicker.svelte) to React to restore full PR/branch/issue selection. */}
      {pickerOpen && (
        <OpenPicker
          items={[]}
          onSelect={() => setPickerOpen(false)}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {/* File Picker (Cmd+O) */}
      <FilePicker
        open={filePickerOpen}
        workspacePath={activeWorkspaceCwd}
        changedFiles={lastChangedFiles}
        recentFiles={openFileTabs}
        onClose={() => setFilePickerOpen(false)}
        onSelect={(path, isChanged) => {
          openFileTab(path, isChanged);
          setFilePickerOpen(false);
        }}
      />

      {/* Toasts */}
      <UpdateToast />
      <InstallBanner />
      <ErrorToast />
      <NotificationStack />
    </QueryClientProvider>
  );
}
