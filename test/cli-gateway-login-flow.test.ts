import { afterAll, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { Server } from 'node:http';
import {
  CliGatewayLoginFlowRegistry,
  CliGatewayLoginFlowError,
  generateCliLoginCode,
  createCliGatewayLoginRouter,
} from '../server/cli-gateway-login-flow.js';
import {
  createCliGatewayActorRegistry,
  issueCliGatewayActorCredential,
  renewCliGatewayActorCredential,
  validateCliGatewayActorCredential,
  CLI_GATEWAY_ACTOR_AUDIENCE,
  CLI_GATEWAY_READ_SCOPE_TASK_REF,
} from '../server/cli-gateway-actor-auth.js';
import {
  ScopedActorCredentialRegistry,
  type ScopedActorCredentialRecord,
} from '../shared/scoped-actor-credentials.js';

const NOW = new Date('2026-08-25T00:00:00.000Z');

function registryWithClock() {
  return createCliGatewayActorRegistry({ maxTtlMs: 30 * 24 * 60 * 60 * 1000 });
}

function flowRegistry(options: {
  actorRegistry?: ReturnType<typeof createCliGatewayActorRegistry>;
  clock?: () => Date;
  minted?: IssuedCapture[];
}) {
  const actorRegistry = options.actorRegistry ?? registryWithClock();
  const clock = options.clock ?? (() => NOW);
  const minted = options.minted ?? [];
  const flows = new CliGatewayLoginFlowRegistry({
    issueCredential: ({ flow, approvedBy }) => {
      const issued = issueCliGatewayActorCredential(actorRegistry, {
        actor: { type: 'cli', id: flow.actorId },
        issuer: { id: approvedBy },
        capabilities: flow.requestedCapabilities,
        scope: { taskRefs: [CLI_GATEWAY_READ_SCOPE_TASK_REF] },
      });
      minted.push(issued);
      return issued;
    },
    now: clock,
  });
  return { flows, actorRegistry, minted };
}

interface IssuedCapture {
  token: string;
  credential: ScopedActorCredentialRecord;
}

describe('generateCliLoginCode', () => {
  it('produces XXXX-XXXX without ambiguous glyphs', () => {
    for (let index = 0; index < 50; index += 1) {
      const code = generateCliLoginCode();
      expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    }
  });
});

describe('CliGatewayLoginFlowRegistry lifecycle', () => {
  it('start → approve → poll delivers token exactly once', () => {
    const { flows, minted } = flowRegistry({});
    const flow = flows.start({ actorId: 'relay-cli@box' });
    expect(flow.status).toBe('pending');
    expect(flow.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    // Pending polls carry no token material.
    const pendingPoll = flows.poll(flow.flowId);
    expect(pendingPoll.status).toBe('pending');
    expect(pendingPoll.token).toBeUndefined();

    flows.approve(flow.flowId, { approvedBy: 'browser-operator' });

    const first = flows.poll(flow.flowId);
    expect(first.status).toBe('approved');
    expect(typeof first.token).toBe('string');
    expect(first.token).toMatch(/^relay-sac-v1\./);
    expect(first.credential?.id).toBeTruthy();

    // Second poll reports consumed and NEVER re-delivers the token.
    const second = flows.poll(flow.flowId);
    expect(second.status).toBe('consumed');
    expect(second.token).toBeUndefined();
    // The token was minted once.
    expect(minted).toHaveLength(1);
  });

  it('denied flows never deliver a token', () => {
    const { flows, minted } = flowRegistry({});
    const flow = flows.start({});
    flows.deny(flow.flowId, {});
    const poll = flows.poll(flow.flowId);
    expect(poll.status).toBe('denied');
    expect(poll.token).toBeUndefined();
    expect(minted).toHaveLength(0);
  });

  it('expired flows cannot be approved and read as expired on poll', () => {
    let current = NOW.getTime();
    const clock = () => new Date(current);
    const { flows } = flowRegistry({ clock });
    const flow = flows.start({});
    current += 6 * 60 * 1000; // past the 5-minute TTL
    expect(flows.poll(flow.flowId).status).toBe('expired');
    expect(() => flows.approve(flow.flowId, {})).toThrow(
      CliGatewayLoginFlowError
    );
    const poll = flows.poll(flow.flowId);
    expect(poll.status).toBe('expired');
    expect(poll.token).toBeUndefined();
  });

  it('rejects unsupported capability requests before any approval', () => {
    const { flows } = flowRegistry({});
    expect(() =>
      flows.start({ capabilities: ['session:read', 'hub:own-everything'] }, [
        'session:read',
        'context:write',
      ])
    ).toThrow(/unsupported capabilities/);
  });

  it('unknown flow ids fail closed', () => {
    const { flows } = flowRegistry({});
    expect(() => flows.poll('00000000-0000-0000-0000-000000000000')).toThrow(
      /unknown CLI login flow/
    );
  });

  it('caps the number of simultaneously pending flows', () => {
    let current = NOW.getTime();
    const clock = () => new Date(current);
    const { flows } = flowRegistry({ clock });
    for (let index = 0; index < 20; index += 1) {
      flows.start({});
    }
    expect(() => flows.start({})).toThrow(/too many pending/);
    // Expiry frees slots.
    current += 6 * 60 * 1000;
    expect(() => flows.start({})).not.toThrow();
  });
});

// ── HTTP surface with a mocked browser leg ───────────────────────────────────

async function startServer(router: express.Router): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const app = express();
  app.use(express.json());
  app.use('/cli-gateway/login', router);
  const server: Server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function testRouter(flows: CliGatewayLoginFlowRegistry) {
  return createCliGatewayLoginRouter({
    flows,
    verifyPin: async (pin) => pin === '4321',
    isRateLimited: () => false,
    recordFailedAttempt: () => undefined,
    clearRateLimit: () => undefined,
    allowedCapabilities: ['session:read'],
    baseUrl: () => 'http://127.0.0.1:3456',
  });
}

const cleanupServers: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const close of cleanupServers) await close();
});

