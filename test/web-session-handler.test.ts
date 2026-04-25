import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  pushToBuffer,
  createWebSession,
} from '../server/web-session-handler.js';
import { createAdapter } from '../server/protocol-adapters/index.js';
import { MockProtocolAdapter } from '../server/protocol-adapters/mock-adapter.js';
import type { Session } from '../server/types.js';
import type { ChatEvent, ApprovalRequestEvent } from '../shared/chat-events.js';
import {
  makeWebSession,
  makeBaseEvent,
  makeApproval,
} from './helpers/web-chat-fixtures.js';

vi.mock('../server/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock sessions.fireBackendStateIfChanged since web-session-handler imports it
vi.mock('../server/sessions.js', () => ({
  fireBackendStateIfChanged: vi.fn(),
}));

// ── pushToBuffer ──────────────────────────────────────────────────────────────

describe('pushToBuffer', () => {
  it('pushes events into the messages array', () => {
    const session = makeWebSession();
    const event = makeBaseEvent();
    pushToBuffer(session, event);
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]).toBe(event);
  });

  it('evicts oldest non-approval event when at cap (1000)', () => {
    const session = makeWebSession();
    // Fill to 999 with text-delta events
    for (let i = 0; i < 999; i++) {
      session.messages.push(makeBaseEvent({ delta: `chunk-${i}` }));
    }
    // Push one approval event (should not be evicted)
    const approval = makeApproval('req-evict-test');
    session.messages.push(approval);
    expect(session.messages).toHaveLength(1000);

    // Now push one more — should evict the FIRST text-delta (index 0), not the approval
    const newEvent = makeBaseEvent({ delta: 'new' });
    pushToBuffer(session, newEvent);

    expect(session.messages).toHaveLength(1000);
    // chunk-0 (index 0) was evicted; chunk-1 is now at index 0
    expect(session.messages[0]?.type).toBe('chat:text-delta');
    // The approval (was at index 999) is now at index 998
    expect(session.messages[998]).toBe(approval);
    // New event is at the end
    expect(session.messages[session.messages.length - 1]).toBe(newEvent);
  });

  it('evicts oldest non-approval event (first non-approval wins)', () => {
    const session = makeWebSession();
    // Approval first, then text events to fill to 1000
    const approval = makeApproval('req-1');
    session.messages.push(approval);
    for (let i = 0; i < 999; i++) {
      session.messages.push(makeBaseEvent({ delta: `chunk-${i}` }));
    }
    expect(session.messages).toHaveLength(1000);

    // Push another event — evict first non-approval (chunk-0 at index 1)
    const newEvent = makeBaseEvent({ delta: 'new' });
    pushToBuffer(session, newEvent);

    expect(session.messages).toHaveLength(1000);
    // Approval at index 0 should survive
    expect(session.messages[0]).toBe(approval);
    // New event at end
    expect(session.messages[session.messages.length - 1]).toBe(newEvent);
  });

  it('shifts from front when all events are approvals', () => {
    const session = makeWebSession();
    // Fill with 1000 approval events
    for (let i = 0; i < 1000; i++) {
      session.messages.push(makeApproval(`req-${i}`));
    }
    const newEvent = makeApproval('req-overflow');
    pushToBuffer(session, newEvent);

    expect(session.messages).toHaveLength(1000);
    // First approval (req-0) should be gone, new one at end
    expect((session.messages[0] as ApprovalRequestEvent).requestId).toBe(
      'req-1'
    );
    expect(
      (session.messages[session.messages.length - 1] as ApprovalRequestEvent)
        .requestId
    ).toBe('req-overflow');
  });
});

// ── createAdapter ─────────────────────────────────────────────────────────────

