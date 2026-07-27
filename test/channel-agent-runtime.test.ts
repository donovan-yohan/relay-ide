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
import { emptyAgentSessionV2 } from '../shared/agent-chat-protocol-v2.js';

const adapterState = vi.hoisted(() => ({
  last: null as TestAdapter | null,
  all: [] as TestAdapter[],
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
  disconnectError: Error | null = null;
  private readonly handlers = new Set<AgentPatchHandlerV2>();

  async connect(_config: AdapterConfig): Promise<void> {
    this.status = 'connected';
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
  emitProviderSession(threadId: string): void {
    for (const handler of this.handlers) {
      handler({
        type: 'agent-session-updated-v2',
        sessionId: 'channel-runtime',
        timestamp: '2026-07-26T00:00:00.000Z',
        providerSession: { threadId },
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
