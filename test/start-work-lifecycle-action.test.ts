import { describe, expect, it, vi } from 'vitest';
import { gatewayOk } from '../shared/cli-gateway-contract.js';
import type { RelayJsonSchema } from '../shared/cli-gateway-contract.js';
import {
  branchOpenSessionActionAvailability,
  branchOpenSessionActionDescriptor,
  branchesOpenSessionCommandDefinition,
  executeBranchOpenSessionAction,
  executeTicketStartWorkAction,
  ticketStartWorkActionAvailability,
  ticketStartWorkActionDescriptor,
  ticketsStartWorkCommandDefinition,
  type CreateSessionDep,
  type CreateWorktreeDep,
} from '../frontend/src/lib/actions/start-work-lifecycle.js';
import type { CreateSessionBody } from '../frontend/src/lib/api.js';
import { ConfirmationRequiredError, ConflictError, HttpError } from '../frontend/src/lib/api.js';
import type { SessionSummary } from '../frontend/src/lib/types.js';

function schemaTypeMatches(type: string, value: unknown): boolean {
  if (type === 'array') return Array.isArray(value);
  if (type === 'null') return value === null;
  if (type === 'object') {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
  return typeof value === type;
}

// Mirrors the tiny JSON Schema subset used in test/workspace-lifecycle-action.test.ts
// so the regression doesn't depend on an undeclared Ajv package.
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
  if (
    schema.type === 'object' &&
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  ) {
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

function sessionSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'sess-1',
    type: 'agent',
    agent: 'claude',
    mode: 'pty',
    cwd: '/repo/.worktrees/feat-foo',
    repoPath: '/repo',
    worktreePath: '/repo/.worktrees/feat-foo',
    branchName: 'feat/foo',
    displayName: 'feat/foo agent',
    createdAt: '2026-06-10T00:00:00.000Z',
    lastActivity: '2026-06-10T00:00:00.000Z',
    idle: false,
    status: 'active',
    ...overrides,
  };
}

