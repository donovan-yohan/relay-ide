<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { getAuth, checkExistingAuth } from './lib/state/auth.svelte.js';
  import { getUi, openSidebar, closeSidebar, toggleSidebarCollapsed } from './lib/state/ui.svelte.js';
  import { getSessionState, refreshAll, enrichSidebarBranches, handleBackendStateChanged, handleActivityChanged, handleUserViewed, renameSession, handleBranchChanged, initSessionNotification, getNotificationSessionIds, getSessionsForRepo, setLoading, clearLoading, isItemLoading, rememberSessionForWorkspace, recallSessionForWorkspace } from './lib/state/sessions.svelte.js';
  import { connectEventSocket, sendPtyData } from './lib/ws.js';
  import { initNotifications, initPushNotifications, resubscribeIfNeeded } from './lib/notifications.js';
  import { getConfigState } from './lib/state/config.svelte.js';
  import { isMobileDevice, isMac, estimateTerminalDimensions } from './lib/utils.js';
  import type { AccountTelemetry, SessionTelemetry, WorktreeInfo, Repo, PullRequest } from './lib/types.js';
  import { createWorktree, createSession, fetchWorkspaceSettings, killSession, deleteWorktree, setDefaultYolo, renameSession as renameSessionApi, launchWorkspaceSession } from './lib/api.js';
  import { derivePrAction, buildPrStateInput, getActionPrompt } from './lib/pr-state.js';
  import { initAnalytics, destroyAnalytics, track } from './lib/analytics.js';
  import { registerGlobal, getAllActions } from './lib/actions/registry.svelte.js';
  import { setupShortcutListener } from './lib/actions/shortcuts.js';
  import type { Action, ActionContext } from './lib/actions/types.js';
  import { sessionNewAgent, sessionNewTerminal, sessionCloseActive, sessionKill, sessionStartOnRepo, sessionStartOnTicket, sessionCustomize, sessionSwitchToTab, sessionRename } from './lib/actions/definitions/session.js';
  import { workspaceAdd, workspaceNewWorktree } from './lib/actions/definitions/workspace.js';
  import { prCreate, prPushBranch, prSwitchBranch, prFixConflicts, prArchiveBranch, prRenameBranch, prCopyBranchName, prOpenExternal, prRefresh, prChangeTarget, prSkipChecks } from './lib/actions/definitions/pr.js';
  import { settingsOpen, settingsConnectGithub, settingsToggleYolo, settingsCheckUpdates, settingsDisconnectGithub, settingsSetupWebhooks, settingsRemoveWebhook, settingsTestWebhook, settingsConnectJira, settingsDisconnectJira, settingsToggleDevTools, settingsClearAnalytics, settingsToggleContinue, settingsToggleTmux, settingsToggleNotifications, settingsChangeDefaultAgent } from './lib/actions/definitions/settings.js';
  import { sidebarCollapse, sidebarNavigateDashboard, sidebarWorkspaceSettings, sidebarRenameSession, sidebarDeleteWorktree, sidebarResumeSession, sidebarResumeYolo } from './lib/actions/definitions/sidebar.js';
  import { dashboardOpenPrSession, dashboardSortPrs, dashboardClearFilters, orgSwitchTab, orgSaveFilter, orgDeleteFilter, orgTogglePrStatus, orgNavigateToWorkspace, ticketSwitchProvider, ticketOpenExternal } from './lib/actions/definitions/dashboard.js';
  import { terminalScrollTop, terminalScrollBottom } from './lib/actions/definitions/terminal.js';
  import { navPreviousTab, navNextTab, navSwitchToTab, navOpenFile } from './lib/actions/definitions/navigation.js';
  import BootScreen from './components/BootScreen.svelte';
  import { getBootState, startBoot, reportFetch, finishBoot } from './lib/state/boot-state.svelte.js';
  import PinGate from './components/PinGate.svelte';
  import Sidebar from './components/Sidebar.svelte';
  import Terminal from './components/Terminal.svelte';
  import PrTopBar from './components/PrTopBar.svelte';
  import SessionTabBar from './components/SessionTabBar.svelte';
  import RepoDashboard from './components/RepoDashboard.svelte';
  import OrgDashboard from './components/OrgDashboard.svelte';
  import EmptyState from './components/EmptyState.svelte';
  import Toolbar from './components/Toolbar.svelte';
  import MobileHeader from './components/MobileHeader.svelte';
  import SessionStatusBar from './components/SessionStatusBar.svelte';
  import UpdateToast from './components/UpdateToast.svelte';
  import ImageToast from './components/ImageToast.svelte';
  import ErrorToast from './components/ErrorToast.svelte';
  import { showToast } from './lib/state/toasts.svelte.js';
  import CommandPalette from './components/CommandPalette.svelte';
  import OpenPicker from './components/OpenPicker.svelte';
  import FilePicker from './components/FilePicker.svelte';
  import type { SessionIntent, PickerItem } from './lib/session-intent.js';
  import { issueToBranchName } from './lib/session-intent.js';
  import CustomizeSessionDialog from './components/dialogs/CustomizeSessionDialog.svelte';
  import SettingsDialog from './components/dialogs/SettingsDialog.svelte';
  import DeleteWorktreeDialog from './components/dialogs/DeleteWorktreeDialog.svelte';
  import AddWorkspaceDialog from './components/dialogs/AddWorkspaceDialog.svelte';
  import WorkspaceSettingsDialog from './components/dialogs/WorkspaceSettingsDialog.svelte';
  import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query';
  import FullPageDiff from './components/FullPageDiff.svelte';
  import FileTreeSidebar from './components/FileTreeSidebar.svelte';
  import FileViewerPane from './components/FileViewerPane.svelte';
  import SplitPaneLayout from './components/SplitPaneLayout.svelte';
  import { openFileTab, openHtmlTab, refreshHtmlTab, toggleRightSidebarCollapsed } from './lib/state/ui.svelte.js';
  import { refreshTelemetry, handleSessionTelemetryEvent, handleAccountTelemetryEvent } from './lib/state/telemetry.svelte.js';

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60 * 1000,
        gcTime: 10 * 60 * 1000,
        refetchOnWindowFocus: true,
      },
    },
  });

  const auth = getAuth();
  const ui = getUi();
  const sessionState = getSessionState();
  const configState = getConfigState();

  let actionContext = $derived.by<ActionContext>(() => {
    if (sessionState.activeSessionId) {
      const ctx: ActionContext = { view: 'session', sessionId: sessionState.activeSessionId };
      if (ui.activeRepoPath) ctx.workspacePath = ui.activeRepoPath;
      return ctx;
    }
    if (ui.activeRepoPath) {
      return { view: 'workspace', workspacePath: ui.activeRepoPath };
    }
    return { view: 'dashboard' };
  });

  function navigateToDashboard() {
    if (sessionState.activeSessionId) sessionState.activeSessionId = null;
  }

  async function handleRenameActiveSession() {
    const name = prompt('rename session:');
    if (name?.trim() && sessionState.activeSessionId) {
      await renameSessionApi(sessionState.activeSessionId, name.trim());
    }
  }

  function navigateToSession(sessionId: string, _sessionType: string) {
    sessionState.activeSessionId = sessionId;
    // Set active workspace from session's repoPath
    const session = sessionState.sessions.find(s => s.id === sessionId);
    if (session) {
      ui.activeRepoPath = session.repoPath;
    }
    handleUserViewed(sessionId);
    closeSidebar();
  }

  initNotifications(navigateToSession);

  // Component refs — must be $state() so $effect can track bind:this assignments
  let terminalRef = $state<Terminal | undefined>();
  let fileTreeSidebarRef = $state<FileTreeSidebar | undefined>();
  let changedFilesData = $state<string[]>([]);
  let changedFilesThrottleTimer: ReturnType<typeof setTimeout> | null = null;
  function throttledChangedFilesRefresh() {
    if (changedFilesThrottleTimer) return;
    changedFilesThrottleTimer = setTimeout(() => {
      changedFilesThrottleTimer = null;
      fileTreeSidebarRef?.refresh();
    }, 2000);
  }
  onDestroy(() => {
    if (changedFilesThrottleTimer) clearTimeout(changedFilesThrottleTimer);
  });

  let imageToastRef = $state<ImageToast | undefined>();
  let customizeDialogRef = $state<CustomizeSessionDialog | undefined>();
  let settingsDialogRef = $state<SettingsDialog | undefined>();
  let deleteWorktreeDialogRef = $state<DeleteWorktreeDialog | undefined>();
  let workspaceSettingsDialogRef = $state<WorkspaceSettingsDialog | undefined>();
  let mainAppEl = $state<HTMLDivElement | undefined>();

  let spotlightOpen = $state(false);
  let pickerOpen = $state(false);
  let filePickerOpen = $state(false);

  const bootState = getBootState();
  let bootScreenVisible = $state(true);

  // Keep boot screen mounted for 300ms after completion so the CSS fade-out plays
  $effect(() => {
    if (bootState.bootComplete) {
      const timer = setTimeout(() => { bootScreenVisible = false; }, 300);
      return () => clearTimeout(timer);
    }
  });

  onMount(() => {
    initAnalytics(() => sessionState.activeSessionId);
    startBoot();
    checkExistingAuth();

    // ── Action Registry ──────────────────────────────────
    registerGlobal([
      { ...sessionNewAgent, handler: () => handleQuickAgent() },
      { ...sessionNewTerminal, handler: () => handleQuickTerminal() },
      { ...sessionCloseActive, handler: () => {
        if (sessionState.activeSessionId) handleCloseSession(sessionState.activeSessionId);
      }},
      { ...sessionKill, handler: async () => {
        if (sessionState.activeSessionId) {
          try {
            await killSession(sessionState.activeSessionId);
          } catch (err) {
            console.error('Failed to kill session', err);
          }
          await refreshAll();
        }
      }},
      { ...sessionStartOnRepo, handler: () => handleQuickAgent() },
      { ...sessionStartOnTicket, handler: () => navigateToDashboard() },
      { ...workspaceAdd, handler: () => addWorkspaceDialogRef?.open() },
      { ...workspaceNewWorktree, handler: () => {
        if (activeWorkspace) handleNewWorktree(activeWorkspace);
      }},
      { ...prCreate, handler: () => navigateToDashboard() },
      { ...prPushBranch, handler: () => navigateToDashboard() },
      { ...prSwitchBranch, handler: () => navigateToDashboard() },
      { ...settingsOpen, handler: () => handleOpenSettings() },
      { ...settingsConnectGithub, handler: () => settingsDialogRef?.open('section-integrations') },
      { ...settingsToggleYolo, handler: async () => {
        const prev = configState.defaultYolo;
        configState.defaultYolo = !prev;
        try {
          await setDefaultYolo(!prev);
        } catch (err) {
          configState.defaultYolo = prev;
          console.error('Failed to update default YOLO setting', err);
        }
      }},
      { ...settingsCheckUpdates, handler: () => settingsDialogRef?.open('section-about') },
      // ── Phase 3: Session ──
      { ...sessionCustomize, handler: () => { if (activeWorkspace) customizeDialogRef?.open({ name: activeWorkspace.name, path: activeWorkspace.path }, activeSession?.worktreePath); } },
      { ...sessionSwitchToTab, handler: () => {} },
      { ...sessionRename, handler: () => handleRenameActiveSession() },
      // ── Phase 3: PR ──
      { ...prFixConflicts, handler: () => navigateToDashboard() },
      { ...prArchiveBranch, handler: () => navigateToDashboard() },
      { ...prRenameBranch, handler: () => navigateToDashboard() },
      { ...prCopyBranchName, handler: async () => {
        const sessions = workspaceSessions;
        const branch = sessions[0]?.branchName;
        if (branch) await navigator.clipboard.writeText(branch);
      }},
      { ...prOpenExternal, handler: () => navigateToDashboard() },
      { ...prRefresh, handler: async () => {
        await refreshAll();
      }},
      { ...prChangeTarget, handler: () => navigateToDashboard() },
      { ...prSkipChecks, handler: () => navigateToDashboard() },
      // ── Phase 3: Settings ──
      { ...settingsDisconnectGithub, handler: () => settingsDialogRef?.open('section-integrations') },
      { ...settingsSetupWebhooks, handler: () => settingsDialogRef?.open('section-integrations') },
      { ...settingsRemoveWebhook, handler: () => settingsDialogRef?.open('section-integrations') },
      { ...settingsTestWebhook, handler: () => settingsDialogRef?.open('section-integrations') },
      { ...settingsConnectJira, handler: () => settingsDialogRef?.open('section-integrations') },
      { ...settingsDisconnectJira, handler: () => settingsDialogRef?.open('section-integrations') },
      { ...settingsToggleDevTools, handler: () => settingsDialogRef?.open('section-advanced') },
      { ...settingsClearAnalytics, handler: () => settingsDialogRef?.open('section-advanced') },
      { ...settingsToggleContinue, handler: () => settingsDialogRef?.open('section-general') },
      { ...settingsToggleTmux, handler: () => settingsDialogRef?.open('section-general') },
      { ...settingsToggleNotifications, handler: () => settingsDialogRef?.open('section-general') },
      { ...settingsChangeDefaultAgent, handler: () => settingsDialogRef?.open('section-general') },
      // ── Phase 3: Sidebar ──
      { ...sidebarCollapse, handler: () => toggleSidebarCollapsed() },
      { ...sidebarNavigateDashboard, handler: () => navigateToDashboard() },
      { ...sidebarWorkspaceSettings, handler: () => {
        if (activeWorkspace) workspaceSettingsDialogRef?.open(activeWorkspace.path, activeWorkspace.name);
      }},
      { ...sidebarRenameSession, handler: () => handleRenameActiveSession() },
      { ...sidebarDeleteWorktree, handler: () => {
        const wt = sessionState.worktrees.find(w => w.path === activeSession?.worktreePath);
        if (wt) deleteWorktreeDialogRef?.open(wt);
      }},
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
      // ── Phase 3: Terminal (scroll methods not yet exposed by Terminal.svelte) ──
      { ...terminalScrollTop, handler: () => terminalRef?.getTerm()?.scrollToLine(0) },
      { ...terminalScrollBottom, handler: () => terminalRef?.getTerm()?.scrollToBottom() },
      // ── Phase 3: Navigation ──
      { ...navPreviousTab, handler: () => {
        const sessions = workspaceSessions;
        if (sessions.length === 0) return;
        const idx = sessions.findIndex(s => s.id === sessionState.activeSessionId);
        const prev = idx <= 0 ? sessions[sessions.length - 1] : sessions[idx - 1];
        if (prev) handleSelectSession(prev.id);
      }},
      { ...navNextTab, handler: () => {
        const sessions = workspaceSessions;
        if (sessions.length === 0) return;
        const idx = sessions.findIndex(s => s.id === sessionState.activeSessionId);
        const next = idx === -1 || idx === sessions.length - 1 ? sessions[0] : sessions[idx + 1];
        if (next) handleSelectSession(next.id);
      }},
      { ...navSwitchToTab, handler: () => {} },
      { ...navOpenFile, handler: () => { filePickerOpen = true; } },
      // ── Diff view (from nightly) ──
      {
        id: 'workspace.open-diff-view' as const,
        label: 'open diff view',
        description: 'open full-page diff viewer for changed files',
        category: 'workspace' as const,
        shortcut: { key: 'd' },
        when: (ctx: ActionContext) => ctx.view === 'session',
        handler: () => {
          const ws = activeSession?.cwd ?? activeSession?.repoPath ?? '';
          if (ws) ui.fullPageDiff = { workspacePath: ws };
        },
      },
      {
        id: 'workspace.close-diff-view' as const,
        label: 'close diff view',
        description: 'close full-page diff viewer',
        category: 'workspace' as const,
        shortcut: { key: 'Escape' },
        when: () => !!ui.fullPageDiff,
        handler: () => { ui.fullPageDiff = null; },
      },
    ] satisfies Action[]);

    let cleanupViewport: (() => void) | undefined;
    let cleanupSwipe: (() => void) | undefined;

    if (isMobileDevice && window.visualViewport) {
      const vv = window.visualViewport;
      let fitTimer: ReturnType<typeof setTimeout> | null = null;

      const onViewportResize = () => {
        const kbHeight = window.innerHeight - vv.height;
        ui.keyboardOpen = kbHeight > 50;
        if (mainAppEl) {
          mainAppEl.style.height = ui.keyboardOpen ? vv.height + 'px' : '';
        }
        window.scrollTo(0, 0);
        if (fitTimer) clearTimeout(fitTimer);
        fitTimer = setTimeout(() => terminalRef?.fitTerm(), 100);
      };
      vv.addEventListener('resize', onViewportResize);
      vv.addEventListener('scroll', onViewportResize);
      cleanupViewport = () => {
        vv.removeEventListener('resize', onViewportResize);
        vv.removeEventListener('scroll', onViewportResize);
        if (fitTimer) clearTimeout(fitTimer);
      };
    }

    // Keyboard shortcuts — centralized via ShortcutListener
    let cleanupKeydown: (() => void) | undefined;

    {
      // Special-case: Cmd+P toggles palette (must work even from inputs, before registry check)
      // Special-case: Cmd+1-9 for tab switching (dynamic, not registry-driven)
      const onSpecialKeydown = (e: KeyboardEvent) => {
        const mod = isMac ? e.metaKey : e.ctrlKey;
        if (!mod) return;

        if (e.key === 'p' && !e.shiftKey) {
          e.preventDefault();
          spotlightOpen = !spotlightOpen;
          return;
        }

        const activeTag = (document.activeElement as HTMLElement | null)?.tagName;
        const isInInput = activeTag === 'INPUT' || activeTag === 'TEXTAREA' || !!(document.activeElement as HTMLElement)?.isContentEditable;

        // / — open picker (not from inputs)
        if (e.key === '/' && !mod && !isInInput) {
          e.preventDefault();
          pickerOpen = true;
          return;
        }

        // Cmd/Ctrl+K — open picker (works from input fields)
        if (mod && e.key === 'k') {
          e.preventDefault();
          pickerOpen = !pickerOpen;
          return;
        }

        // Cmd/Ctrl+O — open file picker (only when a session is active)
        if (mod && !e.shiftKey && e.key === 'o' && activeSession && activeWorkspaceCwd) {
          e.preventDefault();
          filePickerOpen = !filePickerOpen;
          return;
        }

        // Ctrl/Cmd+B — toggle right sidebar
        if (mod && e.key === 'b') {
          e.preventDefault();
          toggleRightSidebarCollapsed();
          return;
        }

        if (isInInput) return;

        if (!e.shiftKey && e.key >= '1' && e.key <= '9') {
          const sessions = workspaceSessions;
          if (sessions.length === 0) return;
          e.preventDefault();
          const n = parseInt(e.key, 10);
          const target = n === 9 ? sessions[sessions.length - 1] : sessions[n - 1];
          if (target) handleSelectSession(target.id);
          return;
        }
      };

      document.addEventListener('keydown', onSpecialKeydown);

      // Registry-driven shortcuts (Cmd+T, Cmd+W, Cmd+Shift+[/], etc.)
      const cleanupRegistry = setupShortcutListener(
        () => getAllActions(),
        () => actionContext,
        isMac,
      );

      cleanupKeydown = () => {
        document.removeEventListener('keydown', onSpecialKeydown);
        cleanupRegistry();
      };
    }

    if (isMobileDevice) {
      const EDGE_ZONE = 30;
      const SWIPE_THRESHOLD = 50;
      let swipeStartX = 0;
      let swipeStartY = 0;
      let swipeTracking = false;

      const onSwipeTouchStart = (e: TouchEvent) => {
        const touch = e.touches[0];
        if (!touch) return;
        if (touch.clientX <= EDGE_ZONE && !ui.sidebarOpen) {
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
          openSidebar();
        }
      };

      const onSwipeTouchEnd = () => { swipeTracking = false; };

      document.addEventListener('touchstart', onSwipeTouchStart, { passive: true });
      document.addEventListener('touchmove', onSwipeTouchMove, { passive: true });
      document.addEventListener('touchend', onSwipeTouchEnd);
      cleanupSwipe = () => {
        document.removeEventListener('touchstart', onSwipeTouchStart);
        document.removeEventListener('touchmove', onSwipeTouchMove);
        document.removeEventListener('touchend', onSwipeTouchEnd);
      };
    }

    // Hardware keyboard detection (mobile only — self-removing once triggered)
    if (isMobileDevice) {
      const detectKeyboard = () => {
        ui.hasHardwareKeyboard = true;
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
  });

  let prevActiveSessionId: string | null | undefined = undefined;
  $effect(() => {
    const id = sessionState.activeSessionId;
    // Skip the initial mount — only track real navigation transitions
    if (prevActiveSessionId === undefined) {
      prevActiveSessionId = id;
      return;
    }
    if (id === prevActiveSessionId) return;
    prevActiveSessionId = id;
    if (id) {
      track('navigation', 'page.view', '/terminal', undefined, id);
    } else {
      track('navigation', 'page.view', '/dashboard', { workspace: ui.activeRepoPath });
    }
  });

  // Refresh when authenticated
  let bootRefreshDone = false; // intentionally non-reactive — one-shot guard for boot sequence
  $effect(() => {
    if (auth.authenticated) {
      const isInitialBoot = !bootRefreshDone;
      if (isInitialBoot) {
        bootRefreshDone = true;
        reportFetch('auth', 'ok');
      }
      refreshAll(isInitialBoot ? reportFetch : undefined).then(async () => {
        await refreshTelemetry();

        if (isInitialBoot) {
          finishBoot();
          // Backfill PR info and staleness via batch enrichment
          enrichSidebarBranches();
        }
        const params = new URLSearchParams(window.location.search);
        const sessionParam = params.get('session');
        if (sessionParam) {
          window.history.replaceState({}, '', '/');
          navigateToSession(sessionParam, 'repo');
        }

        // Auto-select if exactly one session exists and none is selected
        if (!sessionState.activeSessionId && !sessionParam && sessionState.sessions.length === 1) {
          handleSelectSession(sessionState.sessions[0]!.id);
        }

        // Initialize notifications for existing sessions
        for (const s of sessionState.sessions) {
          initSessionNotification(s.id, configState.defaultNotifications);
        }

        initPushNotifications().then(() => {
          resubscribeIfNeeded(getNotificationSessionIds());
        });
      });
    }
  });

  // Event socket
  $effect(() => {
    if (!auth.authenticated) return;

    const refChangedTimers = new Map<string, ReturnType<typeof setTimeout>>();
    let pollInvalidateTimer: ReturnType<typeof setTimeout> | null = null;

    function invalidatePrData(): void {
      // Invalidate TanStack Query caches for PrTopBar individual queries
      queryClient.invalidateQueries({ queryKey: ['pr'] });
      queryClient.invalidateQueries({ queryKey: ['ci-status'] });
      // Re-enrich sidebar batch data
      enrichSidebarBranches();
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
          refreshAll();
        } else if (msg.type === 'session-backend-state-changed') {
          handleBackendStateChanged(msg.sessionId, msg.state, msg.permissionType);
        } else if (msg.type === 'session-renamed') {
          renameSession(msg.sessionId, msg.branchName, msg.displayName);
          invalidatePrData();
        } else if (msg.type === 'session-branch-changed') {
          handleBranchChanged(msg.sessionId, msg.branch);
        } else if (msg.type === 'session-ended') {
          invalidatePrData();
          refreshAll();
        } else if (msg.type === 'ref-changed') {
          const key = msg.cwdPath;
          const existing = refChangedTimers.get(key);
          if (existing) clearTimeout(existing);
          refChangedTimers.set(key, setTimeout(() => {
            refChangedTimers.delete(key);
            invalidatePrData();
          }, 5000));
        } else if (msg.type === 'pr-updated' || msg.type === 'ci-updated') {
          throttledPollInvalidate();
        } else if (msg.type === 'files-changed') {
          const activeWs = activeSession?.cwd ?? activeSession?.repoPath;
          if (activeWs === msg.workspacePath) {
            throttledChangedFilesRefresh();
            queryClient.invalidateQueries({ queryKey: ['files-list'] });
            if (msg.changedFiles) {
              changedFilesData = msg.changedFiles;
            }
          }
        } else if (msg.type === 'session-activity-changed') {
          handleActivityChanged(msg.sessionId, msg.timestamp, msg.currentActivity ?? undefined);
        } else if (msg.type === 'session-telemetry') {
          handleSessionTelemetryEvent(msg.sessionId, msg.data as SessionTelemetry | Record<string, unknown>);
        } else if (msg.type === 'account-telemetry') {
          handleAccountTelemetryEvent(msg.data as AccountTelemetry | Record<string, unknown> | null);
        } else if (msg.type === 'browser-tab-opened') {
          openHtmlTab(msg.filePath, msg.token);
        } else if (msg.type === 'browser-tab-refreshed') {
          refreshHtmlTab(msg.filePath);
        }
      },
      () => {
        void refreshTelemetry();
      },
    );

    return () => {
      for (const timer of refChangedTimers.values()) clearTimeout(timer);
      refChangedTimers.clear();
      if (pollInvalidateTimer) { clearTimeout(pollInvalidateTimer); pollInvalidateTimer = null; }
    };
  });

  // Derived state
  let activeWorkspace = $derived<Repo | undefined>(
    ui.activeRepoPath
      ? sessionState.repos.find(w => w.path === ui.activeRepoPath)
      : undefined
  );

  let allWorkspaceSessions = $derived(
    ui.activeRepoPath
      ? getSessionsForRepo(ui.activeRepoPath)
      : []
  );

  let activeSession = $derived(
    sessionState.activeSessionId
      ? sessionState.sessions.find(s => s.id === sessionState.activeSessionId)
      : undefined
  );

  // Tab bar shows only sessions in the SAME worktree/directory as the active session
  // (not all sessions across all worktrees in the workspace).
  // Sorted by createdAt so new tabs always appear rightmost.
  let workspaceSessions = $derived(
    (activeSession
      ? allWorkspaceSessions.filter(s => s.cwd === activeSession.cwd)
      : allWorkspaceSessions
    ).toSorted((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
  );

  let hasActiveSession = $derived(!!activeSession && !!ui.activeRepoPath && (
    activeSession.repoPath === ui.activeRepoPath
  ));

  let sessionTitle = $derived(
    activeSession?.displayName || activeWorkspace?.name || 'Relay'
  );

  let activeSessionUseTmux = $derived(activeSession?.useTmux ?? false);
  let copyModeActive = $state(false);

  // View state: which main area content to show
  let viewMode = $derived<'empty' | 'org' | 'dashboard' | 'session'>(
    !sessionState.repos.length ? 'empty' :
    !ui.activeRepoPath ? 'org' :
    !hasActiveSession ? 'dashboard' :
    'session'
  );

  // Active workspace path for file tree — use worktreePath/repoPath (stable root),
  // not cwd which can drift to subdirectories during session use
  let activeWorkspaceCwd = $derived(activeSession?.worktreePath ?? activeSession?.repoPath ?? '');

  // Diff-to-agent bridge: inject file reference into terminal input
  function handleInjectReference(reference: string) {
    // Inject the reference followed by a space into the active PTY session
    sendPtyData(reference + ' ');
  }

  // Handle file selection from sidebar
  function handleFileSelect(filePath: string, isChanged: boolean) {
    openFileTab(filePath, isChanged);
  }

  // Handle file path clicks from terminal output
  function handleTerminalFilePathClick(clickedPath: string) {
    const cwd = activeWorkspaceCwd;
    if (!cwd) return;
    // Resolve to a path relative to the workspace root
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
  }

  // Handlers
  function handleSelectWorkspace(path: string) {
    if (ui.activeRepoPath === path) {
      // Already viewing this workspace — toggle between session and dashboard
      if (sessionState.activeSessionId) {
        sessionState.activeSessionId = null;
      } else {
        const recalled = recallSessionForWorkspace(path);
        if (recalled) sessionState.activeSessionId = recalled;
      }
    } else {
      ui.activeRepoPath = path;
      sessionState.activeSessionId = recallSessionForWorkspace(path);
    }
    closeSidebar();
  }

  function handleSelectSession(id: string) {
    sessionState.activeSessionId = id;
    const session = sessionState.sessions.find(s => s.id === id);
    if (session) {
      rememberSessionForWorkspace(session.repoPath, id);
      ui.activeRepoPath = session.repoPath;
    }
    handleUserViewed(id);
    closeSidebar();
    terminalRef?.focusTerm();
  }

  async function handleQuickAgent() {
    if (!activeWorkspace) return;
    const { cols, rows } = estimateTerminalDimensions();
    try {
      const session = await createSession({
        repoPath: activeWorkspace.path,
        worktreePath: activeSession?.worktreePath ?? null,
        type: 'agent',
        cols,
        rows,
      });
      await refreshAll();
      if (session?.id) {
        sessionState.activeSessionId = session.id;
        initSessionNotification(session.id, configState.defaultNotifications);
      }
    } catch (err: unknown) {
      if (err instanceof Error && 'sessionId' in err) {
        const conflictErr = err as Error & { sessionId?: string };
        await refreshAll();
        if (conflictErr.sessionId) {
          sessionState.activeSessionId = conflictErr.sessionId;
        }
      } else {
        console.error('Failed to create agent session:', err);
        showToast(err instanceof Error ? err.message : 'failed to create agent session');
      }
    }
  }

  async function handleQuickTerminal() {
    if (!activeWorkspace) return;
    try {
      const session = await createSession({
        repoPath: activeWorkspace.path,
        worktreePath: activeSession?.worktreePath ?? null,
        type: 'terminal',
      });
      await refreshAll();
      if (session?.id) {
        sessionState.activeSessionId = session.id;
        initSessionNotification(session.id, configState.defaultNotifications);
      }
    } catch (err) {
      console.error('Failed to create terminal session:', err);
      showToast(err instanceof Error ? err.message : 'failed to create terminal session');
    }
  }

  function handleCustomize() {
    if (activeWorkspace) {
      customizeDialogRef?.open({ name: activeWorkspace.name, path: activeWorkspace.path }, activeSession?.worktreePath);
    }
  }

  function handleOpenSettings(workspace?: Repo) {
    if (workspace) {
      workspaceSettingsDialogRef?.open(workspace.path, workspace.name);
    } else {
      settingsDialogRef?.open();
    }
  }

  async function handleNewWorktree(workspace: Repo) {
    // Instant worktree creation — no dialog.
    // 1. Create git worktree with next mountain name via POST /workspaces/worktree
    // 2. Start a session in the new worktree with workspace default settings
    // 3. Session is flagged needsBranchRename — first message triggers auto-rename
    const loadingKey = `new-worktree:${workspace.path}`;
    if (isItemLoading(loadingKey)) return;
    setLoading(loadingKey);
    try {
      const { branchName, worktreePath } = await createWorktree(workspace.path);
      const session = await createSession({
        repoPath: workspace.path,
        worktreePath,
        type: 'agent',
        branchName,
        needsBranchRename: true,
      });
      await refreshAll();
      sessionState.activeSessionId = session.id;
      ui.activeRepoPath = workspace.path;
      initSessionNotification(session.id, configState.defaultNotifications);
      closeSidebar();
      terminalRef?.focusTerm();
    } catch (e) {
      console.error('Failed to create worktree session:', e);
      showToast(e instanceof Error ? e.message : 'failed to create worktree');
      // Fall back to dialog on error so user can retry with options
      customizeDialogRef?.open({ name: workspace.name, path: workspace.path });
    } finally {
      clearLoading(loadingKey);
    }
  }

  async function handleLaunchWorkspaceSession(workspaceId: string) {
    const loadingKey = `ws-launch:${workspaceId}`;
    if (isItemLoading(loadingKey)) return;
    setLoading(loadingKey);
    try {
      const result = await launchWorkspaceSession(workspaceId);
      await refreshAll();
      sessionState.activeSessionId = result.id;
      ui.activeRepoPath = result.repoPath;
      ui.activeWorkspaceId = workspaceId;
      closeSidebar();

      if (result.warnings?.length) {
        const msgs = result.warnings.map(w => `  ${w.repoPath}: ${w.error}`).join('\n');
        console.warn('[workspace-session] partial failure:', result.warnings);
        alert(`workspace launched with warnings:\n${msgs}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      console.error('[workspace-session] launch failed:', err);
      alert(`workspace launch failed: ${message}`);
    } finally {
      clearLoading(loadingKey);
    }
  }

  async function handleFixConflicts(pr: PullRequest) {
    if (!activeWorkspace) return;

    const repoPath = activeWorkspace.path;

    const existingSession = sessionState.sessions.find(s => s.branchName === pr.headRefName && s.repoPath === repoPath);
    const existingWorktree = sessionState.worktrees.find(w => w.branchName === pr.headRefName && w.repoPath === repoPath);

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
        // Active session exists in this branch's worktree — open a new tab there
        worktreePath = existingSession.worktreePath;
        branchName = existingSession.branchName;
      } else if (existingWorktree) {
        // Inactive worktree exists for this branch — reuse it
        worktreePath = existingWorktree.path;
        branchName = existingWorktree.branchName;
      } else {
        // No worktree yet — create one from the existing branch
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
      await refreshAll();
      sessionState.activeSessionId = session.id;
      ui.activeRepoPath = repoPath;
      initSessionNotification(session.id, configState.defaultNotifications);
      closeSidebar();

      // Delay sending the prompt to allow the terminal WebSocket connection to establish
      setTimeout(() => {
        sendPtyData(prompt + '\r');
      }, 1500);
    } catch (e) {
      console.error('Failed to start conflict resolution:', e);
      showToast(e instanceof Error ? e.message : 'failed to start conflict resolution');
    }
  }

  async function handleOpenPrBranch(pr: PullRequest, prompt?: string) {
    if (!activeWorkspace) return;
    const repoPath = activeWorkspace.path;

    const existingSession = sessionState.sessions.find(s => s.branchName === pr.headRefName && s.repoPath === repoPath);
    const existingWorktree = sessionState.worktrees.find(w => w.branchName === pr.headRefName && w.repoPath === repoPath);

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
      await refreshAll();
      sessionState.activeSessionId = session.id;
      ui.activeRepoPath = repoPath;
      initSessionNotification(session.id, configState.defaultNotifications);
      closeSidebar();

      // TODO: replace setTimeout with event-driven terminal-ready signal to avoid race condition on slow connections
      if (prompt) {
        setTimeout(() => {
          sendPtyData(prompt + '\r');
        }, 1500);
      }
    } catch (e) {
      console.error('Failed to open PR branch session:', e);
      showToast(e instanceof Error ? e.message : 'failed to open session on this branch');
    }
  }

  async function handlePickerIntent(intent: SessionIntent, item: PickerItem) {
    switch (intent.type) {
      case 'resume-session': {
        if (intent.existingSessionId) {
          navigateToSession(intent.existingSessionId, 'agent');
        } else {
          console.warn('resume-session intent missing existingSessionId');
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
          sessionState.activeSessionId = intent.existingSessionId;
          await handleArchive();
        }
        break;
      }
    }
  }

  async function handleOpenBranchSession(branchName: string, repoPath: string, prompt?: string) {
    try {
      const existingSession = sessionState.sessions.find(s => s.branchName === branchName && s.repoPath === repoPath);
      const existingWorktree = sessionState.worktrees.find(w => w.branchName === branchName && w.repoPath === repoPath);

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
      await refreshAll();
      sessionState.activeSessionId = session.id;
      ui.activeRepoPath = repoPath;
      initSessionNotification(session.id, configState.defaultNotifications);
      closeSidebar();

      // TODO: replace setTimeout with event-driven terminal-ready signal to avoid race condition on slow connections
      if (prompt) {
        setTimeout(() => sendPtyData(prompt + '\r'), 1500);
      }
    } catch (e) {
      console.error('Failed to open branch session:', e);
    }
  }

  function handlePrAction(pr: PullRequest) {
    const action = derivePrAction(buildPrStateInput(pr));
    const prompt = getActionPrompt(action, {
      branchName: pr.headRefName,
      baseBranch: pr.baseRefName,
      prNumber: pr.number,
    });
    if (prompt) {
      handleOpenPrBranch(pr, prompt);
    }
  }

  function handleOpenPrSession(pr: PullRequest) {
    handleOpenPrBranch(pr);
  }

  function handleDeleteWorktree(wt: WorktreeInfo) {
    deleteWorktreeDialogRef?.open(wt);
  }

  function handleNewSessionCreated(sessionId: string) {
    sessionState.activeSessionId = sessionId;
    initSessionNotification(sessionId, configState.defaultNotifications);
    closeSidebar();
    terminalRef?.focusTerm();
  }

  function handleCloseSession(sessionId: string) {
    // Kill session via API, then refresh
    fetch(`/sessions/${sessionId}`, { method: 'DELETE' }).then(() => refreshAll());
    if (sessionState.activeSessionId === sessionId) {
      // Select next available session in this workspace
      const remaining = workspaceSessions.filter(s => s.id !== sessionId);
      sessionState.activeSessionId = remaining[0]?.id ?? null;
    }
  }

  function handleImageUpload(text: string, showInsert: boolean, path?: string) {
    imageToastRef?.show(text, showInsert, path);
    if (!showInsert) {
      imageToastRef?.autoDismiss(3000);
    }
  }

  function handleSendKey(key: string) { sendPtyData(key); }
  function handleFlushComposedText() { /* xterm.js handles natively */ }
  function handleClearInput() { /* xterm.js manages textarea */ }

  function handleUploadImage() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) terminalRef?.handleImageUpload(file, file.type);
    };
    input.click();
  }

  function handleRefocusMobileInput() { terminalRef?.focusTerm(); }
  function handleCopyModeChange(active: boolean) { copyModeActive = active; }
  function handleExitCopyMode() { terminalRef?.exitCopyMode(); }

  let addWorkspaceDialogRef = $state<AddWorkspaceDialog | undefined>();

  function handlePaletteSelectPr(pr: import('./lib/types.js').PullRequest) {
    // Navigate to the PR's workspace, then open the PR branch
    if (pr.repoPath) {
      ui.activeRepoPath = pr.repoPath;
      sessionState.activeSessionId = null;
    }
    handleOpenPrBranch(pr);
  }

  function handleAddWorkspace() {
    addWorkspaceDialogRef?.open();
  }

  async function handleWorkspacesAdded(paths: string[]) {
    await refreshAll();
    // Auto-select the first newly added workspace
    if (paths.length > 0) {
      ui.activeRepoPath = paths[0]!;
    }
  }

  async function handleArchive() {
    const sessionId = sessionState.activeSessionId;
    if (!sessionId) return;
    const session = sessionState.sessions.find(s => s.id === sessionId);
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
    sessionState.activeSessionId = null;
    await refreshAll();
  }
</script>

{#if auth.checking || (auth.authenticated && bootScreenVisible)}
  <BootScreen />
{:else if !auth.authenticated || auth.needsSetup}
  <PinGate />
{:else}
  <QueryClientProvider client={queryClient}>
  <div class="main-app" bind:this={mainAppEl}>
    <!-- Sidebar overlay (mobile) -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    {#if ui.sidebarOpen}
      <div class="sidebar-overlay" onclick={closeSidebar}></div>
    {/if}

    <Sidebar
      onSelectSession={handleSelectSession}
      onOpenSettings={handleOpenSettings}
      onNewWorktree={handleNewWorktree}
      onAddWorkspace={handleAddWorkspace}
      onDeleteSession={handleCloseSession}
      onDeleteWorktree={handleDeleteWorktree}
      onLaunchWorkspaceSession={handleLaunchWorkspaceSession}
    />

    <div class="terminal-area">
      <MobileHeader
        title={sessionTitle}
        onMenuClick={openSidebar}
        onCommandClick={() => { spotlightOpen = true; }}
        hidden={ui.keyboardOpen}
      />

      {#if viewMode === 'empty'}
        <EmptyState
          heading="Add a workspace to get started"
          description="Point to any folder on your machine. Git repos get PR tracking and branch management."
          actionLabel="+ Add Workspace"
          onAction={handleAddWorkspace}
        />

      {:else if viewMode === 'org'}
        <OrgDashboard
          onOpenWorkspace={(path) => { ui.activeRepoPath = path; sessionState.activeSessionId = recallSessionForWorkspace(path); }}
          onOpenSession={(id) => { sessionState.activeSessionId = id; }}
        />

      {:else if viewMode === 'dashboard'}
        <RepoDashboard
          repoPath={ui.activeRepoPath ?? ''}
          workspaceName={activeWorkspace?.name ?? ''}
          creatingWorktree={isItemLoading(`new-worktree:${ui.activeRepoPath ?? ''}`)}
          onNewSession={() => handleQuickAgent()}
          onNewWorktree={() => { if (activeWorkspace) handleNewWorktree(activeWorkspace); }}
          onFixConflicts={handleFixConflicts}
          onPrAction={handlePrAction}
          onOpenPrSession={handleOpenPrSession}
        />

      {:else if viewMode === 'session'}
        <PrTopBar
          repoPath={ui.activeRepoPath ?? ''}
          branchName={activeSession?.branchName ?? ''}
          sessionId={sessionState.activeSessionId}
          agentRunning={activeSession?.agentState === 'processing'}
          onArchive={handleArchive}
        />
        <SplitPaneLayout>
          {#snippet terminal()}
            <SessionTabBar
              sessions={workspaceSessions}
              activeSessionId={sessionState.activeSessionId}
              onSelectSession={handleSelectSession}
              onCloseSession={handleCloseSession}
              onNewAgent={() => handleQuickAgent()}
              onNewTerminal={() => handleQuickTerminal()}
              onCustomize={() => handleCustomize()}
            />

            <Terminal
              bind:this={terminalRef}
              sessionId={sessionState.activeSessionId}
              onImageUpload={handleImageUpload}
              useTmux={activeSessionUseTmux}
              onCopyModeChange={handleCopyModeChange}
              onFilePathClick={handleTerminalFilePathClick}
            />

            {#if sessionState.activeSessionId}
              <SessionStatusBar
                sessionId={sessionState.activeSessionId}
                currentActivity={activeSession?.currentActivity ?? null}
              />
            {/if}

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
          {/snippet}

          {#snippet fileViewer()}
            <FileViewerPane
              workspacePath={activeWorkspaceCwd}
              onInjectReference={handleInjectReference}
            />
          {/snippet}

          {#snippet rightSidebar()}
            <FileTreeSidebar
              bind:this={fileTreeSidebarRef}
              workspacePath={activeWorkspaceCwd}
              changedFilesData={changedFilesData}
              onFileSelect={handleFileSelect}
            />
          {/snippet}
        </SplitPaneLayout>
      {/if}
    </div>
  </div>

  <!-- Dialogs & overlays -->
  <CustomizeSessionDialog
    bind:this={customizeDialogRef}
    onSessionCreated={handleNewSessionCreated}
  />
  <SettingsDialog bind:this={settingsDialogRef} />
  <DeleteWorktreeDialog bind:this={deleteWorktreeDialogRef} />
  <AddWorkspaceDialog bind:this={addWorkspaceDialogRef} onWorkspacesAdded={handleWorkspacesAdded} />
  <WorkspaceSettingsDialog
    bind:this={workspaceSettingsDialogRef}
    onRemoveWorkspace={async (p) => {
      await fetch('/workspaces', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }) });
      await refreshAll();
      if (ui.activeRepoPath === p) ui.activeRepoPath = null;
    }}
  />

  <!-- Full-page diff overlay -->
  {#if ui.fullPageDiff}
    <div class="full-page-diff-overlay">
      <FullPageDiff
        workspacePath={ui.fullPageDiff.workspacePath}
        {...(ui.fullPageDiff.file !== undefined ? { initialFile: ui.fullPageDiff.file } : {})}
        {...(ui.fullPageDiff.base !== undefined ? { initialBase: ui.fullPageDiff.base } : {})}
        onClose={() => { ui.fullPageDiff = null; }}
      />
    </div>
  {/if}

  <!-- Command palette -->
  <CommandPalette
    open={spotlightOpen}
    workspaces={sessionState.repos}
    sessions={sessionState.sessions}
    {actionContext}
    onClose={() => { spotlightOpen = false; }}
    onSelectWorkspace={(path) => { ui.activeRepoPath = path; sessionState.activeSessionId = recallSessionForWorkspace(path); closeSidebar(); }}
    onSelectSession={(id) => handleSelectSession(id)}
    onSelectPr={handlePaletteSelectPr}
    onOpenSettings={(sectionId) => { spotlightOpen = false; settingsDialogRef?.open(sectionId); }}
  />

  <!-- Open Picker (/ or Cmd+K) -->
  <OpenPicker
    open={pickerOpen}
    repoPath={ui.activeRepoPath ?? ''}
    sessions={sessionState.sessions}
    worktrees={sessionState.worktrees}
    onClose={() => pickerOpen = false}
    onSelectIntent={handlePickerIntent}
  />

  <!-- File Picker (Cmd+O) -->
  <FilePicker
    open={filePickerOpen}
    workspacePath={activeWorkspaceCwd}
    changedFiles={ui.lastChangedFiles}
    recentFiles={ui.openFileTabs}
    onClose={() => { filePickerOpen = false; }}
    onSelect={(path, isChanged) => { openFileTab(path, isChanged); filePickerOpen = false; }}
  />

  <!-- Toasts -->
  <UpdateToast />
  <ImageToast bind:this={imageToastRef} />
  <ErrorToast />
  </QueryClientProvider>
{/if}

<style>
  .main-app {
    display: flex;
    flex-direction: row;
    width: 100%;
    height: 100vh;
    height: 100dvh;
    overflow: hidden;
  }

  .sidebar-overlay {
    display: none;
  }

  .terminal-area {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
    position: relative;
  }

  /* Mobile */
  @media (max-width: 600px) {
    .main-app {
      position: fixed;
      inset: 0;
      width: 100%;
    }

    /* No overlay needed — sidebar is full-screen on mobile */

    .terminal-area {
      width: 100%;
    }
  }
</style>
