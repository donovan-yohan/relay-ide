import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import express, { type RequestHandler } from 'express';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';

import {
  attachAuthenticatedCliGatewayActorCredential,
  cliGatewayActorCommandCapabilities,
  CLI_GATEWAY_ACTOR_READ_COMMANDS,
  CLI_GATEWAY_ACTOR_WRITE_COMMANDS,
} from '../server/cli-gateway-actor-auth.js';
import type {
  ScopedActorCredentialRecord,
  ScopedActorCredentialScope,
} from '../shared/scoped-actor-credentials.js';
import { builtInAgentProfileId } from '../shared/agent-profile.js';
import { createAgentProfileStore } from '../server/agent-profile-store.js';
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
  authenticatedSourceRuntimeId,
  channelSearchRequestedChannelId,
  createChannelChatRouter,
  DEFAULT_KNOWN_PROVIDER_IDS,
} from '../server/channel-chat-router.js';
import {
  ChannelAgentBusyError,
  ChannelAgentReleaseRefusedError,
  ChannelAgentRoleConflictError,
  ChannelMessageNotRetryableError,
  createChannelAgentBinder,
  type ChannelAgentBinder,
} from '../server/channel-agent-binder.js';
import { MockProtocolAdapterV2 } from '../server/protocol-adapters/mock-v2-adapter.js';
import type { ChannelAgentRuntime } from '../server/channel-agent-runtime.js';
import {
  CHANNEL_IMAGE_MAX_BYTES,
  createChannelAttachmentStore,
  type ChannelAttachmentStore,
} from '../server/channel-attachments.js';
import {
  createWorkspaceTopicStore,
  type WorkspaceTopicStore,
} from '../server/workspace-topics.js';
import type { IaStore } from '../server/ia-store.js';
import { OPERATOR_CLIENT_CHANNEL_COMMANDS } from '../server/operator-client-auth.js';
import {
  CHANNEL_MEMBERSHIP_SELF_INVITER,
  CHANNEL_SEARCH_HIGHLIGHT_CLOSE,
  CHANNEL_SEARCH_HIGHLIGHT_OPEN,
  CHANNEL_SEARCH_MAX_RESULTS,
  CHANNEL_SEARCH_PREFIX_TERM_BUDGET,
  parseChannelSearchSnippet,
  type ChannelDeliveryReceiptV1,
  type ChannelEventV1,
} from '../shared/channel-chat-protocol.js';
import { dmChannelCreateInput } from '../shared/dm-channels.js';
import { commandSpec } from '../shared/cli-gateway-contract.js';

const cleanup: Array<() => void> = [];

function expectRuntimeCursorMatchesSchema(
  command: 'channels.history' | 'channels.threads.history',
  cursor: Record<string, unknown>
): void {
  const schema =
    commandSpec(command).outputSchema.properties?.['data']?.properties?.[
      'nextCursor'
    ];
  const matchingBranches =
    schema?.oneOf?.filter((branch) => {
      const required = branch.required ?? [];
      const properties = branch.properties ?? {};
      return (
        required.every((key) => Object.hasOwn(cursor, key)) &&
        Object.keys(cursor).every((key) => Object.hasOwn(properties, key))
      );
    }) ?? [];
  expect(matchingBranches).toHaveLength(1);
}

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
  /** Every `/ws/events` broadcast the router emitted, in order. */
  broadcasts: Array<{ type: string; data?: Record<string, unknown> }>;
}

/**
 * #1455 slice 1: the actor lane is membership-gated. Cases that assert
 * attribution, validation order, or scope behaviour — not admission — enroll
 * their actor exactly as the hub otherwise would (an earlier post, a
 * mention-invite, or the upgrade backfill), so they keep testing what they were
 * written to test. Admission has its own cases.
 */
function enrollActor(h: Harness, actorId: string, channelId?: string): void {
  h.store.upsertMember({
    channelId: channelId ?? h.channelId,
    kind: 'agent',
    id: `agent:${actorId}`,
    invitedBy: 'human:operator',
  });
}

