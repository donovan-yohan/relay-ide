import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import {
  attachAuthenticatedCliGatewayActorCredential,
  createCliGatewayActorRegistry,
  issueCliGatewayActorCredential,
  issueLocalHubCliActorCredential,
  validateCliGatewayActorCredential,
  CLI_GATEWAY_READ_SCOPE_TASK_REF,
} from '../server/cli-gateway-actor-auth.js';
import { createChannelHub } from '../server/channel-hub.js';
import { createChannelMessageStore } from '../server/channel-message-store.js';
import { createChannelSubscriptionRouter } from '../server/channel-subscription-router.js';
import type { ChannelEventSink, ChannelHub } from '../server/channel-hub.js';
import {
  applyChannelEventV1,
  initialChannelReducerState,
  type ChannelEventV1,
  type ChannelMessage,
} from '../shared/channel-chat-protocol.js';
import type { ScopedActorCredentialRecord } from '../shared/scoped-actor-credentials.js';

const servers: http.Server[] = [];
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  while (cleanup.length > 0) cleanup.pop()?.();
});

async function listen(input: {
  channelIds: string[];
  subscribe?: (sink: ChannelEventSink, afterSeq: number | null) => void;
  isStillAuthorized?: (req: express.Request, channelId: string) => boolean;
  onUnsubscribe?: () => void;
  heartbeatMs?: number;
  drainTimeoutMs?: number;
  writableSoftLimitBytes?: number;
  writableLowWatermarkBytes?: number;
  writableHardLimitBytes?: number;
  writeResponse?: (res: express.Response, data: string) => boolean;
  hub?: ChannelHub;
  /** #1455 membership oracle. Defaults to "everyone is a member" so the
   *  transport tests keep testing transport; membership has its own case. */
  isMember?: (channelId: string) => boolean;
  /** Override the attached credential (#1476 host-local lane). */
  credential?: ScopedActorCredentialRecord;
}): Promise<number> {
  const app = express();
  app.use((req, _res, next) => {
    attachAuthenticatedCliGatewayActorCredential(
      req,
      input.credential ??
        ({
          id: 'credential:test',
          actor: { type: 'agent', id: 'actor:test', displayName: 'Test' },
          capabilities: ['context:read'],
          scope: { channelIds: input.channelIds },
        } as ScopedActorCredentialRecord)
    );
    next();
  });
  const hub =
    input.hub ??
    ({
      channelExists: (id: string) => id === 'topic:a' || id === 'topic:b',
      subscribe: (
        sink: ChannelEventSink,
        value: { afterSeq: number | null }
      ) => {
        input.subscribe?.(sink, value.afterSeq);
        return () => input.onUnsubscribe?.();
      },
    } as unknown as ChannelHub);
  app.use(
    createChannelSubscriptionRouter({
      hub,
      store: {
        isMember: (channelId: string) => input.isMember?.(channelId) ?? true,
      },
      requireSubscribeAuth: (_req, _res, next) => next(),
      now: () => new Date('2026-08-12T00:00:00.000Z'),
      heartbeatMs: input.heartbeatMs ?? 60_000,
      ...(input.drainTimeoutMs !== undefined
        ? { drainTimeoutMs: input.drainTimeoutMs }
        : {}),
      ...(input.writableSoftLimitBytes !== undefined
        ? { writableSoftLimitBytes: input.writableSoftLimitBytes }
        : {}),
      ...(input.writableLowWatermarkBytes !== undefined
        ? { writableLowWatermarkBytes: input.writableLowWatermarkBytes }
        : {}),
      ...(input.writableHardLimitBytes !== undefined
        ? { writableHardLimitBytes: input.writableHardLimitBytes }
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

function createNdjsonReader(response: Response): () => Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('missing NDJSON response body');
  const decoder = new TextDecoder();
  let buffered = '';
  return async () => {
    while (true) {
      const newline = buffered.indexOf('\n');
      if (newline !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line) return JSON.parse(line) as unknown;
        continue;
      }
      const { done, value } = await reader.read();
      if (done) throw new Error('NDJSON stream ended before the next frame');
      buffered += decoder.decode(value, { stream: true });
    }
  };
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      'threadId=chm%3A%20%20%20',
      'messageId=chm%3A%09',
      'runId=chrun%3A%20%0A',
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
            schemaVersion: 1,
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
              card: { kind: 'tool_call', title: 'x', status: 'completed' },
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
            schemaVersion: 1,
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
              schemaVersion: 1,
              id: 'chm:unmatched',
              channelId: 'topic:a',
              createdAt: '2026-08-12T00:00:00.000Z',
              updatedAt: '2026-08-12T00:00:00.000Z',
              seq: 5,
              kind: 'message',
              status: 'streaming',
              sender: { kind: 'agent', id: 'agent:one' },
              threadId: null,
              parentMessageId: null,
              body: { text: 'intermediate', format: 'markdown' },
            },
            {
              schemaVersion: 1,
              id: 'chm:matched',
              channelId: 'topic:a',
              createdAt: '2026-08-12T00:00:00.000Z',
              updatedAt: '2026-08-12T00:00:00.000Z',
              seq: 6,
              kind: 'message',
              status: 'complete',
              sender: { kind: 'agent', id: 'agent:one' },
              threadId: null,
              parentMessageId: null,
              body: { text: 'answer', format: 'markdown' },
            },
          ] as ChannelMessage[],
          stateReplacements: [
            {
              message: {
                schemaVersion: 1,
                id: 'chm:stale-at-cursor',
                channelId: 'topic:a',
                createdAt: '2026-08-12T00:00:00.000Z',
                updatedAt: '2026-08-12T00:00:00.000Z',
                seq: 3,
                kind: 'message',
                status: 'complete',
                sender: { kind: 'agent', id: 'agent:one' },
                threadId: null,
                parentMessageId: null,
                body: { text: 'stale answer', format: 'markdown' },
              },
            },
          ],
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
      `http://127.0.0.1:${port}/channels/topic%3Aa/subscribe?afterSeq=4&status=complete&terminalOnly=true&principalOnly=true`,
      { headers: { 'x-relay-cli-gateway': 'v1' } }
    );
    const frames = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(frames.map((frame) => frame.durableSeq)).toEqual([4, 9, 9]);
    expect(frames[1].payload).toMatchObject({
      type: 'channel-snapshot-v1',
      messages: [{ id: 'chm:matched' }],
      runs: [],
      latestSeq: 9,
      inFlight: [],
      truncated: false,
    });
    expect(frames[1].payload.stateReplacements).toEqual([
      {
        message: expect.objectContaining({ id: 'chm:stale-at-cursor', seq: 3 }),
      },
    ]);
    expect(
      frames[1].payload.messages.map((message: ChannelMessage) => message.id)
    ).toEqual(['chm:matched']);
    expect(
      frames[1].payload.messages.every(
        (message: ChannelMessage) => message.seq > 4
      )
    ).toBe(true);
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

  it('rejects a scoped non-member before subscribing (#1455 slice 1)', async () => {
    let subscribed = false;
    const port = await listen({
      channelIds: ['topic:a'],
      isMember: () => false,
      subscribe: () => {
        subscribed = true;
      },
    });
    const response = await fetch(
      `http://127.0.0.1:${port}/channels/topic%3Aa/subscribe`,
      { headers: { 'x-relay-cli-gateway': 'v1' } }
    );
    expect(response.status).toBe(403);
    expect(
      (
        (await response.json()) as {
          error: { details?: { reasonCode?: string } };
        }
      ).error.details?.reasonCode
    ).toBe('CHANNEL_NOT_MEMBER');
    // Scope was satisfied; membership is what refused, and it refused BEFORE
    // the hub handed out a subscriber slot.
    expect(subscribed).toBe(false);
  });

  it('streams for the host-local CLI credential that names no channel (#1476)', async () => {
    // The host-local credential (#1467) is minted with taskRefs only — no
    // `channelIds` — so before #1476 both the enumeration guard here and the
    // per-frame recheck refused it while `channels.list` worked.
    const registry = createCliGatewayActorRegistry({ maxTtlMs: 60_000 });
    const local = issueLocalHubCliActorCredential(registry, {
      actor: { type: 'cli', id: 'local-cli', displayName: 'relay-ide local' },
      issuer: { id: 'hub-local-boot' },
      capabilities: ['session:read', 'context:read', 'context:write'],
      scope: { taskRefs: [CLI_GATEWAY_READ_SCOPE_TASK_REF] },
      ttlMs: 60_000,
    });
    expect(local.credential.scope?.channelIds).toBeUndefined();

    const port = await listen({
      channelIds: [],
      credential: local.credential,
      // The REAL per-frame closure shape from `server/index.ts`: revalidate the
      // bearer token against the channel being streamed before every frame.
      isStillAuthorized: (_req, channelId) =>
        !(
          'reason' in
          validateCliGatewayActorCredential(registry, {
            token: local.token,
            capabilities: ['context:read'],
            scope: { channelIds: [channelId] },
          })
        ),
      subscribe: (sink) => {
        sink.send({
          type: 'channel-message-created-v1',
          channelId: 'topic:a',
          timestamp: '2026-08-11T00:00:00.000Z',
          message: { seq: 1 } as ChannelMessage,
        });
        sink.close({ code: 'transport-closed' });
      },
    });
    const response = await fetch(
      `http://127.0.0.1:${port}/channels/topic%3Aa/subscribe`,
      { headers: { 'x-relay-cli-gateway': 'v1' } }
    );
    expect(response.status).toBe(200);
    const frames = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    // Open + the event frame both survived the per-frame revalidation.
    expect(frames.map((frame) => frame.frame)).toEqual([
      'open',
      'event',
      'closed',
    ]);
  });

  it('still refuses a delegated actor credential that names no channel (#1476)', async () => {
    // Same absent `channelIds`, no host-local marker: the fail-closed lane is
    // unchanged for every credential a remote/delegated caller can hold.
    const registry = createCliGatewayActorRegistry({ maxTtlMs: 60_000 });
    const delegated = issueCliGatewayActorCredential(registry, {
      actor: { type: 'agent', id: 'agent:remote' },
      issuer: { id: 'operator' },
      capabilities: ['session:read', 'context:read'],
      scope: { taskRefs: [CLI_GATEWAY_READ_SCOPE_TASK_REF] },
      ttlMs: 60_000,
    });
    expect(delegated.credential.scope?.channelIds).toBeUndefined();

    let subscribed = false;
    const port = await listen({
      channelIds: [],
      credential: delegated.credential,
      subscribe: () => {
        subscribed = true;
      },
    });
    const response = await fetch(
      `http://127.0.0.1:${port}/channels/topic%3Aa/subscribe`,
      { headers: { 'x-relay-cli-gateway': 'v1' } }
    );
    expect(response.status).toBe(403);
    expect(subscribed).toBe(false);
    // ...and the per-frame revalidation would have refused it as well.
    expect(
      validateCliGatewayActorCredential(registry, {
        token: delegated.token,
        capabilities: ['context:read'],
        scope: { channelIds: ['topic:a'] },
      })
    ).toMatchObject({ reason: 'wrong_channel_scope' });
  });

  it('fails closed for a scoped actor when no membership store is wired', async () => {
    const app = express();
    app.use((req, _res, next) => {
      attachAuthenticatedCliGatewayActorCredential(req, {
        id: 'credential:test',
        actor: { type: 'agent', id: 'actor:test', displayName: 'Test' },
        capabilities: ['context:read'],
        scope: { channelIds: ['topic:a'] },
      } as ScopedActorCredentialRecord);
      next();
    });
    app.use(
      createChannelSubscriptionRouter({
        hub: {
          channelExists: () => true,
          subscribe: () => () => {},
        } as unknown as ChannelHub,
        requireSubscribeAuth: (_req, _res, next) => next(),
      })
    );
    const server = http.createServer(app);
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('missing port');
    const response = await fetch(
      `http://127.0.0.1:${address.port}/channels/topic%3Aa/subscribe`,
      { headers: { 'x-relay-cli-gateway': 'v1' } }
    );
    expect(response.status).toBe(403);
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

  it('keeps at-cursor refreshes in the replacement lane through an explicit HTTP catch-up', async () => {
    const port = await listen({
      channelIds: ['topic:a'],
      subscribe: (sink) => {
        // The hub intentionally includes seq 3 to replace a row which changed
        // in place while the client was away. It is not durable progress after
        // the explicit cursor 4, so HTTP subscribers must not see it again.
        sink.send({
          type: 'channel-snapshot-v1',
          channelId: 'topic:a',
          timestamp: '2026-08-11T00:00:00.000Z',
          mode: 'catchup',
          // Deliberately minimal rows: the assertion below compares
          // stateReplacements with an exact `toEqual`, so these fixtures must
          // not carry extra fields.
          messages: [{ id: 'chm:fresh', seq: 5 } as unknown as ChannelMessage],
          stateReplacements: [
            {
              message: {
                id: 'chm:resync',
                seq: 3,
              } as unknown as ChannelMessage,
              inFlight: { messageId: 'chm:resync', deltaIndex: 1 },
            },
          ],
          members: [],
          latestSeq: 5,
          inFlight: [{ messageId: 'chm:fresh', deltaIndex: 2 }],
          truncated: false,
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

    expect(frames.map((frame) => frame.durableSeq)).toEqual([4, 5, 5]);
    expect(frames[1]?.payload).toMatchObject({
      type: 'channel-snapshot-v1',
      mode: 'catchup',
      messages: [{ seq: 5 }],
      latestSeq: 5,
      inFlight: [{ messageId: 'chm:fresh', deltaIndex: 2 }],
    });
    expect(frames[1]?.payload.messages).toHaveLength(1);
    expect(frames[1]?.payload.stateReplacements).toEqual([
      {
        message: { id: 'chm:resync', seq: 3 },
        inFlight: { messageId: 'chm:resync', deltaIndex: 1 },
      },
    ]);
  });

  it('reconstructs an agent stream exactly across a real hub and HTTP resume handoff', async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'relay-subscribe-resume-')
    );
    const store = createChannelMessageStore(path.join(dir, 'channel-chat.db'));
    const hub = createChannelHub({
      store,
      channelExists: (id) => id === 'topic:a',
      coalesceMs: 5,
    });
    cleanup.push(() => hub.close());
    cleanup.push(() => store.close());
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));

    const streaming = store.beginStream({
      channelId: 'topic:a',
      sender: { kind: 'agent', id: 'agent:claude', providerId: 'claude' },
      source: { runtimeId: 'resume-test' },
    });
    hub.beginStreamBroadcast(streaming);
    const port = await listen({ channelIds: ['topic:a'], hub });
    const headers = { 'x-relay-cli-gateway': 'v1' };

    const firstAbort = new AbortController();
    const firstResponse = await fetch(
      `http://127.0.0.1:${port}/channels/topic%3Aa/subscribe?afterSeq=0`,
      { headers, signal: firstAbort.signal }
    );
    const firstFrame = createNdjsonReader(firstResponse);
    await firstFrame(); // open
    const initial = (await firstFrame()) as {
      payload: ChannelEventV1;
      durableSeq: number;
    };
    expect(initial.payload.type).toBe('channel-snapshot-v1');
    if (initial.payload.type !== 'channel-snapshot-v1')
      throw new Error('expected initial snapshot');
    expect(initial.payload.messages.map((message) => message.seq)).toEqual([
      streaming.seq,
    ]);
    let state = applyChannelEventV1(
      initialChannelReducerState('topic:a'),
      initial.payload
    );
    expect(state.lastSeq).toBe(streaming.seq);
    firstAbort.abort();
    await pause(0);

    // This flush happened while the first HTTP subscriber was disconnected.
    hub.pushDelta(streaming.id, 'hello ');
    await pause(15);

    const resumedAbort = new AbortController();
    const resumedResponse = await fetch(
      `http://127.0.0.1:${port}/channels/topic%3Aa/subscribe?afterSeq=${state.lastSeq}`,
      { headers, signal: resumedAbort.signal }
    );
    const resumedFrame = createNdjsonReader(resumedResponse);
    await resumedFrame(); // open
    const replacementFrame = (await resumedFrame()) as {
      payload: ChannelEventV1;
      durableSeq: number;
    };
    expect(replacementFrame.payload.type).toBe('channel-snapshot-v1');
    if (replacementFrame.payload.type !== 'channel-snapshot-v1')
      throw new Error('expected catch-up snapshot');
    expect(replacementFrame.payload.messages).toEqual([]);
    expect(replacementFrame.payload.stateReplacements).toEqual([
      {
        message: expect.objectContaining({
          id: streaming.id,
          seq: streaming.seq,
          body: expect.objectContaining({ text: 'hello ' }),
        }),
        inFlight: { messageId: streaming.id, deltaIndex: 0 },
      },
    ]);
    state = applyChannelEventV1(state, replacementFrame.payload);
    expect(state.lastSeq).toBe(streaming.seq);
    expect(state.byId[streaming.id]?.body.text).toBe('hello ');

    hub.pushDelta(streaming.id, 'world');
    await pause(15);
    const final = store.finalizeStream(streaming.id, {
      text: 'hello world',
      status: 'complete',
    });
    if (!final) throw new Error('expected final stream row');
    hub.completeStreamBroadcast(final);

    const deltaFrame = (await resumedFrame()) as { payload: ChannelEventV1 };
    const completedFrame = (await resumedFrame()) as {
      payload: ChannelEventV1;
    };
    expect(deltaFrame.payload).toMatchObject({
      type: 'channel-message-delta-v1',
      messageId: streaming.id,
      deltaIndex: 1,
      delta: { text: 'world' },
    });
    expect(completedFrame.payload).toMatchObject({
      type: 'channel-message-completed-v1',
      message: { id: streaming.id, body: { text: 'hello world' } },
    });
    state = applyChannelEventV1(state, deltaFrame.payload);
    state = applyChannelEventV1(state, completedFrame.payload);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.body.text).toBe('hello world');
    expect(state.lastSeq).toBe(streaming.seq);
    expect(state.needsCatchup).toBe(false);
    resumedAbort.abort();
  });

  it('resumes from durable afterSeq across a store reopen with no replay or seq reset (#1570)', async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'relay-subscribe-reopen-')
    );
    const dbPath = path.join(dir, 'channel-chat.db');
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));

    const store1 = createChannelMessageStore(dbPath);
    const hub1 = createChannelHub({
      store: store1,
      channelExists: (id) => id === 'topic:a',
      coalesceMs: 5,
    });

    const first = store1.appendComplete({
      channelId: 'topic:a',
      sender: { kind: 'human', id: 'human:one' },
      text: 'first',
    });
    hub1.broadcastCreated(first, first.mentions ?? []);

    const port1 = await listen({ channelIds: ['topic:a'], hub: hub1 });
    const headers = { 'x-relay-cli-gateway': 'v1' };
    const abort1 = new AbortController();
    const response1 = await fetch(
      `http://127.0.0.1:${port1}/channels/topic%3Aa/subscribe?afterSeq=0`,
      { headers, signal: abort1.signal }
    );
    const read1 = createNdjsonReader(response1);
    await read1(); // open
    const snapshotFrame1 = (await read1()) as { payload: ChannelEventV1 };
    expect(snapshotFrame1.payload.type).toBe('channel-snapshot-v1');
    if (snapshotFrame1.payload.type !== 'channel-snapshot-v1') {
      throw new Error('expected snapshot');
    }
    expect(snapshotFrame1.payload.messages.map((m) => m.id)).toContain(
      first.id
    );
    abort1.abort();
    await pause(0);

    hub1.close();
    store1.close();

    const store2 = createChannelMessageStore(dbPath);
    const hub2 = createChannelHub({
      store: store2,
      channelExists: (id) => id === 'topic:a',
      coalesceMs: 5,
    });
    cleanup.push(() => hub2.close());
    cleanup.push(() => store2.close());

    const second = store2.appendComplete({
      channelId: 'topic:a',
      sender: { kind: 'human', id: 'human:one' },
      text: 'second',
    });
    expect(second.seq).toBeGreaterThan(first.seq);
    hub2.broadcastCreated(second, second.mentions ?? []);

    const port2 = await listen({ channelIds: ['topic:a'], hub: hub2 });
    const abort2 = new AbortController();
    const response2 = await fetch(
      `http://127.0.0.1:${port2}/channels/topic%3Aa/subscribe?afterSeq=${first.seq}`,
      { headers, signal: abort2.signal }
    );
    const read2 = createNdjsonReader(response2);
    await read2(); // open
    const snapshotFrame2 = (await read2()) as { payload: ChannelEventV1 };
    expect(snapshotFrame2.payload.type).toBe('channel-snapshot-v1');
    if (snapshotFrame2.payload.type !== 'channel-snapshot-v1') {
      throw new Error('expected snapshot');
    }
    expect(snapshotFrame2.payload.messages.map((m) => m.id)).not.toContain(
      first.id
    );
    expect(snapshotFrame2.payload.messages.map((m) => m.id)).toContain(
      second.id
    );
    abort2.abort();
  });

  it('keeps full snapshots when the cursor is omitted or requires a reset', async () => {
    const subscribe = (sink: ChannelEventSink) => {
      sink.send({
        type: 'channel-snapshot-v1',
        channelId: 'topic:a',
        timestamp: '2026-08-11T00:00:00.000Z',
        mode: 'full',
        messages: [{ seq: 3 } as ChannelMessage],
        members: [],
        latestSeq: 3,
        inFlight: [],
        truncated: false,
      });
      sink.close({ code: 'transport-closed' });
    };
    const [omittedPort, resetPort] = await Promise.all([
      listen({ channelIds: ['topic:a'], subscribe }),
      listen({ channelIds: ['topic:a'], subscribe }),
    ]);
    const headers = { 'x-relay-cli-gateway': 'v1' };
    const [omitted, reset] = await Promise.all(
      [
        `http://127.0.0.1:${omittedPort}/channels/topic%3Aa/subscribe`,
        `http://127.0.0.1:${resetPort}/channels/topic%3Aa/subscribe?afterSeq=4`,
      ].map(async (url) => {
        const response = await fetch(url, { headers });
        return (await response.text())
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
      })
    );

    for (const frames of [omitted!, reset!]) {
      expect(frames[1]?.payload).toMatchObject({
        type: 'channel-snapshot-v1',
        mode: 'full',
        messages: [{ seq: 3 }],
      });
    }
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

  it('drops ephemeral deltas when send queue exceeds soft limit, keeps durable frames, and emits channel-resync-required on drain', async () => {
    let fakeBuffered = 0;
    const port = await listen({
      channelIds: ['topic:a'],
      writableSoftLimitBytes: 100,
      writableLowWatermarkBytes: 50,
      writableHardLimitBytes: 1000,
      writeResponse: (res, data) => {
        Object.defineProperty(res, 'writableLength', {
          get: () => fakeBuffered,
          configurable: true,
        });
        return res.write(data);
      },
      subscribe: (sink) => {
        // Initial durable created event
        sink.send({
          type: 'channel-message-created-v1',
          channelId: 'topic:a',
          timestamp: '2026-08-11T00:00:00.000Z',
          message: {
            schemaVersion: 1,
            channelId: 'topic:a',
            id: 'chm:1',
            seq: 1,
            kind: 'message',
            status: 'streaming',
            sender: { kind: 'agent', id: 'agent:one' },
            body: { text: 'start', format: 'markdown' },
            threadId: null,
            parentMessageId: null,
            createdAt: '2026-08-11T00:00:00.000Z',
            updatedAt: '2026-08-11T00:00:00.000Z',
          } as ChannelMessage,
        });

        // Push send buffer above soft limit (100)
        fakeBuffered = 150;

        // Ephemeral deltas while over soft limit -> dropped!
        sink.send({
          type: 'channel-message-delta-v1',
          channelId: 'topic:a',
          timestamp: '2026-08-11T00:00:01.000Z',
          messageId: 'chm:1',
          deltaIndex: 1,
          delta: { text: 'delta-1-dropped' },
        });
        sink.send({
          type: 'channel-message-delta-v1',
          channelId: 'topic:a',
          timestamp: '2026-08-11T00:00:02.000Z',
          messageId: 'chm:1',
          deltaIndex: 2,
          delta: { text: 'delta-2-dropped' },
        });

        // Durable completed frame -> NOT dropped!
        sink.send({
          type: 'channel-message-completed-v1',
          channelId: 'topic:a',
          timestamp: '2026-08-11T00:00:03.000Z',
          message: {
            schemaVersion: 1,
            channelId: 'topic:a',
            id: 'chm:1',
            seq: 1,
            kind: 'message',
            status: 'complete',
            sender: { kind: 'agent', id: 'agent:one' },
            body: { text: 'completed message text', format: 'markdown' },
            threadId: null,
            parentMessageId: null,
            createdAt: '2026-08-11T00:00:00.000Z',
            updatedAt: '2026-08-11T00:00:03.000Z',
          } as ChannelMessage,
        });

        // Drain below low watermark (50)
        fakeBuffered = 10;

        // Next event triggers resync emission before sending
        sink.send({
          type: 'channel-message-created-v1',
          channelId: 'topic:a',
          timestamp: '2026-08-11T00:00:04.000Z',
          message: {
            schemaVersion: 1,
            channelId: 'topic:a',
            id: 'chm:2',
            seq: 2,
            kind: 'message',
            status: 'complete',
            sender: { kind: 'agent', id: 'agent:one' },
            body: { text: 'next', format: 'markdown' },
            threadId: null,
            parentMessageId: null,
            createdAt: '2026-08-11T00:00:04.000Z',
            updatedAt: '2026-08-11T00:00:04.000Z',
          } as ChannelMessage,
        });

        sink.close({ code: 'transport-closed' });
      },
    });

    const response = await fetch(
      `http://127.0.0.1:${port}/channels/topic%3Aa/subscribe?afterSeq=0`,
      { headers: { 'x-relay-cli-gateway': 'v1' } }
    );
    const frames = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    const eventTypes = frames
      .filter((f) => f.frame === 'event')
      .map((f) => f.payload.type);

    expect(eventTypes).toEqual([
      'channel-message-created-v1',
      'channel-message-completed-v1',
      'channel-resync-required-v1',
      'channel-message-created-v1',
    ]);
    expect(
      frames.some((f) => f.payload?.type === 'channel-message-delta-v1')
    ).toBe(false);
    expect(JSON.stringify(frames)).not.toContain('delta-1-dropped');
    expect(JSON.stringify(frames)).not.toContain('delta-2-dropped');
  });

  it('closes with backpressure when durable frames alone exceed the hard limit', async () => {
    let fakeBuffered = 0;
    const port = await listen({
      channelIds: ['topic:a'],
      writableSoftLimitBytes: 100,
      writableHardLimitBytes: 500,
      writeResponse: (res, data) => {
        Object.defineProperty(res, 'writableLength', {
          get: () => fakeBuffered,
          configurable: true,
        });
        return res.write(data);
      },
      subscribe: (sink) => {
        fakeBuffered = 600; // Above hard limit
        sink.send({
          type: 'channel-message-created-v1',
          channelId: 'topic:a',
          timestamp: '2026-08-11T00:00:00.000Z',
          message: {
            schemaVersion: 1,
            channelId: 'topic:a',
            id: 'chm:1',
            seq: 1,
            kind: 'message',
            status: 'complete',
            sender: { kind: 'human', id: 'human:one' },
            body: { text: 'overflow', format: 'markdown' },
            threadId: null,
            parentMessageId: null,
            createdAt: '2026-08-11T00:00:00.000Z',
            updatedAt: '2026-08-11T00:00:00.000Z',
          } as ChannelMessage,
        });
      },
    });

    const response = await fetch(
      `http://127.0.0.1:${port}/channels/topic%3Aa/subscribe?afterSeq=0`,
      { headers: { 'x-relay-cli-gateway': 'v1' } }
    );
    const frames = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    expect(frames).toMatchObject([
      { frame: 'open' },
      {
        frame: 'closed',
        reason: 'backpressure',
        retryable: true,
      },
    ]);
  });

  it('suppresses heartbeats while the stream is above soft limit or lagging', async () => {
    let fakeBuffered = 0;
    let registeredSink: ChannelEventSink | undefined;
    const port = await listen({
      channelIds: ['topic:a'],
      heartbeatMs: 20,
      writableSoftLimitBytes: 100,
      writableLowWatermarkBytes: 50,
      writableHardLimitBytes: 500,
      writeResponse: (res, data) => {
        Object.defineProperty(res, 'writableLength', {
          get: () => fakeBuffered,
          configurable: true,
        });
        return res.write(data);
      },
      subscribe: (sink) => {
        registeredSink = sink;
      },
    });

    const abortController = new AbortController();
    const response = await fetch(
      `http://127.0.0.1:${port}/channels/topic%3Aa/subscribe?afterSeq=0`,
      {
        headers: { 'x-relay-cli-gateway': 'v1' },
        signal: abortController.signal,
      }
    );

    const reader = response.body?.getReader();
    if (!reader) throw new Error('missing reader');
    const decoder = new TextDecoder();

    // Read open frame
    const first = await reader.read();
    expect(decoder.decode(first.value)).toContain('"frame":"open"');

    // Simulate soft-limit exceeded & lagging
    fakeBuffered = 150;
    registeredSink?.send({
      type: 'channel-message-delta-v1',
      channelId: 'topic:a',
      timestamp: '2026-08-11T00:00:01.000Z',
      messageId: 'chm:1',
      deltaIndex: 0,
      delta: { text: 'dropped' },
    });

    // Wait for what would have been several heartbeats (20ms each)
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Drain below low watermark
    fakeBuffered = 20;

    // Send next message to trigger resync and complete
    registeredSink?.send({
      type: 'channel-message-created-v1',
      channelId: 'topic:a',
      timestamp: '2026-08-11T00:00:02.000Z',
      message: {
        schemaVersion: 1,
        channelId: 'topic:a',
        id: 'chm:2',
        seq: 2,
        kind: 'message',
        status: 'complete',
        sender: { kind: 'agent', id: 'agent:one' },
        body: { text: 'after drain', format: 'markdown' },
        threadId: null,
        parentMessageId: null,
        createdAt: '2026-08-11T00:00:02.000Z',
        updatedAt: '2026-08-11T00:00:02.000Z',
      } as ChannelMessage,
    });
    registeredSink?.close({ code: 'transport-closed' });

    let remaining = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      remaining += decoder.decode(value);
    }

    const lines = remaining
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const heartbeatFrames = lines.filter(
      (f) => f.payload?.type === 'channel-heartbeat-v1'
    );
    expect(heartbeatFrames).toHaveLength(0);
    expect(
      lines.some((f) => f.payload?.type === 'channel-resync-required-v1')
    ).toBe(true);
  });

  it('closes with backpressure if channel-resync-required-v1 cannot be delivered after shedding', async () => {
    let fakeBuffered = 0;
    const port = await listen({
      channelIds: ['topic:a'],
      writableSoftLimitBytes: 100,
      writableLowWatermarkBytes: 50,
      writableHardLimitBytes: 300,
      writeResponse: (res, data) => {
        Object.defineProperty(res, 'writableLength', {
          get: () => fakeBuffered,
          configurable: true,
        });
        return res.write(data);
      },
      subscribe: (sink) => {
        fakeBuffered = 150;
        // Shed delta
        sink.send({
          type: 'channel-message-delta-v1',
          channelId: 'topic:a',
          timestamp: '2026-08-11T00:00:01.000Z',
          messageId: 'chm:1',
          deltaIndex: 0,
          delta: { text: 'dropped' },
        });
        // Exceed hard limit when resync is attempted
        fakeBuffered = 400;
        sink.send({
          type: 'channel-message-created-v1',
          channelId: 'topic:a',
          timestamp: '2026-08-11T00:00:02.000Z',
          message: {
            schemaVersion: 1,
            channelId: 'topic:a',
            id: 'chm:2',
            seq: 2,
            kind: 'message',
            status: 'complete',
            sender: { kind: 'agent', id: 'agent:one' },
            body: { text: 'hard limit hit', format: 'markdown' },
            threadId: null,
            parentMessageId: null,
            createdAt: '2026-08-11T00:00:02.000Z',
            updatedAt: '2026-08-11T00:00:02.000Z',
          } as ChannelMessage,
        });
      },
    });

    const response = await fetch(
      `http://127.0.0.1:${port}/channels/topic%3Aa/subscribe?afterSeq=0`,
      { headers: { 'x-relay-cli-gateway': 'v1' } }
    );
    const frames = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    expect(frames).toMatchObject([
      { frame: 'open' },
      {
        frame: 'closed',
        reason: 'backpressure',
        retryable: true,
      },
    ]);
  });
});
