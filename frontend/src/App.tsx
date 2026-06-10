import type React from 'react';
import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAuthStore } from './lib/stores/auth.js';
import {
  useUiStore,
  DEFAULT_UTILITY_RAIL_STATE,
  MAX_UTILITY_RAIL_WIDTH,
  MIN_UTILITY_RAIL_WIDTH,
  UTILITY_ICON_RAIL_WIDTH,
  type WorkspaceUtilityRailState,
} from './lib/stores/ui.js';
import {
  useSessionsStore,
  type BackendConnectionStatus,
} from './lib/stores/sessions.js';
import { useConfigStore } from './lib/stores/config.js';
import { useToastStore } from './lib/stores/toasts.js';
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
import type { Repo, PullRequest, SessionSummary } from './lib/types.js';
import { estimateTerminalDimensions } from './lib/utils.js';
import { createSessionWithoutActivation } from './lib/session-utils.js';
import { resolveSessionByKey, scopedSessionKey } from './lib/session-keys.js';
import { killSession } from './lib/api.js';
import {
  getMainWorkspaceSessions,
  getUtilityTerminalSessions,
} from './lib/utility-terminals.js';
import { deriveUtilityRailContext } from './lib/utility-rail-context.js';
import { initAnalytics, destroyAnalytics, track } from './lib/analytics.js';
import { startShikiGc } from './lib/stores/shiki-gc.js';
import type { ActionContext } from './lib/actions/types.js';
import { useEventSocket } from './hooks/useEventSocket.js';
import { useVisibilityRefresh } from './hooks/useVisibilityRefresh.js';
import { useAppShortcuts } from './hooks/useAppShortcuts.js';
import { useActionRegistry } from './hooks/useActionRegistry.js';
import { useSessionHandlers } from './hooks/useSessionHandlers.js';
import { useUrlNav } from './hooks/useUrlNav.js';

