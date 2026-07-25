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

function agentMessage(input: Partial<ChannelMessage>): ChannelMessage {
  return {
    schemaVersion: 1,
    id: 'chm:agent-card' as ChannelMessageId,
    channelId: 'topic:eng-threads',
    seq: 2,
    kind: 'message',
    status: 'complete',
    sender: {
      kind: 'agent',
      id: 'agent:codex',
      providerId: 'codex',
    },
    body: { text: '', format: 'markdown' },
    threadId: null,
    parentMessageId: null,
    createdAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:00:00.000Z',
    ...input,
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

  it('renders a persisted reasoning card collapsed and expands its content', async () => {
    await act(async () => {
      root.render(
        React.createElement(ChannelMessageRow, {
          message: agentMessage({
            agentDetail: {
              itemId: 'reason-1',
              card: {
                kind: 'thought',
                title: 'inspect the channel renderer',
                status: 'completed',
                content: 'reasoning content survives channel persistence',
              },
            },
          }),
          channelId: 'topic:eng-threads',
        })
      );
    });

    const toggle = container.querySelector<HTMLButtonElement>(
      '.ch-agent-card__toggle'
    );
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.ch-agent-card__body')).toBeNull();
    await act(async () => toggle?.click());
    expect(
      container.querySelector('.ch-agent-card__body')?.textContent
    ).toContain('reasoning content survives channel persistence');
  });

  it('rerenders authoritative streaming card rows without overriding persisted status', async () => {
    const row = (status: 'pending' | 'running', content: string) =>
      agentMessage({
        status: 'streaming',
        agentDetail: {
          itemId: 'reason-live',
          card: {
            kind: 'thought',
            title: 'thinking',
            status,
            content,
          },
        },
      });
    await act(async () => {
      root.render(
        React.createElement(ChannelMessageRow, {
          message: row('pending', 'first persisted row'),
          channelId: 'topic:eng-threads',
        })
      );
    });
    expect(container.querySelector('.ch-agent-card__status')?.textContent).toBe(
      'pending'
    );
    const toggle = container.querySelector<HTMLButtonElement>(
      '.ch-agent-card__toggle'
    );
    await act(async () => toggle?.click());
    expect(
      container.querySelector('.ch-agent-card__body')?.textContent
    ).toContain('first persisted row');

    await act(async () => {
      root.render(
        React.createElement(ChannelMessageRow, {
          message: row('running', 'authoritative debounced row'),
          channelId: 'topic:eng-threads',
        })
      );
    });
    expect(container.querySelector('.ch-agent-card__status')?.textContent).toBe(
      'running'
    );
    expect(
      container.querySelector('.ch-agent-card__body')?.textContent
    ).toContain('authoritative debounced row');
  });

  it('collapses agent-authored markdown fences into bounded output and diff cards', async () => {
    const output = Array.from(
      { length: 500 },
      (_, index) => `const line${index + 1} = ${index + 1};`
    ).join('\n');
    const diff = [
      '--- a/example.ts',
      '+++ b/example.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n');
    await act(async () => {
      root.render(
        React.createElement(ChannelMessageRow, {
          message: agentMessage({
            body: {
              format: 'markdown',
              text: `report\n\n\`\`\`typescript\n${output}\n\`\`\`\n\n\`\`\`diff\n${diff}\n\`\`\``,
            },
          }),
          channelId: 'topic:eng-threads',
        })
      );
    });

    const cards = container.querySelectorAll('.ch-agent-card');
    expect(cards).toHaveLength(2);
    expect(cards[0]?.getAttribute('data-agent-card-kind')).toBe('output');
    expect(
      cards[0]?.querySelector('.ch-agent-card__toggle')?.textContent
    ).toContain('500 lines');
    expect(cards[1]?.getAttribute('data-agent-card-kind')).toBe('diff');
    expect(
      cards[1]?.querySelector('.ch-agent-card__toggle')?.textContent
    ).toContain('+1 -1');
    expect(container.querySelectorAll('.ch-agent-card__body')).toHaveLength(0);

    const diffToggle = cards[1]?.querySelector<HTMLButtonElement>(
      '.ch-agent-card__toggle'
    );
    await act(async () => diffToggle?.click());
    expect(
      cards[1]?.querySelectorAll('.ch-agent-card__line--added')
    ).toHaveLength(1);
    expect(
      cards[1]?.querySelectorAll('.ch-agent-card__line--removed')
    ).toHaveLength(1);
  });
});
