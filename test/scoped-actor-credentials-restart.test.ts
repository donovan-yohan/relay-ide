// Durable scoped CLI actor credential lifecycle across hub restart (#1546).
//
// Tests that scoped actor credentials minted via POST /cli-gateway/actor-credentials,
// renewed, or approved via relay-ide login are persisted hash-only in SQLite
// (scoped-actor-credentials.db) and survive hub restarts within TTL, while
// revocations survive as typed 'revoked' refusals and expired rows are pruned.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
  issueCliGatewayActorCredential,
  issueCliGatewayActorCredentialWithGrant,
  renewCliGatewayActorCredential,
  rotateCliGatewayActorCredentialWithGrant,
  validateCliGatewayActorCredential,
  CLI_GATEWAY_ACTOR_AUDIENCE,
  CLI_GATEWAY_READ_SCOPE_TASK_REF,
} from '../server/cli-gateway-actor-auth.js';
import { HandshakeGrantRegistry } from '../shared/operator-handshake-grants.js';
import type { ScopedActorCredentialRegistry } from '../shared/scoped-actor-credentials.js';

const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length) cleanup.pop()?.();
});

interface Hub {
  dbPath: string;
  store: ScopedActorCredentialStore;
  registry: ScopedActorCredentialRegistry;
  service: ScopedActorCredentialService;
  /** Close and reopen everything, exactly as a hub restart does. */
  restart(now?: () => Date): Hub;
}

function openHub(dbPath: string, options: { now?: () => Date } = {}): Hub {
  const store = createScopedActorCredentialStore(dbPath);
  const registry = createCliGatewayActorRegistry({ maxTtlMs: MAX_TTL_MS });
  const service = createScopedActorCredentialService({
    registry: () => registry,
    store: () => store,
    ...(options.now ? { now: options.now } : {}),
  });
  const hub: Hub = {
    dbPath,
    store,
    registry,
    service,
    restart(now?: () => Date): Hub {
      store.close();
      const next = openHub(dbPath, {
        ...(now ? { now } : {}),
      });
      next.service.rehydrate();
      return next;
    },
  };
  cleanup.push(() => {
    try {
      store.close();
    } catch {
      // already closed by a restart
    }
  });
  return hub;
}

function newHub(options: { now?: () => Date } = {}): Hub {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'relay-scoped-actor-cred-')
  );
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return openHub(path.join(dir, 'scoped-actor-credentials.db'), options);
}

function validate(
  hub: Hub,
  token: string,
  options: {
    capabilities?: string[];
    scope?: {
      taskRefs?: string[];
      channelIds?: string[];
      workContextIds?: string[];
    };
  } = {}
) {
  return validateCliGatewayActorCredential(hub.registry, {
    token,
    capabilities: (options.capabilities ?? ['session:read']) as never,
    ...(options.scope ? { scope: options.scope } : {}),
  });
}

describe('scoped actor credentials persistence — hash-only storage', () => {
  it('never writes the token, or any part of its secret, to the database file', () => {
    const hub = newHub();
    const issued = issueCliGatewayActorCredential(hub.registry, {
      actor: { type: 'cli', id: 'relay-cli-dev' },
      issuer: { id: 'browser-operator' },
      capabilities: ['session:read', 'context:read'],
      scope: { channelIds: ['topic:123'] },
    });
    hub.service.recordIssued(issued);

    // Force everything out of the WAL so the assertion reads the real bytes.
    hub.store.close();
    const secret = issued.token.split('.')[2] as string;
    expect(secret.length).toBeGreaterThan(32);
    for (const suffix of ['', '-wal', '-shm']) {
      const file = `${hub.dbPath}${suffix}`;
      if (!fs.existsSync(file)) continue;
      const bytes = fs.readFileSync(file).toString('latin1');
      expect(bytes).not.toContain(issued.token);
      expect(bytes).not.toContain(secret);
    }

    // What IS stored is the sha256Hex digest.
    const reopened = openHub(hub.dbPath);
    const [row] = reopened.store.listRestorableCredentials();
    expect(row?.secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.secretHash).not.toContain(secret);
  });
});

