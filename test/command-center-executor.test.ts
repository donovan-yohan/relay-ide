import { describe, expect, it, vi } from 'vitest';

import {
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
        properties: { repoId: { type: 'string' } },
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

const catalog = buildCommandCenterResolverCatalog([
  sessionsListDescriptor,
  nodesListDescriptor,
  writeDescriptor,
  confirmationDescriptor,
]);

const handlers: Partial<
  Record<RelayCliGatewayCommand, CommandCenterReadOnlyHandler>
> = {
  'sessions.list': (args) => ({
    ok: true,
    data: { sessions: [{ id: 's1', repoId: args['repoId'] }] },
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

  it('blocks write/destructive command ids instead of executing', async () => {
    await expect(
      executeCommandCenterCommand(
        { commandId: 'sessions.rename', args: { repoId: 'repo-1' } },
        { catalog, handlers }
      )
    ).resolves.toMatchObject({
      kind: 'blocked',
      reason: 'unsafe-command',
      audit: { sideEffectClass: 'write', policyOutcome: 'blocked' },
    });

    await expect(
      executeCommandCenterCommand(
        { commandId: 'sessions.kill', args: { repoId: 'repo-1' } },
        { catalog, handlers }
      )
    ).resolves.toMatchObject({
      kind: 'confirmation_required',
      reason: 'confirmation-required',
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
