import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  discoverLocalHubActorToken,
  localHubActorTokenPath,
  readLocalHubActorTokenFile,
  type LocalHubActorTokenFile,
} from '../shared/local-hub-actor-token.js';
import {
  LOCAL_HUB_ACTOR_ID,
  localHubActorTokenDisabled,
  localHubActorTokenRoot,
  publishLocalHubActorToken,
  retireLocalHubActorToken,
} from '../server/local-hub-actor-token.js';
import {
  CLI_GATEWAY_ACTOR_AUDIENCE,
  CLI_GATEWAY_READ_SCOPE_TASK_REF,
  cliGatewayActorCommandCapabilities,
  cliGatewayActorFailure,
  createCliGatewayActorRegistry,
  DEFAULT_CLI_LOGIN_ACTOR_TTL_MS,
  isLocalHubCliActorCredential,
  issueCliGatewayActorCredential,
  validateCliGatewayActorCredential,
} from '../server/cli-gateway-actor-auth.js';

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function fixtureHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-local-token-'));
  cleanup.push(dir);
  return dir;
}

function fixtureEnv(home: string): Record<string, string | undefined> {
  return { XDG_CONFIG_HOME: home };
}

const PORT = 3469;

function registry() {
  return createCliGatewayActorRegistry({
    maxTtlMs: DEFAULT_CLI_LOGIN_ACTOR_TTL_MS,
  });
}

function publish(home: string, reg = registry()) {
  const published = publishLocalHubActorToken({
    registry: reg,
    port: PORT,
    maxTtlMs: DEFAULT_CLI_LOGIN_ACTOR_TTL_MS,
    env: fixtureEnv(home),
    homedir: home,
  });
  if (!published) throw new Error('expected the local token to be published');
  return {
    published,
    registry: reg,
    root: localHubActorTokenRoot(fixtureEnv(home), home),
  };
}

function readFileJson(filePath: string): LocalHubActorTokenFile {
  return JSON.parse(
    fs.readFileSync(filePath, 'utf8')
  ) as LocalHubActorTokenFile;
}

