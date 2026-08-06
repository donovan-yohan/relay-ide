import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MockProtocolAdapterV2 } from '../server/protocol-adapters/mock-v2-adapter.js';
import {
  AgentSteerRejectedError,
  BaseProtocolAdapterV2,
  type AdapterConfig,
  type AdapterStatus,
  type AgentApprovalResponseInputV2,
  type AgentInterruptInputV2,
  type AgentSendMessageInputV2,
  type ProtocolAdapterV2,
} from '../server/protocol-adapter-v2.js';
import type { AgentCapabilitySetV2 } from '../shared/agent-chat-protocol-v2.js';
import type { AgentRole } from '../shared/agent-roster.js';
import { builtInAgentProfileId } from '../shared/agent-profile.js';
import {
  dmChannelCreateInput,
  dmChannelTopicId,
} from '../shared/dm-channels.js';
import {
  createAgentProfileStore,
  type AgentProfileStore,
} from '../server/agent-profile-store.js';
import {
  createChannelMessageStore,
  type ChannelMessageStore,
} from '../server/channel-message-store.js';
import { createChannelHub, type ChannelHub } from '../server/channel-hub.js';
import type { ChannelAttachmentStore } from '../server/channel-attachments.js';
import {
  CHANNEL_BINDING_YOLO_DEFAULT,
  ChannelAgentBusyError,
  createChannelAgentBinder,
  MAX_CONSECUTIVE_AGENT_TURNS,
  type BinderRuntimes,
  type ChannelAgentBinder,
  type MentionTarget,
} from '../server/channel-agent-binder.js';
import type {
  ChannelAgentRuntime,
  CreateChannelAgentRuntimeParams,
} from '../server/channel-agent-runtime.js';
import {
  createWorkspaceTopicStore,
  type WorkspaceTopicStore,
} from '../server/workspace-topics.js';
import {
  channelTurnId,
  parseMentions,
  CHANNEL_RETRY_OF_META_KEY,
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
const CLAUDE_AGENT_SENDER: ChannelSenderRef = {
  kind: 'agent',
  id: 'agent-profile:claude:default',
  providerId: 'claude',
  displayName: 'Claude',
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
      !m.agentDetail &&
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
  knownIds: string[],
  runtimeId = 'runtime:orchestrator',
  sender: ChannelSenderRef = AGENT_SENDER
): ChannelMessage {
  const mentions = parseMentions(text, knownIds);
  const stream = store.beginStream({
    channelId: CH,
    sender,
    source: { runtimeId, turnId, itemId },
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

// ── steerable adapter (#1308 slice 4 mid-turn steering) ──────────────────────
// Every send opens a turn that streams one partial chunk and then STALLS, so a
// turn is reliably live when the next post lands. `interrupt` emits the same
// terminal patch a real cancellation produces; `complete` finishes naturally.
// Tracks the set of turns the adapter believes are open so a double dispatch is
// OBSERVED (concurrentPeak > 1) rather than inferred from send counts.
class SteerableAdapter extends BaseProtocolAdapterV2 {
  readonly runtimeOwnership = 'spawned' as const;
  readonly capabilities: AgentCapabilitySetV2;
  readonly sendCalls: string[] = [];
  readonly sendInputs: AgentSendMessageInputV2[] = [];
  readonly steerAttempts: AgentSendMessageInputV2[] = [];
  readonly steerInputs: AgentSendMessageInputV2[] = [];
  readonly interruptCalls: string[] = [];
  /** Peak simultaneously-open turns; the binder must never let this exceed 1. */
  concurrentPeak = 0;
  private readonly open = new Set<string>();
  private _status: AdapterStatus = 'disconnected';
  private sid = 'steerable';

  constructor(
    readonly agentType: string,
    private readonly supportsSafeBoundarySteer = false,
    private readonly rejectsSafeBoundarySteer = false,
    private readonly failsSafeBoundarySteer = false,
    private readonly hangsSafeBoundarySteer = false
  ) {
    super();
    this.capabilities = {
      text: true,
      queue: false,
      steer: supportsSafeBoundarySteer,
      interrupt: true,
      approvals: false,
      streaming: true,
    };
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
    this.sendCalls.push(input.turnId);
    this.sendInputs.push(input);
    this.open.add(input.turnId);
    this.concurrentPeak = Math.max(this.concurrentPeak, this.open.size);
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
        type: 'assistantMessage',
        id: `a-${input.turnId}`,
        text: '',
      },
    });
    this.emitPatch({
      type: 'agent-item-delta-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId: input.turnId,
      itemId: `a-${input.turnId}`,
      delta: { text: 'partial…' },
    });
    // No terminal patch: the turn stays live until interrupt() or complete().
  }

  async steerMessage(input: AgentSendMessageInputV2): Promise<void> {
    this.steerAttempts.push(input);
    if (!this.supportsSafeBoundarySteer) {
      throw new Error('safe-boundary steering unavailable');
    }
    if (this.rejectsSafeBoundarySteer) {
      throw new AgentSteerRejectedError('activeTurnNotSteerable');
    }
    if (this.failsSafeBoundarySteer) {
      throw new Error('steer transport reset');
    }
    if (this.hangsSafeBoundarySteer) {
      return new Promise<void>(() => {});
    }
    this.steerInputs.push(input);
  }

  async interrupt(input: AgentInterruptInputV2): Promise<void> {
    const turnId = input.turnId ?? [...this.open][0];
    if (turnId === undefined) return;
    this.interruptCalls.push(turnId);
    this.closeTurn(turnId, 'interrupted');
  }

  /** Finish the newest live turn the way a normal completion would. */
  completeLatest(text = 'done'): void {
    const turnId = this.sendCalls[this.sendCalls.length - 1];
    if (turnId === undefined) return;
    this.emitPatch({
      type: 'agent-item-updated-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId,
      item: {
        type: 'assistantMessage',
        id: `a-${turnId}`,
        text,
        status: 'completed',
      },
    });
    this.closeTurn(turnId, 'completed');
  }

  private closeTurn(
    turnId: string,
    status: 'completed' | 'interrupted' | 'failed'
  ): void {
    if (!this.open.delete(turnId)) return;
    this.emitPatch({
      type: 'agent-turn-completed-v2',
      sessionId: this.sid,
      timestamp: 't',
      turnId,
      status,
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

// ── parked-on-approval adapter (#1307) ───────────────────────────────────────
// Opens a turn and parks it on an approval, which is the ONE state the watchdog
// deliberately refuses to force-drain (draining it would abandon the approval).
// Presence therefore has no timer under it: if the runtime dies here without a
// terminal transition, the header chip and the in-timeline presence row stay
// busy forever. `die()` models the unexpected process/transport death an adapter
// reports as a `disconnected` live state; the runtime can also be made to vanish
// from the registry with no notification at all (`forgetWithoutEnd`).
class ParkedOnApprovalAdapter extends BaseProtocolAdapterV2 {
  readonly runtimeOwnership = 'spawned' as const;
  readonly capabilities: AgentCapabilitySetV2 = {
    text: true,
    streaming: true,
    interrupt: true,
  };
  readonly sendCalls: string[] = [];
  private _status: AdapterStatus = 'disconnected';
  private sid = 'parked';

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
  async respondToApproval(_i: AgentApprovalResponseInputV2): Promise<void> {}
  async respondToInput(): Promise<void> {}

  async sendMessage(input: AgentSendMessageInputV2): Promise<void> {
    this.sendCalls.push(input.turnId);
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
    this.emitPatch({
      type: 'agent-live-state-updated-v2',
      sessionId: this.sid,
      timestamp: 't',
      live: {
        status: 'waiting',
        activeTurnId: input.turnId,
        waitingOn: 'approval',
        error: null,
      },
    });
  }

  /** Unexpected process death, as codex reports it when its client closes. */
  die(): void {
    this._status = 'disconnected';
    this.emitPatch({
      type: 'agent-live-state-updated-v2',
      sessionId: this.sid,
      timestamp: 't',
      live: {
        status: 'disconnected',
        activeTurnId: null,
        waitingOn: null,
        activeRequestIds: [],
        queueLength: 0,
      },
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
  sessions: BinderRuntimes;
  spawns: () => number;
  firstSessionId: () => string;
  adapterFor: (sessionId: string) => ProtocolAdapterV2;
  fireEnd: (sessionId: string) => void;
  forgetWithoutEnd: (sessionId: string) => void;
  registerSourceSession: (sessionId: string, role: AgentRole) => void;
  registerRestoredRuntime: (
    sessionId: string,
    agentType: string,
    role: AgentRole,
    profileId?: string
  ) => Promise<void>;
  lastCreateParams: () => CreateChannelAgentRuntimeParams | undefined;
  createParams: () => CreateChannelAgentRuntimeParams[];
}

function makeSessions(
  build: (agentType: string) => ProtocolAdapterV2,
  opts: { throwOnCreate?: boolean; gate?: Promise<void> } = {}
): SessionsHarness {
  const created = new Map<string, { runtime: ChannelAgentRuntime }>();
  const order: string[] = [];
  const endCbs: Array<(id: string) => void> = [];
  let spawns = 0;
  let lastParams: CreateChannelAgentRuntimeParams | undefined;
  const createParams: CreateChannelAgentRuntimeParams[] = [];
  const sessions: BinderRuntimes = {
    async create(params) {
      spawns++;
      lastParams = params;
      createParams.push(params);
      if (opts.throwOnCreate) throw new Error('boom: spawn failed');
      // Optional gate: park the spawn so a test can drive a close()/reorder race
      // between runtime creation being invoked and its continuation resuming.
      if (opts.gate) await opts.gate;
      const id = `sess-${spawns}-${params.providerId}`;
      const adapter = build(params.providerId);
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
        ...(params.role !== undefined ? { role: params.role } : {}),
        status: 'active',
        adapter,
        cwd: params.cwd,
        providerSession: {},
      } as unknown as ChannelAgentRuntime;
      created.set(id, { runtime });
      order.push(id);
      return runtime;
    },
    get(id) {
      return created.get(id)?.runtime;
    },
    async destroy(id) {
      if (!created.delete(id)) return;
      for (const cb of [...endCbs]) cb(id);
    },
    onRuntimeEnd(cb) {
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
    adapterFor: (id) => created.get(id)!.runtime.adapter,
    fireEnd: (id) => {
      created.delete(id);
      for (const cb of [...endCbs]) cb(id);
    },
    forgetWithoutEnd: (id) => {
      created.delete(id);
    },
    registerSourceSession: (id, role) => {
      created.set(id, {
        runtime: { id, role } as unknown as ChannelAgentRuntime,
      });
    },
    registerRestoredRuntime: async (id, agentType, role, profileId) => {
      const adapter = build(agentType);
      await adapter.connect({
        cwd: '/tmp',
        port: 0,
        sessionId: id,
        hookToken: 't',
        configDir: '/tmp',
      });
      created.set(id, {
        runtime: {
          id,
          providerId: agentType,
          profileActorId: profileId ?? builtInAgentProfileId(agentType),
          role,
          status: 'active',
          adapter,
          cwd: '/tmp',
          providerSession: {},
        } as unknown as ChannelAgentRuntime,
      });
    },
    lastCreateParams: () => lastParams,
    createParams: () => createParams,
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
  presenceSweepMs?: number;
  throwOnCreate?: boolean;
  yolo?: boolean;
  gate?: Promise<void>;
  attachmentStore?: ChannelAttachmentStore;
  agentProfileStore?: AgentProfileStore | null;
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
    ...(cfg.agentProfileStore !== undefined
      ? { agentProfileStore: cfg.agentProfileStore }
      : {}),
    runtimes: sessions.sessions,
    knownProviderIds: cfg.knownProviderIds,
    mentionTargets: async () => cfg.targets,
    port: 0,
    configDir: '/tmp',
    ...(cfg.watchdogMs !== undefined ? { watchdogMs: cfg.watchdogMs } : {}),
    ...(cfg.presenceSweepMs !== undefined
      ? { presenceSweepMs: cfg.presenceSweepMs }
      : {}),
    ...(cfg.yolo !== undefined ? { yolo: cfg.yolo } : {}),
  });
  cleanup.push(() => binder.close());
  return { binder, store, hub, sessions };
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('channel-agent-binder — lifecycle', () => {
  it('keeps same-provider profiles isolated: bindings, sessions, replies, roster, and status all use profile actor ids', async () => {
    const profiles = createAgentProfileStore(':memory:');
    cleanup.push(() => profiles.close());
    profiles.seedBuiltIns([{ id: 'mock' }]);
    const backend = profiles.create({
      id: 'agent-profile:mock:backend',
      providerId: 'mock',
      displayName: 'Backend',
      model: 'mock-model',
      provider: 'mock-provider',
      effort: 'high',
      envVars: { PROFILE_TEST_FLAG: '1' },
      systemPrompt: 'Review the backend boundary.',
    });
    const reviewer = profiles.create({
      id: 'agent-profile:mock:reviewer',
      providerId: 'mock',
      displayName: 'Reviewer',
    });
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      agentProfileStore: profiles,
    });
    const statusAgentIds = new Set<string>();
    binder.setStatusBroadcaster((_type, data) => {
      if (typeof data['agentId'] === 'string')
        statusAgentIds.add(data['agentId']);
    });

    post(store, binder, '@Backend one', ['mock']);
    await waitFor(() => sessions.spawns() === 1);
    expect(sessions.lastCreateParams()).toMatchObject({
      providerId: 'mock',
      profileActorId: backend.id,
      model: 'mock-model',
      processEnv: { PROFILE_TEST_FLAG: '1' },
      systemPrompt: 'Review the backend boundary.',
      extra: { provider: 'mock-provider', effort: 'high' },
    });
    post(store, binder, '@Reviewer two', ['mock']);
    await waitFor(() => sessions.spawns() === 2);
    expect(store.getBinding(CH, backend.id)?.runtimeId).toBeTruthy();
    expect(store.getBinding(CH, reviewer.id)?.runtimeId).toBeTruthy();

    // A second mention of Backend reuses only Backend's pinned profile runtime.
    post(store, binder, '@Backend again', ['mock']);
    await waitFor(() => agentReplies(store, 'mock').length === 3);
    expect(sessions.spawns()).toBe(2);
    expect(agentReplies(store, 'mock').map((reply) => reply.sender.id)).toEqual(
      expect.arrayContaining([backend.id, reviewer.id])
    );
    const roster = await binder.rosterForChannel(CH);
    expect(roster.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([backend.id, reviewer.id])
    );
    expect(statusAgentIds.has(backend.id)).toBe(true);
    expect(statusAgentIds.has(reviewer.id)).toBe(true);
  });

  it('keeps the default-only provider path on one reusable built-in profile identity', async () => {
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const defaultId = builtInAgentProfileId('mock');
    const statusIds = new Set<string>();
    binder.setStatusBroadcaster((_type, data) => {
      if (typeof data['agentId'] === 'string') statusIds.add(data['agentId']);
    });
    post(store, binder, '@mock first', ['mock']);
    post(store, binder, '@mock second', ['mock']);
    await waitFor(() => agentReplies(store, 'mock').length === 2);
    expect(sessions.spawns()).toBe(1);
    expect(store.getBinding(CH, defaultId)?.runtimeId).toBeTruthy();
    expect(
      agentReplies(store, 'mock').every((row) => row.sender.id === defaultId)
    ).toBe(true);
    expect(
      (await binder.rosterForChannel(CH)).find((row) => row.id === defaultId)
        ?.binding
    ).not.toBeNull();
    expect(statusIds.has(defaultId)).toBe(true);
  });

  it('routes a named profile mention from the assistant-finalized contacts parser path', async () => {
    const profiles = createAgentProfileStore(':memory:');
    cleanup.push(() => profiles.close());
    profiles.seedBuiltIns([{ id: 'mock' }]);
    profiles.create({
      id: 'agent-profile:mock:backend-finalizer',
      providerId: 'mock',
      displayName: 'Backend',
    });
    const reviewer = profiles.create({
      id: 'agent-profile:mock:reviewer-finalizer',
      providerId: 'mock',
      displayName: 'Reviewer',
    });
    const { binder, store, sessions } = makeBinder({
      build: (agentType) =>
        new ScriptedAdapter(agentType, {
          mode: 'reply',
          text: '@Reviewer take this.',
        }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      agentProfileStore: profiles,
    });

    post(store, binder, '@Backend begin', ['mock']);
    await waitFor(() => sessions.spawns() === 2);
    expect(store.getBinding(CH, reviewer.id)?.runtimeId).toBeTruthy();
  });

  it('keeps a persisted profile mention pinned across a rename/collision reparse', async () => {
    const profiles = createAgentProfileStore(':memory:');
    cleanup.push(() => profiles.close());
    profiles.seedBuiltIns([{ id: 'mock' }]);
    const pinned = profiles.create({
      id: 'agent-profile:mock:renamed',
      providerId: 'mock',
      displayName: 'Backend',
    });
    profiles.create({
      id: 'agent-profile:mock:current-reviewer',
      providerId: 'mock',
      displayName: 'Reviewer',
    });
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      agentProfileStore: profiles,
    });
    const message = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: '@Reviewer please inspect',
      mentions: [
        { raw: '@Reviewer', providerId: 'mock', profileId: pinned.id },
      ],
    });
    binder.handleMessagePosted(message, message.mentions ?? []);
    await waitFor(() => sessions.spawns() === 1);
    expect(store.getBinding(CH, pinned.id)?.runtimeId).toBeTruthy();
    expect(
      store.getBinding(CH, 'agent-profile:mock:current-reviewer')
    ).toBeNull();
  });

  it('designates an orchestrator without submitting a turn', async () => {
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });

    const binding = await binder.ensureOrchestrator(CH, 'mock');

    expect(binding.runtimeId).toBe(sessions.firstSessionId());
    expect(sessions.lastCreateParams()).toMatchObject({
      providerId: 'mock',
      role: 'orchestrator',
    });
    expect(agentReplies(store)).toHaveLength(0);
  });

  it('reuses a restored orchestrator binding', async () => {
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const sessionId = 'session:restored-driver';
    await sessions.registerRestoredRuntime(sessionId, 'mock', 'orchestrator');
    store.upsertBinding({
      channelId: CH,
      profileActorId: builtInAgentProfileId('mock'),
      agentFramework: 'mock',
      runtimeId: sessionId,
    });

    const binding = await binder.ensureOrchestrator(CH, 'mock');

    expect(binding.runtimeId).toBe(sessionId);
    expect(sessions.spawns()).toBe(0);
  });

  it('reuses an explicitly selected profile-pinned restored orchestrator', async () => {
    const profiles = createAgentProfileStore(':memory:');
    cleanup.push(() => profiles.close());
    profiles.seedBuiltIns([{ id: 'mock' }]);
    const reviewer = profiles.create({
      id: 'reviewer',
      providerId: 'mock',
      displayName: 'Reviewer',
    });
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      agentProfileStore: profiles,
    });
    const sessionId = 'session:restored-profile';
    await sessions.registerRestoredRuntime(
      sessionId,
      'mock',
      'orchestrator',
      reviewer.id
    );
    store.upsertBinding({
      channelId: CH,
      profileActorId: reviewer.id,
      agentFramework: 'mock',
      runtimeId: sessionId,
    });

    expect(
      (await binder.ensureOrchestrator(CH, 'mock', reviewer.id)).runtimeId
    ).toBe(sessionId);
    expect(sessions.spawns()).toBe(0);
    // Exact custom actor ids are accepted by the control lookup; a legacy
    // prefix rewrite would miss this live binding as "not found".
    await expect(binder.interrupt(CH, reviewer.id)).rejects.toThrow(
      /no active turn/
    );
  });

  it('does not reuse an unpinned legacy session for a custom profile', async () => {
    const profiles = createAgentProfileStore(':memory:');
    cleanup.push(() => profiles.close());
    profiles.seedBuiltIns([{ id: 'mock' }]);
    const reviewer = profiles.create({
      id: 'reviewer',
      providerId: 'mock',
      displayName: 'Reviewer',
    });
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      agentProfileStore: profiles,
    });
    await sessions.registerRestoredRuntime(
      'session:legacy',
      'mock',
      'orchestrator'
    );
    store.upsertBinding({
      channelId: CH,
      profileActorId: reviewer.id,
      agentFramework: 'mock',
      runtimeId: 'session:legacy',
    });

    expect(
      (await binder.ensureOrchestrator(CH, 'mock', reviewer.id)).runtimeId
    ).not.toBe('session:legacy');
    expect(sessions.spawns()).toBe(1);
  });

  it('does not reuse a different custom profile restored session for the same provider', async () => {
    const profiles = createAgentProfileStore(':memory:');
    cleanup.push(() => profiles.close());
    profiles.seedBuiltIns([{ id: 'mock' }]);
    const profileA = profiles.create({
      id: 'profile-a',
      providerId: 'mock',
      displayName: 'Reviewer A',
    });
    const profileB = profiles.create({
      id: 'profile-b',
      providerId: 'mock',
      displayName: 'Reviewer B',
    });
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      agentProfileStore: profiles,
    });
    await sessions.registerRestoredRuntime(
      'session:profile-a',
      'mock',
      'orchestrator',
      profileA.id
    );
    store.upsertBinding({
      channelId: CH,
      profileActorId: profileB.id,
      agentFramework: 'mock',
      runtimeId: 'session:profile-a',
    });

    const binding = await binder.ensureOrchestrator(CH, 'mock', profileB.id);
    expect(binding.runtimeId).not.toBe('session:profile-a');
    expect(sessions.spawns()).toBe(1);
    expect(sessions.lastCreateParams()).toMatchObject({
      profileActorId: profileB.id,
    });
    expect(store.getBinding(CH, profileB.id)).toMatchObject({
      profileActorId: profileB.id,
      runtimeId: binding.runtimeId,
    });
  });

  it('rejects a restored healthy non-orchestrator binding', async () => {
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const sessionId = 'session:restored-worker';
    await sessions.registerRestoredRuntime(sessionId, 'mock', 'implementer');
    store.upsertBinding({
      channelId: CH,
      profileActorId: builtInAgentProfileId('mock'),
      agentFramework: 'mock',
      runtimeId: sessionId,
    });

    await expect(binder.ensureOrchestrator(CH, 'mock')).rejects.toThrow(
      /already binds @mock.*role implementer/
    );
    expect(sessions.spawns()).toBe(0);
    expect(store.getBinding(CH, builtInAgentProfileId('mock'))?.runtimeId).toBe(
      sessionId
    );
  });

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
    expect(reply.sender.id).toBe('agent-profile:mock:default');
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
    const profiles = createAgentProfileStore(':memory:');
    cleanup.push(() => profiles.close());
    profiles.seedBuiltIns([{ id: 'mock' }]);
    profiles.create({
      id: 'agent-profile:mock:backend-error',
      providerId: 'mock',
      displayName: 'Backend',
    });
    const { binder, store, sessions } = makeBinder({
      build: (agentType) => new ManualBareIdleAdapter(agentType),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      agentProfileStore: profiles,
    });
    post(store, binder, '@Backend idle', ['mock']);
    await waitFor(() => sessions.spawns() === 1);
    expect(sessions.lastCreateParams()?.displayName).toBe(`#${CH} · Backend`);
    const adapter = sessions.adapterFor(
      sessions.firstSessionId()
    ) as ManualBareIdleAdapter;
    await waitFor(() => adapter.sendCalls.length === 1);
    adapter.emitError('idle failure');
    await waitFor(() =>
      systemRows(store).some(
        (row) => row.body.text === '@Backend errored: idle failure'
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

  // #1308 slice 4 changed what the cap means for the operator's own lane: a
  // contiguous human run drains as ONE turn, so an overflowing post supersedes
  // the queue tail (identical trigger + packet) instead of being announced as
  // dropped for a turn that was never going to exist. The drop row is still the
  // honest answer whenever superseding would NOT be equivalent.
  it('supersedes rather than drops when an over-cap post coalesces with the tail', async () => {
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
    for (let i = 0; i < 12; i++) {
      post(store, binder, `@stall ${i}`, ['stall'], OPERATOR, root.id);
    }
    await new Promise((r) => setTimeout(r, 120));
    expect(
      systemRows(store).filter((m) => m.body.text.includes('message dropped'))
    ).toHaveLength(0);
  });

  it('queue overflow past the cap drops a non-coalescing message with a system row', async () => {
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
    const rootA = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'root a',
    });
    const rootB = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'root b',
    });
    // One live turn plus a full cap of thread-A posts.
    for (let i = 0; i < 9; i++) {
      post(store, binder, `@stall a${i}`, ['stall'], OPERATOR, rootA.id);
    }
    await new Promise((r) => setTimeout(r, 120));
    // A thread-B post cannot be represented by the thread-A tail, so the cap
    // refuses it explicitly rather than silently losing it.
    const overflow = post(
      store,
      binder,
      '@stall b0',
      ['stall'],
      OPERATOR,
      rootB.id
    );
    await waitFor(() =>
      systemRows(store).some((m) => m.body.text.includes('message dropped'))
    );
    const dropped = systemRows(store).filter((m) =>
      m.body.text.includes('message dropped')
    );
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.body.text).toContain('has 8 messages pending');
    expect(dropped[0]!.threadId).toBe(rootB.id);
    expect(dropped[0]!.parentMessageId).toBe(overflow.id);
  });

  it('runtime death unbinds, clears the binding, and respawns on next mention', async () => {
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    post(store, binder, '@mock one', ['mock']);
    await waitFor(() => agentReplies(store, 'mock').length === 1);
    const sid = sessions.firstSessionId();
    sessions.fireEnd(sid);
    expect(
      store.getBinding(CH, builtInAgentProfileId('mock'))?.runtimeId
    ).toBeNull();
    post(store, binder, '@mock two', ['mock']);
    await waitFor(() => agentReplies(store, 'mock').length === 2);
    expect(sessions.spawns()).toBe(2);
  });

  it('threads runtime-ended rows for queued trigger messages', async () => {
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
      systemRows(store).some((m) => m.body.text.includes('runtime ended'))
    );
    const ended = systemRows(store).find((m) =>
      m.body.text.includes('runtime ended')
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

  it('keeps a saved provider conversation intact across failed recovery attempts', async () => {
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2(),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      throwOnCreate: true,
    });
    const profileActorId = builtInAgentProfileId('mock');
    store.upsertBinding({
      channelId: CH,
      profileActorId,
      agentFramework: 'mock',
      runtimeId: 'stale-runtime',
      providerSession: { threadId: 'durable-provider-thread' },
    });

    await expect(binder.ensureBinding(CH, 'mock')).rejects.toThrow(
      'spawn failed'
    );
    await expect(binder.ensureBinding(CH, 'mock')).rejects.toThrow(
      'spawn failed'
    );

    expect(sessions.createParams()).toEqual([
      expect.objectContaining({
        providerSession: { threadId: 'durable-provider-thread' },
      }),
      expect.objectContaining({
        providerSession: { threadId: 'durable-provider-thread' },
      }),
    ]);
    expect(store.getBinding(CH, profileActorId)?.providerSession).toEqual({
      threadId: 'durable-provider-thread',
    });
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
    const expected = `chturn-${trigger.id}-${builtInAgentProfileId('x')}`;
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
        store.getBinding(CH, builtInAgentProfileId('mock'))?.providerSession[
          'lastDeliveredSeq'
        ] === trigger.seq
    );
    expect(
      store.getBinding(CH, builtInAgentProfileId('mock'))?.providerSession[
        'lastDeliveredSeq'
      ]
    ).toBe(trigger.seq);
  });
});

