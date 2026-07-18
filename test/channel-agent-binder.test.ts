import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

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
  createChannelMessageStore,
  type ChannelMessageStore,
} from '../server/channel-message-store.js';
import { createChannelHub, type ChannelHub } from '../server/channel-hub.js';
import {
  createChannelAgentBinder,
  MAX_CONSECUTIVE_AGENT_TURNS,
  type BinderSessions,
  type ChannelAgentBinder,
  type MentionTarget,
} from '../server/channel-agent-binder.js';
import type { Session, WebSession } from '../server/types.js';
import type { WorkspaceTopicStore } from '../server/workspace-topics.js';
import {
  parseMentions,
  type ChannelMessage,
  type ChannelSenderRef,
} from '../shared/channel-chat-protocol.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
});

const CH = 'topic:test';
const OPERATOR: ChannelSenderRef = {
  kind: 'human',
  id: 'human:operator',
  displayName: 'operator',
};

function makeStore(): { store: ChannelMessageStore; hub: ChannelHub } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-binder-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createChannelMessageStore(path.join(dir, 'channel-chat.db'));
  cleanup.push(() => store.close());
  const hub = createChannelHub({ store, channelExists: () => true });
  cleanup.push(() => hub.close());
  return { store, hub };
}

async function waitFor(
  cond: () => boolean,
  ms = 4000,
  step = 5
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, step));
  }
  throw new Error('waitFor timed out');
}

function rows(store: ChannelMessageStore): ChannelMessage[] {
  return store.history(CH, { limit: 200 });
}
function agentReplies(store: ChannelMessageStore, providerId?: string) {
  return rows(store).filter(
    (m) =>
      m.sender.kind === 'agent' &&
      m.status === 'complete' &&
      (!providerId || m.sender.providerId === providerId)
  );
}
function systemRows(store: ChannelMessageStore) {
  return rows(store).filter((m) => m.kind === 'system');
}

function post(
  store: ChannelMessageStore,
  binder: ChannelAgentBinder,
  text: string,
  knownIds: string[],
  sender: ChannelSenderRef = OPERATOR
): ChannelMessage {
  const mentions = parseMentions(text, knownIds);
  const message = store.appendComplete({
    channelId: CH,
    sender,
    text,
    ...(mentions.length ? { mentions } : {}),
  });
  binder.handleMessagePosted(message, message.mentions ?? []);
  return message;
}

// ── scripted adapter (deterministic, no timers) ──────────────────────────────

type ScriptMode =
  | { mode: 'stall' }
  | { mode: 'reply'; text: string }
  | { mode: 'reject-once-then-reply'; text: string };

class ScriptedAdapter extends BaseProtocolAdapterV2 {
  readonly runtimeOwnership = 'spawned' as const;
  readonly capabilities: AgentCapabilitySetV2 = {
    text: true,
    queue: false,
    interrupt: true,
    approvals: true,
    streaming: true,
  };
  readonly sendCalls: string[] = [];
  private _status: AdapterStatus = 'disconnected';
  private sid = 'scripted';
  private rejected = false;

  constructor(
    readonly agentType: string,
    private readonly script: ScriptMode
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
    this.sendCalls.push(input.turnId);
    if (this.script.mode === 'reject-once-then-reply' && !this.rejected) {
      this.rejected = true;
      throw new Error('transport down');
    }
    if (this.script.mode === 'stall') return; // resolve, never complete
    this.runReply(input.turnId, this.script.text);
  }

  private runReply(turnId: string, text: string): void {
    const itemId = `assistant-${turnId}`;
    this.emitPatch({
      type: 'agent-turn-started-v2',
      sessionId: this.sid,
      timestamp: 't',
      turn: {
        id: turnId,
        status: 'running',
        inputMessageId: `u-${turnId}`,
        items: [],
        startedAt: 't',
      },
    });
    this.emitPatch({
      type: 'agent-item-started-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId,
      item: { type: 'assistantMessage', id: itemId, text: '' },
    });
    this.emitPatch({
      type: 'agent-item-delta-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId,
      itemId,
      delta: { text },
    });
    this.emitPatch({
      type: 'agent-item-updated-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId,
      item: {
        type: 'assistantMessage',
        id: itemId,
        text,
        status: 'completed',
      },
    });
    this.emitPatch({
      type: 'agent-turn-completed-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId,
      status: 'completed',
    });
  }
}

// ── sessions harness ─────────────────────────────────────────────────────────

interface SessionsHarness {
  sessions: BinderSessions;
  spawns: () => number;
  firstSessionId: () => string;
  adapterFor: (sessionId: string) => ProtocolAdapterV2;
  fireEnd: (sessionId: string) => void;
}

