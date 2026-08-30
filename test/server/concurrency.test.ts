import { describe, expect, it } from 'vitest';

import { Semaphore, allOrFirstError } from '../../server/concurrency.js';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('Semaphore', () => {
  it('never runs more than `limit` tasks at once (defining invariant)', async () => {
    const gate = new Semaphore(3);
    let active = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 25 }, () =>
        gate.run(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 1));
          active -= 1;
        })
      )
    );

    expect(peak).toBeLessThanOrEqual(3);
    // Sanity: the bound is actually being exercised, not trivially satisfied.
    expect(peak).toBeGreaterThan(1);
    expect(gate.peakInFlight).toBeLessThanOrEqual(3);
    expect(gate.inFlight).toBe(0);
  });

  it('releases the permit when a task throws', async () => {
    const gate = new Semaphore(1);
    await expect(
      gate.run(async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(gate.inFlight).toBe(0);
    await expect(gate.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('admits waiters in FIFO order as permits free up', async () => {
    const gate = new Semaphore(1);
    const order: number[] = [];
    const first = deferred<void>();

    const running = gate.run(async () => {
      order.push(0);
      await first.promise;
    });
    const queued = [1, 2, 3].map((n) =>
      gate.run(async () => {
        order.push(n);
      })
    );

    first.resolve();
    await Promise.all([running, ...queued]);
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it('coerces a non-positive limit to 1 rather than deadlocking', async () => {
    const gate = new Semaphore(0);
    await expect(gate.run(async () => 'ok')).resolves.toBe('ok');
  });
});

describe('allOrFirstError', () => {
  it('preserves input order for fulfilled tasks', async () => {
    const values = await allOrFirstError([
      new Promise<number>((resolve) => setTimeout(() => resolve(1), 5)),
      Promise.resolve(2),
      Promise.resolve(3),
    ]);
    expect(values).toEqual([1, 2, 3]);
  });

  it('throws the LOWEST-INDEX rejection, not the fastest one', async () => {
    const slowFirst = new Promise<number>((_resolve, reject) =>
      setTimeout(() => reject(new Error('index-0')), 10)
    );
    const fastLater = Promise.reject(new Error('index-2'));
    await expect(
      allOrFirstError([slowFirst, Promise.resolve(1), fastLater])
    ).rejects.toThrow('index-0');
  });

  it('observes every rejection so none surfaces as an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(
        allOrFirstError([
          Promise.reject(new Error('a')),
          Promise.reject(new Error('b')),
        ])
      ).rejects.toThrow('a');
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});
