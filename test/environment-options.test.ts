import { describe, expect, it } from 'vitest';

import {
  buildEnvironmentOptions,
  firstDegradedReasonMessage,
} from '../frontend/src/lib/environment-options.js';
import type { AggregatedRepoInventoryResponse } from '../shared/repo-inventory.js';
import type { HubNodeSummary } from '../shared/relay-node-protocol.js';

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
    generatedAt: '2026-05-19T00:00:00.000Z',
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
            repoInstanceId: 'local:/Users/kyle/relay-ide',
            nodeId: 'local',
            localPath: '/Users/kyle/relay-ide',
            name: 'relay-ide',
            isGitRepo: true,
            defaultBranch: 'master',
            currentBranch: 'nightly',
            repoIdentity: 'github.com/donovan-yohan/relay-ide',
            selectedRemote: null,
            remotes: [],
            repoIdentityWarnings: [],
            worktrees: [
              {
                worktreeInstanceId:
                  'local:/Users/kyle/relay-ide/.worktrees/feat',
                localPath: '/Users/kyle/relay-ide/.worktrees/feat',
                branchName: 'feature/local',
                displayName: 'feat',
              },
            ],
            reportedAt: '2026-05-19T00:00:00.000Z',
          },
          {
            repoInstanceId: 'linux:/srv/relay-ide',
            nodeId: 'linux',
            localPath: '/srv/relay-ide',
            name: 'relay-ide',
            isGitRepo: true,
            defaultBranch: 'master',
            currentBranch: 'nightly',
            repoIdentity: 'github.com/donovan-yohan/relay-ide',
            selectedRemote: null,
            remotes: [],
            repoIdentityWarnings: [],
            worktrees: [],
            reportedAt: '2026-05-19T00:00:00.000Z',
          },
        ],
      },
    ],
  };
}

const GENERATED_AT = '2026-05-19T12:00:00.000Z';

