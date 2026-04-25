import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  mapAgentPatchV2ToChatEvents,
  mapChatEventToAgentPatchV2,
} from '../shared/agent-chat-v1-compat.js';
import type { AgentPatchV2 } from '../shared/agent-chat-protocol-v2.js';
import type { ChatEvent } from '../shared/chat-events.js';

const timestamp = '2026-04-25T00:00:00.000Z';

describe('Agent Chat v1 compatibility bridge', () => {
  it('maps v1 text deltas to assistant message item deltas', () => {
    const event: ChatEvent = {
      type: 'chat:text-delta',
      sessionId: 'session-1',
      timestamp,
      source: 'claude',
      turnId: 'turn-1',
      messageId: 'message-1',
      delta: 'hello',
    };

    expect(mapChatEventToAgentPatchV2(event)).toEqual([
      {
        type: 'agent-item-delta-v2',
        sessionId: 'session-1',
        timestamp,
        turnId: 'turn-1',
        itemId: 'message-1',
        delta: { text: 'hello' },
      },
    ]);
  });

  it('maps v1 approval requests to an approval item and active request', () => {
    const event: ChatEvent = {
      type: 'chat:approval-request',
      sessionId: 'session-1',
      timestamp,
      source: 'codex',
      turnId: 'turn-1',
      requestId: 'request-1',
      kind: 'command',
      toolName: 'shell',
      description: 'Run tests',
      target: 'npm test',
      detail: 'from migration test',
      timeoutMs: 300_000,
    };

    expect(mapChatEventToAgentPatchV2(event)).toEqual([
      {
        type: 'agent-item-started-v2',
        sessionId: 'session-1',
        timestamp,
        turnId: 'turn-1',
        item: {
          type: 'approval',
          id: 'approval-request-1',
          requestId: 'request-1',
          kind: 'command',
          description: 'Run tests',
          target: 'npm test',
          detail: 'from migration test',
          status: 'pending',
          metadata: {
            source: 'codex',
            toolName: 'shell',
            timeoutMs: 300_000,
          },
        },
      },
      {
        type: 'agent-live-state-updated-v2',
        sessionId: 'session-1',
        timestamp,
        live: {
          status: 'waiting',
          activeTurnId: 'turn-1',
          waitingOn: 'approval',
          activeRequestIds: ['request-1'],
        },
      },
    ]);
  });

  it('maps v2 assistant message deltas back to v1 text deltas for legacy UI', () => {
    const patch: AgentPatchV2 = {
      type: 'agent-item-delta-v2',
      sessionId: 'session-1',
      timestamp,
      turnId: 'turn-1',
      itemId: 'message-1',
      delta: { text: 'hello' },
    };

    expect(mapAgentPatchV2ToChatEvents(patch)).toEqual([
      {
        type: 'chat:text-delta',
        sessionId: 'session-1',
        timestamp,
        source: 'mock',
        turnId: 'turn-1',
        messageId: 'message-1',
        delta: 'hello',
      },
    ]);
  });

  it('documents that the module is temporary and removed in Task 9', () => {
    const source = readFileSync(
      fileURLToPath(
        new URL('../shared/agent-chat-v1-compat.ts', import.meta.url)
      ),
      'utf8'
    );

    expect(source).toContain('temporary');
    expect(source).toContain('Task 9');
  });
});
