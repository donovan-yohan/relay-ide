// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

import { ChannelMessageRow } from '../../frontend/src/components/chat/ChannelMessageRow.js';
import type {
  ChannelMessage,
  ChannelMessageId,
  ChannelTruncationReason,
} from '../../shared/channel-chat-protocol.js';

function truncatedMessage(reason: ChannelTruncationReason): ChannelMessage {
  return {
    schemaVersion: 1,
    id: 'chm:truncated' as ChannelMessageId,
    channelId: 'topic:eng-threads',
    seq: 1,
    kind: 'message',
    status: 'truncated',
    sender: {
      kind: 'agent',
      id: 'agent:codex',
      providerId: 'codex',
    },
    body: { text: 'partial report', format: 'text' },
    threadId: null,
    parentMessageId: null,
    meta: { truncationReason: reason },
    ...(reason === 'size-limit' ? { truncated: true } : {}),
    createdAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:00:00.000Z',
  };
}

describe('ChannelMessageRow truncation fidelity', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it.each([
    ['missing-terminal', 'truncated · missing terminal'],
    ['restart', 'truncated · restart'],
    ['size-limit', 'truncated · 256kb limit'],
  ] as const)(
    'renders %s as a visible terminal-loss marker',
    async (reason, label) => {
      await act(async () => {
        root.render(
          React.createElement(ChannelMessageRow, {
            message: truncatedMessage(reason),
            channelId: 'topic:eng-threads',
          })
        );
      });

      expect(container.querySelector('.ch-msg--truncated')).not.toBeNull();
      const tags = container.querySelectorAll('.ch-msg__tag--truncated');
      expect(tags).toHaveLength(1);
      expect(tags[0]?.textContent).toBe(label);
    }
  );
});
