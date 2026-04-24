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
});
