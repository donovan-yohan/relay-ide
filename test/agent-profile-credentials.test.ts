// Durable per-profile actor credential lifecycle (#1455 slice 3).
//
// The load-bearing claims of the slice are all here: a token survives a hub
// restart, a revocation survives one too, and the hub never writes anything
// replayable to disk.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createAgentProfileStore,
  type AgentProfileStore,
} from '../server/agent-profile-store.js';
import {
  createAgentProfileCredentialService,
  AgentProfileCredentialError,
  type AgentProfileCredentialService,
} from '../server/agent-profile-credentials.js';
import {
  createCliGatewayActorRegistry,
  issueAgentProfileCliGatewayActorCredential,
  issueCliGatewayActorCredential,
  isAgentProfileActorCredential,
  renewCliGatewayActorCredential,
  credentialDefersChannelScopeToMembership,
  validateCliGatewayActorCredential,
} from '../server/cli-gateway-actor-auth.js';
import type { ScopedActorCredentialRegistry } from '../shared/scoped-actor-credentials.js';
import { builtInAgentProfileId } from '../shared/agent-profile.js';
import { AGENT_PROFILE_CREDENTIAL_CAPABILITIES } from '../shared/agent-profile-credential.js';

const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length) cleanup.pop()?.();
});

interface Hub {
  dbPath: string;
  store: AgentProfileStore;
  registry: ScopedActorCredentialRegistry;
  credentials: AgentProfileCredentialService;
  profileId: string;
  /** Close and reopen everything, exactly as a hub restart does. */
  restart(now?: () => Date): Hub;
}

