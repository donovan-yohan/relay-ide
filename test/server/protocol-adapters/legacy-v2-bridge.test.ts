import { describe, expect, it } from 'vitest';
import { BaseProtocolAdapter } from '../../../server/protocol-adapter.js';
import type {
  AdapterConfig,
  AdapterStatus,
  Attachment,
  SessionOptions,
} from '../../../server/protocol-adapter.js';
import { LegacyProtocolAdapterV2Bridge } from '../../../server/protocol-adapters/legacy-v2-bridge.js';
import type {
  AgentCapabilitySetV2,
  AgentPatchV2,
} from '../../../shared/agent-chat-protocol-v2.js';
import type {
  ChatEvent,
  ChatEventSource,
} from '../../../shared/chat-events.js';

const BASE_CONFIG: AdapterConfig = {
  cwd: '/repo',
  port: 3456,
  sessionId: 'sess-bridge',
  hookToken: 'hook-token',
  configDir: '/config',
};

const CAPABILITIES: AgentCapabilitySetV2 = {
  text: true,
  resume: true,
};

class ReconnectingLegacyAdapter extends BaseProtocolAdapter {
  readonly agentType = 'mock';
  readonly runtimeOwnership = 'attached' as const;

  private config: AdapterConfig | null = null;
  private turnIndex = 0;
  private currentStatus: AdapterStatus = 'disconnected';

  get status(): AdapterStatus {
    return this.currentStatus;
  }

  async connect(config: AdapterConfig): Promise<void> {
    this.config = config;
    this.currentStatus = 'connected';
  }

  protected async onDisconnect(): Promise<void> {
    this.currentStatus = 'disconnected';
  }

  async reconnect(): Promise<void> {
    if (!this.config) throw new Error('Cannot reconnect before connect');
    const config = this.config;
    await this.disconnect();
    await this.connect(config);
  }

  async sendMessage(
    turnId: string,
    content: string,
    _attachments?: Attachment[]
  ): Promise<void> {
    const sessionId = this.config?.sessionId;
    if (!sessionId) throw new Error('No session ID');
    const timestamp = new Date().toISOString();
    const source: ChatEventSource = 'mock';

    this.emit({
      type: 'chat:turn-started',
      sessionId,
      timestamp,
      source,
      turnId,
      turnIndex: this.turnIndex++,
    });
    this.emit({
      type: 'chat:message-complete',
      sessionId,
      timestamp,
      source,
      turnId,
      messageId: `user-${turnId}`,
      role: 'user',
      content,
    });
  }

  async interrupt(_turnId: string): Promise<void> {}
  async respondToApproval(): Promise<void> {}
  async respondToInput(): Promise<void> {}
  async createSession(
    _cwd: string,
    _options?: SessionOptions
  ): Promise<string> {
    return 'created-session';
  }
  async resumeSession(_sessionId: string): Promise<void> {}
  async forkSession(_sessionId: string): Promise<string> {
    return 'forked-session';
  }
}

describe('LegacyProtocolAdapterV2Bridge reconnect', () => {
  it('keeps forwarding legacy adapter events after reconnect clears inner listeners', async () => {
    const bridge = new LegacyProtocolAdapterV2Bridge(
      new ReconnectingLegacyAdapter(),
      CAPABILITIES
    );
    const patches: string[] = [];
    bridge.onPatch((patch) => patches.push(patch.type));

    await bridge.connect(BASE_CONFIG);
    await bridge.reconnect();
    await bridge.sendMessage({ turnId: 'turn-1', content: 'hello' });

    expect(patches).toContain('agent-turn-started-v2');
    expect(patches).toContain('agent-item-updated-v2');
  });
});

/**
 * A legacy adapter whose event stream the test writes by hand, so each failure
 * choreography below is the SHAPE a real adapter fires, replayed exactly.
 */
class ScriptedLegacyAdapter extends BaseProtocolAdapter {
  readonly agentType = 'mock';
  readonly runtimeOwnership = 'attached' as const;

  private currentStatus: AdapterStatus = 'disconnected';

  get status(): AdapterStatus {
    return this.currentStatus;
  }

