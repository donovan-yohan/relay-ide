/**
 * Shared read-path helpers for the native-session state adapters (#1449).
 *
 * `GET /sessions/native` used to re-read, hash and `JSON.parse` every provider
 * transcript on every request (~730 MB across the claude + codex stores on a
 * real machine). Two seams fix that without changing the response:
 *
 * - `FileDerivedCache` — an LRU cache (battle-tested-patterns `lru-cache`) of
 *   values derived from a file, keyed on the file's identity stamp. A file that
 *   was rewritten, replaced, appended to or restored from backup gets a new
 *   stamp, misses the cache and is re-derived, so the cache cannot serve a
 *   summary for content that has since changed.
 * - `runWithConcurrency` — bounded concurrency (battle-tested-patterns
 *   `semaphore`) over the per-file work, so the walk is no longer strictly
 *   serial while still never opening an unbounded number of file handles.
 *
 * Both are deliberately provider-agnostic: adapters own their parse semantics
 * and only borrow the caching/fan-out mechanics from here.
 *
 * #1459 adds an optional durable backing to `FileDerivedCache`. The cache is
 * still the only thing that decides whether a value may be served: a rehydrated
 * row goes through the same `get(filePath, stamp)` comparison as an in-memory
 * one, so persistence moves *where* the cache lives without widening what it is
 * allowed to answer.
 */

import type { Stats } from 'node:fs';

/**
 * Identity of a file's content at a point in time.
 *
 * All four fields matter and all four come free from one `stat`:
 * - `size` catches every append (provider stores are append-only).
 * - `mtimeMs` catches an in-place rewrite.
 * - `ino` catches a replacement by `rename`, which carries the *other* file's
 *   mtime and size and would otherwise look unchanged.
 * - `ctimeMs` catches a restore that forges mtime (`utimes`, rsync, backup
 *   tooling). ctime is not settable from userspace, so it cannot be forged the
 *   way mtime can.
 *
 * The residual window is an in-place rewrite to the identical byte length
 * within the filesystem's mtime granularity. On ext4 (ns timestamps) that
 * window is tens of microseconds; on a coarse-granularity mount (CIFS, FAT) it
 * is up to the granularity. Provider transcripts are append-only, so a rewrite
 * to the identical length is not a shape any supported provider produces.
 */
export interface FileStamp {
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  ino: number;
}

export function stampFromStats(info: Stats): FileStamp {
  return {
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
    size: info.size,
    ino: info.ino,
  };
}

export function sameStamp(a: FileStamp, b: FileStamp): boolean {
  return (
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.size === b.size &&
    a.ino === b.ino
  );
}

/** Counters for the cache's own behaviour; exposed for tests and diagnostics. */
export interface FileDerivedCacheStats {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
  capacity: number;
  /** #1459 durable-backing counters; all zero when no backing is configured. */
  persisted: FileDerivedCachePersistenceStats;
}

/** #1459: counters for the durable backing behind a {@link FileDerivedCache}. */
export interface FileDerivedCachePersistenceStats {
  /** A durable backing is configured for this cache. */
  enabled: boolean;
  /** The durable rows have been read into memory. */
  rehydrated: boolean;
  /** Rows accepted from the durable backing at rehydrate. */
  rehydratedRows: number;
  /** Rows the backing returned that failed `deserialize` and were discarded. */
  rejectedRows: number;
  /** Values handed to the backing to write, cumulative. */
  writes: number;
  /** Paths handed to the backing to drop, cumulative. */
  forgets: number;
  /** Values derived but not yet flushed. */
  pending: number;
}

/**
 * One durable row: a file path, the stamp its value was derived under, and the
 * serialized value. The stamp is stored verbatim so the rehydrated entry is
 * indistinguishable from one this process derived.
 */
export interface PersistedCacheRow {
  filePath: string;
  stamp: FileStamp;
  json: string;
}

/**
 * The narrow slice of a durable store a {@link FileDerivedCache} needs.
 * Structural, so the SQLite store in `summary-cache-store.ts` satisfies it
 * without this module importing it (and without a module cycle).
 *
 * Every method must contain its own failures: a cache backing that throws into
 * the read path would turn a performance optimisation into an outage.
 */
export interface FileDerivedCacheBackingStore {
  load(namespace: string, fingerprint: string): PersistedCacheRow[];
  save(
    namespace: string,
    fingerprint: string,
    entries: readonly PersistedCacheRow[]
  ): void;
  forget(namespace: string, filePaths: readonly string[]): void;
}

/** Wiring that binds one cache to one namespace inside a durable store. */
export interface FileDerivedCachePersistence<T> {
  /** Row namespace, e.g. the provider id. */
  namespace: string;
  /**
   * Hash of everything outside the file's bytes that shapes the derived value.
   * Rows written under a different fingerprint are never served.
   */
  fingerprint: string;
  store: FileDerivedCacheBackingStore;
  serialize: (value: T) => string;
  /**
   * Parse a durable row back, or return `undefined` to reject it. `filePath` is
   * the row's key so the implementation can refuse a misfiled value.
   */
  deserialize: (json: string, filePath: string) => T | undefined;
}