function openHub(
  dbPath: string,
  options: { seed?: boolean; now?: () => Date } = {}
): Hub {
  const store = createAgentProfileStore(dbPath);
  if (options.seed !== false) store.seedBuiltIns([{ id: 'hermes' }]);
  const registry = createCliGatewayActorRegistry({ maxTtlMs: MAX_TTL_MS });
  const credentials = createAgentProfileCredentialService({
    registry: () => registry,
    store: () => store,
    maxTtlMs: () => MAX_TTL_MS,
    ...(options.now ? { now: options.now } : {}),
  });
  const hub: Hub = {
    dbPath,
    store,
    registry,
    credentials,
    profileId: builtInAgentProfileId('hermes'),
    restart(now?: () => Date): Hub {
      store.close();
      const next = openHub(dbPath, {
        seed: false,
        ...(now ? { now } : {}),
      });
      next.credentials.rehydrate();
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-profile-cred-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return openHub(path.join(dir, 'agent-profiles.db'), options);
}

function validate(
  hub: Hub,
  token: string,
  capabilities: string[] = ['context:write']
) {
  return validateCliGatewayActorCredential(hub.registry, {
    token,
    capabilities: capabilities as never,
  });
}

describe('agent profile credentials — mint', () => {
  it('binds the credential to the profile Actor id and the fixed capability set', () => {
    const hub = newHub();
    const minted = hub.credentials.mint({
      profileId: hub.profileId,
      issuerId: 'human:operator',
    });
    expect(minted.credential.actorId).toBe(hub.profileId);
    expect(minted.credential.profileId).toBe(hub.profileId);
    expect(minted.credential.state).toBe('active');
    expect(minted.credential.capabilities).toEqual([
      ...AGENT_PROFILE_CREDENTIAL_CAPABILITIES,
    ]);
    const record = hub.registry.getCredential(minted.credential.credentialId);
    expect(isAgentProfileActorCredential(record ?? undefined)).toBe(true);
    // No channel scope: reach is membership, and the deferral predicate must
    // agree with the shape the mint actually produces.
    expect(record?.scope.channelIds).toBeUndefined();
    expect(credentialDefersChannelScopeToMembership(record ?? undefined)).toBe(
      true
    );
  });

  it('caps a requested TTL at the hub ceiling and never exceeds it', () => {
    const hub = newHub();
    const minted = hub.credentials.mint({
      profileId: hub.profileId,
      issuerId: 'human:operator',
      ttlMs: MAX_TTL_MS * 10,
    });
    const life =
      new Date(minted.credential.expiresAt).getTime() -
      new Date(minted.credential.issuedAt).getTime();
    expect(life).toBeLessThanOrEqual(MAX_TTL_MS);
  });

  it('is usable immediately on the gateway lane', () => {
    const hub = newHub();
    const minted = hub.credentials.mint({
      profileId: hub.profileId,
      issuerId: 'human:operator',
    });
    expect(validate(hub, minted.token).ok).toBe(true);
  });
});

describe('agent profile credentials — hash-only storage', () => {
  it('never writes the token, or any part of its secret, to the database file', () => {
    const hub = newHub();
    const minted = hub.credentials.mint({
      profileId: hub.profileId,
      issuerId: 'human:operator',
    });
    // Force everything out of the WAL so the assertion reads the real bytes.
    hub.store.close();
    const secret = minted.token.split('.')[2] as string;
    expect(secret.length).toBeGreaterThan(32);
    for (const suffix of ['', '-wal', '-shm']) {
      const file = `${hub.dbPath}${suffix}`;
      if (!fs.existsSync(file)) continue;
      const bytes = fs.readFileSync(file).toString('latin1');
      expect(bytes).not.toContain(minted.token);
      expect(bytes).not.toContain(secret);
    }
    // What IS stored is the digest the registry compares against.
    const reopened = openHub(hub.dbPath, { seed: false });
    const [row] = reopened.store.listRestorableCredentials();
    expect(row?.secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.secretHash).not.toContain(secret);
  });

  it('keeps the digest off every ordinary read path', () => {
    const hub = newHub();
    hub.credentials.mint({
      profileId: hub.profileId,
      issuerId: 'human:operator',
    });
    const status = hub.credentials.status(hub.profileId);
    expect(status).not.toBeNull();
    expect(JSON.stringify(status)).not.toContain('secretHash');
    expect(
      Object.keys(hub.store.getCredentialStatus(hub.profileId) ?? {})
    ).not.toContain('secretHash');
  });
});

describe('agent profile credentials — restart survival', () => {
  it('keeps the SAME token working after a hub restart', () => {
    const before = newHub();
    const minted = before.credentials.mint({
      profileId: before.profileId,
      issuerId: 'human:operator',
    });
    const after = before.restart();
    // The pre-restart registry object is gone; this is a brand-new one that has
    // only ever seen the persisted row.
    expect(after.registry).not.toBe(before.registry);
    const result = validate(after, minted.token);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.credential.actor.id).toBe(before.profileId);
      expect(isAgentProfileActorCredential(result.credential)).toBe(true);
    }
    // And the restored credential still defers channel scope to membership,
    // which is the property the channel routers branch on.
    const record = after.registry.getCredential(minted.credential.credentialId);
    expect(credentialDefersChannelScopeToMembership(record ?? undefined)).toBe(
      true
    );
  });

  it('reports the same status after a restart, including issue time', () => {
    const before = newHub();
    const minted = before.credentials.mint({
      profileId: before.profileId,
      issuerId: 'human:operator',
    });
    const after = before.restart();
    expect(after.credentials.status(before.profileId)).toEqual(
      minted.credential
    );
  });

  it('keeps a REVOKED credential revoked across a restart', () => {
    const before = newHub();
    const minted = before.credentials.mint({
      profileId: before.profileId,
      issuerId: 'human:operator',
    });
    before.credentials.revoke({
      profileId: before.profileId,
      revokedBy: 'human:operator',
    });
    expect(validate(before, minted.token).ok).toBe(false);
    const after = before.restart();
    const result = validate(after, minted.token);
    expect(result.ok).toBe(false);
    // Restored AS revoked, so the refusal is the typed one rather than an
    // unexplained unknown-credential rejection.
    if (!result.ok) expect(result.reason).toBe('revoked');
    expect(after.credentials.status(before.profileId)?.state).toBe('revoked');
  });

  it('does not restore, and prunes, an expired row', () => {
    const hub = newHub();
    const minted = hub.credentials.mint({
      profileId: hub.profileId,
      issuerId: 'human:operator',
      ttlMs: 1000,
    });
    const later = new Date(Date.now() + 5000);
    const after = hub.restart(() => later);
    expect(after.registry.getCredential(minted.credential.credentialId)).toBe(
      null
    );
    expect(validate(after, minted.token).ok).toBe(false);
    expect(after.store.getCredentialStatus(hub.profileId)).toBe(null);
  });

  it('is idempotent: a second rehydrate neither duplicates nor breaks anything', () => {
    const before = newHub();
    const minted = before.credentials.mint({
      profileId: before.profileId,
      issuerId: 'human:operator',
    });
    const after = before.restart();
    const second = after.credentials.rehydrate();
    expect(second.restored).toBe(0);
    expect(validate(after, minted.token).ok).toBe(true);
  });
});

