import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MockProtocolAdapterV2 } from '../server/protocol-adapters/mock-v2-adapter.js';
import {
  BaseProtocolAdapterV2,
  type AdapterConfig,
  type AdapterStatus,
  type AgentApprovalResponseInputV2,
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
import type { ChannelAttachmentStore } from '../server/channel-attachments.js';
import {
  CHANNEL_BINDING_YOLO_DEFAULT,
  createChannelAgentBinder,
  MAX_CONSECUTIVE_AGENT_TURNS,
  type BinderSessions,
  type ChannelAgentBinder,
  type MentionTarget,
} from '../server/channel-agent-binder.js';
import type { Session, WebSession } from '../server/types.js';
import type { CreateWebParams } from '../server/web-session-handler.js';
import { createWebSession } from '../server/web-session-handler.js';
import type { WorkspaceTopicStore } from '../server/workspace-topics.js';
import {
  parseMentions,
  type ChannelImagePart,
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
/** A CLI-gateway actor post (deriveSender kind 'agent') — subject to the brake. */
const AGENT_SENDER: ChannelSenderRef = {
  kind: 'agent',
  id: 'agent:orchestrator',
  providerId: 'orchestrator',
  displayName: 'orchestrator',
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
  sender: ChannelSenderRef = OPERATOR,
  parentMessageId?: string
): ChannelMessage {
  const mentions = parseMentions(text, knownIds);
  const message = store.appendComplete({
    channelId: CH,
    sender,
    text,
    ...(mentions.length ? { mentions } : {}),
    ...(parentMessageId ? { parentMessageId } : {}),
  });
  binder.handleMessagePosted(message, message.mentions ?? []);
  return message;
}

function postAgentTurnRow(
  store: ChannelMessageStore,
  binder: ChannelAgentBinder,
  turnId: string,
  itemId: string,
  text: string,
  knownIds: string[]
): ChannelMessage {
  const mentions = parseMentions(text, knownIds);
  const stream = store.beginStream({
    channelId: CH,
    sender: AGENT_SENDER,
    source: { sessionId: 'session:orchestrator', turnId, itemId },
    ...(mentions.length ? { mentions } : {}),
  });
  const message = store.finalizeStream(stream.id, {
    text,
    status: 'complete',
  })!;
  binder.handleMessagePosted(message, mentions);
  return message;
}

// ── scripted adapter (deterministic, no timers) ──────────────────────────────

type ScriptMode =
  | { mode: 'stall' }
  | { mode: 'reply'; text: string }
  | { mode: 'reply-items'; texts: string[] }
  | { mode: 'reject' }
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
  readonly sendInputs: AgentSendMessageInputV2[] = [];
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
    this.sendInputs.push(input);
    if (this.script.mode === 'reject-once-then-reply' && !this.rejected) {
      this.rejected = true;
      throw new Error('transport down');
    }
    if (this.script.mode === 'reject') throw new Error('transport down');
    if (this.script.mode === 'stall') return; // resolve, never complete
    this.runReplyItems(
      input.turnId,
      this.script.mode === 'reply-items'
        ? this.script.texts
        : [this.script.text]
    );
  }

  private runReplyItems(turnId: string, texts: string[]): void {
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
    for (const [index, text] of texts.entries()) {
      const itemId = `assistant-${turnId}-${index}`;
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
    }
    this.emitPatch({
      type: 'agent-turn-completed-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId,
      status: 'completed',
    });
  }
}

// ── approval-driving adapter (waitingOn handshake, no timers) ─────────────────
// Emits an approval item + `waitingOn:'approval'` on send, parks the turn, and
// resolves it only on respondToApproval / interrupt. Records send/respond/
// interrupt calls so the brake, watchdog-pause, and round-trip can be asserted.
class ApprovalAdapter extends BaseProtocolAdapterV2 {
  readonly runtimeOwnership = 'spawned' as const;
  readonly capabilities: AgentCapabilitySetV2 = {
    text: true,
    approvals: true,
    interrupt: true,
    streaming: true,
    queue: false,
  };
  readonly sendCalls: string[] = [];
  readonly respondCalls: AgentApprovalResponseInputV2[] = [];
  readonly interruptCalls: string[] = [];
  private _status: AdapterStatus = 'disconnected';
  private sid = 'appr';
  private activeTurn: string | null = null;
  private pendingApprovalId: string | null = null;

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
  async respondToInput(): Promise<void> {}

  async sendMessage(input: AgentSendMessageInputV2): Promise<void> {
    this.sendCalls.push(input.turnId);
    this.activeTurn = input.turnId;
    const approvalId = `appr-${input.turnId}`;
    this.pendingApprovalId = approvalId;
    this.emitPatch({
      type: 'agent-turn-started-v2',
      sessionId: this.sid,
      timestamp: 't',
      turn: {
        id: input.turnId,
        status: 'running',
        inputMessageId: `u-${input.turnId}`,
        items: [],
        startedAt: 't',
      },
    });
    this.emitPatch({
      type: 'agent-item-started-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId: input.turnId,
      item: {
        type: 'approval',
        id: approvalId,
        requestId: approvalId,
        kind: 'command',
        description: 'Run mock command',
        target: 'npm test',
        status: 'pending',
        startedAt: 't',
      },
    });
    this.emitPatch({
      type: 'agent-live-state-updated-v2',
      sessionId: this.sid,
      timestamp: 't',
      live: { waitingOn: 'approval' },
    });
    // Real hermes shape (#1181 re-review): hermes fires
    // `session-status {status:'idle', waitingOn:'approval'}` alongside the
    // permission prompt, and the legacy compat mapping strips the waitingOn for
    // the `idle` case — so the binder sees a BARE idle mid-approval. It must
    // ignore it: never finalize (which would let pump dispatch a concurrent
    // turn) and never clobber the waiting state / re-arm the watchdog.
    this.emitPatch({
      type: 'agent-live-state-updated-v2',
      sessionId: this.sid,
      timestamp: 't',
      live: {
        status: 'idle',
        activeTurnId: null,
        waitingOn: null,
        activeRequestIds: [],
        error: null,
      },
    });
  }

  async interrupt(input: AgentInterruptInputV2): Promise<void> {
    this.interruptCalls.push(input.turnId ?? this.activeTurn ?? '');
    const turnId = this.activeTurn;
    if (turnId === null) return;
    this.activeTurn = null;
    this.pendingApprovalId = null;
    this.emitPatch({
      type: 'agent-turn-completed-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId,
      status: 'interrupted',
    });
  }

