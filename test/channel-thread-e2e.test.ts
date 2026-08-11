import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createChannelAgentBinder,
  type BinderRuntimes,
  type ChannelAgentBinder,
  type MentionTarget,
} from '../server/channel-agent-binder.js';
import { createChannelChatRouter } from '../server/channel-chat-router.js';
import { createChannelHub, type ChannelHub } from '../server/channel-hub.js';
import {
  createChannelMessageStore,
  type ChannelMessageStore,
} from '../server/channel-message-store.js';
import { MockProtocolAdapterV2 } from '../server/protocol-adapters/mock-v2-adapter.js';
import {
  BaseProtocolAdapterV2,
  type AdapterConfig,
  type AdapterStatus,
  type AgentInterruptInputV2,
  type AgentSendMessageInputV2,
  type ProtocolAdapterV2,
} from '../server/protocol-adapter-v2.js';
import type { ChannelAgentRuntime } from '../server/channel-agent-runtime.js';
import { builtInAgentProfileId } from '../shared/agent-profile.js';
import {
  createWorkspaceTopicStore,
  type WorkspaceTopicStore,
} from '../server/workspace-topics.js';
import {
  parseMentions,
  type ChannelMessage,
} from '../shared/channel-chat-protocol.js';
import type { AgentCapabilitySetV2 } from '../shared/agent-chat-protocol-v2.js';

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

class ThreadRecordingAdapter extends BaseProtocolAdapterV2 {
  readonly runtimeOwnership = 'spawned' as const;
  readonly capabilities: AgentCapabilitySetV2 = { text: true, streaming: true };
  readonly contents: string[] = [];
  private _status: AdapterStatus = 'disconnected';
  private sid = 'thread-recording';
  constructor(
    readonly agentType: string,
    private readonly reply: string
  ) {
    super();
  }
  get status(): AdapterStatus {
    return this._status;
  }
  async connect(config: AdapterConfig): Promise<void> {
    this._status = 'connected';
    this.sid = config.sessionId;
  }
  protected async onDisconnect(): Promise<void> {
    this._status = 'disconnected';
  }
  async reconnect(): Promise<void> {}
  async resumeSession(): Promise<void> {}
  async interrupt(_input: AgentInterruptInputV2): Promise<void> {}
  async respondToApproval(): Promise<void> {}
  async respondToInput(): Promise<void> {}
  async sendMessage(input: AgentSendMessageInputV2): Promise<void> {
    this.contents.push(input.content);
    const itemId = `a-${input.turnId}`;
    this.emitPatch({
      type: 'agent-item-started-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId: input.turnId,
      item: { type: 'assistantMessage', id: itemId, text: '' },
    });
    this.emitPatch({
      type: 'agent-item-delta-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId: input.turnId,
      itemId,
      delta: { text: this.reply },
    });
    this.emitPatch({
      type: 'agent-item-updated-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId: input.turnId,
      item: {
        type: 'assistantMessage',
        id: itemId,
        text: this.reply,
        status: 'completed',
      },
    });
    this.emitPatch({
      type: 'agent-turn-completed-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId: input.turnId,
      status: 'completed',
    });
  }
}

interface Harness {
  port: number;
  store: ChannelMessageStore;
  topicStore: WorkspaceTopicStore;
  hub: ChannelHub;
  channelId: string;
  binder: ChannelAgentBinder;
  adapters: () => ProtocolAdapterV2[];
}

function mockSessions(
  build: (provider: string) => ProtocolAdapterV2 = () =>
    new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
  adapters: ProtocolAdapterV2[] = []
): BinderRuntimes {
  const sessions = new Map<string, ChannelAgentRuntime>();
  const endHandlers = new Set<(id: string) => void>();
  return {
    async create(params) {
      const id = `session-${sessions.size + 1}`;
      const adapter = build(params.providerId);
      adapters.push(adapter);
      await adapter.connect({
        cwd: params.cwd,
        port: 0,
        sessionId: id,
        hookToken: 'thread-e2e',
        configDir: params.configDir,
      });
      const runtime = {
        id,
        providerId: params.providerId,
        profileActorId: params.profileActorId,
        threadId: params.threadId ?? null,
        status: 'active',
        adapter,
        cwd: params.cwd,
        providerSession: {},
      } as unknown as ChannelAgentRuntime;
      sessions.set(id, runtime);
      return runtime;
    },
    get(id) {
      return sessions.get(id);
    },
    async destroy(id) {
      if (!sessions.delete(id)) return;
      for (const handler of endHandlers) handler(id);
    },
    onRuntimeEnd(handler) {
      endHandlers.add(handler);
      return () => endHandlers.delete(handler);
    },
  };
}

