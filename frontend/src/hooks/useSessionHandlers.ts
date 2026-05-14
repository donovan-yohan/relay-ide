import { useCallback } from 'react';
import type React from 'react';
import { createLogger } from '../lib/logger.js';
import { useSessionsStore } from '../lib/stores/sessions.js';
import { useUiStore } from '../lib/stores/ui.js';
import { useConfigStore } from '../lib/stores/config.js';
import { useToastStore } from '../lib/stores/toasts.js';
import { sendPtyData } from '../lib/ws.js';
import { estimateTerminalDimensions } from '../lib/utils.js';
import type { WorktreeInfo, Repo, PullRequest } from '../lib/types.js';
import {
  createWorktree,
  ConflictError,
  fetchWorkspaceSettings,
  fetchWorktreeStatus,
  killSession,
  deleteWorktree,
  renameSession as renameSessionApi,
  launchWorkspaceSession,
} from '../lib/api.js';
import {
  derivePrAction,
  buildPrStateInput,
  getActionPrompt,
} from '../lib/pr-state.js';
import {
  createAgentSession,
  getCurrentSessionContext,
} from '../lib/session-utils.js';
import {
  resolveSessionByKey,
  resolveSessionCloseTarget,
} from '../lib/session-keys.js';
import type { SessionIntent, PickerItem } from '../lib/session-intent.js';
import { issueToBranchName } from '../lib/session-intent.js';
import { getActiveTerminalHandle } from '../lib/terminal-refs.js';
import type { CustomizeSessionDialogHandle } from '../components/dialogs/CustomizeSessionDialog.js';
import type { DeleteWorktreeDialogHandle } from '../components/dialogs/DeleteWorktreeDialog.js';
import type { WorkspaceSettingsDialogHandle } from '../components/dialogs/WorkspaceSettingsDialog.js';

const logger = createLogger('useSessionHandlers');

function focusActiveTerminalSoon(): void {
  const focus = () => getActiveTerminalHandle()?.focusTerm();
  if (typeof window === 'undefined') {
    focus();
    return;
  }
  window.setTimeout(focus, 0);
}

export interface UseSessionHandlersParams {
  customizeDialogRef: React.RefObject<CustomizeSessionDialogHandle | null>;
  deleteWorktreeDialogRef: React.RefObject<DeleteWorktreeDialogHandle | null>;
  workspaceSettingsDialogRef: React.RefObject<WorkspaceSettingsDialogHandle | null>;
  setAnalyticsView: (v: 'dashboard' | { sessionId: string } | null) => void;
}

