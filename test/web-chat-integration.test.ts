import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MockProtocolAdapter } from '../server/protocol-adapters/mock-adapter.js';
import { createAdapter } from '../server/protocol-adapters/index.js';
import { ClaudeProtocolAdapter } from '../server/protocol-adapters/claude-adapter.js';
import { CodexProtocolAdapter } from '../server/protocol-adapters/codex-adapter.js';
import { OpenCodeProtocolAdapter } from '../server/protocol-adapters/opencode-adapter.js';
import { pushToBuffer } from '../server/web-session-handler.js';
import { isChatEvent } from '../shared/chat-events.js';
import type { ChatEvent } from '../shared/chat-events.js';
import type { HookEventPayload } from '../server/protocol-adapters/base-hook-adapter.js';
import { BaseHookAdapter } from '../server/protocol-adapters/base-hook-adapter.js';
import type { AdapterConfig } from '../server/protocol-adapter.js';
import {
  ZERO_DELAYS,
  BASE_CONFIG,
  makeWebSession,
  makeBaseEvent,
  makeApproval,
  connectAndClear,
} from './helpers/web-chat-fixtures.js';

vi.mock('../server/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../server/sessions.js', () => ({
  fireBackendStateIfChanged: vi.fn(),
}));

// ── 1. Mock adapter scenario contract tests ───────────────────────────────────

