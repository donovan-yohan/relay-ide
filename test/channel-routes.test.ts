import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import {
  attachAuthenticatedCliGatewayActorCredential,
  cliGatewayActorCommandCapabilities,
  CLI_GATEWAY_ACTOR_READ_COMMANDS,
  CLI_GATEWAY_ACTOR_WRITE_COMMANDS,
} from '../server/cli-gateway-actor-auth.js';
import type { ScopedActorCredentialRecord } from '../shared/scoped-actor-credentials.js';
import {
  createChannelMessageStore,
  type ChannelMessageStore,
} from '../server/channel-message-store.js';
import {
  createChannelHub,
  type ChannelHub,
  type ChannelSocket,
} from '../server/channel-hub.js';
import { createChannelChatRouter } from '../server/channel-chat-router.js';
import {
  createWorkspaceTopicStore,
  type WorkspaceTopicStore,
} from '../server/workspace-topics.js';
import type { ChannelEventV1 } from '../shared/channel-chat-protocol.js';

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
});

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-channel-routes-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

interface Harness {
  port: number;
  store: ChannelMessageStore;
  topicStore: WorkspaceTopicStore;
  hub: ChannelHub;
  channelId: string;
}

async function harness(
  options: { withStore?: boolean; historyMaxBytes?: number } = {}
): Promise<Harness> {
  const dir = tmpDir();
  const topicStore = createWorkspaceTopicStore({
    dbPath: path.join(dir, 'topics.db'),
    now: () => '2026-07-18T00:00:00.000Z',
  });
  cleanup.push(() => topicStore.close());
  const store = createChannelMessageStore(path.join(dir, 'channel-chat.db'));
  cleanup.push(() => store.close());
  const hub = createChannelHub({
    store,
    channelExists: (id) => Boolean(topicStore.get(id)),
  });
  cleanup.push(() => hub.close());
  const topic = topicStore.create({ workspaceId: 'ws', title: 'General' });

  const app = express();
  app.use(express.json());
  // Simulate the CLI-gateway actor lane: attach a credential when the test asks.
  app.use((req, _res, next) => {
    const actorId = req.header('x-test-actor-id');
    if (actorId) {
      attachAuthenticatedCliGatewayActorCredential(req, {
        id: 'cred-1',
        actor: { type: 'agent', id: actorId, displayName: 'Claude Bot' },
        capabilities: ['context:read', 'context:write'],
      } as unknown as ScopedActorCredentialRecord);
    }
    next();
  });
  app.use(
    createChannelChatRouter({
      store: options.withStore === false ? null : store,
      hub,
      topicStore,
      ...(options.historyMaxBytes !== undefined
        ? { historyMaxBytes: options.historyMaxBytes }
        : {}),
    })
  );
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => server.close());
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  return { port: address.port, store, topicStore, hub, channelId: topic.id };
}

