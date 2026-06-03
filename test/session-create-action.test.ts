import { describe, expect, it } from 'vitest';
import {
  executeSessionCreateAction,
  sessionCreateActionAvailability,
  sessionCreateActionDescriptor,
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

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'sess-1',
    globalSessionId: 'remote-1:sess-1',
    nodeId: 'remote-1',
    type: 'terminal',
    mode: 'pty',
    cwd: '/home/me/repo',
    repoPath: '/home/me/repo',
    worktreePath: null,
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
    expect(descriptor.error.kind).toBe('typed-shape');
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

  it('executes a web launch through the shared action path with typed success target', async () => {
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
      command: 'sessions.create',
      target: {
        sessionId: 'sess-1',
        globalSessionId: 'remote-1:sess-1',
        nodeId: 'remote-1',
        cwd: '/home/me/repo',
        repoPath: '/home/me/repo',
        worktreePath: null,
        type: 'terminal',
        mode: 'pty',
      },
    });
    expect(result.descriptor.contract?.relayCommandName).toBe('sessions.create');
  });

  it('normalizes launch failures into a stable typed error envelope', async () => {
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
      command: 'sessions.create',
      target: {
        nodeId: 'remote-1',
        cwd: '/home/me/repo',
        type: 'terminal',
      },
      error: {
        code: 'NODE_OFFLINE',
        reasonCode: 'NODE_OFFLINE',
        message: 'node is offline',
        retryable: true,
        details: { nodeId: 'remote-1' },
      },
    });
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