describe('createAdapter', () => {
  it('returns a MockProtocolAdapter for agent type "mock"', () => {
    const adapter = createAdapter('mock');
    expect(adapter).toBeInstanceOf(MockProtocolAdapter);
    expect(adapter.agentType).toBe('mock');
  });

  it('throws for unknown agent types', () => {
    expect(() => createAdapter('unknown-agent')).toThrow(
      'No protocol adapter registered for agent type: unknown-agent'
    );
  });

  it('throws for empty string agent type', () => {
    expect(() => createAdapter('')).toThrow(
      'No protocol adapter registered for agent type: '
    );
  });
});

// ── MockProtocolAdapter ───────────────────────────────────────────────────────

describe('MockProtocolAdapter - happy-path scenario', () => {
  it('emits the correct event sequence', async () => {
    const adapter = new MockProtocolAdapter();
    const events: ChatEvent[] = [];
    adapter.on((e) => events.push(e));

    await adapter.connect({
      cwd: '/repo',
      port: 3000,
      sessionId: 'sess-1',
      hookToken: 'tok',
      configDir: '/config',
    });

    events.length = 0; // clear connect events

    await adapter.sendMessage('turn-1', 'hello');

    const types = events.map((e) => e.type);
    expect(types[0]).toBe('chat:session-status'); // active
    expect(types[1]).toBe('chat:turn-started');
    expect(types.some((t) => t === 'chat:text-delta')).toBe(true);
    expect(types.some((t) => t === 'chat:message-complete')).toBe(true);
    expect(types.some((t) => t === 'chat:turn-completed')).toBe(true);
    // Last event should be session-status idle
    expect(types[types.length - 1]).toBe('chat:session-status');

    const turnCompleted = events.find((e) => e.type === 'chat:turn-completed');
    expect(turnCompleted).toBeDefined();
    if (turnCompleted?.type === 'chat:turn-completed') {
      expect(turnCompleted.reason).toBe('completed');
      expect(turnCompleted.toolCallCount).toBe(0);
      expect(turnCompleted.messageCount).toBe(1);
    }
  });
});

describe('MockProtocolAdapter - interrupt', () => {
  it('stops emission and emits turn-completed with reason interrupted', async () => {
    const adapter = new MockProtocolAdapter();
    const events: ChatEvent[] = [];
    adapter.on((e) => events.push(e));

    await adapter.connect({
      cwd: '/repo',
      port: 3000,
      sessionId: 'sess-1',
      hookToken: 'tok',
      configDir: '/config',
    });
    events.length = 0;

    // Start sendMessage but don't await — interrupt immediately
    const sendPromise = adapter.sendMessage('turn-1', 'scenario:happy-path');

    // Interrupt after a tick
    await new Promise((r) => setTimeout(r, 10));
    await adapter.interrupt('turn-1');

    await sendPromise;

    const turnCompleted = events.find((e) => e.type === 'chat:turn-completed');
    expect(turnCompleted).toBeDefined();
    if (turnCompleted?.type === 'chat:turn-completed') {
      expect(turnCompleted.reason).toBe('interrupted');
      expect(turnCompleted.durationMs).toBe(0);
    }
  });
});

