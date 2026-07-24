import { describe, expect, it, vi } from 'vitest';

import {
  OrchestratorPeer,
  TokenManager,
  abortableDelay,
  buildAckText,
  needsRemint,
  selectNewMessages,
  type FetchLike,
  type PeerConfig,
} from '../scripts/orchestrator-peer.js';
import type {
  ChannelMessage,
  ChannelMessageId,
} from '../shared/channel-chat-protocol.js';

const CONFIG: PeerConfig = {
  baseUrl: 'http://relay.test/',
  pin: 'test-pin',
  actorId: 'echo-peer',
  displayName: 'Echo Peer',
  role: 'orchestrator',
  productChannelId: 'topic:general',
  capabilities: ['session:read', 'context:read', 'context:write'],
  renewable: true,
  pollIntervalMs: 10,
};

function message(
  seq: number,
  senderId: string,
  text = 'hello'
): ChannelMessage {
  return {
    schemaVersion: 1,
    id: `chm:${seq}` as ChannelMessageId,
    channelId: CONFIG.productChannelId,
    seq,
    kind: 'message',
    status: 'complete',
    sender: {
      kind: senderId.startsWith('agent:') ? 'agent' : 'human',
      id: senderId,
    },
    body: { text, format: 'markdown' },
    threadId: null,
    parentMessageId: null,
    createdAt: '2026-07-24T00:00:00.000Z',
    updatedAt: '2026-07-24T00:00:00.000Z',
  };
}

function jsonResponse(
  body: unknown,
  init: ResponseInit = { status: 200 }
): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

function minted(token: string): Response {
  return jsonResponse(
    {
      token,
      credential: {
        issuedAt: '2026-07-24T00:00:00.000Z',
        expiresAt: '2026-07-24T00:05:00.000Z',
      },
    },
    { status: 201 }
  );
}

