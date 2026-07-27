import { describe, expect, it } from 'vitest';
import type { HandoffPlan } from '../shared/handoff.js';
import type { RelayJsonSchema } from '../shared/cli-gateway-contract.js';
import { getHandoffPlanFixture } from '../frontend/src/lib/handoff-fixtures.js';
import { buildHandoffDraft } from '../frontend/src/lib/handoff-live.js';
import {
  executeHandoffsPlanAction,
  handoffsPlanActionDescriptor,
  handoffsPlanCommandDefinition,
} from '../frontend/src/lib/actions/handoff-gateway.js';
import type { SessionSummary } from '../frontend/src/lib/types.js';

function schemaTypeMatches(type: string, value: unknown): boolean {
  if (type === 'array') return Array.isArray(value);
  if (type === 'null') return value === null;
  if (type === 'object')
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  return typeof value === type;
}

function schemaAllowsType(schema: RelayJsonSchema, type: string): boolean {
  const schemaType = schema.type;
  if (!schemaType) return true;
  return Array.isArray(schemaType)
    ? schemaType.includes(type)
    : schemaType === type;
}

// The test intentionally implements the tiny JSON Schema subset used by the gateway
// envelopes so this regression does not depend on an undeclared Ajv package.

function validateJsonSchema(
  schema: RelayJsonSchema | undefined,
  value: unknown,
  path = '$'
): string[] {
  if (!schema) return [`${path} has no schema`];
  const errors: string[] = [];
  if ('const' in schema && value !== schema.const)
    errors.push(`${path} expected const ${String(schema.const)}`);
  if (schema.enum && !schema.enum.includes(String(value)))
    errors.push(`${path} expected enum ${schema.enum.join('|')}`);
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
  if (
    schemaAllowsType(schema, 'object') &&
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  ) {
    const objectValue = value as Record<string, unknown>;
    const properties = schema.properties ?? {};
    for (const required of schema.required ?? []) {
      if (!(required in objectValue))
        errors.push(`${path} missing required property ${required}`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(objectValue)) {
        if (!(key in properties))
          errors.push(`${path} has additional property ${key}`);
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (key in objectValue)
        errors.push(
          ...validateJsonSchema(childSchema, objectValue[key], `${path}.${key}`)
        );
    }
  }
  if (
    schemaAllowsType(schema, 'array') &&
    Array.isArray(value) &&
    schema.items
  ) {
    for (let index = 0; index < value.length; index += 1) {
      errors.push(
        ...validateJsonSchema(schema.items, value[index], `${path}[${index}]`)
      );
    }
  }
  return errors;
}

function activeSession(
  overrides: Partial<SessionSummary> = {}
): SessionSummary {
  return {
    id: 'sess-handoff-872',
    type: 'terminal',
    repoName: 'relay-ide',
    repoPath: '/home/dev/relay-ide',
    worktreePath: '/home/dev/relay-ide/.worktrees/872-web-gateway-bridge',
    cwd: '/home/dev/relay-ide/.worktrees/872-web-gateway-bridge',
    branchName: 'issue-872-web-gateway-bridge',
    displayName: 'handoff descriptor bridge',
    createdAt: '2026-06-06T18:00:00.000Z',
    lastActivity: '2026-06-06T18:01:00.000Z',
    idle: false,
    workContextId: 'wc:issue-872',
    ...overrides,
  };
}

function validFixturePlan(
  key: Parameters<typeof getHandoffPlanFixture>[0]
): HandoffPlan {
  const plan = JSON.parse(
    JSON.stringify(getHandoffPlanFixture(key).plan)
  ) as HandoffPlan;
  plan.pathMappings = plan.pathMappings.map((mapping, index) => ({
    ...mapping,
    sha256: String(index + 1)
      .repeat(64)
      .slice(0, 64),
  }));
  plan.requiredGrants = [
    {
      leg: 'source-read',
      nodeId: plan.route.sourceNodeId,
      capability: 'rpc:fs:read',
      decision: 'requiresConfirmation',
    },
    {
      leg: 'destination-write',
      nodeId: plan.route.destinationNodeId,
      capability: 'rpc:fs:write',
      decision: 'requiresConfirmation',
    },
  ];
  return plan;
}

describe('handoff gateway frontend action bridge', () => {
  it('projects the read-only handoffs.plan command from the stable manifest', () => {
    const planCommand = handoffsPlanCommandDefinition();
    const plan = handoffsPlanActionDescriptor();

    expect(plan.id).toBe('handoffs.plan');
    expect(plan.contract).toMatchObject({
      relayCommandName: 'handoffs.plan',
      stable: true,
      source: 'shared/relay-command-manifest.ts',
    });
    expect(plan.input).toEqual({
      kind: 'json-schema',
      schema: planCommand.inputSchema,
    });
    expect(plan.result).toEqual({
      kind: 'json-schema',
      schema: planCommand.outputSchema,
    });
    expect(plan.sideEffect).toBe('read');
    expect(plan.confirmation).toEqual({
      required: false,
      controlRequirements: [],
    });
    expect(plan.availability.capabilityHints).toEqual(
      planCommand.capabilityHints
    );
    expect(plan.surfaces).toEqual(
      expect.arrayContaining(['cli', 'agent', 'web', 'command-center'])
    );
  });

  it('executes handoffs.plan through the stable gateway success envelope', async () => {
    const descriptor = handoffsPlanActionDescriptor();
    const draft = buildHandoffDraft(activeSession()).draft;
    if (!draft) throw new Error('expected draft');
    const fixturePlan = validFixturePlan('grants-required');

    const result = await executeHandoffsPlanAction(
      {
        request: draft.request,
        sourceRepoPath: draft.sourceRepoPath,
        sourceBranchName: draft.sourceBranchName,
      },
      async (url, init) => {
        expect(url).toBe('/handoffs/plan');
        const body = JSON.parse(String(init?.body));
        expect(body.request.source.workContextId).toBe('wc:issue-872');
        expect(body.sourceRepoPath).toContain('872-web-gateway-bridge');
        return new Response(
          JSON.stringify({ plan: fixturePlan, readOnly: true }),
          { status: 200 }
        );
      }
    );

    expect(result).toMatchObject({
      ok: true,
      contract: 'v1',
      contractVersion: '1.0',
      command: 'handoffs.plan',
      data: { plan: fixturePlan, readOnly: true },
    });
    expect(validateJsonSchema(descriptor.result.schema, result)).toEqual([]);
  });

  it('walks object and array schemas even when schema.type allows multiple JSON types', () => {
    const schema: RelayJsonSchema = {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['items'],
      properties: {
        items: {
          type: ['array', 'null'],
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id'],
            properties: { id: { type: 'string' } },
          },
        },
      },
    };

    expect(
      validateJsonSchema(schema, { items: [{ id: 'artifact:ok' }] })
    ).toEqual([]);
    expect(validateJsonSchema(schema, { items: [{}] })).toContain(
      '$.items[0] missing required property id'
    );
    expect(
      validateJsonSchema(schema, {
        items: [{ id: 'artifact:ok', rawPayload: 'nope' }],
      })
    ).toContain('$.items[0] has additional property rawPayload');
  });

  it('normalizes handoff API failures into the stable gateway error envelope', async () => {
    const descriptor = handoffsPlanActionDescriptor();
    const draft = buildHandoffDraft(activeSession()).draft;
    if (!draft) throw new Error('expected draft');

    const result = await executeHandoffsPlanAction(
      { request: draft.request },
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'CAPABILITY_DENIED',
              message: 'missing validated capability context for handoff route',
              retryable: false,
              details: {
                conflicts: [
                  { code: 'CAPABILITY_DENIED', message: 'typed summary only' },
                ],
              },
            },
          }),
          { status: 403 }
        )
    );

    expect(result).toMatchObject({
      ok: false,
      contract: 'v1',
      contractVersion: '1.0',
      command: 'handoffs.plan',
      error: {
        code: 'FORBIDDEN',
        message: 'missing validated capability context for handoff route',
        retryable: false,
        details: {
          status: 403,
          upstreamCode: 'CAPABILITY_DENIED',
          conflicts: [
            { code: 'CAPABILITY_DENIED', message: 'typed summary only' },
          ],
        },
      },
    });
    expect(validateJsonSchema(descriptor.error.schema, result)).toEqual([]);
  });
});
