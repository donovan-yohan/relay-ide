import { describe, expect, it } from 'vitest';

import {
  createCliGatewayEventBus,
  eventMatchesFilter,
  type CliGatewayMetadataEvent,
} from '../server/cli-gateway-event-bus.js';
import { buildAttentionEventInput } from '../shared/agent-roster.js';

// #963 (child of #952): the `attention` topic rides the same in-memory metadata
// bus as `inbox`. These tests pin the primitives that the acceptance criteria
// call out: cursor/resume, gap/drop, scope filtering, and metadata redaction.

describe('CliGatewayEventBus cursor/resume + gap semantics', () => {
  it('replays only events after a known cursor', () => {
    const bus = createCliGatewayEventBus();
    const a = bus.publish({ topic: 'attention', type: 'attention.state-changed', payload: { n: 1 } });
    const b = bus.publish({ topic: 'attention', type: 'attention.state-changed', payload: { n: 2 } });
    const c = bus.publish({ topic: 'attention', type: 'attention.state-changed', payload: { n: 3 } });

    const resumed = bus.replay('attention', a.cursor);
    expect(resumed.replayDropped).toBe(false);
    expect(resumed.events.map((e) => e.cursor)).toEqual([b.cursor, c.cursor]);
  });

  it('returns no replay (and no gap) when no cursor is supplied', () => {
    const bus = createCliGatewayEventBus();
    bus.publish({ topic: 'attention', type: 'attention.state-changed', payload: {} });
    const fresh = bus.replay('attention');
    expect(fresh.events).toHaveLength(0);
    expect(fresh.replayDropped).toBe(false);
  });

  it('signals a gap (replayDropped) when the cursor aged out of the buffer', () => {
    const bus = createCliGatewayEventBus({ maxEventsPerTopic: 2 });
    bus.publish({ topic: 'attention', type: 'attention.state-changed', payload: { n: 1 } });
    bus.publish({ topic: 'attention', type: 'attention.state-changed', payload: { n: 2 } });
    bus.publish({ topic: 'attention', type: 'attention.state-changed', payload: { n: 3 } });

    // A cursor the buffer no longer contains -> dropped, replay all retained.
    const dropped = bus.replay('attention', 'cg:0:0');
    expect(dropped.replayDropped).toBe(true);
    expect(dropped.events).toHaveLength(2);
  });

  it('does not cross topics when replaying', () => {
    const bus = createCliGatewayEventBus();
    bus.publish({ topic: 'inbox', type: 'inbox.sent', payload: {} });
    const att = bus.publish({ topic: 'attention', type: 'attention.state-changed', payload: {} });
    const replay = bus.replay('attention', undefined);
    expect(replay.events).toHaveLength(0);
    // Sanity: the attention event is in its own buffer.
    expect(bus.replay('attention', 'cg:0:0').events.map((e) => e.cursor)).toContain(att.cursor);
  });
});

describe('eventMatchesFilter scoping', () => {
  const base: CliGatewayMetadataEvent = {
    cursor: 'cg:1:1',
    topic: 'attention',
    type: 'attention.state-changed',
    occurredAt: '2026-06-15T00:00:00.000Z',
    sessionId: 's1',
    globalSessionId: 'local:s1',
    workContextId: 'wc:1',
    repoPath: '/repo/a',
    payload: {},
    redaction: { rawPayloadIncluded: false, rawTranscriptIncluded: false, artifactBodyIncluded: false },
  };

  it('matches when filter fields equal the event', () => {
    expect(eventMatchesFilter(base, { sessionId: 's1' })).toBe(true);
    expect(eventMatchesFilter(base, { globalSessionId: 'local:s1' })).toBe(true);
    expect(eventMatchesFilter(base, { workContextId: 'wc:1' })).toBe(true);
    expect(eventMatchesFilter(base, { repoPath: '/repo/a' })).toBe(true);
  });

  it('excludes on any mismatch', () => {
    expect(eventMatchesFilter(base, { sessionId: 'other' })).toBe(false);
    expect(eventMatchesFilter(base, { repoPath: '/repo/b' })).toBe(false);
    expect(eventMatchesFilter(base, { workContextId: 'wc:2' })).toBe(false);
  });

  it('excludes events lacking repoPath when a repoPath filter is set', () => {
    const noRepo = { ...base, repoPath: undefined };
    expect(eventMatchesFilter(noRepo, { repoPath: '/repo/a' })).toBe(false);
  });
});