  async connect(_config: AdapterConfig): Promise<void> {
    this.currentStatus = 'connected';
  }

  protected async onDisconnect(): Promise<void> {
    this.currentStatus = 'disconnected';
  }

  /**
   * How this harness answers on its own wire. Both OpenCode lanes fire a
   * `chat:approval-response` once the provider accepts the decision, so a test
   * that needs the real teardown race installs that echo here.
   */
  approvalWireEcho:
    | ((requestId: string, decision: 'allow' | 'allow-always' | 'deny') => void)
    | null = null;

  async reconnect(): Promise<void> {}
  async sendMessage(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async respondToApproval(
    requestId: string,
    decision: 'allow' | 'allow-always' | 'deny'
  ): Promise<void> {
    const echo = this.approvalWireEcho;
    if (!echo) return;
    // A real wire answers after a round-trip, so the echo lands on a LATER
    // microtask than the cancelled card — which is the ordering the fix has to
    // survive, not a synchronous one it would win by accident.
    await Promise.resolve();
    echo(requestId, decision);
  }
  async respondToInput(): Promise<void> {}
  async createSession(): Promise<string> {
    return 'created-session';
  }
  async resumeSession(): Promise<void> {}
  async forkSession(): Promise<string> {
    return 'forked-session';
  }

  /** Fire one legacy event, filling in the envelope every adapter sets. */
  fire(event: Partial<ChatEvent> & Pick<ChatEvent, 'type'>): void {
    this.emit({
      sessionId: 'sess-bridge',
      timestamp: '2026-01-01T00:00:00.000Z',
      source: 'mock' as ChatEventSource,
      ...event,
    } as ChatEvent);
  }

  startTurn(turnId: string): void {
    this.fire({ type: 'chat:turn-started', turnId, turnIndex: 0 });
  }
}

async function bridgeWithScript(): Promise<{
  inner: ScriptedLegacyAdapter;
  bridge: LegacyProtocolAdapterV2Bridge;
  patches: AgentPatchV2[];
  drain: () => Promise<void>;
}> {
  const inner = new ScriptedLegacyAdapter();
  const bridge = new LegacyProtocolAdapterV2Bridge(inner, CAPABILITIES);
  const patches: AgentPatchV2[] = [];
  bridge.onPatch((patch) => patches.push(patch));
  await bridge.connect(BASE_CONFIG);
  // The bridge's fallback completion is deferred by exactly one microtask, so
  // one awaited tick is the whole wait — no wall clock, nothing to flake on.
  const drain = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  };
  return { inner, bridge, patches, drain };
}

function terminals(
  patches: AgentPatchV2[],
  turnId: string
): Extract<AgentPatchV2, { type: 'agent-turn-completed-v2' }>[] {
  return patches.filter(
    (
      patch
    ): patch is Extract<AgentPatchV2, { type: 'agent-turn-completed-v2' }> =>
      patch.type === 'agent-turn-completed-v2' && patch.turnId === turnId
  );
}

/**
 * #1411 (inverted pins). These used to be impossible to state: the terminal
 * `agent-turn-completed-v2` had no owner, so hermes emitted two per failed
 * turn, opencode one or two depending on which failure path fired, and
 * opencode-attached none. The bridge now owns it, and the conformance floor
 * re-arms hermes's invariant (a) on the back of these.
 */
