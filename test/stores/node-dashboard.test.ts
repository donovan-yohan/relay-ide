import { describe, expect, it } from 'vitest';
import type { HubNodeSummary } from '../../shared/relay-node-protocol.js';
import {
  deriveHubNodeDashboardRows,
  hubNodeDashboardSummary,
} from '../../frontend/src/lib/state/node-dashboard.js';

const now = new Date('2026-01-02T03:05:00.000Z');

function node(overrides: Partial<HubNodeSummary> = {}): HubNodeSummary {
  return {
    nodeId: 'node-1',
    displayName: 'dev mac',
    hostname: 'dev-mac.local',
    platform: 'darwin',
    arch: 'arm64',
    relayVersion: '9.9.9',
    protocolVersion: '1.0',
    status: 'online',
    connection: { route: 'reverse-link', status: 'connected' },
    capabilities: {
      totals: { available: 11, degraded: 0, unavailable: 0, unknown: 0 },
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
    createdAt: '2026-01-02T03:00:00.000Z',
    pairedAt: '2026-01-02T03:00:00.000Z',
    lastSeenAt: '2026-01-02T03:04:30.000Z',
    credentialId: 'cred-1',
    ...overrides,
  };
}

describe('hub node dashboard state', () => {
  it('marks online nodes with shell, tmux, git, and agent CLIs as ready to work', () => {
    const [row] = deriveHubNodeDashboardRows([node()], { now });

    expect(row).toMatchObject({
      nodeId: 'node-1',
      status: 'online',
      statusTone: 'online',
      attachable: true,
      workReadiness: 'ready to work',
      disabledReason: null,
      routeLabel: 'reverse-link · connected',
      lastSeenLabel: '30s ago',
      versionWarning: null,
    });
    expect(
      row.capabilityHints.map((hint) => `${hint.label}:${hint.status}`)
    ).toEqual([
      'shell:available',
      'tmux:available',
      'git:available',
      'worktrees:available',
      'agents:available',
      'browser:available',
      'clipboard:available',
      'ssh:available',
      'tailscale:available',
      'service:available',
    ]);
  });

  it('keeps stale and offline nodes visible but not attachable', () => {
    const rows = deriveHubNodeDashboardRows(
      [
        node({
          nodeId: 'node-stale',
          displayName: 'stale box',
          status: 'stale',
        }),
        node({
          nodeId: 'node-offline',
          displayName: 'offline box',
          status: 'offline',
        }),
      ],
      { now }
    );

    expect(
      rows.map((row) => [row.displayName, row.attachable, row.disabledReason])
    ).toEqual([
      ['stale box', false, 'not attachable: heartbeat is stale'],
      ['offline box', false, 'not attachable: node is offline'],
    ]);
  });

  it('annotates degraded capabilities that block work actions', () => {
    const [row] = deriveHubNodeDashboardRows(
      [
        node({
          capabilities: {
            ...node().capabilities,
            totals: { available: 8, degraded: 1, unavailable: 2, unknown: 0 },
            core: {
              ...node().capabilities.core,
              tmux: 'degraded',
              git: 'unavailable',
            },
          },
        }),
      ],
      { now }
    );

    expect(row.attachable).toBe(false);
    expect(row.disabledReason).toBe(
      'work disabled: tmux degraded; git unavailable; worktrees unavailable'
    );
    expect(row.capabilityHints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'tmux', status: 'degraded' }),
        expect.objectContaining({ label: 'git', status: 'unavailable' }),
        expect.objectContaining({ label: 'worktrees', status: 'unavailable' }),
      ])
    );
  });

  it('surfaces protocol version warnings separately from availability', () => {
    const [row] = deriveHubNodeDashboardRows(
      [node({ protocolVersion: '1.1', relayVersion: '9.9.0' })],
      { now, expectedProtocolVersion: '1.0' }
    );

    expect(row.attachable).toBe(true);
    expect(row.versionWarning).toBe('protocol 1.1 != hub 1.0');
  });

  it('summarizes which machines can currently do work', () => {
    const summary = hubNodeDashboardSummary(
      [
        node({ nodeId: 'ready' }),
        node({ nodeId: 'offline', status: 'offline' }),
        node({
          nodeId: 'degraded',
          capabilities: {
            ...node().capabilities,
            core: { ...node().capabilities.core, git: 'unavailable' },
          },
        }),
      ],
      { now }
    );

    expect(summary).toBe(
      '1/3 nodes ready · 1 blocked by capabilities · 1 offline/stale'
    );
  });
});
