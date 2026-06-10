import { describe, expect, it, vi } from 'vitest';
import type { RelayJsonSchema } from '../shared/cli-gateway-contract.js';
import {
  executeWorktreeArchiveAction,
  executeWorktreeCreateAction,
  executeWorktreeDeleteAction,
  executeWorkspaceLaunchAction,
  worktreeArchiveActionAvailability,
  worktreeArchiveActionDescriptor,
  worktreeCreateActionAvailability,
  worktreeCreateActionDescriptor,
  worktreeDeleteActionAvailability,
  worktreeDeleteActionDescriptor,
  workspaceLaunchActionAvailability,
  workspaceLaunchActionDescriptor,
} from '../frontend/src/lib/actions/workspace-lifecycle.js';
import { HttpError, createWorktree, deleteWorktree } from '../frontend/src/lib/api.js';

function schemaTypeMatches(type: string, value: unknown): boolean {
  if (type === 'array') return Array.isArray(value);
  if (type === 'null') return value === null;
  if (type === 'object') {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
  return typeof value === type;
}

// Mirrors the tiny JSON Schema subset used in test/session-lifecycle-action.test.ts
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

describe('worktrees + workspaces lifecycle frontend action contract', () => {
  describe('descriptor shapes', () => {
    it('projects worktrees.delete as destructive + confirmation-required', () => {
      const descriptor = worktreeDeleteActionDescriptor();
      expect(descriptor.id).toBe('worktrees.delete');
      expect(descriptor.stable).toBe(true);
      expect(descriptor.sideEffect).toBe('destructive');
      expect(descriptor.confirmation.required).toBe(true);
      expect(descriptor.input.kind).toBe('json-schema');
      expect(descriptor.result.kind).toBe('json-schema');
      expect(descriptor.error.kind).toBe('typed-shape');
      expect(descriptor.surfaces).toEqual(
        expect.arrayContaining(['cli', 'agent', 'web', 'command-center'])
      );
      expect(descriptor.contract).toMatchObject({
        relayCommandName: 'worktrees.delete',
        stable: true,
        source: 'shared/relay-command-manifest.ts',
      });
    });

    it('projects worktrees.archive as destructive + confirmation-required', () => {
      const descriptor = worktreeArchiveActionDescriptor();
      expect(descriptor.id).toBe('worktrees.archive');
      expect(descriptor.sideEffect).toBe('destructive');
      expect(descriptor.confirmation.required).toBe(true);
      expect(descriptor.contract).toMatchObject({
        relayCommandName: 'worktrees.archive',
        stable: true,
      });
    });

    it('projects worktrees.create as a non-destructive write with no confirmation', () => {
      const descriptor = worktreeCreateActionDescriptor();
      expect(descriptor.id).toBe('worktrees.create');
      expect(descriptor.sideEffect).toBe('write');
      expect(descriptor.confirmation.required).toBe(false);
      expect(descriptor.contract).toMatchObject({
        relayCommandName: 'worktrees.create',
        stable: true,
      });
    });

    it('projects workspaces.launch as a non-destructive write with no confirmation', () => {
      const descriptor = workspaceLaunchActionDescriptor();
      expect(descriptor.id).toBe('workspaces.launch');
      expect(descriptor.sideEffect).toBe('write');
      expect(descriptor.confirmation.required).toBe(false);
      expect(descriptor.contract).toMatchObject({
        relayCommandName: 'workspaces.launch',
        stable: true,
      });
    });
  });

  describe('executor happy paths validated against contract output schemas', () => {
    it('creates a worktree as the stable CLI gateway success envelope', async () => {
      const descriptor = worktreeCreateActionDescriptor();
      const result = await executeWorktreeCreateAction(
        { repoPath: '/repo' },
        async () => ({
          branchName: 'feat/foo',
          mountainName: 'everest',
          worktreePath: '/repo/.worktrees/feat-foo',
        })
      );

      expect(result).toMatchObject({
        ok: true,
        contract: 'v1',
        contractVersion: '1.0',
        command: 'worktrees.create',
        data: {
          branchName: 'feat/foo',
          mountainName: 'everest',
          worktreePath: '/repo/.worktrees/feat-foo',
        },
      });
      if (!result.ok) throw new Error('expected ok envelope');
      // descriptor.result.schema is the full okOutput envelope schema, so validate
      // the whole result (matches test/session-lifecycle-action.test.ts).
      expect(validateJsonSchema(descriptor.result.schema, result)).toEqual([]);
    });

    it('fails closed when create returns a null worktreePath (no contract-violating empty path)', async () => {
      // The contract output requires a non-empty string worktreePath. A null path
      // on a "success" must surface as an error envelope rather than be coerced to
      // '' (which the backend createAgentSession would reject with an opaque path error).
      const result = await executeWorktreeCreateAction(
        { repoPath: '/repo' },
        async () => ({
          branchName: 'feat/foo',
          mountainName: 'everest',
          worktreePath: null,
        })
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected error envelope');
      expect(result.error.message).toContain('no worktree path');
    });

    it('deletes a worktree as the destructive success envelope (branch deleted)', async () => {
      const descriptor = worktreeDeleteActionDescriptor();
      const result = await executeWorktreeDeleteAction(
        { worktreePath: '/repo/.worktrees/feat-foo', repoPath: '/repo', force: true },
        async () => undefined
      );

      expect(result).toMatchObject({
        ok: true,
        command: 'worktrees.delete',
        data: { ok: true, action: 'delete', branchDeleted: true },
      });
      if (!result.ok) throw new Error('expected ok envelope');
      expect(validateJsonSchema(descriptor.result.schema, result)).toEqual([]);
    });

    it('launches a workspace session, passing the SessionSummary through unchanged', async () => {
      const descriptor = workspaceLaunchActionDescriptor();
      const result = await executeWorkspaceLaunchAction(
        { workspaceId: 'ws-1', agent: 'claude' },
        async () => ({
          id: 'sess-1',
          type: 'agent',
          agent: 'claude',
          mode: 'pty',
          cwd: '/repo',
          repoPath: '/repo',
          displayName: 'ws-1 agent',
          createdAt: '2026-06-10T00:00:00.000Z',
          lastActivity: '2026-06-10T00:00:00.000Z',
          idle: false,
          status: 'active',
        })
      );

      expect(result).toMatchObject({
        ok: true,
        command: 'workspaces.launch',
        data: { id: 'sess-1', type: 'agent', agent: 'claude', status: 'active' },
      });
      if (!result.ok) throw new Error('expected ok envelope');
      // sessionDescriptorSchema is open (additionalProperties:true) — the whole
      // summary validates and downstream callers keep repoPath/etc. The envelope
      // okOutput wrapper is additionalProperties:false but every wrapper field is
      // present, so validating the full result passes.
      expect(validateJsonSchema(descriptor.result.schema, result)).toEqual([]);
      expect((result.data as { repoPath?: string }).repoPath).toBe('/repo');
    });
  });

  describe('archive branch preservation', () => {
    it('archives a worktree with branchDeleted:false (branch PRESERVED)', async () => {
      const descriptor = worktreeArchiveActionDescriptor();
      const result = await executeWorktreeArchiveAction(
        { worktreePath: '/repo/.worktrees/feat-foo', repoPath: '/repo', force: true },
        async () => undefined
      );

      expect(result).toMatchObject({
        ok: true,
        command: 'worktrees.archive',
        data: { ok: true, action: 'archive', branchDeleted: false },
      });
      if (!result.ok) throw new Error('expected ok envelope');
      expect(result.data.branchDeleted).toBe(false);
      expect(validateJsonSchema(descriptor.result.schema, result)).toEqual([]);
    });

    it('archive executor never requests branch deletion from the api fn', async () => {
      const archiveExecutor = vi.fn(async () => undefined);
      await executeWorktreeArchiveAction(
        { worktreePath: '/wt', repoPath: '/repo', force: false },
        archiveExecutor
      );
      // The bridge passes the typed input through; it must NOT carry any
      // branch-deletion flag/intent.
      const passed = archiveExecutor.mock.calls[0]?.[0];
      expect(passed).not.toHaveProperty('deleteBranch');
      expect(passed).toMatchObject({ worktreePath: '/wt', repoPath: '/repo' });
    });
  });

  describe('fail-closed cases', () => {
    it('maps a dirty worktree (409 uncommitted_changes) to CONFIRMATION_REQUIRED', async () => {
      const descriptor = worktreeDeleteActionDescriptor();
      const result = await executeWorktreeDeleteAction(
        { worktreePath: '/wt', repoPath: '/repo' },
        async () => {
          // Wire format: 409 { error: 'uncommitted_changes', hasUncommittedChanges: true }
          // httpErrorFromResponse surfaces the plain string on error.code.
          throw new HttpError(409, 'uncommitted_changes', 'uncommitted_changes', false, {
            hasUncommittedChanges: true,
          });
        }
      );

      expect(result).toMatchObject({
        ok: false,
        command: 'worktrees.delete',
        error: {
          code: 'CONFIRMATION_REQUIRED',
          details: { reasonCode: 'uncommitted_changes', hasUncommittedChanges: true },
        },
      });
      if (result.ok) throw new Error('expected error envelope');
      expect(validateJsonSchema(descriptor.error.schema, result)).toEqual([]);
    });

    it('maps active sessions (409 active_sessions) to SESSION_CONFLICT', async () => {
      const result = await executeWorktreeDeleteAction(
        { worktreePath: '/wt', repoPath: '/repo' },
        async () => {
          throw new HttpError(409, 'active_sessions', 'active_sessions', false, {
            sessionIds: ['s1', 's2'],
          });
        }
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'SESSION_CONFLICT',
          details: { reasonCode: 'active_sessions', sessionIds: ['s1', 's2'] },
        },
      });
    });

    it('maps a missing worktree path (404) to NOT_FOUND', async () => {
      const result = await executeWorktreeDeleteAction(
        { worktreePath: '/missing', repoPath: '/repo' },
        async () => {
          throw new HttpError(
            404,
            'Worktree not found — may have been already cleaned up',
            undefined,
            false
          );
        }
      );

      expect(result).toMatchObject({
        ok: false,
        error: { code: 'NOT_FOUND', retryable: false },
      });
    });

    it('maps an offline node (503 NODE_OFFLINE) to NODE_OFFLINE on create', async () => {
      const result = await executeWorktreeCreateAction(
        { repoPath: '/repo' },
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
          retryable: true,
          details: { reasonCode: 'NODE_OFFLINE', nodeId: 'remote-1' },
        },
      });
    });

    it('maps an unsupported remote lifecycle write to UNSUPPORTED on create', async () => {
      const result = await executeWorktreeCreateAction(
        { repoPath: '/repo' },
        async () => {
          // Mirrors rejectRemoteLifecycleWrite (bin/relay-ide.ts) vocabulary.
          throw new HttpError(
            400,
            'repo/worktree lifecycle writes are local-only in v1; remote node mutation is unsupported until routed node worktree capabilities exist',
            'NODE_UNSUPPORTED',
            false,
            { nodeId: 'remote-1' }
          );
        }
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'UNSUPPORTED',
          retryable: false,
          details: { nodeId: 'remote-1' },
        },
      });
    });

    it('maps a missing workspace id (404) to NOT_FOUND on launch', async () => {
      const result = await executeWorkspaceLaunchAction(
        { workspaceId: 'missing' },
        async () => {
          throw new HttpError(404, 'workspace not found', 'NOT_FOUND', false);
        }
      );

      expect(result).toMatchObject({
        ok: false,
        command: 'workspaces.launch',
        error: { code: 'NOT_FOUND', retryable: false },
      });
    });

    it('archive surfaces fail-closed conditions identically to delete', async () => {
      const result = await executeWorktreeArchiveAction(
        { worktreePath: '/wt', repoPath: '/repo' },
        async () => {
          throw new HttpError(409, 'active_sessions', 'active_sessions', false, {
            sessionIds: ['s1'],
          });
        }
      );

      expect(result).toMatchObject({
        ok: false,
        command: 'worktrees.archive',
        error: { code: 'SESSION_CONFLICT', details: { reasonCode: 'active_sessions' } },
      });
    });
  });

  describe('confirmation strategy is force-only (no challenge round-trip)', () => {
    it('deleteWorktree re-issues with force without registering a confirmation retry', async () => {
      // Confirms the api.ts deleteWorktree path is plain fetch + typed HttpError,
      // not the challenge/registerConfirmationRetry path (per the wire investigation).
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify({ error: 'uncommitted_changes', hasUncommittedChanges: true }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      vi.stubGlobal('fetch', fetchMock);
      try {
        await expect(deleteWorktree('/wt', '/repo', true)).rejects.toMatchObject({
          name: 'HttpError',
          status: 409,
          // plain-string body surfaces on code (NOT a CONFIRMATION_REQUIRED challenge)
          code: 'uncommitted_changes',
        });
        // force:true was sent in the body.
        const body = JSON.parse(
          (fetchMock.mock.calls[0]?.[1] as RequestInit).body as string
        );
        expect(body).toMatchObject({ worktreePath: '/wt', repoPath: '/repo', force: true });
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('default archive executor sends deleteBranch:false over the wire (branch PRESERVED)', async () => {
      // Regression: the DELETE /worktrees route treats `deleteBranch !== false`
      // as true, so omitting the flag silently deletes the branch even though the
      // archive envelope reports branchDeleted:false. The default archive executor
      // MUST send deleteBranch:false so the wire matches the branch-preserving
      // contract. Uses the REAL default executor (no injected stub).
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify({ ok: true, branchDeleted: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      vi.stubGlobal('fetch', fetchMock);
      try {
        const result = await executeWorktreeArchiveAction({
          worktreePath: '/repo/.worktrees/feat',
          repoPath: '/repo',
          force: true,
        });
        expect(result.ok).toBe(true);
        const body = JSON.parse(
          (fetchMock.mock.calls[0]?.[1] as RequestInit).body as string
        );
        expect(body).toMatchObject({
          worktreePath: '/repo/.worktrees/feat',
          repoPath: '/repo',
          force: true,
          deleteBranch: false,
        });
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('default delete executor omits deleteBranch (route default deletes branch)', async () => {
      // Delete is branch-DELETING; it must NOT send deleteBranch so the route's
      // `deleteBranch !== false` default (true) applies, matching branchDeleted:true.
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify({ ok: true, branchDeleted: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      vi.stubGlobal('fetch', fetchMock);
      try {
        const result = await executeWorktreeDeleteAction({
          worktreePath: '/repo/.worktrees/feat',
          repoPath: '/repo',
          force: true,
        });
        expect(result.ok).toBe(true);
        const body = JSON.parse(
          (fetchMock.mock.calls[0]?.[1] as RequestInit).body as string
        );
        expect(body).not.toHaveProperty('deleteBranch');
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('createWorktree surfaces res.ok failures as a typed HttpError', async () => {
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify({ error: 'Path is not a recognized git worktree' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      vi.stubGlobal('fetch', fetchMock);
      try {
        await expect(createWorktree('/repo')).rejects.toMatchObject({
          name: 'HttpError',
          status: 400,
        });
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  describe('availability shapes per failure mode incl. capability hints', () => {
    it('reports worktree create/delete/archive unavailability with capability hints', () => {
      expect(
        worktreeCreateActionAvailability({ workspaceMissing: true })
      ).toMatchObject({
        state: 'unavailable',
        reason: 'creating a worktree requires an active workspace',
        capabilityHints: expect.arrayContaining(['rpc:git:write']),
      });
      expect(worktreeDeleteActionAvailability({ worktreeMissing: true })).toMatchObject({
        state: 'unavailable',
        reason: 'deleting a worktree requires an existing worktree',
        capabilityHints: expect.arrayContaining(['session:control:kill']),
      });
      expect(
        worktreeArchiveActionAvailability({ nodeUnavailableReason: 'node is offline' })
      ).toMatchObject({ state: 'unavailable', reason: 'node is offline' });
      expect(
        worktreeDeleteActionAvailability({
          unsupportedRemoteReason:
            'repo/worktree lifecycle writes are local-only in v1',
        })
      ).toMatchObject({
        state: 'unavailable',
        reason: 'repo/worktree lifecycle writes are local-only in v1',
      });
      expect(worktreeCreateActionAvailability({})).toMatchObject({
        state: 'available',
        capabilityHints: expect.arrayContaining(['rpc:git:write']),
      });
    });

    it('reports workspace launch availability per failure mode', () => {
      expect(
        workspaceLaunchActionAvailability({ workspaceMissing: true })
      ).toMatchObject({
        state: 'unavailable',
        reason: 'launching a workspace requires a workspace',
        capabilityHints: expect.arrayContaining(['session:create:agent']),
      });
      expect(
        workspaceLaunchActionAvailability({ nodeUnavailableReason: 'node is offline' })
      ).toMatchObject({ state: 'unavailable', reason: 'node is offline' });
      expect(workspaceLaunchActionAvailability({})).toMatchObject({
        state: 'available',
        capabilityHints: expect.arrayContaining(['session:create:agent']),
      });
    });
  });
});
