import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { HubNodeSummary } from '../../shared/relay-node-protocol.js';
import type { NodePairingRequestSummary } from '../../shared/node-pairing-requests.js';
import {
  groupSettingsNodes,
  PairedNodeCard,
  PendingNodeRequestCard,
} from '../../frontend/src/components/dialogs/SettingsNodesSection.js';

const SECRET_HOST = 'donovans-secret-macbook.tailnet.ts.net';
const SECRET_TOKEN = 'pair_SECRET123';

function request(
  overrides: Partial<NodePairingRequestSummary> = {}
): NodePairingRequestSummary {
  return {
    requestId: 'ppreq_1',
    correlationId: 'corr_1',
    deviceCode: '7KQ-M2P',
    state: 'pending',
    reasonCode: 'PENDING_PAIRING_REQUESTED',
    displayName: 'work-mac',
    platform: 'macOS arm64',
    relayVersion: '0.1.0-nightly',
    requestedProfile: 'dev-workstation',
    requestedTrustTier: 'dev',
    requestedCapabilities: [
      'launch terminal sessions',
      'read approved repo roots',
      'run git',
    ],
    requestedRoots: ['~/code'],
    requiresExactOperationApproval: false,
    publicKeyFingerprint: 'nkey_0123456789abcdef',
    sourceDiagnostics: {
      state: 'source-match',
      policy: 'audit',
      reasonCode: 'SOURCE_MATCH',
      observedAt: '2026-06-19T12:00:00.000Z',
      sourceFingerprint: 'src_a1b2c3d4',
      displayHint: 'same tailnet',
    },
    createdAt: '2026-06-19T12:00:00.000Z',
    expiresAt: '2026-06-19T12:10:00.000Z',
    ...overrides,
  };
}

function node(overrides: Partial<HubNodeSummary> = {}): HubNodeSummary {
  return {
    nodeId: 'node_1234567890abcdef',
    identity: {
      nodeId: 'node_1234567890abcdef',
      displayName: 'dev mac',
      hostname: SECRET_HOST,
      createdAt: '2026-06-19T11:00:00.000Z',
      pairedAt: '2026-06-19T11:01:00.000Z',
    },
    displayName: 'dev mac',
    hostname: SECRET_HOST,
    platform: 'darwin',
    arch: 'arm64',
    relayVersion: '0.1.0-nightly',
    protocolVersion: '1.0',
    status: 'online',
    connection: { route: 'reverse-link', status: 'connected' },
    trust: {
      state: 'trusted',
      level: 'standard',
      tier: 'dev',
      policy: {
        policyVersion: '1.0',
        ref: 'acl_safe_ref',
        trustTier: 'dev',
        allowed: ['session:create:terminal', 'rpc:git:read'],
        requiresConfirmation: [],
        scope: { kind: 'path', pathPrefixes: ['~/code'] },
      },
    },
    credentialState: 'active',
    credential: {
      credentialId: 'cred_safe',
      issuedAt: '2026-06-19T11:01:00.000Z',
      state: 'active',
      keyBound: true,
      publicKeyFingerprint: 'nkey_0123456789abcdef',
    },
    version: {
      state: 'compatible',
      nodeProtocolVersion: '1.0',
      hubProtocolVersion: '1.0',
    },
    capabilities: {
      totals: { available: 4, degraded: 0, unavailable: 0, unknown: 0 },
      core: {
        shell: 'available',
        git: 'available',
        browserAutomation: 'unknown',
        clipboardImage: 'unknown',
        ssh: 'unknown',
        tailscale: 'available',
      },
      terminalBackends: { 'relay-pty': 'available' },
      agents: { claude: 'available' },
      serviceManager: 'launchd',
      wsl: false,
    },
    sourceDiagnostics: {
      state: 'source-match',
      policy: 'audit',
      reasonCode: 'SOURCE_MATCH',
      observedAt: '2026-06-19T12:00:00.000Z',
      sourceFingerprint: 'src_a1b2c3d4',
      displayHint: 'same tailnet',
    },
    createdAt: '2026-06-19T11:00:00.000Z',
    pairedAt: '2026-06-19T11:01:00.000Z',
    lastSeenAt: new Date().toISOString(),
    credentialId: 'cred_safe',
    ...overrides,
  };
}

describe('SettingsNodesSection cards', () => {
  it('renders pending request metadata and actions without raw secrets or hostnames', () => {
    const html = renderToStaticMarkup(
      React.createElement(PendingNodeRequestCard, {
        request: request({ displayName: `work-mac ${SECRET_TOKEN}` }),
      })
    );

    expect(html).toContain('work-mac');
    expect(html).toContain('requested access');
    expect(html).toContain('approve');
    expect(html).toContain('deny');
    expect(html).toContain('approved nodes can execute code');
    expect(html).not.toContain(SECRET_HOST);
    expect(html).not.toContain('tailnet.ts.net');
    expect(html).not.toContain('rpc:git:read');
  });

  it('disables stale terminal requests and exposes safe revoke copy for paired nodes', () => {
    const html = renderToStaticMarkup(
      React.createElement(PairedNodeCard, {
        node: node({ status: 'offline' }),
      })
    );

    expect(html).toContain('offline');
    expect(html).toContain('routed sessions unavailable');
    expect(html).toContain('revoke unavailable');
    expect(html).toContain('local files on that machine are not deleted');
    expect(html).not.toContain(SECRET_HOST);
    expect(html).not.toContain('tailnet.ts.net');
    expect(html).not.toContain(SECRET_TOKEN);
  });

  it('orders node attention groups for rotation, degraded, offline, online, revoked', () => {
    const groups = groupSettingsNodes([
      node({ nodeId: 'online', displayName: 'online' }),
      node({ nodeId: 'revoked', displayName: 'revoked', status: 'revoked' }),
      node({ nodeId: 'offline', displayName: 'offline', status: 'offline' }),
      node({
        nodeId: 'degraded',
        displayName: 'degraded',
        helperSkew: {
          category: 'minor-skew-warn',
          helperVersion: '0.1.0',
          hubVersion: '0.2.0',
          message: 'update recommended',
        },
      }),
      node({
        nodeId: 'rotating',
        displayName: 'rotating',
        credentialState: 'rotation-failed',
      }),
    ]);

    expect(groups.map((group) => group.key)).toEqual([
      'needs-attention',
      'degraded',
      'offline-stale',
      'online',
      'revoked',
    ]);
  });
});
