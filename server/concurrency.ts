/**
 * Small async-concurrency primitives shared by the request-path scanners.
 *
 * Pattern: `semaphore` (bounded concurrency) from the battle-tested-patterns
 * catalog. The seam this exists for is the repo inventory scan
 * (`repo-inventory.ts`), which forks `git` once per repo per fact. Serially
 * that is O(repos x facts) round trips on the request path; unbounded it is a
 * fork storm that can exhaust file descriptors and starve the event loop on a
 * host with dozens of configured repos.
 *
 * The defining invariant is "never more than `limit` permits held at once",
 * enforced here and covered by `test/server/concurrency.test.ts`.
 */

/**
 * FIFO counting semaphore. `run` acquires one permit, awaits the task, and
 * releases the permit even when the task throws.
 *
 * Callers MUST NOT invoke `run` from inside a task that already holds a permit
 * from the same semaphore — that self-deadlocks once the limit is reached. The
 * repo scanners guard only the leaf `git` subprocess call for exactly this
 * reason.
 */
export class Semaphore {
  private readonly limit: number;
  private active = 0;
  private peak = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(limit: number) {
    this.limit = Math.max(1, Math.floor(limit));
  }

  /** Permits currently held. Test/observability hook only. */
  get inFlight(): number {
    return this.active;
  }

  /** Highest number of simultaneously held permits since construction. */
  get peakInFlight(): number {
    return this.peak;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      if (this.active > this.peak) this.peak = this.active;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.active += 1;
        if (this.active > this.peak) this.peak = this.active;
        resolve();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }
}

/**
 * Run every task, then surface the LOWEST-INDEX rejection.
 *
 * `Promise.all` rejects on whichever task loses the race, which would make the
 * error a repo inventory scan reports depend on subprocess timing. Settling
 * everything first keeps the reported failure deterministic (it is the same
 * repo the old serial loop would have failed on) and guarantees no task is
 * left as an unobserved rejection.
 */
export async function allOrFirstError<T>(
  tasks: ReadonlyArray<Promise<T>>
): Promise<T[]> {
  const settled = await Promise.allSettled(tasks);
  const failure = settled.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  );
  if (failure) throw failure.reason;
  return settled.map((result) => (result as PromiseFulfilledResult<T>).value);
}
