import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createIaStore,
  IaStoreError,
  type IaStore,
} from '../server/ia-store.js';
import { createWorkspaceId, parseWorkspaceId } from '../shared/workspace.js';
import { createBenchId, parseBenchId } from '../shared/bench.js';
import { createInstanceId, createProjectId } from '../shared/project.js';

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
const openStores: IaStore[] = [];

function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-ia-store-test-'));
  tmpDirs.push(dir);
  return dir;
}

function makeStore(): { store: IaStore; dbPath: string } {
  const dbPath = path.join(makeDir(), 'ia.db');
  const store = createIaStore(dbPath);
  openStores.push(store);
  return { store, dbPath };
}

afterEach(() => {
  while (openStores.length) {
    try {
      openStores.pop()!.close();
    } catch {
      /* already closed */
    }
  }
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

// A realistic instance id for bench overlay tests.
const INSTANCE_ID = createInstanceId(
  createProjectId({ kind: 'repo', remote: 'github.com/acme/widget' }),
  'local'
);

describe('ia-store: workspace', () => {
  it('round-trips a workspace: insert -> read', () => {
    const { store } = makeStore();
    const id = createWorkspaceId('design-team');
    const ws = store.upsertWorkspace({
      id,
      name: 'Design',
      order: 1,
      projectIds: ['proj:repo:a', 'proj:repo:b'],
    });

    expect(ws.id).toBe(id);
    expect(ws.name).toBe('Design');
    expect(ws.order).toBe(1);
    expect(ws.projectIds).toEqual(['proj:repo:a', 'proj:repo:b']);
    expect(ws.createdAt).toBeTruthy();
    expect(ws.updatedAt).toBeTruthy();

    const read = store.getWorkspace(id);
    expect(read).not.toBeNull();
    expect(read!.name).toBe('Design');
    expect(read!.projectIds).toEqual(['proj:repo:a', 'proj:repo:b']);

    // id round-trips through shared parser.
    expect(parseWorkspaceId(read!.id)).toEqual({ localId: 'design-team' });
  });

  it('upsert updates in place and preserves createdAt', () => {
    const { store } = makeStore();
    const id = createWorkspaceId('eng');
    const first = store.upsertWorkspace({
      id,
      name: 'Engineering',
      order: 2,
      projectIds: ['proj:repo:a'],
    });

    const updated = store.upsertWorkspace({
      id,
      name: 'Engineering (renamed)',
      order: 5,
      projectIds: ['proj:repo:a', 'proj:repo:c'],
    });

    expect(updated.name).toBe('Engineering (renamed)');
    expect(updated.order).toBe(5);
    expect(updated.projectIds).toEqual(['proj:repo:a', 'proj:repo:c']);
    expect(updated.createdAt).toBe(first.createdAt);

    expect(store.listWorkspaces()).toHaveLength(1);
  });

  it('lists workspaces ordered by order ascending', () => {
    const { store } = makeStore();
    store.upsertWorkspace({
      id: createWorkspaceId('c'),
      name: 'C',
      order: 3,
      projectIds: [],
    });
    store.upsertWorkspace({
      id: createWorkspaceId('a'),
      name: 'A',
      order: 1,
      projectIds: [],
    });
    store.upsertWorkspace({
      id: createWorkspaceId('b'),
      name: 'B',
      order: 2,
      projectIds: [],
    });

    expect(store.listWorkspaces().map((w) => w.name)).toEqual(['A', 'B', 'C']);
  });

  it('deletes a workspace', () => {
    const { store } = makeStore();
    const id = createWorkspaceId('temp');
    store.upsertWorkspace({ id, name: 'Temp', order: 0, projectIds: [] });
    expect(store.getWorkspace(id)).not.toBeNull();

    expect(store.deleteWorkspace(id)).toBe(true);
    expect(store.getWorkspace(id)).toBeNull();
    expect(store.deleteWorkspace(id)).toBe(false);
  });

  it('rejects invalid workspace id', () => {
    const { store } = makeStore();
    expect(() =>
      store.upsertWorkspace({
        id: 'not-a-workspace-id',
        name: 'x',
        order: 0,
        projectIds: [],
      })
    ).toThrow(IaStoreError);
  });

  it('rejects blank name and non-finite order', () => {
    const { store } = makeStore();
    const id = createWorkspaceId('x');
    expect(() =>
      store.upsertWorkspace({ id, name: '  ', order: 0, projectIds: [] })
    ).toThrow(/workspace_name_required/);
    expect(() =>
      store.upsertWorkspace({
        id,
        name: 'ok',
        order: Number.NaN,
        projectIds: [],
      })
    ).toThrow(/workspace_order_invalid/);
  });

  it('preserves float order for reorder-without-renumber', () => {
    const { store } = makeStore();
    const id = createWorkspaceId('frac');
    const ws = store.upsertWorkspace({
      id,
      name: 'Frac',
      order: 1.5,
      projectIds: [],
    });
    expect(ws.order).toBe(1.5);
    expect(store.getWorkspace(id)!.order).toBe(1.5);
  });
});

describe('ia-store: bench overlay', () => {
  it('round-trips a bench overlay: insert -> read', () => {
    const { store } = makeStore();
    const id = createBenchId(INSTANCE_ID, '/work/widget/feature-x');
    const overlay = store.upsertBenchOverlay({
      id,
      envOverrides: { NODE_ENV: 'test', PORT: '4000' },
      label: 'Feature X',
    });

    expect(overlay.id).toBe(id);
    expect(overlay.instanceId).toBe(INSTANCE_ID);
    expect(overlay.cwd).toBe('/work/widget/feature-x');
    expect(overlay.label).toBe('Feature X');
    expect(overlay.envOverrides).toEqual({ NODE_ENV: 'test', PORT: '4000' });

    const read = store.getBenchOverlay(id);
    expect(read).not.toBeNull();
    expect(read!.envOverrides).toEqual({ NODE_ENV: 'test', PORT: '4000' });

    // BenchId round-trips: instanceId + cwd recovered via shared parser.
    expect(parseBenchId(read!.id)).toEqual({
      instanceId: INSTANCE_ID,
      cwd: '/work/widget/feature-x',
    });
  });

  it('label defaults to null when omitted (use derived label)', () => {
    const { store } = makeStore();
    const id = createBenchId(INSTANCE_ID, '/work/widget/main');
    const overlay = store.upsertBenchOverlay({
      id,
      envOverrides: {},
    });
    expect(overlay.label).toBeNull();
    expect(overlay.envOverrides).toEqual({});
  });

  it('upsert updates env overrides + label, preserves createdAt', () => {
    const { store } = makeStore();
    const id = createBenchId(INSTANCE_ID, '/work/widget/dev');
    const first = store.upsertBenchOverlay({
      id,
      envOverrides: { A: '1' },
      label: 'dev',
    });
    const updated = store.upsertBenchOverlay({
      id,
      envOverrides: { A: '2', B: '3' },
      label: null,
    });

    expect(updated.envOverrides).toEqual({ A: '2', B: '3' });
    expect(updated.label).toBeNull();
    expect(updated.createdAt).toBe(first.createdAt);
    expect(store.listBenchOverlays()).toHaveLength(1);
  });

  it('strips non-string env values on write', () => {
    const { store } = makeStore();
    const id = createBenchId(INSTANCE_ID, '/work/widget/dirty');
    const overlay = store.upsertBenchOverlay({
      id,
      envOverrides: {
        GOOD: 'yes',
        // intentionally invalid values that must be dropped
        BAD: 5 as unknown as string,
        ALSO_BAD: null as unknown as string,
      },
    });
    expect(overlay.envOverrides).toEqual({ GOOD: 'yes' });
  });

  it('deletes a bench overlay', () => {
    const { store } = makeStore();
    const id = createBenchId(INSTANCE_ID, '/work/widget/gone');
    store.upsertBenchOverlay({ id, envOverrides: { X: '1' } });
    expect(store.getBenchOverlay(id)).not.toBeNull();

    expect(store.deleteBenchOverlay(id)).toBe(true);
    expect(store.getBenchOverlay(id)).toBeNull();
    expect(store.deleteBenchOverlay(id)).toBe(false);
  });

  it('rejects invalid bench id', () => {
    const { store } = makeStore();
    expect(() =>
      store.upsertBenchOverlay({ id: 'nope', envOverrides: {} })
    ).toThrow(IaStoreError);
  });
});

describe('ia-store: durability + migration', () => {
  it('persists across re-open of the same DB file', () => {
    const dbPath = path.join(makeDir(), 'ia.db');
    const wsId = createWorkspaceId('persist');
    const benchId = createBenchId(INSTANCE_ID, '/work/widget/persist');

    const s1 = createIaStore(dbPath);
    s1.upsertWorkspace({
      id: wsId,
      name: 'Persist',
      order: 1,
      projectIds: ['proj:repo:p'],
    });
    s1.upsertBenchOverlay({ id: benchId, envOverrides: { K: 'v' } });
    s1.close();

    const s2 = createIaStore(dbPath);
    openStores.push(s2);
    expect(s2.getWorkspace(wsId)!.projectIds).toEqual(['proj:repo:p']);
    expect(s2.getBenchOverlay(benchId)!.envOverrides).toEqual({ K: 'v' });
  });

  it('fails soft on corrupt JSON columns instead of throwing (external tampering)', () => {
    const dbPath = path.join(makeDir(), 'ia.db');
    const wsId = createWorkspaceId('corrupt');
    const benchId = createBenchId(INSTANCE_ID, '/work/widget/corrupt');

    const s1 = createIaStore(dbPath);
    s1.upsertWorkspace({ id: wsId, name: 'Corrupt', order: 1, projectIds: ['proj:repo:x'] });
    s1.upsertBenchOverlay({ id: benchId, envOverrides: { K: 'v' } });
    s1.close();

    // Simulate out-of-band corruption of the JSON payload columns.
    const raw = new Database(dbPath);
    raw.prepare('UPDATE ia_workspaces SET project_ids_json = ? WHERE id = ?').run('{not json', wsId);
    raw.prepare('UPDATE ia_bench_overlays SET env_overrides_json = ? WHERE id = ?').run('{not json', benchId);
    raw.close();

    const s2 = createIaStore(dbPath);
    openStores.push(s2);
    // Single-row getters must not throw; they degrade to empty collections.
    expect(s2.getWorkspace(wsId)!.projectIds).toEqual([]);
    expect(s2.getBenchOverlay(benchId)!.envOverrides).toEqual({});
    // List paths stay safe too.
    expect(() => s2.listWorkspaces()).not.toThrow();
    expect(() => s2.listBenchOverlays()).not.toThrow();
  });

  it('migration is idempotent: re-running createIaStore on existing DB is a no-op', () => {
    const dbPath = path.join(makeDir(), 'ia.db');
    const a = createIaStore(dbPath);
    a.upsertWorkspace({
      id: createWorkspaceId('keep'),
      name: 'Keep',
      order: 1,
      projectIds: [],
    });
    a.close();

    // Re-open twice more — must not error and must not lose data.
    const b = createIaStore(dbPath);
    b.close();
    const c = createIaStore(dbPath);
    openStores.push(c);
    expect(c.listWorkspaces()).toHaveLength(1);

    // schema_version pinned at the latest migration version (v2 adds the #736
    // ia_migration_state marker table).
    const db = new Database(dbPath);
    try {
      const row = db.prepare('SELECT version FROM schema_version').get() as {
        version: number;
      };
      expect(row.version).toBe(2);
    } finally {
      db.close();
    }
  });

  it('creates the expected IA tables on a fresh DB', () => {
    const { store, dbPath } = makeStore();
    store.close();
    openStores.pop(); // already closed

    const db = new Database(dbPath);
    try {
      const tables = (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
          )
          .all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(tables).toContain('ia_workspaces');
      expect(tables).toContain('ia_bench_overlays');
      expect(tables).toContain('ia_migration_state');
      expect(tables).toContain('schema_version');
    } finally {
      db.close();
    }
  });

  it('empty-DB safety: list returns [] before any insert', () => {
    const { store } = makeStore();
    expect(store.listWorkspaces()).toEqual([]);
    expect(store.listBenchOverlays()).toEqual([]);
    expect(store.getWorkspace(createWorkspaceId('none'))).toBeNull();
  });

  it('runs cleanly against a pre-existing DB that has no IA tables', () => {
    // Simulate an existing relay DB with unrelated tables + a schema_version
    // row. createIaStore must add IA tables without touching the rest.
    const dbPath = path.join(makeDir(), 'ia.db');
    const seed = new Database(dbPath);
    seed.exec(
      'CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)'
    );
    seed
      .prepare('INSERT INTO schema_version (version) VALUES (?)')
      .run(0);
    seed.exec('CREATE TABLE legacy_thing (id TEXT PRIMARY KEY)');
    seed.prepare('INSERT INTO legacy_thing (id) VALUES (?)').run('keep-me');
    seed.close();

    const store = createIaStore(dbPath);
    openStores.push(store);
    store.upsertWorkspace({
      id: createWorkspaceId('added'),
      name: 'Added',
      order: 1,
      projectIds: [],
    });
    expect(store.listWorkspaces()).toHaveLength(1);

    // Pre-existing unrelated table + row untouched.
    const db = new Database(dbPath);
    try {
      const legacy = db
        .prepare('SELECT id FROM legacy_thing')
        .all() as Array<{ id: string }>;
      expect(legacy).toEqual([{ id: 'keep-me' }]);
    } finally {
      db.close();
    }
  });
});