describe('channel-agent-binder — agent-to-agent brake', () => {
  it('does not grant the brake exemption from a self-declared orchestrator presence role', async () => {
    const { binder, store } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });

    for (let index = 0; index < MAX_CONSECUTIVE_AGENT_TURNS; index += 1) {
      postAgentTurnRow(
        store,
        binder,
        `self-declared-${index}`,
        'item-0',
        `@mock self-declared orchestrator ${index}`,
        ['mock'],
        'session:not-registered',
        AGENT_SENDER
      );
    }
    await waitFor(
      () => agentReplies(store, 'mock').length === MAX_CONSECUTIVE_AGENT_TURNS
    );

    postAgentTurnRow(
      store,
      binder,
      'self-declared-cap',
      'item-0',
      '@mock should be braked',
      ['mock'],
      'session:not-registered',
      AGENT_SENDER
    );
    await waitFor(() =>
      systemRows(store).some((message) =>
        message.body.text.includes('Mention chain paused')
      )
    );
    expect(agentReplies(store, 'mock')).toHaveLength(
      MAX_CONSECUTIVE_AGENT_TURNS
    );
  });

  it('does not charge orchestrator turns against the worker-turn allowance', async () => {
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const driverSessionId = 'session:driver';
    const workerSessionId = 'session:worker';
    sessions.registerSourceSession(driverSessionId, 'orchestrator');
    sessions.registerSourceSession(workerSessionId, 'implementer');

    for (let index = 0; index < MAX_CONSECUTIVE_AGENT_TURNS + 1; index += 1) {
      postAgentTurnRow(
        store,
        binder,
        `driver-turn-${index}`,
        'item-0',
        `@mock coordinate ${index}`,
        ['mock'],
        driverSessionId,
        CLAUDE_AGENT_SENDER
      );
    }
    await waitFor(
      () =>
        agentReplies(store, 'mock').length === MAX_CONSECUTIVE_AGENT_TURNS + 1
    );
    expect(
      systemRows(store).filter((message) =>
        message.body.text.includes('Mention chain paused')
      )
    ).toHaveLength(0);

    for (let index = 0; index < MAX_CONSECUTIVE_AGENT_TURNS; index += 1) {
      postAgentTurnRow(
        store,
        binder,
        `worker-turn-${index}`,
        'item-0',
        `@mock worker ${index}`,
        ['mock'],
        workerSessionId,
        AGENT_SENDER
      );
    }
    await waitFor(
      () =>
        agentReplies(store, 'mock').length ===
        MAX_CONSECUTIVE_AGENT_TURNS * 2 + 1
    );
    postAgentTurnRow(
      store,
      binder,
      'worker-turn-cap',
      'item-0',
      '@mock worker cap',
      ['mock'],
      workerSessionId,
      AGENT_SENDER
    );
    await waitFor(() =>
      systemRows(store).some((message) =>
        message.body.text.includes('Mention chain paused')
      )
    );
    expect(agentReplies(store, 'mock')).toHaveLength(
      MAX_CONSECUTIVE_AGENT_TURNS * 2 + 1
    );
  });

  it('lets the orchestrator route through a paused brake while human reset restores workers', async () => {
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const driverSessionId = 'session:driver';
    const workerSessionId = 'session:worker';
    sessions.registerSourceSession(driverSessionId, 'orchestrator');
    sessions.registerSourceSession(workerSessionId, 'implementer');

    for (let index = 0; index < MAX_CONSECUTIVE_AGENT_TURNS; index += 1) {
      postAgentTurnRow(
        store,
        binder,
        `worker-pause-${index}`,
        'item-0',
        `@mock worker ${index}`,
        ['mock'],
        workerSessionId,
        AGENT_SENDER
      );
    }
    await waitFor(
      () => agentReplies(store, 'mock').length === MAX_CONSECUTIVE_AGENT_TURNS
    );
    postAgentTurnRow(
      store,
      binder,
      'worker-pause-cap',
      'item-0',
      '@mock pause',
      ['mock'],
      workerSessionId,
      AGENT_SENDER
    );
    await waitFor(() =>
      systemRows(store).some((message) =>
        message.body.text.includes('Mention chain paused')
      )
    );

    postAgentTurnRow(
      store,
      binder,
      'driver-after-pause',
      'item-0',
      '@mock keep coordinating',
      ['mock'],
      driverSessionId,
      CLAUDE_AGENT_SENDER
    );
    await waitFor(
      () =>
        agentReplies(store, 'mock').length === MAX_CONSECUTIVE_AGENT_TURNS + 1
    );
    expect(
      systemRows(store).filter((message) =>
        message.body.text.includes('Mention chain paused')
      )
    ).toHaveLength(1);

    post(store, binder, '@mock human reset', ['mock'], OPERATOR);
    await waitFor(
      () =>
        agentReplies(store, 'mock').length === MAX_CONSECUTIVE_AGENT_TURNS + 2
    );
    postAgentTurnRow(
      store,
      binder,
      'worker-after-reset',
      'item-0',
      '@mock worker resumed',
      ['mock'],
      workerSessionId,
      AGENT_SENDER
    );
    await waitFor(
      () =>
        agentReplies(store, 'mock').length === MAX_CONSECUTIVE_AGENT_TURNS + 3
    );
  });

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
  it('includes the default profile for an unseeded target provider without duplicating stored providers', async () => {
    const profiles = createAgentProfileStore(':memory:');
    cleanup.push(() => profiles.close());
    profiles.seedBuiltIns([{ id: 'mock' }]);
    const { binder } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: [
        ...MOCK_TARGETS,
        {
          id: 'worker',
          displayName: 'Worker',
          kind: 'framework',
          available: true,
          reason: null,
        },
      ],
      knownProviderIds: ['mock', 'worker'],
      agentProfileStore: profiles,
    });

    const roster = await binder.rosterForChannel(CH);
    expect(roster.filter((entry) => entry.providerId === 'mock')).toHaveLength(
      1
    );
    expect(roster).toContainEqual(
      expect.objectContaining({
        id: builtInAgentProfileId('worker'),
        providerId: 'worker',
        isDefault: true,
      })
    );
  });

  it('surfaces bound session roles in the channel roster', async () => {
    const { binder, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: [
        ...MOCK_TARGETS,
        {
          id: 'worker',
          displayName: 'Worker',
          kind: 'framework',
          available: true,
          reason: null,
        },
      ],
      knownProviderIds: ['mock', 'worker'],
    });

    await binder.ensureOrchestrator(CH, 'mock');
    await binder.ensureBinding(CH, 'worker');

    const roster = await binder.rosterForChannel(CH);
    expect(
      roster.find((entry) => entry.id === builtInAgentProfileId('mock'))?.role
    ).toBe('orchestrator');
    expect(
      roster.find((entry) => entry.id === builtInAgentProfileId('worker'))?.role
    ).toBeUndefined();
    expect(sessions.spawns()).toBe(2);
  });

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
          reason: 'Codex is not currently available in channels.',
        },
      ],
      knownProviderIds: ['mock', 'codex'],
    });
    let roster = await binder.rosterForChannel(CH);
    const codex = roster.find((r) => r.id === builtInAgentProfileId('codex'))!;
    expect(codex.available).toBe(false);
    expect(codex.reason).toContain('not currently available in channels');
    expect(
      roster.find((r) => r.id === builtInAgentProfileId('mock'))!.binding
    ).toBeNull();

    post(store, binder, '@mock hi', ['mock', 'codex']);
    await waitFor(() => agentReplies(store, 'mock').length === 1);
    roster = await binder.rosterForChannel(CH);
    expect(
      roster.find((r) => r.id === builtInAgentProfileId('mock'))!.binding
    ).not.toBeNull();
    expect(
      roster.find((r) => r.id === builtInAgentProfileId('mock'))!.binding
        ?.status
    ).toBe('idle');
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
      if (data['agentId'] === builtInAgentProfileId('hermes'))
        statuses.push(String(data['status']));
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

  it('an unavailable named profile posts a de-advertise row, rate-limited', async () => {
    const profiles = createAgentProfileStore(':memory:');
    cleanup.push(() => profiles.close());
    profiles.seedBuiltIns([{ id: 'codex' }]);
    profiles.create({
      id: 'agent-profile:codex:backend-unavailable',
      providerId: 'codex',
      displayName: 'Backend',
    });
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2(),
      targets: [
        {
          id: 'codex',
          displayName: 'Codex',
          kind: 'framework',
          available: false,
          reason: 'Codex is not currently available in channels.',
        },
      ],
      knownProviderIds: ['codex'],
      agentProfileStore: profiles,
    });
    const root = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'root',
    });
    const trigger = post(
      store,
      binder,
      '@Backend fix it',
      ['codex'],
      OPERATOR,
      root.id
    );
    await waitFor(() =>
      systemRows(store).some((m) =>
        m.body.text.includes('not currently available in channels')
      )
    );
    const secondTrigger = post(
      store,
      binder,
      '@Backend fix it again',
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
    expect(unavailable.body.text).toBe(
      '@Backend is not available in channels yet — Codex is not currently available in channels.'
    );
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
  it('does not route a provider-default gateway self mention', async () => {
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: [
        {
          id: 'claude',
          displayName: 'Claude',
          kind: 'framework',
          available: true,
          reason: null,
        },
      ],
      knownProviderIds: ['claude'],
    });

    const gatewayPost = post(store, binder, '@claude', ['claude'], {
      kind: 'agent',
      id: 'agent:claude',
      providerId: 'claude',
      displayName: 'Claude',
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sessions.spawns()).toBe(0);
    expect(
      agentReplies(store, 'claude').filter(
        (message) => message.id !== gatewayPost.id
      )
    ).toHaveLength(0);
  });

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
    const t1 = `chturn-${m1.id}-${builtInAgentProfileId('mock')}`;
    expect(a1.sendCalls).toEqual([t1]);
    const sid1 = sessions.firstSessionId();

    // Session dies → binder clears the live entry (activeTurnId reset, row null).
    sessions.fireEnd(sid1);

    // M2 → fresh session 2, turn T2 delivered, send parked.
    const m2 = post(store, binder, '@mock two', ['mock']);
    await waitFor(() => built.length === 2 && built[1]!.sendCalls.length === 1);
    const a2 = built[1]!;
    const t2 = `chturn-${m2.id}-${builtInAgentProfileId('mock')}`;
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
    await waitFor(() => sessions.spawns() === 1); // runtime creation parked at the gate
    binder.close();
    releaseGate(); // spawn resolves AFTER close
    await expect(pending).rejects.toThrow(); // BinderClosedError — no attach
    expect(
      store.getBinding(CH, builtInAgentProfileId('mock'))?.runtimeId ?? null
    ).toBeNull();
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
    const turnId = `chturn-${trigger.id}-${builtInAgentProfileId('mock')}`;
    const requestId = `appr-${turnId}`;
    const approvalRow = systemRows(store).find((m) =>
      m.body.text.includes('requests approval')
    )!;
    expect(approvalRow.meta).toMatchObject({
      approvalRequestId: requestId,
      agentId: builtInAgentProfileId('mock'),
    });
    expect(approvalRow.meta?.['runtimeId']).toBe(sessions.firstSessionId());
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

    const requestId = `appr-chturn-${t1msg.id}-${builtInAgentProfileId('mock')}`;
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
      (await binder.rosterForChannel(CH)).find(
        (r) => r.id === builtInAgentProfileId('mock')
      )!.binding?.status
    ).toBe('waiting');

    // Resolving the approval resumes the turn: it completes normally, then T2 drains.
    const requestId = `appr-chturn-${t1.id}-${builtInAgentProfileId('mock')}`;
    await binder.respondToApproval(CH, 'mock', requestId, { kind: 'accept' });
    await waitFor(() => agentReplies(store, 'mock').length === 1, 4000);
    expect(agentReplies(store, 'mock')[0]!.body.text).toBe('approved and done');
    await waitFor(() => a.sendCalls.length === 2, 4000); // queued turn drained
    expect(a.sendCalls).toHaveLength(2);
  });
});