describe('login HTTP flow (mocked browser leg)', () => {
  it('full simulated flow: start → approve with PIN → poll returns usable scoped token', async () => {
    const { flows, actorRegistry, minted } = flowRegistry({});
    const server = await startServer(testRouter(flows));
    cleanupServers.push(server.close);

    // 1. CLI starts the flow.
    const startResponse = await fetch(
      `${server.baseUrl}/cli-gateway/login/start`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          actorId: 'relay-cli@testbox',
          displayName: 'testbox',
        }),
      }
    );
    expect(startResponse.status).toBe(201);
    const start = (await startResponse.json()) as {
      flowId: string;
      code: string;
      verificationUrl: string;
      expiresAt: string;
    };
    expect(start.flowId).toBeTruthy();
    expect(start.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(start.verificationUrl).toContain(start.flowId);

    // 2. Browser leg (mocked): GET the approval page, then POST the PIN.
    const page = await fetch(
      `${server.baseUrl}/cli-gateway/login/${start.flowId}/approve`
    );
    expect(page.status).toBe(200);
    const pageHtml = await page.text();
    expect(pageHtml).toContain(start.code);
    expect(pageHtml).toContain('relay-cli@testbox');

    // Wrong PIN does not approve.
    const badResponse = await fetch(
      `${server.baseUrl}/cli-gateway/login/${start.flowId}/approve`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pin: '0000' }),
      }
    );
    expect(badResponse.status).toBe(401);

    // Correct PIN approves.
    const approveResponse = await fetch(
      `${server.baseUrl}/cli-gateway/login/${start.flowId}/approve`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pin: '4321' }),
      }
    );
    expect(approveResponse.status).toBe(200);

    // 3. CLI polls and gets the token ONCE; validation against the real
    // registry succeeds for session reads.
    const pollResponse = await fetch(
      `${server.baseUrl}/cli-gateway/login/${encodeURIComponent(start.flowId)}`
    );
    const poll = (await pollResponse.json()) as {
      status: string;
      token?: string;
    };
    expect(poll.status).toBe('approved');
    expect(typeof poll.token).toBe('string');

    const validation = validateCliGatewayActorCredential(actorRegistry, {
      token: poll.token!,
      capabilities: ['session:read'],
      scope: { taskRef: CLI_GATEWAY_READ_SCOPE_TASK_REF },
    });
    expect(validation.ok).toBe(true);
    if (validation.ok) {
      expect(validation.credential.audience).toBe(CLI_GATEWAY_ACTOR_AUDIENCE);
    }

    // Second poll: no token re-delivery.
    const secondPoll = await (
      await fetch(
        `${server.baseUrl}/cli-gateway/login/${encodeURIComponent(start.flowId)}`
      )
    ).json();
    expect((secondPoll as { status: string }).status).toBe('consumed');
    expect((secondPoll as { token?: string }).token).toBeUndefined();
    expect(minted).toHaveLength(1);
  });

  it('deny action marks the flow denied and polling never yields a token', async () => {
    const { flows, minted } = flowRegistry({});
    const server = await startServer(testRouter(flows));
    cleanupServers.push(server.close);
    const start = await (
      await fetch(`${server.baseUrl}/cli-gateway/login/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
    ).json();
    const { flowId } = start as { flowId: string };
    const denyResponse = await fetch(
      `${server.baseUrl}/cli-gateway/login/${flowId}/approve`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pin: '4321', action: 'deny' }),
      }
    );
    expect(denyResponse.status).toBe(200);
    const body = (await denyResponse.text()).toLowerCase();
    expect(body).toContain('denied');
    const poll = (await (
      await fetch(`${server.baseUrl}/cli-gateway/login/${flowId}`)
    ).json()) as { status: string; token?: string };
    expect(poll.status).toBe('denied');
    expect(poll.token).toBeUndefined();
    expect(minted).toHaveLength(0);
  });

  it('unknown flow ids return 404 on both legs', async () => {
    const { flows } = flowRegistry({});
    const server = await startServer(testRouter(flows));
    cleanupServers.push(server.close);
    const pollStatus = await fetch(
      `${server.baseUrl}/cli-gateway/login/not-a-real-flow-id-value`
    );
    expect(pollStatus.status).toBe(404);
    const pageStatus = await fetch(
      `${server.baseUrl}/cli-gateway/login/00000000-0000-0000-0000-00000000dead/approve`
    );
    expect(pageStatus.status).toBe(404);
  });
});

// ── renewal rotation + config knob + revocation fail-closed (#1435 scope 2) ──

describe('actor credential renewal semantics', () => {
  it('renew issues successor with same actor/capabilities/scope; predecessor stays valid until natural expiry; revoked fails closed immediately', () => {
    let current = NOW.getTime();
    // 30-day ceiling mirrors the raised default the login flow relies on.
    const reg = new ScopedActorCredentialRegistry({
      now: () => new Date(current),
      maxTtlMs: 30 * 24 * 60 * 60 * 1000,
    });
    const issued = issueCliGatewayActorCredential(reg, {
      actor: { type: 'cli', id: 'relay-cli@box' },
      issuer: { id: 'operator' },
      capabilities: ['session:read'],
      scope: { taskRefs: [CLI_GATEWAY_READ_SCOPE_TASK_REF] },
      ttlMs: 60_000,
    });

    // Renew BEFORE expiry: successor copies identity dimensions verbatim.
    const renewedAt = current + 30_000;
    current = renewedAt;
    const successor = renewCliGatewayActorCredential(
      reg,
      issued.credential,
      {}
    );
    expect(successor.credential.actor).toEqual(issued.credential.actor);
    expect(successor.credential.capabilities).toEqual(
      issued.credential.capabilities
    );
    expect(successor.credential.scope).toEqual(issued.credential.scope);
    expect(successor.token).not.toEqual(issued.token);
    // Successor TTL defaults to 30 days from renewal time.
    expect(Date.parse(successor.credential.expiresAt)).toBeGreaterThanOrEqual(
      renewedAt + 29 * 24 * 60 * 60 * 1000
    );

    // Both credentials validate while the old one is unexpired.
    for (const token of [issued.token, successor.token]) {
      const result = validateCliGatewayActorCredential(reg, {
        token,
        capabilities: ['session:read'],
        scope: { taskRef: CLI_GATEWAY_READ_SCOPE_TASK_REF },
      });
      expect(result.ok).toBe(true);
    }

    // Revoke the SUCCESSOR: it fails closed immediately even though a client
    // might still hold it in a file.
    reg.revoke(successor.credential.id, {
      revokedBy: 'test-operator',
      reason: 'logout',
    });
    const revokedResult = validateCliGatewayActorCredential(reg, {
      token: successor.token,
      capabilities: ['session:read'],
      scope: { taskRef: CLI_GATEWAY_READ_SCOPE_TASK_REF },
    });
    expect(revokedResult.ok).toBe(false);
    if (!revokedResult.ok) expect(revokedResult.reason).toBe('revoked');

    // Advance past the old credential's expiry: it fails closed as expired.
    current = NOW.getTime() + 61_000;
    const expiredResult = validateCliGatewayActorCredential(reg, {
      token: issued.token,
      capabilities: ['session:read'],
      scope: { taskRef: CLI_GATEWAY_READ_SCOPE_TASK_REF },
    });
    expect(expiredResult.ok).toBe(false);
    if (!expiredResult.ok) expect(expiredResult.reason).toBe('expired');
  });

  it('config knob raises the registry ceiling above the 15-minute default', async () => {
    const { createCliGatewayActorRegistry: factory } =
      await import('../server/cli-gateway-actor-auth.js');
    const defaultRegistry = factory();
    // Default ceiling (15 min): a 1-hour TTL must be rejected…
    expect(() =>
      issueCliGatewayActorCredential(defaultRegistry, {
        actor: { type: 'cli', id: 'relay-cli' },
        issuer: { id: 'op' },
        capabilities: ['session:read'],
        scope: { taskRefs: [CLI_GATEWAY_READ_SCOPE_TASK_REF] },
        ttlMs: 60 * 60 * 1000,
      })
    ).toThrow(/EXPIRY_EXCEEDS_MAX_TTL/);

    // …but a registry built with the raised ceiling accepts it.
    const dayRegistry = factory({ maxTtlMs: 30 * 24 * 60 * 60 * 1000 });
    const longIssued = issueCliGatewayActorCredential(dayRegistry, {
      actor: { type: 'cli', id: 'relay-cli' },
      issuer: { id: 'op' },
      capabilities: ['session:read'],
      scope: { taskRefs: [CLI_GATEWAY_READ_SCOPE_TASK_REF] },
      ttlMs: 60 * 60 * 1000,
    });
    expect(longIssued.credential.id).toBeTruthy();

    // Even the raised ceiling still rejects TTLs above it.
    expect(() =>
      issueCliGatewayActorCredential(dayRegistry, {
        actor: { type: 'cli', id: 'relay-cli' },
        issuer: { id: 'op' },
        capabilities: ['session:read'],
        scope: { taskRefs: [CLI_GATEWAY_READ_SCOPE_TASK_REF] },
        ttlMs: 31 * 24 * 60 * 60 * 1000,
      })
    ).toThrow(/EXPIRY_EXCEEDS_MAX_TTL/);
  });
});
