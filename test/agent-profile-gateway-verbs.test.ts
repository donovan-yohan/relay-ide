import express from 'express';
import http from 'node:http';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAgentProfileRouter } from '../server/agent-profile-router.js';
import {
  createAgentProfileStore,
  type AgentProfileStore,
} from '../server/agent-profile-store.js';
import {
  CLI_GATEWAY_ACTOR_READ_COMMANDS,
  CLI_GATEWAY_ACTOR_WRITE_COMMANDS,
  attachAuthenticatedCliGatewayActorCredential,
  cliGatewayActorCommandCapabilities,
  createCliGatewayActorRegistry,
  issueCliGatewayActorCredential,
  issueLocalHubCliActorCredential,
} from '../server/cli-gateway-actor-auth.js';
import { commandSpec } from '../shared/cli-gateway-contract.js';
import { relayCommandDefinition } from '../shared/relay-command-manifest.js';

/**
 * #1473: the `agent-profiles.*` gateway verbs, exercised through the real
 * router with a real scoped-actor credential attached the way
 * `requireCliGatewayAuthForActorCommand` attaches one.
 *
 * Two invariants carry the security weight here:
 *  1. a profile READ never carries `hermesApiKey`, only `hermesApiKeySet`;
 *  2. a DELEGATED actor credential — the kind a bound agent runtime holds, and
 *     one that routinely carries `context:write` — cannot create or patch a
 *     profile. Only the #1467 host-local trust token and the browser/operator
 *     lane can.
 */

type Lane = 'host-local' | 'delegated' | 'browser';

let server: http.Server | undefined;
let baseUrl = '';
let store: AgentProfileStore;
let lane: Lane = 'host-local';

const registry = createCliGatewayActorRegistry();
const hostLocal = issueLocalHubCliActorCredential(registry, {
  actor: { type: 'cli', id: 'local-cli' },
  issuer: { id: 'hub-local-boot' },
  capabilities: ['context:read', 'context:write'],
  scope: { taskRefs: ['relay:cli-gateway:v1:read'] },
  ttlMs: 60_000,
});
const delegated = issueCliGatewayActorCredential(registry, {
  actor: { type: 'agent', id: 'agent:worker' },
  issuer: { id: 'relay-ide' },
  capabilities: ['context:read', 'context:write'],
  scope: { channelIds: ['topic:one'] },
  ttlMs: 60_000,
});

const FRAMEWORKS = ['claude', 'hermes'];