async function createHarness(
  opts: {
    build?: (provider: string) => ProtocolAdapterV2;
    targets?: MentionTarget[];
    knownProviderIds?: string[];
  } = {}
): Promise<Harness> {
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

  const adapters: ProtocolAdapterV2[] = [];
  const knownProviderIds = opts.knownProviderIds ?? ['mock'];
  const binder = createChannelAgentBinder({
    store,
    hub,
    topicStore,
    runtimes: mockSessions(opts.build, adapters),
    knownProviderIds,
    mentionTargets: async () => opts.targets ?? TARGETS,
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
      knownProviderIds,
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
    binder,
    adapters: () => adapters,
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
  it('creates, renames, and revisits a durable empty conversation', async () => {
    const harness = await createHarness();
    const create = await fetch(
      `http://127.0.0.1:${harness.port}/channels/${encodeURIComponent(harness.channelId)}/threads`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-relay-capabilities': 'context:write',
        },
        body: JSON.stringify({ title: 'Runtime isolation audit' }),
      }
    );
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      thread: { rootMessageId: string; title: string; replyCount: number };
    };
    expect(created.thread).toMatchObject({
      title: 'Runtime isolation audit',
      replyCount: 0,
    });

    const rename = await fetch(
      `http://127.0.0.1:${harness.port}/channels/${encodeURIComponent(harness.channelId)}/threads/${encodeURIComponent(created.thread.rootMessageId)}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-relay-capabilities': 'context:write',
        },
        body: JSON.stringify({ title: 'Runtime isolation shipped' }),
      }
    );
    expect(rename.status).toBe(200);
    expect((await rename.json()) as { thread: { title: string } }).toEqual({
      thread: expect.objectContaining({ title: 'Runtime isolation shipped' }),
    });
    const history = harness.store.threadHistory(
      harness.channelId,
      created.thread.rootMessageId
    );
    expect(history).toHaveLength(1);
    expect(
      harness.store.getThreadTitle(
        harness.channelId,
        created.thread.rootMessageId
      )
    ).toBe('Runtime isolation shipped');
  });

  it('runs one provider profile in independent concurrent thread runtimes', async () => {
    const harness = await createHarness({
      build: (provider) => new ThreadRecordingAdapter(provider, 'thread ack'),
    });
    const first = await post(harness, { text: 'first root' });
    const second = await post(harness, { text: 'second root' });
    await post(harness, {
      text: '@mock inspect first scope',
      threadId: first.message.id,
    });
    await post(harness, {
      text: '@mock inspect second scope',
      threadId: second.message.id,
    });

    await waitFor(() => harness.adapters().length === 2);
    await waitFor(
      () =>
        harness.store
          .history(harness.channelId, { limit: 30 })
          .filter(
            (message) =>
              message.sender.id === builtInAgentProfileId('mock') &&
              message.status === 'complete'
          ).length === 2
    );
    const profileId = builtInAgentProfileId('mock');
    const firstBinding = harness.store.getBinding(
      harness.channelId,
      profileId,
      first.message.id
    );
    const secondBinding = harness.store.getBinding(
      harness.channelId,
      profileId,
      second.message.id
    );
    expect(firstBinding?.runtimeId).toBeTruthy();
    expect(secondBinding?.runtimeId).toBeTruthy();
    expect(firstBinding?.runtimeId).not.toBe(secondBinding?.runtimeId);
  });

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
            message.sender.id === 'agent-profile:mock:default' &&
            message.status === 'complete' &&
            !message.agentDetail
        )
    );
    const agentReply = harness.store
      .history(harness.channelId, { limit: 20 })
      .find(
        (message) =>
          message.sender.id === 'agent-profile:mock:default' &&
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
    // The four detail cards persist in-thread (with a thread_id) but are not
    // conversational replies — only the human trigger and the mock reply count.
    expect(harness.store.getMessage(root.message.id)?.replyCount).toBe(2);
  });

  it('retains thread scope when a delegated agent receives its typed completion callback', async () => {
    const targets: MentionTarget[] = ['a', 'b'].map((id) => ({
      id,
      displayName: id.toUpperCase(),
      kind: 'framework' as const,
      available: true,
      reason: null,
    }));
    const harness = await createHarness({
      build: (provider) =>
        new ThreadRecordingAdapter(
          provider,
          provider === 'b' ? 'B thread result' : 'A thread follow-up'
        ),
      targets,
      knownProviderIds: ['a', 'b'],
    });
    const root = await post(harness, { text: 'thread callback root' });
    await post(harness, { text: 'unrelated channel update' });
    const text = '@b investigate in this thread';
    const stream = harness.store.beginStream({
      channelId: harness.channelId,
      sender: {
        kind: 'agent',
        id: builtInAgentProfileId('a'),
        providerId: 'a',
        displayName: 'A',
      },
      source: { runtimeId: 'runtime:a', turnId: 'a-thread-b', itemId: 'a-1' },
      parentMessageId: root.message.id,
      mentions: parseMentions(text, ['a', 'b']),
    });
    const delegated = harness.store.finalizeStream(stream.id, {
      text,
      status: 'complete',
    })!;
    harness.binder.handleMessagePosted(delegated, delegated.mentions ?? []);

    await waitFor(() => harness.adapters().length === 2);
    const a = harness
      .adapters()
      .find(
        (adapter) => (adapter as ThreadRecordingAdapter).agentType === 'a'
      ) as ThreadRecordingAdapter;
    await waitFor(() => a.contents.length === 1);
    expect(a.contents[0]).toContain('[Relay internal completion callback]');
    expect(a.contents[0]).toContain(
      '[Thread scope — only this thread is shown; its root message is always included]'
    );
    expect(a.contents[0]).toContain('thread callback root');
    expect(a.contents[0]).not.toContain('unrelated channel update');
    const prose = harness.store
      .history(harness.channelId, { limit: 20 })
      .filter((message) => !message.agentDetail);
    const aFollowUp = prose.find(
      (message) => message.body.text === 'A thread follow-up'
    )!;
    expect(aFollowUp).toMatchObject({
      threadId: root.message.id,
    });
  });
});