  async respondToApproval(input: AgentApprovalResponseInputV2): Promise<void> {
    this.respondCalls.push(input);
    if (input.requestId !== this.pendingApprovalId) return;
    const turnId = this.activeTurn;
    if (turnId === null) return;
    this.emitPatch({
      type: 'agent-item-updated-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId,
      item: {
        type: 'approval',
        id: input.requestId,
        requestId: input.requestId,
        kind: 'command',
        description: 'Run mock command',
        target: 'npm test',
        status: 'completed',
        decision: input.decision,
      },
    });
    this.emitPatch({
      type: 'agent-live-state-updated-v2',
      sessionId: this.sid,
      timestamp: 't',
      live: { waitingOn: null },
    });
    const itemId = `a-${turnId}`;
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
      delta: { text: 'approved and done' },
    });
    this.emitPatch({
      type: 'agent-item-updated-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId,
      item: {
        type: 'assistantMessage',
        id: itemId,
        text: 'approved and done',
        status: 'completed',
      },
    });
    this.activeTurn = null;
    this.pendingApprovalId = null;
    this.emitPatch({
      type: 'agent-turn-completed-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId,
      status: 'completed',
    });
  }
}

// ── deferred-send adapter (send acceptance resolved/rejected on command) ──────
// sendMessage returns a promise the test resolves (accept) or rejects (transport
// failure) explicitly, so the send-failure/rebind interleaving is deterministic.
class DeferredAdapter extends BaseProtocolAdapterV2 {
  readonly runtimeOwnership = 'spawned' as const;
  readonly capabilities: AgentCapabilitySetV2 = {
    text: true,
    streaming: true,
    interrupt: true,
    queue: false,
  };
  readonly sendCalls: string[] = [];
  private _status: AdapterStatus = 'disconnected';
  private sid = 'deferred';
  private readonly pending = new Map<
    string,
    { resolve: () => void; reject: (err: unknown) => void }
  >();

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
  async interrupt(): Promise<void> {}
  async respondToApproval(): Promise<void> {}
  async respondToInput(): Promise<void> {}

  sendMessage(input: AgentSendMessageInputV2): Promise<void> {
    this.sendCalls.push(input.turnId);
    return new Promise<void>((resolve, reject) => {
      this.pending.set(input.turnId, { resolve, reject });
    });
  }

  rejectSend(turnId: string): void {
    const d = this.pending.get(turnId);
    this.pending.delete(turnId);
    d?.reject(new Error('transport down'));
  }

