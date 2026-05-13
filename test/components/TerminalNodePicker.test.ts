import { describe, expect, it } from 'vitest';
import type { HubNodeSummary } from '../../shared/relay-node-protocol.js';
import { buildChoices } from '../../frontend/src/components/TerminalNodePicker.js';

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
    trust: { state: 'trusted', level: 'standard', warning: '' },
    credentialState: 'active',
    version: {
      state: 'match',
      nodeProtocolVersion: '1.0',
      hubProtocolVersion: '1.0',
    },
    capabilities: {
      totals: { available: 11, degraded: 0, unavailable: 0, unknown: 0 },
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
      agents: { claude: 'available' },
      serviceManager: 'launchd',
      wsl: false,
    },
    createdAt: '2026-01-02T03:00:00.000Z',
    pairedAt: '2026-01-02T03:00:00.000Z',
    lastSeenAt: '2026-01-02T03:04:30.000Z',
    credentialId: 'cred-1',
    ...overrides,
  } as HubNodeSummary;
}

describe('TerminalNodePicker buildChoices', () => {
  it('always includes a "this host" entry first', () => {
    const choices = buildChoices([]);
    expect(choices).toHaveLength(1);
    expect(choices[0]?.label).toBe('this host');
    expect(choices[0]?.nodeId).toBe('local');
    expect(choices[0]?.disabled).toBe(false);
  });

  it('appends online nodes after the local entry as enabled choices', () => {
    const choices = buildChoices([
      node({ nodeId: 'mac', displayName: 'mac', status: 'online' }),
    ]);
    expect(choices.map((c) => c.nodeId)).toEqual(['local', 'mac']);
    expect(choices[1]?.disabled).toBe(false);
    expect(choices[1]?.status).toBe('online');
  });

  it('disables non-online nodes and surfaces the status as reason', () => {
    const choices = buildChoices([
      node({ nodeId: 'stale', displayName: 'stale', status: 'stale' }),
      node({ nodeId: 'offline', displayName: 'offline', status: 'offline' }),
      node({ nodeId: 'revoked', displayName: 'revoked', status: 'revoked' }),
    ]);
    expect(choices[1]).toMatchObject({
      disabled: true,
      disabledReason: 'stale',
    });
    expect(choices[2]).toMatchObject({
      disabled: true,
      disabledReason: 'offline',
    });
    expect(choices[3]).toMatchObject({
      disabled: true,
      disabledReason: 'revoked',
    });
  });

  it('falls back to nodeId when displayName is empty', () => {
    const choices = buildChoices([node({ nodeId: 'm1', displayName: '' })]);
    expect(choices[1]?.label).toBe('m1');
  });
});

import { firstEnabledIndex } from '../../frontend/src/components/TerminalNodePicker.js';

describe('TerminalNodePicker firstEnabledIndex', () => {
  const local = buildChoices([])[0]!;
  const onlineMac = buildChoices([
    node({ nodeId: 'mac', displayName: 'mac', status: 'online' }),
  ])[1]!;
  const offlineWsl = buildChoices([
    node({ nodeId: 'wsl', displayName: 'wsl', status: 'offline' }),
  ])[1]!;

  it('returns the first enabled index when stepping forward', () => {
    expect(firstEnabledIndex([offlineWsl, local, onlineMac], 0, 1)).toBe(1);
  });

  it('returns the first enabled index when stepping backward', () => {
    expect(firstEnabledIndex([offlineWsl, local, onlineMac], 2, -1)).toBe(2);
    expect(firstEnabledIndex([offlineWsl, local, onlineMac], 1, -1)).toBe(1);
    expect(firstEnabledIndex([offlineWsl, local], 1, -1)).toBe(1);
  });

  it('returns -1 when no choice is enabled in the direction', () => {
    expect(firstEnabledIndex([offlineWsl], 0, 1)).toBe(-1);
    expect(firstEnabledIndex([offlineWsl, offlineWsl], 0, 1)).toBe(-1);
  });

  it('handles out-of-range starts', () => {
    expect(firstEnabledIndex([local, onlineMac], 5, 1)).toBe(-1);
    expect(firstEnabledIndex([local, onlineMac], -1, 1)).toBe(-1);
  });
});