async function harness(
  options: {
    withStore?: boolean;
    withAttachmentStore?: boolean;
    historyMaxBytes?: number;
    withAuth?: boolean;
    binder?: Partial<ChannelAgentBinder>;
    /**
     * Monotonic topic clock. The default is frozen, which is fine until a test
     * cares about `updated_at DESC` rank — the rail read model's ordering — and
     * needs "older than the 200 most recent" to be a fact rather than a
     * tiebreak SQLite is free to resolve either way.
     */
    topicClock?: () => string;
    /**
     * Wall-clock ceiling for one search read (#1316). `0` makes the ceiling
     * fire on the first matched row, so the route's `search_timeout` mapping is
     * provable without a pathological corpus or a latency assertion.
     */
    searchTimeBudgetMs?: number;
    iaStore?: Pick<IaStore, 'listWorkspaces'> | null;
    binderFactory?: (deps: {
      store: ChannelMessageStore;
      hub: ChannelHub;
      topicStore: WorkspaceTopicStore;
    }) => ChannelAgentBinder;
    requireWriteActorAuth?: (command: string) => RequestHandler;
    requireReadActorAuth?: (command: string) => RequestHandler;
  } = {}
): Promise<Harness> {
  const dir = tmpDir();
  const topicStore = createWorkspaceTopicStore({
    dbPath: path.join(dir, 'topics.db'),
    now: options.topicClock ?? (() => '2026-07-18T00:00:00.000Z'),
  });
  cleanup.push(() => topicStore.close());
  const store = createChannelMessageStore(
    path.join(dir, 'channel-chat.db'),
    options.searchTimeBudgetMs === undefined
      ? {}
      : { searchTimeBudgetMs: options.searchTimeBudgetMs }
  );
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
  const binder =
    options.binderFactory?.({ store, hub, topicStore }) ?? options.binder;
  if (options.binderFactory) {
    cleanup.push(() => binder?.close?.());
    const unlisten = hub.onMessagePosted((message, mentions, postOptions) =>
      binder?.handleMessagePosted?.(message, mentions, postOptions)
    );
    cleanup.push(unlisten);
  }

  const app = express();
  app.use(express.json());
  // Simulate the CLI-gateway actor lane: attach a credential when the test asks.
  // `x-test-actor-scope` optionally supplies a JSON scope (e.g. `channelIds`) so
  // channel-scope enforcement can be exercised at the route level.
  app.use((req, _res, next) => {
    const actorId = req.header('x-test-actor-id');
    if (actorId) {
      const scopeHeader = req.header('x-test-actor-scope');
      const scope = scopeHeader
        ? (JSON.parse(scopeHeader) as ScopedActorCredentialScope)
        : undefined;
      // `x-test-actor-reason` models the trusted-internal metadata marker the
      // hub stamps in-process (#1467 `hub-local-cli`); no caller can set it on
      // a real credential.
      const reason = req.header('x-test-actor-reason');
      attachAuthenticatedCliGatewayActorCredential(req, {
        id: 'cred-1',
        actor: { type: 'agent', id: actorId, displayName: 'Claude Bot' },
        capabilities: ['context:read', 'context:write'],
        ...(scope ? { scope } : {}),
        ...(reason ? { metadata: { reason } } : {}),
      } as unknown as ScopedActorCredentialRecord);
    }
    next();
  });
  const broadcasts: Array<{ type: string; data?: Record<string, unknown> }> =
    [];
  app.use(
    createChannelChatRouter({
      store: options.withStore === false ? null : store,
      attachmentStore:
        options.withAttachmentStore === false ? null : attachmentStore,
      hub,
      topicStore,
      ...(options.iaStore ? { iaStore: options.iaStore } : {}),
      broadcastEvent: (type, data) => {
        broadcasts.push({ type, ...(data ? { data } : {}) });
      },
      ...(binder ? { binder: binder as unknown as ChannelAgentBinder } : {}),
      ...(options.withAuth
        ? {
            requireAuth: (req, res, next) => {
              if (req.header('authorization') === 'Bearer test') return next();
              res.sendStatus(401);
            },
          }
        : {}),
      ...(options.requireWriteActorAuth
        ? { requireWriteActorAuth: options.requireWriteActorAuth as never }
        : {}),
      ...(options.requireReadActorAuth
        ? { requireReadActorAuth: options.requireReadActorAuth as never }
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
    broadcasts,
  };
}

async function req<T>(input: {
  port: number;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
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

async function waitForCondition(
  condition: () => boolean,
  timeoutMs = 4000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition timed out');
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

    const actorHeaders = {
      Authorization: 'Bearer test',
      'x-test-actor-id': 'agent-profile:codex:scoped',
      'x-test-actor-scope': JSON.stringify({ channelIds: [h.channelId] }),
    };
    const actorUpload = await uploadImages({
      port: h.port,
      channelId: h.channelId,
      images: [{ bytes: png, name: 'actor.png', mime: 'image/png' }],
      capabilities: 'context:write',
    });
    // Re-send with the actor lane marker; FormData helper intentionally only
    // models production auth headers, so use fetch directly for this denial.
    const actorForm = new FormData();
    actorForm.append(
      'images',
      new Blob([new Uint8Array(png)], { type: 'image/png' }),
      'actor.png'
    );
    const deniedActorUpload = await fetch(
      `http://127.0.0.1:${h.port}/channels/${encodeURIComponent(h.channelId)}/attachments`,
      {
        method: 'POST',
        headers: {
          ...actorHeaders,
          'x-relay-capabilities': 'context:write',
        },
        body: actorForm,
      }
    );
    expect(actorUpload.status).toBe(401);
    expect(deniedActorUpload.status).toBe(403);

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

    const rowsBeforeActorReuse = h.store.history(h.channelId, { limit: 10 });
    const deniedActorReuse = await req<{ error: unknown }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${encodeURIComponent(h.channelId)}/messages`,
      headers: actorHeaders,
      body: { text: 'reuse', parts: uploadBody.attachments },
    });
    expect(deniedActorReuse.status).toBe(403);
    expect(h.store.history(h.channelId, { limit: 10 })).toEqual(
      rowsBeforeActorReuse
    );

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
    expect(
      (
        await fetch(serveUrl, {
          headers: {
            ...actorHeaders,
            'x-relay-capabilities': 'context:read',
          },
        })
      ).status
    ).toBe(403);

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
    enrollActor(h, 'claude');
    const res = await req<{
      message: { sender: { kind: string; id: string } };
    }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${encodeURIComponent(h.channelId)}/messages`,
      body: { text: 'hello from claude' },
      headers: {
        'x-test-actor-id': 'claude',
        'x-test-actor-scope': JSON.stringify({ channelIds: [h.channelId] }),
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.message.sender).toMatchObject({
      kind: 'agent',
      id: 'agent:claude',
    });
  });

  it('attributes persistent-orchestrator posts only to its scoped private runtime and stable profile actor', () => {
    const runtimes: Readonly<
      Record<
        string,
        {
          profileActorId: string;
          providerId: string;
          role: string;
          status: string;
        }
      >
    > = {
      'runtime:orchestrator': {
        profileActorId: 'agent-profile:claude:orchestrator',
        providerId: 'claude',
        role: 'orchestrator',
        status: 'active',
      },
      'runtime:worker': {
        profileActorId: 'agent-profile:claude:worker',
        providerId: 'claude',
        role: 'implementer',
        status: 'active',
      },
    };
    const getRuntime = (runtimeId: string) => runtimes[runtimeId];
    const credential = (actorId: string, runtimeId: string) =>
      ({
        actor: { type: 'agent', id: actorId },
        scope: { sessionIds: [runtimeId] },
        metadata: { reason: 'persistent-orchestrator' },
      }) as unknown as ScopedActorCredentialRecord;

    expect(
      authenticatedSourceRuntimeId(
        credential('agent-profile:claude:orchestrator', 'runtime:orchestrator'),
        getRuntime
      )
    ).toBe('runtime:orchestrator');
    expect(
      authenticatedSourceRuntimeId(
        credential('agent-profile:claude:worker', 'runtime:worker'),
        getRuntime
      )
    ).toBeUndefined();
    expect(
      authenticatedSourceRuntimeId(
        credential('agent-profile:claude:stale', 'runtime:stale'),
        getRuntime
      )
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

  it('returns NOT_FOUND for thread history on an unknown / derived topic', async () => {
    const h = await harness();
    const res = await req<{
      error: { code: string };
    }>({
      port: h.port,
      method: 'GET',
      url: `/channels/${encodeURIComponent('topic:ghost')}/threads/chm%3Amissing`,
    });
    expect(res).toMatchObject({
      status: 404,
      body: { error: { code: 'NOT_FOUND' } },
    });
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

describe('channel routes — delivery receipts (#1442)', () => {
  function receipt(
    overrides: Partial<ChannelDeliveryReceiptV1> = {}
  ): ChannelDeliveryReceiptV1 {
    return {
      messageId: 'chm:1',
      channelId: '',
      targetBindingId: '\u0000\u0000agent-profile:mock:default',
      senderProfileId: null,
      targetProfileId: 'agent-profile:mock:default',
      state: 'queued',
      ts: '2026-08-25T00:00:00.000Z',
      ...overrides,
    };
  }

  it('returns receipts for the channel, filtered by messageId and target', async () => {
    const h = await harness();
    const ch = h.channelId;
    h.hub.broadcastDeliveryReceipt(
      receipt({ channelId: ch, messageId: 'chm:a', state: 'queued' })
    );
    h.hub.broadcastDeliveryReceipt(
      receipt({
        channelId: ch,
        messageId: 'chm:b',
        state: 'completed',
        targetProfileId: 'agent-profile:claude:default',
        targetBindingId: `\u0000\u0000agent-profile:claude:default`,
      })
    );

    const all = await req<{ receipts: ChannelDeliveryReceiptV1[] }>({
      port: h.port,
      method: 'GET',
      url: `/channels/${encodeURIComponent(ch)}/receipts`,
    });
    expect(all.status).toBe(200);
    // Newest-first.
    expect(all.body.receipts.map((r) => r.messageId)).toEqual([
      'chm:b',
      'chm:a',
    ]);

    const perMessage = await req<{ receipts: ChannelDeliveryReceiptV1[] }>({
      port: h.port,
      method: 'GET',
      url: `/channels/${encodeURIComponent(ch)}/receipts?messageId=chm:a`,
    });
    expect(perMessage.body.receipts).toHaveLength(1);
    expect(perMessage.body.receipts[0]).toMatchObject({
      messageId: 'chm:a',
      state: 'queued',
      channelId: ch,
    });

    const perTarget = await req<{ receipts: ChannelDeliveryReceiptV1[] }>({
      port: h.port,
      method: 'GET',
      url: `/channels/${encodeURIComponent(
        ch
      )}/receipts?targetProfileId=agent-profile%3Aclaude%3Adefault`,
    });
    expect(perTarget.body.receipts).toHaveLength(1);
    expect(perTarget.body.receipts[0]!.messageId).toBe('chm:b');
  });

  it('never returns another channel\u2019s receipts and honors the limit', async () => {
    const h = await harness();
    const ch = h.channelId;
    for (let i = 0; i < 5; i++) {
      h.hub.broadcastDeliveryReceipt(
        receipt({ channelId: ch, messageId: `chm:${i}` })
      );
    }
    const limited = await req<{ receipts: ChannelDeliveryReceiptV1[] }>({
      port: h.port,
      method: 'GET',
      url: `/channels/${encodeURIComponent(ch)}/receipts?limit=2`,
    });
    expect(limited.body.receipts).toHaveLength(2);
    expect(limited.body.receipts[0]!.messageId).toBe('chm:4');

    // A different persisted topic never sees this ring.
    const other = h.topicStore.create({ workspaceId: 'ws', title: 'Other' });
    const foreign = await req<{ receipts: ChannelDeliveryReceiptV1[] }>({
      port: h.port,
      method: 'GET',
      url: `/channels/${encodeURIComponent(other.id)}/receipts`,
    });
    expect(foreign.body.receipts).toEqual([]);
  });

  it('refuses unknown topics with NOT_FOUND', async () => {
    const h = await harness();
    const res = await req<{ error: { code: string } }>({
      port: h.port,
      method: 'GET',
      url: `/channels/${encodeURIComponent('topic:ghost')}/receipts`,
    });
    expect(res).toMatchObject({
      status: 404,
      body: { error: { code: 'NOT_FOUND' } },
    });
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

  // #1308 slice 4 review: the composer keeps its `clientMessageId` after a
  // failed send, so "queue → looked like it failed → interrupt & send" replays a
  // known id. The row must not be duplicated, but the interrupt must still land
  // — otherwise the UI reports an interrupt-and-send that did neither.
  it('applies steering on an idempotent replay without re-posting the row', async () => {
    const steered: Array<{ id: string; steering: string }> = [];
    const h = await harness({
      binder: {
        steerExisting: (message, steering) => {
          steered.push({ id: message.id, steering });
        },
      },
    });
    const url = `/channels/${encodeURIComponent(h.channelId)}/messages`;
    const first = await req<{ message: { id: string } }>({
      port: h.port,
      method: 'POST',
      url,
      body: { text: 'wait, stop', clientMessageId: 'c-steer' },
    });
    expect(first.status).toBe(201);
    expect(steered).toHaveLength(0); // plain queue post never steers

    const replay = await req<{ message: { id: string } }>({
      port: h.port,
      method: 'POST',
      url,
      body: {
        text: 'wait, stop',
        clientMessageId: 'c-steer',
        steering: 'interrupt',
      },
    });
    expect(replay.status).toBe(200);
    expect(replay.body.message.id).toBe(first.body.message.id);
    expect(h.store.history(h.channelId)).toHaveLength(1);
    expect(steered).toEqual([
      { id: first.body.message.id, steering: 'interrupt' },
    ]);
  });

  it('rejects scoped-actor steering before fresh or replay binder side effects', async () => {
    const steered: string[] = [];
    const h = await harness({
      binder: { steerExisting: (_message, steering) => steered.push(steering) },
    });
    enrollActor(h, 'scoped-agent');
    const url = `/channels/${encodeURIComponent(h.channelId)}/messages`;
    const headers = {
      'x-test-actor-id': 'scoped-agent',
      'x-test-actor-scope': JSON.stringify({ channelIds: [h.channelId] }),
    };
    const deniedFresh = await req<{ error: { code: string } }>({
      port: h.port,
      method: 'POST',
      url,
      headers,
      body: {
        text: 'no control',
        clientMessageId: 'fresh',
        steering: 'interrupt',
      },
    });
    expect(deniedFresh.status).toBe(403);
    expect(deniedFresh.body.error.code).toBe('FORBIDDEN');
    expect(h.store.history(h.channelId)).toHaveLength(0);
    expect(
      (
        await req({
          port: h.port,
          method: 'POST',
          url,
          headers,
          body: { text: 'queued', clientMessageId: 'replay' },
        })
      ).status
    ).toBe(201);
    expect(
      (
        await req({
          port: h.port,
          method: 'POST',
          url,
          headers,
          body: {
            text: 'queued',
            clientMessageId: 'replay',
            steering: 'interrupt',
          },
        })
      ).status
    ).toBe(403);
    expect(steered).toEqual([]);
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

  it('uses limit plus one lookahead for ordinary history without cursor gaps', async () => {
    const h = await harness();
    const url = `/channels/${encodeURIComponent(h.channelId)}/messages`;
    for (let i = 0; i < 5; i++) {
      await req({ port: h.port, method: 'POST', url, body: { text: `m${i}` } });
    }
    const page1 = await req<{
      messages: Array<{ seq: number }>;
      hasMore?: boolean;
      nextCursor?: { afterSeq?: number };
    }>({ port: h.port, method: 'GET', url: `${url}?afterSeq=0&limit=2` });
    expect(page1.body.messages.map((message) => message.seq)).toEqual([1, 2]);
    expect(page1.body).toMatchObject({
      hasMore: true,
      nextCursor: { afterSeq: 2 },
    });

    const page2 = await req<{
      messages: Array<{ seq: number }>;
      hasMore?: boolean;
      nextCursor?: { afterSeq?: number };
    }>({
      port: h.port,
      method: 'GET',
      url: `${url}?afterSeq=${page1.body.nextCursor!.afterSeq}&limit=2`,
    });
    expect(page2.body.messages.map((message) => message.seq)).toEqual([3, 4]);
    expect(page2.body.nextCursor).toEqual({ afterSeq: 4 });

    const terminal = await req<{ messages: Array<{ seq: number }> }>({
      port: h.port,
      method: 'GET',
      url: `${url}?afterSeq=${page2.body.nextCursor!.afterSeq}&limit=2`,
    });
    expect(terminal.body.messages.map((message) => message.seq)).toEqual([5]);
    expect(terminal.body).not.toHaveProperty('hasMore');
    expect(terminal.body).not.toHaveProperty('nextCursor');
  });

  it('validates an actor channels.post body before channel lookup or persistence', async () => {
    const h = await harness();
    enrollActor(h, 'scoped-agent');
    // Membership is recorded for the ABSENT channel too: this case proves body
    // validation runs before channel lookup, so admission must not be what
    // answers first.
    enrollActor(h, 'scoped-agent', 'topic:missing');
    const headers = {
      'x-test-actor-id': 'scoped-agent',
      'x-test-actor-scope': JSON.stringify({
        channelIds: [h.channelId, 'topic:missing'],
      }),
    };
    for (const body of [
      { text: 'ok', clientMessageId: 7 },
      { text: 'ok', unexpected: true },
      { text: '' },
      { text: 'ok', format: null },
      { text: 'ok', parentMessageId: null },
      { text: 'ok', threadId: 7 },
      [],
    ]) {
      const response = await req<{ error: { code: string } }>({
        port: h.port,
        method: 'POST',
        url: '/channels/topic%3Amissing/messages',
        headers,
        body,
      });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_ARGUMENT');
    }
    expect(h.store.history(h.channelId)).toHaveLength(0);

    const valid = await req<{ message: { sender: { id: string } } }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${encodeURIComponent(h.channelId)}/messages`,
      headers,
      body: { text: 'valid actor post', threadId: null, clientMessageId: 'c1' },
    });
    expect(valid.status).toBe(201);
    expect(valid.body.message.sender.id).toBe('agent:scoped-agent');
    expect(h.store.history(h.channelId)).toHaveLength(1);
  });

  it('fails closed for undeclared actor history queries and missing channels', async () => {
    const h = await harness();
    enrollActor(h, 'scoped-agent');
    // Member of the absent channel too, so the 404 below is the CHANNEL
    // answering rather than the membership gate.
    enrollActor(h, 'scoped-agent', 'missing');
    const headers = {
      'x-test-actor-id': 'scoped-agent',
      'x-test-actor-scope': JSON.stringify({
        channelIds: [h.channelId, 'missing'],
      }),
      'x-relay-capabilities': 'context:read',
    };
    for (const query of [
      'threadId=root',
      'undeclared=value',
      'limit=-1',
      'limit=201',
      'limit=1.5',
      'afterSeq=junk',
      'afterSeq=1&afterSeq=2',
      'beforeSeq=2&afterSeq=4',
    ]) {
      const response = await req<{ error: { code: string } }>({
        port: h.port,
        method: 'GET',
        url: `/channels/${encodeURIComponent(h.channelId)}/messages?${query}`,
        headers,
      });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_ARGUMENT');
    }
    const missing = await req<{ error: { code: string } }>({
      port: h.port,
      method: 'GET',
      url: '/channels/missing/messages',
      headers,
    });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
  });

  it('rejects conflicting actor thread cursors while preserving browser precedence', async () => {
    const h = await harness();
    enrollActor(h, 'scoped-agent');
    const messageUrl = `/channels/${encodeURIComponent(h.channelId)}/messages`;
    const root = await req<{ message: { id: string } }>({
      port: h.port,
      method: 'POST',
      url: messageUrl,
      body: { text: 'root' },
    });
    const threadUrl = `/channels/${encodeURIComponent(h.channelId)}/threads/${encodeURIComponent(root.body.message.id)}`;
    const headers = {
      'x-test-actor-id': 'scoped-agent',
      'x-test-actor-scope': JSON.stringify({ channelIds: [h.channelId] }),
      'x-relay-capabilities': 'context:read',
    };
    const actor = await req<{
      error: { code: string; details?: Record<string, unknown> };
    }>({
      port: h.port,
      method: 'GET',
      url: `${threadUrl}?beforeSeq=2&afterSeq=4`,
      headers,
    });
    expect(actor.status).toBe(400);
    expect(actor.body.error).toMatchObject({
      code: 'INVALID_ARGUMENT',
      details: { reasonCode: 'CHANNEL_PAGINATION_DIRECTION_CONFLICT' },
    });

    const browser = await req<{ messages: unknown[] }>({
      port: h.port,
      method: 'GET',
      url: `${threadUrl}?beforeSeq=2&afterSeq=4`,
    });
    expect(browser.status).toBe(200);
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
    expectRuntimeCursorMatchesSchema(
      'channels.history',
      page.body.nextCursor as Record<string, unknown>
    );
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
    expectRuntimeCursorMatchesSchema(
      'channels.threads.history',
      page1.body.nextCursor as Record<string, unknown>
    );

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

  // #1287 slice 5 item 18: the rail surfaces threads. That data rides the
  // channel-list response the rail already fetches — a response-shape extension
  // like slice 3's summaries, never a new route or a per-thread fetch.
  it('carries thread summaries on the channel list and single-channel reads', async () => {
    const h = await harness();
    const messageUrl = `/channels/${encodeURIComponent(h.channelId)}/messages`;
    const post = async (body: Record<string, unknown>) =>
      (
        await req<{ message: { id: string } }>({
          port: h.port,
          method: 'POST',
          url: messageUrl,
          body,
        })
      ).body.message.id;

    const rootId = await post({ text: 'how should the binder key runtimes?' });
    const quiet = await post({ text: 'top-level with no replies' });
    await post({ text: 'reply one', threadId: rootId });
    await post({ text: 'reply two', threadId: rootId });

    const list = await req<{ channels: Array<Record<string, unknown>> }>({
      port: h.port,
      method: 'GET',
      url: '/channels',
    });
    const listed = list.body.channels.find((c) => c['id'] === h.channelId);
    expect(listed).toMatchObject({ threadCount: 1 });
    expect(listed?.['threads']).toMatchObject([
      {
        rootMessageId: rootId,
        replyCount: 2,
        preview: 'how should the binder key runtimes?',
      },
    ]);
    // A top-level message nobody replied to is not a thread.
    expect(
      (listed?.['threads'] as Array<{ rootMessageId: string }>).some(
        (thread) => thread.rootMessageId === quiet
      )
    ).toBe(false);

    const single = await req<{ channel: Record<string, unknown> }>({
      port: h.port,
      method: 'GET',
      url: `/channels/${encodeURIComponent(h.channelId)}`,
    });
    expect(single.body.channel).toMatchObject({ threadCount: 1 });
  });

  it('reports no threads for a channel that only holds top-level messages', async () => {
    const h = await harness();
    await req({
      port: h.port,
      method: 'POST',
      url: `/channels/${encodeURIComponent(h.channelId)}/messages`,
      body: { text: 'flat conversation' },
    });
    const list = await req<{ channels: Array<Record<string, unknown>> }>({
      port: h.port,
      method: 'GET',
      url: '/channels',
    });
    expect(
      list.body.channels.find((c) => c['id'] === h.channelId)
    ).toMatchObject({ threads: [], threadCount: 0 });
  });

  it('reports no threads for a channel that holds no messages at all', async () => {
    // The aggregate is skipped outright here — a channel with zero messages
    // cannot hold a thread, and `GET /channels` pays this per channel on a list
    // the rail refetches on every agent-turn window.
    const h = await harness();
    const list = await req<{ channels: Array<Record<string, unknown>> }>({
      port: h.port,
      method: 'GET',
      url: '/channels',
    });
    expect(
      list.body.channels.find((c) => c['id'] === h.channelId)
    ).toMatchObject({ messageCount: 0, threads: [], threadCount: 0 });
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
    expect(CLI_GATEWAY_ACTOR_WRITE_COMMANDS).not.toContain(
      'channels.agent-commands' as never
    );
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

  // #1410: search opened to in-scope actors under its OWN verb. The actor lane
  // authorizes by the `x-relay-cli-command` header, so if the route asked for
  // `channels.history` here, any history-capable credential could search while
  // naming the wrong operation in the audit trail.
  it('registers channels.search as its own read verb rather than riding channels.history', () => {
    expect(CLI_GATEWAY_ACTOR_READ_COMMANDS).toContain('channels.search');
    expect(CLI_GATEWAY_ACTOR_WRITE_COMMANDS).not.toContain(
      'channels.search' as never
    );
    expect(cliGatewayActorCommandCapabilities('channels.search')).toEqual([
      'context:read',
    ]);
  });

  it('authorizes GET /channels/search through the channels.search middleware', async () => {
    const commands: string[] = [];
    const h = await harness({
      requireReadActorAuth: (command) => (_req, _res, next) => {
        commands.push(command);
        next();
      },
    });
    const res = await req<{ results: unknown[] }>({
      port: h.port,
      method: 'GET',
      url: '/channels/search?q=anything',
    });
    expect(res.status).toBe(200);
    expect(commands).toEqual(['channels.search']);
  });

  // One parser, two layers. `server/index.ts` builds the requested actor scope
  // from this helper and the route enforces `denyOutOfScopeChannel` on the same
  // value, so the middleware can never authorize a different channel than the
  // route enforces. Express turns `?channelId=A&channelId=B` into an array — a
  // bare `typeof === 'string'` check reads that as "no channel named".
  it('parses the searched channelId identically for the middleware and the route', () => {
    expect(channelSearchRequestedChannelId({ channelId: 'topic:a' })).toBe(
      'topic:a'
    );
    expect(
      channelSearchRequestedChannelId({ channelId: ['topic:b', 'topic:a'] })
    ).toBe('topic:b');
    expect(
      channelSearchRequestedChannelId({ channelId: ['topic:a', 'topic:b'] })
    ).toBe('topic:a');
    expect(channelSearchRequestedChannelId({ channelId: '' })).toBeUndefined();
    expect(channelSearchRequestedChannelId({ channelId: [] })).toBeUndefined();
    expect(channelSearchRequestedChannelId({})).toBeUndefined();
    expect(channelSearchRequestedChannelId(undefined)).toBeUndefined();
    // A nested/object value is not a channel name and must not become one.
    expect(
      channelSearchRequestedChannelId({ channelId: { $ne: 'x' } })
    ).toBeUndefined();
  });
});

describe('channel routes — private routes stay closed to the standing read lease (#1410)', () => {
  it('denies every private channel route for a channel-scoped actor', async () => {
    const h = await harness({
      binder: {
        interrupt: async () => {
          throw new Error('binder must never be reached');
        },
        respondToApproval: async () => {
          throw new Error('binder must never be reached');
        },
      },
    });
    const actorHeaders = {
      'x-test-actor-id': 'agent-profile:claude:default',
      'x-test-actor-scope': JSON.stringify({ channelIds: [h.channelId] }),
      'x-relay-capabilities': 'context:read,context:write',
    };
    // Opening search moved exactly one deny. Enumerate the rest so a future
    // "just drop denyScopedActorPrivateRoute" cannot pass silently.
    for (const [method, url] of [
      ['POST', `/channels/${encodeURIComponent(h.channelId)}/attachments`],
      ['GET', `/channels/${encodeURIComponent(h.channelId)}/attachments/att-1`],
      ['POST', `/channels/${encodeURIComponent(h.channelId)}/agent-commands`],
      [
        'POST',
        `/channels/${encodeURIComponent(h.channelId)}/agent-runtimes/restart`,
      ],
      [
        'POST',
        `/channels/${encodeURIComponent(h.channelId)}/agents/claude/interrupt`,
      ],
      [
        'POST',
        `/channels/${encodeURIComponent(h.channelId)}/agents/claude/approvals`,
      ],
    ] as const) {
      const denied = await req<{
        error: { code: string; details?: Record<string, unknown> };
      }>({
        port: h.port,
        method,
        url,
        body: method === 'POST' ? {} : undefined,
        headers: actorHeaders,
      });
      expect([method, url, denied.status]).toEqual([method, url, 403]);
      expect(denied.body.error.details?.['reasonCode']).toBe(
        'CHANNEL_PRIVATE_ROUTE_ACTOR_FORBIDDEN'
      );
    }

    // Read state is operator-only through a different guard, and stays so.
    for (const [method, url] of [
      ['GET', '/channels/read-state'],
      ['PUT', `/channels/${encodeURIComponent(h.channelId)}/read-state`],
    ] as const) {
      const denied = await req<{
        error: { details?: Record<string, unknown> };
      }>({
        port: h.port,
        method,
        url,
        body: method === 'PUT' ? { lastReadSeq: 1 } : undefined,
        headers: actorHeaders,
      });
      expect([url, denied.status]).toEqual([url, 403]);
      expect(denied.body.error.details?.['reasonCode']).toBe(
        'CHANNEL_READ_STATE_HUMAN_ONLY'
      );
    }
  });
});

describe('channel routes — channel-scope escape (Slice 0 gate)', () => {
  function actorHeaders(channelId: string, method: 'GET' | 'POST') {
    return {
      'x-test-actor-id': 'claude',
      'x-test-actor-scope': JSON.stringify({ channelIds: [channelId] }),
      ...(method === 'GET' ? { 'x-relay-capabilities': 'context:read' } : {}),
    };
  }

  it('an actor scoped to channel A can read/write A but never enumerate, read, or write B', async () => {
    const h = await harness();
    enrollActor(h, 'claude');
    // The harness default channel is A; create a second persisted channel B.
    const a = h.channelId;
    const b = h.topicStore.create({ workspaceId: 'ws', title: 'Other' }).id;

    // Positive: the same actor CAN read and write channel A.
    const postA = await req<{ message: { sender: { kind: string } } }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${encodeURIComponent(a)}/messages`,
      body: { text: 'to A' },
      headers: actorHeaders(a, 'POST'),
    });
    expect(postA.status).toBe(201);
    const getA = await req<{ channel: { id: string } }>({
      port: h.port,
      method: 'GET',
      url: `/channels/${encodeURIComponent(a)}`,
      headers: actorHeaders(a, 'GET'),
    });
    expect(getA.status).toBe(200);
    expect(getA.body.channel.id).toBe(a);
    const historyA = await req<{ messages: unknown[] }>({
      port: h.port,
      method: 'GET',
      url: `/channels/${encodeURIComponent(a)}/messages`,
      headers: actorHeaders(a, 'GET'),
    });
    expect(historyA.status).toBe(200);

    // (a) GET /channels returns only channel A (never B).
    const list = await req<{ channels: Array<{ id: string }> }>({
      port: h.port,
      method: 'GET',
      url: '/channels',
      headers: actorHeaders(a, 'GET'),
    });
    expect(list.status).toBe(200);
    const listedIds = list.body.channels.map((c) => c.id);
    expect(listedIds).toContain(a);
    expect(listedIds).not.toContain(b);

    const seededB = await req({
      port: h.port,
      method: 'POST',
      url: `/channels/${encodeURIComponent(b)}/messages`,
      body: { text: 'quarantine leak marker' },
    });
    expect(seededB.status).toBe(201);
    // #1410: an in-scope actor MAY search, but an unnamed search reaches only
    // its own channels. B's row is indexed and matching, and must still not
    // appear — search is scope-narrowed at the candidate set, not filtered
    // after the index answered.
    const globalSearch = await req<{ results: Array<{ channelId: string }> }>({
      port: h.port,
      method: 'GET',
      url: '/channels/search?q=quarantine',
      headers: actorHeaders(a, 'GET'),
    });
    expect(globalSearch.status).toBe(200);
    expect(globalSearch.body.results).toEqual([]);
    const seededA = await req({
      port: h.port,
      method: 'POST',
      url: `/channels/${encodeURIComponent(a)}/messages`,
      body: { text: 'quarantine marker in scope' },
    });
    expect(seededA.status).toBe(201);
    const ownSearch = await req<{ results: Array<{ channelId: string }> }>({
      port: h.port,
      method: 'GET',
      url: '/channels/search?q=quarantine',
      headers: actorHeaders(a, 'GET'),
    });
    expect(ownSearch.status).toBe(200);
    expect(ownSearch.body.results.map((hit) => hit.channelId)).toEqual([a]);
    // An explicit out-of-scope channelId is refused before the store is read.
    const crossSearch = await req<{
      error: { code: string; details?: Record<string, unknown> };
    }>({
      port: h.port,
      method: 'GET',
      url: `/channels/search?q=quarantine&channelId=${encodeURIComponent(b)}`,
      headers: actorHeaders(a, 'GET'),
    });
    expect(crossSearch.status).toBe(403);
    expect(crossSearch.body.error.details?.['reasonCode']).toBe(
      'CHANNEL_OUT_OF_SCOPE'
    );

    // (b) Every channel-B read/write is 403 FORBIDDEN before touching the store.
    for (const [method, url] of [
      ['GET', `/channels/${encodeURIComponent(b)}`],
      ['GET', `/channels/${encodeURIComponent(b)}/messages`],
      ['GET', `/channels/${encodeURIComponent(b)}/roster`],
      ['GET', `/channels/${encodeURIComponent(b)}/threads/root`],
      ['POST', `/channels/${encodeURIComponent(b)}/messages`],
    ] as const) {
      const res = await req<{ error: { code: string } }>({
        port: h.port,
        method,
        url,
        body: method === 'POST' ? { text: 'to B' } : undefined,
        headers: actorHeaders(a, method),
      });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
  });

  it('denies scope-less actors list and global search while preserving browser/operator reads', async () => {
    const h = await harness();
    const seeded = await req({
      port: h.port,
      method: 'POST',
      url: `/channels/${encodeURIComponent(h.channelId)}/messages`,
      body: { text: 'scope boundary marker' },
    });
    expect(seeded.status).toBe(201);
    const actorHeaders = {
      'x-test-actor-id': 'claude',
      'x-relay-capabilities': 'context:read',
    };

    for (const url of ['/channels', '/channels/search?q=boundary']) {
      const denied = await req<{
        error: { code: string; details?: Record<string, unknown> };
      }>({
        port: h.port,
        method: 'GET',
        url,
        headers: actorHeaders,
      });
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe('FORBIDDEN');
      // #1410 opened search to in-scope actors via `channels.search`. A
      // credential with NO channel scope still cannot enumerate or search:
      // the deny simply names the missing scope instead of the private route.
      expect(denied.body.error.details?.['reasonCode']).toBe(
        'CHANNEL_SCOPE_REQUIRED'
      );
    }

    for (const [method, url] of [
      ['GET', `/channels/${encodeURIComponent(h.channelId)}`],
      ['GET', `/channels/${encodeURIComponent(h.channelId)}/messages`],
      ['GET', `/channels/${encodeURIComponent(h.channelId)}/roster`],
      ['GET', `/channels/${encodeURIComponent(h.channelId)}/threads/root`],
      ['POST', `/channels/${encodeURIComponent(h.channelId)}/messages`],
    ] as const) {
      const denied = await req<{ error: { code: string } }>({
        port: h.port,
        method,
        url,
        body: method === 'POST' ? { text: 'scope-less write' } : undefined,
        headers: actorHeaders,
      });
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe('FORBIDDEN');
    }

    const browserList = await req<{ channels: Array<{ id: string }> }>({
      port: h.port,
      method: 'GET',
      url: '/channels',
      capabilities: 'context:read',
    });
    expect(browserList.status).toBe(200);
    expect(browserList.body.channels.map((channel) => channel.id)).toContain(
      h.channelId
    );

    const browserSearch = await req<{ results: unknown[] }>({
      port: h.port,
      method: 'GET',
      url: '/channels/search?q=boundary',
      capabilities: 'context:read',
    });
    expect(browserSearch.status).toBe(200);
    expect(browserSearch.body.results).toHaveLength(1);
  });

  it('exempts only the #1467 host-local operator credential from channel scope', async () => {
    const h = await harness();
    const seeded = await req({
      port: h.port,
      method: 'POST',
      url: `/channels/${encodeURIComponent(h.channelId)}/messages`,
      body: { text: 'local operator marker' },
    });
    expect(seeded.status).toBe(201);

    // Same scope-less credential, but carrying the trusted in-process marker.
    const localOperatorHeaders = {
      'x-test-actor-id': 'local-cli',
      'x-test-actor-reason': 'hub-local-cli',
      'x-relay-capabilities': 'context:read',
    };
    const list = await req<{ channels: Array<{ id: string }> }>({
      port: h.port,
      method: 'GET',
      url: '/channels',
      headers: localOperatorHeaders,
    });
    expect(list.status).toBe(200);
    expect(list.body.channels.map((channel) => channel.id)).toContain(
      h.channelId
    );

    for (const url of [
      `/channels/${encodeURIComponent(h.channelId)}`,
      `/channels/${encodeURIComponent(h.channelId)}/messages`,
      '/channels/search?q=marker',
    ]) {
      const allowed = await req({
        port: h.port,
        method: 'GET',
        url,
        headers: localOperatorHeaders,
      });
      expect(allowed.status).toBe(200);
    }

    // Attribution is deliberately unchanged: the host-local credential posts
    // as an agent sender and stays under the ordinary agent brake. Only
    // `persistent-orchestrator` reaches the verbatim sender-id path. Pinned
    // here so promoting it to operator attribution is a decision, not a drift.
    const posted = await req<{
      message: { sender: { kind: string; id: string } };
    }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${encodeURIComponent(h.channelId)}/messages`,
      body: { text: 'posted by the host-local operator' },
      headers: {
        ...localOperatorHeaders,
        'x-relay-capabilities': 'context:write',
      },
    });
    expect(posted.status).toBe(201);
    expect(posted.body.message.sender).toMatchObject({
      kind: 'agent',
      id: 'agent:local-cli',
    });

    // A neighbouring reason marker must NOT inherit the exemption.
    const otherMarker = await req<{
      error: { details?: Record<string, unknown> };
    }>({
      port: h.port,
      method: 'GET',
      url: '/channels',
      headers: {
        'x-test-actor-id': 'claude',
        'x-test-actor-reason': 'channel-runtime-read',
        'x-relay-capabilities': 'context:read',
      },
    });
    expect(otherMarker.status).toBe(403);
    expect(otherMarker.body.error.details?.['reasonCode']).toBe(
      'CHANNEL_SCOPE_REQUIRED'
    );
  });
});

describe('channel routes — agent commands', () => {
  const commandBinder = (
    calls: unknown[] = []
  ): Partial<ChannelAgentBinder> => ({
    isControlMessage: (text: string) => /@codex\s*\/compact/i.test(text),
    executeCommand: async (...args: unknown[]) => {
      calls.push(args);
      return { config: { model: 'gpt-fast' } };
    },
  });

  it('keeps private commands outside the scoped actor lane and denies before dispatch', async () => {
    const commands: string[] = [];
    const calls: unknown[] = [];
    const h = await harness({
      binder: commandBinder(calls),
      requireWriteActorAuth: (command) => (req, res, next) => {
        commands.push(command);
        next();
      },
    });
    const res = await req<{ error: unknown }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${h.channelId}/agent-commands`,
      headers: {
        'x-test-actor-id': 'agent-profile:codex:scoped',
        'x-test-actor-scope': JSON.stringify({ channelIds: [h.channelId] }),
      },
      body: {
        profileId: 'agent-profile:codex:default',
        command: 'model',
        args: 'gpt-fast',
      },
    });
    expect(res.status).toBe(403);
    expect(commands).toEqual([]);
    expect(calls).toEqual([]);
    expect(h.store.history(h.channelId, { limit: 10 })).toEqual([]);
  });

  it('lets an in-scope actor search while interrupt and approval stay denied with no binder side effect', async () => {
    const calls: string[] = [];
    const h = await harness({
      binder: {
        interrupt: async () => {
          calls.push('interrupt');
        },
        respondToApproval: async () => {
          calls.push('approval');
        },
      },
    });
    enrollActor(h, 'agent-profile:codex:scoped');
    h.store.appendComplete({
      channelId: h.channelId,
      sender: { kind: 'human', id: 'human:operator' },
      text: 'private searchable text',
    });
    const rowsBefore = h.store.history(h.channelId, { limit: 10 });
    const actorHeaders = {
      'x-test-actor-id': 'agent-profile:codex:scoped',
      'x-test-actor-scope': JSON.stringify({ channelIds: [h.channelId] }),
    };
    // #1410: search is the ONE surface this slice opened. It reads the same
    // durable log `channels.history` already grants, inside the same scope.
    const search = await req<{ results: Array<{ channelId: string }> }>({
      port: h.port,
      method: 'GET',
      url: `/channels/search?q=private&channelId=${encodeURIComponent(h.channelId)}`,
      headers: actorHeaders,
    });
    const interrupt = await req<{ error: unknown }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${h.channelId}/agents/codex/interrupt`,
      headers: actorHeaders,
      body: {},
    });
    const approval = await req<{ error: unknown }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${h.channelId}/agents/codex/approvals`,
      headers: actorHeaders,
      body: { requestId: 'approval-1', decision: { kind: 'accept' } },
    });
    expect([search.status, interrupt.status, approval.status]).toEqual([
      200, 403, 403,
    ]);
    expect(search.body.results.map((hit) => hit.channelId)).toEqual([
      h.channelId,
    ]);
    expect(calls).toEqual([]);
    expect(h.store.history(h.channelId, { limit: 10 })).toEqual(rowsBefore);
  });

  it('rejects archived commands and dispatches successful controls without rows', async () => {
    const calls: unknown[] = [];
    const h = await harness({ binder: commandBinder(calls) });
    h.topicStore.archive(h.channelId);
    const archived = await req<{
      error: { details?: { reasonCode?: string } };
    }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${h.channelId}/agent-commands`,
      body: {
        profileId: 'agent-profile:codex:default',
        command: 'model',
        args: 'gpt-fast',
      },
    });
    expect(archived.status).toBe(409);
    expect(calls).toHaveLength(0);
    h.topicStore.restore(h.channelId);
    const unknown = await req<{ error: { code: string } }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${h.channelId}/agent-commands`,
      body: {
        profileId: 'agent-profile:codex:default',
        command: 'model',
        threadId: 'chm:not-a-thread',
      },
    });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('NOT_FOUND');
    expect(calls).toHaveLength(0);
    const thread = h.store.createThread({
      channelId: h.channelId,
      title: 'Command scope',
    });
    const rowsBefore = h.store.history(h.channelId, { limit: 10 });
    const ok = await req<{ ok: boolean }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${h.channelId}/agent-commands`,
      body: {
        profileId: 'agent-profile:codex:default',
        command: 'model',
        args: 'gpt-fast',
        threadId: thread.rootMessageId,
      },
    });
    expect(ok.status).toBe(200);
    expect(calls).toEqual([
      [
        h.channelId,
        'agent-profile:codex:default',
        'model',
        'gpt-fast',
        false,
        thread.rootMessageId,
      ],
    ]);
    expect(h.store.history(h.channelId, { limit: 10 })).toEqual(rowsBefore);
  });

  it('restarts only the requested conversation scope and refuses malformed scope', async () => {
    const calls: unknown[] = [];
    const h = await harness({
      binder: {
        restartScope: async (...args: unknown[]) => {
          calls.push(args);
          return { restarted: 2 };
        },
      },
    });

    const malformed = await req<{ error: { code: string } }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${h.channelId}/agent-runtimes/restart`,
      body: { threadId: '' },
    });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('INVALID_ARGUMENT');
    expect(calls).toEqual([]);

    const unknown = await req<{ error: { code: string } }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${h.channelId}/agent-runtimes/restart`,
      body: { threadId: 'chm:not-a-thread' },
    });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('NOT_FOUND');
    expect(calls).toEqual([]);

    const thread = h.store.createThread({
      channelId: h.channelId,
      title: 'Apply scope',
    });

    const restarted = await req<{ ok: boolean; restarted: number }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${h.channelId}/agent-runtimes/restart`,
      body: { threadId: thread.rootMessageId },
    });
    expect(restarted).toMatchObject({
      status: 200,
      body: { ok: true, restarted: 2 },
    });
    expect(calls).toEqual([[h.channelId, thread.rootMessageId]]);
  });

  const realControlBinder = ({
    store,
    hub,
    topicStore,
  }: {
    store: ChannelMessageStore;
    hub: ChannelHub;
    topicStore: WorkspaceTopicStore;
  }) =>
    createChannelAgentBinder({
      store,
      hub,
      topicStore,
      runtimes: {
        create: async () => {
          throw new Error('control messages must not create a runtime');
        },
        get: () => undefined,
        destroy: async () => {},
        onRuntimeEnd: () => () => {},
      },
      knownProviderIds: ['codex'],
      mentionTargets: async () => [
        {
          id: 'codex',
          displayName: 'Codex',
          kind: 'framework' as const,
          available: true,
          reason: null,
        },
      ],
      port: 0,
      configDir: '/tmp',
    });

  it.each([
    '@codex/compact',
    '@codex /compact',
    'please @codex/compact',
    '@codex hello @codex/compact',
  ])('rejects normal-post control form %s before persistence', async (text) => {
    const h = await harness({ binderFactory: realControlBinder });
    const res = await req<{
      error: { details?: { reasonCode?: string } };
    }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${h.channelId}/messages`,
      body: { text },
    });
    expect(res.status).toBe(400);
    expect(h.store.history(h.channelId, { limit: 10 })).toHaveLength(0);
  });

  it.each(['/model gpt-5.6', '/effort high'])(
    'rejects bare DM control %s before persistence',
    async (text) => {
      const h = await harness({ binderFactory: realControlBinder });
      const dm = h.topicStore.create(
        dmChannelCreateInput({
          providerId: 'codex',
          providerDisplayName: 'Codex',
          workspaceId: 'ws:local',
        })
      );
      const res = await req<{
        error: { details?: { reasonCode?: string } };
      }>({
        port: h.port,
        method: 'POST',
        url: `/channels/${dm.id}/messages`,
        body: { text },
      });

      expect(res.status).toBe(400);
      expect(res.body.error.details?.reasonCode).toBe(
        'CHANNEL_COMMAND_REQUIRES_CONTROL_LANE'
      );
      expect(h.store.history(dm.id, { limit: 10 })).toHaveLength(0);
    }
  );

  it.each(['/model prime/a', '/thinking high', '/effort high'])(
    'rejects bare Prime DM control %s before persistence',
    async (text) => {
      const h = await harness({ binderFactory: realControlBinder });
      const dm = h.topicStore.create(
        dmChannelCreateInput({
          providerId: 'prime-agent',
          providerDisplayName: 'Prime Agent',
          workspaceId: 'ws:local',
        })
      );
      const res = await req<{
        error: { details?: { reasonCode?: string } };
      }>({
        port: h.port,
        method: 'POST',
        url: `/channels/${dm.id}/messages`,
        body: { text },
      });

      expect(res.status).toBe(400);
      expect(res.body.error.details?.reasonCode).toBe(
        'CHANNEL_COMMAND_REQUIRES_CONTROL_LANE'
      );
      expect(h.store.history(dm.id, { limit: 10 })).toHaveLength(0);
    }
  );

  it('keeps bare group-channel slash text as ordinary persisted prose', async () => {
    const h = await harness({ binderFactory: realControlBinder });
    const res = await req<{ message: { body: { text: string } } }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${h.channelId}/messages`,
      body: { text: '/model gpt-5.6' },
    });

    expect(res.status).toBe(201);
    expect(res.body.message.body.text).toBe('/model gpt-5.6');
    expect(h.store.history(h.channelId, { limit: 10 })).toHaveLength(1);
  });
});

