import { describe, expect, it } from 'vitest';

import {
  buildEnvironmentPickerModel,
  isFrameworkAvailable,
  nodeShellBlockReason,
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
    identity: {
      nodeId: 'local',
      displayName: 'local mac',
      hostname: 'local.local',
      createdAt: '2026-05-12T00:00:00.000Z',
      pairedAt: '2026-05-12T00:00:00.000Z',
    },
    displayName: 'local mac',
    hostname: 'local.local',
    platform: 'darwin',
    arch: 'arm64',
    relayVersion: '0.1.0',
    protocolVersion: '1.0',
    status: 'online',
    connection: { route: 'local', status: 'connected' },
    trust: { state: 'active', level: 'standard' },
    credentialState: 'active',
    credential: {
      credentialId: 'cred-local',
      issuedAt: '2026-05-12T00:00:00.000Z',
      state: 'active',
      keyBound: false,
    },
    version: {
      state: 'compatible',
      nodeProtocolVersion: '1.0',
      hubProtocolVersion: '1.0',
    },
    capabilities: {
      totals: { available: 10, degraded: 0, unavailable: 0, unknown: 0 },
      core: {
        shell: 'available',
        // TODO(#1498): `tmux` is no longer a HubNodeCoreCapability.
        git: 'available',
        browserAutomation: 'available',
        clipboardImage: 'available',
        ssh: 'available',
        tailscale: 'available',
      },
      agents: { claude: 'available', codex: 'available' },
      terminalBackends: { 'relay-pty': 'available' },
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
                worktreeInstanceId:
                  'linux:%2Fsrv%2Frelay-ide%2F.worktrees%2Ffeature',
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
                worktreeInstanceId:
                  'local:%2FUsers%2Fkyle%2Frelay-ide%2F.worktrees%2Ffeature',
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

describe('CustomizeSessionDialog agent availability', () => {
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
      selectedGroupId: 'github.com/donovan-yohan/relay-ide',
      selectedNodeId: 'linux',
      selectedCheckoutId:
        'worktree:linux:%2Fsrv%2Frelay-ide%2F.worktrees%2Ffeature',
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
      selectedGroupId: 'github.com/donovan-yohan/relay-ide',
      selectedNodeId: 'linux',
      selectedCheckoutId: null,
      fallbackWorkspace: { name: 'relay-ide', path: '/Users/kyle/relay-ide' },
      fallbackWorktreePath: null,
    });

    expect(
      model.nodeChoices.find((choice) => choice.value === 'linux')
    ).toMatchObject({
      disabled: true,
      reason: 'node is offline',
    });
    expect(model.resolved.nodeId).toBe('local');
  });

  it('does not gate terminal nodes on provider availability', () => {
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
      selectedGroupId: 'github.com/donovan-yohan/relay-ide',
      selectedNodeId: 'linux',
      selectedCheckoutId: null,
      fallbackWorkspace: { name: 'relay-ide', path: '/Users/kyle/relay-ide' },
      fallbackWorktreePath: null,
    });

    expect(
      model.nodeChoices.find((choice) => choice.value === 'linux')
    ).toMatchObject({ value: 'linux', label: 'linux lab' });
    expect(model.resolved.nodeId).toBe('linux');
  });

  it('includes a paired node without repo inventory as a remote target', () => {
    const repoInventory = inventory();
    repoInventory.groups = [
      {
        ...repoInventory.groups[1]!,
        instances: [repoInventory.groups[1]!.instances[0]!],
      },
    ];

    const model = buildEnvironmentPickerModel({
      inventory: repoInventory,
      nodes: [
        node(),
        node({ nodeId: 'remote-free', displayName: 'remote free' }),
      ],
      selectedGroupId: 'github.com/example/tools',
      selectedNodeId: 'remote-free',
      selectedCheckoutId: null,
      fallbackWorkspace: { name: 'tools', path: '/Users/kyle/tools' },
      fallbackWorktreePath: null,
    });

    expect(model.nodeChoices.map((choice) => choice.value)).toContain(
      'remote-free'
    );
    expect(model.selectedNodeId).toBe('remote-free');
    expect(model.selectedNodeReason).toBeNull();
    expect(model.resolved).toEqual({
      nodeId: 'remote-free',
      repoPath: '',
      worktreePath: null,
    });
  });

  it('keeps a single remote-only inventory on the remote cwd lane', () => {
    const repoInventory = inventory();
    repoInventory.groups = [
      {
        ...repoInventory.groups[0]!,
        identityDebug: {
          ...repoInventory.groups[0]!.identityDebug,
          instanceCount: 1,
          nodeIds: ['linux'],
        },
        instances: [repoInventory.groups[0]!.instances[0]!],
      },
    ];

    const model = buildEnvironmentPickerModel({
      inventory: repoInventory,
      nodes: [node({ nodeId: 'linux', displayName: 'linux lab' })],
      selectedGroupId: 'github.com/donovan-yohan/relay-ide',
      selectedNodeId: null,
      selectedCheckoutId: null,
      fallbackWorkspace: { name: 'relay-ide', path: '/Users/kyle/relay-ide' },
      fallbackWorktreePath: null,
    });

    expect(model.selectedNodeId).toBe('linux');
    expect(model.selectedNodeReason).toBeNull();
    expect(model.resolved.nodeId).toBe('linux');
  });

  it('keeps an explicitly selected blocked remote node blocked when no enabled target exists', () => {
    const repoInventory = inventory();
    repoInventory.groups = [
      {
        ...repoInventory.groups[0]!,
        identityDebug: {
          ...repoInventory.groups[0]!.identityDebug,
          instanceCount: 1,
          nodeIds: ['linux'],
        },
        instances: [repoInventory.groups[0]!.instances[0]!],
      },
    ];

    const model = buildEnvironmentPickerModel({
      inventory: repoInventory,
      nodes: [
        node({ nodeId: 'linux', displayName: 'linux lab', status: 'offline' }),
      ],
      selectedGroupId: 'github.com/donovan-yohan/relay-ide',
      selectedNodeId: 'linux',
      selectedCheckoutId: null,
      fallbackWorkspace: { name: 'relay-ide', path: '/Users/kyle/relay-ide' },
      fallbackWorktreePath: null,
    });

    expect(model.selectedNodeId).toBe('linux');
    expect(model.selectedNodeReason).toBe('node is offline');
    expect(model.resolved.nodeId).toBe('linux');
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
      selectedGroupId: 'github.com/donovan-yohan/relay-ide',
      selectedNodeId: 'local',
      selectedCheckoutId:
        'worktree:local:%2FUsers%2Fkyle%2Frelay-ide-copy%2F.worktrees%2Fcopy-feature',
      fallbackWorkspace: { name: 'relay-ide', path: '/Users/kyle/relay-ide' },
      fallbackWorktreePath: null,
    });

    expect(
      model.nodeChoices.filter((choice) => choice.value === 'local')
    ).toHaveLength(1);
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
    'disables nodes when relay-pty backend status is %s',
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
              terminalBackends: { 'relay-pty': tmuxStatus },
            },
          }),
        ],
        selectedGroupId: 'github.com/donovan-yohan/relay-ide',
        selectedNodeId: 'linux',
        selectedCheckoutId: null,
        fallbackWorkspace: { name: 'relay-ide', path: '/Users/kyle/relay-ide' },
        fallbackWorktreePath: null,
      });

      expect(
        model.nodeChoices.find((choice) => choice.value === 'linux')
      ).toMatchObject({
        disabled: true,
        reason: `terminal backend unavailable on linux lab (relay-pty ${tmuxStatus})`,
      });
      expect(model.resolved.nodeId).toBe('local');
    }
  );
});

