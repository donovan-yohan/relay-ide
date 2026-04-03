import { test, before, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
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
import type { Session } from '../server/types.js';

const noopAuth = (
  _req: express.Request,
  _res: express.Response,
  next: express.NextFunction
): void => next();

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'claude-remote-cli-telemetry-test-')
  );
});

afterEach(() => {
  stopTelemetry();
  for (const entry of fs.readdirSync(tmpDir)) {
    fs.rmSync(path.join(tmpDir, entry), { recursive: true, force: true });
  }
});

after(() => {
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
  assert.deepEqual(session, {
    sessionId: 'abc-123',
    model: 'Claude Opus 4.6',
    totalInputTokens: 12400,
    totalOutputTokens: 3200,
    totalCacheRead: 5000,
    totalCacheWrite: 1000,
    contextPercent: 7.8,
    contextWindowSize: 200000,
    costUsd: 0.42,
    source: 'statusLine',
    updatedAt: session?.updatedAt,
  });

  assert.deepEqual(account, {
    fiveHourUsedPercent: 22,
    fiveHourResetsAt: '2026-03-31T19:30:00Z',
    sevenDayUsedPercent: 8,
    sevenDayResetsAt: '2026-04-03T00:00:00Z',
    updatedAt: account?.updatedAt,
  });

  assert.equal(
    events.filter((event) => event.type === 'session-telemetry').length,
    1
  );
  assert.equal(
    events.filter((event) => event.type === 'account-telemetry').length,
    1
  );
});

test('missing statusLine file leaves telemetry undefined', () => {
  const events: Array<{ type: string; data?: Record<string, unknown> }> = [];

  startTelemetry(makeDeps(['missing-session'], events));

  assert.equal(getTelemetryForSession('missing-session'), undefined);
  assert.equal(getAccountTelemetry(), null);
  assert.equal(events.length, 0);
});

test('inactive sessions are pruned once active telemetry is available', () => {
  writePendingTelemetryFile(tmpDir, {
    version: 1,
    timestamp: new Date().toISOString(),
    sessions: {
      stale: {
        sessionId: 'stale',
        model: 'Claude Sonnet 4',
        totalInputTokens: 10,
        totalOutputTokens: 20,
        totalCacheRead: 30,
        totalCacheWrite: 40,
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

  assert.equal(getTelemetryForSession('stale'), undefined);
  assert.ok(getTelemetryForSession('fresh'));
});

test('malformed statusLine JSON is ignored without crashing', () => {
  const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
  const telemetryDir = path.join(tmpDir, 'telemetry');
  fs.mkdirSync(telemetryDir, { recursive: true });
  fs.writeFileSync(path.join(telemetryDir, 'bad-session.json'), '{"model":');

  assert.doesNotThrow(() => {
    startTelemetry(makeDeps(['bad-session'], events));
  });

  assert.equal(getTelemetryForSession('bad-session'), undefined);
  assert.equal(getAccountTelemetry(), null);
  assert.equal(events.length, 0);
});

test('restores pending telemetry from disk on startup', () => {
  const restored = {
    version: 1,
    timestamp: new Date().toISOString(),
    sessions: {
      restored: {
        sessionId: 'restored',
        model: 'Claude Sonnet 4',
        totalInputTokens: 10,
        totalOutputTokens: 20,
        totalCacheRead: 30,
        totalCacheWrite: 40,
        contextPercent: 11,
        contextWindowSize: 999,
        costUsd: 1.23,
        source: 'statusLine',
        updatedAt: '2026-03-31T18:00:00Z',
      },
    },
    account: {
      fiveHourUsedPercent: 44,
      fiveHourResetsAt: '2026-03-31T19:30:00Z',
      sevenDayUsedPercent: 55,
      sevenDayResetsAt: '2026-04-03T00:00:00Z',
      updatedAt: '2026-03-31T18:00:00Z',
    },
  };
  const pendingPath = writePendingTelemetryFile(tmpDir, restored);
  const events: Array<{ type: string; data?: Record<string, unknown> }> = [];

  startTelemetry(makeDeps([], events));

  assert.deepEqual(getTelemetryForSession('restored'), {
    sessionId: 'restored',
    model: 'Claude Sonnet 4',
    totalInputTokens: 10,
    totalOutputTokens: 20,
    totalCacheRead: 30,
    totalCacheWrite: 40,
    contextPercent: 11,
    contextWindowSize: 999,
    costUsd: 1.23,
    source: 'statusLine',
    updatedAt: '2026-03-31T18:00:00Z',
  });
  assert.deepEqual(getAccountTelemetry(), restored.account);
  assert.equal(
    fs.existsSync(pendingPath),
    false,
    'pending telemetry should be cleared after restore'
  );
  assert.equal(events.length, 0);
});

test('GET /telemetry endpoints return session and account telemetry', async () => {
  const restored = {
    version: 1,
    timestamp: new Date().toISOString(),
    sessions: {
      endpoint: {
        sessionId: 'endpoint',
        model: 'Claude Opus 4.6',
        totalInputTokens: 100,
        totalOutputTokens: 200,
        totalCacheRead: 300,
        totalCacheWrite: 400,
        contextPercent: 12.5,
        contextWindowSize: 123456,
        costUsd: 4.56,
        source: 'statusLine',
        updatedAt: '2026-03-31T18:00:00Z',
      },
    },
    account: {
      fiveHourUsedPercent: 9,
      fiveHourResetsAt: '2026-03-31T19:30:00Z',
      sevenDayUsedPercent: 18,
      sevenDayResetsAt: '2026-04-03T00:00:00Z',
      updatedAt: '2026-03-31T18:00:00Z',
    },
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
    assert.equal(typeof addr, 'object');
    assert.ok(addr);
    const baseUrl = `http://127.0.0.1:${(addr as { port: number }).port}`;

    const sessionsRes = await fetch(`${baseUrl}/telemetry/sessions`);
    assert.equal(sessionsRes.status, 200);
    assert.deepEqual(await sessionsRes.json(), {
      endpoint: {
        sessionId: 'endpoint',
        model: 'Claude Opus 4.6',
        totalInputTokens: 100,
        totalOutputTokens: 200,
        totalCacheRead: 300,
        totalCacheWrite: 400,
        contextPercent: 12.5,
        contextWindowSize: 123456,
        costUsd: 4.56,
        source: 'statusLine',
        updatedAt: '2026-03-31T18:00:00Z',
      },
    });

    const accountRes = await fetch(`${baseUrl}/telemetry/account`);
    assert.equal(accountRes.status, 200);
    assert.deepEqual(await accountRes.json(), restored.account);

    const setupStatusRes = await fetch(`${baseUrl}/telemetry/setup-status`);
    assert.equal(setupStatusRes.status, 200);
    assert.deepEqual(await setupStatusRes.json(), { installed: true });
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

  assert.doesNotThrow(() => {
    stopTelemetry();
  });
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

  assert.equal(calls, 1);
  assert.equal(
    events.filter((event) => event.type === 'session-telemetry').length,
    1
  );
});