describe('orchestrator peer pure seams', () => {
  it('selectNewMessages skips own posts, advances seq, and emits acks for others', () => {
    const selection = selectNewMessages(
      [
        message(4, 'agent:echo-peer'),
        message(3, 'human:operator'),
        message(2, 'human:old'),
      ],
      2,
      'agent:echo-peer'
    );

    expect(selection).toEqual({
      acks: [
        {
          seq: 3,
          text: 'orchestrator online — ack seq 3 from human:operator',
        },
      ],
      nextSeq: 4,
    });
    expect(buildAckText(message(7, 'agent:worker'))).toBe(
      'orchestrator online — ack seq 7 from agent:worker'
    );
  });

  it('needsRemint fires inside the refresh window', () => {
    expect(needsRemint(300_000, 199_999, 2 / 3)).toBe(false);
    expect(needsRemint(300_000, 200_000, 2 / 3)).toBe(true);
    expect(needsRemint(300_000, 299_999, 1)).toBe(false);
    expect(needsRemint(300_000, 300_000, 1)).toBe(true);
  });

  it('abortableDelay removes listeners on timeout and clears timers on abort', async () => {
    vi.useFakeTimers();
    try {
      const timed = new AbortController();
      const removeTimed = vi.spyOn(timed.signal, 'removeEventListener');
      const completed = abortableDelay(100, timed.signal);
      await vi.advanceTimersByTimeAsync(100);
      await completed;

      expect(removeTimed).toHaveBeenCalledWith('abort', expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);

      const aborted = new AbortController();
      const interrupted = abortableDelay(100, aborted.signal);
      expect(vi.getTimerCount()).toBe(1);
      aborted.abort();
      await interrupted;

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('orchestrator peer gateway cycle', () => {
  it('runs mint, poll, and one post with exact gateway headers and no self ack', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi.fn<FetchLike>(async (input, init = {}) => {
      const url = input.toString();
      calls.push({ url, init });
      if (url.endsWith('/auth')) {
        return jsonResponse(
          { ok: true },
          { headers: { 'set-cookie': 'token=browser-cookie; HttpOnly' } }
        );
      }
      if (url.endsWith('/cli-gateway/actor-credentials')) {
        return minted('relay-sac-v1.first');
      }
      if (url.includes('?afterSeq=0&limit=100')) {
        return jsonResponse({
          messages: [
            message(1, 'human:operator'),
            message(2, 'agent:echo-peer'),
          ],
        });
      }
      if (url.endsWith('/channels/topic%3Ageneral/messages')) {
        return jsonResponse(
          { message: message(3, 'agent:echo-peer') },
          { status: 201 }
        );
      }
      return new Response(null, { status: 404 });
    });

    const peer = new OrchestratorPeer(CONFIG, fetchMock, () =>
      Date.parse('2026-07-24T00:00:00.000Z')
    );
    await expect(peer.pollOnce()).resolves.toEqual({
      ackCount: 1,
      lastSeq: 2,
    });

    expect(calls).toHaveLength(4);
    const authBody = JSON.parse(String(calls[0]?.init.body)) as unknown;
    expect(authBody).toEqual({ pin: 'test-pin' });
    const mintBody = JSON.parse(String(calls[1]?.init.body)) as Record<
      string,
      unknown
    >;
    expect(mintBody).toEqual({
      capabilities: CONFIG.capabilities,
      actor: {
        type: 'agent',
        id: 'echo-peer',
        displayName: 'Echo Peer',
      },
    });
    expect(mintBody).not.toHaveProperty('scope');
    expect(new Headers(calls[1]?.init.headers).get('cookie')).toBe(
      'token=browser-cookie'
    );

    const gatewayCalls = calls.slice(2);
    expect(gatewayCalls).toHaveLength(2);
    for (const call of gatewayCalls) {
      const headers = new Headers(call.init.headers);
      expect(headers.get('authorization')).toBe('Bearer relay-sac-v1.first');
      expect(headers.get('x-relay-cli-gateway')).toBe('v1');
    }
    expect(
      new Headers(gatewayCalls[0]?.init.headers).get('x-relay-cli-command')
    ).toBe('channels.history');
    expect(
      new Headers(gatewayCalls[1]?.init.headers).get('x-relay-cli-command')
    ).toBe('channels.post');
    expect(JSON.parse(String(gatewayCalls[1]?.init.body))).toEqual({
      text: 'orchestrator online — ack seq 1 from human:operator',
    });
  });

  it('re-mints once and retries a gateway 401', async () => {
    let mintCount = 0;
    let gatewayCount = 0;
    const gatewayHeaders: Headers[] = [];
    const fetchMock = vi.fn<FetchLike>(async (input, init) => {
      const url = input.toString();
      if (url.endsWith('/auth')) {
        return jsonResponse(
          { ok: true },
          { headers: { 'set-cookie': 'token=browser-cookie; HttpOnly' } }
        );
      }
      if (url.endsWith('/cli-gateway/actor-credentials')) {
        mintCount += 1;
        return minted(`relay-sac-v1.token-${mintCount}`);
      }
      gatewayCount += 1;
      gatewayHeaders.push(new Headers(init?.headers));
      return gatewayCount === 1
        ? new Response(null, { status: 401 })
        : jsonResponse({ messages: [] });
    });

    const manager = new TokenManager(CONFIG, fetchMock, () =>
      Date.parse('2026-07-24T00:00:00.000Z')
    );
    const response = await manager.gatewayFetch(
      'http://relay.test/channels/topic%3Ageneral/messages',
      'channels.history'
    );

    expect(response.status).toBe(200);
    expect(mintCount).toBe(2);
    expect(gatewayCount).toBe(2);
    expect(
      gatewayHeaders.map((headers) => ({
        authorization: headers.get('authorization'),
        gateway: headers.get('x-relay-cli-gateway'),
        command: headers.get('x-relay-cli-command'),
      }))
    ).toEqual([
      {
        authorization: 'Bearer relay-sac-v1.token-1',
        gateway: 'v1',
        command: 'channels.history',
      },
      {
        authorization: 'Bearer relay-sac-v1.token-2',
        gateway: 'v1',
        command: 'channels.history',
      },
    ]);
  });
});