function makeSessions(
  build: (agentType: string) => ProtocolAdapterV2,
  opts: { throwOnCreate?: boolean } = {}
): SessionsHarness {
  const created = new Map<string, { session: WebSession }>();
  const order: string[] = [];
  const endCbs: Array<(id: string, cwd: string, br?: string) => void> = [];
  let spawns = 0;
  const sessions: BinderSessions = {
    async createWeb(params) {
      spawns++;
      if (opts.throwOnCreate) throw new Error('boom: spawn failed');
      const id = `sess-${spawns}-${params.agentType}`;
      const adapter = build(params.agentType);
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
      created.set(id, { session });
      order.push(id);
      return { session };
    },
    get(id) {
      return created.get(id)?.session as unknown as Session | undefined;
    },
    onSessionEnd(cb) {
      endCbs.push(cb);
      return () => {
        const i = endCbs.indexOf(cb);
        if (i >= 0) endCbs.splice(i, 1);
      };
    },
  };
  return {
    sessions,
    spawns: () => spawns,
    firstSessionId: () => order[0]!,
    adapterFor: (id) => created.get(id)!.session.adapterV2,
    fireEnd: (id) => {
      created.delete(id);
      for (const cb of [...endCbs]) cb(id, '/tmp');
    },
  };
}

const MOCK_TARGETS: MentionTarget[] = [
  {
    id: 'mock',
    displayName: 'Mock',
    kind: 'framework',
    available: true,
    reason: null,
  },
];

function makeBinder(cfg: {
  build: (agentType: string) => ProtocolAdapterV2;
  targets: MentionTarget[];
  knownProviderIds: string[];
  topicStore?: WorkspaceTopicStore | null;
  watchdogMs?: number;
  throwOnCreate?: boolean;
}): {
  binder: ChannelAgentBinder;
  store: ChannelMessageStore;
  hub: ChannelHub;
  sessions: SessionsHarness;
} {
  const { store, hub } = makeStore();
  const sessions = makeSessions(cfg.build, {
    ...(cfg.throwOnCreate ? { throwOnCreate: true } : {}),
  });
  const binder = createChannelAgentBinder({
    store,
    hub,
    topicStore: cfg.topicStore ?? null,
    sessions: sessions.sessions,
    knownProviderIds: cfg.knownProviderIds,
    mentionTargets: async () => cfg.targets,
    port: 0,
    configDir: '/tmp',
    ...(cfg.watchdogMs !== undefined ? { watchdogMs: cfg.watchdogMs } : {}),
  });
  cleanup.push(() => binder.close());
  return { binder, store, hub, sessions };
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('channel-agent-binder — lifecycle', () => {
  it('first mention spawns exactly one session and streams the reply as agent:mock', async () => {
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    post(store, binder, '@mock hello', ['mock']);
    await waitFor(() => agentReplies(store, 'mock').length === 1);
    expect(sessions.spawns()).toBe(1);
    const reply = agentReplies(store, 'mock')[0]!;
    expect(reply.sender.id).toBe('agent:mock');
    expect(reply.body.text).toBe('Mock v2 response complete.');
  });

  it('two concurrent mentions single-flight to exactly one spawn', async () => {
    const { binder, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 5, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const [b1, b2] = await Promise.all([
      binder.ensureBinding(CH, 'mock'),
      binder.ensureBinding(CH, 'mock'),
    ]);
    expect(sessions.spawns()).toBe(1);
    expect(b1).toBe(b2);
  });

  it('a second sequential mention reuses the live session (no respawn)', async () => {
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    post(store, binder, '@mock one', ['mock']);
    await waitFor(() => agentReplies(store, 'mock').length === 1);
    post(store, binder, '@mock two', ['mock']);
    await waitFor(() => agentReplies(store, 'mock').length === 2);
    expect(sessions.spawns()).toBe(1);
  });

  it('a mention while streaming queues and drains after the active turn', async () => {
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 30 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    post(store, binder, '@mock a', ['mock']);
    post(store, binder, '@mock b', ['mock']);
    await waitFor(() => agentReplies(store, 'mock').length === 2, 6000);
    expect(sessions.spawns()).toBe(1);
  });

  it('queue overflow past the cap drops the message with a system row', async () => {
    const { binder, store } = makeBinder({
      build: () => new ScriptedAdapter('stall', { mode: 'stall' }),
      targets: [
        {
          id: 'stall',
          displayName: 'Stall',
          kind: 'framework',
          available: true,
          reason: null,
        },
      ],
      knownProviderIds: ['stall'],
    });
    for (let i = 0; i < 10; i++) post(store, binder, `@stall ${i}`, ['stall']);
    await waitFor(() =>
      systemRows(store).some((m) => m.body.text.includes('turns queued'))
    );
    const dropped = systemRows(store).filter((m) =>
      m.body.text.includes('message dropped')
    );
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.body.text).toContain('has 8 turns queued');
  });

  it('session death unbinds, nulls the row session id, and respawns on next mention', async () => {
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    post(store, binder, '@mock one', ['mock']);
    await waitFor(() => agentReplies(store, 'mock').length === 1);
    const sid = sessions.firstSessionId();
    sessions.fireEnd(sid);
    expect(store.getBinding(CH, 'mock')?.sessionId).toBeNull();
    post(store, binder, '@mock two', ['mock']);
    await waitFor(() => agentReplies(store, 'mock').length === 2);
    expect(sessions.spawns()).toBe(2);
  });

  it('spawn failure posts a system row and leaves no stuck single-flight', async () => {
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2(),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      throwOnCreate: true,
    });
    post(store, binder, '@mock one', ['mock']);
    await waitFor(() =>
      systemRows(store).some((m) => m.body.text.includes('failed to start'))
    );
    post(store, binder, '@mock two', ['mock']);
    await waitFor(() => sessions.spawns() === 2); // single-flight cleared, retried
    expect(
      systemRows(store).filter((m) => m.body.text.includes('failed to start'))
    ).toHaveLength(2);
  });
});