describe('LegacyProtocolAdapterV2Bridge terminal turn ownership (#1411)', () => {
  it('emits ONE terminal when the adapter pairs chat:error with its own completion (hermes failCurrentTurn)', async () => {
    const { inner, patches, drain } = await bridgeWithScript();
    inner.startTurn('turn-1');

    // hermes-adapter.ts `failCurrentTurn`: error, then the adapter's own
    // completion carrying the honest reason, then the error session status.
    inner.fire({
      type: 'chat:error',
      kind: 'protocol',
      message: 'gateway blew up',
      retryable: true,
      turnId: 'turn-1',
    });
    inner.fire({
      type: 'chat:turn-completed',
      turnId: 'turn-1',
      reason: 'failed',
      durationMs: 0,
      toolCallCount: 0,
      messageCount: 0,
    });
    inner.fire({ type: 'chat:session-status', status: 'error' });
    await drain();

    const completed = terminals(patches, 'turn-1');
    expect(
      completed.length,
      'hermes fires chat:error AND chat:turn-completed on every failure path — the bridge must publish one terminal, not two'
    ).toBe(1);
    expect(completed[0]?.status).toBe('failed');
    // The error text used to ride the synthesized patch; it now rides the one
    // terminal that survives, so a failed turn still says why.
    expect(completed[0]?.error).toBe('gateway blew up');
  });

  it("keeps the adapter's own reason instead of flattening it to failed", async () => {
    const { inner, patches, drain } = await bridgeWithScript();
    inner.startTurn('turn-1');

    // hermes `response.incomplete` fails the turn with reason 'error', and an
    // aborted turn completes with reason 'interrupted' — neither is 'failed'.
    inner.fire({
      type: 'chat:error',
      kind: 'protocol',
      message: 'Hermes response is incomplete: max_output_tokens',
      retryable: true,
      turnId: 'turn-1',
    });
    inner.fire({
      type: 'chat:turn-completed',
      turnId: 'turn-1',
      reason: 'interrupted',
      durationMs: 0,
      toolCallCount: 0,
      messageCount: 0,
    });
    await drain();

    const completed = terminals(patches, 'turn-1');
    expect(completed.length).toBe(1);
    expect(completed[0]?.status).toBe('interrupted');
  });

  it('completes the turn itself when the adapter errors without completing (opencode tui.toast.show)', async () => {
    const { inner, patches, drain } = await bridgeWithScript();
    inner.startTurn('turn-1');

    // opencode-adapter.ts `failCurrentTurn`: error + error status, and the turn
    // is never completed on the wire.
    inner.fire({
      type: 'chat:error',
      kind: 'unknown',
      message: 'OpenCode: conformance provider failure',
      retryable: true,
      turnId: 'turn-1',
    });
    inner.fire({
      type: 'chat:session-status',
      status: 'error',
      error: 'OpenCode: conformance provider failure',
    });
    await drain();

    const completed = terminals(patches, 'turn-1');
    expect(
      completed.length,
      'nothing else will ever end this turn — the bridge owes it a terminal'
    ).toBe(1);
    expect(completed[0]?.status).toBe('failed');
    expect(completed[0]?.error).toBe('OpenCode: conformance provider failure');
    // Ownership is not a licence to reorder: the error patch still precedes it.
    expect(patches.map((patch) => patch.type)).toEqual([
      'agent-turn-started-v2',
      'agent-error-v2',
      'agent-live-state-updated-v2',
      'agent-turn-completed-v2',
    ]);
  });

  it('drops a second completion for a turn that already ended (opencode idle + POST resolution)', async () => {
    const { inner, patches, drain } = await bridgeWithScript();
    inner.startTurn('turn-1');

    // `handleSessionStatus('idle')` completes the turn from the SSE stream and
    // the resolving message POST completes it again with the same turn id.
    for (let i = 0; i < 2; i += 1) {
      inner.fire({
        type: 'chat:turn-completed',
        turnId: 'turn-1',
        reason: 'completed',
        durationMs: 0,
        toolCallCount: 0,
        messageCount: 1,
      });
    }
    await drain();

    expect(terminals(patches, 'turn-1').length).toBe(1);
  });

  it('does not manufacture a terminal for an error with no turn id', async () => {
    const { inner, patches, drain } = await bridgeWithScript();
    inner.startTurn('turn-1');

    // An error with no turnId is a session-level event that binds to no turn,
    // so guessing one here would attribute a failure to whatever happened to be
    // running. This was opencode-attached's `session.error` shape until #1412
    // made it carry the turnId; the bridge rule is unchanged and still applies
    // to any adapter that reports a session-level failure.
    inner.fire({
      type: 'chat:error',
      kind: 'unknown',
      message: 'conformance provider failure',
      retryable: true,
    });
    await drain();

    expect(terminals(patches, 'turn-1')).toEqual([]);
  });

  it('leaves a later turn free to end on its own after an errored one', async () => {
    const { inner, patches, drain } = await bridgeWithScript();

    inner.startTurn('turn-1');
    inner.fire({
      type: 'chat:error',
      kind: 'unknown',
      message: 'first turn died',
      retryable: true,
      turnId: 'turn-1',
    });
    await drain();

    inner.startTurn('turn-2');
    inner.fire({
      type: 'chat:turn-completed',
      turnId: 'turn-2',
      reason: 'completed',
      durationMs: 0,
      toolCallCount: 0,
      messageCount: 1,
    });
    await drain();

    expect(terminals(patches, 'turn-1').map((patch) => patch.status)).toEqual([
      'failed',
    ]);
    expect(terminals(patches, 'turn-2').map((patch) => patch.status)).toEqual([
      'completed',
    ]);
  });

  it('does not fire an armed fallback after disconnect', async () => {
    const { inner, bridge, patches } = await bridgeWithScript();
    inner.startTurn('turn-1');
    inner.fire({
      type: 'chat:error',
      kind: 'unknown',
      message: 'died on the way out',
      retryable: true,
      turnId: 'turn-1',
    });
    await bridge.disconnect();
    await Promise.resolve();
    await Promise.resolve();

    expect(terminals(patches, 'turn-1')).toEqual([]);
  });
});

