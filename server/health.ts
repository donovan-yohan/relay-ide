import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import type { RequestHandler } from 'express';
import { createLogger, type Logger } from './logger.js';

/**
 * Identity of *this* process, minted once at module load.
 *
 * `/healthz` answers liveness, which is not enough for a client waiting out a
 * restart: the outgoing process keeps listening for up to ~3.5s after it
 * answers `POST /update`, and every version field it can report is read from
 * the install root that the update just overwrote. A boot id changes only when
 * the process does, so a client that captured the pre-update id can tell the
 * new server from the old one instead of guessing with a timer.
 */
export const PROCESS_BOOT_ID = randomUUID();

export const DEFAULT_EVENT_LOOP_LAG_THRESHOLD_MS = 2_000;
export const DEFAULT_EVENT_LOOP_PROBE_INTERVAL_MS = 1_000;
export const DEFAULT_MEMORY_LOG_INTERVAL_MS = 60_000;

export interface HealthMemorySnapshot {
  rss: number;
  heapUsed: number;
  external: number;
}

/** Aggregate-only process accounting; intentionally excludes ids and commands. */
export interface HealthResourceSummary {
  runtimeCount: number;
  runtimeWithOwnedProcesses: number;
  processCount: number;
  totalRssBytes: number;
}

export interface HealthCgroupMemory {
  currentBytes: number;
  maxBytes?: number;
}

/**
 * Progress for work that begins only after the HTTP listener is available.
 * Health reports this informationally; it never changes the health status.
 */
export interface ResumeReadiness {
  inProgress: boolean;
  complete: boolean;
  restored: number;
  failed: boolean;
}

export interface HealthMonitor {
  handler: RequestHandler;
  getLagMs(): number;
  stop(): void;
}

export interface HealthMonitorOptions {
  /** Finalized disabled persistence stores for this hub process, if any. */
  disabledStores?: readonly string[];
  lagThresholdMs?: number;
  probeIntervalMs?: number;
  memoryLogIntervalMs?: number;
  /** Bounded off-request refresh for process/cgroup resource accounting. */
  resourceRefreshIntervalMs?: number;
  getLagMs?: () => number;
  memoryUsage?: () => NodeJS.MemoryUsage;
  monotonicNow?: () => number;
  logger?: Logger;
  /** Optional post-listen session-resume progress owned by server startup. */
  getResumeReadiness?: () => ResumeReadiness;
  /** Informational aggregate child-process accounting; never affects liveness. */
  getResourceSummary?: () => HealthResourceSummary;
  /** Aggregate service cgroup memory; informational and never a health gate. */
  getCgroupMemory?: () => HealthCgroupMemory | undefined;
  /** Overrides the per-process boot id reported by `/healthz` (tests). */
  bootId?: string;
  /**
   * Config file this process booted with, reported only in e2e fixture mode.
   *
   * `reuseExistingServer` adopts whatever is already listening on the e2e port
   * without asking what config it holds, so a leftover server from an aborted
   * run could serve a whole suite off a stale temp dir — the same "a green run
   * only meant a stale server got recycled" failure #1214 was about. The
   * harness probes this field and refuses to reuse a mismatch (#1299).
   *
   * Fixture mode only: a deployed hub never runs in fixture mode, so this never
   * discloses a real install's paths on an unauthenticated endpoint.
   */
  fixtureConfigPath?: string | undefined;
}

const healthLogger = createLogger('health');

export function readHealthMemorySnapshot(
  memoryUsage: () => NodeJS.MemoryUsage = process.memoryUsage
): HealthMemorySnapshot {
  const { rss, heapUsed, external } = memoryUsage();
  return { rss, heapUsed, external };
}

/** Read cgroup v2 memory without disclosing the unit/cgroup path in health. */
export function readHealthCgroupMemory(): HealthCgroupMemory | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    const cgroup = fs
      .readFileSync('/proc/self/cgroup', 'utf8')
      .split('\n')
      .find((line) => line.startsWith('0::'))
      ?.slice(3);
    if (!cgroup) return undefined;
    const root = `/sys/fs/cgroup${cgroup}`;
    const current = Number(
      fs.readFileSync(`${root}/memory.current`, 'utf8').trim()
    );
    if (!Number.isFinite(current)) return undefined;
    const maxRaw = fs.readFileSync(`${root}/memory.max`, 'utf8').trim();
    const max = Number(maxRaw);
    return {
      currentBytes: current,
      ...(Number.isFinite(max) ? { maxBytes: max } : {}),
    };
  } catch {
    return undefined;
  }
}

