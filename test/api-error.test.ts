import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ConfirmationRequiredError,
  createSession,
  fetchConfirmationRequesterToken,
  HttpError,
  killSession,
  type ConfirmationChallenge,
} from '../frontend/src/lib/api.js';
import {
  clearConfirmationRetry,
  createConfirmationRetryRegistry,
  getConfirmationRetry,
} from '../frontend/src/lib/confirmation-retries.js';

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

  it('posts selected remote cwd session creates to the hub route without local repo fields', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: 'remote-session-1' }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    await createSession({
      nodeId: 'node-a',
      cwd: '/home/relay/project',
      type: 'terminal',
      sessionLane: 'remote-cwd',
    });

    expect(fetchMock).toHaveBeenCalledWith('/hub/nodes/node-a/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cwd: '/home/relay/project',
        type: 'terminal',
        sessionLane: 'remote-cwd',
      }),
    });
  });

  it('registers confirmation retries with the exact original session-create params', async () => {
    const challenge = {
      challengeId: 'challenge-1',
      status: 'pending',
      nodeId: 'node-a',
      intent: { action: 'sessions.create', target: 'node-a' },
      requiredBits: ['session:create:terminal'],
      challengeBits: ['session:create:terminal'],
      canonicalParams: {
        action: 'sessions.create',
        type: 'terminal',
        cwd: '/home/relay/project',
      },
      canonicalParamsHash: 'hash-1',
      createdAt: '2026-05-16T00:00:00.000Z',
      expiresAt: '2026-05-16T00:05:00.000Z',
      failedRedemptions: 0,
      maxFailedRedemptions: 3,
      reasonCode: 'CONFIRMATION_REQUIRED',
      message: 'confirmation required',
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: 'CONFIRMATION_REQUIRED',
              message: 'confirmation required',
              retryable: false,
              details: { reasonCode: 'CONFIRMATION_REQUIRED', challenge },
            },
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'remote-session-1' }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createSession({
        nodeId: 'node-a',
        cwd: '/home/relay/project',
        type: 'terminal',
        sessionLane: 'remote-cwd',
      })
    ).rejects.toBeInstanceOf(ConfirmationRequiredError);

    const retry = getConfirmationRetry('challenge-1');
    expect(retry?.paramsHash).toBe('hash-1');
    await retry?.retry('token-1');

    expect(fetchMock).toHaveBeenLastCalledWith('/hub/nodes/node-a/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cwd: '/home/relay/project',
        type: 'terminal',
        sessionLane: 'remote-cwd',
        confirmationToken: 'token-1',
      }),
    });

    clearConfirmationRetry('challenge-1');
  });

  it('hands approved tokens to the requester registry, not the approver registry', async () => {
    const requesterRegistry = createConfirmationRetryRegistry();
    const approverRegistry = createConfirmationRetryRegistry();
    const approvedChallenge: ConfirmationChallenge = {
      challengeId: 'challenge-1',
      status: 'approved',
      nodeId: 'node-a',
      intent: { action: 'sessions.create', target: 'node-a' },
      requiredBits: ['session:create:terminal'],
      challengeBits: ['session:create:terminal'],
      canonicalParams: {
        action: 'sessions.create',
        type: 'terminal',
        cwd: '/home/relay/project',
      },
      canonicalParamsHash: 'hash-1',
      createdAt: '2026-05-16T00:00:00.000Z',
      expiresAt: '2026-05-16T00:05:00.000Z',
      approvedAt: '2026-05-16T00:01:00.000Z',
      tokenExpiresAt: '2026-05-16T00:02:00.000Z',
      failedRedemptions: 0,
      maxFailedRedemptions: 3,
      reasonCode: 'CONFIRMATION_APPROVED',
      message: 'confirmation approved',
    };
    const retry = vi.fn(async () => ({ id: 'remote-session-1' }));
    requesterRegistry.registerConfirmationRetry({
      challenge: approvedChallenge,
      label: 'sessions.create',
      paramsHash: 'hash-1',
      retry,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ confirmationToken: 'requester-token-1', challenge: approvedChallenge }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
      )
    );

    expect(approverRegistry.getConfirmationRetry('challenge-1')).toBeUndefined();
    const pickup = await fetchConfirmationRequesterToken('challenge-1');
    await requesterRegistry.retryConfirmedOperation(pickup.challenge, pickup.confirmationToken);

    expect(fetch).toHaveBeenCalledWith('/hub/confirmations/challenge-1/requester-token', {
      method: 'POST',
    });
    expect(retry).toHaveBeenCalledWith('requester-token-1');
    expect(requesterRegistry.getConfirmationRetry('challenge-1')).toBeUndefined();
  });

  it('preserves local session lane markers in create payloads', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: 'local-session-1' }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    await createSession({ repoPath: '/repo', type: 'agent', sessionLane: 'local-repo' });

    expect(fetchMock).toHaveBeenCalledWith('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoPath: '/repo',
        type: 'agent',
        sessionLane: 'local-repo',
      }),
    });
  });

  it('deletes selected remote node sessions through the hub route', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    await killSession('remote-session-1', 'node-a');

    expect(fetchMock).toHaveBeenCalledWith(
      '/hub/nodes/node-a/sessions/remote-session-1',
      { method: 'DELETE' }
    );
  });

  it('registers remote kill confirmation retries with the token header', async () => {
    const challenge = {
      challengeId: 'kill-challenge-1',
      status: 'pending',
      nodeId: 'node-a',
      intent: { action: 'sessions.kill', target: 'node-a' },
      requiredBits: ['session:attach'],
      challengeBits: ['session:attach'],
      sessionId: 'remote-session-1',
      canonicalParams: { action: 'sessions.kill', method: 'DELETE' },
      canonicalParamsHash: 'kill-hash-1',
      createdAt: '2026-05-16T00:00:00.000Z',
      expiresAt: '2026-05-16T00:05:00.000Z',
      failedRedemptions: 0,
      maxFailedRedemptions: 3,
      reasonCode: 'CONFIRMATION_REQUIRED',
      message: 'confirmation required',
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: 'CONFIRMATION_REQUIRED',
              message: 'confirmation required',
              retryable: false,
              details: { reasonCode: 'CONFIRMATION_REQUIRED', challenge },
            },
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(killSession('remote-session-1', 'node-a')).rejects.toBeInstanceOf(
      ConfirmationRequiredError
    );
    await getConfirmationRetry('kill-challenge-1')?.retry('kill-token-1');

    expect(fetchMock).toHaveBeenLastCalledWith(
      '/hub/nodes/node-a/sessions/remote-session-1',
      {
        method: 'DELETE',
        headers: { 'x-confirmation-token': 'kill-token-1' },
      }
    );

    clearConfirmationRetry('kill-challenge-1');
  });

  it('keeps local session delete on the local sessions route', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    await killSession('local-session-1');

    expect(fetchMock).toHaveBeenCalledWith('/sessions/local-session-1', {
      method: 'DELETE',
    });
  });

  it('preserves typed relay error bodies for remote session create failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: 'NODE_OFFLINE',
                message: 'node node-a has no live reverse link',
                retryable: true,
              },
            }),
            {
              status: 404,
              headers: { 'Content-Type': 'application/json' },
            }
          )
      )
    );

    await expect(
      createSession({ nodeId: 'node-a', repoPath: '/repo', type: 'terminal' })
    ).rejects.toMatchObject({
      name: 'HttpError',
      status: 404,
      code: 'NODE_OFFLINE',
      message: 'node node-a has no live reverse link',
      retryable: true,
    });
  });
});