describe('channel routes — orchestrator designation (#1259)', () => {
  function realDesignationBinder(gated: boolean): {
    factory: (deps: {
      store: ChannelMessageStore;
      hub: ChannelHub;
      topicStore: WorkspaceTopicStore;
    }) => ChannelAgentBinder;
    state: { spawns: number };
    release: () => void;
  } {
    const state = { spawns: 0 };
    const runtimes = new Map<string, ChannelAgentRuntime>();
    let release!: () => void;
    const gate = gated
      ? new Promise<void>((resolve) => {
          release = resolve;
        })
      : Promise.resolve();
    if (!gated) release = () => {};
    return {
      state,
      release: () => release(),
      factory: ({ store, hub, topicStore }) =>
        createChannelAgentBinder({
          store,
          hub,
          topicStore,
          runtimes: {
            create: async (params) => {
              state.spawns += 1;
              await gate;
              const id = `runtime:${state.spawns}:${params.providerId}`;
              const adapter = new MockProtocolAdapterV2({
                connectMs: 0,
                stepMs: 0,
              });
              await adapter.connect({
                cwd: params.cwd,
                port: 0,
                sessionId: id,
                hookToken: 'test',
                configDir: params.configDir,
              });
              const runtime: ChannelAgentRuntime = {
                id,
                providerId: params.providerId,
                profileActorId: params.profileActorId,
                ...(params.role !== undefined ? { role: params.role } : {}),
                status: 'active',
                adapter,
                cwd: params.cwd,
                providerSession: {},
                displayName: params.providerId,
                hookToken: 'test',
                hooksActive: false,
                agentState: 'idle',
                idle: true,
                needsBranchRename: false,
                lastActivity: '2026-01-01T00:00:00.000Z',
              };
              runtimes.set(id, runtime);
              return runtime;
            },
            get: (id) => runtimes.get(id),
            destroy: async (id) => {
              runtimes.delete(id);
            },
            onRuntimeEnd: () => () => {},
          },
          knownProviderIds: ['mock', 'codex'],
          mentionTargets: async () => [
            {
              id: 'mock',
              displayName: 'Mock',
              kind: 'framework',
              available: true,
              reason: null,
            },
            {
              id: 'codex',
              displayName: 'Codex',
              kind: 'framework',
              available: true,
              reason: null,
            },
          ],
          port: 0,
          configDir: '/tmp',
        }),
    };
  }

  async function postBareAndReadWinner(h: Harness): Promise<string[]> {
    const post = await req<{ message: { id: string } }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${h.channelId}/messages`,
      body: { text: 'continue the plan' },
    });
    expect(post.status).toBe(201);
    try {
      await waitForCondition(() =>
        h.store
          .history(h.channelId, { limit: 20 })
          .some((row) => row.sender.kind === 'agent')
      );
    } catch {
      throw new Error(
        `bare route produced no agent row: ${JSON.stringify(
          h.store.history(h.channelId, { limit: 20 })
        )}`
      );
    }
    return h.store
      .history(h.channelId, { limit: 20 })
      .filter((row) => row.sender.kind === 'agent')
      .map((row) => row.sender.providerId ?? '');
  }

  it('designates the persistent orchestrator via ensureOrchestrator', async () => {
    const calls: Array<{ channelId: string; framework: string }> = [];
    const h = await harness({
      binder: {
        ensureOrchestrator: async (channelId: string, framework: string) => {
          calls.push({ channelId, framework });
          return { runtimeId: 'orch-1', status: 'idle' } as never;
        },
      },
    });
    const res = await req<{
      ok: boolean;
      orchestrator: { runtimeId: string; status: string; framework: string };
    }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${h.channelId}/orchestrator?framework=claude`,
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.orchestrator).toEqual({
      runtimeId: 'orch-1',
      status: 'idle',
      framework: 'claude',
    });
    expect(calls).toEqual([{ channelId: h.channelId, framework: 'claude' }]);
  });

  it('keeps sequential route designation idempotent, then bare-routes the winner', async () => {
    const real = realDesignationBinder(false);
    const h = await harness({ binderFactory: real.factory });
    const designate = (framework: string) =>
      req<{
        ok?: boolean;
        error?: {
          code: string;
          details?: Record<string, unknown>;
        };
      }>({
        port: h.port,
        method: 'POST',
        url: `/channels/${h.channelId}/orchestrator?framework=${framework}`,
      });

    expect((await designate('mock')).status).toBe(200);
    expect((await designate('mock')).status).toBe(200);
    const conflict = await designate('codex');
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toMatchObject({
      code: 'SESSION_CONFLICT',
      details: {
        reasonCode: 'CHANNEL_ORCHESTRATOR_CONFLICT',
        channelId: h.channelId,
        designatedProfileActorId: builtInAgentProfileId('mock'),
        requestedProfileActorId: builtInAgentProfileId('codex'),
      },
    });
    expect(
      h.store.getSoleOrchestratorBinding(h.channelId)?.profileActorId
    ).toBe(builtInAgentProfileId('mock'));
    expect(real.state.spawns).toBe(1);
    const routedProviders = await postBareAndReadWinner(h);
    expect(routedProviders.length).toBeGreaterThan(0);
    expect(new Set(routedProviders)).toEqual(new Set(['mock']));
  });

  it('allows one concurrent route winner, then bare-routes only that runtime', async () => {
    const real = realDesignationBinder(true);
    const h = await harness({ binderFactory: real.factory });
    const mockRequest = req<{ ok?: boolean; error?: { code: string } }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${h.channelId}/orchestrator?framework=mock`,
    });
    const codexRequest = req<{ ok?: boolean; error?: { code: string } }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${h.channelId}/orchestrator?framework=codex`,
    });
    await waitForCondition(() => real.state.spawns === 1);
    // Both requests overlap while the winner's runtime launch is parked; the
    // channel-level binder lock must keep the competitor from spawning.
    expect(real.state.spawns).toBe(1);
    real.release();
    const [mock, codex] = await Promise.all([mockRequest, codexRequest]);
    expect([mock.status, codex.status].sort()).toEqual([200, 409]);
    const loser = mock.status === 409 ? mock : codex;
    expect(loser.body.error?.code).toBe('SESSION_CONFLICT');
    expect(real.state.spawns).toBe(1);
    const sole = h.store.getSoleOrchestratorBinding(h.channelId);
    expect(sole).not.toBeNull();
    const winnerProvider = sole?.agentFramework ?? '';
    const loserProfile =
      winnerProvider === 'mock'
        ? builtInAgentProfileId('codex')
        : builtInAgentProfileId('mock');
    expect(h.store.getBinding(h.channelId, loserProfile)).toBeNull();
    const routedProviders = await postBareAndReadWinner(h);
    expect(routedProviders.length).toBeGreaterThan(0);
    expect(new Set(routedProviders)).toEqual(new Set([winnerProvider]));
  });

  it('defaults the framework to claude when omitted', async () => {
    const seen: string[] = [];
    const h = await harness({
      binder: {
        ensureOrchestrator: async (_channelId: string, framework: string) => {
          seen.push(framework);
          return { runtimeId: 'orch-2', status: 'idle' } as never;
        },
      },
    });
    const res = await req<{ ok: boolean }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${h.channelId}/orchestrator`,
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual(['claude']);
  });

  it('refuses DM designation before invoking the binder', async () => {
    let called = false;
    const h = await harness({
      binder: {
        ensureOrchestrator: async () => {
          called = true;
          return { runtimeId: 'orch-dm', status: 'idle' } as never;
        },
      },
    });
    const dm = h.topicStore.create(
      dmChannelCreateInput({
        providerId: 'codex',
        providerDisplayName: 'Codex',
        workspaceId: 'ws:local',
      })
    );

    const res = await req<{
      error: {
        code: string;
        retryable: boolean;
        details?: Record<string, unknown>;
      };
    }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${dm.id}/orchestrator`,
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('UNSUPPORTED');
    expect(res.body.error.retryable).toBe(false);
    expect(res.body.error.details).toEqual({
      channelId: dm.id,
      reasonCode: 'DM_ORCHESTRATOR_UNSUPPORTED',
    });
    expect(called).toBe(false);
  });

  it('maps a role conflict to SESSION_CONFLICT', async () => {
    const h = await harness({
      binder: {
        ensureOrchestrator: async () => {
          throw new ChannelAgentRoleConflictError(
            'topic:x',
            'claude',
            'sess-x',
            'implementer'
          );
        },
      },
    });
    const res = await req<{ error: { reasonCode?: string } }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${h.channelId}/orchestrator`,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBeDefined();
  });

  it('returns 503 when no binder is configured', async () => {
    const h = await harness();
    const res = await req<{ error: unknown }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${h.channelId}/orchestrator`,
    });
    expect(res.status).toBe(503);
  });
});