describe('terminal vs agent node eligibility', () => {
  function remoteNode(overrides: Partial<HubNodeSummary> = {}): HubNodeSummary {
    return node({
      nodeId: 'remote',
      displayName: 'remote server',
      capabilities: {
        ...node().capabilities,
        agents: {},
      },
      ...overrides,
    });
  }

  it('nodeShellBlockReason ignores provider availability when terminal capabilities are available', () => {
    const hermesMissingNode = remoteNode();

    expect(nodeShellBlockReason(hermesMissingNode)).toBeNull();
  });

  it('buildEnvironmentPickerModel enables node in terminal mode when agent is missing but shell plus terminal backend are available', () => {
    const hermesMissingNode = remoteNode();
    const repoInventory = inventory();
    repoInventory.groups = [
      {
        ...repoInventory.groups[0]!,
        identityDebug: {
          ...repoInventory.groups[0]!.identityDebug,
          instanceCount: 2,
          nodeIds: ['local', 'remote'],
        },
        instances: [
          { ...repoInventory.groups[0]!.instances[1]!, worktrees: [] },
          {
            repoInstanceId: 'remote:%2Fsrv%2Frelay-ide',
            nodeId: 'remote',
            localPath: '/srv/relay-ide',
            name: 'relay-ide',
            isGitRepo: true,
            defaultBranch: 'nightly',
            currentBranch: 'nightly',
            repoIdentity: 'github.com/donovan-yohan/relay-ide',
            selectedRemote: null,
            remotes: [],
            repoIdentityWarnings: [],
            worktrees: [],
            reportedAt: '2026-05-12T00:00:00.000Z',
          },
        ],
      },
    ];

    const terminalModel = buildEnvironmentPickerModel({
      inventory: repoInventory,
      nodes: [node(), hermesMissingNode],
      selectedGroupId: 'github.com/donovan-yohan/relay-ide',
      selectedNodeId: 'remote',
      selectedCheckoutId: null,
      fallbackWorkspace: { name: 'relay-ide', path: '/Users/kyle/relay-ide' },
      fallbackWorktreePath: null,
    });

    const terminalRemoteChoice = terminalModel.nodeChoices.find(
      (c) => c.value === 'remote'
    );
    expect(terminalRemoteChoice?.disabled).toBeUndefined();
    expect(terminalRemoteChoice?.reason).toBeUndefined();
  });

  it('keeps node enabled when relay-pty is available', () => {
    const tmuxDegradedNode = remoteNode({
      capabilities: {
        ...remoteNode().capabilities,
        terminalBackends: {
          'relay-pty': 'available',
        },
      },
    });

    expect(nodeShellBlockReason(tmuxDegradedNode)).toBeNull();
  });

  it('disables node when no terminal backend is available', () => {
    const noBackendNode = remoteNode({
      capabilities: {
        ...remoteNode().capabilities,
        terminalBackends: {
          'relay-pty': 'unavailable',
        },
      },
    });

    expect(nodeShellBlockReason(noBackendNode)).toBe(
      'terminal backend unavailable on remote server (relay-pty unavailable)'
    );
  });

  it('disables node when node is offline', () => {
    const offlineNode = remoteNode({ status: 'offline' });

    expect(nodeShellBlockReason(offlineNode)).toBe('node is offline');
  });

  it('blocks a version-skew terminal node', () => {
    const skewNode = remoteNode({
      version: {
        state: 'version-skew',
        nodeProtocolVersion: '1.1',
        hubProtocolVersion: '1.0',
      },
    });

    expect(nodeShellBlockReason(skewNode)).toBe('node has version skew');
  });

  it('blocks an incompatible terminal node', () => {
    const incompatNode = remoteNode({
      version: {
        state: 'incompatible',
        nodeProtocolVersion: '2.0',
        hubProtocolVersion: '1.0',
      },
    });

    expect(nodeShellBlockReason(incompatNode)).toBe(
      'node protocol is incompatible'
    );
  });
});

