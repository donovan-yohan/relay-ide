import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createChannelAgentBinder,
  type BinderSessions,
  type MentionTarget,
} from '../server/channel-agent-binder.js';
import { createChannelChatRouter } from '../server/channel-chat-router.js';
import { createChannelHub, type ChannelHub } from '../server/channel-hub.js';
import {
  createChannelMessageStore,
  type ChannelMessageStore,
} from '../server/channel-message-store.js';
import { MockProtocolAdapterV2 } from '../server/protocol-adapters/mock-v2-adapter.js';
import type { ProtocolAdapterV2 } from '../server/protocol-adapter-v2.js';
import type { Session, WebSession } from '../server/types.js';
import {
  createWorkspaceTopicStore,
  type WorkspaceTopicStore,
} from '../server/workspace-topics.js';
import type { ChannelMessage } from '../shared/channel-chat-protocol.js';

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
});

const TARGETS: MentionTarget[] = [
  {
    id: 'mock',
    displayName: 'Mock',
    kind: 'framework',
    available: true,
    reason: null,
  },
];

interface Harness {
  port: number;
  store: ChannelMessageStore;
  topicStore: WorkspaceTopicStore;
  hub: ChannelHub;
  channelId: string;
}

function mockSessions(): BinderSessions {
  const sessions = new Map<string, WebSession>();
  return {
    async createWeb(params) {
      const id = `session-${sessions.size + 1}`;
      const adapter: ProtocolAdapterV2 = new MockProtocolAdapterV2({
        connectMs: 1,
        stepMs: 1,
      });
      await adapter.connect({
        cwd: params.cwd,
        port: 0,
        sessionId: id,
        hookToken: 'thread-e2e',
        configDir: params.configDir,
      });
      const session = {
        id,
        mode: 'web',
        agent: params.agentType,
        adapterV2: adapter,
        cwd: params.cwd,
      } as unknown as WebSession;
      sessions.set(id, session);
      return { session };
    },
    get(id) {
      return sessions.get(id) as unknown as Session | undefined;
    },
    onSessionEnd() {
      return () => {};
    },
  };
}

async function createHarness(): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-thread-e2e-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));

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
  const topic = topicStore.create({
    workspaceId: 'ws-thread-e2e',
    title: 'Thread round trip',
  });

  const binder = createChannelAgentBinder({
    store,
    hub,
    topicStore,
    sessions: mockSessions(),
    knownProviderIds: ['mock'],
    mentionTargets: async () => TARGETS,
    port: 0,
    configDir: dir,
  });
  cleanup.push(() => binder.close());
  hub.onMessagePosted((message, mentions) =>
    binder.handleMessagePosted(message, mentions)
  );

  const app = express();
  app.use(express.json());
  app.use(
    createChannelChatRouter({
      store,
      hub,
      topicStore,
      binder,
      knownProviderIds: ['mock'],
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
    topicStore,
    hub,
    channelId: topic.id,
  };
}

async function post(
  harness: Harness,
  body: { text: string; threadId?: string }
): Promise<{ status: number; message: ChannelMessage }> {
  const response = await fetch(
    `http://127.0.0.1:${harness.port}/channels/${encodeURIComponent(harness.channelId)}/messages`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-relay-capabilities': 'context:write',
      },
      body: JSON.stringify(body),
    }
  );
  const data = (await response.json()) as { message: ChannelMessage };
  return { status: response.status, message: data.message };
}

async function waitFor(condition: () => boolean, timeoutMs = 4_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('waitFor timed out');
}

describe('channel thread mention round trip', () => {
  it('persists the human trigger and mock reply in one thread with a live root count', async () => {
    const harness = await createHarness();
    const root = await post(harness, { text: 'root needing an agent answer' });
    expect(root.status).toBe(201);

    const trigger = await post(harness, {
      text: '@mock answer inside this thread',
      threadId: root.message.id,
    });
    expect(trigger.status).toBe(201);
    expect(trigger.message).toMatchObject({
      threadId: root.message.id,
      parentMessageId: root.message.id,
    });

    await waitFor(() =>
      harness.store
        .history(harness.channelId, { limit: 20 })
        .some(
          (message) =>
            message.sender.id === 'agent:mock' &&
            message.status === 'complete' &&
            !message.agentDetail
        )
    );
    const agentReply = harness.store
      .history(harness.channelId, { limit: 20 })
      .find(
        (message) =>
          message.sender.id === 'agent:mock' &&
          message.status === 'complete' &&
          !message.agentDetail
      );
    expect(agentReply).toMatchObject({
      body: { text: 'Mock v2 response complete.' },
      threadId: root.message.id,
      // `parentMessageId` is the immediate human trigger; `threadId` is the
      // canonical root used by the UI projection and history endpoint.
      parentMessageId: trigger.message.id,
    });

    const thread = harness.store.threadHistory(
      harness.channelId,
      root.message.id,
      { limit: 20 }
    );
    expect(
      thread
        .filter((message) => !message.agentDetail)
        .map((message) => message.id)
    ).toEqual([root.message.id, trigger.message.id, agentReply!.id]);
    expect(thread.filter((message) => message.agentDetail)).toHaveLength(4);
    expect(harness.store.getMessage(root.message.id)?.replyCount).toBe(6);
  });
});
