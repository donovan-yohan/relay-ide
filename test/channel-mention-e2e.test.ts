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
import { createChannelHub, type ChannelHub } from '../server/channel-hub.js';
import { createChannelChatRouter } from '../server/channel-chat-router.js';
import {
  createChannelAgentBinder,
  type BinderSessions,
  type MentionTarget,
} from '../server/channel-agent-binder.js';
import { MockProtocolAdapterV2 } from '../server/protocol-adapters/mock-v2-adapter.js';
import {
  BaseProtocolAdapterV2,
  type AdapterConfig,
  type AdapterStatus,
  type AgentSendMessageInputV2,
  type ProtocolAdapterV2,
} from '../server/protocol-adapter-v2.js';
import type { AgentCapabilitySetV2 } from '../shared/agent-chat-protocol-v2.js';
import {
  createWorkspaceTopicStore,
  type WorkspaceTopicStore,
} from '../server/workspace-topics.js';
import type { ChannelMessage } from '../shared/channel-chat-protocol.js';
import type { Session, WebSession } from '../server/types.js';

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
  {
    id: 'codex',
    displayName: 'Codex',
    kind: 'framework',
    available: false,
    reason:
      'Codex web sessions do not yet stream chat responses (see issue #301).',
  },
];

/** Adapter that records the content it receives and replies with a fixed line. */
class RecordingAdapter extends BaseProtocolAdapterV2 {
  readonly runtimeOwnership = 'spawned' as const;
  readonly capabilities: AgentCapabilitySetV2 = { text: true, streaming: true };
  readonly contents: string[] = [];
  private _status: AdapterStatus = 'disconnected';
  private sid = 'rec';
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
  async interrupt(): Promise<void> {}
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
  hub: ChannelHub;
  channelId: string;
  adapters: () => ProtocolAdapterV2[];
}

function makeSessions(
  build: (agentType: string) => ProtocolAdapterV2,
  adapters: ProtocolAdapterV2[]
): BinderSessions {
  const created = new Map<string, WebSession>();
  let n = 0;
  return {
    async createWeb(params) {
      const id = `sess-${++n}-${params.agentType}`;
      const adapter = build(params.agentType);
      adapters.push(adapter);
      await adapter.connect({
        cwd: params.cwd,
        port: 0,
        sessionId: id,
        hookToken: 't',
        configDir: params.configDir,
      });
      const session = {
        id,
        mode: 'web',
        agent: params.agentType,
        adapterV2: adapter,
        cwd: params.cwd,
      } as unknown as WebSession;
      created.set(id, session);
      return { session };
    },
    get(id) {
      return created.get(id) as unknown as Session | undefined;
    },
    onSessionEnd() {
      return () => {};
    },
  };
}

