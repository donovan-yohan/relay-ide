import { describe, expect, it } from 'vitest';
import type { InterventionRecord } from '../shared/control-state.js';
import {
  clampInterventionLimit,
  createAgentDrivenInitialControlState,
  evaluateControlCapabilityPlaceholder,
  toInterventionReadResponse,
  validateAgentHandBackAck,
} from '../server/session-control-api.js';

function intervention(id: string, timestamp = `2026-05-16T00:00:0${id.length}.000Z`): InterventionRecord {
  return {
    id,
    sessionId: 'session-1',
    tabId: 'local:session-1',
    nodeId: 'local',
    globalSessionId: 'local:session-1',
    cwd: '/tmp/work',
    timestamp,
    author: { kind: 'human', id: 'local-user', displayName: 'Local user' },
    source: 'pty-input',
    kind: 'human-input',
    payloadPreview: id === 'secret' ? '[redacted:secret-like] bytes=40 sha256=abcdef123456' : `preview-${id}`,
    redaction: {
      redacted: id === 'secret',
      byteCount: 10 + id.length,
      charCount: id.length,
      lineCount: 1,
      hashSha256: `hash-${id}`,
      classes: id === 'secret' ? ['secret-like'] : ['plain-text'],
    },
    modeBefore: 'agent-driven',
    modeAfter: 'co-driven',
  };
}

describe('session control API helpers', () => {
  it('creates fresh agent-driven control state for new agent sessions', () => {
    expect(
      createAgentDrivenInitialControlState({
        workerId: 'worker-session-1',
        displayName: 'Ebi backend worker',
      })
    ).toEqual({
      controlMode: 'agent-driven',
      activeActors: [
        {
          kind: 'agent',
          id: 'worker-session-1',
          displayName: 'Ebi backend worker',
        },
      ],
      activeWorker: {
        kind: 'agent',
        id: 'worker-session-1',
        displayName: 'Ebi backend worker',
      },
      lastInterventionAt: null,
      lastInterventionBy: null,
      lastInterventionEventId: null,
      controlFreshness: 'fresh',
      controlReason: 'requested-initial-agent-driven',
    });
  });

  it('returns bounded intervention history with redaction metadata but no raw payload dump', () => {
    const response = toInterventionReadResponse({
      records: [intervention('newest'), intervention('secret'), intervention('oldest')],
      limit: 2,
    });

    expect(response.limit).toBe(2);
    expect(response.count).toBe(2);
    expect(response.truncated).toBe(true);
    expect(response.rawPayloadAvailable).toBe(false);
    expect(response.transcriptExportAvailable).toBe(false);
    expect(response.interventions.map((record) => record.id)).toEqual(['newest', 'secret']);
    expect(response.interventions[1]).toMatchObject({
      payloadPreview: '[redacted:secret-like] bytes=40 sha256=abcdef123456',
      redaction: { redacted: true, classes: ['secret-like'] },
    });
    expect(JSON.stringify(response)).not.toContain('password=');
  });

  it.each([
    ['missing', undefined, 50],
    ['blank', '', 50],
    ['not-a-number', 'garbage', 50],
    ['too-small', '0', 1],
    ['negative', '-10', 1],
    ['fraction', '3.9', 3],
    ['too-large', '9999', 200],
  ])('normalizes %s intervention read limits', (_name, input, expected) => {
    expect(clampInterventionLimit(input)).toBe(expected);
  });

  it('surfaces the #427 capability placeholder and rejects explicit missing capabilities', () => {
    expect(
      evaluateControlCapabilityPlaceholder(undefined, 'tab:intervention:read')
    ).toMatchObject({ decision: 'allow', placeholder: true, capability: 'tab:intervention:read' });

    expect(
      evaluateControlCapabilityPlaceholder('session:read,session:attach', 'tab:intervention:read')
    ).toMatchObject({
      decision: 'deny',
      reasonCode: 'CAPABILITY_REQUIRED',
      capability: 'tab:intervention:read',
    });

    expect(
      evaluateControlCapabilityPlaceholder('session:read,tab:intervention:read', 'tab:mode:set-agent')
    ).toMatchObject({
      decision: 'deny',
      reasonCode: 'CAPABILITY_REQUIRED',
      capability: 'tab:mode:set-agent',
    });
  });

  it('accepts hand-back only when the caller acknowledges the latest human intervention id', () => {
    const result = validateAgentHandBackAck({
      session: {
        id: 'session-1',
        status: 'active',
        controlMode: 'co-driven',
        controlFreshness: 'fresh',
        lastInterventionEventId: 'event-2',
      },
      latestSeenInterventionEventId: 'event-2',
      unackedHumanInterventions: [intervention('event-2')],
    });

    expect(result).toEqual({ ok: true });
  });

  it.each([
    ['missing-event-id', undefined, 'HAND_BACK_ACK_REQUIRED'],
    ['old-event-id', 'event-1', 'STALE_INTERVENTION_ACK'],
  ])('rejects hand-back with %s', (_name, latestSeenInterventionEventId, reasonCode) => {
    const result = validateAgentHandBackAck({
      session: {
        id: 'session-1',
        status: 'active',
        controlMode: 'co-driven',
        controlFreshness: 'fresh',
        lastInterventionEventId: 'event-2',
      },
      latestSeenInterventionEventId,
      unackedHumanInterventions: [intervention('event-2')],
    });

    expect(result).toMatchObject({ ok: false, error: { reasonCode } });
  });

  it.each([
    ['disconnected', { status: 'disconnected', controlFreshness: 'fresh' }, 'SESSION_DISCONNECTED'],
    ['stale', { status: 'active', controlFreshness: 'stale' }, 'CONTROL_STATE_STALE'],
    ['unknown', { status: 'active', controlFreshness: 'unknown' }, 'CONTROL_STATE_UNKNOWN'],
    ['old-session-default', { status: 'active', controlFreshness: undefined }, 'CONTROL_STATE_UNKNOWN'],
  ])('rejects hand-back for %s sessions with typed errors', (_name, overrides, reasonCode) => {
    const result = validateAgentHandBackAck({
      session: {
        id: 'session-1',
        status: overrides.status as 'active' | 'disconnected',
        controlMode: 'co-driven',
        controlFreshness: overrides.controlFreshness as 'fresh' | 'stale' | 'unknown' | undefined,
        lastInterventionEventId: 'event-2',
      },
      latestSeenInterventionEventId: 'event-2',
      unackedHumanInterventions: [intervention('event-2')],
    });

    expect(result).toMatchObject({ ok: false, error: { reasonCode } });
  });

  it('rejects hand-back when no unacked human intervention is pending', () => {
    const result = validateAgentHandBackAck({
      session: {
        id: 'session-1',
        status: 'active',
        controlMode: 'co-driven',
        controlFreshness: 'fresh',
        lastInterventionEventId: 'event-2',
      },
      latestSeenInterventionEventId: 'event-2',
      unackedHumanInterventions: [],
    });

    expect(result).toMatchObject({ ok: false, error: { reasonCode: 'NO_UNACKED_HUMAN_INTERVENTION' } });
  });
});
