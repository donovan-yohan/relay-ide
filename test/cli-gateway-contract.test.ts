import { describe, expect, it } from 'vitest';
import {
  RELAY_CLI_GATEWAY_CONTRACT,
  RELAY_CLI_GATEWAY_CONTRACT_VERSION,
  RELAY_CLI_GATEWAY_MAJOR,
  commandSpec,
  gatewayError,
  gatewayOk,
  stableCommandNames,
  type RelayJsonSchema,
} from '../shared/cli-gateway-contract.js';
import {
  RELAY_COMMAND_MANIFEST,
  relayCommandDefinition,
  relayCommandDefinitionsForSurface,
} from '../shared/relay-command-manifest.js';
import {
  HIGH_RISK_CAPABILITIES,
  LEGACY_DEFAULT_ALLOWED_CAPABILITIES,
  RELAY_CAPABILITY_BITS,
  createLegacyDefaultNodeAcl,
  resolveAclCapability,
} from '../shared/security-policy.js';
import {
  gatewayCliInvalidArgumentError,
  gatewayCliInvalidJsonError,
  gatewayErrorRetryable,
  normalizeGatewayErrorCode,
  sanitizedGatewayErrorDetails,
  validateAndSanitizeGatewayCreateInput,
  validateAndSanitizeLocalGatewayCreateInput,
} from '../shared/cli-gateway-runtime.js';

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function objectMatchesSchemaKeywords(
  schema: RelayJsonSchema,
  value: Record<string, unknown>
): boolean {
  const properties = schema.properties ?? {};
  const required = schema.required ?? [];
  if (schema.type === 'object' && (value === null || Array.isArray(value)))
    return false;
  if (!required.every((key) => hasOwn(value, key))) return false;
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!hasOwn(properties, key)) return false;
    }
  }
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (!hasOwn(value, key)) continue;
    if ('const' in propertySchema && value[key] !== propertySchema.const)
      return false;
    if (propertySchema.type === 'string' && typeof value[key] !== 'string')
      return false;
    if (propertySchema.type === 'boolean' && typeof value[key] !== 'boolean')
      return false;
    if (propertySchema.type === 'number' && typeof value[key] !== 'number')
      return false;
  }
  return true;
}

function schemaAcceptsSessionInput(value: Record<string, unknown>): boolean {
  const schema = commandSpec('sessions.input').inputSchema;
  if (!objectMatchesSchemaKeywords(schema, value)) return false;
  if (!schema.oneOf) return true;
  return (
    schema.oneOf.filter((branch) => objectMatchesSchemaKeywords(branch, value))
      .length === 1
  );
}

