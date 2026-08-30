import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  builtInAgentProfileId,
  resolveHistoricalAgentSenderProfileId,
} from '../shared/agent-profile.js';
import {
  AgentProfileStoreError,
  createAgentProfileStore,
  rethrowConstraint,
  type AgentProfileStore,
  type SeedFramework,
} from '../server/agent-profile-store.js';
import { listConfiguredFrameworks } from '../server/frameworks.js';

vi.mock('../server/logger.js', () => ({
  createLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const tmpDirs: string[] = [];
const openStores: AgentProfileStore[] = [];

function makeStore(): AgentProfileStore {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'relay-agent-profile-test-')
  );
  tmpDirs.push(dir);
  const store = createAgentProfileStore(path.join(dir, 'agent-profiles.db'));
  openStores.push(store);
  return store;
}

const FRAMEWORKS: SeedFramework[] = [
  { id: 'claude' },
  { id: 'codex' },
  { id: 'opencode' },
  { id: 'hermes' },
];

afterEach(() => {
  while (openStores.length) {
    try {
      openStores.pop()?.close();
    } catch {
      // already closed
    }
  }
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('seedBuiltIns — one built-in default per configured framework', () => {
  it('seeds exactly one isBuiltIn+isDefault profile per framework', () => {
    const store = makeStore();
    const inserted = store.seedBuiltIns(FRAMEWORKS);
    expect(inserted).toBe(FRAMEWORKS.length);

    const all = store.list();
    expect(all).toHaveLength(FRAMEWORKS.length);
    for (const framework of FRAMEWORKS) {
      const rows = store.list({ providerId: framework.id });
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.id).toBe(builtInAgentProfileId(framework.id));
      expect(row.isDefault).toBe(true);
      expect(row.isBuiltIn).toBe(true);
      // Thin overlay: vendor label is NOT duplicated onto the row.
      expect(row.displayName).toBe('');
      expect(row.avatar).toBeNull();
    }
  });

  it('is idempotent: seeding twice yields identical rows', () => {
    const store = makeStore();
    const first = store.seedBuiltIns(FRAMEWORKS);
    const before = store.list();
    const second = store.seedBuiltIns(FRAMEWORKS);
    const after = store.list();

    expect(first).toBe(FRAMEWORKS.length);
    expect(second).toBe(0); // no new rows on the second run
    expect(after).toHaveLength(before.length);
    expect(after.map((p) => p.id).sort()).toEqual(
      before.map((p) => p.id).sort()
    );
  });

  it('does not flip an existing user-chosen default when re-seeding', () => {
    const store = makeStore();
    store.seedBuiltIns([{ id: 'claude' }]);
    const custom = store.create({
      providerId: 'claude',
      displayName: 'Backend Claude',
    });
    store.setDefault(custom.id);
    expect(store.getDefaultForProvider('claude')?.id).toBe(custom.id);

    // Re-seeding must not resurrect the built-in default or duplicate rows.
    const inserted = store.seedBuiltIns([{ id: 'claude' }]);
    expect(inserted).toBe(0);
    expect(store.getDefaultForProvider('claude')?.id).toBe(custom.id);
  });

  it('self-heals a provider left with ZERO defaults (#1241 FIX 2)', () => {
    const store = makeStore();
    store.seedBuiltIns([{ id: 'claude' }]);
    const builtInId = builtInAgentProfileId('claude');

    // Drive the provider into a zero-default state: promote a user profile
    // (demotes the built-in survivor to is_default = 0), then delete the
    // promoted default — leaving one row for 'claude' with NO default at all.
    const custom = store.create({ providerId: 'claude', displayName: 'Temp' });
    store.setDefault(custom.id);
    expect(store.get(builtInId)?.isDefault).toBe(false);
    store.delete(custom.id);
    expect(store.getDefaultForProvider('claude')).toBeNull();

    // Seeding must HEAL the invariant: promote the surviving built-in row back
    // to the sole default rather than leaving the vendor default-less (the old
    // INSERT OR IGNORE path could not restore it because the PK already existed).
    const inserted = store.seedBuiltIns([{ id: 'claude' }]);
    expect(inserted).toBe(0); // a promotion, not a NEW row
    const healed = store.getDefaultForProvider('claude');
    expect(healed?.id).toBe(builtInId);
    expect(healed?.isDefault).toBe(true);
    expect(healed?.isBuiltIn).toBe(true);
    const claudeRows = store.list({ providerId: 'claude' });
    expect(claudeRows).toHaveLength(1);
    expect(claudeRows.filter((p) => p.isDefault)).toHaveLength(1);

    // Idempotent after healing: a further seed changes nothing.
    expect(store.seedBuiltIns([{ id: 'claude' }])).toBe(0);
    expect(store.getDefaultForProvider('claude')?.id).toBe(builtInId);
    expect(store.list({ providerId: 'claude' })).toHaveLength(1);
  });
});

describe('best-effort init survives a malformed custom framework (#1241 FIX 1)', () => {
  // A hand-edited / half-registered fully-custom framework: config loading does
  // NOT validate command/continueArgs/yoloArgs/parserType/eventSource/capabilities,
  // so resolveFramework throws for it only at enumeration time.
  const malformedFrameworks = {
    'broken-custom': { id: 'broken-custom', displayName: 'Broken Custom' },
  };

  it('listConfiguredFrameworks throws for the malformed entry', () => {
    // This is the throw that, pre-fix, escaped the best-effort guard: it was the
    // argument evaluated OUTSIDE the try/catch, so it crashed hub boot.
    expect(() => listConfiguredFrameworks(malformedFrameworks)).toThrow(
      /broken-custom/
    );
  });

  it('guarded init degrades to no profile rows instead of crashing boot', () => {
    // Mirrors server/index.ts initAgentProfileStoreBestEffort AFTER FIX 1: the
    // framework enumeration runs INSIDE the try, so a resolution throw degrades
    // to "store with no seeded rows" rather than propagating and setting
    // exitCode = 1. (index.ts self-runs main() on import, so the wrapper itself
    // is not unit-importable; this reproduces its exact shape.)
    function initGuarded(
      dbPath: string,
      frameworks?: Parameters<typeof listConfiguredFrameworks>[0]
    ): AgentProfileStore | null {
      let store: AgentProfileStore | null = null;
      try {
        store = createAgentProfileStore(dbPath);
        store.seedBuiltIns(listConfiguredFrameworks(frameworks));
        return store;
      } catch {
        store?.close();
        return null;
      }
    }

    const badDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'relay-agent-profile-test-')
    );
    tmpDirs.push(badDir);
    let badStore: AgentProfileStore | null = null;
    expect(() => {
      badStore = initGuarded(
        path.join(badDir, 'agent-profiles.db'),
        malformedFrameworks
      );
    }).not.toThrow();
    // Boot survived; the guard returned null (no rows seeded) rather than throwing.
    expect(badStore).toBeNull();

    // The clean all-builtin case still seeds normally through the same path.
    const goodDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'relay-agent-profile-test-')
    );
    tmpDirs.push(goodDir);
    const goodStore = initGuarded(path.join(goodDir, 'agent-profiles.db'));
    expect(goodStore).not.toBeNull();
    openStores.push(goodStore!);
    expect(goodStore!.list().length).toBeGreaterThan(0);
  });
});

