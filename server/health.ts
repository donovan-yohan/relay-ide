import { performance } from 'node:perf_hooks';
import type { RequestHandler } from 'express';
import { createLogger, type Logger } from './logger.js';

export const DEFAULT_EVENT_LOOP_LAG_THRESHOLD_MS = 2_000;
export const DEFAULT_EVENT_LOOP_PROBE_INTERVAL_MS = 1_000;
export const DEFAULT_MEMORY_LOG_INTERVAL_MS = 60_000;

export interface HealthMemorySnapshot {
  rss: number;
  heapUsed: number;
  external: number;
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
  getLagMs?: () => number;
  memoryUsage?: () => NodeJS.MemoryUsage;
  monotonicNow?: () => number;
  logger?: Logger;
  /** Optional post-listen session-resume progress owned by server startup. */
  getResumeReadiness?: () => ResumeReadiness;
}

const healthLogger = createLogger('health');

export function readHealthMemorySnapshot(
  memoryUsage: () => NodeJS.MemoryUsage = process.memoryUsage
): HealthMemorySnapshot {
  const { rss, heapUsed, external } = memoryUsage();
  return { rss, heapUsed, external };
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

  const getLagMs = (): number =>
    Math.max(0, options.getLagMs?.() ?? measuredLagMs);
  const disabledStores = options.disabledStores ?? [];

  const handler: RequestHandler = (_req, res) => {
    const lagMs = Math.round(getLagMs());
    const { rss } = readHealthMemorySnapshot(memoryUsage);
    const healthy = lagMs <= lagThresholdMs && disabledStores.length === 0;
    const resume = options.getResumeReadiness?.();
    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      lagMs,
      rss,
      ...(disabledStores.length > 0 ? { disabledStores } : {}),
      ...(resume ? { ready: resume.complete, resume } : {}),
    });
  };

  return {
    handler,
    getLagMs,
    stop() {
      if (probeTimer) clearInterval(probeTimer);
      clearInterval(memoryTimer);
    },
  };
}
