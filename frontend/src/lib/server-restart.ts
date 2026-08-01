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
 * fallback exit 3s later — so the outgoing process can still be listening
 * ~3.5s after the response is written, and this clock starts later still, at
 * response *receipt*. The margin over that budget covers timers slipping on a
 * loaded host; boot-id identity below covers the rest.
 */
export const SERVER_RESTART_GRACE_MS = 6000;

/**
 * Successful liveness probes required when the server cannot be identified by
 * boot id. One 200 proves only "something answered", which the outgoing
 * process still does mid-shutdown; two in a row across a poll interval do not
 * survive it.
 */
export const SERVER_RESTART_LIVENESS_CONFIRMATIONS = 2;

/** Shown when the poll budget runs out with the server still unreachable. */
export const SERVER_RESTART_TIMEOUT_TEXT =
  'Server is taking longer than expected — reload manually.';

/**
 * - `new` — a different process answered (boot id changed): proof, reload now.
 * - `alive` — something answered but could not be identified.
 * - `down` — no answer, or the *same* process that served `POST /update`.
 */
export type ServerRestartProbeResult = 'new' | 'alive' | 'down';

export interface WaitForServerRestartOptions {
  /** Defaults to a `/healthz` probe. */
  probe?: () => Promise<ServerRestartProbeResult>;
  /**
   * `bootId` from the `POST /update` response, i.e. the process that is going
   * away. Any other boot id is the restarted server.
   */
  previousBootId?: string | null;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  graceMs?: number;
  intervalMs?: number;
  timeoutMs?: number;
  /** Consecutive `alive` results accepted as a restart when no boot id is known. */
  confirmations?: number;
  /** Aborts the wait (component unmounted, toast dismissed). */
  signal?: AbortSignal;
}

/**
 * Liveness plus identity. Any answer from Relay's own health monitor means the
 * process is listening — including 503, which reports a degraded store or event
 * loop, not a dead server. A proxy's 502/504 is not an answer from Relay, so
 * only the two statuses the monitor itself returns count.
 *
 * `/healthz` also carries the per-process `bootId`, so an answer from the
 * process that is still shutting down is reported as `down` rather than
 * mistaken for the restarted server.
 */
export async function probeServerRestart(
  previousBootId?: string | null
): Promise<ServerRestartProbeResult> {
  try {
    const res = await fetch('/healthz', { cache: 'no-store' });
    if (res.status !== 200 && res.status !== 503) return 'down';
    if (!previousBootId) return 'alive';
    let bootId: string | null = null;
    try {
      const body = (await res.json()) as { bootId?: unknown };
      bootId = typeof body.bootId === 'string' ? body.bootId : null;
    } catch {
      bootId = null;
    }
    // An older server without `bootId` falls back to liveness confirmations.
    if (bootId === null) return 'alive';
    return bootId === previousBootId ? 'down' : 'new';
  } catch {
    return 'down';
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Poll until the server answers or the budget is spent.
 * Returns true when it came back (caller reloads), false on timeout or abort.
 */
export async function waitForServerRestart(
  options: WaitForServerRestartOptions = {}
): Promise<boolean> {
  const previousBootId = options.previousBootId ?? null;
  const probe = options.probe ?? (() => probeServerRestart(previousBootId));
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  const graceMs = options.graceMs ?? SERVER_RESTART_GRACE_MS;
  const intervalMs = options.intervalMs ?? SERVER_RESTART_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? SERVER_RESTART_TIMEOUT_MS;
  const confirmations =
    options.confirmations ?? SERVER_RESTART_LIVENESS_CONFIRMATIONS;
  const signal = options.signal;

  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  await sleep(Math.min(graceMs, timeoutMs));

  // The grace window is part of the budget, so a caller passing a timeout
  // shorter than the grace still gets exactly one probe rather than none: the
  // deadline is only consulted after a probe has run.
  let streak = 0;
  for (;;) {
    if (signal?.aborted) return false;
    const result = await probe();
    // A boot-id change is proof, not evidence: no confirmation run needed.
    if (result === 'new') return true;
    streak = result === 'alive' ? streak + 1 : 0;
    if (streak >= confirmations) return true;
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
  // An aborted wait belongs to a dismissed toast or an unmounted dialog:
  // neither reload the page nor write state back into a dead tree.
  if (options.signal?.aborted) return;
  if (returned) {
    reload();
    return;
  }
  onTimeout(SERVER_RESTART_TIMEOUT_TEXT);
}
