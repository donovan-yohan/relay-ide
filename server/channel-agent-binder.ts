import os from 'node:os';

import { createLogger } from './logger.js';
import { bindSessionToChannel } from './channel-agent-bridge.js';
import {
  buildMentionContextPacketEnvelope,
  PACKET_MAX_ROWS,
  resolveMentionContextPacket,
  type ResolvedMentionContextPacket,
} from './channel-context-packet.js';
import type { ChannelAttachmentStore } from './channel-attachments.js';
import {
  CHANNEL_HISTORY_MAX_LIMIT,
  type ChannelBinding,
  type ChannelMessageStore,
} from './channel-message-store.js';
import type { ChannelHub } from './channel-hub.js';
import type { Attachment, ProtocolAdapterV2 } from './protocol-adapter-v2.js';
import type { CreateWebParams } from './web-session-handler.js';
import type { Session, WebSession } from './types.js';
import type { WorkspaceTopicStore } from './workspace-topics.js';
import { DEFAULT_LOCAL_NODE_ID } from '../shared/identity.js';
import { builtInAgentProfileId } from '../shared/agent-profile.js';
import {
  parseMentions,
  type ChannelMention,
  type ChannelMessage,
} from '../shared/channel-chat-protocol.js';
import type { AgentApprovalDecisionV2 } from '../shared/agent-chat-protocol-v2.js';

// @-mention routing binder (#1167, slice 4). One module owns the whole loop:
// subscribe to hub.onMessagePosted → resolve mentions → ensure a (channel,
// framework) web session (single-flight spawn | reuse | rebind) → wire the
// slice-2 bridge → build a context packet → deliver the turn. Single-node only.
//
// It never touches the wire protocol and requires ZERO adapter changes: the
// bridge remains the sole text mirror; the binder registers its OWN onPatch
// listener (multi-handler) watching only turn lifecycle / live-state / approval
// items so it can drive the queue, status, watchdog, and approval rows.

const logger = createLogger('channel-agent-binder');

// ── MVP policy knobs (single obvious constants — flip post-MVP) ───────────────

/**
 * MVP: channel-bound agents spawn in yolo / permission-bypass mode so mention
 * routing never wedges on an approval prompt (user decision, #1167). Flip to
 * `false` post-MVP to restore each framework's default permission prompts — the
 * approval-render path (§7) stays wired and lights up automatically if an
 * approval ever arrives.
 */
export const CHANNEL_BINDING_YOLO_DEFAULT = true;
/** Permission mode that maps to yolo for the web adapters (claude → --dangerously-skip-permissions). */
const YOLO_PERMISSION_MODE = 'bypassPermissions';

/** Per-binding FIFO turn queue cap; overflow → system row, message dropped. */
const QUEUE_CAP = 8;
/** Force-drain a genuinely-stuck turn after this long (paused while waitingOn != null). */
const DEFAULT_WATCHDOG_MS = 5 * 60 * 1000;
/** Consecutive agent-authored routed turns allowed between human/gateway posts. */
export const MAX_CONSECUTIVE_AGENT_TURNS = 4;
/** Dedupe identical unavailable/cross-node system rows per (channel, agent). */
const UNAVAILABLE_ROW_TTL_MS = 5 * 60 * 1000;
/** How long a resolved framework-availability list is reused before re-probing. */
const TARGETS_TTL_MS = 5 * 1000;
/** Newest rows fetched before the trigger to build a packet (packet caps to N). */
const PACKET_FETCH_WINDOW = Math.min(
  PACKET_MAX_ROWS * 3,
  CHANNEL_HISTORY_MAX_LIMIT
);

// ── public types ─────────────────────────────────────────────────────────────

export type ChannelAgentStatus =
  | 'spawning'
  | 'thinking'
  | 'streaming'
  | 'waiting'
  | 'idle';

/** A routable framework the binder resolves mentions against. */
export interface MentionTarget {
  id: string;
  displayName: string;
  kind: 'framework';
  available: boolean;
  reason: string | null;
}

export interface ChannelAgentRosterEntry {
  id: string;
  displayName: string;
  kind: 'framework';
  available: boolean;
  reason: string | null;
  binding: { sessionId: string; status: ChannelAgentStatus } | null;
}

export type ChannelAgentStatusBroadcaster = (
  type: string,
  data: Record<string, unknown>
) => void;

/** Minimal session surface the binder needs (real `sessions` module satisfies it). */
export interface BinderSessions {
  createWeb(params: CreateWebParams): Promise<{ session: WebSession }>;
  get(id: string): Session | undefined;
  onSessionEnd(
    cb: (sessionId: string, cwd: string, branchName?: string) => void
  ): () => void;
}

export interface ChannelAgentBinderDeps {
  store: ChannelMessageStore;
  /** Content-addressed image lane; production injects the config-dir store. */
  attachmentStore?: ChannelAttachmentStore | null;
  hub: ChannelHub;
  topicStore: WorkspaceTopicStore | null;
  sessions: BinderSessions;
  /** Resolve the current routable frameworks (builtin/configured + mock in tests). */
  mentionTargets: () => Promise<MentionTarget[]>;
  /** Provider ids used to resolve agent-to-agent mentions (adapter registry keys). */
  knownProviderIds: readonly string[];
  port: number;
  configDir: string;
  localNodeId?: string;
  watchdogMs?: number;
  yolo?: boolean;
  now?: () => number;
}