async function harness(
  build: (agentType: string) => ProtocolAdapterV2 = () =>
    new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 })
): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-mention-e2e-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const topicStore: WorkspaceTopicStore = createWorkspaceTopicStore({
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

  const adapters: ProtocolAdapterV2[] = [];
  const binder = createChannelAgentBinder({
    store,
    hub,
    topicStore,
    sessions: makeSessions(build, adapters),
    knownProviderIds: ['mock', 'claude', 'codex', 'opencode', 'hermes'],
    mentionTargets: async () => TARGETS,
    port: 0,
    configDir: dir,
  });
  cleanup.push(() => binder.close());
  hub.onMessagePosted((m, mentions) => binder.handleMessagePosted(m, mentions));

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const actorId = req.header('x-test-actor-id');
    if (actorId) {
      attachAuthenticatedCliGatewayActorCredential(req, {
        id: 'cred-1',
        actor: { type: 'agent', id: actorId, displayName: actorId },
        capabilities: ['context:read', 'context:write'],
      } as unknown as ScopedActorCredentialRecord);
    }
    next();
  });
  app.use(
    createChannelChatRouter({
      store,
      hub,
      topicStore,
      binder,
      knownProviderIds: ['mock', 'claude', 'codex', 'opencode', 'hermes'],
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
    hub,
    channelId: topic.id,
    adapters: () => adapters,
  };
}

async function req<T>(input: {
  port: number;
  method: 'GET' | 'POST';
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
}): Promise<{ status: number; body: T }> {
  const res = await fetch(`http://127.0.0.1:${input.port}${input.url}`, {
    method: input.method,
    headers: {
      'Content-Type': 'application/json',
      'x-relay-capabilities':
        input.method === 'GET' ? 'context:read' : 'context:write',
      ...(input.headers ?? {}),
    },
    ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as T };
}

async function waitFor(cond: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitFor timed out');
}

function agentReply(store: ChannelMessageStore, channelId: string) {
  return store
    .history(channelId, { limit: 200 })
    .filter(
      (m: ChannelMessage) =>
        m.sender.id === 'agent:mock' && m.status === 'complete'
    );
}

describe('mention routing — end-to-end via the router', () => {
  it('a browser @mock post spawns a mock web session and streams the reply back', async () => {
    const h = await harness();
    const res = await req<{ message: ChannelMessage }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${encodeURIComponent(h.channelId)}/messages`,
      body: { text: '@mock hello there' },
    });
    expect(res.status).toBe(201);
    expect(res.body.message.sender.kind).toBe('human');
    await waitFor(() => agentReply(h.store, h.channelId).length === 1);
    const reply = agentReply(h.store, h.channelId)[0]!;
    expect(reply.sender.id).toBe('agent:mock');
    expect(reply.body.text).toBe('Mock v2 response complete.');
    // cursor advanced to the trigger seq
    expect(
      h.store.getBinding(h.channelId, 'mock')?.providerSession[
        'lastDeliveredSeq'
      ]
    ).toBe(res.body.message.seq);
  });

  it('a CLI-gateway-actor @mock post routes identically to a browser post', async () => {
    const h = await harness();
    const res = await req<{ message: ChannelMessage }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${encodeURIComponent(h.channelId)}/messages`,
      body: { text: '@mock brief from the orchestrator' },
      headers: { 'x-test-actor-id': 'orchestrator' },
    });
    expect(res.status).toBe(201);
    expect(res.body.message.sender).toMatchObject({
      kind: 'agent',
      id: 'agent:orchestrator',
    });
    await waitFor(() => agentReply(h.store, h.channelId).length === 1);
    expect(agentReply(h.store, h.channelId)[0]!.sender.id).toBe('agent:mock');
  });

  it("the next turn's packet includes interim human rows but not the agent's own reply", async () => {
    const h = await harness(
      (agentType) => new RecordingAdapter(agentType, 'ack')
    );
    // turn 1
    await req({
      port: h.port,
      method: 'POST',
      url: `/channels/${encodeURIComponent(h.channelId)}/messages`,
      body: { text: '@mock first' },
    });
    await waitFor(
      () => (h.adapters()[0] as RecordingAdapter).contents.length === 1
    );
    // an interim human message with no mention
    await req({
      port: h.port,
      method: 'POST',
      url: `/channels/${encodeURIComponent(h.channelId)}/messages`,
      body: { text: 'meanwhile the CI went green' },
    });
    // turn 2
    await req({
      port: h.port,
      method: 'POST',
      url: `/channels/${encodeURIComponent(h.channelId)}/messages`,
      body: { text: '@mock second' },
    });
    await waitFor(
      () => (h.adapters()[0] as RecordingAdapter).contents.length === 2
    );
    const packet2 = (h.adapters()[0] as RecordingAdapter).contents[1]!;
    expect(packet2).toContain('meanwhile the CI went green');
    expect(packet2).not.toContain('ack'); // agent's own prior reply is skipped
    expect(packet2).toContain('@mock second');
  });

  it('the roster verb reports availability + reasons', async () => {
    const h = await harness();
    const res = await req<{
      roster: Array<{ id: string; available: boolean; reason: string | null }>;
    }>({
      port: h.port,
      method: 'GET',
      url: `/channels/${encodeURIComponent(h.channelId)}/roster`,
    });
    expect(res.status).toBe(200);
    const mock = res.body.roster.find((r) => r.id === 'mock')!;
    expect(mock.available).toBe(true);
    const codex = res.body.roster.find((r) => r.id === 'codex')!;
    expect(codex.available).toBe(false);
    expect(codex.reason).toContain('#301');
  });

  it('interrupt returns 409 NO_ACTIVE_TURN when the agent is idle', async () => {
    const h = await harness();
    // bind mock first
    await req({
      port: h.port,
      method: 'POST',
      url: `/channels/${encodeURIComponent(h.channelId)}/messages`,
      body: { text: '@mock hi' },
    });
    await waitFor(() => agentReply(h.store, h.channelId).length === 1);
    const res = await req<{ error: { details?: { reasonCode?: string } } }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${encodeURIComponent(h.channelId)}/agents/mock/interrupt`,
      body: {},
    });
    expect(res.status).toBe(409);
    expect(res.body.error.details?.reasonCode).toBe('NO_ACTIVE_TURN');
  });
});

describe('mention routing — gateway command/capability mapping', () => {
  it('registers the new verbs with the correct capability bits', () => {
    expect(CLI_GATEWAY_ACTOR_READ_COMMANDS).toContain('channels.roster');
    expect(CLI_GATEWAY_ACTOR_WRITE_COMMANDS).toContain('channels.interrupt');
    expect(CLI_GATEWAY_ACTOR_WRITE_COMMANDS).toContain(
      'channels.respond-approval'
    );
    expect(cliGatewayActorCommandCapabilities('channels.roster')).toEqual([
      'context:read',
    ]);
    expect(cliGatewayActorCommandCapabilities('channels.interrupt')).toEqual([
      'context:write',
    ]);
    expect(
      cliGatewayActorCommandCapabilities('channels.respond-approval')
    ).toEqual(['context:write']);
  });
});
