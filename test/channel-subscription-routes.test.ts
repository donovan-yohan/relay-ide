import * as http from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { attachAuthenticatedCliGatewayActorCredential } from '../server/cli-gateway-actor-auth.js';
import { createChannelSubscriptionRouter } from '../server/channel-subscription-router.js';
import type { ChannelEventSink, ChannelHub } from '../server/channel-hub.js';
import type { ChannelMessage } from '../shared/channel-chat-protocol.js';
import type { ScopedActorCredentialRecord } from '../shared/scoped-actor-credentials.js';

const servers: http.Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function listen(input: {
  channelIds: string[];
  subscribe?: (sink: ChannelEventSink, afterSeq: number | null) => void;
  isStillAuthorized?: () => boolean;
  onUnsubscribe?: () => void;
  heartbeatMs?: number;
  drainTimeoutMs?: number;
  writeResponse?: (res: express.Response, data: string) => boolean;
}): Promise<number> {
  const app = express();
  app.use((req, _res, next) => {
    attachAuthenticatedCliGatewayActorCredential(req, {
      id: 'credential:test',
      actor: { type: 'agent', id: 'actor:test', displayName: 'Test' },
      capabilities: ['context:read'],
      scope: { channelIds: input.channelIds },
    } as ScopedActorCredentialRecord);
    next();
  });
  const hub = {
    channelExists: (id: string) => id === 'topic:a' || id === 'topic:b',
    subscribe: (sink: ChannelEventSink, value: { afterSeq: number | null }) => {
      input.subscribe?.(sink, value.afterSeq);
      return () => input.onUnsubscribe?.();
    },
  } as unknown as ChannelHub;
  app.use(
    createChannelSubscriptionRouter({
      hub,
      requireSubscribeAuth: (_req, _res, next) => next(),
      now: () => new Date('2026-08-12T00:00:00.000Z'),
      heartbeatMs: input.heartbeatMs ?? 60_000,
      ...(input.drainTimeoutMs !== undefined
        ? { drainTimeoutMs: input.drainTimeoutMs }
        : {}),
      ...(input.writeResponse ? { writeResponse: input.writeResponse } : {}),
      ...(input.isStillAuthorized
        ? { isStillAuthorized: input.isStillAuthorized }
        : {}),
    })
  );
  const server = http.createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing port');
  return address.port;
}

