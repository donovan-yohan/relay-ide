import { describe, expect, it } from 'vitest';
import {
  appendPolicyAudit,
  auditEntryForPolicyDecision,
  evaluateHubPolicy,
  policyDecisionToRelayError,
  requiredCapabilitiesForRpcIntent,
  revokePolicyAffectedSessions,
  sessionCreateCapabilities,
} from '../server/hub-policy-evaluator.js';
import { createSessionEnvelopeRegistry } from '../server/session-envelope-registry.js';
import {
  createLegacyDefaultNodeAcl,
  summarizeAcl,
  type RelayCapabilityBit,
  type RelayNodeAcl,
  type RelayPolicyScope,
  type RelayTrustTier,
} from '../shared/security-policy.js';
import { createRoutedNodeSessionEnvelope } from '../shared/session-envelope.js';
import type { SecurityAuditEntryInput } from '../shared/security-audit.js';
import type { HubNodeSummary } from '../shared/relay-node-protocol.js';

const NOW = new Date('2026-01-02T03:04:05.000Z');

function nodeSummary(
  input: {
    nodeId?: string;
    trustTier?: RelayTrustTier;
    allowed?: RelayCapabilityBit[];
    requiresConfirmation?: RelayCapabilityBit[];
    scope?: RelayPolicyScope;
    revoked?: boolean;
  } = {}
): HubNodeSummary {
  const nodeId = input.nodeId ?? 'node_a';
  const acl: RelayNodeAcl = {
    ...createLegacyDefaultNodeAcl({
      nodeId,
      credentialId: `${nodeId}_cred`,
      createdAt: NOW.toISOString(),
      trustTier: input.trustTier ?? 'dev',
    }),
  };
  if (input.allowed || input.requiresConfirmation) {
    acl.grants = {
      allowed: input.allowed ?? [],
      requiresConfirmation: input.requiresConfirmation ?? [],
    };
  }
  if (input.scope) acl.scope = input.scope;
  return {
    nodeId,
    identity: {
      nodeId,
      displayName: nodeId,
      hostname: `${nodeId}.example`,
      createdAt: NOW.toISOString(),
      pairedAt: NOW.toISOString(),
    },
    displayName: nodeId,
    hostname: `${nodeId}.example`,
    platform: 'linux',
    arch: 'x64',
    relayVersion: '0.1.0-test',
    protocolVersion: '1.0',
    status: input.revoked ? 'revoked' : 'online',
    connection: {
      route: 'reverse-link',
      status: input.revoked ? 'revoked' : 'connected',
    },
    trust: {
      state: input.revoked ? 'revoked' : 'active',
      level: input.trustTier ?? 'dev',
      tier: input.trustTier ?? 'dev',
      policy: summarizeAcl(acl),
    },
    credentialState: input.revoked ? 'revoked' : 'active',
    credential: {
      credentialId: `${nodeId}_cred`,
      issuedAt: NOW.toISOString(),
      state: input.revoked ? 'revoked' : 'active',
      keyBound: false,
    },
    version: {
      state: 'compatible',
      nodeProtocolVersion: '1.0',
      hubProtocolVersion: '1.0',
    },
    capabilities: {
      totals: { available: 2, degraded: 0, unavailable: 0, unknown: 0 },
      core: {
        shell: 'available',
        git: 'available',
        browserAutomation: 'unavailable',
        clipboardImage: 'unavailable',
        ssh: 'unavailable',
        tailscale: 'unavailable',
      },
      agents: {},
      serviceManager: 'systemd-user',
      wsl: false,
    },
    createdAt: NOW.toISOString(),
    pairedAt: NOW.toISOString(),
    lastSeenAt: NOW.toISOString(),
    credentialId: `${nodeId}_cred`,
  };
}

function baseInput(
  overrides: Partial<Parameters<typeof evaluateHubPolicy>[0]> = {}
) {
  const node = nodeSummary();
  return {
    peer: { kind: 'hub' as const },
    node,
    nodeId: node.nodeId,
    intent: { action: 'sessions.create', target: node.nodeId },
    scope: { kind: 'node' as const, nodeId: node.nodeId, cwd: '/srv/relay' },
    requiredCapabilities: ['session:create:terminal'],
    now: NOW,
    ...overrides,
  };
}

