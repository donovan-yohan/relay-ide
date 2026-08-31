// HTTP surface for the per-profile credential lifecycle (#1455 slice 3).
//
// The security claim under test: credential lifecycle is HOST-LOCAL OPERATOR
// authority. A delegated scoped actor — including one holding a profile
// credential of its own — cannot mint, rotate, revoke, or even inspect one.

import express from 'express';
import http from 'node:http';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAgentProfileRouter } from '../server/agent-profile-router.js';
import {
  createAgentProfileStore,
  type AgentProfileStore,
} from '../server/agent-profile-store.js';
import { createAgentProfileCredentialService } from '../server/agent-profile-credentials.js';
import {
  CLI_GATEWAY_ACTOR_READ_COMMANDS,
  CLI_GATEWAY_ACTOR_WRITE_COMMANDS,
  attachAuthenticatedCliGatewayActorCredential,
  cliGatewayActorCommandCapabilities,
  createCliGatewayActorRegistry,
  issueAgentProfileCliGatewayActorCredential,
  issueCliGatewayActorCredential,
  issueLocalHubCliActorCredential,
  validateCliGatewayActorCredential,
} from '../server/cli-gateway-actor-auth.js';
import { commandSpec } from '../shared/cli-gateway-contract.js';
import { relayCommandDefinition } from '../shared/relay-command-manifest.js';
import { builtInAgentProfileId } from '../shared/agent-profile.js';

type Lane = 'host-local' | 'delegated' | 'profile-credential' | 'browser';

const FRAMEWORKS = ['claude', 'hermes'];
const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;

let server: http.Server | undefined;
let baseUrl = '';
let store: AgentProfileStore;
let registry: ReturnType<typeof createCliGatewayActorRegistry>;
let lane: Lane = 'host-local';
let laneCredentials: Partial<Record<Lane, unknown>> = {};

