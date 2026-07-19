import http from 'node:http';
import express from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import { createHealthMonitor, type HealthMonitor } from '../server/health.js';
import { restoreSessionsAfterListen } from '../server/startup-restore.js';

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

it('listens before a hanging background restore and keeps health/auth responsive', async () => {
  const monitor = createHealthMonitor({
    getLagMs: () => 0,
    memoryLogIntervalMs: 60_000,
  });
  monitors.push(monitor);
  const app = express();
  app.get('/healthz', monitor.handler);
  app.get('/auth/status', (_req, res) => res.json({ hasPIN: false }));
  const server = http.createServer(app);
  servers.push(server);

  let restoreStarted = false;
  restoreSessionsAfterListen(
    server,
    () => {
      restoreStarted = true;
      return new Promise<number>(() => {});
    },
    { restored: vi.fn(), failed: vi.fn() }
  );
  expect(restoreStarted).toBe(false);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  await vi.waitFor(() => expect(restoreStarted).toBe(true));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  const baseUrl = `http://127.0.0.1:${String(address.port)}`;

  const [health, auth] = await Promise.all([
    fetch(`${baseUrl}/healthz`),
    fetch(`${baseUrl}/auth/status`),
  ]);
  expect(health.status).toBe(200);
  await expect(health.json()).resolves.toMatchObject({
    status: 'ok',
    lagMs: 0,
  });
  expect(auth.status).toBe(200);
  await expect(auth.json()).resolves.toEqual({ hasPIN: false });
});