describe('metadata payload redaction', () => {
  it('strips secret-bearing keys from published payloads', () => {
    const bus = createCliGatewayEventBus();
    const event = bus.publish({
      topic: 'attention',
      type: 'attention.state-changed',
      payload: {
        backendState: 'permission',
        token: 'relay-sac-v1-should-not-leak',
        env: { SECRET: 'x' },
        transcript: 'raw bytes',
        needsAttention: true,
      },
    });
    expect(event.payload['backendState']).toBe('permission');
    expect(event.payload['needsAttention']).toBe(true);
    expect(event.payload).not.toHaveProperty('token');
    expect(event.payload).not.toHaveProperty('env');
    expect(event.payload).not.toHaveProperty('transcript');
    expect(event.redaction).toEqual({
      rawPayloadIncluded: false,
      rawTranscriptIncluded: false,
      artifactBodyIncluded: false,
    });
  });
});

describe('buildAttentionEventInput projection', () => {
  it('derives needs-attention from a permission-prompt transition', () => {
    const input = buildAttentionEventInput(
      {
        id: 's1',
        globalSessionId: 'local:s1',
        agent: 'claude',
        type: 'agent',
        agentState: 'permission-prompt',
        repoPath: '/repo/a',
        repoName: 'a',
        branchName: 'feat/x',
        workContextId: 'wc:1',
      },
      {
        backendState: 'permission',
        previousBackendState: 'running',
        permissionType: 'approval',
        nodeId: 'local',
      }
    );

    expect(input.topic).toBe('attention');
    expect(input.type).toBe('attention.state-changed');
    expect(input.sessionId).toBe('s1');
    expect(input.globalSessionId).toBe('local:s1');
    expect(input.workContextId).toBe('wc:1');
    expect(input.repoPath).toBe('/repo/a');
    expect(input.nodeId).toBe('local');
    expect(input.payload).toMatchObject({
      backendState: 'permission',
      previousBackendState: 'running',
      agentState: 'permission-prompt',
      needsAttention: true,
      reasons: ['permission-prompt'],
      permissionType: 'approval',
      provider: 'claude',
      role: 'implementer',
      sessionType: 'agent',
      repoName: 'a',
      branchName: 'feat/x',
    });
  });

  it('folds pending inbox backlog into attention reasons', () => {
    const input = buildAttentionEventInput(
      { id: 's2', agent: 'codex', type: 'agent', agentState: 'idle' },
      { backendState: 'idle', pendingInboxCount: 3, nodeId: 'local' }
    );
    expect(input.payload['needsAttention']).toBe(true);
    expect(input.payload['reasons']).toEqual(['pending-inbox']);
    expect(input.payload['pendingInboxCount']).toBe(3);
    expect(input.payload['role']).toBe('reviewer');
  });

  it('reports no attention for a quiet idle session', () => {
    const input = buildAttentionEventInput(
      { id: 's3', agent: 'claude', type: 'agent', agentState: 'idle' },
      { backendState: 'idle', pendingInboxCount: 0, nodeId: 'local' }
    );
    expect(input.payload['needsAttention']).toBe(false);
    expect(input.payload['reasons']).toEqual([]);
    expect(input.repoPath).toBeUndefined();
  });

  it('never carries transcript/prompt/token shaped fields', () => {
    const input = buildAttentionEventInput(
      { id: 's4', agent: 'claude', type: 'agent', agentState: 'error' },
      { backendState: 'error', nodeId: 'local' }
    );
    const serialized = JSON.stringify(input);
    expect(serialized).not.toMatch(/transcript|prompt|token|apikey|\benv\b/i);
    expect(input.payload['reasons']).toEqual(['error']);
  });
});
