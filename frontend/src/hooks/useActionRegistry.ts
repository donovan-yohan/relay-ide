import { useEffect } from 'react';
import type React from 'react';
import { registerGlobal } from '../lib/actions/registry.js';
import {
  registerContextual,
  unregisterContextual,
} from '../lib/actions/registry.js';
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
} from '../lib/actions/definitions/session.js';
import { createFrameworkAction } from '../lib/actions/definitions/frameworks.js';
import { isFrameworkAvailable } from '../components/dialogs/CustomizeSessionDialog.js';
import {
  workspaceAdd,
  workspaceNewWorktree,
} from '../lib/actions/definitions/workspace.js';
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
} from '../lib/actions/definitions/pr.js';
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
  settingsToggleNotifications,
  settingsChangeDefaultAgent,
} from '../lib/actions/definitions/settings.js';
import {
  sidebarCollapse,
  sidebarNavigateDashboard,
  sidebarWorkspaceSettings,
  sidebarRenameSession,
  sidebarDeleteWorktree,
  sidebarResumeSession,
  sidebarResumeYolo,
} from '../lib/actions/definitions/sidebar.js';
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
} from '../lib/actions/definitions/dashboard.js';
import {
  terminalScrollTop,
  terminalScrollBottom,
} from '../lib/actions/definitions/terminal.js';
import {
  navPreviousTab,
  navNextTab,
  navSwitchToTab,
  navOpenFile,
} from '../lib/actions/definitions/navigation.js';
import { useSessionsStore } from '../lib/stores/sessions.js';
import { useUiStore } from '../lib/stores/ui.js';
import { useConfigStore } from '../lib/stores/config.js';
import { ConflictError, killSession, setDefaultYolo } from '../lib/api.js';
import { createLogger } from '../lib/logger.js';
import type { Action, ActionContext } from '../lib/actions/types.js';
import type { Repo } from '../lib/types.js';
import { createAgentSession } from '../lib/session-utils.js';
import { resolveSessionByKey, scopedSessionKey } from '../lib/session-keys.js';
import { getActiveTerminalHandle } from '../lib/terminal-refs.js';
import type { CustomizeSessionDialogHandle } from '../components/dialogs/CustomizeSessionDialog.js';
import type { DeleteWorktreeDialogHandle } from '../components/dialogs/DeleteWorktreeDialog.js';
import type { WorkspaceSettingsDialogHandle } from '../components/dialogs/WorkspaceSettingsDialog.js';

const logger = createLogger('ActionRegistry');

const SECTION_INTEGRATIONS = 'section-integrations' as const;
const SECTION_GENERAL = 'section-general' as const;
const SECTION_ADVANCED = 'section-advanced' as const;
const SECTION_ABOUT = 'section-about' as const;