describe('tickets.startWork + branches.openSession frontend action contract', () => {
  describe('descriptor shapes', () => {
    it('projects tickets.startWork as a non-destructive write with no confirmation', () => {
      const descriptor = ticketStartWorkActionDescriptor();
      expect(descriptor.id).toBe('tickets.startWork');
      expect(descriptor.stable).toBe(true);
      expect(descriptor.sideEffect).toBe('write');
      expect(descriptor.confirmation.required).toBe(false);
      expect(descriptor.input.kind).toBe('json-schema');
      expect(descriptor.result.kind).toBe('json-schema');
      expect(descriptor.error.kind).toBe('typed-shape');
      expect(descriptor.surfaces).toEqual(
        expect.arrayContaining(['cli', 'agent', 'web', 'command-center'])
      );
      expect(descriptor.contract).toMatchObject({
        relayCommandName: 'tickets.startWork',
        stable: true,
        source: 'shared/relay-command-manifest.ts',
      });
    });

    it('projects branches.openSession as a non-destructive write with no confirmation', () => {
      const descriptor = branchOpenSessionActionDescriptor();
      expect(descriptor.id).toBe('branches.openSession');
      expect(descriptor.sideEffect).toBe('write');
      expect(descriptor.confirmation.required).toBe(false);
      expect(descriptor.contract).toMatchObject({
        relayCommandName: 'branches.openSession',
        stable: true,
      });
    });

    it('exposes the frozen command definitions', () => {
      expect(ticketsStartWorkCommandDefinition().name).toBe('tickets.startWork');
      expect(branchesOpenSessionCommandDefinition().name).toBe(
        'branches.openSession'
      );
    });
  });

  describe('executor happy paths validated against contract output schemas', () => {
    it('starts ticket work as the stable CLI gateway success envelope', async () => {
      const descriptor = ticketStartWorkActionDescriptor();
      const createSession: CreateSessionDep = vi.fn(async () =>
        sessionSummary()
      );
      const result = await executeTicketStartWorkAction(
        {
          ticket: { source: 'github', id: '871', title: 'frontend bridge' },
          repo: { repoPath: '/repo' },
          branch: { name: 'feat/foo' },
          worktree: { mode: 'reuse-existing', worktreePath: '/repo/.worktrees/feat-foo' },
        },
        { createSession }
      );

      expect(result).toMatchObject({
        ok: true,
        contract: 'v1',
        contractVersion: '1.0',
        command: 'tickets.startWork',
        data: {
          created: { session: true, worktree: false },
          reused: { worktree: true },
          branch: { name: 'feat/foo' },
        },
      });
      if (!result.ok) throw new Error('expected ok envelope');
      expect(validateJsonSchema(descriptor.result.schema, result)).toEqual([]);
      // ticketContext rides the session body, not a post-create raw write.
      const body = (createSession as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0] as CreateSessionBody;
      expect(body.ticketContext).toMatchObject({
        ticketId: '871',
        source: 'github',
        repoPath: '/repo',
      });
    });

    it('opens a branch session as the branches.openSession success envelope', async () => {
      const descriptor = branchOpenSessionActionDescriptor();
      const result = await executeBranchOpenSessionAction(
        {
          repo: { repoPath: '/repo' },
          branch: { name: 'feat/foo' },
          existingWorktreePath: '/repo/.worktrees/feat-foo',
        },
        { createSession: async () => sessionSummary() }
      );

      expect(result).toMatchObject({
        ok: true,
        command: 'branches.openSession',
        data: { created: { session: true }, branch: { name: 'feat/foo' } },
      });
      if (!result.ok) throw new Error('expected ok envelope');
      expect(validateJsonSchema(descriptor.result.schema, result)).toEqual([]);
    });

    it('opens a PR session, projecting the pr target into the output', async () => {
      const descriptor = branchOpenSessionActionDescriptor();
      const result = await executeBranchOpenSessionAction(
        {
          repo: { repoPath: '/repo' },
          pr: { number: 42, head: 'feat/foo', url: 'https://example/pr/42' },
          existingWorktreePath: '/repo/.worktrees/feat-foo',
        },
        { createSession: async () => sessionSummary() }
      );

      expect(result).toMatchObject({
        ok: true,
        command: 'branches.openSession',
        data: { pr: { number: 42, head: 'feat/foo' } },
      });
      if (!result.ok) throw new Error('expected ok envelope');
      expect(result.data.pr).toMatchObject({ number: 42 });
      expect(validateJsonSchema(descriptor.result.schema, result)).toEqual([]);
    });

    it('defaults a SessionSummary missing mode/status into a contract-valid session descriptor', async () => {
      const descriptor = ticketStartWorkActionDescriptor();
      const result = await executeTicketStartWorkAction(
        {
          ticket: { source: 'github', id: '871' },
          repo: { repoPath: '/repo' },
          branch: { name: 'feat/foo' },
          existingWorktreePath: '/wt',
        },
        {
          createSession: async () =>
            // SessionSummary leaves mode/status optional; the contract session
            // descriptor requires them. The bridge defaults pty/active.
            ({
              ...sessionSummary(),
              mode: undefined,
              status: undefined,
            }) as SessionSummary,
        }
      );
      if (!result.ok) throw new Error('expected ok envelope');
      expect(result.data.session.mode).toBe('pty');
      expect(result.data.session.status).toBe('active');
      expect(validateJsonSchema(descriptor.result.schema, result)).toEqual([]);
    });
  });

  describe('worktree resolution: reuse vs create', () => {
    it('reuses an existing worktree (store fast-path) without calling create', async () => {
      const createWorktree: CreateWorktreeDep = vi.fn();
      const result = await executeBranchOpenSessionAction(
        {
          repo: { repoPath: '/repo' },
          branch: { name: 'feat/foo' },
          worktree: { mode: 'reuse-existing' },
          existingWorktreePath: '/repo/.worktrees/feat-foo',
        },
        { createWorktree, createSession: async () => sessionSummary() }
      );
      expect(result.ok).toBe(true);
      expect(createWorktree).not.toHaveBeenCalled();
      if (!result.ok) throw new Error('expected ok envelope');
      expect(result.data.created.worktree).toBe(false);
      expect(result.data.reused.worktree).toBe(true);
    });

    it('create-if-missing calls createWorktree and binds the resulting path', async () => {
      const createWorktree: CreateWorktreeDep = vi.fn(async () =>
        gatewayOk('worktrees.create', {
          branchName: 'feat/foo',
          mountainName: 'everest',
          worktreePath: '/repo/.worktrees/feat-foo',
        })
      );
      const createSession: CreateSessionDep = vi.fn(async () => sessionSummary());
      const result = await executeBranchOpenSessionAction(
        {
          repo: { repoPath: '/repo' },
          branch: { name: 'feat/foo' },
          worktree: { mode: 'create-if-missing' },
        },
        { createWorktree, createSession }
      );
      expect(result.ok).toBe(true);
      expect(createWorktree).toHaveBeenCalledTimes(1);
      if (!result.ok) throw new Error('expected ok envelope');
      expect(result.data.created.worktree).toBe(true);
      // newWorktree:true rides the session body when the bridge created the worktree.
      const body = (createSession as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0] as CreateSessionBody;
      expect(body.newWorktree).toBe(true);
      expect(body.worktreePath).toBe('/repo/.worktrees/feat-foo');
    });

    it('fails closed when create-if-missing worktree create fails (surfaces the worktree reason)', async () => {
      const createWorktree: CreateWorktreeDep = vi.fn(async () =>
        executeWorktreeCreateFailure()
      );
      const createSession: CreateSessionDep = vi.fn();
      const result = await executeBranchOpenSessionAction(
        {
          repo: { repoPath: '/repo' },
          branch: { name: 'feat/foo' },
          worktree: { mode: 'create-if-missing' },
        },
        { createWorktree, createSession }
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected error envelope');
      // The worktree-create error is surfaced verbatim; no session created.
      expect(result.error.code).toBe('NODE_OFFLINE');
      expect(createSession).not.toHaveBeenCalled();
    });
  });

  describe('prompt handoff (typed initial-prompt path, never raw PTY)', () => {
    it('delivers an initial-prompt and carries initialPrompt in the session body', async () => {
      const createSession: CreateSessionDep = vi.fn(async () => sessionSummary());
      const result = await executeTicketStartWorkAction(
        {
          ticket: { source: 'github', id: '871' },
          repo: { repoPath: '/repo' },
          branch: { name: 'feat/foo' },
          existingWorktreePath: '/wt',
          prompt: { mode: 'initial-prompt', prompt: 'fix the bug' },
        },
        { createSession }
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok envelope');
      expect(result.data.promptHandoff).toEqual({
        delivered: true,
        method: 'sessions.create.initialPrompt',
      });
      const body = (createSession as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0] as CreateSessionBody;
      expect(body.initialPrompt).toBe('fix the bug');
    });

    it('reports promptHandoff.delivered:false when no prompt is requested', async () => {
      const createSession: CreateSessionDep = vi.fn(async () => sessionSummary());
      const result = await executeBranchOpenSessionAction(
        {
          repo: { repoPath: '/repo' },
          branch: { name: 'feat/foo' },
          existingWorktreePath: '/wt',
        },
        { createSession }
      );
      if (!result.ok) throw new Error('expected ok envelope');
      expect(result.data.promptHandoff).toEqual({ delivered: false });
      const body = (createSession as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0] as CreateSessionBody;
      expect(body.initialPrompt).toBeUndefined();
    });

    it('fails with UNSUPPORTED + PROMPT_HANDOFF_UNSUPPORTED for unsupported + requireTypedDelivery (no session created)', async () => {
      const createSession: CreateSessionDep = vi.fn();
      const result = await executeBranchOpenSessionAction(
        {
          repo: { repoPath: '/repo' },
          branch: { name: 'feat/foo' },
          existingWorktreePath: '/wt',
          prompt: { mode: 'unsupported', requireTypedDelivery: true },
        },
        { createSession }
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected error envelope');
      expect(result.error).toMatchObject({
        code: 'UNSUPPORTED',
        retryable: false,
        details: { reasonCode: 'PROMPT_HANDOFF_UNSUPPORTED' },
      });
      // Never degrade to raw PTY: no session created when typed delivery is required.
      expect(createSession).not.toHaveBeenCalled();
    });
  });

  describe('error mapping + fail-closed cases', () => {
    it('maps a missing repo path to INVALID_ARGUMENT', async () => {
      const createSession: CreateSessionDep = vi.fn();
      const result = await executeTicketStartWorkAction(
        {
          ticket: { source: 'github', id: '871' },
          repo: { repoPath: '' },
          branch: { name: 'feat/foo' },
        },
        { createSession }
      );
      expect(result).toMatchObject({
        ok: false,
        command: 'tickets.startWork',
        error: { code: 'INVALID_ARGUMENT', retryable: false },
      });
      expect(createSession).not.toHaveBeenCalled();
    });

    it('maps an offline node (503 NODE_OFFLINE) on session create to NODE_OFFLINE', async () => {
      const result = await executeBranchOpenSessionAction(
        {
          repo: { repoPath: '/repo', nodeId: 'remote-1' },
          branch: { name: 'feat/foo' },
          existingWorktreePath: '/wt',
        },
        {
          createSession: async () => {
            throw new HttpError(503, 'node is offline', 'NODE_OFFLINE', true, {
              nodeId: 'remote-1',
            });
          },
        }
      );
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'NODE_OFFLINE',
          retryable: true,
          details: { reasonCode: 'NODE_OFFLINE', nodeId: 'remote-1' },
        },
      });
    });

    it('maps a ConflictError (409 with sessionId) to SESSION_CONFLICT carrying the sessionId', async () => {
      const result = await executeBranchOpenSessionAction(
        {
          repo: { repoPath: '/repo' },
          branch: { name: 'feat/foo' },
          existingWorktreePath: '/wt',
        },
        {
          createSession: async () => {
            throw new ConflictError('existing-sess-9');
          },
        }
      );
      expect(result).toMatchObject({
        ok: false,
        command: 'branches.openSession',
        error: {
          code: 'SESSION_CONFLICT',
          retryable: false,
          details: { sessionId: 'existing-sess-9' },
        },
      });
    });

    it('preserves a CONFIRMATION_REQUIRED challenge from session create', async () => {
      const challenge = {
        challengeId: 'ch-1',
        status: 'pending' as const,
        nodeId: 'local',
        intent: { action: 'sessions.create' },
        requiredBits: ['session:create:agent'],
        challengeBits: ['session:create:agent'],
        canonicalParams: { action: 'sessions.create' },
        canonicalParamsHash: 'hash',
        createdAt: '2026-06-10T00:00:00.000Z',
        expiresAt: '2026-06-10T00:05:00.000Z',
        failedRedemptions: 0,
        maxFailedRedemptions: 3,
        reasonCode: 'CONFIRMATION_REQUIRED',
        message: 'confirmation required',
      };
      const result = await executeTicketStartWorkAction(
        {
          ticket: { source: 'github', id: '871' },
          repo: { repoPath: '/repo' },
          branch: { name: 'feat/foo' },
          existingWorktreePath: '/wt',
        },
        {
          createSession: async () => {
            throw new ConfirmationRequiredError(
              new HttpError(403, 'confirmation required', 'CONFIRMATION_REQUIRED', true),
              challenge
            );
          },
        }
      );
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'CONFIRMATION_REQUIRED',
          retryable: true,
          details: { challengeId: 'ch-1', reasonCode: 'CONFIRMATION_REQUIRED' },
        },
      });
    });
  });

  describe('availability shapes per failure mode incl. capability hints', () => {
    it('reports tickets.startWork availability per failure mode', () => {
      expect(
        ticketStartWorkActionAvailability({ ticketMissing: true })
      ).toMatchObject({
        state: 'unavailable',
        reason: 'starting ticket work requires a ticket',
        capabilityHints: expect.arrayContaining(['session:create:agent']),
      });
      expect(
        ticketStartWorkActionAvailability({ repoMissing: true })
      ).toMatchObject({
        state: 'unavailable',
        reason: 'starting ticket work requires a repo path',
      });
      expect(
        ticketStartWorkActionAvailability({
          nodeUnavailableReason: 'node is offline',
        })
      ).toMatchObject({ state: 'unavailable', reason: 'node is offline' });
      expect(ticketStartWorkActionAvailability({})).toMatchObject({
        state: 'available',
        capabilityHints: expect.arrayContaining(['session:create:agent']),
      });
    });

    it('reports branches.openSession availability per failure mode', () => {
      expect(
        branchOpenSessionActionAvailability({ branchOrPrMissing: true })
      ).toMatchObject({
        state: 'unavailable',
        reason: 'opening a branch session requires a branch or PR target',
      });
      expect(
        branchOpenSessionActionAvailability({
          unsupportedRemoteReason: 'start-work is local-only in v1',
        })
      ).toMatchObject({
        state: 'unavailable',
        reason: 'start-work is local-only in v1',
      });
      expect(branchOpenSessionActionAvailability({})).toMatchObject({
        state: 'available',
        capabilityHints: expect.arrayContaining(['session:create:agent']),
      });
    });
  });
});

// Local helper: a worktree-create gateway error envelope to assert the composite
// fails closed and surfaces the worktree reason verbatim.
function executeWorktreeCreateFailure(): ReturnType<CreateWorktreeDep> {
  return Promise.resolve({
    ok: false,
    contract: 'v1',
    contractVersion: '1.0',
    command: 'worktrees.create',
    error: {
      code: 'NODE_OFFLINE',
      message: 'node is offline',
      retryable: true,
      details: { reasonCode: 'NODE_OFFLINE' },
    },
  });
}
