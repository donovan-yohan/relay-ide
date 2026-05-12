import { afterEach, test, expect } from 'vitest';

import {
  fetchSessionTelemetry,
  fetchAccountTelemetry,
  fetchTelemetrySetupStatus,
} from '../frontend/src/lib/api.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('fetchSessionTelemetry handles plain object-map responses', async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
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
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    )) as typeof globalThis.fetch;

  const result = await fetchSessionTelemetry();

  expect(result).toEqual([
    {
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
  ]);
});

test('fetchSessionTelemetry handles globally scoped object-map responses', async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        sessions: {
          'node-a:same-local-id': {
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
        },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    )) as typeof globalThis.fetch;

  const result = await fetchSessionTelemetry();

  expect(result[0]).toMatchObject({
    sessionId: 'same-local-id',
    localSessionId: 'same-local-id',
    nodeId: 'node-a',
    globalSessionId: 'node-a:same-local-id',
    totalInputTokens: 10,
  });
});

test('fetchTelemetrySetupStatus returns installed flag from the server response', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ installed: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof globalThis.fetch;

  expect(await fetchTelemetrySetupStatus()).toEqual({ installed: true });
});

test('fetchAccountTelemetry handles map-based responses', async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        claude: {
          framework: 'claude',
          rateLimits: [
            {
              name: 'five_hour',
              usedPercent: 42,
              resetsAt: '2026-03-31T19:30:00Z',
              windowMinutes: 300,
            },
            {
              name: 'seven_day',
              usedPercent: 63,
              resetsAt: '2026-04-03T00:00:00Z',
              windowMinutes: 10080,
            },
          ],
          updatedAt: '2026-04-01T00:00:00Z',
        },
        codex: {
          framework: 'codex',
          rateLimits: [
            {
              name: 'five_hour',
              usedPercent: 10,
              resetsAt: '2026-03-31T19:30:00Z',
              windowMinutes: 300,
            },
          ],
          updatedAt: '2026-04-01T00:00:00Z',
        },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    )) as typeof globalThis.fetch;

  const result = await fetchAccountTelemetry();

  expect(result).toEqual({
    claude: {
      framework: 'claude',
      rateLimits: [
        {
          name: 'five_hour',
          usedPercent: 42,
          resetsAt: '2026-03-31T19:30:00Z',
          windowMinutes: 300,
        },
        {
          name: 'seven_day',
          usedPercent: 63,
          resetsAt: '2026-04-03T00:00:00Z',
          windowMinutes: 10080,
        },
      ],
      updatedAt: '2026-04-01T00:00:00Z',
    },
    codex: {
      framework: 'codex',
      rateLimits: [
        {
          name: 'five_hour',
          usedPercent: 10,
          resetsAt: '2026-03-31T19:30:00Z',
          windowMinutes: 300,
        },
      ],
      updatedAt: '2026-04-01T00:00:00Z',
    },
  });
});

test('fetchAccountTelemetry returns null for empty maps', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof globalThis.fetch;

  expect(await fetchAccountTelemetry()).toBeNull();
});

test('fetchAccountTelemetry returns null for invalid responses', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(null), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof globalThis.fetch;

  expect(await fetchAccountTelemetry()).toBeNull();
});
