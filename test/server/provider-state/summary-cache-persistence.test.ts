/**
 * #1459: the native-session summary cache survives a process restart.
 *
 * #1449 made a *warm* `GET /sessions/native` cheap; a cold process still read
 * every transcript once because the summary carries `hashSha256`, `lineCount`
 * and `eventTypes`. These tests pin the durable layer that fixes that, and —
 * more importantly — pin that durability never buys a wrong answer:
 *
 * - a rehydrated row is only served when all four stamp fields still match,
 * - a changed, deleted, misfiled or unparseable row re-parses,
 * - a row written by a build with different limits/capabilities is retired,
 * - the responses are byte-identical to the uncached path,
 * - and the file is bounded, corruption-tolerant and safe under two writers.
 */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeJsonlStateAdapter } from '../../../server/provider-state/claude-jsonl-state-adapter.js';
import { CodexJsonlStateAdapter } from '../../../server/provider-state/codex-jsonl-state-adapter.js';
import { NativeSessionAdapterRegistry } from '../../../server/provider-state/registry.js';
import {
  NOOP_SUMMARY_CACHE_STORE,
  SUMMARY_CACHE_DB_FILE,
  initNativeSummaryCacheStore,
  nativeSummaryCachePersistence,
  openNativeSummaryCacheStore,
  type NativeSummaryCacheStore,
} from '../../../server/provider-state/summary-cache-store.js';
import { FileDerivedCache } from '../../../server/provider-state/file-summary-cache.js';

const openStores: NativeSummaryCacheStore[] = [];

function openStore(
  dbPath: string,
  limits?: {
    maxRows?: number;
    maxBytes?: number;
  }
): NativeSummaryCacheStore {
  const store = openNativeSummaryCacheStore({ dbPath, ...(limits ?? {}) });
  openStores.push(store);
  return store;
}

afterEach(() => {
  while (openStores.length > 0) openStores.pop()?.close();
});

function claudeLine(
  sessionId: string,
  timestamp: string,
  text: string
): string {
  return JSON.stringify({
    type: 'user',
    sessionId,
    uuid: `${sessionId}-${timestamp}`,
    cwd: '/tmp/repo',
    timestamp,
    message: { role: 'user', content: text },
  });
}

function codexLine(sessionId: string, timestamp: string, text: string): string {
  return JSON.stringify({
    type: 'user',
    session_id: sessionId,
    id: `${sessionId}-${timestamp}`,
    cwd: '/tmp/repo',
    timestamp,
    message: { role: 'user', content: text },
  });
}

/** A scratch hub config dir plus a Claude state root with `count` transcripts. */
async function claudeFixture(count = 3): Promise<{
  configDir: string;
  dbPath: string;
  root: string;
  projectDir: string;
  paths: string[];
}> {
  const base = await mkdtemp(path.join(tmpdir(), 'relay-1459-'));
  const configDir = path.join(base, 'config');
  const root = path.join(base, 'claude');
  const projectDir = path.join(root, 'projects', '-tmp-repo');
  await mkdir(configDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  const paths: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const filePath = path.join(projectDir, `session-${i}.jsonl`);
    await writeFile(
      filePath,
      `${claudeLine(`session-${i}`, `2026-01-0${i + 1}T00:00:00.000Z`, `turn ${i}`)}\n`
    );
    paths.push(filePath);
  }
  return {
    configDir,
    dbPath: path.join(configDir, SUMMARY_CACHE_DB_FILE),
    root,
    projectDir,
    paths,
  };
}

