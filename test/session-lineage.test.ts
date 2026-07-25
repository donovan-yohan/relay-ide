import { describe, expect, it } from 'vitest';
import { buildSessionLineage } from '../frontend/src/lib/session-lineage.js';
import { scopedSessionKey } from '../frontend/src/lib/session-keys.js';
import { makeSession } from './helpers/frontend-factories.js';

describe('buildSessionLineage', () => {
  it('nests workers directly beneath their orchestrator root', () => {
    const lineage = buildSessionLineage([
      makeSession({ id: 'worker-b', spawnedBySessionId: 'orch' }),
      makeSession({ id: 'orch', role: 'orchestrator' }),
      makeSession({ id: 'worker-a', spawnedBySessionId: 'orch' }),
    ]);

    expect(lineage.orchestrators).toHaveLength(1);
    expect(lineage.orchestrators[0]?.session.id).toBe('orch');
    expect(
      lineage.orchestrators[0]?.workers.map((session) => session.id)
    ).toEqual(['worker-a', 'worker-b']);
  });

  it('keeps workers with missing and non-orchestrator parents in ungrouped', () => {
    const lineage = buildSessionLineage([
      makeSession({ id: 'plain-parent' }),
      makeSession({ id: 'missing', spawnedBySessionId: 'gone' }),
      makeSession({
        id: 'non-orchestrator',
        spawnedBySessionId: 'plain-parent',
      }),
    ]);

    expect(lineage.orchestrators).toEqual([]);
    expect(lineage.ungrouped.map((session) => session.id)).toEqual([
      'missing',
      'non-orchestrator',
    ]);
  });

  it('preserves unparented sessions as top-level standalone rows', () => {
    const lineage = buildSessionLineage([
      makeSession({ id: 'orchestrator', role: 'orchestrator' }),
      makeSession({ id: 'standalone' }),
    ]);

    expect(lineage.standalone.map((session) => session.id)).toEqual([
      'standalone',
    ]);
  });

  it('attaches a raw parent id to its uniquely matching cross-node orchestrator', () => {
    const lineage = buildSessionLineage([
      makeSession({ id: 'orch', nodeId: 'node-a', role: 'orchestrator' }),
      makeSession({
        id: 'worker',
        nodeId: 'node-b',
        spawnedBySessionId: 'orch',
      }),
    ]);

    expect(
      lineage.orchestrators[0]?.workers.map((session) => session.id)
    ).toEqual(['worker']);
  });

  it('resolves duplicate raw parent ids to the one matching the worker node', () => {
    const lineage = buildSessionLineage([
      makeSession({ id: 'orch', nodeId: 'node-a', role: 'orchestrator' }),
      makeSession({ id: 'orch', nodeId: 'node-b', role: 'orchestrator' }),
      makeSession({
        id: 'worker',
        nodeId: 'node-b',
        spawnedBySessionId: 'orch',
      }),
    ]);

    expect(
      lineage.orchestrators.find((root) => root.session.nodeId === 'node-a')
        ?.workers
    ).toEqual([]);
    expect(
      lineage.orchestrators
        .find((root) => root.session.nodeId === 'node-b')
        ?.workers.map((session) => session.id)
    ).toEqual(['worker']);
  });

  it('keeps an ambiguous duplicate raw parent id ungrouped', () => {
    const lineage = buildSessionLineage([
      makeSession({ id: 'orch', nodeId: 'node-a', role: 'orchestrator' }),
      makeSession({ id: 'orch', nodeId: 'node-b', role: 'orchestrator' }),
      makeSession({
        id: 'worker',
        nodeId: 'node-c',
        spawnedBySessionId: 'orch',
      }),
    ]);

    expect(lineage.ungrouped.map((session) => session.id)).toEqual(['worker']);
  });

  it('uses an exact scoped parent key before raw-id fallback', () => {
    const lineage = buildSessionLineage([
      makeSession({ id: 'orch', nodeId: 'node-a', role: 'orchestrator' }),
      makeSession({ id: 'orch', nodeId: 'node-b', role: 'orchestrator' }),
      makeSession({
        id: 'worker',
        nodeId: 'node-c',
        spawnedBySessionId: 'node-b:orch',
      }),
    ]);

    expect(
      lineage.orchestrators
        .find((root) => root.session.nodeId === 'node-b')
        ?.workers.map((session) => session.id)
    ).toEqual(['worker']);
  });

  it('keeps an empty parent pointer in ungrouped rather than treating it as absent', () => {
    const lineage = buildSessionLineage([
      makeSession({ id: 'orch', role: 'orchestrator' }),
      makeSession({ id: 'empty-parent', spawnedBySessionId: '' }),
    ]);

    expect(lineage.standalone).toEqual([]);
    expect(lineage.ungrouped.map((session) => session.id)).toEqual([
      'empty-parent',
    ]);
  });

  it('uses createdAt, displayName, then id for deterministic ordering', () => {
    const lineage = buildSessionLineage([
      makeSession({
        id: 'zeta',
        displayName: 'same',
        createdAt: '2026-07-02T00:00:00Z',
      }),
      makeSession({
        id: 'beta',
        displayName: 'beta',
        createdAt: '2026-07-01T00:00:00Z',
      }),
      makeSession({
        id: 'alpha',
        displayName: 'alpha',
        createdAt: '2026-07-02T00:00:00Z',
      }),
      makeSession({
        id: 'alpha-tie',
        displayName: 'same',
        createdAt: '2026-07-02T00:00:00Z',
      }),
    ]);

    expect(lineage.standalone.map((session) => session.id)).toEqual([
      'beta',
      'alpha',
      'alpha-tie',
      'zeta',
    ]);
  });

  it('uses the scoped key to break same-name, same-time duplicate raw-id ties', () => {
    const lineage = buildSessionLineage([
      makeSession({
        id: 'duplicate',
        nodeId: 'node-b',
        displayName: 'same',
        createdAt: '2026-07-02T00:00:00Z',
      }),
      makeSession({
        id: 'duplicate',
        nodeId: 'node-a',
        displayName: 'same',
        createdAt: '2026-07-02T00:00:00Z',
      }),
    ]);

    expect(lineage.standalone.map(scopedSessionKey)).toEqual([
      'node-a:duplicate',
      'node-b:duplicate',
    ]);
  });
});