  /** Accept the send AND stream a completing reply for the turn. */
  completeReply(turnId: string, text: string): void {
    const d = this.pending.get(turnId);
    this.pending.delete(turnId);
    d?.resolve();
    const itemId = `a-${turnId}`;
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
      item: { type: 'assistantMessage', id: itemId, text, status: 'completed' },
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

// ── idle-without-turn-completed adapter (#1181 defect 3) ─────────────────────
// Emits `working` then a trailing `idle` live-state but NO agent-turn-completed-v2
// (and no assistant item) — the shape a hermes turn produces when it signals
// session-status idle without a paired turn-completed. Reproduces the presence
// wedge: the binder must fall back to idle instead of flipping to 'thinking'.
class IdleWithoutTurnCompletedAdapter extends BaseProtocolAdapterV2 {
  readonly runtimeOwnership = 'attached' as const;
  readonly capabilities: AgentCapabilitySetV2 = {
    text: true,
    interrupt: true,
    streaming: true,
  };
  private _status: AdapterStatus = 'disconnected';
  private sid = 'idle-nc';
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
  async interrupt(_i: AgentInterruptInputV2): Promise<void> {}
  async respondToApproval(): Promise<void> {}
  async respondToInput(): Promise<void> {}
  async sendMessage(input: AgentSendMessageInputV2): Promise<void> {
    this.emitPatch({
      type: 'agent-live-state-updated-v2',
      sessionId: this.sid,
      timestamp: 't',
      live: { status: 'working', error: null },
    });
    this.emitPatch({
      type: 'agent-turn-started-v2',
      sessionId: this.sid,
      timestamp: 't',
      turn: {
        id: input.turnId,
        status: 'running',
        inputMessageId: `user-${input.turnId}`,
        items: [],
        startedAt: 't',
      },
    });
    // No assistant item, and crucially NO agent-turn-completed-v2 — only a
    // trailing idle live-state, as a hermes turn can emit.
    this.emitPatch({
      type: 'agent-live-state-updated-v2',
      sessionId: this.sid,
      timestamp: 't',
      live: {
        status: 'idle',
        activeTurnId: null,
        waitingOn: null,
        activeRequestIds: [],
        error: null,
      },
    });
  }
}

// Bare-idle harness with explicit late/error terminals. It keeps lifecycle
// ordering deterministic for retained-parent pruning and legacy error-pair
// regressions without relying on timers.
class ManualBareIdleAdapter extends BaseProtocolAdapterV2 {
  readonly runtimeOwnership = 'attached' as const;
  readonly capabilities: AgentCapabilitySetV2 = {
    text: true,
    interrupt: true,
    streaming: true,
  };
  readonly sendCalls: string[] = [];
  private _status: AdapterStatus = 'disconnected';
  private sid = 'manual-idle';
  private itemNumber = 0;
  private idleOneSend = false;

  constructor(
    readonly agentType: string,
    private readonly autoIdle = true
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
  async interrupt(_i: AgentInterruptInputV2): Promise<void> {}
  async respondToApproval(): Promise<void> {}
  async respondToInput(): Promise<void> {}

  async sendMessage(input: AgentSendMessageInputV2): Promise<void> {
    this.sendCalls.push(input.turnId);
    if (this.autoIdle || this.idleOneSend) {
      this.idleOneSend = false;
      this.emitPatch({
        type: 'agent-live-state-updated-v2',
        sessionId: this.sid,
        timestamp: 't',
        live: { status: 'idle', activeTurnId: null },
      });
    }
  }

  idleNextSend(): void {
    this.idleOneSend = true;
  }

  emitLate(turnId: string, text = 'late reply'): void {
    this.emitPatch({
      type: 'agent-item-updated-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId,
      item: {
        type: 'assistantMessage',
        id: `manual-late-${++this.itemNumber}`,
        text,
        status: 'completed',
      },
    });
  }

  emitCompleted(turnId: string): void {
    this.emitPatch({
      type: 'agent-turn-completed-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId,
      status: 'completed',
    });
  }

  emitError(message: string): void {
    this.emitPatch({
      type: 'agent-error-v2',
      sessionId: this.sid,
      timestamp: 't',
      message,
    });
  }

  emitLegacyErrorPair(message: string): void {
    this.emitError(message);
    this.emitCompleted('turn-0');
  }
}

// Emits bare idle before its first assistant row. This reproduces late-opening
// output after binder finishTurn, including Hermes' `turn-0` fallback label.
class LateOpeningReplyAdapter extends BaseProtocolAdapterV2 {
  readonly runtimeOwnership = 'attached' as const;
  readonly capabilities: AgentCapabilitySetV2 = {
    text: true,
    interrupt: true,
    streaming: true,
  };
  private _status: AdapterStatus = 'disconnected';
  private sid = 'late';
  private outputNumber = 0;

  constructor(
    readonly agentType: string,
    private readonly fallbackTurnId: boolean
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
  async interrupt(_i: AgentInterruptInputV2): Promise<void> {}
  async respondToApproval(): Promise<void> {}
  async respondToInput(): Promise<void> {}
  async sendMessage(input: AgentSendMessageInputV2): Promise<void> {
    const outputNumber = ++this.outputNumber;
    this.emitPatch({
      type: 'agent-live-state-updated-v2',
      sessionId: this.sid,
      timestamp: 't',
      live: { status: 'idle', activeTurnId: null },
    });
    const turnId = this.fallbackTurnId ? 'turn-0' : input.turnId;
    setTimeout(() => {
      this.emitPatch({
        type: 'agent-item-updated-v2',
        sessionId: this.sid,
        timestamp: 't',
        turnId,
        item: {
          type: 'assistantMessage',
          id: `late-${turnId}-${outputNumber}`,
          text: 'late reply',
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
    }, 5).unref?.();
  }
}

// ── sessions harness ─────────────────────────────────────────────────────────

interface SessionsHarness {
  sessions: BinderSessions;
  spawns: () => number;
  firstSessionId: () => string;
  adapterFor: (sessionId: string) => ProtocolAdapterV2;
  fireEnd: (sessionId: string) => void;
  forgetWithoutEnd: (sessionId: string) => void;
  lastCreateParams: () => CreateWebParams | undefined;
}

function makeSessions(
  build: (agentType: string) => ProtocolAdapterV2,
  opts: { throwOnCreate?: boolean; gate?: Promise<void> } = {}
): SessionsHarness {
  const created = new Map<string, { session: WebSession }>();
  const order: string[] = [];
  const endCbs: Array<(id: string, cwd: string, br?: string) => void> = [];
  let spawns = 0;
  let lastParams: CreateWebParams | undefined;
  const sessions: BinderSessions = {
    async createWeb(params) {
      spawns++;
      lastParams = params;
      if (opts.throwOnCreate) throw new Error('boom: spawn failed');
      // Optional gate: park the spawn so a test can drive a close()/reorder race
      // between createWeb being invoked and its continuation resuming.
      if (opts.gate) await opts.gate;
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
    forgetWithoutEnd: (id) => {
      created.delete(id);
    },
    lastCreateParams: () => lastParams,
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
  yolo?: boolean;
  gate?: Promise<void>;
  attachmentStore?: ChannelAttachmentStore;
}): {
  binder: ChannelAgentBinder;
  store: ChannelMessageStore;
  hub: ChannelHub;
  sessions: SessionsHarness;
} {
  const { store, hub } = makeStore();
  const sessions = makeSessions(cfg.build, {
    ...(cfg.throwOnCreate ? { throwOnCreate: true } : {}),
    ...(cfg.gate ? { gate: cfg.gate } : {}),
  });
  const binder = createChannelAgentBinder({
    store,
    ...(cfg.attachmentStore ? { attachmentStore: cfg.attachmentStore } : {}),
    hub,
    topicStore: cfg.topicStore ?? null,
    sessions: sessions.sessions,
    knownProviderIds: cfg.knownProviderIds,
    mentionTargets: async () => cfg.targets,
    port: 0,
    configDir: '/tmp',
    ...(cfg.watchdogMs !== undefined ? { watchdogMs: cfg.watchdogMs } : {}),
    ...(cfg.yolo !== undefined ? { yolo: cfg.yolo } : {}),
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
    expect(reply.threadId).toBeNull();
    expect(reply.parentMessageId).toBeNull();
  });

  it.each([
    ['the routed turn id', false],
    ['the unambiguous Hermes turn-0 fallback', true],
  ])(
    'retains the exact thread parent for a late-opening row using %s',
    async (_label, fallbackTurnId) => {
      const { binder, store } = makeBinder({
        build: (agentType) =>
          new LateOpeningReplyAdapter(agentType, fallbackTurnId),
        targets: MOCK_TARGETS,
        knownProviderIds: ['mock'],
      });
      const root = store.appendComplete({
        channelId: CH,
        sender: OPERATOR,
        text: 'root',
      });
      const trigger = post(
        store,
        binder,
        '@mock threaded',
        ['mock'],
        OPERATOR,
        root.id
      );
      await waitFor(() => agentReplies(store, 'mock').length === 1);
      const reply = agentReplies(store, 'mock')[0]!;
      expect(trigger.threadId).toBe(root.id);
      expect(reply.threadId).toBe(root.id);
      expect(reply.parentMessageId).toBe(trigger.id);
    }
  );

  it('releases each Hermes fallback association before the next threaded turn', async () => {
    const { binder, store } = makeBinder({
      build: (agentType) => new LateOpeningReplyAdapter(agentType, true),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const rootOne = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'root one',
    });
    const rootTwo = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'root two',
    });
    const triggerOne = post(
      store,
      binder,
      '@mock one',
      ['mock'],
      OPERATOR,
      rootOne.id
    );
    await waitFor(() => agentReplies(store, 'mock').length === 1);
    const triggerTwo = post(
      store,
      binder,
      '@mock two',
      ['mock'],
      OPERATOR,
      rootTwo.id
    );
    await waitFor(() => agentReplies(store, 'mock').length === 2);
    const replies = agentReplies(store, 'mock');
    expect(replies[0]).toMatchObject({
      threadId: rootOne.id,
      parentMessageId: triggerOne.id,
    });
    expect(replies[1]).toMatchObject({
      threadId: rootTwo.id,
      parentMessageId: triggerTwo.id,
    });
  });

  it('fails closed when a turn-0 fallback could belong to multiple turns', async () => {
    const { binder, store } = makeBinder({
      build: (agentType) => new LateOpeningReplyAdapter(agentType, true),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const rootOne = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'root one',
    });
    const rootTwo = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'root two',
    });
    post(store, binder, '@mock one', ['mock'], OPERATOR, rootOne.id);
    post(store, binder, '@mock two', ['mock'], OPERATOR, rootTwo.id);
    await waitFor(() => agentReplies(store, 'mock').length === 2);
    for (const reply of agentReplies(store, 'mock')) {
      expect(reply.threadId).toBeNull();
      expect(reply.parentMessageId).toBeNull();
    }
  });

  it('bounds retained parents across many bare-idle turns', async () => {
    const { binder, store, sessions } = makeBinder({
      build: (agentType) => new ManualBareIdleAdapter(agentType),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    for (let i = 0; i < 20; i++) {
      post(store, binder, `@mock idle ${i}`, ['mock']);
    }
    await waitFor(() => {
      if (sessions.spawns() !== 1) return false;
      return (
        (
          sessions.adapterFor(
            sessions.firstSessionId()
          ) as ManualBareIdleAdapter
        ).sendCalls.length === 20
      );
    });
    const binding = await binder.ensureBinding(CH, 'mock');
    expect(binding.activeTurnId).toBeNull();
    expect(binding.parentMessageIdByTurn.size).toBeLessThanOrEqual(1);
  });

  it('prunes predecessors so an exact late successor recovers from fallback poisoning', async () => {
    const { binder, store, sessions } = makeBinder({
      build: (agentType) => new ManualBareIdleAdapter(agentType),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const rootOne = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'root one',
    });
    const rootTwo = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'root two',
    });
    const rootThree = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'root three',
    });
    post(store, binder, '@mock one', ['mock'], OPERATOR, rootOne.id);
    const triggerTwo = post(
      store,
      binder,
      '@mock two',
      ['mock'],
      OPERATOR,
      rootTwo.id
    );
    await waitFor(() => sessions.spawns() === 1);
    const adapter = sessions.adapterFor(
      sessions.firstSessionId()
    ) as ManualBareIdleAdapter;
    await waitFor(() => adapter.sendCalls.length === 2);
    adapter.emitLate(adapter.sendCalls[1]!);
    await waitFor(() => agentReplies(store, 'mock').length === 1);
    expect(agentReplies(store, 'mock')[0]).toMatchObject({
      threadId: rootTwo.id,
      parentMessageId: triggerTwo.id,
    });
    // Exact terminal evidence identifies and releases B, clearing the overlap
    // ambiguity. A later isolated C may safely use a genuine turn-0 fallback.
    adapter.emitCompleted(adapter.sendCalls[1]!);
    const triggerThree = post(
      store,
      binder,
      '@mock three',
      ['mock'],
      OPERATOR,
      rootThree.id
    );
    await waitFor(() => adapter.sendCalls.length === 3);
    adapter.emitLate('turn-0', 'valid fallback');
    await waitFor(() => agentReplies(store, 'mock').length === 2);
    expect(agentReplies(store, 'mock')[1]).toMatchObject({
      threadId: rootThree.id,
      parentMessageId: triggerThree.id,
    });
  });

  it('never resurrects a stale turn-0 against a newer retained successor', async () => {
    const { binder, store, sessions } = makeBinder({
      build: (agentType) => new ManualBareIdleAdapter(agentType),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const rootOne = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'root one',
    });
    const rootTwo = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'root two',
    });
    post(store, binder, '@mock one', ['mock'], OPERATOR, rootOne.id);
    post(store, binder, '@mock two', ['mock'], OPERATOR, rootTwo.id);
    await waitFor(() => sessions.spawns() === 1);
    const adapter = sessions.adapterFor(
      sessions.firstSessionId()
    ) as ManualBareIdleAdapter;
    await waitFor(() => adapter.sendCalls.length === 2);
    // Both turns have bare-idled; this anonymous row may belong to the older
    // generation and therefore must not borrow the newer turn's parent.
    adapter.emitLate('turn-0', 'stale reply');
    await waitFor(() => agentReplies(store, 'mock').length === 1);
    expect(agentReplies(store, 'mock')[0]).toMatchObject({
      threadId: null,
      parentMessageId: null,
    });
  });

