import { describe, expect, test } from 'vitest';

import type { DecoratedInboxMessage } from '../frontend/src/lib/api.js';
import {
  buildSessionMailboxMessage,
  buildSessionMailboxSummary,
} from '../frontend/src/lib/session-mailbox.js';

function msg(
  input: Partial<DecoratedInboxMessage> & Pick<DecoratedInboxMessage, 'id'>
): DecoratedInboxMessage {
  return {
    targetSessionId: 'local:session-1',
    contextPacketIds: [],
    state: 'queued',
    createdBy: 'relayctl',
    createdAt: '2026-06-01T00:00:00.000Z',
    ...input,
  } as DecoratedInboxMessage;
}

describe('session mailbox projection', () => {
  test('classifies relay notify notes as unread session-bound attention', () => {
    const projected = buildSessionMailboxMessage(
      msg({
        id: 'im:notify',
        state: 'delivered',
        contextPacketIds: ['cp:notify'],
        contextPackets: [
          {
            id: 'cp:notify',
            kind: 'note',
            note: '[attention:review] check the failing pane',
            createdBy: 'relayctl',
            createdAt: '2026-06-01T00:00:00.000Z',
          },
        ],
      })
    );

    expect(projected.kind).toBe('attention');
    expect(projected.attentionKind).toBe('review');
    expect(projected.priority).toBe('attention');
    expect(projected.unread).toBe(true);
    expect(projected.ackable).toBe(true);
    expect(projected.body).toBe('check the failing pane');
  });

  test('classifies decision requests as critical until resolved', () => {
    const open = buildSessionMailboxMessage(
      msg({
        id: 'im:decision',
        state: 'queued',
        text: '[decision:pending] pick claude or codex for pane 2',
      })
    );
    const closed = buildSessionMailboxMessage(
      msg({
        id: 'im:decision',
        state: 'resolved',
        text: '[decision:pending] pick claude or codex for pane 2',
      })
    );

    expect(open.kind).toBe('decision');
    expect(open.priority).toBe('critical');
    expect(open.resolvable).toBe(true);
    expect(closed.priority).toBe('quiet');
    expect(closed.open).toBe(false);
  });

  test('renders log/file refs as safe artifact summaries without file bytes', () => {
    const projected = buildSessionMailboxMessage(
      msg({
        id: 'im:artifact',
        state: 'acknowledged',
        contextPacketIds: ['cp:log'],
        contextPackets: [
          {
            id: 'cp:log',
            kind: 'log-ref',
            fileRef: {
              nodeId: 'local',
              path: '/tmp/relay/session.log',
              capturedAt: '2026-06-01T00:00:00.000Z',
              intent: 'read',
            },
            note: 'terminal transcript',
            createdBy: 'relayctl',
            createdAt: '2026-06-01T00:00:00.000Z',
          },
        ],
      })
    );

    expect(projected.kind).toBe('artifact');
    expect(projected.artifacts).toEqual([
      {
        packetId: 'cp:log',
        kind: 'log-ref',
        path: '/tmp/relay/session.log',
        label: 'terminal transcript',
      },
    ]);
    expect(projected.body).toBe('terminal transcript');
  });

  test('summarizes unread/open priority before older quiet messages', () => {
    const summary = buildSessionMailboxSummary([
      msg({
        id: 'im:old',
        state: 'acknowledged',
        text: 'already read',
        createdAt: '2026-06-01T00:05:00.000Z',
      }),
      msg({
        id: 'im:decision',
        state: 'queued',
        text: '[decision:pending] choose runtime',
        createdAt: '2026-06-01T00:01:00.000Z',
      }),
      msg({
        id: 'im:attention',
        state: 'delivered',
        text: '[attention:notify] stdout changed',
        createdAt: '2026-06-01T00:03:00.000Z',
      }),
    ]);

    expect(summary.priority).toBe('critical');
    expect(summary.unreadCount).toBe(2);
    expect(summary.openCount).toBe(3);
    expect(summary.decisionCount).toBe(1);
    expect(summary.attentionCount).toBe(1);
    expect(summary.latestPreview).toBe('choose runtime');
    expect(summary.messages.map((message) => message.id)).toEqual([
      'im:decision',
      'im:attention',
      'im:old',
    ]);
  });
});
