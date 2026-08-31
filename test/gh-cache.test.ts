import { describe, it, expect, beforeEach } from 'vitest';

import {
  batchGetPrsForRepo,
  clearBatchPrCache,
  clearCiStatusCache,
  getCiStatus,
} from '../server/gh.js';

type ExecFn = (
  file: string,
  args: string[],
  options: { cwd: string; timeout?: number }
) => Promise<{ stdout: string; stderr: string }>;

const prList = JSON.stringify([
  {
    number: 42,
    title: 'Cache me',
    url: 'https://github.com/o/r/pull/42',
    state: 'OPEN',
    headRefName: 'feat/cache',
    baseRefName: 'nightly',
    isDraft: false,
    reviewDecision: null,
    additions: 1,
    deletions: 0,
    mergeable: 'MERGEABLE',
    updatedAt: '2026-01-01T00:00:00Z',
  },
]);

const checks = JSON.stringify([
  { name: 'build', state: 'COMPLETED', conclusion: 'SUCCESS' },
]);

beforeEach(() => {
  clearBatchPrCache();
  clearCiStatusCache();
});

describe('batchGetPrsForRepo cache', () => {
  it('returns a cached result within the ttl without spawning gh again', async () => {
    let calls = 0;
    const exec: ExecFn = async () => {
      calls += 1;
      return { stdout: prList, stderr: '' };
    };

    const first = await batchGetPrsForRepo('/repos/one', { exec });
    const second = await batchGetPrsForRepo('/repos/one', { exec });

    expect(first.get('feat/cache')?.number).toBe(42);
    expect(second.get('feat/cache')?.number).toBe(42);
    expect(calls).toBe(1);
  });

  it('deduplicates concurrent calls for the same repo path', async () => {
    let calls = 0;
    // Held in an object so the assignment inside the promise executor is
    // visible to control-flow analysis at the call sites below.
    const pending: {
      resolveExec: ((value: { stdout: string; stderr: string }) => void) | null;
    } = { resolveExec: null };
    const exec: ExecFn = async () => {
      calls += 1;
      return new Promise((resolve) => {
        pending.resolveExec = resolve;
      });
    };

    const first = batchGetPrsForRepo('/repos/one', { exec });
    const second = batchGetPrsForRepo('/repos/one', { exec });

    expect(calls).toBe(1);
    pending.resolveExec?.({ stdout: prList, stderr: '' });

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.get('feat/cache')?.number).toBe(42);
    expect(secondResult.get('feat/cache')?.number).toBe(42);
    expect(calls).toBe(1);
  });

  it('misses after repo invalidation', async () => {
    let calls = 0;
    const exec: ExecFn = async () => {
      calls += 1;
      return { stdout: prList, stderr: '' };
    };

    await batchGetPrsForRepo('/repos/one', { exec });
    clearBatchPrCache('/repos/one');
    await batchGetPrsForRepo('/repos/one', { exec });

    expect(calls).toBe(2);
  });

  it('does not let an invalidated in-flight lookup repopulate the cache', async () => {
    let calls = 0;
    // Held in an object so the assignment inside the promise executor is
    // visible to control-flow analysis at the call sites below.
    const pending: {
      resolveExec: ((value: { stdout: string; stderr: string }) => void) | null;
    } = { resolveExec: null };
    const exec: ExecFn = async () => {
      calls += 1;
      return new Promise((resolve) => {
        pending.resolveExec = resolve;
      });
    };

    const first = batchGetPrsForRepo('/repos/one', { exec });
    clearBatchPrCache('/repos/one');
    pending.resolveExec?.({ stdout: prList, stderr: '' });
    await first;

    const second = batchGetPrsForRepo('/repos/one', { exec });
    pending.resolveExec?.({ stdout: prList, stderr: '' });
    await second;

    expect(calls).toBe(2);
  });

  it('keeps a newer in-flight lookup after an invalidated older lookup settles', async () => {
    let calls = 0;
    const resolvers: Array<
      (value: { stdout: string; stderr: string }) => void
    > = [];
    const exec: ExecFn = async () => {
      calls += 1;
      return new Promise((resolve) => {
        resolvers.push(resolve);
      });
    };

    const first = batchGetPrsForRepo('/repos/one', { exec });
    clearBatchPrCache('/repos/one');
    const second = batchGetPrsForRepo('/repos/one', { exec });

    expect(calls).toBe(2);
    resolvers[0]?.({ stdout: prList, stderr: '' });
    await first;

    const third = batchGetPrsForRepo('/repos/one', { exec });
    expect(calls).toBe(2);

    resolvers[1]?.({ stdout: prList, stderr: '' });
    await expect(Promise.all([second, third])).resolves.toHaveLength(2);
    expect(calls).toBe(2);
  });
});

describe('getCiStatus cache', () => {
  it('returns a cached status within the ttl without spawning gh again', async () => {
    let calls = 0;
    const exec: ExecFn = async () => {
      calls += 1;
      return { stdout: checks, stderr: '' };
    };

    const first = await getCiStatus('/repos/one', 'feat/cache', { exec });
    const second = await getCiStatus('/repos/one', 'feat/cache', { exec });

    expect(first).toEqual({ total: 1, passing: 1, failing: 0, pending: 0 });
    expect(second).toEqual(first);
    expect(calls).toBe(1);
  });

  it('deduplicates concurrent calls for the same repo path and branch', async () => {
    let calls = 0;
    // Held in an object so the assignment inside the promise executor is
    // visible to control-flow analysis at the call sites below.
    const pending: {
      resolveExec: ((value: { stdout: string; stderr: string }) => void) | null;
    } = { resolveExec: null };
    const exec: ExecFn = async () => {
      calls += 1;
      return new Promise((resolve) => {
        pending.resolveExec = resolve;
      });
    };

    const first = getCiStatus('/repos/one', 'feat/cache', { exec });
    const second = getCiStatus('/repos/one', 'feat/cache', { exec });

    expect(calls).toBe(1);
    pending.resolveExec?.({ stdout: checks, stderr: '' });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { total: 1, passing: 1, failing: 0, pending: 0 },
      { total: 1, passing: 1, failing: 0, pending: 0 },
    ]);
    expect(calls).toBe(1);
  });

  it('misses after repo invalidation', async () => {
    let calls = 0;
    const exec: ExecFn = async () => {
      calls += 1;
      return { stdout: checks, stderr: '' };
    };

    await getCiStatus('/repos/one', 'feat/cache', { exec });
    clearCiStatusCache('/repos/one');
    await getCiStatus('/repos/one', 'feat/cache', { exec });

    expect(calls).toBe(2);
  });

  it('keeps a newer in-flight lookup after an invalidated older lookup settles', async () => {
    let calls = 0;
    const resolvers: Array<
      (value: { stdout: string; stderr: string }) => void
    > = [];
    const exec: ExecFn = async () => {
      calls += 1;
      return new Promise((resolve) => {
        resolvers.push(resolve);
      });
    };

    const first = getCiStatus('/repos/one', 'feat/cache', { exec });
    clearCiStatusCache('/repos/one');
    const second = getCiStatus('/repos/one', 'feat/cache', { exec });

    expect(calls).toBe(2);
    resolvers[0]?.({ stdout: checks, stderr: '' });
    await first;

    const third = getCiStatus('/repos/one', 'feat/cache', { exec });
    expect(calls).toBe(2);

    resolvers[1]?.({ stdout: checks, stderr: '' });
    await expect(Promise.all([second, third])).resolves.toHaveLength(2);
    expect(calls).toBe(2);
  });
});
