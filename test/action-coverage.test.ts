import { describe, it, beforeEach, expect } from 'vitest';
import {
  registerGlobal,
  getAllActions,
  _resetForTesting,
} from '../frontend/src/lib/actions/registry.js';
import type { Action, ActionMeta } from '../frontend/src/lib/actions/types.js';
import {
  sessionActions,
  sessionStartOnTicket,
} from '../frontend/src/lib/actions/definitions/session.js';
import { workspaceActions } from '../frontend/src/lib/actions/definitions/workspace.js';
import {
  prActions,
  prFixConflicts,
  prSwitchBranch,
  prCopyBranchName,
  prOpenExternal,
} from '../frontend/src/lib/actions/definitions/pr.js';
import { settingsActions } from '../frontend/src/lib/actions/definitions/settings.js';
import { sidebarActions } from '../frontend/src/lib/actions/definitions/sidebar.js';
import {
  dashboardActions,
  dashboardOpenPrSession,
} from '../frontend/src/lib/actions/definitions/dashboard.js';
import {
  terminalActions,
  terminalScrollTop,
} from '../frontend/src/lib/actions/definitions/terminal.js';
import { navigationActions } from '../frontend/src/lib/actions/definitions/navigation.js';
import { cliGatewayCommandActions } from '../frontend/src/lib/actions/definitions/cli-gateway.js';
import { workspaceOpenFileBrowser } from '../frontend/src/lib/actions/definitions/workspace-file-rpc.js';
import { actionDescriptorFromMeta } from '../frontend/src/lib/actions/descriptors.js';
import { stableCommandNames } from '../shared/cli-gateway-contract.js';

// Full allowlist: 62 palettable action IDs (15 Phase 2 + 44 Phase 3 + 1 from #630
// + workspace.launch from #870 + next-attention WorkContext jump from #933)
const ACTION_ALLOWLIST = [
  // Session (10)
  'session.new-agent',
  'session.new-terminal',
  'session.close-active',
  'session.kill',
  'session.start-on-repo',
  'session.start-on-ticket',
  'session.start-work-in-env',
  'session.customize',
  'session.switch-to-tab',
  'session.rename',
  // Workspace (3)
  'workspace.add',
  'workspace.new-worktree',
  'workspace.launch',
  // PR (11)
  'pr.create',
  'pr.push-branch',
  'pr.switch-branch',
  'pr.fix-conflicts',
  'pr.archive-branch',
  'pr.rename-branch',
  'pr.copy-branch-name',
  'pr.open-external',
  'pr.refresh',
  'pr.change-target',
  'pr.skip-checks',
  // Settings (15)
  'settings.open',
  'settings.connect-github',
  'settings.toggle-yolo',
  'settings.check-updates',
  'settings.disconnect-github',
  'settings.setup-webhooks',
  'settings.remove-webhook',
  'settings.test-webhook',
  'settings.connect-jira',
  'settings.disconnect-jira',
  'settings.toggle-devtools',
  'settings.clear-analytics',
  'settings.toggle-continue',
  'settings.toggle-notifications',
  'settings.change-default-agent',
  // Sidebar (7)
  'sidebar.collapse',
  'sidebar.navigate-dashboard',
  'sidebar.workspace-settings',
  'sidebar.rename-session',
  'sidebar.delete-worktree',
  'sidebar.resume-session',
  'sidebar.resume-yolo',
  // Dashboard (3)
  'dashboard.open-pr-session',
  'dashboard.sort-prs',
  'dashboard.clear-filters',
  // Org (5)
  'org.switch-tab',
  'org.save-filter',
  'org.delete-filter',
  'org.toggle-pr-status',
  'org.navigate-to-workspace',
  // Ticket (2)
  'ticket.switch-provider',
  'ticket.open-external',
  // Terminal (2)
  'terminal.scroll-top',
  'terminal.scroll-bottom',
  // Navigation (5)
  'navigation.previous-tab',
  'navigation.next-tab',
  'navigation.switch-to-tab',
  'navigation.open-file',
  'navigation.next-attention-work',
] as const;

const ALL_META: ActionMeta[] = [
  ...sessionActions,
  ...workspaceActions,
  ...prActions,
  ...settingsActions,
  ...sidebarActions,
  ...dashboardActions,
  ...terminalActions,
  ...navigationActions,
];

