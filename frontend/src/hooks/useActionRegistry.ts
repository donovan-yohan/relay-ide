import { useEffect } from 'react';
import type React from 'react';
import { registerGlobal } from '../lib/actions/registry.js';
import { leaveChatSurface, openTopicTaskRoom } from '../lib/topic-task-room.js';
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
  sessionCreateTaskRoom,
  sessionCustomize,
  sessionSwitchToTab,
  sessionRename,
  sessionStartWorkInEnv,
} from '../lib/actions/definitions/session.js';
import { sessionHandoffToHub } from '../lib/actions/definitions/handoff.js';
import { createFrameworkAction } from '../lib/actions/definitions/frameworks.js';
import { isFrameworkAvailable } from '../components/dialogs/CustomizeSessionDialog.js';
import {
  workspaceAdd,
  workspaceNewWorktree,
  workspaceLaunch,
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
  settingsCheckUpdates,
  settingsDisconnectGithub,
  settingsSetupWebhooks,
  settingsRemoveWebhook,
  settingsTestWebhook,
  settingsConnectJira,
  settingsDisconnectJira,
  settingsToggleDevTools,
  settingsClearAnalytics,
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
  workspaceOpenFileBrowser,
  workbenchAddFileBlock,
} from '../lib/actions/definitions/workspace-file-rpc.js';
import {
  firstManageableNode,
  firstPendingNodeRequest,
  firstTerminalNode,
  NODE_INSTALL_INSTRUCTIONS,
  NODE_PAIR_COMMAND,
  nodeCommandCenterActions,
  nodeCredentialActionUnavailableReason,
  nodeTerminalUnavailableReason,
  pendingNodeRequestReason,
  type NodeCommandCenterActionKind,
} from '../lib/actions/definitions/node-actions.js';
import {
  navPreviousTab,
  navNextTab,
  navSwitchToTab,
  navOpenFile,
  navNextAttentionWork,
  navOpenWorkCockpit,
  navOpenNodesDashboard,
  navOpenAnalytics,
  navOpenActiveWork,
} from '../lib/actions/definitions/navigation.js';
import { cliGatewayCommandActions } from '../lib/actions/definitions/cli-gateway.js';
import { useSessionsStore } from '../lib/stores/sessions.js';
import { useUiStore, type OrgDashboardTab } from '../lib/stores/ui.js';
import { useConfigStore } from '../lib/stores/config.js';
import { useToastStore } from '../lib/stores/toasts.js';
import {
  approveNodePairingRequest,
  createSession,
  denyNodePairingRequest,
  fetchActiveWork,
  fetchHubNodes,
  fetchNodePairingRequests,
  rotateHubNodeCredential,
  revokeHubNode,
} from '../lib/api.js';
import { executeSessionKillAction } from '../lib/actions/session-lifecycle.js';
import { createLogger } from '../lib/logger.js';
import type { Action, ActionContext } from '../lib/actions/types.js';
import type { Repo } from '../lib/types.js';
import { openAgentChannel } from '../lib/agent-channels.js';
import {
  resolveSessionByKey,
  resolveSessionCloseTarget,
  scopedSessionKey,
} from '../lib/session-keys.js';
import { getActiveTerminalHandle } from '../lib/terminal-refs.js';
import type { CustomizeSessionDialogHandle } from '../components/dialogs/CustomizeSessionDialog.js';
import type { DeleteWorktreeDialogHandle } from '../components/dialogs/DeleteWorktreeDialog.js';
import type { WorkspaceSettingsDialogHandle } from '../components/dialogs/WorkspaceSettingsDialog.js';
import { activeWorkNextAttentionTarget } from '../lib/active-work-control.js';
import { normalizeWorkspaceId } from '../../../shared/workspace.js';

const logger = createLogger('ActionRegistry');

const SECTION_INTEGRATIONS = 'section-integrations' as const;
const SECTION_GENERAL = 'section-general' as const;
const SECTION_ADVANCED = 'section-advanced' as const;
const SECTION_ABOUT = 'section-about' as const;
const SECTION_NODES = 'section-nodes' as const;