describe('channel-agent-binder — delivery + idempotency', () => {
  it('uses a deterministic turnId and a retry reuses the same turn identity', async () => {
    const { binder, store, sessions } = makeBinder({
      build: () =>
        new ScriptedAdapter('x', {
          mode: 'reject-once-then-reply',
          text: 'ok',
        }),
      targets: [
        {
          id: 'x',
          displayName: 'X',
          kind: 'framework',
          available: true,
          reason: null,
        },
      ],
      knownProviderIds: ['x'],
    });
    const trigger = post(store, binder, '@x go', ['x']);
    await waitFor(() => agentReplies(store, 'x').length === 1);
    const adapter = sessions.adapterFor(
      sessions.firstSessionId()
    ) as ScriptedAdapter;
    expect(adapter.sendCalls).toHaveLength(2); // rejected once, then retried
    const expected = `chturn-${trigger.id}-x`;
    expect(adapter.sendCalls[0]).toBe(expected);
    expect(adapter.sendCalls[1]).toBe(expected); // retry reuses the SAME turnId
    expect(sessions.spawns()).toBe(1);
  });

  it('advances the delivery cursor only after a send is accepted', async () => {
    const { binder, store } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const trigger = post(store, binder, '@mock hello', ['mock']);
    await waitFor(() => agentReplies(store, 'mock').length === 1);
    await waitFor(
      () =>
        store.getBinding(CH, 'mock')?.providerSession['lastDeliveredSeq'] ===
        trigger.seq
    );
    expect(
      store.getBinding(CH, 'mock')?.providerSession['lastDeliveredSeq']
    ).toBe(trigger.seq);
  });
});

describe('channel-agent-binder — agent-to-agent brake', () => {
  it('caps consecutive agent turns and a human post resets the brake', async () => {
    const build = (agentType: string) =>
      new ScriptedAdapter(agentType, {
        mode: 'reply',
        text: agentType === 'a' ? 'ping @b' : 'ping @a',
      });
    const { binder, store } = makeBinder({
      build,
      targets: [
        {
          id: 'a',
          displayName: 'A',
          kind: 'framework',
          available: true,
          reason: null,
        },
        {
          id: 'b',
          displayName: 'B',
          kind: 'framework',
          available: true,
          reason: null,
        },
      ],
      knownProviderIds: ['a', 'b'],
    });
    post(store, binder, '@a go', ['a', 'b']);
    await waitFor(() =>
      systemRows(store).some((m) =>
        m.body.text.includes('Mention chain paused')
      )
    );
    const pausedRows = systemRows(store).filter((m) =>
      m.body.text.includes('Mention chain paused')
    );
    expect(pausedRows).toHaveLength(1);
    // Human-initiated a reply is not counted; the brake bounds the autonomous
    // fan-out at MAX_CONSECUTIVE_AGENT_TURNS agent turns.
    const beforeReset = agentReplies(store).length;
    expect(beforeReset).toBeLessThanOrEqual(MAX_CONSECUTIVE_AGENT_TURNS + 1);

    // A fresh human post resets the counter → the chain resumes.
    post(store, binder, '@a again', ['a', 'b']);
    await waitFor(() => agentReplies(store).length > beforeReset, 6000);
    expect(agentReplies(store).length).toBeGreaterThan(beforeReset);
  });
});