function toAction(meta: ActionMeta): Action {
  return { ...meta, handler: () => {} };
}

describe('Action Coverage', () => {
  beforeEach(() => {
    _resetForTesting();
  });

  it('all allowlist IDs have corresponding definitions', () => {
    const definedIds = new Set(ALL_META.map((a) => a.id));
    const missing = ACTION_ALLOWLIST.filter((id) => !definedIds.has(id));
    expect(missing).toEqual([]);
  });

  it('all defined actions are in the allowlist', () => {
    const allowedIds = new Set<string>(ACTION_ALLOWLIST);
    const extra = ALL_META.filter((a) => !allowedIds.has(a.id)).map(
      (a) => a.id
    );
    expect(extra).toEqual([]);
  });

  it('all registered action IDs are unique', () => {
    registerGlobal(ALL_META.map(toAction));
    const all = getAllActions();
    const ids = all.map((a: Action) => a.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(dupes).toEqual([]);
  });

  it('all required Action fields are present and well-formed', () => {
    for (const meta of ALL_META) {
      expect(meta.id).toBeTruthy();
      expect(meta.id).toContain('.');
      expect(meta.label).toBeTruthy();
      expect(meta.category).toBeTruthy();
      expect(meta.label).toBe(meta.label.toLowerCase());
    }
  });

  it('projects stable CLI gateway commands into disabled Command Center metadata', () => {
    expect(cliGatewayCommandActions.map((action) => action.relayCommand.name)).toEqual(
      stableCommandNames()
    );
    expect(cliGatewayCommandActions.map((action) => action.id)).toEqual(
      stableCommandNames().map((name) => `gateway.${name}`)
    );

    for (const action of cliGatewayCommandActions) {
      expect(action.category).toBe('gateway');
      expect(action.label).toBe(action.label.toLowerCase());
      expect(action.description).toBe(action.relayCommand.summary);
      expect(action.aliases).toEqual(
        expect.arrayContaining([action.relayCommand.name, action.relayCommand.sideEffect])
      );
      expect(action.when?.({ view: 'workspace' })).toBe(false);
      expect(action.disabledReason?.({ view: 'workspace' })).toContain('relay-ide v1');
      expect(action.descriptor.contract?.source).toBe(
        'shared/relay-command-manifest.ts'
      );
    }
  });

  it('bridges sessions.create as a stable Relay action descriptor', () => {
    const action = cliGatewayCommandActions.find(
      (entry) => entry.relayCommand.name === 'sessions.create'
    );
    expect(action).toBeTruthy();
    const descriptor = action!.descriptor;

    expect(action!.id).toBe('gateway.sessions.create');
    expect(descriptor.id).toBe('sessions.create');
    expect(descriptor.stable).toBe(true);
    expect(descriptor.source).toBe('cli-gateway-v1');
    expect(descriptor.input.kind).toBe('json-schema');
    expect(descriptor.result.kind).toBe('json-schema');
    expect(descriptor.error.kind).toBe('typed-shape');
    expect(descriptor.sideEffect).toBe('write');
    expect(descriptor.confirmation.required).toBe(false);
    expect(descriptor.surfaces).toEqual(
      expect.arrayContaining(['cli', 'agent', 'web', 'command-center'])
    );
    expect(descriptor.availability).toMatchObject({
      state: 'unavailable',
      reason: expect.stringContaining('Command Center execution is not wired yet'),
    });
    expect(descriptor.contract).toMatchObject({
      relayCommandName: 'sessions.create',
      stable: true,
      source: 'shared/relay-command-manifest.ts',
    });
  });

  it('bridges sessions.kill as a destructive, confirmation-gated Relay action descriptor', () => {
    const action = cliGatewayCommandActions.find(
      (entry) => entry.relayCommand.name === 'sessions.kill'
    );
    expect(action).toBeTruthy();
    const descriptor = action!.descriptor;

    expect(descriptor.id).toBe('sessions.kill');
    expect(descriptor.stable).toBe(true);
    expect(descriptor.sideEffect).toBe('destructive');
    expect(descriptor.confirmation.required).toBe(true);
    expect(descriptor.contract).toMatchObject({
      relayCommandName: 'sessions.kill',
      stable: true,
      source: 'shared/relay-command-manifest.ts',
    });
  });

  it('bridges sessions.rename as a non-destructive write Relay action descriptor', () => {
    const action = cliGatewayCommandActions.find(
      (entry) => entry.relayCommand.name === 'sessions.rename'
    );
    expect(action).toBeTruthy();
    const descriptor = action!.descriptor;

    expect(descriptor.id).toBe('sessions.rename');
    expect(descriptor.stable).toBe(true);
    expect(descriptor.sideEffect).toBe('write');
    expect(descriptor.confirmation.required).toBe(false);
    expect(descriptor.contract).toMatchObject({
      relayCommandName: 'sessions.rename',
      stable: true,
      source: 'shared/relay-command-manifest.ts',
    });
  });

  it('bridges worktrees.delete as a destructive, confirmation-gated Relay action descriptor', () => {
    const action = cliGatewayCommandActions.find(
      (entry) => entry.relayCommand.name === 'worktrees.delete'
    );
    expect(action).toBeTruthy();
    const descriptor = action!.descriptor;

    expect(descriptor.id).toBe('worktrees.delete');
    expect(descriptor.stable).toBe(true);
    expect(descriptor.sideEffect).toBe('destructive');
    expect(descriptor.confirmation.required).toBe(true);
    expect(descriptor.contract).toMatchObject({
      relayCommandName: 'worktrees.delete',
      stable: true,
      source: 'shared/relay-command-manifest.ts',
    });
  });

  it('bridges worktrees.archive as a destructive, confirmation-gated Relay action descriptor', () => {
    const action = cliGatewayCommandActions.find(
      (entry) => entry.relayCommand.name === 'worktrees.archive'
    );
    expect(action).toBeTruthy();
    const descriptor = action!.descriptor;

    expect(descriptor.id).toBe('worktrees.archive');
    expect(descriptor.stable).toBe(true);
    expect(descriptor.sideEffect).toBe('destructive');
    expect(descriptor.confirmation.required).toBe(true);
    expect(descriptor.contract).toMatchObject({
      relayCommandName: 'worktrees.archive',
      stable: true,
      source: 'shared/relay-command-manifest.ts',
    });
  });

  it('bridges worktrees.create as a non-destructive write Relay action descriptor', () => {
    const action = cliGatewayCommandActions.find(
      (entry) => entry.relayCommand.name === 'worktrees.create'
    );
    expect(action).toBeTruthy();
    const descriptor = action!.descriptor;

    expect(descriptor.id).toBe('worktrees.create');
    expect(descriptor.stable).toBe(true);
    expect(descriptor.sideEffect).toBe('write');
    expect(descriptor.confirmation.required).toBe(false);
    expect(descriptor.contract).toMatchObject({
      relayCommandName: 'worktrees.create',
      stable: true,
      source: 'shared/relay-command-manifest.ts',
    });
  });

  it('bridges workspaces.launch as a non-destructive write Relay action descriptor', () => {
    const action = cliGatewayCommandActions.find(
      (entry) => entry.relayCommand.name === 'workspaces.launch'
    );
    expect(action).toBeTruthy();
    const descriptor = action!.descriptor;

    expect(descriptor.id).toBe('workspaces.launch');
    expect(descriptor.stable).toBe(true);
    expect(descriptor.sideEffect).toBe('write');
    expect(descriptor.confirmation.required).toBe(false);
    expect(descriptor.contract).toMatchObject({
      relayCommandName: 'workspaces.launch',
      stable: true,
      source: 'shared/relay-command-manifest.ts',
    });
  });

  it('bridges tickets.startWork as a non-destructive write Relay action descriptor', () => {
    const action = cliGatewayCommandActions.find(
      (entry) => entry.relayCommand.name === 'tickets.startWork'
    );
    expect(action).toBeTruthy();
    const descriptor = action!.descriptor;

    expect(descriptor.id).toBe('tickets.startWork');
    expect(descriptor.stable).toBe(true);
    expect(descriptor.sideEffect).toBe('write');
    expect(descriptor.confirmation.required).toBe(false);
    expect(descriptor.contract).toMatchObject({
      relayCommandName: 'tickets.startWork',
      stable: true,
      source: 'shared/relay-command-manifest.ts',
    });
  });

  it('bridges branches.openSession as a non-destructive write Relay action descriptor', () => {
    const action = cliGatewayCommandActions.find(
      (entry) => entry.relayCommand.name === 'branches.openSession'
    );
    expect(action).toBeTruthy();
    const descriptor = action!.descriptor;

    expect(descriptor.id).toBe('branches.openSession');
    expect(descriptor.stable).toBe(true);
    expect(descriptor.sideEffect).toBe('write');
    expect(descriptor.confirmation.required).toBe(false);
    expect(descriptor.contract).toMatchObject({
      relayCommandName: 'branches.openSession',
      stable: true,
      source: 'shared/relay-command-manifest.ts',
    });
  });

  it('attaches start-work descriptors to the ticket/PR/dashboard entry points (#871/#876)', () => {
    // session.start-on-ticket (StartWorkModal) bridges to tickets.startWork.
    expect(sessionStartOnTicket.descriptor?.id).toBe('tickets.startWork');
    expect(sessionStartOnTicket.descriptor?.contract?.relayCommandName).toBe(
      'tickets.startWork'
    );

    // pr.fix-conflicts and pr.switch-branch open a session on a PR/branch
    // target through branches.openSession.
    expect(prFixConflicts.descriptor?.id).toBe('branches.openSession');
    expect(prFixConflicts.descriptor?.contract?.relayCommandName).toBe(
      'branches.openSession'
    );
    expect(prSwitchBranch.descriptor?.id).toBe('branches.openSession');
    expect(prSwitchBranch.descriptor?.contract?.relayCommandName).toBe(
      'branches.openSession'
    );

    // dashboard.open-pr-session also bridges to branches.openSession.
    expect(dashboardOpenPrSession.descriptor?.id).toBe('branches.openSession');
    expect(dashboardOpenPrSession.descriptor?.contract?.relayCommandName).toBe(
      'branches.openSession'
    );

    // UI-only exceptions stay descriptor-free.
    expect(prCopyBranchName.descriptor).toBeUndefined();
    expect(prOpenExternal.descriptor).toBeUndefined();
  });

  it('projects UI-only actions without promoting them to stable Relay commands', () => {
    const descriptor = actionDescriptorFromMeta(terminalScrollTop, {
      view: 'session',
      sessionId: 'session-1',
    });

    expect(descriptor).toMatchObject({
      id: 'terminal.scroll-top',
      stable: false,
      source: 'ui-action-registry',
      sideEffect: 'ui',
      availability: { state: 'available' },
    });
    expect(descriptor.contract).toBeUndefined();
    expect(descriptor.surfaces).toEqual(
      expect.arrayContaining(['web', 'command-center'])
    );
  });

  it('projects action availability reasons from contextual UI gates', () => {
    const descriptor = actionDescriptorFromMeta(workspaceOpenFileBrowser, {
      view: 'workspace',
      workspacePath: '/repo',
      activeNodeFileRpcAvailable: false,
    });

    expect(descriptor.availability).toEqual({
      state: 'unavailable',
      reason: 'file rpc unavailable on this node — check the node helper status',
    });
  });

  it('does not evaluate disabled reasons for actions that pass contextual gates', () => {
    let disabledReasonCalls = 0;
    const descriptor = actionDescriptorFromMeta(
      {
        id: 'workspace.enabled-test',
        label: 'enabled test action',
        category: 'workspace',
        when: () => true,
        disabledReason: () => {
          disabledReasonCalls += 1;
          return 'should not be projected while enabled';
        },
      },
      { view: 'workspace', workspacePath: '/repo' }
    );

    expect(disabledReasonCalls).toBe(0);
    expect(descriptor.availability).toEqual({ state: 'available' });
  });

  it('no conflicting keyboard shortcuts', () => {
    const shortcuts = ALL_META.filter((a: ActionMeta) => a.shortcut).map(
      (a: ActionMeta) => ({ id: a.id, key: a.shortcut!.key })
    );
    const seen = new Map<string, string>();
    for (const { id, key } of shortcuts) {
      if (seen.has(key)) {
        throw new Error(
          `Shortcut conflict: "${key}" claimed by both "${seen.get(key)}" and "${id}"`
        );
      }
      seen.set(key, id);
    }
  });
});