// ── #1287: channels state their participants instead of being guessed ────────

describe('channel-agent-binder — topic participant links', () => {
  function makeTopicStore(): WorkspaceTopicStore {
    const topicStore = createWorkspaceTopicStore({ dbPath: ':memory:' });
    cleanup.push(() => topicStore.close());
    return topicStore;
  }

  it('links its spawned runtime into the topic and never relinks on reuse', async () => {
    const topicStore = makeTopicStore();
    topicStore.create({
      id: CH,
      workspaceId: 'ws:local',
      title: 'general',
      routingDefaults: { repoPath: '/repo/relay', cwd: '/repo/relay' },
    });
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      topicStore,
    });

    post(store, binder, '@mock hi', ['mock']);
    await waitFor(() => agentReplies(store, 'mock').length === 1);
    const runtimeId = sessions.firstSessionId();
    const linked = topicStore.get(CH)!;
    expect(linked.linkedRefs.agentRuntimeIds).toEqual([runtimeId]);
    // The runtime is NOT a Relay session and must never be filed as one.
    expect(linked.linkedRefs.sessionIds).toBeUndefined();

    // Reuse: same runtime, so the topic keeps one entry and takes no write.
    post(store, binder, '@mock again', ['mock']);
    await waitFor(() => agentReplies(store, 'mock').length === 2);
    expect(sessions.spawns()).toBe(1);
    expect(topicStore.get(CH)?.linkedRefs.agentRuntimeIds).toEqual([runtimeId]);
    expect(topicStore.get(CH)?.updatedAt).toBe(linked.updatedAt);
  });

  it('links on reuse when the topic row only appears after the bind', async () => {
    const topicStore = makeTopicStore();
    const { binder, store, sessions } = makeBinder({
      build: () => new MockProtocolAdapterV2({ connectMs: 1, stepMs: 1 }),
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
      topicStore,
    });

    post(store, binder, '@mock hi', ['mock']);
    await waitFor(() => agentReplies(store, 'mock').length === 1);
    expect(topicStore.get(CH)).toBeNull();

    topicStore.create({ id: CH, workspaceId: 'ws:local', title: 'general' });
    post(store, binder, '@mock again', ['mock']);
    await waitFor(() => agentReplies(store, 'mock').length === 2);
    expect(sessions.spawns()).toBe(1);
    expect(topicStore.get(CH)?.linkedRefs.agentRuntimeIds).toEqual([
      sessions.firstSessionId(),
    ]);
  });
});

