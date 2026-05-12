import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { HubNodeSummary } from '../../shared/relay-node-protocol.js';
import { HubNodeDashboard } from '../../frontend/src/components/HubNodeDashboard.js';

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
    createdAt: '2026-01-02T03:00:00.000Z',
    pairedAt: '2026-01-02T03:00:00.000Z',
    lastSeenAt: '2026-01-02T03:04:30.000Z',
    credentialId: 'cred-1',
    ...overrides,
  };
}

describe('HubNodeDashboard', () => {
  it('renders nothing in boring local mode when the hub has no nodes', () => {
    const html = renderToStaticMarkup(
      React.createElement(HubNodeDashboard, { nodes: [], now })
    );

    expect(html).toBe('');
  });

  it('shows online, stale/offline, degraded capability, and version warning states', () => {
    const html = renderToStaticMarkup(
      React.createElement(HubNodeDashboard, {
        now,
        expectedProtocolVersion: '1.0',
        nodes: [
          node({ displayName: 'ready mac' }),
          node({ nodeId: 'stale', displayName: 'stale linux', status: 'stale' }),
          node({ nodeId: 'offline', displayName: 'offline lab', status: 'offline' }),
          node({
            nodeId: 'degraded',
            displayName: 'thin client',
            protocolVersion: '2.0',
            capabilities: {
              ...node().capabilities,
              totals: { available: 8, degraded: 1, unavailable: 2, unknown: 0 },
              core: {
                ...node().capabilities.core,
                tmux: 'degraded',
                git: 'unavailable',
                worktrees: 'unavailable',
              },
            },
          }),
        ],
      })
    );

    expect(html).toContain('nodes');
    expect(html).toContain('1/4 nodes ready');
    expect(html).toContain('ready mac');
    expect(html).toContain('ready to work');
    expect(html).toContain('stale linux');
    expect(html).toContain('not attachable: heartbeat is stale');
    expect(html).toContain('offline lab');
    expect(html).toContain('not attachable: node is offline');
    expect(html).toContain('thin client');
    expect(html).toContain('work disabled: tmux degraded; git unavailable; worktrees unavailable');
    expect(html).toContain('protocol 2.0 != hub 1.0');
    expect(html).toContain('shell');
    expect(html).toContain('tmux');
    expect(html).toContain('git');
    expect(html).toContain('worktrees');
    expect(html).toContain('agents');
    expect(html).toContain('browser');
    expect(html).toContain('clipboard');
    expect(html).toContain('ssh');
    expect(html).toContain('tailscale');
    expect(html).toContain('service');
  });
});