describe('directory-kind workspace support', () => {
  it('fallback group for non-git workspace has isGitRepo: false and no worktrees', () => {
    const model = buildEnvironmentPickerModel({
      inventory: null,
      nodes: [],
      selectedGroupId: null,
      selectedNodeId: null,
      selectedCheckoutId: null,
      fallbackWorkspace: {
        name: 'my-project',
        path: '/home/user/my-project',
        isGitRepo: false,
      },
      fallbackWorktreePath: null,
    });

    expect(model.showPicker).toBe(false);
    // The group's single instance should reflect isGitRepo: false
    const groups = model.repoChoices;
    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toContain('non-git directory');
  });

  it('repoChoices labels include "non-git directory" for directory-kind workspace', () => {
    const model = buildEnvironmentPickerModel({
      inventory: null,
      nodes: [],
      selectedGroupId: null,
      selectedNodeId: null,
      selectedCheckoutId: null,
      fallbackWorkspace: {
        name: 'scripts',
        path: '/home/user/scripts',
        isGitRepo: false,
      },
      fallbackWorktreePath: null,
    });

    expect(model.repoChoices[0]?.label).toBe('scripts — non-git directory');
  });

  it('repoChoices labels show "unidentified repo" for git workspace without identity', () => {
    const model = buildEnvironmentPickerModel({
      inventory: null,
      nodes: [],
      selectedGroupId: null,
      selectedNodeId: null,
      selectedCheckoutId: null,
      fallbackWorkspace: {
        name: 'relay-ide',
        path: '/Users/kyle/relay-ide',
        isGitRepo: true,
      },
      fallbackWorktreePath: null,
    });

    expect(model.repoChoices[0]?.label).toBe('relay-ide — unidentified repo');
  });

  it('synthetic fallback row for git workspace without isGitRepo field defaults to "unidentified repo"', () => {
    // Backward-compat: callers that don't pass isGitRepo should get old behavior
    const model = buildEnvironmentPickerModel({
      inventory: null,
      nodes: [],
      selectedGroupId: null,
      selectedNodeId: null,
      selectedCheckoutId: null,
      fallbackWorkspace: { name: 'relay-ide', path: '/Users/kyle/relay-ide' },
      fallbackWorktreePath: null,
    });

    expect(model.repoChoices[0]?.label).toBe('relay-ide — unidentified repo');
  });
});