// ── #1166 routing half: a DM is "a channel with one agent", so addressing the
// channel IS the mention. Before this lane a DM message with no literal @name
// resolved zero profiles and returned with zero rows and zero logs — the agent
// never heard you and nothing said so.

describe('channel-agent-binder — DM implicit routing', () => {
  const DM_WORKSPACE = 'ws:local';
  const DM_CH = dmChannelTopicId('hermes', DM_WORKSPACE);
  const HERMES_TARGETS: MentionTarget[] = [
    {
      id: 'hermes',
      displayName: 'Hermes',
      kind: 'framework',
      available: true,
      reason: null,
    },
  ];
  /** A bound hermes reply posting back into its own DM (self-trigger bait). */
  const HERMES_AGENT_SENDER: ChannelSenderRef = {
    kind: 'agent',
    id: builtInAgentProfileId('hermes'),
    providerId: 'hermes',
    displayName: 'Hermes',
  };

  function makeTopics(): WorkspaceTopicStore {
    const topics = createWorkspaceTopicStore({ dbPath: ':memory:' });
    cleanup.push(() => topics.close());
    return topics;
  }

  function createDmTopic(topics: WorkspaceTopicStore): void {
    topics.create(
      dmChannelCreateInput({
        providerId: 'hermes',
        providerDisplayName: 'Hermes',
        workspaceId: DM_WORKSPACE,
      })
    );
  }

  function postTo(
    store: ChannelMessageStore,
    binder: ChannelAgentBinder,
    channelId: string,
    text: string,
    sender: ChannelSenderRef = OPERATOR,
    providers: string[] = ['hermes']
  ): ChannelMessage {
    const mentions = parseMentions(text, providers);
    const message = store.appendComplete({
      channelId,
      sender,
      text,
      ...(mentions.length ? { mentions } : {}),
    });
    binder.handleMessagePosted(message, message.mentions ?? []);
    return message;
  }

  function repliesIn(store: ChannelMessageStore, channelId: string) {
    return store
      .history(channelId, { limit: 200 })
      .filter(
        (m) =>
          m.sender.kind === 'agent' && m.status === 'complete' && !m.agentDetail
      );
  }

  function systemRowsIn(store: ChannelMessageStore, channelId: string) {
    return store
      .history(channelId, { limit: 200 })
      .filter((m) => m.kind === 'system');
  }

  /** Let every queued microtask + availability probe drain before asserting a negative. */
  const settle = () => new Promise((r) => setTimeout(r, 60));

  it('routes an unmentioned human DM message to the channel agent', async () => {
    const topics = makeTopics();
    createDmTopic(topics);
    const adapter = new ScriptedAdapter('hermes', {
      mode: 'reply',
      text: 'on it',
    });
    const { binder, store, sessions } = makeBinder({
      build: () => adapter,
      targets: HERMES_TARGETS,
      knownProviderIds: ['hermes'],
      topicStore: topics,
    });

    postTo(store, binder, DM_CH, 'what is the state of the build?');

    await waitFor(() => repliesIn(store, DM_CH).length === 1);
    expect(repliesIn(store, DM_CH)[0]!.body.text).toBe('on it');
    expect(adapter.sendCalls).toHaveLength(1);
    // The DM's single agent is that provider's DEFAULT profile actor.
    expect(sessions.lastCreateParams()).toMatchObject({
      providerId: 'hermes',
      profileActorId: builtInAgentProfileId('hermes'),
    });
  });

  it('does not double-route an explicit @mention in a DM', async () => {
    const topics = makeTopics();
    createDmTopic(topics);
    const adapter = new ScriptedAdapter('hermes', {
      mode: 'reply',
      text: 'ack',
    });
    const { binder, store, sessions } = makeBinder({
      build: () => adapter,
      targets: HERMES_TARGETS,
      knownProviderIds: ['hermes'],
      topicStore: topics,
    });

    postTo(store, binder, DM_CH, '@hermes ship it');

    await waitFor(() => repliesIn(store, DM_CH).length === 1);
    await settle();
    // Exactly ONE turn: the explicit mention resolved, so the implicit DM path
    // must not fire a second copy of the same message.
    expect(adapter.sendCalls).toHaveLength(1);
    expect(repliesIn(store, DM_CH)).toHaveLength(1);
    expect(sessions.spawns()).toBe(1);
  });

  it('never self-routes an agent-authored DM post', async () => {
    const topics = makeTopics();
    createDmTopic(topics);
    const adapter = new ScriptedAdapter('hermes', {
      mode: 'reply',
      text: 'loop',
    });
    const { binder, store, sessions } = makeBinder({
      build: () => adapter,
      targets: HERMES_TARGETS,
      knownProviderIds: ['hermes'],
      topicStore: topics,
    });

    // An unmentioned post from the DM's OWN agent. `eligibleProfiles`' self
    // filter cannot catch this — there are no mentions to filter — so the
    // implicit path must be gated on sender kind instead.
    postTo(store, binder, DM_CH, 'still working on it', HERMES_AGENT_SENDER);

    await settle();
    expect(adapter.sendCalls).toHaveLength(0);
    expect(sessions.spawns()).toBe(0);
    expect(systemRowsIn(store, DM_CH)).toHaveLength(0);
  });

  it('never blames the human for an AGENT-authored unroutable mention in a DM', async () => {
    const topics = makeTopics();
    createDmTopic(topics);
    // The DM agent's own reply mentions a provider that is MENTIONABLE
    // (`knownProviderIds` = every built-in adapter) but not a configured
    // routing target (`mentionTargets` = the configured frameworks).
    const adapter = new ScriptedAdapter('hermes', {
      mode: 'reply',
      text: 'looking now — @codex can you diff the branch?',
    });
    const { binder, store, sessions } = makeBinder({
      build: () => adapter,
      targets: HERMES_TARGETS, // codex resolves, but is not a target
      knownProviderIds: ['hermes', 'codex'],
      topicStore: topics,
    });

    postTo(store, binder, DM_CH, 'what is the state of the build?');

    await waitFor(() => repliesIn(store, DM_CH).length === 1);
    await settle();
    // The human's message routed and WAS answered. `routeOne` is shared with
    // the agent lanes, so the DM "nothing was routed" row must be gated on the
    // trigger's sender kind, not on DM-ness alone: otherwise the agent's own
    // dead @mention stamps a failure row under the human's trigger claiming
    // nothing was routed, while the human was in fact answered.
    expect(systemRowsIn(store, DM_CH)).toHaveLength(0);
    expect(sessions.spawns()).toBe(1);

    // Same gate for the other agent lane: a gateway agent post in the DM.
    postTo(store, binder, DM_CH, '@codex following up', HERMES_AGENT_SENDER, [
      'hermes',
      'codex',
    ]);
    await settle();
    expect(systemRowsIn(store, DM_CH)).toHaveLength(0);
    expect(sessions.spawns()).toBe(1);
  });

  it('says so out loud when a DM agent is not routable', async () => {
    const topics = makeTopics();
    createDmTopic(topics);
    const adapter = new ScriptedAdapter('hermes', {
      mode: 'reply',
      text: 'never',
    });
    const { binder, store, sessions } = makeBinder({
      build: () => adapter,
      targets: [], // hermes is not a known framework on this hub
      knownProviderIds: ['hermes'],
      topicStore: topics,
    });

    postTo(store, binder, DM_CH, 'are you there?');

    await waitFor(() => systemRowsIn(store, DM_CH).length === 1);
    expect(systemRowsIn(store, DM_CH)[0]!.body.text).toContain(
      'nothing was routed'
    );
    expect(sessions.spawns()).toBe(0);
    expect(adapter.sendCalls).toHaveLength(0);
  });

  it('stays silent in a multi-party channel with no mentions', async () => {
    const topics = makeTopics();
    createDmTopic(topics); // the DM exists; this post just is not in it
    topics.create({ id: CH, workspaceId: DM_WORKSPACE, title: 'general' });
    const adapter = new ScriptedAdapter('hermes', {
      mode: 'reply',
      text: 'never',
    });
    const { binder, store, sessions } = makeBinder({
      build: () => adapter,
      targets: HERMES_TARGETS,
      knownProviderIds: ['hermes'],
      topicStore: topics,
    });

    postTo(store, binder, CH, 'morning everyone');

    await settle();
    expect(adapter.sendCalls).toHaveLength(0);
    expect(sessions.spawns()).toBe(0);
    // Humans chat without addressing an agent — a system row here is spam.
    expect(systemRowsIn(store, CH)).toHaveLength(0);
    expect(repliesIn(store, CH)).toHaveLength(0);
  });
});

