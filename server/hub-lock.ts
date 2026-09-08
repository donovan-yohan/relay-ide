import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type HubLockRecord = {
  pid: number;
  port: number | null;
  host: string | null;
  startedAt: string;
  hostname: string;
};

export class HubConfigDirLockedError extends Error {
  readonly configDir: string;
  readonly lockPath: string;
  readonly owner: HubLockRecord;

  constructor(configDir: string, owner: HubLockRecord) {
    const lockPath = hubLockPath(configDir);
    super(
      [
        `Refusing to open Relay hub config dir because it is owned by a live hub: ${configDir}`,
        `hub.lock: ${lockPath}`,
        `owner: pid=${owner.pid} host=${owner.host ?? 'unknown'} port=${owner.port ?? 'unknown'} hostname=${owner.hostname} startedAt=${owner.startedAt}`,
        `Stop the owning hub or pass an isolated config path via --config /path/to/config.json. (#1587)`,
      ].join('\n')
    );
    this.name = 'HubConfigDirLockedError';
    this.configDir = configDir;
    this.lockPath = lockPath;
    this.owner = owner;
  }
}

export function hubLockPath(configDir: string): string {
  return path.join(configDir, 'hub.lock');
}

function isPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    // EPERM means the process exists but we lack permission to signal it.
    if (e?.code === 'EPERM') return true;
    return false;
  }
}

export function readHubLock(configDir: string): HubLockRecord | null {
  const lockPath = hubLockPath(configDir);
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<HubLockRecord>;
    if (
      typeof parsed.pid !== 'number' ||
      !Number.isFinite(parsed.pid) ||
      typeof parsed.startedAt !== 'string' ||
      typeof parsed.hostname !== 'string'
    ) {
      return null;
    }
    return {
      pid: parsed.pid,
      port:
        typeof parsed.port === 'number' && Number.isFinite(parsed.port)
          ? parsed.port
          : null,
      host: typeof parsed.host === 'string' ? parsed.host : null,
      startedAt: parsed.startedAt,
      hostname: parsed.hostname,
    };
  } catch {
    return null;
  }
}

export function assertConfigDirNotOwnedByAnotherLiveHub(
  configDir: string
): void {
  const lock = readHubLock(configDir);
  if (!lock) return;
  if (lock.pid === process.pid) return;
  // Foreign-host locks must still block in the synchronous guard: store opens
  // have no liveness probe fallback, so treating these as "absent" would allow
  // accidental config-dir DB opens against a live hub (#1587).
  if (lock.hostname !== os.hostname()) {
    throw new HubConfigDirLockedError(configDir, lock);
  }
  if (!isPidAlive(lock.pid)) return;
  throw new HubConfigDirLockedError(configDir, lock);
}

type HubLivenessProbeConfig = {
  /** Path to config.json inside the candidate configDir. */
  configPath: string;
  /** Abort the probe after this many ms. */
  timeoutMs: number;
  /**
   * Effective port this process intends to use (flag > env > config > default).
   *
   * Preferred over the value in config.json so flag/env overrides are respected
   * (and so we can probe the port a deployed hub may be bound to even if its
   * config.json is stale). (#1587)
   */
  fallbackPort?: number | undefined;
};

function readConfiguredPort(configPath: string): {
  port: number;
  fromConfig: boolean;
} {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      port?: unknown;
    };
    const port = parsed?.port;
    if (typeof port === 'number' && Number.isFinite(port)) {
      return { port, fromConfig: true };
    }
    return { port: 3456, fromConfig: false };
  } catch {
    return { port: 3456, fromConfig: false };
  }
}