import BootScreen from './components/BootScreen.js';
import PinGate from './components/PinGate.js';
import Sidebar from './components/Sidebar.js';
import { getActiveTerminalHandle } from './lib/terminal-refs.js';
import PrTopBar from './components/PrTopBar.js';
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
import ConfirmationPrompt from './components/ConfirmationPrompt.js';
import InstallBanner from './components/InstallBanner.js';
import { ProdTrustBanner } from './components/ProdTrustBanner.js';
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
import EnvPickerLauncher from './components/dialogs/EnvPickerLauncher.js';
import type { LaunchEnvironmentResult } from './lib/launch-environment.js';
import HandoffPlanDialog from './components/dialogs/HandoffPlanDialog.js';
import AnalyticsDashboard from './components/AnalyticsDashboard.js';
import SessionDetail from './components/SessionDetail.js';
import FullPageDiff from './components/FullPageDiff.js';
import WorkspaceArea from './components/WorkspaceArea.js';
import { SplitPaneLayout } from './components/SplitPaneLayout.js';
import WorkspaceUtilityRail, {
  utilityRailRenderedWidth,
} from './components/WorkspaceUtilityRail.js';
import type { FileTreeHandle } from './components/FileTree/index.js';

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
        ? resolveSessionByKey(sessions, activeSessionId)
        : undefined,
    [activeSessionId, sessions]
  );

  const allWorkspaceSessions = useMemo(() => {
    const scopedSessions = activeRepoPath
      ? sessions.filter((session) => session.repoPath === activeRepoPath)
      : activeSession
        ? sessions.filter(
            (session) =>
              session.cwd === activeSession.cwd &&
              (session.nodeId ?? 'local') === (activeSession.nodeId ?? 'local')
          )
        : [];
    return scopedSessions.toSorted(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
  }, [activeRepoPath, activeSession, sessions]);

  const workspaceSessions = useMemo(
    () =>
      activeSession
        ? allWorkspaceSessions.filter((s) => s.cwd === activeSession.cwd)
        : allWorkspaceSessions,
    [activeSession, allWorkspaceSessions]
  );

  const hasActiveSession = useMemo(
    () =>
      !!activeSession &&
      (activeRepoPath ? activeSession.repoPath === activeRepoPath : true),
    [activeSession, activeRepoPath]
  );

  const sessionTitle = useMemo(
    () => activeSession?.displayName || activeWorkspace?.name || 'Relay',
    [activeSession, activeWorkspace]
  );

  const activeWorkspaceCwd = useMemo(
    () =>
      activeSession?.worktreePath ??
      activeSession?.repoPath ??
      activeSession?.cwd ??
      activeRepoPath ??
      '',
    [activeRepoPath, activeSession]
  );

  const viewMode = useMemo<
    'empty' | 'org' | 'dashboard' | 'session' | 'analytics'
  >(() => {
    if (analyticsView !== null) return 'analytics';
    if (hasActiveSession) return 'session';
    if (!repos.length) return 'empty';
    if (!activeRepoPath) return 'org';
    return 'dashboard';
  }, [analyticsView, repos.length, activeRepoPath, hasActiveSession]);

  return {
    activeRepoPath,
    activeSessionId,
    activeSession,
    activeWorkspace,
    allWorkspaceSessions,
    workspaceSessions,
    sessionTitle,
    activeWorkspaceCwd,
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

const EMPTY_UTILITY_TERMINAL_IDS: string[] = [];

function getUtilityTerminalIds(railState: WorkspaceUtilityRailState): string[] {
  return railState.utilityTerminalIds ?? EMPTY_UTILITY_TERMINAL_IDS;
}

function isUtilityRailResizable(state: WorkspaceUtilityRailState): boolean {
  return state.visible && state.selectedRailTab !== null;
}

function toggleUtilityRailForWorkspace(
  workspacePath: string,
  toggleUtilityRailVisible: (workspacePath: string) => void
): void {
  if (workspacePath) toggleUtilityRailVisible(workspacePath);
}

interface UtilityTerminalHandlerOptions {
  activeWorkspaceCwd: string;
  utilityRailStateKey: string;
  activeWorkspace?: Repo | undefined;
  activeSession?: SessionSummary | undefined;
  addUtilityTerminal: (workspacePath: string, sessionId: string) => void;
  selectUtilityTerminal: (workspacePath: string, sessionId: string) => void;
  removeUtilityTerminal: (workspacePath: string, sessionId: string) => void;
  promoteUtilityTerminal: (workspacePath: string, sessionId: string) => void;
  onSelectSession: (id: string) => void;
}

function useUtilityTerminalHandlers({
  activeWorkspaceCwd,
  utilityRailStateKey,
  activeWorkspace,
  activeSession,
  addUtilityTerminal,
  selectUtilityTerminal,
  removeUtilityTerminal,
  promoteUtilityTerminal,
  onSelectSession,
}: UtilityTerminalHandlerOptions) {
  const handleCreateUtilityTerminal = useCallback(async () => {
    if (!activeWorkspaceCwd || !utilityRailStateKey) return;
    const loadingKey = `utility-terminal:${utilityRailStateKey}`;
    if (useSessionsStore.getState().isItemLoading(loadingKey)) return;
    useSessionsStore.getState().setLoading(loadingKey);
    try {
      const { cols, rows } = estimateTerminalDimensions(
        useUiStore.getState().terminalFontSize
      );
      const repoPath =
        activeWorkspace?.path ?? activeSession?.repoPath ?? activeWorkspaceCwd;
      const worktreePath = activeSession?.worktreePath ?? null;
      const { session, error } = await createSessionWithoutActivation({
        repoPath,
        worktreePath,
        type: 'terminal',
        cols,
        rows,
      });
      const isTerminalSession = session?.type === 'terminal';
      if (isTerminalSession) {
        addUtilityTerminal(utilityRailStateKey, session.id);
        selectUtilityTerminal(utilityRailStateKey, session.id);
        if (!error) {
          useSessionsStore
            .getState()
            .initSessionNotification(
              session.id,
              useConfigStore.getState().defaultNotifications
            );
        }
      }
      if (error || (session && !isTerminalSession)) {
        useToastStore
          .getState()
          .showToast(
            error instanceof Error
              ? error.message
              : session && !isTerminalSession
                ? 'created session was not a utility terminal'
                : 'failed to create utility terminal'
          );
      }
    } finally {
      useSessionsStore.getState().clearLoading(loadingKey);
    }
  }, [
    activeSession?.repoPath,
    activeSession?.worktreePath,
    activeWorkspace?.path,
    activeWorkspaceCwd,
    addUtilityTerminal,
    selectUtilityTerminal,
    utilityRailStateKey,
  ]);

  const handleSelectUtilityTerminal = useCallback(
    (sessionId: string) => {
      if (utilityRailStateKey)
        selectUtilityTerminal(utilityRailStateKey, sessionId);
    },
    [selectUtilityTerminal, utilityRailStateKey]
  );

  const handleCloseUtilityTerminal = useCallback(
    async (sessionId: string) => {
      if (!utilityRailStateKey) return;
      const previousRailState = useUiStore
        .getState()
        .getUtilityRailState(utilityRailStateKey);
      removeUtilityTerminal(utilityRailStateKey, sessionId);
      try {
        const session = resolveSessionByKey(
          useSessionsStore.getState().sessions,
          sessionId
        );
        await killSession(session?.id ?? sessionId, session?.nodeId);
        await useSessionsStore.getState().refreshAll();
      } catch (error) {
        useUiStore.setState({
          utilityRailByWorkspace: {
            ...useUiStore.getState().utilityRailByWorkspace,
            [utilityRailStateKey]: previousRailState,
          },
        });
        useUiStore.getState().saveUtilityRailState(utilityRailStateKey);
        useToastStore
          .getState()
          .showToast(
            error instanceof Error
              ? error.message
              : 'failed to close utility terminal'
          );
      }
    },
    [removeUtilityTerminal, utilityRailStateKey]
  );

  const handlePromoteUtilityTerminal = useCallback(
    (sessionId: string) => {
      if (!utilityRailStateKey) return;
      promoteUtilityTerminal(utilityRailStateKey, sessionId);
      onSelectSession(sessionId);
    },
    [onSelectSession, promoteUtilityTerminal, utilityRailStateKey]
  );

  return {
    handleCreateUtilityTerminal,
    handleSelectUtilityTerminal,
    handleCloseUtilityTerminal,
    handlePromoteUtilityTerminal,
  };
}

// ─── TerminalAreaContent ──────────────────────────────────────────────────────
// Extracted to reduce App's cyclomatic complexity. Accesses Zustand stores
// directly to avoid a large prop surface; only truly local state/refs are passed.

interface TerminalAreaContentProps {
  setSpotlightOpen: React.Dispatch<React.SetStateAction<boolean>>;
  fileTreeSidebarRef: React.RefObject<FileTreeHandle | null>;
  onAddWorkspace: () => void;
  onImageUpload: (text: string, showInsert: boolean, path?: string) => void;
  onQuickAgent: () => Promise<void>;
  onNewWorktree: (workspace: Repo) => Promise<void>;
  onFixConflicts: (pr: PullRequest) => Promise<void>;
  onPrAction: (pr: PullRequest) => void;
  onOpenPrSession: (pr: PullRequest) => void;
  onArchive: () => Promise<void>;
  onSelectSession: (id: string) => void;
  onCloseSession: (sessionId: string, nodeId?: string) => void;
  onSessionCreated: (sessionId: string) => void;
}

function TerminalAreaContent({
  setSpotlightOpen,
  fileTreeSidebarRef,
  onAddWorkspace,
  onImageUpload,
  onQuickAgent,
  onNewWorktree,
  onFixConflicts,
  onPrAction,
  onOpenPrSession,
  onArchive,
  onSelectSession,
  onCloseSession,
  onSessionCreated,
}: TerminalAreaContentProps) {
  // Store access (layout / sidebar values not in derived state hook)
  const openSidebar = useUiStore((s) => s.openSidebar);
  const keyboardOpen = useUiStore((s) => s.keyboardOpen);
  // #862: empty-state secondary action opens the env picker modal.
  const setActiveModal = useUiStore((s) => s.setActiveModal);
  const hydrateUtilityRailState = useUiStore((s) => s.hydrateUtilityRailState);
  const setUtilityRailWidth = useUiStore((s) => s.setUtilityRailWidth);
  const saveUtilityRailState = useUiStore((s) => s.saveUtilityRailState);
  const addUtilityTerminal = useUiStore((s) => s.addUtilityTerminal);
  const selectUtilityTerminal = useUiStore((s) => s.selectUtilityTerminal);
  const removeUtilityTerminal = useUiStore((s) => s.removeUtilityTerminal);
  const promoteUtilityTerminal = useUiStore((s) => s.promoteUtilityTerminal);
  const reconcileUtilityTerminals = useUiStore(
    (s) => s.reconcileUtilityTerminals
  );
  const toggleUtilityRailVisible = useUiStore(
    (s) => s.toggleUtilityRailVisible
  );
  const openFileTab = useUiStore((s) => s.openFileTab);
  const isItemLoading = useSessionsStore((s) => s.isItemLoading);

  // ── Derived state ──────────────────────────────────────────────────────────
  const {
    activeRepoPath,
    activeSessionId,
    activeSession,
    activeWorkspace,
    allWorkspaceSessions,
    workspaceSessions,
    sessionTitle,
    activeWorkspaceCwd,
    viewMode,
    repos,
    sessions,
  } = useTerminalDerivedState();
  const utilityRailContext = useMemo(
    () =>
      deriveUtilityRailContext({
        activeRepoPath,
        ...(activeWorkspace ? { activeWorkspace } : {}),
        ...(activeSession ? { activeSession } : {}),
      }),
    [activeRepoPath, activeSession, activeWorkspace]
  );
  const utilityRailStateKey = utilityRailContext.stateKey;
  const utilityRailWorkspaceState = useUiStore((s) =>
    utilityRailStateKey
      ? s.utilityRailByWorkspace[utilityRailStateKey]
      : undefined
  );

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
  const getToolbarTerminalHandle = useCallback(
    () => getActiveTerminalHandle(),
    []
  );

  const handleExitCopyMode = useCallback(() => {
    getToolbarTerminalHandle()?.exitCopyMode();
  }, [getToolbarTerminalHandle]);
  const handleRefocusMobileInput = useCallback(() => {
    getToolbarTerminalHandle()?.focusTerm();
  }, [getToolbarTerminalHandle]);
  const handleUploadImage = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) getToolbarTerminalHandle()?.handleImageUpload(file, file.type);
    };
    input.click();
  }, [getToolbarTerminalHandle]);
  const handleTerminalFilePathClick = useCallback(
    (clickedPath: string) => {
      const sessionsState = useSessionsStore.getState();
      const currentActiveSessionId = sessionsState.activeSessionId;
      const currentActiveSession = currentActiveSessionId
        ? resolveSessionByKey(sessionsState.sessions, currentActiveSessionId)
        : undefined;
      const cwd =
        currentActiveSession?.worktreePath ??
        currentActiveSession?.repoPath ??
        currentActiveSession?.cwd ??
        '';
      const relative = resolveTerminalFilePath(clickedPath, cwd);
      if (relative !== null) {
        const currentActiveRepoPath = useUiStore.getState().activeRepoPath;
        const currentWorkspace = currentActiveRepoPath
          ? sessionsState.repos.find(
              (repo) => repo.path === currentActiveRepoPath
            )
          : undefined;
        const currentRailContext = deriveUtilityRailContext({
          activeRepoPath: currentActiveRepoPath,
          ...(currentWorkspace ? { activeWorkspace: currentWorkspace } : {}),
          ...(currentActiveSession
            ? { activeSession: currentActiveSession }
            : {}),
        });
        if (currentRailContext.stateKey) {
          useUiStore
            .getState()
            .openUtilityRailTab(currentRailContext.stateKey, 'files');
        }
        openFileTab(relative, false);
      }
    },
    [openFileTab]
  );

  useEffect(() => {
    if (utilityRailStateKey) hydrateUtilityRailState(utilityRailStateKey);
  }, [hydrateUtilityRailState, utilityRailStateKey]);

  useEffect(() => {
    if (!utilityRailStateKey) return;
    reconcileUtilityTerminals(
      utilityRailStateKey,
      new Set(
        allWorkspaceSessions
          .filter((session) => session.type === 'terminal')
          .map((session) => session.id)
      )
    );
  }, [allWorkspaceSessions, reconcileUtilityTerminals, utilityRailStateKey]);

  const utilityRailState =
    utilityRailWorkspaceState ?? DEFAULT_UTILITY_RAIL_STATE;
  const utilityTerminalIds = getUtilityTerminalIds(utilityRailState);
  const mainWorkspaceSessions = useMemo(
    () => getMainWorkspaceSessions(workspaceSessions, utilityTerminalIds),
    [workspaceSessions, utilityTerminalIds]
  );
  const utilityTerminalSessions = useMemo(
    () => getUtilityTerminalSessions(allWorkspaceSessions, utilityTerminalIds),
    [allWorkspaceSessions, utilityTerminalIds]
  );
  const utilityRailWidth = utilityRailRenderedWidth(utilityRailState);
  const utilityRailResizable = isUtilityRailResizable(utilityRailState);

  const handleUtilityRailWidthChange = useCallback(
    (width: number) => {
      if (!utilityRailStateKey || !utilityRailResizable) return;
      setUtilityRailWidth(utilityRailStateKey, width - UTILITY_ICON_RAIL_WIDTH);
    },
    [setUtilityRailWidth, utilityRailResizable, utilityRailStateKey]
  );

  const handleUtilityRailResizeEnd = useCallback(() => {
    if (utilityRailStateKey && utilityRailResizable)
      saveUtilityRailState(utilityRailStateKey);
  }, [saveUtilityRailState, utilityRailResizable, utilityRailStateKey]);

  const handleToggleUtilityRail = useCallback(() => {
    toggleUtilityRailForWorkspace(
      utilityRailStateKey,
      toggleUtilityRailVisible
    );
  }, [toggleUtilityRailVisible, utilityRailStateKey]);

  const {
    handleCreateUtilityTerminal,
    handleSelectUtilityTerminal,
    handleCloseUtilityTerminal,
    handlePromoteUtilityTerminal,
  } = useUtilityTerminalHandlers({
    activeWorkspaceCwd,
    utilityRailStateKey,
    ...(activeWorkspace ? { activeWorkspace } : {}),
    ...(activeSession ? { activeSession } : {}),
    addUtilityTerminal,
    selectUtilityTerminal,
    removeUtilityTerminal,
    promoteUtilityTerminal,
    onSelectSession,
  });

  return (
    <div className="terminal-area">
      <MobileHeader
        title={sessionTitle}
        onMenuClick={openSidebar}
        onCommandClick={() => setSpotlightOpen(true)}
        onRightSidebarClick={handleToggleUtilityRail}
        hidden={keyboardOpen}
      />

      {viewMode === 'empty' && (
        <EmptyState
          heading="add a project to get started"
          description="point to any folder on your machine. git repos get pr tracking and branch management."
          actionLabel="+ add project"
          onAction={onAddWorkspace}
          secondaryActionLabel="start a terminal on a node"
          onSecondaryAction={() => setActiveModal({ modal: 'env-picker' })}
          hint={
            onboardingHints.showNoReposHint ? (
              <Hint id={HINT_NO_REPOS} variant="inline-text">
                relay-ide manages agents and terminals across your projects.
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
          onSessionCreated={onSessionCreated}
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
          {activeRepoPath &&
            activeSession?.repoPath === activeRepoPath &&
            activeWorkspace?.kind === 'repo' && (
            <PrTopBar
              workspacePath={activeRepoPath}
              utilityRailWorkspacePath={utilityRailStateKey}
              branchName={activeSession?.branchName ?? ''}
              sessionId={activeSessionId}
              agentRunning={activeSession?.agentState === 'processing'}
              onArchive={onArchive}
            />
          )}
          <SplitPaneLayout
            rightSidebarCollapsed={!utilityRailState.visible}
            rightSidebarWidth={utilityRailWidth}
            onRightSidebarWidthChange={handleUtilityRailWidthChange}
            onRightSidebarResizeEnd={handleUtilityRailResizeEnd}
            onToggleRightSidebar={handleToggleUtilityRail}
            rightSidebarResizable={utilityRailResizable}
            rightSidebarMinWidth={
              MIN_UTILITY_RAIL_WIDTH + UTILITY_ICON_RAIL_WIDTH
            }
            rightSidebarMaxWidth={
              MAX_UTILITY_RAIL_WIDTH + UTILITY_ICON_RAIL_WIDTH
            }
            terminal={
              <>
                <WorkspaceArea
                  workspacePath={activeWorkspaceCwd}
                  sessions={mainWorkspaceSessions}
                  onInjectReference={handleInjectReference}
                  onImageUpload={onImageUpload}
                  onCopyModeChange={handleCopyModeChange}
                  onFilePathClick={handleTerminalFilePathClick}
                  onCloseSession={onCloseSession}
                />

                {activeSessionId && (
                  <SessionStatusBar
                    sessionId={activeSessionId}
                    currentActivity={activeSession?.currentActivity ?? null}
                    framework={activeSession?.agent}
                    onHandoffClick={() =>
                      useUiStore
                        .getState()
                        .setActiveModal({ modal: 'handoff-plan' })
                    }
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
            rightSidebar={
              <WorkspaceUtilityRail
                fileTreeSidebarRef={fileTreeSidebarRef}
                workspacePath={utilityRailStateKey}
                resourceContext={utilityRailContext}
                railState={utilityRailState}
                activeSession={activeSession}
                workspaceSessions={mainWorkspaceSessions}
                utilityTerminalSessions={utilityTerminalSessions}
                onCreateUtilityTerminal={handleCreateUtilityTerminal}
                onSelectUtilityTerminal={handleSelectUtilityTerminal}
                onCloseUtilityTerminal={handleCloseUtilityTerminal}
                onPromoteUtilityTerminal={handlePromoteUtilityTerminal}
                onImageUpload={onImageUpload}
                onCopyModeChange={handleCopyModeChange}
                onFilePathClick={handleTerminalFilePathClick}
              />
            }
          />
        </>
      )}
    </div>
  );
}

function BackendConnectionBanner({
  status,
}: {
  status: BackendConnectionStatus;
}) {
  if (status === 'connected') return null;
  const label =
    status === 'restarting'
      ? 'backend restarting — reconnecting'
      : 'backend unavailable — reconnecting';
  return (
    <div className="backend-connection-banner" role="status">
      {label}
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
  // Default agent for the env-picker capability gating (#862). Terminal MVP
  // gates only shell/backend, but the shared option builder still takes the
  // selected agent — pass the configured default.
  const defaultAgent = useConfigStore((s) => s.defaultAgent);

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
  const backendConnectionStatus = useSessionsStore(
    (s) => s.backendConnectionStatus
  );
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
  const setLastChangedFiles = useUiStore((s) => s.setLastChangedFiles);
  const setAnalyticsView = useUiStore((s) => s.setAnalyticsView);
  const activeModal = useUiStore((s) => s.activeModal);
  const setActiveModal = useUiStore((s) => s.setActiveModal);

  // ── Refs ───────────────────────────────────────────────────────────────────
  const customizeDialogRef = useRef<CustomizeSessionDialogHandle>(null);
  const settingsDialogRef = useRef<SettingsDialogHandle>(null);
  const deleteWorktreeDialogRef = useRef<DeleteWorktreeDialogHandle>(null);
  const addWorkspaceDialogRef = useRef<AddWorkspaceDialogHandle>(null);
  const workspaceSettingsDialogRef =
    useRef<WorkspaceSettingsDialogHandle>(null);
  const mainAppRef = useRef<HTMLDivElement>(null);
  const fileTreeSidebarRef = useRef<FileTreeHandle>(null);
  const changedFilesThrottleTimer = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const bootRefreshDone = useRef(false);
  const navRefreshMounted = useRef(false);

  // ── Derived state ──────────────────────────────────────────────────────────
  // activeSession and activeWorkspaceCwd are needed for FilePicker
  const activeSession = useMemo(
    () =>
      activeSessionId
        ? resolveSessionByKey(sessions, activeSessionId)
        : undefined,
    [activeSessionId, sessions]
  );

  // Active workspace cwd — prefer stable repo/worktree roots, falling back to cwd
  // for free terminal tabs that are not bound to a repo.
  const activeWorkspaceCwd = useMemo(
    () =>
      activeSession?.worktreePath ??
      activeSession?.repoPath ??
      activeSession?.cwd ??
      activeRepoPath ??
      '',
    [activeRepoPath, activeSession]
  );

  // ── Action context ─────────────────────────────────────────────────────────
  const actionContext = useMemo<ActionContext>(() => {
    if (activeSessionId) {
      const ctx: ActionContext = {
        view: 'session',
        sessionId: activeSessionId,
      };
      if (activeRepoPath) ctx.workspacePath = activeRepoPath;
      if (activeWorkspaceCwd) ctx.cwd = activeWorkspaceCwd;
      return ctx;
    }
    if (activeRepoPath) {
      const ctx: ActionContext = {
        view: 'workspace',
        workspacePath: activeRepoPath,
      };
      if (activeWorkspaceCwd) ctx.cwd = activeWorkspaceCwd;
      return ctx;
    }
    return { view: 'dashboard' };
  }, [activeSessionId, activeRepoPath, activeWorkspaceCwd]);

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
    handleViewSpineCreateTab,
    handleQuickTerminal,
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

  // #862: stable fallback workspace for the env picker. Only used when the
  // repo inventory is empty / hasn't surfaced the active workspace. Memoized so
  // the launcher's option list keeps reference equality across rerenders that
  // don't change the active workspace identity.
  const envPickerFallbackWorkspace = useMemo(() => {
    const ws = activeRepoPath
      ? repos.find((w) => w.path === activeRepoPath)
      : undefined;
    return ws
      ? { name: ws.name, path: ws.path, isGitRepo: ws.isGitRepo }
      : null;
  }, [activeRepoPath, repos]);

  // #862: navigate to the freshly launched terminal session. The picker already
  // closes itself on success; this only wires the new session as active.
  const onEnvPickerLaunched = useCallback(
    (result: LaunchEnvironmentResult) => {
      if (result.kind === 'launched' && result.result.session) {
        handleNewSessionCreated(result.result.session.id);
      }
    },
    [handleNewSessionCreated]
  );

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
    useSessionsStore.getState().setActiveSessionId(null);
    useUiStore.getState().setActiveRepoPath(null);
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
        // Backfill PR info and staleness via per-repo enrichment.
        useSessionsStore.getState().ensureFreshAll(0);
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
        handleSelectSession(scopedSessionKey(currentSessions[0]!));
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

  useVisibilityRefresh(authAuthenticated);

  useEffect(() => {
    if (!authAuthenticated) return;
    if (!navRefreshMounted.current) {
      navRefreshMounted.current = true;
      return;
    }
    if (
      typeof document !== 'undefined' &&
      document.visibilityState !== 'visible'
    ) {
      return;
    }

    const timer = setTimeout(() => {
      void useSessionsStore.getState().ensureFreshAll();
    }, 500);
    return () => clearTimeout(timer);
  }, [authAuthenticated, activeRepoPath, activeSessionId]);

  // ── Event socket ───────────────────────────────────────────────────────────
  useEventSocket({
    authAuthenticated,
    queryClient,
    throttledChangedFilesRefresh,
    setChangedFilesData: setLastChangedFiles,
  });

  // ── Action registry (extracted hook) ────────────────────────────────────────
  useActionRegistry({
    handleQuickAgent,
    handleQuickTerminal,
    handleCloseSession,
    handleSelectSession,
    handleNewWorktree,
    handleLaunchWorkspaceSession,
    handleOpenSettings,
    handleRenameActiveSession,
    handleArchive,
    navigateToDashboard,
    customizeDialogRef,
    deleteWorktreeDialogRef,
    workspaceSettingsDialogRef,
    setFilePickerOpen,
  });

  // ── Keyboard shortcuts, mobile viewport, edge swipe (extracted hook) ──────
  useAppShortcuts({
    handleSelectSession,
    setSpotlightOpen,
    setPickerOpen,
    setFilePickerOpen,
    mainAppRef,
    actionContextRef,
  });

  // ── Mount: analytics, boot, auth check, shiki GC ─────────────────────────
  useEffect(() => {
    initAnalytics(() => useSessionsStore.getState().activeSessionId);
    startShikiGc();
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
        <BackendConnectionBanner status={backendConnectionStatus} />
        <ProdTrustBanner />
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
          onViewSpineCreateTab={handleViewSpineCreateTab}
          onOpenAnalytics={openAnalytics}
        />

        <TerminalAreaContent
          setSpotlightOpen={setSpotlightOpen}
          fileTreeSidebarRef={fileTreeSidebarRef}
          onAddWorkspace={handleAddWorkspace}
          onImageUpload={handleImageUpload}
          onQuickAgent={handleQuickAgent}
          onNewWorktree={handleNewWorktree}
          onFixConflicts={handleFixConflicts}
          onPrAction={handlePrAction}
          onOpenPrSession={handleOpenPrSession}
          onArchive={handleArchive}
          onSelectSession={handleSelectSession}
          onCloseSession={handleCloseSession}
          onSessionCreated={handleNewSessionCreated}
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
      {/* #862: command-palette / empty-state "start a terminal on a node"
          target. Driven by the `env-picker` ActiveModal variant. Options derive
          from the single shared read model (`buildEnvironmentOptions`) over the
          `['hub-nodes']` + `['repo-inventory']` queries — replacing the #630
          repo-only stopgap. The launcher owns those `useQuery` calls so they run
          inside the QueryClientProvider boundary. Terminal MVP: bare-shell
          launch (`launchOverrides={{ type: 'terminal' }}`); agent picking is
          #863. The active workspace (if any) is only a fallback when inventory
          is empty — the picker still surfaces a launchable local node otherwise. */}
      <EnvPickerLauncher
        open={activeModal?.modal === 'env-picker'}
        onClose={handleModalClose}
        selectedAgent={defaultAgent}
        fallbackWorkspace={envPickerFallbackWorkspace}
        onLaunched={onEnvPickerLaunched}
      />
      <HandoffPlanDialog
        open={activeModal?.modal === 'handoff-plan'}
        onClose={handleModalClose}
        mode="live"
        activeSession={activeSession ?? null}
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
          if (isChanged && activeWorkspaceCwd) {
            useUiStore
              .getState()
              .openReviewWorkspace(activeWorkspaceCwd, { filePath: path });
          } else {
            openFileTab(path, isChanged);
          }
          setFilePickerOpen(false);
        }}
      />

      {/* Toasts */}
      <ConfirmationPrompt />
      <UpdateToast />
      <InstallBanner />
      <ErrorToast />
      <NotificationStack />
    </QueryClientProvider>
  );
}
