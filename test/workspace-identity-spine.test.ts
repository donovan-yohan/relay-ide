// #1287 slice 2 — workspace identity spine.
//
// Regression suite for the verified defect: every default-created channel was
// stamped with a placeholder (`workspace:local` from the composer/DM builders,
// `ws:derived` from the derived read model) that CANNOT equal an
// `ia_workspaces` id, because those are minted exclusively by
// `createWorkspaceId` (grammar `ws:<localId>`). The sidebar's
// `knownIds.has(workspaceId)` lookup was therefore structurally always false
// and 100% of channels landed in the orphan lane.
//
// Three properties are pinned here:
//   1. grammar — the seeded local id conforms; the sentinels never do; every
//      channel-create boundary resolves onto the seed instead of a sentinel;
//   2. seed idempotency — re-running the boot seed never duplicates or clobbers;
//   3. migration — sentinel rows are repointed COLUMN-ONLY, ids untouched.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createIaStore, type IaStore } from '../server/ia-store.js';
import {
  ensureLocalWorkspace,
  localWorkspaceName,
} from '../server/local-workspace-seed.js';
import {
  createWorkspaceTopicStore,
  migrateSentinelWorkspaceIds,
  type WorkspaceTopicStore,
} from '../server/workspace-topics.js';
import { parseWorkspaceTopicCreateInput } from '../shared/workspace-topics.js';
import type { WorkspaceTopic } from '../shared/workspace-topics.js';
import {
  LEGACY_WORKSPACE_ID_SENTINELS,
  LOCAL_WORKSPACE_ID,
  createWorkspaceId,
  isWorkspaceIdGrammar,
  normalizeWorkspaceId,
  parseWorkspaceId,
} from '../shared/workspace.js';
import { buildTopicRoomCreateInput } from '../frontend/src/lib/topic-create.js';
import { TOPIC_ROOM_DRAFT_EMPTY } from '../frontend/src/lib/topic-create.js';

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
const openIaStores: IaStore[] = [];
const openTopicStores: WorkspaceTopicStore[] = [];

function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-ws-spine-test-'));
  tmpDirs.push(dir);
  return dir;
}

function makeIaStore(): IaStore {
  const store = createIaStore(path.join(makeDir(), 'ia.db'));
  openIaStores.push(store);
  return store;
}

function makeTopicDbPath(): string {
  return path.join(makeDir(), 'workspace-topics.db');
}

function makeTopicStore(dbPath: string): WorkspaceTopicStore {
  const store = createWorkspaceTopicStore({ dbPath });
  openTopicStores.push(store);
  return store;
}