// ── retry (#1308 slice 1 item 2) ─────────────────────────────────────────────

describe('channel-agent-binder — retry', () => {
  const MOCK_PROFILE = builtInAgentProfileId('mock');

  /**
   * Exactly what the bridge writes for a lost turn: a streaming row stamped with
   * the binder-minted `source.turnId`, finalized to a terminal non-complete
   * status. Built through the store (not by driving a provider into failing) so
   * the retry contract is exercised deterministically and without timers.
   */
  function failedAgentRow(
    store: ChannelMessageStore,
    trigger: ChannelMessage,
    status: 'failed' | 'interrupted' | 'truncated' = 'failed',
    turnId = channelTurnId(trigger.id, MOCK_PROFILE)
  ): ChannelMessage {
    const stream = store.beginStream({
      channelId: CH,
      sender: {
        kind: 'agent',
        id: MOCK_PROFILE,
        providerId: 'mock',
        displayName: 'Mock',
      },
      source: { runtimeId: 'runtime:mock', turnId, itemId: 'assistant-0' },
    });
    return store.finalizeStream(stream.id, { text: 'half a re', status })!;
  }

  function humanRows(store: ChannelMessageStore): ChannelMessage[] {
    return rows(store).filter((m) => m.sender.kind === 'human');
  }

  it('re-routes the original trigger exactly once and never duplicates the human message', async () => {
    const adapter = new ScriptedAdapter('mock', { mode: 'stall' });
    const { binder, store } = makeBinder({
      build: () => adapter,
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const trigger = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: '@mock ship the anchor',
    });
    const failed = failedAgentRow(store, trigger);

    const result = await binder.retryMessage(CH, failed.id);
    await waitFor(() => adapter.sendCalls.length > 0);

    expect(result).toEqual({
      messageId: failed.id,
      triggerMessageId: trigger.id,
      profileActorId: MOCK_PROFILE,
    });
    // Exactly one delivery, carrying the SAME deterministic turn identity the
    // lost turn had — a retry re-runs a turn, it does not open a new one.
    expect(adapter.sendCalls).toEqual([
      channelTurnId(trigger.id, MOCK_PROFILE),
    ]);
    // The load-bearing invariant: the operator's message is re-routed, never
    // re-posted, so the timeline still holds exactly one copy of it.
    expect(humanRows(store).map((m) => m.id)).toEqual([trigger.id]);
    expect(adapter.sendInputs[0]?.content).toContain('ship the anchor');
  });

  it('supersedes the retried row with a system row carrying its id', async () => {
    const adapter = new ScriptedAdapter('mock', { mode: 'stall' });
    const { binder, store } = makeBinder({
      build: () => adapter,
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const trigger = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: '@mock ship the anchor',
    });
    const failed = failedAgentRow(store, trigger);

    await binder.retryMessage(CH, failed.id);
    await waitFor(() => adapter.sendCalls.length > 0);

    const marker = systemRows(store).find(
      (row) => row.meta?.[CHANNEL_RETRY_OF_META_KEY] === failed.id
    );
    expect(marker).toBeDefined();
    expect(marker?.body.text).toContain('retrying');
    // The failed row itself is untouched: it stays the durable record of what
    // went wrong, and the supersede mark lives on a separate durable row.
    expect(store.getMessage(failed.id)?.status).toBe('failed');
  });

  it('refuses to retry while the same profile is mid-turn (storm brake)', async () => {
    const adapter = new ScriptedAdapter('mock', { mode: 'stall' });
    const { binder, store } = makeBinder({
      build: () => adapter,
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    // Drive a real turn that never completes so the binding is genuinely busy.
    const live = post(store, binder, '@mock keep going', ['mock']);
    await waitFor(() => adapter.sendCalls.length === 1);

    const trigger = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: '@mock the earlier one',
    });
    const failed = failedAgentRow(store, trigger);

    await expect(binder.retryMessage(CH, failed.id)).rejects.toBeInstanceOf(
      ChannelAgentBusyError
    );
    // Nothing was delivered and nothing was superseded by the refused retry.
    expect(adapter.sendCalls).toEqual([channelTurnId(live.id, MOCK_PROFILE)]);
    expect(
      systemRows(store).filter(
        (row) => row.meta?.[CHANNEL_RETRY_OF_META_KEY] !== undefined
      )
    ).toHaveLength(0);
  });

  it('admits exactly one of two concurrent retries (brake is not a TOCTOU)', async () => {
    const adapter = new ScriptedAdapter('mock', { mode: 'stall' });
    const { binder, store } = makeBinder({
      build: () => adapter,
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const trigger = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: '@mock ship the anchor',
    });
    // Two different lost rows for the SAME profile — two devices pressing retry
    // in the same tick. Nothing is bound yet (cold binding after a hub restart),
    // so the `live` map cannot answer "busy" for either caller.
    const first = failedAgentRow(store, trigger);
    const trigger2 = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: '@mock and the other one',
    });
    const second = failedAgentRow(store, trigger2);

    const results = await Promise.allSettled([
      binder.retryMessage(CH, first.id),
      binder.retryMessage(CH, second.id),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected');
    expect(refused?.status === 'rejected' && refused.reason).toBeInstanceOf(
      ChannelAgentBusyError
    );
    await waitFor(() => adapter.sendCalls.length > 0);
    expect(adapter.sendCalls).toHaveLength(1);
    // The refused retry never wrote a supersede mark either — the row it names
    // keeps its own retry affordance.
    expect(
      systemRows(store).filter(
        (row) => row.meta?.[CHANNEL_RETRY_OF_META_KEY] !== undefined
      )
    ).toHaveLength(1);
  });

  it('rejects rows no routed turn can be recovered from', async () => {
    const adapter = new ScriptedAdapter('mock', { mode: 'stall' });
    const { binder, store } = makeBinder({
      build: () => adapter,
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const trigger = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: '@mock ship the anchor',
    });

    await expect(binder.retryMessage(CH, 'chm:nope')).rejects.toMatchObject({
      reasonCode: 'CHANNEL_MESSAGE_NOT_FOUND',
      notFound: true,
    });
    // A human row is not an agent turn.
    await expect(binder.retryMessage(CH, trigger.id)).rejects.toMatchObject({
      reasonCode: 'MESSAGE_NOT_RETRYABLE',
      notFound: false,
    });
    // A provider-labelled turn id (Hermes emits `turn-0`) names no trigger.
    const orphan = failedAgentRow(store, trigger, 'failed', 'turn-0');
    await expect(binder.retryMessage(CH, orphan.id)).rejects.toMatchObject({
      reasonCode: 'MESSAGE_NOT_RETRYABLE',
    });
    expect(adapter.sendCalls).toHaveLength(0);
  });

  it('refuses to re-run a turn whose trigger the operator deleted (#1308 item 4)', async () => {
    const adapter = new ScriptedAdapter('mock', { mode: 'stall' });
    const { binder, store } = makeBinder({
      build: () => adapter,
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const trigger = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: '@mock ship the anchor',
    });
    const failed = failedAgentRow(store, trigger);
    // A tombstone keeps its id, so the trigger still RESOLVES — re-running the
    // turn would hand the provider exactly the text the operator erased.
    store.deleteMessage({
      channelId: CH,
      messageId: trigger.id,
      deleterId: OPERATOR.id,
    });

    await expect(binder.retryMessage(CH, failed.id)).rejects.toMatchObject({
      reasonCode: 'RETRY_TRIGGER_DELETED',
      notFound: false,
    });
    expect(adapter.sendCalls).toHaveLength(0);
    // Refused before the supersede mark: a mark for a turn that never ran would
    // disable the row's own retry affordance forever.
    expect(
      systemRows(store).filter(
        (row) => row.meta?.[CHANNEL_RETRY_OF_META_KEY] !== undefined
      )
    ).toHaveLength(0);
  });

  it('retries interrupted and truncated rows too — every lost turn, not just failed', async () => {
    const adapter = new ScriptedAdapter('mock', { mode: 'stall' });
    const { binder, store } = makeBinder({
      build: () => adapter,
      targets: MOCK_TARGETS,
      knownProviderIds: ['mock'],
    });
    const trigger = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: '@mock ship the anchor',
    });
    const interrupted = failedAgentRow(store, trigger, 'interrupted');

    await binder.retryMessage(CH, interrupted.id);
    await waitFor(() => adapter.sendCalls.length > 0);
    expect(adapter.sendCalls).toEqual([
      channelTurnId(trigger.id, MOCK_PROFILE),
    ]);
  });
});

