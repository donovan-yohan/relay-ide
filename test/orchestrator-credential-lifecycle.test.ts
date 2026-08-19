import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScopedActorCredentialRecord } from '../shared/scoped-actor-credentials.js';
import {
  ORCHESTRATOR_ACTOR_CAPABILITIES,
  ORCHESTRATOR_ACTOR_CREDENTIAL_TTL_MS,
  READONLY_RUNTIME_ACTOR_CAPABILITIES,
  RUNTIME_ACTOR_CREDENTIAL_TTL_MS,
  startOrchestratorCredentialLifecycle,
  type OrchestratorCredentialLifecycleDeps,
} from '../server/orchestrator-credential-lifecycle.js';

const START_MS = Date.parse('2026-07-25T00:00:00.000Z');

function credential(
  id: string,
  issuedAtMs: number
): ScopedActorCredentialRecord {
  return {
    id,
    actor: { type: 'agent', id: 'agent-profile:test' },
    issuer: { id: 'relay-ide' },
    audience: 'relay:cli-gateway:v1',
    capabilities: [...ORCHESTRATOR_ACTOR_CAPABILITIES],
    scope: {
      sessionIds: ['runtime-orchestrator'],
      taskRefs: ['relay:cli-gateway:v1:read'],
    },
    metadata: { reason: 'persistent-orchestrator' },
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(
      issuedAtMs + ORCHESTRATOR_ACTOR_CREDENTIAL_TTL_MS
    ).toISOString(),
    correlationId: `correlation-${id}`,
  };
}

