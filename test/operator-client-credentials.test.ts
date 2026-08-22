import { describe, expect, it } from 'vitest';

import {
  OPERATOR_CLIENT_CREDENTIAL_AUDIENCE,
  OperatorClientCredentialRegistry,
} from '../shared/operator-client-credentials.js';
import { HandshakeGrantRegistry } from '../shared/operator-handshake-grants.js';
import {
  issueOperatorClientCredentialWithGrant,
  revokeOperatorClientCredentialWithGrant,
} from '../server/operator-client-auth.js';

const NOW = new Date('2026-08-21T00:00:00.000Z');

function credentials(now: () => Date): OperatorClientCredentialRegistry {
  return new OperatorClientCredentialRegistry({
    now,
    secretBytes: () => Buffer.from('0123456789abcdef0123456789abcdef'),
  });
}

function grants(now: () => Date): HandshakeGrantRegistry {
  return new HandshakeGrantRegistry({
    now,
    secretBytes: () => Buffer.from('abcdef0123456789abcdef0123456789'),
  });
}

function issueInput() {
  return {
    client: {
      id: 'desktop-plugin-backend',
      displayName: 'Desktop plugin backend',
      platform: 'linux',
    },
    device: { id: 'device-opaque-id', displayName: 'Operator desktop' },
    capabilities: ['context:read', 'context:write'],
    scope: { channelIds: ['topic:operator'] },
    ttlMs: 60_000,
  };
}

describe('operator client credential registry', () => {
  it('issues one raw token while list metadata stays human-derived and secret-free', () => {
    const registry = credentials(() => NOW);
    const issued = registry.issue(issueInput());

    expect(issued.token).toMatch(/^relay-occ-v1\.[a-z0-9-]+\.[a-f0-9]+$/);
    expect(issued.credential).toMatchObject({
      audience: OPERATOR_CLIENT_CREDENTIAL_AUDIENCE,
      principal: {
        kind: 'human',
        id: 'human:operator',
        displayName: 'Operator',
      },
      client: { id: 'desktop-plugin-backend', platform: 'linux' },
      scope: { channelIds: ['topic:operator'] },
      capabilities: ['context:read', 'context:write'],
    });
    const listed = registry.listCredentials();
    expect(JSON.stringify(listed)).not.toContain(issued.token);
    expect(JSON.stringify(listed)).not.toContain('device-opaque-id');
    expect(listed[0]?.device?.idHash).toBeDefined();
  });

  it('fails closed for scope/capability misuse, expiry, and revocation', () => {
    let now = NOW;
    const registry = credentials(() => now);
    const issued = registry.issue(issueInput());

    expect(
      registry.validate(issued.token, {
        audience: OPERATOR_CLIENT_CREDENTIAL_AUDIENCE,
        requiredCapabilities: ['context:read'],
        channelId: 'topic:other',
      })
    ).toMatchObject({ ok: false, reason: 'wrong_channel_scope' });
    expect(
      registry.validate(issued.token, {
        audience: OPERATOR_CLIENT_CREDENTIAL_AUDIENCE,
        requiredCapabilities: ['session:read'],
        channelId: 'topic:operator',
      })
    ).toMatchObject({ ok: false, reason: 'unknown_capability' });

    now = new Date(NOW.getTime() + 60_000);
    expect(
      registry.validate(issued.token, {
        audience: OPERATOR_CLIENT_CREDENTIAL_AUDIENCE,
        requiredCapabilities: ['context:read'],
        channelId: 'topic:operator',
      })
    ).toMatchObject({ ok: false, reason: 'expired' });

    now = NOW;
    const revocable = registry.issue(issueInput());
    registry.revoke(revocable.credential.id, {
      revokedBy: 'browser-operator',
      reason: 'operator requested revocation',
    });
    expect(
      registry.validate(revocable.token, {
        audience: OPERATOR_CLIENT_CREDENTIAL_AUDIENCE,
        requiredCapabilities: ['context:write'],
        channelId: 'topic:operator',
      })
    ).toMatchObject({ ok: false, reason: 'revoked' });
  });

  it('mints and revokes through single-use handshake grants without exposing a token on revoke', () => {
    const registry = credentials(() => NOW);
    const grantRegistry = grants(() => NOW);
    const input = issueInput();
    const requested = grantRegistry.request({
      actor: { type: 'cli', id: input.client.id },
      issuer: { id: 'browser-operator' },
      audience: OPERATOR_CLIENT_CREDENTIAL_AUDIENCE,
      capabilities: input.capabilities,
      scope: input.scope,
      device: input.device,
      ttlMs: 120_000,
    });
    const approved = grantRegistry.approve(requested.id, {
      approvedBy: { id: 'browser-operator' },
    });
    const issued = issueOperatorClientCredentialWithGrant(
      registry,
      grantRegistry,
      {
        ...input,
        grantHandle: approved.handle,
      }
    );
    expect(issued.credential.grantId).toBe(requested.id);
    expect(
      grantRegistry.validate(approved.handle, {
        audience: OPERATOR_CLIENT_CREDENTIAL_AUDIENCE,
        requiredCapabilities: ['context:read'],
      })
    ).toMatchObject({ ok: false, reason: 'replayed' });

    const revokeGrant = grantRegistry.request({
      actor: { type: 'cli', id: input.client.id },
      issuer: { id: 'browser-operator' },
      audience: OPERATOR_CLIENT_CREDENTIAL_AUDIENCE,
      capabilities: input.capabilities,
      scope: input.scope,
      device: input.device,
      ttlMs: 120_000,
    });
    const revokeHandle = grantRegistry.approve(revokeGrant.id, {
      approvedBy: { id: 'browser-operator' },
    }).handle;
    const revoked = revokeOperatorClientCredentialWithGrant(
      registry,
      grantRegistry,
      issued.credential.id,
      {
        grantHandle: revokeHandle,
        client: input.client,
        device: input.device,
        reason: 'lost device',
      }
    );
    expect(revoked).not.toHaveProperty('token');
    expect(revoked.revokedAt).toBeDefined();
  });
});
