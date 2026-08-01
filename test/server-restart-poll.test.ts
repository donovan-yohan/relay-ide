import { afterEach, expect, test, vi } from 'vitest';
import {
  SERVER_RESTART_GRACE_MS,
  SERVER_RESTART_LIVENESS_CONFIRMATIONS,
  SERVER_RESTART_POLL_INTERVAL_MS,
  SERVER_RESTART_TIMEOUT_MS,
  SERVER_RESTART_TIMEOUT_TEXT,
  probeServerRestart,
  reloadWhenServerReturns,
  waitForServerRestart,
  type ServerRestartProbeResult,
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

/** A probe that walks a scripted sequence, repeating its last result. */
function scriptedProbe(results: ServerRestartProbeResult[]) {
  let index = 0;
  return vi.fn(async () => {
    const result = results[Math.min(index, results.length - 1)];
    index += 1;
    return result as ServerRestartProbeResult;
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test('waitForServerRestart waits out the pre-exit grace before the first probe', async () => {
  const clock = fakeClock();
  const probedAt: number[] = [];
  const probe = vi.fn(async (): Promise<ServerRestartProbeResult> => {
    probedAt.push(clock.now());
    return 'new';
  });

  await expect(
    waitForServerRestart({ probe, sleep: clock.sleep, now: clock.now })
  ).resolves.toBe(true);

  // Probing immediately would hit the server still finishing its shutdown and
  // reload the page into the outgoing process.
  expect(probedAt).toEqual([SERVER_RESTART_GRACE_MS]);
  expect(probe).toHaveBeenCalledTimes(1);
});

test('waitForServerRestart accepts a boot-id change as proof on the first probe', async () => {
  const clock = fakeClock();
  const probe = scriptedProbe(['down', 'new']);

  await expect(
    waitForServerRestart({ probe, sleep: clock.sleep, now: clock.now })
  ).resolves.toBe(true);

  // `new` is identity, not evidence: no confirmation round is required.
  expect(probe).toHaveBeenCalledTimes(2);
});

test('waitForServerRestart needs consecutive liveness answers without a boot id', async () => {
  const clock = fakeClock();
  const probe = scriptedProbe(['alive', 'alive']);

  await expect(
    waitForServerRestart({ probe, sleep: clock.sleep, now: clock.now })
  ).resolves.toBe(true);

  expect(SERVER_RESTART_LIVENESS_CONFIRMATIONS).toBe(2);
  expect(probe).toHaveBeenCalledTimes(2);
});

test('waitForServerRestart restarts the confirmation streak when the server drops', async () => {
  const clock = fakeClock();
  // The outgoing process answering once, then dying, must not read as a
  // restart — one 200 is not evidence the new server is up.
  const probe = scriptedProbe(['alive', 'down', 'alive', 'alive']);

  await expect(
    waitForServerRestart({ probe, sleep: clock.sleep, now: clock.now })
  ).resolves.toBe(true);

  expect(probe).toHaveBeenCalledTimes(4);
});

test('waitForServerRestart polls on the interval until the server answers', async () => {
  const clock = fakeClock();
  const probedAt: number[] = [];
  const probe = vi.fn(async (): Promise<ServerRestartProbeResult> => {
    probedAt.push(clock.now());
    return probedAt.length === 4 ? 'new' : 'down';
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

test('the grace window outlasts the server exit budget it covers', () => {
  // server/index.ts: 500ms broadcast delay, then close, with a hard 3000ms
  // fallback exit — and this clock starts at response receipt, later still.
  expect(SERVER_RESTART_GRACE_MS).toBeGreaterThan(500 + 3000);
});

test('waitForServerRestart gives up at the timeout instead of polling forever', async () => {
  const clock = fakeClock();
  const probe = scriptedProbe(['down']);

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
  const probe = scriptedProbe(['down']);

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

test('waitForServerRestart stops when the caller aborts', async () => {
  const clock = fakeClock();
  const controller = new AbortController();
  const probe = vi.fn(async (): Promise<ServerRestartProbeResult> => {
    controller.abort();
    return 'down';
  });

  await expect(
    waitForServerRestart({
      probe,
      sleep: clock.sleep,
      now: clock.now,
      signal: controller.signal,
    })
  ).resolves.toBe(false);

  // One probe ran, then the abort ended the wait instead of burning the budget.
  expect(probe).toHaveBeenCalledTimes(1);
});

test('reloadWhenServerReturns reloads once the server answers', async () => {
  const clock = fakeClock();
  const reload = vi.fn();
  const onTimeout = vi.fn();

  await reloadWhenServerReturns(onTimeout, {
    probe: async () => 'new',
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
    probe: async () => 'down',
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

test('reloadWhenServerReturns neither reloads nor reports after an abort', async () => {
  const clock = fakeClock();
  const reload = vi.fn();
  const onTimeout = vi.fn();
  const controller = new AbortController();

  await reloadWhenServerReturns(onTimeout, {
    probe: async () => {
      controller.abort();
      return 'new';
    },
    sleep: clock.sleep,
    now: clock.now,
    reload,
    signal: controller.signal,
  });

  // A dismissed toast must not navigate the page or set state on a dead tree.
  expect(reload).not.toHaveBeenCalled();
  expect(onTimeout).not.toHaveBeenCalled();
});

function stubHealthz(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      status,
      json: async () => body,
    }))
  );
}

test('probeServerRestart reports the outgoing process as down, not alive', async () => {
  stubHealthz(200, { status: 'ok', bootId: 'boot-old' });
  await expect(probeServerRestart('boot-old')).resolves.toBe('down');

  stubHealthz(200, { status: 'ok', bootId: 'boot-new' });
  await expect(probeServerRestart('boot-old')).resolves.toBe('new');
});

test('probeServerRestart falls back to liveness without a comparable boot id', async () => {
  stubHealthz(200, { status: 'ok', bootId: 'boot-new' });
  await expect(probeServerRestart(null)).resolves.toBe('alive');

  // A server old enough to lack `bootId` still counts as alive, and 503 is a
  // degraded store or event loop — an answer from Relay either way.
  stubHealthz(503, { status: 'degraded' });
  await expect(probeServerRestart('boot-old')).resolves.toBe('alive');
});

test('probeServerRestart treats proxy errors and transport failures as down', async () => {
  stubHealthz(502, 'Bad Gateway');
  await expect(probeServerRestart('boot-old')).resolves.toBe('down');

  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    })
  );
  await expect(probeServerRestart('boot-old')).resolves.toBe('down');
});