export interface ChannelAgentBinder {
  handleMessagePosted(
    message: ChannelMessage,
    mentions: ChannelMention[]
  ): void;
  ensureBinding(channelId: string, framework: string): Promise<LiveBinding>;
  interrupt(channelId: string, agentId: string): Promise<void>;
  respondToApproval(
    channelId: string,
    agentId: string,
    requestId: string,
    decision: AgentApprovalDecisionV2
  ): Promise<void>;
  rosterForChannel(channelId: string): Promise<ChannelAgentRosterEntry[]>;
  setStatusBroadcaster(broadcaster: ChannelAgentStatusBroadcaster): void;
  close(): void;
}

// ── internal live state ──────────────────────────────────────────────────────

interface QueuedTurn {
  trigger: ChannelMessage;
}

export interface LiveBinding {
  channelId: string;
  framework: string;
  displayName: string;
  sessionId: string | null;
  adapter: ProtocolAdapterV2 | null;
  unbind: (() => void) | null;
  patchUnlisten: (() => void) | null;
  status: ChannelAgentStatus;
  activeTurnId: string | null;
  /** Immediate thread parent keyed by routed turn; retained past binder idle. */
  parentMessageIdByTurn: Map<string, string | null>;
  /** Anonymous turn-0 cannot be associated safely after retained generations overlap. */
  turnZeroFallbackUnsafe: boolean;
  /** Context packet for the active turn (kept so a retry re-sends identical content). */
  activeContent: string | null;
  /** Resolved local payloads retained with activeContent across retry/rebind. */
  activeAttachments: Attachment[];
  sawStream: boolean;
  waitingOn: string | null;
  queue: QueuedTurn[];
  watchdog: NodeJS.Timeout | null;
  retriedTurns: Set<string>;
  announcedApprovals: Set<string>;
}

export class ChannelBindingError extends Error {
  constructor(
    message: string,
    /** Ready-to-post system-row text, rate-limited when `unavailable`. */
    readonly systemMessage: string,
    readonly unavailable = false
  ) {
    super(message);
    this.name = 'ChannelBindingError';
  }
}

export class ChannelAgentNotFoundError extends Error {
  constructor(message = 'no live binding for agent') {
    super(message);
    this.name = 'ChannelAgentNotFoundError';
  }
}

export class ChannelAgentNoActiveTurnError extends Error {
  constructor(message = 'agent has no active turn') {
    super(message);
    this.name = 'ChannelAgentNoActiveTurnError';
  }
}

/**
 * Thrown from an in-flight `doEnsureBinding` continuation that resumes AFTER
 * `close()`. It aborts the spawn/attach/store-write path so shutdown never
 * re-populates the cleared maps, arms a fresh watchdog, or writes to a closing
 * store. Callers swallow it silently (no system row) — it is a shutdown signal.
 */
class BinderClosedError extends Error {
  constructor() {
    super('channel agent binder is closed');
    this.name = 'BinderClosedError';
  }
}

const SYSTEM_SENDER = { kind: 'system', id: 'system' } as const;

function bindingKey(channelId: string, framework: string): string {
  return `${channelId}\u0000${framework}`;
}