describe('agent profile credentials — rotation and revocation', () => {
  it('rotation kills the previous token in the same operation', () => {
    const hub = newHub();
    const first = hub.credentials.mint({
      profileId: hub.profileId,
      issuerId: 'human:operator',
    });
    const second = hub.credentials.mint({
      profileId: hub.profileId,
      issuerId: 'human:operator',
    });
    expect(second.token).not.toBe(first.token);
    const old = validate(hub, first.token);
    expect(old.ok).toBe(false);
    if (!old.ok) expect(old.reason).toBe('revoked');
    expect(validate(hub, second.token).ok).toBe(true);
    // Exactly one live row survives — the DB-level invariant, not just intent.
    const rows = hub.store
      .listRestorableCredentials()
      .filter((row) => row.revokedAt === null);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.credentialId).toBe(second.credential.credentialId);
  });

  it('rotation survives a restart with only the new token working', () => {
    const before = newHub();
    const first = before.credentials.mint({
      profileId: before.profileId,
      issuerId: 'human:operator',
    });
    const second = before.credentials.mint({
      profileId: before.profileId,
      issuerId: 'human:operator',
    });
    const after = before.restart();
    expect(validate(after, first.token).ok).toBe(false);
    expect(validate(after, second.token).ok).toBe(true);
  });

  it('refuses to revoke when the profile holds nothing live', () => {
    const hub = newHub();
    expect(() =>
      hub.credentials.revoke({
        profileId: hub.profileId,
        revokedBy: 'human:operator',
      })
    ).toThrowError(AgentProfileCredentialError);
    hub.credentials.mint({
      profileId: hub.profileId,
      issuerId: 'human:operator',
    });
    hub.credentials.revoke({
      profileId: hub.profileId,
      revokedBy: 'human:operator',
    });
    // A second revoke is a 404, not a silent success that revoked nothing.
    expect(() =>
      hub.credentials.revoke({
        profileId: hub.profileId,
        revokedBy: 'human:operator',
      })
    ).toThrowError(/no live credential/);
  });

  it('cuts EVERY live row out of the registry, not just the first', () => {
    const hub = newHub();
    const issued = [0, 1].map(() =>
      issueAgentProfileCliGatewayActorCredential(hub.registry, {
        actor: { type: 'agent', id: hub.profileId },
        issuer: { id: 'human:operator' },
        capabilities: ['context:read'],
        scope: {},
        ttlMs: 60_000,
      })
    );
    // The partial unique index means one live row per profile TODAY, so the
    // difference between "revoke the first" and "revoke them all" is invisible
    // through the real store. A store double supplying two rows is what makes
    // the sweep testable — and reverting the service to `revoked[0]` leaves the
    // second credential authenticating from memory until the next restart.
    const rows = issued.map((entry) => ({
      credentialId: entry.credential.id,
      profileId: hub.profileId,
      actorId: hub.profileId,
      displayName: null,
      issuerId: 'human:operator',
      capabilities: [...entry.credential.capabilities],
      issuedAt: entry.credential.issuedAt,
      expiresAt: entry.credential.expiresAt,
      revokedAt: new Date().toISOString(),
      revokedBy: 'human:operator',
      lastUsedAt: null,
    }));
    const doubled = {
      ...hub.store,
      revokeCredentialsForProfile: () => rows,
    } as unknown as AgentProfileStore;
    const service = createAgentProfileCredentialService({
      registry: () => hub.registry,
      store: () => doubled,
      maxTtlMs: () => MAX_TTL_MS,
    });
    service.revoke({ profileId: hub.profileId, revokedBy: 'human:operator' });
    for (const entry of issued) {
      const result = validate(hub, entry.token, ['context:read']);
      expect([entry.credential.id, result.ok]).toEqual([
        entry.credential.id,
        false,
      ]);
      if (!result.ok) expect(result.reason).toBe('revoked');
    }
  });

  it('records who revoked, and keeps the row for the status read', () => {
    const hub = newHub();
    hub.credentials.mint({
      profileId: hub.profileId,
      issuerId: 'human:operator',
    });
    const revoked = hub.credentials.revoke({
      profileId: hub.profileId,
      revokedBy: 'agent:local-cli',
      reason: 'key rotation',
    });
    expect(revoked.revokedBy).toBe('agent:local-cli');
    expect(revoked.revokedAt).not.toBeNull();
    expect(hub.credentials.status(hub.profileId)?.state).toBe('revoked');
  });

  it('deleting the profile revokes its credential, permanently', () => {
    const before = newHub();
    const custom = before.store.create({
      providerId: 'hermes',
      displayName: 'Ocean',
    });
    const minted = before.credentials.mint({
      profileId: custom.id,
      issuerId: 'human:operator',
    });
    expect(validate(before, minted.token).ok).toBe(true);
    before.store.delete(custom.id);
    before.credentials.revokeForDeletedProfile(custom.id);
    expect(validate(before, minted.token).ok).toBe(false);
    const after = before.restart();
    const result = validate(after, minted.token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('revoked');
  });
});

