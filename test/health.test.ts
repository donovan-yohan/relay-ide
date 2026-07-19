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
});

async function serveHealthz(lagMs: number): Promise<string> {
  const monitor = createHealthMonitor({
    getLagMs: () => lagMs,
    lagThresholdMs: 100,
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
  it('returns the unauthenticated health shape', async () => {
    const baseUrl = await serveHealthz(12.4);
    const response = await fetch(`${baseUrl}/healthz`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: 'ok',
      lagMs: 12,
      rss: 123_456,
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