describe('channel routes — explicit idle agent release', () => {
  it('releases a live idle binding through the binder-owned control lane', async () => {
    const calls: Array<{ channelId: string; agentId: string }> = [];
    const h = await harness({
      binder: {
        release: async (channelId: string, agentId: string) => {
          calls.push({ channelId, agentId });
        },
      },
    });
    const res = await req<{ ok: boolean }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${h.channelId}/agents/agent-profile%3Acodex%3Adefault/release`,
    });

    expect(res).toMatchObject({ status: 200, body: { ok: true } });
    expect(calls).toEqual([
      { channelId: h.channelId, agentId: 'agent-profile:codex:default' },
    ]);
  });

  it('passes an explicit thread scope to the release control without falling back to root', async () => {
    const calls: Array<{
      channelId: string;
      agentId: string;
      threadId: string | null | undefined;
    }> = [];
    const h = await harness({
      binder: {
        release: async (
          channelId: string,
          agentId: string,
          threadId?: string | null
        ) => {
          calls.push({ channelId, agentId, threadId });
        },
      },
    });
    const res = await req<{ ok: boolean }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${h.channelId}/agents/mock/release`,
      body: { threadId: 'chm:thread-one' },
    });

    expect(res).toMatchObject({ status: 200, body: { ok: true } });
    expect(calls).toEqual([
      {
        channelId: h.channelId,
        agentId: 'mock',
        threadId: 'chm:thread-one',
      },
    ]);
  });

  it('maps an active, queued, or waiting binding refusal to a retryable conflict', async () => {
    const h = await harness({
      binder: {
        release: async () => {
          throw new ChannelAgentReleaseRefusedError(
            'topic:x',
            'agent-profile:codex:default',
            'thinking',
            'CHANNEL_AGENT_NOT_IDLE'
          );
        },
      },
    });
    const res = await req<{
      error: { retryable: boolean; details?: Record<string, unknown> };
    }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${h.channelId}/agents/codex/release`,
    });

    expect(res.status).toBe(409);
    expect(res.body.error.retryable).toBe(true);
    expect(res.body.error.details?.['reasonCode']).toBe(
      'CHANNEL_AGENT_NOT_IDLE'
    );
  });

  it('refuses release by an agent credential before consulting the binding', async () => {
    const release = async () => {
      throw new Error('must not be called');
    };
    const h = await harness({ binder: { release } });
    const res = await req<{ error: { details?: Record<string, unknown> } }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${h.channelId}/agents/codex/release`,
      headers: { 'x-test-actor-id': 'codex' },
    });

    expect(res.status).toBe(403);
    expect(res.body.error.details?.['reasonCode']).toBe(
      'CHANNEL_RELEASE_HUMAN_ONLY'
    );
  });
});

describe('channel routes — message retry (#1308 slice 1 item 2)', () => {
  it('re-routes through the binder and echoes what was re-run', async () => {
    const calls: Array<{ channelId: string; messageId: string }> = [];
    const h = await harness({
      binder: {
        retryMessage: async (channelId: string, messageId: string) => {
          calls.push({ channelId, messageId });
          return {
            messageId,
            triggerMessageId: 'chm:trigger',
            profileActorId: 'agent-profile:claude:default',
          };
        },
      },
    });
    const res = await req<{
      ok: boolean;
      retry: { triggerMessageId: string; profileActorId: string };
    }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${h.channelId}/messages/chm%3Afailed/retry`,
    });
    expect(res.status).toBe(200);
    expect(res.body.retry).toEqual({
      messageId: 'chm:failed',
      triggerMessageId: 'chm:trigger',
      profileActorId: 'agent-profile:claude:default',
    });
    expect(calls).toEqual([
      { channelId: h.channelId, messageId: 'chm:failed' },
    ]);
  });

  it('maps the busy storm brake to 409 CHANNEL_AGENT_BUSY', async () => {
    const h = await harness({
      binder: {
        retryMessage: async () => {
          throw new ChannelAgentBusyError(
            'topic:x',
            'agent-profile:claude:default',
            'streaming'
          );
        },
      },
    });
    const res = await req<{
      error: { retryable: boolean; details?: Record<string, unknown> };
    }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${h.channelId}/messages/chm%3Afailed/retry`,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.details?.['reasonCode']).toBe('CHANNEL_AGENT_BUSY');
    // Retryable: the operator can press again once the agent goes idle.
    expect(res.body.error.retryable).toBe(true);
  });

  it('separates a missing row (404) from an unretryable one (409)', async () => {
    const h = await harness({
      binder: {
        retryMessage: async (_channelId: string, messageId: string) => {
          throw messageId === 'chm:missing'
            ? new ChannelMessageNotRetryableError(
                'message not found in this channel',
                'CHANNEL_MESSAGE_NOT_FOUND',
                true
              )
            : new ChannelMessageNotRetryableError(
                'not retryable',
                'MESSAGE_NOT_RETRYABLE'
              );
        },
      },
    });
    const missing = await req<{ error: { details?: Record<string, unknown> } }>(
      {
        port: h.port,
        method: 'POST',
        url: `/channels/${h.channelId}/messages/chm%3Amissing/retry`,
      }
    );
    expect(missing.status).toBe(404);
    expect(missing.body.error.details?.['reasonCode']).toBe(
      'CHANNEL_MESSAGE_NOT_FOUND'
    );
    const unretryable = await req<{
      error: { details?: Record<string, unknown> };
    }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${h.channelId}/messages/chm%3Acomplete/retry`,
    });
    expect(unretryable.status).toBe(409);
    expect(unretryable.body.error.details?.['reasonCode']).toBe(
      'MESSAGE_NOT_RETRYABLE'
    );
  });

  it('404s an unknown channel and 503s with no binder configured', async () => {
    const h = await harness({
      binder: { retryMessage: async () => ({}) as never },
    });
    const unknown = await req<{ error: unknown }>({
      port: h.port,
      method: 'POST',
      url: `/channels/topic%3Anope/messages/chm%3Afailed/retry`,
    });
    expect(unknown.status).toBe(404);

    const noBinder = await harness();
    const res = await req<{ error: unknown }>({
      port: noBinder.port,
      method: 'POST',
      url: `/channels/${noBinder.channelId}/messages/chm%3Afailed/retry`,
    });
    expect(res.status).toBe(503);
  });
});

describe('channel routes — retry write fence', () => {
  it('refuses a retry on an archived channel before touching the binder', async () => {
    let called = false;
    const h = await harness({
      binder: {
        retryMessage: async () => {
          called = true;
          return {} as never;
        },
      },
    });
    h.topicStore.archive(h.channelId);

    const res = await req<{ error: { details?: Record<string, unknown> } }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${h.channelId}/messages/chm%3Afailed/retry`,
    });
    // An archived channel is read-only for EVERY write lane: a retry would spawn
    // a runtime, write a durable `retrying @…` system row and append a whole new
    // agent turn.
    expect(res.status).toBe(409);
    expect(res.body.error.details?.['reasonCode']).toBe('CHANNEL_ARCHIVED');
    expect(called).toBe(false);
  });

  it('refuses the agent lane — only the operator may re-run a turn', async () => {
    let called = false;
    const h = await harness({
      binder: {
        retryMessage: async () => {
          called = true;
          return {} as never;
        },
      },
    });
    // A scoped actor credential carries `context:write`, so the capability gate
    // admits it; re-running a turn spends real provider tokens and routes
    // outside the mention-chain brake, so the human gate is the load-bearing one.
    const res = await req<{
      error: { code: string; details?: Record<string, unknown> };
    }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${h.channelId}/messages/chm%3Afailed/retry`,
      headers: {
        'x-test-actor-id': 'claude',
        'x-test-actor-scope': JSON.stringify({ channelIds: [h.channelId] }),
      },
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.details?.['reasonCode']).toBe(
      'CHANNEL_RETRY_HUMAN_ONLY'
    );
    expect(called).toBe(false);
  });
});

describe('channel routes — retry capability gate', () => {
  it('rejects a caller without context:write before touching the binder', async () => {
    let called = false;
    const h = await harness({
      binder: {
        retryMessage: async () => {
          called = true;
          return {} as never;
        },
      },
    });
    const res = await req<{ error: { code: string } }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${h.channelId}/messages/chm%3Afailed/retry`,
      capabilities: 'context:read',
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(called).toBe(false);
  });
});

