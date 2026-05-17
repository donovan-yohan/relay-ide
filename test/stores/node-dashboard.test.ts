import { describe, expect, it } from 'vitest';
import type { HubNodeSummary } from '../../shared/relay-node-protocol.js';
import {
  createLegacyDefaultNodeAcl,
  RELAY_CAPABILITY_BITS,
  summarizeAcl,
  type RelayCapabilityBit,
  type RelayTrustTier,
} from '../../shared/security-policy.js';
import {
  deriveHubNodeDashboardRows,
  hubNodeDashboardSummary,
} from '../../frontend/src/lib/state/node-dashboard.js';
import { deriveConfirmationSecurityVisibility } from '../../frontend/src/lib/state/security-visibility.js';
import type { ConfirmationChallenge } from '../../frontend/src/lib/api.js';

const now = new Date('2026-01-02T03:05:00.000Z');
const createdAt = '2026-01-02T03:00:00.000Z';

function policy(
  nodeId: string,
  trustTier: RelayTrustTier = 'dev',
  overrides: Partial<{ allowed: RelayCapabilityBit[]; requiresConfirmation: RelayCapabilityBit[] }> = {}
) {
  const acl = createLegacyDefaultNodeAcl({ nodeId, trustTier, createdAt });
  return summarizeAcl({
    ...acl,
    grants: {
      allowed: overrides.allowed ?? acl.grants.allowed,
      requiresConfirmation: overrides.requiresConfirmation ?? acl.grants.requiresConfirmation,
    },
  });
}

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
    trust: {
      state: 'trusted',
      level: 'dev',
      tier: 'dev',
      policy: policy('node-1'),
    },
    credentialState: 'active',
    version: {
      state: 'compatible',
      nodeProtocolVersion: '1.0',
      hubProtocolVersion: '1.0',
    },
    createdAt: '2026-01-02T03:00:00.000Z',
    pairedAt: '2026-01-02T03:00:00.000Z',
    lastSeenAt: '2026-01-02T03:04:30.000Z',
    credentialId: 'cred-1',
    ...overrides,
  };
}

function confirmationChallenge(
  overrides: Partial<ConfirmationChallenge> = {}
): ConfirmationChallenge {
  return {
    challengeId: 'challenge-1',
    status: 'pending',
    nodeId: 'node-1',
    intent: { action: 'rpc.fs.delete', target: '/tmp/nope' },
    requiredBits: ['session:read', 'rpc:fs:delete'],
    challengeBits: ['rpc:fs:delete'],
    canonicalParams: { action: 'rpc.fs.delete', path: '/tmp/nope' },
    canonicalParamsHash: 'abc123',
    createdAt,
    expiresAt: '2026-01-02T03:10:00.000Z',
    failedRedemptions: 0,
    maxFailedRedemptions: 3,
    reasonCode: 'POLICY_CONFIRMATION_REQUIRED',
    message: 'confirmation required',
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

  it('honors an explicit capabilities.worktrees override (future repo feature contract)', () => {
    // When a repo feature decorator publishes capabilities.worktrees,
    // that value wins over the core.git fallback. Verify the precedence
    // by pinning git=available but worktrees=degraded — derived would
    // be 'available', explicit override should produce 'degraded'.
    const [row] = deriveHubNodeDashboardRows(
      [
        node({
          capabilities: {
            ...node().capabilities,
            worktrees: 'degraded',
          },
        }),
      ],
      { now }
    );

    expect(row.capabilityHints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'git', status: 'available' }),
        expect.objectContaining({ label: 'worktrees', status: 'degraded' }),
      ])
    );
  });

  it('falls back to deriving worktrees status from core.git when no explicit override is set', () => {
    // Inverse of the above — explicit absence on a node where core.git
    // is 'degraded' should produce a 'degraded' worktrees hint.
    const [row] = deriveHubNodeDashboardRows(
      [
        node({
          capabilities: {
            ...node().capabilities,
            core: { ...node().capabilities.core, git: 'degraded' },
          },
        }),
      ],
      { now }
    );

    expect(row.capabilityHints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'git', status: 'degraded' }),
        expect.objectContaining({ label: 'worktrees', status: 'degraded' }),
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

  it('summarizes sandbox, dev, and prod policy posture with prod high-risk challenge distinct', () => {
    const rows = deriveHubNodeDashboardRows(
      [
        node({
          nodeId: 'sandbox-node',
          displayName: 'sandbox node',
          trust: {
            state: 'trusted',
            level: 'sandbox',
            tier: 'sandbox',
            policy: policy('sandbox-node', 'sandbox', {
              allowed: ['session:read'],
              requiresConfirmation: [],
            }),
          },
        }),
        node({
          nodeId: 'dev-node',
          displayName: 'dev node',
          trust: {
            state: 'trusted',
            level: 'dev',
            tier: 'dev',
            policy: policy('dev-node', 'dev'),
          },
        }),
        node({
          nodeId: 'prod-node',
          displayName: 'prod node',
          trust: {
            state: 'trusted',
            level: 'prod',
            tier: 'prod',
            policy: policy('prod-node', 'prod', {
              allowed: ['session:read'],
              requiresConfirmation: ['rpc:fs:delete', 'pty:exec:arbitrary'],
            }),
          },
        }),
      ],
      { now }
    );

    expect(rows.map((row) => [row.security.trustTier, row.security.postureLabel])).toEqual([
      ['sandbox', 'allow 1 · challenge 0 · deny 14'],
      ['dev', 'allow 8 · challenge 0 · deny 7'],
      ['prod', 'allow 1 · challenge 2 · deny 12'],
    ]);
    expect(rows[2].security).toMatchObject({
      tone: 'danger',
      highRiskLabel: 'prod high-risk: 2 require challenge',
    });
  });

  it('shows an honest audit cli affordance when policy visibility is unavailable', () => {
    const [row] = deriveHubNodeDashboardRows(
      [
        node({
          trust: {
            state: 'paired',
            level: 'standard',
            warning: 'legacy pairing without acl summary',
          },
        }),
      ],
      { now }
    );

    expect(row.security).toMatchObject({
      trustTier: 'unknown',
      policyRef: null,
      postureLabel: 'policy unavailable · capability grants hidden',
      highRiskLabel: 'audit: cli only · relay-ide audit verify',
      auditLabel: 'audit visibility: run relay-ide audit verify --db ~/.config/relay-ide/security-audit.db',
    });
  });

  it('treats revoked and superseded policy summaries as backend-denied posture', () => {
    const rows = deriveHubNodeDashboardRows(
      [
        node({
          nodeId: 'revoked-node',
          trust: {
            state: 'trusted',
            level: 'dev',
            tier: 'dev',
            policy: { ...policy('revoked-node'), revokedAt: createdAt },
          },
        }),
        node({
          nodeId: 'superseded-node',
          trust: {
            state: 'trusted',
            level: 'dev',
            tier: 'dev',
            policy: { ...policy('superseded-node'), supersededBy: 'acl:superseding:1.0' },
          },
        }),
      ],
      { now }
    );

    expect(rows.map((row) => row.disabledReason)).toEqual([
      'work disabled: policy revoked',
      'work disabled: policy superseded',
    ]);
    expect(rows.map((row) => row.security.postureLabel)).toEqual([
      `policy revoked · deny ${RELAY_CAPABILITY_BITS.length}`,
      `policy superseded · deny ${RELAY_CAPABILITY_BITS.length}`,
    ]);
    expect(rows.map((row) => row.security.tone)).toEqual(['danger', 'danger']);
    expect(rows.every((row) => row.security.denyBits.length === RELAY_CAPABILITY_BITS.length)).toBe(true);
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
      '1/3 nodes ready · 1 blocked by capabilities · 1 offline/stale · 0 policy unavailable · 0 prod high-risk'
    );
  });
});