/** Raw row inspection: the durable layer is only trustworthy if it is checkable. */
function readRows(
  dbPath: string,
  namespace = 'claude'
): {
  file_path: string;
  fingerprint: string;
  mtime_ms: number;
  ctime_ms: number;
  size: number;
  ino: number;
  summary_json: string;
}[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT file_path, fingerprint, mtime_ms, ctime_ms, size, ino, summary_json
           FROM native_session_summaries WHERE namespace = ? ORDER BY file_path`
      )
      .all(namespace) as ReturnType<typeof readRows>;
  } finally {
    db.close();
  }
}

function mutateRow(
  dbPath: string,
  filePath: string,
  column: string,
  value: unknown
): void {
  const db = new Database(dbPath);
  try {
    db.prepare(
      `UPDATE native_session_summaries SET ${column} = ? WHERE file_path = ?`
    ).run(value, filePath);
  } finally {
    db.close();
  }
}

describe('#1459 persistent native-session summary cache', () => {
  it('rehydrates a fresh process without re-reading a single transcript', async () => {
    const { dbPath, root, paths } = await claudeFixture(3);

    const first = new ClaudeJsonlStateAdapter({
      stateRoot: root,
      summaryCacheStore: openStore(dbPath),
    });
    const cold = await first.listNativeSessions();
    expect(cold).toHaveLength(3);
    expect(first.nativeSessionReadStats().summaryCache.misses).toBe(3);
    expect(readRows(dbPath)).toHaveLength(3);

    const second = new ClaudeJsonlStateAdapter({
      stateRoot: root,
      summaryCacheStore: openStore(dbPath),
    });
    const warm = await second.listNativeSessions();

    expect(JSON.stringify(warm)).toBe(JSON.stringify(cold));
    const stats = second.nativeSessionReadStats().summaryCache;
    // A miss is the only path that opens a transcript, so zero misses over
    // three sessions is zero bytes of transcript read by this process.
    expect(stats.misses).toBe(0);
    expect(stats.hits).toBe(3);
    expect(stats.persisted.rehydratedRows).toBe(3);
    expect(stats.persisted.rejectedRows).toBe(0);
    expect(paths).toHaveLength(3);
  });

  it('invalidates a row when only ctime changed', async () => {
    // ctime is the field that catches metadata-only changes and a restore that
    // forges mtime. A chmod moves ctime and nothing else, so it is the cheapest
    // way to prove the fourth stamp field is load-bearing across a restart —
    // and that a persisted row cannot outlive it.
    const { dbPath, root, paths } = await claudeFixture(2);
    const first = new ClaudeJsonlStateAdapter({
      stateRoot: root,
      summaryCacheStore: openStore(dbPath),
    });
    const cold = await first.listNativeSessions();

    const before = await stat(paths[0] as string);
    await chmod(paths[0] as string, 0o400);
    const after = await stat(paths[0] as string);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
    expect(after.ctimeMs).not.toBe(before.ctimeMs);

    const second = new ClaudeJsonlStateAdapter({
      stateRoot: root,
      summaryCacheStore: openStore(dbPath),
    });
    const warm = await second.listNativeSessions();
    const stats = second.nativeSessionReadStats().summaryCache;
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(1);
    expect(JSON.stringify(warm)).toBe(JSON.stringify(cold));
  });

  it('re-parses a transcript mutated between processes', async () => {
    const { dbPath, root, paths } = await claudeFixture(2);
    const first = new ClaudeJsonlStateAdapter({
      stateRoot: root,
      summaryCacheStore: openStore(dbPath),
    });
    const cold = await first.listNativeSessions();
    const beforeHash = cold.find((s) => s.nativeId === 'session-0')?.metadata?.[
      'hashSha256'
    ];

    await writeFile(
      paths[0] as string,
      `${claudeLine('session-0', '2026-01-01T00:00:00.000Z', 'turn 0')}\n` +
        `${claudeLine('session-0', '2026-09-09T00:00:00.000Z', 'appended after restart')}\n`
    );

    const second = new ClaudeJsonlStateAdapter({
      stateRoot: root,
      summaryCacheStore: openStore(dbPath),
    });
    const warm = await second.listNativeSessions();
    const changed = warm.find((s) => s.nativeId === 'session-0');
    expect(changed?.metadata?.['lineCount']).toBe(2);
    expect(changed?.updatedAt).toBe('2026-09-09T00:00:00.000Z');
    expect(changed?.metadata?.['hashSha256']).not.toBe(beforeHash);

    const stats = second.nativeSessionReadStats().summaryCache;
    // Exactly one re-parse: the changed file. The untouched one still hits.
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(1);

    // The refreshed value is what the *next* process will rehydrate.
    const rows = readRows(dbPath);
    const persisted = rows.find((row) => row.file_path === paths[0]);
    expect(
      (JSON.parse(persisted?.summary_json ?? '{}') as { updatedAt?: string })
        .updatedAt
    ).toBe('2026-09-09T00:00:00.000Z');
  });

  it('prunes the row for a transcript deleted between processes', async () => {
    const { dbPath, root, paths } = await claudeFixture(3);
    const first = new ClaudeJsonlStateAdapter({
      stateRoot: root,
      summaryCacheStore: openStore(dbPath),
    });
    await first.listNativeSessions();
    expect(readRows(dbPath).map((row) => row.file_path)).toEqual(
      [...paths].sort()
    );

    await rm(paths[2] as string);

    const second = new ClaudeJsonlStateAdapter({
      stateRoot: root,
      summaryCacheStore: openStore(dbPath),
    });
    const warm = await second.listNativeSessions();
    expect(warm).toHaveLength(2);
    expect(second.nativeSessionReadStats().summaryCache.persisted.forgets).toBe(
      1
    );
    expect(readRows(dbPath).map((row) => row.file_path)).toEqual(
      [paths[0], paths[1]].sort()
    );
  });

  it('never prunes when the walk was capped by maxFiles', async () => {
    const { dbPath, root } = await claudeFixture(4);
    // An uncapped run records all four.
    const full = new ClaudeJsonlStateAdapter({
      stateRoot: root,
      summaryCacheStore: openStore(dbPath),
    });
    await full.listNativeSessions();
    expect(readRows(dbPath)).toHaveLength(4);

    // A capped walk reaches only two of them; the other two rows are for files
    // it never looked at, so they must survive.
    const capped = new ClaudeJsonlStateAdapter({
      stateRoot: root,
      maxFiles: 2,
      summaryCacheStore: openStore(dbPath),
    });
    const listed = await capped.listNativeSessions();
    expect(listed).toHaveLength(2);
    expect(readRows(dbPath)).toHaveLength(4);
  });

  it.each([
    ['mtime_ms', 1_700_000_000_000],
    ['ctime_ms', 1_700_000_000_000],
    ['size', 999_999],
    ['ino', 424_242],
  ])(
    'rejects a persisted row whose %s no longer matches the file',
    async (column, forged) => {
      const { dbPath, root, paths } = await claudeFixture(2);
      const first = new ClaudeJsonlStateAdapter({
        stateRoot: root,
        summaryCacheStore: openStore(dbPath),
      });
      const cold = await first.listNativeSessions();
      while (openStores.length > 0) openStores.pop()?.close();

      mutateRow(dbPath, paths[0] as string, column, forged);

      const second = new ClaudeJsonlStateAdapter({
        stateRoot: root,
        summaryCacheStore: openStore(dbPath),
      });
      const warm = await second.listNativeSessions();
      const stats = second.nativeSessionReadStats().summaryCache;

      // The forged row is unusable: that file is re-derived from disk, the
      // untouched one is still served from the row.
      expect(stats.misses).toBe(1);
      expect(stats.hits).toBe(1);
      // And the answer is still exactly right.
      expect(JSON.stringify(warm)).toBe(JSON.stringify(cold));

      // The re-derived value replaces the forged row for the next process.
      const repaired = readRows(dbPath).find(
        (row) => row.file_path === paths[0]
      );
      const live = await stat(paths[0] as string);
      expect(repaired?.size).toBe(live.size);
      expect(repaired?.mtime_ms).toBe(live.mtimeMs);
      expect(repaired?.ctime_ms).toBe(live.ctimeMs);
      expect(repaired?.ino).toBe(live.ino);
    }
  );

  it('rejects a row whose payload is truncated or misfiled', async () => {
    const { dbPath, root, paths } = await claudeFixture(3);
    const first = new ClaudeJsonlStateAdapter({
      stateRoot: root,
      summaryCacheStore: openStore(dbPath),
    });
    const cold = await first.listNativeSessions();
    while (openStores.length > 0) openStores.pop()?.close();

    // A half-written value (the shape a torn write would leave behind).
    const rows = readRows(dbPath);
    const truncated = (
      rows.find((row) => row.file_path === paths[0])?.summary_json ?? ''
    ).slice(0, 40);
    mutateRow(dbPath, paths[0] as string, 'summary_json', truncated);

    // A structurally valid summary filed under the wrong key: serving it would
    // hand a caller another session's transcript path.
    const misfiled = JSON.parse(
      rows.find((row) => row.file_path === paths[2])?.summary_json ?? '{}'
    ) as Record<string, unknown>;
    mutateRow(
      dbPath,
      paths[1] as string,
      'summary_json',
      JSON.stringify(misfiled)
    );

    const second = new ClaudeJsonlStateAdapter({
      stateRoot: root,
      summaryCacheStore: openStore(dbPath),
    });
    const warm = await second.listNativeSessions();
    const stats = second.nativeSessionReadStats().summaryCache;

    expect(stats.persisted.rejectedRows).toBe(2);
    expect(stats.misses).toBe(2);
    expect(stats.hits).toBe(1);
    expect(JSON.stringify(warm)).toBe(JSON.stringify(cold));
  });

  it('retires every row when the derivation fingerprint changes', async () => {
    const { dbPath } = await claudeFixture(0);
    const store = openStore(dbPath);
    const stamp = { mtimeMs: 1, ctimeMs: 2, size: 3, ino: 4 };

    const oldBuild = nativeSummaryCachePersistence({
      provider: 'claude',
      store,
      fingerprintInput: { version: 1, limits: { maxEvents: 5_000 } },
    });
    const newBuild = nativeSummaryCachePersistence({
      provider: 'claude',
      store,
      fingerprintInput: { version: 1, limits: { maxEvents: 9_000 } },
    });
    expect(oldBuild.fingerprint).not.toBe(newBuild.fingerprint);

    store.save('claude', oldBuild.fingerprint, [
      { filePath: '/tmp/a.jsonl', stamp, json: '{"provider":"claude"}' },
    ]);
    expect(store.load('claude', oldBuild.fingerprint)).toHaveLength(1);

    // The new build sees nothing, and the dead row is gone rather than kept.
    expect(store.load('claude', newBuild.fingerprint)).toHaveLength(0);
    expect(store.load('claude', oldBuild.fingerprint)).toHaveLength(0);
  });

  it('bounds the file by rows and by bytes, evicting oldest first', async () => {
    const { dbPath } = await claudeFixture(0);
    const store = openStore(dbPath, { maxRows: 3 });
    const stamp = { mtimeMs: 1, ctimeMs: 2, size: 3, ino: 4 };
    for (let i = 0; i < 10; i += 1) {
      store.save('claude', 'fp', [
        { filePath: `/tmp/${i}.jsonl`, stamp, json: `{"n":${i}}` },
      ]);
    }
    expect(store.load('claude', 'fp')).toHaveLength(3);

    const byteDbPath = `${dbPath}.bytes`;
    const byteStore = openStore(byteDbPath, { maxBytes: 1_024 });
    const fat = `{"pad":"${'x'.repeat(400)}"}`;
    for (let i = 0; i < 20; i += 1) {
      byteStore.save('claude', 'fp', [
        { filePath: `/tmp/fat-${i}.jsonl`, stamp, json: fat },
      ]);
    }
    const kept = byteStore.load('claude', 'fp');
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length * fat.length).toBeLessThanOrEqual(1_024);

    // An individual value too large for the per-row ceiling is skipped, not
    // allowed to consume the budget.
    const huge = `{"pad":"${'x'.repeat(64 * 1024)}"}`;
    const hugeStore = openStore(`${dbPath}.huge`);
    hugeStore.save('claude', 'fp', [
      { filePath: '/tmp/huge.jsonl', stamp, json: huge },
    ]);
    expect(hugeStore.load('claude', 'fp')).toHaveLength(0);
  });

  it('recovers from a corrupt cache file instead of failing the list', async () => {
    const { dbPath, root } = await claudeFixture(2);
    await writeFile(dbPath, 'this is definitely not a sqlite database\n');

    const store = openStore(dbPath);
    expect(store.stats().disabled).toBe(false);

    const adapter = new ClaudeJsonlStateAdapter({
      stateRoot: root,
      summaryCacheStore: store,
    });
    const listed = await adapter.listNativeSessions();
    expect(listed).toHaveLength(2);
    // Rebuilt, not merely tolerated: the run repopulated the file.
    expect(readRows(dbPath)).toHaveLength(2);
  });

  it('serves a list unchanged when the store is unusable', async () => {
    const { root } = await claudeFixture(2);
    const plain = new ClaudeJsonlStateAdapter({ stateRoot: root });
    const noop = new ClaudeJsonlStateAdapter({
      stateRoot: root,
      summaryCacheStore: NOOP_SUMMARY_CACHE_STORE,
    });
    expect(JSON.stringify(await noop.listNativeSessions())).toBe(
      JSON.stringify(await plain.listNativeSessions())
    );
    expect(plain.nativeSessionReadStats().summaryCache.persisted.enabled).toBe(
      false
    );
  });

  it('tolerates a second writer on the same cache file', async () => {
    const { dbPath } = await claudeFixture(0);
    const a = openStore(dbPath);
    const b = openStore(dbPath);
    const stamp = { mtimeMs: 1, ctimeMs: 2, size: 3, ino: 4 };

    a.save('claude', 'fp', [
      { filePath: '/tmp/a.jsonl', stamp, json: '{"who":"a"}' },
    ]);
    b.save('claude', 'fp', [
      { filePath: '/tmp/b.jsonl', stamp, json: '{"who":"b"}' },
    ]);
    // Same key from both writers: last write wins, no error, no duplicate row.
    a.save('codex', 'fp', [
      { filePath: '/tmp/s.jsonl', stamp, json: '{"who":"a"}' },
    ]);
    b.save('codex', 'fp', [
      { filePath: '/tmp/s.jsonl', stamp, json: '{"who":"b"}' },
    ]);

    expect(a.load('claude', 'fp')).toHaveLength(2);
    expect(b.load('codex', 'fp')).toHaveLength(1);
    expect(a.stats().errors).toBe(0);
    expect(b.stats().errors).toBe(0);
  });

  it('keeps claude and codex rows in separate namespaces', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'relay-1459-both-'));
    const configDir = path.join(base, 'config');
    const claudeProject = path.join(base, 'claude', 'projects', '-tmp-repo');
    const codexDay = path.join(base, 'codex', '2026', '01', '01');
    await mkdir(configDir, { recursive: true });
    await mkdir(claudeProject, { recursive: true });
    await mkdir(codexDay, { recursive: true });
    await writeFile(
      path.join(claudeProject, 'shared-id.jsonl'),
      `${claudeLine('shared-id', '2026-01-01T00:00:00.000Z', 'claude turn')}\n`
    );
    await writeFile(
      path.join(codexDay, 'rollout-shared.jsonl'),
      `${codexLine('shared-id', '2026-01-02T00:00:00.000Z', 'codex turn')}\n`
    );

    const store = initNativeSummaryCacheStore(configDir);
    openStores.push(store);
    const dbPath = path.join(configDir, SUMMARY_CACHE_DB_FILE);

    const registry = new NativeSessionAdapterRegistry();
    registry.register(
      new ClaudeJsonlStateAdapter({
        stateRoot: path.join(base, 'claude'),
        summaryCacheStore: store,
      })
    );
    registry.register(
      new CodexJsonlStateAdapter({
        stateRoot: path.join(base, 'codex'),
        summaryCacheStore: store,
      })
    );
    const cold = await registry.listAllSessions();
    expect(cold.sessions).toHaveLength(2);
    expect(readRows(dbPath, 'claude')).toHaveLength(1);
    expect(readRows(dbPath, 'codex')).toHaveLength(1);

    // A fresh registry over the same store answers byte-identically, and the
    // uncached registry agrees with both.
    const rehydrated = new NativeSessionAdapterRegistry();
    rehydrated.register(
      new ClaudeJsonlStateAdapter({
        stateRoot: path.join(base, 'claude'),
        summaryCacheStore: store,
      })
    );
    rehydrated.register(
      new CodexJsonlStateAdapter({
        stateRoot: path.join(base, 'codex'),
        summaryCacheStore: store,
      })
    );
    const uncached = new NativeSessionAdapterRegistry();
    uncached.register(
      new ClaudeJsonlStateAdapter({ stateRoot: path.join(base, 'claude') })
    );
    uncached.register(
      new CodexJsonlStateAdapter({ stateRoot: path.join(base, 'codex') })
    );

    const warmReport = await rehydrated.listAllSessions();
    const plainReport = await uncached.listAllSessions();
    expect(JSON.stringify(warmReport.sessions)).toBe(
      JSON.stringify(cold.sessions)
    );
    expect(JSON.stringify(plainReport.sessions)).toBe(
      JSON.stringify(cold.sessions)
    );
  });

  it('writes the cache into the config dir, never the checkout', async () => {
    const { configDir, dbPath, root } = await claudeFixture(1);
    const store = initNativeSummaryCacheStore(configDir);
    openStores.push(store);
    const adapter = new ClaudeJsonlStateAdapter({
      stateRoot: root,
      summaryCacheStore: store,
    });
    await adapter.listNativeSessions();
    const info = await stat(dbPath);
    expect(info.isFile()).toBe(true);
    // Summaries carry redacted prompt text and project paths; keep the file as
    // narrow as the agent-profile store.
    expect(info.mode & 0o777).toBe(0o600);
  });

  it('does not persist a value the derivation never confirmed', async () => {
    // A cache with a backing must still be the only thing deciding what is
    // served: `get` on a stale stamp misses and leaves the durable row alone.
    const { dbPath } = await claudeFixture(0);
    const store = openStore(dbPath);
    const cache = new FileDerivedCache<{ v: number }>(10, {
      namespace: 'claude',
      fingerprint: 'fp',
      store,
      serialize: (value) => JSON.stringify(value),
      deserialize: (json) => JSON.parse(json) as { v: number },
    });
    const stamp = { mtimeMs: 1, ctimeMs: 2, size: 3, ino: 4 };
    cache.set('/tmp/x.jsonl', stamp, { v: 1 });
    cache.flush();
    expect(store.load('claude', 'fp')).toHaveLength(1);

    expect(cache.get('/tmp/x.jsonl', { ...stamp, size: 4 })).toBeUndefined();
    cache.delete('/tmp/x.jsonl');
    cache.flush();
    expect(store.load('claude', 'fp')).toHaveLength(0);
  });
});

/**
 * Drift guard, not a description: the persisted rows are `NativeSessionSummary`
 * values written by an older build. Adding or removing a field changes what a
 * fresh parse would produce, so this test fails until someone decides whether
 * `SUMMARY_CACHE_FORMAT_VERSION` needs a bump to retire the old rows.
 */
describe('#1459 summary shape drift guard', () => {
  const PINNED_FIELDS = [
    'provider',
    'nativeId',
    'sourcePath',
    'cwd',
    'repoPath',
    'worktreePath',
    'workContextId',
    'createdAt',
    'updatedAt',
    'lastMessageAt',
    'title',
    'preview',
    'metadata',
    'capabilities',
  ];
  const PINNED_METADATA_FIELDS = [
    'lineCount',
    'byteCount',
    'hashSha256',
    'nativeSessionId',
    'eventTypes',
    'readTruncation',
    'transcriptAvailable',
  ];

  it('pins the NativeSessionSummary field set', async () => {
    const source = await readFile(
      path.join(process.cwd(), 'shared', 'provider-native-session-state.ts'),
      'utf8'
    );
    const start = source.indexOf('export interface NativeSessionSummary {');
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf('\n}\n', start);
    const body = source.slice(start, end);

    const metadataStart = body.indexOf('metadata: {');
    const metadataEnd = body.indexOf('\n  };', metadataStart);
    const metadataBody = body.slice(metadataStart, metadataEnd);
    const topBody = body.slice(0, metadataStart) + body.slice(metadataEnd);

    const fieldsIn = (block: string): string[] =>
      Array.from(block.matchAll(/^\s{2,4}([A-Za-z_][A-Za-z0-9_]*)\??:/gm)).map(
        (match) => match[1] as string
      );

    expect(fieldsIn(topBody).filter((f) => f !== 'metadata')).toEqual(
      PINNED_FIELDS.filter((f) => f !== 'metadata')
    );
    expect(fieldsIn(metadataBody).filter((f) => f !== 'metadata')).toEqual(
      PINNED_METADATA_FIELDS
    );
  });

  it('changes the fingerprint when any derivation input changes', () => {
    const store = NOOP_SUMMARY_CACHE_STORE;
    const base = {
      version: 1,
      capabilities: { readOnly: true },
      limits: { a: 1 },
    };
    const baseline = nativeSummaryCachePersistence({
      provider: 'claude',
      store,
      fingerprintInput: base,
    }).fingerprint;

    for (const changed of [
      { ...base, version: 2 },
      { ...base, capabilities: { readOnly: false } },
      { ...base, limits: { a: 2 } },
    ]) {
      expect(
        nativeSummaryCachePersistence({
          provider: 'claude',
          store,
          fingerprintInput: changed,
        }).fingerprint
      ).not.toBe(baseline);
    }

    // The provider is the namespace, not part of the fingerprint.
    expect(
      nativeSummaryCachePersistence({
        provider: 'codex',
        store,
        fingerprintInput: base,
      }).namespace
    ).toBe('codex');
    expect(createHash('sha256').update('x').digest('hex')).toHaveLength(64);
  });
});
