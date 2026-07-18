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
      const validation = validateCliGatewayActorCredential(registry, {
        token: bearerActorToken(req),
        capabilities: cliGatewayActorCommandCapabilities(expectedCommand),
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
  if (!opts.actorRegistry) {
    // Fabricated-credential fast path used by the routing-parity tests.
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

describe('mention routing — real scoped-actor auth composition (P2 #1180)', () => {
  it('a real minted actor token authenticates, routes @mock, and is braked as an agent sender', async () => {
    // Mint a REAL credential in the registry the auth middleware validates
    // against — no fabricated record, the full bearer→validate→attach path runs.
    const registry = createCliGatewayActorRegistry();
    // Mirrors the shipped mail-loop credential: session:read stamps the read
    // task-ref (giving a non-empty scope), context:write authorizes channels.post.
    const issued = issueCliGatewayActorCredential(registry, {
      actor: { type: 'agent', id: 'orchestrator', displayName: 'orchestrator' },
      capabilities: ['session:read', 'context:read', 'context:write'],
    });
    const h = await harness(undefined, { actorRegistry: registry });
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
    expect(agentReply(h.store, h.channelId)[0]!.sender.id).toBe('agent:mock');

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