  it('does not let a legacy error pair finish a freshly pumped successor', async () => {
    const { binder, store, sessions } = makeBinder({
      build: (agentType) => new ManualBareIdleAdapter(agentType, false),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const root = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'root',
    });
    post(store, binder, '@mock first', ['mock']);
    const successor = post(
      store,
      binder,
      '@mock successor',
      ['mock'],
      OPERATOR,
      root.id
    );
    await waitFor(() => sessions.spawns() === 1);
    const adapter = sessions.adapterFor(
      sessions.firstSessionId()
    ) as ManualBareIdleAdapter;
    await waitFor(() => adapter.sendCalls.length === 1);
    // Patch 1 of the pair pumps U; model U synchronously bare-idling before
    // patch 2 (turn-0 completed) is dispatched.
    adapter.idleNextSend();
    adapter.emitLegacyErrorPair('legacy failure');
    await waitFor(() => adapter.sendCalls.length === 2);
    const binding = await binder.ensureBinding(CH, 'mock');
    expect(binding.activeTurnId).toBeNull();
    expect(binding.parentMessageIdByTurn.has(adapter.sendCalls[1]!)).toBe(true);
    adapter.emitLate(adapter.sendCalls[1]!, 'successor late reply');
    await waitFor(() => agentReplies(store, 'mock').length === 1);
    expect(agentReplies(store, 'mock')[0]).toMatchObject({
      threadId: root.id,
      parentMessageId: successor.id,
    });
    adapter.emitCompleted(adapter.sendCalls[1]!);
    expect(binding.parentMessageIdByTurn.size).toBe(0);
  });

  it('surfaces an agent error received while the binding is idle', async () => {
    const { binder, store, sessions } = makeBinder({
      build: (agentType) => new ManualBareIdleAdapter(agentType),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    post(store, binder, '@mock idle', ['mock']);
    await waitFor(() => sessions.spawns() === 1);
    const adapter = sessions.adapterFor(
      sessions.firstSessionId()
    ) as ManualBareIdleAdapter;
    await waitFor(() => adapter.sendCalls.length === 1);
    adapter.emitError('idle failure');
    await waitFor(() =>
      systemRows(store).some((row) =>
        row.body.text.includes('@mock errored: idle failure')
      )
    );
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
    const root = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'root',
    });
    const triggers: ChannelMessage[] = [];
    for (let i = 0; i < 10; i++) {
      triggers.push(
        post(store, binder, `@stall ${i}`, ['stall'], OPERATOR, root.id)
      );
    }
    await waitFor(() =>
      systemRows(store).some((m) => m.body.text.includes('turns queued'))
    );
    const dropped = systemRows(store).filter((m) =>
      m.body.text.includes('message dropped')
    );
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.body.text).toContain('has 8 turns queued');
    expect(dropped[0]!.threadId).toBe(root.id);
    expect(dropped[0]!.parentMessageId).toBe(triggers.at(-1)!.id);
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

  it('threads session-ended rows for queued trigger messages', async () => {
    const { binder, store, sessions } = makeBinder({
      build: (agentType) => new DeferredAdapter(agentType),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const root = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'root',
    });
    post(store, binder, '@mock active', ['mock'], OPERATOR, root.id);
    const queued = post(
      store,
      binder,
      '@mock queued',
      ['mock'],
      OPERATOR,
      root.id
    );
    await waitFor(() => sessions.spawns() === 1);
    const adapter = sessions.adapterFor(
      sessions.firstSessionId()
    ) as DeferredAdapter;
    await waitFor(() => adapter.sendCalls.length === 1);
    sessions.fireEnd(sessions.firstSessionId());
    await waitFor(() =>
      systemRows(store).some((m) => m.body.text.includes('session ended'))
    );
    const ended = systemRows(store).find((m) =>
      m.body.text.includes('session ended')
    )!;
    expect(ended.threadId).toBe(root.id);
    expect(ended.parentMessageId).toBe(queued.id);
  });

  it('spawn failure posts a system row and leaves no stuck single-flight', async () => {
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2(),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      throwOnCreate: true,
    });
    const root = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'root',
    });
    const first = post(store, binder, '@mock one', ['mock'], OPERATOR, root.id);
    await waitFor(() =>
      systemRows(store).some((m) => m.body.text.includes('failed to start'))
    );
    const second = post(
      store,
      binder,
      '@mock two',
      ['mock'],
      OPERATOR,
      root.id
    );
    await waitFor(() => sessions.spawns() === 2); // single-flight cleared, retried
    const failures = systemRows(store).filter((m) =>
      m.body.text.includes('failed to start')
    );
    expect(failures).toHaveLength(2);
    expect(failures.map((m) => m.parentMessageId)).toEqual([
      first.id,
      second.id,
    ]);
  });
});

