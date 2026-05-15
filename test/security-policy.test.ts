import { describe, expect, it } from 'vitest';
import {
  applyTrustTierOverlay,
  createLegacyDefaultNodeAcl,
  isRelayCapabilityBit,
  resolveAclCapability,
  type RelayNodeAcl,
} from '../shared/security-policy.js';

describe('security policy schema', () => {
  it('treats the capability enum as closed and fails unknown bits closed', () => {
    const acl = createLegacyDefaultNodeAcl({
      nodeId: 'node_1',
      credentialId: 'cred_1',
      createdAt: '2026-01-02T03:04:05.000Z',
    });

    expect(isRelayCapabilityBit('rpc:fs:read')).toBe(true);
    expect(isRelayCapabilityBit('rpc:fs:format-disk')).toBe(false);
    expect(resolveAclCapability(acl, 'rpc:fs:read')).toMatchObject({
      known: true,
      decision: 'allow',
    });
    expect(resolveAclCapability(acl, 'rpc:fs:format-disk')).toMatchObject({
      known: false,
      decision: 'deny',
    });
  });

  it('moves prod high-risk silent grants to confirmation without granting denied bits', () => {
    const base = createLegacyDefaultNodeAcl({
      nodeId: 'node_prod',
      createdAt: '2026-01-02T03:04:05.000Z',
      trustTier: 'prod',
    });
    const acl: RelayNodeAcl = {
      ...base,
      grants: {
        allowed: ['session:read', 'rpc:fs:write', 'rpc:git:write'],
        requiresConfirmation: ['rpc:fs:delete'],
      },
    };

    const overlaid = applyTrustTierOverlay(acl);

    expect(overlaid.grants.allowed).toEqual(['session:read']);
    expect(overlaid.grants.requiresConfirmation).toEqual(
      expect.arrayContaining(['rpc:fs:write', 'rpc:git:write', 'rpc:fs:delete'])
    );
    expect(resolveAclCapability(overlaid, 'preview:port-forward')).toMatchObject({
      decision: 'deny',
    });
  });

  it('normalizes unknown stored bits out of effective ACL decisions', () => {
    const acl = createLegacyDefaultNodeAcl({
      nodeId: 'node_dirty',
      createdAt: '2026-01-02T03:04:05.000Z',
    }) as RelayNodeAcl & { grants: { allowed: string[]; requiresConfirmation: string[] } };
    acl.grants.allowed.push('rpc:fs:format-disk');
    acl.grants.requiresConfirmation.push('session:teleport');

    const overlaid = applyTrustTierOverlay(acl);

    expect(overlaid.grants.allowed).not.toContain('rpc:fs:format-disk');
    expect(overlaid.grants.requiresConfirmation).not.toContain('session:teleport');
    expect(resolveAclCapability(acl, 'session:teleport')).toMatchObject({
      known: false,
      decision: 'deny',
    });
  });
});
