import { describe, expect, it, vi } from 'vitest';
import type { RelayJsonSchema } from '../shared/cli-gateway-contract.js';
import {
  executeSessionKillAction,
  executeSessionRenameAction,
  sessionKillActionAvailability,
  sessionKillActionDescriptor,
  sessionKillActionTarget,
  sessionRenameActionAvailability,
  sessionRenameActionDescriptor,
  sessionRenameActionTarget,
} from '../frontend/src/lib/actions/session-lifecycle.js';
import {
  ConfirmationRequiredError,
  HttpError,
  renameSession,
  type ConfirmationChallenge,
} from '../frontend/src/lib/api.js';

function schemaTypeMatches(type: string, value: unknown): boolean {
  if (type === 'array') return Array.isArray(value);
  if (type === 'null') return value === null;
  if (type === 'object') {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
  return typeof value === type;
}

// The test intentionally implements the tiny JSON Schema subset used by the gateway
// envelopes so this regression does not depend on an undeclared Ajv package.
// eslint-disable-next-line sonarjs/cognitive-complexity
function validateJsonSchema(
  schema: RelayJsonSchema | undefined,
  value: unknown,
  path = '$'
): string[] {
  if (!schema) return [`${path} has no schema`];

  const errors: string[] = [];
  if ('const' in schema && value !== schema.const) {
    errors.push(`${path} expected const ${String(schema.const)}`);
  }
  if (schema.enum && !schema.enum.includes(String(value))) {
    errors.push(`${path} expected enum ${schema.enum.join('|')}`);
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter(
      (candidate) => validateJsonSchema(candidate, value, path).length === 0
    );
    if (matches.length !== 1) errors.push(`${path} expected oneOf match`);
    return errors;
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => schemaTypeMatches(type, value))) {
      errors.push(`${path} expected type ${types.join('|')}`);
      return errors;
    }
  }
  if (schema.type === 'object' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const objectValue = value as Record<string, unknown>;
    const properties = schema.properties ?? {};
    for (const required of schema.required ?? []) {
      if (!(required in objectValue)) {
        errors.push(`${path} missing required property ${required}`);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(objectValue)) {
        if (!(key in properties)) errors.push(`${path} has additional property ${key}`);
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (key in objectValue) {
        errors.push(...validateJsonSchema(childSchema, objectValue[key], `${path}.${key}`));
      }
    }
  }
  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    for (let index = 0; index < value.length; index += 1) {
      errors.push(...validateJsonSchema(schema.items, value[index], `${path}[${index}]`));
    }
  }
  return errors;
}

function challenge(
  overrides: Partial<ConfirmationChallenge> = {}
): ConfirmationChallenge {
  return {
    challengeId: 'chal-1',
    status: 'pending',
    nodeId: 'remote-1',
    intent: { action: 'sessions.kill', target: 'remote-1' },
    requiredBits: ['session:control:kill'],
    challengeBits: ['session:control:kill'],
    canonicalParams: { action: 'sessions.kill' },
    canonicalParamsHash: 'hash-1',
    createdAt: '2026-06-03T00:00:00.000Z',
    expiresAt: '2026-06-03T00:05:00.000Z',
    failedRedemptions: 0,
    maxFailedRedemptions: 3,
    reasonCode: 'CONFIRMATION_REQUIRED',
    message: 'confirmation required to kill session',
    ...overrides,
  };
}