async function mount(): Promise<void> {
  store = createAgentProfileStore(':memory:');
  store.seedBuiltIns(FRAMEWORKS.map((id) => ({ id })));
  registry = createCliGatewayActorRegistry({ maxTtlMs: MAX_TTL_MS });
  const credentials = createAgentProfileCredentialService({
    registry: () => registry,
    store: () => store,
    maxTtlMs: () => MAX_TTL_MS,
  });
  laneCredentials = {
    'host-local': issueLocalHubCliActorCredential(registry, {
      actor: { type: 'cli', id: 'local-cli' },
      issuer: { id: 'hub-local-boot' },
      capabilities: ['context:read', 'context:write'],
      scope: { taskRefs: ['relay:cli-gateway:v1:read'] },
      ttlMs: 60_000,
    }).credential,
    delegated: issueCliGatewayActorCredential(registry, {
      actor: { type: 'agent', id: 'agent:worker' },
      issuer: { id: 'relay-ide' },
      capabilities: ['context:read', 'context:write'],
      scope: { channelIds: ['topic:one'] },
      ttlMs: 60_000,
    }).credential,
    // The credential this very slice mints: an agent holding one must NOT be
    // able to reach the lifecycle surface that created it.
    'profile-credential': issueAgentProfileCliGatewayActorCredential(registry, {
      actor: { type: 'agent', id: builtInAgentProfileId('hermes') },
      issuer: { id: 'human:operator' },
      capabilities: ['context:read', 'context:write'],
      scope: {},
      ttlMs: 60_000,
    }).credential,
  };
  const app = express();
  app.use(express.json());
  app.use(
    createAgentProfileRouter({
      store,
      credentials,
      listConfiguredFrameworks: () => FRAMEWORKS.map((id) => ({ id })),
      requireAuth: (_req, _res, next) => next(),
      requireGatewayAuthForCommand: () => (req, _res, next) => {
        const credential = laneCredentials[lane];
        if (credential) {
          attachAuthenticatedCliGatewayActorCredential(
            req,
            credential as never
          );
        }
        next();
      },
    })
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server?.address();
      if (!address || typeof address === 'string') {
        throw new Error('missing server address');
      }
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
}

async function request(
  method: string,
  route: string,
  body?: unknown
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers:
      body === undefined ? undefined : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

function hermesProfileId(): string {
  return builtInAgentProfileId('hermes');
}

function credentialRoute(id: string, suffix = ''): string {
  return `/agent-profiles/${encodeURIComponent(id)}/credential${suffix}`;
}

beforeEach(async () => {
  lane = 'host-local';
  await mount();
});

afterEach(async () => {
  await new Promise<void>((resolve) =>
    server ? server.close(() => resolve()) : resolve()
  );
  server = undefined;
  store.close();
});

describe('agent-profiles credential verbs — contract', () => {
  it('declares the three verbs on the actor lane with the right capabilities', () => {
    expect(CLI_GATEWAY_ACTOR_READ_COMMANDS).toContain(
      'agent-profiles.credential.status'
    );
    expect(CLI_GATEWAY_ACTOR_WRITE_COMMANDS).toContain(
      'agent-profiles.credential.mint'
    );
    expect(CLI_GATEWAY_ACTOR_WRITE_COMMANDS).toContain(
      'agent-profiles.credential.revoke'
    );
    expect(
      cliGatewayActorCommandCapabilities('agent-profiles.credential.status')
    ).toEqual(['context:read']);
    for (const command of [
      'agent-profiles.credential.mint',
      'agent-profiles.credential.revoke',
    ] as const) {
      expect(cliGatewayActorCommandCapabilities(command)).toEqual([
        'context:write',
      ]);
    }
    expect(
      relayCommandDefinition('agent-profiles.credential.mint')
    ).toMatchObject({ sideEffect: 'write', scopeKinds: ['node'] });
    // Revocation cuts an agent's whole reach and cannot be undone — the new
    // token has to be replanted — so it is classified with `nodes.revoke`.
    expect(
      relayCommandDefinition('agent-profiles.credential.revoke')
    ).toMatchObject({
      sideEffect: 'destructive',
      scopeKinds: ['node'],
      // Recovery from a mistaken revoke is minting a NEW token and replanting
      // it on the agent's host, so a manifest-reading surface must ask first.
      requiresConfirmation: true,
    });
  });

  it('keeps the token out of every declared schema except the mint output', () => {
    for (const command of [
      'agent-profiles.credential.revoke',
      'agent-profiles.credential.status',
    ] as const) {
      expect(JSON.stringify(commandSpec(command).outputSchema)).not.toContain(
        '"token"'
      );
    }
    expect(
      JSON.stringify(commandSpec('agent-profiles.credential.mint').outputSchema)
    ).toContain('"token"');
  });
});

describe('agent-profiles credential verbs — lifecycle', () => {
  it('mints once, shows the token once, and never returns it again', async () => {
    const id = hermesProfileId();
    const minted = await request('POST', credentialRoute(id));
    expect(minted.status).toBe(200);
    expect(typeof minted.body.token).toBe('string');
    expect(minted.body.token).toMatch(/^relay-sac-v1\./);
    expect(minted.body.credential.state).toBe('active');
    expect(minted.body.credential.actorId).toBe(id);

    const status = await request('GET', credentialRoute(id));
    expect(status.status).toBe(200);
    expect(status.body.credential.credentialId).toBe(
      minted.body.credential.credentialId
    );
    // The token is not reachable from any read, at any nesting depth.
    expect(JSON.stringify(status.body)).not.toContain(minted.body.token);
    expect(status.body.token).toBeUndefined();
  });

  it('reports null status before anything is minted', async () => {
    const status = await request('GET', credentialRoute(hermesProfileId()));
    expect(status.status).toBe(200);
    expect(status.body.credential).toBeNull();
  });

  it('rotates by minting again, invalidating the previous token', async () => {
    const id = hermesProfileId();
    const first = await request('POST', credentialRoute(id));
    const second = await request('POST', credentialRoute(id));
    expect(second.status).toBe(200);
    expect(second.body.token).not.toBe(first.body.token);
    const stale = validateCliGatewayActorCredential(registry, {
      token: first.body.token,
      capabilities: ['context:write'],
    });
    expect(stale.ok).toBe(false);
    const fresh = validateCliGatewayActorCredential(registry, {
      token: second.body.token,
      capabilities: ['context:write'],
    });
    expect(fresh.ok).toBe(true);
  });

  it('revokes, and the revoked token stops authenticating immediately', async () => {
    const id = hermesProfileId();
    const minted = await request('POST', credentialRoute(id));
    const revoked = await request('POST', credentialRoute(id, '/revoke'), {
      reason: 'operator test',
    });
    expect(revoked.status).toBe(200);
    expect(revoked.body.credential.state).toBe('revoked');
    expect(revoked.body.credential.revokedBy).toBe('agent:local-cli');
    const result = validateCliGatewayActorCredential(registry, {
      token: minted.body.token,
      capabilities: ['context:write'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('revoked');
  });

  it('404s a revoke with nothing live, and a verb against an unknown profile', async () => {
    const id = hermesProfileId();
    const empty = await request('POST', credentialRoute(id, '/revoke'));
    expect(empty.status).toBe(404);
    expect(empty.body.error.details.reasonCode).toBe(
      'AGENT_PROFILE_CREDENTIAL_NOT_FOUND'
    );
    for (const [method, route] of [
      ['POST', credentialRoute('agent-profile:hermes:nope')],
      ['POST', credentialRoute('agent-profile:hermes:nope', '/revoke')],
      ['GET', credentialRoute('agent-profile:hermes:nope')],
    ] as const) {
      const missing = await request(method, route);
      expect([route, missing.status]).toEqual([route, 404]);
      expect(missing.body.error.details.reasonCode).toBe(
        'AGENT_PROFILE_NOT_FOUND'
      );
    }
  });

  it('rejects a malformed ttl instead of silently minting the default', async () => {
    const id = hermesProfileId();
    for (const ttlMs of [0, -1, 'forever', null]) {
      const bad = await request('POST', credentialRoute(id), { ttlMs });
      expect([ttlMs, bad.status]).toEqual([ttlMs, 400]);
      expect(bad.body.error.details.reasonCode).toBe(
        'AGENT_PROFILE_CREDENTIAL_TTL_INVALID'
      );
    }
    expect(store.getCredentialStatus(id)).toBeNull();
  });

  it('takes the actor id from the stored profile, never from the body', async () => {
    const id = hermesProfileId();
    const minted = await request('POST', credentialRoute(id), {
      actorId: 'agent-profile:claude:default',
      profileId: 'agent-profile:claude:default',
      capabilities: ['session:create:terminal'],
    });
    // `additionalProperties` are ignored, not honoured: identity and privilege
    // are both server-derived.
    expect(minted.status).toBe(200);
    expect(minted.body.credential.actorId).toBe(id);
    expect(minted.body.credential.capabilities).not.toContain(
      'session:create:terminal'
    );
  });
});

describe('agent-profiles credential verbs — authority', () => {
  it('refuses a DELEGATED actor on mint, revoke, AND status', async () => {
    const id = hermesProfileId();
    // Seed something for the delegated lane to try to read.
    await request('POST', credentialRoute(id));
    lane = 'delegated';
    for (const [method, route] of [
      ['POST', credentialRoute(id)],
      ['POST', credentialRoute(id, '/revoke')],
      ['GET', credentialRoute(id)],
    ] as const) {
      const denied = await request(method, route);
      expect([route, method, denied.status]).toEqual([route, method, 403]);
      expect(denied.body.error.details.reasonCode).toBe(
        'AGENT_PROFILE_HOST_LOCAL_REQUIRED'
      );
      expect(JSON.stringify(denied.body)).not.toContain('relay-sac-v1');
    }
  });

  it('refuses a PROFILE credential holder — no self-service rotation', async () => {
    const id = hermesProfileId();
    const minted = await request('POST', credentialRoute(id));
    lane = 'profile-credential';
    const selfMint = await request('POST', credentialRoute(id));
    expect(selfMint.status).toBe(403);
    const selfStatus = await request('GET', credentialRoute(id));
    expect(selfStatus.status).toBe(403);
    const selfRevoke = await request('POST', credentialRoute(id, '/revoke'));
    expect(selfRevoke.status).toBe(403);
    // Its own credential is untouched by the attempts.
    lane = 'host-local';
    const status = await request('GET', credentialRoute(id));
    expect(status.body.credential.credentialId).toBe(
      minted.body.credential.credentialId
    );
    expect(status.body.credential.state).toBe('active');
  });

  it('keeps browser/operator authority when no actor credential is attached', async () => {
    lane = 'browser';
    const id = hermesProfileId();
    const minted = await request('POST', credentialRoute(id));
    expect(minted.status).toBe(200);
    // Attribution follows the lane the request actually authenticated on.
    const revoked = await request('POST', credentialRoute(id, '/revoke'));
    expect(revoked.body.credential.revokedBy).toBe('human:operator');
  });

  it('revokes the credential when the profile itself is deleted', async () => {
    const custom = store.create({
      providerId: 'hermes',
      displayName: 'Ocean',
    });
    const minted = await request('POST', credentialRoute(custom.id));
    expect(minted.status).toBe(200);
    const deleted = await request(
      'DELETE',
      `/agent-profiles/${encodeURIComponent(custom.id)}`
    );
    expect(deleted.status).toBe(204);
    const result = validateCliGatewayActorCredential(registry, {
      token: minted.body.token,
      capabilities: ['context:write'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('revoked');
  });
});