/**
 * Flush once this many un-written values pile up, so a caller that never calls
 * {@link FileDerivedCache.persistWalk} still cannot grow the pending map
 * without bound.
 */
const PENDING_WRITE_FLUSH_THRESHOLD = 512;

/**
 * Bounded LRU cache of values derived from a file's full contents.
 *
 * Invariants:
 * - `size` never exceeds `capacity` (memory is bounded even if the provider
 *   store grows without limit).
 * - A `get` only returns a value stored under an identical stamp — a modified,
 *   truncated, replaced or restored file always misses.
 * - Eviction removes the least recently used entry.
 */
export class FileDerivedCache<T> {
  private readonly entries = new Map<string, { stamp: FileStamp; value: T }>();
  private readonly capacity: number;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  /** #1459: optional durable backing. Absent means memory-only, as before. */
  private readonly persistence: FileDerivedCachePersistence<T> | undefined;
  private rehydrated = false;
  private rehydratedRows = 0;
  private rejectedRows = 0;
  private persistWrites = 0;
  private persistForgets = 0;
  /** Paths the backing is known to hold a row for (rehydrated or flushed). */
  private readonly durablePaths = new Set<string>();
  /** Derived values not yet written; flushed by `persistWalk`/`flush`. */
  private readonly pendingWrites = new Map<
    string,
    { stamp: FileStamp; value: T }
  >();
  /** Paths whose durable row should be dropped on the next flush. */
  private readonly pendingForgets = new Set<string>();

  constructor(
    capacity = 4_000,
    persistence?: FileDerivedCachePersistence<T> | undefined
  ) {
    this.capacity = Math.max(
      1,
      Number.isFinite(capacity) ? Math.floor(capacity) : 4_000
    );
    this.persistence = persistence;
  }

  /**
   * Read the durable rows into memory once, on first use.
   *
   * Lazy rather than at construction so hub boot never pays for a store nobody
   * asks about, and so a broken cache file surfaces on the first list rather
   * than during startup. Rejected rows are counted, not thrown: a row that no
   * longer deserializes simply re-parses from the transcript.
   */
  private ensureRehydrated(): void {
    const persistence = this.persistence;
    if (!persistence || this.rehydrated) return;
    // Set first: a throwing backing must not retry on every single lookup.
    this.rehydrated = true;
    let rows: PersistedCacheRow[];
    try {
      rows = persistence.store.load(
        persistence.namespace,
        persistence.fingerprint
      );
    } catch {
      return;
    }
    for (const row of rows) {
      // The backing holds a row for this path either way, and that is what
      // `durablePaths` tracks: a rejected row still has to be prunable and
      // still has to be replaced by the re-derived value rather than orphaned.
      this.durablePaths.add(row.filePath);
      const value = persistence.deserialize(row.json, row.filePath);
      if (value === undefined) {
        this.rejectedRows += 1;
        continue;
      }
      this.rehydratedRows += 1;
      this.store(row.filePath, row.stamp, value);
    }
  }

  get(filePath: string, stamp: FileStamp): T | undefined {
    this.ensureRehydrated();
    const hit = this.entries.get(filePath);
    if (!hit) {
      this.misses += 1;
      return undefined;
    }
    if (!sameStamp(hit.stamp, stamp)) {
      // Stale: the file changed underneath us. Drop it rather than keep a
      // second key alive for the same path.
      this.entries.delete(filePath);
      this.misses += 1;
      return undefined;
    }
    // Refresh recency (Map preserves insertion order; re-insert moves to back).
    this.entries.delete(filePath);
    this.entries.set(filePath, hit);
    this.hits += 1;
    return hit.value;
  }

  set(filePath: string, stamp: FileStamp, value: T): void {
    this.ensureRehydrated();
    this.store(filePath, stamp, value);
    if (!this.persistence) return;
    // A path being written cannot also be a path being dropped.
    this.pendingForgets.delete(filePath);
    this.pendingWrites.set(filePath, { stamp, value });
    if (this.pendingWrites.size >= PENDING_WRITE_FLUSH_THRESHOLD) this.flush();
  }