describe('channel-agent-binder — retry availability', () => {
  it('refuses (and does not supersede) when the framework is unavailable', async () => {
    const adapter = new ScriptedAdapter('mock', { mode: 'stall' });
    const { binder, store } = makeBinder({
      build: () => adapter,
      targets: [
        {
          id: 'mock',
          displayName: 'Mock',
          kind: 'framework',
          available: false,
          reason: 'cli not installed',
        },
      ],
      knownProviderIds: ['mock'],
    });
    const trigger = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: '@mock ship the anchor',
    });
    const profileId = builtInAgentProfileId('mock');
    const stream = store.beginStream({
      channelId: CH,
      sender: { kind: 'agent', id: profileId, providerId: 'mock' },
      source: {
        runtimeId: 'runtime:mock',
        turnId: channelTurnId(trigger.id, profileId),
        itemId: 'assistant-0',
      },
    });
    const failed = store.finalizeStream(stream.id, {
      text: '',
      status: 'failed',
    })!;

    await expect(binder.retryMessage(CH, failed.id)).rejects.toMatchObject({
      reasonCode: 'AGENT_UNAVAILABLE',
    });
    // No supersede mark: the row keeps its retry affordance for when the
    // framework comes back, instead of being stranded by a turn that never ran.
    expect(
      systemRows(store).filter(
        (row) => row.meta?.[CHANNEL_RETRY_OF_META_KEY] !== undefined
      )
    ).toHaveLength(0);
    expect(adapter.sendCalls).toHaveLength(0);
  });
});

// ── #1308 slice 4: mid-turn steering ─────────────────────────────────────────

const STEER_TARGETS: MentionTarget[] = [
  {
    id: 'steer',
    displayName: 'Steer',
    kind: 'framework',
    available: true,
    reason: null,
  },
];

/**
 * First `sendMessage` parks forever until the test fails it — the shape a dead
 * transport has when the send hangs and only later rejects. Everything else is
 * `SteerableAdapter`.
 */
class ParkedSendAdapter extends SteerableAdapter {
  private rejectSend: ((err: unknown) => void) | null = null;
  override sendMessage(input: AgentSendMessageInputV2): Promise<void> {
    this.sendCalls.push(input.turnId);
    this.sendInputs.push(input);
    return new Promise<void>((_resolve, reject) => {
      this.rejectSend = reject;
    });
  }
  failParkedSend(): void {
    const reject = this.rejectSend;
    this.rejectSend = null;
    reject?.(new Error('boom: transport gone'));
  }
}

/** Refuses every cancellation so the steering failure row is observable. */
class RefusingInterruptAdapter extends SteerableAdapter {
  override async interrupt(): Promise<void> {
    throw new Error('boom: interrupt refused');
  }
}

/** Post with an explicit steering choice, exactly as the post route forwards it. */
function postSteering(
  store: ChannelMessageStore,
  binder: ChannelAgentBinder,
  text: string,
  knownIds: string[],
  steering: 'interrupt' | undefined,
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
  binder.handleMessagePosted(
    message,
    message.mentions ?? [],
    steering ? { steering } : undefined
  );
  return message;
}

/** Image-bearing post. The payload never resolves — only the turn shape matters. */
function postSteerImage(
  store: ChannelMessageStore,
  binder: ChannelAgentBinder,
  text: string,
  partId: string
): ChannelMessage {
  const mentions = parseMentions(text, ['steer']);
  const part: ChannelImagePart = {
    type: 'image',
    id: partId,
    mime: 'image/png',
    w: 1,
    h: 1,
    bytes: 7,
  };
  const message = store.appendComplete({
    channelId: CH,
    sender: OPERATOR,
    text,
    ...(mentions.length ? { mentions } : {}),
    parts: [part],
  });
  binder.handleMessagePosted(message, message.mentions ?? []);
  return message;
}

function makeSteerBinder(supportsSafeBoundarySteer = false) {
  const harness = makeBinder({
    build: (agentType) =>
      new SteerableAdapter(agentType, supportsSafeBoundarySteer),
    targets: STEER_TARGETS,
    knownProviderIds: ['steer'],
  });
  const events: Array<Record<string, unknown>> = [];
  harness.binder.setStatusBroadcaster((_type, data) => events.push(data));
  return { ...harness, events };
}

async function steerAdapter(
  sessions: ReturnType<typeof makeBinder>['sessions']
): Promise<SteerableAdapter> {
  await waitFor(() => sessions.spawns() === 1);
  return sessions.adapterFor(sessions.firstSessionId()) as SteerableAdapter;
}