describe('hub policy evaluator', () => {
  it('allows explicitly granted session capabilities and emits a grant audit entry', () => {
    const decision = evaluateHubPolicy(baseInput());
    expect(decision).toMatchObject({
      decision: 'allow',
      reasonCode: 'POLICY_ALLOWED',
      grantedBits: ['session:create:terminal'],
      deniedBits: [],
    });

    const audit = auditEntryForPolicyDecision(decision);
    expect(audit).toMatchObject({
      eventType: 'grant',
      decision: 'allow',
      reasonCode: 'POLICY_ALLOWED',
      peer: { kind: 'hub' },
      node: { nodeId: 'node_a', trustTier: 'dev' },
      requiredBits: ['session:create:terminal'],
      grantedBits: ['session:create:terminal'],
      deniedBits: [],
    });
  });

  it('fails closed for unknown capability bits before granting known bits', () => {
    const decision = evaluateHubPolicy(
      baseInput({
        requiredCapabilities: ['session:read', 'rpc:fs:format-disk'],
      })
    );
    expect(decision).toMatchObject({
      decision: 'deny',
      reasonCode: 'POLICY_UNKNOWN_CAPABILITY',
      requiredBits: ['session:read'],
      unknownBits: ['rpc:fs:format-disk'],
    });
  });

  it('maps unknown RPC intents to an unknown capability so callers fail closed', () => {
    const required = requiredCapabilitiesForRpcIntent('rpc.fs.format-disk');
    expect(required).toEqual(['rpc:unknown:rpc.fs.format-disk']);

    expect(
      evaluateHubPolicy(baseInput({ requiredCapabilities: required }))
    ).toMatchObject({
      decision: 'deny',
      reasonCode: 'POLICY_UNKNOWN_CAPABILITY',
      unknownBits: ['rpc:unknown:rpc.fs.format-disk'],
    });
  });

  it('maps routed session kill to the explicit high-risk control capability', () => {
    expect(requiredCapabilitiesForRpcIntent('sessions.kill')).toEqual([
      'session:control:kill',
    ]);

    expect(
      evaluateHubPolicy(baseInput({ requiredCapabilities: ['session:attach'] }))
    ).toMatchObject({
      decision: 'allow',
      grantedBits: ['session:attach'],
    });
    expect(
      evaluateHubPolicy(
        baseInput({
          intent: { action: 'sessions.kill', target: 'node_a' },
          requiredCapabilities:
            requiredCapabilitiesForRpcIntent('sessions.kill'),
        })
      )
    ).toMatchObject({
      decision: 'allow',
      reasonCode: 'POLICY_ALLOWED',
      grantedBits: ['session:control:kill'],
    });

    const attachOnlyNode = nodeSummary({
      allowed: ['session:read', 'session:attach'],
    });
    expect(
      evaluateHubPolicy(
        baseInput({
          node: attachOnlyNode,
          intent: { action: 'sessions.kill', target: 'node_a' },
          requiredCapabilities:
            requiredCapabilitiesForRpcIntent('sessions.kill'),
        })
      )
    ).toMatchObject({
      decision: 'deny',
      reasonCode: 'POLICY_CAPABILITY_DENIED',
      deniedBits: ['session:control:kill'],
    });
  });

  it('canonicalizes path ACL comparisons before checking prefixes', () => {
    const node = nodeSummary({
      scope: { kind: 'path', pathPrefixes: ['/srv/allowed'] },
      allowed: ['session:create:terminal'],
    });

    expect(
      evaluateHubPolicy(
        baseInput({
          node,
          scope: {
            kind: 'node-cwd',
            nodeId: node.nodeId,
            cwd: '/srv/allowed/project',
          },
        })
      )
    ).toMatchObject({ decision: 'allow' });

    expect(
      evaluateHubPolicy(
        baseInput({
          node,
          scope: {
            kind: 'node-cwd',
            nodeId: node.nodeId,
            cwd: '/srv/allowed/../outside',
          },
        })
      )
    ).toMatchObject({ decision: 'deny', reasonCode: 'POLICY_SCOPE_DENIED' });

    expect(
      evaluateHubPolicy(
        baseInput({
          node,
          scope: {
            kind: 'node-cwd',
            nodeId: node.nodeId,
            cwd: '../allowed/project',
          },
        })
      )
    ).toMatchObject({ decision: 'deny', reasonCode: 'POLICY_SCOPE_DENIED' });
  });

  it('preserves typed relay errors for policy lifecycle failures', () => {
    const expired = evaluateHubPolicy(
      baseInput({ expiresAt: '2026-01-02T03:04:04.000Z', sessionId: 's1' })
    );
    expect(policyDecisionToRelayError(expired)).toMatchObject({
      code: 'SESSION_EXPIRED',
    });
  });

  it('returns challenge for prod high-risk capabilities after trust-tier overlay', () => {
    const node = nodeSummary({
      trustTier: 'prod',
      allowed: ['session:read', 'rpc:fs:write'],
    });
    const decision = evaluateHubPolicy(
      baseInput({
        node,
        requiredCapabilities: ['rpc:fs:write'],
        intent: { action: 'rpc.fs.write', target: node.nodeId },
      })
    );
    expect(decision).toMatchObject({
      decision: 'challenge',
      reasonCode: 'POLICY_CHALLENGE_REQUIRED',
      challengeBits: ['rpc:fs:write'],
    });
  });

  it('denies scope mismatches and node-originated envelopes acting as another node', () => {
    expect(
      evaluateHubPolicy(
        baseInput({
          scope: { kind: 'node', nodeId: 'node_b', cwd: '/srv/relay' },
        })
      )
    ).toMatchObject({
      decision: 'deny',
      reasonCode: 'POLICY_SCOPE_NODE_MISMATCH',
    });

    expect(
      evaluateHubPolicy(baseInput({ peer: { kind: 'node', nodeId: 'node_b' } }))
    ).toMatchObject({
      decision: 'deny',
      reasonCode: 'POLICY_PEER_NODE_MISMATCH',
    });

    expect(
      evaluateHubPolicy(
        baseInput({
          peer: { kind: 'node', nodeId: 'node_a', credentialId: 'stale_cred' },
        })
      )
    ).toMatchObject({
      decision: 'deny',
      reasonCode: 'POLICY_PEER_CREDENTIAL_MISMATCH',
    });
  });

  it('denies expired and revoked session lifecycles', () => {
    expect(
      evaluateHubPolicy(
        baseInput({ expiresAt: '2026-01-02T03:04:04.000Z', sessionId: 's1' })
      )
    ).toMatchObject({
      decision: 'revoke',
      reasonCode: 'POLICY_SESSION_EXPIRED',
    });

    expect(
      evaluateHubPolicy(
        baseInput({ revokedAt: '2026-01-02T03:04:04.000Z', sessionId: 's1' })
      )
    ).toMatchObject({
      decision: 'revoke',
      reasonCode: 'POLICY_SESSION_REVOKED',
    });
  });

  it('keeps multi-node authorization independent', () => {
    const nodeA = nodeSummary({ nodeId: 'node_a', allowed: ['session:read'] });
    const nodeB = nodeSummary({
      nodeId: 'node_b',
      allowed: ['session:create:terminal'],
    });

    expect(
      evaluateHubPolicy(
        baseInput({
          node: nodeA,
          nodeId: 'node_a',
          requiredCapabilities: ['session:create:terminal'],
        })
      )
    ).toMatchObject({
      decision: 'deny',
      reasonCode: 'POLICY_CAPABILITY_DENIED',
    });
    expect(
      evaluateHubPolicy(
        baseInput({
          node: nodeB,
          nodeId: 'node_b',
          scope: { kind: 'node', nodeId: 'node_b', cwd: '/srv/relay' },
          requiredCapabilities: ['session:create:terminal'],
        })
      )
    ).toMatchObject({ decision: 'allow' });
  });

  it('revokes active node sessions and emits typed revocation audit events', () => {
    const envelopes = createSessionEnvelopeRegistry();
    envelopes.upsert(
      createRoutedNodeSessionEnvelope({
        nodeId: 'node_a',
        sessionId: 's1',
        cwd: '/srv/relay',
        repoPath: '/srv/relay',
        issuedAt: NOW.toISOString(),
      })
    );
    envelopes.upsert(
      createRoutedNodeSessionEnvelope({
        nodeId: 'node_b',
        sessionId: 's2',
        cwd: '/srv/other',
        issuedAt: NOW.toISOString(),
      })
    );
    const auditEntries: SecurityAuditEntryInput[] = [];
    const revoked = revokePolicyAffectedSessions({
      envelopes,
      nodeId: 'node_a',
      node: nodeSummary({ nodeId: 'node_a', revoked: true }),
      reason: 'node-revoked',
      now: NOW,
      auditSink: { append: (entry) => auditEntries.push(entry) },
    });

    expect(revoked.map((session) => session.sessionId)).toEqual(['s1']);
    expect(
      envelopes.validate({ nodeId: 'node_a', sessionId: 's1', now: NOW })
    ).toMatchObject({
      ok: false,
      error: { code: 'SESSION_REVOKED' },
    });
    expect(
      envelopes.validate({ nodeId: 'node_b', sessionId: 's2', now: NOW })
    ).toMatchObject({
      ok: true,
    });
    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0]).toMatchObject({
      eventType: 'revocation',
      decision: 'revoked',
      reasonCode: 'POLICY_SESSION_REVOKED',
      sessionId: 's1',
      intent: { action: 'sessions.revalidate', target: 'node_a' },
    });
  });

  it('maps read-only File RPC intents to read/list/tail capability bits', () => {
    expect(requiredCapabilitiesForRpcIntent('rpc.fs.list')).toEqual([
      'rpc:fs:list',
    ]);
    expect(requiredCapabilitiesForRpcIntent('rpc.fs.stat')).toEqual([
      'rpc:fs:read',
    ]);
    expect(requiredCapabilitiesForRpcIntent('rpc.fs.read')).toEqual([
      'rpc:fs:read',
    ]);
    expect(requiredCapabilitiesForRpcIntent('rpc.fs.tail')).toEqual([
      'rpc:fs:tail',
    ]);
  });

  it('separates tab intervention capabilities from file/git/exec powers', () => {
    expect(
      requiredCapabilitiesForRpcIntent('sessions.interventions.read')
    ).toEqual(['session:read', 'tab:intervention:read']);
    expect(
      requiredCapabilitiesForRpcIntent('sessions.control.set-agent')
    ).toEqual(['rpc:unknown:sessions.control.set-agent']);
    expect(
      sessionCreateCapabilities({
        sessionType: 'terminal',
        controlMode: 'agent-driven',
      })
    ).toEqual(['session:create:terminal']);
    expect(sessionCreateCapabilities({ sessionType: 'terminal' })).toEqual([
      'session:create:terminal',
    ]);
    expect(
      sessionCreateCapabilities({
        sessionType: 'terminal',
        controlMode: 'lol-nope',
      })
    ).toEqual(['session:create:terminal']);
    expect(
      evaluateHubPolicy(
        baseInput({
          requiredCapabilities: sessionCreateCapabilities({
            sessionType: 'terminal',
            controlMode: 'lol-nope',
          }),
        })
      )
    ).toMatchObject({
      decision: 'allow',
      grantedBits: ['session:create:terminal'],
    });
    expect(
      sessionCreateCapabilities({
        sessionType: 'terminal',
        controlMode: 'human-driven',
      })
    ).toEqual(['session:create:terminal']);
    expect(
      sessionCreateCapabilities({
        sessionType: 'terminal',
        controlMode: 'human-driven',
      })
    ).toEqual(['session:create:terminal']);
  });

  it('denies File RPC when the node ACL lacks the required read-only capability', () => {
    const node = nodeSummary({ allowed: ['session:read'] });
    const decision = evaluateHubPolicy(
      baseInput({
        node,
        intent: { action: 'rpc.fs.read', target: node.nodeId },
        requiredCapabilities: requiredCapabilitiesForRpcIntent('rpc.fs.read'),
        scope: {
          kind: 'repo',
          nodeId: node.nodeId,
          cwd: '/srv/relay',
          repoPath: '/srv/relay',
        },
        sessionId: 's1',
      })
    );
    expect(decision).toMatchObject({
      decision: 'deny',
      reasonCode: 'POLICY_CAPABILITY_DENIED',
      deniedBits: ['rpc:fs:read'],
    });
    expect(policyDecisionToRelayError(decision)).toMatchObject({
      code: 'UNAUTHORIZED',
      details: {
        reasonCode: 'POLICY_CAPABILITY_DENIED',
        deniedBits: ['rpc:fs:read'],
      },
    });
  });

  it('fails closed when audit persistence fails for high-risk decisions', () => {
    const node = nodeSummary({ trustTier: 'prod', allowed: ['rpc:fs:write'] });
    const decision = evaluateHubPolicy(
      baseInput({ node, requiredCapabilities: ['rpc:fs:write'] })
    );
    const audited = appendPolicyAudit(
      {
        append: () => {
          throw new Error('disk full');
        },
      },
      decision
    );
    expect(audited).toMatchObject({
      decision: 'deny',
      reasonCode: 'POLICY_AUDIT_WRITE_FAILED_CLOSED',
      deniedBits: ['rpc:fs:write'],
    });
  });
});