describe('scoped actor credentials persistence — restart survival', () => {
  it('keeps the SAME token working after a hub restart', () => {
    const before = newHub();
    const issued = issueCliGatewayActorCredential(before.registry, {
      actor: { type: 'cli', id: 'relay-cli-dev' },
      issuer: { id: 'browser-operator' },
      capabilities: ['session:read', 'context:read'],
      scope: { channelIds: ['topic:123'] },
    });
    before.service.recordIssued(issued);

    const after = before.restart();
    // Brand new registry instance that only knows what was rehydrated from SQLite.
    expect(after.registry).not.toBe(before.registry);

    const result = validate(after, issued.token, {
      capabilities: ['context:read'],
      scope: { channelIds: ['topic:123'] },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.credential.actor.id).toBe('relay-cli-dev');
      expect(result.credential.capabilities).toContain('context:read');
    }
  });

  it('keeps a REVOKED credential revoked across a restart with typed reason', () => {
    const before = newHub();
    const issued = issueCliGatewayActorCredential(before.registry, {
      actor: { type: 'cli', id: 'relay-cli-dev' },
      issuer: { id: 'browser-operator' },
      capabilities: ['session:read'],
    });
    before.service.recordIssued(issued);

    before.service.revoke(issued.credential.id, {
      revokedBy: 'browser-operator',
      reason: 'security rotation',
    });
    expect(validate(before, issued.token).ok).toBe(false);

    const after = before.restart();
    const result = validate(after, issued.token);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('revoked');
    }
    const cred = after.registry.getCredential(issued.credential.id);
    expect(cred?.revokedAt).toBeTruthy();
    expect(cred?.revokedBy).toBe('browser-operator');
    expect(cred?.revocationReason).toBe('security rotation');
  });

  it('prunes expired credentials on boot', () => {
    const now = Date.now();
    const hub = newHub({ now: () => new Date(now) });
    const issued = issueCliGatewayActorCredential(hub.registry, {
      actor: { type: 'cli', id: 'relay-cli-temp' },
      issuer: { id: 'browser-operator' },
      capabilities: ['session:read'],
      ttlMs: 1000,
    });
    hub.service.recordIssued(issued);

    // Restart at T + 5 seconds
    const later = new Date(now + 5000);
    const after = hub.restart(() => later);

    expect(after.registry.getCredential(issued.credential.id)).toBeNull();
    const result = validate(after, issued.token);
    expect(result.ok).toBe(false);
    expect(after.store.getCredential(issued.credential.id)).toBeNull();
  });

  it('rejects malformed token with malformed_credential reason', () => {
    const hub = newHub();
    const result = validate(hub, 'not-a-real-token');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('malformed_credential');
    }
  });

  it('rehydrates is idempotent across repeated calls', () => {
    const before = newHub();
    const issued = issueCliGatewayActorCredential(before.registry, {
      actor: { type: 'cli', id: 'relay-cli-dev' },
      issuer: { id: 'browser-operator' },
      capabilities: ['session:read'],
    });
    before.service.recordIssued(issued);

    const after = before.restart();
    const second = after.service.rehydrate();
    expect(second.restored).toBe(0);
    expect(validate(after, issued.token).ok).toBe(true);
  });
});