function harness(
  options: {
    issueError?: Error;
    applyError?: Error;
  } = {}
): {
  deps: OrchestratorCredentialLifecycleDeps;
  issueCredential: ReturnType<typeof vi.fn>;
  revokeCredential: ReturnType<typeof vi.fn>;
  applyRuntimeEnv: ReturnType<typeof vi.fn>;
  failClosed: ReturnType<typeof vi.fn>;
  events: string[];
} {
  let issueCount = 0;
  const events: string[] = [];
  const issueCredential = vi.fn(() => {
    if (options.issueError) throw options.issueError;
    issueCount++;
    const id = `credential-${issueCount}`;
    events.push(`issue:${id}`);
    return {
      token: `relay-sac-v1.${id}.secret-${issueCount}`,
      credential: credential(id, Date.now()),
    };
  });
  const revokeCredential = vi.fn((id: string) => {
    events.push(`revoke:${id}`);
  });
  const applyRuntimeEnv = vi.fn(async () => {
    events.push('apply');
    if (options.applyError) throw options.applyError;
  });
  const failClosed = vi.fn(() => {
    events.push('fail-closed');
  });
  return {
    deps: {
      issueCredential,
      revokeCredential,
      applyRuntimeEnv,
      failClosed,
    },
    issueCredential,
    revokeCredential,
    applyRuntimeEnv,
    failClosed,
    events,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('OrchestratorCredentialLifecycle', () => {
  it('mints the exact bounded actor credential before adapter creation', () => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
    const h = harness();

    const lease = startOrchestratorCredentialLifecycle(
      {
        runtimeId: 'runtime-orchestrator',
        channelId: 'channel-A',
        profileActorId: 'agent-profile:test',
        port: 4567,
        displayName: 'Product orchestrator',
        leaseKind: 'orchestrator',
        capabilities: [...ORCHESTRATOR_ACTOR_CAPABILITIES],
        rotation: 'refresh',
      },
      h.deps
    );

    expect(h.issueCredential).toHaveBeenCalledWith({
      actor: {
        type: 'agent',
        id: 'agent-profile:test',
        displayName: 'Product orchestrator',
      },
      issuer: { id: 'relay-ide', displayName: 'Relay' },
      capabilities: [...ORCHESTRATOR_ACTOR_CAPABILITIES],
      scope: {
        sessionIds: ['runtime-orchestrator'],
        channelIds: ['channel-A'],
      },
      ttlMs: 15 * 60 * 1000,
    });
    expect(lease.processEnv).toEqual({
      RELAY_IDE_ACTOR_TOKEN: 'relay-sac-v1.credential-1.secret-1',
      RELAY_IDE_PORT: '4567',
      RELAY_IDE_RUNTIME_ID: 'runtime-orchestrator',
    });
    expect(h.applyRuntimeEnv).not.toHaveBeenCalled();

    lease.stop();
  });

  it('refreshes at half lifetime and revokes old only after apply', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
    const h = harness();
    const lease = startOrchestratorCredentialLifecycle(
      {
        runtimeId: 'runtime-orchestrator',
        channelId: 'channel-A',
        profileActorId: 'agent-profile:test',
        port: 4567,
        leaseKind: 'orchestrator',
        capabilities: [...ORCHESTRATOR_ACTOR_CAPABILITIES],
        rotation: 'refresh',
      },
      h.deps
    );

    await vi.advanceTimersByTimeAsync(7.5 * 60 * 1000 - 1);
    expect(h.issueCredential).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);

    expect(h.applyRuntimeEnv).toHaveBeenCalledWith({
      RELAY_IDE_ACTOR_TOKEN: 'relay-sac-v1.credential-2.secret-2',
      RELAY_IDE_PORT: '4567',
      RELAY_IDE_RUNTIME_ID: 'runtime-orchestrator',
    });
    expect(h.events).toEqual([
      'issue:credential-1',
      'issue:credential-2',
      'apply',
      'revoke:credential-1',
    ]);
    expect(h.issueCredential.mock.calls.map(([input]) => input.scope)).toEqual([
      {
        sessionIds: ['runtime-orchestrator'],
        channelIds: ['channel-A'],
      },
      {
        sessionIds: ['runtime-orchestrator'],
        channelIds: ['channel-A'],
      },
    ]);
    expect(lease.processEnv).toEqual({
      RELAY_IDE_ACTOR_TOKEN: 'relay-sac-v1.credential-2.secret-2',
      RELAY_IDE_PORT: '4567',
      RELAY_IDE_RUNTIME_ID: 'runtime-orchestrator',
    });

    lease.stop();
  });

  it('stops the timer and revokes the current credential on runtime end', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
    const h = harness();
    const lease = startOrchestratorCredentialLifecycle(
      {
        runtimeId: 'runtime-orchestrator',
        channelId: 'channel-A',
        profileActorId: 'agent-profile:test',
        port: 4567,
        leaseKind: 'orchestrator',
        capabilities: [...ORCHESTRATOR_ACTOR_CAPABILITIES],
        rotation: 'refresh',
      },
      h.deps
    );

    lease.stop();
    await vi.advanceTimersByTimeAsync(ORCHESTRATOR_ACTOR_CREDENTIAL_TTL_MS);

    expect(h.issueCredential).toHaveBeenCalledTimes(1);
    expect(h.revokeCredential).toHaveBeenCalledTimes(1);
    expect(h.revokeCredential).toHaveBeenCalledWith('credential-1', {
      revokedBy: 'relay-ide',
      reason: 'orchestrator-runtime-ended',
    });
  });

  it('fails initial provisioning without exposing issuer error material', () => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
    const h = harness({
      issueError: new Error(
        'issuer failed around relay-sac-v1.private.secret-material'
      ),
    });

    expect(() =>
      startOrchestratorCredentialLifecycle(
        {
          runtimeId: 'runtime-orchestrator',
          channelId: 'channel-A',
          profileActorId: 'agent-profile:test',
          port: 4567,
          leaseKind: 'orchestrator',
          capabilities: [...ORCHESTRATOR_ACTOR_CAPABILITIES],
          rotation: 'refresh',
        },
        h.deps
      )
    ).toThrowError('Failed to provision orchestrator actor credential');
    try {
      startOrchestratorCredentialLifecycle(
        {
          runtimeId: 'runtime-orchestrator',
          channelId: 'channel-A',
          profileActorId: 'agent-profile:test',
          port: 4567,
          leaseKind: 'orchestrator',
          capabilities: [...ORCHESTRATOR_ACTOR_CAPABILITIES],
          rotation: 'refresh',
        },
        h.deps
      );
    } catch (error) {
      expect(String(error)).not.toContain('secret-material');
    }
  });

  it('revokes a failed replacement and requests fail-closed termination', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
    const h = harness({
      applyError: new Error(
        'env apply failed for relay-sac-v1.private.secret-material'
      ),
    });
    const lease = startOrchestratorCredentialLifecycle(
      {
        runtimeId: 'runtime-orchestrator',
        channelId: 'channel-A',
        profileActorId: 'agent-profile:test',
        port: 4567,
        leaseKind: 'orchestrator',
        capabilities: [...ORCHESTRATOR_ACTOR_CAPABILITIES],
        rotation: 'refresh',
      },
      h.deps
    );

    await lease.refreshNow();

    expect(h.revokeCredential).toHaveBeenCalledWith('credential-2', {
      revokedBy: 'relay-ide',
      reason: 'orchestrator-token-refresh-failed',
    });
    expect(h.revokeCredential).not.toHaveBeenCalledWith(
      'credential-1',
      expect.anything()
    );
    expect(h.failClosed).toHaveBeenCalledTimes(1);
    const error = h.failClosed.mock.calls[0]?.[0];
    expect(String(error)).toBe(
      'Error: Failed to refresh orchestrator actor credential'
    );
    expect(String(error)).not.toContain('secret-material');

    lease.stop();
  });

  it('fails closed before expiry when runtime application stays blocked', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
    let releaseApply: (() => void) | undefined;
    const h = harness();
    h.deps.applyRuntimeEnv = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseApply = resolve;
        })
    );
    const lease = startOrchestratorCredentialLifecycle(
      {
        runtimeId: 'runtime-orchestrator',
        channelId: 'channel-A',
        profileActorId: 'agent-profile:test',
        port: 4567,
        leaseKind: 'orchestrator',
        capabilities: [...ORCHESTRATOR_ACTOR_CAPABILITIES],
        rotation: 'refresh',
      },
      h.deps
    );

    const refresh = lease.refreshNow();
    await vi.advanceTimersByTimeAsync(
      ORCHESTRATOR_ACTOR_CREDENTIAL_TTL_MS - 1_000
    );
    await refresh;

    expect(h.failClosed).toHaveBeenCalledTimes(1);
    expect(h.revokeCredential).toHaveBeenCalledWith('credential-2', {
      revokedBy: 'relay-ide',
      reason: 'orchestrator-token-refresh-failed',
    });
    expect(h.revokeCredential).not.toHaveBeenCalledWith(
      'credential-1',
      expect.anything()
    );

    releaseApply?.();
    lease.stop();
  });
});