/** Every approval patch the bridge published for one request id, in order. */
function approvalItems(
  patches: AgentPatchV2[],
  requestId: string
): { status?: string; respondedBy?: string }[] {
  return patches.flatMap((patch) => {
    if (
      patch.type !== 'agent-item-started-v2' &&
      patch.type !== 'agent-item-updated-v2'
    ) {
      return [];
    }
    if (patch.item.type !== 'approval' || patch.item.requestId !== requestId) {
      return [];
    }
    return [
      {
        ...(patch.item.status === undefined
          ? {}
          : { status: patch.item.status }),
        ...(patch.item.respondedBy === undefined
          ? {}
          : { respondedBy: patch.item.respondedBy }),
      },
    ];
  });
}

/**
 * #1407, teardown ordering. The cancelled card is only the LAST word if the
 * inner subscription is gone before the wire deny goes out: the deny is
 * unawaited and both OpenCode lanes answer it with a `chat:approval-response`,
 * which maps to a `completed` / `respondedBy: 'user'` update. `onDisconnect`
 * always unlistened first; `reconnect` used to cancel with the subscription
 * still attached, so the transcript ended up claiming the operator denied an
 * approval they never saw.
 */
describe('LegacyProtocolAdapterV2Bridge approval teardown ordering (#1407)', () => {
  it.each([
    [
      'reconnect',
      async (bridge: LegacyProtocolAdapterV2Bridge) => bridge.reconnect(),
    ],
    [
      'disconnect',
      async (bridge: LegacyProtocolAdapterV2Bridge) => bridge.disconnect(),
    ],
  ])(
    'cancels an outstanding approval and stays cancelled across %s',
    async (_label, teardown) => {
      const { inner, bridge, patches } = await bridgeWithScript();
      inner.approvalWireEcho = (requestId, decision) => {
        inner.fire({
          type: 'chat:approval-response',
          turnId: 'turn-1',
          requestId,
          decision,
          respondedBy: 'user',
        });
      };
      inner.startTurn('turn-1');
      inner.fire({
        type: 'chat:approval-request',
        turnId: 'turn-1',
        requestId: 'per-1',
        kind: 'permission',
        toolName: 'bash',
        description: 'Run pwd in the workspace',
        target: 'pwd',
      });

      await teardown(bridge);
      // Let the wire deny's echo land, if anything is still listening for it.
      await Promise.resolve();
      await Promise.resolve();

      const items = approvalItems(patches, 'per-1');
      expect(items.at(-1)).toEqual({
        status: 'cancelled',
        respondedBy: 'timeout',
      });
      expect(items).not.toContainEqual(
        expect.objectContaining({ respondedBy: 'user' })
      );
    }
  );
});