describe('confirmation security visibility state', () => {
  it('groups allow, challenge, and deny posture from challenge plus node policy', () => {
    const view = deriveConfirmationSecurityVisibility(
      confirmationChallenge({
        requiredBits: ['session:read', 'rpc:fs:delete', 'rpc:git:write'],
        challengeBits: ['rpc:fs:delete'],
      }),
      node({
        trust: {
          state: 'trusted',
          level: 'prod',
          tier: 'prod',
          policy: policy('node-1', 'prod', {
            allowed: ['session:read'],
            requiresConfirmation: ['rpc:fs:delete'],
          }),
        },
      })
    );

    expect(view).toMatchObject({
      nodeLabel: 'dev mac (node-1)',
      trustTier: 'prod',
      policyRef: 'acl:node-1:1.0',
      postureLabel: 'challenge required · allow 1 · challenge 1 · deny 1',
      allowedBits: ['session:read'],
      challengeBits: ['rpc:fs:delete'],
      deniedBits: ['rpc:git:write'],
      unknownBits: [],
      tone: 'danger',
    });
  });

  it('preserves every required bit when the policy summary is unavailable', () => {
    const view = deriveConfirmationSecurityVisibility(
      confirmationChallenge({
        requiredBits: ['session:read', 'rpc:fs:delete', 'rpc:git:write'],
        challengeBits: ['rpc:fs:delete'],
      })
    );

    expect(view).toMatchObject({
      nodeLabel: 'node-1',
      trustTier: 'unknown',
      policyRef: null,
      postureLabel: 'policy unavailable · challenge 1 · unknown 2',
      allowedBits: [],
      challengeBits: ['rpc:fs:delete'],
      deniedBits: [],
      unknownBits: ['session:read', 'rpc:git:write'],
      tone: 'danger',
    });
  });

  it('fails closed when a confirmation sees a revoked policy summary', () => {
    const view = deriveConfirmationSecurityVisibility(
      confirmationChallenge({
        requiredBits: ['session:read', 'rpc:fs:delete'],
        challengeBits: ['rpc:fs:delete'],
      }),
      node({
        trust: {
          state: 'trusted',
          level: 'dev',
          tier: 'dev',
          policy: { ...policy('node-1'), revokedAt: createdAt },
        },
      })
    );

    expect(view).toMatchObject({
      policyRef: 'acl:node-1:1.0',
      postureLabel: 'policy revoked · deny 2',
      allowedBits: [],
      challengeBits: [],
      deniedBits: ['session:read', 'rpc:fs:delete'],
      unknownBits: [],
      tone: 'danger',
    });
  });
});
