import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createIaStore, type IaStore } from '../server/ia-store.js';
import {
  MIGRATION_KEY,
  migrateLegacyWorkspaces,
  migratedWorkspaceId,
  type LegacyWorkspaceInput,
} from '../server/ia-workspace-migration.js';
import {
  buildIaTree,
  repoInstanceProjectId,
} from '../server/features/ia-tree.js';
import { DEFAULT_LOCAL_NODE_ID } from '../shared/identity.js';
import { createWorkspaceId } from '../shared/workspace.js';
import type {
  RepoInventoryReport,
  RepoInventoryRepoInstance,
} from '../shared/repo-inventory.js';

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-ia-migration-test-'));
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

function repoInstance(
  overrides: Partial<RepoInventoryRepoInstance> = {}
): RepoInventoryRepoInstance {
  const nodeId = overrides.nodeId ?? DEFAULT_LOCAL_NODE_ID;
  const localPath = overrides.localPath ?? '/repos/relay';
  return {
    repoInstanceId: `${nodeId}:${localPath}`,
    nodeId,
    localPath,
    name: 'relay',
    isGitRepo: true,
    defaultBranch: 'main',
    currentBranch: 'main',
    repoIdentity: 'github.com/donovan-yohan/relay-ide',
    selectedRemote: null,
    remotes: [],
    repoIdentityWarnings: [],
    worktrees: [],
    reportedAt: '2026-05-27T00:00:00.000Z',
    ...overrides,
  };
}

function localReport(repos: RepoInventoryRepoInstance[]): RepoInventoryReport {
  return {
    nodeId: DEFAULT_LOCAL_NODE_ID,
    generatedAt: '2026-05-27T00:00:00.000Z',
    repos,
  };
}

const EMPTY_REPORT = localReport([]);

