import { describe, it, expect } from 'vitest';
import {
  isChatEvent,
  isApprovalRequestEvent,
  isToolCallEvent,
  isFileChangeEvent,
  isTelemetryEvent,
  isLifecycleEvent,
} from '../shared/chat-events.js';
import type {
  ChatEvent,
  TextDeltaEvent,
  ToolCallEvent,
  ApprovalRequestEvent,
  FileChangeEvent,
  TelemetryEvent,
  SessionStartedEvent,
  TurnStartedEvent,
  TurnCompletedEvent,
  SessionStatusEvent,
  ErrorEvent,
} from '../shared/chat-events.js';

const BASE = {
  sessionId: 'test-session',
  timestamp: new Date().toISOString(),
  source: 'claude' as const,
};

function makeTextDelta(overrides?: Partial<TextDeltaEvent>): TextDeltaEvent {
  return {
    ...BASE,
    type: 'chat:text-delta',
    turnId: 'turn-1',
    messageId: 'msg-1',
    delta: 'hello',
    ...overrides,
  };
}

function makeToolCall(overrides?: Partial<ToolCallEvent>): ToolCallEvent {
  return {
    ...BASE,
    type: 'chat:tool-call',
    turnId: 'turn-1',
    toolCallId: 'tool-1',
    toolName: 'Read',
    description: 'Reading server/index.ts',
    input: { file_path: 'server/index.ts' },
    status: 'running',
    ...overrides,
  };
}

function makeApprovalRequest(
  overrides?: Partial<ApprovalRequestEvent>
): ApprovalRequestEvent {
  return {
    ...BASE,
    type: 'chat:approval-request',
    turnId: 'turn-1',
    requestId: 'req-1',
    kind: 'command',
    toolName: 'Bash',
    description: 'Run git status',
    target: 'git status',
    ...overrides,
  };
}

function makeFileChange(overrides?: Partial<FileChangeEvent>): FileChangeEvent {
  return {
    ...BASE,
    type: 'chat:file-change',
    turnId: 'turn-1',
    toolCallId: 'tool-1',
    path: 'server/index.ts',
    kind: 'modified',
    additions: 5,
    deletions: 2,
    ...overrides,
  };
}

function makeTelemetry(overrides?: Partial<TelemetryEvent>): TelemetryEvent {
  return {
    ...BASE,
    type: 'chat:telemetry',
    model: 'claude-sonnet-4-6',
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 500,
    cacheWriteTokens: 100,
    costUsd: 0.01,
    contextPercent: 12,
    contextWindowSize: 200000,
    ...overrides,
  };
}

function makeSessionStarted(
  overrides?: Partial<SessionStartedEvent>
): SessionStartedEvent {
  return {
    ...BASE,
    type: 'chat:session-started',
    sessionId: 'test-session',
    agentType: 'mock',
    ...overrides,
  };
}

describe('isChatEvent', () => {
  it('returns true for valid ChatEvent objects', () => {
    expect(isChatEvent(makeTextDelta())).toBe(true);
    expect(isChatEvent(makeToolCall())).toBe(true);
    expect(isChatEvent(makeApprovalRequest())).toBe(true);
    expect(isChatEvent(makeTelemetry())).toBe(true);
  });

  it('returns false for null and primitives', () => {
    expect(isChatEvent(null)).toBe(false);
    expect(isChatEvent(undefined)).toBe(false);
    expect(isChatEvent('string')).toBe(false);
    expect(isChatEvent(42)).toBe(false);
  });

  it('returns false for objects missing required fields', () => {
    expect(isChatEvent({})).toBe(false);
    expect(isChatEvent({ sessionId: 'x', timestamp: 'y' })).toBe(false);
    expect(
      isChatEvent({ type: 'not-chat-type', sessionId: 'x', timestamp: 'y' })
    ).toBe(false);
  });

  it('requires type to be a known ChatEvent type with valid source', () => {
    // non-chat: prefix fails
    expect(
      isChatEvent({
        type: 'session.started',
        sessionId: 'x',
        timestamp: 'y',
        source: 'claude',
      })
    ).toBe(false);
    // known type + valid source passes
    expect(
      isChatEvent({
        type: 'chat:text-delta',
        sessionId: 'x',
        timestamp: 'y',
        source: 'claude',
      })
    ).toBe(true);
    // chat: prefix but unknown type fails (stricter than prefix-only check)
    expect(
      isChatEvent({
        type: 'chat:nonexistent',
        sessionId: 'x',
        timestamp: 'y',
        source: 'claude',
      })
    ).toBe(false);
    // invalid source fails even with valid type
    expect(
      isChatEvent({
        type: 'chat:text-delta',
        sessionId: 'x',
        timestamp: 'y',
        source: 'unknown',
      })
    ).toBe(false);
    // 'mock' is a valid source (used by MockProtocolAdapter)
    expect(
      isChatEvent({
        type: 'chat:text-delta',
        sessionId: 'x',
        timestamp: 'y',
        source: 'mock',
      })
    ).toBe(true);
    // missing source fails
    expect(
      isChatEvent({ type: 'chat:text-delta', sessionId: 'x', timestamp: 'y' })
    ).toBe(false);
  });
});