describe('agent profile credentials — the validator defers channel scope', () => {
  /**
   * The router guards are covered in `test/channel-routes.test.ts`, but those
   * attach a FABRICATED credential and never run the validator. This suite
   * covers the other half — `validateCliGatewayActorCredential`, which the
   * gateway middleware and the per-frame subscribe recheck both share. Without
   * it, deleting the marker arm leaves every channel verb that NAMES a channel
   * 403ing with `CLI_ACTOR_WRONG_CHANNEL_SCOPE` and every subscribe stream
   * dying on its first frame, with a green test suite.
   */
  function validateAgainstChannel(
    hub: Hub,
    token: string,
    channelId = 'topic:anything'
  ) {
    return validateCliGatewayActorCredential(hub.registry, {
      token,
      capabilities: ['context:read'],
      scope: { channelIds: [channelId] },
    });
  }

  it('admits a profile credential against a channel it does not name', () => {
    const hub = newHub();
    const minted = hub.credentials.mint({
      profileId: hub.profileId,
      issuerId: 'human:operator',
    });
    expect(validateAgainstChannel(hub, minted.token).ok).toBe(true);
    // Any channel id, including one that does not exist yet: the hub decides
    // on membership, downstream of this.
    expect(
      validateAgainstChannel(hub, minted.token, 'topic:created-tomorrow').ok
    ).toBe(true);
  });

  it('still refuses an ordinary credential that names no channels', () => {
    const hub = newHub();
    const ordinary = issueCliGatewayActorCredential(hub.registry, {
      actor: { type: 'agent', id: 'agent:worker' },
      issuer: { id: 'relay-ide' },
      capabilities: ['context:read'],
      scope: { taskRefs: ['relay:cli-gateway:v1:read'] },
      ttlMs: 60_000,
    });
    const result = validateAgainstChannel(hub, ordinary.token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('wrong_channel_scope');
  });

  it('keeps deferring after a restart, so the rehydrate rebuilds it faithfully', () => {
    const before = newHub();
    const minted = before.credentials.mint({
      profileId: before.profileId,
      issuerId: 'human:operator',
    });
    const after = before.restart();
    expect(validateAgainstChannel(after, minted.token).ok).toBe(true);
  });

  it('narrows normally when a profile credential DOES name channels', () => {
    const hub = newHub();
    const issued = issueAgentProfileCliGatewayActorCredential(hub.registry, {
      actor: { type: 'agent', id: hub.profileId },
      issuer: { id: 'human:operator' },
      capabilities: ['context:read'],
      scope: { channelIds: ['topic:only-this-one'] },
      ttlMs: 60_000,
    });
    expect(
      validateAgainstChannel(hub, issued.token, 'topic:only-this-one').ok
    ).toBe(true);
    const denied = validateAgainstChannel(hub, issued.token, 'topic:other');
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toBe('wrong_channel_scope');
  });

  it('enforces every OTHER dimension unchanged', () => {
    const hub = newHub();
    const minted = hub.credentials.mint({
      profileId: hub.profileId,
      issuerId: 'human:operator',
    });
    // Capability: the credential carries no `session:create:terminal`.
    const missingCapability = validateCliGatewayActorCredential(hub.registry, {
      token: minted.token,
      capabilities: ['session:create:terminal'],
      scope: { channelIds: ['topic:anything'] },
    });
    expect(missingCapability.ok).toBe(false);
    if (!missingCapability.ok) {
      expect(missingCapability.reason).toBe('insufficient_capability');
    }
    // Revocation is still checked on the same call that drops channel scope.
    hub.credentials.revoke({
      profileId: hub.profileId,
      revokedBy: 'human:operator',
    });
    const revoked = validateAgainstChannel(hub, minted.token);
    expect(revoked.ok).toBe(false);
    if (!revoked.ok) expect(revoked.reason).toBe('revoked');
  });
});

describe('agent profile credentials — self-renewal is refused', () => {
  it('cannot be renewed into a successor the operator cannot revoke', () => {
    const hub = newHub();
    const minted = hub.credentials.mint({
      profileId: hub.profileId,
      issuerId: 'human:operator',
    });
    const record = hub.registry.getCredential(minted.credential.credentialId);
    expect(record).not.toBeNull();
    // `POST /cli-gateway/actor-credentials/renew` mints a successor with the
    // same actor and capabilities but a NEW id, NO trusted marker, and no row
    // in `agent_profile_credentials` — an unrevokable ghost that would also
    // vanish at the next restart. Refused outright.
    expect(() =>
      renewCliGatewayActorCredential(hub.registry, record as never)
    ).toThrowError(/cannot be self-renewed/);
    // An ordinary credential still renews, so the refusal is targeted.
    const ordinary = issueCliGatewayActorCredential(hub.registry, {
      actor: { type: 'agent', id: 'agent:worker' },
      issuer: { id: 'relay-ide' },
      capabilities: ['context:read'],
      scope: { channelIds: ['topic:one'] },
      ttlMs: 60_000,
    });
    expect(
      renewCliGatewayActorCredential(hub.registry, ordinary.credential).token
    ).toBeTruthy();
  });
});

describe('agent profile credentials — last used', () => {
  it('stamps the first use and then debounces', () => {
    let clock = Date.now();
    const hub = newHub({ now: () => new Date(clock) });
    const minted = hub.credentials.mint({
      profileId: hub.profileId,
      issuerId: 'human:operator',
    });
    const id = minted.credential.credentialId;
    expect(hub.credentials.status(hub.profileId)?.lastUsedAt).toBeNull();
    hub.credentials.noteUsed(id);
    const first = hub.credentials.status(hub.profileId)?.lastUsedAt;
    expect(first).not.toBeNull();
    // Inside the window: no second write, so the stamp does not move.
    clock += 1000;
    hub.credentials.noteUsed(id);
    expect(hub.credentials.status(hub.profileId)?.lastUsedAt).toBe(first);
    // Past the window: it advances.
    clock += 120_000;
    hub.credentials.noteUsed(id);
    expect(hub.credentials.status(hub.profileId)?.lastUsedAt).not.toBe(first);
  });
});
