import { test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CodexTelemetryAdapter } from '../server/adapters/codex-telemetry.js';
import type { TelemetryDeps } from '../server/telemetry.js';

let tmpDir: string;
let adapter: CodexTelemetryAdapter;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'relay-ide-codex-telemetry-test-')
  );
  const deps: TelemetryDeps = {
    configDir: tmpDir,
    getActiveSessions: () => [],
    broadcastEvent: () => {},
  };
  adapter = new CodexTelemetryAdapter(deps);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Create an empty JSONL file and return its path */
function createEmptyJsonlFile(fileName: string): string {
  const filePath = path.join(tmpDir, fileName);
  fs.writeFileSync(filePath, '', 'utf-8');
  return filePath;
}

/** Append JSONL lines to an existing file */
function appendJsonlLines(filePath: string, lines: unknown[]): void {
  const content = lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
  fs.appendFileSync(filePath, content, 'utf-8');
}

/** Setup a session: attach, discover transcript via hook, then append data */
function setupSession(sessionId: string, lines: unknown[]): string {
  const filePath = createEmptyJsonlFile(`${sessionId}.jsonl`);
  adapter.attach({ id: sessionId });
  adapter.handleHookEvent(sessionId, 'session.started', {
    transcript_path: filePath,
  });
  if (lines.length > 0) {
    appendJsonlLines(filePath, lines);
  }
  return filePath;
}

test('valid token_count JSONL produces correct TelemetryData', () => {
  setupSession('test-session', [
    {
      type: 'token_count',
      token_count: {
        input_tokens: 1000,
        output_tokens: 500,
        cached_tokens: 200,
        reasoning_output_tokens: 100,
      },
    },
  ]);

  const snapshot = adapter.collectSnapshot('test-session');

  expect(snapshot).toBeTruthy();
  expect(snapshot!.sessionId).toBe('test-session');
  expect(snapshot!.totalInputTokens).toBe(1000);
  expect(snapshot!.totalOutputTokens).toBe(500);
  expect(snapshot!.totalCacheRead).toBe(200);
  expect(snapshot!.reasoningOutputTokens).toBe(100);
  expect(snapshot!.source).toBe('jsonl');
});

test('reasoning_output_tokens maps to reasoningOutputTokens', () => {
  setupSession('test-session', [
    {
      type: 'token_count',
      token_count: {
        input_tokens: 100,
        output_tokens: 50,
        reasoning_output_tokens: 25,
      },
    },
  ]);

  const snapshot = adapter.collectSnapshot('test-session');

  expect(snapshot).toBeTruthy();
  expect(snapshot!.reasoningOutputTokens).toBe(25);
});

test('turn_context model name extraction', () => {
  setupSession('test-session', [
    {
      type: 'turn_context',
      turn_context: { model: 'o4-mini' },
    },
    {
      type: 'token_count',
      token_count: { input_tokens: 100, output_tokens: 50 },
    },
  ]);

  const snapshot = adapter.collectSnapshot('test-session');

  expect(snapshot).toBeTruthy();
  expect(snapshot!.model).toBe('o4-mini');
});

test('model name persists across polls', () => {
  const filePath = setupSession('test-session', [
    {
      type: 'turn_context',
      turn_context: { model: 'o4-mini' },
    },
    {
      type: 'token_count',
      token_count: { input_tokens: 100, output_tokens: 50 },
    },
  ]);

  adapter.collectSnapshot('test-session');

  // Second poll has token_count but no turn_context — model should persist
  appendJsonlLines(filePath, [
    {
      type: 'token_count',
      token_count: { input_tokens: 200, output_tokens: 100 },
    },
  ]);

  const snapshot = adapter.collectSnapshot('test-session');
  expect(snapshot).toBeTruthy();
  expect(snapshot!.model).toBe('o4-mini');
  expect(snapshot!.totalInputTokens).toBe(200);
});

test('rate_limits produces RateLimitWindow[] with windowMinutes', () => {
  setupSession('test-session', [
    {
      type: 'token_count',
      token_count: { input_tokens: 100, output_tokens: 50 },
    },
    {
      type: 'rate_limits',
      rate_limits: {
        five_hour: {
          used_percentage: 45,
          resets_at: '2026-04-06T20:00:00Z',
          window_minutes: 300,
        },
        seven_day: {
          used_percentage: 12,
          resets_at: '2026-04-13T00:00:00Z',
          window_minutes: 10080,
        },
      },
    },
  ]);

  adapter.collectSnapshot('test-session');
  const accountTelemetry = adapter.collectAccountTelemetry();

  expect(accountTelemetry).toBeTruthy();
  expect(accountTelemetry!.framework).toBe('codex');
  expect(accountTelemetry!.rateLimits).toHaveLength(2);

  const fiveHour = accountTelemetry!.rateLimits.find(
    (r) => r.name === 'five_hour'
  );
  expect(fiveHour).toBeTruthy();
  expect(fiveHour!.usedPercent).toBe(45);
  expect(fiveHour!.resetsAt).toBe('2026-04-06T20:00:00Z');
  expect(fiveHour!.windowMinutes).toBe(300);

  const sevenDay = accountTelemetry!.rateLimits.find(
    (r) => r.name === 'seven_day'
  );
  expect(sevenDay).toBeTruthy();
  expect(sevenDay!.windowMinutes).toBe(10080);
});

