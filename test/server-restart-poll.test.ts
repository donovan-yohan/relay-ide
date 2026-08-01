import { expect, test, vi } from 'vitest';
import {
  SERVER_RESTART_GRACE_MS,
  SERVER_RESTART_POLL_INTERVAL_MS,
  SERVER_RESTART_TIMEOUT_MS,
  SERVER_RESTART_TIMEOUT_TEXT,
  reloadWhenServerReturns,
  waitForServerRestart,
} from '../frontend/src/lib/server-restart.js';

/**
 * Virtual clock: `sleep` advances it instead of waiting, so a 90s poll budget
 * runs in microseconds and every assertion is about the schedule, not timing
 * luck.
 */
function fakeClock() {
  let current = 0;
  const sleeps: number[] = [];
  return {
    now: () => current,
    sleeps,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      current += ms;
    },
  };
}

test('waitForServerRestart waits out the pre-exit grace before the first probe', async () => {
  const clock = fakeClock();
  const probedAt: number[] = [];
  const probe = vi.fn(async () => {
    probedAt.push(clock.now());
    return true;
  });

  await expect(
    waitForServerRestart({ probe, sleep: clock.sleep, now: clock.now })
  ).resolves.toBe(true);

  // Probing immediately would hit the server still finishing its shutdown and
  // reload the page into the outgoing process.
  expect(probedAt).toEqual([SERVER_RESTART_GRACE_MS]);
  expect(probe).toHaveBeenCalledTimes(1);
});

test('waitForServerRestart polls on the interval until the server answers', async () => {
  const clock = fakeClock();
  const probedAt: number[] = [];
  const probe = vi.fn(async () => {
    probedAt.push(clock.now());
    return probedAt.length === 4;
  });

  await expect(
    waitForServerRestart({ probe, sleep: clock.sleep, now: clock.now })
  ).resolves.toBe(true);

  expect(probedAt).toEqual([
    SERVER_RESTART_GRACE_MS,
    SERVER_RESTART_GRACE_MS + SERVER_RESTART_POLL_INTERVAL_MS,
    SERVER_RESTART_GRACE_MS + SERVER_RESTART_POLL_INTERVAL_MS * 2,
    SERVER_RESTART_GRACE_MS + SERVER_RESTART_POLL_INTERVAL_MS * 3,
  ]);
});

test('waitForServerRestart gives up at the timeout instead of polling forever', async () => {
  const clock = fakeClock();
  const probe = vi.fn(async () => false);

  await expect(
    waitForServerRestart({ probe, sleep: clock.sleep, now: clock.now })
  ).resolves.toBe(false);

  expect(clock.now()).toBeGreaterThanOrEqual(SERVER_RESTART_TIMEOUT_MS);
  const expectedProbes =
    1 +
    Math.ceil(
      (SERVER_RESTART_TIMEOUT_MS - SERVER_RESTART_GRACE_MS) /
        SERVER_RESTART_POLL_INTERVAL_MS
    );
  expect(probe).toHaveBeenCalledTimes(expectedProbes);
});

test('waitForServerRestart still probes once when the budget is shorter than the grace', async () => {
  const clock = fakeClock();
  const probe = vi.fn(async () => false);

  await expect(
    waitForServerRestart({
      probe,
      sleep: clock.sleep,
      now: clock.now,
      timeoutMs: 1000,
    })
  ).resolves.toBe(false);

  expect(probe).toHaveBeenCalledTimes(1);
  expect(clock.sleeps).toEqual([1000]);
});

test('reloadWhenServerReturns reloads once the server answers', async () => {
  const clock = fakeClock();
  const reload = vi.fn();
  const onTimeout = vi.fn();

  await reloadWhenServerReturns(onTimeout, {
    probe: async () => true,
    sleep: clock.sleep,
    now: clock.now,
    reload,
  });

  expect(reload).toHaveBeenCalledTimes(1);
  expect(onTimeout).not.toHaveBeenCalled();
});

test('reloadWhenServerReturns hands back the manual-reload copy on timeout', async () => {
  const clock = fakeClock();
  const reload = vi.fn();
  const onTimeout = vi.fn();

  await reloadWhenServerReturns(onTimeout, {
    probe: async () => false,
    sleep: clock.sleep,
    now: clock.now,
    reload,
  });

  expect(reload).not.toHaveBeenCalled();
  expect(onTimeout).toHaveBeenCalledWith(SERVER_RESTART_TIMEOUT_TEXT);
  expect(SERVER_RESTART_TIMEOUT_TEXT).toBe(
    'Server is taking longer than expected — reload manually.'
  );
});
