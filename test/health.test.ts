import http from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createHealthMonitor,
  formatHealthMemoryLine,
  logHealthMemorySnapshot,
  type HealthMonitor,
} from '../server/health.js';

const servers: http.Server[] = [];
const monitors: HealthMonitor[] = [];

afterEach(async () => {
  for (const monitor of monitors.splice(0)) monitor.stop();
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve()))
      )
  );
  vi.useRealTimers();
});

const TEST_BOOT_ID = 'boot-id-under-test';

async function serveHealthz(lagMs: number): Promise<string> {
  const monitor = createHealthMonitor({
    getLagMs: () => lagMs,
    lagThresholdMs: 100,
    bootId: TEST_BOOT_ID,
    memoryLogIntervalMs: 60_000,
    memoryUsage: () => ({
      rss: 123_456,
      heapTotal: 80_000,
      heapUsed: 40_000,
      external: 2_000,
      arrayBuffers: 1_000,
    }),
  });
  monitors.push(monitor);
  const app = express();
  app.get('/healthz', monitor.handler);
  const server = http.createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  return `http://127.0.0.1:${String(address.port)}`;
}

describe('/healthz', () => {
  it('returns 503 from the actual monotonic interval drift probe', () => {
    vi.useFakeTimers();
    let monotonicMs = 0;
    const monitor = createHealthMonitor({
      lagThresholdMs: 50,
      probeIntervalMs: 100,
      bootId: TEST_BOOT_ID,
      memoryLogIntervalMs: 60_000,
      monotonicNow: () => monotonicMs,
      memoryUsage: () => ({
        rss: 123_456,
        heapTotal: 80_000,
        heapUsed: 40_000,
        external: 2_000,
        arrayBuffers: 1_000,
      }),
    });
    monitors.push(monitor);
    monotonicMs = 175;
    vi.advanceTimersByTime(100);

    const json = vi.fn();
    const response = {
      status: vi.fn().mockReturnThis(),
      json,
    };
    monitor.handler({} as never, response as never, vi.fn());

    expect(monitor.getLagMs()).toBe(75);
    expect(response.status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith({
      status: 'degraded',
      lagMs: 75,
      rss: 123_456,
      bootId: TEST_BOOT_ID,
    });
  });

  it('logs the memory line on the periodic interval', () => {
    vi.useFakeTimers();
    const info = vi.fn();
    const monitor = createHealthMonitor({
      getLagMs: () => 0,
      memoryLogIntervalMs: 60_000,
      logger: {
        trace: vi.fn(),
        debug: vi.fn(),
        info,
        warn: vi.fn(),
        error: vi.fn(),
      },
      memoryUsage: () => ({
        rss: 100,
        heapTotal: 80,
        heapUsed: 60,
        external: 40,
        arrayBuffers: 20,
      }),
    });
    monitors.push(monitor);

    vi.advanceTimersByTime(59_999);
    expect(info).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(info).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith('memory rss=100 heapUsed=60 external=40');
  });

  it('returns the unauthenticated health shape', async () => {
    const baseUrl = await serveHealthz(12.4);
    const response = await fetch(`${baseUrl}/healthz`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: 'ok',
      lagMs: 12,
      rss: 123_456,
      // Per-process identity: a client waiting out a restart uses it to tell
      // the new server from the one still shutting down (#1285).
      bootId: TEST_BOOT_ID,
    });
  });

  it('returns 503 when the injected event-loop lag exceeds the threshold', async () => {
    const baseUrl = await serveHealthz(101);
    const response = await fetch(`${baseUrl}/healthz`);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: 'degraded',
      lagMs: 101,
      rss: 123_456,
      bootId: TEST_BOOT_ID,
    });
  });

  it('returns 503 and disabled stores when persistence is explicitly degraded', () => {
    const monitor = createHealthMonitor({
      getLagMs: () => 12,
      bootId: TEST_BOOT_ID,
      disabledStores: ['channel-messages', 'analytics'],
      memoryLogIntervalMs: 60_000,
      memoryUsage: () => ({
        rss: 123_456,
        heapTotal: 80_000,
        heapUsed: 40_000,
        external: 2_000,
        arrayBuffers: 1_000,
      }),
    });
    monitors.push(monitor);
    const json = vi.fn();
    const response = {
      status: vi.fn().mockReturnThis(),
      json,
    };

    monitor.handler({} as never, response as never, vi.fn());

    expect(response.status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith({
      status: 'degraded',
      lagMs: 12,
      rss: 123_456,
      bootId: TEST_BOOT_ID,
      disabledStores: ['channel-messages', 'analytics'],
    });
  });

  it('formats one memory line with rss, heapUsed, and external', () => {
    const info = vi.fn();
    const snapshot = logHealthMemorySnapshot(
      {
        trace: vi.fn(),
        debug: vi.fn(),
        info,
        warn: vi.fn(),
        error: vi.fn(),
      },
      () => ({
        rss: 100,
        heapTotal: 80,
        heapUsed: 60,
        external: 40,
        arrayBuffers: 20,
      })
    );

    expect(formatHealthMemoryLine(snapshot)).toBe(
      'memory rss=100 heapUsed=60 external=40'
    );
    expect(info).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith('memory rss=100 heapUsed=60 external=40');
  });
});