async function mount(): Promise<void> {
  store = createAgentProfileStore(':memory:');
  store.seedBuiltIns(FRAMEWORKS.map((id) => ({ id })));
  const app = express();
  app.use(express.json());
  app.use(
    createAgentProfileRouter({
      store,
      listConfiguredFrameworks: () => FRAMEWORKS.map((id) => ({ id })),
      requireAuth: (_req, _res, next) => next(),
      // Stands in for `requireCliGatewayAuthForActorCommand`: the browser lane
      // attaches no credential, the two actor lanes attach a real one.
      requireGatewayAuthForCommand: () => (req, _res, next) => {
        if (lane === 'host-local') {
          attachAuthenticatedCliGatewayActorCredential(
            req,
            hostLocal.credential
          );
        } else if (lane === 'delegated') {
          attachAuthenticatedCliGatewayActorCredential(
            req,
            delegated.credential
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
): Promise<{ status: number; text: string; body: any }> {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers:
      body === undefined ? undefined : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    body: text ? JSON.parse(text) : {},
  };
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

const SECRET = 'hermes-gateway-key-1473';

describe('agent-profiles gateway verbs', () => {
  it('declares the four verbs on the actor lane with read/write capabilities', () => {
    expect(CLI_GATEWAY_ACTOR_READ_COMMANDS).toContain('agent-profiles.list');
    expect(CLI_GATEWAY_ACTOR_READ_COMMANDS).toContain('agent-profiles.get');
    expect(CLI_GATEWAY_ACTOR_WRITE_COMMANDS).toContain('agent-profiles.create');
    expect(CLI_GATEWAY_ACTOR_WRITE_COMMANDS).toContain('agent-profiles.update');
    for (const command of [
      'agent-profiles.list',
      'agent-profiles.get',
    ] as const) {
      expect(cliGatewayActorCommandCapabilities(command)).toEqual([
        'context:read',
      ]);
      expect(commandSpec(command).capabilityHints).toEqual(['context:read']);
      expect(relayCommandDefinition(command)).toMatchObject({
        sideEffect: 'read',
        scopeKinds: ['node'],
      });
    }
    for (const command of [
      'agent-profiles.create',
      'agent-profiles.update',
    ] as const) {
      expect(cliGatewayActorCommandCapabilities(command)).toEqual([
        'context:write',
      ]);
      expect(commandSpec(command).capabilityHints).toEqual(['context:write']);
      expect(relayCommandDefinition(command)).toMatchObject({
        sideEffect: 'write',
        scopeKinds: ['node'],
      });
    }
  });

  it('keeps the gateway key out of the declared output schema', () => {
    for (const command of [
      'agent-profiles.list',
      'agent-profiles.get',
      'agent-profiles.create',
      'agent-profiles.update',
    ] as const) {
      const serialized = JSON.stringify(commandSpec(command).outputSchema);
      expect(serialized).not.toContain('hermesApiKey"');
      expect(serialized).toContain('hermesApiKeySet');
    }
  });

  it('round-trips create -> list -> get -> update on the host-local lane', async () => {
    const created = await request('POST', '/agent-profiles', {
      providerId: 'hermes',
      displayName: 'Tako Planner',
      hermesProfile: 'tako-planner',
      hermesApiKey: SECRET,
    });
    expect(created.status).toBe(201);
    expect(created.body.profile).toMatchObject({
      providerId: 'hermes',
      displayName: 'Tako Planner',
      hermesProfile: 'tako-planner',
      hermesApiKeySet: true,
      isBuiltIn: false,
      isDefault: false,
    });
    // The secret must not appear anywhere in the create response body.
    expect(created.text).not.toContain(SECRET);
    expect(created.body.profile).not.toHaveProperty('hermesApiKey');
    const id = created.body.profile.id as string;

    const listed = await request('GET', '/agent-profiles');
    expect(listed.status).toBe(200);
    expect(listed.text).not.toContain(SECRET);
    const listedProfile = (listed.body.profiles as any[]).find(
      (profile) => profile.id === id
    );
    expect(listedProfile).toMatchObject({
      hermesProfile: 'tako-planner',
      hermesApiKeySet: true,
    });

    const fetched = await request(
      'GET',
      `/agent-profiles/${encodeURIComponent(id)}`
    );
    expect(fetched.status).toBe(200);
    expect(fetched.text).not.toContain(SECRET);
    expect(fetched.body.profile).toMatchObject({
      id,
      hermesProfile: 'tako-planner',
      hermesApiKeySet: true,
    });
    // The store still holds the value even though no read path returns it.
    expect(store.getGatewaySecret(id)).toBe(SECRET);

    const cleared = await request(
      'PATCH',
      `/agent-profiles/${encodeURIComponent(id)}`,
      { hermesProfile: null, hermesApiKey: null }
    );
    expect(cleared.status).toBe(200);
    expect(cleared.text).not.toContain(SECRET);
    expect(cleared.body.profile).not.toHaveProperty('hermesProfile');
    expect(cleared.body.profile.hermesApiKeySet).toBeFalsy();
    expect(store.getGatewaySecret(id)).toBeNull();
  });

  it('returns 404 for an unknown profile id', async () => {
    const missing = await request('GET', '/agent-profiles/agent-profile:nope');
    expect(missing.status).toBe(404);
    expect(missing.body.error.details.reasonCode).toBe(
      'AGENT_PROFILE_NOT_FOUND'
    );
  });

  it('never echoes a rejected key back to the caller', async () => {
    const rejected = await request('POST', '/agent-profiles', {
      providerId: 'hermes',
      displayName: 'Bad Key',
      hermesApiKey: 'has a space',
    });
    expect(rejected.status).toBe(400);
    expect(rejected.text).not.toContain('has a space');
    expect(rejected.body.error.details).toMatchObject({
      field: 'hermesApiKey',
    });
  });

  it('refuses profile writes from a delegated actor credential', async () => {
    lane = 'delegated';

    const created = await request('POST', '/agent-profiles', {
      providerId: 'hermes',
      displayName: 'Escalation Attempt',
    });
    expect(created.status).toBe(403);
    expect(created.body.error).toMatchObject({
      code: 'FORBIDDEN',
      retryable: false,
      details: { reasonCode: 'AGENT_PROFILE_HOST_LOCAL_REQUIRED' },
    });

    const builtIn = store
      .list()
      .find((profile) => profile.providerId === 'hermes');
    const patched = await request(
      'PATCH',
      `/agent-profiles/${encodeURIComponent(builtIn?.id ?? '')}`,
      { hermesProfile: 'stolen' }
    );
    expect(patched.status).toBe(403);
    expect(patched.body.error.details.reasonCode).toBe(
      'AGENT_PROFILE_HOST_LOCAL_REQUIRED'
    );
    expect(store.get(builtIn?.id ?? '')?.hermesProfile).toBeUndefined();

    // Reads stay available to the delegated lane: the roster is not a secret.
    const listed = await request('GET', '/agent-profiles');
    expect(listed.status).toBe(200);
    expect(Array.isArray(listed.body.profiles)).toBe(true);
  });

  it('keeps browser/operator authority when no actor credential is attached', async () => {
    lane = 'browser';
    const created = await request('POST', '/agent-profiles', {
      providerId: 'claude',
      displayName: 'Browser Made',
    });
    expect(created.status).toBe(201);
    expect(created.body.profile.displayName).toBe('Browser Made');
  });
});