describe('read-only runtime credential lease (#1410)', () => {
  it('mints exactly the read bits, pinned to its own channel and nothing else', () => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
    const h = harness();

    const lease = startOrchestratorCredentialLifecycle(
      {
        runtimeId: 'runtime-collaborator',
        channelId: 'channel-A',
        profileActorId: 'agent-profile:codex:default',
        port: 4567,
        displayName: '#eng · Codex',
        leaseKind: 'channel-runtime-read',
        capabilities: [...READONLY_RUNTIME_ACTOR_CAPABILITIES],
        rotation: 'static',
      },
      h.deps
    );

    expect(READONLY_RUNTIME_ACTOR_CAPABILITIES).toEqual([
      'session:read',
      'context:read',
    ]);
    expect(h.issueCredential).toHaveBeenCalledWith({
      actor: {
        type: 'agent',
        id: 'agent-profile:codex:default',
        displayName: '#eng · Codex',
      },
      issuer: { id: 'relay-ide', displayName: 'Relay' },
      capabilities: ['session:read', 'context:read'],
      // Channel and NOTHING else. `validateCredentialScope` denies any
      // credential dimension a request does not name, and a channel HTTP
      // request names no session — a `sessionIds` pin here would make the lease
      // unusable on every `channels.*` route it exists for. Confinement is not
      // lost: that same rule means a channel-only credential is accepted ONLY by
      // routes that request `channelIds`.
      scope: { channelIds: ['channel-A'] },
      ttlMs: 15 * 60 * 1000,
    });
    const issued = h.issueCredential.mock.calls[0]?.[0];
    expect(issued.capabilities).not.toContain('context:write');
    expect(issued.capabilities).not.toContain('session:create:terminal');
    expect(issued.scope.sessionIds).toBeUndefined();
    expect(lease.processEnv).toEqual({
      RELAY_IDE_ACTOR_TOKEN: 'relay-sac-v1.credential-1.secret-1',
      RELAY_IDE_PORT: '4567',
      RELAY_IDE_RUNTIME_ID: 'runtime-collaborator',
    });

    lease.stop();
  });

  it('never rotates a static lease and lets the credential expire', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
    const h = harness();
    const lease = startOrchestratorCredentialLifecycle(
      {
        runtimeId: 'runtime-collaborator',
        channelId: 'channel-A',
        profileActorId: 'agent-profile:codex:default',
        port: 4567,
        leaseKind: 'channel-runtime-read',
        capabilities: [...READONLY_RUNTIME_ACTOR_CAPABILITIES],
        rotation: 'static',
      },
      h.deps
    );

    await vi.advanceTimersByTimeAsync(RUNTIME_ACTOR_CREDENTIAL_TTL_MS * 4);
    // An adapter with no `refreshRuntimeEnv` cannot receive a replacement
    // token, so re-minting one would only revoke a working credential.
    await lease.refreshNow();

    expect(h.issueCredential).toHaveBeenCalledTimes(1);
    expect(h.applyRuntimeEnv).not.toHaveBeenCalled();
    expect(h.revokeCredential).not.toHaveBeenCalled();
    expect(h.failClosed).not.toHaveBeenCalled();
    expect(h.events).toEqual(['issue:credential-1']);

    lease.stop();
    expect(h.revokeCredential).toHaveBeenCalledWith('credential-1', {
      revokedBy: 'relay-ide',
      reason: 'channel-runtime-read-ended',
    });
  });

  it('rotates a refresh-capable read lease under its own audit reasons', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
    const h = harness();
    const lease = startOrchestratorCredentialLifecycle(
      {
        runtimeId: 'runtime-collaborator',
        channelId: 'channel-A',
        profileActorId: 'agent-profile:claude:default',
        port: 4567,
        leaseKind: 'channel-runtime-read',
        capabilities: [...READONLY_RUNTIME_ACTOR_CAPABILITIES],
        rotation: 'refresh',
      },
      h.deps
    );

    await vi.advanceTimersByTimeAsync(7.5 * 60 * 1000);

    expect(h.events).toEqual([
      'issue:credential-1',
      'issue:credential-2',
      'apply',
      'revoke:credential-1',
    ]);
    // A read lease must never borrow the orchestrator's audit identity.
    expect(h.revokeCredential).toHaveBeenCalledWith('credential-1', {
      revokedBy: 'relay-ide',
      reason: 'channel-runtime-read-rotated',
    });
    expect(
      h.issueCredential.mock.calls.map(([input]) => input.capabilities)
    ).toEqual([
      ['session:read', 'context:read'],
      ['session:read', 'context:read'],
    ]);

    lease.stop();
  });

  it('keeps failure text free of orchestrator identity and credential material', () => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
    const h = harness({
      issueError: new Error(
        'issuer failed around relay-sac-v1.private.secret-material'
      ),
    });

    expect(() =>
      startOrchestratorCredentialLifecycle(
        {
          runtimeId: 'runtime-collaborator',
          channelId: 'channel-A',
          profileActorId: 'agent-profile:codex:default',
          port: 4567,
          leaseKind: 'channel-runtime-read',
          capabilities: [...READONLY_RUNTIME_ACTOR_CAPABILITIES],
          rotation: 'static',
        },
        h.deps
      )
    ).toThrowError('Failed to provision channel runtime read actor credential');
  });
});
