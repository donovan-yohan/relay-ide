import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import {
  handleSupervisorActionRequest,
  handleSupervisorSessionsRequest,
} from '../server/supervisor-route-handlers.js';
import type { SupervisorActionSessionBoundary } from '../server/supervisor-actions.js';
import type { Session, SessionSummary } from '../server/types.js';

function requestWithCapabilities(capabilities: string | undefined): Request {
  return {
    header: (name: string) =>
      name.toLowerCase() === 'x-relay-capabilities' ? capabilities : undefined,
  } as unknown as Request;
}

function supervisorActionRequest(input: {
  action?: string;
  body?: Record<string, unknown>;
  capabilities?: string;
}): Request {
  return {
    params: { action: input.action ?? 'sendText' },
    body: input.body ?? {},
    header: (name: string) =>
      name.toLowerCase() === 'x-relay-capabilities'
        ? input.capabilities
        : undefined,
  } as unknown as Request;
}

function jsonResponse(): Response & {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
} {
  const response = {
    status: vi.fn(function status(this: Response, _code: number) {
      return this;
    }),
    json: vi.fn(function json(this: Response, _body: unknown) {
      return this;
    }),
  };
  return response as unknown as Response & {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
  };
}

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'sess-1',
    globalSessionId: 'local:sess-1',
    nodeId: 'local',
    type: 'agent',
    agent: 'codex',
    mode: 'pty',
    cwd: '/repo',
    createdAt: '2026-05-16T00:00:00.000Z',
    lastActivity: '2026-05-16T00:00:00.000Z',
    idle: true,
    status: 'active',
    controlMode: 'agent-driven',
    controlFreshness: 'fresh',
    controlState: {
      controlMode: 'agent-driven',
      activeActors: [{ kind: 'agent', id: 'codex' }],
      activeWorker: { kind: 'agent', id: 'codex' },
      lastInterventionAt: null,
      lastInterventionBy: null,
      lastInterventionEventId: null,
      controlFreshness: 'fresh',
    },
    ...overrides,
  } as SessionSummary;
}

function supervisorBoundary(
  sessions: Record<string, SessionSummary> = { 'sess-1': session() }
): SupervisorActionSessionBoundary & {
  supervisorWrite: ReturnType<typeof vi.fn>;
} {
  const supervisorWrite = vi.fn((id: string, input: { payload: string }) => ({
    eventId: `evt-${id}-${input.payload.length}`,
    modeBefore: 'agent-driven' as const,
    modeAfter: 'co-driven' as const,
  }));
  return {
    list: () => Object.values(sessions),
    get: (id: string) => sessions[id] as Session | undefined,
    supervisorWrite,
  };
}

describe('supervisor route handlers', () => {
  it('requires session:read and tab:intervention:read before listing supervisor sessions', () => {
    const sessions = { list: vi.fn(() => [session()]) };
    const res = jsonResponse();

    handleSupervisorSessionsRequest(
      requestWithCapabilities('session:read'),
      res,
      sessions
    );

    expect(sessions.list).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: expect.objectContaining({
        code: 'FORBIDDEN',
        reasonCode: 'CAPABILITY_REQUIRED',
        details: expect.objectContaining({
          capability: 'tab:intervention:read',
        }),
      }),
    });
  });

  it('lists supervisor sessions when both read capabilities are present', () => {
    const sessions = { list: vi.fn(() => [session()]) };
    const res = jsonResponse();

    handleSupervisorSessionsRequest(
      requestWithCapabilities('session:read,tab:intervention:read'),
      res,
      sessions
    );

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'supervisor.sessions', count: 1 })
    );
  });

  it('rejects supervisor action requests with both id and targetIds before writing', () => {
    const sessions = supervisorBoundary();
    const res = jsonResponse();

    handleSupervisorActionRequest(
      supervisorActionRequest({
        body: { id: 'sess-1', targetIds: ['sess-1'], text: 'hello' },
        capabilities: 'session:attach,tab:intervention:send-text',
      }),
      res,
      sessions
    );

    expect(sessions.supervisorWrite).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: expect.objectContaining({
        code: 'INVALID_ARGUMENT',
        reasonCode: 'TARGET_SELECTOR_INVALID',
      }),
    });
  });

  it('rejects supervisor action requests with no selector before writing', () => {
    const sessions = supervisorBoundary();
    const res = jsonResponse();

    handleSupervisorActionRequest(
      supervisorActionRequest({
        body: { text: 'hello' },
        capabilities: 'session:attach,tab:intervention:send-text',
      }),
      res,
      sessions
    );

    expect(sessions.supervisorWrite).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: expect.objectContaining({
        code: 'INVALID_ARGUMENT',
        reasonCode: 'TARGET_SELECTOR_REQUIRED',
      }),
    });
  });

  it.each([
    { targetIds: [], label: 'empty' },
    { targetIds: ['sess-1', ''], label: 'blank string' },
    { targetIds: ['sess-1', 7], label: 'non-string' },
    { targetIds: 'sess-1', label: 'non-array' },
  ])('rejects $label targetIds before writing', ({ targetIds }) => {
    const sessions = supervisorBoundary();
    const res = jsonResponse();

    handleSupervisorActionRequest(
      supervisorActionRequest({
        body: { targetIds, text: 'hello' },
        capabilities: 'session:attach,tab:intervention:send-text',
      }),
      res,
      sessions
    );

    expect(sessions.supervisorWrite).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: expect.objectContaining({
        code: 'INVALID_ARGUMENT',
        reasonCode: 'TARGET_SELECTOR_INVALID',
      }),
    });
  });

  it('denies missing supervisor action capability evidence before writing', () => {
    const sessions = supervisorBoundary();
    const res = jsonResponse();

    handleSupervisorActionRequest(
      supervisorActionRequest({ body: { id: 'sess-1', text: 'hello' } }),
      res,
      sessions
    );

    expect(sessions.supervisorWrite).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: expect.objectContaining({
        code: 'FORBIDDEN',
        reasonCode: 'CAPABILITY_REQUIRED',
        details: expect.objectContaining({
          capability: 'tab:intervention:send-text',
        }),
      }),
    });
  });

  it('preserves multi-target partial-failure semantics for valid supervisor action requests', () => {
    const sessions = supervisorBoundary({
      'sess-1': session({ id: 'sess-1' }),
      'sess-2': session({ id: 'sess-2' }),
    });
    sessions.supervisorWrite.mockImplementation(
      (id: string, input: { payload: string }) => {
        if (id === 'sess-2') throw new Error('pty is gone');
        return {
          eventId: `evt-${id}-${input.payload.length}`,
          modeBefore: 'agent-driven' as const,
          modeAfter: 'co-driven' as const,
        };
      }
    );
    const res = jsonResponse();

    handleSupervisorActionRequest(
      supervisorActionRequest({
        body: { targetIds: ['sess-1', 'sess-2'], text: 'hello' },
        capabilities: 'session:attach,tab:intervention:send-text',
      }),
      res,
      sessions
    );

    expect(sessions.supervisorWrite).toHaveBeenCalledTimes(2);
    expect(sessions.supervisorWrite).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({ action: 'sendText', payload: 'hello' })
    );
    expect(sessions.supervisorWrite).toHaveBeenCalledWith(
      'sess-2',
      expect.objectContaining({ action: 'sendText', payload: 'hello' })
    );
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'supervisor.sendText',
        counts: {
          requested: 2,
          succeeded: 1,
          denied: 0,
          failed: 1,
          skipped: 0,
        },
      })
    );
  });
});
