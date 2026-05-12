import { describe, expect, it } from 'vitest';

import {
  buildEnvironmentPickerModel,
  defaultSessionModeForAgent,
  getSessionModeOptions,
  isFrameworkAvailable,
  isFrameworkWebAvailable,
  selectLaunchAgent,
} from '../frontend/src/components/dialogs/CustomizeSessionDialog.js';
import type { FrameworkInfo } from '../frontend/src/lib/types.js';
import type { AggregatedRepoInventoryResponse } from '../shared/repo-inventory.js';
import type { HubNodeSummary } from '../shared/relay-node-protocol.js';

function framework(id: string, installed = true): FrameworkInfo {
  return {
    id,
    displayName: id,
    command: id,
    capabilities: {
      supportsContinue: true,
      supportsYolo: true,
      supportsHooks: true,
      supportsTelemetry: false,
      supportsWebSessions: ['claude', 'codex', 'opencode', 'hermes'].includes(
        id
      ),
    },
    eventSource: 'hooks',
    availability: installed
      ? { installed: true, path: `/usr/local/bin/${id}` }
      : { installed: false, reason: `${id} CLI not found on PATH` },
  };
}

function node(overrides: Partial<HubNodeSummary> = {}): HubNodeSummary {
  return {
    nodeId: 'local',
    displayName: 'local mac',
    hostname: 'local.local',
    platform: 'darwin',
    arch: 'arm64',
    relayVersion: '0.1.0',
    protocolVersion: '1.0',
    status: 'online',
    connection: { route: 'local', status: 'connected' },
    capabilities: {
      totals: { available: 10, degraded: 0, unavailable: 0, unknown: 0 },
      core: {
        shell: 'available',
        tmux: 'available',
        git: 'available',
        worktrees: 'available',
        browserAutomation: 'available',
        clipboardImage: 'available',
        ssh: 'available',
        tailscale: 'available',
      },
      agents: { claude: 'available', codex: 'available' },
      serviceManager: 'launchd',
      wsl: false,
    },
    createdAt: '2026-05-12T00:00:00.000Z',
    pairedAt: '2026-05-12T00:00:00.000Z',
    lastSeenAt: '2026-05-12T00:00:00.000Z',
    credentialId: 'cred-local',
    ...overrides,
  };
}

function inventory(): AggregatedRepoInventoryResponse {
  return {
    generatedAt: '2026-05-12T00:00:00.000Z',
    reports: [],
    groups: [
      {
        groupId: 'github.com/donovan-yohan/relay-ide',
        repoIdentity: 'github.com/donovan-yohan/relay-ide',
        displayName: 'relay-ide',
        selectedRemote: null,
        remotes: [],
        warnings: [],
        identityDebug: {
          groupedBy: 'repoIdentity',
          repoIdentity: 'github.com/donovan-yohan/relay-ide',
          instanceCount: 2,
          nodeIds: ['local', 'linux'],
        },
        instances: [
          {
            repoInstanceId: 'linux:%2Fsrv%2Frelay-ide',
            nodeId: 'linux',
            localPath: '/srv/relay-ide',
            name: 'relay-ide',
            isGitRepo: true,
            defaultBranch: 'nightly',
            currentBranch: 'nightly',
            repoIdentity: 'github.com/donovan-yohan/relay-ide',
            selectedRemote: null,
            remotes: [],
            repoIdentityWarnings: [],
            worktrees: [
              {
                worktreeInstanceId: 'linux:%2Fsrv%2Frelay-ide%2F.worktrees%2Ffeature',
                localPath: '/srv/relay-ide/.worktrees/feature',
                branchName: 'feature/linux',
                displayName: 'feature',
              },
            ],
            reportedAt: '2026-05-12T00:00:00.000Z',
          },
          {
            repoInstanceId: 'local:%2FUsers%2Fkyle%2Frelay-ide',
            nodeId: 'local',
            localPath: '/Users/kyle/relay-ide',
            name: 'relay-ide',
            isGitRepo: true,
            defaultBranch: 'nightly',
            currentBranch: 'nightly',
            repoIdentity: 'github.com/donovan-yohan/relay-ide',
            selectedRemote: null,
            remotes: [],
            repoIdentityWarnings: [],
            worktrees: [
              {
                worktreeInstanceId: 'local:%2FUsers%2Fkyle%2Frelay-ide%2F.worktrees%2Ffeature',
                localPath: '/Users/kyle/relay-ide/.worktrees/feature',
                branchName: 'feature/local',
                displayName: 'feature',
              },
            ],
            reportedAt: '2026-05-12T00:00:00.000Z',
          },
        ],
      },
      {
        groupId: 'github.com/example/tools',
        repoIdentity: 'github.com/example/tools',
        displayName: 'tools',
        selectedRemote: null,
        remotes: [],
        warnings: [],
        identityDebug: {
          groupedBy: 'repoIdentity',
          repoIdentity: 'github.com/example/tools',
          instanceCount: 1,
          nodeIds: ['local'],
        },
        instances: [
          {
            repoInstanceId: 'local:%2FUsers%2Fkyle%2Ftools',
            nodeId: 'local',
            localPath: '/Users/kyle/tools',
            name: 'tools',
            isGitRepo: true,
            defaultBranch: 'main',
            currentBranch: 'main',
            repoIdentity: 'github.com/example/tools',
            selectedRemote: null,
            remotes: [],
            repoIdentityWarnings: [],
            worktrees: [],
            reportedAt: '2026-05-12T00:00:00.000Z',
          },
        ],
      },
    ],
  };
}

