import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createWebSession,
  reconnectWebSession,
  continueHereWebSession,
} from '../server/web-session-handler.js';
import { MockProtocolAdapter } from '../server/protocol-adapters/mock-adapter.js';
import { MockProtocolAdapterV2 } from '../server/protocol-adapters/mock-v2-adapter.js';
import type { Session, WebSession } from '../server/types.js';
import type { ChatEvent } from '../shared/chat-events.js';
import type {
  AgentCapabilitySetV2,
  AgentSessionV2,
} from '../shared/agent-chat-protocol-v2.js';
import { emptyAgentSessionV2 } from '../shared/agent-chat-protocol-v2.js';
import type { AdapterConfig } from '../server/protocol-adapter.js';
import { makeWebSession } from './helpers/web-chat-fixtures.js';

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
    const { session, config } = await createWebSession(
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
    expect(session.role).toBeUndefined();
    expect(config.systemPromptAppendix).toContain('role: collaborator');
    expect(session.controlState).toMatchObject({
      controlMode: 'human-driven',
      controlFreshness: 'unknown',
    });
    expect(sessionsMap.has(session.id)).toBe(true);
    expect(sessionsMap.get(session.id)).toBe(session);
  });

  it('persists an explicit role and threads its playbook into web adapter config', async () => {
    const { session, config } = await createWebSession(
      {
        agentType: 'claude',
        role: 'orchestrator',
        cwd: '/repo',
        displayName: 'Product orchestrator',
        port: 3000,
        configDir: '/config',
      },
      sessionsMap,
      onBackendStateChanged
    );

    expect(session.role).toBe('orchestrator');
    expect(config.systemPromptAppendix).toContain(
      'operator’s Relay-managed orchestrator'
    );
    expect(config.systemPromptAppendix).toContain(
      'events subscribe --topic attention'
    );
    expect(config.systemPromptAppendix).not.toContain(
      'events subscribe --topic inbox'
    );
  });

  it('uses role overrides only for display when an explicit role is absent', async () => {
    const { session, config } = await createWebSession(
      {
        agentType: 'mock',
        roleOverrides: { mock: 'reviewer' },
        cwd: '/repo',
        displayName: 'Review agent',
        port: 3000,
        configDir: '/config',
      },
      sessionsMap,
      onBackendStateChanged
    );

    expect(session.role).toBeUndefined();
    expect(config.systemPromptAppendix).toContain('role: reviewer');
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
  onBackendStateChanged: ReturnType<typeof vi.fn>;
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
  // Resume-failed sessions have live.status === 'disconnected' with error set.
  agentSessionV2.live = {
    ...agentSessionV2.live,
    status: 'disconnected',
    error: 'resume failed',
  };

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

  const onBackendStateChanged = vi.fn() as unknown as ReturnType<typeof vi.fn>;

  return { session, adapter, connectSpy, disconnectSpy, onBackendStateChanged };
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
    const { session, disconnectSpy, onBackendStateChanged } =
      makeWebSessionForContinueHere({});

    await continueHereWebSession(
      session,
      CONTINUE_HERE_CONFIG,
      onBackendStateChanged
    );

    expect(disconnectSpy).toHaveBeenCalledTimes(1);
  });

  it('calls connect() fresh (no resume arg)', async () => {
    const { session, connectSpy, onBackendStateChanged } =
      makeWebSessionForContinueHere({});

    await continueHereWebSession(
      session,
      CONTINUE_HERE_CONFIG,
      onBackendStateChanged
    );

    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(connectSpy).toHaveBeenCalledWith(CONTINUE_HERE_CONFIG);
  });

  it('clears the stored vendor session ID before reconnecting', async () => {
    const { session, onBackendStateChanged } = makeWebSessionForContinueHere({
      providerSession: { claudeSessionId: 'stale-vendor-id' },
    });

    expect(session.agentSessionV2.providerSession).toEqual({
      claudeSessionId: 'stale-vendor-id',
    });

    await continueHereWebSession(
      session,
      CONTINUE_HERE_CONFIG,
      onBackendStateChanged
    );

    // After continueHere the stale vendor ID must be cleared
    expect(session.agentSessionV2.providerSession).toEqual({});
  });

  it('appends a sessionBreak divider item to the last turn', async () => {
    const { session, onBackendStateChanged } = makeWebSessionForContinueHere({
      priorTurns: true,
    });

    const turnsBefore = session.agentSessionV2.turns.length;
    expect(turnsBefore).toBe(1);

    await continueHereWebSession(
      session,
      CONTINUE_HERE_CONFIG,
      onBackendStateChanged
    );

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
    const { session, onBackendStateChanged } = makeWebSessionForContinueHere({
      priorTurns: true,
    });

    const priorTurnIds = session.agentSessionV2.turns.map((t) => t.id);

    await continueHereWebSession(
      session,
      CONTINUE_HERE_CONFIG,
      onBackendStateChanged
    );

    const turnIds = session.agentSessionV2.turns.map((t) => t.id);
    expect(turnIds).toEqual(priorTurnIds);
  });

  it('proceeds even if disconnect throws (adapter already dead)', async () => {
    const { session, connectSpy, disconnectSpy, onBackendStateChanged } =
      makeWebSessionForContinueHere({});
    disconnectSpy.mockRejectedValue(new Error('already disconnected'));

    // Should not throw — disconnect errors are non-fatal; returns true (completed).
    await expect(
      continueHereWebSession(
        session,
        CONTINUE_HERE_CONFIG,
        onBackendStateChanged
      )
    ).resolves.toBe(true);

    // connect() still called after disconnect error
    expect(connectSpy).toHaveBeenCalledTimes(1);
  });

  it('does not append a sessionBreak when there are no prior turns', async () => {
    // No priorTurns — empty transcript
    const { session, onBackendStateChanged } = makeWebSessionForContinueHere(
      {}
    );

    await continueHereWebSession(
      session,
      CONTINUE_HERE_CONFIG,
      onBackendStateChanged
    );

    // No turn created — transcript stays empty
    expect(session.agentSessionV2.turns.length).toBe(0);
  });

  // ── Issue 6: active session guard ─────────────────────────────────────────────

  it('Issue 6: no-op when session live status is not disconnected', async () => {
    const adapter = new MockProtocolAdapterV2({ connectMs: 0, stepMs: 0 });
    const connectSpy = vi.fn().mockResolvedValue(undefined);
    const disconnectSpy = vi.fn().mockResolvedValue(undefined);
    (adapter as unknown as Record<string, unknown>)['connect'] = connectSpy;
    (adapter as unknown as Record<string, unknown>)['disconnect'] =
      disconnectSpy;
    // Simulate a connected, active adapter (not disconnected).
    (adapter as unknown as Record<string, unknown>)['_status'] = 'connected';

    const agentSessionV2: AgentSessionV2 = emptyAgentSessionV2({
      id: 'sess-active',
      provider: 'mock',
      cwd: '/repo',
      capabilities: adapter.capabilities,
    });
    // Force a non-disconnected live status (working = active session).
    agentSessionV2.live = {
      ...agentSessionV2.live,
      status: 'working',
      activeTurnId: 'turn-active-1',
    };

    const session = makeWebSession({
      id: 'sess-active',
      adapterType: 'mock',
      adapterV2: adapter,
      agentSessionV2,
      agentPatchesV2: [],
      runtimeOwnership: 'spawned',
      hookToken: 'tok',
      hooksActive: true,
      protocolVersion: 2,
    });

    const onBackendStateChanged = vi.fn() as unknown as (s: Session) => void;

    const config: AdapterConfig = {
      cwd: '/repo',
      port: 3000,
      sessionId: 'sess-active',
      hookToken: 'tok',
      configDir: '/config',
    };

    const result = await continueHereWebSession(
      session,
      config,
      onBackendStateChanged
    );

    // Should return false (no-op) and never call disconnect or connect.
    expect(result).toBe(false);
    expect(disconnectSpy).not.toHaveBeenCalled();
    expect(connectSpy).not.toHaveBeenCalled();
  });

  // ── Bug 1: patch handlers re-registered after Continue Here ──────────────────

  it('Bug 1: patch handlers continue receiving patches after Continue Here', async () => {
    // Use real disconnect so handlers.clear() is actually called, then verify
    // that the re-registered handler in continueHereWebSession receives patches.
    const adapter = new MockProtocolAdapterV2({ connectMs: 0, stepMs: 0 });
    const connectSpy = vi.fn().mockResolvedValue(undefined);
    (adapter as unknown as Record<string, unknown>)['connect'] = connectSpy;

    const agentSessionV2: AgentSessionV2 = emptyAgentSessionV2({
      id: 'sess-patch-test',
      provider: 'mock',
      cwd: '/repo',
      capabilities: adapter.capabilities,
    });
    // Set disconnected so the guard passes.
    agentSessionV2.live = {
      ...agentSessionV2.live,
      status: 'disconnected',
      error: 'resume failed',
    };

    const session = makeWebSession({
      id: 'sess-patch-test',
      adapterType: 'mock',
      adapterV2: adapter,
      agentSessionV2,
      agentPatchesV2: [],
      runtimeOwnership: 'spawned',
      hookToken: 'tok',
      hooksActive: true,
      protocolVersion: 2,
    });

    const onBackendStateChanged = vi.fn() as unknown as (s: Session) => void;

    // Run continueHereWebSession with real disconnect (no spy override).
    // disconnect() will call handlers.clear() via BaseProtocolAdapterV2.
    const config: AdapterConfig = {
      ...CONTINUE_HERE_CONFIG,
      sessionId: 'sess-patch-test',
    };
    await continueHereWebSession(session, config, onBackendStateChanged);

    // After continue-here, broadcast a patch via the adapter to simulate the
    // fresh connection emitting state. The re-registered onBackendStateChanged
    // handler should receive and process it.
    const testPatch: import('../shared/agent-chat-protocol-v2.js').AgentPatchV2 =
      {
        type: 'agent-live-state-updated-v2',
        sessionId: 'sess-patch-test',
        timestamp: new Date().toISOString(),
        live: {
          status: 'idle',
          activeTurnId: null,
          waitingOn: null,
          activeRequestIds: [],
          proposedPlanItemId: null,
          queueLength: 0,
          fastModeAvailable: false,
          error: null,
        },
      };
    adapter.broadcastPatch(testPatch);

    // onBackendStateChanged must have been called via the re-registered handler.
    expect(onBackendStateChanged).toHaveBeenCalled();
  });

  // ── Bug 2: synthetic sessionBreak patch broadcast to WS listeners ─────────────

  it('Bug 2: synthetic sessionBreak patch is broadcast to onPatch listeners before disconnect', async () => {
    const adapter = new MockProtocolAdapterV2({ connectMs: 0, stepMs: 0 });
    const connectSpy = vi.fn().mockResolvedValue(undefined);
    (adapter as unknown as Record<string, unknown>)['connect'] = connectSpy;

    // Pre-populate a turn so the break item will be emitted.
    const now = new Date().toISOString();
    const agentSessionV2: AgentSessionV2 = emptyAgentSessionV2({
      id: 'sess-break-broadcast',
      provider: 'mock',
      cwd: '/repo',
      capabilities: adapter.capabilities,
    });
    agentSessionV2.live = {
      ...agentSessionV2.live,
      status: 'disconnected',
      error: 'resume failed',
    };
    agentSessionV2.turns = [
      {
        id: 'turn-old-1',
        status: 'completed',
        inputMessageId: 'msg-1',
        items: [],
        startedAt: now,
        completedAt: now,
      },
    ];

    const session = makeWebSession({
      id: 'sess-break-broadcast',
      adapterType: 'mock',
      adapterV2: adapter,
      agentSessionV2,
      agentPatchesV2: [],
      runtimeOwnership: 'spawned',
      hookToken: 'tok',
      hooksActive: true,
      protocolVersion: 2,
    });

    const onBackendStateChanged = vi.fn() as unknown as (s: Session) => void;

    // Simulate a WS forwarder — registered BEFORE continue-here is called,
    // exactly as ws.ts does on connection. This handler must receive the
    // sessionBreak patch since it is emitted before disconnect clears handlers.
    const wsReceivedPatches: import('../shared/agent-chat-protocol-v2.js').AgentPatchV2[] =
      [];
    adapter.onPatch((patch) => {
      wsReceivedPatches.push(patch);
    });

    const config: AdapterConfig = {
      ...CONTINUE_HERE_CONFIG,
      sessionId: 'sess-break-broadcast',
    };
    await continueHereWebSession(session, config, onBackendStateChanged);

    // The WS forwarder must have received the sessionBreak patch
    // (emitted via broadcastPatch before disconnect clears handlers).
    const breakPatch = wsReceivedPatches.find(
      (p) =>
        p.type === 'agent-item-started-v2' && p.item.type === 'sessionBreak'
    );
    expect(breakPatch).toBeDefined();
    if (breakPatch?.type === 'agent-item-started-v2') {
      expect(breakPatch.item.type).toBe('sessionBreak');
    }
  });
});
