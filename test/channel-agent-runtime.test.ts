import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentApprovalResponseInputV2,
  AgentInputResponseInputV2,
  AgentInterruptInputV2,
  AgentPatchHandlerV2,
  AgentSendMessageInputV2,
  AdapterConfig,
  ProtocolAdapterV2,
} from '../server/protocol-adapter-v2.js';
import type {
  AgentPatchV2,
  AgentSessionLiveStateV2,
} from '../shared/agent-chat-protocol-v2.js';
import { emptyAgentSessionV2 } from '../shared/agent-chat-protocol-v2.js';

const adapterState = vi.hoisted(() => ({
  last: null as TestAdapter | null,
  all: [] as TestAdapter[],
  /** Runs inside `connect()`, before it resolves. */
  onConnect: null as ((adapter: TestAdapter) => void) | null,
  /** Make the next adapter report its child dying from inside `connect` (#1307). */
  dieDuringConnect: false,
  /** Adapter can atomically restore the provider session from connect config. */
  resumeDuringConnect: false,
}));

class TestAdapter implements ProtocolAdapterV2 {
  readonly agentType = 'codex';
  readonly runtimeOwnership = 'spawned' as const;
  readonly capabilities = emptyAgentSessionV2({
    id: 'capabilities',
    provider: 'codex',
    cwd: '/tmp',
    capabilities: { text: true, resume: true },
  }).capabilities;
  status = 'disconnected' as const | 'connected';
  resumed: string[] = [];
  connectConfigs: AdapterConfig[] = [];
  disconnectError: Error | null = null;
  interruptCalls = 0;
  interruptReject: Error | null = null;
  private readonly handlers = new Set<AgentPatchHandlerV2>();

  get resumesProviderSessionDuringConnect(): boolean {
    return adapterState.resumeDuringConnect;
  }

  sessionId = 'channel-runtime';

  async connect(config: AdapterConfig): Promise<void> {
    // Real adapters flip to 'connected' partway through their own connect, so
    // the manager's disconnect listener is already live when the child dies.
    this.status = 'connected';
    this.connectConfigs.push(config);
    this.sessionId = config.sessionId;
    adapterState.onConnect?.(this);
    if (adapterState.dieDuringConnect) {
      await Promise.resolve();
      this.emitDisconnected();
    }
  }
  async disconnect(): Promise<void> {
    this.status = 'disconnected';
    if (this.disconnectError) throw this.disconnectError;
  }
  async reconnect(): Promise<void> {}
  async resumeSession(sessionId: string): Promise<void> {
    this.resumed.push(sessionId);
  }
  async sendMessage(_input: AgentSendMessageInputV2): Promise<void> {}
  async interrupt(_input: AgentInterruptInputV2): Promise<void> {
    this.interruptCalls += 1;
    if (this.interruptReject) throw this.interruptReject;
  }
  async respondToApproval(
    _input: AgentApprovalResponseInputV2
  ): Promise<void> {}
  async respondToInput(_input: AgentInputResponseInputV2): Promise<void> {}
  onPatch(handler: AgentPatchHandlerV2): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  broadcastPatch(): void {}
  emitPatch(patch: AgentPatchV2): void {
    for (const handler of [...this.handlers]) handler(patch);
  }
  emitProviderSession(threadId: string): void {
    this.emitPatch({
      type: 'agent-session-updated-v2',
      sessionId: 'channel-runtime',
      timestamp: '2026-07-26T00:00:00.000Z',
      providerSession: { threadId },
    });
  }
  emitLiveState(live: Partial<AgentSessionLiveStateV2>): void {
    this.emitPatch({
      type: 'agent-live-state-updated-v2',
      sessionId: this.sessionId,
      timestamp: '2026-07-26T00:00:00.000Z',
      live,
    });
  }
  emitSnapshot(live: Partial<AgentSessionLiveStateV2>): void {
    const session = emptyAgentSessionV2({
      id: this.sessionId,
      provider: 'codex',
      cwd: '/tmp',
    });
    this.emitPatch({
      type: 'agent-session-snapshot-v2',
      sessionId: this.sessionId,
      timestamp: '2026-07-26T00:00:00.000Z',
      session: { ...session, live: { ...session.live, ...live } },
    });
  }
  emitTurnStarted(turnId: string): void {
    this.emitPatch({
      type: 'agent-turn-started-v2',
      sessionId: this.sessionId,
      timestamp: '2026-07-26T00:00:00.000Z',
      turn: {
        id: turnId,
        status: 'running',
        inputMessageId: `user-${turnId}`,
        items: [],
        startedAt: '2026-07-26T00:00:00.000Z',
      },
    });
  }
  emitTurnCompleted(turnId: string): void {
    this.emitPatch({
      type: 'agent-turn-completed-v2',
      sessionId: this.sessionId,
      timestamp: '2026-07-26T00:00:00.000Z',
      turnId,
      status: 'completed',
      completedAt: '2026-07-26T00:00:00.000Z',
    });
  }
  /** Unexpected process/transport death (#1307). */
  emitDisconnected(): void {
    for (const handler of [...this.handlers]) {
      handler({
        type: 'agent-live-state-updated-v2',
        sessionId: 'channel-runtime',
        timestamp: '2026-07-26T00:00:00.000Z',
        live: {
          status: 'disconnected',
          activeTurnId: null,
          waitingOn: null,
          activeRequestIds: [],
          queueLength: 0,
        },
      });
    }
  }
}

vi.mock('../server/protocol-adapters/index.js', () => ({
  createAdapterV2: () => {
    const adapter = new TestAdapter();
    adapterState.last = adapter;
    adapterState.all.push(adapter);
    return adapter;
  },
}));

async function runtimeModule() {
  return import('../server/channel-agent-runtime.js');
}

afterEach(async () => {
  const { channelAgentRuntimes } = await runtimeModule();
  await channelAgentRuntimes.close();
  adapterState.last = null;
  adapterState.all.length = 0;
  adapterState.onConnect = null;
  adapterState.dieDuringConnect = false;
  adapterState.resumeDuringConnect = false;
});

