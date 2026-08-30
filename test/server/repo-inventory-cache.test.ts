import { describe, expect, it } from 'vitest';

import {
  createRepoInventoryCache,
  DEFAULT_REPO_INVENTORY_TTL_MS,
} from '../../server/repo-inventory-cache.js';
import type { RepoInventoryDetail } from '../../server/repo-inventory.js';
import type { RepoInventoryReport } from '../../shared/repo-inventory.js';

function report(tag: string): RepoInventoryReport {
  return {
    nodeId: 'local',
    generatedAt: `${tag}`,
    repos: [],
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('repo inventory cache', () => {
  it('serves a warm read from the memo instead of rescanning', async () => {
    let calls = 0;
    let clock = 1_000;
    const cache = createRepoInventoryCache({
      collect: async () => {
        calls += 1;
        return report(`scan-${calls}`);
      },
      ttlMs: 5_000,
      now: () => clock,
    });

    await expect(cache.get()).resolves.toMatchObject({ generatedAt: 'scan-1' });
    clock += 4_999;
    await expect(cache.get()).resolves.toMatchObject({ generatedAt: 'scan-1' });
    expect(calls).toBe(1);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1 });
  });

  it('rescans once the TTL window closes', async () => {
    let calls = 0;
    let clock = 0;
    const cache = createRepoInventoryCache({
      collect: async () => {
        calls += 1;
        return report(`scan-${calls}`);
      },
      ttlMs: 5_000,
      now: () => clock,
    });

    await cache.get();
    clock += 5_000;
    await expect(cache.get()).resolves.toMatchObject({ generatedAt: 'scan-2' });
    expect(calls).toBe(2);
  });

  it('coalesces concurrent readers onto one in-flight scan', async () => {
    let calls = 0;
    const gate = deferred<void>();
    const cache = createRepoInventoryCache({
      collect: async () => {
        calls += 1;
        await gate.promise;
        return report('scan');
      },
    });

    const readers = [cache.get(), cache.get(), cache.get()];
    gate.resolve();
    const results = await Promise.all(readers);

    expect(calls).toBe(1);
    expect(results.every((value) => value.generatedAt === 'scan')).toBe(true);
    expect(cache.stats()).toMatchObject({ misses: 1, coalesced: 2 });
  });

  it('serves a cached full report to an identity reader but never the reverse', async () => {
    const seen: RepoInventoryDetail[] = [];
    const cache = createRepoInventoryCache({
      collect: async (detail) => {
        seen.push(detail);
        return report(detail);
      },
      ttlMs: 60_000,
    });

    await cache.get('full');
    // A full report is a superset of the identity projection — reuse it.
    await expect(cache.get('identity')).resolves.toMatchObject({
      generatedAt: 'full',
    });
    expect(seen).toEqual(['full']);

    // The reverse substitution would silently drop dirty/divergence/worktrees.
    await expect(cache.get('full')).resolves.toMatchObject({
      generatedAt: 'full',
    });
    const identityOnly = createRepoInventoryCache({
      collect: async (detail) => {
        seen.push(detail);
        return report(detail);
      },
      ttlMs: 60_000,
    });
    await identityOnly.get('identity');
    await expect(identityOnly.get('full')).resolves.toMatchObject({
      generatedAt: 'full',
    });
    expect(seen).toEqual(['full', 'identity', 'full']);
  });

  it('invalidate() forces the next read to rescan (dirty flag)', async () => {
    let calls = 0;
    const cache = createRepoInventoryCache({
      collect: async () => {
        calls += 1;
        return report(`scan-${calls}`);
      },
      ttlMs: 60_000,
    });

    await cache.get();
    await cache.get();
    expect(calls).toBe(1);

    cache.invalidate();
    await expect(cache.get()).resolves.toMatchObject({ generatedAt: 'scan-2' });
    expect(calls).toBe(2);
    expect(cache.stats().invalidations).toBe(1);
  });

  it('never stores a scan that started before an invalidation', async () => {
    let calls = 0;
    const gate = deferred<void>();
    const cache = createRepoInventoryCache({
      collect: async () => {
        calls += 1;
        const attempt = calls;
        if (attempt === 1) await gate.promise;
        return report(`scan-${attempt}`);
      },
      ttlMs: 60_000,
    });

    const inFlight = cache.get();
    // Mutation lands mid-scan: the pre-mutation result must not become the memo.
    cache.invalidate();
    gate.resolve();
    await expect(inFlight).resolves.toMatchObject({ generatedAt: 'scan-1' });

    await expect(cache.get()).resolves.toMatchObject({ generatedAt: 'scan-2' });
    expect(calls).toBe(2);
  });

  it('does not join a doomed in-flight scan after an invalidation', async () => {
    let calls = 0;
    const gate = deferred<void>();
    const cache = createRepoInventoryCache({
      collect: async () => {
        calls += 1;
        const attempt = calls;
        if (attempt === 1) await gate.promise;
        return report(`scan-${attempt}`);
      },
      ttlMs: 60_000,
    });

    const before = cache.get();
    cache.invalidate();
    const after = cache.get();
    gate.resolve();

    await expect(before).resolves.toMatchObject({ generatedAt: 'scan-1' });
    await expect(after).resolves.toMatchObject({ generatedAt: 'scan-2' });
  });

  it('does not memoise a failed scan and stays usable afterwards', async () => {
    let calls = 0;
    const cache = createRepoInventoryCache({
      collect: async () => {
        calls += 1;
        if (calls === 1) throw new Error('git exploded');
        return report('scan-2');
      },
      ttlMs: 60_000,
    });

    await expect(cache.get()).rejects.toThrow('git exploded');
    await expect(cache.get()).resolves.toMatchObject({ generatedAt: 'scan-2' });
    expect(calls).toBe(2);
  });

  it('expires an entry when the wall clock steps backwards', async () => {
    let calls = 0;
    let clock = 10_000;
    const cache = createRepoInventoryCache({
      collect: async () => {
        calls += 1;
        return report(`scan-${calls}`);
      },
      ttlMs: 60_000,
      now: () => clock,
    });

    await cache.get();
    // NTP correction / suspend-resume: a negative age must not pin the memo.
    clock -= 5_000;
    await expect(cache.get()).resolves.toMatchObject({ generatedAt: 'scan-2' });
    expect(calls).toBe(2);
  });

  it('defaults to a short TTL', () => {
    expect(DEFAULT_REPO_INVENTORY_TTL_MS).toBeLessThanOrEqual(10_000);
  });
});
