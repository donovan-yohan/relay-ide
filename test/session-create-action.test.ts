import { describe, expect, it } from 'vitest';
import type { RelayJsonSchema } from '../shared/cli-gateway-contract.js';
import {
  executeSessionCreateAction,
  sessionCreateActionAvailability,
  sessionCreateActionDescriptor,
  sessionCreateActionTarget,
  sessionsCreateCommandDefinition,
} from '../frontend/src/lib/actions/session-create.js';
import {
  sessionNewAgent,
  sessionNewTerminal,
  sessionStartOnRepo,
  sessionStartWorkInEnv,
} from '../frontend/src/lib/actions/definitions/session.js';
import { HttpError } from '../frontend/src/lib/api.js';
import type { SessionSummary } from '../frontend/src/lib/types.js';

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

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'sess-1',
    globalSessionId: 'remote-1:sess-1',
    nodeId: 'remote-1',
    type: 'terminal',
    agent: 'claude',
    mode: 'pty',
    cwd: '/home/me/repo',
    repoPath: '/home/me/repo',
    worktreePath: null,
    displayName: 'terminal',
    createdAt: '2026-06-03T00:00:00.000Z',
    lastActivity: '2026-06-03T00:00:00.000Z',
    idle: true,
    status: 'active',
    ...overrides,
  } as SessionSummary;
}