describe('ChannelAgentRuntimeManager agentState (#1254)', () => {
  it('leaves initializing as soon as the first turn runs and lands idle when it completes', async () => {
    const { channelAgentRuntimes } = await runtimeModule();
    // Codex delivers its first prompt natively (#1240), so the turn lifecycle
    // can arrive while the runtime is still `initializing` — before any full
    // live state was ever observed.
    const observed: string[] = [];
    adapterState.onConnect = (adapter) => {
      adapter.emitTurnStarted('turn-1');
      observed.push(
        channelAgentRuntimes.get('channel-runtime')?.agentState ?? 'missing'
      );
      adapter.emitTurnCompleted('turn-1');
      observed.push(
        channelAgentRuntimes.get('channel-runtime')?.agentState ?? 'missing'
      );
    };

    const runtime = await channelAgentRuntimes.create({
      id: 'channel-runtime',
      providerId: 'codex',
      profileActorId: 'agent-profile:codex:default',
      cwd: '/tmp',
      displayName: '#eng · Codex',
      port: 3456,
      configDir: '/tmp',
    });

    expect(observed).toEqual(['processing', 'idle']);
    expect(runtime.agentState).toBe('idle');
    expect(runtime.idle).toBe(true);
  });

  it('promotes initializing on the first output item of a turn', async () => {
    const { channelAgentRuntimes } = await runtimeModule();
    const observed: string[] = [];
    adapterState.onConnect = (adapter) => {
      adapter.emitPatch({
        type: 'agent-item-started-v2',
        sessionId: adapter.sessionId,
        timestamp: '2026-07-26T00:00:00.000Z',
        turnId: 'turn-1',
        item: {
          id: 'assistant-1',
          type: 'assistantMessage',
          text: 'CODEX_OK',
          status: 'streaming',
        },
      });
      observed.push(
        channelAgentRuntimes.get('channel-runtime')?.agentState ?? 'missing'
      );
    };

    await channelAgentRuntimes.create({
      id: 'channel-runtime',
      providerId: 'codex',
      profileActorId: 'agent-profile:codex:default',
      cwd: '/tmp',
      displayName: '#eng · Codex',
      port: 3456,
      configDir: '/tmp',
    });

    expect(observed).toEqual(['processing']);
  });

  it('keeps a live turn observed during connect instead of stamping idle', async () => {
    const { channelAgentRuntimes } = await runtimeModule();
    adapterState.onConnect = (adapter) => {
      adapter.emitLiveState({ status: 'working', activeTurnId: 'turn-1' });
    };

    const runtime = await channelAgentRuntimes.create({
      id: 'channel-runtime',
      providerId: 'codex',
      profileActorId: 'agent-profile:codex:default',
      cwd: '/tmp',
      displayName: '#eng · Codex',
      port: 3456,
      configDir: '/tmp',
    });

    expect(runtime.agentState).toBe('processing');
    expect(runtime.idle).toBe(false);
  });

  it('ignores a partial live state that carries no status', async () => {
    const { channelAgentRuntimes } = await runtimeModule();
    const runtime = await channelAgentRuntimes.create({
      id: 'channel-runtime',
      providerId: 'codex',
      profileActorId: 'agent-profile:codex:default',
      cwd: '/tmp',
      displayName: '#eng · Codex',
      port: 3456,
      configDir: '/tmp',
    });
    const adapter = adapterState.last!;

    adapter.emitLiveState({ status: 'working', activeTurnId: 'turn-1' });
    expect(runtime.agentState).toBe('processing');

    // `rejectQueued` emits a bare `{ queueLength }`; in claude-adapter that
    // fires mid-turn when a runtime-env refresh boundary fails.
    adapter.emitLiveState({ queueLength: 0 });
    expect(runtime.agentState).toBe('processing');
    expect(runtime.idle).toBe(false);

    adapter.emitLiveState({ status: 'waiting', waitingOn: 'approval' });
    expect(runtime.agentState).toBe('permission-prompt');

    // The approval is answered, so the turn resumes and then ends.
    adapter.emitLiveState({ status: 'working', activeTurnId: 'turn-1' });
    expect(runtime.agentState).toBe('processing');

    adapter.emitLiveState({ status: 'idle', activeTurnId: null });
    expect(runtime.agentState).toBe('idle');
    expect(runtime.idle).toBe(true);
  });

  it('keeps an outstanding approval when a bare idle live state arrives', async () => {
    const { channelAgentRuntimes } = await runtimeModule();
    const runtime = await channelAgentRuntimes.create({
      id: 'channel-runtime',
      providerId: 'hermes',
      profileActorId: 'agent-profile:hermes:default',
      cwd: '/tmp',
      displayName: '#eng · Hermes',
      port: 3456,
      configDir: '/tmp',
    });
    const adapter = adapterState.last!;

    adapter.emitLiveState({ status: 'waiting', waitingOn: 'approval' });
    expect(runtime.agentState).toBe('permission-prompt');

    // hermes fires `session-status {status:'idle', waitingOn:'approval'}`
    // alongside the prompt, and the v1 compat mapping strips `waitingOn` from
    // every idle — so a BARE idle arrives mid-approval (#1181 defect 3).
    adapter.emitLiveState({
      status: 'idle',
      activeTurnId: null,
      waitingOn: null,
    });
    expect(runtime.agentState).toBe('permission-prompt');
    expect(runtime.idle).toBe(false);

    // A question prompt is parked on the operator the same way.
    adapter.emitLiveState({ status: 'waiting', waitingOn: 'question' });
    expect(runtime.agentState).toBe('waiting-for-input');
    adapter.emitLiveState({ status: 'idle', activeTurnId: null });
    expect(runtime.agentState).toBe('waiting-for-input');
    expect(runtime.idle).toBe(false);

    // A turn terminal is authoritative: it ends the turn that owned the prompt,
    // so it is the guaranteed exit from a parked state.
    adapter.emitTurnCompleted('turn-1');
    expect(runtime.agentState).toBe('idle');
    expect(runtime.idle).toBe(true);
  });

  it('keeps running through a system wait so the idle that ends the turn lands', async () => {
    const { channelAgentRuntimes } = await runtimeModule();
    const runtime = await channelAgentRuntimes.create({
      id: 'channel-runtime',
      providerId: 'codex',
      profileActorId: 'agent-profile:codex:default',
      cwd: '/tmp',
      displayName: '#eng · Codex',
      port: 3456,
      configDir: '/tmp',
    });
    const adapter = adapterState.last!;

    // `tool` and `network` waits are the runtime waiting on itself — nobody owes
    // it an answer, so they must not park the machine against a later idle.
    for (const waitingOn of ['tool', 'network'] as const) {
      adapter.emitLiveState({
        status: 'waiting',
        activeTurnId: 'turn-1',
        waitingOn,
      });
      expect(runtime.agentState).toBe('processing');
      expect(runtime.idle).toBe(false);

      adapter.emitLiveState({ status: 'idle', activeTurnId: null });
      expect(runtime.agentState).toBe('idle');
      expect(runtime.idle).toBe(true);
    }
  });

  it('leaves initializing on a resume that delivers only a session snapshot', async () => {
    const { channelAgentRuntimes } = await runtimeModule();
    const observed: string[] = [];
    adapterState.onConnect = (adapter) => {
      // `agent-session-snapshot-v2` embeds a COMPLETE live state.
      adapter.emitSnapshot({ status: 'working', activeTurnId: 'turn-1' });
      observed.push(
        channelAgentRuntimes.get('channel-runtime')?.agentState ?? 'missing'
      );
    };

    const runtime = await channelAgentRuntimes.create({
      id: 'channel-runtime',
      providerId: 'codex',
      profileActorId: 'agent-profile:codex:default',
      cwd: '/tmp',
      displayName: '#eng · Codex',
      port: 3456,
      configDir: '/tmp',
    });

    expect(observed).toEqual(['processing']);
    expect(runtime.agentState).toBe('processing');

    // A snapshot's `waitingOn` is trustworthy, so its idle clears a prompt that
    // an incremental patch could not.
    const adapter = adapterState.last!;
    adapter.emitLiveState({ status: 'waiting', waitingOn: 'approval' });
    expect(runtime.agentState).toBe('permission-prompt');
    adapter.emitSnapshot({ status: 'idle' });
    expect(runtime.agentState).toBe('idle');
    expect(runtime.idle).toBe(true);
  });

  it('reports an approval item as a permission prompt even before its live state', async () => {
    const { channelAgentRuntimes } = await runtimeModule();
    const observed: string[] = [];
    adapterState.onConnect = (adapter) => {
      adapter.emitPatch({
        type: 'agent-item-started-v2',
        sessionId: adapter.sessionId,
        timestamp: '2026-07-26T00:00:00.000Z',
        turnId: 'turn-1',
        item: {
          id: 'approval-1',
          type: 'approval',
          requestId: 'req-1',
          kind: 'command',
          description: 'Run command: ls',
          target: 'ls',
          status: 'pending',
        },
      });
      observed.push(
        channelAgentRuntimes.get('channel-runtime')?.agentState ?? 'missing'
      );
    };

    const runtime = await channelAgentRuntimes.create({
      id: 'channel-runtime',
      providerId: 'codex',
      profileActorId: 'agent-profile:codex:default',
      cwd: '/tmp',
      displayName: '#eng · Codex',
      port: 3456,
      configDir: '/tmp',
    });

    expect(observed).toEqual(['permission-prompt']);
    expect(runtime.agentState).toBe('permission-prompt');
    expect(runtime.idle).toBe(false);
  });

  it('leaves the run state alone for an agent-error-v2 complaint', async () => {
    const { channelAgentRuntimes } = await runtimeModule();
    const runtime = await channelAgentRuntimes.create({
      id: 'channel-runtime',
      providerId: 'codex',
      profileActorId: 'agent-profile:codex:default',
      cwd: '/tmp',
      displayName: '#eng · Codex',
      port: 3456,
      configDir: '/tmp',
    });
    const adapter = adapterState.last!;

    adapter.emitLiveState({ status: 'working', activeTurnId: 'turn-1' });
    // Codex answers a malformed slash command with `agent-error-v2` and keeps
    // running, so the patch carries no run-state signal.
    adapter.emitPatch({
      type: 'agent-error-v2',
      sessionId: adapter.sessionId,
      timestamp: '2026-07-26T00:00:00.000Z',
      message: 'resume requires a thread id argument: /resume <threadId>',
    });
    expect(runtime.agentState).toBe('processing');
    expect(runtime.idle).toBe(false);

    // A real failure reports itself through the live state.
    adapter.emitLiveState({ status: 'error', error: 'runtime exited' });
    expect(runtime.agentState).toBe('error');
    expect(runtime.idle).toBe(false);
  });
});

