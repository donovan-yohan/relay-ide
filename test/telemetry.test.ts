import { test, beforeAll, afterEach, afterAll, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';

import {
  createTelemetryRouter,
  getAccountTelemetry,
  getTelemetryForSession,
  startTelemetry,
  stopTelemetry,
  type TelemetryDeps,
} from '../server/telemetry.js';
import { getAdapterForFramework } from '../server/telemetry-adapter.js';
import type { Session } from '../server/types.js';

const noopAuth = (
  _req: express.Request,
  _res: express.Response,
  next: express.NextFunction
): void => next();

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-ide-telemetry-test-'));
});

afterEach(() => {
  stopTelemetry();
  for (const entry of fs.readdirSync(tmpDir)) {
    fs.rmSync(path.join(tmpDir, entry), { recursive: true, force: true });
  }
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeSession(id: string): Session {
  return { id } as unknown as Session;
}

function makeDeps(
  sessionIds: string[],
  events: Array<{ type: string; data?: Record<string, unknown> }>,
  configDir = tmpDir
): TelemetryDeps {
  return {
    configDir,
    getActiveSessions: () => sessionIds.map(makeSession),
    broadcastEvent: (type, data) => {
      if (data === undefined) events.push({ type });
      else events.push({ type, data });
    },
  };
}

function writeStatusLineFile(
  sessionId: string,
  payload: unknown,
  configDir = tmpDir
): string {
  const telemetryDir = path.join(configDir, 'telemetry');
  fs.mkdirSync(telemetryDir, { recursive: true });
  const filePath = path.join(telemetryDir, `${sessionId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  return filePath;
}

function writePendingTelemetryFile(
  configDir: string,
  payload: unknown
): string {
  const filePath = path.join(configDir, 'pending-telemetry.json');
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  return filePath;
}

function sampleStatusLinePayload(): Record<string, unknown> {
  return {
    session_id: 'abc-123',
    model: { id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6' },
    context_window: {
      total_input_tokens: 12400,
      total_output_tokens: 3200,
      context_window_size: 200000,
      used_percentage: 7.8,
      remaining_percentage: 92.2,
      current_usage: {
        input_tokens: 500,
        output_tokens: 100,
        cache_creation_input_tokens: 1000,
        cache_read_input_tokens: 5000,
      },
    },
    cost: { total_cost_usd: 0.42 },
    rate_limits: {
      five_hour: { used_percentage: 22, resets_at: '2026-03-31T19:30:00Z' },
      seven_day: { used_percentage: 8, resets_at: '2026-04-03T00:00:00Z' },
    },
  };
}

test('parses session telemetry from the statusLine file', () => {
  const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
  writeStatusLineFile('abc-123', sampleStatusLinePayload());

  startTelemetry(makeDeps(['abc-123'], events));

  const session = getTelemetryForSession('abc-123');
  const account = getAccountTelemetry();
  expect(session).toEqual({
    sessionId: 'abc-123',
    model: 'Claude Opus 4.6',
    totalInputTokens: 12400,
    totalOutputTokens: 3200,
    totalCacheRead: 5000,
    totalCacheWrite: 1000,
    reasoningOutputTokens: 0,
    contextPercent: 7.8,
    contextWindowSize: 200000,
    costUsd: 0.42,
    source: 'statusLine',
    updatedAt: session?.updatedAt,
  });

  expect(account).toEqual({
    claude: {
      framework: 'claude',
      rateLimits: [
        {
          name: 'five_hour',
          usedPercent: 22,
          resetsAt: '2026-03-31T19:30:00Z',
          windowMinutes: 300,
        },
        {
          name: 'seven_day',
          usedPercent: 8,
          resetsAt: '2026-04-03T00:00:00Z',
          windowMinutes: 10080,
        },
      ],
      updatedAt: account?.claude?.updatedAt,
    },
  });

  expect(
    events.filter((event) => event.type === 'session-telemetry').length
  ).toBe(1);
  expect(
    events.filter((event) => event.type === 'account-telemetry').length
  ).toBe(1);
});

test('missing statusLine file leaves telemetry undefined', () => {
  const events: Array<{ type: string; data?: Record<string, unknown> }> = [];

  startTelemetry(makeDeps(['missing-session'], events));

  expect(getTelemetryForSession('missing-session')).toBe(undefined);
  expect(getAccountTelemetry()).toEqual({});
  expect(events.length).toBe(0);
});

test('inactive sessions are pruned once active telemetry is available', () => {
  writePendingTelemetryFile(tmpDir, {
    version: 2,
    timestamp: new Date().toISOString(),
    sessions: {
      stale: {
        sessionId: 'stale',
        model: 'Claude Sonnet 4',
        totalInputTokens: 10,
        totalOutputTokens: 20,
        totalCacheRead: 30,
        totalCacheWrite: 40,
        reasoningOutputTokens: 0,
        contextPercent: 11,
        contextWindowSize: 999,
        costUsd: 1.23,
        source: 'statusLine',
        updatedAt: '2026-03-31T17:00:00Z',
      },
    },
    account: null,
  });
  writeStatusLineFile('fresh', sampleStatusLinePayload());

  startTelemetry(makeDeps(['fresh'], []));

  expect(getTelemetryForSession('stale')).toBe(undefined);
  expect(getTelemetryForSession('fresh')).toBeTruthy();
});

test('malformed statusLine JSON is ignored without crashing', () => {
  const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
  const telemetryDir = path.join(tmpDir, 'telemetry');
  fs.mkdirSync(telemetryDir, { recursive: true });
  fs.writeFileSync(path.join(telemetryDir, 'bad-session.json'), '{"model":');

  expect(() => {
    startTelemetry(makeDeps(['bad-session'], events));
  }).not.toThrow();

  expect(getTelemetryForSession('bad-session')).toBe(undefined);
  expect(getAccountTelemetry()).toEqual({});
  expect(events.length).toBe(0);
});

test('restores pending telemetry from disk on startup', () => {
  const restoredAccount = {
    framework: 'claude',
    rateLimits: [
      {
        name: 'five_hour',
        usedPercent: 44,
        resetsAt: '2026-03-31T19:30:00Z',
        windowMinutes: 300,
      },
      {
        name: 'seven_day',
        usedPercent: 55,
        resetsAt: '2026-04-03T00:00:00Z',
        windowMinutes: 10080,
      },
    ],
    updatedAt: '2026-03-31T18:00:00Z',
  };
  const restored = {
    version: 2,
    timestamp: new Date().toISOString(),
    sessions: {
      restored: {
        sessionId: 'restored',
        model: 'Claude Sonnet 4',
        totalInputTokens: 10,
        totalOutputTokens: 20,
        totalCacheRead: 30,
        totalCacheWrite: 40,
        reasoningOutputTokens: 0,
        contextPercent: 11,
        contextWindowSize: 999,
        costUsd: 1.23,
        source: 'statusLine',
        updatedAt: '2026-03-31T18:00:00Z',
      },
    },
    account: { claude: restoredAccount },
  };
  const pendingPath = writePendingTelemetryFile(tmpDir, restored);
  const events: Array<{ type: string; data?: Record<string, unknown> }> = [];

  startTelemetry(makeDeps([], events));

  expect(getTelemetryForSession('restored')).toEqual({
    sessionId: 'restored',
    model: 'Claude Sonnet 4',
    totalInputTokens: 10,
    totalOutputTokens: 20,
    totalCacheRead: 30,
    totalCacheWrite: 40,
    reasoningOutputTokens: 0,
    contextPercent: 11,
    contextWindowSize: 999,
    costUsd: 1.23,
    source: 'statusLine',
    updatedAt: '2026-03-31T18:00:00Z',
  });
  expect(getAccountTelemetry()).toEqual({ claude: restoredAccount });
  expect(fs.existsSync(pendingPath)).toBe(false);
  expect(events.length).toBe(0);
});

test('GET /telemetry endpoints return session and account telemetry', async () => {
  const restoredAccount = {
    framework: 'claude',
    rateLimits: [
      {
        name: 'five_hour',
        usedPercent: 9,
        resetsAt: '2026-03-31T19:30:00Z',
        windowMinutes: 300,
      },
      {
        name: 'seven_day',
        usedPercent: 18,
        resetsAt: '2026-04-03T00:00:00Z',
        windowMinutes: 10080,
      },
    ],
    updatedAt: '2026-03-31T18:00:00Z',
  };
  const restored = {
    version: 2,
    timestamp: new Date().toISOString(),
    sessions: {
      endpoint: {
        sessionId: 'endpoint',
        model: 'Claude Opus 4.6',
        totalInputTokens: 100,
        totalOutputTokens: 200,
        totalCacheRead: 300,
        totalCacheWrite: 400,
        reasoningOutputTokens: 0,
        contextPercent: 12.5,
        contextWindowSize: 123456,
        costUsd: 4.56,
        source: 'statusLine',
        updatedAt: '2026-03-31T18:00:00Z',
      },
    },
    account: { claude: restoredAccount },
  };
  writePendingTelemetryFile(tmpDir, restored);
  startTelemetry(makeDeps([], []));

  let server: Server | undefined;
  try {
    const app = express();
    app.use(express.json());
    app.use('/telemetry', noopAuth, createTelemetryRouter());
    server = await new Promise<Server>((resolve) => {
      const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
    });

    const addr = server.address();
    expect(typeof addr).toBe('object');
    expect(addr).toBeTruthy();
    const baseUrl = `http://127.0.0.1:${(addr as { port: number }).port}`;

    const sessionsRes = await fetch(`${baseUrl}/telemetry/sessions`);
    expect(sessionsRes.status).toBe(200);
    expect(await sessionsRes.json()).toEqual({
      endpoint: {
        sessionId: 'endpoint',
        model: 'Claude Opus 4.6',
        totalInputTokens: 100,
        totalOutputTokens: 200,
        totalCacheRead: 300,
        totalCacheWrite: 400,
        reasoningOutputTokens: 0,
        contextPercent: 12.5,
        contextWindowSize: 123456,
        costUsd: 4.56,
        source: 'statusLine',
        updatedAt: '2026-03-31T18:00:00Z',
      },
    });

    const accountRes = await fetch(`${baseUrl}/telemetry/account`);
    expect(accountRes.status).toBe(200);
    expect(await accountRes.json()).toEqual({ claude: restoredAccount });

    const setupStatusRes = await fetch(`${baseUrl}/telemetry/setup-status`);
    expect(setupStatusRes.status).toBe(200);
    expect(await setupStatusRes.json()).toEqual({ installed: true });
  } finally {
    await new Promise<void>((resolve) => {
      if (server) server.close(() => resolve());
      else resolve();
    });
  }
});

test('stopTelemetry ignores pending persistence write failures', () => {
  const blockedPath = path.join(tmpDir, 'not-a-directory');
  fs.writeFileSync(blockedPath, 'blocked');

  startTelemetry(makeDeps([], [], blockedPath));

  expect(() => {
    stopTelemetry();
  }).not.toThrow();
});

test('collectTelemetry reuses a single active session snapshot per poll', () => {
  const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
  let calls = 0;

  writeStatusLineFile('abc-123', sampleStatusLinePayload());

  startTelemetry({
    configDir: tmpDir,
    getActiveSessions: () => {
      calls++;
      return [makeSession('abc-123')];
    },
    broadcastEvent: (type, data) => {
      if (data === undefined) events.push({ type });
      else events.push({ type, data });
    },
  });

  expect(calls).toBe(1);
  expect(
    events.filter((event) => event.type === 'session-telemetry').length
  ).toBe(1);
});

test('Codex adapter registered and discoverable via getAdapterForFramework', () => {
  const deps = makeDeps([], []);

  const adapter = getAdapterForFramework('codex', deps);

  expect(adapter).toBeTruthy();
  expect(adapter!.framework).toBe('codex');
});

test('multi-adapter coexistence: Claude and Codex adapters work independently', () => {
  const events: Array<{ type: string; data?: Record<string, unknown> }> = [];

  writeStatusLineFile('claude-session', sampleStatusLinePayload());

  const deps: TelemetryDeps = {
    configDir: tmpDir,
    getActiveSessions: () => [
      { id: 'codex-session', agent: 'codex' } as Session,
      { id: 'claude-session', agent: 'claude' } as Session,
    ],
    broadcastEvent: (type, data) => {
      if (data === undefined) events.push({ type });
      else events.push({ type, data });
    },
  };

  startTelemetry(deps);

  const claudeTelemetry = getTelemetryForSession('claude-session');

  expect(claudeTelemetry).toBeTruthy();
  expect(claudeTelemetry!.source).toBe('statusLine');
  expect(claudeTelemetry!.totalInputTokens).toBe(12400);
});