export function createChannelAgentBinder(
  deps: ChannelAgentBinderDeps
): ChannelAgentBinder {
  const { store, hub, topicStore } = deps;
  const localNodeId = deps.localNodeId ?? DEFAULT_LOCAL_NODE_ID;
  const watchdogMs = deps.watchdogMs ?? DEFAULT_WATCHDOG_MS;
  const yolo = deps.yolo ?? CHANNEL_BINDING_YOLO_DEFAULT;
  const now = deps.now ?? (() => Date.now());

  const live = new Map<string, LiveBinding>();
  const inflight = new Map<string, Promise<LiveBinding>>();
  const consecutiveAgentTurns = new Map<
    string,
    {
      count: number;
      allowedTurnKeys: Set<string>;
      paused: boolean;
    }
  >();
  const unavailableRowAt = new Map<string, number>();
  let statusBroadcaster: ChannelAgentStatusBroadcaster | null = null;
  let targetsCache: { at: number; value: MentionTarget[] } | null = null;
  let closed = false;

  const unsubSessionEnd = deps.sessions.onSessionEnd((sessionId) =>
    handleSessionEnd(sessionId)
  );

  // ── system-row helpers ──────────────────────────────────────────────────────

  function postSystemRow(
    channelId: string,
    text: string,
    options: {
      meta?: Record<string, unknown>;
      parentMessageId?: string | undefined;
    } = {}
  ): void {
    try {
      const message = store.appendComplete({
        channelId,
        kind: 'system',
        sender: { ...SYSTEM_SENDER },
        text,
        ...(options.meta ? { meta: options.meta } : {}),
        ...(options.parentMessageId
          ? { parentMessageId: options.parentMessageId }
          : {}),
      });
      hub.broadcastCreated(message);
    } catch (err) {
      logger.warn('channel binder system row failed:', err);
    }
  }

  function postUnavailableRow(
    channelId: string,
    framework: string,
    text: string,
    parentMessageId?: string
  ): void {
    const key = `${bindingKey(channelId, framework)}\u0000${text}\u0000${parentMessageId ?? ''}`;
    const last = unavailableRowAt.get(key);
    if (last !== undefined && now() - last < UNAVAILABLE_ROW_TTL_MS) return;
    unavailableRowAt.set(key, now());
    postSystemRow(channelId, text, { parentMessageId });
  }

  function parentForTrigger(trigger: ChannelMessage): string | undefined {
    return trigger.threadId !== null ? trigger.id : undefined;
  }

  function parentKeyForTurn(
    binding: LiveBinding,
    turnId: string
  ): string | undefined {
    if (binding.parentMessageIdByTurn.has(turnId)) return turnId;
    // Hermes can label a late output item `turn-0` after clearing its current
    // turn. Use the retained parent only when there is exactly one possible
    // routed turn; ambiguity must fail closed rather than borrow a wrong thread.
    if (
      turnId === 'turn-0' &&
      binding.activeTurnId === null &&
      !binding.turnZeroFallbackUnsafe &&
      binding.parentMessageIdByTurn.size === 1
    ) {
      return binding.parentMessageIdByTurn.keys().next().value;
    }
    return undefined;
  }

  function parentForTurn(
    binding: LiveBinding,
    turnId: string
  ): string | undefined {
    const key = parentKeyForTurn(binding, turnId);
    return key === undefined
      ? undefined
      : (binding.parentMessageIdByTurn.get(key) ?? undefined);
  }

  function releaseTurnParent(binding: LiveBinding, turnId: string): void {
    const key = parentKeyForTurn(binding, turnId);
    if (key !== undefined) binding.parentMessageIdByTurn.delete(key);
  }

  // ── availability targets ────────────────────────────────────────────────────

  async function getTargets(): Promise<MentionTarget[]> {
    if (targetsCache && now() - targetsCache.at < TARGETS_TTL_MS) {
      return targetsCache.value;
    }
    const value = await deps.mentionTargets();
    targetsCache = { at: now(), value };
    return value;
  }

  async function resolveTarget(
    framework: string
  ): Promise<MentionTarget | undefined> {
    const targets = await getTargets();
    return targets.find((target) => target.id === framework);
  }

  /**
   * Vendor catalog label for the DEFAULT profile's `ChannelSenderRef.displayName`
   * (#1234). Reuses the (cached) mention-target probe as the label source and
   * fails soft to the raw framework id so an availability-probe error never blocks
   * a spawn or an attribution stamp.
   */
  async function senderLabelFor(framework: string): Promise<string> {
    try {
      return (await resolveTarget(framework))?.displayName ?? framework;
    } catch {
      return framework;
    }
  }

  // ── status ──────────────────────────────────────────────────────────────────

  function setStatus(binding: LiveBinding, status: ChannelAgentStatus): void {
    if (binding.status === status) return;
    binding.status = status;
    statusBroadcaster?.('channel-agent-status', {
      channelId: binding.channelId,
      agentId: binding.framework,
      status,
      sessionId: binding.sessionId ?? null,
    });
  }

  // ── watchdog ────────────────────────────────────────────────────────────────

  function armWatchdog(binding: LiveBinding): void {
    disarmWatchdog(binding);
    binding.watchdog = setTimeout(() => {
      binding.watchdog = null;
      // Never force-drain a turn parked on a human approval (§3 / Amendment 2):
      // that would abandon the approval and release a concurrent send.
      if (binding.activeTurnId === null || binding.waitingOn !== null) return;
      logger.warn('channel binder watchdog force-drained a stuck turn', {
        channelId: binding.channelId,
        framework: binding.framework,
        turnId: binding.activeTurnId,
      });
      finishTurn(binding);
    }, watchdogMs);
    binding.watchdog.unref?.();
  }

  function disarmWatchdog(binding: LiveBinding): void {
    if (binding.watchdog) {
      clearTimeout(binding.watchdog);
      binding.watchdog = null;
    }
  }

  // ── binding lifecycle ───────────────────────────────────────────────────────

  function newLiveBinding(
    channelId: string,
    framework: string,
    displayName: string
  ): LiveBinding {
    return {
      channelId,
      framework,
      displayName,
      sessionId: null,
      adapter: null,
      unbind: null,
      patchUnlisten: null,
      status: 'idle',
      activeTurnId: null,
      parentMessageIdByTurn: new Map(),
      turnZeroFallbackUnsafe: false,
      activeContent: null,
      activeAttachments: [],
      sawStream: false,
      waitingOn: null,
      queue: [],
      watchdog: null,
      retriedTurns: new Set(),
      announcedApprovals: new Set(),
    };
  }

  function attachSession(
    channelId: string,
    framework: string,
    displayName: string,
    senderDisplayName: string,
    session: { id: string; adapterV2: ProtocolAdapterV2 }
  ): LiveBinding {
    const key = bindingKey(channelId, framework);
    const existing = live.get(key);
    // Tear down any prior wiring before re-binding a fresh adapter.
    existing?.unbind?.();
    existing?.patchUnlisten?.();
    if (existing) {
      // A rejected send can discover a dead transport, attach a replacement
      // session, then redeliver the SAME active turn. Preserve that turn's
      // parent across the rebind; discard only idle/older retained entries.
      for (const turnId of existing.parentMessageIdByTurn.keys()) {
        if (turnId !== existing.activeTurnId) {
          existing.parentMessageIdByTurn.delete(turnId);
        }
      }
      // Removing the old adapter listeners establishes a hard boundary for
      // anonymous provider turn ids while retaining an exact active retry.
      existing.turnZeroFallbackUnsafe = false;
    }
    const binding =
      existing ?? newLiveBinding(channelId, framework, displayName);
    binding.displayName = displayName;
    binding.sessionId = session.id;
    binding.adapter = session.adapterV2;
    binding.unbind = bindSessionToChannel({
      channelId,
      agentFramework: framework,
      adapter: session.adapterV2,
      store,
      ...(deps.attachmentStore
        ? { attachmentStore: deps.attachmentStore }
        : {}),
      hub,
      // Sender attribution (#1234): the durable ChannelSenderRef carries the
      // vendor DEFAULT profile Actor id + the vendor catalog label, NOT the
      // session/tab composite (`binding.displayName`). One session == one profile.
      profileActorId: builtInAgentProfileId(framework),
      displayName: senderDisplayName,
      parentMessageIdForTurn: (turnId) => parentForTurn(binding, turnId),
      onAssistantMessageFinalized: (message) =>
        handleAssistantFinalized(message),
    });
    binding.patchUnlisten = session.adapterV2.onPatch((patch) =>
      handleBindingPatch(binding, patch)
    );
    live.set(key, binding);
    return binding;
  }

  function healthySession(
    sessionId: string | null,
    framework: string
  ): (Session & { adapterV2: ProtocolAdapterV2 }) | null {
    if (!sessionId) return null;
    const session = deps.sessions.get(sessionId);
    if (
      session &&
      session.mode === 'web' &&
      session.agent === framework &&
      session.adapterV2
    ) {
      return session as Session & { adapterV2: ProtocolAdapterV2 };
    }
    return null;
  }

  function displayNameFor(channelId: string, framework: string): string {
    const topic = topicStore?.get(channelId);
    return `#${topic?.display.title ?? channelId} · ${framework}`;
  }

  async function doEnsureBinding(
    channelId: string,
    framework: string
  ): Promise<LiveBinding> {
    if (closed) throw new BinderClosedError();
    const key = bindingKey(channelId, framework);
    const displayName = displayNameFor(channelId, framework);

    // 2. Reuse a live entry whose session is still healthy.
    const existing = live.get(key);
    if (existing?.adapter && existing.sessionId) {
      const session = healthySession(existing.sessionId, framework);
      if (session && session.adapterV2 === existing.adapter) return existing;
    }

    // Sender attribution label (#1234): the vendor DEFAULT profile inherits the
    // framework catalog label (built-in default profiles carry an empty stored
    // displayName). Resolved past the reuse fast-path so a hot rebind pays no
    // availability probe; failures fall back to the raw framework id.
    const senderDisplayName = await senderLabelFor(framework);

    // 3. Rebind a restored session that survived a live reconnect / restart.
    const row = store.getBinding(channelId, framework);
    const restored = healthySession(row?.sessionId ?? null, framework);
    if (restored) {
      return attachSession(
        channelId,
        framework,
        displayName,
        senderDisplayName,
        restored
      );
    }

    // 3.5 Cross-node guard (Amendment 1): a remote-node topic must fail visibly,
    // never spawn a local stand-in.
    const topic = topicStore?.get(channelId);
    const nodeId = topic?.routingDefaults.nodeId;
    if (nodeId && nodeId !== localNodeId) {
      throw new ChannelBindingError(
        `topic ${channelId} routes to remote node ${nodeId}`,
        'Agents on other nodes are not yet supported in channels.',
        true
      );
    }

    // 4. Spawn a fresh local web session.
    const routing = topic?.routingDefaults ?? {};
    const cwd =
      routing.cwd ?? routing.worktreePath ?? routing.repoPath ?? os.homedir();
    const provisional =
      existing ?? newLiveBinding(channelId, framework, displayName);
    live.set(key, provisional);
    setStatus(provisional, 'spawning');
    let created: { session: WebSession };
    try {
      created = await deps.sessions.createWeb({
        agentType: framework,
        cwd,
        displayName,
        port: deps.port,
        configDir: deps.configDir,
        ...(routing.repoPath ? { repoPath: routing.repoPath } : {}),
        ...(routing.worktreePath ? { worktreePath: routing.worktreePath } : {}),
        ...(yolo ? { permissionMode: YOLO_PERMISSION_MODE } : {}),
      });
    } catch (err) {
      setStatus(provisional, 'idle');
      throw new ChannelBindingError(
        `spawn failed for @${framework}: ${errText(err)}`,
        `@${framework} failed to start: ${errText(err)}`
      );
    }
    // close() may have raced the spawn await: abort before we attach a bridge,
    // arm listeners, or write to a closing store (Amendment: shutdown contract).
    if (closed) throw new BinderClosedError();
    const binding = attachSession(
      channelId,
      framework,
      displayName,
      senderDisplayName,
      created.session
    );
    store.upsertBinding({
      channelId,
      agentFramework: framework,
      sessionId: created.session.id,
    });
    setStatus(binding, 'idle');
    return binding;
  }

  function ensureBinding(
    channelId: string,
    framework: string
  ): Promise<LiveBinding> {
    const key = bindingKey(channelId, framework);
    const pending = inflight.get(key);
    if (pending) return pending;
    // Store the promise BEFORE any await so two concurrent mentions of the same
    // framework in one channel single-flight to exactly one spawn.
    const promise = doEnsureBinding(channelId, framework).finally(() => {
      inflight.delete(key);
    });
    inflight.set(key, promise);
    return promise;
  }

  // ── turn queue + delivery ───────────────────────────────────────────────────

  function enqueueTurn(binding: LiveBinding, trigger: ChannelMessage): void {
    if (binding.queue.length >= QUEUE_CAP) {
      postSystemRow(
        binding.channelId,
        `@${binding.framework} has ${QUEUE_CAP} turns queued — message dropped`,
        { parentMessageId: parentForTrigger(trigger) }
      );
      return;
    }
    binding.queue.push({ trigger });
    pump(binding);
  }

  function pump(binding: LiveBinding): void {
    if (binding.activeTurnId !== null) return;
    if (!binding.adapter) return;
    const next = binding.queue.shift();
    if (!next) return;
    sendTurn(binding, next.trigger);
  }

  function buildPacket(
    binding: LiveBinding,
    trigger: ChannelMessage
  ): ResolvedMentionContextPacket {
    const topic = topicStore?.get(binding.channelId);
    const title = topic?.display.title ?? binding.channelId;
    const row = store.getBinding(binding.channelId, binding.framework);
    const lastDeliveredSeq =
      typeof row?.providerSession['lastDeliveredSeq'] === 'number'
        ? (row.providerSession['lastDeliveredSeq'] as number)
        : 0;
    let rows: ChannelMessage[];
    if (trigger.threadId !== null) {
      rows = store.threadHistory(binding.channelId, trigger.threadId, {
        beforeSeq: trigger.seq,
        limit: PACKET_FETCH_WINDOW,
      });
      // A bounded newest-first page may omit the load-bearing root. Reinsert it
      // through the existing point-read lane; the builder preserves it through
      // row and byte trimming.
      const root = store.getMessage(trigger.threadId);
      if (root) rows.push(root);
      rows = [...new Map(rows.map((message) => [message.id, message])).values()]
        .filter((message) => message.seq < trigger.seq)
        .sort((a, b) => a.seq - b.seq);
    } else {
      rows = store
        .history(binding.channelId, {
          beforeSeq: trigger.seq,
          limit: PACKET_FETCH_WINDOW,
        })
        .filter((r) => r.seq < trigger.seq);
    }
    return resolveMentionContextPacket(
      buildMentionContextPacketEnvelope({
        channelTitle: title,
        framework: binding.framework,
        rows,
        trigger,
        lastDeliveredSeq,
      }),
      deps.attachmentStore
    );
  }

  function sendTurn(binding: LiveBinding, trigger: ChannelMessage): void {
    const adapter = binding.adapter;
    if (!adapter) return;
    const turnId = `chturn-${trigger.id}-${binding.framework}`;
    // Build the packet BEFORE mutating any binding state: buildPacket does
    // synchronous SQLite work (getBinding/history) that can throw. If it did so
    // AFTER activeTurnId was set (and before the watchdog armed), the binding
    // wedged 'turn-active' forever with no in-flight turn — the queue filled and
    // every later mention dropped. On a throw we surface a row and keep draining.
    let packet: ResolvedMentionContextPacket;
    try {
      packet = buildPacket(binding, trigger);
    } catch (err) {
      logger.warn('channel binder packet build failed:', err);
      postSystemRow(
        binding.channelId,
        `@${binding.framework} could not build the message context: ${errText(err)}`,
        { parentMessageId: parentForTrigger(trigger) }
      );
      pump(binding); // activeTurnId is still null — keep the queue draining
      return;
    }
    // Retained parents exist solely for output that opens shortly after a bare
    // idle finalized its turn. Once a successor starts, the old association is
    // no longer safe for a turn-0 fallback and must not accumulate forever.
    if (binding.parentMessageIdByTurn.size > 0) {
      // A successor started while its predecessor was retained after bare idle.
      // Future anonymous turn-0 patches cannot be assigned to either generation
      // safely; exact turn ids continue to work.
      binding.turnZeroFallbackUnsafe = true;
    }
    binding.parentMessageIdByTurn.clear();
    binding.activeTurnId = turnId;
    binding.parentMessageIdByTurn.set(
      turnId,
      parentForTrigger(trigger) ?? null
    );
    binding.sawStream = false;
    binding.waitingOn = null;
    binding.activeContent = packet.content;
    binding.activeAttachments = packet.attachments;
    setStatus(binding, 'thinking');
    armWatchdog(binding);
    deliver(binding, adapter, turnId, trigger);
  }

  function deliver(
    binding: LiveBinding,
    adapter: ProtocolAdapterV2,
    turnId: string,
    trigger: ChannelMessage
  ): void {
    adapter
      .sendMessage({
        turnId,
        content: binding.activeContent ?? '',
        ...(binding.activeAttachments.length > 0
          ? { attachments: binding.activeAttachments }
          : {}),
        // Deterministic per routed (message, framework) turn (Amendment 3): a
        // retry reuses the same turn identity. `clientMessageId` is forward-compat
        // only — no adapter dedupes on it today.
        clientMessageId: `${trigger.id}:${binding.framework}`,
      })
      .then(() => advanceCursor(binding, trigger))
      .catch((err) => handleSendFailure(binding, trigger, turnId, err));
  }

  function advanceCursor(binding: LiveBinding, trigger: ChannelMessage): void {
    if (closed) return; // never write to a closing store from an in-flight send
    // Thread packets deliberately ignore the channel-global cursor. Advancing it
    // here would make a later top-level mention skip intervening channel rows.
    if (trigger.threadId !== null) return;
    const triggerSeq = trigger.seq;
    // Cursor advances only on send acceptance (§4): a failed send re-offers the
    // rows next mention (at-least-once). Never lower the cursor.
    try {
      const row = store.getBinding(binding.channelId, binding.framework);
      const prev = row?.providerSession ?? {};
      const current =
        typeof prev['lastDeliveredSeq'] === 'number'
          ? (prev['lastDeliveredSeq'] as number)
          : 0;
      if (triggerSeq <= current) return;
      store.upsertBinding({
        channelId: binding.channelId,
        agentFramework: binding.framework,
        providerSession: { ...prev, lastDeliveredSeq: triggerSeq },
      });
    } catch (err) {
      logger.warn('channel binder cursor advance failed:', err);
    }
  }

  async function handleSendFailure(
    binding: LiveBinding,
    trigger: ChannelMessage,
    turnId: string,
    err: unknown
  ): Promise<void> {
    if (closed) return; // shutdown in progress — no rows, no re-delivery
    // A rejected sendMessage means the turn was NEVER accepted (Amendment 3), so
    // a single retry-after-rebind is safe — covers dead legacy-bridge transports.
    if (!binding.retriedTurns.has(turnId)) {
      binding.retriedTurns.add(turnId);
      try {
        const rebound = await ensureBinding(
          binding.channelId,
          binding.framework
        );
        if (closed) return;
        if (rebound.adapter && rebound.activeTurnId === turnId) {
          // Same binding still owns this turn — redeliver identical content.
          deliver(rebound, rebound.adapter, turnId, trigger);
          return;
        }
        if (rebound.adapter) {
          // The binding was rebound to a fresh/different session (e.g. after the
          // failed send tore the session down). A NEWER turn may already be
          // active on it — never clobber it. Re-enqueue (cap-respecting): pump
          // delivers when the binding is free, and sendTurn re-establishes the
          // status/sawStream/watchdog for the retried turn instead of the
          // fallback overwriting an in-flight turn's lifecycle tracking.
          enqueueTurn(rebound, trigger);
          return;
        }
      } catch {
        // fall through to the error row
      }
    }
    postSystemRow(
      binding.channelId,
      `@${binding.framework} could not receive the message: ${errText(err)}`,
      { parentMessageId: parentForTrigger(trigger) }
    );
    releaseTurnParent(binding, turnId);
    finishTurn(binding);
  }

  function finishTurn(binding: LiveBinding): void {
    if (binding.activeTurnId === null) return;
    binding.activeTurnId = null;
    binding.activeContent = null;
    binding.activeAttachments = [];
    binding.waitingOn = null;
    binding.sawStream = false;
    disarmWatchdog(binding);
    setStatus(binding, 'idle');
    pump(binding);
  }

  // ── binder-owned patch listener ─────────────────────────────────────────────

  function markStreaming(binding: LiveBinding): void {
    binding.sawStream = true;
    if (binding.waitingOn === null) setStatus(binding, 'streaming');
  }

  function handleBindingPatch(
    binding: LiveBinding,
    patch: import('../shared/agent-chat-protocol-v2.js').AgentPatchV2
  ): void {
    switch (patch.type) {
      case 'agent-item-started-v2':
        if (patch.item.type === 'approval') {
          handleApprovalStarted(binding, patch.item);
        } else if (
          patch.turnId === binding.activeTurnId &&
          patch.item.type === 'assistantMessage'
        ) {
          markStreaming(binding);
        }
        break;
      case 'agent-item-delta-v2':
        if (
          patch.turnId === binding.activeTurnId &&
          typeof patch.delta.text === 'string'
        ) {
          markStreaming(binding);
        }
        break;
      case 'agent-item-updated-v2':
        if (patch.item.type === 'approval' && patch.item.decision) {
          handleApprovalResolved(binding, patch.item);
        }
        break;
      case 'agent-live-state-updated-v2':
        if (patch.live.status === 'idle') {
          // A session that reports `idle` has no active turn. Finalize ours even
          // when a matching `agent-turn-completed-v2` never fired (or arrives
          // after this idle live-state): hermes can emit `session-status idle`
          // without a paired turn-completed when its turn id was already
          // cleared, and the `waitingOn` branch below would otherwise flip the
          // binding back to 'thinking' and wedge presence forever (#1181 defect
          // 3).
          //
          // BUT while an approval is outstanding (or the binding is otherwise
          // waiting) the idle is a lie: hermes fires `session-status
          // {status:'idle', waitingOn:'approval'}` alongside a permission
          // prompt, and the legacy compat mapping strips the `waitingOn` for the
          // idle case (agent-chat-v1-compat.ts), so a BARE idle arrives
          // mid-approval. Ignore it entirely then — finalizing would abandon the
          // approval and let `pump` dispatch a concurrent turn to the same
          // session, and falling through to `updateWaiting(null)` would clobber
          // the waiting state and re-arm the watchdog against the parked turn.
          if (
            binding.activeTurnId !== null &&
            binding.announcedApprovals.size === 0 &&
            binding.waitingOn === null
          ) {
            finishTurn(binding);
          }
          break;
        }
        if (patch.live.waitingOn !== undefined) {
          updateWaiting(binding, patch.live.waitingOn);
        }
        break;
      case 'agent-turn-completed-v2': {
        // The bridge listener runs first, so any terminally-opened row has
        // already resolved its parent. Prune before finishTurn pumps a queued
        // turn, so a Hermes fallback cannot become ambiguous with its successor.
        const completedByExactTurnId = binding.parentMessageIdByTurn.has(
          patch.turnId
        );
        const completedParentKey = parentKeyForTurn(binding, patch.turnId);
        releaseTurnParent(binding, patch.turnId);
        if (completedByExactTurnId) {
          // An exact terminal establishes which retained generation ended, so
          // a later isolated turn may safely use the anonymous fallback again.
          binding.turnZeroFallbackUnsafe = false;
        }
        if (
          patch.turnId === binding.activeTurnId ||
          completedParentKey === binding.activeTurnId
        ) {
          finishTurn(binding);
        }
        break;
      }
      case 'agent-error-v2':
        {
          const activeTurnId = binding.activeTurnId;
          if (activeTurnId !== null && patch.turnId === undefined) {
            // Legacy chat:error dispatches its paired turn-0 completion only
            // after this handler returns. The queued successor can bare-idle
            // synchronously while finishTurn pumps it, so mark the anonymous
            // namespace unsafe before that successor starts.
            binding.turnZeroFallbackUnsafe = true;
          }
          const terminalTurnId = patch.turnId ?? binding.activeTurnId;
          const terminalByExactTurnId =
            patch.turnId !== undefined &&
            binding.parentMessageIdByTurn.has(patch.turnId);
          const terminalParentKey =
            terminalTurnId === null
              ? undefined
              : parentKeyForTurn(binding, terminalTurnId);
          const targetsActiveTurn =
            activeTurnId !== null &&
            (patch.turnId === activeTurnId ||
              terminalParentKey === activeTurnId);
          const targetsIdleBinding =
            activeTurnId === null && patch.turnId === undefined;
          if (targetsActiveTurn || targetsIdleBinding) {
            // Only surface a system row when NO assistant row opened — otherwise the
            // bridge's `failed` finalize is the visible artifact (§7, no duplicate).
            if (!binding.sawStream) {
              postSystemRow(
                binding.channelId,
                `@${binding.framework} errored: ${patch.message}`,
                {
                  parentMessageId:
                    activeTurnId === null
                      ? undefined
                      : parentForTurn(binding, activeTurnId),
                }
              );
            }
          }
          if (terminalTurnId !== null) {
            releaseTurnParent(binding, terminalTurnId);
          }
          if (terminalByExactTurnId) {
            binding.turnZeroFallbackUnsafe = false;
          }
          if (targetsActiveTurn) {
            finishTurn(binding);
          }
        }
        break;
      default:
        break;
    }
  }

  function updateWaiting(binding: LiveBinding, waitingOn: string | null): void {
    binding.waitingOn = waitingOn;
    if (binding.activeTurnId === null) return;
    if (waitingOn !== null) {
      setStatus(binding, 'waiting');
      disarmWatchdog(binding);
    } else {
      setStatus(binding, binding.sawStream ? 'streaming' : 'thinking');
      armWatchdog(binding);
    }
  }

  function handleApprovalStarted(
    binding: LiveBinding,
    item: import('../shared/agent-chat-protocol-v2.js').AgentApprovalItemV2
  ): void {
    if (binding.announcedApprovals.has(item.requestId)) return;
    binding.announcedApprovals.add(item.requestId);
    postSystemRow(
      binding.channelId,
      `@${binding.framework} requests approval: ${item.description} (${item.target})`,
      {
        parentMessageId:
          binding.activeTurnId === null
            ? undefined
            : parentForTurn(binding, binding.activeTurnId),
        meta: {
          approvalRequestId: item.requestId,
          agentId: binding.framework,
          sessionId: binding.sessionId,
        },
      }
    );
  }

  function handleApprovalResolved(
    binding: LiveBinding,
    item: import('../shared/agent-chat-protocol-v2.js').AgentApprovalItemV2
  ): void {
    if (!binding.announcedApprovals.has(item.requestId)) return;
    binding.announcedApprovals.delete(item.requestId);
    const kind = item.decision?.kind ?? 'resolved';
    postSystemRow(binding.channelId, `@${binding.framework} approval ${kind}`, {
      parentMessageId:
        binding.activeTurnId === null
          ? undefined
          : parentForTurn(binding, binding.activeTurnId),
    });
  }

  // ── routing ─────────────────────────────────────────────────────────────────

  function routeOne(trigger: ChannelMessage, framework: string): void {
    void (async () => {
      try {
        const target = await resolveTarget(framework);
        if (closed) return; // close() raced the availability probe
        if (!target) return; // not a known framework — ignore silently
        if (!target.available) {
          postUnavailableRow(
            trigger.channelId,
            framework,
            `@${framework} is not available in channels yet — ${target.reason ?? 'web sessions unavailable.'}`,
            parentForTrigger(trigger)
          );
          return;
        }
        let binding: LiveBinding;
        try {
          binding = await ensureBinding(trigger.channelId, framework);
        } catch (err) {
          if (err instanceof BinderClosedError) return; // shutdown — silent
          if (err instanceof ChannelBindingError) {
            if (err.unavailable) {
              postUnavailableRow(
                trigger.channelId,
                framework,
                err.systemMessage,
                parentForTrigger(trigger)
              );
            } else {
              postSystemRow(trigger.channelId, err.systemMessage, {
                parentMessageId: parentForTrigger(trigger),
              });
            }
            return;
          }
          throw err;
        }
        if (closed) return; // never enqueue/spawn a turn after close()
        enqueueTurn(binding, trigger);
      } catch (err) {
        if (closed || err instanceof BinderClosedError) return;
        logger.warn('channel binder route failed:', err);
      }
    })();
  }

  /** Eligible (providerId-resolved, non-self) mentions in routing order. */
  function eligibleFrameworks(
    message: ChannelMessage,
    mentions: ChannelMention[]
  ): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const mention of mentions) {
      const framework = mention.providerId;
      if (!framework) continue; // unknown @name never routes (§1)
      if (framework === message.sender.providerId) continue; // self-mention
      if (seen.has(framework)) continue;
      seen.add(framework);
      out.push(framework);
    }
    return out;
  }

  function agentTurnBrakeKey(message: ChannelMessage): string {
    if (message.source?.sessionId && message.source.turnId) {
      return `${message.source.sessionId}\u0000${message.source.turnId}`;
    }
    // Gateway agent posts do not yet carry provider turn identity. Treat each
    // durable post as one turn instead of collapsing unrelated agent activity.
    return `message:${message.id}`;
  }

  /**
   * Route an AGENT-authored turn's mentions under the consecutive-agent brake
   * (Amendment 5). The brake counts a durable provider turn once, keyed by
   * (source session, source turn), regardless of how many assistant item rows
   * or mention targets that turn fans out to. Shared by bound-session replies
   * AND gateway-agent posts so neither can escape the token-spend guard between
   * human turns.
   */
  function routeWithBrake(message: ChannelMessage, frameworks: string[]): void {
    if (frameworks.length === 0) return;
    const turnKey = agentTurnBrakeKey(message);
    let state = consecutiveAgentTurns.get(message.channelId);
    if (!state) {
      state = { count: 0, allowedTurnKeys: new Set(), paused: false };
      consecutiveAgentTurns.set(message.channelId, state);
    }
    // Pause is a per-dispatch safety check, not a turn-admission check. A turn
    // may legitimately finalize several assistant items, but none may route
    // after another turn has paused the channel.
    if (state.paused) return;
    if (!state.allowedTurnKeys.has(turnKey)) {
      if (state.count >= MAX_CONSECUTIVE_AGENT_TURNS) {
        state.paused = true;
        // Bounds total agent-token spend between human turns. Reset happens
        // on the next human (browser / gateway-human) post.
        postSystemRow(
          message.channelId,
          `Mention chain paused — ${state.count} agent turns without a human.`,
          { parentMessageId: parentForTrigger(message) }
        );
        return;
      }
      state.allowedTurnKeys.add(turnKey);
      state.count += 1;
    }
    for (const framework of frameworks) {
      routeOne(message, framework);
    }
  }

  function handleMessagePosted(
    message: ChannelMessage,
    mentions: ChannelMention[]
  ): void {
    if (closed) return;
    if (message.kind !== 'message') return; // system rows never route (§1)
    // Both browser-human and CLI-gateway-actor posts arrive here (postToChannel
    // fires onMessagePosted for both). Routing is IDENTICAL for both (locked
    // decision: @claude via gateway == browser). The loop brake, however, keys
    // off the server-derived sender kind — never the transport:
    //   • human sender (browser cookie lane, or a gateway actor that maps to a
    //     human operator) → resets the consecutive-agent counter, routes freely.
    //   • agent sender (deriveSender kind 'agent', incl. CLI-gateway actor posts
    //     — the shipped agent-mail loop) → an agent-authored turn: it INCREMENTS
    //     the counter and is subject to the cap, exactly like a bound reply.
    // Without this a bound agent posting via `relay-ide v1 channels.post` would
    // both bypass the increment AND reset the brake, defeating the sole
    // token-spend guard between human turns (#1167 P1).
    const frameworks = eligibleFrameworks(message, mentions);
    if (message.sender.kind === 'agent') {
      routeWithBrake(message, frameworks);
      return;
    }
    consecutiveAgentTurns.delete(message.channelId);
    for (const framework of frameworks) {
      routeOne(message, framework);
    }
  }

  function handleAssistantFinalized(message: ChannelMessage): void {
    if (closed) return;
    const mentions = parseMentions(message.body.text, deps.knownProviderIds);
    routeWithBrake(message, eligibleFrameworks(message, mentions));
  }

  // ── session death ───────────────────────────────────────────────────────────

  function handleSessionEnd(sessionId: string): void {
    for (const [key, binding] of live) {
      if (binding.sessionId !== sessionId) continue;
      binding.unbind?.(); // bridge finalizes any open stream 'interrupted'
      binding.patchUnlisten?.();
      disarmWatchdog(binding);
      for (const queued of binding.queue) {
        postSystemRow(
          binding.channelId,
          `@${binding.framework} session ended before delivering a queued message.`,
          { parentMessageId: parentForTrigger(queued.trigger) }
        );
      }
      binding.queue = [];
      binding.adapter = null;
      binding.unbind = null;
      binding.patchUnlisten = null;
      binding.activeTurnId = null;
      binding.parentMessageIdByTurn.clear();
      binding.activeContent = null;
      binding.activeAttachments = [];
      binding.waitingOn = null;
      binding.announcedApprovals.clear();
      setStatus(binding, 'idle');
      live.delete(key);
      try {
        store.upsertBinding({
          channelId: binding.channelId,
          agentFramework: binding.framework,
          sessionId: null,
        });
      } catch (err) {
        logger.warn('channel binder unbind persist failed:', err);
      }
    }
  }

  // ── control verbs ───────────────────────────────────────────────────────────

  async function interrupt(channelId: string, agentId: string): Promise<void> {
    const binding = live.get(bindingKey(channelId, agentId));
    if (!binding || !binding.adapter) throw new ChannelAgentNotFoundError();
    if (binding.activeTurnId === null)
      throw new ChannelAgentNoActiveTurnError();
    await binding.adapter.interrupt({ turnId: binding.activeTurnId });
  }

  async function respondToApproval(
    channelId: string,
    agentId: string,
    requestId: string,
    decision: AgentApprovalDecisionV2
  ): Promise<void> {
    const binding = live.get(bindingKey(channelId, agentId));
    if (!binding || !binding.adapter) throw new ChannelAgentNotFoundError();
    await binding.adapter.respondToApproval({ requestId, decision });
  }

  async function rosterForChannel(
    channelId: string
  ): Promise<ChannelAgentRosterEntry[]> {
    const targets = await getTargets();
    return targets.map((target) => {
      const binding = live.get(bindingKey(channelId, target.id));
      const row = store.getBinding(channelId, target.id);
      const sessionId = binding?.sessionId ?? row?.sessionId ?? null;
      return {
        id: target.id,
        displayName: target.displayName,
        kind: 'framework',
        available: target.available,
        reason: target.reason,
        binding: sessionId
          ? { sessionId, status: binding?.status ?? 'idle' }
          : null,
      };
    });
  }

  return {
    handleMessagePosted,
    ensureBinding,
    interrupt,
    respondToApproval,
    rosterForChannel,
    setStatusBroadcaster(broadcaster) {
      statusBroadcaster = broadcaster;
    },
    close() {
      closed = true;
      unsubSessionEnd();
      for (const binding of live.values()) {
        disarmWatchdog(binding);
        binding.unbind?.();
        binding.patchUnlisten?.();
        binding.parentMessageIdByTurn.clear();
      }
      live.clear();
      inflight.clear();
      consecutiveAgentTurns.clear();
      unavailableRowAt.clear();
      targetsCache = null;
    },
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Keep referenced binding shape exported for callers/tests without widening deps.
export type { ChannelBinding };
