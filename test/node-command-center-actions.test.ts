import { describe, expect, it } from 'vitest';
import {
  firstManageableNode,
  firstPendingNodeRequest,
  firstTerminalNode,
  nodeCommandCenterActions,
  nodeCredentialActionUnavailableReason,
  nodeTerminalUnavailableReason,
  pendingNodeRequestReason,
} from '../frontend/src/lib/actions/definitions/node-actions.js';
import type { HubNodeSummary } from '../shared/relay-node-protocol.js';
import type { NodePairingRequestSummary } from '../shared/node-pairing-requests.js';
import { stableCommandNames } from '../shared/cli-gateway-contract.js';

function request(
  state: NodePairingRequestSummary['state']
): NodePairingRequestSummary {
  return {
    requestId: `req-${state}`,
    correlationId: `corr-${state}`,
    deviceCode: 'ABC-123',
    state,
    reasonCode: 'PENDING_PAIRING_REQUESTED',
    displayName: 'work machine',
    platform: 'linux x64',
    relayVersion: '0.0.0-test',
    requestedProfile: 'dev-workstation',
    requestedTrustTier: 'dev',
    requestedCapabilities: ['launch terminal sessions'],
    requestedRoots: ['~/code'],
    requiresExactOperationApproval: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-01T00:10:00.000Z',
  };
}

