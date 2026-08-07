import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import express from 'express';
import type { RequestHandler } from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import {
  attachAuthenticatedCliGatewayActorCredential,
  bearerActorToken,
  classifyCliGatewayCredentialLane,
  cliGatewayActorCommandCapabilities,
  cliGatewayActorFailure,
  createCliGatewayActorRegistry,
  isCliGatewayActorTokenRequest,
  issueCliGatewayActorCredential,
  sendCliGatewayActorFailure,
  validateCliGatewayActorCredential,
  CLI_GATEWAY_ACTOR_READ_COMMANDS,
  CLI_GATEWAY_ACTOR_WRITE_COMMANDS,
  type CliGatewayActorCommand,
} from '../server/cli-gateway-actor-auth.js';
import type {
  ScopedActorCredentialRecord,
  ScopedActorCredentialRegistry,
} from '../shared/scoped-actor-credentials.js';
import {
  createChannelMessageStore,
  type ChannelMessageStore,
} from '../server/channel-message-store.js';
import { builtInAgentProfileId } from '../shared/agent-profile.js';
import { createChannelHub, type ChannelHub } from '../server/channel-hub.js';
import { createChannelChatRouter } from '../server/channel-chat-router.js';
import {
  createChannelAgentBinder,
  type BinderRuntimes,
  type MentionTarget,
} from '../server/channel-agent-binder.js';
import { MockProtocolAdapterV2 } from '../server/protocol-adapters/mock-v2-adapter.js';
import {
  BaseProtocolAdapterV2,
  type AdapterConfig,
  type AdapterStatus,
  type AgentInterruptInputV2,
  type AgentSendMessageInputV2,
  type ProtocolAdapterV2,
} from '../server/protocol-adapter-v2.js';
import type { AgentCapabilitySetV2 } from '../shared/agent-chat-protocol-v2.js';
import {
  createWorkspaceTopicStore,
  type WorkspaceTopicStore,
} from '../server/workspace-topics.js';
import type { ChannelMessage } from '../shared/channel-chat-protocol.js';
import type { ChannelAgentRuntime } from '../server/channel-agent-runtime.js';

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
    reason: 'Codex is not currently available in channels.',
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
      type: 'agent-item-updated-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId: input.turnId,
      item: {
        type: 'assistantMessage',
        id: itemId,
        text: this.reply,
        status: 'completed',
        completedAt: 't',
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

/**
 * Streams a partial reply and then stalls, so a turn is genuinely live when the
 * next HTTP post lands (#1308 slice 4). `interrupt` emits the terminal patch a
 * real cancellation produces, which is what releases the binder's queue.
 */
class StallingAdapter extends BaseProtocolAdapterV2 {
  readonly runtimeOwnership = 'spawned' as const;
  readonly capabilities: AgentCapabilitySetV2 = {
    text: true,
    streaming: true,
    interrupt: true,
  };
  readonly contents: string[] = [];
  readonly interruptCalls: string[] = [];
  private _status: AdapterStatus = 'disconnected';
  private sid = 'stalling';
  private live: string | null = null;
  constructor(readonly agentType: string) {
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
  async respondToApproval(): Promise<void> {}
  async respondToInput(): Promise<void> {}
  async sendMessage(input: AgentSendMessageInputV2): Promise<void> {
    this.contents.push(input.content);
    this.live = input.turnId;
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
      delta: { text: 'thinking…' },
    });
  }
  async interrupt(input: AgentInterruptInputV2): Promise<void> {
    const turnId = input.turnId ?? this.live;
    if (turnId === null || turnId === undefined) return;
    this.interruptCalls.push(turnId);
    this.live = null;
    this.emitPatch({
      type: 'agent-turn-completed-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId,
      status: 'interrupted',
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
): BinderRuntimes {
  const created = new Map<string, ChannelAgentRuntime>();
  const endHandlers = new Set<(id: string) => void>();
  let n = 0;
  return {
    async create(params) {
      const id = `sess-${++n}-${params.providerId}`;
      const adapter = build(params.providerId);
      adapters.push(adapter);
      await adapter.connect({
        cwd: params.cwd,
        port: 0,
        sessionId: id,
        hookToken: 't',
        configDir: params.configDir,
      });
      const runtime = {
        id,
        providerId: params.providerId,
        profileActorId: params.profileActorId,
        status: 'active',
        adapter,
        cwd: params.cwd,
        providerSession: {},
      } as unknown as ChannelAgentRuntime;
      created.set(id, runtime);
      return runtime;
    },
    get(id) {
      return created.get(id);
    },
    async destroy(id) {
      const runtime = created.get(id);
      if (!runtime) return;
      created.delete(id);
      for (const handler of endHandlers) handler(id);
    },
    onRuntimeEnd(handler) {
      endHandlers.add(handler);
      return () => endHandlers.delete(handler);
    },
  };
}

/**
 * The REAL scoped-actor auth composition (bearer token → lane classify →
 * validate → attach), mirroring `requireCliGatewayActorAuth` in server/index.ts.
 * No fabricated credential: the router only sees a credential the registry
 * actually minted and validated.
 */
function realActorAuthDeps(registry: ScopedActorCredentialRegistry): {
  requireReadActorAuth: (command: CliGatewayActorCommand) => RequestHandler;
  requireWriteActorAuth: (command: CliGatewayActorCommand) => RequestHandler;
} {
  const make =
    (expectedCommand: CliGatewayActorCommand): RequestHandler =>
    (req, res, next) => {
      if (!isCliGatewayActorTokenRequest(req)) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED' } });
        return;
      }
      const lane = classifyCliGatewayCredentialLane(req, expectedCommand);
      if (lane !== 'scoped-actor-credential') {
        sendCliGatewayActorFailure(res, cliGatewayActorFailure({ lane }));
        return;
      }
      const channelId =
        typeof req.params['id'] === 'string' ? req.params['id'] : '';
      const validation = validateCliGatewayActorCredential(registry, {
        token: bearerActorToken(req),
        capabilities: cliGatewayActorCommandCapabilities(expectedCommand),
        ...(channelId ? { scope: { channelIds: [channelId] } } : {}),
      });
      if ('reason' in validation) {
        sendCliGatewayActorFailure(
          res,
          cliGatewayActorFailure({
            reason: validation.reason,
            ...(validation.deniedBits
              ? { deniedBits: validation.deniedBits }
              : {}),
          })
        );
        return;
      }
      attachAuthenticatedCliGatewayActorCredential(req, validation.credential);
      next();
    };
  return {
    requireReadActorAuth: (command) => make(command),
    requireWriteActorAuth: (command) => make(command),
  };
}

async function harness(
  build: (agentType: string) => ProtocolAdapterV2 = () =>
    new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
  opts: { actorRegistry?: ScopedActorCredentialRegistry } = {}
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
    runtimes: makeSessions(build, adapters),
    knownProviderIds: ['mock', 'claude', 'codex', 'opencode', 'hermes'],
    mentionTargets: async () => TARGETS,
    port: 0,
    configDir: dir,
  });
  cleanup.push(() => binder.close());
  hub.onMessagePosted((m, mentions, options) =>
    binder.handleMessagePosted(m, mentions, options)
  );

  const app = express();
  app.use(express.json());
  if (!opts.actorRegistry) {
    // Fabricated-credential fast path used by the routing-parity tests.
    app.use((req, _res, next) => {
      const actorId = req.header('x-test-actor-id');
      if (actorId) {
        attachAuthenticatedCliGatewayActorCredential(req, {
          id: 'cred-1',
          actor: { type: 'agent', id: actorId, displayName: actorId },
          capabilities: ['context:read', 'context:write'],
          scope: { channelIds: [topic.id] },
        } as unknown as ScopedActorCredentialRecord);
      }
      next();
    });
  }
  app.use(
    createChannelChatRouter({
      store,
      hub,
      topicStore,
      binder,
      knownProviderIds: ['mock', 'claude', 'codex', 'opencode', 'hermes'],
      ...(opts.actorRegistry ? realActorAuthDeps(opts.actorRegistry) : {}),
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
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
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
        m.sender.id === 'agent-profile:mock:default' &&
        m.status === 'complete' &&
        !m.agentDetail
    );
}

describe('mention routing — end-to-end via the router', () => {
  it('a browser @mock post spawns a channel runtime and streams the reply back', async () => {
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
    expect(reply.sender.id).toBe('agent-profile:mock:default');
    expect(reply.body.text).toBe('Mock v2 response complete.');
    expect(reply.threadId).toBeNull();
    expect(reply.parentMessageId).toBeNull();
    // cursor advanced to the trigger seq
    expect(
      h.store.getBinding(h.channelId, builtInAgentProfileId('mock'))
        ?.providerSession['lastDeliveredSeq']
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
    expect(agentReply(h.store, h.channelId)[0]!.sender.id).toBe(
      'agent-profile:mock:default'
    );
  });

  it('a threaded mention receives only thread context and replies in that thread', async () => {
    const h = await harness(
      (agentType) => new RecordingAdapter(agentType, 'thread ack')
    );
    const url = `/channels/${encodeURIComponent(h.channelId)}/messages`;
    const root = await req<{ message: ChannelMessage }>({
      port: h.port,
      method: 'POST',
      url,
      body: { text: 'root discussion' },
    });
    await req({
      port: h.port,
      method: 'POST',
      url,
      body: { text: 'unrelated top-level update' },
    });
    await req({
      port: h.port,
      method: 'POST',
      url,
      body: { text: 'prior thread detail', threadId: root.body.message.id },
    });
    const trigger = await req<{ message: ChannelMessage }>({
      port: h.port,
      method: 'POST',
      url,
      body: { text: '@mock answer in thread', threadId: root.body.message.id },
    });
    expect(trigger.status).toBe(201);
    expect(trigger.body.message.threadId).toBe(root.body.message.id);

    await waitFor(() => agentReply(h.store, h.channelId).length === 1);
    const adapter = h.adapters()[0] as RecordingAdapter;
    expect(adapter.contents).toHaveLength(1);
    expect(adapter.contents[0]).toContain(
      '[Thread scope — only this thread is shown; its root message is always included]'
    );
    expect(adapter.contents[0]).toContain('root discussion');
    expect(adapter.contents[0]).toContain('prior thread detail');
    expect(adapter.contents[0]).not.toContain('unrelated top-level update');
    const reply = agentReply(h.store, h.channelId)[0]!;
    expect(reply.sender.id).toBe('agent-profile:mock:default');
    expect(reply.body.text).toBe('thread ack');
    expect(reply.threadId).toBe(root.body.message.id);
    expect(reply.parentMessageId).toBe(trigger.body.message.id);

    // Thread delivery must not advance the channel-global cursor. Otherwise a
    // later top-level mention would silently skip intervening channel rows.
    expect(
      h.store.getBinding(h.channelId, builtInAgentProfileId('mock'))
        ?.providerSession['lastDeliveredSeq']
    ).toBeUndefined();
    await req({
      port: h.port,
      method: 'POST',
      url,
      body: { text: '@mock now answer at top level' },
    });
    await waitFor(() => adapter.contents.length === 2);
    expect(adapter.contents[1]).toContain('unrelated top-level update');
    expect(adapter.contents[1]).not.toContain('[Thread scope —');
    await waitFor(() => agentReply(h.store, h.channelId).length === 2);
    expect(agentReply(h.store, h.channelId)[1]!.threadId).toBeNull();
  });

  it('a long thread packet reinserts its root and keeps the newest replies', async () => {
    const h = await harness(
      (agentType) => new RecordingAdapter(agentType, 'long thread ack')
    );
    const url = `/channels/${encodeURIComponent(h.channelId)}/messages`;
    const root = await req<{ message: ChannelMessage }>({
      port: h.port,
      method: 'POST',
      url,
      body: { text: 'load-bearing long-thread root' },
    });
    for (let i = 1; i <= 65; i++) {
      await req({
        port: h.port,
        method: 'POST',
        url,
        body: {
          text: `long-thread reply ${i}`,
          threadId: root.body.message.id,
        },
      });
    }
    await req({
      port: h.port,
      method: 'POST',
      url,
      body: {
        text: '@mock summarize the long thread',
        threadId: root.body.message.id,
      },
    });

    await waitFor(() => h.adapters().length === 1);
    const adapter = h.adapters()[0] as RecordingAdapter;
    await waitFor(() => adapter.contents.length === 1);
    const packet = adapter.contents[0]!;
    expect(packet).toContain('Operator: load-bearing long-thread root');
    expect(packet).toContain('Operator: long-thread reply 51');
    expect(packet).toContain('Operator: long-thread reply 65');
    expect(packet).not.toContain('Operator: long-thread reply 50\n');
    await waitFor(() => agentReply(h.store, h.channelId).length === 1);
    expect(agentReply(h.store, h.channelId)[0]).toMatchObject({
      threadId: root.body.message.id,
    });
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
      roster: Array<{
        id: string;
        providerId: string;
        available: boolean;
        reason: string | null;
      }>;
    }>({
      port: h.port,
      method: 'GET',
      url: `/channels/${encodeURIComponent(h.channelId)}/roster`,
    });
    expect(res.status).toBe(200);
    // #1232 slice 5: roster entries are keyed by profile actor id; the vendor is
    // carried on the explicit providerId field (never derived from id).
    const mock = res.body.roster.find((r) => r.providerId === 'mock')!;
    expect(mock.available).toBe(true);
    const codex = res.body.roster.find((r) => r.providerId === 'codex')!;
    expect(codex.available).toBe(false);
    expect(codex.reason).toContain('not currently available in channels');
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

describe('mention routing — real scoped-actor auth composition (P2 #1180)', () => {
  it('a real minted actor token authenticates, routes @mock, and is braked as an agent sender', async () => {
    // Mint a REAL credential in the registry the auth middleware validates
    // against — no fabricated record, the full bearer→validate→attach path runs.
    const registry = createCliGatewayActorRegistry();
    // Mirrors the shipped mail-loop credential: session:read stamps the read
    // task-ref (giving a non-empty scope), context:write authorizes channels.post.
    const h = await harness(undefined, { actorRegistry: registry });
    const issued = issueCliGatewayActorCredential(registry, {
      actor: { type: 'agent', id: 'orchestrator', displayName: 'orchestrator' },
      capabilities: ['session:read', 'context:read', 'context:write'],
      scope: { channelIds: [h.channelId] },
    });
    const actorHeaders = {
      authorization: `Bearer ${issued.token}`,
      'x-relay-cli-actor-token': 'v1',
      'x-relay-cli-command': 'channels.post',
    };
    const postOnce = (text: string) =>
      req<{ message: ChannelMessage }>({
        port: h.port,
        method: 'POST',
        url: `/channels/${encodeURIComponent(h.channelId)}/messages`,
        body: { text },
        headers: actorHeaders,
      });

    // First post: server-derived agent attribution from the validated credential.
    const first = await postOnce('@mock brief 0');
    expect(first.status).toBe(201);
    expect(first.body.message.sender).toMatchObject({
      kind: 'agent',
      id: 'agent:orchestrator',
    });
    // Routing works through the real auth lane.
    await waitFor(() => agentReply(h.store, h.channelId).length >= 1);
    expect(agentReply(h.store, h.channelId)[0]!.sender.id).toBe(
      'agent-profile:mock:default'
    );

    // Brake accounting: further agent-sender posts count toward the cap. Posting
    // past MAX trips the pause row — a browser (human) sender never would, proving
    // the actor post is accounted as an agent turn end-to-end.
    for (let i = 1; i <= 4; i++) {
      const res = await postOnce(`@mock brief ${i}`);
      expect(res.status).toBe(201);
    }
    await waitFor(() =>
      h.store
        .history(h.channelId, { limit: 200 })
        .some(
          (m) =>
            m.kind === 'system' && m.body.text.includes('Mention chain paused')
        )
    );
    const paused = h.store
      .history(h.channelId, { limit: 200 })
      .filter(
        (m) =>
          m.kind === 'system' && m.body.text.includes('Mention chain paused')
      );
    expect(paused).toHaveLength(1);
  });

  it('rejects a bogus bearer token (no fabricated credential accepted)', async () => {
    const registry = createCliGatewayActorRegistry();
    const h = await harness(undefined, { actorRegistry: registry });
    const res = await req<{ error: { code: string } }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${encodeURIComponent(h.channelId)}/messages`,
      body: { text: '@mock hello' },
      headers: {
        authorization: 'Bearer relay-sac-v1.not-a-real-token',
        'x-relay-cli-actor-token': 'v1',
        'x-relay-cli-command': 'channels.post',
      },
    });
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(res.status).toBeLessThan(404);
    await new Promise((r) => setTimeout(r, 30));
    expect(agentReply(h.store, h.channelId)).toHaveLength(0); // never routed
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

describe('mention routing — edited context (#1308 slice 1 item 3)', () => {
  it('delivers the EDITED body to the next turn and never re-runs the old one', async () => {
    // The whole "agents see the edit" promise reduces to one question: does the
    // packet the adapter receives carry the new text? The binder builds packets
    // from store rows at send time, so this is a property of the real path
    // rather than of the pure builder — assert it end-to-end.
    const h = await harness(
      (agentType) => new RecordingAdapter(agentType, 'ack')
    );
    const url = `/channels/${encodeURIComponent(h.channelId)}/messages`;
    const posted = await req<{ message: ChannelMessage }>({
      port: h.port,
      method: 'POST',
      url,
      body: { text: 'the deploy is at 3pm' },
    });
    expect(posted.status).toBe(201);

    const edited = await req<{ message: ChannelMessage }>({
      port: h.port,
      method: 'PATCH',
      url: `${url}/${encodeURIComponent(posted.body.message.id)}`,
      body: { text: 'the deploy is at 5pm' },
    });
    expect(edited.status).toBe(200);

    // Editing must not re-trigger a past turn: no adapter has been spawned and
    // no agent row exists, even though the edited row is the only one there.
    await new Promise((r) => setTimeout(r, 50));
    expect(h.adapters()).toHaveLength(0);
    expect(agentReply(h.store, h.channelId)).toHaveLength(0);

    await req({
      port: h.port,
      method: 'POST',
      url,
      body: { text: '@mock when is the deploy?' },
    });
    await waitFor(() => agentReply(h.store, h.channelId).length === 1);
    const adapter = h.adapters()[0] as RecordingAdapter;
    expect(adapter.contents).toHaveLength(1);
    expect(adapter.contents[0]).toContain('the deploy is at 5pm');
    expect(adapter.contents[0]).not.toContain('the deploy is at 3pm');
  });

  it('rejects an edit from a scoped actor credential without touching the row', async () => {
    const h = await harness();
    const url = `/channels/${encodeURIComponent(h.channelId)}/messages`;
    const posted = await req<{ message: ChannelMessage }>({
      port: h.port,
      method: 'POST',
      url,
      body: { text: 'operator wrote this' },
    });
    const res = await req<{ error: { details?: Record<string, unknown> } }>({
      port: h.port,
      method: 'PATCH',
      url: `${url}/${encodeURIComponent(posted.body.message.id)}`,
      body: { text: 'an agent wrote this' },
      headers: { 'x-test-actor-id': 'orchestrator' },
    });
    expect(res.status).toBe(403);
    expect(res.body.error.details?.['reasonCode']).toBe(
      'CHANNEL_EDIT_HUMAN_ONLY'
    );
    expect(h.store.getMessage(posted.body.message.id)?.body.text).toBe(
      'operator wrote this'
    );
  });
});

describe('mention routing — deleted context (#1308 slice 1 item 4)', () => {
  it('never delivers a deleted body to a later turn', async () => {
    // The packet-exclusion promise reduces to one question: can a deleted row's
    // text still reach an adapter? The binder builds packets from store rows at
    // send time, so this is a property of the real path, not of the pure builder.
    const h = await harness(
      (agentType) => new RecordingAdapter(agentType, 'ack')
    );
    const url = `/channels/${encodeURIComponent(h.channelId)}/messages`;
    const posted = await req<{ message: ChannelMessage }>({
      port: h.port,
      method: 'POST',
      url,
      body: { text: 'the production password is hunter2' },
    });
    expect(posted.status).toBe(201);

    const removed = await req<{ message: ChannelMessage }>({
      port: h.port,
      method: 'DELETE',
      url: `${url}/${encodeURIComponent(posted.body.message.id)}`,
    });
    expect(removed.status).toBe(200);

    // Deleting must not trigger a turn of its own.
    await new Promise((r) => setTimeout(r, 50));
    expect(h.adapters()).toHaveLength(0);

    await req({
      port: h.port,
      method: 'POST',
      url,
      body: { text: '@mock what did I just say?' },
    });
    await waitFor(() => agentReply(h.store, h.channelId).length === 1);
    const adapter = h.adapters()[0] as RecordingAdapter;
    expect(adapter.contents).toHaveLength(1);
    expect(adapter.contents[0]).not.toContain('hunter2');
    // Dropped entirely, not rendered as an empty message the agent must parse.
    expect(adapter.contents[0]).not.toMatch(/operator: *\n/);
  });

  it('rejects a delete from a scoped actor credential without touching the row', async () => {
    const h = await harness();
    const url = `/channels/${encodeURIComponent(h.channelId)}/messages`;
    const posted = await req<{ message: ChannelMessage }>({
      port: h.port,
      method: 'POST',
      url,
      body: { text: 'operator wrote this' },
    });
    const res = await req<{ error: { details?: Record<string, unknown> } }>({
      port: h.port,
      method: 'DELETE',
      url: `${url}/${encodeURIComponent(posted.body.message.id)}`,
      headers: { 'x-test-actor-id': 'orchestrator' },
    });
    expect(res.status).toBe(403);
    expect(res.body.error.details?.['reasonCode']).toBe(
      'CHANNEL_DELETE_HUMAN_ONLY'
    );
    expect(h.store.getMessage(posted.body.message.id)?.body.text).toBe(
      'operator wrote this'
    );
  });
});

// ── #1308 slice 4: mid-turn steering through the post route ──────────────────

describe('mid-turn steering — end-to-end via the post route', () => {
  it('rejects an unknown steering value without writing a row', async () => {
    const h = await harness();
    const before = h.store.history(h.channelId, { limit: 50 }).length;
    const res = await req<{ error: { details?: Record<string, unknown> } }>({
      port: h.port,
      method: 'POST',
      url: `/channels/${encodeURIComponent(h.channelId)}/messages`,
      body: { text: '@mock hello', steering: 'yolo' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details?.['reasonCode']).toBe(
      'CHANNEL_STEERING_INVALID'
    );
    expect(h.store.history(h.channelId, { limit: 50 })).toHaveLength(before);
  });

  it('queues a plain post behind a live turn and interrupts on steering:"interrupt"', async () => {
    const h = await harness((agentType) => new StallingAdapter(agentType));
    const url = `/channels/${encodeURIComponent(h.channelId)}/messages`;
    await req({
      port: h.port,
      method: 'POST',
      url,
      body: { text: '@mock go' },
    });
    await waitFor(() => h.adapters().length === 1);
    const adapter = h.adapters()[0] as StallingAdapter;
    await waitFor(() => adapter.contents.length === 1);

    // A plain post lands mid-turn: queued, never a second concurrent dispatch.
    await req({
      port: h.port,
      method: 'POST',
      url,
      body: { text: '@mock also this' },
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(adapter.contents).toHaveLength(1);
    expect(adapter.interruptCalls).toHaveLength(0);

    // The explicit steering flag cancels the live turn and sends now.
    const steered = await req<{ message: ChannelMessage }>({
      port: h.port,
      method: 'POST',
      url,
      body: { text: '@mock stop and do this', steering: 'interrupt' },
    });
    expect(steered.status).toBe(201);
    await waitFor(() => adapter.interruptCalls.length === 1);
    await waitFor(() => adapter.contents.length === 2);
    // Both queued posts ride the one next packet (queue coalescing).
    expect(adapter.contents[1]).toContain('@mock also this');
    expect(adapter.contents[1]).toContain('@mock stop and do this');
    // Existing interrupt semantics: the partial row finalizes `interrupted`.
    expect(
      h.store
        .history(h.channelId, { limit: 50 })
        .some((m) => m.sender.kind === 'agent' && m.status === 'interrupted')
    ).toBe(true);
  });
});