describe('CustomizeSessionDialog session mode options', () => {
  it('shows tui and web for agents with web-session adapters', () => {
    const frameworks = [
      framework('claude'),
      framework('codex'),
      framework('opencode'),
    ];

    expect(getSessionModeOptions(frameworks, 'claude')).toEqual([
      { value: 'pty', label: 'tui' },
      { value: 'web', label: 'web' },
    ]);
  });

  it('shows only tui for agents without web-session adapters', () => {
    expect(getSessionModeOptions([framework('custom')], 'custom')).toEqual([
      { value: 'pty', label: 'tui' },
    ]);
  });

  it('defaults hermes to web and other agents to tui', () => {
    expect(defaultSessionModeForAgent([framework('hermes')], 'hermes')).toBe(
      'web'
    );
    expect(defaultSessionModeForAgent([framework('claude')], 'claude')).toBe(
      'pty'
    );
  });

  it('disables web mode when an installed agent runtime is unavailable', () => {
    const hermes = framework('hermes');
    hermes.webAvailability = {
      available: false,
      reason: 'Hermes API server is not reachable',
    };

    expect(isFrameworkAvailable(hermes)).toBe(true);
    expect(isFrameworkWebAvailable(hermes)).toBe(false);
    expect(getSessionModeOptions([hermes], 'hermes')).toEqual([
      { value: 'pty', label: 'tui' },
      {
        value: 'web',
        label: 'web (unavailable)',
        disabled: true,
        reason: 'Hermes API server is not reachable',
      },
    ]);
    expect(defaultSessionModeForAgent([hermes], 'hermes')).toBe('pty');
  });

  it('treats missing legacy availability as available', () => {
    const legacy = framework('claude');
    delete legacy.availability;

    expect(isFrameworkAvailable(legacy)).toBe(true);
  });

  it('falls back to an installed agent when preferred agent is unavailable', () => {
    const frameworks = [framework('claude', false), framework('codex', true)];

    expect(selectLaunchAgent(frameworks, 'claude')).toBe('codex');
  });
});