describe('buildEnvironmentOptions', () => {
  it('produces one option per repo instance plus per worktree, preserving order', () => {
    const options = buildEnvironmentOptions({
      inventory: inventory(),
      nodes: [
        node(),
        node({
          nodeId: 'linux',
          displayName: 'linux lab',
          capabilities: {
            ...node().capabilities,
            agents: { claude: 'available' },
          },
        }),
      ],
      selectedAgent: 'claude',
      sessionType: 'agent',
      generatedAt: GENERATED_AT,
    });
    expect(options.map((o) => o.id)).toEqual([
      'local|local:/Users/kyle/relay-ide|__none__',
      'local|local:/Users/kyle/relay-ide|local:/Users/kyle/relay-ide/.worktrees/feat',
      'linux|linux:/srv/relay-ide|__none__',
    ]);
  });

  it('marks offline nodes as freshness=offline with typed reason', () => {
    const options = buildEnvironmentOptions({
      inventory: inventory(),
      nodes: [
        node(),
        node({
          nodeId: 'linux',
          status: 'offline',
          displayName: 'linux lab',
          capabilities: {
            ...node().capabilities,
            agents: { claude: 'available' },
          },
        }),
      ],
      selectedAgent: 'claude',
      sessionType: 'agent',
      generatedAt: GENERATED_AT,
    });
    const linuxOpt = options.find((o) => o.node.nodeId === 'linux');
    expect(linuxOpt?.freshness).toBe('offline');
    expect(linuxOpt?.degradedReasons?.[0]?.kind).toBe('node-offline');
  });

  it('marks stale nodes with node-stale reason carrying lastSeenAt', () => {
    const options = buildEnvironmentOptions({
      inventory: inventory(),
      nodes: [
        node(),
        node({
          nodeId: 'linux',
          status: 'stale',
          displayName: 'linux lab',
          lastSeenAt: '2026-05-18T00:00:00.000Z',
          capabilities: {
            ...node().capabilities,
            agents: { claude: 'available' },
          },
        }),
      ],
      selectedAgent: 'claude',
      sessionType: 'agent',
      generatedAt: GENERATED_AT,
    });
    const linuxOpt = options.find((o) => o.node.nodeId === 'linux');
    expect(linuxOpt?.freshness).toBe('stale');
    const reason = linuxOpt?.degradedReasons?.[0];
    expect(reason?.kind).toBe('node-stale');
    if (reason?.kind === 'node-stale') {
      expect(reason.lastSeenAt).toBe('2026-05-18T00:00:00.000Z');
    }
  });

  it('marks agents-missing nodes as stale with capability-missing reason in agent mode', () => {
    const options = buildEnvironmentOptions({
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
      sessionType: 'agent',
      generatedAt: GENERATED_AT,
    });
    const linuxOpt = options.find((o) => o.node.nodeId === 'linux');
    expect(linuxOpt?.freshness).toBe('stale');
    const reason = linuxOpt?.degradedReasons?.[0];
    expect(reason?.kind).toBe('capability-missing');
  });

  it('terminal mode ignores missing agents and stays fresh on shell+tmux available', () => {
    const options = buildEnvironmentOptions({
      inventory: inventory(),
      nodes: [
        node(),
        node({
          nodeId: 'linux',
          displayName: 'linux lab',
          capabilities: {
            ...node().capabilities,
            agents: {},
          },
        }),
      ],
      selectedAgent: 'claude',
      sessionType: 'terminal',
      generatedAt: GENERATED_AT,
    });
    const linuxOpt = options.find((o) => o.node.nodeId === 'linux');
    expect(linuxOpt?.freshness).toBe('fresh');
    expect(linuxOpt?.degradedReasons ?? []).toEqual([]);
  });

  it('emits typed-id environment shape (nodeId + repoInstance + bench)', () => {
    const options = buildEnvironmentOptions({
      inventory: inventory(),
      nodes: [node()],
      selectedAgent: 'claude',
      sessionType: 'agent',
      generatedAt: GENERATED_AT,
    });
    const worktreeOpt = options.find((o) => o.bench !== undefined);
    expect(worktreeOpt?.node.nodeId).toBe('local');
    expect(worktreeOpt?.repoInstance?.repoInstanceId).toBe(
      'local:/Users/kyle/relay-ide'
    );
    expect(worktreeOpt?.bench?.worktreeInstanceId).toBe(
      'local:/Users/kyle/relay-ide/.worktrees/feat'
    );
    expect(worktreeOpt?.cwdMode).toBe('repo');
  });

  it('appends a fallback workspace when inventory is empty', () => {
    const options = buildEnvironmentOptions({
      inventory: null,
      nodes: [node()],
      selectedAgent: 'claude',
      sessionType: 'agent',
      fallbackWorkspace: {
        name: 'scratch',
        path: '/Users/kyle/scratch',
        isGitRepo: false,
      },
      fallbackWorktreePath: null,
      generatedAt: GENERATED_AT,
    });
    expect(options.length).toBeGreaterThan(0);
    const fallback = options.find((o) => o.cwd === '/Users/kyle/scratch');
    expect(fallback?.cwdMode).toBe('free');
    expect(fallback?.repoInstance).toBeUndefined();
  });

  it('appends paired remote nodes with no inventory as free cwd entries', () => {
    const options = buildEnvironmentOptions({
      inventory: null,
      nodes: [
        node(),
        node({
          nodeId: 'linux',
          displayName: 'linux lab',
          homeDir: '/home/linux',
          capabilities: {
            ...node().capabilities,
            agents: { claude: 'available' },
          },
        }),
      ],
      selectedAgent: 'claude',
      sessionType: 'agent',
      generatedAt: GENERATED_AT,
    });
    const remote = options.find((o) => o.node.nodeId === 'linux');
    expect(remote?.cwdMode).toBe('free');
    expect(remote?.cwd).toBe('/home/linux');
  });

  it('omits session:create:terminal capability when tmux is unavailable (Gemini PR #647)', () => {
    const options = buildEnvironmentOptions({
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
              tmux: 'unavailable',
            },
            agents: { claude: 'available' },
          },
        }),
      ],
      selectedAgent: 'claude',
      sessionType: 'terminal',
      generatedAt: GENERATED_AT,
    });
    const linuxOpt = options.find((o) => o.node.nodeId === 'linux');
    // tmux is mandatory for PTY sessions; without it the option must NOT
    // advertise session:create:terminal even if shell is available.
    expect(linuxOpt?.capabilities).not.toContain('session:create:terminal');
    // And it should also flag the missing capability as a degraded reason.
    expect(
      linuxOpt?.degradedReasons?.some((r) => r.kind === 'capability-missing')
    ).toBe(true);
  });

  it('omits session:create:agent capability when tmux is unavailable in agent mode', () => {
    const options = buildEnvironmentOptions({
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
              tmux: 'unavailable',
            },
            agents: { claude: 'available' },
          },
        }),
      ],
      selectedAgent: 'claude',
      sessionType: 'agent',
      generatedAt: GENERATED_AT,
    });
    const linuxOpt = options.find((o) => o.node.nodeId === 'linux');
    expect(linuxOpt?.capabilities).not.toContain('session:create:agent');
    expect(linuxOpt?.capabilities).not.toContain('session:create:terminal');
  });

  it('does not silently merge a stale/offline node into another node', () => {
    // Critical correctness property of #629: stale/offline nodes still appear
    // as their own options with a degraded reason. They are NEVER replaced
    // by a different node entry. The picker + safe-defaults are responsible
    // for refusing launch — but the converter must preserve identity.
    const offlineNode = node({
      nodeId: 'linux',
      status: 'offline',
      displayName: 'linux lab',
      capabilities: { ...node().capabilities, agents: { claude: 'available' } },
    });
    const options = buildEnvironmentOptions({
      inventory: inventory(),
      nodes: [node(), offlineNode],
      selectedAgent: 'claude',
      sessionType: 'agent',
      generatedAt: GENERATED_AT,
    });
    const linuxOpts = options.filter((o) => o.node.nodeId === 'linux');
    expect(linuxOpts.length).toBe(1);
    expect(linuxOpts[0]?.freshness).toBe('offline');
  });
});

describe('firstDegradedReasonMessage', () => {
  it('returns null for empty or undefined input', () => {
    expect(firstDegradedReasonMessage(undefined)).toBeNull();
    expect(firstDegradedReasonMessage([])).toBeNull();
  });

  it('returns the message of node-offline reasons', () => {
    expect(
      firstDegradedReasonMessage([
        { kind: 'node-offline', message: 'node is offline' },
      ])
    ).toBe('node is offline');
  });

  it('falls back to default copy when message is absent', () => {
    expect(firstDegradedReasonMessage([{ kind: 'node-offline' }])).toBe(
      'node offline'
    );
  });

  it('describes node-stale with lastSeenAt when no message', () => {
    expect(
      firstDegradedReasonMessage([
        { kind: 'node-stale', lastSeenAt: '2026-05-18T00:00:00.000Z' },
      ])
    ).toBe('node stale since 2026-05-18T00:00:00.000Z');
  });
});
