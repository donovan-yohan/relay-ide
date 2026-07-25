import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import express from 'express';
import sharp from 'sharp';
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
import {
  authenticatedSourceSessionId,
  createChannelChatRouter,
} from '../server/channel-chat-router.js';
import {
  CHANNEL_IMAGE_MAX_BYTES,
  createChannelAttachmentStore,
  type ChannelAttachmentStore,
} from '../server/channel-attachments.js';
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
  attachmentStore: ChannelAttachmentStore;
  topicStore: WorkspaceTopicStore;
  hub: ChannelHub;
  channelId: string;
}

async function harness(
  options: {
    withStore?: boolean;
    withAttachmentStore?: boolean;
    historyMaxBytes?: number;
    withAuth?: boolean;
  } = {}
): Promise<Harness> {
  const dir = tmpDir();
  const topicStore = createWorkspaceTopicStore({
    dbPath: path.join(dir, 'topics.db'),
    now: () => '2026-07-18T00:00:00.000Z',
  });
  cleanup.push(() => topicStore.close());
  const store = createChannelMessageStore(path.join(dir, 'channel-chat.db'));
  cleanup.push(() => store.close());
  const attachmentStore = createChannelAttachmentStore({
    dbPath: path.join(dir, 'channel-attachments.db'),
    payloadRoot: path.join(dir, 'channel-attachments', 'payloads'),
  });
  cleanup.push(() => attachmentStore.close());
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
      attachmentStore:
        options.withAttachmentStore === false ? null : attachmentStore,
      hub,
      topicStore,
      ...(options.withAuth
        ? {
            requireAuth: (req, res, next) => {
              if (req.header('authorization') === 'Bearer test') return next();
              res.sendStatus(401);
            },
          }
        : {}),
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
  return {
    port: address.port,
    store,
    attachmentStore,
    topicStore,
    hub,
    channelId: topic.id,
  };
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

async function uploadImages(input: {
  port: number;
  channelId: string;
  images: Array<{ bytes: Buffer; name: string; mime: string }>;
  authorization?: string;
  capabilities?: string;
}): Promise<Response> {
  const form = new FormData();
  for (const image of input.images) {
    form.append(
      'images',
      new Blob([new Uint8Array(image.bytes)], { type: image.mime }),
      image.name
    );
  }
  return fetch(
    `http://127.0.0.1:${input.port}/channels/${encodeURIComponent(input.channelId)}/attachments`,
    {
      method: 'POST',
      headers: {
        ...(input.authorization ? { Authorization: input.authorization } : {}),
        'x-relay-capabilities': input.capabilities ?? 'context:write',
      },
      body: form,
    }
  );
}

describe('channel routes — image attachments', () => {
  it('authenticates upload/serve, canonicalizes message refs, and serves sanitized bytes', async () => {
    const h = await harness({ withAuth: true });
    const png = await sharp({
      create: {
        width: 7,
        height: 5,
        channels: 3,
        background: '#24a148',
      },
    })
      .png()
      .toBuffer();

    const unauthorizedUpload = await uploadImages({
      port: h.port,
      channelId: h.channelId,
      images: [{ bytes: png, name: 'status.png', mime: 'image/png' }],
    });
    expect(unauthorizedUpload.status).toBe(401);

    const upload = await uploadImages({
      port: h.port,
      channelId: h.channelId,
      images: [
        {
          bytes: png,
          name: 'status.png',
          mime: 'application/octet-stream',
        },
      ],
      authorization: 'Bearer test',
    });
    expect(upload.status).toBe(201);
    const uploadBody = (await upload.json()) as {
      attachments: Array<Record<string, unknown>>;
    };
    expect(uploadBody.attachments).toHaveLength(1);
    expect(uploadBody.attachments[0]).toMatchObject({
      type: 'image',
      mime: 'image/png',
      w: 7,
      h: 5,
      alt: 'status.png',
    });
    const attachmentId = String(uploadBody.attachments[0]?.['id']);

    const posted = await req<{
      message: {
        body: { text: string };
        parts: Array<Record<string, unknown>>;
      };
    }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${encodeURIComponent(h.channelId)}/messages`,
      headers: { Authorization: 'Bearer test' },
      body: {
        text: '',
        parts: [
          {
            type: 'image',
            id: attachmentId,
            mime: 'image/gif',
            w: 999,
            h: 999,
            bytes: 1,
            alt: '  deployment status  ',
          },
        ],
      },
    });
    expect(posted.status).toBe(201);
    expect(posted.body.message).toMatchObject({
      body: { text: '' },
      parts: [
        {
          id: attachmentId,
          mime: 'image/png',
          w: 7,
          h: 5,
          alt: 'deployment status',
        },
      ],
    });

    const serveUrl = `http://127.0.0.1:${h.port}/channels/${encodeURIComponent(h.channelId)}/attachments/${encodeURIComponent(attachmentId)}`;
    expect((await fetch(serveUrl)).status).toBe(401);
    expect(
      (
        await fetch(serveUrl, {
          headers: { Authorization: 'Bearer test' },
        })
      ).status
    ).toBe(403);
    const served = await fetch(serveUrl, {
      headers: {
        Authorization: 'Bearer test',
        'x-relay-capabilities': 'context:read',
      },
    });
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(served.headers.get('cache-control')).toBe(
      'private, max-age=31536000, immutable'
    );
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    const servedBytes = Buffer.from(await served.arrayBuffer());
    expect(servedBytes).toHaveLength(
      Number(uploadBody.attachments[0]?.['bytes'])
    );
    expect(await sharp(servedBytes).metadata()).toMatchObject({
      format: 'png',
      width: 7,
      height: 5,
    });

    const missing = await fetch(`${serveUrl}-missing`, {
      headers: {
        Authorization: 'Bearer test',
        'x-relay-capabilities': 'context:read',
      },
    });
    expect(missing.status).toBe(404);
    expect(missing.headers.get('cache-control')).toBe('no-store');
    expect(missing.headers.get('cache-control')).not.toContain('immutable');
  });

  it('does not cache a send failure after the attachment path exists', async () => {
    const h = await harness({ withAuth: true });
    const [attachment] = await h.attachmentStore.ingestMany([
      {
        bytes: await sharp({
          create: {
            width: 3,
            height: 2,
            channels: 3,
            background: '#0f62fe',
          },
        })
          .png()
          .toBuffer(),
        alt: 'unavailable.png',
      },
    ]);
    if (!attachment) throw new Error('attachment ingest failed');
    const record = h.attachmentStore.get(attachment.id);
    if (!record) throw new Error('attachment lookup failed');

    // A directory passes the route's existence check but sendFile cannot serve
    // it, deterministically exercising the callback error path.
    fs.rmSync(record.payloadPath);
    fs.mkdirSync(record.payloadPath);

    const response = await fetch(
      `http://127.0.0.1:${h.port}/channels/${encodeURIComponent(h.channelId)}/attachments/${encodeURIComponent(attachment.id)}`,
      {
        headers: {
          Authorization: 'Bearer test',
          'x-relay-capabilities': 'context:read',
        },
      }
    );
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('cache-control')).not.toContain('immutable');
  });

  it('rejects unsupported payloads, oversized files, and more than four images', async () => {
    const h = await harness();
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'
    );
    expect(
      (
        await uploadImages({
          port: h.port,
          channelId: h.channelId,
          images: [{ bytes: svg, name: 'unsafe.svg', mime: 'image/svg+xml' }],
        })
      ).status
    ).toBe(415);

    expect(
      (
        await uploadImages({
          port: h.port,
          channelId: h.channelId,
          images: [
            {
              bytes: Buffer.alloc(CHANNEL_IMAGE_MAX_BYTES + 1),
              name: 'large.png',
              mime: 'image/png',
            },
          ],
        })
      ).status
    ).toBe(413);

    const png = await sharp({
      create: {
        width: 1,
        height: 1,
        channels: 3,
        background: '#000000',
      },
    })
      .png()
      .toBuffer();
    expect(
      (
        await uploadImages({
          port: h.port,
          channelId: h.channelId,
          images: Array.from({ length: 5 }, (_, index) => ({
            bytes: png,
            name: `image-${index}.png`,
            mime: 'image/png',
          })),
        })
      ).status
    ).toBe(400);
  });
});

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

  it('attributes persistent-orchestrator posts only to a matching durable orchestrator session', () => {
    const roles: Readonly<Record<string, string>> = {
      'session:orchestrator': 'orchestrator',
      'session:worker': 'implementer',
    };
    const getSession = (sessionId: string) => {
      const role = roles[sessionId];
      return role ? { role, status: 'active' } : undefined;
    };
    const credential = (actorId: string) =>
      ({
        actor: { type: 'agent', id: actorId },
        metadata: { reason: 'persistent-orchestrator' },
      }) as unknown as ScopedActorCredentialRecord;

    expect(
      authenticatedSourceSessionId(
        credential('session:orchestrator'),
        getSession
      )
    ).toBe('session:orchestrator');
    expect(
      authenticatedSourceSessionId(credential('session:worker'), getSession)
    ).toBeUndefined();
    expect(
      authenticatedSourceSessionId(credential('session:stale'), getSession)
    ).toBeUndefined();
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

describe('channel routes — threads', () => {
  it('writes nested replies, pages root-inclusive history, and reports replyCount', async () => {
    const h = await harness();
    const messageUrl = `/channels/${encodeURIComponent(h.channelId)}/messages`;
    const root = await req<{ message: { id: string; seq: number } }>({
      port: h.port,
      method: 'POST',
      url: messageUrl,
      body: { text: 'root' },
    });
    let parentId = root.body.message.id;
    for (let i = 1; i <= 4; i++) {
      const reply = await req<{
        message: {
          id: string;
          seq: number;
          threadId: string;
          parentMessageId: string;
        };
      }>({
        port: h.port,
        method: 'POST',
        url: messageUrl,
        body: { text: `reply ${i}`, threadId: parentId },
      });
      expect(reply.status).toBe(201);
      expect(reply.body.message.threadId).toBe(root.body.message.id);
      expect(reply.body.message.parentMessageId).toBe(parentId);
      parentId = reply.body.message.id;
    }

    const timeline = await req<{
      messages: Array<{ id: string; replyCount?: number }>;
    }>({ port: h.port, method: 'GET', url: messageUrl });
    expect(
      timeline.body.messages.find(
        (message) => message.id === root.body.message.id
      )?.replyCount
    ).toBe(4);

    const threadUrl = `/channels/${encodeURIComponent(h.channelId)}/threads/${encodeURIComponent(root.body.message.id)}`;
    const page1 = await req<{
      messages: Array<{ seq: number }>;
      hasMore?: boolean;
      nextCursor?: { afterSeq?: number };
    }>({
      port: h.port,
      method: 'GET',
      url: `${threadUrl}?afterSeq=0&limit=2`,
    });
    expect(page1.status).toBe(200);
    expect(page1.body.messages.map((message) => message.seq)).toEqual([1, 2]);
    expect(page1.body.hasMore).toBe(true);
    expect(page1.body.nextCursor).toEqual({ afterSeq: 2 });

    const page2 = await req<{
      messages: Array<{ seq: number }>;
      hasMore?: boolean;
      nextCursor?: { afterSeq?: number };
    }>({
      port: h.port,
      method: 'GET',
      url: `${threadUrl}?afterSeq=${page1.body.nextCursor!.afterSeq}&limit=2`,
    });
    expect(page2.body.messages.map((message) => message.seq)).toEqual([3, 4]);
    expect(page2.body.hasMore).toBe(true);
    expect(page2.body.nextCursor).toEqual({ afterSeq: 4 });

    const terminal = await req<{
      messages: Array<{ seq: number }>;
      hasMore?: boolean;
      nextCursor?: { afterSeq?: number };
    }>({
      port: h.port,
      method: 'GET',
      url: `${threadUrl}?afterSeq=4&limit=2`,
    });
    expect(terminal.body.messages.map((message) => message.seq)).toEqual([5]);
    expect(terminal.body).not.toHaveProperty('hasMore');
    expect(terminal.body).not.toHaveProperty('nextCursor');
  });

  it('returns 404 for an unknown parent and 409 for a cross-channel parent', async () => {
    const h = await harness();
    const messageUrl = `/channels/${encodeURIComponent(h.channelId)}/messages`;
    const missing = await req({
      port: h.port,
      method: 'POST',
      url: messageUrl,
      body: { text: 'reply', threadId: 'chm:missing' },
    });
    expect(missing.status).toBe(404);

    const root = await req<{ message: { id: string } }>({
      port: h.port,
      method: 'POST',
      url: messageUrl,
      body: { text: 'root' },
    });
    const other = h.topicStore.create({ workspaceId: 'ws', title: 'Other' });
    const mismatch = await req({
      port: h.port,
      method: 'POST',
      url: `/channels/${encodeURIComponent(other.id)}/messages`,
      body: { text: 'cross channel', threadId: root.body.message.id },
    });
    expect(mismatch.status).toBe(409);

    const invalid = await req({
      port: h.port,
      method: 'POST',
      url: messageUrl,
      body: { text: 'invalid', threadId: '' },
    });
    expect(invalid.status).toBe(400);

    const numeric = await req({
      port: h.port,
      method: 'POST',
      url: messageUrl,
      body: { text: 'invalid numeric id', threadId: 42 },
    });
    expect(numeric.status).toBe(400);
  });

  it('returns the exact 404/409/400 thread-history root contract', async () => {
    const h = await harness();
    const messageUrl = `/channels/${encodeURIComponent(h.channelId)}/messages`;
    const missing = await req<{
      error: { code: string; details: { reasonCode: string } };
    }>({
      port: h.port,
      method: 'GET',
      url: `/channels/${encodeURIComponent(h.channelId)}/threads/chm%3Amissing`,
    });
    expect(missing).toMatchObject({
      status: 404,
      body: {
        error: {
          code: 'NOT_FOUND',
          details: { reasonCode: 'THREAD_ROOT_NOT_FOUND' },
        },
      },
    });

    const root = await req<{ message: { id: string } }>({
      port: h.port,
      method: 'POST',
      url: messageUrl,
      body: { text: 'root' },
    });
    const reply = await req<{ message: { id: string } }>({
      port: h.port,
      method: 'POST',
      url: messageUrl,
      body: { text: 'reply', threadId: root.body.message.id },
    });
    const other = h.topicStore.create({ workspaceId: 'ws', title: 'Other' });
    const mismatch = await req<{
      error: { code: string; details: { reasonCode: string } };
    }>({
      port: h.port,
      method: 'GET',
      url: `/channels/${encodeURIComponent(other.id)}/threads/${encodeURIComponent(root.body.message.id)}`,
    });
    expect(mismatch).toMatchObject({
      status: 409,
      body: {
        error: {
          code: 'SESSION_CONFLICT',
          details: { reasonCode: 'THREAD_ROOT_CHANNEL_MISMATCH' },
        },
      },
    });

    const nonRoot = await req<{
      error: { code: string; details: { reasonCode: string } };
    }>({
      port: h.port,
      method: 'GET',
      url: `/channels/${encodeURIComponent(h.channelId)}/threads/${encodeURIComponent(reply.body.message.id)}`,
    });
    expect(nonRoot).toMatchObject({
      status: 400,
      body: {
        error: {
          code: 'INVALID_ARGUMENT',
          details: { reasonCode: 'THREAD_ROOT_REQUIRED' },
        },
      },
    });
  });

  it('preserves parentMessageId writes and rejects conflicting dual fields', async () => {
    const h = await harness();
    const messageUrl = `/channels/${encodeURIComponent(h.channelId)}/messages`;
    const firstRoot = await req<{ message: { id: string } }>({
      port: h.port,
      method: 'POST',
      url: messageUrl,
      body: { text: 'first root' },
    });
    const secondRoot = await req<{ message: { id: string } }>({
      port: h.port,
      method: 'POST',
      url: messageUrl,
      body: { text: 'second root' },
    });

    const legacy = await req<{
      message: { threadId: string; parentMessageId: string };
    }>({
      port: h.port,
      method: 'POST',
      url: messageUrl,
      body: {
        text: 'legacy reply',
        parentMessageId: firstRoot.body.message.id,
      },
    });
    expect(legacy.status).toBe(201);
    expect(legacy.body.message.threadId).toBe(firstRoot.body.message.id);
    expect(legacy.body.message.parentMessageId).toBe(firstRoot.body.message.id);

    const legacyEmpty = await req<{
      message: { threadId: string | null; parentMessageId: string | null };
    }>({
      port: h.port,
      method: 'POST',
      url: messageUrl,
      body: { text: 'legacy empty is root', parentMessageId: '' },
    });
    expect(legacyEmpty.status).toBe(201);
    expect(legacyEmpty.body.message.threadId).toBeNull();
    expect(legacyEmpty.body.message.parentMessageId).toBeNull();

    const conflict = await req({
      port: h.port,
      method: 'POST',
      url: messageUrl,
      body: {
        text: 'ambiguous reply',
        threadId: firstRoot.body.message.id,
        parentMessageId: secondRoot.body.message.id,
      },
    });
    expect(conflict.status).toBe(400);
  });

  it('treats null thread aliases as absent and accepts equal dual ids', async () => {
    const h = await harness();
    const messageUrl = `/channels/${encodeURIComponent(h.channelId)}/messages`;
    const root = await req<{ message: { id: string } }>({
      port: h.port,
      method: 'POST',
      url: messageUrl,
      body: { text: 'root', threadId: null, parentMessageId: null },
    });
    expect(root.status).toBe(201);

    const threadNull = await req<{
      message: { threadId: string; parentMessageId: string };
    }>({
      port: h.port,
      method: 'POST',
      url: messageUrl,
      body: {
        text: 'legacy id wins',
        threadId: null,
        parentMessageId: root.body.message.id,
      },
    });
    expect(threadNull.status).toBe(201);
    expect(threadNull.body.message.parentMessageId).toBe(root.body.message.id);

    const parentNull = await req<{
      message: { threadId: string; parentMessageId: string };
    }>({
      port: h.port,
      method: 'POST',
      url: messageUrl,
      body: {
        text: 'public id wins',
        threadId: root.body.message.id,
        parentMessageId: null,
      },
    });
    expect(parentNull.status).toBe(201);
    expect(parentNull.body.message.parentMessageId).toBe(root.body.message.id);

    const equal = await req({
      port: h.port,
      method: 'POST',
      url: messageUrl,
      body: {
        text: 'equal ids',
        threadId: root.body.message.id,
        parentMessageId: root.body.message.id,
      },
    });
    expect(equal.status).toBe(201);
  });

  it('walks backward pages, gives afterSeq precedence, and omits terminal cursors', async () => {
    const h = await harness();
    const messageUrl = `/channels/${encodeURIComponent(h.channelId)}/messages`;
    const root = await req<{ message: { id: string } }>({
      port: h.port,
      method: 'POST',
      url: messageUrl,
      body: { text: 'root' },
    });
    for (let i = 1; i <= 5; i++) {
      await req({
        port: h.port,
        method: 'POST',
        url: messageUrl,
        body: { text: `reply ${i}`, threadId: root.body.message.id },
      });
    }
    const threadUrl = `/channels/${encodeURIComponent(h.channelId)}/threads/${encodeURIComponent(root.body.message.id)}`;
    const newest = await req<{
      messages: Array<{ seq: number }>;
      hasMore?: boolean;
      nextCursor?: { beforeSeq?: number };
    }>({ port: h.port, method: 'GET', url: `${threadUrl}?limit=2` });
    expect(newest.body.messages.map((m) => m.seq)).toEqual([5, 6]);
    expect(newest.body.nextCursor).toEqual({ beforeSeq: 5 });

    const middle = await req<{
      messages: Array<{ seq: number }>;
      nextCursor?: { beforeSeq?: number };
    }>({
      port: h.port,
      method: 'GET',
      url: `${threadUrl}?beforeSeq=${newest.body.nextCursor!.beforeSeq}&limit=2`,
    });
    expect(middle.body.messages.map((m) => m.seq)).toEqual([3, 4]);
    expect(middle.body.nextCursor).toEqual({ beforeSeq: 3 });

    const oldest = await req<{
      messages: Array<{ seq: number }>;
      hasMore?: boolean;
      nextCursor?: { beforeSeq?: number };
    }>({
      port: h.port,
      method: 'GET',
      url: `${threadUrl}?beforeSeq=3&limit=2`,
    });
    expect(oldest.body.messages.map((m) => m.seq)).toEqual([1, 2]);
    expect(oldest.body).not.toHaveProperty('hasMore');
    expect(oldest.body).not.toHaveProperty('nextCursor');

    const afterWins = await req<{ messages: Array<{ seq: number }> }>({
      port: h.port,
      method: 'GET',
      url: `${threadUrl}?beforeSeq=2&afterSeq=4&limit=10`,
    });
    expect(afterWins.body.messages.map((m) => m.seq)).toEqual([5, 6]);
  });

  it('clamps thread limits and preserves the legacy timeline thread filter', async () => {
    const h = await harness();
    const messageUrl = `/channels/${encodeURIComponent(h.channelId)}/messages`;
    const root = await req<{ message: { id: string } }>({
      port: h.port,
      method: 'POST',
      url: messageUrl,
      body: { text: 'root' },
    });
    for (let i = 1; i <= 204; i++) {
      h.store.appendComplete({
        channelId: h.channelId,
        sender: { kind: 'human', id: 'human:operator' },
        text: `reply ${i}`,
        parentMessageId: root.body.message.id,
      });
    }
    const threadUrl = `/channels/${encodeURIComponent(h.channelId)}/threads/${encodeURIComponent(root.body.message.id)}`;
    const zero = await req<{ messages: unknown[] }>({
      port: h.port,
      method: 'GET',
      url: `${threadUrl}?afterSeq=0&limit=0`,
    });
    expect(zero.body.messages).toHaveLength(1);
    const huge = await req<{ messages: unknown[] }>({
      port: h.port,
      method: 'GET',
      url: `${threadUrl}?afterSeq=0&limit=999`,
    });
    expect(huge.body.messages).toHaveLength(200);
    const junk = await req<{ messages: unknown[] }>({
      port: h.port,
      method: 'GET',
      url: `${threadUrl}?afterSeq=0&limit=junk`,
    });
    expect(junk.body.messages).toHaveLength(50);

    const legacy = await req<{
      messages: Array<{ threadId: string | null }>;
    }>({
      port: h.port,
      method: 'GET',
      url: `${messageUrl}?threadId=${encodeURIComponent(root.body.message.id)}&limit=200`,
    });
    expect(legacy.body.messages).toHaveLength(200);
    expect(
      legacy.body.messages.every((m) => m.threadId === root.body.message.id)
    ).toBe(true);
  });

  it('byte-budgets forward and backward thread pages with usable cursors', async () => {
    const h = await harness({ historyMaxBytes: 2600 });
    const messageUrl = `/channels/${encodeURIComponent(h.channelId)}/messages`;
    const root = await req<{ message: { id: string } }>({
      port: h.port,
      method: 'POST',
      url: messageUrl,
      body: { text: 'root' },
    });
    for (let i = 1; i <= 8; i++) {
      h.store.appendComplete({
        channelId: h.channelId,
        sender: { kind: 'human', id: 'human:operator' },
        text: `${i}:${'x'.repeat(900)}`,
        parentMessageId: root.body.message.id,
      });
    }
    const threadUrl = `/channels/${encodeURIComponent(h.channelId)}/threads/${encodeURIComponent(root.body.message.id)}`;
    type ThreadPage = {
      messages: Array<{ seq: number }>;
      hasMore?: boolean;
      nextCursor?: { afterSeq?: number; beforeSeq?: number };
    };
    const expected = Array.from({ length: 9 }, (_, index) => index + 1);

    const forwardSeqs: number[] = [];
    let afterSeq = 0;
    for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
      const page = await req<ThreadPage>({
        port: h.port,
        method: 'GET',
        url: `${threadUrl}?afterSeq=${afterSeq}&limit=200`,
      });
      const seqs = page.body.messages.map((message) => message.seq);
      expect(seqs.length).toBeGreaterThan(0);
      forwardSeqs.push(...seqs);
      if (!page.body.hasMore) {
        expect(page.body).not.toHaveProperty('hasMore');
        expect(page.body).not.toHaveProperty('nextCursor');
        break;
      }
      expect(page.body.nextCursor?.afterSeq).toBe(seqs.at(-1));
      afterSeq = page.body.nextCursor!.afterSeq!;
    }
    expect(forwardSeqs).toEqual(expected);
    expect(new Set(forwardSeqs).size).toBe(expected.length);

    const backwardSeqs: number[] = [];
    let beforeSeq: number | undefined;
    for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
      const page = await req<ThreadPage>({
        port: h.port,
        method: 'GET',
        url:
          beforeSeq === undefined
            ? `${threadUrl}?limit=200`
            : `${threadUrl}?beforeSeq=${beforeSeq}&limit=200`,
      });
      const seqs = page.body.messages.map((message) => message.seq);
      expect(seqs.length).toBeGreaterThan(0);
      backwardSeqs.unshift(...seqs);
      if (!page.body.hasMore) {
        expect(page.body).not.toHaveProperty('hasMore');
        expect(page.body).not.toHaveProperty('nextCursor');
        break;
      }
      expect(page.body.nextCursor?.beforeSeq).toBe(seqs[0]);
      beforeSeq = page.body.nextCursor!.beforeSeq!;
    }
    expect(backwardSeqs).toEqual(expected);
    expect(new Set(backwardSeqs).size).toBe(expected.length);
  });

  it('broadcasts a threaded reply on the normal channel created-event lane', async () => {
    const h = await harness();
    const messageUrl = `/channels/${encodeURIComponent(h.channelId)}/messages`;
    const root = await req<{ message: { id: string } }>({
      port: h.port,
      method: 'POST',
      url: messageUrl,
      body: { text: 'root' },
    });
    const sock = fakeSocket();
    h.hub.handleConnection(sock, { channelId: h.channelId, sinceSeq: null });
    await req({
      port: h.port,
      method: 'POST',
      url: messageUrl,
      body: { text: 'threaded', threadId: root.body.message.id },
    });
    const created = sock.sent.find(
      (event) =>
        event.type === 'channel-message-created-v1' &&
        event.message.body.text === 'threaded'
    );
    expect(created?.type).toBe('channel-message-created-v1');
    if (created?.type === 'channel-message-created-v1') {
      expect(created.message.threadId).toBe(root.body.message.id);
    }
  });
});

describe('channel routes — gateway capability mapping', () => {
  it('registers channels verbs in the actor command sets', () => {
    expect(CLI_GATEWAY_ACTOR_READ_COMMANDS).toContain('channels.list');
    expect(CLI_GATEWAY_ACTOR_READ_COMMANDS).toContain('channels.get');
    expect(CLI_GATEWAY_ACTOR_READ_COMMANDS).toContain('channels.history');
    expect(CLI_GATEWAY_ACTOR_READ_COMMANDS).toContain(
      'channels.threads.history'
    );
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
    expect(
      cliGatewayActorCommandCapabilities('channels.threads.history')
    ).toEqual(['context:read']);
    expect(cliGatewayActorCommandCapabilities('channels.post')).toEqual([
      'context:write',
    ]);
  });
});