export async function probeLiveHubHealth(
  configDir: string,
  opts: HubLivenessProbeConfig
): Promise<{ port: number } | null> {
  // #1587: upgrade window safety. Older hubs don't write hub.lock yet, so the
  // lock check alone cannot prevent accidental store opens. If no lock exists,
  // probe the configured port's /health endpoint and refuse if a hub answers.
  const lock = readHubLock(configDir);
  // Skip the probe only when the lock looks live. A stale lock must not disable
  // the liveness fallback forever (#1587 review).
  if (lock && lock.hostname === os.hostname() && isPidAlive(lock.pid)) {
    return null;
  }

  const configured = readConfiguredPort(opts.configPath);
  const port = opts.fallbackPort ?? configured.port;
  const url = `http://127.0.0.1:${port}/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
    });
    if (res.ok) return { port };
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function describeHubLockAbsence(configDir: string): string {
  const lock = readHubLock(configDir);
  if (!lock) return 'no hub.lock present';
  if (lock.hostname !== os.hostname()) {
    return `foreign-host hub.lock (hostname=${lock.hostname})`;
  }
  if (!isPidAlive(lock.pid)) {
    return `stale hub.lock (pid=${lock.pid} not alive)`;
  }
  return 'hub.lock present';
}

export async function assertConfigDirNotOwnedByAnotherLiveHubOrListeningHub(
  configDir: string,
  opts: HubLivenessProbeConfig
): Promise<void> {
  assertConfigDirNotOwnedByAnotherLiveHub(configDir);
  const live = await probeLiveHubHealth(configDir, opts);
  if (!live) return;
  throw new Error(
    [
      `Refusing to open Relay hub config dir: a hub is listening on :${live.port} (${describeHubLockAbsence(configDir)}).`,
      `configDir: ${configDir}`,
      `health: http://127.0.0.1:${live.port}/health`,
      `Pass an isolated config path via --config /path/to/config.json. (#1587)`,
    ].join('\n')
  );
}

function writeHubLockSync(configDir: string, record: HubLockRecord): void {
  const lockPath = hubLockPath(configDir);
  const tmp = lockPath + `.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, lockPath);
}

export function acquireHubLockOrThrow(
  configDir: string,
  record: Omit<HubLockRecord, 'pid' | 'hostname' | 'startedAt'> & {
    pid?: number | undefined;
    hostname?: string | undefined;
    startedAt?: string | undefined;
  } = { port: null, host: null }
): HubLockRecord {
  fs.mkdirSync(configDir, { recursive: true });
  const lockPath = hubLockPath(configDir);
  const existing = readHubLock(configDir);
  if (
    existing &&
    existing.hostname === os.hostname() &&
    isPidAlive(existing.pid)
  ) {
    if (existing.pid !== process.pid) {
      throw new HubConfigDirLockedError(configDir, existing);
    }
  } else if (existing) {
    // Stale lock: best-effort remove so an atomic create can succeed.
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* best effort */
    }
  }
  const resolved: HubLockRecord = {
    pid: record.pid ?? process.pid,
    port: record.port ?? null,
    host: record.host ?? null,
    startedAt: record.startedAt ?? new Date().toISOString(),
    hostname: record.hostname ?? os.hostname(),
  };
  const payload = JSON.stringify(resolved, null, 2) + '\n';
  try {
    fs.writeFileSync(lockPath, payload, { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code !== 'EEXIST') throw err;
    // Somebody else created the lock concurrently. Re-read and refuse.
    const raced = readHubLock(configDir);
    if (
      raced &&
      raced.hostname === os.hostname() &&
      isPidAlive(raced.pid) &&
      raced.pid !== process.pid
    ) {
      throw new HubConfigDirLockedError(configDir, raced);
    }
    // If it's stale/garbled, try one more unlink + exclusive create.
    try {
      fs.unlinkSync(lockPath);
      fs.writeFileSync(lockPath, payload, { encoding: 'utf8', flag: 'wx' });
    } catch {
      // Fall back to the stronger refusal message.
      const final = readHubLock(configDir);
      if (final) throw new HubConfigDirLockedError(configDir, final);
      throw err;
    }
  }
  return resolved;
}

export function updateHubLockBestEffort(
  configDir: string,
  patch: Partial<Omit<HubLockRecord, 'pid' | 'hostname' | 'startedAt'>> & {
    expectedPid?: number | undefined;
  }
): void {
  const current = readHubLock(configDir);
  if (!current) return;
  const expectedPid = patch.expectedPid ?? process.pid;
  if (current.pid !== expectedPid) return;
  try {
    writeHubLockSync(configDir, {
      ...current,
      ...(patch.port !== undefined ? { port: patch.port } : {}),
      ...(patch.host !== undefined ? { host: patch.host } : {}),
    });
  } catch {
    /* best effort */
  }
}

export function releaseHubLockBestEffort(
  configDir: string,
  expectedPid: number = process.pid
): void {
  const lockPath = hubLockPath(configDir);
  const current = readHubLock(configDir);
  if (!current || current.pid !== expectedPid) return;
  try {
    fs.unlinkSync(lockPath);
  } catch {
    /* best effort */
  }
}
