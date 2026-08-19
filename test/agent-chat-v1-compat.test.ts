import { describe, expect, it } from 'vitest';
import {
  mapAgentPatchV2ToChatEvents,
  mapChatEventToAgentPatchV2,
} from '../shared/agent-chat-v1-compat.js';
import {
  applyAgentPatchV2,
  emptyAgentSessionV2,
  type AgentPatchV2,
  type AgentSessionV2,
} from '../shared/agent-chat-protocol-v2.js';
import type { ChatEvent } from '../shared/chat-events.js';

const timestamp = '2026-04-25T00:00:00.000Z';

function reduceCompatEvents(events: ChatEvent[]): AgentSessionV2 {
  let session = emptyAgentSessionV2({
    id: 'session-1',
    provider: 'opencode',
    cwd: '/workspace/example',
  });
  session = applyAgentPatchV2(session, {
    type: 'agent-turn-started-v2',
    sessionId: 'session-1',
    timestamp,
    turn: {
      id: 'turn-1',
      status: 'running',
      inputMessageId: 'input-1',
      items: [],
      startedAt: timestamp,
    },
  });
  for (const event of events) {
    for (const patch of mapChatEventToAgentPatchV2(event)) {
      session = applyAgentPatchV2(session, patch);
    }
  }
  return session;
}

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
        metadata: { source: 'claude' },
      },
    ]);
  });

  it('maps a provider-session event to a session-updated providerSession patch', () => {
    const event: ChatEvent = {
      type: 'chat:provider-session',
      sessionId: 'session-1',
      timestamp,
      source: 'hermes',
      providerSession: { hermesResponseId: 'resp_abc' },
    };

    expect(mapChatEventToAgentPatchV2(event)).toEqual([
      {
        type: 'agent-session-updated-v2',
        sessionId: 'session-1',
        timestamp,
        providerSession: { hermesResponseId: 'resp_abc' },
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
          supported: {
            scopes: ['once'],
            amendmentTypes: [],
            canCancel: false,
          },
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

  it('maps v1 turn completion to a terminal v2 turn patch', () => {
    const event: ChatEvent = {
      type: 'chat:turn-completed',
      sessionId: 'session-1',
      timestamp,
      source: 'opencode',
      turnId: 'turn-1',
      reason: 'interrupted',
      durationMs: 42,
      toolCallCount: 0,
      messageCount: 1,
    };

    expect(mapChatEventToAgentPatchV2(event)).toEqual([
      {
        type: 'agent-turn-completed-v2',
        sessionId: 'session-1',
        timestamp,
        turnId: 'turn-1',
        status: 'interrupted',
        completedAt: timestamp,
        durationMs: 42,
      },
    ]);
  });

  // #1411 (inverted): this test used to pin the DEFECT — a `chat:error`
  // carrying a turnId mapped to an error patch AND a synthesized terminal, so a
  // hermes failure (which also fires `chat:turn-completed`) ended one turn
  // twice. The mapper is now a faithful one-event-to-its-own-patches function;
  // `LegacyProtocolAdapterV2Bridge` owns the single terminal patch, and
  // `test/server/protocol-adapters/legacy-v2-bridge.test.ts` holds it to that.
  it('maps a v1 error to an error patch only — never a terminal turn patch', () => {
    const event: ChatEvent = {
      type: 'chat:error',
      sessionId: 'session-1',
      timestamp,
      source: 'opencode',
      turnId: 'turn-1',
      kind: 'unknown',
      message: 'OpenCode failed',
      retryable: true,
    };

    expect(mapChatEventToAgentPatchV2(event)).toEqual([
      {
        type: 'agent-error-v2',
        sessionId: 'session-1',
        timestamp,
        message: 'OpenCode failed',
      },
    ]);
  });

  it('maps v1 idle status to a v2 idle live state', () => {
    const event: ChatEvent = {
      type: 'chat:session-status',
      sessionId: 'session-1',
      timestamp,
      source: 'opencode',
      status: 'idle',
    };

    expect(mapChatEventToAgentPatchV2(event)).toEqual([
      {
        type: 'agent-live-state-updated-v2',
        sessionId: 'session-1',
        timestamp,
        live: {
          status: 'idle',
          activeTurnId: null,
          waitingOn: null,
          activeRequestIds: [],
          error: null,
        },
      },
    ]);
  });

  it('maps v1 tool-call events to a dynamicToolCall item update', () => {
    const event: ChatEvent = {
      type: 'chat:tool-call',
      sessionId: 'session-1',
      timestamp,
      source: 'hermes',
      turnId: 'turn-1',
      toolCallId: 'call-1',
      toolName: 'read_file',
      description: '',
      input: { path: 'a.txt' },
      status: 'completed',
    };

    expect(mapChatEventToAgentPatchV2(event)).toEqual([
      {
        type: 'agent-item-updated-v2',
        sessionId: 'session-1',
        timestamp,
        turnId: 'turn-1',
        item: {
          type: 'dynamicToolCall',
          id: 'tool-call-1',
          namespace: 'hermes',
          tool: 'read_file',
          arguments: { path: 'a.txt' },
          status: 'completed',
          metadata: { source: 'hermes' },
        },
      },
    ]);
  });

  it('maps v1 tool-result events to terminal content deltas keyed by the same tool item id', () => {
    const event: ChatEvent = {
      type: 'chat:tool-result',
      sessionId: 'session-1',
      timestamp,
      source: 'hermes',
      turnId: 'turn-1',
      toolCallId: 'call-1',
      toolName: 'read_file',
      status: 'completed',
      output: 'file contents',
      durationMs: 12,
    };

    expect(mapChatEventToAgentPatchV2(event)).toEqual([
      {
        type: 'agent-item-delta-v2',
        sessionId: 'session-1',
        timestamp,
        turnId: 'turn-1',
        itemId: 'tool-call-1',
        delta: {
          content: 'file contents',
          status: 'completed',
          durationMs: 12,
        },
      },
    ]);
  });

  it('keeps a terminal tool-result update even when it has no body', () => {
    const event: ChatEvent = {
      type: 'chat:tool-result',
      sessionId: 'session-1',
      timestamp,
      source: 'hermes',
      turnId: 'turn-1',
      toolCallId: 'call-1',
      toolName: 'read_file',
      status: 'completed',
      durationMs: 12,
    };

    expect(mapChatEventToAgentPatchV2(event)).toEqual([
      {
        type: 'agent-item-delta-v2',
        sessionId: 'session-1',
        timestamp,
        turnId: 'turn-1',
        itemId: 'tool-call-1',
        delta: { status: 'completed', durationMs: 12 },
      },
    ]);
  });

  it('finishes an OpenCode-shaped command result on the original stable item', () => {
    const session = reduceCompatEvents([
      {
        type: 'chat:tool-call',
        sessionId: 'session-1',
        timestamp,
        source: 'opencode',
        turnId: 'turn-1',
        toolCallId: 'bash-1',
        toolName: 'bash',
        description: '',
        input: { command: 'npm test' },
        status: 'running',
      },
      {
        type: 'chat:tool-result',
        sessionId: 'session-1',
        timestamp,
        source: 'opencode',
        turnId: 'turn-1',
        toolCallId: 'bash-1',
        toolName: 'bash',
        status: 'completed',
        output: 'PASS\n',
        exitCode: 0,
        durationMs: 42,
      },
    ]);

    expect(session.turns[0]?.items).toHaveLength(1);
    expect(session.turns[0]?.items[0]).toMatchObject({
      id: 'tool-bash-1',
      type: 'commandExecution',
      command: 'npm test',
      output: 'PASS\n',
      status: 'completed',
      exitCode: 0,
      durationMs: 42,
      card: { kind: 'output', status: 'completed', content: 'PASS\n' },
    });
  });

  it('fails an OpenCode-shaped tool result with its error on the original stable item', () => {
    const session = reduceCompatEvents([
      {
        type: 'chat:tool-call',
        sessionId: 'session-1',
        timestamp,
        source: 'opencode',
        turnId: 'turn-1',
        toolCallId: 'read-1',
        toolName: 'read_file',
        description: '',
        input: { path: '/workspace/example/missing.ts' },
        status: 'running',
      },
      {
        type: 'chat:tool-result',
        sessionId: 'session-1',
        timestamp,
        source: 'opencode',
        turnId: 'turn-1',
        toolCallId: 'read-1',
        toolName: 'read_file',
        status: 'error',
        durationMs: 7,
        error: 'synthetic missing file',
      },
    ]);

    expect(session.turns[0]?.items).toHaveLength(1);
    expect(session.turns[0]?.items[0]).toMatchObject({
      id: 'tool-read-1',
      type: 'dynamicToolCall',
      arguments: { path: '/workspace/example/missing.ts' },
      content: 'synthetic missing file',
      status: 'failed',
      error: 'synthetic missing file',
      card: {
        kind: 'tool_call',
        status: 'failed',
      },
    });
  });

  it('maps a tagged legacy file edit onto the same durable tool entity', () => {
    const event: ChatEvent = {
      type: 'chat:file-change',
      sessionId: 'session-1',
      timestamp,
      source: 'hermes',
      turnId: 'turn-1',
      toolCallId: 'call-1',
      path: 'demo.ts',
      kind: 'modified',
      additions: 1,
      deletions: 1,
      diff: '@@ -1 +1 @@\n-old\n+new\n',
    };

    expect(mapChatEventToAgentPatchV2(event)).toEqual([
      {
        type: 'agent-item-updated-v2',
        sessionId: 'session-1',
        timestamp,
        turnId: 'turn-1',
        item: {
          type: 'fileChange',
          id: 'tool-call-1',
          providerItemId: 'call-1',
          paths: [{ path: 'demo.ts', status: 'modified' }],
          patch: '@@ -1 +1 @@\n-old\n+new\n',
          status: 'completed',
          metadata: {
            source: 'hermes',
            additions: 1,
            deletions: 1,
            contentKind: 'diff',
          },
        },
      },
    ]);
  });

  it('maps v1 reasoning events to a reasoning item update', () => {
    const event: ChatEvent = {
      type: 'chat:reasoning',
      sessionId: 'session-1',
      timestamp,
      source: 'hermes',
      turnId: 'turn-1',
      messageId: 'reasoning-turn-1',
      content: 'Thinking it through',
      isDelta: false,
    };

    expect(mapChatEventToAgentPatchV2(event)).toEqual([
      {
        type: 'agent-item-updated-v2',
        sessionId: 'session-1',
        timestamp,
        turnId: 'turn-1',
        item: {
          type: 'reasoning',
          id: 'reasoning-turn-1',
          summary: 'Thinking it through',
          visibility: 'summary',
          status: 'completed',
          metadata: { source: 'hermes' },
        },
      },
    ]);
  });

  it('maps v2 assistant message deltas back to v1 text deltas with preserved source for legacy UI', () => {
    const patch: AgentPatchV2 & { metadata: { source: 'opencode' } } = {
      type: 'agent-item-delta-v2',
      sessionId: 'session-1',
      timestamp,
      turnId: 'turn-1',
      itemId: 'message-1',
      delta: { text: 'hello' },
      metadata: { source: 'opencode' },
    };

    expect(mapAgentPatchV2ToChatEvents(patch)).toEqual([
      {
        type: 'chat:text-delta',
        sessionId: 'session-1',
        timestamp,
        source: 'opencode',
        turnId: 'turn-1',
        messageId: 'message-1',
        delta: 'hello',
      },
    ]);
  });
});
