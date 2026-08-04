import { useCallback } from 'react';
import type React from 'react';
import { createLogger } from '../lib/logger.js';
import { useSessionsStore } from '../lib/stores/sessions.js';
import { useUiStore } from '../lib/stores/ui.js';
import { useConfigStore } from '../lib/stores/config.js';
import { useToastStore } from '../lib/stores/toasts.js';
import type { WorktreeInfo, Repo, PullRequest } from '../lib/types.js';
import {
  ConflictError,
  fetchWorkspaceSettings,
  fetchWorktreeStatus,
} from '../lib/api.js';
import {
  executeSessionKillAction,
  executeSessionRenameAction,
} from '../lib/actions/session-lifecycle.js';
import {
  executeWorktreeArchiveAction,
  executeWorktreeCreateAction,
  executeWorktreeDeleteAction,
} from '../lib/actions/workspace-lifecycle.js';
import {
  derivePrAction,
  buildPrStateInput,
  getActionPrompt,
} from '../lib/pr-state.js';
import {
  createTerminalSession,
  getCurrentSessionContext,
} from '../lib/session-utils.js';
import { openAgentChannel } from '../lib/agent-channels.js';
import { leaveChatSurface } from '../lib/topic-task-room.js';
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
  // #1287: `dashboard` sits BELOW an open channel and an open composer in
  // `resolveAppViewMode`, so clearing the session alone left every caller a
  // silent no-op while a channel was on screen — and the palette offers all of
  // them there (`pr.*` and `session.start-on-ticket` gate on `workspacePath`
  // only, which an open channel satisfies). Same latch-without-clear bug as the
  // new-chat button; routed through the shared helper so it cannot drift again.
  const navigateToDashboard = useCallback(() => {
    leaveChatSurface();
    useSessionsStore.getState().setActiveSessionId(null);
  }, []);

  const navigateToSession = useCallback(
    (sessionId: string, _sessionType: string) => {
      useUiStore.getState().setForceOrgCockpit(false);
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
      // Route through the shared sessions.rename executor; passing the owning
      // node lets the default api executor keep its node-aware PATCH routing.
      const result = await executeSessionRenameAction({
        id: session.id,
        displayName: name.trim(),
        ...(session.nodeId ? { nodeId: session.nodeId } : {}),
      });
      if (!result.ok) {
        logger.error('Failed to rename session:', result.error);
        return;
      }
      await useSessionsStore.getState().refreshAll();
    }
  }, []);

  const handleSelectSession = useCallback(
    (id: string) => {
      setAnalyticsView(null);
      useUiStore.getState().setForceOrgCockpit(false);
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
    try {
      await openAgentChannel();
    } catch (error) {
      logger.error('Failed to open agent chat:', error);
      useToastStore
        .getState()
        .showToast(
          error instanceof Error ? error.message : 'failed to open agent chat'
        );
    }
  }, []);

  const handleLaunchRepoSession = useCallback(async (repoPath: string) => {
    const loadingKey = `repo-session:${repoPath}`;
    if (useSessionsStore.getState().isItemLoading(loadingKey)) return;
    useSessionsStore.getState().setLoading(loadingKey);
    try {
      useUiStore.getState().setActiveRepoPath(repoPath);
      await openAgentChannel();
    } catch (error) {
      useToastStore
        .getState()
        .showToast(
          error instanceof Error ? error.message : 'failed to open chat'
        );
    } finally {
      useSessionsStore.getState().clearLoading(loadingKey);
    }
  }, []);

  const handleQuickTerminal = useCallback(async () => {
    const { currentActiveWorkspace, currentWorktreePath } =
      getCurrentSessionContext();
    if (!currentActiveWorkspace) return;
    const { session, error } = await createTerminalSession({
      repoPath: currentActiveWorkspace.path,
      worktreePath: currentWorktreePath,
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
        const worktreeResult = await executeWorktreeCreateAction({
          repoPath: workspace.path,
        });
        if (!worktreeResult.ok) {
          throw new Error(worktreeResult.error.message);
        }
        const { branchName, worktreePath } = worktreeResult.data;
        useUiStore.getState().setActiveRepoPath(workspace.path);
        await openAgentChannel({
          prompt: `Continue work on branch ${branchName} in ${worktreePath}.`,
        });
      } catch (e) {
        logger.error('Failed to create worktree chat:', e);
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
        useUiStore.getState().setActiveWorkspaceId(workspaceId);
        await openAgentChannel({ workspaceId });
      } catch (error) {
        logger.error('[workspace-chat] open failed:', error);
        useToastStore
          .getState()
          .showToast(
            error instanceof Error ? error.message : 'failed to open chat'
          );
      } finally {
        useSessionsStore.getState().clearLoading(loadingKey);
      }
    },
    []
  );

  const handleFixConflicts = useCallback(async (pr: PullRequest) => {
    const repoPath = pr.repoPath ?? useUiStore.getState().activeRepoPath;
    if (!repoPath) return;

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
      useUiStore.getState().setActiveRepoPath(repoPath);
      await openAgentChannel({ prompt: conflictPrompt });
    } catch (error) {
      logger.error('Failed to open conflict-resolution chat:', error);
      useToastStore
        .getState()
        .showToast(
          error instanceof Error
            ? error.message
            : 'failed to open conflict-resolution chat'
        );
    }
  }, []);

  const handleOpenPrBranch = useCallback(
    async (pr: PullRequest, prPrompt?: string) => {
      const repoPath = pr.repoPath ?? useUiStore.getState().activeRepoPath;
      if (!repoPath) return;
      const prompt =
        prPrompt?.trim() ||
        `Open pull request #${pr.number} on branch ${pr.headRefName} and review its current state.`;
      try {
        useUiStore.getState().setActiveRepoPath(repoPath);
        await openAgentChannel({ prompt });
      } catch (error) {
        logger.error('Failed to open PR chat:', error);
        useToastStore
          .getState()
          .showToast(
            error instanceof Error ? error.message : 'failed to open PR chat'
          );
      }
    },
    []
  );

  const handleOpenBranchSession = useCallback(
    async (branchName: string, repoPath: string, branchPrompt?: string) => {
      const prompt =
        branchPrompt?.trim() ||
        `Open branch ${branchName} in ${repoPath} and inspect its current state.`;
      try {
        useUiStore.getState().setActiveRepoPath(repoPath);
        await openAgentChannel({ prompt });
      } catch (error) {
        logger.error('Failed to open branch chat:', error);
        useToastStore
          .getState()
          .showToast(
            error instanceof Error
              ? error.message
              : 'failed to open branch chat'
          );
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

    // #870: kill the session through the shared sessions.kill executor. Archive
    // still proceeds to worktree cleanup if the session was already gone or the
    // backend close fails (best-effort — inspect the envelope, do not throw).
    const killResult = await executeSessionKillAction({
      id: session.id,
      ...(session.nodeId ? { nodeId: session.nodeId } : {}),
    });
    if (!killResult.ok) {
      logger.warn('Failed to close session before archive:', killResult.error);
    }

    // #870: if a worktree session, ARCHIVE the worktree (branch-PRESERVING) via
    // the worktrees.archive executor. This is a deliberate behavior change from
    // the prior deleteWorktree call, which removed the branch. Best-effort — the
    // worktree may already be gone — so a non-ok envelope is logged, not thrown.
    if (session.worktreePath && session.repoPath) {
      const archiveResult = await executeWorktreeArchiveAction({
        repoPath: session.repoPath,
        worktreePath: session.worktreePath,
      });
      if (!archiveResult.ok) {
        logger.warn('Failed to archive worktree:', archiveResult.error);
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
          // Dirty worktree: DeleteWorktreeDialog stays the confirmation surface
          // layered over the destructive worktrees.delete contract.
          deleteWorktreeDialogRef.current?.open(wt, hasActive);
        } else {
          // #870: clean worktree — route the delete through the stable
          // worktrees.delete descriptor/executor. Preserve the existing force
          // semantics (force only when an active session must be torn down) and
          // inspect the envelope rather than fire-and-forget.
          useSessionsStore.getState().setLoading(wt.path);
          try {
            const deleteResult = await executeWorktreeDeleteAction({
              repoPath: wt.repoPath,
              worktreePath: wt.path,
              ...(hasActive ? { force: true } : {}),
            });
            if (!deleteResult.ok) {
              throw new Error(deleteResult.error.message);
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
      useUiStore.getState().setActiveRepoPath(wt.repoPath);
      await openAgentChannel({
        prompt: `Resume work on branch ${wt.branchName} in ${wt.path}.`,
      });
    } catch (e) {
      logger.error('Failed to resume worktree chat:', e);
      useToastStore
        .getState()
        .showToast(
          e instanceof Error ? e.message : 'failed to resume worktree chat'
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
      // Close = kill + tab-selection UI. Route the kill through the shared
      // sessions.kill executor with the resolved owning node, then refresh
      // regardless of outcome. Tab selection below stays synchronous so the UI
      // advances without waiting on the kill.
      void executeSessionKillAction({
        id: localSessionId,
        nodeId: targetNodeId,
      })
        .then((result) => {
          if (!result.ok) {
            logger.error('Failed to close session:', result.error);
          }
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
