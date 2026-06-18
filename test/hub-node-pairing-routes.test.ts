import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createHubNodeRegistry } from '../server/hub-node-registry.js';
import { createHubNodeRouter } from '../server/hub-node-router.js';
import { createConfirmationChallengeStore } from '../server/confirmation-challenges.js';
import * as auth from '../server/auth.js';
import { generateNodeIdentityKeyPair } from '../shared/node-identity-keys.js';
import { buildManifestWithAgents } from './helpers/manifest-fixtures.js';

const NOW_MS = Date.parse('2026-06-18T12:00:00.000Z');
const SECRET_HOSTNAME = 'donovans-secret-macbook.tailnet.ts.net';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('missing server address');
  }
  return address.port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function manifest() {
  return buildManifestWithAgents({
    agents: [{ id: 'claude' }],
    overrides: { hostname: SECRET_HOSTNAME, platform: 'darwin' },
  });
}

interface Setup {
  base: string;
  registry: ReturnType<typeof createHubNodeRegistry>;
  storagePath: string;
  clock: { ms: number };
}

async function setup(): Promise<Setup> {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'relay-pending-pairing-routes-')
  );
  const storagePath = path.join(tmpDir, 'nodes.json');
  const clock = { ms: NOW_MS };
  const now = () => new Date(clock.ms);
  const registry = createHubNodeRegistry({ storagePath, now });
  const app = express();
  app.use(express.json());
  app.use(
    createHubNodeRouter({
      registry,
      now,
      confirmations: createConfirmationChallengeStore({ now }),
      requireAuth: (req, res, next) => {
        if (req.header('x-test-auth') === 'yes') next();
        else res.status(401).json(auth.browserSessionRequiredChallenge());
      },
    })
  );
  const server = http.createServer(app);
  const port = await listen(server);
  cleanup.push(() => close(server));
  cleanup.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  return { base: `http://127.0.0.1:${port}`, registry, storagePath, clock };
}

function operatorHeaders(session = 'operator-a'): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-test-auth': 'yes',
    'x-auth-session': session,
  };
}