describe('#1467 hub-local CLI trust token — publish', () => {
  it('writes a port-keyed 0600 file into the shared standard config root', () => {
    const home = fixtureHome();
    const { published, root } = publish(home);

    expect(published.path).toBe(localHubActorTokenPath(root, PORT));
    expect(path.basename(published.path)).toBe(
      `local-actor-token-${PORT}.json`
    );
    expect(fs.statSync(published.path).mode & 0o777).toBe(0o600);

    const file = readFileJson(published.path);
    expect(file).toMatchObject({
      version: 1,
      source: 'hub-local',
      port: PORT,
      hubUrl: `http://127.0.0.1:${PORT}`,
      actorId: LOCAL_HUB_ACTOR_ID,
    });
    expect(file.token.startsWith('relay-sac-v1.')).toBe(true);
  });

  it('mints the full CLI-gateway capability surface and authorizes channels.list', () => {
    const home = fixtureHome();
    const { published, registry: reg } = publish(home);
    const file = readFileJson(published.path);

    expect(new Set(file.capabilities)).toEqual(
      new Set([
        'session:read',
        'session:create:terminal',
        'context:read',
        'context:write',
        'inbox:read',
        'inbox:write',
        'artifact:write',
      ])
    );

    const validation = validateCliGatewayActorCredential(reg, {
      token: file.token,
      capabilities: cliGatewayActorCommandCapabilities('channels.list'),
      scope: { taskRefs: [CLI_GATEWAY_READ_SCOPE_TASK_REF] },
    });
    expect('reason' in validation).toBe(false);
    if ('reason' in validation) return;
    // Identity is server-derived: nothing the caller sends decides it.
    expect(validation.credential.actor.id).toBe(LOCAL_HUB_ACTOR_ID);
    expect(validation.credential.actor.type).toBe('cli');
    expect(validation.credential.audience).toBe(CLI_GATEWAY_ACTOR_AUDIENCE);
    expect(published.credentialId).toBe(validation.credential.id);
  });

  it('rotates on restart: the previous token no longer validates', () => {
    const home = fixtureHome();
    const first = publish(home);
    const firstToken = readFileJson(first.published.path).token;

    // A hub restart builds a brand-new memory-only registry.
    const second = publish(home, registry());
    const secondToken = readFileJson(second.published.path).token;
    expect(secondToken).not.toBe(firstToken);

    const stale = validateCliGatewayActorCredential(second.registry, {
      token: firstToken,
      capabilities: cliGatewayActorCommandCapabilities('channels.list'),
      scope: { taskRefs: [CLI_GATEWAY_READ_SCOPE_TASK_REF] },
    });
    expect(stale).toMatchObject({ reason: 'malformed_credential' });
  });

  it('never exposes the token through anything the hub serializes', () => {
    const home = fixtureHome();
    const { published, registry: reg } = publish(home);
    const token = readFileJson(published.path).token;

    // The publish result (the only thing the boot path logs).
    expect(JSON.stringify(published)).not.toContain(token);
    // Every credential record shape a route may echo.
    expect(JSON.stringify(reg.listCredentials())).not.toContain(token);
    // The registry audit trail.
    expect(JSON.stringify(reg.listAuditEvents())).not.toContain(token);
    // The typed 401/403 envelope a denied request receives.
    expect(
      JSON.stringify(
        cliGatewayActorFailure({
          reason: 'insufficient_capability',
          credentialId: published.credentialId,
          deniedBits: ['session:read'],
        })
      )
    ).not.toContain(token);
  });

  it('is suppressed in e2e fixture mode and by the explicit opt-out', () => {
    const home = fixtureHome();
    expect(localHubActorTokenDisabled({ RELAY_IDE_E2E_FIXTURES: '1' })).toBe(
      true
    );
    expect(
      localHubActorTokenDisabled({ RELAY_IDE_DISABLE_LOCAL_ACTOR_TOKEN: '1' })
    ).toBe(true);
    expect(
      localHubActorTokenDisabled({ RELAY_IDE_DISABLE_LOCAL_ACTOR_TOKEN: '0' })
    ).toBe(false);
    expect(localHubActorTokenDisabled({})).toBe(false);

    expect(
      publishLocalHubActorToken({
        registry: registry(),
        port: PORT,
        env: { ...fixtureEnv(home), RELAY_IDE_E2E_FIXTURES: '1' },
        homedir: home,
      })
    ).toBeNull();
  });

  it('stamps a trusted marker that the public issue surface cannot forge', () => {
    const home = fixtureHome();
    const { registry: reg, published } = publish(home);
    const boot = reg.getCredential(published.credentialId);
    expect(isLocalHubCliActorCredential(boot)).toBe(true);

    // `POST /cli-gateway/actor-credentials` funnels through this issuer; a
    // caller asking for the marker must not get the channel-scope exemption.
    const forged = issueCliGatewayActorCredential(reg, {
      actor: { type: 'cli', id: 'attacker' },
      issuer: { id: 'attacker' },
      capabilities: ['session:read'],
      scope: { taskRefs: [CLI_GATEWAY_READ_SCOPE_TASK_REF] },
      metadata: { reason: 'hub-local-cli' },
      ttlMs: 60_000,
    });
    expect(isLocalHubCliActorCredential(forged.credential)).toBe(false);
  });

  it('retires the file on graceful shutdown', () => {
    const home = fixtureHome();
    const { published } = publish(home);
    expect(fs.existsSync(published.path)).toBe(true);
    expect(retireLocalHubActorToken(PORT, fixtureEnv(home), home)).toBe(true);
    expect(fs.existsSync(published.path)).toBe(false);
  });
});