async function req<T>(input: {
  port: number;
  method: 'GET' | 'POST';
  url: string;
  body?: unknown;
  capabilities?: string;
  headers?: Record<string, string>;
}): Promise<{ status: number; body: T }> {
  const res = await fetch(`http://127.0.0.1:${input.port}${input.url}`, {
    method: input.method,
    headers: {
      'Content-Type': 'application/json',
      'x-relay-capabilities':
        input.capabilities ??
        (input.method === 'GET' ? 'context:read' : 'context:write'),
      ...(input.headers ?? {}),
    },
    ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as T };
}

function fakeSocket(): ChannelSocket & { sent: ChannelEventV1[] } {
  return {
    readyState: 1,
    bufferedAmount: 0,
    sent: [],
    send(data: string) {
      this.sent.push(JSON.parse(data) as ChannelEventV1);
    },
    close() {},
    on() {},
  };
}

describe('channel routes — attribution', () => {
  it('rejects a client-supplied sender field with 400', async () => {
    const h = await harness();
    const res = await req<{ error: { reasonCode?: string } }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${encodeURIComponent(h.channelId)}/messages`,
      body: { text: 'hi', sender: { kind: 'agent', id: 'agent:evil' } },
    });
    expect(res.status).toBe(400);
    expect(h.store.history(h.channelId)).toHaveLength(0); // nothing persisted
  });

  it('derives a human sender from the browser cookie lane', async () => {
    const h = await harness();
    const res = await req<{
      message: { sender: { kind: string; id: string } };
    }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${encodeURIComponent(h.channelId)}/messages`,
      body: { text: 'hello from operator' },
    });
    expect(res.status).toBe(201);
    expect(res.body.message.sender).toMatchObject({
      kind: 'human',
      id: 'human:operator',
    });
  });

  it('derives an agent sender from the CLI-gateway actor lane', async () => {
    const h = await harness();
    const res = await req<{
      message: { sender: { kind: string; id: string } };
    }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${encodeURIComponent(h.channelId)}/messages`,
      body: { text: 'hello from claude' },
      headers: { 'x-test-actor-id': 'claude' },
    });
    expect(res.status).toBe(201);
    expect(res.body.message.sender).toMatchObject({
      kind: 'agent',
      id: 'agent:claude',
    });
  });
});

describe('channel routes — topic validation', () => {
  it('rejects a post to an unknown / derived topic with 404', async () => {
    const h = await harness();
    const res = await req({
      port: h.port,
      method: 'POST',
      url: `/channels/${encodeURIComponent('topic:ghost')}/messages`,
      body: { text: 'hi' },
    });
    expect(res.status).toBe(404);
  });

  it('rejects a post to an archived topic with 409', async () => {
    const h = await harness();
    h.topicStore.archive(h.channelId);
    const res = await req({
      port: h.port,
      method: 'POST',
      url: `/channels/${encodeURIComponent(h.channelId)}/messages`,
      body: { text: 'hi' },
    });
    expect(res.status).toBe(409);
  });
});

describe('channel routes — read / write contract', () => {
  it('lists a persisted topic as a channel with summary fields', async () => {
    const h = await harness();
    await req({
      port: h.port,
      method: 'POST',
      url: `/channels/${encodeURIComponent(h.channelId)}/messages`,
      body: { text: 'first message' },
    });
    const res = await req<{ channels: Array<Record<string, unknown>> }>({
      port: h.port,
      method: 'GET',
      url: '/channels',
    });
    expect(res.status).toBe(200);
    const channel = res.body.channels.find((c) => c['id'] === h.channelId);
    expect(channel).toMatchObject({
      latestSeq: 1,
      messageCount: 1,
      archived: false,
    });
  });

  it('is idempotent under a repeated clientMessageId', async () => {
    const h = await harness();
    const url = `/channels/${encodeURIComponent(h.channelId)}/messages`;
    const first = await req<{ message: { id: string } }>({
      port: h.port,
      method: 'POST',
      url,
      body: { text: 'once', clientMessageId: 'c-1' },
    });
    expect(first.status).toBe(201);
    const second = await req<{ message: { id: string } }>({
      port: h.port,
      method: 'POST',
      url,
      body: { text: 'twice', clientMessageId: 'c-1' },
    });
    expect(second.status).toBe(200);
    expect(second.body.message.id).toBe(first.body.message.id);
    expect(h.store.history(h.channelId)).toHaveLength(1);
  });

  it('paginates history with limit and afterSeq', async () => {
    const h = await harness();
    const url = `/channels/${encodeURIComponent(h.channelId)}/messages`;
    for (let i = 0; i < 5; i++) {
      await req({ port: h.port, method: 'POST', url, body: { text: `m${i}` } });
    }
    const page = await req<{ messages: Array<{ seq: number }> }>({
      port: h.port,
      method: 'GET',
      url: `${url}?afterSeq=3&limit=10`,
    });
    expect(page.body.messages.map((m) => m.seq)).toEqual([4, 5]);
  });

  it('byte-budgets a history response and returns a continuation cursor', async () => {
    const h = await harness({ historyMaxBytes: 4000 });
    const url = `/channels/${encodeURIComponent(h.channelId)}/messages`;
    const body = 'y'.repeat(1000);
    for (let i = 0; i < 12; i++) {
      await req({ port: h.port, method: 'POST', url, body: { text: body } });
    }
    // Forward pagination (afterSeq): keeps oldest-first, continues via afterSeq.
    const page = await req<{
      messages: Array<{ seq: number }>;
      hasMore?: boolean;
      nextCursor?: { afterSeq?: number };
    }>({
      port: h.port,
      method: 'GET',
      url: `${url}?afterSeq=0&limit=200`,
    });
    expect(page.body.hasMore).toBe(true);
    expect(page.body.messages.length).toBeGreaterThan(0);
    expect(page.body.messages.length).toBeLessThan(12); // stopped before the full page
    const lastSeq = page.body.messages[page.body.messages.length - 1]!.seq;
    expect(page.body.nextCursor?.afterSeq).toBe(lastSeq);
    const bytes = Buffer.byteLength(JSON.stringify(page.body.messages), 'utf8');
    expect(bytes).toBeLessThanOrEqual(4000 + 1200);
  });

  it('echoes a posted message to a live channel subscriber (REST → WS round-trip)', async () => {
    const h = await harness();
    const sock = fakeSocket();
    h.hub.handleConnection(sock, { channelId: h.channelId, sinceSeq: null });
    await req({
      port: h.port,
      method: 'POST',
      url: `/channels/${encodeURIComponent(h.channelId)}/messages`,
      body: { text: 'broadcast me' },
    });
    const created = sock.sent.find(
      (e) => e.type === 'channel-message-created-v1'
    );
    expect(created).toBeDefined();
    if (created?.type === 'channel-message-created-v1') {
      expect(created.message.body.text).toBe('broadcast me');
    }
  });

  it('returns 503 when the channel store failed to initialize', async () => {
    const h = await harness({ withStore: false });
    const res = await req({ port: h.port, method: 'GET', url: '/channels' });
    expect(res.status).toBe(503);
  });
});

describe('channel routes — gateway capability mapping', () => {
  it('registers channels verbs in the actor command sets', () => {
    expect(CLI_GATEWAY_ACTOR_READ_COMMANDS).toContain('channels.list');
    expect(CLI_GATEWAY_ACTOR_READ_COMMANDS).toContain('channels.get');
    expect(CLI_GATEWAY_ACTOR_READ_COMMANDS).toContain('channels.history');
    expect(CLI_GATEWAY_ACTOR_WRITE_COMMANDS).toContain('channels.post');
  });

  it('maps channels verbs to context read/write capability bits', () => {
    expect(cliGatewayActorCommandCapabilities('channels.list')).toEqual([
      'context:read',
    ]);
    expect(cliGatewayActorCommandCapabilities('channels.get')).toEqual([
      'context:read',
    ]);
    expect(cliGatewayActorCommandCapabilities('channels.history')).toEqual([
      'context:read',
    ]);
    expect(cliGatewayActorCommandCapabilities('channels.post')).toEqual([
      'context:write',
    ]);
  });
});