async function submitRequest(
  base: string,
  body: Record<string, unknown> = {}
): Promise<{ status: number; json: any }> {
  const keys = generateNodeIdentityKeyPair();
  const res = await fetch(`${base}/hub/pairing/requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      manifest: manifest(),
      displayName: 'work-mac',
      publicKey: keys.publicKeyPem,
      ...body,
    }),
  });
  return { status: res.status, json: await res.json() };
}

describe('hub node pending pairing routes (#982)', () => {
  it('submits a request and polls status without operator auth', async () => {
    const { base } = await setup();
    const { status, json } = await submitRequest(base);
    expect(status).toBe(201);
    expect(json.request.state).toBe('pending');
    expect(json.statusToken).toMatch(/^pstat_/);
    expect(json.request.deviceCode).toMatch(/^[A-Z2-9]{3}-[A-Z2-9]{3}$/);

    const poll = await fetch(
      `${base}/hub/pairing/requests/${json.request.requestId}/status`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ statusToken: json.statusToken }),
      }
    );
    expect(poll.status).toBe(200);
    const pollJson = await poll.json();
    expect(pollJson.request.state).toBe('pending');
    expect(pollJson.credential).toBeUndefined();
  });

  it('protects the operator list/approve/deny lanes behind auth', async () => {
    const { base } = await setup();
    const list = await fetch(`${base}/hub/pairing/requests`);
    expect(list.status).toBe(401);
    const { json } = await submitRequest(base);
    const approve = await fetch(
      `${base}/hub/pairing/requests/${json.request.requestId}/approve`,
      { method: 'POST' }
    );
    expect(approve.status).toBe(401);
  });

  it('runs the full dev-profile approve → claim flow and redacts secrets', async () => {
    const { base, storagePath } = await setup();
    const submitted = await submitRequest(base);
    const requestId = submitted.json.request.requestId;
    const statusToken = submitted.json.statusToken;

    const listRes = await fetch(`${base}/hub/pairing/requests`, {
      headers: operatorHeaders(),
    });
    expect(listRes.status).toBe(200);
    const listJson = await listRes.json();
    expect(listJson.requests).toHaveLength(1);
    const listText = JSON.stringify(listJson);
    expect(listText).not.toContain(statusToken);
    expect(listText).not.toContain(SECRET_HOSTNAME);

    const approveRes = await fetch(
      `${base}/hub/pairing/requests/${requestId}/approve`,
      { method: 'POST', headers: operatorHeaders() }
    );
    expect(approveRes.status).toBe(200);
    const approveJson = await approveRes.json();
    expect(approveJson.request.state).toBe('approved');
    // The operator surface never carries credential material.
    expect(approveJson.credential).toBeUndefined();
    expect(JSON.stringify(approveJson)).not.toContain('secret_');

    const claimRes = await fetch(
      `${base}/hub/pairing/requests/${requestId}/status`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ statusToken }),
      }
    );
    expect(claimRes.status).toBe(200);
    const claimJson = await claimRes.json();
    expect(claimJson.credential.token).toMatch(
      new RegExp(`^${claimJson.node.nodeId}\\.`)
    );
    expect(claimJson.credential.publicKeyFingerprint).toMatch(/^nkey_/);

    // Raw credential token never persisted.
    const persisted = fs.readFileSync(storagePath, 'utf8');
    expect(persisted).not.toContain(claimJson.credential.token);

    // The node now appears in the node list.
    const nodesRes = await fetch(`${base}/nodes`, { headers: operatorHeaders() });
    expect(nodesRes.status).toBe(200);
    const nodesJson = await nodesRes.json();
    expect(nodesJson.nodes).toHaveLength(1);
  });

  it('locates a request by device code via the operator list', async () => {
    const { base } = await setup();
    const { json } = await submitRequest(base);
    const code = json.request.deviceCode;
    const res = await fetch(
      `${base}/hub/pairing/requests?deviceCode=${encodeURIComponent(code.toLowerCase())}`,
      { headers: operatorHeaders() }
    );
    expect(res.status).toBe(200);
    const found = await res.json();
    expect(found.request.requestId).toBe(json.request.requestId);
  });

  it('edits requested access before approval', async () => {
    const { base } = await setup();
    const { json } = await submitRequest(base);
    const res = await fetch(
      `${base}/hub/pairing/requests/${json.request.requestId}/access`,
      {
        method: 'PATCH',
        headers: operatorHeaders(),
        body: JSON.stringify({
          displayName: 'renamed',
          requestedRoots: ['~/code'],
        }),
      }
    );
    expect(res.status).toBe(200);
    const edited = await res.json();
    expect(edited.request.displayName).toBe('renamed');
    expect(edited.request.requestedRoots).toEqual(['~/code']);
  });

  it('denies a request; the node poll sees the denial and gets no credential', async () => {
    const { base } = await setup();
    const { json } = await submitRequest(base);
    const denyRes = await fetch(
      `${base}/hub/pairing/requests/${json.request.requestId}/deny`,
      {
        method: 'POST',
        headers: operatorHeaders(),
        body: JSON.stringify({ reason: 'unknown device' }),
      }
    );
    expect(denyRes.status).toBe(200);
    expect((await denyRes.json()).request.state).toBe('denied');

    const poll = await fetch(
      `${base}/hub/pairing/requests/${json.request.requestId}/status`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ statusToken: json.statusToken }),
      }
    );
    const pollJson = await poll.json();
    expect(pollJson.request.state).toBe('denied');
    expect(pollJson.credential).toBeUndefined();
  });

  it('routes a high-risk (prod) approval through the exact-operation confirmation contract', async () => {
    const { base } = await setup();
    const { json } = await submitRequest(base, {
      requestedProfile: 'infra-prod-host',
    });
    const requestId = json.request.requestId;
    expect(json.request.requiresExactOperationApproval).toBe(true);

    // First approve (no confirmation token) → 409 CONFIRMATION_REQUIRED.
    const challengeRes = await fetch(
      `${base}/hub/pairing/requests/${requestId}/approve`,
      { method: 'POST', headers: operatorHeaders('operator-a') }
    );
    expect(challengeRes.status).toBe(409);
    const challengeJson = await challengeRes.json();
    expect(challengeJson.error.code).toBe('CONFIRMATION_REQUIRED');
    const challengeId = challengeJson.error.details.challenge.challengeId;

    // A different operator session approves the challenge (separation of duty).
    const approveChallengeRes = await fetch(
      `${base}/hub/confirmations/${challengeId}/approve`,
      {
        method: 'POST',
        headers: operatorHeaders('operator-b'),
        body: JSON.stringify({ decision: 'approve' }),
      }
    );
    expect(approveChallengeRes.status).toBe(200);
    const confirmationToken = (await approveChallengeRes.json())
      .confirmationToken as string;
    expect(confirmationToken).toBeTruthy();

    // The original requester re-approves with the confirmation token.
    const approveRes = await fetch(
      `${base}/hub/pairing/requests/${requestId}/approve`,
      {
        method: 'POST',
        headers: operatorHeaders('operator-a'),
        body: JSON.stringify({ confirmationToken }),
      }
    );
    expect(approveRes.status).toBe(200);
    expect((await approveRes.json()).request.state).toBe('approved');

    // Node can now claim its credential.
    const claim = await fetch(
      `${base}/hub/pairing/requests/${requestId}/status`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ statusToken: json.statusToken }),
      }
    );
    expect((await claim.json()).credential.token).toBeTruthy();
  });

  it('names the elevated capability in the confirmation challenge and binds the token to it', async () => {
    const { base } = await setup();
    const { json } = await submitRequest(base, {
      requestedCapabilities: ['rpc:fs:write'],
    });
    const requestId = json.request.requestId;
    expect(json.request.requiresExactOperationApproval).toBe(true);

    const challengeRes = await fetch(
      `${base}/hub/pairing/requests/${requestId}/approve`,
      { method: 'POST', headers: operatorHeaders('operator-a') }
    );
    expect(challengeRes.status).toBe(409);
    const challenge = (await challengeRes.json()).error.details.challenge;
    // The challenge card names the real high-risk bit being authorized.
    expect(challenge.challengeBits).toContain('rpc:fs:write');

    const confirmToken = await fetch(
      `${base}/hub/confirmations/${challenge.challengeId}/approve`,
      {
        method: 'POST',
        headers: operatorHeaders('operator-b'),
        body: JSON.stringify({ decision: 'approve' }),
      }
    ).then((r) => r.json());

    // Widening the granted capabilities after the token was minted invalidates
    // the token — the confirmed set and the granted set must not diverge.
    await fetch(`${base}/hub/pairing/requests/${requestId}/access`, {
      method: 'PATCH',
      headers: operatorHeaders('operator-a'),
      body: JSON.stringify({
        requestedCapabilities: ['rpc:fs:write', 'pty:exec:arbitrary'],
      }),
    });
    const replay = await fetch(
      `${base}/hub/pairing/requests/${requestId}/approve`,
      {
        method: 'POST',
        headers: operatorHeaders('operator-a'),
        body: JSON.stringify({ confirmationToken: confirmToken.confirmationToken }),
      }
    );
    expect(replay.status).not.toBe(200);
    const stillPending = await fetch(
      `${base}/hub/pairing/requests/${requestId}`,
      { headers: operatorHeaders() }
    );
    expect((await stillPending.json()).request.state).toBe('pending');
  });

  it('binds the confirmation token to the roots set; a widened roots edit invalidates it', async () => {
    const { base } = await setup();
    const { json } = await submitRequest(base, {
      requestedProfile: 'infra-prod-host',
      requestedRoots: ['~/code'],
    });
    const requestId = json.request.requestId;

    const challenge = (
      await fetch(`${base}/hub/pairing/requests/${requestId}/approve`, {
        method: 'POST',
        headers: operatorHeaders('operator-a'),
      }).then((r) => r.json())
    ).error.details.challenge;

    const confirmationToken = (
      await fetch(`${base}/hub/confirmations/${challenge.challengeId}/approve`, {
        method: 'POST',
        headers: operatorHeaders('operator-b'),
        body: JSON.stringify({ decision: 'approve' }),
      }).then((r) => r.json())
    ).confirmationToken as string;

    // Widen the approved roots after the token was minted.
    await fetch(`${base}/hub/pairing/requests/${requestId}/access`, {
      method: 'PATCH',
      headers: operatorHeaders('operator-a'),
      body: JSON.stringify({ requestedRoots: ['~/code', '/'] }),
    });

    const replay = await fetch(
      `${base}/hub/pairing/requests/${requestId}/approve`,
      {
        method: 'POST',
        headers: operatorHeaders('operator-a'),
        body: JSON.stringify({
          requestedRoots: ['~/code', '/'],
          confirmationToken,
        }),
      }
    );
    expect(replay.status).not.toBe(200);
    const stillPending = await fetch(
      `${base}/hub/pairing/requests/${requestId}`,
      { headers: operatorHeaders() }
    );
    expect((await stillPending.json()).request.state).toBe('pending');
  });

  it('refuses to approve an expired request', async () => {
    const { base, clock } = await setup();
    // The node does not control its own request TTL; advance past the default
    // 10-minute pending window to drive expiry.
    const { json } = await submitRequest(base);
    clock.ms = NOW_MS + 11 * 60 * 1000;
    const res = await fetch(
      `${base}/hub/pairing/requests/${json.request.requestId}/approve`,
      { method: 'POST', headers: operatorHeaders() }
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('TOKEN_EXPIRED');
  });

  it('returns NOT_FOUND for an unknown request id', async () => {
    const { base } = await setup();
    const res = await fetch(`${base}/hub/pairing/requests/ppreq_missing`, {
      headers: operatorHeaders(),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.details.reasonCode).toBe(
      'PENDING_PAIRING_NOT_FOUND'
    );
  });
});
