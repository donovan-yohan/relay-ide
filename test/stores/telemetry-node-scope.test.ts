import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../frontend/src/lib/api.js', () => ({
  fetchSessionTelemetry: vi.fn(),
  fetchAccountTelemetry: vi.fn(),
  fetchTelemetrySetupStatus: vi.fn(),
}));

import type {
  SessionSummary,
  SessionTelemetry,
} from '../../frontend/src/lib/types.js';
import { useTelemetryStore } from '../../frontend/src/lib/stores/telemetry.js';

const nodeASession: SessionSummary = {
  id: 'same-local-id',
  type: 'terminal',
  mode: 'pty',
  repoName: 'relay-ide',
  repoPath: '/node-a/relay-ide',
  worktreePath: null,
  cwd: '/node-a/relay-ide',
  branchName: 'main',
  displayName: 'node a',
  createdAt: '2026-05-11T00:00:00.000Z',
  lastActivity: '2026-05-11T00:00:00.000Z',
  idle: false,
  activityState: 'idle',
  nodeId: 'node-a',
  globalSessionId: 'node-a:same-local-id',
};

const nodeBSession: SessionSummary = {
  ...nodeASession,
  repoPath: '/node-b/relay-ide',
  cwd: '/node-b/relay-ide',
  displayName: 'node b',
  nodeId: 'node-b',
  globalSessionId: 'node-b:same-local-id',
};

function makeTelemetry(
  overrides: Partial<SessionTelemetry> = {}
): SessionTelemetry {
  return {
    sessionId: 'same-local-id',
    model: 'Claude Sonnet 4',
    totalInputTokens: 10,
    totalOutputTokens: 20,
    totalCacheRead: 30,
    totalCacheWrite: 40,
    contextPercent: 12,
    contextWindowSize: 200000,
    costUsd: 0.5,
    turnCount: 1,
    subagentCount: 0,
    source: 'statusLine',
    updatedAt: '2026-05-11T00:00:00.000Z',
    ...overrides,
  };
}

describe('telemetry store node-scoped sessions', () => {
  beforeEach(() => {
    useTelemetryStore.setState({
      sessionTelemetryById: {},
      accountTelemetryByFramework: {},
      telemetrySetupInstalled: null,
    });
  });

  it('keeps telemetry separate when local session ids collide across nodes', () => {
    const state = useTelemetryStore.getState();

    state.handleSessionTelemetryEvent(
      'same-local-id',
      makeTelemetry({ totalInputTokens: 11 }),
      {
        sessionId: 'same-local-id',
        localSessionId: 'same-local-id',
        nodeId: 'node-a',
        globalSessionId: 'node-a:same-local-id',
      }
    );
    state.handleSessionTelemetryEvent(
      'same-local-id',
      makeTelemetry({ totalInputTokens: 22 }),
      {
        sessionId: 'same-local-id',
        localSessionId: 'same-local-id',
        nodeId: 'node-b',
        globalSessionId: 'node-b:same-local-id',
      }
    );

    const latest = useTelemetryStore.getState();
    expect(Object.keys(latest.sessionTelemetryById).sort()).toEqual([
      'node-a:same-local-id',
      'node-b:same-local-id',
    ]);
    expect(
      latest.summarizeSessionTelemetry(nodeASession)?.totalInputTokens
    ).toBe(11);
    expect(
      latest.summarizeSessionTelemetry(nodeBSession)?.totalInputTokens
    ).toBe(22);
    expect(
      latest.summarizeSessionSetTelemetry([nodeASession, nodeBSession])
    ).toMatchObject({
      trackedSessions: 2,
      totalSessions: 2,
      totalInputTokens: 33,
    });
  });

  it('merges and prunes batch snapshots using scoped telemetry keys', () => {
    const state = useTelemetryStore.getState();

    state.setSessionTelemetryBatch(
      [
        makeTelemetry({
          nodeId: 'node-a',
          globalSessionId: 'node-a:same-local-id',
          totalInputTokens: 11,
        }),
        makeTelemetry({
          nodeId: 'node-b',
          globalSessionId: 'node-b:same-local-id',
          totalInputTokens: 22,
        }),
      ],
      '2026-05-11T00:00:00.000Z'
    );

    expect(
      Object.keys(useTelemetryStore.getState().sessionTelemetryById).sort()
    ).toEqual(['node-a:same-local-id', 'node-b:same-local-id']);

    useTelemetryStore.getState().pruneSessionTelemetry([nodeBSession]);

    const latest = useTelemetryStore.getState();
    expect(Object.keys(latest.sessionTelemetryById)).toEqual([
      'node-b:same-local-id',
    ]);
    expect(latest.summarizeSessionTelemetry(nodeASession)).toBeNull();
    expect(
      latest.summarizeSessionTelemetry(nodeBSession)?.totalInputTokens
    ).toBe(22);
  });
});