describe('CustomizeSessionDialog environment picker model', () => {
  it('keeps single-node local launch low-friction', () => {
    const model = buildEnvironmentPickerModel({
      inventory: null,
      nodes: [],
      selectedAgent: 'claude',
      selectedGroupId: null,
      selectedNodeId: null,
      selectedCheckoutId: null,
      fallbackWorkspace: { name: 'relay-ide', path: '/Users/kyle/relay-ide' },
      fallbackWorktreePath: null,
    });

    expect(model.showPicker).toBe(false);
    expect(model.resolved).toEqual({
      nodeId: 'local',
      repoPath: '/Users/kyle/relay-ide',
      worktreePath: null,
    });
  });

  it('shows a picker reason when the only selected node is disabled', () => {
    const repoInventory = inventory();
    repoInventory.groups = [
      {
        ...repoInventory.groups[0]!,
        identityDebug: {
          ...repoInventory.groups[0]!.identityDebug,
          instanceCount: 1,
          nodeIds: ['local'],
        },
        instances: [
          {
            ...repoInventory.groups[0]!.instances[1]!,
            worktrees: [],
          },
        ],
      },
    ];

    const model = buildEnvironmentPickerModel({
      inventory: repoInventory,
      nodes: [node({ status: 'offline' })],
      selectedAgent: 'claude',
      selectedGroupId: 'github.com/donovan-yohan/relay-ide',
      selectedNodeId: 'local',
      selectedCheckoutId: null,
      fallbackWorkspace: { name: 'relay-ide', path: '/Users/kyle/relay-ide' },
      fallbackWorktreePath: null,
    });

    expect(model.showPicker).toBe(true);
    expect(model.selectedNodeReason).toBe('node is offline');
    expect(model.nodeChoices).toHaveLength(1);
    expect(model.nodeChoices[0]).toMatchObject({
      disabled: true,
      reason: 'node is offline',
    });
  });

  it('orders repo identity before node and checkout choices for multi-node inventory', () => {
    const model = buildEnvironmentPickerModel({
      inventory: inventory(),
      nodes: [node(), node({ nodeId: 'linux', displayName: 'linux lab' })],
      selectedAgent: 'claude',
      selectedGroupId: 'github.com/donovan-yohan/relay-ide',
      selectedNodeId: 'linux',
      selectedCheckoutId: 'worktree:linux:%2Fsrv%2Frelay-ide%2F.worktrees%2Ffeature',
      fallbackWorkspace: { name: 'relay-ide', path: '/Users/kyle/relay-ide' },
      fallbackWorktreePath: null,
    });

    expect(model.showPicker).toBe(true);
    expect(model.repoChoices.map((choice) => choice.label)).toEqual([
      'relay-ide — github.com/donovan-yohan/relay-ide',
      'tools — github.com/example/tools',
    ]);
    expect(model.nodeChoices.map((choice) => choice.label)).toEqual([
      'linux lab',
      'local mac',
    ]);
    expect(model.checkoutChoices.map((choice) => choice.label)).toEqual([
      'default — /srv/relay-ide',
      'feature/linux — /srv/relay-ide/.worktrees/feature',
    ]);
    expect(model.resolved).toEqual({
      nodeId: 'linux',
      repoPath: '/srv/relay-ide',
      worktreePath: '/srv/relay-ide/.worktrees/feature',
    });
  });

  it('disables offline nodes with a clear reason', () => {
    const model = buildEnvironmentPickerModel({
      inventory: inventory(),
      nodes: [
        node(),
        node({ nodeId: 'linux', displayName: 'linux lab', status: 'offline' }),
      ],
      selectedAgent: 'claude',
      selectedGroupId: 'github.com/donovan-yohan/relay-ide',
      selectedNodeId: 'linux',
      selectedCheckoutId: null,
      fallbackWorkspace: { name: 'relay-ide', path: '/Users/kyle/relay-ide' },
      fallbackWorktreePath: null,
    });

    expect(model.nodeChoices.find((choice) => choice.value === 'linux')).toMatchObject({
      disabled: true,
      reason: 'node is offline',
    });
    expect(model.resolved.nodeId).toBe('local');
  });

  it('disables nodes missing the selected agent capability', () => {
    const model = buildEnvironmentPickerModel({
      inventory: inventory(),
      nodes: [
        node(),
        node({
          nodeId: 'linux',
          displayName: 'linux lab',
          capabilities: {
            ...node().capabilities,
            agents: { claude: 'unavailable' },
          },
        }),
      ],
      selectedAgent: 'claude',
      selectedGroupId: 'github.com/donovan-yohan/relay-ide',
      selectedNodeId: 'linux',
      selectedCheckoutId: null,
      fallbackWorkspace: { name: 'relay-ide', path: '/Users/kyle/relay-ide' },
      fallbackWorktreePath: null,
    });

    expect(model.nodeChoices.find((choice) => choice.value === 'linux')).toMatchObject({
      disabled: true,
      reason: 'claude unavailable on linux lab',
    });
    expect(model.resolved.nodeId).toBe('local');
  });

  it('keeps all same-node repo instance checkouts selectable', () => {
    const repoInventory = inventory();
    const relayGroup = repoInventory.groups[0]!;
    relayGroup.instances.push({
      repoInstanceId: 'local:%2FUsers%2Fkyle%2Frelay-ide-copy',
      nodeId: 'local',
      localPath: '/Users/kyle/relay-ide-copy',
      name: 'relay-ide-copy',
      isGitRepo: true,
      defaultBranch: 'nightly',
      currentBranch: 'feature/copy',
      repoIdentity: 'github.com/donovan-yohan/relay-ide',
      selectedRemote: null,
      remotes: [],
      repoIdentityWarnings: [],
      worktrees: [
        {
          worktreeInstanceId:
            'local:%2FUsers%2Fkyle%2Frelay-ide-copy%2F.worktrees%2Fcopy-feature',
          localPath: '/Users/kyle/relay-ide-copy/.worktrees/copy-feature',
          branchName: 'feature/copy-worktree',
          displayName: 'copy-feature',
        },
      ],
      reportedAt: '2026-05-12T00:00:00.000Z',
    });

    const model = buildEnvironmentPickerModel({
      inventory: repoInventory,
      nodes: [node(), node({ nodeId: 'linux', displayName: 'linux lab' })],
      selectedAgent: 'claude',
      selectedGroupId: 'github.com/donovan-yohan/relay-ide',
      selectedNodeId: 'local',
      selectedCheckoutId:
        'worktree:local:%2FUsers%2Fkyle%2Frelay-ide-copy%2F.worktrees%2Fcopy-feature',
      fallbackWorkspace: { name: 'relay-ide', path: '/Users/kyle/relay-ide' },
      fallbackWorktreePath: null,
    });

    expect(model.nodeChoices.filter((choice) => choice.value === 'local')).toHaveLength(1);
    expect(model.checkoutChoices.map((choice) => choice.label)).toEqual([
      'default — /Users/kyle/relay-ide',
      'feature/local — /Users/kyle/relay-ide/.worktrees/feature',
      'default — /Users/kyle/relay-ide-copy',
      'feature/copy-worktree — /Users/kyle/relay-ide-copy/.worktrees/copy-feature',
    ]);
    expect(model.resolved).toEqual({
      nodeId: 'local',
      repoPath: '/Users/kyle/relay-ide-copy',
      worktreePath: '/Users/kyle/relay-ide-copy/.worktrees/copy-feature',
    });
  });

  it.each(['degraded', 'unavailable', 'unknown'] as const)(
    'disables nodes when tmux is %s',
    (tmuxStatus) => {
      const model = buildEnvironmentPickerModel({
        inventory: inventory(),
        nodes: [
          node(),
          node({
            nodeId: 'linux',
            displayName: 'linux lab',
            capabilities: {
              ...node().capabilities,
              core: {
                ...node().capabilities.core,
                tmux: tmuxStatus,
              },
            },
          }),
        ],
        selectedAgent: 'claude',
        selectedGroupId: 'github.com/donovan-yohan/relay-ide',
        selectedNodeId: 'linux',
        selectedCheckoutId: null,
        fallbackWorkspace: { name: 'relay-ide', path: '/Users/kyle/relay-ide' },
        fallbackWorktreePath: null,
      });

      expect(model.nodeChoices.find((choice) => choice.value === 'linux')).toMatchObject({
        disabled: true,
        reason: `tmux ${tmuxStatus} on linux lab`,
      });
      expect(model.resolved.nodeId).toBe('local');
    }
  );
});
