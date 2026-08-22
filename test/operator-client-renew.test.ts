import { describe, expect, it } from 'vitest';

import {
  OPERATOR_CLIENT_CREDENTIAL_AUDIENCE,
  OperatorClientCredentialRegistry,
} from '../shared/operator-client-credentials.js';
import {
  authenticateOperatorClientCredentialForRenew,
  renewOperatorClientCredential,
} from '../server/operator-client-auth.js';

const NOW = new Date('2026-08-21T00:00:00.000Z');

function credentials(now: () => Date): OperatorClientCredentialRegistry {
  return new OperatorClientCredentialRegistry({
    now,
    secretBytes: () => Buffer.from('0123456789abcdef0123456789abcdef'),
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

function renewRequest(
  token: string,
  headers: Record<string, string | undefined> = {}
): Parameters<typeof authenticateOperatorClientCredentialForRenew>[1] {
  const store: Record<string, string> = {
    authorization: `Bearer ${token}`,
    'x-relay-operator-client-token': 'v1',
    'x-relay-cli-gateway': 'v1',
    ...headers,
  };
  return {
    header: (name: string) => store[name.toLowerCase()],
  } as never;
}

describe('operator client credential renewal', () => {
  it('mints a successor copying identity dimensions while the old token stays valid', () => {
    const registry = credentials(() => NOW);
    const issued = registry.issue(issueInput());
    const renewed = renewOperatorClientCredential(
      registry,
      issued.credential,
      {}
    );

    expect(renewed.token).not.toBe(issued.token);
    expect(renewed.token).toMatch(/^relay-occ-v1\./);
    expect(renewed.credential).toMatchObject({
      client: issued.credential.client,
      capabilities: issued.credential.capabilities,
      scope: issued.credential.scope,
      device: issued.credential.device,
    });
    // Old token is deliberately not revoked: a lost renew response can never
    // lock the client out, and per-token blast radius is unchanged.
    expect(
      registry.validate(issued.token, {
        audience: OPERATOR_CLIENT_CREDENTIAL_AUDIENCE,
        requiredCapabilities: ['context:read'],
      })
    ).toMatchObject({ ok: true });
  });

  it('preserves the originating grantId so grant revocation cascades', () => {
    const registry = credentials(() => NOW);
    const issued = registry.issue({ ...issueInput(), grantId: 'grant-1' });
    const renewed = renewOperatorClientCredential(
      registry,
      issued.credential,
      {}
    );

    expect(renewed.credential.grantId).toBe('grant-1');
    const cascaded = registry.revokeByGrantId('grant-1', {
      revokedBy: 'grant:grant-1',
    });
    expect(cascaded).toHaveLength(2);
    expect(
      registry.validate(renewed.token, {
        audience: OPERATOR_CLIENT_CREDENTIAL_AUDIENCE,
        requiredCapabilities: ['context:read'],
      })
    ).toMatchObject({ ok: false, reason: 'revoked' });
  });

  it('rejects an expired credential', () => {
    let now = NOW;
    const registry = credentials(() => now);
    const issued = registry.issue(issueInput());
    now = new Date(NOW.getTime() + 61_000);

    const auth = authenticateOperatorClientCredentialForRenew(
      registry,
      renewRequest(issued.token)
    );
    expect(auth).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('rejects a revoked credential', () => {
    const registry = credentials(() => NOW);
    const issued = registry.issue(issueInput());
    registry.revoke(issued.credential.id, { revokedBy: 'operator' });

    const auth = authenticateOperatorClientCredentialForRenew(
      registry,
      renewRequest(issued.token)
    );
    expect(auth).toMatchObject({ ok: false, reason: 'revoked' });
  });

  it('requires both v1 marker headers', () => {
    const registry = credentials(() => NOW);
    const issued = registry.issue(issueInput());

    const noTokenMarker = authenticateOperatorClientCredentialForRenew(
      registry,
      renewRequest(issued.token, { 'x-relay-operator-client-token': undefined })
    );
    expect(noTokenMarker).toMatchObject({
      ok: false,
      reason: 'marker_required',
    });

    const noGatewayMarker = authenticateOperatorClientCredentialForRenew(
      registry,
      renewRequest(issued.token, { 'x-relay-cli-gateway': undefined })
    );
    expect(noGatewayMarker).toMatchObject({
      ok: false,
      reason: 'gateway_marker_required',
    });
  });

  it('rejects actor-marker substitution on the renewal lane', () => {
    const registry = credentials(() => NOW);
    const issued = registry.issue(issueInput());

    const auth = authenticateOperatorClientCredentialForRenew(
      registry,
      renewRequest(issued.token, {
        'x-relay-cli-actor-token': 'relay-sac-v1.x.y',
      })
    );
    expect(auth).toMatchObject({ ok: false, reason: 'actor_marker_forbidden' });
  });

  it('rejects a malformed bearer token', () => {
    const registry = credentials(() => NOW);

    const auth = authenticateOperatorClientCredentialForRenew(
      registry,
      renewRequest('relay-sac-v1.not.ours')
    );
    expect(auth).toMatchObject({ ok: false, reason: 'token_substitution' });
  });

  it('rejects a requested ttl beyond the registry maximum', () => {
    const registry = credentials(() => NOW);
    const issued = registry.issue(issueInput());

    // resolveExpiry fails closed rather than silently clamping: an oversized
    // ask is a client bug, and a silent clamp would mint something longer
    // than the operator policy allows.
    expect(() =>
      renewOperatorClientCredential(registry, issued.credential, {
        ttlMs: 24 * 60 * 60 * 1000,
      })
    ).toThrow('ttl exceeds registry maximum');
  });

  it('rejects unknown body fields', () => {
    const registry = credentials(() => NOW);
    const issued = registry.issue(issueInput());

    expect(() =>
      renewOperatorClientCredential(registry, issued.credential, {
        ttlMs: 1000,
        scope: { channelIds: ['topic:other'] },
      })
    ).toThrow('unexpected renewal field');
  });

  it('renews a credential without device or channel scope', () => {
    const registry = credentials(() => NOW);
    const issued = registry.issue({
      client: { id: 'desktop-plugin-backend' },
      capabilities: ['context:read'],
      ttlMs: 60_000,
    });
    const renewed = renewOperatorClientCredential(
      registry,
      issued.credential,
      {}
    );

    expect(renewed.credential.device).toBeUndefined();
    expect(renewed.credential.scope).toEqual({});
  });
});