describe('ChannelAgentRuntimeManager', () => {
  it('resumes from the channel binding provider session and remains outside the public session registry', async () => {
    const { channelAgentRuntimes } = await runtimeModule();
    const sessions = await import('../server/sessions.js');
    const runtime = await channelAgentRuntimes.create({
      id: 'channel-runtime',
      providerId: 'codex',
      profileActorId: 'agent-profile:codex:default',
      cwd: '/tmp',
      displayName: '#eng · Codex',
      port: 3456,
      configDir: '/tmp',
      providerSession: { threadId: 'provider-thread-1' },
    });

    expect(adapterState.last?.resumed).toEqual(['provider-thread-1']);
    expect(channelAgentRuntimes.get(runtime.id)).toBe(runtime);
    expect(sessions.get(runtime.id)).toBeUndefined();
    expect(sessions.list().some((session) => session.id === runtime.id)).toBe(
      false
    );
  });

  it('lets an adapter atomically resume a saved provider session during connect', async () => {
    const { channelAgentRuntimes } = await runtimeModule();
    adapterState.resumeDuringConnect = true;

    await channelAgentRuntimes.create({
      id: 'channel-runtime',
      providerId: 'codex',
      profileActorId: 'agent-profile:codex:default',
      cwd: '/tmp',
      displayName: '#eng · Codex',
      port: 3456,
      configDir: '/tmp',
      providerSession: { threadId: 'provider-thread-1' },
    });

    expect(adapterState.last?.connectConfigs).toEqual([
      expect.objectContaining({ resumeSessionId: 'provider-thread-1' }),
    ]);
    expect(adapterState.last?.resumed).toEqual([]);
  });

  it('captures provider identity and rejects duplicate runtime ids', async () => {
    const { channelAgentRuntimes } = await runtimeModule();
    const runtime = await channelAgentRuntimes.create({
      id: 'channel-runtime',
      providerId: 'codex',
      profileActorId: 'agent-profile:codex:default',
      cwd: '/tmp',
      displayName: '#eng · Codex',
      port: 3456,
      configDir: '/tmp',
    });
    adapterState.last?.emitProviderSession('provider-thread-2');

    expect(runtime.providerSession).toEqual({ threadId: 'provider-thread-2' });
    await expect(
      channelAgentRuntimes.create({
        id: runtime.id,
        providerId: 'codex',
        profileActorId: 'agent-profile:codex:default',
        cwd: '/tmp',
        displayName: '#eng · Codex',
        port: 3456,
        configDir: '/tmp',
      })
    ).rejects.toThrow('already exists');
  });

  it('makes destroy absorbing before adapter teardown', async () => {
    const { channelAgentRuntimes } = await runtimeModule();
    const runtime = await channelAgentRuntimes.create({
      id: 'channel-runtime',
      providerId: 'codex',
      profileActorId: 'agent-profile:codex:default',
      cwd: '/tmp',
      displayName: '#eng · Codex',
      port: 3456,
      configDir: '/tmp',
    });
    const adapter = adapterState.last!;

    await channelAgentRuntimes.destroy(runtime.id);
    adapter.emitProviderSession('late-provider-thread');

    expect(channelAgentRuntimes.get(runtime.id)).toBeUndefined();
    expect(runtime.providerSession).toEqual({});
    expect(runtime.status).toBe('disconnected');
  });

  it('isolates runtime end handlers so one failure cannot skip later cleanup', async () => {
    const { channelAgentRuntimes } = await runtimeModule();
    const runtime = await channelAgentRuntimes.create({
      id: 'channel-runtime',
      providerId: 'codex',
      profileActorId: 'agent-profile:codex:default',
      cwd: '/tmp',
      displayName: '#eng · Codex',
      port: 3456,
      configDir: '/tmp',
    });
    const observed: string[] = [];
    const offThrowing = channelAgentRuntimes.onRuntimeEnd(() => {
      throw new Error('end observer failed');
    });
    const offHealthy = channelAgentRuntimes.onRuntimeEnd((runtimeId) => {
      observed.push(runtimeId);
    });

    await expect(
      channelAgentRuntimes.destroy(runtime.id)
    ).resolves.toBeUndefined();
    expect(observed).toEqual([runtime.id]);
    expect(channelAgentRuntimes.get(runtime.id)).toBeUndefined();
    offThrowing();
    offHealthy();
  });

  it('ends a runtime whose adapter reports an unexpected disconnect (#1307)', async () => {
    const { channelAgentRuntimes } = await runtimeModule();
    const runtime = await channelAgentRuntimes.create({
      id: 'channel-runtime',
      providerId: 'codex',
      profileActorId: 'agent-profile:codex:default',
      cwd: '/tmp',
      displayName: '#eng · Codex',
      port: 3456,
      configDir: '/tmp',
    });
    const ended: string[] = [];
    const off = channelAgentRuntimes.onRuntimeEnd((id) => ended.push(id));

    // No `destroy` call anywhere: the child died on its own. Without this the
    // runtime stays 'active' in the registry forever and the channel binder —
    // whose ONLY teardown signal is `onRuntimeEnd` — keeps broadcasting the
    // status the agent had when it died.
    adapterState.last!.emitDisconnected();
    await vi.waitFor(() => expect(ended).toEqual([runtime.id]));

    expect(channelAgentRuntimes.get(runtime.id)).toBeUndefined();
    expect(runtime.status).toBe('disconnected');
    off();
  });

  it('rejects instead of returning a runtime the disconnect listener already ended (#1307)', async () => {
    // The death lands INSIDE `create`'s own connect await, so the listener
    // installed above has already destroyed this runtime by the time connect
    // resolves. Returning it anyway would hand the channel binder a corpse: it
    // would attach its bridge to the disconnected adapter and persist
    // `runtimeId` durably for a runtime that is no longer in the registry.
    const { channelAgentRuntimes } = await runtimeModule();
    adapterState.dieDuringConnect = true;

    await expect(
      channelAgentRuntimes.create({
        id: 'channel-runtime',
        providerId: 'codex',
        profileActorId: 'agent-profile:codex:default',
        cwd: '/tmp',
        displayName: '#eng · Codex',
        port: 3456,
        configDir: '/tmp',
      })
    ).rejects.toThrow(/died during connect/);

    expect(channelAgentRuntimes.get('channel-runtime')).toBeUndefined();
  });

  it('closes every runtime when one adapter disconnect rejects', async () => {
    const { channelAgentRuntimes } = await runtimeModule();
    const first = await channelAgentRuntimes.create({
      id: 'channel-runtime-a',
      providerId: 'codex',
      profileActorId: 'agent-profile:codex:a',
      cwd: '/tmp',
      displayName: '#eng · Codex A',
      port: 3456,
      configDir: '/tmp',
    });
    const firstAdapter = adapterState.last!;
    const second = await channelAgentRuntimes.create({
      id: 'channel-runtime-b',
      providerId: 'codex',
      profileActorId: 'agent-profile:codex:b',
      cwd: '/tmp',
      displayName: '#eng · Codex B',
      port: 3456,
      configDir: '/tmp',
    });
    firstAdapter.disconnectError = new Error('disconnect failed');

    await expect(channelAgentRuntimes.close()).resolves.toBeUndefined();
    expect(channelAgentRuntimes.get(first.id)).toBeUndefined();
    expect(channelAgentRuntimes.get(second.id)).toBeUndefined();
    expect(adapterState.last?.status).toBe('disconnected');
  });
});