describe('channel routes — message edit (#1308 slice 1 item 3)', () => {
  const messagesUrl = (channelId: string): string =>
    `/channels/${encodeURIComponent(channelId)}/messages`;

  async function postHuman(
    h: Harness,
    text: string
  ): Promise<{ id: string; seq: number }> {
    const res = await req<{ message: { id: string; seq: number } }>({
      port: h.port,
      method: 'POST',
      url: messagesUrl(h.channelId),
      body: { text },
    });
    expect(res.status).toBe(201);
    return res.body.message;
  }

  it('rewrites the body in place, stamps editedAt, and broadcasts the edit', async () => {
    const h = await harness();
    const posted = await postHuman(h, 'deploy at 3pm @claude');
    const sock = fakeSocket();
    h.hub.handleConnection(sock, { channelId: h.channelId, sinceSeq: null });

    const res = await req<{
      message: {
        id: string;
        seq: number;
        body: { text: string };
        meta?: Record<string, unknown>;
        mentions?: unknown[];
      };
    }>({
      port: h.port,
      method: 'PATCH',
      url: `${messagesUrl(h.channelId)}/${encodeURIComponent(posted.id)}`,
      body: { text: 'deploy at 5pm' },
    });
    expect(res.status).toBe(200);
    // Identity is preserved — a deep link, a thread parent and every seq cursor
    // that already named this row stay valid.
    expect(res.body.message.id).toBe(posted.id);
    expect(res.body.message.seq).toBe(posted.seq);
    expect(res.body.message.body.text).toBe('deploy at 5pm');
    expect(typeof res.body.message.meta?.['editedAt']).toBe('string');
    // Mentions are re-derived from the new text (routing is NOT re-run).
    expect(res.body.message.mentions).toBeUndefined();

    // Durable, not just echoed back.
    expect(h.store.getMessage(posted.id)?.body.text).toBe('deploy at 5pm');
    // No new row: an edit must never grow the timeline.
    expect(h.store.history(h.channelId, { limit: 50 })).toHaveLength(1);

    const edit = sock.sent.find(
      (event) => event.type === 'channel-message-edited-v1'
    );
    expect(edit?.type).toBe('channel-message-edited-v1');
    if (edit?.type === 'channel-message-edited-v1') {
      expect(edit.message.id).toBe(posted.id);
      expect(edit.message.body.text).toBe('deploy at 5pm');
    }
    // Editing is not posting: no created event may ride this lane.
    expect(
      sock.sent.some((event) => event.type === 'channel-message-created-v1')
    ).toBe(false);
  });

  it('refuses agent rows, the agent lane, empty text, archived channels, and unknown ids', async () => {
    const h = await harness();
    enrollActor(h, 'claude');
    const posted = await postHuman(h, 'operator says hi');
    const agentPost = await req<{ message: { id: string } }>({
      port: h.port,
      method: 'POST',
      url: messagesUrl(h.channelId),
      body: { text: 'agent says hi' },
      headers: {
        'x-test-actor-id': 'claude',
        'x-test-actor-scope': JSON.stringify({ channelIds: [h.channelId] }),
      },
    });
    expect(agentPost.status).toBe(201);

    // An agent row is a durable record of what a provider said.
    const agentRow = await req<{
      error: { details?: Record<string, unknown> };
    }>({
      port: h.port,
      method: 'PATCH',
      url: `${messagesUrl(h.channelId)}/${encodeURIComponent(agentPost.body.message.id)}`,
      body: { text: 'rewritten' },
    });
    expect(agentRow.status).toBe(409);
    expect(agentRow.body.error.details?.['reasonCode']).toBe(
      'CHANNEL_MESSAGE_NOT_EDITABLE'
    );

    // An actor credential must never be able to rewrite the operator's words —
    // this lane admits scoped actors, so the human gate is load-bearing.
    const agentLane = await req<{
      error: { code: string; details?: Record<string, unknown> };
    }>({
      port: h.port,
      method: 'PATCH',
      url: `${messagesUrl(h.channelId)}/${encodeURIComponent(posted.id)}`,
      body: { text: 'rewritten by an agent' },
      headers: { 'x-test-actor-id': 'claude' },
    });
    expect(agentLane.status).toBe(403);
    expect(agentLane.body.error.details?.['reasonCode']).toBe(
      'CHANNEL_EDIT_HUMAN_ONLY'
    );
    expect(h.store.getMessage(posted.id)?.body.text).toBe('operator says hi');

    // Clearing a message is a different action with a different audit shape.
    const empty = await req<{ error: { details?: Record<string, unknown> } }>({
      port: h.port,
      method: 'PATCH',
      url: `${messagesUrl(h.channelId)}/${encodeURIComponent(posted.id)}`,
      body: { text: '   ' },
    });
    expect(empty.status).toBe(400);
    expect(empty.body.error.details?.['reasonCode']).toBe(
      'CHANNEL_MESSAGE_BODY_EMPTY'
    );

    const missing = await req<{ error: unknown }>({
      port: h.port,
      method: 'PATCH',
      url: `${messagesUrl(h.channelId)}/chm%3Anope`,
      body: { text: 'rewritten' },
    });
    expect(missing.status).toBe(404);

    h.topicStore.archive(h.channelId);
    const archived = await req<{
      error: { details?: Record<string, unknown> };
    }>({
      port: h.port,
      method: 'PATCH',
      url: `${messagesUrl(h.channelId)}/${encodeURIComponent(posted.id)}`,
      body: { text: 'rewritten' },
    });
    expect(archived.status).toBe(409);
    expect(archived.body.error.details?.['reasonCode']).toBe(
      'CHANNEL_ARCHIVED'
    );
  });

  it('rejects a caller without context:write and a body-supplied sender', async () => {
    const h = await harness();
    const posted = await postHuman(h, 'operator says hi');
    const readOnly = await req<{ error: { code: string } }>({
      port: h.port,
      method: 'PATCH',
      url: `${messagesUrl(h.channelId)}/${encodeURIComponent(posted.id)}`,
      body: { text: 'rewritten' },
      capabilities: 'context:read',
    });
    expect(readOnly.status).toBe(403);
    expect(readOnly.body.error.code).toBe('FORBIDDEN');
    expect(h.store.getMessage(posted.id)?.body.text).toBe('operator says hi');

    const forged = await req<{ error: { details?: Record<string, unknown> } }>({
      port: h.port,
      method: 'PATCH',
      url: `${messagesUrl(h.channelId)}/${encodeURIComponent(posted.id)}`,
      body: { text: 'rewritten', sender: { kind: 'human', id: 'human:other' } },
    });
    expect(forged.status).toBe(400);
    expect(forged.body.error.details?.['reasonCode']).toBe(
      'CHANNEL_SENDER_NOT_ALLOWED'
    );
  });

  it('re-derives edited mentions through the binder resolver so a multi-word profile mention keeps its profileId (#1503)', async () => {
    const profiles = createAgentProfileStore(':memory:');
    cleanup.push(() => profiles.close());
    profiles.seedBuiltIns([{ id: 'mock' }]);
    const tako = profiles.create({
      id: 'agent-profile:mock:tako-planner',
      providerId: 'mock',
      displayName: 'Tako Planner',
    });
    const expected = [
      { raw: '@Tako Planner', providerId: 'mock', profileId: tako.id },
    ];

    const h = await harness({
      binderFactory: ({ store, hub, topicStore }) =>
        createChannelAgentBinder({
          store,
          hub,
          topicStore,
          agentProfileStore: profiles,
          runtimes: {
            create: async () => {
              throw new Error('edits must not create a runtime');
            },
            get: () => undefined,
            destroy: async () => {},
            onRuntimeEnd: () => () => {},
          },
          knownProviderIds: ['mock'],
          mentionTargets: async () => [
            {
              id: 'mock',
              displayName: 'Mock',
              kind: 'framework' as const,
              available: true,
              reason: null,
            },
          ],
          port: 0,
          configDir: '/tmp',
        }),
    });

    const posted = await postHuman(h, 'draft the plan');
    const res = await req<{
      message: {
        id: string;
        seq: number;
        body: { text: string };
        mentions?: unknown[];
      };
    }>({
      port: h.port,
      method: 'PATCH',
      url: `${messagesUrl(h.channelId)}/${encodeURIComponent(posted.id)}`,
      body: { text: '@Tako Planner draft the plan' },
    });

    expect(res.status).toBe(200);
    expect(res.body.message.mentions).toEqual(expected);
    expect(h.store.getMessage(posted.id)?.mentions).toEqual(expected);
    expect(h.store.getBinding(h.channelId, tako.id)).toBeNull();

    // Stray-spawn detection: routeOne catches runtime create errors and posts a
    // SYSTEM row into the timeline. Assert no system rows exist to verify edits never route.
    const rows = h.store.history(h.channelId, { limit: 50 });
    expect(rows).toHaveLength(1);
    expect(rows.filter((m) => m.kind === 'system')).toHaveLength(0);

    const cleared = await req<{
      message: {
        id: string;
        seq: number;
        body: { text: string };
        mentions?: unknown[];
      };
    }>({
      port: h.port,
      method: 'PATCH',
      url: `${messagesUrl(h.channelId)}/${encodeURIComponent(posted.id)}`,
      body: { text: 'no mention now' },
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.message.mentions).toBeUndefined();
    expect(h.store.getMessage(posted.id)?.mentions).toBeUndefined();
  });

  it('persists the vendor-only tokenizer shape when no binder is wired (fallback)', async () => {
    const vendor = DEFAULT_KNOWN_PROVIDER_IDS[0]!;
    const h = await harness();
    const posted = await postHuman(h, `ping @${vendor}`);
    expect(h.store.getMessage(posted.id)?.mentions).toEqual([
      { raw: `@${vendor}`, providerId: vendor },
    ]);
  });
});

describe('channel routes — message delete (#1308 slice 1 item 4)', () => {
  const messagesUrl = (channelId: string): string =>
    `/channels/${encodeURIComponent(channelId)}/messages`;

  async function postHuman(
    h: Harness,
    text: string,
    body: Record<string, unknown> = {}
  ): Promise<{ id: string; seq: number }> {
    const res = await req<{ message: { id: string; seq: number } }>({
      port: h.port,
      method: 'POST',
      url: messagesUrl(h.channelId),
      body: { text, ...body },
    });
    expect(res.status).toBe(201);
    return res.body.message;
  }

  it('tombstones the row, keeps its seq, and broadcasts the deletion', async () => {
    const h = await harness();
    const first = await postHuman(h, 'first');
    const target = await postHuman(h, 'ship @claude the anchor');
    const after = await postHuman(h, 'after');
    const sock = fakeSocket();
    h.hub.handleConnection(sock, { channelId: h.channelId, sinceSeq: null });

    const res = await req<{
      message: {
        id: string;
        seq: number;
        body: { text: string };
        meta?: Record<string, unknown>;
        mentions?: unknown[];
      };
    }>({
      port: h.port,
      method: 'DELETE',
      url: `${messagesUrl(h.channelId)}/${encodeURIComponent(target.id)}`,
    });
    expect(res.status).toBe(200);
    expect(res.body.message.id).toBe(target.id);
    expect(res.body.message.seq).toBe(target.seq);
    expect(res.body.message.body.text).toBe('');
    expect(typeof res.body.message.meta?.['deletedAt']).toBe('string');
    expect(res.body.message.mentions).toBeUndefined();

    // The seq log is the substrate contract: the row count and the numbering
    // are both unchanged, so no cursor, deep link or thread parent moved.
    const history = h.store.history(h.channelId, { limit: 50 });
    expect(history.map((m) => m.id)).toEqual([first.id, target.id, after.id]);
    expect(history.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(h.store.getMessage(target.id)?.body.text).toBe('');

    const event = sock.sent.find(
      (e) => e.type === 'channel-message-deleted-v1'
    );
    expect(event?.type).toBe('channel-message-deleted-v1');
    if (event?.type === 'channel-message-deleted-v1') {
      expect(event.message.id).toBe(target.id);
      expect(event.message.body.text).toBe('');
    }
    // Deleting is not posting: no created event may ride this lane.
    expect(sock.sent.some((e) => e.type === 'channel-message-created-v1')).toBe(
      false
    );
  });

  it('is idempotent and refuses agent rows, the agent lane, archived channels, and unknown ids', async () => {
    const h = await harness();
    enrollActor(h, 'claude');
    const posted = await postHuman(h, 'operator says hi');
    const url = `${messagesUrl(h.channelId)}/${encodeURIComponent(posted.id)}`;

    const first = await req<{ message: { meta?: Record<string, unknown> } }>({
      port: h.port,
      method: 'DELETE',
      url,
    });
    expect(first.status).toBe(200);
    // A double tap (or a second device) converges on the same tombstone rather
    // than surfacing an error for a state already reached.
    const again = await req<{ message: { meta?: Record<string, unknown> } }>({
      port: h.port,
      method: 'DELETE',
      url,
    });
    expect(again.status).toBe(200);
    expect(again.body.message.meta?.['deletedAt']).toBe(
      first.body.message.meta?.['deletedAt']
    );

    const agentPost = await req<{ message: { id: string } }>({
      port: h.port,
      method: 'POST',
      url: messagesUrl(h.channelId),
      body: { text: 'agent says hi' },
      headers: {
        'x-test-actor-id': 'claude',
        'x-test-actor-scope': JSON.stringify({ channelIds: [h.channelId] }),
      },
    });
    expect(agentPost.status).toBe(201);
    const agentRow = await req<{
      error: { details?: Record<string, unknown> };
    }>({
      port: h.port,
      method: 'DELETE',
      url: `${messagesUrl(h.channelId)}/${encodeURIComponent(agentPost.body.message.id)}`,
    });
    expect(agentRow.status).toBe(409);
    expect(agentRow.body.error.details?.['reasonCode']).toBe(
      'CHANNEL_MESSAGE_NOT_DELETABLE'
    );

    // An actor credential must never erase the operator's words — this lane
    // admits scoped actors, so the human gate is load-bearing.
    const live = await postHuman(h, 'still here');
    const agentLane = await req<{
      error: { code: string; details?: Record<string, unknown> };
    }>({
      port: h.port,
      method: 'DELETE',
      url: `${messagesUrl(h.channelId)}/${encodeURIComponent(live.id)}`,
      headers: { 'x-test-actor-id': 'claude' },
    });
    expect(agentLane.status).toBe(403);
    expect(agentLane.body.error.details?.['reasonCode']).toBe(
      'CHANNEL_DELETE_HUMAN_ONLY'
    );
    expect(h.store.getMessage(live.id)?.body.text).toBe('still here');

    const missing = await req<{ error: unknown }>({
      port: h.port,
      method: 'DELETE',
      url: `${messagesUrl(h.channelId)}/chm%3Anope`,
    });
    expect(missing.status).toBe(404);

    h.topicStore.archive(h.channelId);
    const archived = await req<{
      error: { details?: Record<string, unknown> };
    }>({
      port: h.port,
      method: 'DELETE',
      url: `${messagesUrl(h.channelId)}/${encodeURIComponent(live.id)}`,
    });
    expect(archived.status).toBe(409);
    expect(archived.body.error.details?.['reasonCode']).toBe(
      'CHANNEL_ARCHIVED'
    );
    expect(h.store.getMessage(live.id)?.body.text).toBe('still here');
  });

  it('rejects a caller without context:write, and refuses to edit a tombstone', async () => {
    const h = await harness();
    const posted = await postHuman(h, 'operator says hi');
    const url = `${messagesUrl(h.channelId)}/${encodeURIComponent(posted.id)}`;

    const readOnly = await req<{ error: { code: string } }>({
      port: h.port,
      method: 'DELETE',
      url,
      capabilities: 'context:read',
    });
    expect(readOnly.status).toBe(403);
    expect(readOnly.body.error.code).toBe('FORBIDDEN');
    expect(h.store.getMessage(posted.id)?.body.text).toBe('operator says hi');

    expect((await req({ port: h.port, method: 'DELETE', url })).status).toBe(
      200
    );
    // An edit of a tombstone would be an undelete.
    const undelete = await req<{
      error: { details?: Record<string, unknown> };
    }>({
      port: h.port,
      method: 'PATCH',
      url,
      body: { text: 'back from the dead' },
    });
    expect(undelete.status).toBe(409);
    expect(undelete.body.error.details?.['reasonCode']).toBe(
      'CHANNEL_MESSAGE_NOT_EDITABLE'
    );
    expect(h.store.getMessage(posted.id)?.body.text).toBe('');
  });
});

describe('channel routes — message search (#1308 slice 2 item 1)', () => {
  interface SearchBody {
    query: string;
    results: Array<{
      messageId: string;
      channelId: string;
      channelTitle: string;
      archived: boolean;
      seq: number;
      threadId: string | null;
      snippet: string;
      senderKind: string;
      senderId: string;
      senderDisplayName?: string;
      createdAt: string;
      score: number;
    }>;
    truncated: boolean;
    unavailableReason?: string;
    scopeAlias?: string;
  }

  async function post(
    h: Harness,
    channelId: string,
    text: string,
    extra: Record<string, unknown> = {}
  ): Promise<{ id: string; seq: number }> {
    const res = await req<{ message: { id: string; seq: number } }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${encodeURIComponent(channelId)}/messages`,
      body: { text, ...extra },
    });
    expect(res.status).toBe(201);
    return res.body.message;
  }

  function search(
    h: Harness,
    query: string
  ): Promise<{
    status: number;
    body: SearchBody;
  }> {
    return req<SearchBody>({
      port: h.port,
      method: 'GET',
      url: `/channels/search?${query}`,
    });
  }

  it('returns ranked jump-shaped hits with channel identity', async () => {
    const h = await harness();
    const passing = await post(h, h.channelId, 'we mention relay once here');
    const dense = await post(h, h.channelId, 'relay relay relay');
    const reply = await post(h, h.channelId, 'relay follow-up in thread', {
      parentMessageId: passing.id,
    });

    const res = await search(h, 'q=relay');
    expect(res.status).toBe(200);
    expect(res.body.query).toBe('relay');
    expect(res.body.truncated).toBe(false);
    expect(res.body.results.map((hit) => hit.messageId)).toContain(dense.id);
    expect(res.body.results[0]?.messageId).toBe(dense.id);
    // Thread replies are searchable; the hit names its root so the #1308 slice 1
    // deep link can open the thread panel.
    const replyHit = res.body.results.find((hit) => hit.messageId === reply.id);
    expect(replyHit).toMatchObject({
      channelId: h.channelId,
      channelTitle: 'General',
      archived: false,
      threadId: passing.id,
      senderKind: 'human',
    });
    expect(replyHit?.snippet).toContain('relay');
    expect(replyHit?.seq).toBe(reply.seq);
    expect(replyHit?.createdAt).toEqual(expect.any(String));
  });

  it('wraps matched terms in the shared plain-text highlight sentinels', async () => {
    const h = await harness();
    await post(h, h.channelId, 'the migration playbook is ready');
    const res = await search(h, 'q=playbook');
    const snippet = res.body.results[0]?.snippet ?? '';
    expect(snippet).toContain(
      `${CHANNEL_SEARCH_HIGHLIGHT_OPEN}playbook${CHANNEL_SEARCH_HIGHLIGHT_CLOSE}`
    );
    // No markup crosses the wire — the client renders its own emphasis.
    expect(snippet).not.toContain('<');
    expect(
      parseChannelSearchSnippet(snippet).filter((segment) => segment.highlight)
    ).toEqual([{ text: 'playbook', highlight: true }]);
  });

  it('hides archived channels unless includeArchived is set', async () => {
    const h = await harness();
    const archivedTopic = h.topicStore.create({
      workspaceId: 'ws',
      title: 'Old Incident',
    });
    await post(h, h.channelId, 'quarantine notes live here');
    const buried = await post(
      h,
      archivedTopic.id,
      'quarantine notes archived here'
    );
    h.topicStore.archive(archivedTopic.id);

    const hidden = await search(h, 'q=quarantine');
    expect(hidden.body.results.map((hit) => hit.channelId)).toEqual([
      h.channelId,
    ]);

    const shown = await search(h, 'q=quarantine&includeArchived=true');
    const archivedHit = shown.body.results.find(
      (hit) => hit.messageId === buried.id
    );
    expect(archivedHit).toMatchObject({
      channelId: archivedTopic.id,
      channelTitle: 'Old Incident',
      archived: true,
    });
  });

  it('excludes detail cards, system rows and tombstones; re-indexes an edit', async () => {
    const h = await harness();
    const prose = await post(h, h.channelId, 'rollback checklist step one');
    const doomed = await post(h, h.channelId, 'rollback checklist step two');
    h.store.appendComplete({
      channelId: h.channelId,
      kind: 'system',
      sender: { kind: 'system', id: 'system' },
      text: 'rollback checklist system notice',
    });
    const detail = h.store.beginStream({
      channelId: h.channelId,
      sender: { kind: 'agent', id: 'agent:claude', providerId: 'claude' },
      source: { runtimeId: 'runtime-1', turnId: 'turn-1', itemId: 'item-1' },
      agentDetail: {
        itemId: 'item-1',
        card: {
          kind: 'thought',
          title: 'rollback checklist card',
          status: 'running',
          content: 'rollback checklist payload',
        },
      },
    });
    h.store.finalizeStream(detail.id, { text: '', status: 'complete' });

    expect(
      (await search(h, 'q=rollback')).body.results.map((hit) => hit.messageId)
    ).toEqual(expect.arrayContaining([prose.id, doomed.id]));
    expect((await search(h, 'q=rollback')).body.results).toHaveLength(2);

    const messageUrl = `/channels/${encodeURIComponent(h.channelId)}/messages/${encodeURIComponent(doomed.id)}`;
    expect(
      (await req({ port: h.port, method: 'DELETE', url: messageUrl })).status
    ).toBe(200);
    expect(
      (await search(h, 'q=rollback')).body.results.map((hit) => hit.messageId)
    ).toEqual([prose.id]);

    expect(
      (
        await req({
          port: h.port,
          method: 'PATCH',
          url: `/channels/${encodeURIComponent(h.channelId)}/messages/${encodeURIComponent(prose.id)}`,
          body: { text: 'rollforward checklist step one' },
        })
      ).status
    ).toBe(200);
    expect((await search(h, 'q=rollback')).body.results).toHaveLength(0);
    expect(
      (await search(h, 'q=rollforward')).body.results.map(
        (hit) => hit.messageId
      )
    ).toEqual([prose.id]);
  });

  it('scopes by channel, caps the page, and reports an empty query', async () => {
    const h = await harness();
    const other = h.topicStore.create({ workspaceId: 'ws', title: 'Other' });
    await post(h, h.channelId, 'shared telemetry note');
    const elsewhere = await post(h, other.id, 'shared telemetry note');

    expect(
      (
        await search(h, `q=telemetry&channelId=${encodeURIComponent(other.id)}`)
      ).body.results.map((hit) => hit.messageId)
    ).toEqual([elsewhere.id]);

    const capped = await search(h, 'q=telemetry&limit=1');
    expect(capped.body.results).toHaveLength(1);
    expect(capped.body.truncated).toBe(true);

    const empty = await search(h, 'q=%20%20');
    expect(empty.status).toBe(200);
    expect(empty.body.results).toEqual([]);
    expect(empty.body.unavailableReason).toBe('empty_query');
  });

  it('names a refused query instead of reporting it as a miss', async () => {
    const h = await harness();
    await post(h, h.channelId, 'a note the index would happily match');

    // Text arrived, but nothing tokenizable: the index was never read, so the
    // client must not print "no matches for ***".
    const unsearchable = await search(h, 'q=***');
    expect(unsearchable.status).toBe(200);
    expect(unsearchable.body.results).toEqual([]);
    expect(unsearchable.body.unavailableReason).toBe('no_searchable_term');

    // Below the minimum searchable length the server refuses too — the UI gate
    // is a courtesy, this route is reachable by any capability holder.
    for (const short of ['q=a', 'q=ab']) {
      const refused = await search(h, short);
      expect(refused.body.results).toEqual([]);
      expect(refused.body.unavailableReason).toBe('query_too_short');
    }

    // A dispatched query that genuinely misses carries NO reason, which is how
    // the client tells "searched and found nothing" from "never searched".
    const miss = await search(h, 'q=zzzznotpresent');
    expect(miss.body.results).toEqual([]);
    expect(miss.body.unavailableReason).toBeUndefined();
  });

  it('answers a cost refusal with 200 and a reason, not an error status (#1316)', async () => {
    const h = await harness();
    // Seeded through the store, not the route: this needs one distinct term per
    // row under a shared prefix to reproduce the expansion #1316 measured, and
    // 1032 HTTP round trips would buy nothing the store call does not.
    for (let i = 0; i < CHANNEL_SEARCH_PREFIX_TERM_BUDGET + 8; i += 1) {
      h.store.appendComplete({
        channelId: h.channelId,
        sender: { kind: 'human', id: 'human:operator' },
        text: `broadcast zzq${i.toString(36)} payload`,
      });
    }
    const broad = await search(h, 'q=zzq');
    // 200, not 4xx/5xx: the request was well formed and the corpus is fine —
    // what failed is affordability, which the client answers by narrowing.
    expect(broad.status).toBe(200);
    expect(broad.body.results).toEqual([]);
    expect(broad.body.truncated).toBe(false);
    expect(broad.body.unavailableReason).toBe('search_query_too_broad');
    // Same store, same request shape: an ordinary query is untouched by the
    // gate and still reports NO reason, so an empty result stays meaningful.
    const ordinary = await search(h, 'q=broadcast');
    expect(ordinary.status).toBe(200);
    expect(ordinary.body.results.length).toBeGreaterThan(0);
    expect(ordinary.body.unavailableReason).toBeUndefined();
  });

  it('answers search_timeout when a read outruns its wall-clock ceiling (#1316)', async () => {
    const timed = await harness({ searchTimeBudgetMs: 0 });
    await post(timed, timed.channelId, 'the deployment pipeline is wedged');
    const res = await search(timed, 'q=deployment');
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
    expect(res.body.truncated).toBe(false);
    expect(res.body.unavailableReason).toBe('search_timeout');
  });

  it('reaches channels the rail read model would have cut off', async () => {
    // `topicStore.list()` caps at 200 rows by `updated_at DESC`; the store keeps
    // up to 500. Building the search allowlist from that read model made every
    // message in an older channel unreachable — indexed, matching, and never
    // returned, with no truncation signal.
    let tick = 0;
    const h = await harness({
      topicClock: () =>
        new Date(Date.UTC(2026, 0, 1) + tick++ * 60_000).toISOString(),
    });
    const buried = await post(h, h.channelId, 'buried needle in an old chat');
    for (let i = 0; i < 220; i += 1) {
      h.topicStore.create({ workspaceId: 'ws', title: `Filler ${i}` });
    }
    expect(h.topicStore.list({ includeArchived: true })).toHaveLength(200);
    expect(
      h.topicStore
        .list({ includeArchived: true })
        .some((topic) => topic.id === h.channelId)
    ).toBe(false);

    const res = await search(h, 'q=needle');
    expect(res.status).toBe(200);
    expect(res.body.results.map((hit) => hit.messageId)).toEqual([buried.id]);
    expect(res.body.results[0]?.channelTitle).toBe('General');
  });

  it('lets workspace scoping narrow the answer, never the reach', async () => {
    let tick = 0;
    const h = await harness({
      topicClock: () =>
        new Date(Date.UTC(2026, 0, 1) + tick++ * 60_000).toISOString(),
    });
    const scoped = await post(
      h,
      h.channelId,
      'scoped needle for one workspace'
    );
    // 220 newer channels in ANOTHER workspace. Scoping applied after a global
    // 200-row window would leave nothing of `ws` to search at all.
    for (let i = 0; i < 220; i += 1) {
      h.topicStore.create({ workspaceId: 'ws-other', title: `Other ${i}` });
    }
    const res = await search(h, 'q=needle&workspaceId=ws');
    expect(res.body.results.map((hit) => hit.messageId)).toEqual([scoped.id]);

    // The scope still excludes: a hit in the other workspace stays out.
    const elsewhere = h.topicStore.create({
      workspaceId: 'ws-other',
      title: 'Loud',
    });
    await post(h, elsewhere.id, 'needle somewhere else entirely');
    expect(
      (await search(h, 'q=needle&workspaceId=ws')).body.results.map(
        (hit) => hit.messageId
      )
    ).toEqual([scoped.id]);
    expect(
      (await search(h, 'q=needle')).body.results.map((hit) => hit.messageId)
    ).toHaveLength(2);
  });

  it('resolves exact human project, channel, and repo aliases without widening', async () => {
    const iaStore = {
      listWorkspaces: () => [
        { id: 'ws', name: 'Relay Project' },
        { id: 'ws-other', name: 'Other Project' },
      ],
    } as unknown as Pick<IaStore, 'listWorkspaces'>;
    const h = await harness({ iaStore });
    const releaseNotes = h.topicStore.create({
      workspaceId: 'ws',
      title: 'Release Notes',
      routingDefaults: { repoPath: '/projects/relay-ide' },
    });
    const elsewhere = h.topicStore.create({
      workspaceId: 'ws-other',
      title: 'Elsewhere',
    });
    const generalHit = await post(h, h.channelId, 'needle in general');
    const releaseHit = await post(
      h,
      releaseNotes.id,
      'needle in release notes'
    );
    await post(h, elsewhere.id, 'needle in another project');

    const project = await search(
      h,
      `q=${encodeURIComponent('needle in:"relay project"')}`
    );
    expect(project.body.results.map((hit) => hit.messageId).sort()).toEqual(
      [generalHit.id, releaseHit.id].sort()
    );

    const channel = await search(
      h,
      `q=${encodeURIComponent('needle in:"RELEASE NOTES"')}`
    );
    expect(channel.body.results.map((hit) => hit.messageId)).toEqual([
      releaseHit.id,
    ]);

    const repo = await search(
      h,
      `q=${encodeURIComponent('needle in:RELAY-IDE')}`
    );
    expect(repo.body.results.map((hit) => hit.messageId)).toEqual([
      releaseHit.id,
    ]);

    const nested = await search(
      h,
      `q=${encodeURIComponent('needle in:"relay project" in:"release notes"')}`
    );
    expect(nested.body).toMatchObject({
      results: [expect.objectContaining({ messageId: releaseHit.id })],
      truncated: false,
    });

    // Repeated valid aliases intersect. Disjoint scopes are a successful,
    // explicitly empty search rather than a union or an authorization hint.
    const disjoint = await search(
      h,
      `q=${encodeURIComponent('needle in:"relay project" in:elsewhere')}`
    );
    expect(disjoint.body).toEqual({
      query: 'needle in:"relay project" in:elsewhere',
      results: [],
      truncated: false,
    });

    // Explicit scope parameters are still an outer narrowing boundary. A valid
    // alias cannot reach around `channelId` and find a different transcript.
    const constrained = await search(
      h,
      `q=${encodeURIComponent('needle in:"release notes"')}&channelId=${encodeURIComponent(h.channelId)}`
    );
    expect(constrained.body).toMatchObject({
      results: [],
      unavailableReason: 'scope_not_found',
      scopeAlias: 'release notes',
    });
  });

  it('answers unknown, ambiguous, and malformed aliases explicitly without broadening', async () => {
    const h = await harness();
    const first = h.topicStore.create({
      workspaceId: 'ws',
      title: 'Operations',
    });
    const second = h.topicStore.create({
      workspaceId: 'ws',
      title: 'Operations',
    });
    await post(h, h.channelId, 'needle in general');
    await post(h, first.id, 'needle in first operations');
    await post(h, second.id, 'needle in second operations');

    const unknown = await search(
      h,
      `q=${encodeURIComponent('needle in:missing')}`
    );
    expect(unknown.body).toMatchObject({
      results: [],
      unavailableReason: 'scope_not_found',
      scopeAlias: 'missing',
    });

    const ambiguous = await search(
      h,
      `q=${encodeURIComponent('needle in:operations')}`
    );
    expect(ambiguous.body).toMatchObject({
      results: [],
      unavailableReason: 'scope_ambiguous',
      scopeAlias: 'operations',
    });

    const malformed = await search(h, `q=${encodeURIComponent('needle in:')}`);
    expect(malformed.body).toMatchObject({
      results: [],
      unavailableReason: 'scope_invalid',
      scopeAlias: '',
    });
  });

  it('requires context:read and is reachable only past the auth gate', async () => {
    const h = await harness({ withAuth: true });
    const unauthenticated = await fetch(
      `http://127.0.0.1:${h.port}/channels/search?q=anything`,
      { headers: { 'x-relay-capabilities': 'context:read' } }
    );
    expect(unauthenticated.status).toBe(401);

    const forbidden = await req<{ error: { code: string } }>({
      port: h.port,
      method: 'GET',
      url: '/channels/search?q=anything',
      capabilities: '',
      headers: { Authorization: 'Bearer test' },
    });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe('FORBIDDEN');
  });

  it('still reports truncation on a full default page', async () => {
    const h = await harness();
    for (let i = 0; i < CHANNEL_SEARCH_MAX_RESULTS + 5; i += 1) {
      h.store.appendComplete({
        channelId: h.channelId,
        sender: { kind: 'human', id: 'human:operator' },
        text: `saturation row ${i}`,
      });
    }
    const res = await search(h, 'q=saturation');
    expect(res.body.results).toHaveLength(CHANNEL_SEARCH_MAX_RESULTS);
    // A page that is exactly full must not silently claim it was the whole set.
    expect(res.body.truncated).toBe(true);
  });
});

