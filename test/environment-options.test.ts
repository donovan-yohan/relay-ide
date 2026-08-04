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
      terminalBackends: {
        'relay-pty': 'available',
        'tmux-compat': 'available',
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
      sessionType: 'terminal',
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
      sessionType: 'terminal',
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
      sessionType: 'terminal',
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

  it('terminal mode ignores missing agents and stays fresh on shell plus terminal backend available', () => {
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
      sessionType: 'terminal',
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
      sessionType: 'terminal',
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
      sessionType: 'terminal',
      generatedAt: GENERATED_AT,
    });
    const remote = options.find((o) => o.node.nodeId === 'linux');
    expect(remote?.cwdMode).toBe('free');
    expect(remote?.cwd).toBe('/home/linux');
  });

  it('keeps session:create:terminal capability when tmux is unavailable but relay-pty is available', () => {
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
            terminalBackends: {
              'relay-pty': 'available',
              'tmux-compat': 'unavailable',
            },
            agents: { claude: 'available' },
          },
        }),
      ],
      sessionType: 'terminal',
      generatedAt: GENERATED_AT,
    });
    const linuxOpt = options.find((o) => o.node.nodeId === 'linux');
    expect(linuxOpt?.capabilities).toContain('session:create:terminal');
    expect(
      linuxOpt?.degradedReasons?.some((r) => r.kind === 'capability-missing') ??
        false
    ).toBe(false);
  });

  it('omits session:create:terminal capability when no terminal backend is available', () => {
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
            terminalBackends: {
              'relay-pty': 'unavailable',
              'tmux-compat': 'unavailable',
            },
            agents: { claude: 'available' },
          },
        }),
      ],
      sessionType: 'terminal',
      generatedAt: GENERATED_AT,
    });
    const linuxOpt = options.find((o) => o.node.nodeId === 'linux');
    expect(linuxOpt?.capabilities).not.toContain('session:create:terminal');
    expect(
      linuxOpt?.degradedReasons?.some((r) => r.kind === 'capability-missing')
    ).toBe(true);
  });

  it('marks updating nodes as freshness=updating with a reason (#861(A))', () => {
    const options = buildEnvironmentOptions({
      inventory: inventory(),
      nodes: [
        node(),
        node({
          nodeId: 'linux',
          status: 'updating',
          displayName: 'linux lab',
          capabilities: {
            ...node().capabilities,
            agents: { claude: 'available' },
          },
        }),
      ],
      sessionType: 'terminal',
      generatedAt: GENERATED_AT,
    });
    const linuxOpt = options.find((o) => o.node.nodeId === 'linux');
    expect(linuxOpt?.freshness).toBe('updating');
    expect(linuxOpt?.degradedReasons?.[0]?.message).toContain('updating');
  });

  it('maps helper major-skew-error onto a typed version-skew reason (#861(C))', () => {
    const options = buildEnvironmentOptions({
      inventory: inventory(),
      nodes: [
        node(),
        node({
          nodeId: 'linux',
          displayName: 'linux lab',
          helperSkew: {
            category: 'major-skew-error',
            helperVersion: '1.0.0',
            hubVersion: '3.0.0',
            message: 'helper binary is too old',
            remediationHint: 'run relay-ide update on linux',
          },
          capabilities: {
            ...node().capabilities,
            agents: { claude: 'available' },
          },
        }),
      ],
      sessionType: 'terminal',
      generatedAt: GENERATED_AT,
    });
    const linuxOpt = options.find((o) => o.node.nodeId === 'linux');
    expect(linuxOpt?.freshness).toBe('stale');
    const skew = linuxOpt?.degradedReasons?.find(
      (r) => r.kind === 'version-skew'
    );
    expect(skew?.kind).toBe('version-skew');
    if (skew?.kind === 'version-skew') {
      expect(skew.scope).toBe('helper');
      expect(skew.category).toBe('major-skew-error');
      expect(skew.message).toBe('helper binary is too old');
      expect(skew.remediationHint).toBe('run relay-ide update on linux');
    }
  });

  it('still surfaces protocol version skew after the version-skew migration (#861(C))', () => {
    const options = buildEnvironmentOptions({
      inventory: inventory(),
      nodes: [
        node(),
        node({
          nodeId: 'linux',
          displayName: 'linux lab',
          version: {
            state: 'version-skew',
            nodeProtocolVersion: '0.9',
            hubProtocolVersion: '1.0',
          },
          capabilities: {
            ...node().capabilities,
            agents: { claude: 'available' },
          },
        }),
      ],
      sessionType: 'terminal',
      generatedAt: GENERATED_AT,
    });
    const linuxOpt = options.find((o) => o.node.nodeId === 'linux');
    expect(linuxOpt?.freshness).toBe('stale');
    const skew = linuxOpt?.degradedReasons?.find(
      (r) => r.kind === 'version-skew'
    );
    expect(skew?.kind).toBe('version-skew');
    if (skew?.kind === 'version-skew') {
      // No more `{ kind: 'other', code: 'version-skew' }` — it is now typed
      // with scope 'protocol', preserving the original copy.
      expect(skew.scope).toBe('protocol');
      expect(skew.category).toBe('version-skew');
      expect(skew.message).toBe('node has version skew');
    }
    // Legacy 'other'/code path must no longer fire for skew.
    expect(
      linuxOpt?.degradedReasons?.some(
        (r) => r.kind === 'other' && r.code === 'version-skew'
      ) ?? false
    ).toBe(false);
  });

  it('enumerates agentProviders with mixed availabilities including unknown (#861(B))', () => {
    const options = buildEnvironmentOptions({
      inventory: inventory(),
      nodes: [
        node({
          capabilities: {
            ...node().capabilities,
            agents: {
              claude: 'available',
              codex: 'unavailable',
              hermes: 'degraded',
              opencode: 'unknown',
            },
          },
        }),
      ],
      sessionType: 'terminal',
      generatedAt: GENERATED_AT,
    });
    const opt = options.find((o) => o.node.nodeId === 'local');
    const providers = opt?.node.agentProviders ?? [];
    const byId = new Map(providers.map((p) => [p.id, p]));
    expect(byId.get('claude')?.availability).toBe('available');
    expect(byId.get('claude')?.reason).toBeUndefined();
    expect(byId.get('codex')?.availability).toBe('unavailable');
    expect(byId.get('codex')?.reason).toBe('UNSUPPORTED_CAPABILITY');
    expect(byId.get('hermes')?.availability).toBe('degraded');
    expect(byId.get('hermes')?.reason).toBe('REPAIR_REQUIRED');
    expect(byId.get('opencode')?.availability).toBe('unknown');
    expect(byId.get('opencode')?.reason).toBe('NODE_UNSUPPORTED');
  });

  it('omits agentProviders entirely for a node with no agents (#861(B))', () => {
    const options = buildEnvironmentOptions({
      inventory: null,
      nodes: [
        node(),
        node({
          nodeId: 'linux',
          displayName: 'linux lab',
          homeDir: '/home/linux',
          capabilities: { ...node().capabilities, agents: {} },
        }),
      ],
      sessionType: 'terminal',
      generatedAt: GENERATED_AT,
    });
    const remote = options.find((o) => o.node.nodeId === 'linux');
    expect(remote?.node.agentProviders).toBeUndefined();
  });

  it('agentProviders presence does not leak repo metadata onto a free cwd option (#861(B))', () => {
    // Free-cwd invariant: a remote node with no inventory surfaces a free cwd
    // option. Adding agentProviders must not introduce a repoInstance/bench.
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
            agents: { claude: 'available', codex: 'unavailable' },
          },
        }),
      ],
      sessionType: 'terminal',
      generatedAt: GENERATED_AT,
    });
    const remote = options.find((o) => o.node.nodeId === 'linux');
    expect(remote?.cwdMode).toBe('free');
    expect(remote?.repoInstance).toBeUndefined();
    expect(remote?.bench).toBeUndefined();
    // But the providers are still enumerated on the node summary.
    expect((remote?.node.agentProviders ?? []).map((p) => p.id)).toEqual([
      'claude',
      'codex',
    ]);
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
      sessionType: 'terminal',
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

  it('describes version-skew reasons with the remediation hint (#861(C))', () => {
    expect(
      firstDegradedReasonMessage([
        {
          kind: 'version-skew',
          scope: 'helper',
          category: 'major-skew-error',
          message: 'helper binary is too old',
          remediationHint: 'run relay-ide update',
        },
      ])
    ).toBe('helper binary is too old — run relay-ide update');
    expect(
      firstDegradedReasonMessage([
        {
          kind: 'version-skew',
          scope: 'protocol',
          category: 'incompatible',
          message: 'node protocol is incompatible',
        },
      ])
    ).toBe('node protocol is incompatible');
  });

  it('describes cwd-invalid reasons (#861(D))', () => {
    expect(
      firstDegradedReasonMessage([
        { kind: 'cwd-invalid', cwd: '/gone', message: 'cwd no longer exists' },
      ])
    ).toBe('cwd no longer exists');
  });
});