describe('one-default-per-provider invariant (enforcement CHOICE: reject)', () => {
  it('refuses to delete a built-in default profile', () => {
    const store = makeStore();
    store.seedBuiltIns([{ id: 'claude' }]);
    const builtInId = builtInAgentProfileId('claude');

    try {
      store.delete(builtInId);
      throw new Error('expected built-in default delete to fail');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'agent_profile_builtin_default_delete_forbidden',
        status: 409,
      });
    }
    expect(store.get(builtInId)).toMatchObject({
      isBuiltIn: true,
      isDefault: true,
    });
  });

  it('rejects creating a second default for the same provider', () => {
    const store = makeStore();
    store.seedBuiltIns([{ id: 'claude' }]);
    expect(() =>
      store.create({
        providerId: 'claude',
        displayName: 'Another Default',
        isDefault: true,
      })
    ).toThrowError(AgentProfileStoreError);

    try {
      store.create({
        providerId: 'claude',
        displayName: 'Another Default',
        isDefault: true,
      });
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(AgentProfileStoreError);
      expect((err as AgentProfileStoreError).code).toBe(
        'agent_profile_default_exists'
      );
      expect((err as AgentProfileStoreError).status).toBe(409);
    }
    // Still exactly one default for claude.
    expect(
      store.list({ providerId: 'claude' }).filter((p) => p.isDefault)
    ).toHaveLength(1);
  });

  it('maps the raced partial-index violation to agent_profile_default_exists (#1241 FIX 3)', () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'relay-agent-profile-test-')
    );
    tmpDirs.push(dir);
    const dbPath = path.join(dir, 'agent-profiles.db');
    const store = createAgentProfileStore(dbPath);
    openStores.push(store);
    store.seedBuiltIns([{ id: 'claude' }]); // one default row for claude

    // create()'s pre-check makes the partial-index branch unreachable in-process,
    // so reproduce a cross-process race: raw-insert a SECOND default row for the
    // same provider directly against the store's db file, bypassing the pre-check.
    const raw = new Database(dbPath);
    let realErr: unknown;
    try {
      raw
        .prepare(
          `INSERT INTO agent_profiles (id, provider_id, is_default, is_built_in, profile_json, created_at, updated_at)
           VALUES (?, ?, 1, 1, '{}', 'now', 'now')`
        )
        .run('agent-profile:claude:raced', 'claude');
    } catch (err) {
      realErr = err;
    } finally {
      raw.close();
    }
    // The real SQLite message names the COLUMN (provider_id), not the index —
    // this is exactly the token rethrowConstraint now keys on.
    expect(realErr).toBeInstanceOf(Error);
    expect((realErr as Error).message).toMatch(/agent_profiles\.provider_id/);

    // rethrowConstraint maps that real message to the default-exists code
    // (previously mis-reported as agent_profile_id_exists).
    try {
      rethrowConstraint(realErr, 'claude');
      throw new Error('expected rethrowConstraint to throw');
    } catch (mapped) {
      expect(mapped).toBeInstanceOf(AgentProfileStoreError);
      expect((mapped as AgentProfileStoreError).code).toBe(
        'agent_profile_default_exists'
      );
      expect((mapped as AgentProfileStoreError).status).toBe(409);
    }
  });

  it('maps an id (primary-key) collision to agent_profile_id_exists (#1241 FIX 3)', () => {
    // The PK-collision message names agent_profiles.id — the id-exists branch.
    try {
      rethrowConstraint(
        new Error('UNIQUE constraint failed: agent_profiles.id'),
        'claude'
      );
      throw new Error('expected rethrowConstraint to throw');
    } catch (mapped) {
      expect(mapped).toBeInstanceOf(AgentProfileStoreError);
      expect((mapped as AgentProfileStoreError).code).toBe(
        'agent_profile_id_exists'
      );
    }
    // A non-constraint error is rethrown unchanged (not remapped to a store error).
    const other = new Error('database is locked');
    expect(() => rethrowConstraint(other, 'claude')).toThrow(other);
  });

  it('allows creating additional NON-default profiles for a provider', () => {
    const store = makeStore();
    store.seedBuiltIns([{ id: 'claude' }]);
    const extra = store.create({
      providerId: 'claude',
      displayName: 'Backend Claude',
    });
    expect(extra.isDefault).toBe(false);
    expect(store.list({ providerId: 'claude' })).toHaveLength(2);
  });

  it('setDefault atomically flips the default (old one cleared)', () => {
    const store = makeStore();
    store.seedBuiltIns([{ id: 'claude' }]);
    const oldDefaultId = builtInAgentProfileId('claude');
    const custom = store.create({
      providerId: 'claude',
      displayName: 'Reviewer Claude',
    });

    const promoted = store.setDefault(custom.id);
    expect(promoted.isDefault).toBe(true);
    expect(store.get(oldDefaultId)?.isDefault).toBe(false);
    expect(store.getDefaultForProvider('claude')?.id).toBe(custom.id);
    // Invariant holds: still exactly one default.
    expect(
      store.list({ providerId: 'claude' }).filter((p) => p.isDefault)
    ).toHaveLength(1);
  });

  it('carries optional overlay fields but never vendor facts', () => {
    const store = makeStore();
    const p = store.create({
      providerId: 'codex',
      displayName: 'Fast Codex',
      model: 'gpt-x',
      effort: 'high',
      envVars: { FOO: 'bar' },
      namePool: ['fast', 'zippy'],
      respondTo: 'allowlist',
      respondToAllowlist: ['human:owner'],
    });
    expect(p.model).toBe('gpt-x');
    expect(p.effort).toBe('high');
    expect(p.envVars).toEqual({ FOO: 'bar' });
    expect(p.namePool).toEqual(['fast', 'zippy']);
    expect(p.respondTo).toBe('allowlist');
    expect(p.respondToAllowlist).toEqual(['human:owner']);
  });
});

