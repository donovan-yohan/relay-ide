import { describe, expect, it, vi } from 'vitest';

import {
  OrchestratorPeer,
  TokenManager,
  abortableDelay,
  buildAckText,
  buildInstruction,
  buildRollup,
  buildWorkerMention,
  readPeerConfig,
  redactPeerText,
  safePeerErrorMessage,
  selectNewMessages,
  validatePeerBaseUrl,
  type FetchLike,
  type PeerConfig,
} from '../scripts/orchestrator-peer.js';
import {
  parseMentions,
  type ChannelMessage,
  type ChannelMessageId,
} from '../shared/channel-chat-protocol.js';

const CONFIG: PeerConfig = {
  baseUrl: 'http://127.0.0.1:3456/',
  actorToken: 'relay-sac-v1.test-lease',
  actorId: 'echo-peer',
  displayName: 'Echo Peer',
  role: 'orchestrator',
  productChannelId: 'topic:general',
  implChannelId: 'topic:implementation',
  workerFramework: 'codex',
  capabilities: ['session:read', 'context:read', 'context:write'],
  renewable: false,
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
      [
        message(
          4,
          'agent:worker',
          'partial reply',
          CONFIG.implChannelId,
          'truncated'
        ),
      ],
      3,
      'agent:echo-peer'
    );
    expect(truncated.acks).toEqual([
      { seq: 4, text: 'orchestrator online — ack seq 4 from agent:worker' },
    ]);
    expect(truncated.nextSeq).toBe(4);

    // A terminal 'interrupted' reply is advanced past without relay (like failed).
    const interrupted = selectNewMessages(
      [
        message(
          5,
          'agent:worker',
          'cut off',
          CONFIG.implChannelId,
          'interrupted'
        ),
      ],
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

  it('reads the pre-minted actor lease and channel ids from args or environment', () => {
    const fromEnvironment = readPeerConfig({
      RELAY_IDE_ACTOR_TOKEN: 'relay-sac-v1.env-lease',
      RELAY_PEER_CHANNEL_ID: 'topic:product-environment',
      RELAY_PEER_IMPL_CHANNEL_ID: 'topic:impl-environment',
      RELAY_PEER_WORKER_FRAMEWORK: 'claude',
      RELAY_PEER_SCOPE: 'this field is intentionally ignored',
    });
    expect(fromEnvironment.actorToken).toBe('relay-sac-v1.env-lease');
    expect(fromEnvironment.productChannelId).toBe('topic:product-environment');
    expect(fromEnvironment.implChannelId).toBe('topic:impl-environment');
    expect(fromEnvironment.workerFramework).toBe('claude');
    expect(fromEnvironment).not.toHaveProperty('pin');
    expect(fromEnvironment).not.toHaveProperty('scope');
    expect(fromEnvironment.renewable).toBe(false);

    const fromArgs = readPeerConfig(
      {
        RELAY_IDE_ACTOR_TOKEN: 'relay-sac-v1.env-only-lease',
        RELAY_PEER_CHANNEL_ID: 'topic:product-environment',
        RELAY_PEER_IMPL_CHANNEL_ID: 'topic:impl-environment',
      },
      [
        '--channel',
        'topic:product-argument',
        '--impl-channel',
        'topic:impl-argument',
        '--worker-framework',
        'codex-argument',
      ]
    );
    expect(fromArgs.actorToken).toBe('relay-sac-v1.env-only-lease');
    expect(fromArgs.productChannelId).toBe('topic:product-argument');
    expect(fromArgs.implChannelId).toBe('topic:impl-argument');
    expect(fromArgs.workerFramework).toBe('codex-argument');
    expect(fromArgs).not.toHaveProperty('scope');
    expect(() =>
      readPeerConfig(
        {
          RELAY_PEER_CHANNEL_ID: 'topic:general',
          RELAY_PEER_IMPL_CHANNEL_ID: 'topic:implementation',
        },
        ['--actor-token', 'relay-sac-v1.argv-leak']
      )
    ).toThrow(/RELAY_IDE_ACTOR_TOKEN/);

    const withDefault = readPeerConfig({
      RELAY_IDE_ACTOR_TOKEN: 'relay-sac-v1.env-lease',
      RELAY_PEER_CHANNEL_ID: 'topic:product-environment',
      RELAY_PEER_IMPL_CHANNEL_ID: 'topic:impl-environment',
    });
    expect(withDefault.workerFramework).toBe('codex');

    // The PIN/cookie harness path is forbidden: it must never appear in config.
    // Supplying only RELAY_PEER_PIN (no lease, no channels) must fail closed.
    expect(() => readPeerConfig({ RELAY_PEER_PIN: 'leaked' })).toThrow(
      /actor token, product channel/
    );
    expect(() =>
      readPeerConfig({
        RELAY_IDE_ACTOR_TOKEN: 'not-a-lease',
        RELAY_PEER_CHANNEL_ID: 'topic:general',
        RELAY_PEER_IMPL_CHANNEL_ID: 'topic:implementation',
      })
    ).toThrow(/relay-sac-v1/);
  });

  it('allows HTTPS remotes and loopback HTTP, but rejects unsafe bearer origins', () => {
    expect(validatePeerBaseUrl('http://127.0.1.1:3456/')).toBe(
      'http://127.0.1.1:3456'
    );
    expect(validatePeerBaseUrl('http://localhost:3456/')).toBe(
      'http://localhost:3456'
    );
    expect(validatePeerBaseUrl('https://relay.example/relay/')).toBe(
      'https://relay.example/relay'
    );
    expect(() => validatePeerBaseUrl('http://relay.example')).toThrow(/HTTPS/);
    expect(() =>
      validatePeerBaseUrl('https://user:password@relay.example')
    ).toThrow(/credentials/);
    expect(() =>
      validatePeerBaseUrl('https://relay.example?token=lease')
    ).toThrow(/query/);
    expect(() => validatePeerBaseUrl('https://relay.example/#token')).toThrow(
      /fragment/
    );

    expect(() =>
      readPeerConfig({
        RELAY_IDE_ACTOR_TOKEN: 'relay-sac-v1.env-lease',
        RELAY_PEER_CHANNEL_ID: 'topic:general',
        RELAY_PEER_IMPL_CHANNEL_ID: 'topic:implementation',
        RELAY_PEER_BASE_URL: 'http://not-loopback.example',
      })
    ).toThrow(/HTTPS/);
  });

  it('redacts and bounds reflected response and thrown error text', () => {
    const token = 'relay-sac-v1.actual-lease';
    const reflected = `Bearer ${token}; ${'x'.repeat(700)}`;
    const safeResponseText = redactPeerText(reflected, token);
    const safeErrorText = safePeerErrorMessage(new Error(reflected), token);

    for (const text of [safeResponseText, safeErrorText]) {
      expect(text).not.toContain(token);
      expect(text).toContain('…redacted');
      expect(text.length).toBeLessThanOrEqual(527);
    }
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
      if (
        url.endsWith('/channels/topic%3Ageneral/messages?afterSeq=0&limit=100')
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

    const peer = new OrchestratorPeer(CONFIG, fetchMock);
    await expect(peer.pollOnce()).resolves.toEqual({
      instructionCount: 1,
      rollupCount: 0,
      productLastSeq: 1,
      implLastSeq: 0,
    });

    // No /auth, no /cli-gateway/actor-credentials, no PIN, no browser cookie:
    // the peer uses the pre-minted lease directly.
    expect(calls).toHaveLength(3);
    const gatewayCalls = calls;
    expect(gatewayCalls).toHaveLength(3);
    for (const call of gatewayCalls) {
      const headers = new Headers(call.init.headers);
      expect(headers.get('authorization')).toBe(
        'Bearer relay-sac-v1.test-lease'
      );
      expect(headers.get('x-relay-cli-gateway')).toBe('v1');
    }
    expect(calls.some((call) => call.url.endsWith('/auth'))).toBe(false);
    expect(
      calls.some((call) => call.url.endsWith('/cli-gateway/actor-credentials'))
    ).toBe(false);
    expect(gatewayCalls[0]?.url).toBe(
      'http://127.0.0.1:3456/channels/topic%3Ageneral/messages?afterSeq=0&limit=100'
    );
    expect(
      new Headers(gatewayCalls[0]?.init.headers).get('x-relay-cli-command')
    ).toBe('channels.history');
    expect(gatewayCalls[1]?.url).toBe(
      'http://127.0.0.1:3456/channels/topic%3Aimplementation/messages'
    );
    expect(gatewayCalls[1]?.init.method).toBe('POST');
    expect(
      new Headers(gatewayCalls[1]?.init.headers).get('x-relay-cli-command')
    ).toBe('channels.post');
    expect(new Headers(gatewayCalls[1]?.init.headers).get('content-type')).toBe(
      'application/json'
    );
    expect(JSON.parse(String(gatewayCalls[1]?.init.body))).toEqual({
      text: '@codex build feature',
    });
    expect(gatewayCalls[2]?.url).toBe(
      'http://127.0.0.1:3456/channels/topic%3Aimplementation/messages?afterSeq=0&limit=100'
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
      if (
        url.endsWith('/channels/topic%3Ageneral/messages?afterSeq=0&limit=100')
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

    const peer = new OrchestratorPeer(CONFIG, fetchMock);
    await expect(peer.pollOnce()).resolves.toEqual({
      instructionCount: 0,
      rollupCount: 1,
      productLastSeq: 0,
      implLastSeq: 4,
    });

    const gatewayCalls = calls.slice(0);
    expect(gatewayCalls).toHaveLength(3);
    const post = gatewayCalls[2];
    expect(post?.url).toBe(
      'http://127.0.0.1:3456/channels/topic%3Ageneral/messages'
    );
    expect(post?.init.method).toBe('POST');
    const headers = new Headers(post?.init.headers);
    expect(headers.get('authorization')).toBe('Bearer relay-sac-v1.test-lease');
    expect(headers.get('x-relay-cli-gateway')).toBe('v1');
    expect(headers.get('x-relay-cli-command')).toBe('channels.post');
    expect(headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(String(post?.init.body))).toEqual({
      text: 'rollup (from impl): implementation complete',
    });
    expect(calls.some((call) => call.url.endsWith('/auth'))).toBe(false);
  });

  it('self-skips its own worker mention in impl without cross-channel ping-pong', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi.fn<FetchLike>(async (input, init = {}) => {
      const url = input.toString();
      calls.push({ url, init });
      if (
        url.endsWith('/channels/topic%3Ageneral/messages?afterSeq=0&limit=100')
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

    const peer = new OrchestratorPeer(CONFIG, fetchMock);
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

    const peer = new OrchestratorPeer(CONFIG, fetchMock);
    await peer.pollOnce();
    await expect(peer.pollOnce()).resolves.toMatchObject({
      productLastSeq: 6,
      implLastSeq: 2,
    });
    expect(peer.productLastSeq).toBe(6);
    expect(peer.implLastSeq).toBe(2);
    expect(historyUrls).toEqual([
      'http://127.0.0.1:3456/channels/topic%3Ageneral/messages?afterSeq=0&limit=100',
      'http://127.0.0.1:3456/channels/topic%3Aimplementation/messages?afterSeq=0&limit=100',
      'http://127.0.0.1:3456/channels/topic%3Ageneral/messages?afterSeq=5&limit=100',
      'http://127.0.0.1:3456/channels/topic%3Aimplementation/messages?afterSeq=2&limit=100',
    ]);
  });

  it('uses the pre-minted lease directly with no PIN/cookie remint path', async () => {
    let gatewayCount = 0;
    const gatewayHeaders: Headers[] = [];
    const fetchMock = vi.fn<FetchLike>(async (input, init) => {
      const url = input.toString();
      if (
        url.endsWith('/auth') ||
        url.endsWith('/cli-gateway/actor-credentials')
      ) {
        throw new Error('PIN/cookie harness path must never be used');
      }
      gatewayCount += 1;
      gatewayHeaders.push(new Headers(init?.headers));
      return jsonResponse({ messages: [] });
    });

    const manager = new TokenManager(CONFIG, fetchMock);
    const response = await manager.gatewayFetch(
      'http://127.0.0.1:3456/channels/topic%3Ageneral/messages',
      'channels.history'
    );

    expect(response.status).toBe(200);
    expect(gatewayCount).toBe(1);
    const headers = gatewayHeaders[0];
    expect(headers?.get('authorization')).toBe(
      'Bearer relay-sac-v1.test-lease'
    );
    expect(headers?.get('x-relay-cli-gateway')).toBe('v1');
    expect(headers?.get('x-relay-cli-command')).toBe('channels.history');
    expect(await manager.getToken()).toBe('relay-sac-v1.test-lease');
    manager.releaseGatewayResponse(response);
  });

  it('bounds a hung gateway request and honors caller cancellation', async () => {
    vi.useFakeTimers();
    try {
      let timedSignal: AbortSignal | null | undefined;
      const timedManager = new TokenManager(
        CONFIG,
        vi.fn<FetchLike>((_input, init) => {
          timedSignal = init?.signal;
          return new Promise<Response>(() => {});
        })
      );
      const timedRequest = timedManager.gatewayFetch(
        'http://127.0.0.1:3456/channels/topic%3Ageneral/messages',
        'channels.history'
      );
      const timedExpectation = expect(timedRequest).rejects.toMatchObject({
        name: 'TimeoutError',
      });

      await vi.advanceTimersByTimeAsync(10_000);
      await timedExpectation;
      expect(timedSignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);

      const caller = new AbortController();
      let callerSignal: AbortSignal | null | undefined;
      const callerManager = new TokenManager(
        CONFIG,
        vi.fn<FetchLike>((_input, init) => {
          callerSignal = init?.signal;
          return new Promise<Response>(() => {});
        })
      );
      const callerRequest = callerManager.gatewayFetch(
        'http://127.0.0.1:3456/channels/topic%3Ageneral/messages',
        'channels.history',
        { signal: caller.signal }
      );
      const callerExpectation = expect(callerRequest).rejects.toThrow(
        'caller canceled gateway request'
      );
      caller.abort(new Error('caller canceled gateway request'));

      await callerExpectation;
      expect(callerSignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds a stalled history response body so pollOnce cannot hang', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn<FetchLike>((_input, init) => {
        const signal = init?.signal;
        if (!signal) throw new Error('gateway signal was required');
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                signal.addEventListener(
                  'abort',
                  () => controller.error(signal.reason),
                  { once: true }
                );
              },
            }),
            { headers: { 'content-type': 'application/json' } }
          )
        );
      });
      const peer = new OrchestratorPeer(CONFIG, fetchMock);
      const poll = peer.pollOnce();
      const pollExpectation = expect(poll).rejects.toMatchObject({
        name: 'TimeoutError',
      });

      await vi.advanceTimersByTimeAsync(10_000);
      await pollExpectation;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a non-lease actor token in TokenManager', () => {
    const bad = { ...CONFIG, actorToken: 'not-a-lease' };
    expect(() => new TokenManager(bad, vi.fn<FetchLike>())).toThrow(
      /relay-sac-v1/
    );
  });

  it('does not forward its bearer to another origin or credential-bearing URL', async () => {
    const fetchMock = vi.fn<FetchLike>();
    const manager = new TokenManager(CONFIG, fetchMock);

    await expect(
      manager.gatewayFetch(
        'https://relay.example/channels/topic%3Ageneral/messages',
        'channels.history'
      )
    ).rejects.toThrow(/configured base origin/);
    await expect(
      manager.gatewayFetch(
        'http://user:password@127.0.0.1:3456/channels/topic%3Ageneral/messages',
        'channels.history'
      )
    ).rejects.toThrow(/credentials/);
    await expect(
      manager.gatewayFetch(
        'http://127.0.0.1:3456/channels/topic%3Ageneral/messages?afterSeq=0&token=relay-sac-v1.test-lease',
        'channels.history'
      )
    ).rejects.toThrow(/credential material/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('redacts a server-reflected lease before surfacing a failed channel request', async () => {
    const reflected = `Bearer ${CONFIG.actorToken} ${'x'.repeat(700)}`;
    const peer = new OrchestratorPeer(
      CONFIG,
      vi.fn<FetchLike>(async () => new Response(reflected, { status: 500 }))
    );

    await expect(peer.pollOnce()).rejects.toSatisfy((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return (
        !message.includes(CONFIG.actorToken) &&
        message.includes('…redacted') &&
        message.length <= 570
      );
    });
  });
});