afterEach(() => {
  while (openTopicStores.length) {
    try {
      openTopicStores.pop()!.close();
    } catch {
      /* already closed */
    }
  }
  while (openIaStores.length) {
    try {
      openIaStores.pop()!.close();
    } catch {
      /* already closed */
    }
  }
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

// ── 1. Grammar ─────────────────────────────────────────────────────────────

describe('workspace id grammar (#1287)', () => {
  it('proves the sentinels can never equal a real ia_workspaces id', () => {
    // The defect in one assertion: `upsertWorkspace` only accepts ids that
    // `parseWorkspaceId` recognizes, so `workspace:local` — what the composer
    // and DM builders stamped on every default create — is unstorable, and the
    // sidebar's `knownIds.has()` lookup was a guaranteed miss.
    expect(parseWorkspaceId('workspace:local')).toBeNull();
    expect(isWorkspaceIdGrammar('workspace:local')).toBe(false);
    // `ws:derived` is grammatically shaped but synthetic: it is minted ONLY by
    // the derived read-model fallback, never by a workspace-create path, so no
    // `ia_workspaces` row carries it either. Both are retired.
    expect(LEGACY_WORKSPACE_ID_SENTINELS).toEqual([
      'workspace:local',
      'ws:derived',
    ]);
    expect(LOCAL_WORKSPACE_ID).toBe(createWorkspaceId('local'));
    expect(isWorkspaceIdGrammar(LOCAL_WORKSPACE_ID)).toBe(true);
    expect(parseWorkspaceId(LOCAL_WORKSPACE_ID)).toEqual({ localId: 'local' });
  });

  it('resolves sentinels, blanks, and nullish refs onto the seeded workspace', () => {
    expect(normalizeWorkspaceId(null)).toBe(LOCAL_WORKSPACE_ID);
    expect(normalizeWorkspaceId(undefined)).toBe(LOCAL_WORKSPACE_ID);
    expect(normalizeWorkspaceId('   ')).toBe(LOCAL_WORKSPACE_ID);
    expect(normalizeWorkspaceId('workspace:local')).toBe(LOCAL_WORKSPACE_ID);
    expect(normalizeWorkspaceId('ws:derived')).toBe(LOCAL_WORKSPACE_ID);
    expect(normalizeWorkspaceId(' workspace:local ')).toBe(LOCAL_WORKSPACE_ID);
    expect(normalizeWorkspaceId(LOCAL_WORKSPACE_ID)).toBe(LOCAL_WORKSPACE_ID);
  });

  it('passes real workspace ids through untouched', () => {
    const real = createWorkspaceId('acme-platform');
    expect(normalizeWorkspaceId(real)).toBe(real);
    // A caller-chosen legacy ref is preserved: the #1287 backfill retires the
    // SENTINELS only, so re-encoding here would split new channels away from
    // the existing rows that already share the ref.
    expect(normalizeWorkspaceId('ws-legacy-1')).toBe('ws-legacy-1');
  });

  it('validates the workspaceId at the topic-create boundary', () => {
    for (const sentinel of LEGACY_WORKSPACE_ID_SENTINELS) {
      const parsed = parseWorkspaceTopicCreateInput({
        workspaceId: sentinel,
        title: 'Reconnect flake',
      });
      expect(parsed.workspaceId).toBe(LOCAL_WORKSPACE_ID);
      expect(isWorkspaceIdGrammar(parsed.workspaceId)).toBe(true);
    }
    // An explicit id in the body is still honored verbatim — normalizing the
    // POINTER must never re-key the channel.
    const withId = parseWorkspaceTopicCreateInput({
      id: 'topic:dm~claude~workspace-local',
      workspaceId: 'workspace:local',
      title: 'Claude',
    });
    expect(withId.id).toBe('topic:dm~claude~workspace-local');
    expect(withId.workspaceId).toBe(LOCAL_WORKSPACE_ID);
    // A real workspace still round-trips.
    expect(
      parseWorkspaceTopicCreateInput({
        workspaceId: createWorkspaceId('acme'),
        title: 'Build lane',
      }).workspaceId
    ).toBe('ws:acme');
  });

  it('never lets the composer emit a sentinel workspaceId', () => {
    for (const raw of [null, 'workspace:local', 'ws:derived']) {
      const create = buildTopicRoomCreateInput({
        draft: { ...TOPIC_ROOM_DRAFT_EMPTY, title: 'Triage' },
        workspaceId: raw,
        defaultProviderId: 'claude',
        taskRef: undefined,
      });
      expect(create.workspaceId).toBe(LOCAL_WORKSPACE_ID);
    }
    expect(
      buildTopicRoomCreateInput({
        draft: { ...TOPIC_ROOM_DRAFT_EMPTY, title: 'Triage' },
        workspaceId: 'ws:acme',
        defaultProviderId: 'claude',
        taskRef: undefined,
      }).workspaceId
    ).toBe('ws:acme');
  });
});

// ── 2. Seed idempotency ────────────────────────────────────────────────────

describe('local workspace seed (#1287)', () => {
  it('seeds one durable workspace and is idempotent across boots', () => {
    const iaStore = makeIaStore();
    expect(iaStore.getWorkspace(LOCAL_WORKSPACE_ID)).toBeNull();

    const first = ensureLocalWorkspace({
      iaStore,
      hostname: () => 'devbox.local',
    });
    expect(first?.id).toBe(LOCAL_WORKSPACE_ID);
    expect(first?.name).toBe('devbox');

    // Re-run (every boot) — no duplicate, no rewrite.
    const second = ensureLocalWorkspace({
      iaStore,
      hostname: () => 'devbox.local',
    });
    const third = ensureLocalWorkspace({
      iaStore,
      hostname: () => 'devbox.local',
    });
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(
      iaStore
        .listWorkspaces({ includeArchived: true })
        .filter((ws) => ws.id === LOCAL_WORKSPACE_ID)
    ).toHaveLength(1);
  });

  it('preserves an operator rename instead of re-stamping the hostname', () => {
    const iaStore = makeIaStore();
    ensureLocalWorkspace({ iaStore, hostname: () => 'devbox' });
    iaStore.upsertWorkspace({
      id: LOCAL_WORKSPACE_ID,
      name: 'My machine',
      order: 4,
      projectIds: [],
      pinned: true,
    });
    const after = ensureLocalWorkspace({ iaStore, hostname: () => 'devbox' });
    expect(after?.name).toBe('My machine');
    expect(after?.pinned).toBe(true);
    expect(after?.order).toBe(4);
  });

  it('does not re-seed underneath an archived local workspace', () => {
    const iaStore = makeIaStore();
    ensureLocalWorkspace({ iaStore, hostname: () => 'devbox' });
    iaStore.archiveWorkspace(LOCAL_WORKSPACE_ID);
    const after = ensureLocalWorkspace({ iaStore, hostname: () => 'devbox' });
    expect(after?.status).toBe('archived');
  });

  it('falls back to a usable name when the host reports nothing', () => {
    expect(localWorkspaceName('')).toBe('Local');
    expect(localWorkspaceName(null)).toBe('Local');
    expect(localWorkspaceName('  ')).toBe('Local');
    expect(localWorkspaceName('mac-mini.lan')).toBe('mac-mini');
    expect(localWorkspaceName('plainhost')).toBe('plainhost');
  });

  it('is a no-op without an IA store', () => {
    expect(ensureLocalWorkspace({ iaStore: null })).toBeNull();
  });
});

// ── 3. Column-only sentinel backfill ───────────────────────────────────────

interface RawTopicRow {
  id: string;
  workspace_id: string;
  record_json: string;
  created_at: string;
  updated_at: string;
}

function seedSentinelRow(
  dbPath: string,
  row: { id: string; workspaceId: string }
): void {
  const db = new Database(dbPath);
  const record: Partial<WorkspaceTopic> = {
    schemaVersion: 1,
    id: row.id,
    workspaceId: row.workspaceId,
    source: 'persisted',
    status: 'active',
    display: { title: row.id },
  };
  db.prepare(
    `INSERT INTO workspace_topics
       (id, workspace_id, status, record_json, created_at, updated_at)
     VALUES (@id, @workspaceId, 'active', @recordJson, @ts, @ts)`
  ).run({
    id: row.id,
    workspaceId: row.workspaceId,
    recordJson: JSON.stringify(record),
    ts: '2026-07-18T00:00:00.000Z',
  });
  db.close();
}

function readRows(dbPath: string): RawTopicRow[] {
  const db = new Database(dbPath);
  const rows = db
    .prepare(
      'SELECT id, workspace_id, record_json, created_at, updated_at FROM workspace_topics ORDER BY id'
    )
    .all() as RawTopicRow[];
  db.close();
  return rows;
}

describe('sentinel workspace_id backfill (#1287)', () => {
  it('repoints both sentinels COLUMN-ONLY and never re-keys a topic id', () => {
    const dbPath = makeTopicDbPath();
    // Create the schema, then plant fixture rows carrying each sentinel.
    makeTopicStore(dbPath).close();
    openTopicStores.pop();
    seedSentinelRow(dbPath, {
      id: 'topic:dm~claude~workspace-local',
      workspaceId: 'workspace:local',
    });
    seedSentinelRow(dbPath, {
      id: 'topic:ws-derived-derived-wc-1',
      workspaceId: 'ws:derived',
    });
    seedSentinelRow(dbPath, {
      id: 'topic:acme-build-lane',
      workspaceId: 'ws:acme',
    });

    const before = readRows(dbPath);
    // Re-opening the store runs the backfill.
    const store = makeTopicStore(dbPath);
    const after = readRows(dbPath);

    // HARD RULE (L-20260729-topic-id-title-slug): channel_messages.channel_id
    // keys history off the topic id, and the boot sweepOrphans pass deletes
    // messages whose channel id is not a stored topic. The id set MUST be
    // byte-identical.
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));

    const byId = new Map(after.map((row) => [row.id, row]));
    for (const id of [
      'topic:dm~claude~workspace-local',
      'topic:ws-derived-derived-wc-1',
    ]) {
      const row = byId.get(id)!;
      expect(row.workspace_id).toBe(LOCAL_WORKSPACE_ID);
      // The embedded record — what every read model actually returns — moves
      // with the column, and keeps its own id.
      const record = JSON.parse(row.record_json) as WorkspaceTopic;
      expect(record.workspaceId).toBe(LOCAL_WORKSPACE_ID);
      expect(record.id).toBe(id);
      expect(store.get(id)?.workspaceId).toBe(LOCAL_WORKSPACE_ID);
    }

    // A non-sentinel row is untouched, blob included.
    const untouched = byId.get('topic:acme-build-lane')!;
    expect(untouched.workspace_id).toBe('ws:acme');
    expect(untouched.record_json).toBe(
      before.find((row) => row.id === 'topic:acme-build-lane')!.record_json
    );

    // Recency ordering must not be reshuffled by a backfill.
    expect(after.map((row) => row.updated_at)).toEqual(
      before.map((row) => row.updated_at)
    );

    // Migrated rows are now groupable under the seeded workspace.
    expect(
      store.list({ workspaceId: LOCAL_WORKSPACE_ID }).map((topic) => topic.id)
    ).toEqual(
      expect.arrayContaining([
        'topic:dm~claude~workspace-local',
        'topic:ws-derived-derived-wc-1',
      ])
    );
  });

  it('is idempotent and tolerates an unparseable record blob', () => {
    const dbPath = makeTopicDbPath();
    makeTopicStore(dbPath).close();
    openTopicStores.pop();
    seedSentinelRow(dbPath, {
      id: 'topic:legacy-a',
      workspaceId: 'workspace:local',
    });
    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO workspace_topics
         (id, workspace_id, status, record_json, created_at, updated_at)
       VALUES ('topic:corrupt', 'ws:derived', 'active', '{not json',
               '2026-07-18T00:00:00.000Z', '2026-07-18T00:00:00.000Z')`
    ).run();

    expect(migrateSentinelWorkspaceIds(db)).toBe(2);
    // Second pass finds nothing left to move.
    expect(migrateSentinelWorkspaceIds(db)).toBe(0);

    const rows = db
      .prepare(
        'SELECT id, workspace_id, record_json FROM workspace_topics ORDER BY id'
      )
      .all() as RawTopicRow[];
    db.close();
    expect(rows.map((row) => [row.id, row.workspace_id])).toEqual([
      ['topic:corrupt', LOCAL_WORKSPACE_ID],
      ['topic:legacy-a', LOCAL_WORKSPACE_ID],
    ]);
    // The corrupt blob is repointed at the column level but left byte-identical
    // rather than replaced with an invented record.
    expect(rows.find((row) => row.id === 'topic:corrupt')!.record_json).toBe(
      '{not json'
    );
  });
});