describe('ChannelAgentRuntimeManager burn-loop backstop', () => {
  const itemPatch = (item: object) => ({
    type: 'agent-item-started-v2' as const,
    sessionId: 'channel-runtime',
    timestamp: '2026-07-26T00:00:00.000Z',
    turnId: 'turn-1',
    item,
  });
  /** Emit a terminal FAILED completion for an item id (advances the burn guard). */
  const failPatch = (item: object) => ({
    type: 'agent-item-updated-v2' as const,
    sessionId: 'channel-runtime',
    timestamp: '2026-07-26T00:00:00.000Z',
    turnId: 'turn-1',
    item,
  });
  /** A completed FAILED commandExecution for an id (exitCode 1). */
  const failCmd = (id: string, command: string) => ({
    id,
    type: 'commandExecution' as const,
    command,
    output: 'err',
    status: 'completed',
    exitCode: 1,
  });

  it('aborts after the same command tool repeats 3x with no assistant text', async () => {
    const { channelAgentRuntimes } = await runtimeModule();
    await channelAgentRuntimes.create({
      id: 'channel-runtime',
      providerId: 'codex',
      profileActorId: 'agent-profile:codex:default',
      cwd: '/tmp',
      displayName: '#eng · Codex',
      port: 3456,
      configDir: '/tmp',
    });
    const adapter = adapterState.last!;
    const cmd = (i: number) => ({
      id: `cmd-${i}`,
      type: 'commandExecution' as const,
      command: 'ls',
      output: '',
      status: 'running',
    });

    adapter.emitPatch(itemPatch(cmd(1)));
    adapter.emitPatch(failPatch(failCmd('cmd-1', 'ls')));
    adapter.emitPatch(itemPatch(cmd(2)));
    adapter.emitPatch(failPatch(failCmd('cmd-2', 'ls')));
    expect(adapter.interruptCalls).toBe(0);
    adapter.emitPatch(itemPatch(cmd(3)));
    adapter.emitPatch(failPatch(failCmd('cmd-3', 'ls')));

    // Interrupt is async-fired; flush microtasks.
    await new Promise((r) => setTimeout(r, 0));
    expect(adapter.interruptCalls).toBe(1);
  });

  it('resets the loop when assistant text intervenes, so a fresh run must re-arm', async () => {
    const { channelAgentRuntimes } = await runtimeModule();
    await channelAgentRuntimes.create({
      id: 'channel-runtime',
      providerId: 'codex',
      profileActorId: 'agent-profile:codex:default',
      cwd: '/tmp',
      displayName: '#eng · Codex',
      port: 3456,
      configDir: '/tmp',
    });
    const adapter = adapterState.last!;
    const cmd = (i: number) => ({
      id: `cmd-${i}`,
      type: 'commandExecution' as const,
      command: 'ls',
      output: '',
      status: 'running',
    });

    // Two identical calls before text -> no abort yet.
    adapter.emitPatch(itemPatch(cmd(1)));
    adapter.emitPatch(itemPatch(cmd(2)));
    adapter.emitPatch({
      ...itemPatch({
        id: 'assistant-1',
        type: 'assistantMessage' as const,
        text: 'checking',
        status: 'streaming',
      }),
    });
    // Assistant text reset the counter; two identical calls after it must NOT
    // abort (only the third consecutive identical call aborts).
    adapter.emitPatch(itemPatch(cmd(3)));
    adapter.emitPatch(itemPatch(cmd(4)));

    await new Promise((r) => setTimeout(r, 0));
    expect(adapter.interruptCalls).toBe(0);
  });

  it('resets the loop on a new turn and aborts again within it', async () => {
    const { channelAgentRuntimes } = await runtimeModule();
    await channelAgentRuntimes.create({
      id: 'channel-runtime',
      providerId: 'codex',
      profileActorId: 'agent-profile:codex:default',
      cwd: '/tmp',
      displayName: '#eng · Codex',
      port: 3456,
      configDir: '/tmp',
    });
    const adapter = adapterState.last!;
    const cmd = (i: number) => ({
      id: `cmd-${i}`,
      type: 'commandExecution' as const,
      command: 'ls',
      output: '',
      status: 'running',
    });

    adapter.emitPatch(itemPatch(cmd(1)));
    adapter.emitPatch(failPatch(failCmd('cmd-1', 'ls')));
    adapter.emitPatch(itemPatch(cmd(2)));
    adapter.emitPatch(failPatch(failCmd('cmd-2', 'ls')));
    adapter.emitPatch(itemPatch(cmd(3)));
    adapter.emitPatch(failPatch(failCmd('cmd-3', 'ls')));
    await new Promise((r) => setTimeout(r, 0));
    expect(adapter.interruptCalls).toBe(1);

    // New turn resets the guard; a different tool then repeats with no output.
    adapter.emitTurnStarted('turn-2');
    adapter.emitPatch({
      ...itemPatch(cmd(1)),
      turnId: 'turn-2',
    });
    adapter.emitPatch({
      ...failPatch(failCmd('cmd-1', 'ls')),
      turnId: 'turn-2',
    });
    adapter.emitPatch({
      ...itemPatch(cmd(2)),
      turnId: 'turn-2',
    });
    adapter.emitPatch({
      ...failPatch(failCmd('cmd-2', 'ls')),
      turnId: 'turn-2',
    });
    adapter.emitPatch({
      ...itemPatch(cmd(3)),
      turnId: 'turn-2',
    });
    adapter.emitPatch({
      ...failPatch(failCmd('cmd-3', 'ls')),
      turnId: 'turn-2',
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(adapter.interruptCalls).toBe(2);
  });

  it('treats a completed tool result as progress and does not abort', async () => {
    const { channelAgentRuntimes } = await runtimeModule();
    await channelAgentRuntimes.create({
      id: 'channel-runtime',
      providerId: 'codex',
      profileActorId: 'agent-profile:codex:default',
      cwd: '/tmp',
      displayName: '#eng · Codex',
      port: 3456,
      configDir: '/tmp',
    });
    const adapter = adapterState.last!;
    const cmd = (i: number) => ({
      id: `cmd-${i}`,
      type: 'commandExecution' as const,
      command: 'ls',
      output: '',
      status: 'running',
    });
    const done = (i: number) => ({
      id: `cmd-${i}`,
      type: 'commandExecution' as const,
      command: 'ls',
      output: 'file-a\nfile-b',
      status: 'completed',
      exitCode: 0,
    });
    const silentDone = (i: number) => ({
      id: `cmd-${i}`,
      type: 'commandExecution' as const,
      command: 'ls',
      output: '',
      status: 'completed',
    });

    adapter.emitPatch(itemPatch(cmd(1)));
    adapter.emitPatch(itemPatch(cmd(2)));
    // A completed result with output resets the counter before the next starts.
    adapter.emitPatch({
      type: 'agent-item-updated-v2',
      sessionId: 'channel-runtime',
      timestamp: '2026-07-26T00:00:00.000Z',
      turnId: 'turn-1',
      item: done(2),
    });
    // Only two consecutive identical starts after the reset -> no abort.
    adapter.emitPatch(itemPatch(cmd(3)));
    adapter.emitPatch(itemPatch(cmd(4)));

    await new Promise((r) => setTimeout(r, 0));
    expect(adapter.interruptCalls).toBe(0);

    // A terminal command with empty output and no exitCode is still a result.
    // Fresh turn resets the guard so the silent sequence starts at zero.
    adapter.emitTurnStarted('turn-2');
    adapter.emitPatch({
      ...itemPatch(cmd(5)),
      turnId: 'turn-2',
    });
    adapter.emitPatch({
      ...itemPatch(cmd(6)),
      turnId: 'turn-2',
    });
    adapter.emitPatch({
      type: 'agent-item-updated-v2',
      sessionId: 'channel-runtime',
      timestamp: '2026-07-26T00:00:00.000Z',
      turnId: 'turn-2',
      item: silentDone(6),
    });
    adapter.emitPatch({
      ...itemPatch(cmd(7)),
      turnId: 'turn-2',
    });
    adapter.emitPatch({
      ...itemPatch(cmd(8)),
      turnId: 'turn-2',
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(adapter.interruptCalls).toBe(0);
  });

  it('does not treat repeated error deltas as progress; still aborts the loop', async () => {
    const { channelAgentRuntimes } = await runtimeModule();
    await channelAgentRuntimes.create({
      id: 'channel-runtime',
      providerId: 'codex',
      profileActorId: 'agent-profile:codex:default',
      cwd: '/tmp',
      displayName: '#eng · Codex',
      port: 3456,
      configDir: '/tmp',
    });
    const adapter = adapterState.last!;
    const cmd = (i: number) => ({
      id: `cmd-${i}`,
      type: 'commandExecution' as const,
      command: 'flaky',
      output: '',
      status: 'running',
    });
    const errorDone = (i: number) => ({
      id: `cmd-${i}`,
      type: 'commandExecution' as const,
      command: 'flaky',
      output: 'error: boom',
      status: 'completed',
      exitCode: 1,
    });
    const errorDelta = (i: number) => ({
      type: 'agent-item-delta-v2' as const,
      sessionId: 'channel-runtime',
      timestamp: '2026-07-26T00:00:00.000Z',
      turnId: 'turn-1',
      itemId: `cmd-${i}`,
      delta: { output: 'error: boom' },
    });

    // Each attempt streams the SAME error and completes with exitCode 1.
    // Deltas must NOT reset the fingerprint; the non-zero exitCode must not
    // reset either, so the third start aborts.
    for (let i = 1; i <= 2; i += 1) {
      adapter.emitPatch(itemPatch(cmd(i)));
      adapter.emitPatch(errorDelta(i));
      adapter.emitPatch({
        type: 'agent-item-updated-v2',
        sessionId: 'channel-runtime',
        timestamp: '2026-07-26T00:00:00.000Z',
        turnId: 'turn-1',
        item: errorDone(i),
      });
    }
    adapter.emitPatch(itemPatch(cmd(3)));
    adapter.emitPatch(errorDelta(3));
    adapter.emitPatch({
      type: 'agent-item-updated-v2',
      sessionId: 'channel-runtime',
      timestamp: '2026-07-26T00:00:00.000Z',
      turnId: 'turn-1',
      item: errorDone(3),
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(adapter.interruptCalls).toBe(1);
  });

  it('does not reset on a failed dynamicToolCall result; still aborts the loop', async () => {
    const { channelAgentRuntimes } = await runtimeModule();
    await channelAgentRuntimes.create({
      id: 'channel-runtime',
      providerId: 'codex',
      profileActorId: 'agent-profile:codex:default',
      cwd: '/tmp',
      displayName: '#eng · Codex',
      port: 3456,
      configDir: '/tmp',
    });
    const adapter = adapterState.last!;
    const dyn = (i: number) => ({
      id: `dyn-${i}`,
      type: 'dynamicToolCall' as const,
      namespace: 'pi',
      tool: 'x',
      arguments: { a: 1 },
      status: 'running',
    });
    const failedDone = (i: number) => ({
      id: `dyn-${i}`,
      type: 'dynamicToolCall' as const,
      namespace: 'pi',
      tool: 'x',
      arguments: { a: 1 },
      status: 'completed',
      result: { isError: true, error: 'boom' },
    });

    for (let i = 1; i <= 2; i += 1) {
      adapter.emitPatch(itemPatch(dyn(i)));
      adapter.emitPatch({
        type: 'agent-item-updated-v2',
        sessionId: 'channel-runtime',
        timestamp: '2026-07-26T00:00:00.000Z',
        turnId: 'turn-1',
        item: failedDone(i),
      });
    }
    adapter.emitPatch(itemPatch(dyn(3)));
    adapter.emitPatch({
      type: 'agent-item-updated-v2',
      sessionId: 'channel-runtime',
      timestamp: '2026-07-26T00:00:00.000Z',
      turnId: 'turn-1',
      item: failedDone(3),
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(adapter.interruptCalls).toBe(1);
  });

  it('treats a null exitCode completed command as success (resets the guard)', async () => {
    const { channelAgentRuntimes } = await runtimeModule();
    await channelAgentRuntimes.create({
      id: 'channel-runtime',
      providerId: 'codex',
      profileActorId: 'agent-profile:codex:default',
      cwd: '/tmp',
      displayName: '#eng · Codex',
      port: 3456,
      configDir: '/tmp',
    });
    const adapter = adapterState.last!;
    const cmd = (i: number) => ({
      id: `cmd-${i}`,
      type: 'commandExecution' as const,
      command: 'ls',
      output: '',
      status: 'running',
    });
    const nullDone = (i: number) => ({
      id: `cmd-${i}`,
      type: 'commandExecution' as const,
      command: 'ls',
      output: '',
      status: 'completed',
      exitCode: null,
    });

    adapter.emitPatch(itemPatch(cmd(1)));
    adapter.emitPatch(itemPatch(cmd(2)));
    adapter.emitPatch({
      type: 'agent-item-updated-v2',
      sessionId: 'channel-runtime',
      timestamp: '2026-07-26T00:00:00.000Z',
      turnId: 'turn-1',
      item: nullDone(2),
    });
    adapter.emitPatch(itemPatch(cmd(3)));
    adapter.emitPatch(itemPatch(cmd(4)));
    await new Promise((r) => setTimeout(r, 0));
    expect(adapter.interruptCalls).toBe(0);
  });

  it('does not treat benign error-like results as failures', async () => {
    const { channelAgentRuntimes } = await runtimeModule();
    await channelAgentRuntimes.create({
      id: 'channel-runtime',
      providerId: 'codex',
      profileActorId: 'agent-profile:codex:default',
      cwd: '/tmp',
      displayName: '#eng · Codex',
      port: 3456,
      configDir: '/tmp',
    });
    const adapter = adapterState.last!;
    const dyn = (i: number) => ({
      id: `dyn-${i}`,
      type: 'dynamicToolCall' as const,
      namespace: 'pi',
      tool: 'x',
      arguments: { a: 1 },
      status: 'running',
    });
    // `{ error: null }` and `{ data: null, error: null }` are success-like results.
    const okDone = (i: number, result: unknown) => ({
      id: `dyn-${i}`,
      type: 'dynamicToolCall' as const,
      namespace: 'pi',
      tool: 'x',
      arguments: { a: 1 },
      status: 'completed',
      result,
    });

    // Two attempts, each completing with a benign result -> each resets.
    adapter.emitPatch(itemPatch(dyn(1)));
    adapter.emitPatch({
      type: 'agent-item-updated-v2',
      sessionId: 'channel-runtime',
      timestamp: '2026-07-26T00:00:00.000Z',
      turnId: 'turn-1',
      item: okDone(1, { error: null }),
    });
    adapter.emitPatch(itemPatch(dyn(2)));
    adapter.emitPatch({
      type: 'agent-item-updated-v2',
      sessionId: 'channel-runtime',
      timestamp: '2026-07-26T00:00:00.000Z',
      turnId: 'turn-1',
      item: okDone(2, { data: null, error: null }),
    });
    // Only one more identical start after two benign resets -> no abort.
    adapter.emitPatch(itemPatch(dyn(3)));
    await new Promise((r) => setTimeout(r, 0));
    expect(adapter.interruptCalls).toBe(0);
  });

  it('does not track fileChange items, so repeated edits to one path are safe', async () => {
    const { channelAgentRuntimes } = await runtimeModule();
    await channelAgentRuntimes.create({
      id: 'channel-runtime',
      providerId: 'codex',
      profileActorId: 'agent-profile:codex:default',
      cwd: '/tmp',
      displayName: '#eng · Codex',
      port: 3456,
      configDir: '/tmp',
    });
    const adapter = adapterState.last!;
    const edit = (i: number) => ({
      id: `edit-${i}`,
      type: 'fileChange' as const,
      paths: [{ path: '/tmp/a.ts', status: 'edited' }],
      applyStatus: 'pending',
      status: 'running',
    });

    // Many identical-path edits must never abort (fingerprint excludes fileChange).
    for (let i = 1; i <= 8; i += 1) adapter.emitPatch(itemPatch(edit(i)));

    await new Promise((r) => setTimeout(r, 0));
    expect(adapter.interruptCalls).toBe(0);
  });

  it('aborts on an alternating two-fingerprint loop (per-fingerprint counts)', async () => {
    const { channelAgentRuntimes } = await runtimeModule();
    await channelAgentRuntimes.create({
      id: 'channel-runtime',
      providerId: 'codex',
      profileActorId: 'agent-profile:codex:default',
      cwd: '/tmp',
      displayName: '#eng · Codex',
      port: 3456,
      configDir: '/tmp',
    });
    const adapter = adapterState.last!;
    const cmdA = (i: number) => ({
      id: `a-${i}`,
      type: 'commandExecution' as const,
      command: 'cmd-a',
      output: '',
      status: 'running',
    });
    const cmdB = (i: number) => ({
      id: `b-${i}`,
      type: 'commandExecution' as const,
      command: 'cmd-b',
      output: '',
      status: 'running',
    });

    // A, B, A, B, A, B: each fingerprint reaches 3 failures without success, so
    // the per-fingerprint counter aborts (an old single counter would never fire).
    adapter.emitPatch(itemPatch(cmdA(1)));
    adapter.emitPatch(failPatch(failCmd('a-1', 'cmd-a')));
    adapter.emitPatch(itemPatch(cmdB(1)));
    adapter.emitPatch(failPatch(failCmd('b-1', 'cmd-b')));
    adapter.emitPatch(itemPatch(cmdA(2)));
    adapter.emitPatch(failPatch(failCmd('a-2', 'cmd-a')));
    adapter.emitPatch(itemPatch(cmdB(2)));
    adapter.emitPatch(failPatch(failCmd('b-2', 'cmd-b')));
    adapter.emitPatch(itemPatch(cmdA(3)));
    adapter.emitPatch(failPatch(failCmd('a-3', 'cmd-a')));
    await new Promise((r) => setTimeout(r, 0));
    expect(adapter.interruptCalls).toBe(1);
  });

  it('aborts on a distinct-fingerprint loop via the total no-progress cap', async () => {
    const { channelAgentRuntimes } = await runtimeModule();
    await channelAgentRuntimes.create({
      id: 'channel-runtime',
      providerId: 'codex',
      profileActorId: 'agent-profile:codex:default',
      cwd: '/tmp',
      displayName: '#eng · Codex',
      port: 3456,
      configDir: '/tmp',
    });
    const adapter = adapterState.last!;
    // Every call has a distinct command, so no single fingerprint reaches 3.
    const cmd = (i: number) => ({
      id: `cmd-${i}`,
      type: 'commandExecution' as const,
      command: `distinct-${i}`,
      output: '',
      status: 'running',
    });

    for (let i = 1; i <= 12; i += 1) {
      adapter.emitPatch(itemPatch(cmd(i)));
      adapter.emitPatch(failPatch(failCmd(`cmd-${i}`, `distinct-${i}`)));
    }

    await new Promise((r) => setTimeout(r, 0));
    expect(adapter.interruptCalls).toBe(1);
  });

  it('does not reset on an empty assistantMessage start, but resets on real text delta', async () => {
    const { channelAgentRuntimes } = await runtimeModule();
    await channelAgentRuntimes.create({
      id: 'channel-runtime',
      providerId: 'codex',
      profileActorId: 'agent-profile:codex:default',
      cwd: '/tmp',
      displayName: '#eng · Codex',
      port: 3456,
      configDir: '/tmp',
    });
    const adapter = adapterState.last!;
    const cmd = (i: number) => ({
      id: `cmd-${i}`,
      type: 'commandExecution' as const,
      command: 'ls',
      output: '',
      status: 'running',
    });

    // Three identical starts, then an EMPTY assistantMessage start: the empty
    // start is not progress, so the next identical call still aborts.
    adapter.emitPatch(itemPatch(cmd(1)));
    adapter.emitPatch(failPatch(failCmd('cmd-1', 'ls')));
    adapter.emitPatch(itemPatch(cmd(2)));
    adapter.emitPatch(failPatch(failCmd('cmd-2', 'ls')));
    adapter.emitPatch(itemPatch(cmd(3)));
    adapter.emitPatch(failPatch(failCmd('cmd-3', 'ls')));
    await new Promise((r) => setTimeout(r, 0));
    expect(adapter.interruptCalls).toBe(1);

    // A real assistant text delta breaks the loop; the next three identical
    // starts re-arm and abort again.
    adapter.emitPatch({
      type: 'agent-item-delta-v2',
      sessionId: 'channel-runtime',
      timestamp: '2026-07-26T00:00:00.000Z',
      turnId: 'turn-1',
      itemId: 'assistant-1',
      delta: { text: 'real answer' },
    });
    adapter.emitPatch(itemPatch(cmd(4)));
    adapter.emitPatch(failPatch(failCmd('cmd-4', 'ls')));
    adapter.emitPatch(itemPatch(cmd(5)));
    adapter.emitPatch(failPatch(failCmd('cmd-5', 'ls')));
    adapter.emitPatch(itemPatch(cmd(6)));
    adapter.emitPatch(failPatch(failCmd('cmd-6', 'ls')));
    await new Promise((r) => setTimeout(r, 0));
    expect(adapter.interruptCalls).toBe(2);
  });

  it('re-arms the guard when interrupt delivery fails', async () => {
    const { channelAgentRuntimes } = await runtimeModule();
    await channelAgentRuntimes.create({
      id: 'channel-runtime',
      providerId: 'codex',
      profileActorId: 'agent-profile:codex:default',
      cwd: '/tmp',
      displayName: '#eng · Codex',
      port: 3456,
      configDir: '/tmp',
    });
    const adapter = adapterState.last!;
    const cmd = (i: number) => ({
      id: `cmd-${i}`,
      type: 'commandExecution' as const,
      command: 'ls',
      output: '',
      status: 'running',
    });
    // First interrupt rejects; the guard re-arms so a later identical loop aborts.
    adapter.interruptReject = new Error('interrupt failed');
    adapter.emitPatch(itemPatch(cmd(1)));
    adapter.emitPatch(failPatch(failCmd('cmd-1', 'ls')));
    adapter.emitPatch(itemPatch(cmd(2)));
    adapter.emitPatch(failPatch(failCmd('cmd-2', 'ls')));
    adapter.emitPatch(itemPatch(cmd(3)));
    adapter.emitPatch(failPatch(failCmd('cmd-3', 'ls')));
    await new Promise((r) => setTimeout(r, 0));
    expect(adapter.interruptCalls).toBe(1);

    // A fresh turn resets the guard; three identical starts abort again.
    adapter.emitTurnStarted('turn-2');
    adapter.emitPatch({ ...itemPatch(cmd(4)), turnId: 'turn-2' });
    adapter.emitPatch({
      ...failPatch(failCmd('cmd-4', 'ls')),
      turnId: 'turn-2',
    });
    adapter.emitPatch({ ...itemPatch(cmd(5)), turnId: 'turn-2' });
    adapter.emitPatch({
      ...failPatch(failCmd('cmd-5', 'ls')),
      turnId: 'turn-2',
    });
    adapter.emitPatch({ ...itemPatch(cmd(6)), turnId: 'turn-2' });
    adapter.emitPatch({
      ...failPatch(failCmd('cmd-6', 'ls')),
      turnId: 'turn-2',
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(adapter.interruptCalls).toBe(2);
  });
});
