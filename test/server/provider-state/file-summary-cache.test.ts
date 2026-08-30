import { describe, expect, it } from 'vitest';
import {
  FileDerivedCache,
  runWithConcurrency,
  sameStamp,
  stampFromStats,
  SingleFlight,
  type FileStamp,
} from '../../../server/provider-state/file-summary-cache.js';

function stamp(overrides: Partial<FileStamp> = {}): FileStamp {
  return { mtimeMs: 100, ctimeMs: 100, size: 20, ino: 7, ...overrides };
}

describe('FileDerivedCache', () => {
  it('serves a value only under an identical stamp', () => {
    const cache = new FileDerivedCache<string>(10);
    cache.set('/a.jsonl', stamp(), 'first');

    expect(cache.get('/a.jsonl', stamp())).toBe('first');
    expect(cache.get('/a.jsonl', stamp({ mtimeMs: 101 }))).toBeUndefined();
  });

  it.each([
    ['mtime moved (in-place rewrite)', { mtimeMs: 101 }],
    ['size grew (append)', { size: 21 }],
    ['ctime moved (mtime forged back by a restore)', { ctimeMs: 101 }],
    ['inode changed (replaced by rename)', { ino: 8 }],
  ])('misses when %s', (_label, change) => {
    const cache = new FileDerivedCache<string>(10);
    cache.set('/a.jsonl', stamp(), 'first');
    expect(cache.get('/a.jsonl', stamp(change))).toBeUndefined();
  });

  it('drops the stale entry on a stamp miss instead of keeping it alive', () => {
    const cache = new FileDerivedCache<string>(10);
    cache.set('/a.jsonl', stamp(), 'first');
    cache.get('/a.jsonl', stamp({ mtimeMs: 200 }));
    expect(cache.size).toBe(0);
    // Even the original stamp is gone: the entry was evicted, not shadowed.
    expect(cache.get('/a.jsonl', stamp())).toBeUndefined();
  });

  it('never exceeds its capacity and evicts the least recently used entry', () => {
    const cache = new FileDerivedCache<string>(3);
    cache.set('/a', stamp(), 'a');
    cache.set('/b', stamp(), 'b');
    cache.set('/c', stamp(), 'c');
    expect(cache.size).toBe(3);

    // Touch /a so /b becomes the least recently used entry.
    expect(cache.get('/a', stamp())).toBe('a');
    cache.set('/d', stamp(), 'd');

    expect(cache.size).toBe(3);
    expect(cache.maxSize).toBe(3);
    expect(cache.get('/b', stamp())).toBeUndefined();
    expect(cache.get('/a', stamp())).toBe('a');
    expect(cache.get('/c', stamp())).toBe('c');
    expect(cache.get('/d', stamp())).toBe('d');
  });

  it('stays bounded under a write flood far larger than its capacity', () => {
    const cache = new FileDerivedCache<number>(50);
    for (let i = 0; i < 5_000; i += 1) cache.set(`/f-${i}`, stamp(), i);
    expect(cache.size).toBe(50);
    expect(cache.stats().evictions).toBe(4_950);
    expect(cache.get('/f-4999', stamp())).toBe(4999);
    expect(cache.get('/f-0', stamp())).toBeUndefined();
  });

  it('clamps a non-finite capacity instead of accepting an unbounded cache', () => {
    expect(new FileDerivedCache<number>(Number.NaN).maxSize).toBe(4_000);
    expect(new FileDerivedCache<number>(0).maxSize).toBe(1);
  });

  it('re-inserting the same path replaces rather than duplicates', () => {
    const cache = new FileDerivedCache<string>(3);
    cache.set('/a', stamp(), 'one');
    cache.set('/a', stamp({ mtimeMs: 2, size: 2 }), 'two');
    expect(cache.size).toBe(1);
    expect(cache.get('/a', stamp({ mtimeMs: 2, size: 2 }))).toBe('two');
  });

  it('counts hits, misses and size', () => {
    const cache = new FileDerivedCache<string>(3);
    cache.set('/a', stamp(), 'a');
    cache.get('/a', stamp());
    cache.get('/a', stamp());
    cache.get('/missing', stamp());
    expect(cache.stats()).toMatchObject({
      hits: 2,
      misses: 1,
      size: 1,
      capacity: 3,
    });
  });

  it('clears and deletes explicitly', () => {
    const cache = new FileDerivedCache<string>(3);
    cache.set('/a', stamp(), 'a');
    cache.set('/b', stamp(), 'b');
    cache.delete('/a');
    expect(cache.size).toBe(1);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('compares stamps on every field', () => {
    expect(sameStamp(stamp(), stamp())).toBe(true);
    for (const change of [
      { mtimeMs: 1 },
      { ctimeMs: 1 },
      { size: 1 },
      { ino: 1 },
    ]) {
      expect(sameStamp(stamp(), stamp(change))).toBe(false);
    }
  });

  it('builds a stamp from every identity field of a stat result', () => {
    expect(
      stampFromStats({
        mtimeMs: 1,
        ctimeMs: 2,
        size: 3,
        ino: 4,
      } as unknown as Parameters<typeof stampFromStats>[0])
    ).toEqual({ mtimeMs: 1, ctimeMs: 2, size: 3, ino: 4 });
  });
});

describe('runWithConcurrency', () => {
  it('saturates the limit and never exceeds it', async () => {
    const items = Array.from({ length: 40 }, (_, i) => i);
    let inFlight = 0;
    let peak = 0;

    await runWithConcurrency(items, 5, async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, item % 3));
      inFlight -= 1;
      return item;
    });

    expect(peak).toBe(5);
  });

  it('returns results in input order regardless of completion order', async () => {
    const items = [5, 1, 4, 0, 3, 2];
    const results = await runWithConcurrency(items, 4, async (item) => {
      // Later items finish first, so completion order is reversed.
      await new Promise((resolve) => setTimeout(resolve, (5 - item) * 2));
      return `v${item}`;
    });
    expect(results).toEqual(['v5', 'v1', 'v4', 'v0', 'v3', 'v2']);
  });

  it('handles an empty input and a limit larger than the input', async () => {
    expect(await runWithConcurrency([], 8, async () => 1)).toEqual([]);
    expect(await runWithConcurrency([1, 2], 99, async (n) => n * 2)).toEqual([
      2, 4,
    ]);
  });

  it('clamps a non-positive or non-finite limit to one worker', async () => {
    for (const limit of [0, -3, Number.NaN]) {
      let peak = 0;
      let inFlight = 0;
      const results = await runWithConcurrency([1, 2, 3], limit, async (n) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return n;
      });
      expect(peak).toBe(1);
      expect(results).toEqual([1, 2, 3]);
    }
  });
});

describe('SingleFlight', () => {
  it('shares one in-flight run per key and releases it on settle', async () => {
    const flight = new SingleFlight<number>();
    let calls = 0;
    const work = async (): Promise<number> => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return calls;
    };

    const [a, b] = await Promise.all([
      flight.run('/x', work),
      flight.run('/x', work),
      flight.run('/y', work),
    ]);

    // Two distinct keys ran; the duplicate '/x' shared the first run.
    expect(calls).toBe(2);
    expect(a).toBe(b);
    expect(flight.size).toBe(0);

    // A later call re-runs rather than reusing a settled promise.
    await flight.run('/x', work);
    expect(calls).toBe(3);
  });

  it('releases the key when the shared run rejects', async () => {
    const flight = new SingleFlight<number>();
    await expect(
      flight.run('/x', async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(flight.size).toBe(0);
    await expect(flight.run('/x', async () => 42)).resolves.toBe(42);
  });
});
