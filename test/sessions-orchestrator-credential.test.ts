import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentApprovalResponseInputV2,
  AgentInputResponseInputV2,
  AgentInterruptInputV2,
  AgentPatchHandlerV2,
  AgentSendMessageInputV2,
  AdapterConfig,
  ProtocolAdapterV2,
} from '../server/protocol-adapter-v2.js';
import type { ScopedActorCredentialRecord } from '../shared/scoped-actor-credentials.js';
import { ScopedActorCredentialRegistry } from '../shared/scoped-actor-credentials.js';
import {
  CLI_GATEWAY_READ_SCOPE_TASK_REF,
  issueChannelRuntimeReadCliGatewayActorCredential,
  issuePersistentOrchestratorCliGatewayActorCredential,
  validateCliGatewayActorCredential,
} from '../server/cli-gateway-actor-auth.js';
import { emptyAgentSessionV2 } from '../shared/agent-chat-protocol-v2.js';

const connect = vi.fn<(config: AdapterConfig) => Promise<void>>();
const disconnect = vi.fn<() => Promise<void>>();
const refreshRuntimeEnv =
  vi.fn<(processEnv: Record<string, string>) => Promise<void>>();
let supportsRuntimeEnvRefresh = true;
let adapterStatus: 'connected' | 'disconnected' = 'connected';

class OrchestratorTestAdapter implements ProtocolAdapterV2 {
  readonly agentType = 'mock';
  readonly runtimeOwnership = 'spawned' as const;
  readonly capabilities = emptyAgentSessionV2({
    id: 'capabilities',
    provider: 'mock',
    cwd: '/tmp',
    capabilities: {
      resume: true,
      text: true,
      queue: true,
      interrupt: true,
    },
  }).capabilities;
  get status(): 'connected' | 'disconnected' {
    return adapterStatus;
  }
  refreshRuntimeEnv?: (processEnv: Record<string, string>) => Promise<void>;

  constructor() {
    if (supportsRuntimeEnvRefresh) {
      this.refreshRuntimeEnv = (processEnv) => refreshRuntimeEnv(processEnv);
    }
  }

  async connect(config: AdapterConfig): Promise<void> {
    await connect(config);
  }
  async disconnect(): Promise<void> {
    await disconnect();
  }
  async reconnect(): Promise<void> {}
  async resumeSession(_sessionId: string): Promise<void> {}
  async sendMessage(_input: AgentSendMessageInputV2): Promise<void> {}
  async interrupt(_input: AgentInterruptInputV2): Promise<void> {}
  async respondToApproval(
    _input: AgentApprovalResponseInputV2
  ): Promise<void> {}
  async respondToInput(_input: AgentInputResponseInputV2): Promise<void> {}
  onPatch(_handler: AgentPatchHandlerV2): () => void {
    return () => {};
  }
  broadcastPatch(): void {}
}

vi.mock('../server/protocol-adapters/index.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../server/protocol-adapters/index.js')
    >();
  return {
    ...actual,
    createAdapterV2: () => new OrchestratorTestAdapter(),
  };
});

function issuedCredential(
  id: string,
  token: string
): { token: string; credential: ScopedActorCredentialRecord } {
  const issuedAt = Date.now();
  return {
    token,
    credential: {
      id,
      actor: { type: 'agent', id: 'agent-profile:test' },
      issuer: { id: 'relay-ide' },
      audience: 'relay:cli-gateway:v1',
      capabilities: [
        'session:read',
        'context:read',
        'context:write',
        'session:create:terminal',
      ],
      scope: {
        sessionIds: ['orchestrator-runtime'],
        taskRefs: ['relay:cli-gateway:v1:read'],
      },
      metadata: { reason: 'persistent-orchestrator' },
      issuedAt: new Date(issuedAt).toISOString(),
      expiresAt: new Date(issuedAt + 15 * 60 * 1000).toISOString(),
      correlationId: `correlation-${id}`,
    },
  };
}

