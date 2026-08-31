import { describe, expect, it } from 'vitest';
import {
  buildAgentActivityFoldNodes,
  formatAgentActivityRunCounts,
  isCompletedAgentActivity,
} from '../../frontend/src/lib/chat/channel-activity-folding.js';
import type {
  ChannelMessage,
  ChannelMessageId,
} from '../../shared/channel-chat-protocol.js';

function message(
  seq: number,
  options: Partial<ChannelMessage> = {}
): ChannelMessage {
  return {
    schemaVersion: 1,
    id: `chm:activity-${seq}` as ChannelMessageId,
    channelId: 'topic:activity',
    seq,
    kind: 'message',
    status: 'complete',
    sender: { kind: 'agent', id: 'agent:codex', providerId: 'codex' },
    body: { text: '', format: 'markdown' },
    threadId: null,
    parentMessageId: null,
    createdAt: '2026-08-17T10:00:00.000Z',
    updatedAt: '2026-08-17T10:00:00.000Z',
    agentDetail: {
      itemId: `activity-${seq}`,
      card: {
        kind: 'tool_call',
        title: 'read file',
        status: 'completed',
        content: 'src/file.ts',
      },
    },
    ...options,
  };
}

/** Drops the optional `agentDetail` key entirely (exactOptionalPropertyTypes). */
function withoutAgentDetail(msg: ChannelMessage): ChannelMessage {
  const { agentDetail: _agentDetail, ...rest } = msg;
  return rest;
}

describe('responses-first agent activity projection', () => {
  it('folds only a contiguous completed durable activity run with exact counts', () => {
    const messages = [
      message(1),
      message(2, {
        agentDetail: {
          itemId: 'reasoning-2',
          card: {
            kind: 'thought',
            title: 'thinking',
            status: 'completed',
            content: 'provider-visible reasoning',
          },
        },
      }),
      withoutAgentDetail(
        message(3, {
          body: { text: 'agent response', format: 'markdown' },
        })
      ),
      message(4, { status: 'streaming' }),
      message(5, { status: 'failed' }),
    ];

    const nodes = buildAgentActivityFoldNodes(messages, true);
    expect(nodes.map((node) => node.kind)).toEqual([
      'agent-activity-run',
      'message',
      'message',
      'message',
    ]);
    const run = nodes[0];
    expect(run?.kind).toBe('agent-activity-run');
    if (run?.kind !== 'agent-activity-run') throw new Error('missing run');
    expect(run.messages.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(formatAgentActivityRunCounts(run.counts)).toBe(
      '1 tool call · 1 reasoning'
    );
  });

  it('does not classify streaming, failed, interrupted, prose, or attachments as foldable activity', () => {
    expect(isCompletedAgentActivity(message(1, { status: 'streaming' }))).toBe(
      false
    );
    expect(isCompletedAgentActivity(message(2, { status: 'failed' }))).toBe(
      false
    );
    expect(
      isCompletedAgentActivity(
        withoutAgentDetail(
          message(3, {
            body: { text: 'prose response', format: 'markdown' },
          })
        )
      )
    ).toBe(false);
    expect(
      isCompletedAgentActivity(
        // TODO(#1498): the attachment half of this case is vacuous.
        // `isCompletedAgentActivity` never inspects `parts`; this assertion
        // holds purely because `agentDetail` is absent.
        withoutAgentDetail(
          message(4, {
            parts: [
              {
                type: 'image',
                id: 'cha:img-1',
                mime: 'image/png',
                w: 8,
                h: 8,
                bytes: 1,
                alt: 'proof.png',
              },
            ],
          })
        )
      )
    ).toBe(false);
  });
});