describe('channel-agent-binder — delivery + idempotency', () => {
  it('preserves an active threaded turn across transport rebind and finishes promptly', async () => {
    let spawnNumber = 0;
    let firstAdapter: DeferredAdapter | null = null;
    const { binder, store, sessions } = makeBinder({
      build: (agentType) => {
        spawnNumber++;
        if (spawnNumber === 1) {
          firstAdapter = new DeferredAdapter(agentType);
          return firstAdapter;
        }
        return new ScriptedAdapter(agentType, {
          mode: 'reply',
          text: 'rebound reply',
        });
      },
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const root = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'root',
    });
    const trigger = post(
      store,
      binder,
      '@mock retry',
      ['mock'],
      OPERATOR,
      root.id
    );
    await waitFor(
      () => firstAdapter !== null && firstAdapter.sendCalls.length === 1
    );
    const turnId = firstAdapter!.sendCalls[0]!;
    // Model a dead transport discovered by send rejection before the normal
    // session-end callback has removed the live binding.
    sessions.forgetWithoutEnd(sessions.firstSessionId());
    firstAdapter!.rejectSend(turnId);
    await waitFor(() => agentReplies(store, 'mock').length === 1);
    const reply = agentReplies(store, 'mock')[0]!;
    expect(reply).toMatchObject({
      threadId: root.id,
      parentMessageId: trigger.id,
    });
    expect(sessions.spawns()).toBe(2);
    const rebound = await binder.ensureBinding(CH, 'mock');
    expect(rebound.activeTurnId).toBeNull();
    expect(rebound.status).toBe('idle');
  });

  it('threads a terminal send-failure row to its triggering reply', async () => {
    const { binder, store } = makeBinder({
      build: () => new ScriptedAdapter('x', { mode: 'reject' }),
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
    const root = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'root',
    });
    const trigger = post(store, binder, '@x go', ['x'], OPERATOR, root.id);
    await waitFor(() =>
      systemRows(store).some((m) => m.body.text.includes('could not receive'))
    );
    const failure = systemRows(store).find((m) =>
      m.body.text.includes('could not receive')
    )!;
    expect(failure.threadId).toBe(root.id);
    expect(failure.parentMessageId).toBe(trigger.id);
  });

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

  it('resolves image refs once and preserves attachments across a send retry', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binder-image-retry-'));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const payloadPath = path.join(dir, 'fixture.png');
    fs.writeFileSync(payloadPath, Buffer.from('fixture'));
    const part: ChannelImagePart = {
      type: 'image',
      id: 'cha:retry-image',
      mime: 'image/png',
      w: 1,
      h: 1,
      bytes: 7,
    };
    const attachmentStore = {
      get: (id: string) =>
        id === part.id
          ? {
              part,
              sha256: 'retry-image',
              payloadPath,
              createdAt: 't',
            }
          : null,
    } as ChannelAttachmentStore;
    const { binder, store, sessions } = makeBinder({
      build: () =>
        new ScriptedAdapter('mock', {
          mode: 'reject-once-then-reply',
          text: 'ok',
        }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      attachmentStore,
    });
    const mentions = parseMentions('@mock inspect', ['mock']);
    const trigger = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: '@mock inspect',
      mentions,
      parts: [part],
    });
    binder.handleMessagePosted(trigger, mentions);

    await waitFor(() => agentReplies(store, 'mock').length === 1);
    const adapter = sessions.adapterFor(
      sessions.firstSessionId()
    ) as ScriptedAdapter;
    expect(adapter.sendInputs).toHaveLength(2);
    expect(adapter.sendInputs[0]!.attachments).toEqual([
      { type: 'image', path: payloadPath, mimeType: 'image/png' },
    ]);
    expect(adapter.sendInputs[1]).toEqual(adapter.sendInputs[0]);
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
  it('counts one provider turn once across item rows and mention fanout', async () => {
    const build = (agentType: string) =>
      agentType === 'a'
        ? new ScriptedAdapter('a', {
            mode: 'reply-items',
            texts: ['one @b @c', 'two @b', 'three @b', 'four @b'],
          })
        : new ScriptedAdapter(agentType, { mode: 'reply', text: 'done' });
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
        {
          id: 'c',
          displayName: 'C',
          kind: 'framework',
          available: true,
          reason: null,
        },
      ],
      knownProviderIds: ['a', 'b', 'c'],
    });

    post(store, binder, '@a go', ['a', 'b', 'c']);
    await waitFor(() => agentReplies(store, 'b').length === 4);
    await waitFor(() => agentReplies(store, 'c').length === 1);
    expect(agentReplies(store, 'b')).toHaveLength(4);
    expect(agentReplies(store, 'c')).toHaveLength(1);

    // Four rows consumed one provider-turn count, not four row counts: a second
    // distinct turn still routes instead of immediately tripping the cap.
    postAgentTurnRow(
      store,
      binder,
      'turn-after-multi-item',
      'item-0',
      '@b after',
      ['a', 'b', 'c']
    );
    await waitFor(() => agentReplies(store, 'b').length === 5);
    expect(agentReplies(store, 'b')).toHaveLength(5);
    expect(
      systemRows(store).filter((message) =>
        message.body.text.includes('Mention chain paused')
      )
    ).toHaveLength(0);
  });

  it('blocks later rows of an admitted turn after another turn pauses the channel', async () => {
    const { binder, store } = makeBinder({
      build: (agentType) =>
        new ScriptedAdapter(agentType, { mode: 'reply', text: 'done' }),
      targets: [
        {
          id: 'b',
          displayName: 'B',
          kind: 'framework',
          available: true,
          reason: null,
        },
      ],
      knownProviderIds: ['b'],
    });

    for (let index = 0; index < MAX_CONSECUTIVE_AGENT_TURNS; index += 1) {
      postAgentTurnRow(
        store,
        binder,
        `turn-${index}`,
        'item-0',
        `@b row ${index}`,
        ['b']
      );
    }
    await waitFor(
      () => agentReplies(store, 'b').length === MAX_CONSECUTIVE_AGENT_TURNS
    );

    postAgentTurnRow(store, binder, 'turn-cap', 'item-0', '@b pause', ['b']);
    await waitFor(() =>
      systemRows(store).some((message) =>
        message.body.text.includes('Mention chain paused')
      )
    );

    // turn-0 was admitted before the pause. Its later item must still pass the
    // per-dispatch pause check and never enqueue another downstream turn.
    postAgentTurnRow(store, binder, 'turn-0', 'item-late', '@b late row', [
      'b',
    ]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(agentReplies(store, 'b')).toHaveLength(MAX_CONSECUTIVE_AGENT_TURNS);
    expect(
      systemRows(store).filter((message) =>
        message.body.text.includes('Mention chain paused')
      )
    ).toHaveLength(1);
  });

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
    const root = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'root',
    });
    post(store, binder, '@a go', ['a', 'b'], OPERATOR, root.id);
    await waitFor(() =>
      systemRows(store).some((m) =>
        m.body.text.includes('Mention chain paused')
      )
    );
    const pausedRows = systemRows(store).filter((m) =>
      m.body.text.includes('Mention chain paused')
    );
    expect(pausedRows).toHaveLength(1);
    expect(pausedRows[0]!.threadId).toBe(root.id);
    expect(pausedRows[0]!.parentMessageId).not.toBeNull();
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

  it('clears presence to idle when a turn finalizes with an idle live-state and no turn-completed (#1181)', async () => {
    const { binder, store } = makeBinder({
      build: (agentType) => new IdleWithoutTurnCompletedAdapter(agentType),
      targets: [
        {
          id: 'hermes',
          displayName: 'Hermes',
          kind: 'framework',
          available: true,
          reason: null,
        },
      ],
      knownProviderIds: ['hermes'],
    });
    const statuses: string[] = [];
    binder.setStatusBroadcaster((_type, data) => {
      if (data['agentId'] === 'hermes') statuses.push(String(data['status']));
    });
    post(store, binder, '@hermes hi', ['hermes']);
    // The turn must reach 'thinking' (proving it was delivered) and then settle
    // back to 'idle' — NOT wedge on 'thinking' — even though no
    // agent-turn-completed-v2 fired; the trailing idle live-state finalizes it.
    await waitFor(
      () => statuses.includes('thinking') && statuses.at(-1) === 'idle',
      3000
    );
    expect(statuses).toContain('thinking');
    expect(statuses.at(-1)).toBe('idle');
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
    const root = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'root',
    });
    const trigger = post(
      store,
      binder,
      '@codex fix it',
      ['codex'],
      OPERATOR,
      root.id
    );
    await waitFor(() =>
      systemRows(store).some((m) => m.body.text.includes('#301'))
    );
    const secondTrigger = post(
      store,
      binder,
      '@codex fix it again',
      ['codex'],
      OPERATOR,
      root.id
    );
    // brief settle
    await new Promise((r) => setTimeout(r, 40));
    expect(
      systemRows(store).filter((m) => m.body.text.includes('not available'))
    ).toHaveLength(2); // distinct trigger parents must not suppress each other
    const unavailable = systemRows(store).find(
      (m) =>
        m.body.text.includes('not available') &&
        m.parentMessageId === trigger.id
    )!;
    expect(unavailable.threadId).toBe(root.id);
    expect(unavailable.parentMessageId).toBe(trigger.id);
    expect(
      systemRows(store).some(
        (m) =>
          m.body.text.includes('not available') &&
          m.parentMessageId === secondTrigger.id
      )
    ).toBe(true);
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