describe('update — profile JSON and denormalized invariant stay in lockstep', () => {
  it('patches explicit fields while preserving omitted overlay fields', () => {
    const store = makeStore();
    store.seedBuiltIns([{ id: 'codex' }]);
    const created = store.create({
      providerId: 'codex',
      displayName: 'Fast Codex',
      systemPrompt: 'be concise',
      model: 'gpt-x',
      effort: 'high',
      envVars: { FAST: '1' },
    });

    const updated = store.update(created.id, {
      displayName: 'Careful Codex',
      effort: null,
    });
    expect(updated).toMatchObject({
      id: created.id,
      providerId: 'codex',
      displayName: 'Careful Codex',
      systemPrompt: 'be concise',
      model: 'gpt-x',
      envVars: { FAST: '1' },
      isDefault: false,
      isBuiltIn: false,
    });
    expect(updated.effort).toBeUndefined();
    expect(store.get(created.id)).toEqual(updated);
  });

  it('rejects provider changes for built-in profiles and isBuiltIn edits', () => {
    const store = makeStore();
    store.seedBuiltIns([{ id: 'claude' }]);
    const builtInId = builtInAgentProfileId('claude');

    try {
      store.update(builtInId, { providerId: 'codex' });
      throw new Error('expected provider change to fail');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'agent_profile_builtin_provider_change_forbidden',
        status: 400,
      });
    }
    try {
      store.update(builtInId, { isBuiltIn: false });
      throw new Error('expected isBuiltIn edit to fail');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'agent_profile_is_built_in_immutable',
        status: 400,
      });
    }
  });

  it('keeps exactly one default when an update promotes a profile', () => {
    const store = makeStore();
    store.seedBuiltIns([{ id: 'claude' }]);
    const custom = store.create({
      providerId: 'claude',
      displayName: 'Reviewer Claude',
    });

    const updated = store.update(custom.id, { isDefault: true });
    expect(updated.isDefault).toBe(true);
    expect(store.get(builtInAgentProfileId('claude'))?.isDefault).toBe(false);
    expect(
      store
        .list({ providerId: 'claude' })
        .filter((profile) => profile.isDefault)
    ).toHaveLength(1);
    try {
      store.update(custom.id, { isDefault: false });
      throw new Error('expected default clearing to fail');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'agent_profile_last_default',
        status: 409,
      });
    }
  });
});