describe('#1467 hub-local CLI trust token — fail-closed reader', () => {
  it('returns the credential for a well-formed file', () => {
    const home = fixtureHome();
    const { published, root } = publish(home);
    const result = readLocalHubActorTokenFile(root, PORT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.credential.token).toBe(readFileJson(published.path).token);
  });

  it('reports `missing` when no hub ever published one', () => {
    const home = fixtureHome();
    const root = path.join(home, 'relay-ide');
    fs.mkdirSync(root, { recursive: true });
    expect(readLocalHubActorTokenFile(root, PORT)).toMatchObject({
      ok: false,
      reason: 'missing',
    });
    expect(discoverLocalHubActorToken([root], PORT)).toBeNull();
  });

  it('refuses a group/other-readable file', () => {
    const home = fixtureHome();
    const { published, root } = publish(home);
    fs.chmodSync(published.path, 0o644);
    expect(readLocalHubActorTokenFile(root, PORT)).toMatchObject({
      ok: false,
      reason: 'loose_mode',
    });
    expect(discoverLocalHubActorToken([root], PORT)).toBeNull();
  });

  it('refuses a symlinked token file', () => {
    const home = fixtureHome();
    const { published, root } = publish(home);
    const real = path.join(home, 'planted-token.json');
    fs.renameSync(published.path, real);
    fs.chmodSync(real, 0o600);
    fs.symlinkSync(real, published.path);
    expect(readLocalHubActorTokenFile(root, PORT)).toMatchObject({
      ok: false,
      reason: 'symlink',
    });
    expect(discoverLocalHubActorToken([root], PORT)).toBeNull();
  });

  it('refuses a group/world-writable parent directory', () => {
    const home = fixtureHome();
    const { root } = publish(home);
    fs.chmodSync(root, 0o777);
    expect(readLocalHubActorTokenFile(root, PORT)).toMatchObject({
      ok: false,
      reason: 'writable_parent',
    });
    fs.chmodSync(root, 0o700);
  });

  it('refuses a file owned by another uid', () => {
    const home = fixtureHome();
    const { root } = publish(home);
    const uid = (process.getuid?.() ?? 0) + 4242;
    expect(readLocalHubActorTokenFile(root, PORT, { uid })).toMatchObject({
      ok: false,
      reason: 'foreign_owner',
    });
  });

  it('refuses a port mismatch, a non-loopback hub, and an expired credential', () => {
    const home = fixtureHome();
    const { published, root } = publish(home);
    const file = readFileJson(published.path);

    const rewrite = (patch: Partial<LocalHubActorTokenFile>, port = PORT) => {
      const target = localHubActorTokenPath(root, port);
      fs.writeFileSync(target, JSON.stringify({ ...file, ...patch }), {
        mode: 0o600,
      });
      fs.chmodSync(target, 0o600);
      return target;
    };

    rewrite({ port: 9999 });
    expect(readLocalHubActorTokenFile(root, PORT)).toMatchObject({
      ok: false,
      reason: 'port_mismatch',
    });

    rewrite({ hubUrl: `http://10.0.0.5:${PORT}` });
    expect(readLocalHubActorTokenFile(root, PORT)).toMatchObject({
      ok: false,
      reason: 'non_loopback_hub',
    });

    rewrite({ hubUrl: `http://127.0.0.1:${PORT + 1}` });
    expect(readLocalHubActorTokenFile(root, PORT)).toMatchObject({
      ok: false,
      reason: 'non_loopback_hub',
    });

    rewrite({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(readLocalHubActorTokenFile(root, PORT)).toMatchObject({
      ok: false,
      reason: 'expired',
    });

    rewrite({ source: 'login' as unknown as 'hub-local' });
    expect(readLocalHubActorTokenFile(root, PORT)).toMatchObject({
      ok: false,
      reason: 'wrong_source',
    });
  });

  it('refuses a malformed file instead of throwing', () => {
    const home = fixtureHome();
    const { published, root } = publish(home);
    fs.writeFileSync(published.path, '{not json', { mode: 0o600 });
    fs.chmodSync(published.path, 0o600);
    expect(readLocalHubActorTokenFile(root, PORT)).toMatchObject({
      ok: false,
      reason: 'malformed',
    });
  });

  it('discovers the first valid root and skips the invalid ones', () => {
    const home = fixtureHome();
    const { published, root } = publish(home);
    const decoy = path.join(home, 'decoy');
    fs.mkdirSync(decoy, { recursive: true, mode: 0o700 });
    expect(discoverLocalHubActorToken([decoy, root], PORT)?.token).toBe(
      readFileJson(published.path).token
    );
  });
});