describe('sessions.kill / sessions.rename frontend action contract', () => {
  it('executes a kill as the stable CLI gateway success envelope with full identity', async () => {
    const descriptor = sessionKillActionDescriptor();
    const result = await executeSessionKillAction(
      { id: 'sess-1', nodeId: 'remote-1' },
      async () => undefined
    );

    expect(result).toMatchObject({
      ok: true,
      contract: 'v1',
      contractVersion: '1.0',
      command: 'sessions.kill',
      data: {
        ok: true,
        killed: true,
        id: 'sess-1',
        sessionId: 'sess-1',
        requestedId: 'sess-1',
        nodeId: 'remote-1',
        globalSessionId: 'remote-1:sess-1',
      },
    });
    expect(validateJsonSchema(descriptor.result.schema, result)).toEqual([]);
  });

  it('executes a rename as the stable CLI gateway success envelope', async () => {
    const descriptor = sessionRenameActionDescriptor();
    const result = await executeSessionRenameAction(
      { id: 'sess-1', displayName: 'renamed tab', nodeId: 'remote-1' },
      async () => ({ renamed: true })
    );

    expect(result).toMatchObject({
      ok: true,
      command: 'sessions.rename',
      data: {
        renamed: true,
        id: 'sess-1',
        sessionId: 'sess-1',
        requestedId: 'sess-1',
        nodeId: 'remote-1',
        globalSessionId: 'remote-1:sess-1',
        displayName: 'renamed tab',
      },
    });
    expect(validateJsonSchema(descriptor.result.schema, result)).toEqual([]);
  });

  it('normalizes a missing session into NOT_FOUND + SESSION_NOT_FOUND', async () => {
    const descriptor = sessionKillActionDescriptor();
    const result = await executeSessionKillAction(
      { id: 'missing', nodeId: 'remote-1' },
      async () => {
        throw new HttpError(404, 'Session not found', 'NOT_FOUND', false, {
          reasonCode: 'SESSION_NOT_FOUND',
        });
      }
    );

    expect(result).toMatchObject({
      ok: false,
      command: 'sessions.kill',
      error: {
        code: 'NOT_FOUND',
        retryable: false,
        details: { reasonCode: 'SESSION_NOT_FOUND' },
      },
    });
    expect(validateJsonSchema(descriptor.error.schema, result)).toEqual([]);
  });

  it('normalizes an offline node into NODE_OFFLINE', async () => {
    const result = await executeSessionKillAction(
      { id: 'sess-1', nodeId: 'remote-1' },
      async () => {
        throw new HttpError(503, 'node is offline', 'NODE_OFFLINE', true, {
          nodeId: 'remote-1',
        });
      }
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'NODE_OFFLINE',
        message: 'node is offline',
        retryable: true,
        details: { reasonCode: 'NODE_OFFLINE', nodeId: 'remote-1' },
      },
    });
  });

  it('maps an unsupported session mode (disconnected) to FORBIDDEN + SESSION_DISCONNECTED', async () => {
    const result = await executeSessionRenameAction(
      { id: 'sess-1', displayName: 'x', nodeId: 'remote-1' },
      async () => {
        throw new HttpError(403, 'session is disconnected', 'FORBIDDEN', false, {
          reasonCode: 'SESSION_DISCONNECTED',
        });
      }
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'FORBIDDEN',
        retryable: false,
        details: { reasonCode: 'SESSION_DISCONNECTED' },
      },
    });
  });

  it('maps stale control state to FORBIDDEN + CONTROL_STATE_STALE', async () => {
    const result = await executeSessionKillAction(
      { id: 'sess-1', nodeId: 'remote-1' },
      async () => {
        throw new HttpError(403, 'control state is stale', 'FORBIDDEN', false, {
          reasonCode: 'CONTROL_STATE_STALE',
        });
      }
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'FORBIDDEN',
        details: { reasonCode: 'CONTROL_STATE_STALE' },
      },
    });
  });

  it('preserves ConfirmationRequiredError challenge fields and stays retryable', async () => {
    const descriptor = sessionKillActionDescriptor();
    const result = await executeSessionKillAction(
      { id: 'sess-1', nodeId: 'remote-1' },
      async () => {
        const httpError = new HttpError(
          409,
          'confirmation required to kill session',
          'CONFIRMATION_REQUIRED',
          true
        );
        throw new ConfirmationRequiredError(httpError, challenge());
      }
    );

    expect(result).toMatchObject({
      ok: false,
      command: 'sessions.kill',
      error: {
        code: 'CONFIRMATION_REQUIRED',
        retryable: true,
        details: {
          reasonCode: 'CONFIRMATION_REQUIRED',
          challengeId: 'chal-1',
          requiredBits: ['session:control:kill'],
          expiresAt: '2026-06-03T00:05:00.000Z',
        },
      },
    });
    expect(validateJsonSchema(descriptor.error.schema, result)).toEqual([]);
  });

  it('reports the shared availability shape per failure mode incl. capability hints', () => {
    expect(sessionKillActionAvailability({ sessionMissing: true })).toMatchObject({
      state: 'unavailable',
      reason: 'closing a session requires an existing session',
      capabilityHints: expect.arrayContaining(['session:control:kill']),
    });
    expect(
      sessionKillActionAvailability({ nodeUnavailableReason: 'node is offline' })
    ).toMatchObject({ state: 'unavailable', reason: 'node is offline' });
    expect(
      sessionKillActionAvailability({ controlState: 'stale' })
    ).toMatchObject({
      state: 'unavailable',
      reason: 'closing a session requires fresh session control state',
    });
    expect(
      sessionRenameActionAvailability({ unsupportedModeReason: 'mode unsupported' })
    ).toMatchObject({
      state: 'unavailable',
      reason: 'mode unsupported',
      capabilityHints: expect.arrayContaining(['session:control:rename']),
    });
    expect(sessionRenameActionAvailability({})).toMatchObject({
      state: 'available',
      capabilityHints: expect.arrayContaining(['session:control:rename']),
    });
  });

  it('builds identity targets from the request input', () => {
    expect(sessionKillActionTarget({ id: 'sess-1', nodeId: 'remote-1' })).toEqual({
      sessionId: 'sess-1',
      globalSessionId: 'remote-1:sess-1',
      nodeId: 'remote-1',
    });
    expect(
      sessionRenameActionTarget({
        id: 'sess-2',
        displayName: 'x',
        globalSessionId: 'remote-2:sess-2',
      })
    ).toEqual({
      sessionId: 'sess-2',
      globalSessionId: 'remote-2:sess-2',
      nodeId: 'remote-2',
    });
  });

  it('surfaces renameSession res.ok failures instead of silently swallowing them', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'Session not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(renameSession('missing', 'new name')).rejects.toMatchObject({
        name: 'HttpError',
        status: 404,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