export interface UseActionRegistryParams {
  handleQuickAgent: () => void;
  handleQuickTerminal: () => void;
  handleCloseSession: (id: string) => void;
  handleSelectSession: (id: string) => void;
  handleNewWorktree: (workspace: Repo) => void;
  handleOpenSettings: (workspace?: Repo) => void;
  handleRenameActiveSession: () => void;
  handleArchive: () => void;
  navigateToDashboard: () => void;
  customizeDialogRef: React.RefObject<CustomizeSessionDialogHandle | null>;
  deleteWorktreeDialogRef: React.RefObject<DeleteWorktreeDialogHandle | null>;
  workspaceSettingsDialogRef: React.RefObject<WorkspaceSettingsDialogHandle | null>;
  setFilePickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

export function useActionRegistry(params: UseActionRegistryParams): void {
  const {
    handleQuickAgent,
    handleQuickTerminal,
    handleCloseSession,
    handleSelectSession,
    handleNewWorktree,
    handleOpenSettings,
    handleRenameActiveSession,
    navigateToDashboard,
    customizeDialogRef,
    deleteWorktreeDialogRef,
    workspaceSettingsDialogRef,
    setFilePickerOpen,
  } = params;
  const frameworks = useConfigStore((state) => state.frameworks);

  useEffect(() => {
    // ── Settings section openers ─────────────────────────────────────────────
    // Many actions just open a specific settings section.
    const settingsSectionActions = [
      [settingsDisconnectGithub, SECTION_INTEGRATIONS],
      [settingsSetupWebhooks, SECTION_INTEGRATIONS],
      [settingsRemoveWebhook, SECTION_INTEGRATIONS],
      [settingsTestWebhook, SECTION_INTEGRATIONS],
      [settingsConnectJira, SECTION_INTEGRATIONS],
      [settingsDisconnectJira, SECTION_INTEGRATIONS],
      [settingsToggleDevTools, SECTION_ADVANCED],
      [settingsClearAnalytics, SECTION_ADVANCED],
      [settingsToggleContinue, SECTION_GENERAL],
      [settingsToggleNotifications, SECTION_GENERAL],
      [settingsChangeDefaultAgent, SECTION_GENERAL],
    ] as const;

    const settingsActions = settingsSectionActions.map(([def, section]) => ({
      ...def,
      handler: () =>
        useUiStore
          .getState()
          .setActiveModal({ modal: 'settings', scrollToId: section }),
    }));

    // ── Noop placeholders ────────────────────────────────────────────────────
    const noopDefs = [
      dashboardSortPrs,
      dashboardClearFilters,
      orgSwitchTab,
      orgSaveFilter,
      orgDeleteFilter,
      orgTogglePrStatus,
      orgNavigateToWorkspace,
      ticketSwitchProvider,
      ticketOpenExternal,
      sessionSwitchToTab,
      navSwitchToTab,
    ];

    const noopActions = noopDefs.map((def) => ({ ...def, handler: () => {} }));

    registerGlobal([
      // ── Session ─────────────────────────────────────────────────────────────
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
            const session = resolveSessionByKey(
              useSessionsStore.getState().sessions,
              id
            );
            try {
              await killSession(session?.id ?? id, session?.nodeId);
            } catch (err) {
              logger.error('Failed to kill session', err);
            }
            await useSessionsStore.getState().refreshAll();
          }
        },
      },
      { ...sessionStartOnRepo, handler: () => handleQuickAgent() },
      { ...sessionStartOnTicket, handler: () => navigateToDashboard() },
      {
        ...sessionCustomize,
        handler: () => {
          const currentRepoPath = useUiStore.getState().activeRepoPath;
          const ws = currentRepoPath
            ? useSessionsStore
                .getState()
                .repos.find((w) => w.path === currentRepoPath)
            : undefined;
          if (ws)
            customizeDialogRef.current?.open({ name: ws.name, path: ws.path });
        },
      },
      { ...sessionRename, handler: () => handleRenameActiveSession() },

      // ── Workspace ───────────────────────────────────────────────────────────
      {
        ...workspaceAdd,
        handler: () =>
          useUiStore.getState().setActiveModal({ modal: 'add-repo' }),
      },
      {
        ...workspaceNewWorktree,
        handler: () => {
          const currentRepoPath = useUiStore.getState().activeRepoPath;
          const ws = currentRepoPath
            ? useSessionsStore
                .getState()
                .repos.find((w) => w.path === currentRepoPath)
            : undefined;
          if (ws) handleNewWorktree(ws);
        },
      },

      // ── PR ──────────────────────────────────────────────────────────────────
      { ...prCreate, handler: () => navigateToDashboard() },
      { ...prPushBranch, handler: () => navigateToDashboard() },
      { ...prSwitchBranch, handler: () => navigateToDashboard() },
      { ...prFixConflicts, handler: () => navigateToDashboard() },
      { ...prArchiveBranch, handler: () => navigateToDashboard() },
      { ...prRenameBranch, handler: () => navigateToDashboard() },
      {
        ...prCopyBranchName,
        handler: async () => {
          const currentActiveSessionId =
            useSessionsStore.getState().activeSessionId;
          const currentActiveSession = currentActiveSessionId
            ? resolveSessionByKey(
                useSessionsStore.getState().sessions,
                currentActiveSessionId
              )
            : undefined;
          const currentRepoPath = useUiStore.getState().activeRepoPath;
          const allWs = currentRepoPath
            ? useSessionsStore.getState().getSessionsForRepo(currentRepoPath)
            : [];
          const wsSessions = (
            currentActiveSession
              ? allWs.filter((s) => s.cwd === currentActiveSession.cwd)
              : allWs
          ).toSorted(
            (a, b) =>
              new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
          );
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

      // ── Settings ────────────────────────────────────────────────────────────
      { ...settingsOpen, handler: () => handleOpenSettings() },
      {
        ...settingsConnectGithub,
        handler: () =>
          useUiStore.getState().setActiveModal({
            modal: 'settings',
            scrollToId: SECTION_INTEGRATIONS,
          }),
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
        handler: () =>
          useUiStore
            .getState()
            .setActiveModal({ modal: 'settings', scrollToId: SECTION_ABOUT }),
      },
      ...settingsActions,

      // ── Sidebar ─────────────────────────────────────────────────────────────
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
            ? useSessionsStore
                .getState()
                .repos.find((w) => w.path === currentRepoPath)
            : undefined;
          if (ws) workspaceSettingsDialogRef.current?.open(ws.path, ws.name);
        },
      },
      { ...sidebarRenameSession, handler: () => handleRenameActiveSession() },
      {
        ...sidebarDeleteWorktree,
        handler: () => {
          const state = useSessionsStore.getState();
          const currentActiveSession = state.activeSessionId
            ? resolveSessionByKey(state.sessions, state.activeSessionId)
            : undefined;
          const wt = state.worktrees.find(
            (w) => w.path === currentActiveSession?.worktreePath
          );
          if (wt) {
            const hasActiveSessions = state.sessions.some(
              (s) => s.worktreePath === wt.path
            );
            deleteWorktreeDialogRef.current?.open(wt, hasActiveSessions);
          }
        },
      },
      { ...sidebarResumeSession, handler: () => handleQuickAgent() },
      { ...sidebarResumeYolo, handler: () => handleQuickAgent() },

      // ── Dashboard / Org / Ticket ────────────────────────────────────────────
      { ...dashboardOpenPrSession, handler: () => handleQuickAgent() },

      // ── Terminal ─────────────────────────────────────────────────────────────
      {
        ...terminalScrollTop,
        handler: () => getActiveTerminalHandle()?.getTerm()?.scrollToLine(0),
      },
      {
        ...terminalScrollBottom,
        handler: () => getActiveTerminalHandle()?.getTerm()?.scrollToBottom(),
      },

      // ── Navigation ──────────────────────────────────────────────────────────
      {
        ...navPreviousTab,
        handler: () => {
          const currentActiveSessionId =
            useSessionsStore.getState().activeSessionId;
          const currentRepoPath = useUiStore.getState().activeRepoPath;
          const currentActiveSession = currentActiveSessionId
            ? resolveSessionByKey(
                useSessionsStore.getState().sessions,
                currentActiveSessionId
              )
            : undefined;
          const allWs = currentRepoPath
            ? useSessionsStore.getState().getSessionsForRepo(currentRepoPath)
            : [];
          const wsSessions = (
            currentActiveSession
              ? allWs.filter((s) => s.cwd === currentActiveSession.cwd)
              : allWs
          ).toSorted(
            (a, b) =>
              new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
          );
          if (wsSessions.length === 0) return;
          const idx = wsSessions.findIndex(
            (s) => scopedSessionKey(s) === currentActiveSessionId
          );
          const prev =
            idx <= 0 ? wsSessions[wsSessions.length - 1] : wsSessions[idx - 1];
          if (prev) handleSelectSession(scopedSessionKey(prev));
        },
      },
      {
        ...navNextTab,
        handler: () => {
          const currentActiveSessionId =
            useSessionsStore.getState().activeSessionId;
          const currentRepoPath = useUiStore.getState().activeRepoPath;
          const currentActiveSession = currentActiveSessionId
            ? resolveSessionByKey(
                useSessionsStore.getState().sessions,
                currentActiveSessionId
              )
            : undefined;
          const allWs = currentRepoPath
            ? useSessionsStore.getState().getSessionsForRepo(currentRepoPath)
            : [];
          const wsSessions = (
            currentActiveSession
              ? allWs.filter((s) => s.cwd === currentActiveSession.cwd)
              : allWs
          ).toSorted(
            (a, b) =>
              new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
          );
          if (wsSessions.length === 0) return;
          const idx = wsSessions.findIndex(
            (s) => scopedSessionKey(s) === currentActiveSessionId
          );
          const next =
            idx === -1 || idx === wsSessions.length - 1
              ? wsSessions[0]
              : wsSessions[idx + 1];
          if (next) handleSelectSession(scopedSessionKey(next));
        },
      },
      {
        ...navOpenFile,
        handler: () => {
          setFilePickerOpen(true);
        },
      },

      // ── Diff view ────────────────────────────────────────────────────────────
      {
        id: 'workspace.open-branch-divergence' as const,
        label: 'open branch pane',
        description: 'open the branch divergence utility pane',
        category: 'workspace' as const,
        shortcut: { key: 'mod+b' },
        when: (ctx: ActionContext) => ctx.view === 'session',
        handler: () => {
          const currentActiveSessionId =
            useSessionsStore.getState().activeSessionId;
          const currentActiveSession = currentActiveSessionId
            ? resolveSessionByKey(
                useSessionsStore.getState().sessions,
                currentActiveSessionId
              )
            : undefined;
          const ws =
            currentActiveSession?.worktreePath ??
            currentActiveSession?.repoPath ??
            '';
          if (ws) {
            const ui = useUiStore.getState();
            ui.openUtilityRailTab(ws, 'branch');
            useUiStore.setState({ fullPageDiff: null });
          }
        },
      },
      {
        id: 'workspace.open-diff-view' as const,
        label: 'open review pane',
        description: 'open the review utility pane for changed files',
        category: 'workspace' as const,
        shortcut: { key: 'd' },
        when: (ctx: ActionContext) => ctx.view === 'session',
        handler: () => {
          const currentActiveSessionId =
            useSessionsStore.getState().activeSessionId;
          const currentActiveSession = currentActiveSessionId
            ? resolveSessionByKey(
                useSessionsStore.getState().sessions,
                currentActiveSessionId
              )
            : undefined;
          const ws =
            currentActiveSession?.worktreePath ??
            currentActiveSession?.repoPath ??
            '';
          if (ws) {
            const ui = useUiStore.getState();
            ui.openReviewWorkspace(ws);
          }
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

      // ── Noop placeholders ────────────────────────────────────────────────────
      ...noopActions,
    ] satisfies Action[]);
  }, []);

  useEffect(() => {
    const frameworkActions = frameworks
      .filter(isFrameworkAvailable)
      .map((framework) => ({
        ...createFrameworkAction(framework),
        handler: async () => {
          const currentRepoPath = useUiStore.getState().activeRepoPath;
          const state = useSessionsStore.getState();
          const workspace = currentRepoPath
            ? state.repos.find((repo) => repo.path === currentRepoPath)
            : undefined;
          const activeSession = state.activeSessionId
            ? resolveSessionByKey(state.sessions, state.activeSessionId)
            : undefined;

          if (!workspace) return;

          const { session, error } = await createAgentSession({
            repoPath: workspace.path,
            worktreePath: activeSession?.worktreePath ?? null,
            type: 'agent',
            agent: framework.id,
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
            logger.error(`Failed to create ${framework.id} session`, error);
            customizeDialogRef.current?.open(
              { name: workspace.name, path: workspace.path },
              activeSession?.worktreePath ?? null,
              framework.id
            );
          }
        },
      }));

    if (frameworkActions.length === 0) return;

    registerContextual(frameworkActions);

    return () => {
      unregisterContextual(frameworkActions.map((action) => action.id));
    };
  }, [customizeDialogRef, frameworks]);
}
