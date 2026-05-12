import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSession, HttpError } from '../frontend/src/lib/api.js';

describe('frontend api errors', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps 502 responses to a user-facing backend unavailable error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response('', { status: 502, statusText: 'Bad Gateway' })
      )
    );

    await expect(
      createSession({ repoPath: '/repo', type: 'agent' })
    ).rejects.toMatchObject({
      name: 'HttpError',
      status: 502,
      message:
        'Relay backend is unavailable (HTTP 502). The server may be restarting; try again in a moment.',
    });
  });

  it('keeps structured HTTP status on non-502 failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('', { status: 503, statusText: 'Service Unavailable' })
      )
    );

    await expect(
      createSession({ repoPath: '/repo', type: 'agent' })
    ).rejects.toBeInstanceOf(HttpError);
    await expect(
      createSession({ repoPath: '/repo', type: 'agent' })
    ).rejects.toMatchObject({
      status: 503,
      message:
        'Relay backend is unavailable (HTTP 503). Try again in a moment.',
    });
  });

  it('uses structured session capacity messages from the server', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: 'pty_capacity_exhausted',
              message:
                'Too many terminal sessions are already active. Close inactive sessions and try again.',
            }),
            {
              status: 503,
              headers: { 'Content-Type': 'application/json' },
            }
          )
      )
    );

    await expect(
      createSession({ repoPath: '/repo', type: 'agent' })
    ).rejects.toMatchObject({
      name: 'HttpError',
      status: 503,
      code: 'pty_capacity_exhausted',
      message:
        'Too many terminal sessions are already active. Close inactive sessions and try again.',
    });
  });

  it('posts selected remote node session creates to the hub route without leaking nodeId to the node payload', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: 'remote-session-1' }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    await createSession({ nodeId: 'node-a', repoPath: '/repo', type: 'terminal' });

    expect(fetchMock).toHaveBeenCalledWith('/hub/nodes/node-a/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath: '/repo', type: 'terminal' }),
    });
  });
});