export function useSessionHandlers({
  customizeDialogRef,
  deleteWorktreeDialogRef,
  workspaceSettingsDialogRef,
  setAnalyticsView,
}: UseSessionHandlersParams) {
  const navigateToDashboard = useCallback(() => {
    useSessionsStore.getState().setActiveSessionId(null);
  }, []);

  const navigateToSession = useCallback(
    (sessionId: string, _sessionType: string) => {
      useSessionsStore.getState().setActiveSessionId(sessionId);
      const session = resolveSessionByKey(
        useSessionsStore.getState().sessions,
        sessionId
      );
      if (session) {
        useUiStore.getState().setActiveRepoPath(session.repoPath ?? null);
      }
      useSessionsStore.getState().handleUserViewed(sessionId);
      useUiStore.getState().closeSidebar();
    },
    []
  );

  const handleRenameActiveSession = useCallback(async () => {
    const name = prompt('rename session:');
    const state = useSessionsStore.getState();
    const id = state.activeSessionId;
    const session = id ? resolveSessionByKey(state.sessions, id) : undefined;
    if (name?.trim() && session) {
      await renameSessionApi(session.id, name.trim());
    }
  }, []);

  const handleSelectSession = useCallback(
    (id: string) => {
      setAnalyticsView(null);
      useSessionsStore.getState().setActiveSessionId(id);
      const session = resolveSessionByKey(
        useSessionsStore.getState().sessions,
        id
      );
      if (session) {
        if (session.repoPath) {
          useSessionsStore
            .getState()
            .rememberSessionForWorkspace(session.repoPath, id);
        }
        useUiStore.getState().setActiveRepoPath(session.repoPath ?? null);
      }
      useSessionsStore.getState().handleUserViewed(id);
      useUiStore.getState().closeSidebar();
      focusActiveTerminalSoon();
    },
    [setAnalyticsView]
  );

  const handleSelectWorkspace = useCallback(
    (path: string) => {
      setAnalyticsView(null);
      const currentRepoPath = useUiStore.getState().activeRepoPath;
      if (currentRepoPath === path) {
        // Already viewing this workspace — toggle between session and dashboard
        if (useSessionsStore.getState().activeSessionId) {
          useSessionsStore.getState().setActiveSessionId(null);
        } else {
          const recalled = useSessionsStore
            .getState()
            .recallSessionForWorkspace(path);
          if (recalled)
            useSessionsStore.getState().setActiveSessionId(recalled);
        }
      } else {
        useUiStore.getState().setActiveRepoPath(path);
        useSessionsStore
          .getState()
          .setActiveSessionId(
            useSessionsStore.getState().recallSessionForWorkspace(path)
          );
      }
      useUiStore.getState().closeSidebar();
    },
    [setAnalyticsView]
  );

  const handleQuickAgent = useCallback(async () => {
    const { currentActiveWorkspace, currentWorktreePath } =
      getCurrentSessionContext();
    if (!currentActiveWorkspace) return;
    const { cols, rows } = estimateTerminalDimensions(
      useUiStore.getState().terminalFontSize
    );
    const { session, error } = await createAgentSession({
      repoPath: currentActiveWorkspace.path,
      worktreePath: currentWorktreePath,
      type: 'agent',
      cols,
      rows,
    });
    if (session?.id && !(error instanceof ConflictError)) {
      useSessionsStore
        .getState()
        .initSessionNotification(
          session.id,
          useConfigStore.getState().defaultNotifications
        );
    }
    if (error && !(error instanceof ConflictError)) {
      logger.error('Failed to create agent session:', error);
      useToastStore
        .getState()
        .showToast(
          error instanceof Error
            ? error.message
            : 'failed to create agent session'
        );
    }
  }, []);

  const handleLaunchRepoSession = useCallback(async (repoPath: string) => {
    const loadingKey = `repo-session:${repoPath}`;
    if (useSessionsStore.getState().isItemLoading(loadingKey)) return;
    useSessionsStore.getState().setLoading(loadingKey);
    try {
      const { cols, rows } = estimateTerminalDimensions(
        useUiStore.getState().terminalFontSize
      );
      const { session, error } = await createAgentSession({
        repoPath,
        worktreePath: null,
        type: 'agent',
        cols,
        rows,
      });
      if (session?.id) {
        useUiStore.getState().setActiveRepoPath(repoPath);
        if (!(error instanceof ConflictError)) {
          useSessionsStore
            .getState()
            .initSessionNotification(
              session.id,
              useConfigStore.getState().defaultNotifications
            );
        }
        useUiStore.getState().closeSidebar();
      }
      if (error && !(error instanceof ConflictError)) {
        useToastStore
          .getState()
          .showToast(
            error instanceof Error ? error.message : 'failed to create session'
          );
      }
    } finally {
      useSessionsStore.getState().clearLoading(loadingKey);
    }
  }, []);

  const handleQuickTerminal = useCallback(async () => {
    const { currentActiveWorkspace, currentWorktreePath } =
      getCurrentSessionContext();
    if (!currentActiveWorkspace) return;
    const { session, error } = await createAgentSession({
      repoPath: currentActiveWorkspace.path,
      worktreePath: currentWorktreePath,
      type: 'terminal',
    });
    if (session?.id && !(error instanceof ConflictError)) {
      useSessionsStore
        .getState()
        .initSessionNotification(
          session.id,
          useConfigStore.getState().defaultNotifications
        );
    }
    if (error && !(error instanceof ConflictError)) {
      logger.error('Failed to create terminal session:', error);
      useToastStore
        .getState()
        .showToast(
          error instanceof Error
            ? error.message
            : 'failed to create terminal session'
        );
    }
  }, []);

  const handleCustomize = useCallback(() => {
    const currentRepoPath = useUiStore.getState().activeRepoPath;
    const currentActiveWorkspace = currentRepoPath
      ? useSessionsStore
          .getState()
          .repos.find((w) => w.path === currentRepoPath)
      : undefined;
    const sessionsState = useSessionsStore.getState();
    const currentActiveSessionId = sessionsState.activeSessionId;
    const currentActiveSession = currentActiveSessionId
      ? resolveSessionByKey(sessionsState.sessions, currentActiveSessionId)
      : undefined;
    if (currentActiveWorkspace) {
      customizeDialogRef.current?.open(
        {
          name: currentActiveWorkspace.name,
          path: currentActiveWorkspace.path,
        },
        currentActiveSession?.worktreePath
      );
    }
  }, [customizeDialogRef]);

  const handleOpenSettings = useCallback(
    (workspace?: Repo) => {
      if (workspace) {
        workspaceSettingsDialogRef.current?.open(
          workspace.path,
          workspace.name
        );
      } else {
        useUiStore
          .getState()
          .setActiveModal({ modal: 'settings', scrollToId: null });
      }
    },
    [workspaceSettingsDialogRef]
  );

  const handleNewWorktree = useCallback(
    async (workspace: Repo) => {
      const loadingKey = `new-worktree:${workspace.path}`;
      if (useSessionsStore.getState().isItemLoading(loadingKey)) return;
      useSessionsStore.getState().setLoading(loadingKey);
      try {
        const { branchName, worktreePath } = await createWorktree(
          workspace.path
        );
        const { session, error } = await createAgentSession({
          repoPath: workspace.path,
          worktreePath,
          type: 'agent',
          branchName,
          needsBranchRename: true,
          newWorktree: true,
        });
        if (error && !(error instanceof ConflictError)) throw error;
        if (!session) throw new Error('failed to create worktree session');
        useUiStore.getState().setActiveRepoPath(workspace.path);
        if (!(error instanceof ConflictError)) {
          useSessionsStore
            .getState()
            .initSessionNotification(
              session.id,
              useConfigStore.getState().defaultNotifications
            );
        }
        useUiStore.getState().closeSidebar();
        focusActiveTerminalSoon();
      } catch (e) {
        logger.error('Failed to create worktree session:', e);
        useToastStore
          .getState()
          .showToast(
            e instanceof Error ? e.message : 'failed to create worktree'
          );
        // Fall back to dialog on error so user can retry with options
        customizeDialogRef.current?.open({
          name: workspace.name,
          path: workspace.path,
        });
      } finally {
        useSessionsStore.getState().clearLoading(loadingKey);
      }
    },
    [customizeDialogRef]
  );

  const handleLaunchWorkspaceSession = useCallback(
    async (workspaceId: string) => {
      const loadingKey = `ws-launch:${workspaceId}`;
      if (useSessionsStore.getState().isItemLoading(loadingKey)) return;
      useSessionsStore.getState().setLoading(loadingKey);
      try {
        const result = await launchWorkspaceSession(workspaceId);
        await useSessionsStore.getState().refreshAll();
        useSessionsStore.getState().setActiveSessionId(result.id);
        useUiStore.getState().setActiveRepoPath(result.repoPath ?? null);
        useUiStore.getState().setActiveWorkspaceId(workspaceId);
        useUiStore.getState().closeSidebar();

        if (result.warnings?.length) {
          const msgs = result.warnings
            .map(
              (w: { repoPath: string; error: string }) =>
                `  ${w.repoPath}: ${w.error}`
            )
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
    },
    []
  );

  const handleFixConflicts = useCallback(async (pr: PullRequest) => {
    const repoPath = pr.repoPath ?? useUiStore.getState().activeRepoPath;
    const currentActiveWorkspace = repoPath
      ? useSessionsStore.getState().repos.find((w) => w.path === repoPath)
      : undefined;
    if (!currentActiveWorkspace || !repoPath) return;

    const currentSessions = useSessionsStore.getState().sessions;
    const currentWorktrees = useSessionsStore.getState().worktrees;
    const existingSession = currentSessions.find(
      (s) => s.branchName === pr.headRefName && s.repoPath === repoPath
    );
    const existingWorktree = currentWorktrees.find(
      (w) => w.branchName === pr.headRefName && w.repoPath === repoPath
    );

    let conflictPrompt = `Merge the branch "${pr.baseRefName}" into this branch and resolve all merge conflicts. Use \`git merge ${pr.baseRefName}\` and fix any conflicts in the working tree. After resolving, verify the build passes.`;
    try {
      const settings = await fetchWorkspaceSettings(repoPath);
      if (settings.promptFixConflicts) {
        conflictPrompt = settings.promptFixConflicts
          .replace(/\{baseRefName\}/g, pr.baseRefName)
          .replace(/\{headRefName\}/g, pr.headRefName);
      }
    } catch {
      // fall through with default prompt
    }

    try {
      let worktreePath: string | null;
      let branchName: string;
      let newWorktree = false;

      if (existingSession) {
        worktreePath = existingSession.worktreePath ?? null;
        branchName = existingSession.branchName ?? pr.headRefName;
      } else if (existingWorktree) {
        worktreePath = existingWorktree.path;
        branchName = existingWorktree.branchName;
      } else {
        const wt = await createWorktree(repoPath, pr.headRefName);
        worktreePath = wt.worktreePath;
        branchName = wt.branchName;
        newWorktree = true;
      }

      const { session, error } = await createAgentSession({
        repoPath,
        worktreePath,
        type: 'agent',
        branchName,
        newWorktree,
      });
      if (!session)
        throw error ?? new Error('failed to start conflict resolution');
      useUiStore.getState().setActiveRepoPath(repoPath);
      if (!(error instanceof ConflictError)) {
        useSessionsStore
          .getState()
          .initSessionNotification(
            session.id,
            useConfigStore.getState().defaultNotifications
          );
      }
      useUiStore.getState().closeSidebar();

      // Delay sending the prompt to allow the terminal WebSocket connection to establish
      setTimeout(() => {
        sendPtyData(conflictPrompt + '\r');
      }, 1500);
    } catch (e) {
      logger.error('Failed to start conflict resolution:', e);
      useToastStore
        .getState()
        .showToast(
          e instanceof Error ? e.message : 'failed to start conflict resolution'
        );
    }
  }, []);

  const handleOpenPrBranch = useCallback(
    async (pr: PullRequest, prPrompt?: string) => {
      const repoPath = pr.repoPath ?? useUiStore.getState().activeRepoPath;
      const currentActiveWorkspace = repoPath
        ? useSessionsStore.getState().repos.find((w) => w.path === repoPath)
        : undefined;
      if (!currentActiveWorkspace || !repoPath) return;

      const currentSessions = useSessionsStore.getState().sessions;
      const currentWorktrees = useSessionsStore.getState().worktrees;
      const existingSession = currentSessions.find(
        (s) => s.branchName === pr.headRefName && s.repoPath === repoPath
      );
      const existingWorktree = currentWorktrees.find(
        (w) => w.branchName === pr.headRefName && w.repoPath === repoPath
      );

      try {
        let worktreePath: string | null;
        let branchName: string;
        let newWorktree = false;

        if (existingSession) {
          worktreePath = existingSession.worktreePath ?? null;
          branchName = existingSession.branchName ?? pr.headRefName;
        } else if (existingWorktree) {
          worktreePath = existingWorktree.path;
          branchName = existingWorktree.branchName;
        } else {
          const wt = await createWorktree(repoPath, pr.headRefName);
          worktreePath = wt.worktreePath;
          branchName = wt.branchName;
          newWorktree = true;
        }

        const { session, error } = await createAgentSession({
          repoPath,
          worktreePath,
          type: 'agent',
          branchName,
          newWorktree,
        });
        if (!session)
          throw error ?? new Error('failed to open PR branch session');
        useUiStore.getState().setActiveRepoPath(repoPath);
        if (!(error instanceof ConflictError)) {
          useSessionsStore
            .getState()
            .initSessionNotification(
              session.id,
              useConfigStore.getState().defaultNotifications
            );
        }
        useUiStore.getState().closeSidebar();

        // TODO: replace setTimeout with event-driven terminal-ready signal to avoid race condition on slow connections
        if (prPrompt) {
          setTimeout(() => {
            sendPtyData(prPrompt + '\r');
          }, 1500);
        }
      } catch (e) {
        logger.error('Failed to open PR branch session:', e);
        useToastStore
          .getState()
          .showToast(
            e instanceof Error
              ? e.message
              : 'failed to open session on this branch'
          );
      }
    },
    []
  );

  const handleOpenBranchSession = useCallback(
    async (branchName: string, repoPath: string, branchPrompt?: string) => {
      try {
        const currentSessions = useSessionsStore.getState().sessions;
        const currentWorktrees = useSessionsStore.getState().worktrees;
        const existingSession = currentSessions.find(
          (s) => s.branchName === branchName && s.repoPath === repoPath
        );
        const existingWorktree = currentWorktrees.find(
          (w) => w.branchName === branchName && w.repoPath === repoPath
        );

        let worktreePath: string | null;
        let resolvedBranch: string;
        let newWorktree = false;

        if (existingSession) {
          worktreePath = existingSession.worktreePath ?? null;
          resolvedBranch = existingSession.branchName ?? branchName;
        } else if (existingWorktree) {
          worktreePath = existingWorktree.path;
          resolvedBranch = existingWorktree.branchName;
        } else {
          const wt = await createWorktree(repoPath, branchName);
          worktreePath = wt.worktreePath;
          resolvedBranch = wt.branchName;
          newWorktree = true;
        }

        const { session, error } = await createAgentSession({
          repoPath,
          worktreePath,
          type: 'agent',
          branchName: resolvedBranch,
          newWorktree,
        });
        if (!session) throw error ?? new Error('failed to open branch session');
        useUiStore.getState().setActiveRepoPath(repoPath);
        if (!(error instanceof ConflictError)) {
          useSessionsStore
            .getState()
            .initSessionNotification(
              session.id,
              useConfigStore.getState().defaultNotifications
            );
        }
        useUiStore.getState().closeSidebar();

        // TODO: replace setTimeout with event-driven terminal-ready signal to avoid race condition on slow connections
        if (branchPrompt) {
          setTimeout(() => sendPtyData(branchPrompt + '\r'), 1500);
        }
      } catch (e) {
        logger.error('Failed to open branch session:', e);
      }
    },
    []
  );

  const handleArchive = useCallback(async () => {
    const sessionState = useSessionsStore.getState();
    const sessionId = sessionState.activeSessionId;
    if (!sessionId) return;
    const session = resolveSessionByKey(sessionState.sessions, sessionId);
    if (!session) return;

    // Kill the session. Archive still proceeds to worktree cleanup if the
    // session was already gone or the backend close fails.
    try {
      await killSession(session.id, session.nodeId);
    } catch (error) {
      logger.warn('Failed to close session before archive:', error);
    }

    // If worktree session, delete the worktree too
    if (session.worktreePath && session.repoPath) {
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

  // Handler map replaces switch statement in handlePickerIntent to reduce cyclomatic complexity
  type PickerIntentHandler = (
    intent: SessionIntent,
    item: PickerItem
  ) => Promise<void>;

  const pickerIntentHandlers: Record<string, PickerIntentHandler> = {
    'resume-session': async (intent) => {
      if (intent.existingSessionId) {
        navigateToSession(intent.existingSessionId, 'agent');
      } else {
        logger.warn('resume-session intent missing existingSessionId');
      }
    },
    'fix-conflicts': async (_intent, item) => {
      if (item.kind === 'pr') {
        await handleFixConflicts(item.pr);
      }
    },
    'review-pr': async (intent, item) => {
      if (item.kind === 'pr') {
        await handleOpenPrBranch(item.pr, intent.prompt ?? undefined);
      }
    },
    'fix-errors': async (intent, item) => {
      if (item.kind === 'pr') {
        await handleOpenPrBranch(item.pr, intent.prompt ?? undefined);
      }
    },
    'resolve-comments': async (intent, item) => {
      if (item.kind === 'pr') {
        await handleOpenPrBranch(item.pr, intent.prompt ?? undefined);
      }
    },
    'create-pr': async (intent, item) => {
      if (item.kind === 'pr') {
        await handleOpenPrBranch(item.pr, intent.prompt ?? undefined);
      }
    },
    'merge-pr': async (_intent, item) => {
      if (item.kind === 'pr') {
        window.open(item.pr.url, '_blank');
      }
    },
    'open-branch': async (intent, item) => {
      if (item.kind === 'branch') {
        await handleOpenBranchSession(
          item.name,
          item.repoPath,
          intent.prompt ?? undefined
        );
      }
    },
    'start-from-issue': async (intent, item) => {
      if (item.kind === 'issue') {
        const branchName = issueToBranchName(item.issue);
        await handleOpenBranchSession(
          branchName,
          item.issue.repoPath,
          intent.prompt ?? undefined
        );
      }
    },
    archive: async (intent) => {
      // TODO: wire to archive flow with confirmation UX
      if (intent.existingSessionId) {
        useSessionsStore
          .getState()
          .setActiveSessionId(intent.existingSessionId);
        await handleArchive();
      }
    },
  };

  const handlePickerIntent = useCallback(
    async (intent: SessionIntent, item: PickerItem) => {
      const handler = pickerIntentHandlers[intent.type];
      if (handler) {
        await handler(intent, item);
      }
    },
    [
      navigateToSession,
      handleFixConflicts,
      handleOpenPrBranch,
      handleOpenBranchSession,
      handleArchive,
    ]
  );

  const handlePrAction = useCallback(
    (pr: PullRequest) => {
      const action = derivePrAction(buildPrStateInput(pr));
      const actionPrompt = getActionPrompt(action, {
        branchName: pr.headRefName,
        baseBranch: pr.baseRefName,
        prNumber: pr.number,
      });
      if (actionPrompt) {
        handleOpenPrBranch(pr, actionPrompt);
      }
    },
    [handleOpenPrBranch]
  );

  const handleOpenPrSession = useCallback(
    (pr: PullRequest) => {
      handleOpenPrBranch(pr);
    },
    [handleOpenPrBranch]
  );

  const handleDeleteWorktree = useCallback(
    async (wt: WorktreeInfo) => {
      try {
        const status = await fetchWorktreeStatus(wt.path);
        const hasActive = status.activeSessions.length > 0;
        if (status.hasUncommittedChanges) {
          deleteWorktreeDialogRef.current?.open(wt, hasActive);
        } else {
          useSessionsStore.getState().setLoading(wt.path);
          try {
            if (hasActive) {
              await deleteWorktree(wt.path, wt.repoPath, true);
            } else {
              await deleteWorktree(wt.path, wt.repoPath);
            }
          } finally {
            useSessionsStore.getState().clearLoading(wt.path);
          }
        }
      } catch (err) {
        useToastStore
          .getState()
          .showToast(
            err instanceof Error ? err.message : 'Failed to delete worktree',
            'error'
          );
      }
    },
    [deleteWorktreeDialogRef]
  );

  const handleNewSessionCreated = useCallback((sessionId: string) => {
    useSessionsStore.getState().setActiveSessionId(sessionId);
    useSessionsStore
      .getState()
      .initSessionNotification(
        sessionId,
        useConfigStore.getState().defaultNotifications
      );
    useUiStore.getState().closeSidebar();
    focusActiveTerminalSoon();
  }, []);

  const handleResumeWorktree = useCallback(async (wt: WorktreeInfo) => {
    const loadingKey = wt.path;
    if (useSessionsStore.getState().isItemLoading(loadingKey)) return;
    useSessionsStore.getState().setLoading(loadingKey);
    try {
      const { cols, rows } = estimateTerminalDimensions(
        useUiStore.getState().terminalFontSize
      );
      const { session, error } = await createAgentSession({
        repoPath: wt.repoPath,
        worktreePath: wt.path,
        type: 'agent',
        branchName: wt.branchName,
        cols,
        rows,
      });
      if (session?.id) {
        useUiStore.getState().setActiveRepoPath(wt.repoPath);
        useSessionsStore.getState().setActiveSessionId(session.id);
        useSessionsStore
          .getState()
          .rememberSessionForWorkspace(wt.repoPath, session.id);
        if (!(error instanceof ConflictError)) {
          useSessionsStore
            .getState()
            .initSessionNotification(
              session.id,
              useConfigStore.getState().defaultNotifications
            );
        }
        useUiStore.getState().closeSidebar();
      }
      if (error && !(error instanceof ConflictError)) {
        useToastStore
          .getState()
          .showToast(
            error instanceof Error
              ? error.message
              : 'failed to resume worktree session'
          );
      }
    } catch (e) {
      logger.error('Failed to resume worktree:', e);
      useToastStore
        .getState()
        .showToast(
          e instanceof Error ? e.message : 'failed to resume worktree session'
        );
    } finally {
      useSessionsStore.getState().clearLoading(loadingKey);
    }
  }, []);

  const handleCloseSession = useCallback(
    (sessionId: string, nodeId?: string) => {
      const state = useSessionsStore.getState();
      const {
        session: targetSession,
        sessionId: localSessionId,
        nodeId: targetNodeId,
      } = resolveSessionCloseTarget(state.sessions, sessionId, nodeId);
      // Kill session via API, then refresh
      void killSession(localSessionId, targetNodeId)
        .catch((error) => {
          logger.error('Failed to close session:', error);
        })
        .finally(() => useSessionsStore.getState().refreshAll());
      const currentActiveSessionId = state.activeSessionId;
      const isClosingActive =
        currentActiveSessionId !== null &&
        targetSession !== undefined &&
        resolveSessionByKey(state.sessions, currentActiveSessionId) ===
          targetSession;
      if (isClosingActive) {
        // Select next available session in this workspace
        const currentActiveSession = targetSession;
        const currentRepoPath = useUiStore.getState().activeRepoPath;
        const allWs = currentRepoPath
          ? useSessionsStore.getState().getSessionsForRepo(currentRepoPath)
          : [];
        const sameDir = currentActiveSession
          ? allWs.filter((s) => s.cwd === currentActiveSession.cwd)
          : allWs;
        const remaining = sameDir.filter((s) => s !== targetSession);
        useSessionsStore
          .getState()
          .setActiveSessionId(remaining[0]?.id ?? null);
      }
    },
    []
  );

  return {
    navigateToDashboard,
    navigateToSession,
    handleRenameActiveSession,
    handleSelectSession,
    handleSelectWorkspace,
    handleQuickAgent,
    handleQuickTerminal,
    handleCustomize,
    handleOpenSettings,
    handleNewWorktree,
    handleLaunchWorkspaceSession,
    handleLaunchRepoSession,
    handleFixConflicts,
    handleOpenPrBranch,
    handleOpenBranchSession,
    handleArchive,
    handlePickerIntent,
    handlePrAction,
    handleOpenPrSession,
    handleDeleteWorktree,
    handleResumeWorktree,
    handleNewSessionCreated,
    handleCloseSession,
  };
}
