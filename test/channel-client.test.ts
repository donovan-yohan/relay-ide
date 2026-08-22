import { describe, expect, it } from 'vitest';

import {
  createRelayChannelClient,
  RelayChannelClientError,
  RelayChannelSubscriptionOverflowError,
} from '../shared/channel-client.js';

const enc = new TextEncoder();
function message(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'chm:one',
    channelId: 'topic:one',
    seq: 1,
    kind: 'message',
    status: 'streaming',
    sender: { kind: 'agent', id: 'agent:one' },
    body: { text: 'Hello', format: 'text' },
    threadId: null,
    parentMessageId: null,
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:00.000Z',
    ...overrides,
  };
}

const PRIVATE_PROVIDER_VALUES = [
  'runtime-private',
  'turn-private',
  'item-private',
  'sender-runtime-private',
  'meta-runtime-private',
  'provider-item-private',
  'provider-runtime-private',
  'source-runtime-private',
  'source-turn-private',
  'source-session-private',
];
const PRIVATE_PROVIDER_KEYS = [
  'runtimeId',
  'turnId',
  'itemId',
  'providerRuntimeId',
  'providerTurnId',
  'sessionId',
  'provider_item_id',
  'provider_turn_id',
  'source',
  'source_runtime_id',
  'sourceSessionId',
];

function providerMessage(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return message({
    sender: {
      kind: 'agent',
      id: 'agent:one',
      providerId: 'codex',
      runtimeId: 'sender-runtime-private',
    },
    source: {
      runtimeId: 'runtime-private',
      turnId: 'turn-private',
      itemId: 'item-private',
    },
    agentDetail: {
      itemId: 'item-private',
      card: { kind: 'message', title: 'Agent detail', status: 'completed' },
    },
    meta: {
      runtimeId: 'meta-runtime-private',
      nested: {
        providerTurnId: 'turn-private',
        provider_item_id: 'provider-item-private',
        providerRuntimeId: 'provider-runtime-private',
        provider_turn_id: 'turn-private',
        source: {
          source_runtime_id: 'source-runtime-private',
          sourceTurnId: 'source-turn-private',
          sourceSessionId: 'source-session-private',
        },
        safe: 'kept but echoed runtime-private and source-session-private',
      },
    },
    ...overrides,
  });
}

function expectNoProviderDiagnostics(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const key of PRIVATE_PROVIDER_KEYS) {
    expect(serialized).not.toContain(`"${key}"`);
  }
  for (const marker of PRIVATE_PROVIDER_VALUES) {
    expect(serialized).not.toContain(marker);
  }
}

function ndjson(lines: unknown[], signal?: AbortSignal): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines)
        controller.enqueue(enc.encode(`${JSON.stringify(line)}\n`));
      controller.close();
    },
    cancel() {
      // The client is allowed to end a bounded collector early.
    },
  });
  void signal;
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  });
}