describe('channel runtime orchestrator credential integration', () => {
  beforeEach(() => {
    connect.mockReset().mockResolvedValue();
    disconnect.mockReset().mockResolvedValue();
    refreshRuntimeEnv.mockReset().mockResolvedValue();
    supportsRuntimeEnvRefresh = true;
    adapterStatus = 'connected';
  });

  afterEach(async () => {
    const runtimes = await import('../server/channel-agent-runtime.js');
    await runtimes.channelAgentRuntimes.close();
    runtimes.configureChannelAgentRuntimes({});
    vi.useRealTimers();
  });

  it('mints before connect, injects runtime identity, and revokes on end', async () => {
    const events: string[] = [];
    const issueCredential = vi.fn(() => {
      events.push('issue');
      return issuedCredential(
        'credential-1',
        'relay-sac-v1.credential-1.redacted'
      );
    });
    connect.mockImplementation(async () => {
      events.push('connect');
    });
    const revokeCredential = vi.fn(() => {
      events.push('revoke');
    });
    const runtimes = await import('../server/channel-agent-runtime.js');
    runtimes.configureChannelAgentRuntimes({
      orchestratorCredentials: { issueCredential, revokeCredential },
    });

    const runtime = await runtimes.channelAgentRuntimes.create({
      id: 'orchestrator-runtime',
      channelId: 'channel-A',
      providerId: 'mock',
      role: 'orchestrator',
      profileActorId: 'agent-profile:test',
      cwd: '/tmp',
      displayName: 'Product orchestrator',
      port: 4567,
      configDir: '/tmp',
    });

    expect(events.slice(0, 2)).toEqual(['issue', 'connect']);
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        processEnv: {
          RELAY_IDE_ACTOR_TOKEN: 'relay-sac-v1.credential-1.redacted',
          RELAY_IDE_PORT: '4567',
          RELAY_IDE_RUNTIME_ID: 'orchestrator-runtime',
        },
      })
    );
    expect(runtime.role).toBe('orchestrator');
    expect(issueCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: expect.objectContaining({ id: 'agent-profile:test' }),
        scope: {
          sessionIds: ['orchestrator-runtime'],
          channelIds: ['channel-A'],
        },
      })
    );

    await runtimes.channelAgentRuntimes.destroy(runtime.id);
    expect(revokeCredential).toHaveBeenCalledWith('credential-1', {
      revokedBy: 'relay-ide',
      reason: 'orchestrator-runtime-ended',
    });
  });

  it('retains channel A scope and denies B across persisted lease rotation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-07-25T00:00:00.000Z');
    const credentialRegistry = new ScopedActorCredentialRegistry({
      now: () => new Date(Date.now()),
      secretBytes: () => Buffer.from('0123456789abcdef0123456789abcdef'),
    });
    const runtimes = await import('../server/channel-agent-runtime.js');
    runtimes.configureChannelAgentRuntimes({
      orchestratorCredentials: {
        issueCredential: (input) =>
          issuePersistentOrchestratorCliGatewayActorCredential(
            credentialRegistry,
            input
          ),
        revokeCredential: (id, input) => credentialRegistry.revoke(id, input),
      },
    });

    await runtimes.channelAgentRuntimes.create({
      id: 'orchestrator-session',
      channelId: 'channel-A',
      providerId: 'mock',
      role: 'orchestrator',
      profileActorId: 'agent-profile:test',
      cwd: '/tmp',
      displayName: 'Product orchestrator',
      port: 4567,
      configDir: '/tmp',
    });
    const first = credentialRegistry.listCredentials()[0]!;
    const firstToken =
      connect.mock.calls[0]?.[0].processEnv?.RELAY_IDE_ACTOR_TOKEN;
    expect(
      validateCliGatewayActorCredential(credentialRegistry, {
        token: firstToken!,
        capabilities: ['context:read'],
        scope: {
          sessionIds: ['orchestrator-session'],
          channelIds: ['channel-A'],
        },
      })
    ).toMatchObject({ ok: true });
    expect(
      validateCliGatewayActorCredential(credentialRegistry, {
        token: firstToken!,
        capabilities: ['context:read'],
        scope: {
          sessionIds: ['orchestrator-session'],
          channelIds: ['channel-B'],
        },
      })
    ).toMatchObject({ ok: false, reason: 'wrong_channel_scope' });

    await vi.advanceTimersByTimeAsync(7.5 * 60 * 1000);
    const rotatedToken =
      refreshRuntimeEnv.mock.calls[0]?.[0]?.RELAY_IDE_ACTOR_TOKEN;
    const records = credentialRegistry.listCredentials();
    expect(records).toHaveLength(2);
    expect(records.map((credential) => credential.scope.channelIds)).toEqual([
      ['channel-A'],
      ['channel-A'],
    ]);
    expect(credentialRegistry.getCredential(first.id)).toMatchObject({
      revokedAt: expect.any(String),
      scope: { channelIds: ['channel-A'] },
    });
    expect(
      validateCliGatewayActorCredential(credentialRegistry, {
        token: rotatedToken!,
        capabilities: ['context:read'],
        scope: {
          sessionIds: ['orchestrator-session'],
          channelIds: ['channel-A'],
        },
      })
    ).toMatchObject({ ok: true });
    expect(
      validateCliGatewayActorCredential(credentialRegistry, {
        token: rotatedToken!,
        capabilities: ['context:read'],
        scope: {
          sessionIds: ['orchestrator-session'],
          channelIds: ['channel-B'],
        },
      })
    ).toMatchObject({ ok: false, reason: 'wrong_channel_scope' });
  });

  // Regression guard for #1419, recorded here so the defect cannot hide behind
  // the hand-built both-dimensions-named shape the rotation test above uses.
  //
  // Every assertion below uses the scope a REAL route derives from the request:
  //  - channel routes (`channelScopeFromParams`, `channelListScopeFromCredential`,
  //    `channelSearchScopeFromRequest`, the `channels.subscribe` revalidation)
  //    request `{ channelIds }` and nothing else;
  //  - sessions / command-center routes (`commandCenterActorCredentialScopeFor`)
  //    request `{ sessionIds, globalSessionIds }` and nothing else.
  //
  // The orchestrator lease pins BOTH dimensions, and `validateCredentialScope`
  // denies any dimension the request leaves unnamed, so it is currently refused
  // on both lanes. This test asserts that deny AS THE CURRENT BEHAVIOR: it is
  // fail-closed (no escalation), and #1419 owns making the lease usable. Flip
  // these expectations there — do not delete them.
  it('is denied on every real route scope shape today (#1419)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-18T00:00:00.000Z');
    const credentialRegistry = new ScopedActorCredentialRegistry({
      now: () => new Date(Date.now()),
      secretBytes: () => Buffer.from('0123456789abcdef0123456789abcdef'),
    });
    const runtimes = await import('../server/channel-agent-runtime.js');
    runtimes.configureChannelAgentRuntimes({
      orchestratorCredentials: {
        issueCredential: (input) =>
          issuePersistentOrchestratorCliGatewayActorCredential(
            credentialRegistry,
            input
          ),
        revokeCredential: (id, input) => credentialRegistry.revoke(id, input),
      },
    });

    await runtimes.channelAgentRuntimes.create({
      id: 'orchestrator-session',
      channelId: 'channel-A',
      providerId: 'mock',
      role: 'orchestrator',
      profileActorId: 'agent-profile:test',
      cwd: '/tmp',
      displayName: 'Product orchestrator',
      port: 4567,
      configDir: '/tmp',
    });
    const token = connect.mock.calls[0]?.[0].processEnv?.RELAY_IDE_ACTOR_TOKEN;
    expect(credentialRegistry.listCredentials()[0]!.scope).toMatchObject({
      sessionIds: ['orchestrator-session'],
      channelIds: ['channel-A'],
    });

    // Channel lane: the credential's own channel, requested the way the router
    // requests it. The unnamed `sessionIds` pin is what denies it.
    expect(
      validateCliGatewayActorCredential(credentialRegistry, {
        token: token!,
        capabilities: ['context:read'],
        scope: { channelIds: ['channel-A'] },
      })
    ).toMatchObject({ ok: false, reason: 'missing_scope' });
    // Same lane, write verb (`channels.post`), same deny.
    expect(
      validateCliGatewayActorCredential(credentialRegistry, {
        token: token!,
        capabilities: ['context:write'],
        scope: { channelIds: ['channel-A'] },
      })
    ).toMatchObject({ ok: false, reason: 'missing_scope' });
    // Session lane: the credential's OWN runtime id, requested the way the
    // command-center scope resolver requests it. The unnamed `channelIds` pin
    // is what denies it.
    expect(
      validateCliGatewayActorCredential(credentialRegistry, {
        token: token!,
        capabilities: ['session:read'],
        scope: { sessionIds: ['orchestrator-session'] },
      })
    ).toMatchObject({ ok: false, reason: 'missing_scope' });
    expect(
      validateCliGatewayActorCredential(credentialRegistry, {
        token: token!,
        capabilities: ['session:read'],
        scope: {
          sessionIds: ['orchestrator-session'],
          globalSessionIds: ['orchestrator-session'],
        },
      })
    ).toMatchObject({ ok: false, reason: 'missing_scope' });
    // The read lease shape #1410 ships — channel only — is the one that works,
    // which is why the read lane could drop its session pin and this one cannot
    // (the router binds the orchestrator's brake bypass to `scope.sessionIds`).
    expect(
      validateCliGatewayActorCredential(credentialRegistry, {
        token: token!,
        capabilities: ['context:read'],
        scope: {
          sessionIds: ['orchestrator-session'],
          channelIds: ['channel-A'],
        },
      })
    ).toMatchObject({ ok: true });
  });

  it('fails before adapter connect when initial minting fails', async () => {
    const runtimes = await import('../server/channel-agent-runtime.js');
    runtimes.configureChannelAgentRuntimes({
      orchestratorCredentials: {
        issueCredential: () => {
          throw new Error('secret issuer details');
        },
        revokeCredential: vi.fn(),
      },
    });

    await expect(
      runtimes.channelAgentRuntimes.create({
        id: 'orchestrator-session',
        channelId: 'channel-A',
        providerId: 'mock',
        role: 'orchestrator',
        profileActorId: 'agent-profile:test',
        cwd: '/tmp',
        displayName: 'Product orchestrator',
        port: 4567,
        configDir: '/tmp',
      })
    ).rejects.toThrow('Failed to provision orchestrator actor credential');
    expect(connect).not.toHaveBeenCalled();
    expect(
      runtimes.channelAgentRuntimes.get('orchestrator-session')
    ).toBeUndefined();
  });

  it('keeps a derived Hermes display role unprivileged without minting a credential', async () => {
    supportsRuntimeEnvRefresh = false;
    const issueCredential = vi.fn(() =>
      issuedCredential(
        'credential-should-not-exist',
        'relay-sac-v1.credential-should-not-exist.redacted'
      )
    );
    const runtimes = await import('../server/channel-agent-runtime.js');
    runtimes.configureChannelAgentRuntimes({
      orchestratorCredentials: {
        issueCredential,
        revokeCredential: vi.fn(),
      },
    });

    const session = await runtimes.channelAgentRuntimes.create({
      id: 'hermes-worker-session',
      providerId: 'hermes',
      profileActorId: 'agent-profile:test',
      cwd: '/tmp',
      displayName: 'Hermes worker',
      port: 4567,
      configDir: '/tmp',
    });

    expect(session.role).toBeUndefined();
    expect(issueCredential).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPromptAppendix: expect.stringContaining('role: collaborator'),
      })
    );
  });

  it('rejects an orchestrator adapter without env refresh before minting', async () => {
    supportsRuntimeEnvRefresh = false;
    const issueCredential = vi.fn(() =>
      issuedCredential(
        'credential-unsupported',
        'relay-sac-v1.credential-unsupported.redacted'
      )
    );
    const revokeCredential = vi.fn();
    const runtimes = await import('../server/channel-agent-runtime.js');
    runtimes.configureChannelAgentRuntimes({
      orchestratorCredentials: {
        issueCredential,
        revokeCredential,
      },
    });

    await expect(
      runtimes.channelAgentRuntimes.create({
        id: 'orchestrator-session',
        channelId: 'channel-A',
        providerId: 'mock',
        role: 'orchestrator',
        profileActorId: 'agent-profile:test',
        cwd: '/tmp',
        displayName: 'Product orchestrator',
        port: 4567,
        configDir: '/tmp',
      })
    ).rejects.toThrow('does not support orchestrator credential refresh');
    expect(connect).not.toHaveBeenCalled();
    expect(issueCredential).not.toHaveBeenCalled();
    expect(revokeCredential).not.toHaveBeenCalled();
  });

  it('kills the session when scheduled credential application fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-07-25T00:00:00.000Z');
    let issueCount = 0;
    const revokeCredential = vi.fn();
    refreshRuntimeEnv.mockRejectedValue(
      new Error('runtime refresh failed around secret material')
    );
    const runtimes = await import('../server/channel-agent-runtime.js');
    runtimes.configureChannelAgentRuntimes({
      orchestratorCredentials: {
        issueCredential: () => {
          issueCount++;
          return issuedCredential(
            `credential-${issueCount}`,
            `relay-sac-v1.credential-${issueCount}.redacted`
          );
        },
        revokeCredential,
      },
    });

    await runtimes.channelAgentRuntimes.create({
      id: 'orchestrator-session',
      channelId: 'channel-A',
      providerId: 'mock',
      role: 'orchestrator',
      profileActorId: 'agent-profile:test',
      cwd: '/tmp',
      displayName: 'Product orchestrator',
      port: 4567,
      configDir: '/tmp',
    });

    await vi.advanceTimersByTimeAsync(7.5 * 60 * 1000);

    expect(
      runtimes.channelAgentRuntimes.get('orchestrator-session')
    ).toBeUndefined();
    expect(revokeCredential).toHaveBeenCalledWith('credential-2', {
      revokedBy: 'relay-ide',
      reason: 'orchestrator-token-refresh-failed',
    });
    expect(revokeCredential).toHaveBeenCalledWith('credential-1', {
      revokedBy: 'relay-ide',
      reason: 'orchestrator-runtime-ended',
    });
  });

  it('stops and removes the lease when the adapter becomes disconnected', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-07-25T00:00:00.000Z');
    let issueCount = 0;
    const revokeCredential = vi.fn();
    const runtimes = await import('../server/channel-agent-runtime.js');
    runtimes.configureChannelAgentRuntimes({
      orchestratorCredentials: {
        issueCredential: () => {
          issueCount++;
          return issuedCredential(
            `credential-${issueCount}`,
            `relay-sac-v1.credential-${issueCount}.redacted`
          );
        },
        revokeCredential,
      },
    });

    const session = await runtimes.channelAgentRuntimes.create({
      id: 'orchestrator-session',
      channelId: 'channel-A',
      providerId: 'mock',
      role: 'orchestrator',
      profileActorId: 'agent-profile:test',
      cwd: '/tmp',
      displayName: 'Product orchestrator',
      port: 4567,
      configDir: '/tmp',
    });
    adapterStatus = 'disconnected';
    await runtimes.channelAgentRuntimes.destroy(session.id);

    expect(runtimes.channelAgentRuntimes.get(session.id)).toBeUndefined();
    expect(revokeCredential).toHaveBeenCalledWith('credential-1', {
      revokedBy: 'relay-ide',
      reason: 'orchestrator-runtime-ended',
    });
  });
});

