// #861 node launch targets — acceptance-evidence suite (Agent A scope).
//
// One named test per #861 acceptance criterion. These exercise the read-model
// surface only (data + guards): how `buildEnvironmentOptions` derives launch
// targets from `nodes.list` + inventory, and how the typed degraded reasons /
// freshness / agent providers / launch gating compose. No launcher UI is
// asserted here (that is #862/#863); this file is the data-layer proof.
//
// Mocking policy: launch-side tests use the `createSession` injection param,
// never `vi.mock`, per the repo test conventions.

import { describe, expect, it, vi } from 'vitest';

import {
  buildEnvironmentOptions,
  firstDegradedReasonMessage,
} from '../frontend/src/lib/environment-options.js';
import { launchEnvironment } from '../frontend/src/lib/launch-environment.js';
import {
  isEnvironmentDegradedReason,
  type EnvironmentDegradedReason,
} from '../shared/environment-option.js';
import type { AggregatedRepoInventoryResponse } from '../shared/repo-inventory.js';
import type { HubNodeSummary } from '../shared/relay-node-protocol.js';

const GENERATED_AT = '2026-06-10T12:00:00.000Z';

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

function remote(overrides: Partial<HubNodeSummary> = {}): HubNodeSummary {
  return node({
    nodeId: 'linux',
    displayName: 'linux lab',
    platform: 'linux',
    homeDir: '/home/linux',
    capabilities: { ...node().capabilities, agents: { claude: 'available' } },
    ...overrides,
  });
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
            worktrees: [],
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

describe('#861 node launch targets — acceptance', () => {
  it('AC: surfaces the local node as a launchable shell target', () => {
    const options = buildEnvironmentOptions({
      inventory: inventory(),
      nodes: [node()],
      selectedAgent: 'claude',
      sessionType: 'terminal',
      generatedAt: GENERATED_AT,
    });
    const local = options.find((o) => o.node.nodeId === 'local');
    expect(local?.node.kind).toBe('local');
    expect(local?.freshness).toBe('fresh');
    expect(local?.capabilities).toContain('session:create:terminal');
  });

  it('AC: surfaces a remote online node as a launchable target', () => {
    const options = buildEnvironmentOptions({
      inventory: inventory(),
      nodes: [node(), remote()],
      selectedAgent: 'claude',
      sessionType: 'agent',
      generatedAt: GENERATED_AT,
    });
    const linux = options.find((o) => o.node.nodeId === 'linux');
    expect(linux?.node.kind).toBe('remote');
    expect(linux?.node.online).toBe(true);
    expect(linux?.freshness).toBe('fresh');
  });

  it('AC: a node mid-update is freshness=updating and blocked at launch', async () => {
    const options = buildEnvironmentOptions({
      inventory: inventory(),
      nodes: [node(), remote({ status: 'updating' })],
      selectedAgent: 'claude',
      sessionType: 'agent',
      generatedAt: GENERATED_AT,
    });
    const linux = options.find((o) => o.node.nodeId === 'linux');
    expect(linux?.freshness).toBe('updating');

    const createSession = vi.fn(async () => ({
      session: undefined,
      error: null,
    }));
    const result = await launchEnvironment(linux!, {}, createSession);
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.reason.code).toBe('updating');
    }
    expect(createSession).not.toHaveBeenCalled();
  });

  it('AC: a target lists the agent providers a node advertises', () => {
    const options = buildEnvironmentOptions({
      inventory: inventory(),
      nodes: [node()],
      selectedAgent: 'claude',
      sessionType: 'agent',
      generatedAt: GENERATED_AT,
    });
    const local = options.find((o) => o.node.nodeId === 'local');
    expect((local?.node.agentProviders ?? []).map((p) => p.id)).toEqual([
      'claude',
      'codex',
    ]);
    expect(
      local?.node.agentProviders?.every((p) => p.availability === 'available')
    ).toBe(true);
  });

  it('AC: terminal-backend gating drops session:create when no backend is available', () => {
    const options = buildEnvironmentOptions({
      inventory: inventory(),
      nodes: [
        node(),
        remote({
          capabilities: {
            ...remote().capabilities,
            core: { ...remote().capabilities.core, tmux: 'unavailable' },
            terminalBackends: {
              'relay-pty': 'unavailable',
              'tmux-compat': 'unavailable',
            },
          },
        }),
      ],
      selectedAgent: 'claude',
      sessionType: 'terminal',
      generatedAt: GENERATED_AT,
    });
    const linux = options.find((o) => o.node.nodeId === 'linux');
    expect(linux?.capabilities).not.toContain('session:create:terminal');
    expect(
      linux?.degradedReasons?.some((r) => r.kind === 'capability-missing')
    ).toBe(true);
  });

  it('AC: a free cwd target never carries repo metadata', () => {
    const options = buildEnvironmentOptions({
      inventory: null,
      nodes: [node(), remote()],
      selectedAgent: 'claude',
      sessionType: 'agent',
      generatedAt: GENERATED_AT,
    });
    const linux = options.find((o) => o.node.nodeId === 'linux');
    expect(linux?.cwdMode).toBe('free');
    expect(linux?.repoInstance).toBeUndefined();
    expect(linux?.bench).toBeUndefined();
  });

  it('AC: offline and stale nodes are surfaced with typed degraded reasons (never substituted)', () => {
    const options = buildEnvironmentOptions({
      inventory: inventory(),
      nodes: [
        node(),
        remote({ nodeId: 'linux', status: 'offline' }),
        remote({
          nodeId: 'win',
          displayName: 'win box',
          status: 'stale',
          lastSeenAt: '2026-06-09T00:00:00.000Z',
        }),
      ],
      selectedAgent: 'claude',
      sessionType: 'terminal',
      generatedAt: GENERATED_AT,
    });
    const offline = options.find((o) => o.node.nodeId === 'linux');
    expect(offline?.freshness).toBe('offline');
    expect(offline?.degradedReasons?.[0]?.kind).toBe('node-offline');
    const stale = options.find((o) => o.node.nodeId === 'win');
    expect(stale?.freshness).toBe('stale');
    expect(stale?.degradedReasons?.[0]?.kind).toBe('node-stale');
  });

  it('AC: a node missing shell / terminal backend reports capability-missing', () => {
    const options = buildEnvironmentOptions({
      inventory: inventory(),
      nodes: [
        node(),
        remote({
          capabilities: {
            ...remote().capabilities,
            core: { ...remote().capabilities.core, shell: 'unavailable' },
          },
        }),
      ],
      selectedAgent: 'claude',
      sessionType: 'terminal',
      generatedAt: GENERATED_AT,
    });
    const linux = options.find((o) => o.node.nodeId === 'linux');
    const reason = linux?.degradedReasons?.find(
      (r) => r.kind === 'capability-missing'
    );
    expect(reason?.kind).toBe('capability-missing');
    expect(firstDegradedReasonMessage(linux?.degradedReasons)).toContain(
      'shell'
    );
  });

  it('AC: an unavailable agent provider is enumerated with a reason', () => {
    const options = buildEnvironmentOptions({
      inventory: inventory(),
      nodes: [
        node({
          capabilities: {
            ...node().capabilities,
            agents: { claude: 'available', codex: 'unavailable' },
          },
        }),
      ],
      selectedAgent: 'claude',
      sessionType: 'agent',
      generatedAt: GENERATED_AT,
    });
    const local = options.find((o) => o.node.nodeId === 'local');
    const codex = local?.node.agentProviders?.find((p) => p.id === 'codex');
    expect(codex?.availability).toBe('unavailable');
    expect(codex?.reason).toBe('UNSUPPORTED_CAPABILITY');
  });

  it('AC: helper and protocol skew both surface as typed version-skew reasons', () => {
    const options = buildEnvironmentOptions({
      inventory: inventory(),
      nodes: [
        node(),
        remote({
          version: {
            state: 'version-skew',
            nodeProtocolVersion: '0.9',
            hubProtocolVersion: '1.0',
          },
          helperSkew: {
            category: 'minor-skew-warn',
            helperVersion: '1.1.0',
            hubVersion: '1.3.0',
            message: 'helper binary is behind the hub',
          },
        }),
      ],
      selectedAgent: 'claude',
      sessionType: 'agent',
      generatedAt: GENERATED_AT,
    });
    const linux = options.find((o) => o.node.nodeId === 'linux');
    const skews = (linux?.degradedReasons ?? []).filter(
      (r) => r.kind === 'version-skew'
    );
    const scopes = skews.flatMap((r) =>
      r.kind === 'version-skew' ? [r.scope] : []
    );
    expect(scopes).toContain('protocol');
    expect(scopes).toContain('helper');
    // No legacy `{ kind: 'other', code: 'version-skew' }` mapping remains.
    expect(
      linux?.degradedReasons?.some(
        (r) => r.kind === 'other' && r.code === 'version-skew'
      ) ?? false
    ).toBe(false);
  });

  it('AC: cwd-invalid is a guarded degraded reason that round-trips through JSON', () => {
    // #861(D): the variant + guards exist now; live population is deferred to
    // the launcher slices. This proves the shape is wired and serializable.
    const reason: EnvironmentDegradedReason = {
      kind: 'cwd-invalid',
      cwd: '/srv/relay-ide/.worktrees/gone',
      code: 'ENOENT',
      message: 'cwd no longer exists on the node',
    };
    expect(isEnvironmentDegradedReason(reason)).toBe(true);
    const round = JSON.parse(JSON.stringify(reason)) as unknown;
    expect(isEnvironmentDegradedReason(round)).toBe(true);
    expect(round).toEqual(reason);
  });
});
