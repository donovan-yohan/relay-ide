import type { RepoInventoryReport } from '../shared/repo-inventory.js';
import type { RepoInventoryDetail } from './repo-inventory.js';

/**
 * Short-TTL memo + in-flight coalescing + dirty-flag invalidation in front of
 * `collectLocalRepoInventory` (#1448).
 *
 * `GET /hub/repo-inventory`, `GET /hub/repo-groups` and `GET /hub/ia/tree` all
 * derive from the SAME local scan and each used to run it from scratch, so a
 * single dialog open could pay for the fork storm three times over. This cache
 * is the shared read model behind all three.
 *
 * Patterns applied (battle-tested-patterns catalog):
 * - `dirty-flag` — repo/worktree/branch mutations mark the memo stale rather
 *   than eagerly rescanning; the next reader pays, and only once.
 * - in-flight coalescing (repo convention, cf. `gh.ts` CI status) — concurrent
 *   readers share one scan instead of racing N of them.
 *
 * Freshness contract: entries live at most `ttlMs`, and ANY hub-observed
 * mutation (worktree add/remove, workspace/repo add/remove, branch change)
 * invalidates immediately. Reads are therefore stale by at most one TTL window
 * of *unobserved* filesystem drift — e.g. a `git commit` run in a terminal the
 * hub does not watch.
 */

/** Default freshness window. Short enough that unobserved git drift is a blink. */
export const DEFAULT_REPO_INVENTORY_TTL_MS = 5_000;

export interface RepoInventoryCacheDeps {
  /** The uncached collector. Called at most once per (tier, miss). */
  collect: (detail: RepoInventoryDetail) => Promise<RepoInventoryReport>;
  ttlMs?: number;
  /** Injected clock (ms). Tests drive this instead of sleeping. */
  now?: () => number;
}

export interface RepoInventoryCacheStats {
  hits: number;
  misses: number;
  coalesced: number;
  invalidations: number;
}

export interface RepoInventoryCache {
  get(detail?: RepoInventoryDetail): Promise<RepoInventoryReport>;
  /** Dirty-flag the memo. Cheap, synchronous, safe to call from event handlers. */
  invalidate(): void;
  stats(): RepoInventoryCacheStats;
}

interface CacheEntry {
  report: RepoInventoryReport;
  storedAt: number;
}

function resolveTtlMs(explicit: number | undefined): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit >= 0) {
    return explicit;
  }
  const raw = Number.parseInt(process.env.RELAY_REPO_INVENTORY_TTL_MS ?? '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_REPO_INVENTORY_TTL_MS;
}

export function createRepoInventoryCache(
  deps: RepoInventoryCacheDeps
): RepoInventoryCache {
  const ttlMs = resolveTtlMs(deps.ttlMs);
  const now = deps.now ?? (() => Date.now());
  // At most two entries ('full' and 'identity'), each overwritten in place, so
  // the retained set is bounded by one report per tier — not a growing map.
  const entries = new Map<RepoInventoryDetail, CacheEntry>();
  const inFlight = new Map<RepoInventoryDetail, Promise<RepoInventoryReport>>();
  let generation = 0;
  const stats: RepoInventoryCacheStats = {
    hits: 0,
    misses: 0,
    coalesced: 0,
    invalidations: 0,
  };

  function fresh(detail: RepoInventoryDetail): RepoInventoryReport | null {
    const entry = entries.get(detail);
    if (!entry) return null;
    const age = now() - entry.storedAt;
    // A negative age means the wall clock stepped backwards (NTP correction,
    // suspend/resume). Expire rather than pinning the entry until the clock
    // catches up.
    if (age < 0 || age >= ttlMs) {
      entries.delete(detail);
      return null;
    }
    return entry.report;
  }

  // A `full` report is a strict superset of the `identity` tier: identical
  // shape, same identity fields, plus the working-tree facts an identity
  // reader ignores. Serving it to an identity reader is never less accurate.
  // The reverse substitution is NOT allowed.
  function servable(detail: RepoInventoryDetail): RepoInventoryReport | null {
    return fresh(detail) ?? (detail === 'identity' ? fresh('full') : null);
  }

  function pending(
    detail: RepoInventoryDetail
  ): Promise<RepoInventoryReport> | undefined {
    return (
      inFlight.get(detail) ??
      (detail === 'identity' ? inFlight.get('full') : undefined)
    );
  }

  function get(
    detail: RepoInventoryDetail = 'full'
  ): Promise<RepoInventoryReport> {
    const cached = servable(detail);
    if (cached) {
      stats.hits += 1;
      return Promise.resolve(cached);
    }

    const shared = pending(detail);
    if (shared) {
      stats.coalesced += 1;
      return shared;
    }

    stats.misses += 1;
    const startedAt = generation;
    const promise = deps
      .collect(detail)
      .then((report) => {
        // Drop the result on the floor if the world changed mid-scan: storing
        // it would resurrect pre-mutation state past an explicit invalidate.
        if (startedAt === generation) {
          entries.set(detail, { report, storedAt: now() });
        }
        return report;
      })
      .finally(() => {
        if (inFlight.get(detail) === promise) inFlight.delete(detail);
      });
    inFlight.set(detail, promise);
    return promise;
  }

  function invalidate(): void {
    generation += 1;
    entries.clear();
    // Also drop the in-flight handles. A scan that started BEFORE the mutation
    // cannot observe it, so a reader arriving after the mutation must start a
    // fresh scan rather than join the doomed one. Existing awaiters still get
    // their (pre-mutation) answer; they asked before the change happened.
    inFlight.clear();
    stats.invalidations += 1;
  }

  return {
    get,
    invalidate,
    stats: () => ({ ...stats }),
  };
}