describe('standing read-only credential for ordinary bound agents (#1410)', () => {
  beforeEach(() => {
    connect.mockReset().mockResolvedValue();
    disconnect.mockReset().mockResolvedValue();
    refreshRuntimeEnv.mockReset().mockResolvedValue();
    supportsRuntimeEnvRefresh = false;
    adapterStatus = 'connected';
  });

  afterEach(async () => {
    const runtimes = await import('../server/channel-agent-runtime.js');
    await runtimes.channelAgentRuntimes.close();
    runtimes.configureChannelAgentRuntimes({});
    vi.useRealTimers();
  });

  async function configureReadAuthority(
    registry: ScopedActorCredentialRegistry
  ): Promise<typeof import('../server/channel-agent-runtime.js')> {
    const runtimes = await import('../server/channel-agent-runtime.js');
    runtimes.configureChannelAgentRuntimes({
      runtimeReadCredentials: {
        issueCredential: (input) =>
          issueChannelRuntimeReadCliGatewayActorCredential(registry, input),
        revokeCredential: (id, input) => registry.revoke(id, input),
      },
    });
    return runtimes;
  }

  function fixedRegistry(): ScopedActorCredentialRegistry {
    return new ScopedActorCredentialRegistry({
      now: () => new Date(Date.now()),
      secretBytes: () => Buffer.from('0123456789abcdef0123456789abcdef'),
    });
  }

  it('injects a read-only channel-pinned credential and denies channel B', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-18T00:00:00.000Z');
    const registry = fixedRegistry();
    const runtimes = await configureReadAuthority(registry);

    const runtime = await runtimes.channelAgentRuntimes.create({
      id: 'collaborator-runtime',
      channelId: 'channel-A',
      providerId: 'mock',
      profileActorId: 'agent-profile:codex:default',
      cwd: '/tmp',
      displayName: '#eng · Codex',
      port: 4567,
      configDir: '/tmp',
    });

    expect(runtime.role).toBeUndefined();
    const injected = connect.mock.calls[0]?.[0].processEnv;
    expect(injected).toEqual({
      RELAY_IDE_ACTOR_TOKEN: expect.stringMatching(/^relay-sac-v1\./),
      RELAY_IDE_PORT: '4567',
      RELAY_IDE_RUNTIME_ID: 'collaborator-runtime',
    });
    const token = injected?.RELAY_IDE_ACTOR_TOKEN;

    const record = registry.listCredentials()[0]!;
    expect(record.capabilities).toEqual(['session:read', 'context:read']);
    // Channel and nothing else. Every validation below uses the scope a channel
    // route actually derives from the request — `{ channelIds }` — because a
    // credential dimension the request does not name is denied `missing_scope`.
    // A session pin here would therefore deny every `channels.*` call the lease
    // exists to make.
    // `taskRefs` is the permissive read marker every `session:read` credential
    // is stamped with, and validation supplies it on every request. The only
    // dimension that decides reach here is `channelIds`.
    expect(record.scope).toEqual({
      channelIds: ['channel-A'],
      taskRefs: [CLI_GATEWAY_READ_SCOPE_TASK_REF],
    });
    expect(record.metadata).toMatchObject({ reason: 'channel-runtime-read' });
    expect(Date.parse(record.expiresAt) - Date.parse(record.issuedAt)).toBe(
      15 * 60 * 1000
    );

    // Own channel reads pass.
    expect(
      validateCliGatewayActorCredential(registry, {
        token: token!,
        capabilities: ['context:read'],
        scope: { channelIds: ['channel-A'] },
      })
    ).toMatchObject({ ok: true });
    // Failing direction: another channel is denied even with the right bit.
    expect(
      validateCliGatewayActorCredential(registry, {
        token: token!,
        capabilities: ['context:read'],
        scope: { channelIds: ['channel-B'] },
      })
    ).toMatchObject({ ok: false, reason: 'wrong_channel_scope' });
    // Failing direction: no write bit, so `channels.post` can never authorize.
    expect(
      validateCliGatewayActorCredential(registry, {
        token: token!,
        capabilities: ['context:write'],
        scope: { channelIds: ['channel-A'] },
      })
    ).toMatchObject({ ok: false, reason: 'insufficient_capability' });
    // Failing direction, and the property that replaces a session pin: a route
    // that addresses something other than a channel never names `channelIds`,
    // so the credential is refused there. `sessions.get` is the sharp case —
    // the lease carries `session:read`, and only this rule keeps it off other
    // runtimes' sessions.
    expect(
      validateCliGatewayActorCredential(registry, {
        token: token!,
        capabilities: ['session:read'],
        scope: { sessionId: 'other-runtime' },
      })
    ).toMatchObject({ ok: false, reason: 'missing_scope' });
    // Same rule for an unscoped request: no channel named, no access.
    expect(
      validateCliGatewayActorCredential(registry, {
        token: token!,
        capabilities: ['context:read'],
        scope: {},
      })
    ).toMatchObject({ ok: false, reason: 'missing_scope' });

    await runtimes.channelAgentRuntimes.destroy(runtime.id);
    expect(registry.getCredential(record.id)).toMatchObject({
      revokedAt: expect.any(String),
    });
    expect(
      validateCliGatewayActorCredential(registry, {
        token: token!,
        capabilities: ['context:read'],
        scope: { channelIds: ['channel-A'] },
      })
    ).toMatchObject({ ok: false });
  });

  it('expires a static lease instead of rotating it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-18T00:00:00.000Z');
    const registry = fixedRegistry();
    const runtimes = await configureReadAuthority(registry);

    await runtimes.channelAgentRuntimes.create({
      id: 'collaborator-runtime',
      channelId: 'channel-A',
      providerId: 'mock',
      profileActorId: 'agent-profile:codex:default',
      cwd: '/tmp',
      displayName: '#eng · Codex',
      port: 4567,
      configDir: '/tmp',
    });
    const token = connect.mock.calls[0]?.[0].processEnv?.RELAY_IDE_ACTOR_TOKEN;

    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 1_000);

    expect(refreshRuntimeEnv).not.toHaveBeenCalled();
    expect(registry.listCredentials()).toHaveLength(1);
    expect(
      validateCliGatewayActorCredential(registry, {
        token: token!,
        capabilities: ['context:read'],
        scope: { channelIds: ['channel-A'] },
      })
    ).toMatchObject({ ok: false, reason: 'expired' });
    // The runtime survives its credential expiring: read access is additive.
    expect(
      runtimes.channelAgentRuntimes.get('collaborator-runtime')
    ).toBeDefined();
  });

  it('rotates the read lease when the adapter can re-receive env', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-18T00:00:00.000Z');
    supportsRuntimeEnvRefresh = true;
    const registry = fixedRegistry();
    const runtimes = await configureReadAuthority(registry);

    await runtimes.channelAgentRuntimes.create({
      id: 'collaborator-runtime',
      channelId: 'channel-A',
      providerId: 'mock',
      profileActorId: 'agent-profile:claude:default',
      cwd: '/tmp',
      displayName: '#eng · Claude',
      port: 4567,
      configDir: '/tmp',
    });

    await vi.advanceTimersByTimeAsync(7.5 * 60 * 1000);

    const rotated = refreshRuntimeEnv.mock.calls[0]?.[0];
    expect(rotated?.RELAY_IDE_RUNTIME_ID).toBe('collaborator-runtime');
    const records = registry.listCredentials();
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.capabilities)).toEqual([
      ['session:read', 'context:read'],
      ['session:read', 'context:read'],
    ]);
    expect(records.map((record) => record.scope.channelIds)).toEqual([
      ['channel-A'],
      ['channel-A'],
    ]);
    expect(
      validateCliGatewayActorCredential(registry, {
        token: rotated!.RELAY_IDE_ACTOR_TOKEN!,
        capabilities: ['context:read'],
        scope: { channelIds: ['channel-B'] },
      })
    ).toMatchObject({ ok: false, reason: 'wrong_channel_scope' });
  });

  it('mints nothing for a gateway-launched provider with no child env', async () => {
    const registry = fixedRegistry();
    const runtimes = await configureReadAuthority(registry);

    await runtimes.channelAgentRuntimes.create({
      id: 'hermes-runtime',
      channelId: 'channel-A',
      providerId: 'hermes',
      profileActorId: 'agent-profile:hermes:default',
      cwd: '/tmp',
      displayName: '#eng · Hermes',
      port: 4567,
      configDir: '/tmp',
    });

    expect(registry.listCredentials()).toHaveLength(0);
    expect(
      connect.mock.calls[0]?.[0].processEnv?.RELAY_IDE_ACTOR_TOKEN
    ).toBeUndefined();
  });

  it('mints nothing for a runtime with no bound channel to scope reads to', async () => {
    const registry = fixedRegistry();
    const runtimes = await configureReadAuthority(registry);

    await runtimes.channelAgentRuntimes.create({
      id: 'unbound-runtime',
      providerId: 'mock',
      profileActorId: 'agent-profile:codex:default',
      cwd: '/tmp',
      displayName: 'unbound',
      port: 4567,
      configDir: '/tmp',
    });

    expect(registry.listCredentials()).toHaveLength(0);
    expect(
      connect.mock.calls[0]?.[0].processEnv?.RELAY_IDE_ACTOR_TOKEN
    ).toBeUndefined();
  });

  it('refuses to let a profile env shadow the injected actor token', async () => {
    const registry = fixedRegistry();
    const runtimes = await configureReadAuthority(registry);

    await runtimes.channelAgentRuntimes.create({
      id: 'collaborator-runtime',
      channelId: 'channel-A',
      providerId: 'mock',
      profileActorId: 'agent-profile:codex:default',
      cwd: '/tmp',
      displayName: '#eng · Codex',
      port: 4567,
      configDir: '/tmp',
      processEnv: {
        RELAY_IDE_ACTOR_TOKEN: 'relay-sac-v1.forged.attacker-supplied',
        RELAY_IDE_PORT: '9999',
        RELAY_IDE_RUNTIME_ID: 'someone-elses-runtime',
      },
    });

    const injected = connect.mock.calls[0]?.[0].processEnv;
    expect(injected?.RELAY_IDE_ACTOR_TOKEN).not.toBe(
      'relay-sac-v1.forged.attacker-supplied'
    );
    expect(injected?.RELAY_IDE_PORT).toBe('4567');
    expect(injected?.RELAY_IDE_RUNTIME_ID).toBe('collaborator-runtime');
  });

  it('spawns without a credential when minting fails', async () => {
    const runtimes = await import('../server/channel-agent-runtime.js');
    const revokeCredential = vi.fn();
    runtimes.configureChannelAgentRuntimes({
      runtimeReadCredentials: {
        issueCredential: () => {
          throw new Error('issuer failed around secret material');
        },
        revokeCredential,
      },
    });

    const runtime = await runtimes.channelAgentRuntimes.create({
      id: 'collaborator-runtime',
      channelId: 'channel-A',
      providerId: 'mock',
      profileActorId: 'agent-profile:codex:default',
      cwd: '/tmp',
      displayName: '#eng · Codex',
      port: 4567,
      configDir: '/tmp',
    });

    expect(runtime.status).toBe('active');
    expect(connect).toHaveBeenCalledTimes(1);
    expect(
      connect.mock.calls[0]?.[0].processEnv?.RELAY_IDE_ACTOR_TOKEN
    ).toBeUndefined();
  });

  it('leaves the orchestrator lease on its own privileged lane', async () => {
    const registry = fixedRegistry();
    supportsRuntimeEnvRefresh = true;
    const runtimes = await import('../server/channel-agent-runtime.js');
    const readIssue = vi.fn((input) =>
      issueChannelRuntimeReadCliGatewayActorCredential(registry, input)
    );
    runtimes.configureChannelAgentRuntimes({
      orchestratorCredentials: {
        issueCredential: (input) =>
          issuePersistentOrchestratorCliGatewayActorCredential(registry, input),
        revokeCredential: (id, input) => registry.revoke(id, input),
      },
      runtimeReadCredentials: {
        issueCredential: readIssue,
        revokeCredential: (id, input) => registry.revoke(id, input),
      },
    });

    await runtimes.channelAgentRuntimes.create({
      id: 'orchestrator-runtime',
      channelId: 'channel-A',
      providerId: 'mock',
      role: 'orchestrator',
      profileActorId: 'agent-profile:test',
      cwd: '/tmp',
      displayName: 'Product orchestrator',
      port: 4567,
      configDir: '/tmp',
    });

    expect(readIssue).not.toHaveBeenCalled();
    const record = registry.listCredentials()[0]!;
    expect(record.metadata).toMatchObject({
      reason: 'persistent-orchestrator',
    });
    expect(record.capabilities).toContain('context:write');
  });
});
