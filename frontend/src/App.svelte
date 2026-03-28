<script lang="ts">
  import { onMount } from 'svelte';
  import { getAuth, checkExistingAuth } from './lib/state/auth.svelte.js';
  import { getUi, openSidebar, closeSidebar } from './lib/state/ui.svelte.js';
  import { getSessionState, refreshAll, handleBackendStateChanged, handleUserViewed, renameSession, initSessionNotification, getNotificationSessionIds, getSessionsForRepo, setLoading, clearLoading, isItemLoading } from './lib/state/sessions.svelte.js';
  import { connectEventSocket, sendPtyData } from './lib/ws.js';
  import { initNotifications, initPushNotifications, resubscribeIfNeeded } from './lib/notifications.js';
  import { getConfigState } from './lib/state/config.svelte.js';
  import { isMobileDevice, estimateTerminalDimensions } from './lib/utils.js';
  import type { WorktreeInfo, Repo, PullRequest } from './lib/types.js';
  import { createWorktree, createSession, fetchWorkspaceSettings, killSession, deleteWorktree } from './lib/api.js';
  import { derivePrAction, getActionPrompt } from './lib/pr-state.js';
  import { initAnalytics, destroyAnalytics, track } from './lib/analytics.js';
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
  import UpdateToast from './components/UpdateToast.svelte';
  import ImageToast from './components/ImageToast.svelte';
  import Spotlight from './components/Spotlight.svelte';
  import CustomizeSessionDialog from './components/dialogs/CustomizeSessionDialog.svelte';
  import SettingsDialog from './components/dialogs/SettingsDialog.svelte';
  import DeleteWorktreeDialog from './components/dialogs/DeleteWorktreeDialog.svelte';
  import AddWorkspaceDialog from './components/dialogs/AddWorkspaceDialog.svelte';
  import WorkspaceSettingsDialog from './components/dialogs/WorkspaceSettingsDialog.svelte';
  import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query';

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
  let imageToastRef = $state<ImageToast | undefined>();
  let customizeDialogRef = $state<CustomizeSessionDialog | undefined>();
  let settingsDialogRef = $state<SettingsDialog | undefined>();
  let deleteWorktreeDialogRef = $state<DeleteWorktreeDialog | undefined>();
  let workspaceSettingsDialogRef = $state<WorkspaceSettingsDialog | undefined>();
  let mainAppEl = $state<HTMLDivElement | undefined>();

  let keyboardOpen = $state(false);
  let spotlightOpen = $state(false);

  onMount(() => {
    initAnalytics(() => sessionState.activeSessionId);
    checkExistingAuth();

    let cleanupViewport: (() => void) | undefined;
    let cleanupSwipe: (() => void) | undefined;

    if (isMobileDevice && window.visualViewport) {
      const vv = window.visualViewport;
      let fitTimer: ReturnType<typeof setTimeout> | null = null;

      const onViewportResize = () => {
        const kbHeight = window.innerHeight - vv.height;
        keyboardOpen = kbHeight > 50;
        if (mainAppEl) {
          mainAppEl.style.height = keyboardOpen ? vv.height + 'px' : '';
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

    // Keyboard shortcuts for tab navigation (desktop only)
    const isMac = navigator.platform.toUpperCase().includes('MAC');
    let cleanupKeydown: (() => void) | undefined;

    {
      const onKeydown = (e: KeyboardEvent) => {
        const mod = isMac ? e.metaKey : e.ctrlKey;

        // Cmd/Ctrl+P — open spotlight (works even from input fields)
        if (mod && e.key === 'p' && !e.shiftKey) {
          e.preventDefault();
          spotlightOpen = !spotlightOpen;
          return;
        }

        const tag = (document.activeElement as HTMLElement | null)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;

        if (!mod) return;

        // Cmd/Ctrl+T — quick new agent session
        if (e.key === 't' && !e.shiftKey) {
          e.preventDefault();
          handleQuickAgent();
          return;
        }

        // Cmd/Ctrl+W — close current session tab
        if (e.key === 'w' && !e.shiftKey) {
          e.preventDefault();
          if (sessionState.activeSessionId) {
            handleCloseSession(sessionState.activeSessionId);
          }
          return;
        }

        // Cmd/Ctrl+1–9 — switch to tab N (9 = last)
        if (!e.shiftKey && e.key >= '1' && e.key <= '9') {
          const sessions = workspaceSessions;
          if (sessions.length === 0) return;
          e.preventDefault();
          const n = parseInt(e.key, 10);
          const target = n === 9 ? sessions[sessions.length - 1] : sessions[n - 1];
          if (target) handleSelectSession(target.id);
          return;
        }

        // Cmd/Ctrl+Shift+[ — previous tab (cycle)
        if (e.shiftKey && e.key === '[') {
          const sessions = workspaceSessions;
          if (sessions.length === 0) return;
          e.preventDefault();
          const idx = sessions.findIndex(s => s.id === sessionState.activeSessionId);
          const prev = idx <= 0 ? sessions[sessions.length - 1] : sessions[idx - 1];
          if (prev) handleSelectSession(prev.id);
          return;
        }

        // Cmd/Ctrl+Shift+] — next tab (cycle)
        if (e.shiftKey && e.key === ']') {
          const sessions = workspaceSessions;
          if (sessions.length === 0) return;
          e.preventDefault();
          const idx = sessions.findIndex(s => s.id === sessionState.activeSessionId);
          const next = idx === -1 || idx === sessions.length - 1 ? sessions[0] : sessions[idx + 1];
          if (next) handleSelectSession(next.id);
          return;
        }
      };

      document.addEventListener('keydown', onKeydown);
      cleanupKeydown = () => document.removeEventListener('keydown', onKeydown);
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
  $effect(() => {
    if (auth.authenticated) {
      refreshAll().then(() => {
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

    function invalidatePrQueries(): void {
      queryClient.invalidateQueries({ queryKey: ['pr'] });
      queryClient.invalidateQueries({ queryKey: ['ci-status'] });
    }

    /** Throttled invalidation for poll-based events (pr-updated/ci-updated).
     *  Schedules one invalidation 500ms after the first event; subsequent
     *  events within the window are dropped. */
    function throttledPollInvalidate(): void {
      if (pollInvalidateTimer) return;
      pollInvalidateTimer = setTimeout(() => {
        pollInvalidateTimer = null;
        invalidatePrQueries();
        queryClient.invalidateQueries({ queryKey: ['org-prs'] });
      }, 500);
    }

    connectEventSocket((msg) => {
      if (msg.type === 'worktrees-changed') {
        refreshAll();
      } else if (msg.type === 'session-backend-state-changed' && msg.sessionId && msg.state) {
        handleBackendStateChanged(msg.sessionId, msg.state as import('./lib/state/display-state.js').BackendDisplayState);
      } else if (msg.type === 'session-renamed' && msg.sessionId) {
        renameSession(msg.sessionId, msg.branchName ?? '', msg.displayName ?? '');
      } else if (msg.type === 'session-ended') {
        invalidatePrQueries();
        refreshAll();
      } else if (msg.type === 'ref-changed' && msg.cwdPath) {
        const key = msg.cwdPath;
        const existing = refChangedTimers.get(key);
        if (existing) clearTimeout(existing);
        refChangedTimers.set(key, setTimeout(() => {
          refChangedTimers.delete(key);
          invalidatePrQueries();
        }, 5000));
      } else if (msg.type === 'pr-updated' || msg.type === 'ci-updated') {
        throttledPollInvalidate();
      }
    });

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

  // Handlers
  function handleSelectWorkspace(path: string) {
    if (ui.activeRepoPath === path) {
      // Already viewing this workspace — return to dashboard
      sessionState.activeSessionId = null;
    } else {
      ui.activeRepoPath = path;
      sessionState.activeSessionId = null;
    }
    closeSidebar();
  }

  function handleSelectSession(id: string) {
    sessionState.activeSessionId = id;
    const session = sessionState.sessions.find(s => s.id === id);
    if (session) {
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
        continue: configState.defaultContinue,
        yolo: configState.defaultYolo,
        agent: configState.defaultAgent,
        useTmux: configState.launchInTmux,
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
    }
  }

  function handleCustomize() {
    if (activeWorkspace) {
      customizeDialogRef?.open({ name: activeWorkspace.name, path: activeWorkspace.path });
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
      // Fall back to dialog on error so user can retry with options
      customizeDialogRef?.open({ name: workspace.name, path: workspace.path });
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

      if (prompt) {
        setTimeout(() => {
          sendPtyData(prompt + '\r');
        }, 1500);
      }
    } catch (e) {
      console.error('Failed to open PR branch session:', e);
    }
  }

  function handlePrAction(pr: PullRequest) {
    const prState = pr.state === 'OPEN' ? 'OPEN' : pr.state === 'MERGED' ? 'MERGED' : 'CLOSED';
    const action = derivePrAction({
      commitsAhead: 1,
      prState,
      ciPassing: 0,
      ciFailing: 0,
      ciPending: 0,
      ciTotal: 0,
      mergeable: (pr.mergeable as 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | null) ?? null,
      unresolvedCommentCount: 0,
    });
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

  function handleSpotlightCommand(cmd: string) {
    switch (cmd) {
      case 'new-worktree':
        if (activeWorkspace) handleNewWorktree(activeWorkspace);
        break;
      case 'new-agent':
        handleQuickAgent();
        break;
      case 'settings':
        handleOpenSettings();
        break;
    }
  }

  function handleSpotlightSelectPr(pr: import('./lib/types.js').PullRequest) {
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

{#if auth.checking}
  <!-- Loading -->
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
    />

    <div class="terminal-area">
      <MobileHeader
        title={sessionTitle}
        onMenuClick={openSidebar}
        hidden={keyboardOpen}
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
          onOpenWorkspace={(path) => { ui.activeRepoPath = path; sessionState.activeSessionId = null; }}
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
        />

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

  <!-- Spotlight command palette -->
  <Spotlight
    open={spotlightOpen}
    workspaces={sessionState.repos}
    sessions={sessionState.sessions}
    onClose={() => { spotlightOpen = false; }}
    onSelectWorkspace={(path) => { ui.activeRepoPath = path; sessionState.activeSessionId = null; closeSidebar(); }}
    onSelectSession={(id) => handleSelectSession(id)}
    onSelectPr={handleSpotlightSelectPr}
    onCommand={handleSpotlightCommand}
    onOpenSettings={(sectionId) => { spotlightOpen = false; settingsDialogRef?.open(sectionId); }}
  />

  <!-- Toasts -->
  <UpdateToast />
  <ImageToast bind:this={imageToastRef} />
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