describe('MockProtocolAdapter - approval-flow scenario', () => {
  it('pauses until respondToApproval is called', async () => {
    const adapter = new MockProtocolAdapter();
    const events: ChatEvent[] = [];
    adapter.on((e) => events.push(e));

    await adapter.connect({
      cwd: '/repo',
      port: 3000,
      sessionId: 'sess-1',
      hookToken: 'tok',
      configDir: '/config',
    });
    events.length = 0;

    const sendPromise = adapter.sendMessage('turn-1', 'scenario:approval-flow');

    // Wait for approval-request to arrive
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'chat:approval-request')).toBe(true);
    });

    // Confirm turn-completed has NOT been emitted yet (still waiting)
    expect(events.some((e) => e.type === 'chat:turn-completed')).toBe(false);

    // Respond to approval
    await adapter.respondToApproval('req-1', 'allow');

    await sendPromise;

    const turnCompleted = events.find((e) => e.type === 'chat:turn-completed');
    expect(turnCompleted).toBeDefined();
    if (turnCompleted?.type === 'chat:turn-completed') {
      expect(turnCompleted.reason).toBe('completed');
      expect(turnCompleted.toolCallCount).toBe(1);
    }

    const approvalResponse = events.find(
      (e) => e.type === 'chat:approval-response'
    );
    expect(approvalResponse).toBeDefined();
    if (approvalResponse?.type === 'chat:approval-response') {
      expect(approvalResponse.decision).toBe('allow');
    }
  });

  it('handles deny decision correctly', async () => {
    const adapter = new MockProtocolAdapter();
    const events: ChatEvent[] = [];
    adapter.on((e) => events.push(e));

    await adapter.connect({
      cwd: '/repo',
      port: 3000,
      sessionId: 'sess-1',
      hookToken: 'tok',
      configDir: '/config',
    });
    events.length = 0;

    const sendPromise = adapter.sendMessage('turn-1', 'scenario:approval-flow');

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'chat:approval-request')).toBe(true);
    });

    await adapter.respondToApproval('req-1', 'deny');
    await sendPromise;

    const approvalResponse = events.find(
      (e) => e.type === 'chat:approval-response'
    );
    if (approvalResponse?.type === 'chat:approval-response') {
      expect(approvalResponse.decision).toBe('deny');
    }

    // Check for declined tool result
    const toolResults = events.filter((e) => e.type === 'chat:tool-result');
    expect(
      toolResults.some(
        (e) => e.type === 'chat:tool-result' && e.status === 'declined'
      )
    ).toBe(true);
  });
});

// ── createWebSession ──────────────────────────────────────────────────────────

describe('createWebSession', () => {
  let sessionsMap: Map<string, Session>;
  let onBackendStateChanged: (session: Session) => void;

  beforeEach(() => {
    sessionsMap = new Map();
    onBackendStateChanged = vi.fn() as unknown as (session: Session) => void;
  });

  it('creates a web session and adds it to sessionsMap', async () => {
    const { session } = await createWebSession(
      {
        agentType: 'mock',
        cwd: '/repo',
        repoPath: '/repo',
        repoName: 'repo',
        branchName: 'main',
        displayName: 'Test Session',
        port: 3000,
        configDir: '/config',
      },
      sessionsMap,
      onBackendStateChanged
    );

    expect(session.mode).toBe('web');
    expect(session.adapterType).toBe('mock');
    expect(sessionsMap.has(session.id)).toBe(true);
    expect(sessionsMap.get(session.id)).toBe(session);
  });

  it('uses provided id if given', async () => {
    const { session } = await createWebSession(
      {
        id: 'custom-id',
        agentType: 'mock',
        cwd: '/repo',
        repoPath: '/repo',
        repoName: 'repo',
        branchName: 'main',
        displayName: 'Test',
        port: 3000,
        configDir: '/config',
      },
      sessionsMap,
      onBackendStateChanged
    );

    expect(session.id).toBe('custom-id');
  });

  it('updates agentState on turn lifecycle events', async () => {
    const { session } = await createWebSession(
      {
        agentType: 'mock',
        cwd: '/repo',
        repoPath: '/repo',
        repoName: 'repo',
        branchName: 'main',
        displayName: 'Test',
        port: 3000,
        configDir: '/config',
      },
      sessionsMap,
      onBackendStateChanged
    );

    // After connect, agentState should be 'idle' (from chat:session-status idle event)
    expect(session.agentState).toBe('idle');

    // Send a message and check state transitions
    const sendPromise = session.adapterV2
      ? session.adapterV2.sendMessage({ turnId: 'turn-1', content: 'hello' })
      : session.adapter.sendMessage('turn-1', 'hello');

    // Wait for turn-started to fire
    await vi.waitFor(() => {
      expect(session.agentState).toBe('processing');
    });

    await sendPromise;

    expect(session.agentState).toBe('idle');
    expect(session.idle).toBe(true);
    expect(session.currentTurnId).toBeNull();
  });
});
