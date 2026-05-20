/**
 * Tests for slice 4 (#654) — degraded UI:
 *   - HubNodeDashboardRow includes helperVersion, fileRpcAvailable, degradedReasons
 *   - HubNodeDashboard renders the DegradedReasonsExpander + NodeHelperMeta
 */

import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { HubNodeSummary } from '../../shared/relay-node-protocol.js';
import type { NodeManifestDegradedReason } from '../../shared/node-manifest.js';
import { deriveHubNodeDashboardRows } from '../../frontend/src/lib/state/node-dashboard.js';
import { HubNodeDashboard } from '../../frontend/src/components/HubNodeDashboard.js';

const now = new Date('2026-01-02T03:05:00.000Z');

function node(overrides: Partial<HubNodeSummary> = {}): HubNodeSummary {
  return {
    nodeId: 'node-1',
    displayName: 'dev mac',
    hostname: 'dev-mac.local',
    platform: 'darwin',
    arch: 'arm64',
    relayVersion: '0.5.0',
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
      agents: { claude: 'available' },
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

// ---------------------------------------------------------------------------
// HubNodeDashboardRow derivation
// ---------------------------------------------------------------------------

describe('deriveHubNodeDashboardRows — degraded UI fields (#654)', () => {
  it('exposes helperVersion from the summary field', () => {
    const [row] = deriveHubNodeDashboardRows(
      [node({ helperVersion: '0.5.0' })],
      { now }
    );
    expect(row.helperVersion).toBe('0.5.0');
  });

  it('sets helperVersion to null when absent from summary (pre-#651 node)', () => {
    const [row] = deriveHubNodeDashboardRows([node()], { now });
    expect(row.helperVersion).toBeNull();
  });

  it('exposes fileRpcAvailable=true when the node reports it', () => {
    const [row] = deriveHubNodeDashboardRows(
      [node({ fileRpcAvailable: true })],
      { now }
    );
    expect(row.fileRpcAvailable).toBe(true);
  });

  it('exposes fileRpcAvailable=false when the node reports file rpc unavailable', () => {
    const [row] = deriveHubNodeDashboardRows(
      [node({ fileRpcAvailable: false })],
      { now }
    );
    expect(row.fileRpcAvailable).toBe(false);
  });

  it('sets fileRpcAvailable to null when the field is absent (pre-#651 node)', () => {
    const [row] = deriveHubNodeDashboardRows([node()], { now });
    expect(row.fileRpcAvailable).toBeNull();
  });

  it('exposes degradedReasons from the summary', () => {
    const reasons: NodeManifestDegradedReason[] = [
      {
        code: 'TMUX_MISSING',
        description: 'tmux not found',
        severity: 'error',
      },
      {
        code: 'FILE_RPC_DISABLED',
        description: 'file rpc disabled by policy',
        severity: 'warn',
      },
    ];
    const [row] = deriveHubNodeDashboardRows(
      [node({ degradedReasons: reasons })],
      { now }
    );
    expect(row.degradedReasons).toEqual(reasons);
  });

  it('defaults degradedReasons to empty array when absent', () => {
    const [row] = deriveHubNodeDashboardRows([node()], { now });
    expect(row.degradedReasons).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// HubNodeDashboard render
// ---------------------------------------------------------------------------

describe('HubNodeDashboard — degraded UI render (#654)', () => {
  it('shows helper version when the node provides it', () => {
    const html = renderToStaticMarkup(
      React.createElement(HubNodeDashboard, {
        now,
        nodes: [node({ helperVersion: '0.5.1' })],
      })
    );
    expect(html).toContain('helper v0.5.1');
  });

  it('omits helper version line when the node does not provide helperVersion', () => {
    const html = renderToStaticMarkup(
      React.createElement(HubNodeDashboard, {
        now,
        nodes: [node()],
      })
    );
    expect(html).not.toContain('helper v');
  });

  it('shows "file rpc unavailable" warning when fileRpcAvailable is false', () => {
    const html = renderToStaticMarkup(
      React.createElement(HubNodeDashboard, {
        now,
        nodes: [node({ fileRpcAvailable: false })],
      })
    );
    expect(html).toContain('file rpc unavailable');
  });

  it('does not show file rpc unavailable warning when fileRpcAvailable is true', () => {
    const html = renderToStaticMarkup(
      React.createElement(HubNodeDashboard, {
        now,
        nodes: [node({ fileRpcAvailable: true })],
      })
    );
    expect(html).not.toContain('file rpc unavailable');
  });

  it('renders the degraded-reasons toggle button when there are degraded reasons', () => {
    const html = renderToStaticMarkup(
      React.createElement(HubNodeDashboard, {
        now,
        nodes: [
          node({
            degradedReasons: [
              {
                code: 'TMUX_MISSING',
                description: 'tmux not found in PATH',
                severity: 'error',
              },
            ],
          }),
        ],
      })
    );
    expect(html).toContain('why degraded?');
    expect(html).toContain('(1)');
  });

  it('does not render the degraded-reasons toggle when there are no degraded reasons', () => {
    const html = renderToStaticMarkup(
      React.createElement(HubNodeDashboard, {
        now,
        nodes: [node()],
      })
    );
    expect(html).not.toContain('why degraded?');
  });

  it('renders combined helper version and file rpc status for a degraded node', () => {
    const html = renderToStaticMarkup(
      React.createElement(HubNodeDashboard, {
        now,
        nodes: [
          node({
            helperVersion: '0.4.2',
            fileRpcAvailable: false,
            degradedReasons: [
              {
                code: 'FILE_RPC_DISABLED',
                description: 'file rpc disabled by policy',
                severity: 'warn',
              },
            ],
          }),
        ],
      })
    );
    expect(html).toContain('helper v0.4.2');
    expect(html).toContain('file rpc unavailable');
    expect(html).toContain('why degraded?');
  });
});