describe('ia-workspace-migration', () => {
  it('(a) migrates 2 legacy workspaces → 2 IA workspaces with correct projectIds', () => {
    const { store } = makeStore();
    const repoA = repoInstance({
      localPath: '/repos/relay',
      repoIdentity: 'github.com/donovan-yohan/relay-ide',
    });
    const repoB = repoInstance({
      localPath: '/repos/widget',
      name: 'widget',
      repoIdentity: 'github.com/acme/widget',
    });
    const report = localReport([repoA, repoB]);

    const legacy: LegacyWorkspaceInput[] = [
      { id: 'one', name: 'Workspace One', order: 0, repos: ['/repos/relay'] },
      { id: 'two', name: 'Workspace Two', order: 1, repos: ['/repos/widget'] },
    ];

    const result = migrateLegacyWorkspaces({
      iaStore: store,
      legacyWorkspaces: legacy,
      localReport: report,
    });

    expect(result.ran).toBe(true);
    expect(result.inserted).toBe(2);

    const all = store.listWorkspaces();
    expect(all).toHaveLength(2);

    const wsOne = store.getWorkspace(migratedWorkspaceId('one'))!;
    expect(wsOne.name).toBe('Workspace One');
    expect(wsOne.order).toBe(0);
    expect(wsOne.projectIds).toEqual([repoInstanceProjectId(repoA)]);

    const wsTwo = store.getWorkspace(migratedWorkspaceId('two'))!;
    expect(wsTwo.projectIds).toEqual([repoInstanceProjectId(repoB)]);

    // Marker recorded.
    expect(store.getMigrationState(MIGRATION_KEY)).not.toBeNull();
  });

  it('(b) is idempotent: re-running produces no dupes and stable timestamps/marker', () => {
    const { store, dbPath } = makeStore();
    const repoA = repoInstance({ localPath: '/repos/relay' });
    const report = localReport([repoA]);
    const legacy: LegacyWorkspaceInput[] = [
      { id: 'one', name: 'Workspace One', order: 0, repos: ['/repos/relay'] },
    ];

    const first = migrateLegacyWorkspaces({
      iaStore: store,
      legacyWorkspaces: legacy,
      localReport: report,
    });
    expect(first.inserted).toBe(1);

    const created = store.getWorkspace(migratedWorkspaceId('one'))!;
    const markerAfterFirst = store.getMigrationState(MIGRATION_KEY);

    // Second run on the SAME store: marker short-circuits → pure no-op.
    const second = migrateLegacyWorkspaces({
      iaStore: store,
      legacyWorkspaces: legacy,
      localReport: report,
    });
    expect(second.ran).toBe(false);
    expect(second.skippedReason).toBe('already-migrated');
    expect(store.listWorkspaces()).toHaveLength(1);
    expect(store.getWorkspace(migratedWorkspaceId('one'))!.updatedAt).toBe(
      created.updatedAt
    );
    expect(store.getMigrationState(MIGRATION_KEY)).toBe(markerAfterFirst);

    // Re-open the DB (fresh store, same file) and re-run: still no dupes.
    store.close();
    openStores.pop();
    const reopened = createIaStore(dbPath);
    openStores.push(reopened);
    const third = migrateLegacyWorkspaces({
      iaStore: reopened,
      legacyWorkspaces: legacy,
      localReport: report,
    });
    expect(third.ran).toBe(false);
    expect(reopened.listWorkspaces()).toHaveLength(1);
    expect(reopened.getWorkspace(migratedWorkspaceId('one'))!.updatedAt).toBe(
      created.updatedAt
    );
  });

  it('(b2) upsert-if-absent guards a re-run even when the marker is missing', () => {
    const { store } = makeStore();
    const repoA = repoInstance({ localPath: '/repos/relay' });
    const report = localReport([repoA]);
    const legacy: LegacyWorkspaceInput[] = [
      { id: 'one', name: 'Original Name', order: 0, repos: ['/repos/relay'] },
    ];

    migrateLegacyWorkspaces({
      iaStore: store,
      legacyWorkspaces: legacy,
      localReport: report,
    });

    // Simulate a user RENAMING the migrated workspace via #733 CRUD.
    const id = migratedWorkspaceId('one');
    store.upsertWorkspace({
      id,
      name: 'User Renamed',
      order: 5,
      projectIds: store.getWorkspace(id)!.projectIds,
    });

    // Force a re-run ignoring the marker (honorMarker:false). The
    // upsert-if-absent guard must NOT clobber the user's edit.
    const rerun = migrateLegacyWorkspaces({
      iaStore: store,
      legacyWorkspaces: legacy,
      localReport: report,
      honorMarker: false,
    });
    expect(rerun.ran).toBe(true);
    expect(rerun.inserted).toBe(0);
    expect(rerun.skippedExisting).toBe(1);

    const after = store.getWorkspace(id)!;
    expect(after.name).toBe('User Renamed');
    expect(after.order).toBe(5);
    expect(store.listWorkspaces()).toHaveLength(1);
  });

  it('(c) non-clobber: a user-created IA workspace survives a migration run untouched', () => {
    const { store } = makeStore();

    // User-created workspace (random-uuid id, never `migrated:` prefixed).
    const userId = createWorkspaceId('11111111-2222-3333-4444-555555555555');
    const userWs = store.upsertWorkspace({
      id: userId,
      name: 'My Hand-Made Workspace',
      order: 9,
      projectIds: ['proj:repo:github.com%2Fme%2Fthing'],
    });

    const repoA = repoInstance({ localPath: '/repos/relay' });
    const legacy: LegacyWorkspaceInput[] = [
      { id: 'one', name: 'Migrated', order: 0, repos: ['/repos/relay'] },
    ];

    const result = migrateLegacyWorkspaces({
      iaStore: store,
      legacyWorkspaces: legacy,
      localReport: localReport([repoA]),
    });
    expect(result.inserted).toBe(1);

    // The user-created workspace is byte-identical afterwards.
    const after = store.getWorkspace(userId)!;
    expect(after).toEqual(userWs);
    expect(store.listWorkspaces()).toHaveLength(2);
  });

  it('(d) empty config → clean no-op (still sets marker, no error)', () => {
    const { store } = makeStore();

    const undefRun = migrateLegacyWorkspaces({
      iaStore: store,
      legacyWorkspaces: undefined,
      localReport: EMPTY_REPORT,
    });
    expect(undefRun.ran).toBe(true);
    expect(undefRun.inserted).toBe(0);
    expect(store.listWorkspaces()).toHaveLength(0);
    expect(store.getMigrationState(MIGRATION_KEY)).not.toBeNull();

    const emptyArr = migrateLegacyWorkspaces({
      iaStore: store,
      legacyWorkspaces: [],
      localReport: EMPTY_REPORT,
      honorMarker: false,
    });
    expect(emptyArr.inserted).toBe(0);
    expect(store.listWorkspaces()).toHaveLength(0);
  });

  it('(d2) null store → skipped, no throw', () => {
    const result = migrateLegacyWorkspaces({
      iaStore: null,
      legacyWorkspaces: [
        { id: 'one', name: 'One', order: 0, repos: ['/repos/relay'] },
      ],
      localReport: EMPTY_REPORT,
    });
    expect(result.ran).toBe(false);
    expect(result.skippedReason).toBe('no-store');
  });

  it('(e) migrated projectIds match buildIaTree projectIdFor output for the same repos', () => {
    const { store } = makeStore();
    // Two checkouts of the SAME git remote on the local node + a non-git dir.
    const repoMain = repoInstance({
      localPath: '/repos/relay',
      repoIdentity: 'github.com/donovan-yohan/relay-ide',
    });
    const repoClone = repoInstance({
      localPath: '/repos/relay-clone',
      repoIdentity: 'github.com/donovan-yohan/relay-ide',
    });
    const dir = repoInstance({
      localPath: '/scratch/notes',
      name: 'notes',
      isGitRepo: false,
      repoIdentity: null,
    });
    const report = localReport([repoMain, repoClone, dir]);

    const legacy: LegacyWorkspaceInput[] = [
      {
        id: 'grp',
        name: 'Group',
        order: 0,
        // Both checkouts share a remote → dedup to ONE project; plus the dir.
        repos: ['/repos/relay', '/repos/relay-clone', '/scratch/notes'],
      },
    ];

    migrateLegacyWorkspaces({
      iaStore: store,
      legacyWorkspaces: legacy,
      localReport: report,
    });

    // Derive the tree the SAME way the route does, with the SAME workspace group.
    const tree = buildIaTree({
      reports: [report],
      nodes: [],
      workspaceGroups: [
        {
          id: 'grp',
          name: 'Group',
          order: 0,
          repos: ['/repos/relay', '/repos/relay-clone', '/scratch/notes'],
        },
      ],
      generatedAt: '2026-05-27T00:00:00.000Z',
    });

    const treeProjectIds = tree.workspaces[0]!.projects.map((p) => p.id).sort();
    const migrated = store
      .getWorkspace(migratedWorkspaceId('grp'))!
      .projectIds.slice()
      .sort();

    expect(migrated).toEqual(treeProjectIds);
    // Sanity: the two same-remote checkouts collapsed to exactly one project,
    // plus the directory project = 2 total.
    expect(migrated).toHaveLength(2);
  });

  it('(f) legacy workspace whose member repos are not in inventory → empty grouping, still migrated', () => {
    const { store } = makeStore();
    const legacy: LegacyWorkspaceInput[] = [
      { id: 'ghost', name: 'Ghost', order: 0, repos: ['/gone/repo'] },
    ];
    const result = migrateLegacyWorkspaces({
      iaStore: store,
      legacyWorkspaces: legacy,
      localReport: EMPTY_REPORT,
    });
    expect(result.inserted).toBe(1);
    expect(result.emptyMembership).toBe(1);
    const ws = store.getWorkspace(migratedWorkspaceId('ghost'))!;
    expect(ws.name).toBe('Ghost');
    expect(ws.projectIds).toEqual([]);
  });

  it('(g) tolerates malformed legacy entries (missing id / junk repos)', () => {
    const { store } = makeStore();
    const repoA = repoInstance({ localPath: '/repos/relay' });
    const legacy = [
      { id: '', name: 'No Id', order: 0, repos: ['/repos/relay'] },
      { id: 'ok', name: '', order: 'nan' as unknown as number, repos: 'not-array' },
      { id: 'good', name: 'Good', order: 2, repos: ['/repos/relay'] },
    ] as LegacyWorkspaceInput[];

    const result = migrateLegacyWorkspaces({
      iaStore: store,
      legacyWorkspaces: legacy,
      localReport: localReport([repoA]),
    });

    // '' id skipped; 'ok' migrated with name fallback + order 0 + empty members;
    // 'good' migrated with one project.
    expect(result.inserted).toBe(2);
    expect(store.getWorkspace(migratedWorkspaceId('ok'))!.name).toBe('ok');
    expect(store.getWorkspace(migratedWorkspaceId('ok'))!.order).toBe(0);
    expect(store.getWorkspace(migratedWorkspaceId('good'))!.projectIds).toEqual([
      repoInstanceProjectId(repoA),
    ]);
  });
});
