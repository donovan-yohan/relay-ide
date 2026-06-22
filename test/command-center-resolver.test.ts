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

const sessionsListDescriptor: RelayActionDescriptor = {
  id: 'sessions.list',
  title: 'sessions list',
  label: 'sessions list',
  description: 'List Relay sessions',
  input: {
    kind: 'json-schema',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { repoId: { type: 'string' } },
    },
  },
  availability: { state: 'available', capabilityHints: ['session:read'] },
  sideEffect: 'read',
  confirmation: { required: false, controlRequirements: [] },
  surfaces: ['web', 'command-center'],
  result: { kind: 'json-schema', schema: { type: 'object' } },
  error: { kind: 'json-schema', schema: { type: 'object' } },
  stable: true,
  source: 'cli-gateway-v1',
  contract: {
    relayCommandName: 'sessions.list',
    stable: true,
    source: 'shared/relay-command-manifest.ts',
    cli: ['relay-ide', 'v1', 'sessions', 'list', '--json'],
    errorCodes: ['INTERNAL'],
  },
  ui: { actionId: 'gateway.sessions.list', category: 'gateway' },
};

const catalog = buildCommandCenterResolverCatalog([sessionsListDescriptor]);

const validIntent: CommandCenterProviderIntent = {
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
      label: 'sessions list',
      sideEffect: 'read',
      requiresConfirmation: false,
      scopeKinds: ['session'],
      capabilityHints: ['session:read'],
      surfaces: ['web', 'command-center'],
      ui: { actionId: 'gateway.sessions.list', category: 'gateway' },
    });
    expect(entry?.keywords).toEqual(
      expect.arrayContaining(['sessions', 'list', 'relay'])
    );
  });

  it('summarizes the provider catalog without prompts, args, or secret fields', () => {
    expect(summarizeCommandCenterCatalogForResolver(catalog)).toEqual([
      {
        commandId: 'sessions.list',
        label: 'sessions list',
        summary: 'List Relay sessions',
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
});

describe('Command Center provider intent validation', () => {
  it('returns a strict resolved contract for valid provider output', () => {
    const resolution = validateCommandCenterProviderIntent(validIntent, {
      catalog,
      query: 'sessions',
    });

    expect(resolution.kind).toBe('resolved');
    if (resolution.kind !== 'resolved') return;
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

  it('falls back safely for malformed output, unknown command, and low confidence', () => {
    expect(
      validateCommandCenterProviderIntent(null, { catalog })
    ).toMatchObject({
      kind: 'fallback',
      reason: 'malformed-output',
    });
    expect(
      validateCommandCenterProviderIntent(
        { commandId: 'not.real', args: {}, confidence: 0.95 },
        { catalog }
      )
    ).toMatchObject({ kind: 'fallback', reason: 'unknown-command' });
    expect(
      validateCommandCenterProviderIntent(
        { ...validIntent, confidence: 0.1 },
        { catalog, minConfidence: 0.6 }
      )
    ).toMatchObject({ kind: 'fallback', reason: 'low-confidence' });
  });

  it('falls back safely for invalid args and metadata/ui target mismatch', () => {
    expect(
      validateCommandCenterProviderIntent(
        { ...validIntent, args: { extra: true } },
        { catalog }
      )
    ).toMatchObject({ kind: 'fallback', reason: 'invalid-args' });
    expect(
      validateCommandCenterProviderIntent(
        { ...validIntent, sideEffect: 'destructive' },
        { catalog }
      )
    ).toMatchObject({ kind: 'fallback', reason: 'metadata-mismatch' });
    expect(
      validateCommandCenterProviderIntent(
        { ...validIntent, ui: { actionId: 'gateway.sessions.kill' } },
        { catalog }
      )
    ).toMatchObject({ kind: 'fallback', reason: 'metadata-mismatch' });
  });
});
