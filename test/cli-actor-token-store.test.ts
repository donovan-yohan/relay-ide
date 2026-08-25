import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  actorTokenFilePath,
  deleteStoredActorCredential,
  expiresWithinMargin,
  loadStoredActorCredential,
  saveStoredActorCredential,
  type StoredActorCredential,
} from '../shared/cli-actor-token-store.js';

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempConfigDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'relay-cli-token-'));
  cleanup.push(dir);
  return dir;
}

function sampleCredential(
  overrides: Partial<StoredActorCredential> = {}
): StoredActorCredential {
  const issuedAt = '2026-08-01T00:00:00.000Z';
  return {
    version: 1,
    token: 'relay-sac-v1.test-credential-id.testsecret',
    credentialId: 'test-credential-id',
    hubUrl: 'http://127.0.0.1:3456',
    issuedAt,
    expiresAt: '2026-08-31T00:00:00.000Z',
    actorId: 'relay-cli@testhost',
    capabilities: ['session:read'],
    ...overrides,
  };
}

describe('stored actor credential file', () => {
  it('save → load round-trips and enforces chmod 600', () => {
    const dir = tempConfigDir();
    saveStoredActorCredential(dir, sampleCredential());
    const filePath = actorTokenFilePath(dir);
    expect(existsSync(filePath)).toBe(true);
    // 0o600 exactly — no group/other bits.
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
    const loaded = loadStoredActorCredential(dir);
    expect(loaded?.token).toBe(sampleCredential().token);
    expect(loaded?.actorId).toBe('relay-cli@testhost');
  });

  it('refuses to load a token file readable by group/other (fail closed)', () => {
    const dir = tempConfigDir();
    saveStoredActorCredential(dir, sampleCredential());
    const filePath = actorTokenFilePath(dir);
    chmodSync(filePath, 0o644);
    expect(loadStoredActorCredential(dir)).toBeNull();
  });

  it('returns null for missing, corrupt, or foreign-schema files', () => {
    const dir = tempConfigDir();
    expect(loadStoredActorCredential(dir)).toBeNull();

    writeFileSync(actorTokenFilePath(dir), 'not json at all');
    expect(loadStoredActorCredential(dir)).toBeNull();

    writeFileSync(
      actorTokenFilePath(dir),
      JSON.stringify({ version: 2, token: 'nope' })
    );
    expect(loadStoredActorCredential(dir)).toBeNull();
  });

  it('delete removes the file', () => {
    const dir = tempConfigDir();
    saveStoredActorCredential(dir, sampleCredential());
    expect(deleteStoredActorCredential(dir)).toBe(true);
    expect(existsSync(actorTokenFilePath(dir))).toBe(false);
    expect(deleteStoredActorCredential(dir)).toBe(false);
  });

  it('never leaves the temp rewrite file behind', () => {
    const dir = tempConfigDir();
    saveStoredActorCredential(dir, sampleCredential());
    const leftovers = readFileSync(path.join(dir, 'actor-token.json'), 'utf8');
    expect(leftovers).toContain('relay-sac-v1.');
  });
});

describe('renew margin logic (120s default pattern)', () => {
  const MARGIN = 120 * 1000;

  it('flags credentials within the margin of expiry', () => {
    const credential = sampleCredential({
      expiresAt: '2026-08-01T00:10:00.000Z',
    });
    // Exactly 10 minutes out: no renewal.
    expect(
      expiresWithinMargin(
        credential,
        MARGIN,
        Date.parse('2026-08-01T00:00:00.000Z')
      )
    ).toBe(false);
    // 2 minutes out: renew.
    expect(
      expiresWithinMargin(
        credential,
        MARGIN,
        Date.parse('2026-08-01T00:08:00.000Z')
      )
    ).toBe(true);
    // Already past expiry: definitely renew-attempt territory.
    expect(
      expiresWithinMargin(
        credential,
        MARGIN,
        Date.parse('2026-08-01T00:09:59.000Z')
      )
    ).toBe(true);
  });

  it('treats unparseable expiry as due-for-renewal check failure (false, not throw)', () => {
    const credential = sampleCredential({ expiresAt: 'garbage' });
    expect(expiresWithinMargin(credential, MARGIN, Date.now())).toBe(false);
  });
});