export function formatHealthMemoryLine(snapshot: HealthMemorySnapshot): string {
  return `memory rss=${snapshot.rss} heapUsed=${snapshot.heapUsed} external=${snapshot.external}`;
}

export function logHealthMemorySnapshot(
  logger: Logger = healthLogger,
  memoryUsage: () => NodeJS.MemoryUsage = process.memoryUsage
): HealthMemorySnapshot {
  const snapshot = readHealthMemorySnapshot(memoryUsage);
  logger.info(formatHealthMemoryLine(snapshot));
  return snapshot;
}

export function createHealthMonitor(
  options: HealthMonitorOptions = {}
): HealthMonitor {
  const lagThresholdMs =
    options.lagThresholdMs ?? DEFAULT_EVENT_LOOP_LAG_THRESHOLD_MS;
  const probeIntervalMs =
    options.probeIntervalMs ?? DEFAULT_EVENT_LOOP_PROBE_INTERVAL_MS;
  const memoryLogIntervalMs =
    options.memoryLogIntervalMs ?? DEFAULT_MEMORY_LOG_INTERVAL_MS;
  const memoryUsage = options.memoryUsage ?? process.memoryUsage;
  const logger = options.logger ?? healthLogger;
  const monotonicNow =
    options.monotonicNow ?? performance.now.bind(performance);
  const resourceRefreshIntervalMs = options.resourceRefreshIntervalMs ?? 5_000;

  let measuredLagMs = 0;
  let expectedProbeAt = monotonicNow() + probeIntervalMs;
  const probeTimer = options.getLagMs
    ? undefined
    : setInterval(() => {
        const now = monotonicNow();
        measuredLagMs = Math.max(0, now - expectedProbeAt);
        // Rebase after every sample. A single stall remains visible for one
        // probe interval without accumulating permanent scheduler drift.
        expectedProbeAt = now + probeIntervalMs;
      }, probeIntervalMs);
  probeTimer?.unref();

  const memoryTimer = setInterval(() => {
    logHealthMemorySnapshot(logger, memoryUsage);
  }, memoryLogIntervalMs);
  memoryTimer.unref();

  let cachedResource = readResourceSummary(options);
  const resourceTimer = setInterval(() => {
    cachedResource = readResourceSummary(options);
  }, resourceRefreshIntervalMs);
  resourceTimer.unref();

  const getLagMs = (): number =>
    Math.max(0, options.getLagMs?.() ?? measuredLagMs);
  const disabledStores = options.disabledStores ?? [];

  const bootId = options.bootId ?? PROCESS_BOOT_ID;
  const fixtureConfigPath = options.fixtureConfigPath;

  const handler: RequestHandler = (_req, res) => {
    const lagMs = Math.round(getLagMs());
    const { rss } = readHealthMemorySnapshot(memoryUsage);
    const healthy = lagMs <= lagThresholdMs && disabledStores.length === 0;
    const resume = options.getResumeReadiness?.();
    const resource = cachedResource;
    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      lagMs,
      rss,
      bootId,
      ...(fixtureConfigPath ? { fixtureConfigPath } : {}),
      ...(disabledStores.length > 0 ? { disabledStores } : {}),
      ...(resume ? { ready: resume.complete, resume } : {}),
      ...(resource ? { resource } : {}),
    });
  };

  return {
    handler,
    getLagMs,
    stop() {
      if (probeTimer) clearInterval(probeTimer);
      clearInterval(memoryTimer);
      clearInterval(resourceTimer);
    },
  };
}

function readResourceSummary(options: HealthMonitorOptions):
  | (Partial<HealthResourceSummary> & {
      cgroupMemory?: HealthCgroupMemory;
    })
  | undefined {
  const runtimeResource = options.getResourceSummary?.();
  const cgroupMemory = options.getCgroupMemory?.();
  return runtimeResource || cgroupMemory
    ? { ...(runtimeResource ?? {}), ...(cgroupMemory ? { cgroupMemory } : {}) }
    : undefined;
}
