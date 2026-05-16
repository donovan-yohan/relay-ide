import { describe, expect, it } from 'vitest';
import type { InterventionRecord } from '../shared/control-state.js';
import type { SessionSummary } from '../frontend/src/lib/types.js';
import {
  canHandBackToAgent,
  controlBadgeView,
  mergeInterventions,
} from '../frontend/src/lib/control-display.js';

const session = (overrides: Partial<SessionSummary>): SessionSummary => ({
  id: 's1',
  type: 'agent',
  agent: 'codex',
  repoName: 'relay-ide',
  repoPath: '/repo/relay-ide',
  worktreePath: null,
  cwd: '/repo/relay-ide',
  branchName: 'nightly',
  displayName: 'agent tab',
  createdAt: '2026-05-16T00:00:00.000Z',
  lastActivity: '2026-05-16T00:00:00.000Z',
  idle: false,
  ...overrides,
});

const intervention = (overrides: Partial<InterventionRecord>): InterventionRecord => ({
  id: 'event-1',
  sessionId: 's1',
  tabId: 's1',
  timestamp: '2026-05-16T00:01:00.000Z',
  author: { kind: 'human', id: 'human-1', displayName: 'Kyle' },
  source: 'pty-input',
  kind: 'human-input',
  redaction: {
    redacted: true,
    byteCount: 12,
    charCount: 12,
    lineCount: 1,
    hashSha256: 'abc',
    classes: ['input'],
  },
  modeBefore: 'agent-driven',
  modeAfter: 'co-driven',
  ...overrides,
});

describe('control badge view', () => {
  it('maps fresh control modes to compact badge labels', () => {
    expect(
      controlBadgeView(
        session({
          controlMode: 'agent-driven',
          controlFreshness: 'fresh',
          activeActors: [{ kind: 'agent', displayName: 'codex' }],
        })
      ).label
    ).toBe('agent');
    expect(
      controlBadgeView(
        session({
          controlMode: 'human-driven',
          controlFreshness: 'fresh',
          activeActors: [{ kind: 'human', displayName: 'Kyle' }],
        })
      ).label
    ).toBe('human');
    expect(
      controlBadgeView(
        session({
          controlMode: 'co-driven',
          controlFreshness: 'fresh',
          activeActors: [
            { kind: 'agent', displayName: 'codex' },
            { kind: 'human', displayName: 'Kyle' },
          ],
        })
      ).label
    ).toBe('co');
  });

  it('renders stale and unknown as control-state caution, not repo failures', () => {
    expect(
      controlBadgeView(
        session({
          controlMode: 'agent-driven',
          controlFreshness: 'stale',
          activeActors: [{ kind: 'agent', displayName: 'codex' }],
        })
      ).mode
    ).toBe('stale');
    expect(controlBadgeView(session({})).mode).toBe('unknown');
  });

  it('keeps remote/free tab details independent of repo binding', () => {
    const view = controlBadgeView(
      session({
        nodeId: 'remote-a',
        repoPath: undefined,
        worktreePath: undefined,
        cwd: '/tmp/free-shell',
        controlMode: 'co-driven',
        controlFreshness: 'fresh',
        activeActors: [{ kind: 'human', displayName: 'browser user' }],
      }),
      { label: 'remote box', status: 'online' }
    );
    expect(view.nodeSummary).toBe('remote box (online)');
    expect(view.title).not.toContain('/repo/relay-ide');
  });
});

describe('intervention control helpers', () => {
  it('only enables hand-back when recent human control is acknowledged on fresh local state', () => {
    expect(
      canHandBackToAgent(
        session({
          controlMode: 'co-driven',
          controlFreshness: 'fresh',
          lastInterventionEventId: 'event-1',
        })
      )
    ).toBe(true);
    expect(
      canHandBackToAgent(
        session({
          controlMode: 'co-driven',
          controlFreshness: 'stale',
          lastInterventionEventId: 'event-1',
        })
      )
    ).toBe(false);
    expect(
      canHandBackToAgent(
        session({
          controlMode: 'agent-driven',
          controlFreshness: 'fresh',
          lastInterventionEventId: 'event-1',
        })
      )
    ).toBe(false);
  });

  it('dedupes and sorts interventions newest first', () => {
    const records = mergeInterventions(
      [intervention({ id: 'older', timestamp: '2026-05-16T00:01:00.000Z' })],
      [
        intervention({ id: 'older', timestamp: '2026-05-16T00:01:00.000Z' }),
        intervention({ id: 'newer', timestamp: '2026-05-16T00:02:00.000Z' }),
      ]
    );
    expect(records.map((record) => record.id)).toEqual(['newer', 'older']);
  });
});
