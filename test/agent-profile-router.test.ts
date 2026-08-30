import express from 'express';
import http from 'node:http';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAgentProfileRouter } from '../server/agent-profile-router.js';
import {
  createAgentProfileStore,
  type AgentProfileStore,
} from '../server/agent-profile-store.js';

let server: http.Server | undefined;
let baseUrl = '';
let store: AgentProfileStore;
let configuredFrameworkIds: string[];

async function mount(): Promise<void> {
  store = createAgentProfileStore(':memory:');
  configuredFrameworkIds = ['claude', 'codex'];
  store.seedBuiltIns(configuredFrameworkIds.map((id) => ({ id })));
  const app = express();
  app.use(express.json());
  app.use(
    createAgentProfileRouter({
      store,
      listConfiguredFrameworks: () =>
        configuredFrameworkIds.map((id) => ({ id })),
      requireAuth: (_req, _res, next) => next(),
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

beforeEach(mount);

afterEach(async () => {
  await new Promise<void>((resolve) =>
    server ? server.close(() => resolve()) : resolve()
  );
  server = undefined;
  store.close();
});

describe('agent profile router', () => {
  it('creates only profiles for configured providers with a non-empty name', async () => {
    const unconfigured = await request('POST', '/agent-profiles', {
      providerId: 'unknown',
      displayName: 'Unknown',
    });
    expect(unconfigured.status).toBe(400);
    expect(unconfigured.body.error.details.reasonCode).toBe(
      'AGENT_PROFILE_PROVIDER_NOT_CONFIGURED'
    );

    const blankName = await request('POST', '/agent-profiles', {
      providerId: 'claude',
      displayName: ' ',
    });
    expect(blankName.status).toBe(400);
    expect(blankName.body.error.details.reasonCode).toBe(
      'AGENT_PROFILE_DISPLAY_NAME_REQUIRED'
    );

    const created = await request('POST', '/agent-profiles', {
      providerId: 'claude',
      displayName: 'Backend Claude',
      envVars: { FAST: '1' },
    });
    expect(created.status).toBe(201);
    expect(created.body.profile).toMatchObject({
      providerId: 'claude',
      displayName: 'Backend Claude',
      isBuiltIn: false,
      isDefault: false,
    });
  });

  it('rejects malformed patch envVars/list values and only validates present fields', async () => {
    const created = await request('POST', '/agent-profiles', {
      providerId: 'claude',
      displayName: 'Backend Claude',
      systemPrompt: 'keep this',
    });
    const id = created.body.profile.id;

    const malformedEnv = await request('PATCH', `/agent-profiles/${id}`, {
      envVars: { FAST: 1 },
    });
    expect(malformedEnv.status).toBe(400);
    expect(malformedEnv.body.error.details).toMatchObject({
      reasonCode: 'AGENT_PROFILE_INVALID_FIELD',
      field: 'envVars',
    });

    const malformedList = await request('PATCH', `/agent-profiles/${id}`, {
      namePool: ['valid', ''],
    });
    expect(malformedList.status).toBe(400);
    expect(malformedList.body.error.details).toMatchObject({
      reasonCode: 'AGENT_PROFILE_INVALID_FIELD',
      field: 'namePool',
    });

    const updated = await request('PATCH', `/agent-profiles/${id}`, {
      displayName: 'Renamed Claude',
    });
    expect(updated.status).toBe(200);
    expect(updated.body.profile).toMatchObject({
      displayName: 'Renamed Claude',
      systemPrompt: 'keep this',
    });
  });

  it('resets vendor-dependent model and effort when a non-default changes provider', async () => {
    const created = await request('POST', '/agent-profiles', {
      providerId: 'claude',
      displayName: 'Portable Reviewer',
      model: 'claude-model',
      effort: 'high',
    });
    const moved = await request(
      'PATCH',
      `/agent-profiles/${created.body.profile.id}`,
      { providerId: 'codex' }
    );
    expect(moved.status).toBe(200);
    expect(moved.body.profile).toMatchObject({
      providerId: 'codex',
      displayName: 'Portable Reviewer',
    });
    expect(moved.body.profile.model).toBeUndefined();
    expect(moved.body.profile.effort).toBeUndefined();
  });

  it('does not delete a built-in default and flips defaults atomically', async () => {
    const builtIn = store.getDefaultForProvider('claude')!;
    const blocked = await request('DELETE', `/agent-profiles/${builtIn.id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.details.reasonCode).toBe(
      'AGENT_PROFILE_BUILT_IN_DEFAULT_DELETE_FORBIDDEN'
    );

    const created = await request('POST', '/agent-profiles', {
      providerId: 'claude',
      displayName: 'Reviewer Claude',
    });
    const selected = await request(
      'POST',
      `/agent-profiles/${created.body.profile.id}/default`
    );
    expect(selected.status).toBe(200);
    expect(selected.body.profile.isDefault).toBe(true);
    expect(store.get(builtIn.id)?.isDefault).toBe(false);
    expect(
      store
        .list({ providerId: 'claude' })
        .filter((profile) => profile.isDefault)
    ).toHaveLength(1);
  });

  it('allows a built-in display name to reset to the catalog-label sentinel', async () => {
    const builtIn = store.getDefaultForProvider('claude')!;
    const renamed = await request('PATCH', `/agent-profiles/${builtIn.id}`, {
      displayName: 'Claude Operator',
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.profile).toMatchObject({
      displayName: 'Claude Operator',
      isBuiltIn: true,
    });

    const reset = await request('PATCH', `/agent-profiles/${builtIn.id}`, {
      displayName: '',
    });
    expect(reset.status).toBe(200);
    expect(reset.body.profile).toMatchObject({
      displayName: '',
      isBuiltIn: true,
      isDefault: true,
    });
  });

  it('round-trips a hermes profile binding through POST, GET and PATCH', async () => {
    configuredFrameworkIds.push('hermes');
    const created = await request('POST', '/agent-profiles', {
      providerId: 'hermes',
      displayName: 'Product Owner',
      hermesProfile: 'koi-product',
    });
    expect(created.status).toBe(201);
    expect(created.body.profile.hermesProfile).toBe('koi-product');

    const listed = await request('GET', '/agent-profiles');
    expect(listed.body.profiles).toContainEqual(
      expect.objectContaining({
        id: created.body.profile.id,
        hermesProfile: 'koi-product',
      })
    );

    const patched = await request(
      'PATCH',
      `/agent-profiles/${created.body.profile.id}`,
      { hermesProfile: 'ika-frontend' }
    );
    expect(patched.status).toBe(200);
    expect(patched.body.profile.hermesProfile).toBe('ika-frontend');

    const cleared = await request(
      'PATCH',
      `/agent-profiles/${created.body.profile.id}`,
      { hermesProfile: null }
    );
    expect(cleared.status).toBe(200);
    expect(cleared.body.profile.hermesProfile).toBeUndefined();
  });

  it.each([
    ['../other'],
    ['a/b'],
    ['..'],
    ['.'],
    [''],
    ['   '],
    ['has space'],
    ['%2e%2e'],
    ['x'.repeat(65)],
    [12],
  ])(
    'rejects the invalid hermes profile binding %j with a typed 400',
    async (value) => {
      configuredFrameworkIds.push('hermes');
      const created = await request('POST', '/agent-profiles', {
        providerId: 'hermes',
        displayName: 'Bound Agent',
        hermesProfile: value,
      });
      expect(created.status).toBe(400);
      expect(created.body.error.details).toMatchObject({
        reasonCode: 'AGENT_PROFILE_INVALID_FIELD',
        field: 'hermesProfile',
      });

      const clean = await request('POST', '/agent-profiles', {
        providerId: 'hermes',
        displayName: 'Clean Agent',
      });
      const patched = await request(
        'PATCH',
        `/agent-profiles/${clean.body.profile.id}`,
        { hermesProfile: value }
      );
      expect(patched.status).toBe(400);
      expect(patched.body.error.details).toMatchObject({
        field: 'hermesProfile',
      });
      // The rejected write must not have landed.
      expect(store.get(clean.body.profile.id)?.hermesProfile).toBeUndefined();
    }
  );

  it('seeds a runtime-added framework before exposing or mutating its profiles', async () => {
    configuredFrameworkIds.push('runtime');
    const listed = await request('GET', '/agent-profiles');
    expect(listed.status).toBe(200);
    expect(listed.body.profiles).toContainEqual(
      expect.objectContaining({
        providerId: 'runtime',
        isBuiltIn: true,
        isDefault: true,
      })
    );

    const created = await request('POST', '/agent-profiles', {
      providerId: 'runtime',
      displayName: 'Runtime Reviewer',
    });
    expect(created.status).toBe(201);
    expect(
      store
        .list({ providerId: 'runtime' })
        .filter((profile) => profile.isDefault)
    ).toHaveLength(1);

    const claudeCustom = await request('POST', '/agent-profiles', {
      providerId: 'claude',
      displayName: 'Portable Reviewer',
    });
    const moved = await request(
      'PATCH',
      `/agent-profiles/${claudeCustom.body.profile.id}`,
      { providerId: 'runtime' }
    );
    expect(moved.status).toBe(200);
    expect(
      store
        .list({ providerId: 'runtime' })
        .filter((profile) => profile.isDefault)
    ).toHaveLength(1);
  });
});

// ── per-profile gateway key (#1453) ─────────────────────────────────────────
describe('agent profile router: write-only hermes api key', () => {
  const SECRET = 'koi-only-key-abc123';

  /** Raw response text, so absence is asserted against the bytes on the wire. */
  async function rawGet(route: string): Promise<string> {
    const response = await fetch(`${baseUrl}${route}`);
    return response.text();
  }

  async function createKeyed(): Promise<string> {
    const created = await request('POST', '/agent-profiles', {
      providerId: 'claude',
      displayName: 'koi',
      hermesApiKey: SECRET,
    });
    expect(created.status).toBe(201);
    expect(created.body.profile.hermesApiKeySet).toBe(true);
    expect(created.body.profile.hermesApiKey).toBeUndefined();
    return created.body.profile.id as string;
  }

  it('never returns the key on create, list, patch or set-default', async () => {
    const id = await createKeyed();

    const createdText = JSON.stringify(
      (await request('POST', '/agent-profiles', {
        providerId: 'codex',
        displayName: 'ika',
        hermesApiKey: 'ika-only-key',
      })
      ).body
    );
    expect(createdText).not.toContain('ika-only-key');

    expect(await rawGet('/agent-profiles')).not.toContain(SECRET);

    const patched = await request('PATCH', `/agent-profiles/${id}`, {
      displayName: 'koi renamed',
    });
    expect(JSON.stringify(patched.body)).not.toContain(SECRET);
    expect(patched.body.profile.hermesApiKeySet).toBe(true);

    const promoted = await request('POST', `/agent-profiles/${id}/default`);
    expect(JSON.stringify(promoted.body)).not.toContain(SECRET);

    // …and the value really is stored; the responses are redacted, not empty.
    expect(store.getGatewaySecret(id)).toBe(SECRET);
  });

  it('replaces on a new value and clears on null', async () => {
    const id = await createKeyed();

    const replaced = await request('PATCH', `/agent-profiles/${id}`, {
      hermesApiKey: 'second-key',
    });
    expect(replaced.status).toBe(200);
    expect(JSON.stringify(replaced.body)).not.toContain('second-key');
    expect(store.getGatewaySecret(id)).toBe('second-key');

    const cleared = await request('PATCH', `/agent-profiles/${id}`, {
      hermesApiKey: null,
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.profile.hermesApiKeySet).toBeUndefined();
    expect(store.getGatewaySecret(id)).toBeNull();
  });

  it('leaves the stored key untouched when the field is omitted', async () => {
    const id = await createKeyed();
    await request('PATCH', `/agent-profiles/${id}`, { model: 'sonnet' });
    expect(store.getGatewaySecret(id)).toBe(SECRET);
  });

  it('clears the key when the profile moves to another provider', async () => {
    const id = await createKeyed();
    const moved = await request('PATCH', `/agent-profiles/${id}`, {
      providerId: 'codex',
    });
    expect(moved.status).toBe(200);
    // The key authenticates against the OLD provider's gateway; it must not
    // linger as dead credential material on a row that cannot use it.
    expect(store.getGatewaySecret(id)).toBeNull();
  });

  it.each([
    ['has space', 'whitespace'],
    ['line\nbreak', 'header injection via LF'],
    ['line\r\nX-Injected: 1', 'header injection via CRLF'],
    ['', 'empty'],
    ['k'.repeat(4097), 'over-length'],
  ])('rejects a malformed key %j (%s) at POST and PATCH', async (value) => {
    const rejectedCreate = await request('POST', '/agent-profiles', {
      providerId: 'claude',
      displayName: 'bad',
      hermesApiKey: value,
    });
    expect(rejectedCreate.status).toBe(400);
    expect(rejectedCreate.body.error.details).toMatchObject({
      field: 'hermesApiKey',
    });
    // The rejection body must not carry the value it rejected.
    if (value.trim()) {
      expect(JSON.stringify(rejectedCreate.body)).not.toContain(value.trim());
    }

    const id = await createKeyed();
    const rejectedPatch = await request('PATCH', `/agent-profiles/${id}`, {
      hermesApiKey: value,
    });
    expect(rejectedPatch.status).toBe(400);
    // The rejected write left the previous key in place.
    expect(store.getGatewaySecret(id)).toBe(SECRET);
  });

  it('refuses a hermesApiKeySet write from the browser', async () => {
    const id = await createKeyed();
    const rejected = await request('PATCH', `/agent-profiles/${id}`, {
      hermesApiKeySet: false,
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.details).toMatchObject({
      reasonCode: 'AGENT_PROFILE_PATCH_FIELD_UNSUPPORTED',
      field: 'hermesApiKeySet',
    });
    expect(store.getGatewaySecret(id)).toBe(SECRET);
  });
});