  /** Memory-only insert + LRU eviction, shared by `set` and rehydration. */
  private store(filePath: string, stamp: FileStamp, value: T): void {
    if (this.entries.has(filePath)) this.entries.delete(filePath);
    this.entries.set(filePath, { stamp, value });
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
      this.evictions += 1;
    }
  }

  delete(filePath: string): void {
    this.entries.delete(filePath);
    if (!this.persistence) return;
    this.pendingWrites.delete(filePath);
    // Only worth a DELETE if a row can actually exist for this path.
    if (this.durablePaths.has(filePath)) this.pendingForgets.add(filePath);
  }

  /**
   * Drop every in-memory entry. Durable rows are deliberately left alone: they
   * are still values this cache derived under stamps that still describe the
   * files, so a later process may serve them. Use it to release memory, not to
   * invalidate.
   */
  clear(): void {
    this.entries.clear();
  }

  /**
   * Write everything derived since the last flush and drop everything deleted
   * since. Synchronous, because the backing is synchronous SQLite and a caller
   * that returns before the write lands would make restart behaviour depend on
   * timing.
   */
  flush(): void {
    const persistence = this.persistence;
    if (!persistence) return;

    if (this.pendingForgets.size > 0) {
      const paths = Array.from(this.pendingForgets);
      this.pendingForgets.clear();
      try {
        persistence.store.forget(persistence.namespace, paths);
        this.persistForgets += paths.length;
        for (const filePath of paths) this.durablePaths.delete(filePath);
      } catch {
        // Dropped rows are stale, not wrong: they can never pass a stamp check.
      }
    }

    if (this.pendingWrites.size > 0) {
      const entries: PersistedCacheRow[] = [];
      for (const [filePath, entry] of this.pendingWrites) {
        entries.push({
          filePath,
          stamp: entry.stamp,
          json: persistence.serialize(entry.value),
        });
      }
      this.pendingWrites.clear();
      try {
        persistence.store.save(
          persistence.namespace,
          persistence.fingerprint,
          entries
        );
        this.persistWrites += entries.length;
        for (const entry of entries) this.durablePaths.add(entry.filePath);
      } catch {
        // Intentionally dropped rather than retried: a permanently failing
        // backing would otherwise grow `pendingWrites` without bound. The
        // values are still correct in memory for the rest of this process; the
        // only cost is that the *next* process re-derives them. The SQLite
        // store contains its own errors, so this is a belt-and-braces path.
      }
    }
  }

  /**
   * Flush, and — when the caller can prove it saw *every* file in the
   * namespace — drop durable rows for paths that no longer exist.
   *
   * This assumes one cache owns a namespace inside the backing store: pruning
   * deletes rows the *store* holds for the namespace, so two caches walking
   * different roots under one namespace would delete each other's rows. The hub
   * registers exactly one adapter per provider.
   *
   * `seenPaths` must be omitted whenever the walk was capped or filtered.
   * Pruning against a partial walk would delete rows for transcripts the walk
   * simply never reached, so the cache would thrash instead of shrinking. With
   * no complete walk the row budget in the backing store is the only bound, and
   * it is enough.
   */
  persistWalk(seenPaths?: ReadonlySet<string>): void {
    if (!this.persistence) return;
    if (seenPaths) {
      for (const filePath of this.durablePaths) {
        if (seenPaths.has(filePath)) continue;
        if (this.pendingWrites.has(filePath)) continue;
        this.pendingForgets.add(filePath);
      }
    }
    this.flush();
  }

  get size(): number {
    return this.entries.size;
  }

  get maxSize(): number {
    return this.capacity;
  }

  stats(): FileDerivedCacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      size: this.entries.size,
      capacity: this.capacity,
      persisted: {
        enabled: this.persistence !== undefined,
        rehydrated: this.rehydrated,
        rehydratedRows: this.rehydratedRows,
        rejectedRows: this.rejectedRows,
        writes: this.persistWrites,
        forgets: this.persistForgets,
        pending: this.pendingWrites.size,
      },
    };
  }
}

/**
 * Run `worker` over `items` with at most `limit` in flight at once, returning
 * results in input order.
 *
 * Order preservation matters: the adapters sort summaries by timestamp with a
 * stable sort, so the pre-sort order is part of the response contract for
 * sessions that share a timestamp.
 *
 * The bound is per call, not global. If `worker` rejects, the returned promise
 * rejects while already-started workers run to completion and their results are
 * discarded; both adapters catch inside their worker, so that path is
 * unreachable from the list path.
 */
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;

  const requested = Number.isFinite(limit) ? Math.floor(limit) : 1;
  const permits = Math.max(1, Math.min(requested, items.length));
  let cursor = 0;

  const runners: Promise<void>[] = [];
  for (let i = 0; i < permits; i += 1) {
    runners.push(
      (async () => {
        for (;;) {
          const index = cursor;
          cursor += 1;
          if (index >= items.length) return;
          results[index] = await worker(items[index] as T, index);
        }
      })()
    );
  }

  await Promise.all(runners);
  return results;
}

/**
 * Share one in-flight derivation per key so concurrent list requests never read
 * the same transcript twice. The entry is removed as soon as it settles, so
 * this map holds at most the paths currently being read.
 */
export class SingleFlight<T> {
  private readonly inFlight = new Map<string, Promise<T>>();

  run(key: string, work: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const started = work().finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, started);
    return started;
  }

  get size(): number {
    return this.inFlight.size;
  }
}
