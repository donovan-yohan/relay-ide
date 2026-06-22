import { describe, expect, it, vi } from 'vitest';

import {
  commandCenterActorCredentialScopeFor,
  createCommandCenterConfirmationStore,
  executeCommandCenterCommand,
  type CommandCenterReadOnlyHandler,
} from '../server/command-center-executor.js';
import { buildCommandCenterResolverCatalog } from '../shared/command-center-resolver.js';
import type { RelayActionDescriptor } from '../shared/action-descriptor.js';
import type { RelayCliGatewayCommand } from '../shared/cli-gateway-contract.js';
import type { RelayCommandSideEffect } from '../shared/relay-command-manifest.js';

function descriptorFor(
  commandId: RelayCliGatewayCommand,
  sideEffect: RelayCommandSideEffect = 'read',
  overrides: Partial<RelayActionDescriptor> = {}
): RelayActionDescriptor {
  return {
    id: commandId,
    title: commandId,
    label: commandId,
    description: `Command ${commandId}`,
    input: {
      kind: 'json-schema',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          repoId: { type: 'string' },
          id: { type: 'string' },
          displayName: { type: 'string' },
          workContextId: { type: 'string' },
        },
      },
    },
    availability: { state: 'available', capabilityHints: ['session:read'] },
    sideEffect,
    confirmation: { required: false, controlRequirements: [] },
    surfaces: ['web', 'command-center'],
    result: { kind: 'json-schema', schema: { type: 'object' } },
    error: { kind: 'json-schema', schema: { type: 'object' } },
    stable: true,
    source: 'cli-gateway-v1',
    contract: {
      relayCommandName: commandId,
      stable: true,
      source: 'shared/relay-command-manifest.ts',
      cli: ['relay-ide', 'v1', commandId, '--json'],
      errorCodes: ['INTERNAL'],
    },
    ui: { actionId: `gateway.${commandId}`, category: 'gateway' },
    ...overrides,
  };
}

const sessionsListDescriptor = descriptorFor('sessions.list');
const nodesListDescriptor = descriptorFor('nodes.list', 'read', {
  availability: { state: 'unavailable', reason: 'node offline' },
});
const writeDescriptor = descriptorFor('sessions.rename', 'write');
const confirmationDescriptor = descriptorFor('sessions.kill', 'destructive', {
  confirmation: {
    required: true,
    controlRequirements: ['confirmation-challenge'],
  },
});
const controlRequirementDescriptor = descriptorFor(
  'supervisor.sendText',
  'write',
  {
    confirmation: {
      required: false,
      controlRequirements: ['fresh-control-state'],
    },
  }
);
const repoScopedDescriptor = descriptorFor('pr-overseer.register', 'write', {
  availability: { state: 'available', capabilityHints: ['context:write'] },
});

const catalog = buildCommandCenterResolverCatalog([
  sessionsListDescriptor,
  nodesListDescriptor,
  writeDescriptor,
  confirmationDescriptor,
  controlRequirementDescriptor,
  repoScopedDescriptor,
]);

const handlers: Partial<
  Record<RelayCliGatewayCommand, CommandCenterReadOnlyHandler>
> = {
  'sessions.list': (args) => ({
    ok: true,
    data: { sessions: [{ id: 's1', repoId: args['repoId'] }] },
  }),
  'sessions.rename': () => ({
    ok: true,
    data: { renamed: true },
  }),
  'supervisor.sendText': () => ({
    ok: true,
    data: { sent: true },
  }),
};

