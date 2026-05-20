// #626: CLI gateway — typed environment IDs for agent tasks.
//
// Verifies that `sessions.create` and any other agent-task verbs accept a typed
// `environment: { nodeId, repoIdentity?, benchId?, cwd }` shape sourced from
// `shared/environment-option.ts` (EnvironmentOption) and reject raw host/path
// pairs as INVALID_ARGUMENT.
//
// Deprecation policy chosen: existing flat fields (`repoPath`, `worktreePath`,
// `cwd`, `nodeId`) remain accepted in v1.x as legacy inputs so adapters
// shipped before #626 do not break. Sending both `environment` and a flat
// `repoPath`/`worktreePath`/`cwd` is INVALID_ARGUMENT (callers must pick one).
// The legacy flat fields are documented as deprecated in `docs/CLI_GATEWAY.md`
// with target removal at the next major (v2). Raw `{ host, path }` (without
// typed IDs) is rejected.

import { describe, expect, it } from 'vitest';
import {
  RELAY_CLI_GATEWAY_CONTRACT,
  commandSpec,
} from '../../shared/cli-gateway-contract.js';
import { validateAndSanitizeGatewayCreateInput } from '../../shared/cli-gateway-runtime.js';
import {
  createRepoInstanceId,
  createWorktreeInstanceId,
} from '../../shared/identity.js';
import type { RepoIdentity } from '../../shared/identity.js';

const NODE_A = 'node-a';
const REPO_IDENTITY: RepoIdentity = 'github.com/donovan-yohan/relay-ide';
const REPO_INSTANCE_ID = createRepoInstanceId(NODE_A, '/Users/me/code/relay-ide');
const BENCH_ID = createWorktreeInstanceId(NODE_A, '/Users/me/code/relay-ide/.worktrees/626');
const REPO_CWD = '/Users/me/code/relay-ide';
const BENCH_CWD = '/Users/me/code/relay-ide/.worktrees/626';

