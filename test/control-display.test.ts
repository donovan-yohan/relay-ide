import { describe, expect, it } from 'vitest';
import type { InterventionRecord } from '../shared/control-state.js';
import {
  interventionLabel,
  interventionTitle,
  mergeInterventions,
} from '../frontend/src/lib/control-display.js';

const intervention = (
  overrides: Partial<InterventionRecord>
): InterventionRecord => ({
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
  modeBefore: 'human-driven',
  ...overrides,
});

describe('intervention display helpers', () => {
  it('labels terminal intervention kinds without ownership-mode copy', () => {
    expect(interventionLabel(intervention({ kind: 'human-input' }))).toBe(
      'input'
    );
    expect(
      interventionLabel(
        intervention({
          source: 'supervisor-action',
          kind: 'supervisor-send-text',
        })
      )
    ).toBe('sent text');
    const title = interventionTitle(intervention({ payloadPreview: 'yes' }));
    expect(title).toContain('input by Kyle');
    expect(title).toContain('payload redacted');
    expect(title).not.toContain('driven');
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