describe('scoped actor credentials persistence — renewal and grants', () => {
  it('persists renewed successor and authorizes across restart', () => {
    const before = newHub();
    const issued = issueCliGatewayActorCredential(before.registry, {
      actor: { type: 'cli', id: 'relay-cli-dev' },
      issuer: { id: 'browser-operator' },
      capabilities: ['session:read'],
    });
    before.service.recordIssued(issued);

    const renewed = renewCliGatewayActorCredential(
      before.registry,
      issued.credential
    );
    before.service.recordIssued(renewed);

    const after = before.restart();
    expect(validate(after, renewed.token).ok).toBe(true);
    // Old credential still works before expiry as per renew semantics
    expect(validate(after, issued.token).ok).toBe(true);
  });

  it('revocation by grant id revokes all associated credentials across restart', () => {
    const before = newHub();
    const grants = new HandshakeGrantRegistry({
      now: () => new Date(),
      secretBytes: () => Buffer.from('abcdef0123456789abcdef0123456789'),
    });

    const grant = grants.request({
      id: 'grant-101',
      actor: { type: 'cli', id: 'grant-cli' },
      issuer: { id: 'operator' },
      audience: CLI_GATEWAY_ACTOR_AUDIENCE,
      capabilities: ['session:read'],
      scope: { taskRefs: [CLI_GATEWAY_READ_SCOPE_TASK_REF] },
      ttlMs: 60_000,
      correlationId: 'corr-grant-req',
    });
    const approved = grants.approve(grant.id, {
      approvedBy: { id: 'operator' },
      correlationId: 'corr-grant-app',
    });

    const issued1 = issueCliGatewayActorCredentialWithGrant(
      before.registry,
      grants,
      {
        grantHandle: approved.handle,
        audience: CLI_GATEWAY_ACTOR_AUDIENCE,
        actor: { type: 'cli', id: 'grant-cli' },
        capabilities: ['session:read'],
        scope: { taskRefs: [CLI_GATEWAY_READ_SCOPE_TASK_REF] },
        ttlMs: 60_000,
        correlationId: 'corr-issue-g1',
      }
    );
    before.service.recordIssued(issued1);

    expect(validate(before, issued1.token).ok).toBe(true);

    before.service.revokeByGrantId('grant-101', {
      revokedBy: 'grant:grant-101',
      reason: 'operator handshake grant revoked',
    });

    expect(validate(before, issued1.token).ok).toBe(false);

    const after = before.restart();
    const result = validate(after, issued1.token);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('revoked');
    }
  });

  it('rotates credential with grant, revoking previous and persisting new across restart', () => {
    const before = newHub();
    const grants = new HandshakeGrantRegistry({
      now: () => new Date(),
      secretBytes: () => Buffer.from('abcdef0123456789abcdef0123456789'),
    });

    const grant = grants.request({
      id: 'grant-rotate-1',
      actor: { type: 'cli', id: 'rotate-cli' },
      issuer: { id: 'operator' },
      audience: CLI_GATEWAY_ACTOR_AUDIENCE,
      capabilities: ['session:read'],
      scope: { taskRefs: [CLI_GATEWAY_READ_SCOPE_TASK_REF] },
      ttlMs: 60_000,
      correlationId: 'corr-req',
    });
    const approved = grants.approve(grant.id, {
      approvedBy: { id: 'operator' },
      correlationId: 'corr-app',
    });

    const initial = issueCliGatewayActorCredentialWithGrant(
      before.registry,
      grants,
      {
        grantHandle: approved.handle,
        audience: CLI_GATEWAY_ACTOR_AUDIENCE,
        actor: { type: 'cli', id: 'rotate-cli' },
        capabilities: ['session:read'],
        scope: { taskRefs: [CLI_GATEWAY_READ_SCOPE_TASK_REF] },
        ttlMs: 60_000,
        correlationId: 'corr-init',
      }
    );
    before.service.recordIssued(initial);

    const rotateGrant = grants.request({
      id: 'grant-rotate-2',
      actor: { type: 'cli', id: 'rotate-cli' },
      issuer: { id: 'operator' },
      audience: CLI_GATEWAY_ACTOR_AUDIENCE,
      capabilities: ['session:read'],
      scope: { taskRefs: [CLI_GATEWAY_READ_SCOPE_TASK_REF] },
      ttlMs: 60_000,
      correlationId: 'corr-rot-req',
    });
    const rotateApproved = grants.approve(rotateGrant.id, {
      approvedBy: { id: 'operator' },
      correlationId: 'corr-rot-app',
    });

    const rotated = rotateCliGatewayActorCredentialWithGrant(
      before.registry,
      grants,
      initial.credential.id,
      {
        grantHandle: rotateApproved.handle,
        audience: CLI_GATEWAY_ACTOR_AUDIENCE,
        actor: { type: 'cli', id: 'rotate-cli' },
        capabilities: ['session:read'],
        scope: { taskRefs: [CLI_GATEWAY_READ_SCOPE_TASK_REF] },
        ttlMs: 60_000,
        correlationId: 'corr-rot',
      }
    );
    before.store.revokeCredential(initial.credential.id, {
      revokedBy: rotated.revoked.revokedBy ?? 'grant',
      ...(rotated.revoked.revocationReason
        ? { reason: rotated.revoked.revocationReason }
        : {}),
    });
    before.service.recordIssued(rotated);

    const after = before.restart();
    const oldResult = validate(after, initial.token);
    expect(oldResult.ok).toBe(false);
    if (!oldResult.ok) expect(oldResult.reason).toBe('revoked');

    const newResult = validate(after, rotated.token);
    expect(newResult.ok).toBe(true);
  });
});