describe('sessions.create frontend action contract', () => {
  it('projects the same typed descriptor as the stable CLI gateway command', () => {
    const command = sessionsCreateCommandDefinition();
    const descriptor = sessionCreateActionDescriptor();

    expect(descriptor.id).toBe('sessions.create');
    expect(descriptor.contract).toMatchObject({
      relayCommandName: 'sessions.create',
      stable: true,
      source: 'shared/relay-command-manifest.ts',
    });
    expect(descriptor.input).toEqual({
      kind: 'json-schema',
      schema: command.inputSchema,
    });
    expect(descriptor.result).toEqual({
      kind: 'json-schema',
      schema: command.outputSchema,
    });
    expect(descriptor.error).toMatchObject({
      kind: 'typed-shape',
      type: 'RelayCliGatewayErrorEnvelope',
      schema: expect.objectContaining({ title: 'RelayCliGatewayErrorEnvelope' }),
    });
    expect(descriptor.surfaces).toEqual(
      expect.arrayContaining(['cli', 'agent', 'web', 'command-center'])
    );
  });

  it('attaches sessions.create to launch action metadata without promoting dialog-only actions', () => {
    for (const action of [
      sessionNewAgent,
      sessionNewTerminal,
      sessionStartOnRepo,
      sessionStartWorkInEnv,
    ]) {
      expect(action.descriptor?.id).toBe('sessions.create');
      expect(action.descriptor?.stable).toBe(true);
      expect(action.descriptor?.contract?.relayCommandName).toBe('sessions.create');
    }
  });

  it('keeps launch actions enabled in a workspace command context', () => {
    const ctx = { view: 'workspace' as const, workspacePath: '/home/me/repo' };

    for (const action of [
      sessionNewAgent,
      sessionNewTerminal,
      sessionStartOnRepo,
    ]) {
      expect(action.when?.(ctx)).toBe(true);
      expect(action.disabledReason?.(ctx)).toBeUndefined();
    }
  });

  it('executes a web launch as the stable CLI gateway success envelope', async () => {
    const descriptor = sessionCreateActionDescriptor();
    const result = await executeSessionCreateAction(
      {
        nodeId: 'remote-1',
        cwd: '/home/me/repo',
        repoPath: '/home/me/repo',
        worktreePath: null,
        type: 'terminal',
        mode: 'pty',
      },
      async () => session()
    );

    expect(result).toMatchObject({
      ok: true,
      contract: 'v1',
      contractVersion: '1.0',
      command: 'sessions.create',
      data: {
        id: 'sess-1',
        globalSessionId: 'remote-1:sess-1',
        nodeId: 'remote-1',
        cwd: '/home/me/repo',
        repoPath: '/home/me/repo',
        worktreePath: null,
        type: 'terminal',
        mode: 'pty',
      },
    });
    expect(validateJsonSchema(descriptor.result.schema, result)).toEqual([]);
  });

  it('rejects the legacy custom web envelope against the advertised result schema', () => {
    const descriptor = sessionCreateActionDescriptor();
    const legacyResult = {
      ok: true,
      command: 'sessions.create',
      descriptor,
      input: { cwd: '/home/me/repo', type: 'terminal' },
      session: session(),
      target: {
        sessionId: 'sess-1',
        globalSessionId: 'remote-1:sess-1',
        nodeId: 'remote-1',
      },
    };

    const errors = validateJsonSchema(descriptor.result.schema, legacyResult);
    expect(errors).toEqual(
      expect.arrayContaining([
        '$ missing required property contract',
        '$ missing required property contractVersion',
        '$ missing required property data',
        '$ has additional property descriptor',
        '$ has additional property input',
        '$ has additional property session',
        '$ has additional property target',
      ])
    );
  });

  it('preserves explicit null worktree responses instead of falling back to input', async () => {
    const result = await executeSessionCreateAction(
      {
        nodeId: 'remote-1',
        cwd: '/home/me/repo',
        repoPath: '/home/me/repo',
        worktreePath: '/home/me/repo/.worktrees/feature',
        type: 'terminal',
        mode: 'pty',
      },
      async () => session({ worktreePath: null })
    );

    expect(result).toMatchObject({
      ok: true,
      data: { worktreePath: null },
    });
  });

  it('keeps fallback targeting as an explicit internal projection helper', () => {
    const serverSession = session();
    delete serverSession.worktreePath;

    expect(
      sessionCreateActionTarget(
        {
          nodeId: 'remote-1',
          cwd: '/home/me/repo',
          repoPath: '/home/me/repo',
          worktreePath: '/home/me/repo/.worktrees/feature',
          type: 'terminal',
          mode: 'pty',
        },
        serverSession
      )
    ).toMatchObject({
      sessionId: 'sess-1',
      globalSessionId: 'remote-1:sess-1',
      nodeId: 'remote-1',
      worktreePath: '/home/me/repo/.worktrees/feature',
    });
  });

  it('normalizes launch failures into the stable CLI gateway error envelope', async () => {
    const descriptor = sessionCreateActionDescriptor();
    const result = await executeSessionCreateAction(
      { nodeId: 'remote-1', cwd: '/home/me/repo', type: 'terminal' },
      async () => {
        throw new HttpError(503, 'node is offline', 'NODE_OFFLINE', true, {
          nodeId: 'remote-1',
        });
      }
    );

    expect(result).toMatchObject({
      ok: false,
      contract: 'v1',
      contractVersion: '1.0',
      command: 'sessions.create',
      error: {
        code: 'NODE_OFFLINE',
        message: 'node is offline',
        retryable: true,
        details: { reasonCode: 'NODE_OFFLINE', nodeId: 'remote-1' },
      },
    });
    expect(Object.keys(result)).toEqual([
      'ok',
      'contract',
      'contractVersion',
      'command',
      'error',
    ]);
    expect(validateJsonSchema(descriptor.error.schema, result)).toEqual([]);
  });

  it('uses the shared availability shape for missing context and node/capability blocks', () => {
    expect(sessionCreateActionAvailability({}).reason).toBe(
      'session launch requires a workspace, cwd, or selected environment'
    );
    expect(
      sessionCreateActionAvailability({
        cwd: '/home/me/repo',
        nodeUnavailableReason: 'node is offline',
      })
    ).toMatchObject({
      state: 'unavailable',
      reason: 'node is offline',
      capabilityHints: expect.arrayContaining(['session:create:terminal']),
    });
    expect(sessionCreateActionAvailability({ cwd: '/home/me/repo' })).toMatchObject({
      state: 'available',
    });
  });
});
