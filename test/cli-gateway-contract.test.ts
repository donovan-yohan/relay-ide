import { describe, expect, it } from 'vitest';
import {
  RELAY_CLI_GATEWAY_CONTRACT,
  RELAY_CLI_GATEWAY_CONTRACT_VERSION,
  RELAY_CLI_GATEWAY_MAJOR,
  commandSpec,
  gatewayError,
  gatewayOk,
  stableCommandNames,
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
      'sessions.attach',
      'sessions.detach',
      'sessions.interventions',
      'sessions.handBack',
      'files.list',
      'files.stat',
      'files.read',
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
    });
    expect(clean).toMatchObject({
      ok: true,
      input: {
        repoPath: '/tmp/repo',
        worktreePath: null,
        type: 'terminal',
        cols: 120,
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
      'sessions.attach',
      'sessions.detach',
      'sessions.interventions',
      'sessions.handBack',
      'files.list',
      'files.stat',
      'files.read',
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


  it('advertises descriptor-only attach/detach and read-only file RPC commands', () => {
    expect(commandSpec('sessions.attach')).toMatchObject({
      capabilityHints: ['session:read', 'session:attach'],
      transport: 'hub-http',
    });
    expect(commandSpec('sessions.detach')).toMatchObject({
      capabilityHints: ['session:read', 'session:attach'],
      transport: 'hub-http',
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