export interface UseActionRegistryParams {
  handleQuickAgent: () => void;
  handleQuickTerminal: () => void;
  handleCloseSession: (id: string) => void;
  handleSelectSession: (id: string) => void;
  handleNewWorktree: (workspace: Repo) => void;
  handleLaunchWorkspaceSession: (workspaceId: string) => void;
  handleOpenSettings: (workspace?: Repo) => void;
  handleRenameActiveSession: () => void;
  handleArchive: () => void;
  navigateToDashboard: () => void;
  customizeDialogRef: React.RefObject<CustomizeSessionDialogHandle | null>;
  deleteWorktreeDialogRef: React.RefObject<DeleteWorktreeDialogHandle | null>;
  workspaceSettingsDialogRef: React.RefObject<WorkspaceSettingsDialogHandle | null>;
  setFilePickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

function openSettingsNodes(): void {
  useUiStore
    .getState()
    .setActiveModal({ modal: 'settings', scrollToId: SECTION_NODES });
}

/**
 * #1058/#1287: escape hatch out of the chat spine into the legacy WorkContext
 * cockpit. Every chat-shell surface that outranks `forceOrgCockpit` in
 * `resolveAppViewMode` must be cleared here — an open channel or composer wins
 * over the flag, so leaving one set makes the action a silent no-op that later
 * fires as a surprise navigation when the operator closes the channel.
 */
export function enterWorkCockpit(tab?: OrgDashboardTab): void {
  const ui = useUiStore.getState();
  ui.setAnalyticsView(null);
  leaveChatSurface();
  useSessionsStore.getState().setActiveSessionId(null);
  ui.setActiveRepoPath(null);
  if (tab) ui.setOrgDashboardTab(tab);
  ui.setForceOrgCockpit(true);
}

async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

function notifyNodeActionBlocked(message: string): void {
  useToastStore.getState().showToast(message, 'info');
  openSettingsNodes();
}

function notifyNodeActionFailed(actionLabel: string, error?: unknown): void {
  if (error === undefined) {
    logger.error(`${actionLabel} failed`);
  } else {
    logger.error(`${actionLabel} failed`, error);
  }
  notifyNodeActionBlocked(`${actionLabel} failed`);
}

async function executeNodeActionMutation(
  actionLabel: string,
  operation: () => Promise<unknown>,
  successMessage: string
): Promise<void> {
  try {
    await operation();
  } catch {
    notifyNodeActionFailed(actionLabel);
    return;
  }
  useToastStore.getState().showToast(successMessage, 'info');
  openSettingsNodes();
}

async function executeNodeCommandCenterAction(
  kind: NodeCommandCenterActionKind
): Promise<void> {
  if (kind === 'add-node' || kind === 'show-pending-requests') {
    openSettingsNodes();
    return;
  }
  if (kind === 'copy-pair-command') {
    await copyText(NODE_PAIR_COMMAND);
    useToastStore
      .getState()
      .showToast('copied redaction-safe pair command', 'info');
    openSettingsNodes();
    return;
  }
  if (kind === 'show-install-instructions') {
    await copyText(NODE_INSTALL_INSTRUCTIONS);
    useToastStore
      .getState()
      .showToast('copied redaction-safe install instructions', 'info');
    openSettingsNodes();
    return;
  }

  if (
    kind === 'approve-request' ||
    kind === 'deny-request' ||
    kind === 'edit-access'
  ) {
    let requests;
    try {
      requests = await fetchNodePairingRequests({ includeResolved: true });
    } catch (error) {
      logger.error('Failed to load pending node requests', error);
      notifyNodeActionBlocked('node pairing API unavailable');
      return;
    }
    const reason = pendingNodeRequestReason(requests);
    const request = firstPendingNodeRequest(requests);
    if (reason || !request) {
      notifyNodeActionBlocked(reason ?? 'no pending request');
      return;
    }
    if (kind === 'edit-access') {
      openSettingsNodes();
      return;
    }
    if (kind === 'approve-request') {
      if (
        !window.confirm(
          `Approve node pairing request for ${request.displayName}? Approve only if you recognize this device.`
        )
      )
        return;
      await executeNodeActionMutation(
        'node request approval',
        () => approveNodePairingRequest(request.requestId, {}),
        'node request approved'
      );
      return;
    }
    if (
      !window.confirm(
        `Deny node pairing request for ${request.displayName}? No credential will be issued.`
      )
    )
      return;
    await executeNodeActionMutation(
      'node request denial',
      () =>
        denyNodePairingRequest(request.requestId, 'denied from command center'),
      'node request denied'
    );
    return;
  }

  let nodes;
  try {
    nodes = await fetchHubNodes();
  } catch (error) {
    logger.error('Failed to load nodes for Command Center action', error);
    notifyNodeActionBlocked('nodes API unavailable');
    return;
  }

  if (kind === 'open-terminal') {
    const reason = nodeTerminalUnavailableReason(nodes);
    const node = firstTerminalNode(nodes);
    if (reason || !node) {
      notifyNodeActionBlocked(reason ?? 'unsupported capability');
      return;
    }
    try {
      await createSession({ type: 'terminal', nodeId: node.nodeId });
      await useSessionsStore.getState().refreshAll();
    } catch (error) {
      notifyNodeActionFailed('node terminal creation', error);
    }
    return;
  }

  const reason = nodeCredentialActionUnavailableReason(nodes);
  const node = firstManageableNode(nodes);
  if (reason || !node) {
    notifyNodeActionBlocked(reason ?? 'missing approval');
    return;
  }
  if (kind === 'rotate-credential') {
    if (
      !window.confirm(
        'Rotate this node credential? The old credential remains valid until the node confirms the new one.'
      )
    )
      return;
    await executeNodeActionMutation(
      'node credential rotation',
      () => rotateHubNodeCredential(node.nodeId, 'online'),
      'node credential rotation started'
    );
    return;
  }
  if (kind === 'revoke-node') {
    if (
      !window.confirm(
        'Revoke this node credential? Active links close immediately and reconnect is blocked. Local files on that machine are not deleted. Re-pairing requires operator approval before this node can connect again.'
      )
    )
      return;
    await executeNodeActionMutation(
      'node revoke',
      () => revokeHubNode(node.nodeId),
      'node revoked'
    );
  }
}

export function useActionRegistry(params: UseActionRegistryParams): void {
  const {
    handleQuickAgent,
    handleQuickTerminal,
    handleCloseSession,
    handleSelectSession,
    handleNewWorktree,
    handleLaunchWorkspaceSession,
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

    // #1058: these placeholders exist for keyboard-shortcut/registry
    // completeness (contextual UI elements — sort headers, tab toggles,
    // inline row buttons — already handle the real interaction) but do
    // nothing when invoked from the palette. Selectable-but-inert commands
    // erode trust in the palette, so they're excluded from its visible
    // listing via `when: () => false` (CommandPalette.tsx already filters on
    // `when`) while staying registered for any other registry consumer.
    const noopActions = noopDefs.map((def) => ({
      ...def,
      when: () => false,
      handler: () => {},
    }));

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
            const { sessionId, nodeId } = resolveSessionCloseTarget(
              useSessionsStore.getState().sessions,
              id
            );
            // Route through the shared sessions.kill executor. Resolving the
            // owning node here and passing it in the input keeps the existing
            // owning-node DELETE routing intact via the default api executor.
            const result = await executeSessionKillAction({
              id: sessionId,
              nodeId,
            });
            if (!result.ok) {
              logger.error('Failed to kill session', result.error);
            }
            await useSessionsStore.getState().refreshAll();
          }
        },
      },
      { ...sessionStartOnRepo, handler: () => handleQuickAgent() },
      { ...sessionStartOnTicket, handler: () => navigateToDashboard() },
      {
        // #1058: the composer is the landing view — starting a topic is a
        // navigation, not a sidebar panel.
        ...sessionCreateTaskRoom,
        handler: () => openTopicTaskRoom(),
      },
      {
        // #630: opens the env picker dialog. The dialog itself owns
        // default-selection + block-on-stale + launch wiring; the action's
        // only job is to surface the entry point in the palette.
        ...sessionStartWorkInEnv,
        handler: () =>
          useUiStore.getState().setActiveModal({ modal: 'env-picker' }),
      },
      {
        // #692: fixture-backed dry-run only. Opening this action must never
        // transfer state or start a hub session until #691 execute wiring lands.
        ...sessionHandoffToHub,
        handler: () =>
          useUiStore.getState().setActiveModal({ modal: 'handoff-plan' }),
      },
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
      {
        // Resolve the active IA workspace id and open its agent channel.
        ...workspaceLaunch,
        handler: () => {
          // #1287 slice 2 — id spaces. `activeWorkspaceId` is an IA workspace id
          // (`ws:<localId>`), which is exactly what the channel path
          // (`handleLaunchWorkspaceSession` -> `openAgentChannel`) consumes. The
          // stable `workspaces.launch` gateway verb keys on the SEPARATE
          // `config.workspaces` group-UUID space and is only ever invoked with an
          // explicit id from the CLI/agent surface; browser active state must
          // never be fed into it.
          //
          // `when`/`disabledReason` still gate on ctx.workspacePath (an active
          // repo path), which can diverge from the active lane. That divergence
          // is now benign: a local workspace is always seeded, so normalizing
          // resolves a real id instead of dead-ending on an empty selection.
          const workspaceId = normalizeWorkspaceId(
            useUiStore.getState().activeWorkspaceId
          );
          handleLaunchWorkspaceSession(workspaceId);
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
        ...navNextAttentionWork,
        handler: async () => {
          try {
            const groups = await fetchActiveWork();
            const target = activeWorkNextAttentionTarget(groups);
            if (!target) {
              useToastStore
                .getState()
                .showToast('no actionable active work needs attention', 'info');
              return;
            }

            const sessions = useSessionsStore.getState();
            const ui = useUiStore.getState();
            ui.setAnalyticsView(null);
            ui.setActiveRepoPath(target.activationRepoPath);
            sessions.setActiveSessionId(target.activationKey);
            sessions.handleUserViewed(target.activationKey);
            ui.closeSidebar();
            window.setTimeout(() => getActiveTerminalHandle()?.focusTerm(), 0);
            void sessions.refreshAll().then(() => {
              useUiStore
                .getState()
                .setActiveRepoPath(target.activationRepoPath);
              useSessionsStore
                .getState()
                .setActiveSessionId(target.activationKey);
            });
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            logger.error('Failed to jump to next active work target', error);
            useToastStore
              .getState()
              .showToast(`could not load active work: ${message}`);
          }
        },
      },
      {
        // #1058: the chat/topic spine is the default no-session/no-repo
        // landing; this is the escape hatch back to the legacy WorkContext
        // cockpit (see enterWorkCockpit).
        ...navOpenWorkCockpit,
        handler: () => enterWorkCockpit(),
      },
      {
        // #1058: one-off escape hatch — opens the work cockpit's nodes tab
        // without flipping the persistent advancedMode flag, so the tab
        // strip stays hidden on the next visit unless the user opts in via
        // Settings.
        ...navOpenNodesDashboard,
        handler: () => enterWorkCockpit('nodes'),
      },
      {
        // #1058: one-off escape hatch — opens the work cockpit's active-work
        // tab without flipping the persistent advancedMode flag.
        ...navOpenActiveWork,
        handler: () => enterWorkCockpit('active-work'),
      },
      {
        // #1058: one-off escape hatch — opens the analytics dashboard
        // without flipping the persistent advancedMode flag (mirrors
        // App.tsx's openAnalytics handler for the sidebar icon).
        ...navOpenAnalytics,
        handler: () => {
          const ui = useUiStore.getState();
          ui.setAnalyticsView('dashboard');
          useSessionsStore.getState().setActiveSessionId(null);
          ui.setActiveRepoPath(null);
        },
      },
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

      // ── File-RPC-gated workspace actions (#654) ─────────────────────────────
      // These show greyed-out in the command palette when the active node's
      // relay helper does not support file RPC, with a tooltip naming the
      // missing capability. When the node is healthy, they behave normally.
      {
        ...workspaceOpenFileBrowser,
        handler: () => {
          // TODO(slice-5+): open the FileBrowser panel against the active node.
          // For now a noop — the action is registered so the palette gating
          // machinery can be exercised even before the feature is wired.
        },
      },
      {
        ...workbenchAddFileBlock,
        handler: () => {
          // Noop. The dialog this was meant to open lived in the pre-channel
          // block canvas (`frontend/src/workbench/`), deleted in #1287 slice 0;
          // a channel-era file surface has to claim this action before it does
          // anything. Registered so palette gating stays exercisable meanwhile.
        },
      },

      // ── Node pairing / management ───────────────────────────────────────────
      ...nodeCommandCenterActions.map((def) => ({
        ...def,
        handler: () => executeNodeCommandCenterAction(def.nodeActionKind),
      })),

      // ── Stable CLI gateway projection (#716) ────────────────────────────────
      // These are searchable Command Center descriptions for the public
      // relay-ide v1 ... --json contract. They stay disabled until a future
      // slice wires safe UI execution; agents must keep using the v1 CLI
      // gateway rather than private node-link/browser routes.
      ...cliGatewayCommandActions.map((def) => ({ ...def, handler: () => {} })),

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
          try {
            await openAgentChannel({ providerId: framework.id });
          } catch (error) {
            logger.error(`Failed to open ${framework.id} chat`, error);
            useToastStore
              .getState()
              .showToast(
                error instanceof Error
                  ? error.message
                  : `failed to open ${framework.id} chat`
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