describe('channel routes — operator read state (#1308 slice 3 item 1)', () => {
  type ReadStateBody = {
    channels: Array<{
      channelId: string;
      lastReadSeq: number;
      updatedAt: string;
    }>;
  };
  type UpdateBody = {
    readState: { channelId: string; lastReadSeq: number; updatedAt: string };
    error?: { code: string; details?: Record<string, unknown> };
  };

  async function put(
    h: Harness,
    channelId: string,
    body: unknown,
    headers?: Record<string, string>
  ) {
    return req<UpdateBody>({
      port: h.port,
      method: 'PUT',
      url: `/channels/${encodeURIComponent(channelId)}/read-state`,
      body,
      ...(headers ? { headers } : {}),
    });
  }

  it('seeds every marked channel in one GET and advances a mark through PUT', async () => {
    const h = await harness();
    const second = h.topicStore.create({ workspaceId: 'ws', title: 'Second' });
    for (let i = 0; i < 3; i += 1) {
      await req({
        port: h.port,
        method: 'POST',
        url: `/channels/${h.channelId}/messages`,
        body: { text: `m${i}` },
      });
    }
    await req({
      port: h.port,
      method: 'POST',
      url: `/channels/${second.id}/messages`,
      body: { text: 'other' },
    });

    // Nothing marked yet: the response is a well-formed empty seed, not a 404.
    const empty = await req<ReadStateBody>({
      port: h.port,
      method: 'GET',
      url: '/channels/read-state',
    });
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ channels: [] });

    const marked = await put(h, h.channelId, { lastReadSeq: 2 });
    expect(marked.status).toBe(200);
    expect(marked.body.readState).toMatchObject({
      channelId: h.channelId,
      lastReadSeq: 2,
    });
    await put(h, second.id, { lastReadSeq: 1 });

    // One call carries the whole map — a boot seed must not cost N round trips.
    const seed = await req<ReadStateBody>({
      port: h.port,
      method: 'GET',
      url: '/channels/read-state',
    });
    expect(seed.status).toBe(200);
    expect(
      seed.body.channels.map((row) => [row.channelId, row.lastReadSeq])
    ).toEqual(
      expect.arrayContaining([
        [h.channelId, 2],
        [second.id, 1],
      ])
    );
    expect(seed.body.channels).toHaveLength(2);
    for (const row of seed.body.channels) {
      expect(typeof row.updatedAt).toBe('string');
    }
  });

  it('is a no-op for a seq below the stored mark and broadcasts only real advances', async () => {
    const h = await harness();
    for (let i = 0; i < 5; i += 1) {
      await req({
        port: h.port,
        method: 'POST',
        url: `/channels/${h.channelId}/messages`,
        body: { text: `m${i}` },
      });
    }
    const before = h.broadcasts.length;

    const desktop = await put(h, h.channelId, { lastReadSeq: 5 });
    expect(desktop.body.readState.lastReadSeq).toBe(5);
    // Cross-device convergence rides the existing global lane.
    expect(h.broadcasts.slice(before)).toEqual([
      {
        type: 'channel-read-state',
        data: { channelId: h.channelId, lastReadSeq: 5 },
      },
    ]);

    // A phone that woke up on seq 2 must not drag the desktop's mark back.
    const stale = await put(h, h.channelId, { lastReadSeq: 2 });
    expect(stale.status).toBe(200);
    expect(stale.body.readState.lastReadSeq).toBe(5);
    // No advance, no broadcast: the lane is unfiltered fan-out to every tab.
    expect(h.broadcasts.slice(before)).toHaveLength(1);

    const seed = await req<ReadStateBody>({
      port: h.port,
      method: 'GET',
      url: '/channels/read-state',
    });
    expect(seed.body.channels).toEqual([
      {
        channelId: h.channelId,
        lastReadSeq: 5,
        updatedAt: desktop.body.readState.updatedAt,
      },
    ]);

    // An idempotent replay of the current mark is accepted and stays quiet.
    await put(h, h.channelId, { lastReadSeq: 5 });
    expect(h.broadcasts.slice(before)).toHaveLength(1);
  });

  it('rejects a malformed seq and an unknown channel', async () => {
    const h = await harness();
    await req({
      port: h.port,
      method: 'POST',
      url: `/channels/${h.channelId}/messages`,
      body: { text: 'hello' },
    });
    for (const bad of [-1, 1.5, '3', null, undefined]) {
      const res = await put(h, h.channelId, { lastReadSeq: bad });
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe('INVALID_ARGUMENT');
      expect(res.body.error?.details?.['reasonCode']).toBe(
        'CHANNEL_READ_SEQ_INVALID'
      );
    }
    const missing = await put(h, 'topic:nope', { lastReadSeq: 1 });
    expect(missing.status).toBe(404);
    expect(h.broadcasts).toHaveLength(0);
  });

  it('refuses an agent credential on both halves — this is operator device sync, not read receipts', async () => {
    const h = await harness();
    await req({
      port: h.port,
      method: 'POST',
      url: `/channels/${h.channelId}/messages`,
      body: { text: 'hello' },
    });
    const agent = { 'x-test-actor-id': 'claude' };

    const read = await req<UpdateBody>({
      port: h.port,
      method: 'GET',
      url: '/channels/read-state',
      headers: agent,
    });
    expect(read.status).toBe(403);
    expect(read.body.error?.details?.['reasonCode']).toBe(
      'CHANNEL_READ_STATE_HUMAN_ONLY'
    );

    const write = await put(h, h.channelId, { lastReadSeq: 1 }, agent);
    expect(write.status).toBe(403);
    expect(write.body.error?.details?.['reasonCode']).toBe(
      'CHANNEL_READ_STATE_HUMAN_ONLY'
    );
    expect(h.store.listReadState()).toEqual([]);
    expect(h.broadcasts).toHaveLength(0);

    // The gate runs before the channel lookup, so an agent cannot use the
    // 404-vs-403 split to probe which channel ids exist on a route it is not
    // allowed to observe at all.
    const probe = await put(h, 'topic:nope', { lastReadSeq: 1 }, agent);
    expect(probe.status).toBe(403);
    expect(probe.body.error?.details?.['reasonCode']).toBe(
      'CHANNEL_READ_STATE_HUMAN_ONLY'
    );
  });

  it('enforces capabilities and the shared auth lane, and routes read-state above /channels/:id', async () => {
    const h = await harness({ withAuth: true });
    const authorized = { authorization: 'Bearer test' };
    await req({
      port: h.port,
      method: 'POST',
      url: `/channels/${h.channelId}/messages`,
      body: { text: 'hello' },
      headers: authorized,
    });

    const unauthenticated = await fetch(
      `http://127.0.0.1:${h.port}/channels/read-state`
    );
    expect(unauthenticated.status).toBe(401);

    const noCapability = await req<UpdateBody>({
      port: h.port,
      method: 'GET',
      url: '/channels/read-state',
      capabilities: '',
      headers: authorized,
    });
    expect(noCapability.status).toBe(403);
    expect(noCapability.body.error?.code).toBe('FORBIDDEN');

    const ok = await req<ReadStateBody>({
      port: h.port,
      method: 'GET',
      url: '/channels/read-state',
      headers: authorized,
    });
    // The discriminating assertion for registration order: `read-state` is a
    // literal segment that `/channels/:id` would otherwise swallow, and that
    // route answers 404 NOT_FOUND for it (no topic has that id) rather than a
    // read-state map.
    expect(ok.status).toBe(200);
    expect(ok.body.channels).toEqual([]);
  });

  it('marks an archived channel read — archive browse is a legitimate read surface', async () => {
    const h = await harness();
    await req({
      port: h.port,
      method: 'POST',
      url: `/channels/${h.channelId}/messages`,
      body: { text: 'hello' },
    });
    h.topicStore.archive(h.channelId);
    const res = await put(h, h.channelId, { lastReadSeq: 1 });
    expect(res.status).toBe(200);
    expect(res.body.readState.lastReadSeq).toBe(1);
  });

  it('503s both halves when the store is unavailable', async () => {
    const h = await harness({ withStore: false });
    const read = await req<UpdateBody>({
      port: h.port,
      method: 'GET',
      url: '/channels/read-state',
    });
    expect(read.status).toBe(503);
    const write = await put(h, h.channelId, { lastReadSeq: 1 });
    expect(write.status).toBe(503);
  });
});

