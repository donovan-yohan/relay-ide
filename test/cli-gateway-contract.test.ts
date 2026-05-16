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
  gatewayErrorRetryable,
  normalizeGatewayErrorCode,
  sanitizedGatewayErrorDetails,
  validateAndSanitizeGatewayCreateInput,
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
      'sessions.interventions',
      'sessions.handBack',
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