describe('channel-agent-binder — roster + availability', () => {
  it('reports availability, reasons, and live binding status', async () => {
    const { binder, store } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: [
        ...MOCK_TARGETS,
        {
          id: 'codex',
          displayName: 'Codex',
          kind: 'framework',
          available: false,
          reason:
            'Codex web sessions do not yet stream chat responses (see issue #301).',
        },
      ],
      knownProviderIds: ['mock', 'codex'],
    });
    let roster = await binder.rosterForChannel(CH);
    const codex = roster.find((r) => r.id === 'codex')!;
    expect(codex.available).toBe(false);
    expect(codex.reason).toContain('#301');
    expect(roster.find((r) => r.id === 'mock')!.binding).toBeNull();

    post(store, binder, '@mock hi', ['mock', 'codex']);
    await waitFor(() => agentReplies(store, 'mock').length === 1);
    roster = await binder.rosterForChannel(CH);
    expect(roster.find((r) => r.id === 'mock')!.binding).not.toBeNull();
    expect(roster.find((r) => r.id === 'mock')!.binding?.status).toBe('idle');
  });

  it('an unavailable framework posts a de-advertise row, rate-limited', async () => {
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2(),
      targets: [
        {
          id: 'codex',
          displayName: 'Codex',
          kind: 'framework',
          available: false,
          reason:
            'Codex web sessions do not yet stream chat responses (see issue #301).',
        },
      ],
      knownProviderIds: ['codex'],
    });
    post(store, binder, '@codex fix it', ['codex']);
    await waitFor(() =>
      systemRows(store).some((m) => m.body.text.includes('#301'))
    );
    post(store, binder, '@codex fix it again', ['codex']);
    // brief settle
    await new Promise((r) => setTimeout(r, 40));
    expect(
      systemRows(store).filter((m) => m.body.text.includes('not available'))
    ).toHaveLength(1); // rate-limited: only one identical row
    expect(sessions.spawns()).toBe(0);
  });
});

describe('channel-agent-binder — watchdog + cross-node + interrupt', () => {
  it('force-drains a stuck turn once the watchdog fires', async () => {
    const { binder, store, sessions } = makeBinder({
      build: () => new ScriptedAdapter('stall', { mode: 'stall' }),
      targets: [
        {
          id: 'stall',
          displayName: 'Stall',
          kind: 'framework',
          available: true,
          reason: null,
        },
      ],
      knownProviderIds: ['stall'],
      watchdogMs: 25,
    });
    post(store, binder, '@stall a', ['stall']);
    await waitFor(() => sessions.spawns() === 1);
    const adapter = sessions.adapterFor(
      sessions.firstSessionId()
    ) as ScriptedAdapter;
    await waitFor(() => adapter.sendCalls.length === 1);
    // Watchdog (25ms) force-drains the stuck turn → the next mention delivers.
    await new Promise((r) => setTimeout(r, 60));
    post(store, binder, '@stall b', ['stall']);
    await waitFor(() => adapter.sendCalls.length === 2, 4000);
    expect(adapter.sendCalls).toHaveLength(2);
  });

  it('cross-node topics fail visibly and never spawn a local stand-in', async () => {
    const topicStore = {
      get: () => ({
        id: CH,
        source: 'persisted',
        display: { title: 'general' },
        routingDefaults: { nodeId: 'remote-node' },
      }),
    } as unknown as WorkspaceTopicStore;
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2(),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      topicStore,
    });
    post(store, binder, '@mock go', ['mock']);
    await waitFor(() =>
      systemRows(store).some((m) => m.body.text.includes('other nodes'))
    );
    expect(sessions.spawns()).toBe(0);
  });

  it('interrupt finalizes the partial row as interrupted (bridge status-map fix)', async () => {
    const { binder, store } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 60 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    post(store, binder, '@mock slow please', ['mock']);
    await waitFor(() =>
      rows(store).some(
        (m) => m.sender.providerId === 'mock' && m.status === 'streaming'
      )
    );
    await binder.interrupt(CH, 'mock');
    await waitFor(() =>
      rows(store).some(
        (m) => m.sender.providerId === 'mock' && m.status === 'interrupted'
      )
    );
    expect(
      rows(store).some(
        (m) => m.sender.providerId === 'mock' && m.status === 'interrupted'
      )
    ).toBe(true);
  });

  it('interrupt throws NO_ACTIVE_TURN when idle and NOT_FOUND when unbound', async () => {
    const { binder, store } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    await expect(binder.interrupt(CH, 'mock')).rejects.toThrow(); // not bound
    post(store, binder, '@mock hi', ['mock']);
    await waitFor(() => agentReplies(store, 'mock').length === 1);
    await expect(binder.interrupt(CH, 'mock')).rejects.toThrow(); // idle
  });
});
