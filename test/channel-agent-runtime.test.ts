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
import { CHANNEL_ADAPTER_LAUNCH_CONTRACTS } from '../server/protocol-adapters/index.js';
import {
  scheduleRelayProcessTreeReap,
  type ProcessInfo,
} from '../server/process-tree.js';

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
  private readonly handlers = new Set<AgentPatchHandlerV2>();

  get resumesProviderSessionDuringConnect(): boolean {
    return adapterState.resumeDuringConnect;
  }

  sessionId = 'channel-runtime';
  ownedRoots: number[] = [];

  ownedProcessRootPids(): number[] {
    return this.ownedRoots;
  }

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
  async interrupt(_input: AgentInterruptInputV2): Promise<void> {}
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
  emitConfig(config: { model?: string; effort?: string | null }): void {
    this.emitPatch({
      type: 'agent-session-updated-v2',
      sessionId: this.sessionId,
      timestamp: '2026-07-26T00:00:00.000Z',
      config,
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

vi.mock('../server/protocol-adapters/index.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../server/protocol-adapters/index.js')
    >();
  return {
    ...actual,
    createAdapterV2: () => {
      const adapter = new TestAdapter();
      adapterState.last = adapter;
      adapterState.all.push(adapter);
      return adapter;
    },
  };
});

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
  it('keeps the latest authoritative model and effort for future channel turns', async () => {
    const { channelAgentRuntimes } = await runtimeModule();
    const runtime = await channelAgentRuntimes.create({
      id: 'channel-runtime',
      providerId: 'codex',
      profileActorId: 'agent-profile:codex:default',
      cwd: '/tmp',
      displayName: '#eng · Codex',
      port: 3456,
      configDir: '/tmp',
      model: 'gpt-5.6',
      extra: { effort: 'low' },
    });

    expect(runtime.agentAttribution).toEqual({
      model: 'gpt-5.6',
      effort: 'low',
    });
    adapterState.last!.emitConfig({ model: 'gpt-5.6-fast', effort: 'high' });
    expect(runtime.agentAttribution).toEqual({
      model: 'gpt-5.6-fast',
      effort: 'high',
    });
    adapterState.last!.emitConfig({ effort: null });
    expect(runtime.agentAttribution).toEqual({ model: 'gpt-5.6-fast' });
  });

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
  it('enforces every command-provider environment denylist after profile merging', async () => {
    const { channelAgentRuntimes } = await runtimeModule();
    const commandContracts = Object.entries(
      CHANNEL_ADAPTER_LAUNCH_CONTRACTS
    ).filter((entry) => entry[1].requirement.kind === 'command');
    const deniedKeys = [
      ...new Set(
        commandContracts.flatMap((entry) => [...entry[1].processEnvDenylist])
      ),
    ];

    for (const [providerId, contract] of commandContracts) {
      await channelAgentRuntimes.create({
        id: `channel-runtime-${providerId}`,
        providerId,
        profileActorId: `agent-profile:${providerId}:named`,
        cwd: '/tmp',
        displayName: `#eng · ${providerId}`,
        port: 3456,
        configDir: '/tmp',
        processEnv: Object.fromEntries([
          ['RELAY_PROFILE_SAFE', `safe-${providerId}`],
          ...deniedKeys.map((key) => [key, `denied-${providerId}`]),
        ]),
      });

      const connectedEnv = adapterState.last!.connectConfigs[0]!.processEnv;
      expect(connectedEnv?.RELAY_PROFILE_SAFE).toBe(`safe-${providerId}`);
      for (const key of contract.processEnvDenylist) {
        expect(connectedEnv).not.toHaveProperty(key);
      }
    }
  });

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

  it('passes Prime Agent provider identity as an atomic resume id', async () => {
    const { channelAgentRuntimes } = await runtimeModule();
    adapterState.resumeDuringConnect = true;

    await channelAgentRuntimes.create({
      id: 'prime-runtime',
      providerId: 'prime-agent',
      profileActorId: 'agent-profile:prime-agent:default',
      cwd: '/tmp',
      displayName: '#eng · Prime Agent',
      port: 3456,
      configDir: '/tmp',
      providerSession: { primeAgentSessionId: 'prime-session-1' },
    });

    expect(adapterState.last?.connectConfigs).toEqual([
      expect.objectContaining({ resumeSessionId: 'prime-session-1' }),
    ]);
    expect(adapterState.last?.resumed).toEqual([]);
  });

  it('passes Pi provider identity as an atomic resume id', async () => {
    const { channelAgentRuntimes } = await runtimeModule();
    adapterState.resumeDuringConnect = true;

    await channelAgentRuntimes.create({
      id: 'pi-runtime',
      providerId: 'pi',
      profileActorId: 'agent-profile:pi:default',
      cwd: '/tmp',
      displayName: '#eng · Pi',
      port: 3456,
      configDir: '/tmp',
      providerSession: { piSessionId: 'pi-session-1' },
    });

    expect(adapterState.last?.connectConfigs).toEqual([
      expect.objectContaining({ resumeSessionId: 'pi-session-1' }),
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

  it('captures owned descendants before graceful disconnect then reaps that snapshot', async () => {
    const { ChannelAgentRuntimeManager } = await runtimeModule();
    const table: ProcessInfo[] = [
      {
        pid: 410,
        ppid: 1,
        pgid: 410,
        command: 'codex',
        commandLine: 'codex',
        rssBytes: 10,
      },
      {
        pid: 411,
        ppid: 410,
        pgid: 410,
        command: 'node',
        commandLine: 'node',
        rssBytes: 20,
      },
    ];
    const reaps: Array<{ rootPids: number[]; processTable: ProcessInfo[] }> =
      [];
    const currentTable = table;
    const manager = new ChannelAgentRuntimeManager({
      readProcessTable: () => currentTable,
      scheduleProcessTreeReap: (input) => reaps.push(input),
    });
    const runtime = await manager.create({
      id: 'owned-runtime',
      providerId: 'codex',
      profileActorId: 'agent-profile:codex:default',
      cwd: '/tmp',
      displayName: 'Codex',
      port: 3456,
      configDir: '/tmp',
    });
    adapterState.last!.ownedRoots = [410];

    expect(manager.resourceSummary()).toEqual({
      runtimeCount: 1,
      runtimeWithOwnedProcesses: 1,
      processCount: 2,
      totalRssBytes: 30,
    });
    await manager.destroy(runtime.id);
    expect(reaps).toEqual([
      expect.objectContaining({ rootPids: [410], processTable: table }),
    ]);
  });

  it('merges a late reparented member into a root-only snapshot before reaping', async () => {
    const { ChannelAgentRuntimeManager } = await runtimeModule();
    const initialTable: ProcessInfo[] = [
      {
        pid: 50_010,
        ppid: 1,
        pgid: 50_010,
        command: 'claude',
        commandLine: 'claude',
        rssBytes: 10,
        startTicks: 1,
      },
    ];
    const reparentedMember: ProcessInfo = {
      pid: 50_011,
      ppid: 1,
      pgid: 50_010,
      command: 'node',
      commandLine: 'node build',
      rssBytes: 20,
      startTicks: 2,
    };
    const unrelated: ProcessInfo = {
      pid: 50_012,
      ppid: 1,
      pgid: 50_012,
      command: 'node',
      commandLine: 'node unrelated',
      rssBytes: 30,
      startTicks: 3,
    };
    const reaps: Array<{ rootPids: number[]; processTable: ProcessInfo[] }> =
      [];
    let currentTable = initialTable;
    const manager = new ChannelAgentRuntimeManager({
      readProcessTable: () => currentTable,
      scheduleProcessTreeReap: (input) => reaps.push(input),
    });
    const runtime = await manager.create({
      id: 'unexpected-runtime',
      providerId: 'codex',
      profileActorId: 'agent-profile:codex:default',
      cwd: '/tmp',
      displayName: 'Codex',
      port: 3456,
      configDir: '/tmp',
    });
    adapterState.last!.ownedRoots = [50_010];
    adapterState.last!.emitLiveState({ status: 'working' });
    expect(
      (
        manager as unknown as {
          ownedProcessSnapshots: Map<string, { rootPids: number[] }>;
        }
      ).ownedProcessSnapshots.get(runtime.id)?.rootPids
    ).toEqual([50_010]);
    // The adapter retains the exited leader ID, but `/proc` now contains only
    // a former child under init. The old root-only snapshot must gain this
    // same-group witness, without absorbing an unrelated process.
    currentTable = [reparentedMember, unrelated];
    adapterState.last!.emitDisconnected();

    await vi.waitFor(() => {
      expect(manager.get(runtime.id)).toBeUndefined();
      expect(reaps).toHaveLength(1);
    });
    expect(reaps).toEqual([
      expect.objectContaining({
        rootPids: [50_010],
        processTable: [...initialTable, reparentedMember],
      }),
    ]);
  });

  it('does not signal a reused root PID after an unexpected leader exit', async () => {
    const { ChannelAgentRuntimeManager } = await runtimeModule();
    const capturedRoot: ProcessInfo = {
      pid: 50_013,
      ppid: 1,
      pgid: 50_013,
      command: 'codex',
      commandLine: 'codex',
      rssBytes: 10,
      startTicks: 1,
    };
    // The original leader exited. Its numeric PID now names an unrelated
    // process and group, so it must not replace the captured identity.
    const reusedRoot: ProcessInfo = {
      pid: 50_013,
      ppid: 1,
      pgid: 50_099,
      command: 'node',
      commandLine: 'node unrelated',
      rssBytes: 20,
      startTicks: 99,
    };
    let currentTable: ProcessInfo[] = [capturedRoot];
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const manager = new ChannelAgentRuntimeManager({
      readProcessTable: () => currentTable,
      scheduleProcessTreeReap: (input) => {
        scheduleRelayProcessTreeReap({
          ...input,
          verifyProcessTable: () => currentTable,
          killProcess: (pid, signal) => signals.push({ pid, signal }),
          setTimer: (callback) => {
            callback();
            return { unref() {} };
          },
          logger: {},
        });
      },
    });
    const runtime = await manager.create({
      id: 'reused-root-runtime',
      providerId: 'codex',
      profileActorId: 'agent-profile:codex:default',
      cwd: '/tmp',
      displayName: 'Codex',
      port: 3456,
      configDir: '/tmp',
    });
    adapterState.last!.ownedRoots = [capturedRoot.pid];
    adapterState.last!.emitLiveState({ status: 'working' });

    currentTable = [reusedRoot];
    adapterState.last!.emitDisconnected();

    await vi.waitFor(() => expect(manager.get(runtime.id)).toBeUndefined());
    expect(signals).toEqual([]);
  });

  it('captures and reaps a spawned root when connect fails before any patch', async () => {
    const { ChannelAgentRuntimeManager } = await runtimeModule();
    const table: ProcessInfo[] = [
      {
        pid: 50_020,
        ppid: 1,
        pgid: 50_020,
        command: 'codex',
        commandLine: 'codex',
        rssBytes: 1,
        startTicks: 1,
      },
    ];
    const reaps: Array<{ rootPids: number[]; processTable: ProcessInfo[] }> =
      [];
    const manager = new ChannelAgentRuntimeManager({
      readProcessTable: () => table,
      scheduleProcessTreeReap: (input) => reaps.push(input),
    });
    adapterState.onConnect = (adapter) => {
      adapter.ownedRoots = [50_020];
      throw new Error('connect failed');
    };

    await expect(
      manager.create({
        id: 'failed-runtime',
        providerId: 'codex',
        profileActorId: 'agent-profile:codex:default',
        cwd: '/tmp',
        displayName: 'Codex',
        port: 3456,
        configDir: '/tmp',
      })
    ).rejects.toThrow('connect failed');
    expect(reaps).toEqual([
      expect.objectContaining({ rootPids: [50_020], processTable: table }),
    ]);
  });

  it('reaps a reparented detached-group member when connect loses its leader immediately', async () => {
    const { ChannelAgentRuntimeManager } = await runtimeModule();
    const table: ProcessInfo[] = [
      // The detached group leader has already exited, but this former child
      // remains alive under init in the same group.
      {
        pid: 50_031,
        ppid: 1,
        pgid: 50_030,
        command: 'node',
        commandLine: 'node build',
        rssBytes: 2,
        startTicks: 2,
      },
      // A process in an unrelated group must not become an ownership witness.
      {
        pid: 50_032,
        ppid: 1,
        pgid: 50_032,
        command: 'node',
        commandLine: 'node unrelated',
        rssBytes: 3,
        startTicks: 3,
      },
    ];
    const reaps: Array<{ rootPids: number[]; processTable: ProcessInfo[] }> =
      [];
    const manager = new ChannelAgentRuntimeManager({
      readProcessTable: () => table,
      scheduleProcessTreeReap: (input) => reaps.push(input),
    });
    adapterState.onConnect = (adapter) => {
      adapter.ownedRoots = [50_030];
      throw new Error('leader exited during connect');
    };

    await expect(
      manager.create({
        id: 'fast-exit-runtime',
        providerId: 'codex',
        profileActorId: 'agent-profile:codex:default',
        cwd: '/tmp',
        displayName: 'Codex',
        port: 3456,
        configDir: '/tmp',
      })
    ).rejects.toThrow('leader exited during connect');

    expect(reaps).toEqual([
      expect.objectContaining({ rootPids: [50_030], processTable: table }),
    ]);
  });
});