describe('channel subscription route', () => {
  it('rejects duplicate, unknown, and malformed filter query values before subscribing', async () => {
    let subscribed = false;
    const port = await listen({
      channelIds: ['topic:a'],
      subscribe: () => {
        subscribed = true;
      },
    });
    for (const query of [
      'status=complete&status=failed',
      'unknownFilter=value',
      'terminalOnly=1',
    ]) {
      const response = await fetch(
        `http://127.0.0.1:${port}/channels/topic%3Aa/subscribe?${query}`,
        { headers: { 'x-relay-cli-gateway': 'v1' } }
      );
      expect(response.status).toBe(400);
    }
    expect(subscribed).toBe(false);
  });

  it('projects semantic replies without changing the durable cursor domain', async () => {
    const port = await listen({
      channelIds: ['topic:a'],
      subscribe: (sink) => {
        sink.send({
          type: 'channel-message-created-v1',
          channelId: 'topic:a',
          timestamp: '2026-08-12T00:00:00.000Z',
          message: {
            id: 'chm:detail',
            channelId: 'topic:a',
            seq: 5,
            kind: 'message',
            status: 'streaming',
            sender: { kind: 'agent', id: 'agent:one' },
            body: { text: 'tool output', format: 'markdown' },
            threadId: null,
            parentMessageId: null,
            agentDetail: {
              itemId: 'item:tool',
              card: { type: 'tool', name: 'x' },
            },
            createdAt: '2026-08-12T00:00:00.000Z',
            updatedAt: '2026-08-12T00:00:00.000Z',
          } as ChannelMessage,
        });
        sink.send({
          type: 'channel-message-delta-v1',
          channelId: 'topic:a',
          timestamp: '2026-08-12T00:00:00.000Z',
          messageId: 'chm:detail',
          deltaIndex: 1,
          delta: { text: ' more tool output' },
        });
        sink.send({
          type: 'channel-message-created-v1',
          channelId: 'topic:a',
          timestamp: '2026-08-12T00:00:00.000Z',
          message: {
            id: 'chm:reply',
            channelId: 'topic:a',
            seq: 6,
            kind: 'message',
            status: 'complete',
            sender: { kind: 'agent', id: 'agent:one' },
            body: { text: 'semantic answer', format: 'markdown' },
            threadId: null,
            parentMessageId: null,
            createdAt: '2026-08-12T00:00:00.000Z',
            updatedAt: '2026-08-12T00:00:00.000Z',
          } as ChannelMessage,
        });
        sink.close({ code: 'transport-closed' });
      },
    });
    const response = await fetch(
      `http://127.0.0.1:${port}/channels/topic%3Aa/subscribe?afterSeq=4&terminalOnly=true&principalOnly=true`,
      { headers: { 'x-relay-cli-gateway': 'v1' } }
    );
    const frames = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    expect(frames.map((frame) => frame.durableSeq)).toEqual([4, 6, 6]);
    expect(frames).toMatchObject([
      { frame: 'open' },
      {
        frame: 'event',
        payload: {
          type: 'channel-message-created-v1',
          message: { id: 'chm:reply', body: { text: 'semantic answer' } },
        },
      },
      { frame: 'closed' },
    ]);
    expect(JSON.stringify(frames)).not.toContain('tool output');
  });

  it('projects snapshot rows but preserves its original cursor and replay metadata', async () => {
    const port = await listen({
      channelIds: ['topic:a'],
      subscribe: (sink) => {
        sink.send({
          type: 'channel-snapshot-v1',
          channelId: 'topic:a',
          timestamp: '2026-08-12T00:00:00.000Z',
          mode: 'catchup',
          messages: [
            {
              id: 'chm:unmatched',
              seq: 5,
              kind: 'message',
              status: 'streaming',
              sender: { kind: 'agent', id: 'agent:one' },
              threadId: null,
              parentMessageId: null,
              body: { text: 'intermediate', format: 'markdown' },
            },
            {
              id: 'chm:matched',
              seq: 6,
              kind: 'message',
              status: 'complete',
              sender: { kind: 'agent', id: 'agent:one' },
              threadId: null,
              parentMessageId: null,
              body: { text: 'answer', format: 'markdown' },
            },
          ] as ChannelMessage[],
          runs: [
            {
              id: 'chrun:included',
              channelId: 'topic:a',
              threadId: null,
              requestMessageId: 'chm:request',
              requesterId: 'human:one',
              state: 'completed',
              targets: [],
              createdAt: '2026-08-12T00:00:00.000Z',
              updatedAt: '2026-08-12T00:00:00.000Z',
            },
          ],
          members: [],
          latestSeq: 9,
          inFlight: [{ messageId: 'chm:unmatched', deltaIndex: 3 }],
          truncated: false,
        });
        sink.close({ code: 'transport-closed' });
      },
    });
    const response = await fetch(
      `http://127.0.0.1:${port}/channels/topic%3Aa/subscribe?status=complete&terminalOnly=true`,
      { headers: { 'x-relay-cli-gateway': 'v1' } }
    );
    const frames = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(frames.map((frame) => frame.durableSeq)).toEqual([0, 9, 9]);
    expect(frames[1].payload).toMatchObject({
      type: 'channel-snapshot-v1',
      messages: [{ id: 'chm:matched' }],
      runs: [],
      latestSeq: 9,
      inFlight: [],
      truncated: false,
    });
  });

  it('treats explicit false booleans as the exact unfiltered stream', async () => {
    const subscribe = (sink: ChannelEventSink) => {
      sink.send({
        type: 'channel-message-delta-v1',
        channelId: 'topic:a',
        timestamp: '2026-08-12T00:00:00.000Z',
        messageId: 'chm:stream',
        deltaIndex: 1,
        delta: { text: 'delta' },
      });
      sink.close({ code: 'transport-closed' });
    };
    const unfilteredPort = await listen({ channelIds: ['topic:a'], subscribe });
    const falsePort = await listen({ channelIds: ['topic:a'], subscribe });
    const headers = { 'x-relay-cli-gateway': 'v1' };
    const [unfiltered, falseOnly] = await Promise.all([
      fetch(`http://127.0.0.1:${unfilteredPort}/channels/topic%3Aa/subscribe`, {
        headers,
      }).then((response) => response.text()),
      fetch(
        `http://127.0.0.1:${falsePort}/channels/topic%3Aa/subscribe?terminalOnly=false&principalOnly=false`,
        { headers }
      ).then((response) => response.text()),
    ]);
    expect(falseOnly).toBe(unfiltered);
  });

  it('projects only prose created/completed rows, never deleted tombstones', async () => {
    const message = (
      id: string,
      seq: number,
      status: 'streaming' | 'complete',
      text: string,
      meta?: Record<string, unknown>
    ) =>
      ({
        id,
        channelId: 'topic:a',
        seq,
        kind: 'message',
        status,
        sender: { kind: 'human', id: 'human:one' },
        body: { text, format: 'markdown' },
        threadId: null,
        parentMessageId: null,
        createdAt: '2026-08-12T00:00:00.000Z',
        ...(meta ? { meta } : {}),
      }) as ChannelMessage;
    const port = await listen({
      channelIds: ['topic:a'],
      subscribe: (sink) => {
        sink.send({
          type: 'channel-message-created-v1',
          channelId: 'topic:a',
          timestamp: '2026-08-12T00:00:00.000Z',
          message: message('chm:created', 1, 'streaming', 'draft'),
        });
        sink.send({
          type: 'channel-message-completed-v1',
          channelId: 'topic:a',
          timestamp: '2026-08-12T00:00:00.000Z',
          message: message('chm:completed', 1, 'complete', 'answer'),
        });
        sink.send({
          type: 'channel-message-deleted-v1',
          channelId: 'topic:a',
          timestamp: '2026-08-12T00:00:00.000Z',
          message: message('chm:deleted', 2, 'complete', '', {
            deletedAt: '2026-08-12T00:00:00.000Z',
          }),
        });
        sink.close({ code: 'transport-closed' });
      },
    });
    const frames = (
      await fetch(
        `http://127.0.0.1:${port}/channels/topic%3Aa/subscribe?principalOnly=true`,
        { headers: { 'x-relay-cli-gateway': 'v1' } }
      ).then((response) => response.text())
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(
      frames
        .filter((frame) => frame.frame === 'event')
        .map((frame) => frame.payload.message.id)
    ).toEqual(['chm:created', 'chm:completed']);
    // Created rows advance the durable append cursor; lifecycle replacements
    // retain it even when their semantic projection is suppressed.
    expect(frames.map((frame) => frame.durableSeq)).toEqual([0, 1, 1, 1]);
  });

  it('keeps heartbeat control frames when no semantic row matches', async () => {
    const port = await listen({
      channelIds: ['topic:a'],
      heartbeatMs: 2,
      subscribe: (sink) => {
        sink.send({
          type: 'channel-message-created-v1',
          channelId: 'topic:a',
          timestamp: '2026-08-12T00:00:00.000Z',
          message: { seq: 5, status: 'streaming' } as ChannelMessage,
        });
        setTimeout(() => sink.close({ code: 'transport-closed' }), 12);
      },
    });
    const response = await fetch(
      `http://127.0.0.1:${port}/channels/topic%3Aa/subscribe?afterSeq=4&status=complete`,
      { headers: { 'x-relay-cli-gateway': 'v1' } }
    );
    const frames = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(frames.map((frame) => frame.durableSeq)).toContain(5);
    expect(
      frames.some((frame) => frame.payload?.type === 'channel-heartbeat-v1')
    ).toBe(true);
    expect(
      frames.some(
        (frame) => frame.payload?.type === 'channel-message-created-v1'
      )
    ).toBe(false);
  });

  it('suppresses lifecycle projections under message-only filters', async () => {
    const port = await listen({
      channelIds: ['topic:a'],
      subscribe: (sink) => {
        sink.send({
          type: 'channel-run-lifecycle-v1',
          channelId: 'topic:a',
          timestamp: '2026-08-12T00:00:00.000Z',
          run: {
            id: 'chrun:secret',
            channelId: 'topic:a',
            threadId: null,
            requestMessageId: 'chm:request',
            requesterId: 'human:one',
            state: 'completed',
            targets: [],
            createdAt: '2026-08-12T00:00:00.000Z',
            updatedAt: '2026-08-12T00:00:00.000Z',
          },
        });
        sink.close({ code: 'transport-closed' });
      },
    });
    const response = await fetch(
      `http://127.0.0.1:${port}/channels/topic%3Aa/subscribe?senderId=agent%3Aone`,
      { headers: { 'x-relay-cli-gateway': 'v1' } }
    );
    const frames = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(frames.map((frame) => frame.frame)).toEqual(['open', 'closed']);
    expect(JSON.stringify(frames)).not.toContain('chrun:secret');
  });

  it('rejects an actor outside the exact channel scope before subscribing', async () => {
    let subscribed = false;
    const port = await listen({
      channelIds: ['topic:a'],
      subscribe: () => {
        subscribed = true;
      },
    });
    const response = await fetch(
      `http://127.0.0.1:${port}/channels/topic%3Ab/subscribe`,
      { headers: { 'x-relay-cli-gateway': 'v1' } }
    );
    expect(response.status).toBe(403);
    expect(subscribed).toBe(false);
  });

  it('keeps ephemeral deltas on the last committed durable cursor', async () => {
    const port = await listen({
      channelIds: ['topic:a'],
      subscribe: (sink, afterSeq) => {
        expect(afterSeq).toBe(4);
        sink.send({
          type: 'channel-message-delta-v1',
          channelId: 'topic:a',
          timestamp: '2026-08-11T00:00:00.000Z',
          messageId: 'chm:test',
          deltaIndex: 1,
          delta: { text: 'later' },
        });
        sink.close({ code: 'transport-closed' });
      },
    });
    const response = await fetch(
      `http://127.0.0.1:${port}/channels/topic%3Aa/subscribe?afterSeq=4`,
      { headers: { 'x-relay-cli-gateway': 'v1' } }
    );
    const frames = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(frames.map((frame) => frame.durableSeq)).toEqual([4, 4, 4]);
    expect(frames.map((frame) => frame.frame)).toEqual([
      'open',
      'event',
      'closed',
    ]);
  });

  it('keeps the message cursor stable for a durable run lifecycle projection', async () => {
    const port = await listen({
      channelIds: ['topic:a'],
      subscribe: (sink, afterSeq) => {
        expect(afterSeq).toBe(4);
        sink.send({
          type: 'channel-run-lifecycle-v1',
          channelId: 'topic:a',
          timestamp: '2026-08-11T00:00:00.000Z',
          run: {
            id: 'chrun:opaque',
            channelId: 'topic:a',
            threadId: null,
            requestMessageId: 'chm:request',
            requesterId: 'actor:external',
            state: 'working',
            targets: [],
            createdAt: '2026-08-11T00:00:00.000Z',
            updatedAt: '2026-08-11T00:00:00.000Z',
          },
        });
        sink.close({ code: 'transport-closed' });
      },
    });
    const response = await fetch(
      `http://127.0.0.1:${port}/channels/topic%3Aa/subscribe?afterSeq=4`,
      { headers: { 'x-relay-cli-gateway': 'v1' } }
    );
    const frames = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(frames.map((frame) => frame.durableSeq)).toEqual([4, 4, 4]);
    expect(frames[1]).toMatchObject({
      frame: 'event',
      payload: {
        type: 'channel-run-lifecycle-v1',
        run: { id: 'chrun:opaque' },
      },
    });
  });

  it('closes before delivery when the actor is revoked mid-stream', async () => {
    let authorized = true;
    const port = await listen({
      channelIds: ['topic:a'],
      isStillAuthorized: () => authorized,
      subscribe: (sink) => {
        authorized = false;
        sink.send({
          type: 'channel-message-created-v1',
          channelId: 'topic:a',
          timestamp: '2026-08-11T00:00:00.000Z',
          message: { seq: 8 } as ChannelMessage,
        });
      },
    });
    const response = await fetch(
      `http://127.0.0.1:${port}/channels/topic%3Aa/subscribe`,
      { headers: { 'x-relay-cli-gateway': 'v1' } }
    );
    const frames = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(frames).toMatchObject([
      { frame: 'open', durableSeq: 0 },
      {
        frame: 'closed',
        durableSeq: 0,
        reason: 'authorization-revoked',
        retryable: false,
      },
    ]);
  });

  it('advances only through snapshot rows contiguous with afterSeq', async () => {
    const port = await listen({
      channelIds: ['topic:a'],
      subscribe: (sink) => {
        sink.send({
          type: 'channel-snapshot-v1',
          channelId: 'topic:a',
          timestamp: '2026-08-11T00:00:00.000Z',
          mode: 'catchup',
          messages: [
            { seq: 5 } as ChannelMessage,
            { seq: 6 } as ChannelMessage,
            { seq: 8 } as ChannelMessage,
          ],
          members: [],
          latestSeq: 12,
          inFlight: [],
          truncated: true,
        });
        sink.close({ code: 'transport-closed' });
      },
    });
    const response = await fetch(
      `http://127.0.0.1:${port}/channels/topic%3Aa/subscribe?afterSeq=4`,
      { headers: { 'x-relay-cli-gateway': 'v1' } }
    );
    const frames = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(frames.map((frame) => frame.durableSeq)).toEqual([4, 6, 6]);
  });

  it('flushes a large accepted snapshot after res.write signals backpressure', async () => {
    const largeText = 'x'.repeat(128 * 1024);
    let unsubscribed = 0;
    const port = await listen({
      channelIds: ['topic:a'],
      onUnsubscribe: () => {
        unsubscribed += 1;
      },
      subscribe: (sink) => {
        sink.send({
          type: 'channel-snapshot-v1',
          channelId: 'topic:a',
          timestamp: '2026-08-11T00:00:00.000Z',
          mode: 'catchup',
          messages: [
            {
              seq: 1,
              body: { text: largeText },
            } as ChannelMessage,
          ],
          members: [],
          latestSeq: 1,
          inFlight: [],
          truncated: false,
        });
        sink.close({ code: 'transport-closed' });
      },
    });
    const response = await fetch(
      `http://127.0.0.1:${port}/channels/topic%3Aa/subscribe?afterSeq=0`,
      { headers: { 'x-relay-cli-gateway': 'v1' } }
    );
    const text = await response.text();
    expect(text).toContain(largeText);
    expect(text).toContain('"durableSeq":1');
    expect(unsubscribed).toBe(1);
  });

  it('cleans the subscription and heartbeat when the client aborts', async () => {
    let unsubscribed = 0;
    const port = await listen({
      channelIds: ['topic:a'],
      heartbeatMs: 5,
      onUnsubscribe: () => {
        unsubscribed += 1;
      },
    });
    const controller = new AbortController();
    const response = await fetch(
      `http://127.0.0.1:${port}/channels/topic%3Aa/subscribe`,
      {
        headers: { 'x-relay-cli-gateway': 'v1' },
        signal: controller.signal,
      }
    );
    await response.body?.getReader().read();
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(unsubscribed).toBe(1);
  });

  it('bounds a non-draining idle subscription and cleans up exactly once', async () => {
    let writes = 0;
    let unsubscribed = 0;
    const port = await listen({
      channelIds: ['topic:a'],
      heartbeatMs: 1,
      drainTimeoutMs: 15,
      writeResponse: () => {
        writes += 1;
        return false;
      },
      onUnsubscribe: () => {
        unsubscribed += 1;
      },
    });
    const response = await fetch(
      `http://127.0.0.1:${port}/channels/topic%3Aa/subscribe`,
      { headers: { 'x-relay-cli-gateway': 'v1' } }
    );
    const frames = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    expect(writes).toBe(1); // open crossed high-water; heartbeats were suppressed
    expect(unsubscribed).toBe(1);
    expect(frames).toMatchObject([
      {
        schemaVersion: 1,
        frame: 'closed',
        reason: 'backpressure',
        retryable: true,
      },
    ]);
  });
});
