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
  selectProdTierNodes,
} from '../../frontend/src/lib/state/node-dashboard.js';
import { deriveConfirmationSecurityVisibility } from '../../frontend/src/lib/state/security-visibility.js';
import type { ConfirmationChallenge } from '../../frontend/src/lib/api.js';

const now = new Date('2026-01-02T03:05:00.000Z');
const createdAt = '2026-01-02T03:00:00.000Z';

function policy(
  nodeId: string,
  trustTier: RelayTrustTier = 'dev',
  overrides: Partial<{
    allowed: RelayCapabilityBit[];
    requiresConfirmation: RelayCapabilityBit[];
  }> = {}
) {
  const acl = createLegacyDefaultNodeAcl({ nodeId, trustTier, createdAt });
  return summarizeAcl({
    ...acl,
    grants: {
      allowed: overrides.allowed ?? acl.grants.allowed,
      requiresConfirmation:
        overrides.requiresConfirmation ?? acl.grants.requiresConfirmation,
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

    // #597 added `logs:read` to the capability bit set; counts shift by 1
    // in every tier (denied in sandbox, allowed in dev, denied in prod).
    // #592 added `session:control:kill` following the same tier pattern:
    // allowed in dev, denied in sandbox + prod.
    // #704 added two typed supervisor action bits; all default node tiers
    // deny them unless a user grants the scoped supervisor capabilities.
    // #765 / ADR-019 added four context/inbox bits (context/inbox read+write):
    // dev silent-allows all four (default-allowed grant set), sandbox denies
    // all four (grants nothing), and the prod fixture below denies all four
    // because it does not grant them — but crucially challenge stays at 2:
    // the writes are NOT high-risk, so prod never promotes them to a
    // confirmation challenge (the headless ack loop is not gated).
    // #807 added three high-risk approval contract bits (node ACL widening,
    // credential export, destructive node lifecycle). They are denied in these
    // fixtures unless explicitly granted/challenged, so challenge remains at 2.
    // #814 added `node:pair-token:create` for grant-backed node bootstrap; it
    // is denied by these node policy fixtures unless explicitly delegated.
    expect(
      rows.map((row) => [row.security.trustTier, row.security.postureLabel])
    ).toEqual([
      ['sandbox', 'allow 1 · challenge 0 · deny 26'],
      ['dev', 'allow 15 · challenge 0 · deny 12'],
      ['prod', 'allow 1 · challenge 2 · deny 24'],
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
      highRiskLabel: 'audit: open audit tab',
      auditLabel: 'audit visibility: open audit tab',
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
            policy: {
              ...policy('superseded-node'),
              supersededBy: 'acl:superseding:1.0',
            },
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
    expect(
      rows.every(
        (row) => row.security.denyBits.length === RELAY_CAPABILITY_BITS.length
      )
    ).toBe(true);
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

describe('selectProdTierNodes', () => {
  it('returns empty array for empty input', () => {
    expect(selectProdTierNodes([])).toEqual([]);
  });

  it('returns empty array when the only node is dev-tier', () => {
    const devNode = node({
      trust: { state: 'trusted', level: 'dev', tier: 'dev', policy: policy('node-1', 'dev') },
    });
    expect(selectProdTierNodes([devNode])).toEqual([]);
  });

  it('returns a prod-tier online node', () => {
    const prodNode = node({
      nodeId: 'prod-1',
      status: 'online',
      trust: { state: 'trusted', level: 'prod', tier: 'prod', policy: policy('prod-1', 'prod') },
    });
    expect(selectProdTierNodes([prodNode])).toEqual([prodNode]);
  });

  it('excludes revoked prod-tier nodes', () => {
    const revokedProd = node({
      nodeId: 'prod-revoked',
      status: 'revoked',
      trust: { state: 'trusted', level: 'prod', tier: 'prod', policy: policy('prod-revoked', 'prod') },
    });
    expect(selectProdTierNodes([revokedProd])).toEqual([]);
  });

  it('returns only live prod nodes from a mixed set', () => {
    const devNode = node({
      nodeId: 'dev-1',
      status: 'online',
      trust: { state: 'trusted', level: 'dev', tier: 'dev', policy: policy('dev-1', 'dev') },
    });
    const prodNode = node({
      nodeId: 'prod-1',
      status: 'online',
      trust: { state: 'trusted', level: 'prod', tier: 'prod', policy: policy('prod-1', 'prod') },
    });
    const revokedProd = node({
      nodeId: 'prod-revoked',
      status: 'revoked',
      trust: { state: 'trusted', level: 'prod', tier: 'prod', policy: policy('prod-revoked', 'prod') },
    });
    const result = selectProdTierNodes([devNode, prodNode, revokedProd]);
    expect(result).toHaveLength(1);
    expect(result[0]?.nodeId).toBe('prod-1');
  });

  it('matches prod nodes via trust.policy.trustTier fallback when trust.tier is absent', () => {
    const noTierNode = node({
      nodeId: 'prod-fallback',
      status: 'online',
      trust: {
        state: 'trusted',
        level: 'prod',
        // intentionally no `tier` field — only policy carries it
        policy: policy('prod-fallback', 'prod'),
      },
    });
    // Strip out `tier` so the fallback path is exercised
    delete (noTierNode.trust as Record<string, unknown>)['tier'];
    expect(selectProdTierNodes([noTierNode])).toEqual([noTierNode]);
  });

  it('excludes prod node with policy.revokedAt set (revoked policy)', () => {
    const revokedPolicyNode = node({
      nodeId: 'prod-revoked-policy',
      status: 'online',
      trust: {
        state: 'trusted',
        level: 'prod',
        tier: 'prod',
        policy: { ...policy('prod-revoked-policy', 'prod'), revokedAt: createdAt },
      },
    });
    expect(selectProdTierNodes([revokedPolicyNode])).toEqual([]);
  });

  it('excludes prod node with policy.supersededBy set', () => {
    const supersededNode = node({
      nodeId: 'prod-superseded',
      status: 'online',
      trust: {
        state: 'trusted',
        level: 'prod',
        tier: 'prod',
        policy: { ...policy('prod-superseded', 'prod'), supersededBy: 'acl:replacement:1.0' },
      },
    });
    expect(selectProdTierNodes([supersededNode])).toEqual([]);
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