describe('mock adapter scenarios - contract tests', () => {
  describe('happy-path scenario', () => {
    it('emits correct event sequence', async () => {
      const adapter = new MockProtocolAdapter(ZERO_DELAYS);
      const events = await connectAndClear(adapter);

      await adapter.sendMessage('turn-1', 'scenario:happy-path');

      const types = events.map((e) => e.type);

      expect(types[0]).toBe('chat:session-status'); // active
      expect(types[1]).toBe('chat:turn-started');
      expect(types.some((t) => t === 'chat:text-delta')).toBe(true);
      expect(types.some((t) => t === 'chat:message-complete')).toBe(true);
      expect(types.some((t) => t === 'chat:turn-completed')).toBe(true);
      expect(types[types.length - 1]).toBe('chat:session-status'); // idle at end

      const sessionStatus = events.filter(
        (e) => e.type === 'chat:session-status'
      );
      expect(sessionStatus).toHaveLength(2);
      if (sessionStatus[0]?.type === 'chat:session-status') {
        expect(sessionStatus[0].status).toBe('active');
      }
      if (sessionStatus[1]?.type === 'chat:session-status') {
        expect(sessionStatus[1].status).toBe('idle');
      }

      const turnStarted = events.find((e) => e.type === 'chat:turn-started');
      expect(turnStarted).toBeDefined();
      if (turnStarted?.type === 'chat:turn-started') {
        expect(turnStarted.turnId).toBe('turn-1');
      }

      const turnCompleted = events.find(
        (e) => e.type === 'chat:turn-completed'
      );
      expect(turnCompleted).toBeDefined();
      if (turnCompleted?.type === 'chat:turn-completed') {
        expect(turnCompleted.reason).toBe('completed');
        expect(turnCompleted.toolCallCount).toBe(0);
        expect(turnCompleted.messageCount).toBe(1);
      }
    });
  });

  describe('tool-chain scenario', () => {
    it('emits tool-call, tool-output-delta, and tool-result events', async () => {
      const adapter = new MockProtocolAdapter(ZERO_DELAYS);
      const events = await connectAndClear(adapter);

      await adapter.sendMessage('turn-1', 'scenario:tool-chain');

      const types = events.map((e) => e.type);

      expect(types.some((t) => t === 'chat:tool-call')).toBe(true);
      expect(types.some((t) => t === 'chat:tool-output-delta')).toBe(true);
      expect(types.some((t) => t === 'chat:tool-result')).toBe(true);

      const toolCalls = events.filter((e) => e.type === 'chat:tool-call');
      expect(toolCalls.length).toBeGreaterThanOrEqual(2);

      // Verify tool-1 Read call
      const readCall = toolCalls.find(
        (e) => e.type === 'chat:tool-call' && e.toolName === 'Read'
      );
      expect(readCall).toBeDefined();
      if (readCall?.type === 'chat:tool-call') {
        expect(readCall.toolCallId).toBe('tool-1');
      }

      // Verify tool-2 Bash call
      const bashCall = toolCalls.find(
        (e) => e.type === 'chat:tool-call' && e.toolName === 'Bash'
      );
      expect(bashCall).toBeDefined();

      // Verify output deltas belong to tool-1
      const deltas = events.filter((e) => e.type === 'chat:tool-output-delta');
      expect(deltas.length).toBeGreaterThanOrEqual(1);
      if (deltas[0]?.type === 'chat:tool-output-delta') {
        expect(deltas[0].toolCallId).toBe('tool-1');
      }

      const turnCompleted = events.find(
        (e) => e.type === 'chat:turn-completed'
      );
      if (turnCompleted?.type === 'chat:turn-completed') {
        expect(turnCompleted.reason).toBe('completed');
        expect(turnCompleted.toolCallCount).toBe(2);
        expect(turnCompleted.messageCount).toBe(1);
      }
    });
  });

  describe('approval-flow scenario', () => {
    it('includes approval-request, pauses until respondToApproval, then approval-response', async () => {
      const adapter = new MockProtocolAdapter(ZERO_DELAYS);
      const events = await connectAndClear(adapter);

      const sendPromise = adapter.sendMessage(
        'turn-1',
        'scenario:approval-flow'
      );

      // Wait for approval-request
      await vi.waitFor(() => {
        expect(events.some((e) => e.type === 'chat:approval-request')).toBe(
          true
        );
      });

      // turn-completed must NOT yet be emitted
      expect(events.some((e) => e.type === 'chat:turn-completed')).toBe(false);

      // Respond
      await adapter.respondToApproval('req-1', 'allow');
      await sendPromise;

      const approvalReq = events.find(
        (e) => e.type === 'chat:approval-request'
      );
      expect(approvalReq).toBeDefined();
      if (approvalReq?.type === 'chat:approval-request') {
        expect(approvalReq.requestId).toBe('req-1');
        expect(approvalReq.kind).toBe('command');
        expect(approvalReq.toolName).toBe('Bash');
      }

      const approvalResp = events.find(
        (e) => e.type === 'chat:approval-response'
      );
      expect(approvalResp).toBeDefined();
      if (approvalResp?.type === 'chat:approval-response') {
        expect(approvalResp.requestId).toBe('req-1');
        expect(approvalResp.decision).toBe('allow');
      }

      const turnCompleted = events.find(
        (e) => e.type === 'chat:turn-completed'
      );
      if (turnCompleted?.type === 'chat:turn-completed') {
        expect(turnCompleted.reason).toBe('completed');
        expect(turnCompleted.toolCallCount).toBe(1);
      }
    });
  });

  describe('file-changes scenario', () => {
    it('emits file-change events with correct paths', async () => {
      const adapter = new MockProtocolAdapter(ZERO_DELAYS);
      const events = await connectAndClear(adapter);

      await adapter.sendMessage('turn-1', 'scenario:file-changes');

      const fileChanges = events.filter((e) => e.type === 'chat:file-change');
      expect(fileChanges).toHaveLength(3);

      const expectedPaths = [
        'server/index.ts',
        'server/ws.ts',
        'server/sessions.ts',
      ];

      for (const change of fileChanges) {
        if (change.type === 'chat:file-change') {
          expect(expectedPaths).toContain(change.path);
          expect(change.kind).toBe('modified');
          expect(change.additions).toBe(5);
          expect(change.deletions).toBe(2);
        }
      }

      const turnCompleted = events.find(
        (e) => e.type === 'chat:turn-completed'
      );
      if (turnCompleted?.type === 'chat:turn-completed') {
        expect(turnCompleted.toolCallCount).toBe(3);
      }
    });
  });

  describe('error-recovery scenario', () => {
    it('emits error event with retryable=true', async () => {
      const adapter = new MockProtocolAdapter(ZERO_DELAYS);
      const events = await connectAndClear(adapter);

      await adapter.sendMessage('turn-1', 'scenario:error-recovery');

      const errorEvent = events.find((e) => e.type === 'chat:error');
      expect(errorEvent).toBeDefined();
      if (errorEvent?.type === 'chat:error') {
        expect(errorEvent.retryable).toBe(true);
        expect(errorEvent.kind).toBe('network');
        expect(errorEvent.message).toBe('connection to model timed out');
      }

      // scenario recovers and completes successfully
      const turnCompleted = events.find(
        (e) => e.type === 'chat:turn-completed'
      );
      expect(turnCompleted).toBeDefined();
      if (turnCompleted?.type === 'chat:turn-completed') {
        expect(turnCompleted.reason).toBe('completed');
      }
    });
  });
});