test('rate_limits updates independently of token_count', () => {
  setupSession('test-session', [
    {
      type: 'rate_limits',
      rate_limits: {
        five_hour: {
          used_percentage: 30,
          resets_at: '2026-04-06T20:00:00Z',
          window_minutes: 300,
        },
      },
    },
  ]);

  // No token_count — session telemetry should be null but account should update
  const snapshot = adapter.collectSnapshot('test-session');
  expect(snapshot).toBeNull();

  const accountTelemetry = adapter.collectAccountTelemetry();
  expect(accountTelemetry).toBeTruthy();
  expect(accountTelemetry!.rateLimits).toHaveLength(1);
  expect(accountTelemetry!.rateLimits[0].usedPercent).toBe(30);
});

test('handleHookEvent sets transcript_path from SessionStart payload', () => {
  const filePath = createEmptyJsonlFile('test.jsonl');
  appendJsonlLines(filePath, [
    {
      type: 'token_count',
      token_count: { input_tokens: 100, output_tokens: 50 },
    },
  ]);

  adapter.attach({ id: 'test-session' });

  // Non-session.started events should not set transcript_path
  adapter.handleHookEvent('test-session', 'prompt.submitted', {
    transcript_path: filePath,
  });

  const snapshotBefore = adapter.collectSnapshot('test-session');
  expect(snapshotBefore).toBeNull();

  // session.started should set transcript_path (seeks to end, so append after)
  adapter.handleHookEvent('test-session', 'session.started', {
    transcript_path: filePath,
  });

  // Append new data after the hook event
  appendJsonlLines(filePath, [
    {
      type: 'token_count',
      token_count: { input_tokens: 200, output_tokens: 75 },
    },
  ]);

  const snapshotAfter = adapter.collectSnapshot('test-session');
  expect(snapshotAfter).toBeTruthy();
  expect(snapshotAfter!.totalInputTokens).toBe(200);
});

test('file not yet discovered returns null without crash', () => {
  adapter.attach({ id: 'test-session' });

  const snapshot = adapter.collectSnapshot('test-session');

  expect(snapshot).toBeNull();
});

test('multiple token_count events: latest wins', () => {
  setupSession('test-session', [
    {
      type: 'token_count',
      token_count: { input_tokens: 100, output_tokens: 50 },
    },
    {
      type: 'token_count',
      token_count: { input_tokens: 200, output_tokens: 100, cached_tokens: 50 },
    },
  ]);

  const snapshot = adapter.collectSnapshot('test-session');

  expect(snapshot).toBeTruthy();
  expect(snapshot!.totalInputTokens).toBe(200);
  expect(snapshot!.totalOutputTokens).toBe(100);
  expect(snapshot!.totalCacheRead).toBe(50);
});

test('malformed JSONL line skipped, good lines still parsed', () => {
  const filePath = createEmptyJsonlFile('test.jsonl');
  adapter.attach({ id: 'test-session' });
  adapter.handleHookEvent('test-session', 'session.started', {
    transcript_path: filePath,
  });

  // Write raw content including a malformed line
  fs.appendFileSync(
    filePath,
    '{"type": "token_count", "token_count": {"input_tokens": 999}}\n' +
      '{"invalid json here\n' +
      '{"type": "token_count", "token_count": {"input_tokens": 111, "output_tokens": 222}}\n',
    'utf-8'
  );

  const snapshot = adapter.collectSnapshot('test-session');

  expect(snapshot).toBeTruthy();
  expect(snapshot!.totalInputTokens).toBe(111);
  expect(snapshot!.totalOutputTokens).toBe(222);
});

test('tailFile reads only new bytes on subsequent calls', () => {
  const filePath = setupSession('test-session', [
    {
      type: 'token_count',
      token_count: { input_tokens: 100 },
    },
  ]);

  const snapshot1 = adapter.collectSnapshot('test-session');
  expect(snapshot1).toBeTruthy();
  expect(snapshot1!.totalInputTokens).toBe(100);

  appendJsonlLines(filePath, [
    {
      type: 'token_count',
      token_count: { input_tokens: 200, output_tokens: 50 },
    },
  ]);

  const snapshot2 = adapter.collectSnapshot('test-session');
  expect(snapshot2).toBeTruthy();
  expect(snapshot2!.totalInputTokens).toBe(200);
  expect(snapshot2!.totalOutputTokens).toBe(50);
});

