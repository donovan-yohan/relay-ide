import { afterEach, describe, expect, it, vi } from 'vitest';
import { killSession } from '../frontend/src/lib/api.js';
import { resolveWorkspaceSessionCloseTarget } from '../frontend/src/lib/workspace-session-close.js';
import type { WorkspaceTab } from '../frontend/src/lib/workspace-layout.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

function stubSuccessfulFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
    jsonResponse({ ok: true })
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('resolveWorkspaceSessionCloseTarget', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses a remote workspace tab nodeId when the sessions store is empty', async () => {
    const fetchMock = stubSuccessfulFetch();
    const tabs: WorkspaceTab[] = [
      {
        kind: 'session',
        sessionId: 'node-a:remote-session-1',
        sessionType: 'terminal',
        nodeId: 'node-a',
      },
    ];

    const target = resolveWorkspaceSessionCloseTarget(
      tabs,
      'session::node-a:remote-session-1',
      []
    );

    expect(target).toEqual({
      sessionId: 'remote-session-1',
      nodeId: 'node-a',
    });

    await killSession(target!.sessionId, target!.nodeId);

    expect(fetchMock).toHaveBeenCalledWith(
      '/hub/nodes/node-a/sessions/remote-session-1',
      { method: 'DELETE' }
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/sessions/node-a%3Aremote-session-1',
      expect.anything()
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/sessions/node-a:remote-session-1',
      expect.anything()
    );
  });

  it('preserves local tab close routing when the tab has no nodeId', async () => {
    const fetchMock = stubSuccessfulFetch();
    const tabs: WorkspaceTab[] = [
      {
        kind: 'session',
        sessionId: 'local-session-1',
        sessionType: 'agent',
      },
    ];

    const target = resolveWorkspaceSessionCloseTarget(
      tabs,
      'session::local-session-1',
      []
    );

    expect(target).toEqual({ sessionId: 'local-session-1' });

    await killSession(target!.sessionId, target!.nodeId);

    expect(fetchMock).toHaveBeenCalledWith('/sessions/local-session-1', {
      method: 'DELETE',
    });
  });
});
