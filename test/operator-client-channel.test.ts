import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import express, { type RequestHandler } from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { createChannelChatRouter } from '../server/channel-chat-router.js';
import { createChannelHub } from '../server/channel-hub.js';
import { createChannelMessageStore } from '../server/channel-message-store.js';
import { createChannelSubscriptionRouter } from '../server/channel-subscription-router.js';
import {
  authenticateOperatorClientCredential,
  issueOperatorClientCredentialWithGrant,
  operatorClientAuthFailure,
} from '../server/operator-client-auth.js';
import { createWorkspaceTopicStore } from '../server/workspace-topics.js';
import {
  OPERATOR_CLIENT_CREDENTIAL_AUDIENCE,
  OperatorClientCredentialRegistry,
} from '../shared/operator-client-credentials.js';
import { HandshakeGrantRegistry } from '../shared/operator-handshake-grants.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
});

async function fixture(): Promise<{
  port: number;
  registry: OperatorClientCredentialRegistry;
  store: ReturnType<typeof createChannelMessageStore>;
  hub: ReturnType<typeof createChannelHub>;
  channelId: string;
  otherChannelId: string;
}> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-operator-client-'));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createChannelMessageStore(path.join(root, 'channels.db'));
  cleanup.push(() => store.close());
  const topics = createWorkspaceTopicStore({
    dbPath: path.join(root, 'topics.db'),
  });
  cleanup.push(() => topics.close());
  const topic = topics.create({ workspaceId: 'workspace', title: 'Operator' });
  const other = topics.create({ workspaceId: 'workspace', title: 'Other' });
  const hub = createChannelHub({
    store,
    channelExists: (channelId) => Boolean(topics.get(channelId)),
  });
  cleanup.push(() => hub.close());
  const registry = new OperatorClientCredentialRegistry({
    secretBytes: () => Buffer.from('0123456789abcdef0123456789abcdef'),
  });

  const authFor =
    (command: string): RequestHandler =>
    (req, res, next) => {
      const result = authenticateOperatorClientCredential(
        registry,
        req,
        command as
          | 'channels.list'
          | 'channels.get'
          | 'channels.history'
          | 'channels.subscribe'
          | 'channels.post',
        typeof req.params['id'] === 'string' ? req.params['id'] : undefined
      );
      if (result.ok) return next();
      const failure = operatorClientAuthFailure(result);
      return res
        .status(failure.code === 'FORBIDDEN' ? 403 : 401)
        .json({ error: failure });
    };
  const app = express();
  app.use(express.json());
  app.use(
    createChannelChatRouter({
      store,
      hub,
      topicStore: topics,
      requireAuth: (_req, res) => res.sendStatus(401),
      requireReadActorAuth: (command) => authFor(command),
      requireWriteActorAuth: (command) => authFor(command),
    })
  );
  app.use(
    createChannelSubscriptionRouter({
      hub,
      requireSubscribeAuth: authFor('channels.subscribe'),
      heartbeatMs: 5,
      isStillAuthorized: (req, channelId) =>
        authenticateOperatorClientCredential(
          registry,
          req,
          'channels.subscribe',
          channelId
        ).ok,
    })
  );
  const server = http.createServer(app);
  cleanup.push(() => server.close());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('server unavailable');
  return {
    port: address.port,
    registry,
    store,
    hub,
    channelId: topic.id,
    otherChannelId: other.id,
  };
}

function headers(token: string, command: string): HeadersInit {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'x-relay-cli-gateway': 'v1',
    'x-relay-operator-client-token': 'v1',
    'x-relay-cli-command': command,
  };
}

function frameReader(
  reader: ReadableStreamDefaultReader<Uint8Array>
): () => Promise<unknown> {
  const decoder = new TextDecoder();
  let buffered = '';
  return async () => {
    while (true) {
      const newline = buffered.indexOf('\n');
      if (newline !== -1) {
        const frame = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (frame) return JSON.parse(frame) as unknown;
        continue;
      }
      const { done, value } = await reader.read();
      if (done) throw new Error('stream closed before frame');
      buffered += decoder.decode(value, { stream: true });
    }
  };
}

