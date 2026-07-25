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

vi.mock('../server/protocol-adapters/index.js', () => ({
  createAdapterV2: () => new OrchestratorTestAdapter(),
}));

function issuedCredential(
  id: string,
  token: string
): { token: string; credential: ScopedActorCredentialRecord } {
  const issuedAt = Date.now();
  return {
    token,
    credential: {
      id,
      actor: { type: 'agent', id: 'orchestrator-session' },
      issuer: { id: 'relay-ide' },
      audience: 'relay:cli-gateway:v1',
      capabilities: [
        'session:read',
        'context:read',
        'context:write',
        'session:create:agent',
      ],
      scope: { taskRefs: ['relay:cli-gateway:v1:read'] },
      metadata: { reason: 'persistent-orchestrator' },
      issuedAt: new Date(issuedAt).toISOString(),
      expiresAt: new Date(issuedAt + 15 * 60 * 1000).toISOString(),
      correlationId: `correlation-${id}`,
    },
  };
}

describe('sessions orchestrator credential integration', () => {
  beforeEach(() => {
    connect.mockReset().mockResolvedValue();
    disconnect.mockReset().mockResolvedValue();
    refreshRuntimeEnv.mockReset().mockResolvedValue();
    supportsRuntimeEnvRefresh = true;
    adapterStatus = 'connected';
  });

  afterEach(async () => {
    const sessions = await import('../server/sessions.js');
    for (const session of sessions.list()) {
      try {
        sessions.kill(session.id);
      } catch {
        // already fail-closed
      }
    }
    sessions.configure({});
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
    const sessions = await import('../server/sessions.js');
    sessions.configure({
      port: 4567,
      configDir: '/tmp',
      orchestratorCredentials: { issueCredential, revokeCredential },
    });

    const { session } = await sessions.createWeb({
      id: 'orchestrator-session',
      role: 'orchestrator',
      agentType: 'mock',
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
          RELAY_IDE_SESSION_ID: 'orchestrator-session',
        },
      })
    );
    expect(session.role).toBe('orchestrator');

    sessions.kill(session.id);
    expect(revokeCredential).toHaveBeenCalledWith('credential-1', {
      revokedBy: 'relay-ide',
      reason: 'orchestrator-session-ended',
    });
  });

  it('fails before adapter connect when initial minting fails', async () => {
    const sessions = await import('../server/sessions.js');
    sessions.configure({
      port: 4567,
      configDir: '/tmp',
      orchestratorCredentials: {
        issueCredential: () => {
          throw new Error('secret issuer details');
        },
        revokeCredential: vi.fn(),
      },
    });

    await expect(
      sessions.createWeb({
        id: 'orchestrator-session',
        role: 'orchestrator',
        agentType: 'mock',
        cwd: '/tmp',
        displayName: 'Product orchestrator',
        port: 4567,
        configDir: '/tmp',
      })
    ).rejects.toThrow('Failed to provision orchestrator actor credential');
    expect(connect).not.toHaveBeenCalled();
    expect(sessions.get('orchestrator-session')).toBeUndefined();
  });

  it('keeps a derived Hermes display role unprivileged without minting a credential', async () => {
    supportsRuntimeEnvRefresh = false;
    const issueCredential = vi.fn(() =>
      issuedCredential(
        'credential-should-not-exist',
        'relay-sac-v1.credential-should-not-exist.redacted'
      )
    );
    const sessions = await import('../server/sessions.js');
    sessions.configure({
      port: 4567,
      configDir: '/tmp',
      orchestratorCredentials: {
        issueCredential,
        revokeCredential: vi.fn(),
      },
    });

    const { session } = await sessions.createWeb({
      id: 'hermes-worker-session',
      agentType: 'hermes',
      cwd: '/tmp',
      displayName: 'Hermes worker',
      port: 4567,
      configDir: '/tmp',
    });

    expect(session.role).toBeUndefined();
    expect(issueCredential).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPromptAppendix: expect.stringContaining(
          'operator’s Relay-managed orchestrator'
        ),
      })
    );
  });

  it('revokes and rejects an orchestrator adapter without env refresh', async () => {
    supportsRuntimeEnvRefresh = false;
    const revokeCredential = vi.fn();
    const sessions = await import('../server/sessions.js');
    sessions.configure({
      port: 4567,
      configDir: '/tmp',
      orchestratorCredentials: {
        issueCredential: () =>
          issuedCredential(
            'credential-unsupported',
            'relay-sac-v1.credential-unsupported.redacted'
          ),
        revokeCredential,
      },
    });

    await expect(
      sessions.createWeb({
        id: 'orchestrator-session',
        role: 'orchestrator',
        agentType: 'mock',
        cwd: '/tmp',
        displayName: 'Product orchestrator',
        port: 4567,
        configDir: '/tmp',
      })
    ).rejects.toThrow('does not support orchestrator credential refresh');
    expect(connect).not.toHaveBeenCalled();
    expect(revokeCredential).toHaveBeenCalledWith('credential-unsupported', {
      revokedBy: 'relay-ide',
      reason: 'orchestrator-session-ended',
    });
  });

  it('kills the session when scheduled credential application fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-07-25T00:00:00.000Z');
    let issueCount = 0;
    const revokeCredential = vi.fn();
    refreshRuntimeEnv.mockRejectedValue(
      new Error('runtime refresh failed around secret material')
    );
    const sessions = await import('../server/sessions.js');
    sessions.configure({
      port: 4567,
      configDir: '/tmp',
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

    await sessions.createWeb({
      id: 'orchestrator-session',
      role: 'orchestrator',
      agentType: 'mock',
      cwd: '/tmp',
      displayName: 'Product orchestrator',
      port: 4567,
      configDir: '/tmp',
    });

    await vi.advanceTimersByTimeAsync(7.5 * 60 * 1000);

    expect(sessions.get('orchestrator-session')).toBeUndefined();
    expect(revokeCredential).toHaveBeenCalledWith('credential-2', {
      revokedBy: 'relay-ide',
      reason: 'orchestrator-token-refresh-failed',
    });
    expect(revokeCredential).toHaveBeenCalledWith('credential-1', {
      revokedBy: 'relay-ide',
      reason: 'orchestrator-session-ended',
    });
  });

  it('stops and removes the lease when the adapter becomes disconnected', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-07-25T00:00:00.000Z');
    let issueCount = 0;
    const revokeCredential = vi.fn();
    const sessions = await import('../server/sessions.js');
    sessions.configure({
      port: 4567,
      configDir: '/tmp',
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

    const { session } = await sessions.createWeb({
      id: 'orchestrator-session',
      role: 'orchestrator',
      agentType: 'mock',
      cwd: '/tmp',
      displayName: 'Product orchestrator',
      port: 4567,
      configDir: '/tmp',
    });
    adapterStatus = 'disconnected';
    sessions.fireBackendStateIfChanged(session);

    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);

    expect(sessions.get(session.id)).toBe(session);
    expect(issueCount).toBe(1);
    expect(refreshRuntimeEnv).not.toHaveBeenCalled();
    expect(revokeCredential).toHaveBeenCalledTimes(1);
    expect(revokeCredential).toHaveBeenCalledWith('credential-1', {
      revokedBy: 'relay-ide',
      reason: 'orchestrator-session-ended',
    });
  });
});
