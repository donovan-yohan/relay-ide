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

function objectMatchesSchemaKeywords(schema: RelayJsonSchema, value: Record<string, unknown>): boolean {
  const properties = schema.properties ?? {};
  const required = schema.required ?? [];
  if (schema.type === 'object' && (value === null || Array.isArray(value))) return false;
  if (!required.every((key) => hasOwn(value, key))) return false;
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!hasOwn(properties, key)) return false;
    }
  }
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (!hasOwn(value, key)) continue;
    if ('const' in propertySchema && value[key] !== propertySchema.const) return false;
    if (propertySchema.type === 'string' && typeof value[key] !== 'string') return false;
    if (propertySchema.type === 'boolean' && typeof value[key] !== 'boolean') return false;
    if (propertySchema.type === 'number' && typeof value[key] !== 'number') return false;
  }
  return true;
}

function schemaAcceptsSessionInput(value: Record<string, unknown>): boolean {
  const schema = commandSpec('sessions.input').inputSchema;
  if (!objectMatchesSchemaKeywords(schema, value)) return false;
  if (!schema.oneOf) return true;
  return schema.oneOf.filter((branch) => objectMatchesSchemaKeywords(branch, value)).length === 1;
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
      'handoffs.plan',
      'handoffs.create',
      'handoffs.status',
      'handoffs.cancel',
      'handoffs.resume',
      'handoffs.launch',
      'artifacts.read',
      'events.subscribe',
    ]);

    for (const spec of RELAY_CLI_GATEWAY_CONTRACT.commandSchemas) {
      expect(spec.stable).toBe(true);
      expect(spec.cli).toContain('--json');
      expect(spec.inputSchema).toBeDefined();
      expect(spec.outputSchema).toBeDefined();
      expect(spec.errorCodes.length).toBeGreaterThan(0);
    }
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
    expect(JSON.stringify(create.inputSchema)).not.toContain('"kind":{"const":"agent"}');
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

    const localEnvelope = validateAndSanitizeGatewayCreateInput({
      repoPath: '/tmp/repo',
      sessionEnvelope: { peerIdentity: { kind: 'relay-node', nodeId: 'node-a' } },
    });
    expect(localEnvelope).toMatchObject({
      ok: false,
      error: { code: 'UNSUPPORTED', details: { field: 'sessionEnvelope' } },
    });

    const agentPeer = validateAndSanitizeGatewayCreateInput({
      nodeId: 'node-a',
      repoPath: '/tmp/repo',
      sessionEnvelope: { peerIdentity: { kind: 'agent', id: 'brain', adapter: 'kbrain' } },
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
    if (routedDefault.ok !== true) throw new Error('expected routed create input to validate');
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
      cols: 120,
      workContextId: 'wc:handoff',
    });
    expect(clean).toMatchObject({
      ok: true,
      input: {
        repoPath: '/tmp/repo',
        worktreePath: null,
        type: 'terminal',
        cols: 120,
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
      'handoffs.plan',
      'handoffs.create',
      'handoffs.status',
      'handoffs.cancel',
      'handoffs.resume',
      'handoffs.launch',
      'artifacts.read',
      'events.subscribe',
    ] as const;

    for (const command of invalidArgumentCommands) {
      const emitted = gatewayError(
        command,
        gatewayCliInvalidArgumentError(command, 'invalid gateway command arguments')
      );
      expect(emitted.error.code).toBe('INVALID_ARGUMENT');
      expect(commandSpec(command).errorCodes).toContain(emitted.error.code);
    }

    const invalidJson = gatewayError(
      'sessions.create',
      gatewayCliInvalidJsonError('sessions.create', 'Unexpected end of JSON input')
    );
    expect(invalidJson.error.code).toBe('INVALID_JSON');
    expect(commandSpec('sessions.create').errorCodes).toContain(invalidJson.error.code);
  });

  it('normalizes routed errors without exposing raw upstream bodies', () => {
    expect(
      normalizeGatewayErrorCode(409, {
        error: { code: 'CONFIRMATION_REQUIRED', retryable: true },
      })
    ).toBe('CONFIRMATION_REQUIRED');
    expect(
      normalizeGatewayErrorCode(404, {
        error: { code: 'NODE_OFFLINE', retryable: true, details: { path: '/internal' } },
      })
    ).toBe('NODE_OFFLINE');
    expect(
      normalizeGatewayErrorCode(409, {
        error: { code: 'SOURCE_STALE_OR_OFFLINE', retryable: true, reasonCode: 'FAILED_STALE_SOURCE' },
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
      gatewayErrorRetryable(404, { error: { code: 'NODE_OFFLINE', retryable: true } })
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
        { required: ['id', 'dataBase64'], properties: { dataBase64: { type: 'string' } } },
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
    expect(read.errorCodes).toEqual(expect.arrayContaining(['NODE_OFFLINE', 'NOT_FOUND']));
    expect(commandSpec('files.stat').capabilityHints).toEqual(['session:read', 'rpc:fs:read']);

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
    expect(write.errorCodes).toEqual(expect.arrayContaining(['NODE_OFFLINE', 'FORBIDDEN', 'CONFIRMATION_REQUIRED']));
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
      expect.arrayContaining(['FORBIDDEN', 'SESSION_CONFLICT', 'SERVER_UNAVAILABLE'])
    );

    expect(commandSpec('handoffs.status').summary).toContain('bounded/redacted');
    expect(commandSpec('handoffs.resume').summary).toContain('without raw transcript');
    expect(commandSpec('artifacts.read').summary).toContain('raw logs/secrets/transcripts are unavailable');
  });

  it('encodes sessions.input source exclusivity for schema-generated adapters', () => {
    expect(schemaAcceptsSessionInput({ id: 's1', data: 'hello', waitFor: 'hello' })).toBe(true);
    expect(schemaAcceptsSessionInput({ id: 's1', dataBase64: 'aGVsbG8=' })).toBe(true);
    expect(schemaAcceptsSessionInput({ id: 's1', stdin: true, timeoutMs: 1000 })).toBe(true);

    expect(schemaAcceptsSessionInput({ id: 's1' })).toBe(false);
    expect(schemaAcceptsSessionInput({ id: 's1', data: 'hello', dataBase64: 'aGVsbG8=' })).toBe(
      false
    );
    expect(schemaAcceptsSessionInput({ id: 's1', data: 'hello', stdin: true })).toBe(false);
    expect(schemaAcceptsSessionInput({ id: 's1', dataBase64: 'aGVsbG8=', stdin: true })).toBe(false);
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