// ── #1180 review findings ─────────────────────────────────────────────────────

describe('channel-agent-binder — gateway agent-sender loop brake (P1 #1180)', () => {
  it('agent-sender posts count toward the cap and pause; a human post resets', async () => {
    const { binder, store } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    // MAX+1 gateway agent-sender posts: MAX route, the last one pauses. The mock
    // reply carries no @mention, so ONLY the gateway posts move the counter.
    for (let i = 0; i < MAX_CONSECUTIVE_AGENT_TURNS + 1; i++) {
      post(store, binder, `@mock ${i}`, ['mock'], AGENT_SENDER);
    }
    await waitFor(() =>
      systemRows(store).some((m) =>
        m.body.text.includes('Mention chain paused')
      )
    );
    await waitFor(
      () => agentReplies(store, 'mock').length === MAX_CONSECUTIVE_AGENT_TURNS
    );
    await new Promise((r) => setTimeout(r, 40)); // settle: no capped turn slips
    expect(agentReplies(store, 'mock')).toHaveLength(
      MAX_CONSECUTIVE_AGENT_TURNS
    );
    expect(
      systemRows(store).filter((m) =>
        m.body.text.includes('Mention chain paused')
      )
    ).toHaveLength(1);

    // A fresh HUMAN post resets the brake → the chain resumes.
    const before = agentReplies(store, 'mock').length;
    post(store, binder, '@mock human', ['mock'], OPERATOR);
    await waitFor(() => agentReplies(store, 'mock').length === before + 1);
    expect(agentReplies(store, 'mock').length).toBe(before + 1);
  });

  it('a mixed human/agent chain only brakes on consecutive agent turns', async () => {
    const { binder, store } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    // Two agent posts (counter 1,2), then a human post resets, then two more
    // agent posts (counter 1,2) — never reaches the cap, so no pause row.
    post(store, binder, '@mock a1', ['mock'], AGENT_SENDER);
    post(store, binder, '@mock a2', ['mock'], AGENT_SENDER);
    post(store, binder, '@mock h1', ['mock'], OPERATOR);
    post(store, binder, '@mock a3', ['mock'], AGENT_SENDER);
    post(store, binder, '@mock a4', ['mock'], AGENT_SENDER);
    await waitFor(() => agentReplies(store, 'mock').length === 5);
    await new Promise((r) => setTimeout(r, 40));
    expect(agentReplies(store, 'mock')).toHaveLength(5);
    expect(
      systemRows(store).filter((m) =>
        m.body.text.includes('Mention chain paused')
      )
    ).toHaveLength(0);
  });
});

