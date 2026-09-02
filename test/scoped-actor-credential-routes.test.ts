// HTTP route tests for scoped CLI actor credential lifecycle and restart survival (#1546).

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import http from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createScopedActorCredentialStore,
  type ScopedActorCredentialStore,
} from '../server/scoped-actor-credential-store.js';
import {
  createScopedActorCredentialService,
  type ScopedActorCredentialService,
} from '../server/scoped-actor-credentials.js';
import {
  createCliGatewayActorRegistry,
  createCliGatewayHandshakeGrantRegistry,
  issueCliGatewayActorCredential,
  issueCliGatewayActorCredentialWithGrant,
  renewCliGatewayActorCredential,
  validateCliGatewayActorCredential,
  classifyCliGatewayCredentialLane,
  cliGatewayCorrelationId,
  bearerActorToken,
  sendCliGatewayActorFailure,
  cliGatewayActorFailure,
  CLI_GATEWAY_ACTOR_RENEW_COMMAND,
  type CliGatewayActorIssueInput,
} from '../server/cli-gateway-actor-auth.js';
import type { ScopedActorCredentialRegistry } from '../shared/scoped-actor-credentials.js';

const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const cleanup: Array<() => void> = [];

afterEach(async () => {
  while (cleanup.length) {
    const fn = cleanup.pop();
    if (fn) await fn();
  }
});