// ── 2. Event type guard contract tests ───────────────────────────────────────

describe('isChatEvent type guard - all mock adapter events pass', () => {
  it('every event from happy-path passes isChatEvent()', async () => {
    const adapter = new MockProtocolAdapter(ZERO_DELAYS);
    const events: ChatEvent[] = [];
    adapter.on((e) => events.push(e));
    await adapter.connect(BASE_CONFIG);
    await adapter.sendMessage('turn-1', 'scenario:happy-path');

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(isChatEvent(event)).toBe(true);
    }
  });

  it('every event from tool-chain passes isChatEvent()', async () => {
    const adapter = new MockProtocolAdapter(ZERO_DELAYS);
    const events: ChatEvent[] = [];
    adapter.on((e) => events.push(e));
    await adapter.connect(BASE_CONFIG);
    await adapter.sendMessage('turn-1', 'scenario:tool-chain');

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(isChatEvent(event)).toBe(true);
    }
  });

  it('every event from approval-flow passes isChatEvent()', async () => {
    const adapter = new MockProtocolAdapter(ZERO_DELAYS);
    const events: ChatEvent[] = [];
    adapter.on((e) => events.push(e));
    await adapter.connect(BASE_CONFIG);

    const sendPromise = adapter.sendMessage('turn-1', 'scenario:approval-flow');
    await vi.waitFor(() =>
      expect(events.some((e) => e.type === 'chat:approval-request')).toBe(true)
    );
    await adapter.respondToApproval('req-1', 'allow');
    await sendPromise;

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(isChatEvent(event)).toBe(true);
    }
  });

  it('every event from file-changes passes isChatEvent()', async () => {
    const adapter = new MockProtocolAdapter(ZERO_DELAYS);
    const events: ChatEvent[] = [];
    adapter.on((e) => events.push(e));
    await adapter.connect(BASE_CONFIG);
    await adapter.sendMessage('turn-1', 'scenario:file-changes');

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(isChatEvent(event)).toBe(true);
    }
  });

  it('every event from error-recovery passes isChatEvent()', async () => {
    const adapter = new MockProtocolAdapter(ZERO_DELAYS);
    const events: ChatEvent[] = [];
    adapter.on((e) => events.push(e));
    await adapter.connect(BASE_CONFIG);
    await adapter.sendMessage('turn-1', 'scenario:error-recovery');

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(isChatEvent(event)).toBe(true);
    }
  });

  it('rejects non-ChatEvent objects', () => {
    expect(isChatEvent(null)).toBe(false);
    expect(isChatEvent(undefined)).toBe(false);
    expect(isChatEvent({ type: 'chat:text-delta' })).toBe(false); // missing sessionId, timestamp, source
    expect(
      isChatEvent({
        type: 'not-a-type',
        sessionId: 's',
        timestamp: 't',
        source: 'claude',
      })
    ).toBe(false);
    expect(
      isChatEvent({
        type: 'chat:text-delta',
        sessionId: 's',
        timestamp: 't',
        source: 'unknown-source',
      })
    ).toBe(false);
  });
});

// ── 3. Buffer contract tests ──────────────────────────────────────────────────

