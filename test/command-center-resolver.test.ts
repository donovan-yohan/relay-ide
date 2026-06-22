import { describe, expect, it } from 'vitest';

import {
  buildCommandCenterResolverCatalog,
  searchCommandCenterCatalog,
  summarizeCommandCenterCatalogForResolver,
  validateCommandCenterArgs,
  validateCommandCenterProviderIntent,
  type CommandCenterProviderIntent,
} from '../shared/command-center-resolver.js';
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
const destructiveDescriptor = descriptorFor('sessions.kill', 'destructive', {
  confirmation: {
    required: true,
    controlRequirements: ['confirmation-challenge'],
  },
});
const streamDescriptor = descriptorFor('sessions.stream', 'stream');

const catalog = buildCommandCenterResolverCatalog([sessionsListDescriptor]);
const unsafeCatalog = buildCommandCenterResolverCatalog([
  sessionsListDescriptor,
  destructiveDescriptor,
  streamDescriptor,
]);

const validIntent: CommandCenterProviderIntent = {
  kind: 'execute_command',
  commandId: 'sessions.list',
  args: { repoId: 'repo-1' },
  confidence: 0.92,
  sideEffect: 'read',
  requiresConfirmation: false,
  scopeKinds: ['session'],
  capabilityHints: ['session:read'],
  surfaces: ['web', 'command-center'],
  ui: { actionId: 'gateway.sessions.list', category: 'gateway' },
};

describe('Command Center resolver catalog', () => {
  it('projects compact command metadata from shared action descriptors', () => {
    expect(catalog.entries).toHaveLength(1);
    const entry = catalog.byCommandId.get('sessions.list');

    expect(entry).toMatchObject({
      commandId: 'sessions.list',
      label: 'sessions.list',
      sideEffect: 'read',
      requiresConfirmation: false,
      scopeKinds: ['session'],
      capabilityHints: ['session:read'],
      surfaces: ['web', 'command-center'],
      ui: { actionId: 'gateway.sessions.list', category: 'gateway' },
    });
    expect(entry?.keywords).toEqual(
      expect.arrayContaining(['sessions', 'list'])
    );
  });

  it('summarizes the provider catalog without prompts, args, or secret fields', () => {
    expect(summarizeCommandCenterCatalogForResolver(catalog)).toEqual([
      {
        commandId: 'sessions.list',
        label: 'sessions.list',
        summary: 'Command sessions.list',
        sideEffect: 'read',
        requiresConfirmation: false,
        inputSchema: sessionsListDescriptor.input.schema,
      },
    ]);
  });

  it('keeps deterministic search available without a provider', () => {
    const hits = searchCommandCenterCatalog('show relay sessions', catalog);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.entry.commandId).toBe('sessions.list');
    expect(searchCommandCenterCatalog('the and', catalog)).toEqual([]);
  });
});

describe('Command Center args validation', () => {
  it('accepts valid json-schema args and rejects unknown/malformed args', () => {
    const schema = sessionsListDescriptor.input.schema;
    expect(validateCommandCenterArgs({ repoId: 'repo-1' }, schema)).toEqual([]);
    expect(
      validateCommandCenterArgs({ repoId: 42 }, schema).join('\n')
    ).toContain('expected string');
    expect(
      validateCommandCenterArgs({ extra: true }, schema).join('\n')
    ).toContain('unknown property');
  });

  it('requires own properties for required schema keys', () => {
    const inherited = Object.create({ toString: 'not-own' }) as Record<
      string,
      unknown
    >;
    const schema = {
      type: 'object' as const,
      required: ['toString'],
      properties: { toString: { type: 'string' as const } },
      additionalProperties: false,
    };

    expect(validateCommandCenterArgs(inherited, schema).join('\n')).toContain(
      '$.toString: required'
    );
    expect(validateCommandCenterArgs({ toString: 'own' }, schema)).toEqual([]);
  });
});