describe('CLI gateway typed environment IDs (#626)', () => {
  describe('schema surface', () => {
    it('declares an environment object on sessions.create with typed IDs', () => {
      const create = commandSpec('sessions.create');
      const properties = create.inputSchema.properties ?? {};
      const environment = properties['environment'];
      expect(environment).toBeDefined();
      expect(environment?.type).toBe('object');
      expect(environment?.additionalProperties).toBe(false);
      expect(environment?.required).toEqual(expect.arrayContaining(['nodeId', 'cwd']));

      const envProps = environment?.properties ?? {};
      expect(envProps['nodeId']?.type).toBe('string');
      expect(envProps['cwd']?.type).toBe('string');
      expect(envProps['repoIdentity']).toBeDefined();
      expect(envProps['repoInstanceId']?.type).toBe('string');
      expect(envProps['benchId']?.type).toBe('string');
    });

    it('does NOT permit raw host/path identity pairs on the environment object', () => {
      const env = commandSpec('sessions.create').inputSchema.properties?.['environment'];
      const envProps = env?.properties ?? {};
      // Anti-regression: the typed shape must never grow a `host` field
      // (free-form host/path identity is exactly what #626 outlaws).
      expect(envProps['host']).toBeUndefined();
      expect(envProps['path']).toBeUndefined();
      // additionalProperties:false guards against silent host/path leakage.
      expect(env?.additionalProperties).toBe(false);
    });

    it('keeps INVALID_ARGUMENT in the create errorCodes for the new typed shape', () => {
      const create = commandSpec('sessions.create');
      expect(create.errorCodes).toContain('INVALID_ARGUMENT');
    });
  });

  describe('validation — typed environment accepted', () => {
    it('accepts a minimal typed environment (nodeId + cwd) without legacy fields', () => {
      const result = validateAndSanitizeGatewayCreateInput({
        environment: { nodeId: NODE_A, cwd: REPO_CWD },
        type: 'agent',
      });
      expect(result.ok).toBe(true);
      if (result.ok !== true) return;
      expect(result.nodeId).toBe(NODE_A);
      expect(result.input['environment']).toMatchObject({
        nodeId: NODE_A,
        cwd: REPO_CWD,
      });
      // The typed environment must not be silently rewritten back to the flat fields.
      expect(result.input['repoPath']).toBeUndefined();
    });

    it('accepts environment with repoIdentity + repoInstanceId + benchId', () => {
      const result = validateAndSanitizeGatewayCreateInput({
        environment: {
          nodeId: NODE_A,
          repoIdentity: REPO_IDENTITY,
          repoInstanceId: REPO_INSTANCE_ID,
          benchId: BENCH_ID,
          cwd: BENCH_CWD,
        },
        type: 'agent',
      });
      expect(result.ok).toBe(true);
      if (result.ok !== true) return;
      expect(result.input['environment']).toMatchObject({
        nodeId: NODE_A,
        repoIdentity: REPO_IDENTITY,
        repoInstanceId: REPO_INSTANCE_ID,
        benchId: BENCH_ID,
      });
    });

    it('accepts environment with repoIdentity: null (no canonical identity resolved)', () => {
      // Mirrors EnvironmentRepoInstanceSummary.repoIdentity, which is `string | null`
      // when remotes did not produce a canonical RepoIdentity. Adapters must be able
      // to round-trip the null signal without dropping the field.
      const result = validateAndSanitizeGatewayCreateInput({
        environment: {
          nodeId: NODE_A,
          repoIdentity: null,
          repoInstanceId: REPO_INSTANCE_ID,
          cwd: REPO_CWD,
        },
      });
      expect(result.ok).toBe(true);
      if (result.ok !== true) return;
      const env = result.input['environment'] as Record<string, unknown>;
      expect(env['repoIdentity']).toBeNull();
    });
  });

  describe('validation — raw host/path rejected', () => {
    it('rejects a raw { host, path } pair on the environment object', () => {
      const result = validateAndSanitizeGatewayCreateInput({
        environment: {
          host: 'devbox.local',
          path: '/srv/relay-ide',
          cwd: '/srv/relay-ide',
        },
      });
      expect(result.ok).toBe(false);
      if (result.ok !== false) return;
      expect(result.error.code).toBe('INVALID_ARGUMENT');
      expect(result.error.details?.['field']).toMatch(/environment/);
    });

    it('rejects environment missing nodeId (typed identity required)', () => {
      const result = validateAndSanitizeGatewayCreateInput({
        environment: { cwd: '/tmp/work' },
      });
      expect(result.ok).toBe(false);
      if (result.ok !== false) return;
      expect(result.error.code).toBe('INVALID_ARGUMENT');
      expect(result.error.details?.['field']).toMatch(/environment\.nodeId/);
    });

    it('rejects environment missing cwd', () => {
      const result = validateAndSanitizeGatewayCreateInput({
        environment: { nodeId: NODE_A },
      });
      expect(result.ok).toBe(false);
      if (result.ok !== false) return;
      expect(result.error.code).toBe('INVALID_ARGUMENT');
      expect(result.error.details?.['field']).toMatch(/environment\.cwd/);
    });

    it('rejects benchId without typed repo IDs (typed bench requires typed repo)', () => {
      const result = validateAndSanitizeGatewayCreateInput({
        environment: {
          nodeId: NODE_A,
          benchId: BENCH_ID,
          cwd: BENCH_CWD,
        },
      });
      expect(result.ok).toBe(false);
      if (result.ok !== false) return;
      expect(result.error.code).toBe('INVALID_ARGUMENT');
      expect(result.error.details?.['field']).toMatch(/environment\.benchId/);
    });

    it('rejects environment.repoIdentity as empty string (must be non-empty or null)', () => {
      const result = validateAndSanitizeGatewayCreateInput({
        environment: { nodeId: NODE_A, cwd: REPO_CWD, repoIdentity: '' },
      });
      expect(result.ok).toBe(false);
      if (result.ok !== false) return;
      expect(result.error.code).toBe('INVALID_ARGUMENT');
      expect(result.error.details?.['field']).toMatch(/environment\.repoIdentity/);
    });

    it('rejects environment.repoInstanceId as empty string', () => {
      const result = validateAndSanitizeGatewayCreateInput({
        environment: { nodeId: NODE_A, cwd: REPO_CWD, repoInstanceId: '' },
      });
      expect(result.ok).toBe(false);
      if (result.ok !== false) return;
      expect(result.error.code).toBe('INVALID_ARGUMENT');
      expect(result.error.details?.['field']).toMatch(/environment\.repoInstanceId/);
    });

    it('rejects environment.benchId as empty string', () => {
      const result = validateAndSanitizeGatewayCreateInput({
        environment: {
          nodeId: NODE_A,
          cwd: BENCH_CWD,
          repoIdentity: REPO_IDENTITY,
          benchId: '',
        },
      });
      expect(result.ok).toBe(false);
      if (result.ok !== false) return;
      expect(result.error.code).toBe('INVALID_ARGUMENT');
      expect(result.error.details?.['field']).toMatch(/environment\.benchId/);
    });
  });

  describe('deprecation policy', () => {
    it('still accepts legacy flat fields (repoPath, nodeId) for backward compat', () => {
      const result = validateAndSanitizeGatewayCreateInput({
        nodeId: NODE_A,
        repoPath: REPO_CWD,
      });
      expect(result.ok).toBe(true);
      if (result.ok !== true) return;
      expect(result.nodeId).toBe(NODE_A);
      expect(result.input['repoPath']).toBe(REPO_CWD);
    });

    it('rejects mixing typed environment with legacy flat repoPath/cwd', () => {
      const result = validateAndSanitizeGatewayCreateInput({
        environment: { nodeId: NODE_A, cwd: REPO_CWD },
        repoPath: REPO_CWD,
      });
      expect(result.ok).toBe(false);
      if (result.ok !== false) return;
      expect(result.error.code).toBe('INVALID_ARGUMENT');
      expect(result.error.details?.['field']).toMatch(/environment|repoPath/);
    });

    it('rejects mixing typed environment with legacy flat nodeId (must be supplied via environment only)', () => {
      const result = validateAndSanitizeGatewayCreateInput({
        environment: { nodeId: NODE_A, cwd: REPO_CWD },
        nodeId: NODE_A,
      });
      expect(result.ok).toBe(false);
      if (result.ok !== false) return;
      expect(result.error.code).toBe('INVALID_ARGUMENT');
    });

    it('rejects mixing typed environment with legacy worktreePath', () => {
      const result = validateAndSanitizeGatewayCreateInput({
        environment: { nodeId: NODE_A, cwd: BENCH_CWD },
        worktreePath: BENCH_CWD,
      });
      expect(result.ok).toBe(false);
      if (result.ok !== false) return;
      expect(result.error.code).toBe('INVALID_ARGUMENT');
    });
  });

  describe('contract manifest schema regression', () => {
    it('exposes the typed environment shape through the manifest', () => {
      const found = RELAY_CLI_GATEWAY_CONTRACT.commandSchemas.find(
        (entry) => entry.name === 'sessions.create'
      );
      expect(found).toBeDefined();
      const envSchema = found?.inputSchema.properties?.['environment'];
      expect(envSchema).toBeDefined();
      expect(envSchema?.title).toBe('CreateSessionEnvironment');
    });
  });

  describe('back-compat round-trip', () => {
    it('still validates the pre-#626 routed-create example body', () => {
      // Existing example from test/cli-gateway-contract.test.ts must continue to pass.
      const routedDefault = validateAndSanitizeGatewayCreateInput({
        nodeId: NODE_A,
        repoPath: '/tmp/repo',
      });
      expect(routedDefault.ok).toBe(true);
      if (routedDefault.ok !== true) return;
      expect(routedDefault.sessionType).toBe('agent');
    });

    it('still validates a clean local create body', () => {
      const clean = validateAndSanitizeGatewayCreateInput({
        repoPath: '/tmp/repo',
        worktreePath: null,
        type: 'terminal',
        cols: 120,
      });
      expect(clean.ok).toBe(true);
      if (clean.ok !== true) return;
      expect(clean.sessionType).toBe('terminal');
    });
  });
});