describe('pushToBuffer - integration with real event sequences', () => {
  it('buffers all events from happy-path run', async () => {
    const adapter = new MockProtocolAdapter(ZERO_DELAYS);
    const session = makeWebSession({ adapter });
    adapter.on((e) => pushToBuffer(session, e));

    await adapter.connect(BASE_CONFIG);
    await adapter.sendMessage('turn-1', 'scenario:happy-path');

    expect(session.messages.length).toBeGreaterThan(0);
    // connect emits session-started + session-status(idle)
    // sendMessage emits: session-status(active), turn-started, N text-deltas, message-complete, turn-completed, session-status(idle)
    expect(
      session.messages.some((e) => e.type === 'chat:session-started')
    ).toBe(true);
    expect(session.messages.some((e) => e.type === 'chat:turn-started')).toBe(
      true
    );
    expect(session.messages.some((e) => e.type === 'chat:text-delta')).toBe(
      true
    );
    expect(
      session.messages.some((e) => e.type === 'chat:message-complete')
    ).toBe(true);
    expect(session.messages.some((e) => e.type === 'chat:turn-completed')).toBe(
      true
    );
  });

  it('maintains cap at 1000 when events exceed limit', () => {
    const session = makeWebSession();

    // Fill to exactly 1000
    for (let i = 0; i < 1000; i++) {
      session.messages.push(makeBaseEvent({ delta: `chunk-${i}` }));
    }
    expect(session.messages).toHaveLength(1000);

    // Push 10 more — should evict oldest each time, staying at 1000
    for (let i = 0; i < 10; i++) {
      pushToBuffer(session, makeBaseEvent({ delta: `overflow-${i}` }));
    }
    expect(session.messages).toHaveLength(1000);
  });

  it('preserves approval events during eviction', () => {
    const session = makeWebSession();

    // Fill to 999 with text-delta events then add one approval
    for (let i = 0; i < 999; i++) {
      session.messages.push(makeBaseEvent({ delta: `chunk-${i}` }));
    }
    const approval = makeApproval('req-preserved');
    session.messages.push(approval);
    expect(session.messages).toHaveLength(1000);

    // Push more events — non-approval should be evicted, approval preserved
    for (let i = 0; i < 5; i++) {
      pushToBuffer(session, makeBaseEvent({ delta: `new-${i}` }));
    }

    expect(session.messages).toHaveLength(1000);
    // The approval must still be in the buffer
    expect(session.messages.some((e) => e === approval)).toBe(true);
    // Text deltas at end are the new ones
    const lastFive = session.messages.slice(-5);
    for (let i = 0; i < 5; i++) {
      expect(lastFive[i]?.type).toBe('chat:text-delta');
    }
  });

  it('buffers approval events from approval-flow scenario without loss', async () => {
    const adapter = new MockProtocolAdapter(ZERO_DELAYS);
    const session = makeWebSession({ adapter });
    adapter.on((e) => pushToBuffer(session, e));

    await adapter.connect(BASE_CONFIG);

    const sendPromise = adapter.sendMessage('turn-1', 'scenario:approval-flow');
    await vi.waitFor(() =>
      expect(
        session.messages.some((e) => e.type === 'chat:approval-request')
      ).toBe(true)
    );
    await adapter.respondToApproval('req-1', 'allow');
    await sendPromise;

    expect(
      session.messages.some((e) => e.type === 'chat:approval-request')
    ).toBe(true);
    expect(
      session.messages.some((e) => e.type === 'chat:approval-response')
    ).toBe(true);
  });
});

// ── 4. Adapter registry tests ─────────────────────────────────────────────────

describe('createAdapter - registry', () => {
  it('returns MockProtocolAdapter for "mock"', () => {
    const adapter = createAdapter('mock');
    expect(adapter).toBeInstanceOf(MockProtocolAdapter);
    expect(adapter.agentType).toBe('mock');
  });

  it('returns ClaudeProtocolAdapter for "claude"', () => {
    const adapter = createAdapter('claude');
    expect(adapter).toBeInstanceOf(ClaudeProtocolAdapter);
    expect(adapter.agentType).toBe('claude');
  });

  it('returns CodexProtocolAdapter for "codex"', () => {
    const adapter = createAdapter('codex');
    expect(adapter).toBeInstanceOf(CodexProtocolAdapter);
    expect(adapter.agentType).toBe('codex');
  });

  it('returns OpenCodeProtocolAdapter for "opencode"', () => {
    const adapter = createAdapter('opencode');
    expect(adapter).toBeInstanceOf(OpenCodeProtocolAdapter);
    expect(adapter.agentType).toBe('opencode');
  });

  it('throws for unknown agent type', () => {
    expect(() => createAdapter('unknown')).toThrow(
      'No protocol adapter registered for agent type: unknown'
    );
  });

  it('throws for empty string agent type', () => {
    expect(() => createAdapter('')).toThrow(
      'No protocol adapter registered for agent type: '
    );
  });

  it('each call returns a new instance', () => {
    const a = createAdapter('mock');
    const b = createAdapter('mock');
    expect(a).not.toBe(b);
  });
});

// ── 5. BaseHookAdapter lifecycle tests ────────────────────────────────────────

/**
 * Minimal concrete subclass of BaseHookAdapter for lifecycle testing.
 * Does not spawn a real process — overrides connect() entirely.
 */