describe('Command Center provider intent validation', () => {
  it('returns a strict execute_command contract for valid provider output', () => {
    const resolution = validateCommandCenterProviderIntent(validIntent, {
      catalog,
      query: 'sessions',
    });

    expect(resolution.kind).toBe('execute_command');
    if (resolution.kind !== 'execute_command') return;
    expect(resolution.intent).toMatchObject({
      commandId: 'sessions.list',
      args: { repoId: 'repo-1' },
      confidence: 0.92,
      sideEffect: 'read',
      requiresConfirmation: false,
      scopeKinds: ['session'],
      capabilityHints: ['session:read'],
      surfaces: ['web', 'command-center'],
      ui: { actionId: 'gateway.sessions.list', category: 'gateway' },
    });
    expect(resolution.suggestions[0]?.entry.commandId).toBe('sessions.list');
  });

  it('validates strict open_ui, ask_followup, explain, and no_match shapes', () => {
    expect(
      validateCommandCenterProviderIntent(
        { ...validIntent, kind: 'open_ui' },
        { catalog }
      )
    ).toMatchObject({
      kind: 'open_ui',
      ui: { actionId: 'gateway.sessions.list', category: 'gateway' },
    });
    expect(
      validateCommandCenterProviderIntent(
        { kind: 'ask_followup', question: 'Which session?', confidence: 0.8 },
        { catalog }
      )
    ).toMatchObject({ kind: 'ask_followup', question: 'Which session?' });
    expect(
      validateCommandCenterProviderIntent(
        { kind: 'ask_followup', question: 'Which session?', confidence: 0.1 },
        { catalog, minConfidence: 0.6 }
      )
    ).toMatchObject({ kind: 'ask_followup', question: 'Which session?' });
    expect(
      validateCommandCenterProviderIntent(
        { kind: 'explain', message: 'I can list sessions.', confidence: 0.8 },
        { catalog }
      )
    ).toMatchObject({ kind: 'explain', message: 'I can list sessions.' });
    expect(
      validateCommandCenterProviderIntent(
        { kind: 'no_match', reason: 'not a Relay command', confidence: 0.2 },
        { catalog }
      )
    ).toMatchObject({ kind: 'no_match', reason: 'provider-no-match' });
  });

  it('falls back safely for malformed output, unknown command, and low confidence', () => {
    expect(
      validateCommandCenterProviderIntent(null, { catalog })
    ).toMatchObject({
      kind: 'no_match',
      reason: 'malformed-output',
    });
    expect(
      validateCommandCenterProviderIntent(
        {
          kind: 'execute_command',
          commandId: 'not.real',
          args: {},
          confidence: 0.95,
        },
        { catalog }
      )
    ).toMatchObject({ kind: 'no_match', reason: 'unknown-command' });
    expect(
      validateCommandCenterProviderIntent(
        { ...validIntent, confidence: 0.1 },
        { catalog, minConfidence: 0.6 }
      )
    ).toMatchObject({ kind: 'no_match', reason: 'low-confidence' });
  });

  it('falls back safely for invalid args and metadata/ui target mismatch', () => {
    expect(
      validateCommandCenterProviderIntent(
        { ...validIntent, args: { extra: true } },
        { catalog }
      )
    ).toMatchObject({ kind: 'no_match', reason: 'invalid-args' });
    expect(
      validateCommandCenterProviderIntent(
        { ...validIntent, sideEffect: 'destructive' },
        { catalog }
      )
    ).toMatchObject({ kind: 'no_match', reason: 'metadata-mismatch' });
    expect(
      validateCommandCenterProviderIntent(
        {
          ...validIntent,
          kind: 'open_ui',
          ui: { actionId: 'gateway.sessions.kill' },
        },
        { catalog }
      )
    ).toMatchObject({ kind: 'no_match', reason: 'metadata-mismatch' });
  });

  it('does not resolve write/destructive/stream commands as first-slice executable or UI intents', () => {
    expect(
      validateCommandCenterProviderIntent(
        {
          kind: 'execute_command',
          commandId: 'sessions.kill',
          args: {},
          confidence: 0.99,
        },
        { catalog: unsafeCatalog }
      )
    ).toMatchObject({ kind: 'no_match', reason: 'unsafe-command' });
    expect(
      validateCommandCenterProviderIntent(
        {
          kind: 'open_ui',
          commandId: 'sessions.kill',
          args: {},
          confidence: 0.99,
        },
        { catalog: unsafeCatalog }
      )
    ).toMatchObject({ kind: 'no_match', reason: 'unsafe-command' });
    expect(
      validateCommandCenterProviderIntent(
        {
          kind: 'execute_command',
          commandId: 'sessions.stream',
          args: {},
          confidence: 0.99,
        },
        { catalog: unsafeCatalog }
      )
    ).toMatchObject({ kind: 'no_match', reason: 'unsafe-command' });
  });
});
