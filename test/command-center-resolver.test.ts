import { describe, expect, it } from 'vitest';

import {
  COMMAND_CENTER_RESOLVER_CATALOG,
  buildCommandCenterResolverCatalog,
  searchCommandCenterCatalog,
  summarizeCommandCenterCatalogForResolver,
  validateCommandCenterArgs,
  validateCommandCenterProviderIntent,
  type CommandCenterProviderIntent,
} from '../shared/command-center-resolver.js';
import { commandCenterExplainCoverageForCommand } from '../shared/command-center-resolver-corpus.js';
import type { RelayActionDescriptor } from '../shared/action-descriptor.js';
import type {
  RelayCliGatewayCommand,
  RelayJsonSchema,
} from '../shared/cli-gateway-contract.js';
import type { RelayCommandSideEffect } from '../shared/relay-command-manifest.js';
import { COMMAND_CENTER_RESOLVER_GOLDEN_CASES } from './fixtures/command-center-resolver/golden-cases.js';

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

function inputSchemaFor(descriptor: RelayActionDescriptor): RelayJsonSchema {
  if (descriptor.input.kind !== 'json-schema') {
    throw new Error(`expected json-schema input for ${descriptor.id}`);
  }
  return descriptor.input.schema;
}

const sessionsListDescriptor = descriptorFor('sessions.list');
const sessionsGetDescriptor = descriptorFor('sessions.get', 'read', {
  input: {
    kind: 'json-schema',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
});
const writeDescriptor = descriptorFor('sessions.rename', 'write');
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
  sessionsGetDescriptor,
  writeDescriptor,
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
  it('wires a real shared catalog entry to a guided open_ui action', () => {
    const uiEntry = COMMAND_CENTER_RESOLVER_CATALOG.entries.find(
      (entry) => entry.ui?.actionId === 'settings.open'
    );

    expect(uiEntry).toMatchObject({
      commandId: 'settings.get',
      ui: { actionId: 'settings.open', category: 'settings' },
    });

    expect(
      validateCommandCenterProviderIntent(
        {
          kind: 'open_ui',
          commandId: 'settings.get',
          args: {},
          confidence: 0.92,
          ui: { actionId: 'settings.open', category: 'settings' },
        },
        { catalog: COMMAND_CENTER_RESOLVER_CATALOG }
      )
    ).toMatchObject({
      kind: 'open_ui',
      ui: { actionId: 'settings.open', category: 'settings' },
    });
  });

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
      availability: { state: 'available' },
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
        scopeKinds: ['session'],
        capabilityHints: ['session:read'],
        surfaces: ['web', 'command-center'],
        availability: { state: 'available' },
        inputSchema: inputSchemaFor(sessionsListDescriptor),
        outputSchema: { type: 'object' },
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
    const schema = inputSchemaFor(sessionsListDescriptor);
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
        {
          kind: 'explain',
          message: 'I can list sessions through the shared gateway manifest.',
          confidence: 0.8,
          citations: ['cli-gateway-command-taxonomy'],
          relatedCommandIds: ['sessions.list'],
          relatedActionIds: ['gateway.sessions.list'],
        },
        { catalog }
      )
    ).toMatchObject({
      kind: 'explain',
      citations: ['cli-gateway-command-taxonomy'],
      relatedCommandIds: ['sessions.list'],
      relatedActionIds: ['gateway.sessions.list'],
    });
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
    ).toMatchObject({ kind: 'ask_followup' });
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
    ).toMatchObject({ kind: 'ask_followup' });
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
    ).toMatchObject({ kind: 'ask_followup' });
  });

  it('rejects explain answers that invent unsupported commands, actions, or citations', () => {
    expect(
      validateCommandCenterProviderIntent(
        {
          kind: 'explain',
          message: 'Relay can launch any provider from Command Center.',
          confidence: 0.88,
          citations: ['made-up-doc'],
        },
        { catalog }
      )
    ).toMatchObject({ kind: 'no_match', reason: 'metadata-mismatch' });
    expect(
      validateCommandCenterProviderIntent(
        {
          kind: 'explain',
          message: 'Relay can launch any provider from Command Center.',
          confidence: 0.88,
          citations: ['cli-gateway-command-taxonomy'],
          relatedCommandIds: ['provider.launch'],
        },
        { catalog }
      )
    ).toMatchObject({ kind: 'no_match', reason: 'metadata-mismatch' });
    expect(
      validateCommandCenterProviderIntent(
        {
          kind: 'explain',
          message: 'Relay can launch any provider from Command Center.',
          confidence: 0.88,
          citations: ['cli-gateway-command-taxonomy'],
          relatedCommandIds: ['sessions.list'],
          relatedActionIds: ['settings.nodes.revoke'],
        },
        { catalog }
      )
    ).toMatchObject({ kind: 'no_match', reason: 'metadata-mismatch' });
  });

  it('rejects explain related commands not covered by cited corpus entries', () => {
    const nodeCatalog = buildCommandCenterResolverCatalog([
      sessionsListDescriptor,
      descriptorFor('nodes.revoke', 'destructive'),
    ]);

    expect(
      validateCommandCenterProviderIntent(
        {
          kind: 'explain',
          message:
            'Scoped read commands can list sessions without exposing private state.',
          confidence: 0.88,
          citations: ['cli-gateway-scoped-read-commands'],
          relatedCommandIds: ['nodes.revoke'],
        },
        { catalog: nodeCatalog }
      )
    ).toMatchObject({ kind: 'no_match', reason: 'metadata-mismatch' });

    expect(
      validateCommandCenterProviderIntent(
        {
          kind: 'explain',
          message:
            'The command manifest can describe all resolver commands, including node revocation.',
          confidence: 0.88,
          citations: ['cli-gateway-command-taxonomy'],
          relatedCommandIds: ['nodes.revoke'],
        },
        { catalog: nodeCatalog }
      )
    ).toMatchObject({ kind: 'explain', relatedCommandIds: ['nodes.revoke'] });
  });
});