describe('hermes profile binding round-trip (#1453)', () => {
  it('persists, patches and clears the binding through the JSON blob', () => {
    const store = makeStore();
    store.seedBuiltIns(FRAMEWORKS);
    const created = store.create({
      providerId: 'claude',
      displayName: 'Product Owner',
      hermesProfile: 'koi-product',
    });
    expect(created.hermesProfile).toBe('koi-product');
    expect(store.get(created.id)?.hermesProfile).toBe('koi-product');

    expect(
      store.update(created.id, { hermesProfile: 'ika-frontend' }).hermesProfile
    ).toBe('ika-frontend');
    // Untouched by an unrelated PATCH.
    expect(store.update(created.id, { model: 'sonnet' }).hermesProfile).toBe(
      'ika-frontend'
    );
    // Cleared by an explicit null.
    expect(
      store.update(created.id, { hermesProfile: null }).hermesProfile
    ).toBeUndefined();
  });

  it.each([
    ['../other'],
    ['a/b'],
    ['..'],
    ['.'],
    ['has space'],
    ['x'.repeat(65)],
  ])(
    'refuses %j at the store guard even when the router is bypassed',
    (value) => {
      const store = makeStore();
      store.seedBuiltIns(FRAMEWORKS);
      expect(() =>
        store.create({
          providerId: 'claude',
          displayName: 'Bad Binding',
          hermesProfile: value,
        })
      ).toThrow(AgentProfileStoreError);

      const clean = store.create({
        providerId: 'claude',
        displayName: 'Clean Binding',
      });
      expect(() => store.update(clean.id, { hermesProfile: value })).toThrow(
        AgentProfileStoreError
      );
      expect(store.get(clean.id)?.hermesProfile).toBeUndefined();
    }
  );
});

describe('read-time shim over the store', () => {
  it('maps agent:<framework> to the seeded default profile id', () => {
    const store = makeStore();
    store.seedBuiltIns(FRAMEWORKS);
    const contacts = store.list();
    expect(
      resolveHistoricalAgentSenderProfileId('agent:claude', contacts)
    ).toBe(builtInAgentProfileId('claude'));
    expect(
      resolveHistoricalAgentSenderProfileId('agent:hermes', contacts)
    ).toBe(builtInAgentProfileId('hermes'));
    expect(
      resolveHistoricalAgentSenderProfileId('agent:unknown', contacts)
    ).toBeNull();
  });
});

describe('persistence across reopen', () => {
  it('reads seeded rows back after reopening the DB file', () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'relay-agent-profile-test-')
    );
    tmpDirs.push(dir);
    const dbPath = path.join(dir, 'agent-profiles.db');

    const first = createAgentProfileStore(dbPath);
    first.seedBuiltIns(FRAMEWORKS);
    first.close();

    const second = createAgentProfileStore(dbPath);
    openStores.push(second);
    expect(second.list()).toHaveLength(FRAMEWORKS.length);
    // Re-seeding the reopened store stays idempotent.
    expect(second.seedBuiltIns(FRAMEWORKS)).toBe(0);
  });
});