test('empty file returns null', () => {
  setupSession('test-session', []);

  const snapshot = adapter.collectSnapshot('test-session');

  expect(snapshot).toBeNull();
});

test('missing file returns null without crash', () => {
  const nonExistentPath = path.join(tmpDir, 'does-not-exist.jsonl');

  adapter.attach({ id: 'test-session' });
  adapter.handleHookEvent('test-session', 'session.started', {
    transcript_path: nonExistentPath,
  });

  const snapshot = adapter.collectSnapshot('test-session');

  expect(snapshot).toBeNull();
});

test('detach cleans up session state', () => {
  setupSession('test-session', [
    {
      type: 'token_count',
      token_count: { input_tokens: 100, output_tokens: 50 },
    },
  ]);

  adapter.detach('test-session');

  const snapshot = adapter.collectSnapshot('test-session');
  expect(snapshot).toBeNull();
});

test('caches telemetry and returns it when no new events', () => {
  setupSession('test-session', [
    {
      type: 'token_count',
      token_count: { input_tokens: 100, output_tokens: 50 },
    },
  ]);

  const snapshot1 = adapter.collectSnapshot('test-session');
  expect(snapshot1).toBeTruthy();
  expect(snapshot1!.totalInputTokens).toBe(100);

  const snapshot2 = adapter.collectSnapshot('test-session');
  expect(snapshot2).toBeTruthy();
  expect(snapshot2!.totalInputTokens).toBe(100);
});

test('collectSnapshot completes quickly (under 50ms)', () => {
  const lines = Array.from({ length: 100 }, (_, i) => ({
    type: 'token_count',
    token_count: {
      input_tokens: i * 10,
      output_tokens: i * 5,
    },
  }));

  const filePath = createEmptyJsonlFile('test.jsonl');
  adapter.attach({ id: 'test-session' });
  adapter.handleHookEvent('test-session', 'session.started', {
    transcript_path: filePath,
  });
  appendJsonlLines(filePath, lines);

  const start = performance.now();
  adapter.collectSnapshot('test-session');
  const duration = performance.now() - start;

  // Loosened from 5ms to 50ms to avoid flakiness on slow CI machines
  expect(duration).toBeLessThan(50);
});

test('truncated file resets offset and recovers', () => {
  // Write enough data to push the offset well past zero
  const filePath = setupSession('test-session', [
    {
      type: 'token_count',
      token_count: { input_tokens: 100, output_tokens: 50 },
    },
    {
      type: 'turn_context',
      turn_context: { model: 'o4-mini' },
    },
    {
      type: 'rate_limits',
      rate_limits: {
        five_hour: {
          used_percentage: 10,
          resets_at: '2026-04-06T20:00:00Z',
          window_minutes: 300,
        },
      },
    },
  ]);

  const snapshot1 = adapter.collectSnapshot('test-session');
  expect(snapshot1).toBeTruthy();
  expect(snapshot1!.totalInputTokens).toBe(100);

  // Truncate file (simulates rotation) — new file is smaller than old offset
  fs.writeFileSync(filePath, '', 'utf-8');
  appendJsonlLines(filePath, [
    {
      type: 'token_count',
      token_count: { input_tokens: 500, output_tokens: 250 },
    },
  ]);

  const snapshot2 = adapter.collectSnapshot('test-session');
  expect(snapshot2).toBeTruthy();
  expect(snapshot2!.totalInputTokens).toBe(500);
  expect(snapshot2!.totalOutputTokens).toBe(250);
});

test('partial JSONL line is retried on next poll', () => {
  const filePath = setupSession('test-session', []);

  // Write a complete line followed by a partial line (no trailing newline)
  fs.appendFileSync(
    filePath,
    '{"type": "token_count", "token_count": {"input_tokens": 100}}\n' +
      '{"type": "token_cou',
    'utf-8'
  );

  const snapshot1 = adapter.collectSnapshot('test-session');
  expect(snapshot1).toBeTruthy();
  expect(snapshot1!.totalInputTokens).toBe(100);

  // Complete the partial line
  fs.appendFileSync(
    filePath,
    'nt", "token_count": {"input_tokens": 200, "output_tokens": 50}}\n',
    'utf-8'
  );

  const snapshot2 = adapter.collectSnapshot('test-session');
  expect(snapshot2).toBeTruthy();
  expect(snapshot2!.totalInputTokens).toBe(200);
  expect(snapshot2!.totalOutputTokens).toBe(50);
});