describe('Command Center resolver golden corpus', () => {
  it.each(COMMAND_CENTER_RESOLVER_GOLDEN_CASES)(
    'keeps $id tied to catalog contracts',
    (golden) => {
      const resolution = validateCommandCenterProviderIntent(
        golden.providerOutput,
        {
          catalog: unsafeCatalog,
          query: golden.utterance,
        }
      );

      if (golden.expected.kind === 'execute_command') {
        expect(resolution.kind).toBe('execute_command');
        if (resolution.kind !== 'execute_command') return;
        expect(resolution.intent.commandId).toBe(golden.expected.commandId);
      } else if (golden.expected.kind === 'open_ui') {
        expect(resolution.kind).toBe('open_ui');
        if (resolution.kind !== 'open_ui') return;
        expect(resolution.intent.commandId).toBe(golden.expected.commandId);
        expect(resolution.ui.actionId).toBe(golden.expected.actionId);
      } else if (golden.expected.kind === 'ask_followup') {
        expect(resolution.kind).toBe('ask_followup');
        if (resolution.kind !== 'ask_followup') return;
        expect(resolution.question.toLowerCase()).toContain(
          golden.expected.questionIncludes
        );
        if (golden.expected.commandId) {
          expect(resolution.commandId).toBe(golden.expected.commandId);
        }
      } else if (golden.expected.kind === 'explain') {
        expect(resolution.kind).toBe('explain');
        if (resolution.kind !== 'explain') return;
        expect(resolution.citations).toEqual(golden.expected.citations);
        expect(resolution.relatedCommandIds).toEqual(
          golden.expected.relatedCommandIds
        );
      } else {
        expect(resolution).toMatchObject({
          kind: 'no_match',
          reason: golden.expected.reason,
        });
      }
    }
  );
});

describe('Command Center resolver descriptor drift guards', () => {
  it('requires resolver-capable commands to carry descriptor metadata and explain coverage', () => {
    for (const entry of COMMAND_CENTER_RESOLVER_CATALOG.entries) {
      expect(entry.label, entry.commandId).toBeTruthy();
      expect(entry.summary, entry.commandId).toBeTruthy();
      expect(['read', 'write', 'destructive', 'stream']).toContain(
        entry.sideEffect
      );
      expect(typeof entry.requiresConfirmation, entry.commandId).toBe(
        'boolean'
      );
      expect(Array.isArray(entry.controlRequirements), entry.commandId).toBe(
        true
      );
      expect(entry.scopeKinds.length, entry.commandId).toBeGreaterThan(0);
      expect(entry.surfaces, entry.commandId).toEqual(
        expect.arrayContaining(['web', 'command-center'])
      );
      expect(entry.inputSchema, entry.commandId).toMatchObject({
        type: 'object',
      });
      expect(['available', 'unavailable', 'unknown']).toContain(
        entry.availability.state
      );
      if (entry.availability.state !== 'available') {
        expect(entry.availability.reason, entry.commandId).toBeTruthy();
      }
      expect(
        commandCenterExplainCoverageForCommand(entry.commandId).length
      ).toBeGreaterThan(0);
    }
  });
});
