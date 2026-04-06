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

function createJsonlFile(fileName: string, lines: unknown[]): string {
  const filePath = path.join(tmpDir, fileName);
  const content = lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

test('valid token_count JSONL produces correct TelemetryData', () => {
  const jsonlPath = createJsonlFile('test.jsonl', [
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

  adapter.attach({ id: 'test-session' });
  adapter.handleHookEvent('test-session', 'session.started', {
    transcript_path: jsonlPath,
  });

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
  const jsonlPath = createJsonlFile('test.jsonl', [
    {
      type: 'token_count',
      token_count: {
        input_tokens: 100,
        output_tokens: 50,
        reasoning_output_tokens: 25,
      },
    },
  ]);

  adapter.attach({ id: 'test-session' });
  adapter.handleHookEvent('test-session', 'session.started', {
    transcript_path: jsonlPath,
  });

  const snapshot = adapter.collectSnapshot('test-session');

  expect(snapshot).toBeTruthy();
  expect(snapshot!.reasoningOutputTokens).toBe(25);
});

test('turn_context model name extraction', () => {
  const jsonlPath = createJsonlFile('test.jsonl', [
    {
      type: 'turn_context',
      turn_context: {
        model: 'o4-mini',
      },
    },
    {
      type: 'token_count',
      token_count: {
        input_tokens: 100,
        output_tokens: 50,
      },
    },
  ]);

  adapter.attach({ id: 'test-session' });
  adapter.handleHookEvent('test-session', 'session.started', {
    transcript_path: jsonlPath,
  });

  const snapshot = adapter.collectSnapshot('test-session');

  expect(snapshot).toBeTruthy();
  expect(snapshot!.model).toBe('o4-mini');
});

test('rate_limits produces RateLimitWindow[] with windowMinutes', () => {
  const jsonlPath = createJsonlFile('test.jsonl', [
    {
      type: 'token_count',
      token_count: {
        input_tokens: 100,
        output_tokens: 50,
      },
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

  adapter.attach({ id: 'test-session' });
  adapter.handleHookEvent('test-session', 'session.started', {
    transcript_path: jsonlPath,
  });

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

test('handleHookEvent sets transcript_path from SessionStart payload', () => {
  const jsonlPath = createJsonlFile('test.jsonl', [
    {
      type: 'token_count',
      token_count: {
        input_tokens: 100,
        output_tokens: 50,
      },
    },
  ]);

  adapter.attach({ id: 'test-session' });

  adapter.handleHookEvent('test-session', 'prompt.submitted', {
    transcript_path: jsonlPath,
  });

  const snapshotBefore = adapter.collectSnapshot('test-session');
  expect(snapshotBefore).toBeNull();

  adapter.handleHookEvent('test-session', 'session.started', {
    transcript_path: jsonlPath,
  });

  const snapshotAfter = adapter.collectSnapshot('test-session');
  expect(snapshotAfter).toBeTruthy();
  expect(snapshotAfter!.totalInputTokens).toBe(100);
});

test('file not yet discovered returns null without crash', () => {
  adapter.attach({ id: 'test-session' });

  const snapshot = adapter.collectSnapshot('test-session');

  expect(snapshot).toBeNull();
});

test('multiple token_count events: latest wins', () => {
  const jsonlPath = createJsonlFile('test.jsonl', [
    {
      type: 'token_count',
      token_count: {
        input_tokens: 100,
        output_tokens: 50,
      },
    },
    {
      type: 'token_count',
      token_count: {
        input_tokens: 200,
        output_tokens: 100,
        cached_tokens: 50,
      },
    },
  ]);

  adapter.attach({ id: 'test-session' });
  adapter.handleHookEvent('test-session', 'session.started', {
    transcript_path: jsonlPath,
  });

  const snapshot = adapter.collectSnapshot('test-session');

  expect(snapshot).toBeTruthy();
  expect(snapshot!.totalInputTokens).toBe(200);
  expect(snapshot!.totalOutputTokens).toBe(100);
  expect(snapshot!.totalCacheRead).toBe(50);
});

test('malformed JSONL line skipped, good lines still parsed', () => {
  const filePath = path.join(tmpDir, 'test.jsonl');
  const content =
    '{"type": "token_count", "token_count": {"input_tokens": 999}}\n' +
    '{"invalid json here\n' +
    '{"type": "token_count", "token_count": {"input_tokens": 111, "output_tokens": 222}}\n';
  fs.writeFileSync(filePath, content, 'utf-8');

  adapter.attach({ id: 'test-session' });
  adapter.handleHookEvent('test-session', 'session.started', {
    transcript_path: filePath,
  });

  const snapshot = adapter.collectSnapshot('test-session');

  expect(snapshot).toBeTruthy();
  expect(snapshot!.totalInputTokens).toBe(111);
  expect(snapshot!.totalOutputTokens).toBe(222);
});

test('tailFile reads only new bytes on subsequent calls', () => {
  const filePath = path.join(tmpDir, 'test.jsonl');

  fs.writeFileSync(
    filePath,
    '{"type": "token_count", "token_count": {"input_tokens": 100}}\n',
    'utf-8'
  );

  adapter.attach({ id: 'test-session' });
  adapter.handleHookEvent('test-session', 'session.started', {
    transcript_path: filePath,
  });

  const snapshot1 = adapter.collectSnapshot('test-session');
  expect(snapshot1).toBeTruthy();
  expect(snapshot1!.totalInputTokens).toBe(100);

  fs.appendFileSync(
    filePath,
    '{"type": "token_count", "token_count": {"input_tokens": 200, "output_tokens": 50}}\n',
    'utf-8'
  );

  const snapshot2 = adapter.collectSnapshot('test-session');
  expect(snapshot2).toBeTruthy();
  expect(snapshot2!.totalInputTokens).toBe(200);
  expect(snapshot2!.totalOutputTokens).toBe(50);
});

test('empty file returns null', () => {
  const filePath = path.join(tmpDir, 'empty.jsonl');
  fs.writeFileSync(filePath, '', 'utf-8');

  adapter.attach({ id: 'test-session' });
  adapter.handleHookEvent('test-session', 'session.started', {
    transcript_path: filePath,
  });

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
  const jsonlPath = createJsonlFile('test.jsonl', [
    {
      type: 'token_count',
      token_count: {
        input_tokens: 100,
        output_tokens: 50,
      },
    },
  ]);

  adapter.attach({ id: 'test-session' });
  adapter.handleHookEvent('test-session', 'session.started', {
    transcript_path: jsonlPath,
  });

  adapter.detach('test-session');

  const snapshot = adapter.collectSnapshot('test-session');
  expect(snapshot).toBeNull();
});

test('caches telemetry and returns it when no new events', () => {
  const jsonlPath = createJsonlFile('test.jsonl', [
    {
      type: 'token_count',
      token_count: {
        input_tokens: 100,
        output_tokens: 50,
      },
    },
  ]);

  adapter.attach({ id: 'test-session' });
  adapter.handleHookEvent('test-session', 'session.started', {
    transcript_path: jsonlPath,
  });

  const snapshot1 = adapter.collectSnapshot('test-session');
  expect(snapshot1).toBeTruthy();
  expect(snapshot1!.totalInputTokens).toBe(100);

  // Second call should return cached data (timestamp may be same or different depending on timing)
  const snapshot2 = adapter.collectSnapshot('test-session');
  expect(snapshot2).toBeTruthy();
  expect(snapshot2!.totalInputTokens).toBe(100);
});

test('collectSnapshot completes quickly (under 5ms)', () => {
  const lines = Array.from({ length: 100 }, (_, i) => ({
    type: 'token_count',
    token_count: {
      input_tokens: i * 10,
      output_tokens: i * 5,
    },
  }));

  const jsonlPath = createJsonlFile('test.jsonl', lines);

  adapter.attach({ id: 'test-session' });
  adapter.handleHookEvent('test-session', 'session.started', {
    transcript_path: jsonlPath,
  });

  const start = performance.now();
  adapter.collectSnapshot('test-session');
  const duration = performance.now() - start;

  expect(duration).toBeLessThan(5);
});
