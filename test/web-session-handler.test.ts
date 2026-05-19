import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  pushToBuffer,
  createWebSession,
  reconnectWebSession,
  continueHereWebSession,
} from '../server/web-session-handler.js';
import { MockProtocolAdapter } from '../server/protocol-adapters/mock-adapter.js';
import { MockProtocolAdapterV2 } from '../server/protocol-adapters/mock-v2-adapter.js';
import type { Session, WebSession } from '../server/types.js';
import type { ChatEvent, ApprovalRequestEvent } from '../shared/chat-events.js';
import type {
  AgentCapabilitySetV2,
  AgentSessionV2,
} from '../shared/agent-chat-protocol-v2.js';
import { emptyAgentSessionV2 } from '../shared/agent-chat-protocol-v2.js';
import type { AdapterConfig } from '../server/protocol-adapter.js';
import {
  makeWebSession,
  makeBaseEvent,
  makeApproval,
} from './helpers/web-chat-fixtures.js';

vi.mock('../server/logger.js', () => ({
  createLogger: () => ({
    trace: vi.fn(),
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
    expect(session.controlState).toMatchObject({
      controlMode: 'human-driven',
      controlFreshness: 'unknown',
    });
    expect(sessionsMap.has(session.id)).toBe(true);
    expect(sessionsMap.get(session.id)).toBe(session);
  });

  it('uses provided control state independently from web transport mode', async () => {
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
        controlState: {
          controlMode: 'co-driven',
          activeActors: [
            { kind: 'human', id: 'operator' },
            { kind: 'agent', id: 'mock-agent' },
          ],
          activeWorker: { kind: 'agent', id: 'mock-agent' },
          lastInterventionAt: '2026-01-02T03:04:05.000Z',
          lastInterventionBy: { kind: 'human', id: 'operator' },
          lastInterventionEventId: 'evt-web-1',
          controlFreshness: 'fresh',
        },
      },
      sessionsMap,
      onBackendStateChanged
    );

    expect(session.mode).toBe('web');
    expect(session.controlState).toMatchObject({
      controlMode: 'co-driven',
      controlFreshness: 'fresh',
      lastInterventionEventId: 'evt-web-1',
    });
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

  it('defaults repo-bound branchName to an empty string', async () => {
    const { session } = await createWebSession(
      {
        agentType: 'mock',
        cwd: '/repo',
        repoPath: '/repo',
        repoName: 'repo',
        displayName: 'Test',
        port: 3000,
        configDir: '/config',
      },
      sessionsMap,
      onBackendStateChanged
    );

    expect(session.branchName).toBe('');
    expect(session).toHaveProperty('branchName');
  });

  it('omits branchName for non-repo web sessions', async () => {
    const { session } = await createWebSession(
      {
        agentType: 'mock',
        cwd: '/repo',
        displayName: 'Test',
        port: 3000,
        configDir: '/config',
      },
      sessionsMap,
      onBackendStateChanged
    );

    expect(session).not.toHaveProperty('branchName');
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

    // After connect, agentState should be 'idle' (from v2 live-state idle patch)
    expect(session.agentState).toBe('idle');

    // Send a message and check state transitions
    expect(session.adapterV2).toBeDefined();
    const sendPromise = session.adapterV2!.sendMessage({
      turnId: 'turn-1',
      content: 'hello',
    });

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

// ── reconnectWebSession ───────────────────────────────────────────────────────

/**
 * Build a minimal WebSession with a controllable MockProtocolAdapterV2.
 * The session's agentSessionV2 can be pre-populated with a providerSession.
 */
function makeWebSessionWithV2Adapter(
  capabilitiesOverride: Partial<AgentCapabilitySetV2> = {},
  providerSession?: Record<string, string>
): {
  session: WebSession;
  adapter: MockProtocolAdapterV2;
  resumeSessionSpy: ReturnType<typeof vi.fn>;
  reconnectSpy: ReturnType<typeof vi.fn>;
} {
  const adapter = new MockProtocolAdapterV2({ connectMs: 0, stepMs: 0 });
  const resumeSessionSpy = vi.fn().mockResolvedValue(undefined);
  const reconnectSpy = vi.fn().mockResolvedValue(undefined);
  (adapter as unknown as Record<string, unknown>)['resumeSession'] =
    resumeSessionSpy;
  (adapter as unknown as Record<string, unknown>)['reconnect'] = reconnectSpy;

  // Override capabilities if needed
  const overriddenCapabilities: AgentCapabilitySetV2 = {
    ...adapter.capabilities,
    ...capabilitiesOverride,
  };
  (adapter as unknown as Record<string, unknown>)['capabilities'] =
    overriddenCapabilities;

  const agentSessionV2: AgentSessionV2 = emptyAgentSessionV2({
    id: 'sess-reconnect',
    provider: 'mock',
    cwd: '/repo',
    capabilities: overriddenCapabilities,
    ...(providerSession !== undefined ? { providerSession } : {}),
  });

  const session = makeWebSession({
    id: 'sess-reconnect',
    adapterType: 'mock',
    adapterV2: adapter,
    agentSessionV2,
  });

  return { session, adapter, resumeSessionSpy, reconnectSpy };
}

describe('reconnectWebSession', () => {
  it('calls resumeSession when capabilities.resume is true and claudeSessionId is stored', async () => {
    const { session, resumeSessionSpy, reconnectSpy } =
      makeWebSessionWithV2Adapter(
        { resume: true },
        { claudeSessionId: 'stored-claude-session-1' }
      );
    session.adapterType = 'claude';

    await reconnectWebSession(session);

    expect(resumeSessionSpy).toHaveBeenCalledWith('stored-claude-session-1');
    expect(resumeSessionSpy).toHaveBeenCalledTimes(1);
    expect(reconnectSpy).not.toHaveBeenCalled();
  });

  it('falls back to reconnect() when capabilities.resume is false', async () => {
    const { session, resumeSessionSpy, reconnectSpy } =
      makeWebSessionWithV2Adapter(
        { resume: false },
        { claudeSessionId: 'stored-session' }
      );
    session.adapterType = 'claude';

    await reconnectWebSession(session);

    expect(reconnectSpy).toHaveBeenCalledTimes(1);
    expect(resumeSessionSpy).not.toHaveBeenCalled();
  });

  it('falls back to reconnect() when no stored provider session id', async () => {
    const { session, resumeSessionSpy, reconnectSpy } =
      makeWebSessionWithV2Adapter({ resume: true });
    session.adapterType = 'claude';

    await reconnectWebSession(session);

    expect(reconnectSpy).toHaveBeenCalledTimes(1);
    expect(resumeSessionSpy).not.toHaveBeenCalled();
  });

  it('falls back to reconnect() when adapterType has no known providerSession key', async () => {
    const { session, resumeSessionSpy, reconnectSpy } =
      makeWebSessionWithV2Adapter({ resume: true }, { someOtherId: 'value' });
    // 'mock' is not in the known key lookup table
    await reconnectWebSession(session);

    expect(reconnectSpy).toHaveBeenCalledTimes(1);
    expect(resumeSessionSpy).not.toHaveBeenCalled();
  });
});

// ── continueHereWebSession ────────────────────────────────────────────────────

/**
 * Build a minimal WebSession with a MockProtocolAdapterV2 whose resumeSession
 * rejects (simulating an expired vendor session). Used to verify the
 * "Continue here" recovery path.
 */
function makeWebSessionForContinueHere(opts: {
  providerSession?: Record<string, string>;
  priorTurns?: boolean;
}): {
  session: WebSession;
  adapter: MockProtocolAdapterV2;
  connectSpy: ReturnType<typeof vi.fn>;
  disconnectSpy: ReturnType<typeof vi.fn>;
} {
  const adapter = new MockProtocolAdapterV2({ connectMs: 0, stepMs: 0 });

  // Override resumeSession to reject so the "resume failed" path is exercised
  const resumeSessionSpy = vi
    .fn()
    .mockRejectedValue(new Error('vendor session expired'));
  (adapter as unknown as Record<string, unknown>)['resumeSession'] =
    resumeSessionSpy;

  // Spy on connect and disconnect
  const connectSpy = vi.fn().mockResolvedValue(undefined);
  const disconnectSpy = vi.fn().mockResolvedValue(undefined);
  (adapter as unknown as Record<string, unknown>)['connect'] = connectSpy;
  (adapter as unknown as Record<string, unknown>)['disconnect'] = disconnectSpy;

  const agentSessionV2: AgentSessionV2 = emptyAgentSessionV2({
    id: 'sess-continue',
    provider: 'mock',
    cwd: '/repo',
    capabilities: adapter.capabilities,
    ...(opts.providerSession !== undefined
      ? { providerSession: opts.providerSession }
      : {}),
  });

  // Optionally add a prior turn to the transcript
  if (opts.priorTurns) {
    const now = new Date().toISOString();
    agentSessionV2.turns = [
      {
        id: 'turn-old-1',
        status: 'completed',
        inputMessageId: 'msg-1',
        items: [
          {
            type: 'userMessage',
            id: 'item-old-1',
            text: 'hello',
            status: 'completed',
            startedAt: now,
            completedAt: now,
          },
        ],
        startedAt: now,
        completedAt: now,
      },
    ];
  }

  const session = makeWebSession({
    id: 'sess-continue',
    adapterType: 'mock',
    adapterV2: adapter,
    agentSessionV2,
    agentPatchesV2: [],
    runtimeOwnership: 'spawned',
    hookToken: 'tok',
    hooksActive: true,
    protocolVersion: 2,
  });

  return { session, adapter, connectSpy, disconnectSpy };
}

const CONTINUE_HERE_CONFIG: AdapterConfig = {
  cwd: '/repo',
  port: 3000,
  sessionId: 'sess-continue',
  hookToken: 'tok',
  configDir: '/config',
};

describe('continueHereWebSession', () => {
  it('disconnects the current adapter', async () => {
    const { session, disconnectSpy } = makeWebSessionForContinueHere({});

    await continueHereWebSession(session, CONTINUE_HERE_CONFIG);

    expect(disconnectSpy).toHaveBeenCalledTimes(1);
  });

  it('calls connect() fresh (no resume arg)', async () => {
    const { session, connectSpy } = makeWebSessionForContinueHere({});

    await continueHereWebSession(session, CONTINUE_HERE_CONFIG);

    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(connectSpy).toHaveBeenCalledWith(CONTINUE_HERE_CONFIG);
  });

  it('clears the stored vendor session ID before reconnecting', async () => {
    const { session } = makeWebSessionForContinueHere({
      providerSession: { claudeSessionId: 'stale-vendor-id' },
    });

    expect(session.agentSessionV2.providerSession).toEqual({
      claudeSessionId: 'stale-vendor-id',
    });

    await continueHereWebSession(session, CONTINUE_HERE_CONFIG);

    // After continueHere the stale vendor ID must be cleared
    expect(session.agentSessionV2.providerSession).toEqual({});
  });

  it('appends a sessionBreak divider item to the last turn', async () => {
    const { session } = makeWebSessionForContinueHere({ priorTurns: true });

    const turnsBefore = session.agentSessionV2.turns.length;
    expect(turnsBefore).toBe(1);

    await continueHereWebSession(session, CONTINUE_HERE_CONFIG);

    // Turns count unchanged — divider appended inside the last turn
    const turns = session.agentSessionV2.turns;
    expect(turns.length).toBe(1);

    const lastTurnItems = turns[turns.length - 1]!.items;
    const breakItem = lastTurnItems.find(
      (item) => item.type === 'sessionBreak'
    );
    expect(breakItem).toBeDefined();
    expect(breakItem?.type).toBe('sessionBreak');
    if (breakItem?.type === 'sessionBreak') {
      expect(breakItem.reason).toBe('continue-here');
    }
  });

  it('preserves all prior turns in the transcript', async () => {
    const { session } = makeWebSessionForContinueHere({ priorTurns: true });

    const priorTurnIds = session.agentSessionV2.turns.map((t) => t.id);

    await continueHereWebSession(session, CONTINUE_HERE_CONFIG);

    const turnIds = session.agentSessionV2.turns.map((t) => t.id);
    expect(turnIds).toEqual(priorTurnIds);
  });

  it('proceeds even if disconnect throws (adapter already dead)', async () => {
    const { session, connectSpy, disconnectSpy } =
      makeWebSessionForContinueHere({});
    disconnectSpy.mockRejectedValue(new Error('already disconnected'));

    // Should not throw — disconnect errors are non-fatal
    await expect(
      continueHereWebSession(session, CONTINUE_HERE_CONFIG)
    ).resolves.toBeUndefined();

    // connect() still called after disconnect error
    expect(connectSpy).toHaveBeenCalledTimes(1);
  });

  it('does not append a sessionBreak when there are no prior turns', async () => {
    // No priorTurns — empty transcript
    const { session } = makeWebSessionForContinueHere({});

    await continueHereWebSession(session, CONTINUE_HERE_CONFIG);

    // No turn created — transcript stays empty
    expect(session.agentSessionV2.turns.length).toBe(0);
  });
});