function node(
  patch: Partial<HubNodeSummary> = {}
): HubNodeSummary {
  return {
    nodeId: 'node-1',
    identity: {
      nodeId: 'node-1',
      displayName: 'work node',
      hostname: 'redacted-host',
      createdAt: '2026-01-01T00:00:00.000Z',
      pairedAt: '2026-01-01T00:00:00.000Z',
    },
    displayName: 'work node',
    hostname: 'redacted-host',
    platform: 'linux',
    arch: 'x64',
    relayVersion: '0.0.0-test',
    protocolVersion: '1.0',
    status: 'online',
    connection: { route: 'reverse-link', status: 'online' },
    trust: { state: 'trusted', level: 'dev', tier: 'dev' },
    credentialState: 'active',
    credential: {
      credentialId: 'cred_public_id',
      issuedAt: '2026-01-01T00:00:00.000Z',
      state: 'active',
      keyBound: true,
    },
    version: {
      state: 'compatible',
      nodeProtocolVersion: '1.0',
      hubProtocolVersion: '1.0',
    },
    capabilities: {
      totals: { available: 1, degraded: 0, unavailable: 0, unknown: 0 },
      core: {
        shell: 'available',
        git: 'available',
        browserAutomation: 'unknown',
        clipboardImage: 'unknown',
        ssh: 'unknown',
        tailscale: 'unknown',
      },
      terminalBackends: { 'relay-pty': 'available' },
      agents: {},
      serviceManager: 'manual',
      wsl: false,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    pairedAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-01T00:00:00.000Z',
    credentialId: 'cred_public_id',
    ...patch,
  };
}

describe('node Command Center action projection', () => {
  it('exposes the required node action family', () => {
    expect(nodeCommandCenterActions.map((action) => action.id)).toEqual([
      'settings.nodes.add-node',
      'settings.nodes.pending-requests',
      'settings.nodes.approve-request',
      'settings.nodes.deny-request',
      'settings.nodes.edit-access',
      'settings.nodes.copy-pair-command',
      'settings.nodes.install-instructions',
      'settings.nodes.open-terminal',
      'settings.nodes.rotate-credential',
      'settings.nodes.revoke',
    ]);
  });

  it('maps executable node actions to stable shared descriptors', () => {
    const descriptors = Object.fromEntries(
      nodeCommandCenterActions.map((action) => [action.id, action.descriptor])
    );

    expect(stableCommandNames()).toEqual(
      expect.arrayContaining([
        'nodes.pair.requests',
        'nodes.pair.approve',
        'nodes.pair.deny',
        'nodes.pair.editAccess',
        'nodes.rotateCredential',
        'nodes.revoke',
      ])
    );
    expect(descriptors['settings.nodes.pending-requests']?.contract?.relayCommandName).toBe(
      'nodes.pair.requests'
    );
    expect(descriptors['settings.nodes.approve-request']?.contract?.relayCommandName).toBe(
      'nodes.pair.approve'
    );
    expect(descriptors['settings.nodes.deny-request']?.contract?.relayCommandName).toBe(
      'nodes.pair.deny'
    );
    expect(descriptors['settings.nodes.edit-access']?.contract?.relayCommandName).toBe(
      'nodes.pair.editAccess'
    );
    expect(descriptors['settings.nodes.open-terminal']?.contract?.relayCommandName).toBe(
      'sessions.create'
    );
    expect(descriptors['settings.nodes.rotate-credential']?.contract?.relayCommandName).toBe(
      'nodes.rotateCredential'
    );
    expect(descriptors['settings.nodes.revoke']?.contract?.relayCommandName).toBe(
      'nodes.revoke'
    );
  });

  it('keeps Settings-only helpers explicitly UI-only', () => {
    for (const id of [
      'settings.nodes.add-node',
      'settings.nodes.copy-pair-command',
      'settings.nodes.install-instructions',
    ]) {
      const descriptor = nodeCommandCenterActions.find((action) => action.id === id)!.descriptor;
      expect(descriptor.source).toBe('ui-action-registry');
      expect(descriptor.stable).toBe(false);
      expect(descriptor.contract).toBeUndefined();
      expect(descriptor.description).toContain('ui-only:');
    }
  });

  it('marks credential/destructive node descriptors as confirmation-gated', () => {
    const approve = nodeCommandCenterActions.find(
      (action) => action.id === 'settings.nodes.approve-request'
    )!.descriptor;
    const rotate = nodeCommandCenterActions.find(
      (action) => action.id === 'settings.nodes.rotate-credential'
    )!.descriptor;
    const revoke = nodeCommandCenterActions.find(
      (action) => action.id === 'settings.nodes.revoke'
    )!.descriptor;

    expect(approve.confirmation.required).toBe(true);
    expect(rotate.confirmation.required).toBe(true);
    expect(revoke.confirmation.required).toBe(true);
    expect(revoke.sideEffect).toBe('destructive');
  });

  it('projects shared unavailable reasons for pending requests and nodes', () => {
    expect(pendingNodeRequestReason(undefined)).toBe('node pairing API unavailable');
    expect(pendingNodeRequestReason([request('expired')])).toBe('no pending request');
    expect(pendingNodeRequestReason([request('pending')])).toBeUndefined();
    expect(firstPendingNodeRequest([request('expired'), request('pending')])?.state).toBe(
      'pending'
    );

    expect(nodeTerminalUnavailableReason(undefined)).toBe('nodes API unavailable');
    expect(nodeTerminalUnavailableReason([node({ status: 'offline' })])).toBe('offline');
    expect(
      nodeTerminalUnavailableReason([
        node({
          capabilities: {
            ...node().capabilities,
            terminalBackends: { 'relay-pty': 'unavailable' },
          },
        }),
      ])
    ).toBe('unsupported capability');
    expect(
      nodeTerminalUnavailableReason([
        node({
          nodeId: 'node-no-terminal',
          capabilities: {
            ...node().capabilities,
            terminalBackends: { 'relay-pty': 'unavailable' },
          },
        }),
        node({ nodeId: 'node-terminal' }),
      ])
    ).toBeUndefined();
    expect(firstTerminalNode([node({ status: 'offline' }), node({ nodeId: 'node-2' })])?.nodeId).toBe(
      'node-2'
    );

    expect(nodeCredentialActionUnavailableReason(undefined)).toBe('nodes API unavailable');
    expect(nodeCredentialActionUnavailableReason([])).toBe('missing approval');
    expect(nodeCredentialActionUnavailableReason([node({ credentialState: 'revoked' })])).toBe(
      'credential revoked'
    );
    expect(firstManageableNode([node({ credentialState: 'revoked' }), node({ nodeId: 'node-2' })])?.nodeId).toBe(
      'node-2'
    );
  });
});