describe('channel-agent-binder — mid-turn steering (#1308 slice 4)', () => {
  it('bounds accepted native steers at the aggregate queue cap', async () => {
    const { binder, store, sessions } = makeSteerBinder(true);
    postSteering(store, binder, '@steer opener', ['steer'], undefined);
    const adapter = await steerAdapter(sessions);
    await waitFor(() => adapter.sendCalls.length === 1);
    for (let i = 0; i < 8; i++) {
      postSteering(store, binder, `@steer ${i}`, ['steer'], undefined);
    }
    await waitFor(() => adapter.steerInputs.length === 8);
    postSteering(store, binder, '@steer overflow', ['steer'], undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(adapter.steerInputs).toHaveLength(8);
    expect(
      rows(store).some((row) => row.body.text.includes('8 messages pending'))
    ).toBe(true);
  });

  it('falls back to one ordinary FIFO turn after a definite native steer rejection', async () => {
    const harness = makeBinder({
      build: (agentType) => new SteerableAdapter(agentType, true, true),
      targets: STEER_TARGETS,
      knownProviderIds: ['steer'],
    });
    postSteering(
      harness.store,
      harness.binder,
      '@steer opener',
      ['steer'],
      undefined
    );
    const adapter = await steerAdapter(harness.sessions);
    await waitFor(() => adapter.sendCalls.length === 1);
    postSteering(
      harness.store,
      harness.binder,
      '@steer fallback',
      ['steer'],
      undefined
    );
    await waitFor(() => adapter.steerAttempts.length === 1);
    adapter.completeLatest();
    await waitFor(() => adapter.sendCalls.length === 2);
    expect(adapter.sendInputs[1]!.content).toContain('@steer fallback');
  });

  it('does not replay a steer after an ambiguous transport failure', async () => {
    const harness = makeBinder({
      build: (agentType) => new SteerableAdapter(agentType, true, false, true),
      targets: STEER_TARGETS,
      knownProviderIds: ['steer'],
    });
    postSteering(
      harness.store,
      harness.binder,
      '@steer opener',
      ['steer'],
      undefined
    );
    const adapter = await steerAdapter(harness.sessions);
    await waitFor(() => adapter.sendCalls.length === 1);
    postSteering(
      harness.store,
      harness.binder,
      '@steer uncertain',
      ['steer'],
      undefined
    );
    await waitFor(() => adapter.steerAttempts.length === 1);
    await waitFor(() =>
      systemRows(harness.store).some((row) =>
        row.body.text.includes('could not accept the steering message')
      )
    );

    adapter.completeLatest();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(adapter.sendCalls).toHaveLength(1);
    expect(adapter.steerInputs).toHaveLength(0);
  });

  it('uses a native safe-boundary steer by default and preserves FIFO without a concurrent turn', async () => {
    const { binder, store, sessions, events } = makeSteerBinder(true);
    postSteering(store, binder, '@steer long task', ['steer'], undefined);
    const adapter = await steerAdapter(sessions);
    await waitFor(() => adapter.sendCalls.length === 1);

    // No explicit field: a harness that advertises a native steer primitive
    // receives the operator's next instruction at that provider boundary.
    postSteering(
      store,
      binder,
      '@steer instead inspect the conflict',
      ['steer'],
      undefined
    );
    await waitFor(() => adapter.steerInputs.length === 1);
    expect(adapter.sendCalls).toHaveLength(1);
    expect(adapter.concurrentPeak).toBe(1);
    expect(adapter.steerInputs[0]!.content).toContain(
      '@steer instead inspect the conflict'
    );
    // Status is deliberately not the old queued lane: the UI can say
    // "steering pending" rather than falsely claiming a future turn.
    expect(events.some((event) => event['steeringCount'] === 1)).toBe(true);
    expect(events.at(-1)?.['queuedCount']).toBe(0);

    adapter.completeLatest('redirected reply');
    await waitFor(() => events.at(-1)?.['steeringCount'] === 0);
  });

  it('clears pending native steer status when its runtime dies', async () => {
    const harness = makeBinder({
      build: (agentType) =>
        new SteerableAdapter(agentType, true, false, false, true),
      targets: STEER_TARGETS,
      knownProviderIds: ['steer'],
    });
    const events: Array<Record<string, unknown>> = [];
    harness.binder.setStatusBroadcaster((_type, data) => events.push(data));
    postSteering(
      harness.store,
      harness.binder,
      '@steer long task',
      ['steer'],
      undefined
    );
    const adapter = await steerAdapter(harness.sessions);
    await waitFor(() => adapter.sendCalls.length === 1);
    postSteering(
      harness.store,
      harness.binder,
      '@steer redirect',
      ['steer'],
      undefined
    );
    await waitFor(() => adapter.steerAttempts.length === 1);
    await waitFor(() => events.at(-1)?.['steeringCount'] === 1);

    harness.sessions.fireEnd(harness.sessions.firstSessionId());
    await waitFor(() => events.at(-1)?.['status'] === 'idle');
    expect(events.at(-1)).toMatchObject({
      queuedCount: 0,
      steeringCount: 0,
    });
  });

  it('queues posts that land mid-turn and drains them all into ONE next turn', async () => {
    const { binder, store, sessions, events } = makeSteerBinder();
    postSteering(store, binder, '@steer one', ['steer'], undefined);
    const adapter = await steerAdapter(sessions);
    await waitFor(() => adapter.sendCalls.length === 1);

    // Three more posts land while the first turn is still live.
    postSteering(store, binder, '@steer two', ['steer'], undefined);
    postSteering(store, binder, '@steer three', ['steer'], undefined);
    postSteering(store, binder, '@steer four', ['steer'], undefined);
    await waitFor(() => events.some((event) => event['queuedCount'] === 3));
    // No concurrent dispatch while the first turn is open — all three queued.
    expect(adapter.sendCalls).toHaveLength(1);

    adapter.completeLatest('first reply');
    // Exactly ONE further turn for the three queued posts (coalesced).
    await waitFor(() => adapter.sendCalls.length === 2);
    await new Promise((r) => setTimeout(r, 40));
    expect(adapter.sendCalls).toHaveLength(2);
    expect(adapter.concurrentPeak).toBe(1);

    // ...and all three ride that one context packet.
    const packet = adapter.sendInputs[1]!.content;
    expect(packet).toContain('@steer two');
    expect(packet).toContain('@steer three');
    expect(packet).toContain('@steer four');
    // The newest queued post is the trigger in the packet footer.
    expect(packet.trimEnd().endsWith('@steer four')).toBe(true);
  });

  it('never drops a queued trigger and never double-dispatches across finishTurn', async () => {
    const { binder, store, sessions } = makeSteerBinder();
    postSteering(store, binder, '@steer first', ['steer'], undefined);
    const adapter = await steerAdapter(sessions);
    await waitFor(() => adapter.sendCalls.length === 1);

    // Interleave a post with the completion of the live turn: the post enqueues
    // while the previous turn is still active, then finishTurn pumps it. Only
    // ONE dispatch may result, and it must not be lost.
    postSteering(store, binder, '@steer second', ['steer'], undefined);
    adapter.completeLatest('first reply');
    await waitFor(() => adapter.sendCalls.length === 2);
    postSteering(store, binder, '@steer third', ['steer'], undefined);
    adapter.completeLatest('second reply');
    await waitFor(() => adapter.sendCalls.length === 3);
    await new Promise((r) => setTimeout(r, 40));

    expect(adapter.sendCalls).toHaveLength(3);
    expect(adapter.concurrentPeak).toBe(1);
    expect(new Set(adapter.sendCalls).size).toBe(3); // no re-sent turn identity
    expect(adapter.sendInputs[1]!.content).toContain('@steer second');
    expect(adapter.sendInputs[2]!.content).toContain('@steer third');
  });

  it('steering:"interrupt" overrides native steer and cancels the live turn', async () => {
    const { binder, store, sessions } = makeSteerBinder(true);
    postSteering(store, binder, '@steer long task', ['steer'], undefined);
    const adapter = await steerAdapter(sessions);
    await waitFor(() => adapter.sendCalls.length === 1);
    await waitFor(() =>
      rows(store).some(
        (m) => m.sender.providerId === 'steer' && m.status === 'streaming'
      )
    );
    const firstTurn = adapter.sendCalls[0]!;

    postSteering(
      store,
      binder,
      '@steer stop, do this instead',
      ['steer'],
      'interrupt'
    );

    await waitFor(() => adapter.interruptCalls.length === 1);
    expect(adapter.interruptCalls[0]).toBe(firstTurn);
    expect(adapter.steerAttempts).toHaveLength(0);
    // Existing interrupt semantics: the partial row finalizes `interrupted`.
    await waitFor(() =>
      rows(store).some(
        (m) => m.sender.providerId === 'steer' && m.status === 'interrupted'
      )
    );
    // ...and the steering message triggers its own turn immediately after.
    await waitFor(() => adapter.sendCalls.length === 2);
    expect(adapter.concurrentPeak).toBe(1);
    expect(adapter.sendInputs[1]!.content).toContain(
      '@steer stop, do this instead'
    );
  });

  it('steering:"interrupt" on an idle agent degrades to a plain send', async () => {
    const { binder, store, sessions } = makeSteerBinder();
    postSteering(store, binder, '@steer go now', ['steer'], 'interrupt');
    const adapter = await steerAdapter(sessions);
    await waitFor(() => adapter.sendCalls.length === 1);
    await new Promise((r) => setTimeout(r, 40));
    expect(adapter.interruptCalls).toHaveLength(0);
    expect(adapter.sendCalls).toHaveLength(1);
  });

  // The idempotent-replay lane applies the steering half to an already-stored
  // row. If the row DRAINED between the two posts, the live turn is the reply
  // the operator is waiting for — replaying the interrupt there would cancel
  // their own answer, the exact opposite of "interrupt and send".
  it('an idempotent steering replay never cancels the turn that message triggered', async () => {
    const { binder, store, sessions } = makeSteerBinder();
    postSteering(store, binder, '@steer long task', ['steer'], undefined);
    const adapter = await steerAdapter(sessions);
    await waitFor(() => adapter.sendCalls.length === 1);
    const steerProfile = builtInAgentProfileId('steer');

    // First "interrupt & send": cancels the opener, queues behind it. The
    // cancellation's terminal patch then releases the binding, so m2 drains and
    // becomes the LIVE turn — exactly the state the second POST arrives into.
    const m2 = postSteering(
      store,
      binder,
      '@steer do this',
      ['steer'],
      'interrupt'
    );
    await waitFor(() => adapter.interruptCalls.length === 1);
    await waitFor(() => adapter.sendCalls.length === 2);
    expect(adapter.sendCalls[1]).toBe(channelTurnId(m2.id, steerProfile));

    // The operator's first POST looked like it failed, so they press the button
    // again with the same clientMessageId — the route replays the steering half.
    binder.steerExisting(m2, 'interrupt');
    await new Promise((r) => setTimeout(r, 40));
    expect(adapter.interruptCalls).toHaveLength(1);
    expect(adapter.sendCalls).toHaveLength(2);
  });

  it('an agent-authored post never steers: no interrupt, one turn per trigger', async () => {
    const { binder, store, sessions } = makeSteerBinder();
    postSteering(store, binder, '@steer human opener', ['steer'], undefined);
    const adapter = await steerAdapter(sessions);
    await waitFor(() => adapter.sendCalls.length === 1);

    // A CLI-gateway agent post carrying the same flag must not cancel the turn.
    postSteering(
      store,
      binder,
      '@steer agent one',
      ['steer'],
      'interrupt',
      AGENT_SENDER
    );
    postSteering(
      store,
      binder,
      '@steer agent two',
      ['steer'],
      'interrupt',
      AGENT_SENDER
    );
    await new Promise((r) => setTimeout(r, 40));
    expect(adapter.interruptCalls).toHaveLength(0);
    expect(adapter.sendCalls).toHaveLength(1);

    // Agent triggers are never coalesced away — each keeps its own turn.
    adapter.completeLatest('reply one');
    await waitFor(() => adapter.sendCalls.length === 2);
    adapter.completeLatest('reply two');
    await waitFor(() => adapter.sendCalls.length === 3);
    expect(adapter.concurrentPeak).toBe(1);
    expect(adapter.sendInputs[1]!.content).toContain('@steer agent one');
    expect(adapter.sendInputs[2]!.content).toContain('@steer agent two');
  });

  it('supersedes the queue tail instead of dropping fast operator typing at the cap', async () => {
    const { binder, store, sessions } = makeSteerBinder();
    postSteering(store, binder, '@steer opener', ['steer'], undefined);
    const adapter = await steerAdapter(sessions);
    await waitFor(() => adapter.sendCalls.length === 1);

    // Far past QUEUE_CAP: they all collapse into the one next turn, so no slot
    // pressure and no "message dropped" row is honest here.
    const total = 20;
    let last: ChannelMessage | null = null;
    for (let i = 0; i < total; i += 1) {
      last = postSteering(
        store,
        binder,
        `@steer burst ${i}`,
        ['steer'],
        undefined
      );
    }
    await waitFor(
      () =>
        store.getMessage(last!.id) !== null && adapter.sendCalls.length === 1
    );
    await new Promise((r) => setTimeout(r, 60));
    expect(
      systemRows(store).filter((row) =>
        row.body.text.includes('message dropped')
      )
    ).toHaveLength(0);

    adapter.completeLatest('opener reply');
    await waitFor(() => adapter.sendCalls.length === 2);
    const packet = adapter.sendInputs[1]!.content;
    expect(packet.trimEnd().endsWith(`@steer burst ${total - 1}`)).toBe(true);
    expect(packet).toContain('@steer burst 0');
    expect(adapter.concurrentPeak).toBe(1);
  });

  it('publishes queuedCount on the status event and the roster payload', async () => {
    const { binder, store, sessions, events } = makeSteerBinder();
    postSteering(store, binder, '@steer one', ['steer'], undefined);
    const adapter = await steerAdapter(sessions);
    await waitFor(() => adapter.sendCalls.length === 1);
    // Every status event carries the field, additively.
    expect(events.length).toBeGreaterThan(0);
    expect(
      events.every((event) => typeof event['queuedCount'] === 'number')
    ).toBe(true);

    postSteering(store, binder, '@steer two', ['steer'], undefined);
    postSteering(store, binder, '@steer three', ['steer'], undefined);
    await waitFor(() => events.some((event) => event['queuedCount'] === 2));
    const roster = await binder.rosterForChannel(CH);
    const entry = roster.find((row) => row.providerId === 'steer');
    expect(entry?.binding?.queuedCount).toBe(2);
    expect(entry?.binding?.status).toBe('streaming');

    adapter.completeLatest('reply');
    await waitFor(() => adapter.sendCalls.length === 2);
    // The drain is reported, not left stale on the last busy count.
    expect(events[events.length - 1]?.['queuedCount']).toBe(0);
    expect(
      (await binder.rosterForChannel(CH)).find(
        (row) => row.providerId === 'steer'
      )?.binding?.queuedCount
    ).toBe(0);
  });

  // The queue is NOT seq-ordered: `handleSendFailure` re-enqueues an older,
  // already-failed trigger BEHIND whatever arrived while the transport was
  // failing. Coalescing folds older members into the newest one's packet, so a
  // run that admitted a stale head would splice a newer post out of the queue
  // while producing neither a turn for it nor a context row carrying it.
  it('a re-enqueued failed trigger never swallows a newer queued post', async () => {
    const built: SteerableAdapter[] = [];
    const { binder, store, sessions } = makeBinder({
      build: (agentType) => {
        const adapter =
          built.length === 0
            ? new ParkedSendAdapter(agentType)
            : new SteerableAdapter(agentType);
        built.push(adapter);
        return adapter;
      },
      targets: STEER_TARGETS,
      knownProviderIds: ['steer'],
    });
    const events: Array<Record<string, unknown>> = [];
    binder.setStatusBroadcaster((_type, data) => events.push(data));
    const steerProfile = builtInAgentProfileId('steer');

    const m1 = postSteering(store, binder, '@steer one', ['steer'], undefined);
    await waitFor(() => built.length === 1 && built[0]!.sendCalls.length === 1);
    const parked = built[0] as ParkedSendAdapter;

    // The runtime dies while m1's send is still in flight, so the retry lands on
    // a DIFFERENT binding and takes the re-enqueue branch rather than redeliver.
    sessions.fireEnd(sessions.firstSessionId());

    // A newer post rebinds and opens its own turn, which stalls...
    postSteering(store, binder, '@steer two', ['steer'], undefined);
    await waitFor(() => built.length === 2 && built[1]!.sendCalls.length === 1);
    const live = built[1]!;

    // ...and a newer-still post queues behind that live turn.
    const m3 = postSteering(
      store,
      binder,
      '@steer three',
      ['steer'],
      undefined
    );
    await waitFor(() => events[events.length - 1]?.['queuedCount'] === 1);

    // Only now does m1's parked send fail: it re-enqueues BEHIND m3.
    parked.failParkedSend();
    await waitFor(() => events[events.length - 1]?.['queuedCount'] === 2);

    // The drain must trigger on the NEWEST queued post, not the queue tail.
    live.completeLatest('two reply');
    await waitFor(() => live.sendCalls.length === 2);
    expect(live.sendCalls[1]).toBe(channelTurnId(m3.id, steerProfile));
    expect(live.sendInputs[1]!.content).toContain('@steer three');

    // ...and the re-enqueued older trigger is not lost either — it drains next.
    live.completeLatest('three reply');
    await waitFor(() => live.sendCalls.length === 3);
    expect(live.sendCalls[2]).toBe(channelTurnId(m1.id, steerProfile));
    expect(live.concurrentPeak).toBe(1);
  });

  // Same setup as above with ONE reordering: m1's parked send fails BEFORE the
  // third post, so the re-enqueued trigger is the run's HEAD rather than a
  // coalescing candidate. The seq-monotonicity guard does not fire here
  // (m3.seq > m1.seq), so without the `reEnqueued` rule `pump` would splice both
  // out and trigger on m3 — and m1 could not come back as a context row either,
  // because m2's successful send already advanced `lastDeliveredSeq` past it.
  it('gives a re-enqueued failed trigger its own turn when it heads the queue', async () => {
    const built: SteerableAdapter[] = [];
    const { binder, store, sessions } = makeBinder({
      build: (agentType) => {
        const adapter =
          built.length === 0
            ? new ParkedSendAdapter(agentType)
            : new SteerableAdapter(agentType);
        built.push(adapter);
        return adapter;
      },
      targets: STEER_TARGETS,
      knownProviderIds: ['steer'],
    });
    const events: Array<Record<string, unknown>> = [];
    binder.setStatusBroadcaster((_type, data) => events.push(data));
    const steerProfile = builtInAgentProfileId('steer');

    const m1 = postSteering(store, binder, '@steer one', ['steer'], undefined);
    await waitFor(() => built.length === 1 && built[0]!.sendCalls.length === 1);
    const parked = built[0] as ParkedSendAdapter;

    sessions.fireEnd(sessions.firstSessionId());

    // m2 rebinds, delivers (advancing the delivery cursor past m1), and stalls.
    postSteering(store, binder, '@steer two', ['steer'], undefined);
    await waitFor(() => built.length === 2 && built[1]!.sendCalls.length === 1);
    const live = built[1]!;

    // m1's parked send fails FIRST, so it re-enqueues at the head of the queue.
    parked.failParkedSend();
    await waitFor(() => events[events.length - 1]?.['queuedCount'] === 1);

    // ...and only then does a newer post land behind it.
    const m3 = postSteering(
      store,
      binder,
      '@steer three',
      ['steer'],
      undefined
    );
    await waitFor(() => events[events.length - 1]?.['queuedCount'] === 2);

    // m1 must reach the adapter as its OWN trigger — the footer renders a
    // trigger unconditionally, which is the only place it can still be carried.
    live.completeLatest('two reply');
    await waitFor(() => live.sendCalls.length === 2);
    expect(live.sendCalls[1]).toBe(channelTurnId(m1.id, steerProfile));
    expect(live.sendInputs[1]!.content).toContain('@steer one');

    // ...and the newer post is not lost to the re-enqueue either.
    live.completeLatest('one reply');
    await waitFor(() => live.sendCalls.length === 3);
    expect(live.sendCalls[2]).toBe(channelTurnId(m3.id, steerProfile));
    expect(live.sendInputs[2]!.content).toContain('@steer three');
    expect(live.concurrentPeak).toBe(1);
    expect(systemRows(store)).toHaveLength(0);
  });

  // The packet image budget is per PACKET, not per message, so folding N
  // image-bearing posts into one turn would silently spend one budget on all of
  // them. Attachments are operator content the slice promised not to drop.
  it('never coalesces image-bearing posts, so each keeps its own image budget', async () => {
    const { binder, store, sessions, events } = makeSteerBinder();
    postSteering(store, binder, '@steer opener', ['steer'], undefined);
    const adapter = await steerAdapter(sessions);
    await waitFor(() => adapter.sendCalls.length === 1);
    const steerProfile = builtInAgentProfileId('steer');

    const shotA = postSteerImage(store, binder, '@steer shot a', 'cha:shot-a');
    const shotB = postSteerImage(store, binder, '@steer shot b', 'cha:shot-b');
    await waitFor(() => events[events.length - 1]?.['queuedCount'] === 2);

    adapter.completeLatest('opener reply');
    await waitFor(() => adapter.sendCalls.length === 2);
    expect(adapter.sendCalls[1]).toBe(channelTurnId(shotA.id, steerProfile));
    adapter.completeLatest('shot a reply');
    await waitFor(() => adapter.sendCalls.length === 3);
    expect(adapter.sendCalls[2]).toBe(channelTurnId(shotB.id, steerProfile));
    expect(adapter.concurrentPeak).toBe(1);
  });

  it('parents a refused steering interrupt to the thread it was issued from', async () => {
    const { binder, store, sessions } = makeBinder({
      build: (agentType) => new RefusingInterruptAdapter(agentType),
      targets: STEER_TARGETS,
      knownProviderIds: ['steer'],
    });
    const root = store.appendComplete({
      channelId: CH,
      sender: OPERATOR,
      text: 'thread root',
    });
    post(store, binder, '@steer long task', ['steer'], OPERATOR, root.id);
    await waitFor(() => sessions.spawns() === 1);
    const adapter = sessions.adapterFor(
      sessions.firstSessionId()
    ) as RefusingInterruptAdapter;
    await waitFor(() => adapter.sendCalls.length === 1);

    const steer = postSteering(
      store,
      binder,
      '@steer stop that',
      ['steer'],
      'interrupt',
      OPERATOR,
      root.id
    );
    await waitFor(() =>
      systemRows(store).some((row) =>
        row.body.text.includes('could not be interrupted')
      )
    );
    const failure = systemRows(store).find((row) =>
      row.body.text.includes('could not be interrupted')
    )!;
    // Without this the explanation lands at channel top level, away from the
    // thread the operator was actually working in.
    expect(failure.threadId).toBe(root.id);
    expect(failure.parentMessageId).toBe(steer.id);
  });
});

// ── presence teardown (#1307) ────────────────────────────────────────────────
// A runtime that dies without a terminal transition used to pin channel-agent
// presence at thinking/streaming/waiting: the header chip AND the in-timeline
// presence row render the same broadcast, and the watchdog cannot bound the
// worst case (it is disarmed for as long as `waitingOn !== null`). Every
// teardown path must therefore end in an `idle` broadcast of its own.

const PARKED_TARGETS: MentionTarget[] = [
  {
    id: 'parked',
    displayName: 'Parked',
    kind: 'framework',
    available: true,
    reason: null,
  },
];

function makeParkedBinder(cfg: { presenceSweepMs?: number } = {}) {
  const harness = makeBinder({
    build: (agentType) => new ParkedOnApprovalAdapter(agentType),
    targets: PARKED_TARGETS,
    knownProviderIds: ['parked'],
    ...(cfg.presenceSweepMs !== undefined
      ? { presenceSweepMs: cfg.presenceSweepMs }
      : {}),
  });
  const events: Array<Record<string, unknown>> = [];
  const statuses: string[] = [];
  harness.binder.setStatusBroadcaster((_type, data) => {
    if (data['agentId'] === builtInAgentProfileId('parked')) {
      events.push(data);
      statuses.push(String(data['status']));
    }
  });
  return { ...harness, events, statuses };
}

async function parkedOnApproval(
  harness: ReturnType<typeof makeParkedBinder>
): Promise<ParkedOnApprovalAdapter> {
  await waitFor(() => harness.sessions.spawns() === 1);
  const adapter = harness.sessions.adapterFor(
    harness.sessions.firstSessionId()
  ) as ParkedOnApprovalAdapter;
  await waitFor(() => adapter.sendCalls.length === 1);
  await waitFor(() => harness.statuses.at(-1) === 'waiting');
  return adapter;
}

describe('channel-agent-binder — presence teardown (#1307)', () => {
  it('broadcasts a terminal idle when the runtime dies under a turn parked on approval', async () => {
    const harness = makeParkedBinder();
    const { binder, store, statuses } = harness;
    post(store, binder, '@parked go', ['parked']);
    const adapter = await parkedOnApproval(harness);

    // The watchdog is explicitly disarmed in this state, so nothing else can
    // ever move this binding off 'waiting'.
    adapter.die();
    await waitFor(() => statuses.at(-1) === 'idle');
    expect(statuses).toContain('waiting');
    expect(statuses.at(-1)).toBe('idle');
  });

  it('drops the queue on the same broadcast as the terminal idle, so no chip stays lit against a dead runtime', async () => {
    // `onRuntimeEnd` never fires here (the death is the adapter's own report),
    // so this covers the window BEFORE `releaseBinding` — up to a whole sweep
    // interval when the teardown event never arrives at all. An idle broadcast
    // carrying `queuedCount > 0` would leave the #1308 queued-send chips lit
    // with nothing left to drain them.
    const harness = makeParkedBinder();
    const { binder, store, events, statuses } = harness;
    post(store, binder, '@parked one', ['parked']);
    const adapter = await parkedOnApproval(harness);
    post(store, binder, '@parked two', ['parked']);
    await waitFor(() => events.at(-1)?.['queuedCount'] === 1);

    adapter.die();
    await waitFor(() => statuses.at(-1) === 'idle');
    expect(events.at(-1)?.['queuedCount']).toBe(0);
    // One row per dropped trigger, and nothing was pumped into the dead adapter.
    expect(
      systemRows(store).filter((row) =>
        row.body.text.includes(
          'runtime ended before delivering a queued message'
        )
      )
    ).toHaveLength(1);
    expect(adapter.sendCalls).toHaveLength(1);
  });

  it('sweeps a binding whose runtime vanished with no end event to idle, drains its queue, and durably unbinds', async () => {
    const harness = makeParkedBinder({ presenceSweepMs: 10 });
    const { binder, store, sessions, events, statuses } = harness;
    post(store, binder, '@parked one', ['parked']);
    await parkedOnApproval(harness);
    post(store, binder, '@parked two', ['parked']);
    await waitFor(() => events.at(-1)?.['queuedCount'] === 1);

    // The runtime disappears WITHOUT `onRuntimeEnd` ever firing — a release that
    // threw halfway, a manager torn down out from under the binder, any teardown
    // path that never reaches the one event the binder subscribes to.
    sessions.forgetWithoutEnd(sessions.firstSessionId());

    await waitFor(() => statuses.at(-1) === 'idle');
    expect(events.at(-1)?.['queuedCount']).toBe(0);
    expect(
      store.getBinding(CH, builtInAgentProfileId('parked'))?.runtimeId
    ).toBeNull();
    const ended = systemRows(store).filter((row) =>
      row.body.text.includes('runtime ended before delivering a queued message')
    );
    expect(ended).toHaveLength(1);
    // Nothing re-routes on its own: a swept binding stays down until the next
    // mention, so the operator never gets a silent respawn they did not ask for.
    expect(sessions.spawns()).toBe(1);
  });

  it('leaves a live runtime alone: the sweep never retires a binding that is genuinely waiting', async () => {
    const harness = makeParkedBinder({ presenceSweepMs: 5 });
    const { binder, store, statuses } = harness;
    post(store, binder, '@parked go', ['parked']);
    await parkedOnApproval(harness);
    // Many sweep ticks with the runtime still registered and healthy.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(statuses.at(-1)).toBe('waiting');
  });

  it('broadcasts a terminal idle for a busy binding on shutdown', async () => {
    const harness = makeParkedBinder();
    const { binder, store, statuses } = harness;
    post(store, binder, '@parked go', ['parked']);
    await parkedOnApproval(harness);
    binder.close();
    expect(statuses.at(-1)).toBe('idle');
  });
});
