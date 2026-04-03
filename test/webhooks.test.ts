import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import type { Server } from 'node:http';

import { createWebhookRouter } from '../server/webhooks.js';

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

function startServer(): Promise<void> {
  return new Promise((resolve) => {
    broadcasts = [];

    const deps = {
      secret: () => TEST_SECRET,
      broadcastEvent: (type: string, data?: Record<string, unknown>) => {
        broadcasts.push({ type, data });
      },
    };

    const app = express();
    app.use('/webhooks', createWebhookRouter(deps));

    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr === 'object' && addr) {
        baseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
}

function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    if (server) server.close(() => resolve());
    else resolve();
  });
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
  before(() => startServer());
  after(() => stopServer());

  it('rejects request with missing signature (401)', async () => {
    const res = await postWebhook({
      body: { action: 'opened' },
      event: 'pull_request',
      omitSignature: true,
    });
    assert.equal(res.status, 401);
    assert.equal(broadcasts.length, 0);
  });

  it('rejects request with invalid signature (401)', async () => {
    const res = await postWebhook({
      body: { action: 'opened' },
      event: 'pull_request',
      signature: 'sha256=invalidsignature',
    });
    assert.equal(res.status, 401);
    assert.equal(broadcasts.length, 0);
  });

  it('accepts valid signature and broadcasts pr-updated for pull_request event', async () => {
    broadcasts = [];
    const body = { action: 'opened', number: 42 };
    const res = await postWebhook({ body, event: 'pull_request' });
    assert.equal(res.status, 200);

    const json = (await res.json()) as { ok: boolean };
    assert.equal(json.ok, true);
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0]?.type, 'pr-updated');
  });

  it('broadcasts pr-updated for pull_request_review event', async () => {
    broadcasts = [];
    const body = { action: 'submitted', review: {} };
    const res = await postWebhook({ body, event: 'pull_request_review' });
    assert.equal(res.status, 200);
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0]?.type, 'pr-updated');
  });

  it('broadcasts ci-updated for check_suite event', async () => {
    broadcasts = [];
    const body = { action: 'completed', check_suite: {} };
    const res = await postWebhook({ body, event: 'check_suite' });
    assert.equal(res.status, 200);
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0]?.type, 'ci-updated');
  });

  it('returns 200 but does NOT broadcast for unknown event (star)', async () => {
    broadcasts = [];
    const body = { action: 'created' };
    const res = await postWebhook({ body, event: 'star' });
    assert.equal(res.status, 200);

    const json = (await res.json()) as { ok: boolean };
    assert.equal(json.ok, true);
    assert.equal(
      broadcasts.length,
      0,
      'Should not broadcast for unknown events'
    );
  });

  it('includes repository full_name in broadcast data', async () => {
    broadcasts = [];
    const body = {
      action: 'opened',
      number: 42,
      repository: { full_name: 'owner/repo' },
    };
    const res = await postWebhook({ body, event: 'pull_request' });
    assert.equal(res.status, 200);
    assert.equal(broadcasts[0]?.data?.repo, 'owner/repo');
  });
});

describe('webhook merge detection', () => {
  before(() => startServer());
  after(() => stopServer());

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
    assert.equal(res.status, 200);
    const types = broadcasts.map((b) => b.type);
    assert.deepEqual(types, ['pr-updated', 'worktrees-changed']);
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
    assert.equal(res.status, 200);
    const types = broadcasts.map((b) => b.type);
    assert.deepEqual(types, ['pr-updated']);
  });
});

describe('webhook handler — no secret configured', () => {
  let noSecretServer: Server;
  let noSecretBaseUrl: string;

  before(
    () =>
      new Promise<void>((resolve) => {
        const app = express();
        app.use(
          '/webhooks',
          createWebhookRouter({
            secret: () => undefined,
            broadcastEvent: () => {},
          })
        );
        noSecretServer = app.listen(0, '127.0.0.1', () => {
          const addr = noSecretServer.address();
          if (typeof addr === 'object' && addr) {
            noSecretBaseUrl = `http://127.0.0.1:${addr.port}`;
          }
          resolve();
        });
      })
  );

  after(
    () =>
      new Promise<void>((resolve) => {
        if (noSecretServer) noSecretServer.close(() => resolve());
        else resolve();
      })
  );

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
    assert.equal(res.status, 401);
    const json = (await res.json()) as { error: string };
    assert.equal(json.error, 'Webhooks not configured');
  });
});