describe('channel-agent-binder — buildPacket failure recovery (P2 #1180)', () => {
  it('a store.history throw does not wedge the binding; the next mention routes', async () => {
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    // Throw once from the top-level packet-fetch history call (the one with
    // `beforeSeq`); row helpers without beforeSeq continue to work.
    const realHistory = store.history.bind(store);
    let thrown = false;
    (store as unknown as { history: ChannelMessageStore['history'] }).history =
      ((id: string, filter?: Parameters<ChannelMessageStore['history']>[1]) => {
        if (!thrown && filter && 'beforeSeq' in filter) {
          thrown = true;
          throw new Error('db boom');
        }
        return realHistory(id, filter);
      }) as ChannelMessageStore['history'];

    post(store, binder, '@mock one', ['mock']);
    await waitFor(() =>
      systemRows(store).some((m) =>
        m.body.text.includes('could not build the message context')
      )
    );
    post(store, binder, '@mock two', ['mock']);
    await waitFor(() => agentReplies(store, 'mock').length === 1);
    expect(sessions.spawns()).toBe(1);
    expect(agentReplies(store, 'mock')).toHaveLength(1);
  });

  it('a store.threadHistory throw does not wedge the binding; the next mention routes', async () => {
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    // Throw once from the threaded packet-fetch lane. The next top-level turn
    // uses ordinary history and proves the queue did not wedge.
    const realThreadHistory = store.threadHistory.bind(store);
    let thrown = false;
    (
      store as unknown as {
        threadHistory: ChannelMessageStore['threadHistory'];
      }
    ).threadHistory = ((
      id: string,
      rootMessageId: string,
      filter?: Parameters<ChannelMessageStore['threadHistory']>[2]
    ) => {
      if (!thrown) {
        thrown = true;
        throw new Error('db boom');
      }
      return realThreadHistory(id, rootMessageId, filter);
    }) as ChannelMessageStore['threadHistory'];

    const root = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'root',
    });
    const failedTrigger = post(
      store,
      binder,
      '@mock one',
      ['mock'],
      OPERATOR,
      root.id
    );
    await waitFor(() =>
      systemRows(store).some((m) =>
        m.body.text.includes('could not build the message context')
      )
    );
    const failure = systemRows(store).find((m) =>
      m.body.text.includes('could not build the message context')
    )!;
    expect(failure.threadId).toBe(root.id);
    expect(failure.parentMessageId).toBe(failedTrigger.id);
    // Binding recovered (not stuck turn-active): the next mention delivers.
    post(store, binder, '@mock two', ['mock']);
    await waitFor(() => agentReplies(store, 'mock').length === 1);
    expect(sessions.spawns()).toBe(1); // reused, not respawned/wedged
    expect(agentReplies(store, 'mock')).toHaveLength(1);
  });
});

describe('channel-agent-binder — send-failure rebind clobber guard (P2 #1180)', () => {
  it('re-enqueues the failed turn instead of clobbering a newer active turn', async () => {
    const built: DeferredAdapter[] = [];
    const { binder, store, sessions } = makeBinder({
      build: (t) => {
        const a = new DeferredAdapter(t);
        built.push(a);
        return a;
      },
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    // M1 → session 1, turn T1 delivered, send parked (pending).
    const m1 = post(store, binder, '@mock one', ['mock']);
    await waitFor(() => built.length === 1 && built[0]!.sendCalls.length === 1);
    const a1 = built[0]!;
    const t1 = `chturn-${m1.id}-mock`;
    expect(a1.sendCalls).toEqual([t1]);
    const sid1 = sessions.firstSessionId();

    // Session dies → binder clears the live entry (activeTurnId reset, row null).
    sessions.fireEnd(sid1);

    // M2 → fresh session 2, turn T2 delivered, send parked.
    const m2 = post(store, binder, '@mock two', ['mock']);
    await waitFor(() => built.length === 2 && built[1]!.sendCalls.length === 1);
    const a2 = built[1]!;
    const t2 = `chturn-${m2.id}-mock`;
    expect(a2.sendCalls).toEqual([t2]);

    // Reject T1's original send: handleSendFailure rebinds → binding with T2
    // active. The failed turn must NOT clobber T2 with a concurrent send.
    a1.rejectSend(t1);
    await new Promise((r) => setTimeout(r, 40));
    expect(a2.sendCalls).toEqual([t2]); // T1 re-enqueued, not redelivered

    // T2 completes → the re-enqueued T1 drains to the SAME (live) session.
    a2.completeReply(t2, 'reply two');
    await waitFor(() => a2.sendCalls.length === 2, 4000);
    expect(a2.sendCalls[1]).toBe(t1);
    a2.completeReply(t1, 'reply one');
    await waitFor(() => agentReplies(store, 'mock').length === 2, 4000);
  });
});

describe('channel-agent-binder — close() gates in-flight spawns (P2 #1180)', () => {
  it('close() racing an in-flight ensureBinding leaves no binding and no store write', async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      gate,
    });
    const pending = binder.ensureBinding(CH, 'mock');
    await waitFor(() => sessions.spawns() === 1); // createWeb parked at the gate
    binder.close();
    releaseGate(); // spawn resolves AFTER close
    await expect(pending).rejects.toThrow(); // BinderClosedError — no attach
    expect(store.getBinding(CH, 'mock')?.sessionId ?? null).toBeNull();
    expect(systemRows(store)).toHaveLength(0); // no post-close store writes
  });
});

describe('channel-agent-binder — YOLO spawn permission mode (locked decision #1167)', () => {
  it('binder spawns pass permissionMode bypassPermissions when the yolo default is on', async () => {
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      // yolo omitted → defaults to CHANNEL_BINDING_YOLO_DEFAULT.
    });
    post(store, binder, '@mock hi', ['mock']);
    await waitFor(() => sessions.spawns() === 1);
    expect(CHANNEL_BINDING_YOLO_DEFAULT).toBe(true);
    expect(sessions.lastCreateParams()?.permissionMode).toBe(
      'bypassPermissions'
    );
  });

  it('binder spawns omit permissionMode when yolo is disabled (framework default)', async () => {
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      yolo: false,
    });
    post(store, binder, '@mock hi', ['mock']);
    await waitFor(() => sessions.spawns() === 1);
    expect(sessions.lastCreateParams()).toBeDefined();
    expect(sessions.lastCreateParams()!.permissionMode).toBeUndefined();
  });

  it('the shared createWebSession path does NOT default permissionMode (no yolo leak)', async () => {
    const map = new Map<string, Session>();
    const { session } = await createWebSession(
      {
        agentType: 'mock',
        cwd: '/tmp',
        displayName: 'normal',
        port: 0,
        configDir: '/tmp',
      },
      map,
      () => {},
      { skipInitialPersist: true }
    );
    expect(session.agentSessionV2.config.permissionMode).toBeUndefined();
  });

  it('the shared createWebSession path plumbs bypassPermissions through when passed', async () => {
    const map = new Map<string, Session>();
    const { session } = await createWebSession(
      {
        agentType: 'mock',
        cwd: '/tmp',
        displayName: 'yolo',
        port: 0,
        configDir: '/tmp',
        permissionMode: 'bypassPermissions',
      },
      map,
      () => {},
      { skipInitialPersist: true }
    );
    expect(session.agentSessionV2.config.permissionMode).toBe(
      'bypassPermissions'
    );
  });
});