async function nextMatchingFrame(
  nextFrame: () => Promise<unknown>,
  predicate: (frame: Record<string, unknown>) => boolean
): Promise<Record<string, unknown>> {
  for (let index = 0; index < 8; index += 1) {
    const frame = await nextFrame();
    if (
      typeof frame === 'object' &&
      frame !== null &&
      !Array.isArray(frame) &&
      predicate(frame as Record<string, unknown>)
    ) {
      return frame as Record<string, unknown>;
    }
  }
  throw new Error('subscription did not emit the expected frame');
}

describe('operator client channel lane', () => {
  it('inherits a grant channel scope omitted by the client and authorizes stable channel commands only within it', async () => {
    const { port, registry, channelId, otherChannelId } = await fixture();
    const grantRegistry = new HandshakeGrantRegistry({
      secretBytes: () => Buffer.from('abcdef0123456789abcdef0123456789'),
    });
    const client = { id: 'desktop-plugin' };
    const requested = grantRegistry.request({
      actor: { type: 'cli', id: client.id },
      issuer: { id: 'browser-operator' },
      audience: OPERATOR_CLIENT_CREDENTIAL_AUDIENCE,
      capabilities: ['context:read', 'context:write'],
      scope: { channelIds: [channelId] },
      ttlMs: 60_000,
    });
    const approved = grantRegistry.approve(requested.id, {
      approvedBy: { id: 'browser-operator' },
    });
    const issued = issueOperatorClientCredentialWithGrant(
      registry,
      grantRegistry,
      {
        grantHandle: approved.handle,
        client,
        capabilities: ['context:read', 'context:write'],
        ttlMs: 60_000,
      }
    );

    expect(issued.credential.scope).toEqual({ channelIds: [channelId] });
    const listed = await fetch(`http://127.0.0.1:${port}/channels`, {
      headers: headers(issued.token, 'channels.list'),
    });
    expect(listed.status).toBe(200);
    expect((await listed.json()).channels).toHaveLength(1);

    const posted = await fetch(
      `http://127.0.0.1:${port}/channels/${encodeURIComponent(channelId)}/messages`,
      {
        method: 'POST',
        headers: headers(issued.token, 'channels.post'),
        body: JSON.stringify({ text: 'grant-backed operator post' }),
      }
    );
    expect(posted.status).toBe(201);

    const history = await fetch(
      `http://127.0.0.1:${port}/channels/${encodeURIComponent(channelId)}/messages`,
      { headers: headers(issued.token, 'channels.history') }
    );
    expect(history.status).toBe(200);

    const siblingPost = await fetch(
      `http://127.0.0.1:${port}/channels/${encodeURIComponent(otherChannelId)}/messages`,
      {
        method: 'POST',
        headers: headers(issued.token, 'channels.post'),
        body: JSON.stringify({ text: 'outside inherited scope' }),
      }
    );
    expect(siblingPost.status).toBe(403);
  });

  it('preserves stable channel schemas, attributes posts to the server-derived human, and rejects sender/source injection', async () => {
    const { port, registry, store, channelId, otherChannelId } =
      await fixture();
    const issued = registry.issue({
      client: { id: 'desktop-plugin' },
      capabilities: ['context:read', 'context:write'],
      scope: { channelIds: [channelId] },
      ttlMs: 60_000,
    });

    const listed = await fetch(`http://127.0.0.1:${port}/channels`, {
      headers: headers(issued.token, 'channels.list'),
    });
    expect(listed.status).toBe(200);
    expect((await listed.json()).channels).toHaveLength(1);

    const posted = await fetch(
      `http://127.0.0.1:${port}/channels/${encodeURIComponent(channelId)}/messages`,
      {
        method: 'POST',
        headers: headers(issued.token, 'channels.post'),
        body: JSON.stringify({
          text: 'human operator post',
          clientMessageId: 'operator-post-1',
        }),
      }
    );
    expect(posted.status).toBe(201);
    expect((await posted.json()).message.sender).toEqual({
      kind: 'human',
      id: 'human:operator',
      displayName: 'Operator',
    });

    store.appendComplete({
      channelId,
      sender: {
        kind: 'agent',
        id: 'agent:provider',
        runtimeId: 'runtime-private',
      },
      source: { runtimeId: 'runtime-private' },
      text: 'provider response',
    });
    const history = await fetch(
      `http://127.0.0.1:${port}/channels/${encodeURIComponent(channelId)}/messages`,
      { headers: headers(issued.token, 'channels.history') }
    );
    expect(history.status).toBe(200);
    expect(JSON.stringify(await history.json())).not.toContain(
      'runtime-private'
    );

    const injected = await fetch(
      `http://127.0.0.1:${port}/channels/${encodeURIComponent(channelId)}/messages`,
      {
        method: 'POST',
        headers: headers(issued.token, 'channels.post'),
        body: JSON.stringify({
          text: 'forged attribution',
          sender: { kind: 'agent', id: 'agent:forged' },
          source: { runtimeId: 'runtime-private' },
        }),
      }
    );
    expect(injected.status).toBe(400);

    const sibling = await fetch(
      `http://127.0.0.1:${port}/channels/${encodeURIComponent(otherChannelId)}`,
      { headers: headers(issued.token, 'channels.get') }
    );
    expect(sibling.status).toBe(403);

    const actorMarker = await fetch(`http://127.0.0.1:${port}/channels`, {
      headers: {
        ...headers(issued.token, 'channels.list'),
        'x-relay-cli-actor-token': 'v1',
      },
    });
    expect(actorMarker.status).toBe(403);

    const tokenSubstitution = await fetch(`http://127.0.0.1:${port}/channels`, {
      headers: headers(
        'relay-sac-v1.actor-token.substitution',
        'channels.list'
      ),
    });
    expect(tokenSubstitution.status).toBe(403);
  });

  it('revalidates a subscription and closes after credential revocation', async () => {
    const { port, registry, store, hub, channelId } = await fixture();
    const issued = registry.issue({
      client: { id: 'desktop-plugin' },
      capabilities: ['context:read'],
      scope: { channelIds: [channelId] },
      ttlMs: 60_000,
    });
    const response = await fetch(
      `http://127.0.0.1:${port}/channels/${encodeURIComponent(channelId)}/subscribe`,
      { headers: headers(issued.token, 'channels.subscribe') }
    );
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('subscription body unavailable');
    const nextFrame = frameReader(reader);
    expect(await nextFrame()).toMatchObject({ frame: 'open' });
    const providerMessage = store.appendComplete({
      channelId,
      sender: {
        kind: 'agent',
        id: 'agent:provider',
        runtimeId: 'runtime-private',
      },
      source: { runtimeId: 'runtime-private' },
      text: 'provider response',
    });
    hub.broadcastCreated(providerMessage);
    const providerFrame = await nextMatchingFrame(
      nextFrame,
      (frame) =>
        frame['frame'] === 'event' &&
        typeof frame['payload'] === 'object' &&
        frame['payload'] !== null &&
        (frame['payload'] as Record<string, unknown>)['type'] ===
          'channel-message-created-v1'
    );
    expect(JSON.stringify(providerFrame)).not.toContain('runtime-private');
    registry.revoke(issued.credential.id, { revokedBy: 'browser-operator' });
    await expect(
      nextMatchingFrame(nextFrame, (frame) => frame['frame'] === 'closed')
    ).resolves.toMatchObject({
      frame: 'closed',
      reason: 'authorization-revoked',
      retryable: false,
    });
  });
});
