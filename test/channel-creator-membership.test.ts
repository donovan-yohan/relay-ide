import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { attachAuthenticatedCliGatewayActorCredential } from '../server/cli-gateway-actor-auth.js';
import type { ScopedActorCredentialRecord } from '../shared/scoped-actor-credentials.js';
import {
  createChannelMessageStore,
  type ChannelMessageStore,
} from '../server/channel-message-store.js';
import { channelParticipantRef } from '../server/channel-chat-router.js';
import {
  createWorkspaceTopicsRouter,
  createWorkspaceTopicStore,
} from '../server/workspace-topics.js';
import { CHANNEL_MEMBERSHIP_CREATOR_INVITER } from '../shared/channel-chat-protocol.js';

/**
 * #1455 slice 2: `channels.create` is an alias for `workspace-topics.create`
 * (#1472), so channel creation lands on the topic router. Without enrolling the
 * creator, an agent could open a channel it is then refused entry to by the
 * slice-1 membership gate.
 *
 * The `onChannelCreated` wiring here mirrors `server/index.ts` exactly, so the
 * assertion covers the contract the hub actually installs.
 */

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()?.();
});

async function harness(): Promise<{
  port: number;
  store: ChannelMessageStore;
}> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-creator-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const topicStore = createWorkspaceTopicStore({
    dbPath: path.join(dir, 'topics.db'),
  });
  cleanup.push(() => topicStore.close());
  const store = createChannelMessageStore(path.join(dir, 'channel-chat.db'));
  cleanup.push(() => store.close());

  const app = express();
  app.use(express.json());
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
    createWorkspaceTopicsRouter({
      store: topicStore,
      onChannelCreated: (req, topic) => {
        const creator = channelParticipantRef(req);
        if (!creator) return;
        store.inviteMember({
          channelId: topic.id,
          kind: creator.kind,
          id: creator.id,
          invitedBy: CHANNEL_MEMBERSHIP_CREATOR_INVITER,
        });
      },
    })
  );
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => server.close());
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  return { port: address.port, store };
}

async function createChannel(
  port: number,
  headers: Record<string, string> = {}
): Promise<{ status: number; id: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/workspace-topics`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-relay-capabilities': 'context:write',
      ...headers,
    },
    body: JSON.stringify({ workspaceId: 'ws', title: 'Ops room' }),
  });
  const body = (await res.json()) as { topic?: { id: string } };
  return { status: res.status, id: body.topic?.id ?? '' };
}

describe('channel creation enrolls its creator (#1455 slice 2)', () => {
  it('admits a scoped actor to the channel it just created', async () => {
    const h = await harness();
    const created = await createChannel(h.port, {
      'x-test-actor-id': 'claude',
    });
    expect(created.status).toBe(201);
    expect(h.store.isMember(created.id, 'agent', 'agent:claude')).toBe(true);
    expect(h.store.listMembers(created.id)).toEqual([
      expect.objectContaining({
        kind: 'agent',
        id: 'agent:claude',
        // `creator` is deliberately distinct from `self`: a creator was never
        // invited by anybody, whereas `self` means a participant that already
        // had reach wrote its own way in.
        invitedBy: 'creator',
      }),
    ]);
  });

  it('admits the human operator on the browser lane', async () => {
    const h = await harness();
    const created = await createChannel(h.port);
    expect(created.status).toBe(201);
    expect(h.store.listMembers(created.id)).toEqual([
      expect.objectContaining({
        kind: 'human',
        id: 'human:operator',
        invitedBy: 'creator',
      }),
    ]);
  });

  it('keeps each creator confined to its own channel', async () => {
    const h = await harness();
    const mine = await createChannel(h.port, { 'x-test-actor-id': 'claude' });
    const theirs = await createChannel(h.port, { 'x-test-actor-id': 'codex' });
    expect(h.store.isMember(theirs.id, 'agent', 'agent:claude')).toBe(false);
    expect(h.store.isMember(mine.id, 'agent', 'agent:codex')).toBe(false);
  });
});