describe('agent/terminal mode toggle', () => {
  it('terminal mode does not block nodes missing agent capability (buildEnvironmentPickerModel)', () => {
    const repoInventory = inventory();
    const noAgentNode = node({
      nodeId: 'no-agent',
      displayName: 'no-agent server',
      capabilities: {
        ...node().capabilities,
        agents: {},
      },
    });
    repoInventory.groups = [
      {
        ...repoInventory.groups[0]!,
        identityDebug: {
          ...repoInventory.groups[0]!.identityDebug,
          instanceCount: 2,
          nodeIds: ['local', 'no-agent'],
        },
        instances: [
          { ...repoInventory.groups[0]!.instances[1]!, worktrees: [] },
          {
            repoInstanceId: 'no-agent:%2Fsrv%2Frelay-ide',
            nodeId: 'no-agent',
            localPath: '/srv/relay-ide',
            name: 'relay-ide',
            isGitRepo: true,
            defaultBranch: 'nightly',
            currentBranch: 'nightly',
            repoIdentity: 'github.com/donovan-yohan/relay-ide',
            selectedRemote: null,
            remotes: [],
            repoIdentityWarnings: [],
            worktrees: [],
            reportedAt: '2026-05-12T00:00:00.000Z',
          },
        ],
      },
    ];

    const terminalModel = buildEnvironmentPickerModel({
      inventory: repoInventory,
      nodes: [node(), noAgentNode],
      selectedGroupId: 'github.com/donovan-yohan/relay-ide',
      selectedNodeId: 'no-agent',
      selectedCheckoutId: null,
      fallbackWorkspace: { name: 'relay-ide', path: '/Users/kyle/relay-ide' },
      fallbackWorktreePath: null,
    });

    const noAgentChoice = terminalModel.nodeChoices.find(
      (c) => c.value === 'no-agent'
    );
    expect(noAgentChoice).toBeDefined();
    expect(noAgentChoice?.disabled).toBeUndefined();
    expect(noAgentChoice?.reason).toBeUndefined();
  });
});
