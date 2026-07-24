import { describe, expect, it, vi } from 'vitest';

import {
  OrchestratorPeer,
  TokenManager,
  abortableDelay,
  buildAckText,
  buildInstruction,
  buildRollup,
  buildWorkerMention,
  needsRemint,
  readPeerConfig,
  selectNewMessages,
  type FetchLike,
  type PeerConfig,
} from '../scripts/orchestrator-peer.js';
import {
  parseMentions,
  type ChannelMessage,
  type ChannelMessageId,
} from '../shared/channel-chat-protocol.js';

const CONFIG: PeerConfig = {
  baseUrl: 'http://relay.test/',
  pin: 'test-pin',
  actorId: 'echo-peer',
  displayName: 'Echo Peer',
  role: 'orchestrator',
  productChannelId: 'topic:general',
  implChannelId: 'topic:implementation',
  workerFramework: 'codex',
  capabilities: ['session:read', 'context:read', 'context:write'],
  renewable: true,
  pollIntervalMs: 10,
};

function message(
  seq: number,
  senderId: string,
  text = 'hello',
  channelId = CONFIG.productChannelId,
  status: ChannelMessage['status'] = 'complete'
): ChannelMessage {
  return {
    schemaVersion: 1,
    id: `chm:${seq}` as ChannelMessageId,
    channelId,
    seq,
    kind: 'message',
    status,
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

  it('holds the cursor on a still-streaming message and relays it once complete', () => {
    // A live worker reply begins as a streaming, empty-bodied message. The peer
    // must NOT relay it yet, and must NOT advance past it (else the finalized
    // text is lost) — the failure the 4c live proof surfaced (empty rollup).
    const streaming = selectNewMessages(
      [message(2, 'agent:worker', '', CONFIG.implChannelId, 'streaming')],
      1,
      'agent:echo-peer'
    );
    expect(streaming.acks).toEqual([]);
    expect(streaming.nextSeq).toBe(1); // cursor held BEFORE the streaming msg

    // Next poll: the same message has finalized → relayed exactly once, advanced.
    const completed = selectNewMessages(
      [
        message(
          2,
          'agent:worker',
          'WORKER_OK',
          CONFIG.implChannelId,
          'complete'
        ),
      ],
      1,
      'agent:echo-peer'
    );
    expect(completed.acks).toEqual([
      { seq: 2, text: 'orchestrator online — ack seq 2 from agent:worker' },
    ]);
    expect(completed.nextSeq).toBe(2);

    // A terminal 'failed' reply carries no useful text: advance past, no relay.
    const failed = selectNewMessages(
      [message(3, 'agent:worker', '', CONFIG.implChannelId, 'failed')],
      2,
      'agent:echo-peer'
    );
    expect(failed.acks).toEqual([]);
    expect(failed.nextSeq).toBe(3);

    // 'truncated' (size-capped but final) IS relayed — it carries real content.
    const truncated = selectNewMessages(
      [message(4, 'agent:worker', 'partial reply', CONFIG.implChannelId, 'truncated')],
      3,
      'agent:echo-peer'
    );
    expect(truncated.acks).toEqual([
      { seq: 4, text: 'orchestrator online — ack seq 4 from agent:worker' },
    ]);
    expect(truncated.nextSeq).toBe(4);

    // A terminal 'interrupted' reply is advanced past without relay (like failed).
    const interrupted = selectNewMessages(
      [message(5, 'agent:worker', 'cut off', CONFIG.implChannelId, 'interrupted')],
      4,
      'agent:echo-peer'
    );
    expect(interrupted.acks).toEqual([]);
    expect(interrupted.nextSeq).toBe(5);
  });

  it('builds canned instruction and rollup text', () => {
    expect(buildInstruction(message(1, 'human:operator', 'ship it'))).toBe(
      'instruction (relayed from product): ship it'
    );
    expect(buildRollup(message(2, 'agent:worker', 'done'))).toBe(
      'rollup (from impl): done'
    );
  });

  it('builds a worker mention recognized as the configured framework', () => {
    const text = buildWorkerMention(
      'codex',
      message(1, 'human:operator', 'ship it')
    );

    expect(parseMentions(text, ['codex'])).toEqual([
      { raw: '@codex', providerId: 'codex' },
    ]);
  });

  it('reads channel ids and worker framework from args or environment', () => {
    const fromEnvironment = readPeerConfig({
      RELAY_PEER_PIN: 'environment-pin',
      RELAY_PEER_CHANNEL_ID: 'topic:product-environment',
      RELAY_PEER_IMPL_CHANNEL_ID: 'topic:impl-environment',
      RELAY_PEER_WORKER_FRAMEWORK: 'claude',
    });
    expect(fromEnvironment.productChannelId).toBe(
      'topic:product-environment'
    );
    expect(fromEnvironment.implChannelId).toBe('topic:impl-environment');
    expect(fromEnvironment.workerFramework).toBe('claude');

    const fromArgs = readPeerConfig(
      {
        RELAY_PEER_PIN: 'environment-pin',
        RELAY_PEER_CHANNEL_ID: 'topic:product-environment',
        RELAY_PEER_IMPL_CHANNEL_ID: 'topic:impl-environment',
      },
      [
        '--pin',
        'argument-pin',
        '--channel',
        'topic:product-argument',
        '--impl-channel',
        'topic:impl-argument',
        '--worker-framework',
        'codex-argument',
      ]
    );
    expect(fromArgs.pin).toBe('argument-pin');
    expect(fromArgs.productChannelId).toBe('topic:product-argument');
    expect(fromArgs.implChannelId).toBe('topic:impl-argument');
    expect(fromArgs.workerFramework).toBe('codex-argument');

    const withDefault = readPeerConfig({
      RELAY_PEER_PIN: 'environment-pin',
      RELAY_PEER_CHANNEL_ID: 'topic:product-environment',
      RELAY_PEER_IMPL_CHANNEL_ID: 'topic:impl-environment',
    });
    expect(withDefault.workerFramework).toBe('codex');
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
  it('relays a product message as one worker mention into impl with exact gateway recipe', async () => {
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
      if (
        url.endsWith(
          '/channels/topic%3Ageneral/messages?afterSeq=0&limit=100'
        )
      ) {
        return jsonResponse({
          messages: [message(1, 'human:operator', 'build feature')],
        });
      }
      if (
        url.endsWith(
          '/channels/topic%3Aimplementation/messages?afterSeq=0&limit=100'
        )
      ) {
        return jsonResponse({ messages: [] });
      }
      if (url.endsWith('/channels/topic%3Aimplementation/messages')) {
        return jsonResponse(
          {
            message: message(
              1,
              'agent:echo-peer',
              '@codex build feature',
              CONFIG.implChannelId
            ),
          },
          { status: 201 }
        );
      }
      return new Response(null, { status: 404 });
    });

    const peer = new OrchestratorPeer(CONFIG, fetchMock, () =>
      Date.parse('2026-07-24T00:00:00.000Z')
    );
    await expect(peer.pollOnce()).resolves.toEqual({
      instructionCount: 1,
      rollupCount: 0,
      productLastSeq: 1,
      implLastSeq: 0,
    });

    expect(calls).toHaveLength(5);
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
    expect(gatewayCalls).toHaveLength(3);
    for (const call of gatewayCalls) {
      const headers = new Headers(call.init.headers);
      expect(headers.get('authorization')).toBe('Bearer relay-sac-v1.first');
      expect(headers.get('x-relay-cli-gateway')).toBe('v1');
    }
    expect(gatewayCalls[0]?.url).toBe(
      'http://relay.test/channels/topic%3Ageneral/messages?afterSeq=0&limit=100'
    );
    expect(
      new Headers(gatewayCalls[0]?.init.headers).get('x-relay-cli-command')
    ).toBe('channels.history');
    expect(gatewayCalls[1]?.url).toBe(
      'http://relay.test/channels/topic%3Aimplementation/messages'
    );
    expect(gatewayCalls[1]?.init.method).toBe('POST');
    expect(
      new Headers(gatewayCalls[1]?.init.headers).get('x-relay-cli-command')
    ).toBe('channels.post');
    expect(
      new Headers(gatewayCalls[1]?.init.headers).get('content-type')
    ).toBe('application/json');
    expect(JSON.parse(String(gatewayCalls[1]?.init.body))).toEqual({
      text: '@codex build feature',
    });
    expect(gatewayCalls[2]?.url).toBe(
      'http://relay.test/channels/topic%3Aimplementation/messages?afterSeq=0&limit=100'
    );
    expect(
      new Headers(gatewayCalls[2]?.init.headers).get('x-relay-cli-command')
    ).toBe('channels.history');
  });

  it('relays an impl message as one rollup into product', async () => {
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
      if (
        url.endsWith(
          '/channels/topic%3Ageneral/messages?afterSeq=0&limit=100'
        )
      ) {
        return jsonResponse({ messages: [] });
      }
      if (
        url.endsWith(
          '/channels/topic%3Aimplementation/messages?afterSeq=0&limit=100'
        )
      ) {
        return jsonResponse({
          messages: [
            message(
              4,
              'agent:worker',
              'implementation complete',
              CONFIG.implChannelId
            ),
          ],
        });
      }
      if (url.endsWith('/channels/topic%3Ageneral/messages')) {
        return jsonResponse(
          {
            message: message(
              1,
              'agent:echo-peer',
              'rollup (from impl): implementation complete'
            ),
          },
          { status: 201 }
        );
      }
      return new Response(null, { status: 404 });
    });

    const peer = new OrchestratorPeer(CONFIG, fetchMock, () =>
      Date.parse('2026-07-24T00:00:00.000Z')
    );
    await expect(peer.pollOnce()).resolves.toEqual({
      instructionCount: 0,
      rollupCount: 1,
      productLastSeq: 0,
      implLastSeq: 4,
    });

    const gatewayCalls = calls.slice(2);
    expect(gatewayCalls).toHaveLength(3);
    const post = gatewayCalls[2];
    expect(post?.url).toBe(
      'http://relay.test/channels/topic%3Ageneral/messages'
    );
    expect(post?.init.method).toBe('POST');
    const headers = new Headers(post?.init.headers);
    expect(headers.get('authorization')).toBe('Bearer relay-sac-v1.first');
    expect(headers.get('x-relay-cli-gateway')).toBe('v1');
    expect(headers.get('x-relay-cli-command')).toBe('channels.post');
    expect(headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(String(post?.init.body))).toEqual({
      text: 'rollup (from impl): implementation complete',
    });
  });

  it('self-skips its own worker mention in impl without cross-channel ping-pong', async () => {
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
      if (
        url.endsWith(
          '/channels/topic%3Ageneral/messages?afterSeq=0&limit=100'
        )
      ) {
        return jsonResponse({
          messages: [message(3, 'agent:echo-peer', 'own rollup')],
        });
      }
      if (
        url.endsWith(
          '/channels/topic%3Aimplementation/messages?afterSeq=0&limit=100'
        )
      ) {
        return jsonResponse({
          messages: [
            message(
              7,
              'agent:echo-peer',
              '@codex build feature',
              CONFIG.implChannelId
            ),
          ],
        });
      }
      if (url.includes('/channels/') && url.includes('/messages?afterSeq=')) {
        return jsonResponse({ messages: [] });
      }
      return new Response(null, { status: 404 });
    });

    const peer = new OrchestratorPeer(CONFIG, fetchMock, () =>
      Date.parse('2026-07-24T00:00:00.000Z')
    );
    await expect(peer.pollOnce()).resolves.toEqual({
      instructionCount: 0,
      rollupCount: 0,
      productLastSeq: 3,
      implLastSeq: 7,
    });
    await expect(peer.pollOnce()).resolves.toEqual({
      instructionCount: 0,
      rollupCount: 0,
      productLastSeq: 3,
      implLastSeq: 7,
    });

    const channelPosts = calls.filter(
      (call) =>
        call.url.includes('/channels/') &&
        call.init.method?.toUpperCase() === 'POST'
    );
    expect(channelPosts).toEqual([]);
  });

  it('advances product and impl cursors independently', async () => {
    const historyUrls: string[] = [];
    let productPoll = 0;
    const fetchMock = vi.fn<FetchLike>(async (input) => {
      const url = input.toString();
      if (url.endsWith('/auth')) {
        return jsonResponse(
          { ok: true },
          { headers: { 'set-cookie': 'token=browser-cookie; HttpOnly' } }
        );
      }
      if (url.endsWith('/cli-gateway/actor-credentials')) {
        return minted('relay-sac-v1.first');
      }
      historyUrls.push(url);
      if (url.includes('/channels/topic%3Ageneral/')) {
        productPoll += 1;
        return jsonResponse({
          messages:
            productPoll === 1
              ? [message(5, 'agent:echo-peer')]
              : [message(6, 'agent:echo-peer')],
        });
      }
      if (url.includes('/channels/topic%3Aimplementation/')) {
        return jsonResponse({
          messages:
            historyUrls.length === 2
              ? [
                  message(
                    2,
                    'agent:echo-peer',
                    'own instruction',
                    CONFIG.implChannelId
                  ),
                ]
              : [],
        });
      }
      return new Response(null, { status: 404 });
    });

    const peer = new OrchestratorPeer(CONFIG, fetchMock, () =>
      Date.parse('2026-07-24T00:00:00.000Z')
    );
    await peer.pollOnce();
    await expect(peer.pollOnce()).resolves.toMatchObject({
      productLastSeq: 6,
      implLastSeq: 2,
    });
    expect(peer.productLastSeq).toBe(6);
    expect(peer.implLastSeq).toBe(2);
    expect(historyUrls).toEqual([
      'http://relay.test/channels/topic%3Ageneral/messages?afterSeq=0&limit=100',
      'http://relay.test/channels/topic%3Aimplementation/messages?afterSeq=0&limit=100',
      'http://relay.test/channels/topic%3Ageneral/messages?afterSeq=5&limit=100',
      'http://relay.test/channels/topic%3Aimplementation/messages?afterSeq=2&limit=100',
    ]);
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
