import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { HubNodeSummary } from '../../shared/relay-node-protocol.js';
import type { AggregatedRepoInventoryResponse } from '../../shared/repo-inventory.js';
import { HubNodeDashboard } from '../../frontend/src/components/HubNodeDashboard.js';
import {
  deriveNodeRepoLocality,
  repoLocalitySummary,
} from '../../frontend/src/lib/state/node-dashboard.js';

const now = new Date('2026-01-02T03:05:00.000Z');

function node(overrides: Partial<HubNodeSummary> = {}): HubNodeSummary {
  return {
    nodeId: 'node-1',
    identity: {
      nodeId: 'node-1',
      displayName: 'dev mac',
      hostname: 'dev-mac.local',
      createdAt: '2026-01-02T03:00:00.000Z',
      pairedAt: '2026-01-02T03:00:00.000Z',
    },
    displayName: 'dev mac',
    hostname: 'dev-mac.local',
    platform: 'darwin',
    arch: 'arm64',
    relayVersion: '9.9.9',
    protocolVersion: '1.0',
    status: 'online',
    connection: { route: 'reverse-link', status: 'connected' },
    trust: { state: 'trusted', level: 'standard', tier: 'dev' },
    credentialState: 'active',
    credential: {
      credentialId: 'cred-1',
      issuedAt: '2026-01-02T03:00:00.000Z',
      state: 'active',
    },
    version: {
      state: 'compatible',
      nodeProtocolVersion: '1.0',
      hubProtocolVersion: '1.0',
    },
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

function inventory(): AggregatedRepoInventoryResponse {
  const repo = {
    repoInstanceId: 'node-1:/repo/relay-ide',
    nodeId: 'node-1',
    localPath: '/repo/relay-ide',
    name: 'relay-ide',
    isGitRepo: true,
    defaultBranch: 'nightly',
    currentBranch: 'frontend/921-nodes-section',
    repoIdentity: 'github.com/donovan-yohan/relay-ide',
    selectedRemote: {
      name: 'origin',
      url: 'https://github.com/donovan-yohan/relay-ide.git',
      identity: 'github.com/donovan-yohan/relay-ide',
      provider: 'github' as const,
      host: 'github.com',
      path: 'donovan-yohan/relay-ide',
      owner: 'donovan-yohan',
      repoName: 'relay-ide',
    },
    remotes: [],
    repoIdentityWarnings: [],
    dirty: null,
    divergence: null,
    worktrees: [
      {
        worktreeInstanceId: 'node-1:/repo/relay-ide/.worktrees/921',
        localPath: '/repo/relay-ide/.worktrees/921',
        branchName: 'frontend/921-nodes-section',
        displayName: '921',
      },
    ],
    reportedAt: '2026-01-02T03:04:00.000Z',
  };
  return {
    generatedAt: '2026-01-02T03:04:00.000Z',
    groups: [
      {
        groupId: 'github.com/donovan-yohan/relay-ide',
        repoIdentity: 'github.com/donovan-yohan/relay-ide',
        displayName: 'relay-ide',
        selectedRemote: repo.selectedRemote,
        remotes: [],
        warnings: [],
        instances: [repo],
        identityDebug: {
          groupedBy: 'repoIdentity',
          repoIdentity: 'github.com/donovan-yohan/relay-ide',
          instanceCount: 1,
          nodeIds: ['node-1'],
        },
      },
    ],
    reports: [
      {
        nodeId: 'node-1',
        generatedAt: '2026-01-02T03:04:00.000Z',
        repos: [repo],
      },
    ],
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
          node({
            nodeId: 'stale',
            displayName: 'stale linux',
            status: 'stale',
          }),
          node({
            nodeId: 'offline',
            displayName: 'offline lab',
            status: 'offline',
          }),
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
    expect(html).toContain(
      'work disabled: tmux degraded; git unavailable; worktrees unavailable'
    );
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

  it('renders repo/worktree locality from inventory without inventing missing data', () => {
    const localityByNode = deriveNodeRepoLocality(inventory());
    const locality = localityByNode.get('node-1');

    expect(locality).toBeDefined();
    expect(locality ? repoLocalitySummary(locality) : '').toBe(
      '1 repo · 1 worktree'
    );

    const html = renderToStaticMarkup(
      React.createElement(HubNodeDashboard, {
        now,
        nodes: [node()],
        localityByNode,
      })
    );

    expect(html).toContain('repo locality: 1 repo · 1 worktree');
    expect(html).toContain('relay-ide');
    expect(html).toContain('frontend/921-nodes-section');
    expect(html).toContain('/repo/relay-ide');
  });

  it('renders an explicit empty locality state when a node has no report', () => {
    const html = renderToStaticMarkup(
      React.createElement(HubNodeDashboard, {
        now,
        nodes: [node({ nodeId: 'missing-locality' })],
        localityByNode: deriveNodeRepoLocality(inventory()),
      })
    );

    expect(html).toContain('no repo locality reported yet');
  });
});
