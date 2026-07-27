import { describe, expect, it } from 'vitest';
import type { InterventionRecord } from '../shared/control-state.js';
import {
  clampInterventionLimit,
  createHumanDrivenInitialControlState,
  evaluateControlCapabilityPlaceholder,
  toInterventionReadResponse,
} from '../server/session-control-api.js';

function intervention(id: string): InterventionRecord {
  return {
    id,
    sessionId: 'session-1',
    tabId: 'local:session-1',
    nodeId: 'local',
    globalSessionId: 'local:session-1',
    cwd: '/tmp/work',
    timestamp: '2026-05-16T00:00:00.000Z',
    author: { kind: 'human', id: 'local-user' },
    source: 'pty-input',
    kind: 'human-input',
    payloadPreview: `preview-${id}`,
    redaction: {
      redacted: false,
      byteCount: id.length,
      charCount: id.length,
      lineCount: 1,
      hashSha256: `hash-${id}`,
      classes: ['plain-text'],
    },
    modeBefore: 'human-driven',
    modeAfter: 'human-driven',
  };
}

describe('session control API helpers', () => {
  it('creates fresh human-driven state for terminal sessions', () => {
    expect(
      createHumanDrivenInitialControlState({
        sessionId: 'remote-session-1',
        displayName: 'mac node terminal',
      })
    ).toEqual({
      controlMode: 'human-driven',
      activeActors: [
        {
          kind: 'human',
          id: 'browser-user',
          displayName: 'mac node terminal',
          sessionId: 'remote-session-1',
        },
      ],
      lastInterventionAt: null,
      lastInterventionBy: null,
      lastInterventionEventId: null,
      controlFreshness: 'fresh',
      controlReason: 'routed-session-created',
    });
  });

  it('returns bounded intervention history without raw payloads', () => {
    const response = toInterventionReadResponse({
      records: [
        intervention('newest'),
        intervention('middle'),
        intervention('oldest'),
      ],
      limit: 2,
    });
    expect(response).toMatchObject({
      limit: 2,
      count: 2,
      truncated: true,
      rawPayloadAvailable: false,
      transcriptExportAvailable: false,
    });
    expect(response.interventions.map((record) => record.id)).toEqual([
      'newest',
      'middle',
    ]);
  });

  it.each([
    [undefined, 50],
    ['', 50],
    ['garbage', 50],
    ['0', 1],
    ['3.9', 3],
    ['9999', 200],
  ])('normalizes intervention read limit %j', (input, expected) => {
    expect(clampInterventionLimit(input)).toBe(expected);
  });

  it('rejects an explicitly missing intervention-read capability', () => {
    expect(
      evaluateControlCapabilityPlaceholder(
        'session:read,session:attach',
        'tab:intervention:read'
      )
    ).toMatchObject({
      decision: 'deny',
      reasonCode: 'CAPABILITY_REQUIRED',
      capability: 'tab:intervention:read',
    });
  });
});