describe('channel routes — hub-authoritative membership (#1455 slice 1)', () => {
  /** Scope is satisfied on every request below; membership is the variable. */
  const scoped = (channelId: string, capability: string) => ({
    'x-test-actor-id': 'claude',
    'x-test-actor-scope': JSON.stringify({ channelIds: [channelId] }),
    'x-relay-capabilities': capability,
  });

  it('rejects a scoped non-member on every gated channel verb', async () => {
    const h = await harness();
    const read = scoped(h.channelId, 'context:read');
    const write = scoped(h.channelId, 'context:write');
    const id = encodeURIComponent(h.channelId);
    const cases: Array<[string, () => Promise<{ status: number; body: any }>]> =
      [
        [
          'channels.get',
          () =>
            req({
              port: h.port,
              method: 'GET',
              url: `/channels/${id}`,
              headers: read,
            }),
        ],
        [
          'channels.history',
          () =>
            req({
              port: h.port,
              method: 'GET',
              url: `/channels/${id}/messages`,
              headers: read,
            }),
        ],
        [
          'channels.roster',
          () =>
            req({
              port: h.port,
              method: 'GET',
              url: `/channels/${id}/roster`,
              headers: read,
            }),
        ],
        [
          'channels.threads.history',
          () =>
            req({
              port: h.port,
              method: 'GET',
              url: `/channels/${id}/threads/chm%3Aroot`,
              headers: read,
            }),
        ],
        [
          'channels.search',
          () =>
            req({
              port: h.port,
              method: 'GET',
              url: `/channels/search?q=anything&channelId=${id}`,
              headers: read,
            }),
        ],
        [
          'channels.post',
          () =>
            req({
              port: h.port,
              method: 'POST',
              url: `/channels/${id}/messages`,
              headers: write,
              body: { text: 'let me in' },
            }),
        ],
        [
          'channels.threads.create',
          () =>
            req({
              port: h.port,
              method: 'POST',
              url: `/channels/${id}/threads`,
              headers: write,
              body: { title: 'mine now' },
            }),
        ],
      ];
    for (const [label, run] of cases) {
      const res = await run();
      expect([label, res.status]).toEqual([label, 403]);
      expect([label, res.body.error.details?.reasonCode]).toEqual([
        label,
        'CHANNEL_NOT_MEMBER',
      ]);
    }
    // Nothing the rejected actor asked for left a trace.
    expect(h.store.history(h.channelId)).toHaveLength(0);
  });

  it('admits the same actor once the hub records it as a member', async () => {
    const h = await harness();
    const denied = await req<{ error: { details?: { reasonCode?: string } } }>({
      port: h.port,
      method: 'GET',
      url: `/channels/${encodeURIComponent(h.channelId)}/messages`,
      headers: scoped(h.channelId, 'context:read'),
    });
    expect(denied.status).toBe(403);
    enrollActor(h, 'claude');
    const allowed = await req<{ messages: unknown[] }>({
      port: h.port,
      method: 'GET',
      url: `/channels/${encodeURIComponent(h.channelId)}/messages`,
      headers: scoped(h.channelId, 'context:read'),
    });
    expect(allowed.status).toBe(200);
    const posted = await req<{ message: { sender: { id: string } } }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${encodeURIComponent(h.channelId)}/messages`,
      headers: scoped(h.channelId, 'context:write'),
      body: { text: 'now I belong' },
    });
    expect(posted.status).toBe(201);
    expect(posted.body.message.sender.id).toBe('agent:claude');
  });

  it('never gates the browser lane or the host-local CLI credential', async () => {
    const h = await harness();
    // Browser cookie lane: no actor credential at all, existing authority.
    const browser = await req<{ messages: unknown[] }>({
      port: h.port,
      method: 'GET',
      url: `/channels/${encodeURIComponent(h.channelId)}/messages`,
      headers: { 'x-relay-capabilities': 'context:read' },
    });
    expect(browser.status).toBe(200);
    // #1467: reading the hub's own 0600 config-dir token already requires
    // owning the hub, so it keeps operator authority here as it does for scope.
    const localCli = await req<{ messages: unknown[] }>({
      port: h.port,
      method: 'GET',
      url: `/channels/${encodeURIComponent(h.channelId)}/messages`,
      headers: {
        'x-test-actor-id': 'local-cli',
        'x-test-actor-reason': 'hub-local-cli',
        'x-relay-capabilities': 'context:read',
      },
    });
    expect(localCli.status).toBe(200);
  });

  it('enumerates only the channels the actor belongs to', async () => {
    const h = await harness();
    const b = h.topicStore.create({ workspaceId: 'ws', title: 'Other' }).id;
    enrollActor(h, 'claude'); // member of A only
    const listed = await req<{ channels: Array<{ id: string }> }>({
      port: h.port,
      method: 'GET',
      url: '/channels',
      headers: {
        'x-test-actor-id': 'claude',
        'x-test-actor-scope': JSON.stringify({ channelIds: [h.channelId, b] }),
        'x-relay-capabilities': 'context:read',
      },
    });
    expect(listed.status).toBe(200);
    expect(listed.body.channels.map((channel) => channel.id)).toEqual([
      h.channelId,
    ]);
    // The browser still sees both.
    const browser = await req<{ channels: Array<{ id: string }> }>({
      port: h.port,
      method: 'GET',
      url: '/channels',
      headers: { 'x-relay-capabilities': 'context:read' },
    });
    expect(browser.body.channels.map((channel) => channel.id).sort()).toEqual(
      [h.channelId, b].sort()
    );
  });

  it('keeps a non-member channel out of an unscoped search corpus', async () => {
    const h = await harness();
    const b = h.topicStore.create({ workspaceId: 'ws', title: 'Other' }).id;
    for (const channelId of [h.channelId, b]) {
      h.store.appendComplete({
        channelId,
        sender: { kind: 'human', id: 'human:operator' },
        text: 'shared secret phrase',
      });
    }
    enrollActor(h, 'claude'); // member of A only
    const search = await req<{ results: Array<{ channelId: string }> }>({
      port: h.port,
      method: 'GET',
      url: '/channels/search?q=secret',
      headers: {
        'x-test-actor-id': 'claude',
        'x-test-actor-scope': JSON.stringify({ channelIds: [h.channelId, b] }),
        'x-relay-capabilities': 'context:read',
      },
    });
    expect(search.status).toBe(200);
    expect([
      ...new Set(search.body.results.map((hit) => hit.channelId)),
    ]).toEqual([h.channelId]);
  });

  it('fails closed when the membership store cannot answer', async () => {
    // The route's own 503 answers first for a wholly absent store, so the
    // guard's fail-closed behaviour is proved where it can actually be
    // observed: the subscribe lane, which reaches the check before any store
    // preflight (see channel-subscription-routes.test.ts), and here through
    // the guard's contract — an unanswerable membership question never
    // resolves to "yes".
    const h = await harness({ withStore: false });
    const res = await req<{ error: { code: string } }>({
      port: h.port,
      method: 'GET',
      url: `/channels/${encodeURIComponent(h.channelId)}`,
      headers: scoped(h.channelId, 'context:read'),
    });
    expect(res.status).toBe(503);
  });
});

describe('channel routes — membership verbs (#1455 slice 2)', () => {
  const scoped = (channelId: string, capability: string, actor = 'claude') => ({
    'x-test-actor-id': actor,
    'x-test-actor-scope': JSON.stringify({ channelIds: [channelId] }),
    'x-relay-capabilities': capability,
  });

  type MemberRefBody = {
    kind: string;
    id: string;
    joinedAt: string;
    invitedBy?: string;
  };

  const members = (h: Harness, headers?: Record<string, string>) =>
    req<{
      channelId: string;
      members: MemberRefBody[];
      error: { code: string; details?: Record<string, unknown> };
    }>({
      port: h.port,
      method: 'GET',
      url: `/channels/${encodeURIComponent(h.channelId)}/members`,
      ...(headers ? { headers } : {}),
    });

  const invite = (
    h: Harness,
    body: Record<string, unknown>,
    headers?: Record<string, string>
  ) =>
    req<{
      channelId: string;
      member: MemberRefBody;
      error: { code: string; details?: Record<string, unknown> };
    }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${encodeURIComponent(h.channelId)}/members`,
      body,
      ...(headers ? { headers } : {}),
    });

  const removeMember = (
    h: Harness,
    body: Record<string, unknown>,
    headers?: Record<string, string>
  ) =>
    req<{
      channelId: string;
      removed: MemberRefBody;
      error: { code: string; details?: Record<string, unknown> };
    }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${encodeURIComponent(h.channelId)}/members/remove`,
      body,
      ...(headers ? { headers } : {}),
    });

  it('refuses invite, remove, and members list from a scoped non-member', async () => {
    const h = await harness();
    const read = scoped(h.channelId, 'context:read');
    const write = scoped(h.channelId, 'context:write');
    for (const res of [
      await members(h, read),
      await invite(h, { id: 'agent-profile:codex:default' }, write),
      await removeMember(h, { id: 'agent-profile:codex:default' }, write),
    ]) {
      expect(res.status).toBe(403);
      expect(
        (res.body as { error: { details?: Record<string, unknown> } }).error
          .details?.['reasonCode']
      ).toBe('CHANNEL_NOT_MEMBER');
    }
    // The refused invite admitted nobody.
    expect(h.store.listMembers(h.channelId)).toHaveLength(0);
  });

  it('records the server-derived inviter and ignores a body-supplied one', async () => {
    const h = await harness();
    enrollActor(h, 'claude');
    const write = scoped(h.channelId, 'context:write');
    const invited = await invite(
      h,
      {
        id: 'agent-profile:codex:default',
        // Not a declared input property; a forged inviter must never survive.
        invitedBy: 'human:operator',
      },
      write
    );
    expect(invited.status).toBe(201);
    expect(invited.body.member).toMatchObject({
      kind: 'agent',
      id: 'agent-profile:codex:default',
      invitedBy: 'agent:claude',
    });
    const listed = await members(h, scoped(h.channelId, 'context:read'));
    expect(listed.status).toBe(200);
    expect(
      listed.body.members.map((member) => [member.id, member.invitedBy])
    ).toEqual([
      ['agent:claude', 'human:operator'],
      ['agent-profile:codex:default', 'agent:claude'],
    ]);
  });

  it('produces the same audit row for the invite verb and the mention path', async () => {
    const viaVerb = await harness();
    enrollActor(viaVerb, 'claude');
    const invited = await invite(
      viaVerb,
      { id: 'agent-profile:codex:default' },
      scoped(viaVerb.channelId, 'context:write')
    );
    expect(invited.status).toBe(201);

    // The mention path (`routeOne`) calls the same store verb with the
    // mentioning sender's id — modelled here at the store boundary the binder
    // uses, so the two admissions are compared as durable rows.
    const viaMention = await harness();
    enrollActor(viaMention, 'claude');
    viaMention.store.inviteMember({
      channelId: viaMention.channelId,
      kind: 'agent',
      id: 'agent-profile:codex:default',
      invitedBy: 'agent:claude',
    });

    // `joinedAt` is wall-clock and orders the list, so compare the audit
    // FIELDS on a stable key: what must match is who is in the room and who
    // put them there, not the millisecond either harness happened to run at.
    const audit = (h: Harness) =>
      h.store
        .listMembers(h.channelId)
        .map(({ joinedAt: _joinedAt, ...rest }) => rest)
        .sort((a, b) => a.id.localeCompare(b.id));
    expect(audit(viaVerb)).toEqual(audit(viaMention));
  });

  it('keeps the original inviter when a live member is invited again', async () => {
    const h = await harness();
    enrollActor(h, 'claude');
    enrollActor(h, 'codex');
    const first = await invite(
      h,
      { id: 'agent-profile:hermes:default' },
      scoped(h.channelId, 'context:write')
    );
    expect(first.body.member.invitedBy).toBe('agent:claude');
    const second = await invite(
      h,
      { id: 'agent-profile:hermes:default' },
      scoped(h.channelId, 'context:write', 'codex')
    );
    expect(second.status).toBe(201);
    expect(second.body.member).toMatchObject({
      invitedBy: 'agent:claude',
      joinedAt: first.body.member.joinedAt,
    });
  });

  it('lets an agent remove itself and the members it invited, but no others', async () => {
    const h = await harness();
    enrollActor(h, 'claude');
    enrollActor(h, 'codex');
    const write = scoped(h.channelId, 'context:write');
    expect(
      (await invite(h, { id: 'agent-profile:hermes:default' }, write)).status
    ).toBe(201);

    // Not the inviter, and not itself.
    const refused = await removeMember(
      h,
      { id: 'agent-profile:hermes:default' },
      scoped(h.channelId, 'context:write', 'codex')
    );
    expect(refused.status).toBe(403);
    expect(refused.body.error.details?.['reasonCode']).toBe(
      'CHANNEL_MEMBER_REMOVE_FORBIDDEN'
    );
    expect(refused.body.error.details?.['reason']).toBe('not-the-inviter');

    // The inviter may.
    const removed = await removeMember(
      h,
      { id: 'agent-profile:hermes:default' },
      write
    );
    expect(removed.status).toBe(200);
    expect(removed.body.removed).toMatchObject({
      id: 'agent-profile:hermes:default',
      invitedBy: 'agent:claude',
    });
    expect(
      h.store.isMember(h.channelId, 'agent', 'agent-profile:hermes:default')
    ).toBe(false);

    // Leaving is always allowed, and it takes effect immediately.
    const left = await removeMember(
      h,
      { id: 'agent:codex' },
      {
        ...scoped(h.channelId, 'context:write', 'codex'),
      }
    );
    expect(left.status).toBe(200);
    const afterLeaving = await members(
      h,
      scoped(h.channelId, 'context:read', 'codex')
    );
    expect(afterLeaving.status).toBe(403);
    expect(afterLeaving.body.error?.details?.['reasonCode']).toBe(
      'CHANNEL_NOT_MEMBER'
    );
  });

  it('never lets a delegated actor invite or evict a human', async () => {
    const h = await harness();
    enrollActor(h, 'claude');
    h.store.upsertMember({
      channelId: h.channelId,
      kind: 'human',
      id: 'human:operator',
      invitedBy: 'self',
    });
    const write = scoped(h.channelId, 'context:write');
    const invited = await invite(h, { kind: 'human', id: 'human:sam' }, write);
    expect(invited.status).toBe(403);
    expect(invited.body.error.details?.['reasonCode']).toBe(
      'CHANNEL_INVITE_TARGET_INVALID'
    );
    const evicted = await removeMember(
      h,
      { kind: 'human', id: 'human:operator' },
      write
    );
    expect(evicted.status).toBe(403);
    expect(evicted.body.error.details?.['reason']).toBe('target-not-governed');
    expect(h.store.isMember(h.channelId, 'human', 'human:operator')).toBe(true);
    // A `human:`-namespaced id is also refused as an AGENT target, so a human
    // principal can never be smuggled into the namespace the removal check
    // resolves `invited_by` in.
    for (const smuggledId of ['human:operator', 'agent:human:operator']) {
      const smuggled = await invite(h, { id: smuggledId }, write);
      expect([smuggledId, smuggled.status]).toEqual([smuggledId, 400]);
      expect(smuggled.body.error.details?.['reasonCode']).toBe(
        'CHANNEL_INVITE_TARGET_INVALID'
      );
    }
  });

  it('refuses to remove a participant membership does not govern', async () => {
    const h = await harness();
    // Both reach channels on lanes that are never membership-gated, so evicting
    // either would drop a roster row and revoke nothing. Refused for the
    // OPERATOR too — a control that reports success while changing no access is
    // worse than one that refuses.
    h.store.upsertMember({
      channelId: h.channelId,
      kind: 'human',
      id: 'human:operator',
      invitedBy: CHANNEL_MEMBERSHIP_SELF_INVITER,
    });
    h.store.upsertMember({
      channelId: h.channelId,
      kind: 'agent',
      id: 'agent:local-cli',
      invitedBy: 'creator',
    });
    for (const body of [
      { kind: 'human', id: 'human:operator' },
      { id: 'agent:local-cli' },
      // The SAME participant under its other spelling. A partial fold would
      // govern this one while exempting `agent:local-cli`.
      { id: 'agent-profile:local-cli:default' },
    ]) {
      const res = await removeMember(h, body);
      expect([JSON.stringify(body), res.status]).toEqual([
        JSON.stringify(body),
        403,
      ]);
      expect(res.body.error.details?.['reasonCode']).toBe(
        'CHANNEL_MEMBER_NOT_GOVERNED'
      );
    }
    expect(h.store.isMember(h.channelId, 'agent', 'agent:local-cli')).toBe(
      true
    );
  });

  it('caps how many members one channel can be invited up to', async () => {
    const h = await harness();
    enrollActor(h, 'claude');
    const write = scoped(h.channelId, 'context:write');
    for (let i = h.store.listMembers(h.channelId).length; i < 128; i += 1) {
      const filled = await invite(h, { id: `agent:filler-${i}` }, write);
      expect([i, filled.status]).toEqual([i, 201]);
    }
    const refused = await invite(h, { id: 'agent:one-too-many' }, write);
    expect(refused.status).toBe(400);
    expect(refused.body.error.details?.['reasonCode']).toBe(
      'CHANNEL_MEMBER_LIMIT_REACHED'
    );
    // Re-inviting an existing member is idempotent and never hits the cap...
    expect((await invite(h, { id: 'agent:filler-1' }, write)).status).toBe(201);
    // ...and a removal frees capacity.
    expect(
      (await removeMember(h, { id: 'agent:filler-1' }, write)).status
    ).toBe(200);
    expect((await invite(h, { id: 'agent:one-too-many' }, write)).status).toBe(
      201
    );
  });

  it('gives the browser/operator lane unrestricted membership authority', async () => {
    const h = await harness();
    const invited = await invite(h, { id: 'agent-profile:codex:default' });
    expect(invited.status).toBe(201);
    expect(invited.body.member.invitedBy).toBe('human:operator');
    const humanInvite = await invite(h, { kind: 'human', id: 'human:sam' });
    expect(humanInvite.status).toBe(201);
    const removed = await removeMember(h, {
      id: 'agent-profile:codex:default',
    });
    expect(removed.status).toBe(200);
    expect(h.store.listMembers(h.channelId).map((m) => m.id)).toEqual([
      'human:sam',
    ]);
  });

  it('keeps the host-local CLI credential unaffected by membership', async () => {
    const h = await harness();
    const localOperator = {
      'x-test-actor-id': 'local-cli',
      'x-test-actor-reason': 'hub-local-cli',
      'x-relay-capabilities': 'context:write',
    };
    const invited = await invite(
      h,
      { id: 'agent-profile:codex:default' },
      localOperator
    );
    expect(invited.status).toBe(201);
    // #1467: the host-local credential is the operator, so it invites as an
    // agent sender but is never itself membership-gated or auto-enrolled.
    expect(invited.body.member.invitedBy).toBe('agent:local-cli');
    expect(h.store.isMember(h.channelId, 'agent', 'agent:local-cli')).toBe(
      false
    );
    const listed = await members(h, {
      ...localOperator,
      'x-relay-capabilities': 'context:read',
    });
    expect(listed.status).toBe(200);
    // It may evict a member it did not invite, exactly like the browser lane.
    const removed = await removeMember(
      h,
      { id: 'agent-profile:codex:default' },
      localOperator
    );
    expect(removed.status).toBe(200);
  });

  it('refuses a malformed member id before it reaches the durable table', async () => {
    const h = await harness();
    enrollActor(h, 'claude');
    const write = scoped(h.channelId, 'context:write');
    for (const body of [
      { id: '' },
      { id: 'agent:has space' },
      { id: 'a'.repeat(201) },
      { id: 'agent:codex', kind: 'robot' },
      { id: 42 },
    ]) {
      const res = await invite(h, body, write);
      expect([JSON.stringify(body), res.status]).toEqual([
        JSON.stringify(body),
        400,
      ]);
    }
    expect(h.store.listMembers(h.channelId).map((m) => m.id)).toEqual([
      'agent:claude',
    ]);
  });

  it('keeps the membership verbs off the operator-client lane', () => {
    // Not an authorization judgement made in the route: the verbs are simply
    // absent from the operator-client command list, so a paired client is
    // refused `unsupported_command` before membership is ever consulted.
    for (const command of [
      'channels.members',
      'channels.invite',
      'channels.remove-member',
    ]) {
      expect(
        OPERATOR_CLIENT_CHANNEL_COMMANDS as readonly string[]
      ).not.toContain(command);
    }
  });

  it('never resolves a reserved invited_by marker as the inviter', async () => {
    const h = await harness();
    // An actor whose own id folds onto the `self` marker. Without the reserved
    // -marker rule it would inherit removal rights over every row credited
    // `self` — every participant that wrote its own way in.
    h.store.upsertMember({
      channelId: h.channelId,
      kind: 'agent',
      id: 'agent:self',
      invitedBy: 'human:operator',
    });
    h.store.upsertMember({
      channelId: h.channelId,
      kind: 'agent',
      id: 'agent-profile:codex:default',
      invitedBy: CHANNEL_MEMBERSHIP_SELF_INVITER,
    });
    const refused = await removeMember(
      h,
      { id: 'agent-profile:codex:default' },
      scoped(h.channelId, 'context:write', 'self')
    );
    expect(refused.status).toBe(403);
    expect(refused.body.error.details?.['reason']).toBe('not-the-inviter');
    expect(
      h.store.isMember(h.channelId, 'agent', 'agent-profile:codex:default')
    ).toBe(true);
    // The same id is refused as an invite target, so the collision cannot be
    // created through the verb either.
    const invited = await invite(
      h,
      { id: 'agent-profile:self:default' },
      scoped(h.channelId, 'context:write', 'self')
    );
    expect(invited.status).toBe(400);
    expect(invited.body.error.details?.['reasonCode']).toBe(
      'CHANNEL_INVITE_TARGET_INVALID'
    );
  });

  it('answers 404 for a member id nobody in this channel resolves to', async () => {
    const h = await harness();
    enrollActor(h, 'claude');
    const res = await removeMember(
      h,
      { id: 'agent-profile:codex:default' },
      scoped(h.channelId, 'context:write')
    );
    expect(res.status).toBe(404);
    expect(res.body.error.details?.['reasonCode']).toBe(
      'CHANNEL_MEMBER_NOT_FOUND'
    );
  });

  it('still enforces credential channel scope on every membership verb', async () => {
    const h = await harness();
    enrollActor(h, 'claude');
    const otherScope = {
      'x-test-actor-id': 'claude',
      'x-test-actor-scope': JSON.stringify({ channelIds: ['chan:other'] }),
      'x-relay-capabilities': 'context:write',
    };
    for (const res of [
      await members(h, {
        ...otherScope,
        'x-relay-capabilities': 'context:read',
      }),
      await invite(h, { id: 'agent-profile:codex:default' }, otherScope),
      await removeMember(h, { id: 'agent:claude' }, otherScope),
    ]) {
      expect(res.status).toBe(403);
      expect(
        (res.body as { error: { details?: Record<string, unknown> } }).error
          .details?.['reasonCode']
      ).toBe('CHANNEL_OUT_OF_SCOPE');
    }
  });

  it('404s the membership verbs on a channel that does not exist', async () => {
    const h = await harness();
    const missing = 'topic:absent';
    for (const [method, url, body] of [
      ['GET', `/channels/${missing}/members`, undefined],
      ['POST', `/channels/${missing}/members`, { id: 'agent:codex' }],
      ['POST', `/channels/${missing}/members/remove`, { id: 'agent:codex' }],
    ] as const) {
      const res = await req<{ error: { code: string } }>({
        port: h.port,
        method,
        url,
        ...(body ? { body } : {}),
      });
      expect([url, res.status]).toEqual([url, 404]);
    }
  });
});

describe('channel routes — profile-bound credentials defer scope to membership (#1455 slice 3)', () => {
  /**
   * The durable per-profile credential: the trusted `agent-profile-credential`
   * marker and NO `channelIds`. The whole point of the slice is that its reach
   * is a membership question, so the tests below vary membership only.
   */
  const profileCredential = (capability: string) => ({
    'x-test-actor-id': builtInAgentProfileId('claude'),
    'x-test-actor-reason': 'agent-profile-credential',
    'x-relay-capabilities': capability,
  });

  /** The same shape WITHOUT the marker: an ordinary delegated actor. */
  const unmarked = (capability: string) => ({
    'x-test-actor-id': builtInAgentProfileId('claude'),
    'x-relay-capabilities': capability,
  });

  it('refuses a non-member with CHANNEL_NOT_MEMBER, not a scope error', async () => {
    const h = await harness();
    const id = encodeURIComponent(h.channelId);
    const read = await req<{ error: { details?: { reasonCode?: string } } }>({
      port: h.port,
      method: 'GET',
      url: `/channels/${id}/messages`,
      headers: profileCredential('context:read'),
    });
    expect(read.status).toBe(403);
    // The distinction is the design: scope stopped being the gate, membership
    // became it. A CHANNEL_OUT_OF_SCOPE here would mean the deferral never ran.
    expect(read.body.error.details?.reasonCode).toBe('CHANNEL_NOT_MEMBER');
    const post = await req<{ error: { details?: { reasonCode?: string } } }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${id}/messages`,
      headers: profileCredential('context:write'),
      body: { text: 'let me in' },
    });
    expect(post.status).toBe(403);
    expect(post.body.error.details?.reasonCode).toBe('CHANNEL_NOT_MEMBER');
    expect(h.store.history(h.channelId)).toHaveLength(0);
  });

  it('admits the profile once the hub records it as a member, attributed to the profile', async () => {
    const h = await harness();
    const profileId = builtInAgentProfileId('claude');
    // Enrolled under the BARE profile Actor id, the spelling the bridge and
    // binder write; the credential arrives as `agent:<profileId>`. The
    // membership fold is what makes those one participant.
    h.store.upsertMember({
      channelId: h.channelId,
      kind: 'agent',
      id: profileId,
      invitedBy: 'human:operator',
    });
    const read = await req<{ messages: unknown[] }>({
      port: h.port,
      method: 'GET',
      url: `/channels/${encodeURIComponent(h.channelId)}/messages`,
      headers: profileCredential('context:read'),
    });
    expect(read.status).toBe(200);
    const posted = await req<{ message: { sender: { id: string } } }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${encodeURIComponent(h.channelId)}/messages`,
      headers: profileCredential('context:write'),
      body: { text: 'posting as my profile' },
    });
    expect(posted.status).toBe(201);
    // Server-derived from the credential: the profile's own Actor id.
    expect(posted.body.message.sender.id).toBe(`agent:${profileId}`);
    // And a body that tries to name a sender is refused outright rather than
    // quietly ignored — attribution is not negotiable on this lane either.
    const forged = await req({
      port: h.port,
      method: 'POST',
      url: `/channels/${encodeURIComponent(h.channelId)}/messages`,
      headers: profileCredential('context:write'),
      body: { text: 'as someone else', sender: { id: 'agent:someone' } },
    });
    expect(forged.status).toBe(400);
  });

  it('enumerates memberships instead of being refused for having no channel scope', async () => {
    const h = await harness();
    const other = h.topicStore.create({ workspaceId: 'ws', title: 'Other' }).id;
    h.store.upsertMember({
      channelId: h.channelId,
      kind: 'agent',
      id: builtInAgentProfileId('claude'),
      invitedBy: 'human:operator',
    });
    const listed = await req<{ channels: Array<{ id: string }> }>({
      port: h.port,
      method: 'GET',
      url: '/channels',
      headers: profileCredential('context:read'),
    });
    expect(listed.status).toBe(200);
    expect(listed.body.channels.map((channel) => channel.id)).toEqual([
      h.channelId,
    ]);
    expect(listed.body.channels.map((channel) => channel.id)).not.toContain(
      other
    );
    // The same guard (`denyChannelReadWithoutScope`) fronts an unscoped search,
    // so it is asserted here rather than assumed to follow from the list.
    for (const channelId of [h.channelId, other]) {
      h.store.appendComplete({
        channelId,
        sender: { kind: 'human', id: 'human:operator' },
        text: 'shared secret phrase',
      });
    }
    const search = await req<{ results: Array<{ channelId: string }> }>({
      port: h.port,
      method: 'GET',
      url: '/channels/search?q=secret',
      headers: profileCredential('context:read'),
    });
    expect(search.status).toBe(200);
    expect([
      ...new Set(search.body.results.map((hit) => hit.channelId)),
    ]).toEqual([h.channelId]);
  });

  it('keeps an UNMARKED scope-less credential fail-closed, membership or not', async () => {
    const h = await harness();
    // The regression guard for the whole slice: the deferral is keyed on a
    // marker only the hub can stamp. Without it, a credential naming no
    // channels is still refused at the scope gate even when it IS a member.
    h.store.upsertMember({
      channelId: h.channelId,
      kind: 'agent',
      id: builtInAgentProfileId('claude'),
      invitedBy: 'human:operator',
    });
    const read = await req<{ error: { details?: { reasonCode?: string } } }>({
      port: h.port,
      method: 'GET',
      url: `/channels/${encodeURIComponent(h.channelId)}/messages`,
      headers: unmarked('context:read'),
    });
    expect(read.status).toBe(403);
    expect(read.body.error.details?.reasonCode).toBe('CHANNEL_OUT_OF_SCOPE');
    const listed = await req<{ error: { details?: { reasonCode?: string } } }>({
      port: h.port,
      method: 'GET',
      url: '/channels',
      headers: unmarked('context:read'),
    });
    expect(listed.status).toBe(403);
    expect(listed.body.error.details?.reasonCode).toBe(
      'CHANNEL_SCOPE_REQUIRED'
    );
  });

  it('still narrows a profile credential that DOES name channels', async () => {
    const h = await harness();
    const other = h.topicStore.create({ workspaceId: 'ws', title: 'Other' }).id;
    const profileId = builtInAgentProfileId('claude');
    for (const channelId of [h.channelId, other]) {
      h.store.upsertMember({
        channelId,
        kind: 'agent',
        id: profileId,
        invitedBy: 'human:operator',
      });
    }
    // A profile credential is never minted with channel scope today, but if one
    // ever is, the deferral must switch OFF rather than silently widen it.
    const headers = {
      ...profileCredential('context:read'),
      'x-test-actor-scope': JSON.stringify({ channelIds: [h.channelId] }),
    };
    const allowed = await req({
      port: h.port,
      method: 'GET',
      url: `/channels/${encodeURIComponent(h.channelId)}/messages`,
      headers,
    });
    expect(allowed.status).toBe(200);
    const denied = await req<{ error: { details?: { reasonCode?: string } } }>({
      port: h.port,
      method: 'GET',
      url: `/channels/${encodeURIComponent(other)}/messages`,
      headers,
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error.details?.reasonCode).toBe('CHANNEL_OUT_OF_SCOPE');
  });
});
