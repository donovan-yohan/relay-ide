/**
 * Restart-surviving backing store for the native-session summary cache (#1459).
 *
 * #1449 put an in-memory per-file summary cache in front of the provider
 * transcript walk, which took `GET /sessions/native` warm from ~5.3 s to
 * ~0.1 s. A *cold* process still paid the full walk once — ~730 MB and 4.3 s at
 * 989 sessions — because a summary carries `hashSha256`, `lineCount` and
 * `eventTypes`, all of which need the whole file. Every hub restart threw the
 * work away.
 *
 * This module persists the derived summaries into a SQLite table in the hub
 * config directory (never the checkout) so a fresh process rehydrates them
 * instead of re-reading the stores. Correctness comes from reusing the #1449
 * stamp unchanged: a rehydrated row is only ever served through
 * `FileDerivedCache.get(filePath, stamp)`, which compares the persisted
 * `(mtimeMs, ctimeMs, size, ino)` against a fresh `stat` and misses if anything
 * differs. Persistence therefore cannot widen the staleness window — it only
 * moves where the cache lives between the stat and the parse.
 *
 * Everything here is a *cache*. No read or write may throw into the request
 * path, no failure may stop the hub booting, and the file is bounded in both
 * rows and bytes so it can never grow without limit.
 */

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import * as path from 'node:path';

import { createLogger } from '../logger.js';
import type {
  FileDerivedCachePersistence,
  FileStamp,
} from './file-summary-cache.js';
import type {
  NativeSessionProvider,
  NativeSessionSummary,
} from '../../shared/provider-native-session-state.js';

const logger = createLogger('provider-state:summary-cache');

/** File name under the hub config directory. */
export const SUMMARY_CACHE_DB_FILE = 'native-session-summaries.db';

/**
 * Row budget across every namespace. The list walk is capped at 500 files per
 * adapter and there are two persisting adapters, so 8,000 rows is ~8x the live
 * working set: enough headroom that ordinary churn never evicts, small enough
 * that an abandoned state root cannot accumulate forever.
 */
const DEFAULT_MAX_ROWS = 8_000;

/**
 * Byte budget across every namespace, measured on the stored JSON. A real
 * summary is ~1 KB, so 32 MB is ~30x the live working set and still a hard
 * ceiling on the file. Whichever budget binds first evicts oldest-first.
 */
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Per-row ceiling. `eventTypes` is the only unbounded field on a summary (one
 * entry per distinct record type in a transcript), so a pathological file is
 * simply not persisted rather than allowed to eat the whole byte budget. It
 * still lives in the in-memory cache for this process.
 */
const MAX_ROW_BYTES = 32 * 1024;

/** After this many consecutive failures the store stops trying for this process. */
const MAX_CONSECUTIVE_ERRORS = 5;

/** Bound on SQLite bound-parameter count per statement. */
const DELETE_CHUNK = 500;

export interface PersistedSummaryEntry {
  filePath: string;
  stamp: FileStamp;
  /** Serialized derived value, exactly as `deserialize` will parse it back. */
  json: string;
}

export interface NativeSummaryCacheStoreStats {
  /** Rows handed back by `load`, cumulative. */
  loaded: number;
  /** Rows written by `save`, cumulative. */
  saved: number;
  /** Rows removed by `forget` or by budget eviction, cumulative. */
  removed: number;
  /** Failed operations, cumulative. */
  errors: number;
  /** True once the store gave up after repeated failures. */
  disabled: boolean;
}