class TestHookAdapter extends BaseHookAdapter {
  readonly agentType = 'test-hook';

  mapHookEventSpy = vi.fn();
  disconnectSpy = vi.fn();
  connectSpy = vi.fn();

  protected buildSpawnCommand(_config: AdapterConfig) {
    return { command: 'echo', args: ['ok'], env: {} };
  }

  protected async setupHooks(_config: AdapterConfig): Promise<void> {}
  protected async cleanupHooks(_config: AdapterConfig): Promise<void> {}

  protected mapHookEvent(payload: HookEventPayload): void {
    this.mapHookEventSpy(payload);
  }

  // Override connect to avoid actually spawning a process
  override async connect(config: AdapterConfig): Promise<void> {
    this.connectSpy(config);
    this._config = config;
    this._status = 'connected';
    this.fire({
      type: 'chat:session-started',
      sessionId: config.sessionId,
      agentType: this.agentType,
    });
    this.fire({ type: 'chat:session-status', status: 'idle' });
  }

  // Override onDisconnect to track calls without process cleanup
  protected override async onDisconnect(): Promise<void> {
    this.disconnectSpy();
    this._status = 'disconnected';
  }
}

describe('BaseHookAdapter - lifecycle', () => {
  let adapter: TestHookAdapter;

  beforeEach(() => {
    adapter = new TestHookAdapter();
  });

  it('handleHookEvent calls mapHookEvent with the payload', () => {
    const payload: HookEventPayload = {
      type: 'PreToolUse',
      sessionId: 'sess-1',
      data: { tool: 'Bash' },
    };

    adapter.handleHookEvent(payload);

    expect(adapter.mapHookEventSpy).toHaveBeenCalledOnce();
    expect(adapter.mapHookEventSpy).toHaveBeenCalledWith(payload);
  });

  it('handleHookEvent can be called multiple times', () => {
    const payloads: HookEventPayload[] = [
      { type: 'PreToolUse', sessionId: 'sess-1' },
      { type: 'PostToolUse', sessionId: 'sess-1' },
      { type: 'Stop', sessionId: 'sess-1' },
    ];

    for (const p of payloads) {
      adapter.handleHookEvent(p);
    }

    expect(adapter.mapHookEventSpy).toHaveBeenCalledTimes(3);
    expect(adapter.mapHookEventSpy.mock.calls[0]![0]).toEqual(payloads[0]);
    expect(adapter.mapHookEventSpy.mock.calls[1]![0]).toEqual(payloads[1]);
    expect(adapter.mapHookEventSpy.mock.calls[2]![0]).toEqual(payloads[2]);
  });

  it('reconnect() calls disconnect() then connect() in order', async () => {
    const callOrder: string[] = [];
    adapter.disconnectSpy.mockImplementation(() => {
      callOrder.push('disconnect');
    });
    adapter.connectSpy.mockImplementation(() => {
      callOrder.push('connect');
    });

    await adapter.connect(BASE_CONFIG);
    callOrder.length = 0; // reset after initial connect

    await adapter.reconnect();

    expect(callOrder).toEqual(['disconnect', 'connect']);
  });

  it('reconnect() restores connected status', async () => {
    await adapter.connect(BASE_CONFIG);
    expect(adapter.status).toBe('connected');

    await adapter.reconnect();

    expect(adapter.status).toBe('connected');
  });

  it('reconnect() throws if connect was never called', async () => {
    await expect(adapter.reconnect()).rejects.toThrow(
      'Cannot reconnect before initial connect'
    );
  });

  it('disconnect() clears event handlers', async () => {
    await adapter.connect(BASE_CONFIG);

    const received: ChatEvent[] = [];
    adapter.on((e) => received.push(e));

    await adapter.disconnect();

    // After disconnect, handlers are cleared — fire() on subclass should not reach them
    adapter.handleHookEvent({ type: 'test' });
    expect(received).toHaveLength(0);
  });

  it('initial status is disconnected', () => {
    expect(adapter.status).toBe('disconnected');
  });

  it('status is connected after connect()', async () => {
    await adapter.connect(BASE_CONFIG);
    expect(adapter.status).toBe('connected');
  });

  it('status is disconnected after disconnect()', async () => {
    await adapter.connect(BASE_CONFIG);
    await adapter.disconnect();
    expect(adapter.status).toBe('disconnected');
  });
});
