import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { fetchSessionTelemetry, fetchTelemetrySetupStatus } from '../frontend/src/lib/api.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('fetchSessionTelemetry handles plain object-map responses', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({
    'session-1': {
      sessionId: 'session-1',
      model: 'Claude Sonnet 4',
      totalInputTokens: 10,
      totalOutputTokens: 20,
      totalCacheRead: 30,
      totalCacheWrite: 40,
      contextPercent: 12,
      contextWindowSize: 200000,
      costUsd: 0.5,
      turnCount: 1,
      subagentCount: 2,
      source: 'statusLine',
      updatedAt: '2026-04-01T00:00:00.000Z',
    },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })) as typeof globalThis.fetch;

  const result = await fetchSessionTelemetry();

  assert.deepEqual(result, [{
    sessionId: 'session-1',
    model: 'Claude Sonnet 4',
    totalInputTokens: 10,
    totalOutputTokens: 20,
    totalCacheRead: 30,
    totalCacheWrite: 40,
    contextPercent: 12,
    contextWindowSize: 200000,
    costUsd: 0.5,
    turnCount: 1,
    subagentCount: 2,
    source: 'statusLine',
    updatedAt: '2026-04-01T00:00:00.000Z',
  }]);
});

test('fetchTelemetrySetupStatus returns installed flag from the server response', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ installed: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })) as typeof globalThis.fetch;

  assert.deepEqual(await fetchTelemetrySetupStatus(), { installed: true });
});
