import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ConfirmationRequiredError,
  createWorkspaceTopicRoomAndMaybeLaunch,
  createSession,
  fetchConfirmationRequesterToken,
  fetchNodeFsList,
  fetchWorkspaceEvidenceList,
  HttpError,
  killSession,
  launchWorkspaceTopicRoom,
  type ConfirmationChallenge,
} from '../frontend/src/lib/api.js';
import {
  clearConfirmationRetry,
  createConfirmationRetryRegistry,
  getConfirmationRetry,
} from '../frontend/src/lib/confirmation-retries.js';
import {
  buildWorkspaceTopicConflictDetails,
  workspaceTopicConflictMessage,
} from '../shared/workspace-topics.js';

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
      createSession({ repoPath: '/repo', type: 'terminal' })
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
      createSession({ repoPath: '/repo', type: 'terminal' })
    ).rejects.toBeInstanceOf(HttpError);
    await expect(
      createSession({ repoPath: '/repo', type: 'terminal' })
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
      createSession({ repoPath: '/repo', type: 'terminal' })
    ).rejects.toMatchObject({
      name: 'HttpError',
      status: 503,
      code: 'pty_capacity_exhausted',
      message:
        'Too many terminal sessions are already active. Close inactive sessions and try again.',
    });
  });

  it('creates task rooms without launching a session', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ workContext: { id: 'wc-topic' } }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            topic: {
              id: 'topic-task',
              workspaceId: 'ws-main',
              linkedRefs: { workContextIds: ['wc-topic'] },
            },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        )
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await createWorkspaceTopicRoomAndMaybeLaunch({
      room: {
        topic: { workspaceId: 'ws-main', title: 'Task room' },
        taskRef: { kind: 'github-issue', id: '1045' },
      },
    });

    expect(result).toMatchObject({
      status: 'created',
      topic: { id: 'topic-task' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/workspace-topics',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-relay-capabilities': 'context:write',
        }),
      })
    );
  });

  // #1287 slice 4: the composer sends an id it owns and reuses across retries,
  // so a 409 on the topic POST means THIS attempt already committed — a create
  // that lost its response, or a double submit. Adopt the row rather than let
  // the retry fork a second channel (the whole reason the id is client-owned).
  it('adopts the blocking row when a retried room create collides', async () => {
    const conflict = buildWorkspaceTopicConflictDetails({
      id: 'topic:owned',
      workspaceId: 'ws-main',
      status: 'active',
      title: 'Task room',
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ workContext: { id: 'wc-topic' } }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: 'SESSION_CONFLICT',
              message: workspaceTopicConflictMessage(conflict),
              retryable: false,
              details: conflict,
            },
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ topic: { id: 'topic:owned', title: 'Task room' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await createWorkspaceTopicRoomAndMaybeLaunch({
      room: {
        topic: { id: 'topic:owned', workspaceId: 'ws-main', title: 'T' },
      },
    });

    expect(result).toMatchObject({
      status: 'created',
      topic: { id: 'topic:owned' },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      '/workspace-topics/topic%3Aowned',
      expect.anything()
    );
  });

  it('surfaces an archived blocker instead of silently adopting it', async () => {
    const conflict = buildWorkspaceTopicConflictDetails({
      id: 'topic:owned',
      workspaceId: 'ws-main',
      status: 'archived',
      title: 'Task room',
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ workContext: { id: 'wc-topic' } }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: 'SESSION_CONFLICT',
              message: workspaceTopicConflictMessage(conflict),
              retryable: false,
              details: conflict,
            },
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } }
        )
      );
    vi.stubGlobal('fetch', fetchMock);

    // The operator archived that channel on purpose; the conflict message
    // already names restore as the way forward.
    await expect(
      createWorkspaceTopicRoomAndMaybeLaunch({
        room: {
          topic: { id: 'topic:owned', workspaceId: 'ws-main', title: 'T' },
        },
      })
    ).rejects.toMatchObject({
      stage: 'topic',
      status: 409,
      message: expect.stringContaining('restore that channel'),
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('launches terminals with WorkspaceTopic and WorkContext links', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ workContext: { id: 'wc-topic' } }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ topic: { id: 'topic-task' } }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'session-topic' }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await createWorkspaceTopicRoomAndMaybeLaunch({
      room: { topic: { workspaceId: 'ws-main', title: 'Task room' } },
      launch: { type: 'terminal', mode: 'pty' },
    });

    expect(result).toMatchObject({
      status: 'launched',
      topic: { id: 'topic-task' },
      workContext: { id: 'wc-topic' },
      session: { id: 'session-topic' },
    });
    expect(fetchMock).toHaveBeenLastCalledWith('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'terminal',
        mode: 'pty',
        workspaceTopicId: 'topic-task',
        workContextId: 'wc-topic',
      }),
    });
  });

  it('preserves the created room and returns typed launch failures', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ workContext: { id: 'wc-topic' } }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ topic: { id: 'topic-task' } }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: 'SESSION_LAUNCH_FAILED',
              message: 'terminal launch failed',
              retryable: true,
            },
          }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        )
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await createWorkspaceTopicRoomAndMaybeLaunch({
      room: { topic: { workspaceId: 'ws-main', title: 'Task room' } },
      launch: { type: 'terminal' },
    });

    expect(result).toMatchObject({
      status: 'launch_failed',
      topic: { id: 'topic-task' },
      workContext: { id: 'wc-topic' },
      failure: {
        stage: 'session',
        code: 'SESSION_LAUNCH_FAILED',
        message: 'terminal launch failed',
        retryable: true,
        status: 503,
      },
    });
  });

  it('retries launch against an existing topic room without recreating it', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: 'session-topic' }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await launchWorkspaceTopicRoom({
      room: {
        topic: { id: 'topic-task' } as never,
        workContext: { id: 'wc-topic' } as never,
      },
      launch: { type: 'terminal' },
    });

    expect(result).toMatchObject({
      status: 'launched',
      session: { id: 'session-topic' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'terminal',
        workspaceTopicId: 'topic-task',
        workContextId: 'wc-topic',
      }),
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
            JSON.stringify({
              confirmationToken: 'requester-token-1',
              challenge: approvedChallenge,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
      )
    );

    expect(
      approverRegistry.getConfirmationRetry('challenge-1')
    ).toBeUndefined();
    const pickup = await fetchConfirmationRequesterToken('challenge-1');
    await requesterRegistry.retryConfirmedOperation(
      pickup.challenge,
      pickup.confirmationToken
    );

    expect(fetch).toHaveBeenCalledWith(
      '/hub/confirmations/challenge-1/requester-token',
      {
        method: 'POST',
      }
    );
    expect(retry).toHaveBeenCalledWith('requester-token-1');
    expect(
      requesterRegistry.getConfirmationRetry('challenge-1')
    ).toBeUndefined();
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

    await createSession({
      repoPath: '/repo',
      type: 'terminal',
      sessionLane: 'local-repo',
    });

    expect(fetchMock).toHaveBeenCalledWith('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoPath: '/repo',
        type: 'terminal',
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

    await expect(
      killSession('remote-session-1', 'node-a')
    ).rejects.toBeInstanceOf(ConfirmationRequiredError);
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

  it('fetchNodeFsList → 404 throws HttpError with the right status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: 'NOT_FOUND', message: 'node is not paired' },
            }),
            {
              status: 404,
              headers: { 'Content-Type': 'application/json' },
            }
          )
      )
    );

    await expect(
      fetchNodeFsList({ nodeId: 'nodeB', sessionId: 's1', cwd: '/remote/repo' })
    ).rejects.toMatchObject({
      name: 'HttpError',
      status: 404,
    });
  });

  it('fetchNodeFsList → NODE_OFFLINE (503) throws retryable HttpError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: 'NODE_OFFLINE',
                message: 'node nodeB has no live reverse link',
                retryable: true,
              },
            }),
            {
              status: 503,
              headers: { 'Content-Type': 'application/json' },
            }
          )
      )
    );

    await expect(
      fetchNodeFsList({ nodeId: 'nodeB', sessionId: 's1', cwd: '/remote/repo' })
    ).rejects.toMatchObject({
      name: 'HttpError',
      status: 503,
      retryable: true,
    });
  });

  it('fetchNodeFsList POSTs to the correct session-scoped URL', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            operation: 'list',
            root: '/remote/repo',
            cwd: '/remote/repo',
            path: '/remote/repo',
            entries: [],
            truncated: false,
            maxEntries: 100,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchNodeFsList({
      nodeId: 'nodeB',
      sessionId: 's1',
      cwd: '/remote/repo',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/hub/nodes/nodeB/sessions/s1/files/list',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('preserves workspace evidence typed error state and reason on helper failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              operation: 'list',
              error: {
                state: 'offline',
                reason: 'WORKSPACE_EVIDENCE_NODE_OFFLINE',
                message: 'workspace evidence node is offline',
                nodeId: 'node_remote',
              },
            }),
            { status: 503, headers: { 'Content-Type': 'application/json' } }
          )
      )
    );

    await expect(
      fetchWorkspaceEvidenceList({
        rootRef: {
          id: 'wer:node_remote:%2Fhome%2Frelay',
          nodeId: 'node_remote',
          kind: 'directory',
        },
      })
    ).rejects.toMatchObject({
      name: 'HttpError',
      status: 503,
      code: 'WORKSPACE_EVIDENCE_NODE_OFFLINE',
      details: {
        state: 'offline',
        reason: 'WORKSPACE_EVIDENCE_NODE_OFFLINE',
        nodeId: 'node_remote',
      },
      workspaceEvidence: {
        error: { state: 'offline', reason: 'WORKSPACE_EVIDENCE_NODE_OFFLINE' },
      },
    });
  });
});
