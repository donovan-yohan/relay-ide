// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HubNodeSummary } from '../../shared/relay-node-protocol.js';
import { HubNodeDashboard } from '../../frontend/src/components/HubNodeDashboard.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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
      totals: { available: 11, degraded: 1, unavailable: 0, unknown: 0 },
      core: {
        shell: 'available',
        tmux: 'available',
        git: 'available',
        browserAutomation: 'degraded',
        clipboardImage: 'available',
        ssh: 'available',
        tailscale: 'available',
      },
      agents: { hermes: 'degraded' },
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

describe('HubNodeDashboard degraded reasons interaction', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('exposes full degraded reason text after expanding', async () => {
    await act(async () => {
      root.render(
        React.createElement(HubNodeDashboard, {
          now,
          nodes: [
            node({
              degradedReasons: [
                {
                  code: 'AGENT_DEGRADED_HERMES',
                  description:
                    'Hermes gateway API is not reachable at http://127.0.0.1:8642 (default). Last error: connect ECONNREFUSED 127.0.0.1:8642',
                  severity: 'warn',
                },
              ],
            }),
          ],
        })
      );
    });

    const toggle = container.querySelector('.hub-node-degraded-toggle');
    expect(toggle).toBeTruthy();

    await act(async () => {
      (toggle as HTMLButtonElement).click();
    });

    const reason = container.querySelector('.hub-node-degraded-reason');
    expect(reason).toBeTruthy();
    expect(reason?.textContent).toContain('connect ECONNREFUSED');
    expect(reason?.getAttribute('title')).toBe(
      'AGENT_DEGRADED_HERMES: Hermes gateway API is not reachable at http://127.0.0.1:8642 (default). Last error: connect ECONNREFUSED 127.0.0.1:8642 (warn)'
    );
  });
});
