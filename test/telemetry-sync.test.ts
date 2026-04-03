import { describe, it, expect } from 'vitest';

import type {
  AccountTelemetry,
  SessionTelemetry,
} from '../frontend/src/lib/types.js';
import {
  mergeAccountTelemetrySnapshot,
  mergeSessionTelemetrySnapshot,
} from '../frontend/src/lib/telemetry-sync.js';

function makeSessionTelemetry(
  overrides: Partial<SessionTelemetry> = {}
): SessionTelemetry {
  return {
    sessionId: 'session-1',
    model: 'Claude Sonnet 4',
    totalInputTokens: 10,
    totalOutputTokens: 20,
    totalCacheRead: 30,
    totalCacheWrite: 40,
    contextPercent: 12,
    contextWindowSize: 200000,
    costUsd: 0.5,
    turnCount: 0,
    subagentCount: 0,
    source: 'statusLine',
    updatedAt: '2026-04-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeAccountTelemetry(
  overrides: Partial<AccountTelemetry> = {}
): AccountTelemetry {
  return {
    fiveHourUsedPercent: 10,
    fiveHourResetsAt: '2026-04-01T05:00:00.000Z',
    sevenDayUsedPercent: 20,
    sevenDayResetsAt: '2026-04-07T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('mergeSessionTelemetrySnapshot', () => {
  it('keeps newer in-memory telemetry when an older snapshot finishes later', () => {
    const currentSession = makeSessionTelemetry({
      totalInputTokens: 99,
      updatedAt: '2026-04-01T00:00:10.000Z',
    });
    const currentAccount = makeAccountTelemetry({
      fiveHourUsedPercent: 55,
      updatedAt: '2026-04-01T00:00:10.000Z',
    });

    const mergedSessions = mergeSessionTelemetrySnapshot(
      {
        'session-1': currentSession,
        'stale-session': makeSessionTelemetry({ sessionId: 'stale-session' }),
      },
      [
        makeSessionTelemetry({
          totalInputTokens: 10,
          updatedAt: '2026-04-01T00:00:05.000Z',
        }),
      ],
      '2026-04-01T00:00:08.000Z'
    );
    const mergedAccount = mergeAccountTelemetrySnapshot(
      currentAccount,
      makeAccountTelemetry({
        fiveHourUsedPercent: 20,
        updatedAt: '2026-04-01T00:00:05.000Z',
      }),
      '2026-04-01T00:00:08.000Z'
    );

    expect(Object.keys(mergedSessions).sort()).toEqual(['session-1']);
    expect(mergedSessions['session-1']).toEqual(currentSession);
    expect(mergedAccount).toEqual(currentAccount);
  });

  it('preserves a newer websocket-only session that arrived after snapshot start', () => {
    const currentSession = makeSessionTelemetry({
      sessionId: 'session-2',
      updatedAt: '2026-04-01T00:00:10.000Z',
    });

    const mergedSessions = mergeSessionTelemetrySnapshot(
      { 'session-2': currentSession },
      [],
      '2026-04-01T00:00:08.000Z'
    );

    expect(Object.keys(mergedSessions)).toEqual(['session-2']);
    expect(mergedSessions['session-2']).toEqual(currentSession);
  });
});
