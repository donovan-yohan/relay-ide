import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import crypto from 'node:crypto';
import express from 'express';
import type { Server } from 'node:http';

import { createWebhookRouter } from '../server/webhooks.js';
import { createTestServer } from './helpers/test-server.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_SECRET = 'test-webhook-secret';

function signPayload(secret: string, payload: string): string {
  return (
    'sha256=' +
    crypto.createHmac('sha256', secret).update(payload).digest('hex')
  );
}

// ---------------------------------------------------------------------------
// Test server setup
// ---------------------------------------------------------------------------

let server: Server;
let baseUrl: string;
let broadcasts: Array<{
  type: string;
  data: Record<string, unknown> | undefined;
}>;

async function startServer(): Promise<void> {
  broadcasts = [];

  const deps = {
    secret: () => TEST_SECRET,
    broadcastEvent: (type: string, data?: Record<string, unknown>) => {
      broadcasts.push({ type, data });
    },
  };

  const app = express();
  app.use('/webhooks', createWebhookRouter(deps));

  const result = await createTestServer(app);
  server = result.server;
  baseUrl = result.url;
}

function stopServer(): Promise<void> {
  if (server) {
    return new Promise((resolve) => server.close(() => resolve()));
  }
  return Promise.resolve();
}

async function postWebhook(opts: {
  body: object;
  event: string;
  signature?: string;
  omitSignature?: boolean;
}): Promise<Response> {
  const payload = JSON.stringify(opts.body);
  const sig = opts.omitSignature
    ? undefined
    : (opts.signature ?? signPayload(TEST_SECRET, payload));

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-GitHub-Event': opts.event,
  };

  if (sig !== undefined) {
    headers['X-Hub-Signature-256'] = sig;
  }

  return fetch(`${baseUrl}/webhooks`, {
    method: 'POST',
    headers,
    body: payload,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('webhook handler', () => {
  beforeAll(() => startServer());
  afterAll(() => stopServer());

  it('rejects request with missing signature (401)', async () => {
    const res = await postWebhook({
      body: { action: 'opened' },
      event: 'pull_request',
      omitSignature: true,
    });
    expect(res.status).toBe(401);
    expect(broadcasts.length).toBe(0);
  });

  it('rejects request with invalid signature (401)', async () => {
    const res = await postWebhook({
      body: { action: 'opened' },
      event: 'pull_request',
      signature: 'sha256=invalidsignature',
    });
    expect(res.status).toBe(401);
    expect(broadcasts.length).toBe(0);
  });

  it('accepts valid signature and broadcasts pr-updated for pull_request event', async () => {
    broadcasts = [];
    const body = { action: 'opened', number: 42 };
    const res = await postWebhook({ body, event: 'pull_request' });
    expect(res.status).toBe(200);

    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);
    expect(broadcasts.length).toBe(1);
    expect(broadcasts[0]?.type).toBe('pr-updated');
  });

  it('broadcasts pr-updated for pull_request_review event', async () => {
    broadcasts = [];
    const body = { action: 'submitted', review: {} };
    const res = await postWebhook({ body, event: 'pull_request_review' });
    expect(res.status).toBe(200);
    expect(broadcasts.length).toBe(1);
    expect(broadcasts[0]?.type).toBe('pr-updated');
  });

  it('broadcasts ci-updated for check_suite event', async () => {
    broadcasts = [];
    const body = { action: 'completed', check_suite: {} };
    const res = await postWebhook({ body, event: 'check_suite' });
    expect(res.status).toBe(200);
    expect(broadcasts.length).toBe(1);
    expect(broadcasts[0]?.type).toBe('ci-updated');
  });

  it('returns 200 but does NOT broadcast for unknown event (star)', async () => {
    broadcasts = [];
    const body = { action: 'created' };
    const res = await postWebhook({ body, event: 'star' });
    expect(res.status).toBe(200);

    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);
    expect(broadcasts.length).toBe(0);
  });

  it('includes repository full_name in broadcast data', async () => {
    broadcasts = [];
    const body = {
      action: 'opened',
      number: 42,
      repository: { full_name: 'owner/repo' },
    };
    const res = await postWebhook({ body, event: 'pull_request' });
    expect(res.status).toBe(200);
    expect(broadcasts[0]?.data?.repo).toBe('owner/repo');
  });
});

describe('webhook merge detection', () => {
  beforeAll(() => startServer());
  afterAll(() => stopServer());

  it('pull_request.closed with merged:true broadcasts pr-updated and worktrees-changed', async () => {
    broadcasts = [];
    const res = await postWebhook({
      body: {
        action: 'closed',
        pull_request: { merged: true, head: { ref: 'fix/auth' } },
        repository: { full_name: 'owner/repo' },
      },
      event: 'pull_request',
    });
    expect(res.status).toBe(200);
    const types = broadcasts.map((b) => b.type);
    expect(types).toEqual(['pr-updated', 'worktrees-changed']);
  });

  it('pull_request.closed without merge does not broadcast worktrees-changed', async () => {
    broadcasts = [];
    const res = await postWebhook({
      body: {
        action: 'closed',
        pull_request: { merged: false },
        repository: { full_name: 'owner/repo' },
      },
      event: 'pull_request',
    });
    expect(res.status).toBe(200);
    const types = broadcasts.map((b) => b.type);
    expect(types).toEqual(['pr-updated']);
  });
});

describe('webhook handler — no secret configured', () => {
  let noSecretBaseUrl: string;
  let closeNoSecret: () => Promise<void>;

  beforeAll(async () => {
    const app = express();
    app.use(
      '/webhooks',
      createWebhookRouter({
        secret: () => undefined,
        broadcastEvent: () => {},
      })
    );
    const result = await createTestServer(app);
    noSecretBaseUrl = result.url;
    closeNoSecret = result.close;
  });

  afterAll(() => closeNoSecret());

  it('rejects with 401 when webhook secret is not configured', async () => {
    const payload = JSON.stringify({ action: 'opened' });
    const sig = signPayload(TEST_SECRET, payload);
    const res = await fetch(`${noSecretBaseUrl}/webhooks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'pull_request',
        'X-Hub-Signature-256': sig,
      },
      body: payload,
    });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('Webhooks not configured');
  });
});
