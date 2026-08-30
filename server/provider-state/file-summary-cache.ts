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
}

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

  constructor(capacity = 4_000) {
    this.capacity = Math.max(
      1,
      Number.isFinite(capacity) ? Math.floor(capacity) : 4_000
    );
  }

  get(filePath: string, stamp: FileStamp): T | undefined {
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
  }

  clear(): void {
    this.entries.clear();
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
