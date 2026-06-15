import { useCallback } from 'react';
import type React from 'react';
import { createLogger } from '../lib/logger.js';
import { useSessionsStore } from '../lib/stores/sessions.js';
import { useUiStore } from '../lib/stores/ui.js';
import { useConfigStore } from '../lib/stores/config.js';
import { useToastStore } from '../lib/stores/toasts.js';
import { estimateTerminalDimensions } from '../lib/utils.js';
import type { WorktreeInfo, Repo, PullRequest } from '../lib/types.js';
import {
  ConflictError,
  fetchIaBenches,
  fetchWorkspaceSettings,
  fetchWorktreeStatus,
} from '../lib/api.js';
import {
  executeSessionKillAction,
  executeSessionRenameAction,
} from '../lib/actions/session-lifecycle.js';
import {
  executeWorkspaceLaunchAction,
  executeWorktreeArchiveAction,
  executeWorktreeCreateAction,
  executeWorktreeDeleteAction,
} from '../lib/actions/workspace-lifecycle.js';
import { executeBranchOpenSessionAction } from '../lib/actions/start-work-lifecycle.js';
import type { BenchCreatePayload } from '../lib/state/view-tree.js';
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

// The composite branches.openSession executor returns
// RelayCliGatewayEnvelope<unknown>; success data projects to
// workflowCommandOutputSchema with a required `session.id`. Narrow it
// defensively rather than asserting the wire shape.
function sessionIdFromWorkflowData(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const session = (data as { session?: unknown }).session;
  if (typeof session !== 'object' || session === null) return undefined;
  const id = (session as { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
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

  // #731: "+ tab" anchored to a view-spine Bench. Reuses the EXISTING
  // node-aware create entrypoint (`createAgentSession` → `createSession`, the
  // #473 local/remote/free flow). The bench resolves to the agent-session repo
  // context the backend requires (`repoPath` ∈ config.repos, worktree → cwd) —
  // mirroring the dialog's local-git create. #740: the new Tab also inherits the
  // anchoring Bench's persisted `envOverrides` overlay (looked up by benchId),
  // applied additively to the PTY env by the backend (reserved `PATH`/`RELAY_*`
  // keys are refused). The overlay lookup is best-effort — a fetch failure or
  // missing overlay just creates with no extra env (unchanged behavior), never
  // blocking the tab. Offline/remote-unavailable benches fail through the same
  // toast path as every other create; no bespoke error UI.
  const handleViewSpineCreateTab = useCallback(
    async (payload: BenchCreatePayload) => {
      const loadingKey = `view-spine-tab:${payload.nodeId}:${payload.cwd}`;
      if (useSessionsStore.getState().isItemLoading(loadingKey)) return;
      useSessionsStore.getState().setLoading(loadingKey);
      try {
        const { cols, rows } = estimateTerminalDimensions(
          useUiStore.getState().terminalFontSize
        );
        // Resolve the anchoring Bench's persisted env overlay (#740). Match by
        // the deterministic benchId; best-effort so create never blocks on it.
        let envOverrides: Record<string, string> | undefined;
        try {
          const benches = await fetchIaBenches(payload.instanceId);
          const overlay = benches.find((b) => b.id === payload.benchId);
          if (overlay && Object.keys(overlay.envOverrides).length > 0) {
            envOverrides = overlay.envOverrides;
          }
        } catch (overlayError) {
          logger.warn(
            'view-spine tab: bench env-overlay lookup failed; creating with no inherited env',
            overlayError
          );
        }
        const { session, error } = await createAgentSession({
          nodeId: payload.nodeId,
          repoPath: payload.repoPath,
          worktreePath: payload.worktreePath,
          cwd: payload.cwd,
          type: 'agent',
          cols,
          rows,
          ...(envOverrides ? { envOverrides } : {}),
        });
        if (session?.id && !(error instanceof ConflictError)) {
          useSessionsStore
            .getState()
            .initSessionNotification(
              session.id,
              useConfigStore.getState().defaultNotifications
            );
        }
        if (session?.id) useUiStore.getState().closeSidebar();
        if (error && !(error instanceof ConflictError)) {
          logger.error('Failed to create view-spine tab:', error);
          useToastStore
            .getState()
            .showToast(
              error instanceof Error ? error.message : 'failed to create tab'
            );
        }
      } finally {
        useSessionsStore.getState().clearLoading(loadingKey);
      }
    },
    []
  );

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
        // #870: route the createWorktree step through the stable worktrees.create
        // descriptor/executor. The createAgentSession tail below stays the #867
        // sessions.create path. Inspect the envelope rather than fire-and-forget.
        const worktreeResult = await executeWorktreeCreateAction({
          repoPath: workspace.path,
        });
        if (!worktreeResult.ok) {
          throw new Error(worktreeResult.error.message);
        }
        const { branchName, worktreePath } = worktreeResult.data;
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
        // #870: route launch through the stable workspaces.launch descriptor/
        // executor. Errors surface on the envelope (!ok) rather than as a throw,
        // so the existing alert path keys off result.error here.
        const launchResult = await executeWorkspaceLaunchAction({ workspaceId });
        if (!launchResult.ok) {
          logger.error(
            '[workspace-session] launch failed:',
            launchResult.error
          );
          alert(`workspace launch failed: ${launchResult.error.message}`);
          return;
        }
        const result = launchResult.data;
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

    // Store-state reuse lookup stays the fast path: resolve an existing
    // worktree/session for the PR head ref so the executor reuses it rather
    // than creating a new one.
    const currentSessions = useSessionsStore.getState().sessions;
    const currentWorktrees = useSessionsStore.getState().worktrees;
    const existingSession = currentSessions.find(
      (s) => s.branchName === pr.headRefName && s.repoPath === repoPath
    );
    const existingWorktree = currentWorktrees.find(
      (w) => w.branchName === pr.headRefName && w.repoPath === repoPath
    );
    const existingWorktreePath =
      existingSession?.worktreePath ?? existingWorktree?.path ?? undefined;

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

    // #871/#876: route through the composite branches.openSession executor.
    // The prompt rides prompt:{mode:'initial-prompt'} as a typed one-shot
    // delivery instead of the old setTimeout(sendPtyData) anti-pattern.
    const result = await executeBranchOpenSessionAction({
      repo: { repoPath },
      pr: { head: pr.headRefName, base: pr.baseRefName },
      branch: { name: pr.headRefName },
      worktree: { mode: 'create-if-missing' },
      ...(existingWorktreePath ? { existingWorktreePath } : {}),
      prompt: { mode: 'initial-prompt', prompt: conflictPrompt },
    });

    if (!result.ok) {
      // SESSION_CONFLICT carries details.sessionId — focus the existing session
      // (the prior ConflictError focus-existing behavior).
      const conflictSessionId =
        result.error.code === 'SESSION_CONFLICT' &&
        typeof result.error.details?.sessionId === 'string'
          ? result.error.details.sessionId
          : undefined;
      if (conflictSessionId) {
        useUiStore.getState().setActiveRepoPath(repoPath);
        useSessionsStore.getState().setActiveSessionId(conflictSessionId);
        useUiStore.getState().closeSidebar();
        return;
      }
      logger.error('Failed to start conflict resolution:', result.error);
      useToastStore
        .getState()
        .showToast(result.error.message || 'failed to start conflict resolution');
      return;
    }

    const sessionId = sessionIdFromWorkflowData(result.data);
    await useSessionsStore.getState().refreshAll();
    if (sessionId) {
      useSessionsStore.getState().setActiveSessionId(sessionId);
    }
    useUiStore.getState().setActiveRepoPath(repoPath);
    if (sessionId) {
      useSessionsStore
        .getState()
        .initSessionNotification(
          sessionId,
          useConfigStore.getState().defaultNotifications
        );
    }
    useUiStore.getState().closeSidebar();
  }, []);

  const handleOpenPrBranch = useCallback(
    async (pr: PullRequest, prPrompt?: string) => {
      const repoPath = pr.repoPath ?? useUiStore.getState().activeRepoPath;
      const currentActiveWorkspace = repoPath
        ? useSessionsStore.getState().repos.find((w) => w.path === repoPath)
        : undefined;
      if (!currentActiveWorkspace || !repoPath) return;

      // Store-state reuse lookup stays the fast path (PR head ref).
      const currentSessions = useSessionsStore.getState().sessions;
      const currentWorktrees = useSessionsStore.getState().worktrees;
      const existingSession = currentSessions.find(
        (s) => s.branchName === pr.headRefName && s.repoPath === repoPath
      );
      const existingWorktree = currentWorktrees.find(
        (w) => w.branchName === pr.headRefName && w.repoPath === repoPath
      );
      const existingWorktreePath =
        existingSession?.worktreePath ?? existingWorktree?.path ?? undefined;

      // #871/#876: route through the composite branches.openSession executor.
      // The optional PR prompt rides prompt:{mode:'initial-prompt'} as a typed
      // one-shot delivery instead of the old setTimeout(sendPtyData) anti-pattern.
      const result = await executeBranchOpenSessionAction({
        repo: { repoPath },
        pr: { head: pr.headRefName, base: pr.baseRefName },
        branch: { name: pr.headRefName },
        worktree: { mode: 'create-if-missing' },
        ...(existingWorktreePath ? { existingWorktreePath } : {}),
        ...(prPrompt ? { prompt: { mode: 'initial-prompt', prompt: prPrompt } } : {}),
      });

      if (!result.ok) {
        const conflictSessionId =
          result.error.code === 'SESSION_CONFLICT' &&
          typeof result.error.details?.sessionId === 'string'
            ? result.error.details.sessionId
            : undefined;
        if (conflictSessionId) {
          useUiStore.getState().setActiveRepoPath(repoPath);
          useSessionsStore.getState().setActiveSessionId(conflictSessionId);
          useUiStore.getState().closeSidebar();
          return;
        }
        logger.error('Failed to open PR branch session:', result.error);
        useToastStore
          .getState()
          .showToast(
            result.error.message || 'failed to open session on this branch'
          );
        return;
      }

      const sessionId = sessionIdFromWorkflowData(result.data);
      await useSessionsStore.getState().refreshAll();
      if (sessionId) {
        useSessionsStore.getState().setActiveSessionId(sessionId);
      }
      useUiStore.getState().setActiveRepoPath(repoPath);
      if (sessionId) {
        useSessionsStore
          .getState()
          .initSessionNotification(
            sessionId,
            useConfigStore.getState().defaultNotifications
          );
      }
      useUiStore.getState().closeSidebar();
    },
    []
  );

  const handleOpenBranchSession = useCallback(
    async (branchName: string, repoPath: string, branchPrompt?: string) => {
      // Store-state reuse lookup stays the fast path (named branch).
      const currentSessions = useSessionsStore.getState().sessions;
      const currentWorktrees = useSessionsStore.getState().worktrees;
      const existingSession = currentSessions.find(
        (s) => s.branchName === branchName && s.repoPath === repoPath
      );
      const existingWorktree = currentWorktrees.find(
        (w) => w.branchName === branchName && w.repoPath === repoPath
      );
      const existingWorktreePath =
        existingSession?.worktreePath ?? existingWorktree?.path ?? undefined;

      // #871/#876: route through the composite branches.openSession executor
      // (branch target — no PR). The optional branch prompt rides
      // prompt:{mode:'initial-prompt'} as a typed one-shot delivery instead of
      // the old setTimeout(sendPtyData) anti-pattern.
      const result = await executeBranchOpenSessionAction({
        repo: { repoPath },
        branch: { name: branchName },
        worktree: { mode: 'create-if-missing' },
        ...(existingWorktreePath ? { existingWorktreePath } : {}),
        ...(branchPrompt
          ? { prompt: { mode: 'initial-prompt', prompt: branchPrompt } }
          : {}),
      });

      if (!result.ok) {
        const conflictSessionId =
          result.error.code === 'SESSION_CONFLICT' &&
          typeof result.error.details?.sessionId === 'string'
            ? result.error.details.sessionId
            : undefined;
        if (conflictSessionId) {
          useUiStore.getState().setActiveRepoPath(repoPath);
          useSessionsStore.getState().setActiveSessionId(conflictSessionId);
          useUiStore.getState().closeSidebar();
          return;
        }
        logger.error('Failed to open branch session:', result.error);
        return;
      }

      const sessionId = sessionIdFromWorkflowData(result.data);
      await useSessionsStore.getState().refreshAll();
      if (sessionId) {
        useSessionsStore.getState().setActiveSessionId(sessionId);
      }
      useUiStore.getState().setActiveRepoPath(repoPath);
      if (sessionId) {
        useSessionsStore
          .getState()
          .initSessionNotification(
            sessionId,
            useConfigStore.getState().defaultNotifications
          );
      }
      useUiStore.getState().closeSidebar();
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
      // Close = kill + tab-selection UI. Route the kill through the shared
      // sessions.kill executor with the resolved owning node, then refresh
      // regardless of outcome. Tab selection below stays synchronous so the UI
      // advances without waiting on the kill.
      void executeSessionKillAction({ id: localSessionId, nodeId: targetNodeId })
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
    handleViewSpineCreateTab,
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
