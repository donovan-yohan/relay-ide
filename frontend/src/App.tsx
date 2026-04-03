import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createLogger } from './lib/logger.js';
import { useAuthStore } from './lib/stores/auth.js';
import { useUiStore } from './lib/stores/ui.js';
import { useSessionsStore } from './lib/stores/sessions.js';
import { useConfigStore } from './lib/stores/config.js';
import { useBootStateStore } from './lib/stores/boot-state.js';
import { useToastStore } from './lib/stores/toasts.js';
import { useTelemetryStore } from './lib/stores/telemetry.js';
import { connectEventSocket, sendPtyData } from './lib/ws.js';
import { initNotifications, initPushNotifications, resubscribeIfNeeded } from './lib/notifications.js';
import { isMobileDevice, isMac, estimateTerminalDimensions } from './lib/utils.js';
import type { AccountTelemetry, SessionTelemetry, WorktreeInfo, Repo, PullRequest } from './lib/types.js';
import {
  createWorktree,
  createSession,
  fetchWorkspaceSettings,
  killSession,
  deleteWorktree,
  setDefaultYolo,
  renameSession as renameSessionApi,
  launchWorkspaceSession,
} from './lib/api.js';
import { derivePrAction, buildPrStateInput, getActionPrompt } from './lib/pr-state.js';
import { initAnalytics, destroyAnalytics, track } from './lib/analytics.js';
import { registerGlobal, getAllActions } from './lib/actions/registry.js';
import { setupShortcutListener } from './lib/actions/shortcuts.js';
import type { Action, ActionContext } from './lib/actions/types.js';
import {
  sessionNewAgent,
  sessionNewTerminal,
  sessionCloseActive,
  sessionKill,
  sessionStartOnRepo,
  sessionStartOnTicket,
  sessionCustomize,
  sessionSwitchToTab,
  sessionRename,
} from './lib/actions/definitions/session.js';
import {
  workspaceAdd,
  workspaceNewWorktree,
} from './lib/actions/definitions/workspace.js';
import {
  prCreate,
  prPushBranch,
  prSwitchBranch,
  prFixConflicts,
  prArchiveBranch,
  prRenameBranch,
  prCopyBranchName,
  prOpenExternal,
  prRefresh,
  prChangeTarget,
  prSkipChecks,
} from './lib/actions/definitions/pr.js';
import {
  settingsOpen,
  settingsConnectGithub,
  settingsToggleYolo,
  settingsCheckUpdates,
  settingsDisconnectGithub,
  settingsSetupWebhooks,
  settingsRemoveWebhook,
  settingsTestWebhook,
  settingsConnectJira,
  settingsDisconnectJira,
  settingsToggleDevTools,
  settingsClearAnalytics,
  settingsToggleContinue,
  settingsToggleTmux,
  settingsToggleNotifications,
  settingsChangeDefaultAgent,
} from './lib/actions/definitions/settings.js';
import {
  sidebarCollapse,
  sidebarNavigateDashboard,
  sidebarWorkspaceSettings,
  sidebarRenameSession,
  sidebarDeleteWorktree,
  sidebarResumeSession,
  sidebarResumeYolo,
} from './lib/actions/definitions/sidebar.js';
import {
  dashboardOpenPrSession,
  dashboardSortPrs,
  dashboardClearFilters,
  orgSwitchTab,
  orgSaveFilter,
  orgDeleteFilter,
  orgTogglePrStatus,
  orgNavigateToWorkspace,
  ticketSwitchProvider,
  ticketOpenExternal,
} from './lib/actions/definitions/dashboard.js';
import { terminalScrollTop, terminalScrollBottom } from './lib/actions/definitions/terminal.js';
import { navPreviousTab, navNextTab, navSwitchToTab, navOpenFile } from './lib/actions/definitions/navigation.js';

import BootScreen from './components/BootScreen.js';
import PinGate from './components/PinGate.js';
import Sidebar from './components/Sidebar.js';
import Terminal from './components/Terminal.js';
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
import { ImageToast } from './components/ImageToast.js';
import type { ImageToastHandle } from './components/ImageToast.js';
import ErrorToast from './components/ErrorToast.js';
import CommandPalette from './components/CommandPalette.js';
import OpenPicker from './components/OpenPicker.js';
import FilePicker from './components/FilePicker.js';
import type { SessionIntent, PickerItem } from './lib/session-intent.js';
import { issueToBranchName } from './lib/session-intent.js';
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
import { FileTreeSidebar, type FileTreeSidebarHandle } from './components/FileTreeSidebar.js';

import './App.css';

const logger = createLogger('App');

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
let _navigateToSessionFn: ((sessionId: string, sessionType: string) => void) | null = null;
initNotifications((sessionId: string, sessionType: string) => {
  _navigateToSessionFn?.(sessionId, sessionType);
});

// ─── App Component ────────────────────────────────────────────────────────────