describe('isApprovalRequestEvent', () => {
  it('returns true only for approval-request events', () => {
    const approval = makeApprovalRequest();
    expect(isApprovalRequestEvent(approval)).toBe(true);
  });

  it('returns false for other event types', () => {
    const events: ChatEvent[] = [
      makeTextDelta(),
      makeToolCall(),
      makeFileChange(),
      makeTelemetry(),
    ];
    for (const e of events) {
      expect(isApprovalRequestEvent(e)).toBe(false);
    }
  });

  it('enables narrowing to ApprovalRequestEvent fields', () => {
    const e: ChatEvent = makeApprovalRequest({
      kind: 'file',
      target: '/etc/hosts',
    });
    if (isApprovalRequestEvent(e)) {
      expect(e.kind).toBe('file');
      expect(e.target).toBe('/etc/hosts');
      expect(e.requestId).toBe('req-1');
    } else {
      throw new Error('Expected type guard to be true');
    }
  });
});

describe('isToolCallEvent', () => {
  it('returns true only for tool-call events', () => {
    expect(isToolCallEvent(makeToolCall())).toBe(true);
  });

  it('returns false for other event types', () => {
    expect(isToolCallEvent(makeTextDelta())).toBe(false);
    expect(isToolCallEvent(makeApprovalRequest())).toBe(false);
  });

  it('enables narrowing to ToolCallEvent fields', () => {
    const e: ChatEvent = makeToolCall({
      toolName: 'Bash',
      status: 'completed',
    });
    if (isToolCallEvent(e)) {
      expect(e.toolName).toBe('Bash');
      expect(e.status).toBe('completed');
      expect(e.toolCallId).toBe('tool-1');
    } else {
      throw new Error('Expected type guard to be true');
    }
  });
});

describe('isFileChangeEvent', () => {
  it('returns true only for file-change events', () => {
    expect(isFileChangeEvent(makeFileChange())).toBe(true);
  });

  it('returns false for other event types', () => {
    expect(isFileChangeEvent(makeTextDelta())).toBe(false);
    expect(isFileChangeEvent(makeToolCall())).toBe(false);
  });

  it('enables narrowing to FileChangeEvent fields', () => {
    const e: ChatEvent = makeFileChange({
      path: 'server/ws.ts',
      kind: 'added',
      additions: 10,
    });
    if (isFileChangeEvent(e)) {
      expect(e.path).toBe('server/ws.ts');
      expect(e.kind).toBe('added');
      expect(e.additions).toBe(10);
    } else {
      throw new Error('Expected type guard to be true');
    }
  });
});

describe('isTelemetryEvent', () => {
  it('returns true only for telemetry events', () => {
    expect(isTelemetryEvent(makeTelemetry())).toBe(true);
  });

  it('returns false for other event types', () => {
    expect(isTelemetryEvent(makeTextDelta())).toBe(false);
    expect(isTelemetryEvent(makeToolCall())).toBe(false);
  });

  it('enables narrowing to TelemetryEvent fields', () => {
    const e: ChatEvent = makeTelemetry({ costUsd: 0.05, inputTokens: 5000 });
    if (isTelemetryEvent(e)) {
      expect(e.costUsd).toBe(0.05);
      expect(e.inputTokens).toBe(5000);
      expect(e.model).toBe('claude-sonnet-4-6');
    } else {
      throw new Error('Expected type guard to be true');
    }
  });
});

describe('isLifecycleEvent', () => {
  const lifecycleEvents: ChatEvent[] = [
    makeSessionStarted(),
    {
      ...BASE,
      type: 'chat:session-status',
      status: 'idle',
    } satisfies SessionStatusEvent,
    {
      ...BASE,
      type: 'chat:turn-started',
      turnId: 'turn-1',
      turnIndex: 0,
    } satisfies TurnStartedEvent,
    {
      ...BASE,
      type: 'chat:turn-completed',
      turnId: 'turn-1',
      reason: 'completed',
      durationMs: 5000,
      toolCallCount: 3,
      messageCount: 1,
    } satisfies TurnCompletedEvent,
  ];

  it('returns true for all lifecycle event types', () => {
    for (const e of lifecycleEvents) {
      expect(isLifecycleEvent(e)).toBe(true);
    }
  });

  it('returns false for non-lifecycle events', () => {
    const nonLifecycle: ChatEvent[] = [
      makeTextDelta(),
      makeToolCall(),
      makeApprovalRequest(),
      makeFileChange(),
      makeTelemetry(),
      {
        ...BASE,
        type: 'chat:error',
        kind: 'network',
        message: 'timeout',
        retryable: true,
      } satisfies ErrorEvent,
    ];
    for (const e of nonLifecycle) {
      expect(isLifecycleEvent(e)).toBe(false);
    }
  });
});

describe('ChatEvent discriminated union', () => {
  it('all 19 event types have distinct type literals', () => {
    const types = [
      'chat:text-delta',
      'chat:message-complete',
      'chat:reasoning',
      'chat:compaction',
      'chat:tool-call',
      'chat:tool-output-delta',
      'chat:tool-result',
      'chat:file-change',
      'chat:approval-request',
      'chat:approval-response',
      'chat:input-request',
      'chat:input-response',
      'chat:session-started',
      'chat:session-status',
      'chat:turn-started',
      'chat:turn-completed',
      'chat:error',
      'chat:telemetry',
      'chat:rate-limit',
    ];
    // Each type literal is unique
    const unique = new Set(types);
    expect(unique.size).toBe(types.length);
    // All start with 'chat:'
    for (const t of types) {
      expect(t.startsWith('chat:')).toBe(true);
    }
  });

  it('ChatEventBase fields are present on all events', () => {
    const events: ChatEvent[] = [
      makeTextDelta(),
      makeToolCall(),
      makeApprovalRequest(),
      makeTelemetry(),
    ];
    for (const e of events) {
      expect(typeof e.sessionId).toBe('string');
      expect(typeof e.timestamp).toBe('string');
      expect(typeof e.source).toBe('string');
    }
  });
});
