/**
 * Wait for a restarting server to come back, instead of reloading on a fixed
 * timer. A fixed timer reloads into whatever is there at that instant — too
 * early on a slow host (browser error page), needlessly late on a fast one.
 */

/** Poll cadence once the pre-exit grace window has passed. */
export const SERVER_RESTART_POLL_INTERVAL_MS = 2000;

/** Total budget, grace window included, before giving up on the reload. */
export const SERVER_RESTART_TIMEOUT_MS = 90_000;

/**
 * The server answers `POST /update` *before* it exits: it waits ~500ms for the
 * `server-restarting` broadcast to reach clients, then closes, with a hard
 * fallback exit 3s later. Probing inside that window would find the outgoing
 * process and reload straight into the shutdown.
 */
export const SERVER_RESTART_GRACE_MS = 4000;

/** Shown when the poll budget runs out with the server still unreachable. */
export const SERVER_RESTART_TIMEOUT_TEXT =
  'Server is taking longer than expected — reload manually.';

export interface WaitForServerRestartOptions {
  /** Resolves true when the server answers again. Defaults to a `/healthz` probe. */
  probe?: () => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  graceMs?: number;
  intervalMs?: number;
  timeoutMs?: number;
}

/**
 * Liveness probe. Any answer from Relay's own health monitor means the process
 * is listening again — including 503, which reports a degraded store or event
 * loop, not a dead server. A proxy's 502/504 is not an answer from Relay, so
 * only the two statuses the monitor itself returns count.
 */
async function probeHealthz(): Promise<boolean> {
  try {
    const res = await fetch('/healthz', { cache: 'no-store' });
    return res.status === 200 || res.status === 503;
  } catch {
    return false;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Poll until the server answers or the budget is spent.
 * Returns true when it came back (caller reloads), false on timeout.
 */
export async function waitForServerRestart(
  options: WaitForServerRestartOptions = {}
): Promise<boolean> {
  const probe = options.probe ?? probeHealthz;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  const graceMs = options.graceMs ?? SERVER_RESTART_GRACE_MS;
  const intervalMs = options.intervalMs ?? SERVER_RESTART_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? SERVER_RESTART_TIMEOUT_MS;

  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  await sleep(Math.min(graceMs, timeoutMs));

  // The grace window is part of the budget, so a caller passing a timeout
  // shorter than the grace still gets exactly one probe rather than none: the
  // deadline is only consulted after a probe has run.
  for (;;) {
    if (await probe()) return true;
    if (now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

/** Wait for the server, then reload — or hand back the timeout copy. */
export async function reloadWhenServerReturns(
  onTimeout: (text: string) => void,
  options: WaitForServerRestartOptions & { reload?: () => void } = {}
): Promise<void> {
  const reload = options.reload ?? (() => window.location.reload());
  const returned = await waitForServerRestart(options);
  if (returned) {
    reload();
    return;
  }
  onTimeout(SERVER_RESTART_TIMEOUT_TEXT);
}
