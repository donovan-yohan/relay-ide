import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { handleSupervisorSessionsRequest } from '../server/supervisor-route-handlers.js';
import type { SessionSummary } from '../server/types.js';

function requestWithCapabilities(capabilities: string | undefined): Request {
  return {
    header: (name: string) => (name.toLowerCase() === 'x-relay-capabilities' ? capabilities : undefined),
  } as unknown as Request;
}

function jsonResponse(): Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const response = {
    status: vi.fn(function status(this: Response, _code: number) {
      return this;
    }),
    json: vi.fn(function json(this: Response, _body: unknown) {
      return this;
    }),
  };
  return response as unknown as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
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
    ...overrides,
  } as SessionSummary;
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
        details: expect.objectContaining({ capability: 'tab:intervention:read' }),
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
});