describe('relay-ide/channel-client', () => {
  it('maps the stable command methods with construction-only credentials', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = createRelayChannelClient({
      baseUrl: 'http://relay.test/',
      token: 'secret-never-in-input',
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        const pathname = new URL(String(url)).pathname;
        if (pathname.includes('/threads/') || pathname.endsWith('/messages')) {
          if (init?.method === 'POST')
            return Response.json({ message: message() });
          return Response.json({ messages: [] });
        }
        return Response.json({ channels: [] });
      },
    });

    await client.list();
    await client.get({ channelId: 'topic:one' });
    await client.run.get({ channelId: 'topic:one', runId: 'chrun:one' });
    await client.history({ channelId: 'topic:one', afterSeq: 4 });
    await client.threads.history({
      channelId: 'topic:one',
      threadId: 'chm:one',
    });
    await client.roster({ channelId: 'topic:one' });
    await client.post({ channelId: 'topic:one', text: 'hi' });

    expect(requests.map(({ url }) => url)).toEqual([
      'http://relay.test/channels',
      'http://relay.test/channels/topic%3Aone',
      'http://relay.test/channels/topic%3Aone/runs/chrun%3Aone',
      'http://relay.test/channels/topic%3Aone/messages?afterSeq=4',
      'http://relay.test/channels/topic%3Aone/threads/chm%3Aone',
      'http://relay.test/channels/topic%3Aone/roster',
      'http://relay.test/channels/topic%3Aone/messages',
    ]);
    const post = requests.at(-1)?.init;
    expect(post?.method).toBe('POST');
    expect(post?.body).toBe('{"text":"hi"}');
    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.get('authorization')).toBe('Bearer secret-never-in-input');
    expect(headers.get('x-relay-cli-actor-token')).toBeNull();
    for (const { url, init } of requests) {
      expect(url).not.toContain('secret-never-in-input');
      expect(String(init?.body ?? '')).not.toContain('secret-never-in-input');
    }
    expect(JSON.stringify(requests)).not.toContain('secret-never-in-input');
  });

  it('selects the human operator-client marker without changing stable request schemas', async () => {
    const requests: RequestInit[] = [];
    const client = createRelayChannelClient({
      baseUrl: 'http://relay.test',
      token: 'relay-occ-v1.credential-id.raw-secret',
      fetch: async (_url, init) => {
        requests.push(init ?? {});
        return Response.json({ channels: [] });
      },
    });

    await client.list();
    const headers = new Headers(requests[0]?.headers);
    expect(headers.get('authorization')).toBe(
      'Bearer relay-occ-v1.credential-id.raw-secret'
    );
    expect(headers.get('x-relay-operator-client-token')).toBe('v1');
    expect(headers.get('x-relay-cli-actor-token')).toBeNull();
    expect(headers.get('x-relay-cli-command')).toBe('channels.list');
  });

  it('keeps concurrent run lookups isolated and preserves sibling denial envelopes', async () => {
    const client = createRelayChannelClient({
      baseUrl: 'http://relay.test',
      fetch: async (url) => {
        const value = String(url);
        if (value.endsWith('chrun%3Adenied')) {
          return Response.json(
            {
              error: {
                code: 'FORBIDDEN',
                message: 'channel scope denied',
                retryable: false,
              },
            },
            { status: 403 }
          );
        }
        return Response.json({
          run: {
            id: value.endsWith('chrun%3Aone') ? 'chrun:one' : 'chrun:two',
          },
        });
      },
    });
    const [one, two] = await Promise.all([
      client.run.get({ channelId: 'topic:one', runId: 'chrun:one' }),
      client.run.get({ channelId: 'topic:two', runId: 'chrun:two' }),
    ]);
    expect(one.run.id).toBe('chrun:one');
    expect(two.run.id).toBe('chrun:two');
    await expect(
      client.run.get({ channelId: 'topic:one', runId: 'chrun:denied' })
    ).rejects.toMatchObject<Partial<RelayChannelClientError>>({
      status: 403,
      code: 'FORBIDDEN',
      retryable: false,
    });
  });

  it('projects recursive provider aliases from every non-streaming success path while retaining Relay ids', async () => {
    const privateFields = {
      providerRuntimeId: 'provider-runtime-private',
      nested: {
        provider_item_id: 'provider-item-private',
        source: { source_runtime_id: 'source-runtime-private' },
      },
    };
    const client = createRelayChannelClient({
      baseUrl: 'http://relay.test',
      fetch: async (url) => {
        const pathname = new URL(String(url)).pathname;
        if (pathname.endsWith('/roster'))
          return Response.json({
            roster: [{ id: 'agent:one', ...privateFields }],
          });
        if (pathname.includes('/runs/'))
          return Response.json({
            run: {
              id: 'chrun:one',
              targetId: 'target:one',
              ...privateFields,
            },
          });
        if (pathname === '/channels/topic%3Aone')
          return Response.json({
            channel: { id: 'topic:one', ...privateFields },
          });
        return Response.json({
          channels: [{ id: 'topic:one', ...privateFields }],
        });
      },
    });

    const [listed, channel, run, roster] = await Promise.all([
      client.list(),
      client.get({ channelId: 'topic:one' }),
      client.run.get({ channelId: 'topic:one', runId: 'chrun:one' }),
      client.roster({ channelId: 'topic:one' }),
    ]);
    expectNoProviderDiagnostics({ listed, channel, run, roster });
    expect(listed.channels[0]?.id).toBe('topic:one');
    expect(channel.channel.id).toBe('topic:one');
    expect(run.run).toMatchObject({ id: 'chrun:one', targetId: 'target:one' });
    expect(roster.roster[0]?.id).toBe('agent:one');
  });

  it('resumes without duplicate durable rows and applies state replacement before a later delta', async () => {
    const requests: string[] = [];
    const initial = message();
    const replacement = message({
      body: { text: 'Hello world', format: 'text' },
    });
    const client = createRelayChannelClient({
      baseUrl: 'http://relay.test',
      fetch: async (url, init) => {
        requests.push(String(url));
        const afterSeq = new URL(String(url)).searchParams.get('afterSeq');
        if (afterSeq === null) {
          return ndjson(
            [
              {
                schemaVersion: 1,
                frame: 'open',
                channelId: 'topic:one',
                sequence: 0,
                occurredAt: '2026-08-12T00:00:00.000Z',
                durableSeq: 0,
              },
              {
                schemaVersion: 1,
                frame: 'event',
                channelId: 'topic:one',
                sequence: 1,
                occurredAt: '2026-08-12T00:00:01.000Z',
                durableSeq: 1,
                payload: {
                  type: 'channel-snapshot-v1',
                  channelId: 'topic:one',
                  timestamp: '2026-08-12T00:00:01.000Z',
                  mode: 'full',
                  messages: [initial],
                  members: [],
                  latestSeq: 1,
                  inFlight: [{ messageId: 'chm:one', deltaIndex: -1 }],
                  truncated: false,
                },
              },
            ],
            init?.signal ?? undefined
          );
        }
        return ndjson(
          [
            {
              schemaVersion: 1,
              frame: 'event',
              channelId: 'topic:one',
              sequence: 2,
              occurredAt: '2026-08-12T00:00:02.000Z',
              durableSeq: 1,
              payload: {
                type: 'channel-snapshot-v1',
                channelId: 'topic:one',
                timestamp: '2026-08-12T00:00:02.000Z',
                mode: 'catchup',
                messages: [],
                stateReplacements: [
                  {
                    message: replacement,
                    inFlight: { messageId: 'chm:one', deltaIndex: 1 },
                  },
                ],
                members: [],
                latestSeq: 1,
                inFlight: [],
                truncated: false,
              },
            },
            {
              schemaVersion: 1,
              frame: 'event',
              channelId: 'topic:one',
              sequence: 3,
              occurredAt: '2026-08-12T00:00:03.000Z',
              durableSeq: 1,
              payload: {
                type: 'channel-message-delta-v1',
                channelId: 'topic:one',
                timestamp: '2026-08-12T00:00:03.000Z',
                messageId: 'chm:one',
                deltaIndex: 2,
                delta: { text: '!' },
              },
            },
          ],
          init?.signal ?? undefined
        );
      },
    });
    const first = await client.collect({
      channelId: 'topic:one',
      maxEvents: 1,
    });
    expect(first.durableSeq).toBe(1);
    const resumed = await client.collect({
      channelId: 'topic:one',
      afterSeq: first.durableSeq,
      state: first.state,
      maxEvents: 2,
    });
    expect(requests).toEqual([
      'http://relay.test/channels/topic%3Aone/subscribe',
      'http://relay.test/channels/topic%3Aone/subscribe?afterSeq=1',
    ]);
    expect(resumed.state.messages).toHaveLength(1);
    expect(resumed.state.messages[0]?.body.text).toBe('Hello world!');
    expect(resumed.state.lastSeq).toBe(1);
    expect(resumed.durableSeq).toBe(1);
  });

  it('projects provider diagnostics out of history, post results, snapshot replacements, state, and errors', async () => {
    const token = 'relay-sac-v1.private-token';
    const sensitive = providerMessage();
    const client = createRelayChannelClient({
      baseUrl: 'http://relay.test',
      token,
      fetch: async (url, init) => {
        const pathname = new URL(String(url)).pathname;
        if (pathname.endsWith('/denied')) {
          return Response.json(
            {
              error: {
                code: 'FORBIDDEN',
                message: `credential ${token} rejected`,
                details: {
                  token,
                  authorization: `Bearer ${token}`,
                  runtimeId: 'runtime-private',
                  nested: { providerTurnId: 'turn-private', echoed: token },
                },
              },
            },
            { status: 403 }
          );
        }
        if (pathname.endsWith('/subscribe')) {
          return ndjson([
            {
              schemaVersion: 1,
              frame: 'event',
              channelId: 'topic:one',
              sequence: 1,
              occurredAt: '2026-08-12T00:00:01.000Z',
              durableSeq: 1,
              payload: {
                type: 'channel-snapshot-v1',
                channelId: 'topic:one',
                timestamp: '2026-08-12T00:00:01.000Z',
                mode: 'full',
                messages: [sensitive],
                runs: [
                  {
                    id: 'chrun:one',
                    channelId: 'topic:one',
                    threadId: null,
                    requestMessageId: 'chm:one',
                    requesterId: 'human:one',
                    state: 'working',
                    targets: [
                      {
                        targetId: 'agent-profile:codex:one',
                        state: 'working',
                        updatedAt: '2026-08-12T00:00:01.000Z',
                        providerRuntimeId: 'provider-runtime-private',
                      },
                    ],
                    createdAt: '2026-08-12T00:00:01.000Z',
                    updatedAt: '2026-08-12T00:00:01.000Z',
                    source: { source_runtime_id: 'source-runtime-private' },
                  },
                ],
                members: [],
                latestSeq: 1,
                inFlight: [],
                truncated: false,
              },
            },
            {
              schemaVersion: 1,
              frame: 'event',
              channelId: 'topic:one',
              sequence: 2,
              occurredAt: '2026-08-12T00:00:02.000Z',
              durableSeq: 1,
              payload: {
                type: 'channel-snapshot-v1',
                channelId: 'topic:one',
                timestamp: '2026-08-12T00:00:02.000Z',
                mode: 'catchup',
                messages: [],
                stateReplacements: [{ message: sensitive }],
                members: [],
                latestSeq: 1,
                inFlight: [],
                truncated: false,
              },
            },
          ]);
        }
        if (pathname.endsWith('/messages') && init?.method === 'POST') {
          return Response.json({ message: sensitive });
        }
        return Response.json({ messages: [sensitive] });
      },
    });

    const history = await client.history({ channelId: 'topic:one' });
    const posted = await client.post({ channelId: 'topic:one', text: 'hi' });
    const subscribed = await client.collect({
      channelId: 'topic:one',
      maxEvents: 2,
    });
    expectNoProviderDiagnostics(history);
    expectNoProviderDiagnostics(posted);
    expectNoProviderDiagnostics(subscribed);
    const replacement = subscribed.frames[1]?.payload;
    expect(replacement).toMatchObject({
      type: 'channel-snapshot-v1',
      messages: [],
      stateReplacements: [{ message: { id: 'chm:one' } }],
    });
    expect(subscribed.state.messages[0]?.sender).toMatchObject({
      id: 'agent:one',
    });
    expect(subscribed.state.runs['chrun:one']).toMatchObject({
      id: 'chrun:one',
      targets: [{ targetId: 'agent-profile:codex:one' }],
    });

    let thrown: unknown;
    try {
      await client.run.get({ channelId: 'topic:one', runId: 'denied' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RelayChannelClientError);
    expectNoProviderDiagnostics(thrown);
    expect(String(thrown)).not.toContain(token);
    expect(JSON.stringify(thrown)).not.toContain('"token"');
    expect(JSON.stringify(thrown)).not.toContain(token);
  });

  it('stops a bounded collector after maxEvents even when the upstream stream ignores abort', async () => {
    const events = [1, 2, 3].map((sequence) => ({
      schemaVersion: 1,
      frame: 'event',
      channelId: 'topic:one',
      sequence,
      occurredAt: `2026-08-12T00:00:0${sequence}.000Z`,
      durableSeq: sequence,
      payload: {
        type: 'channel-message-created-v1',
        channelId: 'topic:one',
        timestamp: `2026-08-12T00:00:0${sequence}.000Z`,
        message: message({
          id: `chm:${sequence}`,
          seq: sequence,
          status: 'complete',
        }),
      },
    }));
    const client = createRelayChannelClient({
      baseUrl: 'http://relay.test',
      fetch: async () => ndjson(events),
    });

    const collected = await client.collect({
      channelId: 'topic:one',
      maxEvents: 2,
      // Immediate upstream frames and the quiet deadline start in the same
      // turn; max-events must win rather than report an idle timeout.
      idleTimeoutMs: 1,
    });

    expect(collected.frames).toHaveLength(2);
    expect(collected.frames.map((frame) => frame.sequence)).toEqual([1, 2]);
    expect(collected.durableSeq).toBe(2);
    expect(collected.stopReason).toBe('max-events');
  });

  it('uses a restartable quiet deadline while continuous accepted frames arrive', async () => {
    let cancelled = false;
    const client = createRelayChannelClient({
      baseUrl: 'http://relay.test',
      fetch: async (_url, init) => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            let sequence = 0;
            const emit = () => {
              sequence += 1;
              controller.enqueue(
                enc.encode(
                  `${JSON.stringify({
                    schemaVersion: 1,
                    frame: 'event',
                    channelId: 'topic:one',
                    sequence,
                    occurredAt: `2026-08-12T00:00:0${sequence}.000Z`,
                    durableSeq: sequence,
                    payload: {
                      type: 'channel-message-created-v1',
                      channelId: 'topic:one',
                      timestamp: `2026-08-12T00:00:0${sequence}.000Z`,
                      message: message({
                        id: `chm:${sequence}`,
                        seq: sequence,
                      }),
                    },
                  })}\n`
                )
              );
              if (sequence < 3) setTimeout(emit, 10);
            };
            emit();
            init?.signal?.addEventListener('abort', () => {
              cancelled = true;
              controller.close();
            });
          },
        });
        return new Response(stream);
      },
    });

    const collected = await client.collect({
      channelId: 'topic:one',
      maxEvents: 3,
      idleTimeoutMs: 18,
    });
    expect(collected.stopReason).toBe('max-events');
    expect(collected.frames).toHaveLength(3);
    expect(cancelled).toBe(true);
  });

  it('times out a quiet stream and clears its local abort timer', async () => {
    let cancelled = false;
    const client = createRelayChannelClient({
      baseUrl: 'http://relay.test',
      fetch: async (_url, init) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              init?.signal?.addEventListener('abort', () => {
                cancelled = true;
                controller.close();
              });
            },
          })
        ),
    });

    await expect(
      client.collect({ channelId: 'topic:one', idleTimeoutMs: 10 })
    ).resolves.toMatchObject({ stopReason: 'idle-timeout', frames: [] });
    expect(cancelled).toBe(true);
  });

  it('rejects malformed frames before projection or reducer application', async () => {
    const client = createRelayChannelClient({
      baseUrl: 'http://relay.test',
      fetch: async () =>
        ndjson([
          {
            schemaVersion: 1,
            frame: 'event',
            channelId: 'topic:one',
            sequence: 1,
            occurredAt: '2026-08-12T00:00:01.000Z',
            durableSeq: 1,
            payload: {
              type: 'channel-message-created-v1',
              channelId: 'topic:two',
            },
          },
        ]),
    });

    await expect(
      client.collect({ channelId: 'topic:one', maxEvents: 1 })
    ).rejects.toMatchObject<Partial<RelayChannelClientError>>({
      code: 'UPSTREAM_ERROR',
      status: 502,
    });
  });

  it('fails closed on per-discriminant extras, missing closed fields, and nested channel mismatches', async () => {
    const validCreated = {
      type: 'channel-message-created-v1',
      channelId: 'topic:one',
      timestamp: '2026-08-12T00:00:01.000Z',
      message: message(),
    };
    const invalidFrames = [
      {
        schemaVersion: 1,
        frame: 'open',
        channelId: 'topic:one',
        sequence: 0,
        occurredAt: '2026-08-12T00:00:00.000Z',
        durableSeq: 0,
        injected: true,
      },
      {
        schemaVersion: 1,
        frame: 'event',
        channelId: 'topic:one',
        sequence: 1,
        occurredAt: '2026-08-12T00:00:01.000Z',
        durableSeq: 1,
        payload: validCreated,
        injected: true,
      },
      {
        schemaVersion: 1,
        frame: 'closed',
        channelId: 'topic:one',
        sequence: 2,
        occurredAt: '2026-08-12T00:00:02.000Z',
        durableSeq: 1,
        reason: 'transport-closed',
      },
      {
        schemaVersion: 1,
        frame: 'event',
        channelId: 'topic:one',
        sequence: 3,
        occurredAt: '2026-08-12T00:00:03.000Z',
        durableSeq: 1,
        payload: {
          ...validCreated,
          message: message({ channelId: 'topic:two' }),
        },
      },
    ];

    for (const frame of invalidFrames) {
      const client = createRelayChannelClient({
        baseUrl: 'http://relay.test',
        fetch: async () => ndjson([frame]),
      });
      await expect(
        client.collect({ channelId: 'topic:one', maxEvents: 1 })
      ).rejects.toMatchObject<Partial<RelayChannelClientError>>({
        code: 'UPSTREAM_ERROR',
        status: 502,
        retryable: true,
      });
    }
  });

  it('bounds no-newline lines, aggregate stream bytes, and retained collector output independently', async () => {
    let lineCanceled = false;
    const noNewline = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('x'.repeat(64)));
      },
      cancel() {
        lineCanceled = true;
      },
    });
    const lineClient = createRelayChannelClient({
      baseUrl: 'http://relay.test',
      fetch: async () => new Response(noNewline),
    });
    await expect(
      lineClient.collect({
        channelId: 'topic:one',
        maxLineBytes: 16,
        maxStreamBytes: 128,
      })
    ).rejects.toMatchObject<Partial<RelayChannelSubscriptionOverflowError>>({
      limit: 'line-bytes',
      maximum: 16,
      observed: 64,
    });
    expect(lineCanceled).toBe(true);

    let aggregateCanceled = false;
    const aggregate = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('12345678'));
        controller.enqueue(enc.encode('abcdefgh'));
      },
      cancel() {
        aggregateCanceled = true;
      },
    });
    const aggregateClient = createRelayChannelClient({
      baseUrl: 'http://relay.test',
      fetch: async () => new Response(aggregate),
    });
    await expect(
      aggregateClient.collect({
        channelId: 'topic:one',
        maxLineBytes: 32,
        maxStreamBytes: 12,
      })
    ).rejects.toMatchObject<Partial<RelayChannelSubscriptionOverflowError>>({
      limit: 'stream-bytes',
      maximum: 12,
      observed: 16,
    });
    expect(aggregateCanceled).toBe(true);

    const outputClient = createRelayChannelClient({
      baseUrl: 'http://relay.test',
      fetch: async () =>
        ndjson([
          {
            schemaVersion: 1,
            frame: 'event',
            channelId: 'topic:one',
            sequence: 1,
            occurredAt: '2026-08-12T00:00:01.000Z',
            durableSeq: 1,
            payload: {
              type: 'channel-message-created-v1',
              channelId: 'topic:one',
              timestamp: '2026-08-12T00:00:01.000Z',
              message: message(),
            },
          },
        ]),
    });
    await expect(
      outputClient.collect({
        channelId: 'topic:one',
        maxOutputBytes: 1,
      })
    ).rejects.toMatchObject<Partial<RelayChannelSubscriptionOverflowError>>({
      limit: 'collected-output-bytes',
      maximum: 1,
    });
  });

  it('accounts for the complete returned collection JSON at the exact output boundary', async () => {
    const frames = [
      {
        schemaVersion: 1,
        frame: 'event',
        channelId: 'topic:one',
        sequence: 1,
        occurredAt: '2026-08-12T00:00:01.000Z',
        durableSeq: 1,
        payload: {
          type: 'channel-message-created-v1',
          channelId: 'topic:one',
          timestamp: '2026-08-12T00:00:01.000Z',
          message: message(),
        },
      },
    ];
    const createClient = () =>
      createRelayChannelClient({
        baseUrl: 'http://relay.test',
        fetch: async () => ndjson(frames),
      });
    const baseline = await createClient().collect({
      channelId: 'topic:one',
      maxEvents: 1,
    });
    expect(baseline.stopReason).toBe('max-events');
    const exactBytes = enc.encode(JSON.stringify(baseline)).byteLength;
    await expect(
      createClient().collect({
        channelId: 'topic:one',
        maxEvents: 1,
        maxOutputBytes: exactBytes,
      })
    ).resolves.toEqual(baseline);
    await expect(
      createClient().collect({
        channelId: 'topic:one',
        maxEvents: 1,
        maxOutputBytes: exactBytes - 1,
      })
    ).rejects.toMatchObject<Partial<RelayChannelSubscriptionOverflowError>>({
      limit: 'collected-output-bytes',
      maximum: exactBytes - 1,
      observed: exactBytes,
      code: 'UPSTREAM_ERROR',
    });
  });

  it('does not turn short common provider values into global redaction needles', async () => {
    const client = createRelayChannelClient({
      baseUrl: 'http://relay.test',
      fetch: async () =>
        Response.json({
          messages: [
            providerMessage({
              source: { runtimeId: '0', itemId: 'codex' },
              meta: { diagnostic: 'codex 0 1 remains useful public prose' },
            }),
          ],
        }),
    });
    const result = await client.history({ channelId: 'topic:one' });
    expect(result.messages[0]?.meta).toEqual({
      diagnostic: 'codex 0 1 remains useful public prose',
    });
  });
});