describe('Command Center read-only executor', () => {
  it('executes a schema-valid read-only command and records redacted audit', async () => {
    const auditSink = vi.fn();
    const result = await executeCommandCenterCommand(
      { commandId: 'sessions.list', args: { repoId: 'secret-repo-name' } },
      {
        catalog,
        handlers,
        trustedCapabilities: {
          source: 'actor-grant',
          capabilities: ['session:read'],
        },
        now: vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(37),
        auditSink,
      }
    );

    expect(result.kind).toBe('success');
    expect(result).toMatchObject({
      commandId: 'sessions.list',
      audit: {
        commandId: 'sessions.list',
        resultKind: 'success',
        sideEffectClass: 'read',
        durationMs: 27,
        policyOutcome: 'allowed',
        confirmationOutcome: 'not-required',
        capabilityOutcome: 'allowed-explicit',
        args: {
          rawArgsReturned: false,
          argKeys: ['repoId'],
        },
      },
    });
    expect(JSON.stringify(result.audit)).not.toContain('secret-repo-name');
    expect(result.audit.args.argsSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(auditSink).toHaveBeenCalledWith(result.audit);
  });

  it('rejects malformed args before handler execution', async () => {
    const handler = vi.fn();
    const result = await executeCommandCenterCommand(
      { commandId: 'sessions.list', args: { repoId: 42, extra: true } },
      {
        catalog,
        handlers: { 'sessions.list': handler },
      }
    );

    expect(result).toMatchObject({
      kind: 'blocked',
      reason: 'invalid-args',
      audit: {
        policyOutcome: 'blocked',
        confirmationOutcome: 'blocked',
        resultKind: 'blocked',
      },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('derives actor credential scope from session and repo command args', () => {
    const sessionEntry = catalog.byCommandId.get('sessions.rename');
    const repoEntry = catalog.byCommandId.get('pr-overseer.register');
    if (!sessionEntry || !repoEntry)
      throw new Error('expected catalog entries');

    expect(
      commandCenterActorCredentialScopeFor(sessionEntry, {
        id: 'session-1',
        globalSessionId: 'global-session-1',
      })
    ).toEqual({
      sessionIds: ['session-1'],
      globalSessionIds: ['global-session-1'],
    });
    expect(
      commandCenterActorCredentialScopeFor(repoEntry, { repoId: 'repo-1' })
    ).toEqual({ repoIds: ['repo-1'] });
  });

  it('validates actor credential scope before minting confirmation previews', async () => {
    const handler = vi.fn(handlers['sessions.rename']);
    const store = {
      create: vi.fn(() => {
        throw new Error('challenge should not be minted');
      }),
      consume: vi.fn(),
    };
    const validateActorScope = vi.fn(() => ({
      ok: false as const,
      reason: 'wrong_session_scope' as const,
      credentialId: 'cred-wrong-session',
    }));

    const result = await executeCommandCenterCommand(
      {
        commandId: 'sessions.rename',
        args: { id: 'session-2', displayName: 'new name' },
      },
      {
        catalog,
        handlers: { ...handlers, 'sessions.rename': handler },
        confirmationStore: store,
        trustedCapabilities: {
          source: 'actor-grant',
          actorId: 'actor-1',
          capabilities: ['session:read'],
        },
        validateActorScope,
      }
    );

    expect(result).toMatchObject({
      kind: 'blocked',
      reason: 'actor-scope-denied',
      audit: {
        policyOutcome: 'blocked',
        confirmationOutcome: 'blocked',
        reason: 'actor-scope-wrong_session_scope',
      },
    });
    expect(validateActorScope).toHaveBeenCalledWith(
      expect.objectContaining({
        requiredCapabilities: ['session:read'],
        requestedScope: { sessionIds: ['session-2'] },
      })
    );
    expect(store.create).not.toHaveBeenCalled();
    expect(store.consume).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('validates actor credential scope before redeeming confirmations', async () => {
    const handler = vi.fn(handlers['sessions.rename']);
    const store = createCommandCenterConfirmationStore();
    const first = await executeCommandCenterCommand(
      {
        commandId: 'sessions.rename',
        args: { id: 'session-1', displayName: 'new name' },
      },
      {
        catalog,
        handlers: { ...handlers, 'sessions.rename': handler },
        confirmationStore: store,
        trustedCapabilities: {
          source: 'actor-grant',
          actorId: 'actor-1',
          capabilities: ['session:read'],
        },
        validateActorScope: () => ({ ok: true }),
        now: () => 10,
      }
    );
    if (first.kind !== 'confirmation_required')
      throw new Error('expected preview');

    const consume = vi.spyOn(store, 'consume');
    const second = await executeCommandCenterCommand(
      {
        commandId: 'sessions.rename',
        args: { id: 'session-1', displayName: 'new name' },
        confirmation: {
          challengeId: first.preview.challengeId,
          decision: 'confirm',
        },
      },
      {
        catalog,
        handlers: { ...handlers, 'sessions.rename': handler },
        confirmationStore: store,
        trustedCapabilities: {
          source: 'actor-grant',
          actorId: 'actor-2',
          capabilities: ['session:read'],
        },
        validateActorScope: () => ({
          ok: false,
          reason: 'wrong_session_scope',
        }),
        now: () => 11,
      }
    );

    expect(second).toMatchObject({
      kind: 'blocked',
      reason: 'actor-scope-denied',
      audit: { reason: 'actor-scope-wrong_session_scope' },
    });
    expect(consume).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('validates repo-style actor credential scope before confirmation minting', async () => {
    const result = await executeCommandCenterCommand(
      {
        commandId: 'pr-overseer.register',
        args: { repoId: 'repo-denied' },
      },
      {
        catalog,
        handlers,
        trustedCapabilities: {
          source: 'actor-grant',
          actorId: 'actor-1',
          capabilities: ['context:write'],
        },
        validateActorScope: vi.fn((input) =>
          input.requestedScope?.repoIds?.includes('repo-allowed')
            ? ({ ok: true } as const)
            : ({ ok: false, reason: 'wrong_repo_scope' } as const)
        ),
      }
    );

    expect(result).toMatchObject({
      kind: 'blocked',
      reason: 'actor-scope-denied',
      audit: { reason: 'actor-scope-wrong_repo_scope' },
    });
  });

  it('requires redacted confirmation preview before write/destructive commands', async () => {
    const store = createCommandCenterConfirmationStore();
    const handler = vi.fn(handlers['sessions.rename']);
    const first = await executeCommandCenterCommand(
      { commandId: 'sessions.rename', args: { repoId: 'secret-repo-name' } },
      {
        catalog,
        handlers: { ...handlers, 'sessions.rename': handler },
        confirmationStore: store,
        trustedCapabilities: {
          source: 'actor-grant',
          actorId: 'actor-1',
          capabilities: ['session:read'],
        },
        now: () => 100,
      }
    );
    expect(first.kind).toBe('confirmation_required');
    if (first.kind !== 'confirmation_required')
      throw new Error('expected preview');
    expect(first.preview).toMatchObject({
      commandId: 'sessions.rename',
      label: 'sessions.rename',
      scopedTarget: 'session:unspecified',
      sideEffectClass: 'write',
      args: { rawArgsReturned: false, argKeys: ['repoId'] },
      expectedResultShape: { kind: 'json-schema' },
    });
    expect(JSON.stringify(first)).not.toContain('secret-repo-name');
    expect(handler).not.toHaveBeenCalled();

    const confirmed = await executeCommandCenterCommand(
      {
        commandId: 'sessions.rename',
        args: { repoId: 'secret-repo-name' },
        confirmation: {
          challengeId: first.preview.challengeId,
          decision: 'confirm',
        },
        providerMetadata: {
          source: 'resolver',
          model: 'resolver-small',
          rawPayload: { prompt: 'do not store me' },
        },
      },
      {
        catalog,
        handlers: { ...handlers, 'sessions.rename': handler },
        confirmationStore: store,
        trustedCapabilities: {
          source: 'actor-grant',
          actorId: 'actor-1',
          capabilities: ['session:read'],
        },
        now: () => 101,
      }
    );
    expect(confirmed).toMatchObject({
      kind: 'success',
      commandId: 'sessions.rename',
      audit: {
        policyOutcome: 'allowed',
        confirmationOutcome: 'confirmed',
        actor: { kind: 'actor-grant', id: 'actor-1' },
        provider: {
          rawProviderPayloadReturned: false,
          source: 'resolver',
          model: 'resolver-small',
          metadataKeys: ['model', 'source'],
        },
      },
    });
    expect(JSON.stringify(confirmed)).not.toContain('do not store me');
    expect(handler).toHaveBeenCalledTimes(1);

    await expect(
      executeCommandCenterCommand(
        { commandId: 'sessions.kill', args: { repoId: 'repo-1' } },
        {
          catalog,
          handlers,
          trustedCapabilities: {
            source: 'actor-grant',
            capabilities: ['session:read'],
          },
        }
      )
    ).resolves.toMatchObject({
      kind: 'confirmation_required',
      reason: 'control-requirement',
      audit: {
        sideEffectClass: 'destructive',
        policyOutcome: 'confirmation-required',
      },
    });
  });

  it('returns typed unavailable state before handler execution', async () => {
    const result = await executeCommandCenterCommand(
      { commandId: 'nodes.list', args: { repoId: 'repo-1' } },
      { catalog, handlers }
    );

    expect(result).toMatchObject({
      kind: 'unavailable',
      commandId: 'nodes.list',
      reason: 'command-unavailable',
      message: 'node offline',
      audit: {
        resultKind: 'unavailable',
        availabilityState: 'unavailable',
      },
    });
  });

  it('caps retained confirmation challenges and evicts the oldest preview', () => {
    const store = createCommandCenterConfirmationStore();
    const nowMs = Date.now();
    const records = Array.from({ length: 513 }, (_, index) =>
      store.create({
        commandId: 'sessions.rename',
        argsSha256: `args-${index}`,
        expiresAtMs: nowMs + 60_000,
      })
    );

    expect(
      store.consume({
        challengeId: records[0]!.challengeId,
        commandId: 'sessions.rename',
        argsSha256: 'args-0',
        nowMs,
      })
    ).toEqual({ ok: false, reason: 'missing' });
    expect(
      store.consume({
        challengeId: records[512]!.challengeId,
        commandId: 'sessions.rename',
        argsSha256: 'args-512',
        nowMs,
      })
    ).toMatchObject({ ok: true });
  });

  it('records confirmation deny and stale decisions without executing handlers', async () => {
    const deniedStore = createCommandCenterConfirmationStore();
    const deniedHandler = vi.fn(handlers['sessions.rename']);
    const deniedPreview = await executeCommandCenterCommand(
      { commandId: 'sessions.rename', args: { repoId: 'repo-1' } },
      {
        catalog,
        handlers: { ...handlers, 'sessions.rename': deniedHandler },
        confirmationStore: deniedStore,
        trustedCapabilities: {
          source: 'actor-grant',
          capabilities: ['session:read'],
        },
        now: () => 1,
      }
    );
    if (deniedPreview.kind !== 'confirmation_required')
      throw new Error('expected preview');
    await expect(
      executeCommandCenterCommand(
        {
          commandId: 'sessions.rename',
          args: { repoId: 'repo-1' },
          confirmation: {
            challengeId: deniedPreview.preview.challengeId,
            decision: 'deny',
          },
        },
        {
          catalog,
          handlers: { ...handlers, 'sessions.rename': deniedHandler },
          confirmationStore: deniedStore,
          trustedCapabilities: {
            source: 'actor-grant',
            capabilities: ['session:read'],
          },
          now: () => 2,
        }
      )
    ).resolves.toMatchObject({
      kind: 'blocked',
      reason: 'confirmation-denied',
      audit: { confirmationOutcome: 'denied' },
    });
    expect(deniedHandler).not.toHaveBeenCalled();

    const staleStore = createCommandCenterConfirmationStore();
    const stalePreview = await executeCommandCenterCommand(
      { commandId: 'sessions.rename', args: { repoId: 'repo-1' } },
      {
        catalog,
        handlers,
        confirmationStore: staleStore,
        trustedCapabilities: {
          source: 'actor-grant',
          capabilities: ['session:read'],
        },
        now: () => 1,
      }
    );
    if (stalePreview.kind !== 'confirmation_required')
      throw new Error('expected preview');
    await expect(
      executeCommandCenterCommand(
        {
          commandId: 'sessions.rename',
          args: { repoId: 'repo-1' },
          confirmation: {
            challengeId: stalePreview.preview.challengeId,
            decision: 'confirm',
          },
        },
        {
          catalog,
          handlers,
          confirmationStore: staleStore,
          trustedCapabilities: {
            source: 'actor-grant',
            capabilities: ['session:read'],
          },
          now: () => 120_002,
        }
      )
    ).resolves.toMatchObject({
      kind: 'blocked',
      reason: 'confirmation-stale',
      audit: { confirmationOutcome: 'stale' },
    });
  });

  it('blocks non-confirmation control requirements before creating a confirmation challenge', async () => {
    const handler = vi.fn(handlers['supervisor.sendText']);
    const result = await executeCommandCenterCommand(
      { commandId: 'supervisor.sendText', args: { repoId: 'repo-1' } },
      {
        catalog,
        handlers: { ...handlers, 'supervisor.sendText': handler },
        confirmationStore: createCommandCenterConfirmationStore(),
        trustedCapabilities: {
          source: 'actor-grant',
          capabilities: ['session:read'],
        },
      }
    );

    expect(result).toMatchObject({
      kind: 'blocked',
      reason: 'control-requirement-unsatisfied',
      message: expect.stringContaining('fresh-control-state'),
      audit: {
        policyOutcome: 'blocked',
        confirmationOutcome: 'blocked',
        reason: 'control-requirement-unsatisfied',
      },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('fails closed for unknown ids and missing explicit capabilities', async () => {
    await expect(
      executeCommandCenterCommand(
        { commandId: 'raw.shell', args: { command: 'rm -rf /' } },
        { catalog, handlers }
      )
    ).resolves.toMatchObject({
      kind: 'blocked',
      reason: 'unknown-command',
      audit: { commandId: 'raw.shell', args: { rawArgsReturned: false } },
    });

    await expect(
      executeCommandCenterCommand(
        { commandId: 'sessions.list', args: { repoId: 'repo-1' } },
        {
          catalog,
          handlers,
          trustedCapabilities: { source: 'actor-grant', capabilities: [] },
        }
      )
    ).resolves.toMatchObject({
      kind: 'blocked',
      reason: 'missing-capability',
      audit: { capabilityOutcome: 'blocked' },
    });
    await expect(
      executeCommandCenterCommand(
        { commandId: 'sessions.list', args: { repoId: 'repo-1' } },
        { catalog, handlers }
      )
    ).resolves.toMatchObject({
      kind: 'blocked',
      reason: 'missing-capability',
      audit: { capabilityOutcome: 'blocked' },
    });
  });

  it('rejects over-budget args before canonical audit hashing', async () => {
    const handler = vi.fn();
    const result = await executeCommandCenterCommand(
      {
        commandId: 'sessions.list',
        args: { repoId: 'repo-1', payload: 'x'.repeat(20_000) },
      },
      {
        catalog,
        handlers: { 'sessions.list': handler },
        trustedCapabilities: {
          source: 'actor-grant',
          capabilities: ['session:read'],
        },
      }
    );

    expect(result).toMatchObject({
      kind: 'blocked',
      reason: 'invalid-args',
      audit: {
        policyOutcome: 'blocked',
        confirmationOutcome: 'blocked',
        reason: 'args-over-budget',
      },
    });
    expect(handler).not.toHaveBeenCalled();
  });
});
