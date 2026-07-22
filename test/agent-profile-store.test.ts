import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  builtInAgentProfileId,
  resolveHistoricalAgentSenderProfileId,
} from '../shared/agent-profile.js';
import {
  AgentProfileStoreError,
  createAgentProfileStore,
  type AgentProfileStore,
  type SeedFramework,
} from '../server/agent-profile-store.js';

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
});

describe('one-default-per-provider invariant (enforcement CHOICE: reject)', () => {
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