export default function App() {
  // ── Auth store ─────────────────────────────────────────────────────────────
  const authChecking = useAuthStore((s) => s.checking);
  const authAuthenticated = useAuthStore((s) => s.authenticated);
  const authNeedsSetup = useAuthStore((s) => s.needsSetup);
  const checkExistingAuth = useAuthStore((s) => s.checkExistingAuth);

  // ── UI store ───────────────────────────────────────────────────────────────
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const openSidebar = useUiStore((s) => s.openSidebar);
  const closeSidebar = useUiStore((s) => s.closeSidebar);
  const activeRepoPath = useUiStore((s) => s.activeRepoPath);
  const setActiveRepoPath = useUiStore((s) => s.setActiveRepoPath);
  const keyboardOpen = useUiStore((s) => s.keyboardOpen);
  const fullPageDiff = useUiStore((s) => s.fullPageDiff);
  const lastChangedFiles = useUiStore((s) => s.lastChangedFiles);
  const openFileTabs = useUiStore((s) => s.openFileTabs);
  const rightSidebarCollapsed = useUiStore((s) => s.rightSidebarCollapsed);
  const rightSidebarWidth = useUiStore((s) => s.rightSidebarWidth);
  const saveRightSidebarWidth = useUiStore((s) => s.saveRightSidebarWidth);
  const fileViewerRatio = useUiStore((s) => s.fileViewerRatio);
  const saveFileViewerRatio = useUiStore((s) => s.saveFileViewerRatio);
  const openFileTab = useUiStore((s) => s.openFileTab);

  // ── Sessions store ─────────────────────────────────────────────────────────
  const sessions = useSessionsStore((s) => s.sessions);
  const worktrees = useSessionsStore((s) => s.worktrees);
  const repos = useSessionsStore((s) => s.repos);
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const setActiveSessionId = useSessionsStore((s) => s.setActiveSessionId);
  const recallSessionForWorkspace = useSessionsStore((s) => s.recallSessionForWorkspace);
  const isItemLoading = useSessionsStore((s) => s.isItemLoading);

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
  const [copyModeActive, setCopyModeActive] = useState(false);
  const [changedFilesData, setChangedFilesData] = useState<string[]>([]);
  const [analyticsView, setAnalyticsView] = useState<'dashboard' | { sessionId: string } | null>(null);

  // ── Refs ───────────────────────────────────────────────────────────────────
  const terminalRef = useRef<TerminalHandle>(null);
  const imageToastRef = useRef<ImageToastHandle>(null);
  const customizeDialogRef = useRef<CustomizeSessionDialogHandle>(null);
  const settingsDialogRef = useRef<SettingsDialogHandle>(null);
  const deleteWorktreeDialogRef = useRef<DeleteWorktreeDialogHandle>(null);
  const addWorkspaceDialogRef = useRef<AddWorkspaceDialogHandle>(null);
  const workspaceSettingsDialogRef = useRef<WorkspaceSettingsDialogHandle>(null);
  const mainAppRef = useRef<HTMLDivElement>(null);
  const fileTreeSidebarRef = useRef<FileTreeSidebarHandle>(null);
  const changedFilesThrottleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bootRefreshDone = useRef(false);

  // ── Derived state ──────────────────────────────────────────────────────────
  const activeWorkspace = useMemo(
    () => (activeRepoPath ? repos.find((w) => w.path === activeRepoPath) : undefined),
    [activeRepoPath, repos],
  );

  const allWorkspaceSessions = useMemo(
    () =>
      activeRepoPath
        ? useSessionsStore.getState().getSessionsForRepo(activeRepoPath)
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeRepoPath, sessions],
  );

  const activeSession = useMemo(
    () => (activeSessionId ? sessions.find((s) => s.id === activeSessionId) : undefined),
    [activeSessionId, sessions],
  );

  // Tab bar shows only sessions in the SAME worktree/directory as the active session.
  // Sorted by createdAt so new tabs always appear rightmost.
  const workspaceSessions = useMemo(
    () =>
      (activeSession
        ? allWorkspaceSessions.filter((s) => s.cwd === activeSession.cwd)
        : allWorkspaceSessions
      ).toSorted((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
    [activeSession, allWorkspaceSessions],
  );

  const hasActiveSession = useMemo(
    () => !!activeSession && !!activeRepoPath && activeSession.repoPath === activeRepoPath,
    [activeSession, activeRepoPath],
  );

  const sessionTitle = useMemo(
    () => activeSession?.displayName || activeWorkspace?.name || 'Relay',
    [activeSession, activeWorkspace],
  );

  const activeSessionUseTmux = useMemo(() => activeSession?.useTmux ?? false, [activeSession]);

  const viewMode = useMemo<'empty' | 'org' | 'dashboard' | 'session' | 'analytics'>(() => {
    if (analyticsView !== null) return 'analytics';
    if (!repos.length) return 'empty';
    if (!activeRepoPath) return 'org';
    if (!hasActiveSession) return 'dashboard';
    return 'session';
  }, [analyticsView, repos.length, activeRepoPath, hasActiveSession]);

  // Active workspace cwd — use worktreePath/repoPath (stable root), not cwd which can drift
  const activeWorkspaceCwd = useMemo(
    () => activeSession?.worktreePath ?? activeSession?.repoPath ?? '',
    [activeSession],
  );

  const fileViewerOpen = useMemo(() => openFileTabs.length > 0, [openFileTabs]);

  // ── Action context ─────────────────────────────────────────────────────────
  const actionContext = useMemo<ActionContext>(() => {
    if (activeSessionId) {
      const ctx: ActionContext = { view: 'session', sessionId: activeSessionId };
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

  // ── Navigation helpers ─────────────────────────────────────────────────────
  const navigateToDashboard = useCallback(() => {
    useSessionsStore.getState().setActiveSessionId(null);
  }, []);

  const navigateToSession = useCallback(
    (sessionId: string, _sessionType: string) => {
      useSessionsStore.getState().setActiveSessionId(sessionId);
      const session = useSessionsStore.getState().sessions.find((s) => s.id === sessionId);
      if (session) {
        useUiStore.getState().setActiveRepoPath(session.repoPath);
      }
      useSessionsStore.getState().handleUserViewed(sessionId);
      useUiStore.getState().closeSidebar();
    },
    [],
  );

  // Wire the module-level notifications forwarder to the live navigateToSession
  useEffect(() => {
    _navigateToSessionFn = navigateToSession;
    return () => {
      _navigateToSessionFn = null;
    };
  }, [navigateToSession]);

  const handleRenameActiveSession = useCallback(async () => {
    const name = prompt('rename session:');
    const id = useSessionsStore.getState().activeSessionId;
    if (name?.trim() && id) {
      await renameSessionApi(id, name.trim());
    }
  }, []);

  // ── Session handlers ───────────────────────────────────────────────────────
  const handleSelectSession = useCallback((id: string) => {
    setAnalyticsView(null);
    useSessionsStore.getState().setActiveSessionId(id);
    const session = useSessionsStore.getState().sessions.find((s) => s.id === id);
    if (session) {
      useSessionsStore.getState().rememberSessionForWorkspace(session.repoPath, id);
      useUiStore.getState().setActiveRepoPath(session.repoPath);
    }
    useSessionsStore.getState().handleUserViewed(id);
    useUiStore.getState().closeSidebar();
    terminalRef.current?.focusTerm();
  }, []);

  const handleSelectWorkspace = useCallback((path: string) => {
    setAnalyticsView(null);
    const currentRepoPath = useUiStore.getState().activeRepoPath;
    if (currentRepoPath === path) {
      // Already viewing this workspace — toggle between session and dashboard
      if (useSessionsStore.getState().activeSessionId) {
        useSessionsStore.getState().setActiveSessionId(null);
      } else {
        const recalled = useSessionsStore.getState().recallSessionForWorkspace(path);
        if (recalled) useSessionsStore.getState().setActiveSessionId(recalled);
      }
    } else {
      useUiStore.getState().setActiveRepoPath(path);
      useSessionsStore.getState().setActiveSessionId(
        useSessionsStore.getState().recallSessionForWorkspace(path),
      );
    }
    useUiStore.getState().closeSidebar();
  }, []);

  const handleQuickAgent = useCallback(async () => {
    const currentRepoPath = useUiStore.getState().activeRepoPath;
    const currentActiveWorkspace = currentRepoPath
      ? useSessionsStore.getState().repos.find((w) => w.path === currentRepoPath)
      : undefined;
    if (!currentActiveWorkspace) return;
    const currentActiveSessionId = useSessionsStore.getState().activeSessionId;
    const currentActiveSession = currentActiveSessionId
      ? useSessionsStore.getState().sessions.find((s) => s.id === currentActiveSessionId)
      : undefined;
    const { cols, rows } = estimateTerminalDimensions();
    try {
      const session = await createSession({
        repoPath: currentActiveWorkspace.path,
        worktreePath: currentActiveSession?.worktreePath ?? null,
        type: 'agent',
        cols,
        rows,
      });
      await useSessionsStore.getState().refreshAll();
      if (session?.id) {
        useSessionsStore.getState().setActiveSessionId(session.id);
        useSessionsStore.getState().initSessionNotification(
          session.id,
          useConfigStore.getState().defaultNotifications,
        );
      }
    } catch (err: unknown) {
      if (err instanceof Error && 'sessionId' in err) {
        const conflictErr = err as Error & { sessionId?: string };
        await useSessionsStore.getState().refreshAll();
        if (conflictErr.sessionId) {
          useSessionsStore.getState().setActiveSessionId(conflictErr.sessionId);
        }
      } else {
        logger.error('Failed to create agent session:', err);
        useToastStore
          .getState()
          .showToast(err instanceof Error ? err.message : 'failed to create agent session');
      }
    }
  }, []);

  const handleQuickTerminal = useCallback(async () => {
    const currentRepoPath = useUiStore.getState().activeRepoPath;
    const currentActiveWorkspace = currentRepoPath
      ? useSessionsStore.getState().repos.find((w) => w.path === currentRepoPath)
      : undefined;
    if (!currentActiveWorkspace) return;
    const currentActiveSessionId = useSessionsStore.getState().activeSessionId;
    const currentActiveSession = currentActiveSessionId
      ? useSessionsStore.getState().sessions.find((s) => s.id === currentActiveSessionId)
      : undefined;
    try {
      const session = await createSession({
        repoPath: currentActiveWorkspace.path,
        worktreePath: currentActiveSession?.worktreePath ?? null,
        type: 'terminal',
      });
      await useSessionsStore.getState().refreshAll();
      if (session?.id) {
        useSessionsStore.getState().setActiveSessionId(session.id);
        useSessionsStore.getState().initSessionNotification(
          session.id,
          useConfigStore.getState().defaultNotifications,
        );
      }
    } catch (err) {
      logger.error('Failed to create terminal session:', err);
      useToastStore
        .getState()
        .showToast(err instanceof Error ? err.message : 'failed to create terminal session');
    }
  }, []);

  const handleCustomize = useCallback(() => {
    const currentRepoPath = useUiStore.getState().activeRepoPath;
    const currentActiveWorkspace = currentRepoPath
      ? useSessionsStore.getState().repos.find((w) => w.path === currentRepoPath)
      : undefined;
    if (currentActiveWorkspace) {
      customizeDialogRef.current?.open({
        name: currentActiveWorkspace.name,
        path: currentActiveWorkspace.path,
      });
    }
  }, []);

  const handleOpenSettings = useCallback((workspace?: Repo) => {
    if (workspace) {
      workspaceSettingsDialogRef.current?.open(workspace.path, workspace.name);
    } else {
      settingsDialogRef.current?.open();
    }
  }, []);

  const handleNewWorktree = useCallback(async (workspace: Repo) => {
    const loadingKey = `new-worktree:${workspace.path}`;
    if (useSessionsStore.getState().isItemLoading(loadingKey)) return;
    useSessionsStore.getState().setLoading(loadingKey);
    try {
      const { branchName, worktreePath } = await createWorktree(workspace.path);
      const session = await createSession({
        repoPath: workspace.path,
        worktreePath,
        type: 'agent',
        branchName,
        needsBranchRename: true,
      });
      await useSessionsStore.getState().refreshAll();
      useSessionsStore.getState().setActiveSessionId(session.id);
      useUiStore.getState().setActiveRepoPath(workspace.path);
      useSessionsStore.getState().initSessionNotification(
        session.id,
        useConfigStore.getState().defaultNotifications,
      );
      useUiStore.getState().closeSidebar();
      terminalRef.current?.focusTerm();
    } catch (e) {
      logger.error('Failed to create worktree session:', e);
      useToastStore
        .getState()
        .showToast(e instanceof Error ? e.message : 'failed to create worktree');
      // Fall back to dialog on error so user can retry with options
      customizeDialogRef.current?.open({ name: workspace.name, path: workspace.path });
    } finally {
      useSessionsStore.getState().clearLoading(loadingKey);
    }
  }, []);

  const handleLaunchWorkspaceSession = useCallback(async (workspaceId: string) => {
    const loadingKey = `ws-launch:${workspaceId}`;
    if (useSessionsStore.getState().isItemLoading(loadingKey)) return;
    useSessionsStore.getState().setLoading(loadingKey);
    try {
      const result = await launchWorkspaceSession(workspaceId);
      await useSessionsStore.getState().refreshAll();
      useSessionsStore.getState().setActiveSessionId(result.id);
      useUiStore.getState().setActiveRepoPath(result.repoPath);
      useUiStore.getState().setActiveWorkspaceId(workspaceId);
      useUiStore.getState().closeSidebar();

      if (result.warnings?.length) {
        const msgs = result.warnings
          .map((w: { repoPath: string; error: string }) => `  ${w.repoPath}: ${w.error}`)
          .join('\n');
        logger.warn('[workspace-session] partial failure:', result.warnings);
        alert(`workspace launched with warnings:\n${msgs}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      logger.error('[workspace-session] launch failed:', err);
      alert(`workspace launch failed: ${message}`);
    } finally {
      useSessionsStore.getState().clearLoading(loadingKey);
    }
  }, []);

  const handleFixConflicts = useCallback(async (pr: PullRequest) => {
    const currentRepoPath = useUiStore.getState().activeRepoPath;
    const currentActiveWorkspace = currentRepoPath
      ? useSessionsStore.getState().repos.find((w) => w.path === currentRepoPath)
      : undefined;
    if (!currentActiveWorkspace) return;
    const repoPath = currentActiveWorkspace.path;

    const currentSessions = useSessionsStore.getState().sessions;
    const currentWorktrees = useSessionsStore.getState().worktrees;
    const existingSession = currentSessions.find(
      (s) => s.branchName === pr.headRefName && s.repoPath === repoPath,
    );
    const existingWorktree = currentWorktrees.find(
      (w) => w.branchName === pr.headRefName && w.repoPath === repoPath,
    );

    let prompt = `Merge the branch "${pr.baseRefName}" into this branch and resolve all merge conflicts. Use \`git merge ${pr.baseRefName}\` and fix any conflicts in the working tree. After resolving, verify the build passes.`;
    try {
      const settings = await fetchWorkspaceSettings(repoPath);
      if (settings.promptFixConflicts) {
        prompt = settings.promptFixConflicts
          .replace(/\{baseRefName\}/g, pr.baseRefName)
          .replace(/\{headRefName\}/g, pr.headRefName);
      }
    } catch {
      // fall through with default prompt
    }

    try {
      let worktreePath: string | null;
      let branchName: string;

      if (existingSession) {
        worktreePath = existingSession.worktreePath;
        branchName = existingSession.branchName;
      } else if (existingWorktree) {
        worktreePath = existingWorktree.path;
        branchName = existingWorktree.branchName;
      } else {
        const wt = await createWorktree(repoPath, pr.headRefName);
        worktreePath = wt.worktreePath;
        branchName = wt.branchName;
      }

      const session = await createSession({
        repoPath,
        worktreePath,
        type: 'agent',
        branchName,
      });
      await useSessionsStore.getState().refreshAll();
      useSessionsStore.getState().setActiveSessionId(session.id);
      useUiStore.getState().setActiveRepoPath(repoPath);
      useSessionsStore.getState().initSessionNotification(
        session.id,
        useConfigStore.getState().defaultNotifications,
      );
      useUiStore.getState().closeSidebar();

      // Delay sending the prompt to allow the terminal WebSocket connection to establish
      setTimeout(() => {
        sendPtyData(prompt + '\r');
      }, 1500);
    } catch (e) {
      logger.error('Failed to start conflict resolution:', e);
      useToastStore
        .getState()
        .showToast(e instanceof Error ? e.message : 'failed to start conflict resolution');
    }
  }, []);

  const handleOpenPrBranch = useCallback(async (pr: PullRequest, prompt?: string) => {
    const currentRepoPath = useUiStore.getState().activeRepoPath;
    const currentActiveWorkspace = currentRepoPath
      ? useSessionsStore.getState().repos.find((w) => w.path === currentRepoPath)
      : undefined;
    if (!currentActiveWorkspace) return;
    const repoPath = currentActiveWorkspace.path;

    const currentSessions = useSessionsStore.getState().sessions;
    const currentWorktrees = useSessionsStore.getState().worktrees;
    const existingSession = currentSessions.find(
      (s) => s.branchName === pr.headRefName && s.repoPath === repoPath,
    );
    const existingWorktree = currentWorktrees.find(
      (w) => w.branchName === pr.headRefName && w.repoPath === repoPath,
    );

    try {
      let worktreePath: string | null;
      let branchName: string;

      if (existingSession) {
        worktreePath = existingSession.worktreePath;
        branchName = existingSession.branchName;
      } else if (existingWorktree) {
        worktreePath = existingWorktree.path;
        branchName = existingWorktree.branchName;
      } else {
        const wt = await createWorktree(repoPath, pr.headRefName);
        worktreePath = wt.worktreePath;
        branchName = wt.branchName;
      }

      const session = await createSession({
        repoPath,
        worktreePath,
        type: 'agent',
        branchName,
      });
      await useSessionsStore.getState().refreshAll();
      useSessionsStore.getState().setActiveSessionId(session.id);
      useUiStore.getState().setActiveRepoPath(repoPath);
      useSessionsStore.getState().initSessionNotification(
        session.id,
        useConfigStore.getState().defaultNotifications,
      );
      useUiStore.getState().closeSidebar();

      // TODO: replace setTimeout with event-driven terminal-ready signal to avoid race condition on slow connections
      if (prompt) {
        setTimeout(() => {
          sendPtyData(prompt + '\r');
        }, 1500);
      }
    } catch (e) {
      logger.error('Failed to open PR branch session:', e);
      useToastStore
        .getState()
        .showToast(e instanceof Error ? e.message : 'failed to open session on this branch');
    }
  }, []);

  const handleOpenBranchSession = useCallback(
    async (branchName: string, repoPath: string, prompt?: string) => {
      try {
        const currentSessions = useSessionsStore.getState().sessions;
        const currentWorktrees = useSessionsStore.getState().worktrees;
        const existingSession = currentSessions.find(
          (s) => s.branchName === branchName && s.repoPath === repoPath,
        );
        const existingWorktree = currentWorktrees.find(
          (w) => w.branchName === branchName && w.repoPath === repoPath,
        );

        let worktreePath: string | null;
        let resolvedBranch: string;

        if (existingSession) {
          worktreePath = existingSession.worktreePath;
          resolvedBranch = existingSession.branchName;
        } else if (existingWorktree) {
          worktreePath = existingWorktree.path;
          resolvedBranch = existingWorktree.branchName;
        } else {
          const wt = await createWorktree(repoPath, branchName);
          worktreePath = wt.worktreePath;
          resolvedBranch = wt.branchName;
        }

        const session = await createSession({
          repoPath,
          worktreePath,
          type: 'agent',
          branchName: resolvedBranch,
        });
        await useSessionsStore.getState().refreshAll();
        useSessionsStore.getState().setActiveSessionId(session.id);
        useUiStore.getState().setActiveRepoPath(repoPath);
        useSessionsStore.getState().initSessionNotification(
          session.id,
          useConfigStore.getState().defaultNotifications,
        );
        useUiStore.getState().closeSidebar();

        // TODO: replace setTimeout with event-driven terminal-ready signal to avoid race condition on slow connections
        if (prompt) {
          setTimeout(() => sendPtyData(prompt + '\r'), 1500);
        }
      } catch (e) {
        logger.error('Failed to open branch session:', e);
      }
    },
    [],
  );

  const handleArchive = useCallback(async () => {
    const sessionId = useSessionsStore.getState().activeSessionId;
    if (!sessionId) return;
    const session = useSessionsStore.getState().sessions.find((s) => s.id === sessionId);
    if (!session) return;

    // Kill the session
    await killSession(sessionId);

    // If worktree session, delete the worktree too
    if (session.worktreePath !== null) {
      try {
        await deleteWorktree(session.worktreePath, session.repoPath);
      } catch {
        // Best effort — worktree may already be gone
      }
    }

    // Clear active session and refresh
    useSessionsStore.getState().setActiveSessionId(null);
    await useSessionsStore.getState().refreshAll();
  }, []);

  const handlePickerIntent = useCallback(
    async (intent: SessionIntent, item: PickerItem) => {
      switch (intent.type) {
        case 'resume-session': {
          if (intent.existingSessionId) {
            navigateToSession(intent.existingSessionId, 'agent');
          } else {
            logger.warn('resume-session intent missing existingSessionId');
          }
          break;
        }
        case 'fix-conflicts': {
          if (item.kind === 'pr') {
            handleFixConflicts(item.pr);
          }
          break;
        }
        case 'review-pr':
        case 'fix-errors':
        case 'resolve-comments':
        case 'create-pr': {
          if (item.kind === 'pr') {
            handleOpenPrBranch(item.pr, intent.prompt ?? undefined);
          }
          break;
        }
        case 'merge-pr': {
          if (item.kind === 'pr') {
            window.open(item.pr.url, '_blank');
          }
          break;
        }
        case 'open-branch': {
          if (item.kind === 'branch') {
            await handleOpenBranchSession(item.name, item.repoPath, intent.prompt ?? undefined);
          }
          break;
        }
        case 'start-from-issue': {
          if (item.kind === 'issue') {
            const branchName = issueToBranchName(item.issue);
            await handleOpenBranchSession(branchName, item.issue.repoPath, intent.prompt ?? undefined);
          }
          break;
        }
        case 'archive': {
          // TODO: wire to archive flow with confirmation UX
          if (intent.existingSessionId) {
            useSessionsStore.getState().setActiveSessionId(intent.existingSessionId);
            await handleArchive();
          }
          break;
        }
      }
    },
    [navigateToSession, handleFixConflicts, handleOpenPrBranch, handleOpenBranchSession, handleArchive],
  );

  const handlePrAction = useCallback(
    (pr: PullRequest) => {
      const action = derivePrAction(buildPrStateInput(pr));
      const prompt = getActionPrompt(action, {
        branchName: pr.headRefName,
        baseBranch: pr.baseRefName,
        prNumber: pr.number,
      });
      if (prompt) {
        handleOpenPrBranch(pr, prompt);
      }
    },
    [handleOpenPrBranch],
  );

  const handleOpenPrSession = useCallback(
    (pr: PullRequest) => {
      handleOpenPrBranch(pr);
    },
    [handleOpenPrBranch],
  );

  const handleDeleteWorktree = useCallback((wt: WorktreeInfo) => {
    deleteWorktreeDialogRef.current?.open(wt);
  }, []);

  const handleNewSessionCreated = useCallback((sessionId: string) => {
    useSessionsStore.getState().setActiveSessionId(sessionId);
    useSessionsStore.getState().initSessionNotification(
      sessionId,
      useConfigStore.getState().defaultNotifications,
    );
    useUiStore.getState().closeSidebar();
    terminalRef.current?.focusTerm();
  }, []);

  const handleCloseSession = useCallback((sessionId: string) => {
    // Kill session via API, then refresh
    fetch(`/sessions/${sessionId}`, { method: 'DELETE' }).then(() =>
      useSessionsStore.getState().refreshAll(),
    );
    const currentActiveSessionId = useSessionsStore.getState().activeSessionId;
    if (currentActiveSessionId === sessionId) {
      // Select next available session in this workspace
      const currentActiveSession = useSessionsStore.getState().sessions.find(
        (s) => s.id === currentActiveSessionId,
      );
      const currentRepoPath = useUiStore.getState().activeRepoPath;
      const allWs = currentRepoPath
        ? useSessionsStore.getState().getSessionsForRepo(currentRepoPath)
        : [];
      const sameDir = currentActiveSession
        ? allWs.filter((s) => s.cwd === currentActiveSession.cwd)
        : allWs;
      const remaining = sameDir.filter((s) => s.id !== sessionId);
      useSessionsStore.getState().setActiveSessionId(remaining[0]?.id ?? null);
    }
  }, []);

  const handleImageUpload = useCallback((text: string, showInsert: boolean, path?: string) => {
    imageToastRef.current?.show(text, showInsert, path);
    if (!showInsert) {
      imageToastRef.current?.autoDismiss(3000);
    }
  }, []);

  const handleSendKey = useCallback((key: string) => {
    sendPtyData(key);
  }, []);

  const handleFlushComposedText = useCallback(() => {
    /* xterm.js handles natively */
  }, []);

  const handleClearInput = useCallback(() => {
    /* xterm.js manages textarea */
  }, []);

  const handleUploadImage = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) terminalRef.current?.handleImageUpload(file, file.type);
    };
    input.click();
  }, []);

  const handleRefocusMobileInput = useCallback(() => {
    terminalRef.current?.focusTerm();
  }, []);

  const handleCopyModeChange = useCallback((active: boolean) => {
    setCopyModeActive(active);
  }, []);

  const handleExitCopyMode = useCallback(() => {
    terminalRef.current?.exitCopyMode();
  }, []);

  const handlePaletteSelectPr = useCallback(
    (pr: PullRequest) => {
      if (pr.repoPath) {
        useUiStore.getState().setActiveRepoPath(pr.repoPath);
        useSessionsStore.getState().setActiveSessionId(null);
      }
      handleOpenPrBranch(pr);
    },
    [handleOpenPrBranch],
  );

  const handleAddWorkspace = useCallback(() => {
    addWorkspaceDialogRef.current?.open();
  }, []);

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

  const handleFileSelect = useCallback(
    (filePath: string, isChanged: boolean) => {
      openFileTab(filePath, isChanged);
    },
    [openFileTab],
  );

  const handleInjectReference = useCallback((reference: string) => {
    sendPtyData(reference + ' ');
  }, []);

  const handleTerminalFilePathClick = useCallback(
    (clickedPath: string) => {
      const currentActiveSessionId = useSessionsStore.getState().activeSessionId;
      const currentActiveSession = currentActiveSessionId
        ? useSessionsStore.getState().sessions.find((s) => s.id === currentActiveSessionId)
        : undefined;
      const cwd = currentActiveSession?.worktreePath ?? currentActiveSession?.repoPath ?? '';
      if (!cwd) return;
      let relative = clickedPath;
      if (clickedPath.startsWith(cwd + '/')) {
        relative = clickedPath.slice(cwd.length + 1);
      } else if (clickedPath.startsWith('/')) {
        // Absolute path outside workspace — ignore
        return;
      } else if (clickedPath.startsWith('./')) {
        relative = clickedPath.slice(2);
      }
      // Normalize: strip any remaining leading "./" (e.g. from ${cwd}/./src/foo.ts)
      while (relative.startsWith('./')) {
        relative = relative.slice(2);
      }
      openFileTab(relative, false);
    },
    [openFileTab],
  );

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

      const params = new URLSearchParams(window.location.search);
      const sessionParam = params.get('session');
      if (sessionParam) {
        window.history.replaceState({}, '', '/');
        navigateToSession(sessionParam, 'repo');
      }

      // Auto-select if exactly one session exists and none is selected
      const currentSessions = useSessionsStore.getState().sessions;
      const currentActiveSessionId = useSessionsStore.getState().activeSessionId;
      if (!currentActiveSessionId && !sessionParam && currentSessions.length === 1) {
        handleSelectSession(currentSessions[0]!.id);
      }

      // Initialize notifications for existing sessions
      for (const s of useSessionsStore.getState().sessions) {
        useSessionsStore
          .getState()
          .initSessionNotification(s.id, useConfigStore.getState().defaultNotifications);
      }

      initPushNotifications().then(() => {
        resubscribeIfNeeded(useSessionsStore.getState().getNotificationSessionIds());
      });
    };

    runRefresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authAuthenticated]);

  // ── Event socket ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!authAuthenticated) return;

    const refChangedTimers = new Map<string, ReturnType<typeof setTimeout>>();
    let pollInvalidateTimer: ReturnType<typeof setTimeout> | null = null;

    function invalidatePrData(): void {
      // Invalidate TanStack Query caches for PrTopBar individual queries
      queryClient.invalidateQueries({ queryKey: ['pr'] });
      queryClient.invalidateQueries({ queryKey: ['ci-status'] });
      // Re-enrich sidebar batch data
      useSessionsStore.getState().enrichSidebarBranches();
    }

    /** Throttled invalidation for poll-based events (pr-updated/ci-updated).
     *  Schedules one invalidation 500ms after the first event; subsequent
     *  events within the window are dropped. */
    function throttledPollInvalidate(): void {
      if (pollInvalidateTimer) return;
      pollInvalidateTimer = setTimeout(() => {
        pollInvalidateTimer = null;
        invalidatePrData();
        queryClient.invalidateQueries({ queryKey: ['org-prs'] });
      }, 500);
    }

    connectEventSocket(
      (msg) => {
        if (msg.type === 'worktrees-changed') {
          useSessionsStore.getState().refreshAll();
        } else if (msg.type === 'session-backend-state-changed') {
          useSessionsStore
            .getState()
            .handleBackendStateChanged(msg.sessionId, msg.state, msg.permissionType);
        } else if (msg.type === 'session-renamed') {
          useSessionsStore
            .getState()
            .renameSession(msg.sessionId, msg.branchName, msg.displayName);
          invalidatePrData();
        } else if (msg.type === 'session-branch-changed') {
          useSessionsStore.getState().handleBranchChanged(msg.sessionId, msg.branch);
        } else if (msg.type === 'session-ended') {
          invalidatePrData();
          useSessionsStore.getState().refreshAll();
        } else if (msg.type === 'ref-changed') {
          const key = msg.cwdPath;
          const existing = refChangedTimers.get(key);
          if (existing) clearTimeout(existing);
          refChangedTimers.set(
            key,
            setTimeout(() => {
              refChangedTimers.delete(key);
              invalidatePrData();
            }, 5000),
          );
        } else if (msg.type === 'pr-updated' || msg.type === 'ci-updated') {
          throttledPollInvalidate();
        } else if (msg.type === 'files-changed') {
          const currentActiveSessionId = useSessionsStore.getState().activeSessionId;
          const currentActiveSession = currentActiveSessionId
            ? useSessionsStore.getState().sessions.find((s) => s.id === currentActiveSessionId)
            : undefined;
          const activeWs = currentActiveSession?.cwd ?? currentActiveSession?.repoPath;
          if (activeWs === msg.workspacePath) {
            throttledChangedFilesRefresh();
            queryClient.invalidateQueries({ queryKey: ['files-list'] });
            if (msg.changedFiles) {
              setChangedFilesData(msg.changedFiles);
            }
          }
        } else if (msg.type === 'session-activity-changed') {
          useSessionsStore
            .getState()
            .handleActivityChanged(msg.sessionId, msg.timestamp, msg.currentActivity ?? undefined);
        } else if (msg.type === 'session-telemetry') {
          useTelemetryStore
            .getState()
            .handleSessionTelemetryEvent(
              msg.sessionId,
              msg.data as SessionTelemetry | Record<string, unknown>,
            );
        } else if (msg.type === 'account-telemetry') {
          useTelemetryStore
            .getState()
            .handleAccountTelemetryEvent(
              msg.data as AccountTelemetry | Record<string, unknown> | null,
            );
        } else if (msg.type === 'browser-tab-opened') {
          useUiStore.getState().openHtmlTab(msg.filePath, msg.token);
        } else if (msg.type === 'browser-tab-refreshed') {
          useUiStore.getState().refreshHtmlTab(msg.filePath);
        }
      },
      () => {
        void useTelemetryStore.getState().refreshTelemetry();
      },
    );

    return () => {
      for (const timer of refChangedTimers.values()) clearTimeout(timer);
      refChangedTimers.clear();
      if (pollInvalidateTimer) {
        clearTimeout(pollInvalidateTimer);
        pollInvalidateTimer = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authAuthenticated]);

  // ── Mount: analytics, boot, auth check, action registry, keyboard, viewport ─
  useEffect(() => {
    initAnalytics(() => useSessionsStore.getState().activeSessionId);
    startBoot();
    checkExistingAuth();

    // ── Action Registry ────────────────────────────────────────────────────────
    registerGlobal([
      { ...sessionNewAgent, handler: () => handleQuickAgent() },
      { ...sessionNewTerminal, handler: () => handleQuickTerminal() },
      {
        ...sessionCloseActive,
        handler: () => {
          const id = useSessionsStore.getState().activeSessionId;
          if (id) handleCloseSession(id);
        },
      },
      {
        ...sessionKill,
        handler: async () => {
          const id = useSessionsStore.getState().activeSessionId;
          if (id) {
            try {
              await killSession(id);
            } catch (err) {
              logger.error('Failed to kill session', err);
            }
            await useSessionsStore.getState().refreshAll();
          }
        },
      },
      { ...sessionStartOnRepo, handler: () => handleQuickAgent() },
      { ...sessionStartOnTicket, handler: () => navigateToDashboard() },
      { ...workspaceAdd, handler: () => addWorkspaceDialogRef.current?.open() },
      {
        ...workspaceNewWorktree,
        handler: () => {
          const currentRepoPath = useUiStore.getState().activeRepoPath;
          const ws = currentRepoPath
            ? useSessionsStore.getState().repos.find((w) => w.path === currentRepoPath)
            : undefined;
          if (ws) handleNewWorktree(ws);
        },
      },
      { ...prCreate, handler: () => navigateToDashboard() },
      { ...prPushBranch, handler: () => navigateToDashboard() },
      { ...prSwitchBranch, handler: () => navigateToDashboard() },
      { ...settingsOpen, handler: () => handleOpenSettings() },
      {
        ...settingsConnectGithub,
        handler: () => settingsDialogRef.current?.open('section-integrations'),
      },
      {
        ...settingsToggleYolo,
        handler: async () => {
          const prev = useConfigStore.getState().defaultYolo;
          useConfigStore.setState({ defaultYolo: !prev });
          try {
            await setDefaultYolo(!prev);
          } catch (err) {
            useConfigStore.setState({ defaultYolo: prev });
            logger.error('Failed to update default YOLO setting', err);
          }
        },
      },
      {
        ...settingsCheckUpdates,
        handler: () => settingsDialogRef.current?.open('section-about'),
      },
      // ── Phase 3: Session ──
      {
        ...sessionCustomize,
        handler: () => {
          const currentRepoPath = useUiStore.getState().activeRepoPath;
          const ws = currentRepoPath
            ? useSessionsStore.getState().repos.find((w) => w.path === currentRepoPath)
            : undefined;
          if (ws) customizeDialogRef.current?.open({ name: ws.name, path: ws.path });
        },
      },
      { ...sessionSwitchToTab, handler: () => {} },
      { ...sessionRename, handler: () => handleRenameActiveSession() },
      // ── Phase 3: PR ──
      { ...prFixConflicts, handler: () => navigateToDashboard() },
      { ...prArchiveBranch, handler: () => navigateToDashboard() },
      { ...prRenameBranch, handler: () => navigateToDashboard() },
      {
        ...prCopyBranchName,
        handler: async () => {
          const currentActiveSessionId = useSessionsStore.getState().activeSessionId;
          const currentActiveSession = currentActiveSessionId
            ? useSessionsStore.getState().sessions.find((s) => s.id === currentActiveSessionId)
            : undefined;
          const currentRepoPath = useUiStore.getState().activeRepoPath;
          const allWs = currentRepoPath
            ? useSessionsStore.getState().getSessionsForRepo(currentRepoPath)
            : [];
          const wsSessions = (currentActiveSession
            ? allWs.filter((s) => s.cwd === currentActiveSession.cwd)
            : allWs
          ).toSorted((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
          const branch = wsSessions[0]?.branchName;
          if (branch) await navigator.clipboard.writeText(branch);
        },
      },
      { ...prOpenExternal, handler: () => navigateToDashboard() },
      {
        ...prRefresh,
        handler: async () => {
          await useSessionsStore.getState().refreshAll();
        },
      },
      { ...prChangeTarget, handler: () => navigateToDashboard() },
      { ...prSkipChecks, handler: () => navigateToDashboard() },
      // ── Phase 3: Settings ──
      {
        ...settingsDisconnectGithub,
        handler: () => settingsDialogRef.current?.open('section-integrations'),
      },
      {
        ...settingsSetupWebhooks,
        handler: () => settingsDialogRef.current?.open('section-integrations'),
      },
      {
        ...settingsRemoveWebhook,
        handler: () => settingsDialogRef.current?.open('section-integrations'),
      },
      {
        ...settingsTestWebhook,
        handler: () => settingsDialogRef.current?.open('section-integrations'),
      },
      {
        ...settingsConnectJira,
        handler: () => settingsDialogRef.current?.open('section-integrations'),
      },
      {
        ...settingsDisconnectJira,
        handler: () => settingsDialogRef.current?.open('section-integrations'),
      },
      {
        ...settingsToggleDevTools,
        handler: () => settingsDialogRef.current?.open('section-advanced'),
      },
      {
        ...settingsClearAnalytics,
        handler: () => settingsDialogRef.current?.open('section-advanced'),
      },
      {
        ...settingsToggleContinue,
        handler: () => settingsDialogRef.current?.open('section-general'),
      },
      {
        ...settingsToggleTmux,
        handler: () => settingsDialogRef.current?.open('section-general'),
      },
      {
        ...settingsToggleNotifications,
        handler: () => settingsDialogRef.current?.open('section-general'),
      },
      {
        ...settingsChangeDefaultAgent,
        handler: () => settingsDialogRef.current?.open('section-general'),
      },
      // ── Phase 3: Sidebar ──
      {
        ...sidebarCollapse,
        handler: () => useUiStore.getState().toggleSidebarCollapsed(),
      },
      { ...sidebarNavigateDashboard, handler: () => navigateToDashboard() },
      {
        ...sidebarWorkspaceSettings,
        handler: () => {
          const currentRepoPath = useUiStore.getState().activeRepoPath;
          const ws = currentRepoPath
            ? useSessionsStore.getState().repos.find((w) => w.path === currentRepoPath)
            : undefined;
          if (ws) workspaceSettingsDialogRef.current?.open(ws.path, ws.name);
        },
      },
      { ...sidebarRenameSession, handler: () => handleRenameActiveSession() },
      {
        ...sidebarDeleteWorktree,
        handler: () => {
          const currentActiveSessionId = useSessionsStore.getState().activeSessionId;
          const currentActiveSession = currentActiveSessionId
            ? useSessionsStore.getState().sessions.find((s) => s.id === currentActiveSessionId)
            : undefined;
          const wt = useSessionsStore
            .getState()
            .worktrees.find((w) => w.path === currentActiveSession?.worktreePath);
          if (wt) deleteWorktreeDialogRef.current?.open(wt);
        },
      },
      { ...sidebarResumeSession, handler: () => handleQuickAgent() },
      { ...sidebarResumeYolo, handler: () => handleQuickAgent() },
      // ── Phase 3: Dashboard/Org/Ticket ──
      { ...dashboardOpenPrSession, handler: () => handleQuickAgent() },
      { ...dashboardSortPrs, handler: () => {} },
      { ...dashboardClearFilters, handler: () => {} },
      { ...orgSwitchTab, handler: () => {} },
      { ...orgSaveFilter, handler: () => {} },
      { ...orgDeleteFilter, handler: () => {} },
      { ...orgTogglePrStatus, handler: () => {} },
      { ...orgNavigateToWorkspace, handler: () => {} },
      { ...ticketSwitchProvider, handler: () => {} },
      { ...ticketOpenExternal, handler: () => {} },
      // ── Phase 3: Terminal ──
      {
        ...terminalScrollTop,
        handler: () => terminalRef.current?.getTerm()?.scrollToLine(0),
      },
      {
        ...terminalScrollBottom,
        handler: () => terminalRef.current?.getTerm()?.scrollToBottom(),
      },
      // ── Phase 3: Navigation ──
      {
        ...navPreviousTab,
        handler: () => {
          const currentActiveSessionId = useSessionsStore.getState().activeSessionId;
          const currentRepoPath = useUiStore.getState().activeRepoPath;
          const currentActiveSession = currentActiveSessionId
            ? useSessionsStore.getState().sessions.find((s) => s.id === currentActiveSessionId)
            : undefined;
          const allWs = currentRepoPath
            ? useSessionsStore.getState().getSessionsForRepo(currentRepoPath)
            : [];
          const wsSessions = (currentActiveSession
            ? allWs.filter((s) => s.cwd === currentActiveSession.cwd)
            : allWs
          ).toSorted((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
          if (wsSessions.length === 0) return;
          const idx = wsSessions.findIndex((s) => s.id === currentActiveSessionId);
          const prev = idx <= 0 ? wsSessions[wsSessions.length - 1] : wsSessions[idx - 1];
          if (prev) handleSelectSession(prev.id);
        },
      },
      {
        ...navNextTab,
        handler: () => {
          const currentActiveSessionId = useSessionsStore.getState().activeSessionId;
          const currentRepoPath = useUiStore.getState().activeRepoPath;
          const currentActiveSession = currentActiveSessionId
            ? useSessionsStore.getState().sessions.find((s) => s.id === currentActiveSessionId)
            : undefined;
          const allWs = currentRepoPath
            ? useSessionsStore.getState().getSessionsForRepo(currentRepoPath)
            : [];
          const wsSessions = (currentActiveSession
            ? allWs.filter((s) => s.cwd === currentActiveSession.cwd)
            : allWs
          ).toSorted((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
          if (wsSessions.length === 0) return;
          const idx = wsSessions.findIndex((s) => s.id === currentActiveSessionId);
          const next =
            idx === -1 || idx === wsSessions.length - 1 ? wsSessions[0] : wsSessions[idx + 1];
          if (next) handleSelectSession(next.id);
        },
      },
      { ...navSwitchToTab, handler: () => {} },
      {
        ...navOpenFile,
        handler: () => {
          setFilePickerOpen(true);
        },
      },
      // ── Diff view ──
      {
        id: 'workspace.open-diff-view' as const,
        label: 'open diff view',
        description: 'open full-page diff viewer for changed files',
        category: 'workspace' as const,
        shortcut: { key: 'd' },
        when: (ctx: ActionContext) => ctx.view === 'session',
        handler: () => {
          const currentActiveSessionId = useSessionsStore.getState().activeSessionId;
          const currentActiveSession = currentActiveSessionId
            ? useSessionsStore.getState().sessions.find((s) => s.id === currentActiveSessionId)
            : undefined;
          const ws = currentActiveSession?.cwd ?? currentActiveSession?.repoPath ?? '';
          if (ws) useUiStore.setState({ fullPageDiff: { workspacePath: ws } });
        },
      },
      {
        id: 'workspace.close-diff-view' as const,
        label: 'close diff view',
        description: 'close full-page diff viewer',
        category: 'workspace' as const,
        shortcut: { key: 'Escape' },
        when: () => !!useUiStore.getState().fullPageDiff,
        handler: () => {
          useUiStore.setState({ fullPageDiff: null });
        },
      },
    ] satisfies Action[]);

    // ── Mobile viewport ──────────────────────────────────────────────────────
    let cleanupViewport: (() => void) | undefined;
    let cleanupSwipe: (() => void) | undefined;

    if (isMobileDevice && window.visualViewport) {
      const vv = window.visualViewport;
      let fitTimer: ReturnType<typeof setTimeout> | null = null;

      const onViewportResize = () => {
        const kbHeight = window.innerHeight - vv.height;
        useUiStore.setState({ keyboardOpen: kbHeight > 50 });
        const el = mainAppRef.current;
        if (el) {
          el.style.height = kbHeight > 50 ? vv.height + 'px' : '';
        }
        window.scrollTo(0, 0);
        if (fitTimer) clearTimeout(fitTimer);
        fitTimer = setTimeout(() => terminalRef.current?.fitTerm(), 100);
      };
      vv.addEventListener('resize', onViewportResize);
      vv.addEventListener('scroll', onViewportResize);
      cleanupViewport = () => {
        vv.removeEventListener('resize', onViewportResize);
        vv.removeEventListener('scroll', onViewportResize);
        if (fitTimer) clearTimeout(fitTimer);
      };
    }

    // ── Keyboard shortcuts ───────────────────────────────────────────────────
    let cleanupKeydown: (() => void) | undefined;
    {
      // Special-case: Cmd+P toggles palette (must work even from inputs, before registry check)
      // Special-case: Cmd+1-9 for tab switching (dynamic, not registry-driven)
      const onSpecialKeydown = (e: KeyboardEvent) => {
        const mod = isMac ? e.metaKey : e.ctrlKey;
        if (!mod) return;

        if (e.key === 'p' && !e.shiftKey) {
          e.preventDefault();
          setSpotlightOpen((v) => !v);
          return;
        }

        const activeTag = (document.activeElement as HTMLElement | null)?.tagName;
        const isInInput =
          activeTag === 'INPUT' ||
          activeTag === 'TEXTAREA' ||
          !!(document.activeElement as HTMLElement)?.isContentEditable;

        // / — open picker (not from inputs)
        if (e.key === '/' && !mod && !isInInput) {
          e.preventDefault();
          setPickerOpen(true);
          return;
        }

        // Cmd/Ctrl+K — open picker (works from input fields)
        if (mod && e.key === 'k') {
          e.preventDefault();
          setPickerOpen((v) => !v);
          return;
        }

        // Cmd/Ctrl+O — open file picker (only when a session is active)
        const currentActiveSessionId = useSessionsStore.getState().activeSessionId;
        const currentActiveSession = currentActiveSessionId
          ? useSessionsStore.getState().sessions.find((s) => s.id === currentActiveSessionId)
          : undefined;
        const currentCwd =
          currentActiveSession?.worktreePath ?? currentActiveSession?.repoPath ?? '';
        if (mod && !e.shiftKey && e.key === 'o' && currentActiveSession && currentCwd) {
          e.preventDefault();
          setFilePickerOpen((v) => !v);
          return;
        }

        // Ctrl/Cmd+B — toggle right sidebar
        if (mod && e.key === 'b') {
          e.preventDefault();
          useUiStore.getState().toggleRightSidebarCollapsed();
          return;
        }

        if (isInInput) return;

        if (!e.shiftKey && e.key >= '1' && e.key <= '9') {
          const currentRepoPath = useUiStore.getState().activeRepoPath;
          const currentActiveSessionId2 = useSessionsStore.getState().activeSessionId;
          const currentActiveSession2 = currentActiveSessionId2
            ? useSessionsStore.getState().sessions.find((s) => s.id === currentActiveSessionId2)
            : undefined;
          const allWs = currentRepoPath
            ? useSessionsStore.getState().getSessionsForRepo(currentRepoPath)
            : [];
          const wsSessions = (currentActiveSession2
            ? allWs.filter((s) => s.cwd === currentActiveSession2.cwd)
            : allWs
          ).toSorted((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
          if (wsSessions.length === 0) return;
          e.preventDefault();
          const n = parseInt(e.key, 10);
          const target = n === 9 ? wsSessions[wsSessions.length - 1] : wsSessions[n - 1];
          if (target) handleSelectSession(target.id);
          return;
        }
      };

      document.addEventListener('keydown', onSpecialKeydown);

      // Registry-driven shortcuts (Cmd+T, Cmd+W, Cmd+Shift+[/], etc.)
      const cleanupRegistry = setupShortcutListener(
        () => getAllActions(),
        () => actionContextRef.current,
        isMac,
      );

      cleanupKeydown = () => {
        document.removeEventListener('keydown', onSpecialKeydown);
        cleanupRegistry();
      };
    }

    // ── Edge swipe (mobile) ──────────────────────────────────────────────────
    if (isMobileDevice) {
      const EDGE_ZONE = 30;
      const SWIPE_THRESHOLD = 50;
      let swipeStartX = 0;
      let swipeStartY = 0;
      let swipeTracking = false;

      const onSwipeTouchStart = (e: TouchEvent) => {
        const touch = e.touches[0];
        if (!touch) return;
        if (touch.clientX <= EDGE_ZONE && !useUiStore.getState().sidebarOpen) {
          swipeStartX = touch.clientX;
          swipeStartY = touch.clientY;
          swipeTracking = true;
        }
      };

      const onSwipeTouchMove = (e: TouchEvent) => {
        if (!swipeTracking) return;
        const touch = e.touches[0];
        if (!touch) return;
        const dx = touch.clientX - swipeStartX;
        const dy = Math.abs(touch.clientY - swipeStartY);
        if (dy > dx && (dy > 8 || dx > 8)) {
          swipeTracking = false;
          return;
        }
        if (dx >= SWIPE_THRESHOLD) {
          swipeTracking = false;
          useUiStore.getState().openSidebar();
        }
      };

      const onSwipeTouchEnd = () => {
        swipeTracking = false;
      };

      document.addEventListener('touchstart', onSwipeTouchStart, { passive: true });
      document.addEventListener('touchmove', onSwipeTouchMove, { passive: true });
      document.addEventListener('touchend', onSwipeTouchEnd);
      cleanupSwipe = () => {
        document.removeEventListener('touchstart', onSwipeTouchStart);
        document.removeEventListener('touchmove', onSwipeTouchMove);
        document.removeEventListener('touchend', onSwipeTouchEnd);
      };
    }

    // ── Hardware keyboard detection (mobile only — self-removing once triggered) ─
    if (isMobileDevice) {
      const detectKeyboard = () => {
        useUiStore.setState({ hasHardwareKeyboard: true });
        document.removeEventListener('keydown', detectKeyboard);
      };
      document.addEventListener('keydown', detectKeyboard);
    }

    return () => {
      cleanupKeydown?.();
      cleanupViewport?.();
      cleanupSwipe?.();
      destroyAnalytics();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
          onLaunchWorkspaceSession={handleLaunchWorkspaceSession}
          onOpenAnalytics={openAnalytics}
        />

        <div className="terminal-area">
          <MobileHeader
            title={sessionTitle}
            onMenuClick={openSidebar}
            onCommandClick={() => setSpotlightOpen(true)}
            hidden={keyboardOpen}
          />

          {viewMode === 'empty' && (
            <EmptyState
              heading="Add a workspace to get started"
              description="Point to any folder on your machine. Git repos get PR tracking and branch management."
              actionLabel="+ Add Workspace"
              onAction={handleAddWorkspace}
            />
          )}

          {viewMode === 'org' && (
            <OrgDashboard
              onOpenWorkspace={(path) => {
                setAnalyticsView(null);
                setActiveRepoPath(path);
                setActiveSessionId(recallSessionForWorkspace(path));
              }}
              onOpenSession={(id) => {
                setAnalyticsView(null);
                setActiveSessionId(id);
              }}
            />
          )}

          {viewMode === 'analytics' && (
            <>
              {typeof analyticsView === 'object' &&
              analyticsView !== null &&
              'sessionId' in analyticsView ? (
                <SessionDetail
                  sessionId={analyticsView.sessionId}
                  onBack={() => setAnalyticsView('dashboard')}
                />
              ) : (
                <AnalyticsDashboard
                  onSelectSession={(id) => setAnalyticsView({ sessionId: id })}
                  onClose={() => setAnalyticsView(null)}
                />
              )}
            </>
          )}

          {viewMode === 'dashboard' && (
            <RepoDashboard
              repoPath={activeRepoPath ?? ''}
              workspaceName={activeWorkspace?.name ?? ''}
              creatingWorktree={isItemLoading(`new-worktree:${activeRepoPath ?? ''}`)}
              onNewSession={() => handleQuickAgent()}
              onNewWorktree={() => {
                if (activeWorkspace) handleNewWorktree(activeWorkspace);
              }}
              onFixConflicts={handleFixConflicts}
              onPrAction={handlePrAction}
              onOpenPrSession={handleOpenPrSession}
            />
          )}

          {viewMode === 'session' && (
            <>
              <PrTopBar
                workspacePath={activeRepoPath ?? ''}
                branchName={activeSession?.branchName ?? ''}
                sessionId={activeSessionId}
                agentRunning={activeSession?.agentState === 'processing'}
                onArchive={handleArchive}
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
                      onSelectSession={handleSelectSession}
                      onCloseSession={handleCloseSession}
                      onNewAgent={() => handleQuickAgent()}
                      onNewTerminal={() => handleQuickTerminal()}
                      onCustomize={() => handleCustomize()}
                    />

                    <Terminal
                      ref={terminalRef}
                      sessionId={activeSessionId}
                      onImageUpload={handleImageUpload}
                      useTmux={activeSessionUseTmux}
                      onCopyModeChange={handleCopyModeChange}
                      onFilePathClick={handleTerminalFilePathClick}
                    />

                    {activeSessionId && (
                      <SessionStatusBar
                        sessionId={activeSessionId}
                        currentActivity={activeSession?.currentActivity ?? null}
                      />
                    )}

                    <Toolbar
                      onSendKey={handleSendKey}
                      onFlushComposedText={handleFlushComposedText}
                      onClearInput={handleClearInput}
                      onUploadImage={handleUploadImage}
                      onRefocusMobileInput={handleRefocusMobileInput}
                      useTmux={activeSessionUseTmux}
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
      </div>

      {/* Dialogs & overlays */}
      <CustomizeSessionDialog
        ref={customizeDialogRef}
        onSessionCreated={handleNewSessionCreated}
      />
      <SettingsDialog ref={settingsDialogRef} />
      <DeleteWorktreeDialog ref={deleteWorktreeDialogRef} />
      <AddWorkspaceDialog ref={addWorkspaceDialogRef} onWorkspacesAdded={handleWorkspacesAdded} />
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
            {...(fullPageDiff.file !== undefined ? { initialFile: fullPageDiff.file } : {})}
            {...(fullPageDiff.base !== undefined ? { initialBase: fullPageDiff.base } : {})}
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
          settingsDialogRef.current?.open(sectionId);
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
      <ImageToast ref={imageToastRef} />
      <ErrorToast />
    </QueryClientProvider>
  );
}