describe('channel-agent-binder — approval round-trip + watchdog pause (Amendment 2 #1180)', () => {
  it('approval item posts a meta-tagged system row; the respond verb maps the decision and resolves', async () => {
    const built: ApprovalAdapter[] = [];
    const { binder, store, sessions } = makeBinder({
      build: (t) => {
        const a = new ApprovalAdapter(t);
        built.push(a);
        return a;
      },
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const root = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'root',
    });
    const trigger = post(
      store,
      binder,
      '@mock please approve',
      ['mock'],
      OPERATOR,
      root.id
    );
    await waitFor(() =>
      systemRows(store).some((m) => m.body.text.includes('requests approval'))
    );
    const turnId = `chturn-${trigger.id}-mock`;
    const requestId = `appr-${turnId}`;
    const approvalRow = systemRows(store).find((m) =>
      m.body.text.includes('requests approval')
    )!;
    expect(approvalRow.meta).toMatchObject({
      approvalRequestId: requestId,
      agentId: 'mock',
    });
    expect(approvalRow.meta?.['sessionId']).toBe(sessions.firstSessionId());
    expect(approvalRow.threadId).toBe(root.id);
    expect(approvalRow.parentMessageId).toBe(trigger.id);

    const a = built[0]!;
    await binder.respondToApproval(CH, 'mock', requestId, { kind: 'accept' });
    // Adapter received the mapped decision.
    expect(a.respondCalls).toHaveLength(1);
    expect(a.respondCalls[0]).toMatchObject({
      requestId,
      decision: { kind: 'accept' },
    });
    // Row updated (resolved-approval system row) + the streamed reply.
    await waitFor(() =>
      systemRows(store).some((m) => m.body.text.includes('approval accept'))
    );
    const resolvedRow = systemRows(store).find((m) =>
      m.body.text.includes('approval accept')
    )!;
    expect(resolvedRow.threadId).toBe(root.id);
    expect(resolvedRow.parentMessageId).toBe(trigger.id);
    await waitFor(() => agentReplies(store, 'mock').length === 1);
    expect(agentReplies(store, 'mock')[0]!.body.text).toBe('approved and done');
  });

  it('the watchdog is PAUSED while waitingOn is set (turn not force-drained) and resumes on approval', async () => {
    const built: ApprovalAdapter[] = [];
    const { binder, store } = makeBinder({
      build: (t) => {
        const a = new ApprovalAdapter(t);
        built.push(a);
        return a;
      },
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      watchdogMs: 25,
    });
    const t1msg = post(store, binder, '@mock approve one', ['mock']);
    await waitFor(() => built.length === 1 && built[0]!.sendCalls.length === 1);
    const a = built[0]!;
    await waitFor(() =>
      systemRows(store).some((m) => m.body.text.includes('requests approval'))
    );
    post(store, binder, '@mock two', ['mock']); // queues behind the parked turn
    // Well past the 25ms watchdog: a fired watchdog would finishTurn → pump → T2.
    await new Promise((r) => setTimeout(r, 90));
    expect(a.sendCalls).toHaveLength(1); // PAUSED: T2 not pumped

    const requestId = `appr-chturn-${t1msg.id}-mock`;
    await binder.respondToApproval(CH, 'mock', requestId, { kind: 'accept' });
    await waitFor(() => a.sendCalls.length === 2, 4000); // resumes → T2 drains
    expect(a.sendCalls).toHaveLength(2);
  });

  it('an approval that never resolves is still recoverable via interrupt', async () => {
    const built: ApprovalAdapter[] = [];
    const { binder, store } = makeBinder({
      build: (t) => {
        const a = new ApprovalAdapter(t);
        built.push(a);
        return a;
      },
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      watchdogMs: 10_000, // watchdog never fires in-window: recovery is via interrupt
    });
    post(store, binder, '@mock approve stuck', ['mock']);
    await waitFor(() => built.length === 1 && built[0]!.sendCalls.length === 1);
    const a = built[0]!;
    await waitFor(() =>
      systemRows(store).some((m) => m.body.text.includes('requests approval'))
    );
    post(store, binder, '@mock next', ['mock']); // queues behind the stuck turn
    await new Promise((r) => setTimeout(r, 30));
    expect(a.sendCalls).toHaveLength(1);

    await binder.interrupt(CH, 'mock'); // operator recovery
    await waitFor(() => a.sendCalls.length === 2, 4000); // parked turn drained
    expect(a.interruptCalls).toHaveLength(1);
    expect(a.sendCalls).toHaveLength(2);
  });

  it('the trailing idle live-state during an approval never finalizes the turn (#1181 re-review)', async () => {
    const built: ApprovalAdapter[] = [];
    const { binder, store } = makeBinder({
      build: (t) => {
        const a = new ApprovalAdapter(t);
        built.push(a);
        return a;
      },
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      watchdogMs: 25,
    });
    const t1 = post(store, binder, '@mock please approve', ['mock']);
    await waitFor(() => built.length === 1 && built[0]!.sendCalls.length === 1);
    const a = built[0]!;
    await waitFor(() =>
      systemRows(store).some((m) => m.body.text.includes('requests approval'))
    );
    // Queue a second turn behind the parked (approval-pending) turn.
    post(store, binder, '@mock two', ['mock']);

    // Well past the 25ms watchdog: the trailing bare `idle` live-state must NOT
    // have finalized the turn (which would pump T2) nor re-armed the watchdog
    // (which would force-drain the parked turn and pump T2). Without the guard
    // this is where the concurrent turn leaks.
    await new Promise((r) => setTimeout(r, 90));
    expect(a.sendCalls).toHaveLength(1); // T2 NOT pumped — turn stayed parked
    // Presence stayed 'waiting' — never flipped to idle/thinking mid-approval.
    expect(
      (await binder.rosterForChannel(CH)).find((r) => r.id === 'mock')!.binding
        ?.status
    ).toBe('waiting');

    // Resolving the approval resumes the turn: it completes normally, then T2 drains.
    const requestId = `appr-chturn-${t1.id}-mock`;
    await binder.respondToApproval(CH, 'mock', requestId, { kind: 'accept' });
    await waitFor(() => agentReplies(store, 'mock').length === 1, 4000);
    expect(agentReplies(store, 'mock')[0]!.body.text).toBe('approved and done');
    await waitFor(() => a.sendCalls.length === 2, 4000); // queued turn drained
    expect(a.sendCalls).toHaveLength(2);
  });
});