describe('CLI gateway contract', () => {
  it('exposes a stable versioned command manifest for node/session adapters', () => {
    expect(RELAY_CLI_GATEWAY_CONTRACT).toMatchObject({
      schemaVersion: 1,
      contract: 'v1',
      contractVersion: '1.0',
      generatedFrom: 'shared/cli-gateway-contract.ts',
    });

    expect(stableCommandNames()).toEqual([
      'contract.list',
      'contract.schema',
      'nodes.manifest',
      'nodes.list',
      'sessions.list',
      'sessions.get',
      'sessions.create',
      'sessions.renew',
      'sessions.attach',
      'sessions.detach',
      'sessions.stream',
      'sessions.input',
      'sessions.interventions',
      'sessions.handBack',
      'files.list',
      'files.stat',
      'files.read',
      'files.write',
      'work-contexts.get',
      'context.create',
      'context.get',
      'context.list',
      'context.pin',
      'context.unpin',
      'inbox.send',
      'inbox.list',
      'inbox.get',
      'inbox.ack',
      'inbox.resolve',
      'inbox.ignore',
      'handoffs.plan',
      'handoffs.create',
      'handoffs.status',
      'handoffs.cancel',
      'handoffs.resume',
      'handoffs.launch',
      'artifacts.read',
      'supervisor.snapshot',
      'supervisor.sessions',
      'supervisor.sendText',
      'supervisor.submit',
      'events.subscribe',
      'settings.get',
      'settings.update',
      'webhooks.status',
      'webhooks.ping',
    ]);

    for (const spec of RELAY_CLI_GATEWAY_CONTRACT.commandSchemas) {
      expect(spec.stable).toBe(true);
      expect(spec.cli).toContain('--json');
      expect(spec.inputSchema).toBeDefined();
      expect(spec.outputSchema).toBeDefined();
      expect(spec.errorCodes.length).toBeGreaterThan(0);
    }
  });

  it('projects every stable gateway command into shared Relay command metadata', () => {
    const stableNames = stableCommandNames();
    expect(RELAY_COMMAND_MANIFEST).toMatchObject({
      schemaVersion: 1,
      generatedFrom: 'shared/cli-gateway-contract.ts',
    });
    expect(
      RELAY_COMMAND_MANIFEST.commands.map((command) => command.name)
    ).toEqual(stableNames);
    expect(
      relayCommandDefinitionsForSurface('cli').map((command) => command.name)
    ).toEqual(stableNames);
    expect(
      relayCommandDefinitionsForSurface('agent').map((command) => command.name)
    ).toEqual(stableNames);
    expect(
      relayCommandDefinitionsForSurface('web').map((command) => command.name)
    ).toEqual(stableNames);

    for (const name of stableNames) {
      const spec = commandSpec(name);
      const command = relayCommandDefinition(name);
      expect(command).toMatchObject({
        id: name,
        name,
        stable: true,
        source: 'cli-gateway-v1',
        surfaces: ['cli', 'agent', 'web'],
      });
      expect(command.label.length).toBeGreaterThan(0);
      expect(command.description).toBe(spec.summary);
      expect(command.summary).toBe(spec.summary);
      expect(command.inputSchema).toBe(spec.inputSchema);
      expect(command.outputSchema).toBe(spec.outputSchema);
      expect(command.capabilityHints).toEqual(spec.capabilityHints);
      for (const hint of command.capabilityHints) {
        expect(RELAY_CAPABILITY_BITS).toContain(hint);
      }
      expect(command.handler.cli).toEqual(spec.cli);
      expect(['read', 'write', 'destructive', 'stream']).toContain(
        command.sideEffect
      );
      expect(Array.isArray(command.scopeKinds)).toBe(true);
      expect(Array.isArray(command.controlRequirements)).toBe(true);
      expect([
        'schema-only',
        'bounded-redacted',
        'hashes-only',
        'action-summary',
        'stream-redacted',
      ]).toContain(command.auditRedaction.expectation);
      expect(command.auditRedaction).toMatchObject({
        storesRawPrompt: false,
        storesRawTranscript: false,
        storesRawPtyInput: false,
        storesRawProviderState: false,
      });
    }

    expect(relayCommandDefinition('files.write')).toMatchObject({
      sideEffect: 'write',
      requiresConfirmation: true,
      controlRequirements: ['confirmation-challenge'],
      auditRedaction: { expectation: 'action-summary' },
      scopeKinds: ['session'],
    });
    expect(relayCommandDefinition('sessions.stream')).toMatchObject({
      sideEffect: 'stream',
      requiresConfirmation: false,
      auditRedaction: { expectation: 'stream-redacted' },
    });
    expect(relayCommandDefinition('handoffs.create')).toMatchObject({
      sideEffect: 'destructive',
      requiresConfirmation: true,
      controlRequirements: ['confirmation-challenge'],
    });
    expect(relayCommandDefinition('supervisor.snapshot')).toMatchObject({
      sideEffect: 'read',
      requiresConfirmation: false,
      controlRequirements: ['fresh-control-state', 'latest-intervention-ack'],
      auditRedaction: { expectation: 'hashes-only' },
      scopeKinds: ['session'],
    });
    expect(relayCommandDefinition('supervisor.sessions')).toMatchObject({
      sideEffect: 'read',
      requiresConfirmation: false,
      auditRedaction: { expectation: 'bounded-redacted' },
      scopeKinds: ['session'],
    });
    expect(relayCommandDefinition('supervisor.sendText')).toMatchObject({
      sideEffect: 'write',
      requiresConfirmation: false,
      controlRequirements: ['fresh-control-state'],
      auditRedaction: { expectation: 'hashes-only' },
      scopeKinds: ['session'],
    });
    expect(relayCommandDefinition('supervisor.submit')).toMatchObject({
      sideEffect: 'write',
      requiresConfirmation: false,
      controlRequirements: ['fresh-control-state'],
      auditRedaction: { expectation: 'hashes-only' },
      scopeKinds: ['session'],
    });
    expect(relayCommandDefinition('settings.update')).toMatchObject({
      sideEffect: 'write',
      requiresConfirmation: true,
      controlRequirements: ['confirmation-challenge'],
      auditRedaction: { expectation: 'action-summary' },
      scopeKinds: ['node'],
    });
    expect(relayCommandDefinition('settings.get')).toMatchObject({
      sideEffect: 'read',
      requiresConfirmation: false,
      auditRedaction: { expectation: 'bounded-redacted' },
      scopeKinds: ['node'],
    });
    expect(relayCommandDefinition('webhooks.status')).toMatchObject({
      sideEffect: 'read',
      requiresConfirmation: false,
      auditRedaction: { expectation: 'bounded-redacted' },
      scopeKinds: ['node'],
    });
    expect(relayCommandDefinition('webhooks.ping')).toMatchObject({
      sideEffect: 'write',
      requiresConfirmation: false,
      auditRedaction: { expectation: 'action-summary' },
      scopeKinds: ['node'],
    });
  });

  it('describes browser-operator-only safe settings and webhook contracts with redaction metadata', () => {
    const settingsGet = commandSpec('settings.get');
    expect(settingsGet.capabilityHints).toEqual([]);
    expect(settingsGet.outputSchema.properties?.data?.properties?.redaction).toMatchObject({
      properties: {
        rawConfigReturned: { const: false },
        secretsReturned: { const: false },
        tokenMaterialReturned: { const: false },
      },
    });

    const settingsUpdate = commandSpec('settings.update');
    expect(settingsUpdate.capabilityHints).toEqual([]);
    expect(settingsUpdate.errorCodes).toContain('CONFIRMATION_REQUIRED');
    expect(settingsUpdate.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['key', 'value'],
    });
    expect(settingsUpdate.inputSchema.properties?.['key']?.enum).toEqual([
      'defaultAgent',
      'defaultContinue',
      'defaultYolo',
      'defaultNotifications',
      'claudeFullscreen',
      'renamerTool',
      'updateChannel',
    ]);
    expect(settingsUpdate.inputSchema.properties?.['confirmRiskyWrite']).toEqual({
      type: 'boolean',
    });

    const webhookStatus = commandSpec('webhooks.status');
    expect(webhookStatus.capabilityHints).toEqual([]);
    const webhookStatusJson = JSON.stringify(webhookStatus.outputSchema);
    expect(webhookStatusJson).toContain('webhookSecretsReturned');
    expect(webhookStatusJson).not.toContain('"webhookSecret"');
    expect(webhookStatusJson).not.toContain('"smeeUrl"');

    const webhookPing = commandSpec('webhooks.ping');
    expect(webhookPing.capabilityHints).toEqual([]);
    expect(webhookPing.outputSchema.properties?.data?.properties?.redaction).toMatchObject({
      properties: {
        webhookSecretsReturned: { const: false },
        rawWebhookUrlsReturned: { const: false },
      },
    });
  });

  it('keeps success and error envelopes machine-readable and versioned', () => {
    expect(gatewayOk('nodes.list', { nodes: [] })).toEqual({
      ok: true,
      contract: RELAY_CLI_GATEWAY_MAJOR,
      contractVersion: RELAY_CLI_GATEWAY_CONTRACT_VERSION,
      command: 'nodes.list',
      data: { nodes: [] },
    });

    expect(
      gatewayError('sessions.create', {
        code: 'UNSUPPORTED',
        message: 'local create cannot safely honor cwd',
        retryable: false,
        details: { field: 'cwd' },
      })
    ).toEqual({
      ok: false,
      contract: RELAY_CLI_GATEWAY_MAJOR,
      contractVersion: RELAY_CLI_GATEWAY_CONTRACT_VERSION,
      command: 'sessions.create',
      error: {
        code: 'UNSUPPORTED',
        message: 'local create cannot safely honor cwd',
        retryable: false,
        details: { field: 'cwd' },
      },
    });
  });

  it('keeps supervisor.snapshot success data aligned with the public contract schema', () => {
    const payload = {
      snapshot: {
        command: 'supervisor.snapshot',
        redaction: {
          rawPtyInputAvailable: false,
          rawTranscriptAvailable: false,
          rawPromptAvailable: false,
          rawProviderStateAvailable: false,
          auditStoresHashesOnly: true,
        },
      },
      audit: {
        command: 'supervisor.snapshot',
        redaction: {
          rawPromptStored: false,
          rawTranscriptStored: false,
          rawPtyInputStored: false,
          rawProviderStateStored: false,
        },
      },
    };
    const envelope = gatewayOk('supervisor.snapshot', payload);

    expect(envelope).toMatchObject({
      ok: true,
      command: 'supervisor.snapshot',
    });
    expect(envelope.data).toEqual(payload);
    expect(Object.keys(envelope.data).sort()).toEqual(['audit', 'snapshot']);
    expect(hasOwn(envelope.data, 'ok')).toBe(false);

    const outputSchema = commandSpec('supervisor.snapshot').outputSchema;
    expect(
      objectMatchesSchemaKeywords(
        outputSchema,
        envelope as unknown as Record<string, unknown>
      )
    ).toBe(true);

    const dataSchema = outputSchema.properties?.data;
    if (!dataSchema)
      throw new Error('supervisor.snapshot output schema must define data');
    expect(objectMatchesSchemaKeywords(dataSchema, envelope.data)).toBe(true);
    expect(
      objectMatchesSchemaKeywords(dataSchema, { ok: true, ...payload })
    ).toBe(false);

    const snapshotSchema = dataSchema.properties?.snapshot;
    const auditSchema = dataSchema.properties?.audit;
    if (!snapshotSchema?.properties?.redaction)
      throw new Error('snapshot redaction schema required');
    if (!auditSchema?.properties?.redaction)
      throw new Error('audit redaction schema required');
    expect(snapshotSchema.required).toEqual(['command', 'redaction']);
    expect(snapshotSchema.properties.redaction.required).toEqual([
      'rawPtyInputAvailable',
      'rawTranscriptAvailable',
      'rawPromptAvailable',
      'rawProviderStateAvailable',
      'auditStoresHashesOnly',
    ]);
    expect(auditSchema.required).toEqual(['command', 'redaction']);
    expect(auditSchema.properties.redaction.required).toEqual([
      'rawPromptStored',
      'rawTranscriptStored',
      'rawPtyInputStored',
      'rawProviderStateStored',
    ]);
  });

  it('fails closed in the create schema and does not advertise unimplemented agent peer round-trips', () => {
    const create = commandSpec('sessions.create');
    expect(create.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });
    expect(create.errorCodes).toContain('UNSUPPORTED');
    expect(create.capabilityHints).toEqual([
      'session:create:terminal',
      'session:create:agent',
      'tab:mode:set-agent',
    ]);

    const createProperties = create.inputSchema.properties ?? {};
    expect(createProperties['sessionEnvelope']).toBeDefined();
    expect(createProperties['workContextId']).toBeDefined();
    expect(JSON.stringify(create.inputSchema)).not.toContain(
      '"kind":{"const":"agent"}'
    );
    expect(JSON.stringify(create.inputSchema)).not.toContain('"adapter"');
  });

  it('validates and sanitizes sessions.create input before forwarding', () => {
    const hidden = validateAndSanitizeGatewayCreateInput({
      repoPath: '/tmp/repo',
      type: 'agent',
      claudeArgs: ['--dangerously-skip-permissions'],
    });
    expect(hidden).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENT', details: { field: 'claudeArgs' } },
    });

    const localLifecycle = validateAndSanitizeGatewayCreateInput({
      repoPath: '/tmp/repo',
      ttlSeconds: 60,
    });
    expect(localLifecycle).toMatchObject({
      ok: false,
      error: { code: 'UNSUPPORTED', details: { field: 'ttlSeconds' } },
    });
    expect(localLifecycle.ok).toBe(false);
    if (localLifecycle.ok === false) {
      expect(localLifecycle.error.details?.['supportedLocalFields']).toEqual(
        expect.arrayContaining([
          'repoPath',
          'worktreePath',
          'type',
          'mode',
          'agent',
          'terminalBackend',
          'cols',
          'rows',
          'workContextId',
        ])
      );
      expect(
        localLifecycle.error.details?.['supportedLocalFields']
      ).not.toContain('ttlSeconds');
      expect(
        localLifecycle.error.details?.['supportedLocalFields']
      ).not.toContain('cwd');
    }

    const localEnvelope = validateAndSanitizeGatewayCreateInput({
      repoPath: '/tmp/repo',
      sessionEnvelope: {
        peerIdentity: { kind: 'relay-node', nodeId: 'node-a' },
      },
    });
    expect(localEnvelope).toMatchObject({
      ok: false,
      error: { code: 'UNSUPPORTED', details: { field: 'sessionEnvelope' } },
    });

    const legacyTmuxFlag = validateAndSanitizeGatewayCreateInput({
      nodeId: 'node-a',
      repoPath: '/tmp/repo',
      useTmux: false,
    });
    expect(legacyTmuxFlag).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENT', details: { field: 'useTmux' } },
    });

    const agentPeer = validateAndSanitizeGatewayCreateInput({
      nodeId: 'node-a',
      repoPath: '/tmp/repo',
      sessionEnvelope: {
        peerIdentity: { kind: 'agent', id: 'brain', adapter: 'kbrain' },
      },
    });
    expect(agentPeer).toMatchObject({
      ok: false,
      error: {
        code: 'UNSUPPORTED',
        details: { field: 'sessionEnvelope.peerIdentity.kind' },
      },
    });

    const routedDefault = validateAndSanitizeGatewayCreateInput({
      nodeId: 'node-a',
      repoPath: '/tmp/repo',
    });
    if (routedDefault.ok !== true)
      throw new Error('expected routed create input to validate');
    expect(routedDefault.sessionType).toBe('agent');
    expect(routedDefault.input).toMatchObject({
      nodeId: 'node-a',
      repoPath: '/tmp/repo',
      type: 'agent',
    });
  });

  it('applies the v1 create contract to direct local /sessions gateway bodies', () => {
    const hidden = validateAndSanitizeLocalGatewayCreateInput({
      repoPath: '/tmp/repo',
      claudeArgs: ['--dangerously-skip-permissions'],
    });
    expect(hidden).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENT', details: { field: 'claudeArgs' } },
    });

    const routedOnly = validateAndSanitizeLocalGatewayCreateInput({
      nodeId: 'node-a',
      repoPath: '/tmp/repo',
    });
    expect(routedOnly).toMatchObject({
      ok: false,
      error: { code: 'UNSUPPORTED', details: { field: 'nodeId' } },
    });

    const clean = validateAndSanitizeLocalGatewayCreateInput({
      repoPath: '/tmp/repo',
      worktreePath: null,
      type: 'terminal',
      terminalBackend: 'relay-pty',
      cols: 120,
      rows: 32,
      workContextId: 'wc:handoff',
    });
    expect(clean).toMatchObject({
      ok: true,
      input: {
        repoPath: '/tmp/repo',
        worktreePath: null,
        type: 'terminal',
        terminalBackend: 'relay-pty',
        cols: 120,
        rows: 32,
        workContextId: 'wc:handoff',
      },
      sessionType: 'terminal',
    });
  });

  it('advertises CLI argument and JSON parse errors emitted by gateway commands', () => {
    const invalidArgumentCommands = [
      'contract.list',
      'nodes.list',
      'sessions.list',
      'sessions.get',
      'sessions.create',
      'sessions.renew',
      'sessions.attach',
      'sessions.detach',
      'sessions.stream',
      'sessions.input',
      'sessions.interventions',
      'sessions.handBack',
      'files.list',
      'files.stat',
      'files.read',
      'files.write',
      'work-contexts.get',
      'context.create',
      'context.get',
      'context.list',
      'context.pin',
      'context.unpin',
      'inbox.send',
      'inbox.list',
      'inbox.get',
      'inbox.ack',
      'inbox.resolve',
      'inbox.ignore',
      'handoffs.plan',
      'handoffs.create',
      'handoffs.status',
      'handoffs.cancel',
      'handoffs.resume',
      'handoffs.launch',
      'artifacts.read',
      'supervisor.snapshot',
      'supervisor.sessions',
      'supervisor.sendText',
      'supervisor.submit',
      'events.subscribe',
    ] as const;

    for (const command of invalidArgumentCommands) {
      const emitted = gatewayError(
        command,
        gatewayCliInvalidArgumentError(
          command,
          'invalid gateway command arguments'
        )
      );
      expect(emitted.error.code).toBe('INVALID_ARGUMENT');
      expect(commandSpec(command).errorCodes).toContain(emitted.error.code);
    }

    const invalidJson = gatewayError(
      'sessions.create',
      gatewayCliInvalidJsonError(
        'sessions.create',
        'Unexpected end of JSON input'
      )
    );
    expect(invalidJson.error.code).toBe('INVALID_JSON');
    expect(commandSpec('sessions.create').errorCodes).toContain(
      invalidJson.error.code
    );
  });

  it('normalizes routed errors without exposing raw upstream bodies', () => {
    expect(
      normalizeGatewayErrorCode(409, {
        error: { code: 'CONFIRMATION_REQUIRED', retryable: true },
      })
    ).toBe('CONFIRMATION_REQUIRED');
    expect(
      normalizeGatewayErrorCode(404, {
        error: {
          code: 'NODE_OFFLINE',
          retryable: true,
          details: { path: '/internal' },
        },
      })
    ).toBe('NODE_OFFLINE');
    expect(
      normalizeGatewayErrorCode(409, {
        error: {
          code: 'SOURCE_STALE_OR_OFFLINE',
          retryable: true,
          reasonCode: 'FAILED_STALE_SOURCE',
        },
      })
    ).toBe('NODE_OFFLINE');
    expect(
      normalizeGatewayErrorCode(409, {
        error: { code: 'STALE_PLAN', retryable: true },
      })
    ).toBe('SESSION_CONFLICT');
    expect(
      normalizeGatewayErrorCode(403, {
        error: { code: 'MISSING_CONFIRMED_GRANT', retryable: false },
      })
    ).toBe('FORBIDDEN');
    expect(
      gatewayErrorRetryable(404, {
        error: { code: 'NODE_OFFLINE', retryable: true },
      })
    ).toBe(true);
    expect(
      sanitizedGatewayErrorDetails(500, {
        error: {
          code: 'INTERNAL',
          message: 'boom',
          details: { path: '/secret/internal', field: 'repoPath' },
          stack: 'nope',
        },
      })
    ).toEqual({ status: 500, upstreamCode: 'INTERNAL', field: 'repoPath' });
  });

  it('advertises descriptor-only attach/detach, session renewal, session I/O, and read-only file RPC commands', () => {
    const renew = commandSpec('sessions.renew');
    expect(renew).toMatchObject({
      capabilityHints: ['session:attach'],
      transport: 'hub-http',
    });
    expect(renew.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ['id'],
      properties: {
        ttlSeconds: { minimum: 1 },
        expiresAt: { format: 'date-time' },
      },
    });
    expect(renew.errorCodes).toEqual(
      expect.arrayContaining([
        'SESSION_EXPIRED',
        'SESSION_REVOKED',
        'SESSION_MISMATCH',
        'SESSION_NON_RENEWABLE',
      ])
    );

    expect(commandSpec('sessions.attach')).toMatchObject({
      capabilityHints: ['session:read', 'session:attach'],
      transport: 'hub-http',
    });
    expect(commandSpec('sessions.detach')).toMatchObject({
      capabilityHints: ['session:read', 'session:attach'],
      transport: 'hub-http',
    });

    const stream = commandSpec('sessions.stream');
    expect(stream.capabilityHints).toEqual(['session:read', 'session:attach']);
    expect(stream.outputSchema).toMatchObject({
      properties: {
        data: { properties: { event: { enum: ['data', 'closed'] } } },
      },
    });

    const input = commandSpec('sessions.input');
    expect(input.capabilityHints).toEqual(['session:read', 'session:attach']);
    expect(input.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ['id'],
      properties: { maxBytes: { maximum: 1048576 } },
      oneOf: [
        { required: ['id', 'data'], properties: { data: { type: 'string' } } },
        {
          required: ['id', 'dataBase64'],
          properties: { dataBase64: { type: 'string' } },
        },
        { required: ['id', 'stdin'], properties: { stdin: { const: true } } },
      ],
    });

    const list = commandSpec('files.list');
    expect(list.capabilityHints).toEqual(['session:read', 'rpc:fs:list']);
    expect(list.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ['sessionId'],
      properties: { maxEntries: { maximum: 500 } },
    });
    expect(list.outputSchema).toMatchObject({
      properties: {
        data: {
          properties: {
            operation: { const: 'list' },
            entries: { type: 'array' },
          },
        },
      },
    });

    const read = commandSpec('files.read');
    expect(read.capabilityHints).toEqual(['session:read', 'rpc:fs:read']);
    expect(read.inputSchema).toMatchObject({
      properties: {
        maxBytes: { maximum: 65536 },
        maxLines: { maximum: 2000 },
      },
    });
    expect(read.errorCodes).toEqual(
      expect.arrayContaining(['NODE_OFFLINE', 'NOT_FOUND'])
    );
    expect(commandSpec('files.stat').capabilityHints).toEqual([
      'session:read',
      'rpc:fs:read',
    ]);

    const write = commandSpec('files.write');
    expect(write.capabilityHints).toEqual(['session:read', 'rpc:fs:write']);
    expect(write.inputSchema).toMatchObject({
      additionalProperties: false,
      required: expect.arrayContaining(['sessionId', 'mode', 'contentBase64']),
      properties: {
        mode: { enum: ['create', 'overwrite', 'append'] },
        contentBase64: { type: 'string' },
        permissions: { maximum: 511 },
      },
    });
    expect(write.outputSchema).toMatchObject({
      properties: {
        data: {
          properties: {
            operation: { const: 'write' },
            bytesWritten: { type: 'number' },
            created: { type: 'boolean' },
            newHash: { type: 'string' },
          },
        },
      },
    });
    expect(write.errorCodes).toEqual(
      expect.arrayContaining([
        'NODE_OFFLINE',
        'FORBIDDEN',
        'CONFIRMATION_REQUIRED',
      ])
    );
  });

  it('advertises handoff/work-context/artifact gateway commands with cold-handoff safety gates', () => {
    expect(commandSpec('work-contexts.get')).toMatchObject({
      capabilityHints: ['session:read'],
      transport: 'hub-http',
    });

    const plan = commandSpec('handoffs.plan');
    expect(plan).toMatchObject({
      capabilityHints: ['session:read', 'rpc:fs:read'],
      transport: 'hub-http',
    });
    expect(plan.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ['request'],
    });
    expect(plan.outputSchema).toMatchObject({
      properties: {
        data: { properties: { readOnly: { const: true } } },
      },
    });

    const create = commandSpec('handoffs.create');
    expect(create.capabilityHints).toEqual([
      'rpc:fs:read',
      'rpc:fs:write',
      'session:create:agent',
      'session:create:terminal',
      'pty:exec:arbitrary',
    ]);
    expect(create.inputSchema).toMatchObject({
      required: ['confirmedGrants', 'sourceRepoPath', 'destinationRepoPath'],
      anyOf: [{ required: ['planId'] }, { required: ['plan'] }],
    });
    expect(create.summary).toContain('refuses fake success');
    expect(create.errorCodes).toEqual(
      expect.arrayContaining([
        'FORBIDDEN',
        'SESSION_CONFLICT',
        'SERVER_UNAVAILABLE',
      ])
    );

    expect(commandSpec('handoffs.status').summary).toContain(
      'bounded/redacted'
    );
    expect(commandSpec('handoffs.resume').summary).toContain(
      'without raw transcript'
    );
    expect(commandSpec('artifacts.read').summary).toContain(
      'raw logs/secrets/transcripts are unavailable'
    );

    const supervisor = commandSpec('supervisor.snapshot');
    expect(supervisor).toMatchObject({
      capabilityHints: ['session:read', 'tab:intervention:read'],
      transport: 'hub-http',
    });
    expect(supervisor.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ['id'],
      properties: {
        expectedControlMode: {
          enum: ['agent-driven', 'human-driven', 'co-driven'],
        },
      },
    });
    expect(supervisor.errorCodes).toEqual(
      expect.arrayContaining([
        'FORBIDDEN',
        'CONTROL_STATE_STALE',
        'INTERVENTION_ACK_REQUIRED',
      ])
    );
    expect(supervisor.summary).toContain('never sends raw PTY input');
  });

  it('advertises context.* / inbox.* verbs with ADR-019 capability + PULL semantics', () => {
    // Reads are session:read peers; writes use the dedicated context/inbox bits.
    expect(commandSpec('context.get').capabilityHints).toEqual([
      'context:read',
    ]);
    expect(commandSpec('context.list').capabilityHints).toEqual([
      'context:read',
    ]);
    expect(commandSpec('context.create').capabilityHints).toEqual([
      'context:write',
    ]);
    expect(commandSpec('context.pin').capabilityHints).toEqual([
      'context:write',
    ]);
    expect(commandSpec('context.unpin').capabilityHints).toEqual([
      'context:write',
    ]);
    expect(commandSpec('inbox.list').capabilityHints).toEqual(['inbox:read']);
    expect(commandSpec('inbox.get').capabilityHints).toEqual(['inbox:read']);
    expect(commandSpec('inbox.send').capabilityHints).toEqual(['inbox:write']);
    for (const verb of [
      'inbox.ack',
      'inbox.resolve',
      'inbox.ignore',
    ] as const) {
      expect(commandSpec(verb).capabilityHints).toEqual(['inbox:write']);
    }

    // PULL delivery is documented on the read verbs; nothing pushes into sessions.input.
    expect(commandSpec('inbox.list').summary).toContain('PULL delivery');
    expect(commandSpec('inbox.get').summary).toContain('PULL delivery');
    expect(commandSpec('inbox.send').summary).toContain(
      'Never pushes into sessions.input'
    );
    expect(commandSpec('context.pin').summary).toContain(
      'WorkContext artifact ref'
    );
    expect(commandSpec('context.unpin').summary).toContain(
      'without deleting the packet'
    );
    expect(commandSpec('context.list').inputSchema).toMatchObject({
      properties: { workContextId: { type: 'string' } },
    });
    for (const verb of ['context.pin', 'context.unpin'] as const) {
      expect(commandSpec(verb).inputSchema).toMatchObject({
        required: ['id', 'workContextId'],
      });
    }

    // anchored addressing: send/list require a target.
    expect(commandSpec('inbox.send').inputSchema).toMatchObject({
      anyOf: [
        { required: ['targetSessionId'] },
        { required: ['targetWorkContextId'] },
      ],
    });

    // Manifest side-effects: writes are 'write' (not destructive); reads are 'read'.
    expect(relayCommandDefinition('context.create').sideEffect).toBe('write');
    expect(relayCommandDefinition('context.pin').sideEffect).toBe('write');
    expect(relayCommandDefinition('context.unpin').sideEffect).toBe('write');
    expect(relayCommandDefinition('inbox.ack').sideEffect).toBe('write');
    expect(relayCommandDefinition('context.get').sideEffect).toBe('read');
    expect(relayCommandDefinition('inbox.list').sideEffect).toBe('read');

    // CRITICAL (fugu gate): write verbs must NOT require a confirmation
    // challenge — that would gate a headless agent ack loop. They carry
    // context/inbox bits, not rpc:fs:write / pty:exec:arbitrary.
    for (const verb of [
      'context.create',
      'context.pin',
      'context.unpin',
      'inbox.send',
      'inbox.ack',
      'inbox.resolve',
      'inbox.ignore',
    ] as const) {
      expect(relayCommandDefinition(verb).requiresConfirmation).toBe(false);
      expect(relayCommandDefinition(verb).controlRequirements).toEqual([]);
    }
  });

  it('places context/inbox capability bits in the correct trust tier (ADR-019 D5)', () => {
    for (const bit of [
      'context:read',
      'context:write',
      'inbox:read',
      'inbox:write',
    ] as const) {
      expect(RELAY_CAPABILITY_BITS).toContain(bit);
    }
    // Reads are default-allow peers of session:read.
    expect(LEGACY_DEFAULT_ALLOWED_CAPABILITIES).toContain('context:read');
    expect(LEGACY_DEFAULT_ALLOWED_CAPABILITIES).toContain('inbox:read');
    // Writes are dev-allow (granted by default) but NOT high-risk — so the
    // prod trust overlay never promotes them to a confirmation prompt.
    expect(LEGACY_DEFAULT_ALLOWED_CAPABILITIES).toContain('context:write');
    expect(LEGACY_DEFAULT_ALLOWED_CAPABILITIES).toContain('inbox:write');
    expect(HIGH_RISK_CAPABILITIES).not.toContain('context:write');
    expect(HIGH_RISK_CAPABILITIES).not.toContain('inbox:write');

    // On the prod tier the overlay keeps writes silent-allow (not confirmation).
    const prodAcl = createLegacyDefaultNodeAcl({
      nodeId: 'node_prod_ctx',
      createdAt: '2026-05-27T00:00:00.000Z',
      trustTier: 'prod',
    });
    for (const bit of [
      'context:read',
      'context:write',
      'inbox:read',
      'inbox:write',
    ] as const) {
      expect(resolveAclCapability(prodAcl, bit)).toMatchObject({
        known: true,
        decision: 'allow',
      });
    }
  });

  it('encodes sessions.input source exclusivity for schema-generated adapters', () => {
    expect(
      schemaAcceptsSessionInput({ id: 's1', data: 'hello', waitFor: 'hello' })
    ).toBe(true);
    expect(
      schemaAcceptsSessionInput({ id: 's1', dataBase64: 'aGVsbG8=' })
    ).toBe(true);
    expect(
      schemaAcceptsSessionInput({ id: 's1', stdin: true, timeoutMs: 1000 })
    ).toBe(true);

    expect(schemaAcceptsSessionInput({ id: 's1' })).toBe(false);
    expect(
      schemaAcceptsSessionInput({
        id: 's1',
        data: 'hello',
        dataBase64: 'aGVsbG8=',
      })
    ).toBe(false);
    expect(
      schemaAcceptsSessionInput({ id: 's1', data: 'hello', stdin: true })
    ).toBe(false);
    expect(
      schemaAcceptsSessionInput({
        id: 's1',
        dataBase64: 'aGVsbG8=',
        stdin: true,
      })
    ).toBe(false);
    expect(schemaAcceptsSessionInput({ id: 's1', stdin: false })).toBe(false);
  });

  it('does not expose raw intervention payloads as a gateway contract', () => {
    const interventions = commandSpec('sessions.interventions');
    expect(interventions.outputSchema).toMatchObject({
      properties: {
        data: {
          properties: {
            rawPayloadAvailable: { const: false },
            transcriptExportAvailable: { const: false },
          },
        },
      },
    });
  });
});