interface AppContext {
  server: http.Server;
  baseUrl: string;
  dbPath: string;
  store: ScopedActorCredentialStore;
  registry: ScopedActorCredentialRegistry;
  service: ScopedActorCredentialService;
  close: () => Promise<void>;
  restart: () => Promise<AppContext>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function createApp(dbPath: string): Promise<AppContext> {
  const store = createScopedActorCredentialStore(dbPath);
  const registry = createCliGatewayActorRegistry({ maxTtlMs: MAX_TTL_MS });
  const grants = createCliGatewayHandshakeGrantRegistry();
  const service = createScopedActorCredentialService({
    registry: () => registry,
    store: () => store,
  });

  const app = express();
  app.use(express.json());

  const actorLifecycleError = (res: express.Response, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const reason =
      error instanceof Error &&
      'reason' in error &&
      typeof error.reason === 'string'
        ? error.reason
        : 'issue_failed';
    res.status(reason === 'credential_not_found' ? 404 : 400).json({
      error: {
        code: `CLI_ACTOR_CREDENTIAL_${reason.toUpperCase()}`,
        message,
        retryable: false,
      },
    });
  };

  app.post('/cli-gateway/actor-credentials', (req, res) => {
    try {
      const body = isRecord(req.body)
        ? (req.body as CliGatewayActorIssueInput)
        : {};
      const issued =
        isRecord(req.body) && typeof req.body['grantHandle'] === 'string'
          ? issueCliGatewayActorCredentialWithGrant(registry, grants, req.body)
          : issueCliGatewayActorCredential(registry, body);
      try {
        service.recordIssued(issued);
      } catch (persistError) {
        registry.revoke(issued.credential.id, {
          revokedBy: 'hub-persistence-failed',
          reason: 'failed to persist scoped actor credential',
        });
        throw persistError;
      }
      res.status(201).json({
        token: issued.token,
        credential: issued.credential,
      });
    } catch (error) {
      actorLifecycleError(res, error);
    }
  });

  app.post('/cli-gateway/actor-credentials/renew', (req, res) => {
    const lane = classifyCliGatewayCredentialLane(
      req as never,
      CLI_GATEWAY_ACTOR_RENEW_COMMAND
    );
    if (lane !== 'scoped-actor-credential') {
      sendCliGatewayActorFailure(res, cliGatewayActorFailure({ lane }));
      return;
    }
    const correlationId = cliGatewayCorrelationId(req as never);
    const validation = validateCliGatewayActorCredential(registry, {
      token: bearerActorToken(req as never),
      capabilities: [],
      ...(correlationId ? { correlationId } : {}),
    });
    if ('reason' in validation) {
      sendCliGatewayActorFailure(
        res,
        cliGatewayActorFailure({
          reason: validation.reason,
          ...(validation.credentialId
            ? { credentialId: validation.credentialId }
            : {}),
          deniedBits: validation.deniedBits,
          ...(correlationId ? { correlationId } : {}),
        })
      );
      return;
    }
    try {
      const body = isRecord(req.body) ? req.body : {};
      const issued = renewCliGatewayActorCredential(
        registry,
        validation.credential,
        body
      );
      try {
        service.recordIssued(issued);
      } catch (persistError) {
        registry.revoke(issued.credential.id, {
          revokedBy: 'hub-persistence-failed',
          reason: 'failed to persist renewed scoped actor credential',
        });
        throw persistError;
      }
      res.status(201).json({
        token: issued.token,
        credential: issued.credential,
        superseded: validation.credential.id,
      });
    } catch (error) {
      actorLifecycleError(res, error);
    }
  });

  app.get('/cli-gateway/actor-credentials', (_req, res) => {
    res.json({ credentials: registry.listCredentials() });
  });

  app.delete('/cli-gateway/actor-credentials/:id', (req, res) => {
    const id = req.params['id'];
    if (!id) {
      res
        .status(400)
        .json({ error: { code: 'CLI_ACTOR_CREDENTIAL_ID_REQUIRED' } });
      return;
    }
    const body = isRecord(req.body) ? req.body : {};
    const credential = service.revoke(id, {
      revokedBy:
        typeof body['revokedBy'] === 'string'
          ? body['revokedBy']
          : 'browser-operator',
      ...(typeof body['reason'] === 'string' ? { reason: body['reason'] } : {}),
    });
    if (!credential) {
      res.status(404).json({
        error: { code: 'CLI_ACTOR_CREDENTIAL_NOT_FOUND', message: 'not found' },
      });
      return;
    }
    res.json({ credential });
  });

  let serverInstance: http.Server;
  await new Promise<void>((resolve) => {
    serverInstance = app.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = serverInstance!.address() as import('node:net').AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const close = async () => {
    await new Promise<void>((resolve) => serverInstance.close(() => resolve()));
    try {
      store.close();
    } catch {
      /* already closed */
    }
  };

  const context: AppContext = {
    server: serverInstance!,
    baseUrl,
    dbPath,
    store,
    registry,
    service,
    close,
    restart: async () => {
      await close();
      const next = await createApp(dbPath);
      next.service.rehydrate();
      return next;
    },
  };

  return context;
}

async function request(
  ctx: AppContext,
  method: string,
  urlPath: string,
  options: {
    headers?: Record<string, string>;
    body?: unknown;
  } = {}
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${ctx.baseUrl}${urlPath}`, {
    method,
    headers: {
      ...(options.body !== undefined
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...(options.headers ?? {}),
    },
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text ? JSON.parse(text) : {},
  };
}

describe('scoped actor credential route lifecycle across restart', () => {
  it('mints via POST /cli-gateway/actor-credentials and survives restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-route-cred-'));
    cleanup.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
    const dbPath = path.join(dir, 'scoped-actor-credentials.db');

    let ctx = await createApp(dbPath);
    cleanup.push(async () => ctx.close());

    // Mint token
    const mintRes = await request(
      ctx,
      'POST',
      '/cli-gateway/actor-credentials',
      {
        body: {
          actor: { type: 'cli', id: 'cli-test-route' },
          capabilities: ['session:read', 'context:read'],
          scope: { channelIds: ['topic:ch1'] },
        },
      }
    );

    expect(mintRes.status).toBe(201);
    expect(mintRes.body.token).toMatch(/^relay-sac-v1\./);
    const token = mintRes.body.token;

    // Simulate restart
    ctx = await ctx.restart();

    // Verify token still validates in the new instance
    const validation = validateCliGatewayActorCredential(ctx.registry, {
      token,
      capabilities: ['context:read'],
      scope: { channelIds: ['topic:ch1'] },
    });
    expect(validation.ok).toBe(true);

    // List credentials shows the restored credential
    const listRes = await request(ctx, 'GET', '/cli-gateway/actor-credentials');
    expect(listRes.status).toBe(200);
    expect(
      listRes.body.credentials.some((c: any) => c.actor.id === 'cli-test-route')
    ).toBe(true);
  });

  it('revokes via DELETE /cli-gateway/actor-credentials/:id and stays revoked across restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-route-cred-'));
    cleanup.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
    const dbPath = path.join(dir, 'scoped-actor-credentials.db');

    let ctx = await createApp(dbPath);
    cleanup.push(async () => ctx.close());

    const mintRes = await request(
      ctx,
      'POST',
      '/cli-gateway/actor-credentials',
      {
        body: {
          actor: { type: 'cli', id: 'cli-revoke-test' },
          capabilities: ['session:read'],
        },
      }
    );
    expect(mintRes.status).toBe(201);
    const { token, credential } = mintRes.body;

    // Revoke
    const delRes = await request(
      ctx,
      'DELETE',
      `/cli-gateway/actor-credentials/${credential.id}`,
      {
        body: { reason: 'operator test' },
      }
    );
    expect(delRes.status).toBe(200);
    expect(delRes.body.credential.revokedAt).toBeTruthy();

    // Restart
    ctx = await ctx.restart();

    // Validating token fails as revoked
    const validation = validateCliGatewayActorCredential(ctx.registry, {
      token,
      capabilities: ['session:read'],
    });
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.reason).toBe('revoked');
    }
  });

  it('renews via POST /cli-gateway/actor-credentials/renew and successor survives restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-route-cred-'));
    cleanup.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
    const dbPath = path.join(dir, 'scoped-actor-credentials.db');

    let ctx = await createApp(dbPath);
    cleanup.push(async () => ctx.close());

    const mintRes = await request(
      ctx,
      'POST',
      '/cli-gateway/actor-credentials',
      {
        body: {
          actor: { type: 'cli', id: 'cli-renew-test' },
          capabilities: ['session:read'],
        },
      }
    );
    expect(mintRes.status).toBe(201);
    const { token: oldToken } = mintRes.body;

    // Renew
    const renewRes = await request(
      ctx,
      'POST',
      '/cli-gateway/actor-credentials/renew',
      {
        headers: {
          authorization: `Bearer ${oldToken}`,
          'x-relay-cli-actor-token': 'v1',
          'x-relay-cli-command': CLI_GATEWAY_ACTOR_RENEW_COMMAND,
        },
        body: { ttlMs: 60_000 },
      }
    );
    expect(renewRes.status).toBe(201);
    const { token: newToken } = renewRes.body;

    // Restart
    ctx = await ctx.restart();

    // New token validates
    const valNew = validateCliGatewayActorCredential(ctx.registry, {
      token: newToken,
      capabilities: ['session:read'],
    });
    expect(valNew.ok).toBe(true);

    // Old token also validates until expiry
    const valOld = validateCliGatewayActorCredential(ctx.registry, {
      token: oldToken,
      capabilities: ['session:read'],
    });
    expect(valOld.ok).toBe(true);
  });
});