export interface NativeSummaryCacheStore {
  /**
   * Every row for `namespace` recorded under `fingerprint`. Rows carrying a
   * different fingerprint are deleted: they were derived by a build whose
   * summary shape or limits differ, so they can never be served again.
   */
  load(namespace: string, fingerprint: string): PersistedSummaryEntry[];
  save(
    namespace: string,
    fingerprint: string,
    entries: readonly PersistedSummaryEntry[]
  ): void;
  forget(namespace: string, filePaths: readonly string[]): void;
  stats(): NativeSummaryCacheStoreStats;
  close(): void;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS native_session_summaries (
  namespace    TEXT NOT NULL,
  file_path    TEXT NOT NULL,
  fingerprint  TEXT NOT NULL,
  mtime_ms     REAL NOT NULL,
  ctime_ms     REAL NOT NULL,
  size         REAL NOT NULL,
  ino          REAL NOT NULL,
  summary_json TEXT NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (namespace, file_path)
);
CREATE INDEX IF NOT EXISTS idx_native_session_summaries_age
  ON native_session_summaries(updated_at);
`;

interface SummaryRow {
  file_path: string;
  mtime_ms: number;
  ctime_ms: number;
  size: number;
  ino: number;
  summary_json: string;
}

/** A store that remembers nothing — used when SQLite is unavailable. */
export const NOOP_SUMMARY_CACHE_STORE: NativeSummaryCacheStore = {
  load: () => [],
  save: () => {},
  forget: () => {},
  stats: () => ({
    loaded: 0,
    saved: 0,
    removed: 0,
    errors: 0,
    disabled: true,
  }),
  close: () => {},
};

export interface OpenSummaryCacheStoreOptions {
  dbPath: string;
  maxRows?: number;
  maxBytes?: number;
}

/**
 * A cache file that cannot be opened as a database is worthless and safe to
 * discard, but only when the failure actually says "this is not a database".
 * A lock, a permission problem or a full disk is transient and must not delete
 * a file another process is using.
 */
function isCorruptionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /CORRUPT|NOTADB/.test(code)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /not a database|malformed|corrupt/i.test(message);
}

/** Create the DB at 0600 before better-sqlite3 opens it (agent-profile-store precedent). */
function precreateRestricted(dbPath: string): void {
  if (!dbPath || dbPath === ':memory:' || dbPath.startsWith('file:')) return;
  try {
    fs.closeSync(fs.openSync(dbPath, 'wx', 0o600));
  } catch {
    // Already exists, or the directory is not writable; the open below reports
    // the real problem.
  }
}

function openDatabase(dbPath: string): Database.Database | null {
  const attempt = (): Database.Database => {
    precreateRestricted(dbPath);
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    // Durability of the newest write does not matter for a cache; WAL with
    // synchronous=NORMAL is still crash-safe against corruption.
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 2000');
    // Set before the first table exists so eviction can hand pages back to the
    // filesystem instead of leaving the file at its high-water mark.
    db.pragma('auto_vacuum = INCREMENTAL');
    db.exec(SCHEMA_SQL);
    return db;
  };

  try {
    return attempt();
  } catch (error) {
    if (!isCorruptionError(error)) {
      logger.warn(
        '[native-summary-cache] could not open %s (%s); running without a persistent summary cache',
        dbPath,
        error instanceof Error ? error.message : String(error)
      );
      return null;
    }
    logger.warn(
      '[native-summary-cache] %s is corrupt; discarding the cache file and rebuilding',
      dbPath
    );
    for (const target of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      try {
        fs.rmSync(target, { force: true });
      } catch {
        // Nothing to do: the retry below reports the outcome.
      }
    }
    try {
      return attempt();
    } catch (retryError) {
      logger.warn(
        '[native-summary-cache] rebuild of %s failed (%s); running without a persistent summary cache',
        dbPath,
        retryError instanceof Error ? retryError.message : String(retryError)
      );
      return null;
    }
  }
}

export function openNativeSummaryCacheStore(
  options: OpenSummaryCacheStoreOptions
): NativeSummaryCacheStore {
  const db = openDatabase(options.dbPath);
  if (!db) return NOOP_SUMMARY_CACHE_STORE;
  // Bound the narrowed handle so the hoisted helpers below see it as non-null.
  const conn: Database.Database = db;

  const maxRows = Math.max(
    1,
    Number.isFinite(options.maxRows ?? NaN)
      ? Math.floor(options.maxRows as number)
      : DEFAULT_MAX_ROWS
  );
  const maxBytes = Math.max(
    1_024,
    Number.isFinite(options.maxBytes ?? NaN)
      ? Math.floor(options.maxBytes as number)
      : DEFAULT_MAX_BYTES
  );

  const stats: NativeSummaryCacheStoreStats = {
    loaded: 0,
    saved: 0,
    removed: 0,
    errors: 0,
    disabled: false,
  };
  let consecutiveErrors = 0;

  const selectStmt = conn.prepare(
    `SELECT file_path, mtime_ms, ctime_ms, size, ino, summary_json
       FROM native_session_summaries
      WHERE namespace = ? AND fingerprint = ?`
  );
  const dropStaleFingerprintStmt = conn.prepare(
    `DELETE FROM native_session_summaries
      WHERE namespace = ? AND fingerprint <> ?`
  );
  const upsertStmt = conn.prepare(
    `INSERT INTO native_session_summaries (
       namespace, file_path, fingerprint, mtime_ms, ctime_ms, size, ino,
       summary_json, updated_at
     ) VALUES (
       @namespace, @filePath, @fingerprint, @mtimeMs, @ctimeMs, @size, @ino,
       @summaryJson, @updatedAt
     )
     ON CONFLICT(namespace, file_path) DO UPDATE SET
       fingerprint  = excluded.fingerprint,
       mtime_ms     = excluded.mtime_ms,
       ctime_ms     = excluded.ctime_ms,
       size         = excluded.size,
       ino          = excluded.ino,
       summary_json = excluded.summary_json,
       updated_at   = excluded.updated_at`
  );
  const auditStmt = conn.prepare(
    `SELECT rowid AS id, LENGTH(summary_json) AS bytes
       FROM native_session_summaries
      ORDER BY updated_at DESC, rowid DESC`
  );

  /**
   * Report a failure, and stop touching SQLite entirely once the same thing has
   * gone wrong repeatedly. A broken cache must cost one warning, not a
   * per-request exception.
   */
  function recordError(operation: string, error: unknown): void {
    stats.errors += 1;
    consecutiveErrors += 1;
    logger.warn(
      '[native-summary-cache] %s failed (%s)',
      operation,
      error instanceof Error ? error.message : String(error)
    );
    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS && !stats.disabled) {
      stats.disabled = true;
      logger.warn(
        '[native-summary-cache] disabling the persistent summary cache for this process after %d consecutive failures',
        consecutiveErrors
      );
    }
  }

  function deleteRows(namespace: string, filePaths: readonly string[]): number {
    let removed = 0;
    for (let i = 0; i < filePaths.length; i += DELETE_CHUNK) {
      const chunk = filePaths.slice(i, i + DELETE_CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const result = conn
        .prepare(
          `DELETE FROM native_session_summaries
            WHERE namespace = ? AND file_path IN (${placeholders})`
        )
        .run(namespace, ...chunk);
      removed += result.changes;
    }
    return removed;
  }

  /**
   * Hold the file to `maxRows` and `maxBytes` by dropping the least recently
   * written rows first. Runs only after a write actually changed something, so
   * a warm hub that writes nothing also scans nothing.
   */
  function enforceBudget(): void {
    const rows = auditStmt.all() as { id: number; bytes: number }[];
    let keptRows = 0;
    let keptBytes = 0;
    const doomed: number[] = [];
    for (const row of rows) {
      const bytes = Number(row.bytes) || 0;
      if (keptRows + 1 > maxRows || keptBytes + bytes > maxBytes) {
        doomed.push(row.id);
        continue;
      }
      keptRows += 1;
      keptBytes += bytes;
    }
    if (doomed.length === 0) return;

    for (let i = 0; i < doomed.length; i += DELETE_CHUNK) {
      const chunk = doomed.slice(i, i + DELETE_CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const result = conn
        .prepare(
          `DELETE FROM native_session_summaries WHERE rowid IN (${placeholders})`
        )
        .run(...chunk);
      stats.removed += result.changes;
    }
    // Hand the freed pages back rather than leaving the file at its
    // high-water mark.
    try {
      conn.pragma('incremental_vacuum');
    } catch {
      // Reclaiming space is an optimisation, not a correctness requirement.
    }
  }

  const saveTransaction = conn.transaction(
    (
      namespace: string,
      fingerprint: string,
      entries: readonly PersistedSummaryEntry[],
      updatedAt: number
    ) => {
      for (const entry of entries) {
        upsertStmt.run({
          namespace,
          filePath: entry.filePath,
          fingerprint,
          mtimeMs: entry.stamp.mtimeMs,
          ctimeMs: entry.stamp.ctimeMs,
          size: entry.stamp.size,
          ino: entry.stamp.ino,
          summaryJson: entry.json,
          updatedAt,
        });
      }
    }
  );

  return {
    load(namespace, fingerprint) {
      if (stats.disabled) return [];
      try {
        const dropped = dropStaleFingerprintStmt.run(namespace, fingerprint);
        stats.removed += dropped.changes;
        const rows = selectStmt.all(namespace, fingerprint) as SummaryRow[];
        const entries: PersistedSummaryEntry[] = rows.map((row) => ({
          filePath: row.file_path,
          stamp: {
            mtimeMs: row.mtime_ms,
            ctimeMs: row.ctime_ms,
            size: row.size,
            ino: row.ino,
          },
          json: row.summary_json,
        }));
        stats.loaded += entries.length;
        consecutiveErrors = 0;
        return entries;
      } catch (error) {
        recordError('load', error);
        return [];
      }
    },

    save(namespace, fingerprint, entries) {
      if (stats.disabled || entries.length === 0) return;
      const writable = entries.filter(
        (entry) => entry.json.length <= MAX_ROW_BYTES
      );
      if (writable.length === 0) return;
      try {
        saveTransaction(namespace, fingerprint, writable, Date.now());
        stats.saved += writable.length;
        enforceBudget();
        consecutiveErrors = 0;
      } catch (error) {
        recordError('save', error);
      }
    },

    forget(namespace, filePaths) {
      if (stats.disabled || filePaths.length === 0) return;
      try {
        stats.removed += deleteRows(namespace, filePaths);
        consecutiveErrors = 0;
      } catch (error) {
        recordError('forget', error);
      }
    },

    stats() {
      return { ...stats };
    },

    close() {
      try {
        conn.close();
      } catch {
        // Closing a cache is best effort.
      }
    },
  };
}

/**
 * Open the summary cache beside the hub's other runtime SQLite stores. The
 * config directory is the only supported location — never the checkout
 * (`server/runtime-state-paths.ts`).
 */
export function initNativeSummaryCacheStore(
  configDir: string
): NativeSummaryCacheStore {
  return openNativeSummaryCacheStore({
    dbPath: path.join(configDir, SUMMARY_CACHE_DB_FILE),
  });
}

/**
 * Reject a persisted row that cannot be what a fresh parse would have produced.
 *
 * The stamp already proves the *file* is unchanged; these checks catch a row
 * that is structurally wrong for some other reason — a partially written value,
 * a summary filed under the wrong key, or a shape from a build whose fingerprint
 * somehow collided. Anything rejected simply re-parses.
 */
function parsePersistedSummary(
  json: string,
  filePath: string,
  provider: NativeSessionProvider
): NativeSessionSummary | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  const candidate = parsed as Partial<NativeSessionSummary>;
  if (candidate.provider !== provider) return undefined;
  if (typeof candidate.nativeId !== 'string' || candidate.nativeId.length === 0)
    return undefined;
  // The row is keyed by path; a summary pointing somewhere else is misfiled and
  // would hand a caller another session's transcript path.
  if (candidate.sourcePath !== filePath) return undefined;
  if (!candidate.preview || typeof candidate.preview !== 'object')
    return undefined;
  if (!candidate.metadata || typeof candidate.metadata !== 'object')
    return undefined;
  if (!candidate.capabilities || typeof candidate.capabilities !== 'object')
    return undefined;
  return candidate as NativeSessionSummary;
}

export interface NativeSummaryPersistenceOptions {
  provider: NativeSessionProvider;
  store: NativeSummaryCacheStore;
  /**
   * Everything outside the file's own bytes that changes the derived summary:
   * the format version, the adapter's capabilities, and its parse limits. It is
   * hashed into the row fingerprint, so tuning a limit or changing capabilities
   * invalidates every persisted row automatically instead of serving summaries
   * the current build would never produce.
   */
  fingerprintInput: unknown;
}

/**
 * Bind a {@link NativeSummaryCacheStore} to one adapter's `FileDerivedCache`.
 */
export function nativeSummaryCachePersistence(
  options: NativeSummaryPersistenceOptions
): FileDerivedCachePersistence<NativeSessionSummary> {
  return {
    namespace: options.provider,
    fingerprint: fingerprintOf(options.fingerprintInput),
    store: options.store,
    serialize: (value) => JSON.stringify(value),
    deserialize: (json, filePath) =>
      parsePersistedSummary(json, filePath, options.provider),
  };
}

/**
 * Stable short hash of everything outside the file that shapes a summary. Any
 * change to it retires every persisted row for the namespace.
 */
function fingerprintOf(input: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(input) ?? 'null')
    .digest('hex')
    .slice(0, 16);
}
