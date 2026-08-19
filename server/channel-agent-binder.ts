import os from 'node:os';

import { createLogger } from './logger.js';
import { resolveExecutablePath } from './frameworks.js';
import { bindSessionToChannel } from './channel-agent-bridge.js';
import {
  buildMentionContextPacketEnvelope,
  PACKET_MAX_ROWS,
  resolveMentionContextPacket,
  type ResolvedMentionContextPacket,
} from './channel-context-packet.js';
import type { ChannelAttachmentStore } from './channel-attachments.js';
import {
  createChannelOrchestratorConflictError,
  type ChannelBinding,
  type ChannelCompletionCallbackEdge,
  type ChannelCompletionCallbackMessageDisposition,
  type ChannelCompletionCallbackTerminalReason,
  type ChannelMessageStore,
} from './channel-message-store.js';
import type { ChannelHub, ChannelMessagePostedOptions } from './channel-hub.js';
import {
  AgentControlUnavailableError,
  AgentSteerRejectedError,
  type Attachment,
  type ProtocolAdapterV2,
} from './protocol-adapter-v2.js';
import type {
  ChannelAgentRuntime,
  CreateChannelAgentRuntimeParams,
} from './channel-agent-runtime.js';
import { providerResumeId } from './channel-agent-runtime.js';
import {
  relayControlCatalogForProvider,
  relayControlInputGuardCatalogForProvider,
} from '../shared/agent-command-catalog.js';
import type { WorkspaceTopicStore } from './workspace-topics.js';
import type { AgentProfileStore } from './agent-profile-store.js';
import { DEFAULT_LOCAL_NODE_ID } from '../shared/identity.js';
import {
  builtInAgentProfileId,
  resolveProfileForMention,
  type AgentProfile,
} from '../shared/agent-profile.js';
import {
  channelRetryTarget,
  channelTurnId,
  isChannelMessageDeleted,
  parseMentions,
  CHANNEL_RETRY_OF_META_KEY,
  type ChannelAsyncRunApprovalState,
  type ChannelAsyncRunTargetState,
  type ChannelMention,
  type ChannelMessage,
  type ChannelPostSteering,
  type ChannelSenderRef,
} from '../shared/channel-chat-protocol.js';
import type {
  AgentApprovalDecisionV2,
  AgentApprovalItemV2,
  AgentLiveStateUpdatedPatchV2,
  AgentPatchV2,
  AgentSlashCommandV2,
} from '../shared/agent-chat-protocol-v2.js';
import type { AgentRole } from '../shared/agent-roster.js';
import { isDmChannel } from '../shared/dm-channels.js';
import { workspaceTopicAgentRuntimeLinkPatch } from '../shared/workspace-topics.js';

// Channel routing binder (#1167, #1353). One module owns the whole loop:
// subscribe to hub.onMessagePosted → resolve explicit mentions or the implicit
// DM/designated-orchestrator recipient → ensure a (channel, profile) runtime
// (single-flight spawn | reuse | rebind) → wire the slice-2 bridge → build a
// context packet → deliver the turn. Single-node only.
//
// It never touches the wire protocol and requires ZERO adapter changes: the
// bridge remains the sole text mirror; the binder registers its OWN onPatch
// listener (multi-handler) watching only turn lifecycle / live-state / approval
// items so it can drive the queue, status, watchdog, and approval rows.
//
// ── mid-turn steering (#1308 slice 4) ────────────────────────────────────────
// A post addressed to a binding that is already mid-turn never opens a second
// concurrent turn and is never dropped. Providers exposing `capabilities.steer`
// receive the post through their own safe-boundary primitive; every other
// provider uses the existing FIFO queue, which `pump` drains after completion.
//
// `steering: 'interrupt'` is the operator's explicit "interrupt and send": the
// live turn is cancelled through the SAME `adapter.interrupt` path the header
// chip already uses (the bridge finalizes its partial row `interrupted`), and
// the queued message dispatches the moment that turn releases.
//
// Restart durability (accepted limit, #1308 slice 4): the queue is in-memory
// TURN-TRIGGER state only. A hub restart loses pending triggers; it never loses
// messages — every queued post is already durable in `channel_messages`, and the
// operator re-triggers by sending again. Persisting trigger intent across a
// restart would also have to survive a runtime that no longer exists, so it is
// deliberately out of scope for this slice.

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
/** Permission mode that maps to yolo for channel adapters (claude → --dangerously-skip-permissions). */
const YOLO_PERMISSION_MODE = 'bypassPermissions';

/** Per-binding FIFO turn queue cap; overflow → system row, message dropped. */
const QUEUE_CAP = 8;
/** Force-drain a genuinely-stuck turn after this long (paused while waitingOn != null). */
const DEFAULT_WATCHDOG_MS = 5 * 60 * 1000;
/**
 * Presence liveness sweep (#1307). `onRuntimeEnd` is the binder's ONLY teardown
 * signal and it fires from exactly one place — an explicit `runtimes.destroy` —
 * with best-effort, individually try/caught handlers. A runtime that leaves the
 * registry any other way therefore leaves this binding holding a dead adapter:
 * `healthyRuntime` keeps saying yes, every rebind reuses the corpse, and the
 * binding never returns to idle. The watchdog cannot bound that (it is disarmed
 * for as long as `waitingOn !== null` and is never armed at all once a turn
 * ends), so liveness is re-derived from the runtime registry on a timer rather
 * than trusted to an event.
 */
const DEFAULT_PRESENCE_SWEEP_MS = 30 * 1000;
/** Consecutive agent-authored routed turns allowed between human/gateway posts. */
export const MAX_CONSECUTIVE_AGENT_TURNS = 4;
/** Dedupe identical unavailable/cross-node system rows per (channel, agent). */
const UNAVAILABLE_ROW_TTL_MS = 5 * 60 * 1000;
/**
 * Keep exact provider turn ids briefly after a bare-idle successor starts.
 * These tombstones are deliberately never candidates for anonymous `turn-0`.
 */
const EXACT_TURN_TOMBSTONE_TTL_MS = 60 * 1000;
const EXACT_TURN_TOMBSTONE_MAX = 16;
/** How long a resolved framework-availability list is reused before re-probing. */
const TARGETS_TTL_MS = 5 * 1000;
/** Claim in bounded pages so a large recovered outbox cannot strand its tail. */
const COMPLETION_CALLBACK_BATCH_LIMIT = 100;
const COMPLETION_CALLBACK_RETRY_MS = 25;
const COMPLETION_CALLBACK_TERMINALIZATION_MAX_ATTEMPTS = 5;
const COMPLETION_CALLBACK_TERMINALIZATION_MAX_RETRY_MS = 1_000;
const COMPLETION_CALLBACK_PRUNE_INTERVAL_MS = 5 * 60 * 1000;
const CALLBACK_NO_TERMINAL_MESSAGE = 'no-terminal-message' as const;
const CALLBACK_UNEXPECTED_DISCONNECT = 'unexpected-disconnect' as const;

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
  /** Actual adapter executable; absent for gateway-only channel providers. */
  command?: string;
}

export interface ChannelAgentRosterEntry {
  id: string;
  displayName: string;
  providerId: string;
  isDefault: boolean;
  isBuiltIn: boolean;
  kind: 'framework';
  available: boolean;
  reason: string | null;
  role?: AgentRole;
  binding: {
    runtimeId: string;
    status: ChannelAgentStatus;
    /**
     * Posts waiting to trigger this binding's NEXT turn (#1308 slice 4). Zero
     * whenever nothing is queued or the runtime is only durably recorded (no
     * live binding), so the chip renders from one number on both lanes.
     */
    queuedCount: number;
    /** Posts accepted by a native safe-boundary steering primitive. */
    steeringCount: number;
    /** Whether this live harness accepts the default safe-boundary steer. */
    steerSupported: boolean;
  } | null;
  /** Provider previews are safe to show before a binding exists. */
  commands?: AgentSlashCommandV2[];
}

export type ChannelArchiveActivityReason =
  | 'binding-status'
  | 'active-turn'
  | 'queued-turn'
  | 'steering'
  | 'binding-in-flight'
  | 'orchestrator-in-flight'
  | 'routing-in-flight'
  | 'retry-in-flight'
  | 'completion-callback'
  /** SQLite could not persist a non-delivery terminal state after bounded retry. */
  | 'completion-callback-terminalization-failed';

/** Synchronous snapshot used by the topic archive mutation boundary. */
export interface ChannelArchiveActivitySnapshot {
  active: boolean;
  reasons: ChannelArchiveActivityReason[];
}

export type ChannelAgentStatusBroadcaster = (
  type: string,
  data: Record<string, unknown>
) => void;

/** Private runtime surface owned by channel bindings. */
export interface BinderRuntimes {
  create(params: CreateChannelAgentRuntimeParams): Promise<ChannelAgentRuntime>;
  get(id: string): ChannelAgentRuntime | undefined;
  destroy(id: string): Promise<void>;
  onRuntimeEnd(cb: (runtimeId: string) => void): () => void;
}

export interface ChannelAgentBinderDeps {
  store: ChannelMessageStore;
  /** Content-addressed image lane; production injects the config-dir store. */
  attachmentStore?: ChannelAttachmentStore | null;
  hub: ChannelHub;
  topicStore: WorkspaceTopicStore | null;
  /** Durable local AgentProfile catalog. */
  agentProfileStore?: AgentProfileStore | null;
  runtimes: BinderRuntimes;
  /** Resolve the current routable frameworks (builtin/configured + mock in tests). */
  mentionTargets: () => Promise<MentionTarget[]>;
  /** Provider ids used to resolve agent-to-agent mentions (adapter registry keys). */
  knownProviderIds: readonly string[];
  port: number;
  configDir: string;
  localNodeId?: string;
  watchdogMs?: number;
  /** Interval of the dead-runtime presence sweep (#1307); tests shorten it. */
  presenceSweepMs?: number;
  yolo?: boolean;
  now?: () => number;
  /** Base environment inherited by channel adapter subprocesses. */
  processEnv?: NodeJS.ProcessEnv;
}

export interface ChannelAgentBinder {
  /**
   * Authoritative pre-persistence admission for a channel post. The router uses
   * these profile actor ids in its one post+run transaction; routing below uses
   * the same resolver, so a durable target is never invented or omitted.
   */
  resolvePostTargetIds(input: {
    channelId: string;
    sender: ChannelSenderRef;
    text: string;
    mentions: ChannelMention[];
  }): string[];
  handleMessagePosted(
    message: ChannelMessage,
    mentions: ChannelMention[],
    options?: ChannelMessagePostedOptions
  ): void;
  ensureBinding(channelId: string, framework: string): Promise<LiveBinding>;
  /** Designate or resume the one orchestrator bound to a product channel. */
  ensureOrchestrator(
    channelId: string,
    framework?: string,
    profileActorId?: string
  ): Promise<LiveBinding>;
  interrupt(
    channelId: string,
    agentId: string,
    threadId?: string | null
  ): Promise<void>;
  /** Explicit operator release; only an actually idle, unqueued binding may end. */
  release(
    channelId: string,
    agentId: string,
    threadId?: string | null
  ): Promise<void>;
  /**
   * Apply steering to an ALREADY-persisted row (#1308 slice 4). Used by the post
   * route when `clientMessageId` idempotency returns an existing row: the
   * message is already queued, but the operator's interrupt intent would
   * otherwise be dropped on the floor. Never re-routes the message.
   */
  steerExisting(message: ChannelMessage, steering: ChannelPostSteering): void;
  /**
   * Re-route the ORIGINAL trigger of a failed/interrupted/truncated agent row to
   * the same profile (#1308 slice 1 item 2). The human message is never
   * re-posted — the timeline gains one system row superseding the retried row
   * plus whatever the new turn produces.
   */
  retryMessage(
    channelId: string,
    messageId: string
  ): Promise<ChannelRetryResult>;
  respondToApproval(
    channelId: string,
    agentId: string,
    requestId: string,
    decision: AgentApprovalDecisionV2,
    threadId?: string | null
  ): Promise<void>;
  rosterForChannel(channelId: string): Promise<ChannelAgentRosterEntry[]>;
  /**
   * Synchronous by design: callers check this and archive in one JS turn, so a
   * new binder operation cannot interleave between the invariant and mutation.
   */
  archiveActivityForChannel(channelId: string): ChannelArchiveActivitySnapshot;
  executeCommand(
    channelId: string,
    profileActorId: string,
    command: string,
    args?: string,
    confirmed?: boolean,
    threadId?: string | null
  ): Promise<{ config?: Record<string, unknown> }>;
  /**
   * Recreate every idle runtime in exactly one conversation scope so its
   * provider receives updated channel instructions at launch. A busy turn is
   * never interrupted or silently reconfigured.
   */
  restartScope(
    channelId: string,
    threadId?: string | null
  ): Promise<{ restarted: number }>;
  /** `channelId` permits DM-only bare controls without reserving group prose. */
  isControlMessage(text: string, channelId?: string): boolean;
  setStatusBroadcaster(broadcaster: ChannelAgentStatusBroadcaster): void;
  /** Replays persisted callback work only after boot store sweeps complete. */
  recoverCompletionCallbacks(): Promise<void>;
  close(): void;
}

// ── internal live state ──────────────────────────────────────────────────────

interface QueuedTurn {
  trigger: ChannelMessage;
  /** Relay-internal upward completion trigger; never serialized as a chat row. */
  completionCallback?: ChannelCompletionCallbackEdge;
  /** Explicit agent delegation whose edge was durably admitted before this FIFO entry. */
  callbackEdgeRequest?: CallbackEdgeRequest;
  /**
   * Set only by `handleSendFailure`'s re-enqueue after a rebind. Such a trigger
   * is BELOW the binding's delivery cursor (a newer turn already succeeded and
   * advanced it past this seq), so it can never survive coalescing as a context
   * row — `buildMentionContextPacketEnvelope` filters context rows with
   * `seq > lastDeliveredSeq` in BOTH scopes since #1408, thread included. It
   * must therefore always trigger its OWN turn,
   * where the packet footer renders it unconditionally. See `pump`.
   */
  reEnqueued?: true;
}

interface CallbackEdgeRequest {
  requesterProfileId: string;
  /** The ancestor edge to satisfy when the callback recipient finishes. */
  continuationParentCallbackId?: string;
}

interface ExactTurnTombstone {
  parentMessageId: string | null;
  requestMessageId: ChannelMessage['id'];
  expiresAt: number;
}

/**
 * Whether a persisted binding row carries provider RESUME state, as opposed to
 * only Relay's own bookkeeping or an adapter's private scratch keys.
 *
 * `lastDeliveredSeq` is written by `advanceCursor` into the same blob adapters
 * use for their resume handles, so a non-empty `providerSession` is not by
 * itself evidence that a respawned runtime can replay the conversation — and
 * neither is "some key other than the cursor". `runtimes.create()` resumes from
 * exactly ONE provider-specific key (`providerResumeId`); an adapter that
 * persists anything else (mock's `mockSessionId`, say) spawns an amnesiac
 * process no matter how full the blob looks. Asking the runtime's own resume
 * map is what keeps this predicate honest for future/custom adapters (#1408).
 */
function hasProviderResumeState(
  framework: string,
  providerSession: Record<string, unknown> | undefined
): boolean {
  return providerResumeId(framework, providerSession) !== undefined;
}

export interface LiveBinding {
  channelId: string;
  /** Null is the root-channel execution scope. */
  threadId: string | null;
  /** Actor id, not provider id: one profile owns one live channel runtime. */
  profileActorId: string;
  framework: string;
  /** Bare profile label for user-facing channel rows, never the runtime title. */
  displayName: string;
  runtimeId: string | null;
  adapter: ProtocolAdapterV2 | null;
  unbind: (() => void) | null;
  patchUnlisten: (() => void) | null;
  status: ChannelAgentStatus;
  activeTurnId: string | null;
  /** Immediate thread parent keyed by routed turn; retained past binder idle. */
  parentMessageIdByTurn: Map<string, string | null>;
  /** Exact accepted post that owns an async target turn (never provider-derived). */
  requestMessageIdByTurn: Map<string, ChannelMessage['id']>;
  /** Bounded exact-turn ancestry retained across a successor; never used by turn-0. */
  exactTurnTombstones: Map<string, ExactTurnTombstone>;
  /** Last terminal prose row by turn, available before the terminal patch lands. */
  finalMessageByTurn: Map<string, ChannelMessage>;
  /** Child callback and ancestor edge awaited by its internal callback turn. */
  continuationByTurn: Map<
    string,
    { childCallbackId: string; parentCallbackId: string }
  >;
  /** Claimed callback triggers that have not yet been accepted by their adapter. */
  completionCallbackByTurn: Map<string, ChannelCompletionCallbackEdge>;
  /** A provider may terminalize synchronously before sendMessage resolves. */
  deferredCompletionTerminalByTurn: Map<
    string,
    {
      terminalReason: ChannelCompletionCallbackTerminalReason;
      terminalMessageId?: string;
      messageDisposition: ChannelCompletionCallbackMessageDisposition;
      continuation?: { childCallbackId: string; parentCallbackId: string };
    }
  >;
  /** Anonymous turn-0 cannot be associated safely after retained generations overlap. */
  turnZeroFallbackUnsafe: boolean;
  /**
   * Thread scope only (#1408): this runtime was spawned WITHOUT provider resume
   * state, so it holds none of the thread even though the durable per-thread
   * cursor says the rows were delivered to its predecessor. The next packet is
   * therefore built at cursor 0 — root plus the newest orientation window —
   * regardless of the stored cursor. Cleared by `advanceCursor` the moment a
   * send is accepted, because the live provider conversation then holds it.
   */
  threadOrientationPending: boolean;
  /** Context packet for the active turn (kept so a retry re-sends identical content). */
  activeContent: string | null;
  /** Resolved local payloads retained with activeContent across retry/rebind. */
  activeAttachments: Attachment[];
  sawStream: boolean;
  waitingOn: string | null;
  queue: QueuedTurn[];
  /** FIFO of native safe-boundary requests not yet handed to the adapter. */
  steeringQueue: QueuedTurn[];
  /** One provider call at a time preserves original operator order. */
  steeringInFlight: boolean;
  /** Requests accepted into the active provider turn, cleared when it ends. */
  steeringAcceptedCount: number;
  /** Last `(status, queuedCount)` pair broadcast; suppresses duplicate events. */
  emittedStatus: ChannelAgentStatus;
  emittedQueuedCount: number;
  emittedSteeringCount: number;
  emittedSteerSupported: boolean;
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

/** Fail closed: releasing a live turn would discard provider work or approval state. */
export class ChannelAgentReleaseRefusedError extends Error {
  constructor(
    readonly channelId: string,
    readonly profileActorId: string,
    readonly status: ChannelAgentStatus,
    readonly reasonCode:
      | 'CHANNEL_AGENT_NOT_IDLE'
      | 'CHANNEL_AGENT_QUEUE_NOT_EMPTY'
      | 'CHANNEL_AGENT_WAITING_ON_OPERATOR'
  ) {
    super(`agent ${profileActorId} cannot be released while ${reasonCode}`);
  }
}

/** A configuration apply never abandons an active or queued provider turn. */
export class ChannelAgentRestartRefusedError extends Error {
  constructor(
    readonly channelId: string,
    readonly threadId: string | null,
    readonly profileActorId: string,
    readonly status: ChannelAgentStatus,
    readonly reasonCode:
      | 'CHANNEL_AGENT_NOT_IDLE'
      | 'CHANNEL_AGENT_QUEUE_NOT_EMPTY'
      | 'CHANNEL_AGENT_WAITING_ON_OPERATOR'
  ) {
    super(
      `agent ${profileActorId} cannot apply instructions while ${reasonCode}`
    );
    this.name = 'ChannelAgentRestartRefusedError';
  }
}

/**
 * The row cannot be re-routed: it is not a retryable agent row, its turn id was
 * not binder-minted (a provider-labelled item), or the original trigger has
 * since left the channel. `notFound` separates "no such row here" (404) from
 * "this row is not retryable" (409).
 */
export class ChannelMessageNotRetryableError extends Error {
  constructor(
    message: string,
    readonly reasonCode: string,
    readonly notFound = false
  ) {
    super(message);
    this.name = 'ChannelMessageNotRetryableError';
  }
}

/**
 * Retry-storm brake (#1308 item 2). A retry while the same profile is mid-turn
 * in this channel would otherwise stack a second turn behind the live one, and
 * a held-down button would fill the queue to `QUEUE_CAP` before the operator
 * saw a single reply. Rejected outright — the client also disables the control
 * from the same signal, this is the fail-closed backstop.
 */
export class ChannelAgentBusyError extends Error {
  constructor(
    readonly channelId: string,
    readonly profileActorId: string,
    readonly status: ChannelAgentStatus
  ) {
    super(
      `agent ${profileActorId} is ${status} in channel ${channelId}; retry is only offered while idle`
    );
    this.name = 'ChannelAgentBusyError';
  }
}

/** Outcome of a successful `retryMessage` dispatch. */
export interface ChannelRetryResult {
  /** The retried (failed/interrupted/truncated) agent row. */
  messageId: string;
  /** The ORIGINAL trigger that was re-routed — never a new timeline row. */
  triggerMessageId: string;
  profileActorId: string;
}

/** A command lane rejection is deliberately not a channel-message failure. */
export class ChannelAgentCommandError extends Error {
  constructor(
    message: string,
    readonly reasonCode:
      | 'UNKNOWN_PROFILE'
      | 'UNAVAILABLE'
      | 'UNKNOWN_COMMAND'
      | 'UNSUPPORTED_DISPATCH'
      | 'UNSUPPORTED_PROVIDER'
      | 'UNAVAILABLE_COMMAND'
      | 'CONFIRMATION_REQUIRED'
  ) {
    super(message);
    this.name = 'ChannelAgentCommandError';
  }
}

export class ChannelAgentRoleConflictError extends Error {
  constructor(
    readonly channelId: string,
    readonly framework: string,
    readonly runtimeId: string,
    readonly actualRole: string
  ) {
    super(
      `channel ${channelId} already binds @${framework} to runtime ${runtimeId} with role ${actualRole}; expected orchestrator`
    );
    this.name = 'ChannelAgentRoleConflictError';
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

function bindingKey(
  channelId: string,
  profileActorId: string,
  threadId: string | null = null
): string {
  // An explicit empty component is the root/channel scope. It keeps a thread
  // queue, provider-session identity and controls from collapsing into root.
  return `${channelId}\u0000${threadId ?? ''}\u0000${profileActorId}`;
}

/** Autonomous agent chains are isolated just like their runtime bindings. */
function conversationScopeKey(
  channelId: string,
  threadId: string | null = null
): string {
  return `${channelId}\u0000${threadId ?? ''}`;
}

function bindingKeyPrefix(channelId: string): string {
  return `${channelId}\u0000`;
}

export function createChannelAgentBinder(
  deps: ChannelAgentBinderDeps
): ChannelAgentBinder {
  const { store, hub, topicStore } = deps;
  const localNodeId = deps.localNodeId ?? DEFAULT_LOCAL_NODE_ID;
  const watchdogMs = deps.watchdogMs ?? DEFAULT_WATCHDOG_MS;
  const presenceSweepMs = deps.presenceSweepMs ?? DEFAULT_PRESENCE_SWEEP_MS;
  const yolo = deps.yolo ?? CHANNEL_BINDING_YOLO_DEFAULT;
  const now = deps.now ?? (() => Date.now());

  const live = new Map<string, LiveBinding>();
  const inflight = new Map<string, Promise<LiveBinding>>();
  // An explicit instruction apply has a destructive middle (runtime teardown).
  // Coalesce duplicate browser/API clicks for one conversation so two applies
  // cannot both pass the idle preflight and recreate competing runtimes.
  const restartInFlight = new Map<string, Promise<{ restarted: number }>>();
  // Designation is a channel-level invariant, not a (channel, profile) spawn.
  // Serialize competing profile requests before either can launch a loser.
  const orchestratorInflight = new Map<string, Promise<LiveBinding>>();
  const consecutiveAgentTurns = new Map<
    string,
    {
      count: number;
      allowedTurnKeys: Set<string>;
      paused: boolean;
    }
  >();
  const unavailableRowAt = new Map<string, number>();
  // Retry storm brake, synchronous half (#1308 review). The `live` binding's
  // busy state is only observable AFTER `routeOne` has awaited its way to
  // `enqueueTurn`, so a check against it alone is a TOCTOU: two retries issued
  // in the same window both see an idle (or absent) binding and both enqueue.
  // This marker is taken synchronously with the busy check and held until the
  // route settles, so the second caller is refused rather than admitted.
  const retryInFlight = new Set<string>();
  // `routeOne` awaits target discovery before `inflight` owns a binding key.
  // Count that earlier window too, otherwise archive can race a mention that is
  // already admitted but has not started spawning its runtime yet.
  const routingInFlightByChannel = new Map<string, number>();
  let statusBroadcaster: ChannelAgentStatusBroadcaster | null = null;
  let targetsCache: { at: number; value: MentionTarget[] } | null = null;
  let targetsGeneration = 0;
  let targetsInFlight: {
    generation: number;
    promise: Promise<MentionTarget[]>;
  } | null = null;
  let completionDrainScheduled = false;
  // Durable satisfied/delivered callbacks are work in the requester's channel
  // before the next-tick drain creates ordinary binding/routing state. Key by
  // callback id so repeated retry scheduling is idempotent and channel-local.
  const pendingCompletionCallbacks = new Map<string, string>();
  // A persistence outage must not turn a deterministic missing-profile result
  // into a 25ms hot loop. This is intentionally in-memory only: restart makes
  // the durable delivered row recoverable again, while an exhausted live binder
  // remains archive-unsafe rather than claiming a CAS it could not record.
  const terminalizationRetryByCallbackId = new Map<
    string,
    { attempts: number; scheduled: boolean; exhausted: boolean }
  >();
  let lastCompletionCallbackPruneAt: number | null = null;
  let closed = false;

  const unsubRuntimeEnd = deps.runtimes.onRuntimeEnd((runtimeId) =>
    handleRuntimeEnd(runtimeId)
  );
  const presenceSweep = setInterval(sweepDeadBindings, presenceSweepMs);
  presenceSweep.unref?.();

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
    profileActorId: string,
    text: string,
    parentMessageId?: string
  ): void {
    const key = `${bindingKey(channelId, profileActorId)}\u0000${text}\u0000${parentMessageId ?? ''}`;
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
    // Exact provider turn ids can arrive after a bare-idle successor starts.
    // Retain a bounded tombstone for that exact identity only; `turn-0` is an
    // anonymous fallback label and must never borrow a predecessor tombstone.
    if (turnId !== 'turn-0' && exactTurnTombstone(binding, turnId)) {
      return turnId;
    }
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

  function exactTurnTombstone(
    binding: LiveBinding,
    turnId: string
  ): ExactTurnTombstone | undefined {
    const tombstone = binding.exactTurnTombstones.get(turnId);
    if (!tombstone) return undefined;
    if (tombstone.expiresAt > now()) return tombstone;
    binding.exactTurnTombstones.delete(turnId);
    return undefined;
  }

  function parentMessageIdForTurnKey(
    binding: LiveBinding,
    turnId: string
  ): string | null | undefined {
    if (binding.parentMessageIdByTurn.has(turnId)) {
      return binding.parentMessageIdByTurn.get(turnId);
    }
    return turnId === 'turn-0'
      ? undefined
      : exactTurnTombstone(binding, turnId)?.parentMessageId;
  }

  function requestMessageIdForTurnKey(
    binding: LiveBinding,
    turnId: string
  ): ChannelMessage['id'] | undefined {
    const active = binding.requestMessageIdByTurn.get(turnId);
    if (active) return active;
    return turnId === 'turn-0'
      ? undefined
      : exactTurnTombstone(binding, turnId)?.requestMessageId;
  }

  function retainExactTurnTombstones(binding: LiveBinding): void {
    const expiresAt = now() + EXACT_TURN_TOMBSTONE_TTL_MS;
    for (const [turnId, parentMessageId] of binding.parentMessageIdByTurn) {
      const requestMessageId = binding.requestMessageIdByTurn.get(turnId);
      // `turn-0` is a provider's anonymous fallback label, not a reliable
      // exact identity. It is intentionally excluded from this retention lane.
      if (turnId === 'turn-0' || !requestMessageId) continue;
      binding.exactTurnTombstones.delete(turnId);
      binding.exactTurnTombstones.set(turnId, {
        parentMessageId,
        requestMessageId,
        expiresAt,
      });
    }
    for (const [turnId, tombstone] of binding.exactTurnTombstones) {
      if (tombstone.expiresAt <= now())
        binding.exactTurnTombstones.delete(turnId);
    }
    while (binding.exactTurnTombstones.size > EXACT_TURN_TOMBSTONE_MAX) {
      const oldest = binding.exactTurnTombstones.keys().next().value;
      if (oldest === undefined) break;
      binding.exactTurnTombstones.delete(oldest);
    }
  }

  function parentForTurn(
    binding: LiveBinding,
    turnId: string
  ): string | undefined {
    const key = parentKeyForTurn(binding, turnId);
    const triggerParent =
      key === undefined
        ? undefined
        : (parentMessageIdForTurnKey(binding, key) ?? undefined);
    // An ambiguous provider fallback must not borrow a possibly wrong trigger,
    // but a thread-scoped runtime still knows its durable conversation root.
    // Keep its output in that conversation rather than leaking it to the root
    // channel just because the immediate parent was deliberately withheld.
    return triggerParent ?? binding.threadId ?? undefined;
  }

  function releaseTurnParent(binding: LiveBinding, turnId: string): void {
    const key = parentKeyForTurn(binding, turnId);
    if (key !== undefined) binding.parentMessageIdByTurn.delete(key);
  }

  /** Stable edge and callback-turn identities make late terminal patches inert. */
  function completionCallbackEdgeId(targetTurnId: string): string {
    return `chcb:${targetTurnId}`;
  }

  function completionCallbackTurnId(
    edge: ChannelCompletionCallbackEdge,
    requesterProfileId: string
  ): string {
    return channelTurnId(edge.id as ChannelMessage['id'], requesterProfileId);
  }

  function requesterProfileForAgentMessage(
    message: ChannelMessage
  ): string | null {
    if (message.sender.kind !== 'agent') return null;
    if (deps.agentProfileStore?.get(message.sender.id))
      return message.sender.id;
    return message.sender.providerId
      ? defaultProfileForProvider(message.sender.providerId).id
      : null;
  }

  function profileForActorId(profileActorId: string): AgentProfile | null {
    const stored = deps.agentProfileStore?.get(profileActorId);
    if (stored) return stored;
    const providerId = deps.knownProviderIds.find(
      (candidate) => builtInAgentProfileId(candidate) === profileActorId
    );
    return providerId ? defaultProfileForProvider(providerId) : null;
  }

  function completionDisposition(
    finalMessage: ChannelMessage | undefined
  ): ChannelCompletionCallbackMessageDisposition {
    return finalMessage ? 'final-message' : CALLBACK_NO_TERMINAL_MESSAGE;
  }

  /**
   * Keep idempotency rows bounded on a live hub too, not just after a restart.
   * The store keeps unresolved ancestry out of the delete set; rate limiting
   * makes this a tiny amortized write on callback lifecycle transitions.
   */
  function maybePruneCompletionCallbacks(): void {
    const timestamp = now();
    if (
      lastCompletionCallbackPruneAt !== null &&
      timestamp - lastCompletionCallbackPruneAt <
        COMPLETION_CALLBACK_PRUNE_INTERVAL_MS
    ) {
      return;
    }
    lastCompletionCallbackPruneAt = timestamp;
    try {
      store.pruneConsumedCompletionCallbacks();
    } catch (err) {
      logger.warn('channel completion callback retention prune failed:', err);
    }
  }

  function terminalizeCompletionCallback(
    binding: LiveBinding,
    turnId: string,
    terminalReason: ChannelCompletionCallbackTerminalReason
  ): void {
    const finalMessage = binding.finalMessageByTurn.get(turnId);
    try {
      const continuation = binding.continuationByTurn.get(turnId);
      const input = {
        terminalReason,
        ...(finalMessage ? { terminalMessageId: finalMessage.id } : {}),
        messageDisposition: completionDisposition(finalMessage),
      };
      const callback = binding.completionCallbackByTurn.get(turnId);
      // The adapter has not accepted this internal callback yet. A terminal
      // patch may race sendMessage (including a watchdog or runtime death), but
      // consuming now would make a crash between CAS and send permanently lose
      // the callback. Hold the terminal evidence until acceptance instead.
      if (
        callback &&
        store.getCompletionCallback(callback.id)?.state === 'delivered'
      ) {
        binding.deferredCompletionTerminalByTurn.set(turnId, {
          ...input,
          ...(continuation ? { continuation } : {}),
        });
        return;
      }
      const satisfied = continuation
        ? store.completeChildContinuation({
            callbackId: continuation.childCallbackId,
            ...input,
          })
        : store.satisfyCompletionCallback({
            channelId: binding.channelId,
            targetProfileId: binding.profileActorId,
            targetTurnId: turnId,
            ...input,
          });
      if (satisfied) drainCompletionCallbacks(0, [satisfied]);
      maybePruneCompletionCallbacks();
    } catch (err) {
      logger.warn('channel completion callback terminalization failed:', err);
    }
  }

  function flushDeferredCompletionTerminal(
    binding: LiveBinding,
    turnId: string
  ): void {
    const deferred = binding.deferredCompletionTerminalByTurn.get(turnId);
    if (!deferred) return;
    binding.deferredCompletionTerminalByTurn.delete(turnId);
    try {
      const satisfied = deferred.continuation
        ? store.completeChildContinuation({
            callbackId: deferred.continuation.childCallbackId,
            terminalReason: deferred.terminalReason,
            ...(deferred.terminalMessageId
              ? { terminalMessageId: deferred.terminalMessageId }
              : {}),
            messageDisposition: deferred.messageDisposition,
          })
        : null;
      if (satisfied) drainCompletionCallbacks(0, [satisfied]);
    } catch (err) {
      logger.warn(
        'channel deferred completion callback terminalization failed:',
        err
      );
    }
  }

  /**
   * An unaccepted callback turn must stay recoverable. This intentionally does
   * not terminalize its ancestor relation: no provider accepted the typed
   * trigger, so completion would be a fabricated acknowledgement.
   */
  function releaseUnacceptedCompletionCallbackTurn(
    binding: LiveBinding,
    turnId: string
  ): boolean {
    const callback = binding.completionCallbackByTurn.get(turnId);
    if (!callback) return false;
    try {
      store.releaseDeliveredCompletionCallback(callback.id);
      drainCompletionCallbacks(COMPLETION_CALLBACK_RETRY_MS, [callback]);
    } catch (err) {
      logger.warn(
        'channel unaccepted completion callback release failed:',
        err
      );
    }
    binding.completionCallbackByTurn.delete(turnId);
    binding.deferredCompletionTerminalByTurn.delete(turnId);
    return true;
  }

  /**
   * Claims durable satisfied edges before touching a live binding. The durable
   * CAS is the exactly-once boundary for duplicate/late terminal patches; the
   * FIFO below is only delivery scheduling for a busy requester.
   */
  function trackCompletionCallbacks(
    edges: readonly ChannelCompletionCallbackEdge[]
  ): void {
    for (const edge of edges) {
      pendingCompletionCallbacks.set(edge.id, edge.channelId);
    }
  }

  function drainCompletionCallbacks(
    delayMs = 0,
    edges: readonly ChannelCompletionCallbackEdge[] = []
  ): void {
    // Track even when a drain timer already exists. Many terminal patches can
    // fan into that one timer, and every affected channel must remain blocked.
    trackCompletionCallbacks(edges);
    if (closed || completionDrainScheduled) return;
    // Let the provider's terminal patch finish its current microtask fan-out
    // before the upward callback enters another agent's FIFO. That preserves
    // one terminal boundary between downward delegation and upward completion;
    // the durable CAS below remains the correctness boundary.
    completionDrainScheduled = true;
    const timer = setTimeout(() => {
      completionDrainScheduled = false;
      claimAndRouteCompletionCallbacks();
    }, delayMs);
    timer.unref?.();
  }

  function releaseClaimedCompletionCallback(
    edge: ChannelCompletionCallbackEdge,
    context: string
  ): void {
    try {
      store.releaseDeliveredCompletionCallback(edge.id);
      drainCompletionCallbacks(COMPLETION_CALLBACK_RETRY_MS, [edge]);
    } catch (err) {
      // This runs from a timer. A synchronous SQLite failure must neither
      // escape the timer nor drop the per-channel archive marker. Retry the
      // release itself: delivered rows are not claimable until this CAS lands.
      logger.warn(context, err);
      if (closed) return;
      const timer = setTimeout(
        () => releaseClaimedCompletionCallback(edge, context),
        COMPLETION_CALLBACK_RETRY_MS
      );
      timer.unref?.();
    }
  }

  /**
   * A missing requester profile is a deterministic delivery failure, never a
   * request to provision or retry that external actor. Only a failed SQLite CAS
   * retries here, against the already-claimed row, so recovery cannot turn the
   * deterministic classification into a provider/log loop.
   */
  function terminalizeUnavailableRequesterCallback(
    edge: ChannelCompletionCallbackEdge
  ): void {
    if (closed) return;
    const retry = terminalizationRetryByCallbackId.get(edge.id) ?? {
      attempts: 0,
      scheduled: false,
      exhausted: false,
    };
    // A callback may be encountered through a timer and a caller in the same
    // turn. One scheduled CAS sequence owns it; exhausted work remains visible
    // through archive activity until an operator restarts or repairs storage.
    if (retry.scheduled || retry.exhausted) return;
    try {
      const terminalized = store.terminalizeDeliveredCompletionCallback({
        id: edge.id,
        channelId: edge.channelId,
        threadId: edge.threadId,
        deliveryReason: 'requester-profile-unavailable',
      });
      pendingCompletionCallbacks.delete(edge.id);
      terminalizationRetryByCallbackId.delete(edge.id);
      if (terminalized) {
        logger.warn(
          'channel completion callback terminalized: requester profile unavailable',
          {
            callbackId: edge.id,
            requesterProfileId: edge.requesterProfileId,
            deliveryReason: terminalized.deliveryReason,
          }
        );
        maybePruneCompletionCallbacks();
      }
    } catch (err) {
      retry.attempts += 1;
      if (retry.attempts >= COMPLETION_CALLBACK_TERMINALIZATION_MAX_ATTEMPTS) {
        retry.exhausted = true;
        terminalizationRetryByCallbackId.set(edge.id, retry);
        // Final, deliberately singular escalation. The durable row is still
        // delivered, so leave the archive fence intact and never say it became
        // undeliverable merely because the intended CAS could not be written.
        logger.error(
          'channel completion callback unavailable-requester terminalization exhausted',
          {
            callbackId: edge.id,
            requesterProfileId: edge.requesterProfileId,
            attempts: retry.attempts,
            error: errText(err),
          }
        );
        return;
      }
      if (closed) return;
      const delayMs = Math.min(
        COMPLETION_CALLBACK_RETRY_MS * 2 ** (retry.attempts - 1),
        COMPLETION_CALLBACK_TERMINALIZATION_MAX_RETRY_MS
      );
      retry.scheduled = true;
      terminalizationRetryByCallbackId.set(edge.id, retry);
      // Rate-limit diagnostics to the first failure and the single exhaustion
      // event. The retry is a storage-write recovery, never a profile retry.
      if (retry.attempts === 1) {
        logger.warn(
          'channel completion callback unavailable-requester terminalization delayed',
          {
            callbackId: edge.id,
            requesterProfileId: edge.requesterProfileId,
            retryInMs: delayMs,
            error: errText(err),
          }
        );
      }
      const timer = setTimeout(() => {
        retry.scheduled = false;
        terminalizeUnavailableRequesterCallback(edge);
      }, delayMs);
      timer.unref?.();
    }
  }

  function claimAndRouteCompletionCallbacks(): void {
    if (closed) return;
    let edges: ChannelCompletionCallbackEdge[];
    try {
      edges = store.claimSatisfiedCompletionCallbacks(
        COMPLETION_CALLBACK_BATCH_LIMIT
      );
    } catch (err) {
      logger.warn('channel completion callback claim failed:', err);
      // Durable work is still satisfied, so keep its per-channel marker and
      // retry instead of either losing delivery or declaring archive-safe.
      drainCompletionCallbacks(COMPLETION_CALLBACK_RETRY_MS);
      return;
    }
    for (const edge of edges) {
      trackCompletionCallbacks([edge]);
      const profile = profileForActorId(edge.requesterProfileId);
      if (!profile) {
        // The durable CAS is the terminal boundary. Do not re-offer an
        // external actor as though it were an installed profile or invent a
        // runtime for it; that actor still observes the delegatee's durable
        // channel reply through its scoped subscription/history contract.
        terminalizeUnavailableRequesterCallback(edge);
        continue;
      }
      const trigger =
        (edge.terminalMessageId
          ? store.getMessage(edge.terminalMessageId)
          : null) ?? store.getMessage(edge.triggerMessageId);
      if (!trigger) {
        logger.warn('channel completion callback trigger is unavailable', {
          callbackId: edge.id,
        });
        releaseClaimedCompletionCallback(
          edge,
          'channel completion callback missing-trigger release failed:'
        );
        continue;
      }
      void ensureProfileBinding(
        edge.channelId,
        profile,
        undefined,
        edge.threadId
      )
        .then((binding) => {
          if (closed) return;
          if (!enqueueTurn(binding, trigger, undefined, false, edge)) {
            // Queue admission is a durable boundary too. A full/released
            // requester must re-offer this claimed edge rather than stranding it.
            store.releaseDeliveredCompletionCallback(edge.id);
            drainCompletionCallbacks(COMPLETION_CALLBACK_RETRY_MS, [edge]);
            return;
          }
          // enqueueTurn synchronously installs active/queued binding state, so
          // that invariant takes over without an archive-visible gap.
          pendingCompletionCallbacks.delete(edge.id);
        })
        .catch((err) => {
          if (closed || err instanceof BinderClosedError) return;
          logger.warn('channel completion callback routing failed:', err);
          try {
            store.releaseDeliveredCompletionCallback(edge.id);
            drainCompletionCallbacks(COMPLETION_CALLBACK_RETRY_MS, [edge]);
          } catch (releaseErr) {
            logger.warn(
              'channel completion callback claim release failed:',
              releaseErr
            );
          }
        });
    }
    if (edges.length === COMPLETION_CALLBACK_BATCH_LIMIT) {
      drainCompletionCallbacks();
    }
  }

  // ── availability targets ────────────────────────────────────────────────────

  function invalidateTargets(): void {
    targetsGeneration += 1;
    targetsCache = null;
    targetsInFlight = null;
  }

  async function getTargets(): Promise<MentionTarget[]> {
    if (closed) return [];
    if (targetsCache && now() - targetsCache.at < TARGETS_TTL_MS) {
      return targetsCache.value;
    }
    const generation = targetsGeneration;
    if (targetsInFlight?.generation === generation) {
      return targetsInFlight.promise;
    }
    const request = deps.mentionTargets();
    const promise = request.then(
      async (value) => {
        // Invalidation may race an async gateway probe. Never let that stale
        // completion repopulate the cache or escape to the caller; join/start
        // the current generation instead.
        if (generation !== targetsGeneration) return getTargets();
        targetsCache = { at: now(), value };
        return value;
      },
      async (error: unknown) => {
        if (generation !== targetsGeneration) return getTargets();
        throw error;
      }
    );
    targetsInFlight = { generation, promise };
    try {
      return await promise;
    } finally {
      if (targetsInFlight?.promise === promise) targetsInFlight = null;
    }
  }

  async function resolveTarget(
    framework: string
  ): Promise<MentionTarget | undefined> {
    const targets = await getTargets();
    return targets.find((target) => target.id === framework);
  }

  function effectiveLaunchEnv(profile: AgentProfile): NodeJS.ProcessEnv {
    return {
      ...(deps.processEnv ?? process.env),
      ...(profile.envVars ?? {}),
    };
  }

  function availabilityForProfile(
    profile: AgentProfile,
    target: MentionTarget | undefined
  ): { available: boolean; reason: string | null } {
    if (!target?.available) {
      return {
        available: false,
        reason: target?.reason ?? 'framework unavailable',
      };
    }
    if (
      target.command &&
      !resolveExecutablePath(target.command, effectiveLaunchEnv(profile))
    ) {
      return {
        available: false,
        reason: `${target.command} is not installed on this node (not found on PATH).`,
      };
    }
    return { available: true, reason: null };
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

  /**
   * The profile store is intentionally the only named-profile resolver. When it
   * is unavailable during boot/failure, retain legacy `@provider` behavior by
   * synthesizing just that provider's built-in actor identity.
   */
  function defaultProfileForProvider(providerId: string): AgentProfile {
    const stored = deps.agentProfileStore?.getDefaultForProvider(providerId);
    if (stored) return stored;
    return {
      id: builtInAgentProfileId(providerId),
      providerId,
      displayName: '',
      avatar: null,
      isDefault: true,
      isBuiltIn: true,
    };
  }

  function resolveProfileMention(mention: ChannelMention): AgentProfile | null {
    const profiles = deps.agentProfileStore?.list() ?? [];
    if (mention.profileId) {
      const pinned = profiles.find(
        (profile) => profile.id === mention.profileId
      );
      if (pinned) return pinned;
      // A persisted, collision-disambiguated profile id must never silently
      // become a different named profile after a catalog edit.
      return null;
    }
    // Keep mention identity deterministic even if an older caller did not
    // persist `profileId`: all profile matching delegates to the shared
    // vendor-alias/longest-name resolver.
    const resolved = resolveProfileForMention(mention.raw, profiles);
    if (resolved) return resolved;
    return mention.providerId
      ? defaultProfileForProvider(mention.providerId)
      : null;
  }

  async function rosterDisplayName(profile: AgentProfile): Promise<string> {
    return profile.displayName || (await senderLabelFor(profile.providerId));
  }

  /**
   * Profiles the binder can safely reconstruct without inventing a deleted
   * named profile. Built-in defaults remain available when the durable profile
   * catalog is absent (boot/tests) or has not seeded that provider yet.
   */
  function knownProfiles(): AgentProfile[] {
    const profiles = [...(deps.agentProfileStore?.list() ?? [])];
    const seen = new Set(profiles.map((profile) => profile.id));
    for (const providerId of deps.knownProviderIds) {
      const profile = defaultProfileForProvider(providerId);
      if (seen.has(profile.id)) continue;
      seen.add(profile.id);
      profiles.push(profile);
    }
    return profiles;
  }

  /**
   * Resolve the channel's durable orchestrator designation. Runtime handles are
   * intentionally ephemeral across hub restarts; the binding role is the source
   * of truth and `routeOne(..., requiredRole='orchestrator')` cold-resumes it.
   * Recipient selection itself never upgrades an ordinary collaborator row.
   */
  function designatedOrchestratorProfile(
    channelId: string
  ): AgentProfile | null {
    const topic = topicStore?.get(channelId);
    if (!topic || isDmChannel(topic) !== null) return null;

    const designated = store.getSoleOrchestratorBinding(channelId);
    if (!designated) return null;
    return (
      knownProfiles().find(
        (profile) => profile.id === designated.profileActorId
      ) ?? null
    );
  }

  function supportsSafeBoundarySteer(binding: LiveBinding): boolean {
    return (
      binding.adapter?.capabilities.steer === true &&
      binding.adapter.steerMessage !== undefined
    );
  }

  // ── status ──────────────────────────────────────────────────────────────────

  /**
   * Broadcast the binding's observable presence plus both delivery lanes.
   * `queuedCount` waits for a future turn; `steeringCount` has been accepted
   * into a native provider's safe-boundary lane. They must remain separate so
   * the client never calls a steering request "queued".
   */
  function emitAgentStatus(binding: LiveBinding): void {
    const queuedCount = binding.queue.length;
    const steeringCount =
      binding.steeringAcceptedCount +
      binding.steeringQueue.length +
      (binding.steeringInFlight ? 1 : 0);
    const steerSupported = supportsSafeBoundarySteer(binding);
    if (
      binding.emittedStatus === binding.status &&
      binding.emittedQueuedCount === queuedCount &&
      binding.emittedSteeringCount === steeringCount &&
      binding.emittedSteerSupported === steerSupported
    ) {
      return;
    }
    binding.emittedStatus = binding.status;
    binding.emittedQueuedCount = queuedCount;
    binding.emittedSteeringCount = steeringCount;
    binding.emittedSteerSupported = steerSupported;
    statusBroadcaster?.('channel-agent-status', {
      channelId: binding.channelId,
      threadId: binding.threadId,
      agentId: binding.profileActorId,
      status: binding.status,
      runtimeId: binding.runtimeId ?? null,
      queuedCount,
      steeringCount,
      steerSupported,
    });
  }

  function setStatus(binding: LiveBinding, status: ChannelAgentStatus): void {
    if (binding.status === status) return;
    binding.status = status;
    emitAgentStatus(binding);
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
      finishTurn(binding, 'watchdog');
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
    profileActorId: string,
    framework: string,
    displayName: string,
    threadId: string | null = null
  ): LiveBinding {
    return {
      channelId,
      threadId,
      profileActorId,
      framework,
      displayName,
      runtimeId: null,
      adapter: null,
      unbind: null,
      patchUnlisten: null,
      status: 'idle',
      activeTurnId: null,
      parentMessageIdByTurn: new Map(),
      requestMessageIdByTurn: new Map(),
      exactTurnTombstones: new Map(),
      finalMessageByTurn: new Map(),
      continuationByTurn: new Map(),
      completionCallbackByTurn: new Map(),
      deferredCompletionTerminalByTurn: new Map(),
      turnZeroFallbackUnsafe: false,
      threadOrientationPending: false,
      activeContent: null,
      activeAttachments: [],
      sawStream: false,
      waitingOn: null,
      queue: [],
      steeringQueue: [],
      steeringInFlight: false,
      steeringAcceptedCount: 0,
      emittedStatus: 'idle',
      emittedQueuedCount: 0,
      emittedSteeringCount: 0,
      emittedSteerSupported: false,
      watchdog: null,
      retriedTurns: new Set(),
      announcedApprovals: new Set(),
    };
  }

  /**
   * Record a binder-owned runtime on its channel topic (#1287). Navigation used
   * to GUESS a channel's participants from `routingDefaults.cwd/repoPath`
   * whenever `linkedRefs` was empty, which pulled unrelated same-path sessions
   * into a channel's participant list. Linking here means every channel the
   * binder ever bound states its participants explicitly instead.
   *
   * Best effort and idempotent: no topic store, no topic row, or a failed store
   * write must never fail the mention turn that triggered the bind.
   */
  function linkRuntimeToTopic(channelId: string, runtimeId: string): void {
    if (!topicStore) return;
    try {
      const topic = topicStore.get(channelId);
      if (!topic) return;
      const patch = workspaceTopicAgentRuntimeLinkPatch({ topic, runtimeId });
      if (!patch) return;
      topicStore.update(topic.id, patch);
    } catch (err) {
      logger.warn('channel binder topic runtime link failed:', errText(err));
    }
  }

  function attachRuntime(
    channelId: string,
    profileActorId: string,
    framework: string,
    senderDisplayName: string,
    runtime: Pick<ChannelAgentRuntime, 'id' | 'adapter' | 'agentAttribution'>,
    threadId: string | null = null
  ): LiveBinding {
    const key = bindingKey(channelId, profileActorId, threadId);
    const existing = live.get(key);
    // Tear down any prior wiring before re-binding a fresh adapter.
    existing?.unbind?.();
    existing?.patchUnlisten?.();
    if (existing) {
      // A rejected send can discover a dead transport, attach a replacement
      // runtime, then redeliver the SAME active turn. Preserve that turn's
      // parent across the rebind; discard only idle/older retained entries.
      for (const turnId of existing.parentMessageIdByTurn.keys()) {
        if (turnId !== existing.activeTurnId) {
          existing.parentMessageIdByTurn.delete(turnId);
          existing.requestMessageIdByTurn.delete(turnId);
        }
      }
      existing.exactTurnTombstones.clear();
      // Removing the old adapter listeners establishes a hard boundary for
      // anonymous provider turn ids while retaining an exact active retry.
      existing.turnZeroFallbackUnsafe = false;
    }
    const binding =
      existing ??
      newLiveBinding(
        channelId,
        profileActorId,
        framework,
        senderDisplayName,
        threadId
      );
    binding.threadId = threadId;
    binding.profileActorId = profileActorId;
    binding.displayName = senderDisplayName;
    binding.runtimeId = runtime.id;
    binding.adapter = runtime.adapter;
    binding.unbind = bindSessionToChannel({
      channelId,
      agentFramework: framework,
      adapter: runtime.adapter,
      store,
      ...(deps.attachmentStore
        ? { attachmentStore: deps.attachmentStore }
        : {}),
      hub,
      // The durable ChannelSenderRef carries the profile Actor id and catalog
      // label. One private runtime belongs to one profile.
      profileActorId,
      displayName: senderDisplayName,
      ...(runtime.agentAttribution
        ? { initialAgentAttribution: runtime.agentAttribution }
        : {}),
      parentMessageIdForTurn: (turnId) => parentForTurn(binding, turnId),
      asyncRunReferenceForTurn: (turnId) => {
        // Mirror the exact/fallback ancestry rules for the public run ref. A
        // late Hermes `turn-0` can only borrow a retained generation when it is
        // uniquely safe; ambiguity never leaks correlation across requests.
        const key = parentKeyForTurn(binding, turnId);
        const triggerId = key
          ? requestMessageIdForTurnKey(binding, key)
          : undefined;
        if (!triggerId) return undefined;
        const run = store.getAsyncRunForRequestMessage(triggerId);
        return run
          ? { runId: run.id, targetId: binding.profileActorId }
          : undefined;
      },
      onAssistantMessageFinalized: (message) =>
        handleAssistantFinalized(binding, message),
    });
    binding.patchUnlisten = runtime.adapter.onPatch((patch) =>
      handleBindingPatch(binding, patch)
    );
    live.set(key, binding);
    // Single funnel for both fresh spawns and restored-runtime rebinds.
    linkRuntimeToTopic(channelId, runtime.id);
    return binding;
  }

  function healthyRuntime(
    runtimeId: string | null,
    framework: string,
    profileActorId: string,
    threadId: string | null = null
  ): ChannelAgentRuntime | null {
    if (!runtimeId) return null;
    const runtime = deps.runtimes.get(runtimeId);
    if (
      runtime &&
      runtime.providerId === framework &&
      runtime.profileActorId === profileActorId &&
      (runtime.threadId ?? null) === threadId &&
      runtime.status === 'active' &&
      runtime.adapter
    ) {
      return runtime;
    }
    return null;
  }

  function displayNameFor(
    channelId: string,
    framework: string,
    profile: AgentProfile
  ): string {
    const topic = topicStore?.get(channelId);
    return `#${topic?.display.title ?? channelId} · ${profile.displayName || framework}`;
  }

  /**
   * One provider-neutral composition path for every channel runtime. Defaults
   * are captured when a runtime is spawned/restarted; changing a topic never
   * mutates a live provider context behind the operator's back.
   */
  function composedRuntimePrompt(
    topic:
      | ReturnType<NonNullable<ChannelAgentBinderDeps['topicStore']>['get']>
      | undefined,
    profile: AgentProfile
  ): string | undefined {
    const parts = [
      topic?.promptDefaults.systemPrompt,
      topic?.promptDefaults.instructions,
      profile.systemPrompt,
    ].filter(
      (part): part is string =>
        typeof part === 'string' && part.trim().length > 0
    );
    return parts.length > 0 ? parts.join('\n\n') : undefined;
  }

  function assertRuntimeRole(
    channelId: string,
    framework: string,
    runtime: ChannelAgentRuntime,
    requiredRole?: AgentRole
  ): void {
    if (!requiredRole || runtime.role === requiredRole) return;
    throw new ChannelAgentRoleConflictError(
      channelId,
      framework,
      runtime.id,
      runtime.role ?? 'unknown'
    );
  }

  async function doEnsureBinding(
    channelId: string,
    profile: AgentProfile,
    requiredRole?: 'orchestrator',
    threadId: string | null = null
  ): Promise<LiveBinding> {
    if (closed) throw new BinderClosedError();
    const framework = profile.providerId;
    const profileActorId = profile.id;
    const key = bindingKey(channelId, profileActorId, threadId);
    const runtimeDisplayName = displayNameFor(channelId, framework, profile);
    const row = store.getBinding(channelId, profileActorId, threadId);
    // Once a profile is durably designated, every recovery path preserves that
    // runtime role — including an explicit mention that happens after restart.
    const effectiveRole = requiredRole ?? row?.role ?? undefined;

    // 2. Reuse a live entry whose private runtime is still healthy.
    const existing = live.get(key);
    if (existing?.adapter && existing.runtimeId) {
      const runtime = healthyRuntime(
        existing.runtimeId,
        framework,
        profileActorId,
        threadId
      );
      if (runtime && runtime.adapter === existing.adapter) {
        assertRuntimeRole(channelId, framework, runtime, effectiveRole);
        // Reuse still links: a topic row created (or re-created) after this
        // runtime was attached would otherwise never learn its participant.
        // The patch helper returns undefined when already linked, so a hot
        // rebind pays one indexed topic read and no write.
        linkRuntimeToTopic(channelId, runtime.id);
        return existing;
      }
    }

    // Sender attribution label (#1234): the vendor DEFAULT profile inherits the
    // framework catalog label (built-in default profiles carry an empty stored
    // displayName). Resolved past the reuse fast-path so a hot rebind pays no
    // availability probe; failures fall back to the raw framework id.
    const senderDisplayName = await rosterDisplayName(profile);

    // 3. Rebind a restored provider conversation to a live private runtime.
    const restored = healthyRuntime(
      row?.runtimeId ?? null,
      framework,
      profileActorId,
      threadId
    );
    if (restored) {
      assertRuntimeRole(channelId, framework, restored, effectiveRole);
      return attachRuntime(
        channelId,
        profileActorId,
        framework,
        senderDisplayName,
        restored,
        threadId
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

    // 4. Spawn a fresh private runtime for this channel participant.
    const routing = topic?.routingDefaults ?? {};
    const inheritedPrompt = composedRuntimePrompt(topic, profile);
    const cwd =
      routing.cwd ?? routing.worktreePath ?? routing.repoPath ?? os.homedir();
    const provisional =
      existing ??
      newLiveBinding(
        channelId,
        profileActorId,
        framework,
        senderDisplayName,
        threadId
      );
    live.set(key, provisional);
    setStatus(provisional, 'spawning');
    let created: ChannelAgentRuntime;
    try {
      created = await deps.runtimes.create({
        channelId,
        threadId,
        providerId: framework,
        profileActorId,
        cwd,
        displayName: runtimeDisplayName,
        port: deps.port,
        configDir: deps.configDir,
        ...(row?.providerSession
          ? { providerSession: row.providerSession }
          : {}),
        ...(effectiveRole ? { role: effectiveRole } : {}),
        ...(routing.repoPath ? { repoPath: routing.repoPath } : {}),
        ...(routing.worktreePath ? { worktreePath: routing.worktreePath } : {}),
        ...(yolo ? { permissionMode: YOLO_PERMISSION_MODE } : {}),
        ...(profile.model !== undefined ? { model: profile.model } : {}),
        ...(profile.envVars !== undefined
          ? { processEnv: profile.envVars }
          : {}),
        ...(inheritedPrompt !== undefined
          ? { systemPrompt: inheritedPrompt }
          : {}),
        ...(profile.provider !== undefined || profile.effort !== undefined
          ? {
              extra: {
                ...(profile.provider !== undefined
                  ? { provider: profile.provider }
                  : {}),
                ...(profile.effort !== undefined
                  ? { effort: profile.effort }
                  : {}),
              },
            }
          : {}),
      });
    } catch (err) {
      setStatus(provisional, 'idle');
      if (isMissingLaunchCommandError(err)) {
        const target = await resolveTarget(framework).catch(() => undefined);
        const command = target?.command;
        const commandStillInstalled = command
          ? resolveExecutablePath(command, effectiveLaunchEnv(profile)) !== null
          : false;
        // The probe result may have raced a config/gateway refresh. Invalidate
        // with a generation bump so an older in-flight completion cannot put
        // stale targets back after this failure.
        invalidateTargets();
        logger.warn('channel agent launch path disappeared:', err);
        const friendlyMessage =
          command && !commandStillInstalled
            ? `@${senderDisplayName} could not start because the configured command "${command}" is not available on this node. Install or configure that CLI on the Relay hub, then review Settings → Agent profiles and try again.`
            : `@${senderDisplayName} could not start because a launch path was not found on this node.${command ? ` The command "${command}" is installed; verify` : ' Verify'} the channel repo/worktree path and Settings → Agent profiles, then try again.`;
        throw new ChannelBindingError(
          friendlyMessage,
          friendlyMessage,
          command !== undefined && !commandStillInstalled
        );
      }
      throw new ChannelBindingError(
        `spawn failed for @${senderDisplayName}: ${errText(err)}`,
        `@${senderDisplayName} failed to start: ${errText(err)}`
      );
    }
    // close() may have raced the spawn await: abort before we attach a bridge,
    // arm listeners, or write to a closing store (Amendment: shutdown contract).
    if (closed) {
      await deps.runtimes.destroy(created.id);
      throw new BinderClosedError();
    }
    const binding = attachRuntime(
      channelId,
      profileActorId,
      framework,
      senderDisplayName,
      created,
      threadId
    );
    // Orientation rule (#1408). Steps 2 and 3 above returned runtimes that still
    // HOLD the thread conversation, so their packets honour the durable cursor.
    // This one was just spawned: unless the provider handed back resume state
    // that replays the prior conversation, it knows nothing about the thread and
    // the stored cursor would silently starve it of its own root.
    binding.threadOrientationPending =
      threadId !== null &&
      !hasProviderResumeState(framework, row?.providerSession);
    store.upsertBinding({
      channelId,
      threadId,
      profileActorId,
      agentFramework: framework,
      runtimeId: created.id,
      providerSession: {
        ...(row?.providerSession ?? {}),
        ...created.providerSession,
      },
    });
    setStatus(binding, 'idle');
    return binding;
  }

  function ensureBinding(
    channelId: string,
    framework: string
  ): Promise<LiveBinding> {
    return ensureProfileBinding(
      channelId,
      defaultProfileForProvider(framework)
    );
  }

  function assertBindingRole(
    binding: LiveBinding,
    framework: string,
    requiredRole: 'orchestrator'
  ): void {
    const runtime = binding.runtimeId
      ? healthyRuntime(
          binding.runtimeId,
          framework,
          binding.profileActorId,
          binding.threadId
        )
      : null;
    if (runtime?.role === requiredRole) return;
    throw new ChannelAgentRoleConflictError(
      binding.channelId,
      framework,
      binding.runtimeId ?? 'unknown',
      runtime?.role ?? 'unknown'
    );
  }

  function persistOrchestratorDesignation(binding: LiveBinding): void {
    store.designateSoleOrchestrator({
      channelId: binding.channelId,
      profileActorId: binding.profileActorId,
      agentFramework: binding.framework,
    });
  }

  function assertSoleOrchestratorTarget(
    channelId: string,
    profileActorId: string
  ): void {
    const designated = store.getSoleOrchestratorBinding(channelId);
    if (!designated || designated.profileActorId === profileActorId) return;
    throw createChannelOrchestratorConflictError({
      channelId,
      designatedProfileActorId: designated.profileActorId,
      requestedProfileActorId: profileActorId,
    });
  }

  function ensureProfileBinding(
    channelId: string,
    profile: AgentProfile,
    requiredRole?: 'orchestrator',
    threadId: string | null = null
  ): Promise<LiveBinding> {
    const key = bindingKey(channelId, profile.id, threadId);
    const pending = inflight.get(key);
    if (pending) {
      if (!requiredRole) return pending;
      return pending.then((binding) => {
        assertBindingRole(binding, profile.providerId, requiredRole);
        return binding;
      });
    }
    // Store before awaiting so concurrent mentions of one profile single-flight.
    const promise = doEnsureBinding(
      channelId,
      profile,
      requiredRole,
      threadId
    ).finally(() => {
      inflight.delete(key);
    });
    inflight.set(key, promise);
    return promise;
  }

  async function ensureOrchestrator(
    channelId: string,
    framework = 'claude',
    profileActorId?: string
  ): Promise<LiveBinding> {
    const profile = profileActorId
      ? (deps.agentProfileStore?.get(profileActorId) ?? null)
      : defaultProfileForProvider(framework);
    if (!profile) {
      throw new ChannelBindingError(
        `agent profile ${profileActorId} was not found`,
        'The requested agent profile no longer exists.'
      );
    }

    const channelPending = orchestratorInflight.get(channelId);
    if (channelPending) {
      // First writer wins. A failed first attempt leaves no durable reservation,
      // so the waiter retries; a success is observed by the preflight below.
      await channelPending.catch(() => undefined);
      return ensureOrchestrator(channelId, framework, profileActorId);
    }

    const promise = (async () => {
      assertSoleOrchestratorTarget(channelId, profile.id);
      const binding = await ensureProfileBinding(
        channelId,
        profile,
        'orchestrator'
      );
      persistOrchestratorDesignation(binding);
      return binding;
    })().finally(() => {
      orchestratorInflight.delete(channelId);
    });
    orchestratorInflight.set(channelId, promise);
    return promise;
  }

  // ── turn queue + delivery ───────────────────────────────────────────────────

  /**
   * True when two queued triggers would drain as ONE turn. Single source of
   * truth for both the drain (`pump`) and the overflow rule below.
   *
   * Three conditions, each load-bearing:
   *   • both HUMAN — see `pump`'s doc comment.
   *   • same thread scope — see `pump`'s doc comment.
   *   • STRICTLY INCREASING seq. Coalescing folds the older members into the
   *     newer one's packet as context rows, which only works while the newer
   *     one really is newer: `buildPacket` selects rows with `seq <
   *     trigger.seq`. The queue is NOT guaranteed seq-ordered —
   *     `handleSendFailure` re-enqueues an older, already-failed trigger behind
   *     whatever arrived while the transport was failing — so without this
   *     guard a re-enqueued M1 could swallow a newer M3 that is neither the
   *     trigger nor a context row of the resulting packet. The message would
   *     have been spliced out of the queue and produce nothing at all.
   *     Seq order alone is NOT sufficient for that case: a re-enqueued trigger
   *     is also below the delivery cursor, so folding it into a NEWER member's
   *     packet loses it too. `pump` keeps such entries out of runs entirely
   *     (`QueuedTurn.reEnqueued`); this predicate handles the ordering half.
   *   • no image parts on EITHER row. A packet's image budget
   *     (`PACKET_IMAGE_MAX_COUNT`) is per-packet, not per-message, so folding N
   *     image-bearing posts into one turn silently spends one budget on all of
   *     them. Attachments are operator content we promised not to drop, so an
   *     image-bearing post keeps one-trigger-one-turn and its own budget.
   */
  function coalescesIntoOneTurn(
    earlier: ChannelMessage,
    later: ChannelMessage
  ): boolean {
    return (
      earlier.sender.kind === 'human' &&
      later.sender.kind === 'human' &&
      earlier.threadId === later.threadId &&
      later.seq > earlier.seq &&
      (earlier.parts?.length ?? 0) === 0 &&
      (later.parts?.length ?? 0) === 0
    );
  }

  function enqueueTurn(
    binding: LiveBinding,
    trigger: ChannelMessage,
    steering?: ChannelPostSteering,
    reEnqueued = false,
    completionCallback?: ChannelCompletionCallbackEdge,
    callbackEdgeRequest?: CallbackEdgeRequest
  ): boolean {
    // A delegation becomes durable at FIFO admission, not when the provider
    // eventually starts it. This preserves a queued B/C target across restart
    // and gives rejection a concrete edge to terminalize upward.
    let admittedDelegationTurnId: string | undefined;
    if (callbackEdgeRequest) {
      if (binding.runtimeId === null) {
        logger.warn(
          'channel completion callback admission has no target runtime'
        );
        return false;
      }
      admittedDelegationTurnId = channelTurnId(
        trigger.id,
        binding.profileActorId
      );
      try {
        store.createCompletionCallback({
          id: completionCallbackEdgeId(admittedDelegationTurnId),
          channelId: binding.channelId,
          threadId: trigger.threadId,
          triggerMessageId: trigger.id,
          requesterProfileId: callbackEdgeRequest.requesterProfileId,
          targetProfileId: binding.profileActorId,
          targetRuntimeId: binding.runtimeId,
          targetTurnId: admittedDelegationTurnId,
          ...(callbackEdgeRequest.continuationParentCallbackId
            ? {
                continuationParentCallbackId:
                  callbackEdgeRequest.continuationParentCallbackId,
              }
            : {}),
        });
        maybePruneCompletionCallbacks();
      } catch (err) {
        logger.warn('channel completion callback admission failed:', err);
        return false;
      }
    }
    const rejectAdmittedDelegation = () => {
      if (!admittedDelegationTurnId) return;
      try {
        const satisfied = store.satisfyCompletionCallback({
          channelId: binding.channelId,
          targetProfileId: binding.profileActorId,
          targetTurnId: admittedDelegationTurnId,
          terminalReason: 'error',
          messageDisposition: CALLBACK_NO_TERMINAL_MESSAGE,
        });
        if (satisfied) drainCompletionCallbacks(0, [satisfied]);
        maybePruneCompletionCallbacks();
      } catch (err) {
        logger.warn(
          'channel completion callback admission rejection failed:',
          err
        );
      }
    };
    // Native harnesses get the user's next instruction at their own tool-safe
    // boundary. Keep this ahead of the queue branch: while a turn is live the
    // regular pump cannot dispatch, whereas a provider steer is explicitly
    // designed to alter that live turn without interrupting its current tool.
    if (
      !reEnqueued &&
      completionCallback === undefined &&
      callbackEdgeRequest === undefined &&
      steering !== 'interrupt' &&
      binding.activeTurnId !== null &&
      binding.adapter?.capabilities.steer === true &&
      binding.adapter.steerMessage !== undefined
    ) {
      if (occupiedTurnSlots(binding) >= QUEUE_CAP) {
        postSystemRow(
          binding.channelId,
          `@${binding.displayName} has ${QUEUE_CAP} messages pending — message dropped`,
          { parentMessageId: parentForTrigger(trigger) }
        );
        rejectAdmittedDelegation();
        return false;
      }
      enqueueSteering(binding, trigger);
      return true;
    }
    const entry: QueuedTurn = reEnqueued
      ? {
          trigger,
          reEnqueued: true,
          ...(completionCallback ? { completionCallback } : {}),
          ...(callbackEdgeRequest ? { callbackEdgeRequest } : {}),
        }
      : {
          trigger,
          ...(completionCallback ? { completionCallback } : {}),
          ...(callbackEdgeRequest ? { callbackEdgeRequest } : {}),
        };
    if (occupiedTurnSlots(binding) >= QUEUE_CAP) {
      const tailIndex = binding.queue.length - 1;
      const tail = binding.queue[tailIndex];
      // Neither side may be a re-enqueued trigger: superseding one silently
      // deletes a message that is below the delivery cursor and therefore
      // unrecoverable as a context row, and superseding WITH one would delete
      // the fresh tail in favour of the stale entry. Both fall through to the
      // explicit drop row below, which at least tells the operator.
      if (
        tail &&
        !tail.reEnqueued &&
        !reEnqueued &&
        tail.completionCallback === undefined &&
        completionCallback === undefined &&
        tail.callbackEdgeRequest === undefined &&
        callbackEdgeRequest === undefined &&
        coalescesIntoOneTurn(tail.trigger, trigger)
      ) {
        // A human run drains as one turn triggered by its NEWEST member, so
        // superseding the tail is identical to appending: same trigger, same
        // packet (the superseded row is still read back as a context row),
        // one fewer slot. An operator typing fast is therefore never told
        // their message was dropped for a turn that was never going to exist.
        binding.queue[tailIndex] = entry;
        emitAgentStatus(binding);
        if (steering === 'interrupt') steerInterrupt(binding, trigger);
        pump(binding);
        return true;
      }
      postSystemRow(
        binding.channelId,
        `@${binding.displayName} has ${QUEUE_CAP} messages pending — message dropped`,
        { parentMessageId: parentForTrigger(trigger) }
      );
      rejectAdmittedDelegation();
      return false;
    }
    binding.queue.push(entry);
    emitAgentStatus(binding);
    // Interrupt BEFORE pumping: while a turn is live `pump` is a no-op, and the
    // cancellation's terminal patch is what releases the binding into
    // `finishTurn` → `pump` → this message. When nothing is live the interrupt
    // is a no-op and the pump below dispatches immediately, so "interrupt and
    // send" degrades cleanly to plain "send".
    if (steering === 'interrupt') steerInterrupt(binding, trigger);
    pump(binding);
    return true;
  }

  function occupiedTurnSlots(binding: LiveBinding): number {
    return (
      binding.queue.length +
      binding.steeringQueue.length +
      binding.steeringAcceptedCount +
      (binding.steeringInFlight ? 1 : 0)
    );
  }

  function isCurrentBinding(binding: LiveBinding): boolean {
    return (
      live.get(
        bindingKey(binding.channelId, binding.profileActorId, binding.threadId)
      ) === binding
    );
  }

  /**
   * Put a post into the provider-native safe-boundary lane. The call is
   * serialized because Codex's `turn/steer` advances its expected native turn
   * id, while Claude's persistent stream-json input is ordered on stdin. No
   * retry occurs after a provider error: a transport failure can be ambiguous,
   * and retrying would violate at-most-once delivery.
   */
  function enqueueSteering(
    binding: LiveBinding,
    trigger: ChannelMessage
  ): void {
    binding.steeringQueue.push({ trigger });
    emitAgentStatus(binding);
    drainSteering(binding);
  }

  function drainSteering(binding: LiveBinding): void {
    if (closed || binding.steeringInFlight || binding.activeTurnId === null) {
      return;
    }
    const adapter = binding.adapter;
    const steerMessage = adapter?.steerMessage;
    if (adapter?.capabilities.steer !== true || !steerMessage) return;
    const entry = binding.steeringQueue.shift();
    if (!entry) return;
    const { trigger } = entry;
    const activeTurnId = binding.activeTurnId;
    let packet: ResolvedMentionContextPacket;
    try {
      // The live turn already read the header, counts, and scope marker; a
      // steer is an interjection into that turn, not a fresh delivery. Interim
      // context rows still ride along, because accepting this steer advances
      // the delivery cursor past them (#1408).
      packet = buildPacket(binding, trigger, { delivery: 'steer' });
    } catch (err) {
      logger.warn('channel binder steering packet build failed:', err);
      postSystemRow(
        binding.channelId,
        `@${binding.displayName} could not build the steering context: ${errText(err)}`,
        { parentMessageId: parentForTrigger(trigger) }
      );
      emitAgentStatus(binding);
      drainSteering(binding);
      return;
    }
    binding.steeringInFlight = true;
    emitAgentStatus(binding);
    steerMessage
      .call(adapter, {
        // The adapter preserves the live provider/Relay turn identity; this id
        // is retained only for provider implementations that annotate input.
        turnId: activeTurnId,
        content: packet.content,
        ...(packet.attachments.length > 0
          ? { attachments: packet.attachments }
          : {}),
        clientMessageId: `${trigger.id}:${binding.profileActorId}`,
      })
      .then(() => {
        if (!isCurrentBinding(binding)) return;
        // A terminal patch can win the provider-RPC race. Do not resurrect a
        // cleared steering indicator after finishTurn; replay would be unsafe
        // because a late transport result may already have been accepted.
        if (binding.activeTurnId === activeTurnId) {
          binding.steeringAcceptedCount += 1;
        }
        advanceCursor(binding, trigger);
      })
      .catch((err) => {
        if (closed || !isCurrentBinding(binding)) return;
        if (err instanceof AgentSteerRejectedError) {
          // Definite provider rejection is safe to deliver once through the
          // normal next-turn FIFO; ambiguous transport failures stay visible
          // errors and are never replayed.
          // This request is no longer in flight, so do not make it consume the
          // final aggregate slot while we move it to the ordinary queue. The
          // finally below is deliberately idempotent.
          binding.steeringInFlight = false;
          enqueueTurn(binding, trigger, undefined, true);
          return;
        }
        logger.warn('channel binder native steering failed:', err);
        postSystemRow(
          binding.channelId,
          `@${binding.displayName} could not accept the steering message: ${errText(err)}`,
          { parentMessageId: parentForTrigger(trigger) }
        );
      })
      .finally(() => {
        if (!isCurrentBinding(binding)) return;
        binding.steeringInFlight = false;
        emitAgentStatus(binding);
        // A terminal patch may have arrived while the provider RPC was in
        // flight. In that case finishTurn moves later entries to the ordinary
        // FIFO; never issue a stale steer against a completed turn.
        drainSteering(binding);
      });
  }

  /**
   * Cancel the binding's live turn on the operator's explicit instruction,
   * reusing the header chip's own path (`interrupt`) so there is exactly ONE
   * interrupt semantic in the product: the partial assistant row finalizes
   * `interrupted` via the bridge, and the adapter's terminal patch drives
   * `finishTurn`.
   *
   * Fire-and-forget with a visible failure: if the adapter refuses, the queued
   * message stays queued and rides the turn's natural completion (or the
   * watchdog), which is strictly better than dropping it. The failure row is
   * parented to the STEERING trigger, exactly like every other binder failure
   * row — an interrupt issued from a thread panel must explain itself inside
   * that thread, not at channel top level where the operator is not looking.
   */
  function steerInterrupt(binding: LiveBinding, trigger: ChannelMessage): void {
    const adapter = binding.adapter;
    const turnId = binding.activeTurnId;
    if (!adapter || turnId === null) return;
    void adapter.interrupt({ turnId }).catch((err) => {
      if (closed) return;
      logger.warn('channel binder steering interrupt failed:', err);
      postSystemRow(
        binding.channelId,
        `@${binding.displayName} could not be interrupted: ${errText(err)}`,
        { parentMessageId: parentForTrigger(trigger) }
      );
    });
  }

  /**
   * Dispatch at most ONE turn from the queue.
   *
   * Coalescing (#1308 slice 4): a contiguous run of HUMAN posts in the same
   * thread scope drains as a single turn triggered by the NEWEST of them. The
   * older ones are not lost — `buildPacket` reads every row between the delivery
   * cursor and the trigger straight out of the store, so they arrive as context
   * rows of that one packet. Three impatient messages therefore cost one turn,
   * not three. Since #1408 that holds identically in thread scope, whose packet
   * window is bounded by the per-(binding, thread) cursor rather than replaying
   * the whole thread.
   *
   * Two deliberate limits on the run:
   *   • thread scope — a threaded packet only carries its own thread, so a
   *     trigger from another thread (or the channel top level) could not stand
   *     in for it. Those stay queued and drain on the following completion.
   *   • human senders only — the packet builder drops an agent's OWN prior rows
   *     (they already live in the reused provider conversation), so coalescing an
   *     agent-authored trigger away could silently erase it. Agent posts keep
   *     one-trigger-one-turn and stay bounded by the consecutive-agent brake.
   *   • image-bearing posts only ever trigger their own turn, so the per-packet
   *     image budget is never split across several operator messages.
   * All three live in `coalescesIntoOneTurn`, together with the seq-monotonicity
   * guard that keeps a re-enqueued failed trigger from swallowing newer posts.
   * A fourth limit lives here rather than in the predicate because it is a
   * property of the ENTRY, not of the pair: a re-enqueued trigger never joins a
   * run in either direction (see below).
   */
  function pump(binding: LiveBinding): void {
    if (binding.activeTurnId !== null) return;
    if (!binding.adapter) return;
    const head = binding.queue[0];
    if (!head) return;
    let take = 1;
    // A re-enqueued trigger neither STARTS a run nor JOINS one. It sits below
    // the binding's delivery cursor (the turn that displaced it already
    // advanced the cursor past its seq), and `buildPacket` selects context rows
    // with `seq > lastDeliveredSeq` in either scope (#1408) — so folded into
    // someone else's packet it would be neither trigger nor context row and
    // would vanish entirely, the exact loss coalescing exists to avoid. This
    // guard is unconditional rather than cursor-derived, so it also covers a
    // thread binding still carrying `threadOrientationPending`. Alone it is the
    // trigger, and the footer renders the trigger unconditionally.
    if (
      !head.reEnqueued &&
      head.completionCallback === undefined &&
      head.callbackEdgeRequest === undefined
    ) {
      while (
        take < binding.queue.length &&
        !binding.queue[take]!.reEnqueued &&
        binding.queue[take]!.completionCallback === undefined &&
        binding.queue[take]!.callbackEdgeRequest === undefined &&
        coalescesIntoOneTurn(head.trigger, binding.queue[take]!.trigger)
      ) {
        take += 1;
      }
    }
    const batch = binding.queue.splice(0, take);
    emitAgentStatus(binding);
    // Newest member triggers, and "newest" means max seq — NOT last position.
    // `coalescesIntoOneTurn` is only evaluated head-vs-candidate, so a queue
    // whose order diverged from seq order (re-enqueue after a send failure)
    // can still admit a candidate that is newer than the head but older than
    // an earlier admitted member. Every non-trigger member has a lower seq, so
    // all of them are read back as context rows of this one packet.
    let trigger = batch[0]!.trigger;
    for (const entry of batch) {
      if (entry.trigger.seq > trigger.seq) trigger = entry.trigger;
    }
    const completionCallback = batch.find(
      (entry) => entry.completionCallback !== undefined
    )?.completionCallback;
    const callbackEdgeRequest = batch.find(
      (entry) => entry.callbackEdgeRequest !== undefined
    )?.callbackEdgeRequest;
    sendTurn(binding, trigger, completionCallback, callbackEdgeRequest);
  }

  function buildPacket(
    binding: LiveBinding,
    trigger: ChannelMessage,
    options?: { delivery?: 'turn' | 'steer' }
  ): ResolvedMentionContextPacket {
    const topic = topicStore?.get(binding.channelId);
    const title = topic?.display.title ?? binding.channelId;
    // Fails closed to the multi-party framing: without a topic row DM-ness is
    // unprovable, and telling a group channel's agent it is in a private DM is
    // the worse error of the two. A DM is also only a DM FOR ITS OWN AGENT — a
    // human may explicitly @-mention a second profile inside one
    // (`resolvedPostTargets`: pinned mentions win), and that guest genuinely
    // shares the channel with the human AND the DM's agent, so it gets the
    // multi-party header.
    const dmProviderId = topic ? isDmChannel(topic) : null;
    const channelKind =
      dmProviderId !== null &&
      defaultProfileForProvider(dmProviderId).id === binding.profileActorId
        ? ('dm' as const)
        : ('channel' as const);
    const row = store.getBinding(
      binding.channelId,
      binding.profileActorId,
      binding.threadId
    );
    const lastDeliveredSeq =
      typeof row?.providerSession['lastDeliveredSeq'] === 'number'
        ? (row.providerSession['lastDeliveredSeq'] as number)
        : 0;
    // #1408: thread packets carry only what arrived since this binding's last
    // ACCEPTED turn, exactly as channel packets already did — the durable
    // per-(channel, thread, profile) cursor is the same row `advanceCursor`
    // writes. The one override is a runtime that cannot possibly hold the
    // conversation the cursor implies (fresh spawn, no provider resume state):
    // it is oriented from 0 so it still receives the root and the window.
    const effectiveCursor =
      binding.threadId !== null && binding.threadOrientationPending
        ? 0
        : lastDeliveredSeq;
    const context = store.mentionContext({
      channelId: binding.channelId,
      framework: binding.framework,
      triggerSeq: trigger.seq,
      afterSeq: effectiveCursor,
      threadRootId: trigger.threadId,
      limit: PACKET_MAX_ROWS,
    });
    return resolveMentionContextPacket(
      buildMentionContextPacketEnvelope({
        channelId: binding.channelId,
        channelTitle: title,
        channelKind,
        ...(options?.delivery ? { delivery: options.delivery } : {}),
        framework: binding.framework,
        rows: context.rows,
        trigger,
        // Store and builder MUST agree byte-exactly: the summary counts come
        // from the store's window, and the builder re-filters the same rows.
        lastDeliveredSeq: effectiveCursor,
        summary: {
          totalCount: context.totalCount,
          activityFilteredCount: context.activityFilteredCount,
          candidateScanBudget: context.candidateScanBudget,
          candidateScanTruncated: context.candidateScanTruncated,
          scope: context.scope,
        },
      }),
      deps.attachmentStore
    );
  }

  function buildCompletionCallbackPacket(
    binding: LiveBinding,
    trigger: ChannelMessage,
    callback: ChannelCompletionCallbackEdge
  ): ResolvedMentionContextPacket {
    const packet = buildPacket(binding, trigger);
    const finalReference = callback.terminalMessageId
      ? `finalMessageId=${callback.terminalMessageId}`
      : 'finalMessageId=none';
    return {
      ...packet,
      content: `${packet.content}\n\n[Relay internal completion callback]\nThis is a typed Relay completion trigger, not a chat message or a new delegation.\ncallbackId=${callback.id}\ndelegateeProfileId=${callback.targetProfileId}\ntargetTurnId=${callback.targetTurnId}\nterminalReason=${callback.terminalReason ?? 'unknown'}\nmessageDisposition=${callback.messageDisposition ?? 'no-terminal-message'}\n${finalReference}\nContinue the requester workflow if needed; do not infer a reverse callback edge from this trigger.`,
    };
  }

  function sendTurn(
    binding: LiveBinding,
    trigger: ChannelMessage,
    completionCallback?: ChannelCompletionCallbackEdge,
    callbackEdgeRequest?: CallbackEdgeRequest
  ): void {
    const adapter = binding.adapter;
    if (!adapter) return;
    const turnId = completionCallback
      ? completionCallbackTurnId(completionCallback, binding.profileActorId)
      : channelTurnId(trigger.id, binding.profileActorId);
    // Build the packet BEFORE mutating any binding state: buildPacket does
    // synchronous SQLite work (getBinding/mentionContext) that can throw. If it did so
    // AFTER activeTurnId was set (and before the watchdog armed), the binding
    // wedged 'turn-active' forever with no in-flight turn — the queue filled and
    // every later mention dropped. On a throw we surface a row and keep draining.
    let packet: ResolvedMentionContextPacket;
    try {
      packet = completionCallback
        ? buildCompletionCallbackPacket(binding, trigger, completionCallback)
        : buildPacket(binding, trigger);
    } catch (err) {
      logger.warn('channel binder packet build failed:', err);
      postSystemRow(
        binding.channelId,
        `@${binding.displayName} could not build the message context: ${errText(err)}`,
        { parentMessageId: parentForTrigger(trigger) }
      );
      if (completionCallback) {
        try {
          store.releaseDeliveredCompletionCallback(completionCallback.id);
          drainCompletionCallbacks(COMPLETION_CALLBACK_RETRY_MS, [
            completionCallback,
          ]);
        } catch (releaseErr) {
          logger.warn(
            'channel completion callback packet-failure release failed:',
            releaseErr
          );
        }
      }
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
    retainExactTurnTombstones(binding);
    binding.parentMessageIdByTurn.clear();
    binding.requestMessageIdByTurn.clear();
    binding.activeTurnId = turnId;
    binding.parentMessageIdByTurn.set(
      turnId,
      parentForTrigger(trigger) ?? null
    );
    // Completion callbacks travel upward only. They must never inherit the
    // triggering requester run or make callback prose look like a reply to it.
    if (!completionCallback) {
      binding.requestMessageIdByTurn.set(turnId, trigger.id);
      const asyncRun = store.getAsyncRunForRequestMessage(trigger.id);
      if (asyncRun) {
        const changed = store.transitionAsyncRunTarget({
          runId: asyncRun.id,
          targetId: binding.profileActorId,
          state: 'working',
        });
        if (changed) hub.broadcastRunLifecycle(changed);
      }
    }
    if (completionCallback?.continuationParentCallbackId) {
      binding.continuationByTurn.set(turnId, {
        childCallbackId: completionCallback.id,
        parentCallbackId: completionCallback.continuationParentCallbackId,
      });
    }
    if (completionCallback) {
      binding.completionCallbackByTurn.set(turnId, completionCallback);
    }
    binding.sawStream = false;
    binding.waitingOn = null;
    binding.activeContent = packet.content;
    binding.activeAttachments = packet.attachments;
    setStatus(binding, 'thinking');
    armWatchdog(binding);
    deliver(
      binding,
      adapter,
      turnId,
      trigger,
      completionCallback,
      callbackEdgeRequest
    );
  }

  function deliver(
    binding: LiveBinding,
    adapter: ProtocolAdapterV2,
    turnId: string,
    trigger: ChannelMessage,
    completionCallback?: ChannelCompletionCallbackEdge,
    callbackEdgeRequest?: CallbackEdgeRequest
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
        clientMessageId: completionCallback
          ? `${completionCallback.id}:${binding.profileActorId}`
          : `${trigger.id}:${binding.profileActorId}`,
      })
      .then(() => {
        if (!completionCallback) {
          advanceCursor(binding, trigger);
          return;
        }
        // `sendMessage` acceptance is the callback's delivery boundary. The
        // CAS deliberately follows acceptance so a crash-before-send reopens
        // the claim after restart; repeat acceptance then sees consumed=false
        // and cannot synthesize a second upward continuation.
        if (store.consumeCompletionCallback(completionCallback.id)) {
          flushDeferredCompletionTerminal(binding, turnId);
          maybePruneCompletionCallbacks();
          if (binding.activeTurnId !== turnId) {
            binding.completionCallbackByTurn.delete(turnId);
          }
        }
      })
      .catch((err) =>
        handleSendFailure(
          binding,
          trigger,
          turnId,
          err,
          completionCallback,
          callbackEdgeRequest
        )
      );
  }

  function advanceCursor(binding: LiveBinding, trigger: ChannelMessage): void {
    if (closed) return; // never write to a closing store from an in-flight send
    const triggerSeq = trigger.seq;
    // Cursor advances only on send acceptance (§4): a failed send re-offers the
    // rows next mention (at-least-once). Never lower the cursor.
    try {
      // Acceptance is the orientation boundary too (#1408): the provider now
      // holds this thread's window, so later turns follow the durable cursor.
      // Cleared before the early return below — a re-delivered trigger at or
      // below the cursor is still an accepted send.
      binding.threadOrientationPending = false;
      const row = store.getBinding(
        binding.channelId,
        binding.profileActorId,
        binding.threadId
      );
      const prev = row?.providerSession ?? {};
      const current =
        typeof prev['lastDeliveredSeq'] === 'number'
          ? (prev['lastDeliveredSeq'] as number)
          : 0;
      if (triggerSeq <= current) return;
      store.upsertBinding({
        channelId: binding.channelId,
        threadId: binding.threadId,
        profileActorId: binding.profileActorId,
        agentFramework: binding.framework,
        providerSession: { ...prev, lastDeliveredSeq: triggerSeq },
      });
    } catch (err) {
      logger.warn('channel binder cursor advance failed:', err);
    }
  }

  function persistProviderSession(
    binding: LiveBinding,
    providerSession: Record<string, string>
  ): void {
    if (closed) return;
    try {
      const row = store.getBinding(
        binding.channelId,
        binding.profileActorId,
        binding.threadId
      );
      store.upsertBinding({
        channelId: binding.channelId,
        threadId: binding.threadId,
        profileActorId: binding.profileActorId,
        agentFramework: binding.framework,
        providerSession: {
          ...(row?.providerSession ?? {}),
          ...providerSession,
        },
      });
    } catch (err) {
      logger.warn('channel binder provider resume persist failed:', err);
    }
  }

  /**
   * Rebuild the retained turn packet for a runtime that REPLACED the one it was
   * built for (#1408).
   *
   * A retry normally redelivers byte-identical content. That is exactly right
   * for a reused runtime, and wrong for a fresh thread process with no provider
   * resume state: the retained packet was windowed at the durable cursor for a
   * process that no longer exists, so it can be replies-only and would orient
   * the new one by nothing. Content identity exists to protect a provider that
   * already accepted the send, and a rejected `sendMessage` never accepted it.
   *
   * A failed rebuild keeps the retained packet — a slightly under-oriented retry
   * beats losing the turn.
   *
   * KNOWN BOUND of the at-most-once steer rule. `drainSteering` advances the
   * durable cursor the moment a steer is ACCEPTED, which is a different event
   * from the owning turn's `sendMessage` resolving. If a runtime accepts a steer
   * and then rejects (or has already rejected) the turn send, the rebuild below
   * re-windows from the failed TURN trigger — so the steer instruction, and any
   * rows between the trigger and it, reached only the dead process and are not
   * redelivered. Both halves are pre-existing turn semantics (cursor advances on
   * acceptance; steers are never retried); the reorientation here narrows the
   * window rather than widening it. Closing it properly means holding the steer's
   * cursor advance until its owning turn is also accepted — worth doing only if
   * this is ever observed live, since it trades an at-most-once rule for a
   * two-phase one.
   */
  function reorientRetainedPacket(
    binding: LiveBinding,
    trigger: ChannelMessage,
    completionCallback?: ChannelCompletionCallbackEdge
  ): void {
    if (!binding.threadOrientationPending) return;
    try {
      const reoriented = completionCallback
        ? buildCompletionCallbackPacket(binding, trigger, completionCallback)
        : buildPacket(binding, trigger);
      binding.activeContent = reoriented.content;
      binding.activeAttachments = reoriented.attachments;
    } catch (err) {
      logger.warn('channel binder thread orientation rebuild failed:', err);
    }
  }

  async function handleSendFailure(
    binding: LiveBinding,
    trigger: ChannelMessage,
    turnId: string,
    err: unknown,
    completionCallback?: ChannelCompletionCallbackEdge,
    callbackEdgeRequest?: CallbackEdgeRequest
  ): Promise<void> {
    if (closed) return; // shutdown in progress — no rows, no re-delivery
    // A rejected sendMessage means the turn was NEVER accepted (Amendment 3), so
    // a single retry-after-rebind is safe — covers dead legacy-bridge transports.
    if (!binding.retriedTurns.has(turnId)) {
      binding.retriedTurns.add(turnId);
      const priorRuntimeId = binding.runtimeId;
      try {
        const profile = deps.agentProfileStore
          ? deps.agentProfileStore.get(binding.profileActorId)
          : defaultProfileForProvider(binding.framework);
        if (!profile) {
          throw new ChannelBindingError(
            `agent profile ${binding.profileActorId} no longer exists`,
            `@${binding.displayName} could not receive the message: its profile no longer exists.`
          );
        }
        const rebound = await ensureProfileBinding(
          binding.channelId,
          profile,
          undefined,
          binding.threadId
        );
        if (closed) return;
        if (rebound.adapter && rebound.activeTurnId === turnId) {
          // Same binding still owns this turn — redeliver identical content,
          // except when the rebind replaced the runtime outright (#1408).
          if (rebound.runtimeId !== priorRuntimeId) {
            reorientRetainedPacket(rebound, trigger, completionCallback);
          }
          deliver(
            rebound,
            rebound.adapter,
            turnId,
            trigger,
            completionCallback,
            callbackEdgeRequest
          );
          return;
        }
        if (rebound.adapter) {
          // The binding was rebound to a fresh/different runtime (e.g. after the
          // failed send tore the runtime down). A NEWER turn may already be
          // active on it — never clobber it. Re-enqueue (cap-respecting): pump
          // delivers when the binding is free, and sendTurn re-establishes the
          // status/sawStream/watchdog for the retried turn instead of the
          // fallback overwriting an in-flight turn's lifecycle tracking.
          // Marked re-enqueued: the newer turn that took this binding has
          // already advanced the delivery cursor past this trigger's seq, so it
          // must get its own turn rather than be coalesced into a later packet
          // that would filter it out (see `QueuedTurn.reEnqueued` and `pump`).
          enqueueTurn(
            rebound,
            trigger,
            undefined,
            true,
            completionCallback,
            callbackEdgeRequest
          );
          return;
        }
      } catch {
        // fall through to the error row
      }
    }
    if (completionCallback) {
      releaseUnacceptedCompletionCallbackTurn(binding, turnId);
      releaseTurnParent(binding, turnId);
      binding.finalMessageByTurn.delete(turnId);
      binding.continuationByTurn.delete(turnId);
      if (binding.activeTurnId === turnId) {
        binding.activeTurnId = null;
        binding.activeContent = null;
        binding.activeAttachments = [];
        binding.waitingOn = null;
        binding.sawStream = false;
        disarmWatchdog(binding);
        setStatus(binding, 'idle');
        emitAgentStatus(binding);
        pump(binding);
      }
      return;
    }
    postSystemRow(
      binding.channelId,
      `@${binding.displayName} could not receive the message: ${errText(err)}`,
      { parentMessageId: parentForTrigger(trigger) }
    );
    releaseTurnParent(binding, turnId);
    finishTurn(binding, 'error');
  }

  /**
   * Drop every trigger waiting on a binding whose runtime is gone (#1307), with
   * one system row each so the operator sees exactly which posts never ran. The
   * caller broadcasts afterwards: the queue depth rides the same
   * `channel-agent-status` event as the status, so it must be empty BEFORE the
   * terminal idle goes out or the queued-send chips stay lit against an agent
   * that is idle and unbound.
   */
  function dropQueuedTurns(binding: LiveBinding): void {
    for (const queued of binding.queue) {
      if (queued.completionCallback) {
        // This is an upward callback that was claimed into an in-memory FIFO
        // but never handed to the dead runtime. Re-offer it; do not pretend the
        // requester accepted it or terminalize a reverse relation.
        try {
          store.releaseDeliveredCompletionCallback(
            queued.completionCallback.id
          );
          drainCompletionCallbacks(COMPLETION_CALLBACK_RETRY_MS, [
            queued.completionCallback,
          ]);
        } catch (err) {
          logger.warn(
            'channel queued completion callback release failed:',
            err
          );
        }
      }
      if (queued.callbackEdgeRequest) {
        // A downward target already has its durable edge at FIFO admission. Its
        // dead runtime is a guarded terminal outcome, so wake the delegator
        // through normal callback routing rather than silently losing the
        // parent intent (or waiting for a hub restart to discover it).
        try {
          const targetTurnId = channelTurnId(
            queued.trigger.id,
            binding.profileActorId
          );
          const satisfied = store.satisfyCompletionCallback({
            channelId: binding.channelId,
            targetProfileId: binding.profileActorId,
            targetTurnId,
            terminalReason: CALLBACK_UNEXPECTED_DISCONNECT,
            messageDisposition: CALLBACK_NO_TERMINAL_MESSAGE,
          });
          if (satisfied) drainCompletionCallbacks(0, [satisfied]);
          maybePruneCompletionCallbacks();
        } catch (err) {
          logger.warn('channel queued delegation terminalization failed:', err);
        }
      }
      postSystemRow(
        binding.channelId,
        `@${binding.displayName} runtime ended before delivering a queued message.`,
        { parentMessageId: parentForTrigger(queued.trigger) }
      );
    }
    binding.queue = [];
    for (const steering of binding.steeringQueue) {
      if (steering.completionCallback) {
        try {
          store.releaseDeliveredCompletionCallback(
            steering.completionCallback.id
          );
          drainCompletionCallbacks(COMPLETION_CALLBACK_RETRY_MS, [
            steering.completionCallback,
          ]);
        } catch (err) {
          logger.warn('channel queued steering callback release failed:', err);
        }
      }
      if (steering.callbackEdgeRequest) {
        try {
          const targetTurnId = channelTurnId(
            steering.trigger.id,
            binding.profileActorId
          );
          const satisfied = store.satisfyCompletionCallback({
            channelId: binding.channelId,
            targetProfileId: binding.profileActorId,
            targetTurnId,
            terminalReason: CALLBACK_UNEXPECTED_DISCONNECT,
            messageDisposition: CALLBACK_NO_TERMINAL_MESSAGE,
          });
          if (satisfied) drainCompletionCallbacks(0, [satisfied]);
          maybePruneCompletionCallbacks();
        } catch (err) {
          logger.warn(
            'channel queued steering delegation terminalization failed:',
            err
          );
        }
      }
      postSystemRow(
        binding.channelId,
        `@${binding.displayName} runtime ended before accepting a steering message.`,
        { parentMessageId: parentForTrigger(steering.trigger) }
      );
    }
    binding.steeringQueue = [];
    binding.steeringInFlight = false;
    binding.steeringAcceptedCount = 0;
  }

  /**
   * Terminal presence for a runtime that died under an open turn (#1307).
   * Deliberately NOT `finishTurn`: it must also clear a binding whose turn was
   * already over but whose status never came back (a spawn that never
   * completed), and it must not `pump` a queued turn into an adapter that is
   * known to be gone — those triggers are dropped here instead, so the single
   * idle broadcast carries `queuedCount: 0` and bumps the drain generation the
   * queued-send chips key off (#1308 slice 4).
   */
  function markDeadRuntimeIdle(binding: LiveBinding): void {
    if (binding.activeTurnId !== null) {
      const activeTurnId = binding.activeTurnId;
      if (!releaseUnacceptedCompletionCallbackTurn(binding, activeTurnId)) {
        terminalizeCompletionCallback(
          binding,
          activeTurnId,
          CALLBACK_UNEXPECTED_DISCONNECT
        );
      }
      binding.finalMessageByTurn.delete(activeTurnId);
      binding.continuationByTurn.delete(activeTurnId);
    }
    binding.activeTurnId = null;
    binding.activeContent = null;
    binding.activeAttachments = [];
    binding.waitingOn = null;
    binding.sawStream = false;
    binding.announcedApprovals.clear();
    disarmWatchdog(binding);
    dropQueuedTurns(binding);
    setStatus(binding, 'idle');
    // The binding may already have BEEN idle (a spawn that never completed), so
    // the dropped queue needs its own emit — `setStatus` dedupes on status.
    emitAgentStatus(binding);
  }

  function finishTurn(
    binding: LiveBinding,
    terminalReason: ChannelCompletionCallbackTerminalReason = 'safe-idle'
  ): void {
    const terminalTurnId = binding.activeTurnId;
    if (terminalTurnId === null) return;
    transitionAsyncRunTargetForTurn(
      binding,
      terminalTurnId,
      terminalReason === 'completed' || terminalReason === 'safe-idle'
        ? 'completed'
        : terminalReason === 'interrupt'
          ? 'cancelled'
          : 'failed'
    );
    terminalizeCompletionCallback(binding, terminalTurnId, terminalReason);
    const callback = binding.completionCallbackByTurn.get(terminalTurnId);
    if (
      callback &&
      store.getCompletionCallback(callback.id)?.state === 'consumed'
    ) {
      binding.completionCallbackByTurn.delete(terminalTurnId);
    }
    binding.finalMessageByTurn.delete(terminalTurnId);
    binding.continuationByTurn.delete(terminalTurnId);
    binding.activeTurnId = null;
    binding.activeContent = null;
    binding.activeAttachments = [];
    binding.waitingOn = null;
    binding.sawStream = false;
    disarmWatchdog(binding);
    setStatus(binding, 'idle');
    // If the provider completed before later safe-boundary requests were
    // accepted, preserve FIFO by falling back to ordinary next-turn delivery.
    // The in-flight request is intentionally not replayed: its transport result
    // may be ambiguous, so re-sending it would break at-most-once semantics.
    if (binding.steeringQueue.length > 0) {
      binding.queue.push(...binding.steeringQueue);
      binding.steeringQueue = [];
      emitAgentStatus(binding);
    }
    binding.steeringAcceptedCount = 0;
    emitAgentStatus(binding);
    pump(binding);
  }

  // ── binder-owned patch listener ─────────────────────────────────────────────

  function markStreaming(binding: LiveBinding): void {
    binding.sawStream = true;
    if (binding.waitingOn === null) setStatus(binding, 'streaming');
  }

  function handleBindingPatch(binding: LiveBinding, patch: AgentPatchV2): void {
    switch (patch.type) {
      case 'agent-session-updated-v2':
        if (patch.providerSession) {
          persistProviderSession(binding, patch.providerSession);
        }
        break;
      case 'agent-session-snapshot-v2':
        if (patch.session.providerSession) {
          persistProviderSession(binding, patch.session.providerSession);
        }
        break;
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
        handleLiveState(binding, patch.live);
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
          finishTurn(
            binding,
            patch.status === 'interrupted'
              ? 'interrupt'
              : patch.status === 'failed'
                ? 'error'
                : 'completed'
          );
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
                `@${binding.displayName} errored: ${patch.message}`,
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
            finishTurn(binding, 'error');
          }
        }
        break;
      default:
        break;
    }
  }

  function handleLiveState(
    binding: LiveBinding,
    live: AgentLiveStateUpdatedPatchV2['live']
  ): void {
    if (live.status === 'disconnected') {
      // The runtime is GONE, not resting (#1307). This branch is reached only on
      // an UNEXPECTED transport/process death: codex-native emits it when its
      // client closes on its own, a deliberate `disconnect()` tears down state
      // without re-emitting, and the legacy v1 compat maps its `disconnected`
      // session-status to `idle` (agent-chat-v1-compat.ts). A dead process can
      // never answer an approval prompt or finish its turn, so this is terminal
      // even mid-approval — the one thing a bare `idle` must never be.
      //
      // Before this branch existed the patch fell through to the `waitingOn`
      // handling below (codex carries an explicit `waitingOn: null`), which was
      // wrong in both directions: mid-approval it flipped 'waiting' → 'thinking'
      // and RE-ARMED the watchdog, so five minutes later the watchdog
      // force-drained the turn — abandoning the approval and pumping a queued
      // turn into the dead adapter for a guaranteed send-failure row — and with
      // no active turn it did nothing at all.
      //
      // Presence and the queue only. The durable unbind and the live-map delete
      // belong to `releaseBinding`, which runs when the runtime's own teardown
      // lands (or when the sweep notices it never did).
      markDeadRuntimeIdle(binding);
      return;
    }
    if (live.status === 'idle') {
      // A runtime that reports `idle` has no active turn. Finalize ours even
      // when a matching `agent-turn-completed-v2` never fired (or arrives after
      // this idle live-state): hermes can emit `session-status idle` without a
      // paired turn-completed when its turn id was already cleared, and the
      // `waitingOn` branch below would otherwise flip the binding back to
      // 'thinking' and wedge presence forever (#1181 defect 3).
      //
      // BUT while an approval is outstanding (or the binding is otherwise
      // waiting) the idle is a lie: hermes fires `session-status
      // {status:'idle', waitingOn:'approval'}` alongside a permission prompt,
      // and the legacy compat mapping strips the `waitingOn` for the idle case
      // (agent-chat-v1-compat.ts), so a BARE idle arrives mid-approval. Ignore
      // it entirely then — finalizing would abandon the approval and let `pump`
      // dispatch a concurrent turn to the same runtime, and falling through to
      // `updateWaiting(null)` would clobber the waiting state and re-arm the
      // watchdog against the parked turn.
      if (
        binding.activeTurnId !== null &&
        binding.announcedApprovals.size === 0 &&
        binding.waitingOn === null
      ) {
        finishTurn(binding, 'safe-idle');
      }
      return;
    }
    if (live.waitingOn !== undefined) {
      updateWaiting(binding, live.waitingOn);
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

  function transitionAsyncRunTargetForTurn(
    binding: LiveBinding,
    turnId: string,
    state: ChannelAsyncRunTargetState,
    options?: {
      reason?: string;
      approvalState?: ChannelAsyncRunApprovalState;
    }
  ): void {
    const requestMessageId = binding.requestMessageIdByTurn.get(turnId);
    if (!requestMessageId) return;
    const run = store.getAsyncRunForRequestMessage(requestMessageId);
    if (!run) return;
    const changed = store.transitionAsyncRunTarget({
      runId: run.id,
      targetId: binding.profileActorId,
      state,
      ...options,
    });
    if (changed) hub.broadcastRunLifecycle(changed);
  }

  function handleApprovalStarted(
    binding: LiveBinding,
    item: AgentApprovalItemV2
  ): void {
    if (binding.announcedApprovals.has(item.requestId)) return;
    binding.announcedApprovals.add(item.requestId);
    if (binding.activeTurnId !== null) {
      transitionAsyncRunTargetForTurn(
        binding,
        binding.activeTurnId,
        'input-required',
        {
          approvalState: 'requested',
        }
      );
    }
    postSystemRow(
      binding.channelId,
      `@${binding.displayName} requests approval: ${item.description} (${item.target})`,
      {
        parentMessageId:
          binding.activeTurnId === null
            ? undefined
            : parentForTurn(binding, binding.activeTurnId),
        meta: {
          approvalRequestId: item.requestId,
          agentId: binding.profileActorId,
          runtimeId: binding.runtimeId,
        },
      }
    );
  }

  function handleApprovalResolved(
    binding: LiveBinding,
    item: AgentApprovalItemV2
  ): void {
    if (!binding.announcedApprovals.has(item.requestId)) return;
    binding.announcedApprovals.delete(item.requestId);
    const kind = item.decision?.kind ?? 'resolved';
    if (binding.activeTurnId !== null) {
      transitionAsyncRunTargetForTurn(
        binding,
        binding.activeTurnId,
        'working',
        { approvalState: 'resolved' }
      );
    }
    postSystemRow(
      binding.channelId,
      `@${binding.displayName} approval ${kind}`,
      {
        parentMessageId:
          binding.activeTurnId === null
            ? undefined
            : parentForTurn(binding, binding.activeTurnId),
      }
    );
  }

  // ── routing ─────────────────────────────────────────────────────────────────

  /**
   * Provider id of the single agent a DM channel belongs to, else null.
   *
   * A DM is not a distinct backend entity — it is a topic whose id equals the
   * deterministic formula for its own `routingDefaults.providerId` (shared
   * derivation, `shared/dm-channels.ts`). Without a topic store — or before the
   * topic row exists — the binder cannot tell a DM from a group channel, so it
   * fails closed to "not a DM" and keeps the multi-party silence rule.
   */
  function dmProviderIdFor(channelId: string): string | null {
    const topic = topicStore?.get(channelId);
    if (!topic) return null;
    return isDmChannel(topic);
  }

  /**
   * Fire-and-forget routing of one (trigger, profile) pair. The returned promise
   * settles once the turn is enqueued (or routing gave up) — callers that only
   * want the side effect ignore it with `void`; the retry lane hangs its storm
   * brake off it so the marker is held until the turn is real (#1308 review).
   */
  function routeOne(
    trigger: ChannelMessage,
    profile: AgentProfile,
    steering?: ChannelPostSteering,
    requiredRole?: 'orchestrator',
    callbackEdgeRequest?: CallbackEdgeRequest
  ): Promise<void> {
    routingInFlightByChannel.set(
      trigger.channelId,
      (routingInFlightByChannel.get(trigger.channelId) ?? 0) + 1
    );
    return (async () => {
      const releaseDeferredParent = () => {
        const parentId = callbackEdgeRequest?.continuationParentCallbackId;
        if (!parentId) return;
        try {
          const released = store.releaseDeferredCompletionCallback(parentId);
          if (released?.state === 'satisfied') {
            drainCompletionCallbacks(0, [released]);
          }
        } catch (err) {
          logger.warn('channel completion callback defer release failed:', err);
        }
      };
      try {
        const rejectAsyncTarget = (reason: string) => {
          const run = store.getAsyncRunForRequestMessage(trigger.id);
          if (!run) return;
          const changed = store.transitionAsyncRunTarget({
            runId: run.id,
            targetId: profile.id,
            state: 'rejected',
            reason,
          });
          if (changed) hub.broadcastRunLifecycle(changed);
        };
        const framework = profile.providerId;
        const target = await resolveTarget(framework);
        if (closed) return; // close() raced the availability probe
        if (!target) {
          releaseDeferredParent();
          rejectAsyncTarget('target-unavailable');
          // Not a known framework. In a multi-party channel an unroutable
          // @name stays silent (§1). In a DM there is nobody ELSE to answer the
          // HUMAN, so silence reads as the product being broken — say so.
          //
          // Gated on the trigger's server-derived sender kind, not only on
          // DM-ness: `routeOne` is shared with the agent lanes
          // (handleAssistantFinalized → routeWithBrake, and gateway agent
          // posts). `knownProviderIds` (every built-in adapter) is a superset of
          // `mentionTargets` (the configured frameworks), so a DM agent's own
          // reply text mentioning a known-but-de-configured provider would
          // otherwise stamp "nothing was routed" under the human's message —
          // while the human's message did route and was answered.
          if (
            trigger.sender.kind !== 'agent' &&
            dmProviderIdFor(trigger.channelId) !== null
          ) {
            postUnavailableRow(
              trigger.channelId,
              profile.id,
              `nothing was routed — ${profile.displayName || framework} is unavailable.`,
              parentForTrigger(trigger)
            );
          }
          return;
        }
        const availability = availabilityForProfile(profile, target);
        if (!availability.available) {
          releaseDeferredParent();
          rejectAsyncTarget('target-unavailable');
          const senderDisplayName =
            profile.displayName || target.displayName || framework;
          postUnavailableRow(
            trigger.channelId,
            profile.id,
            `@${senderDisplayName} is not available in channels yet — ${availability.reason ?? 'channel runtime unavailable.'}`,
            parentForTrigger(trigger)
          );
          return;
        }
        let binding: LiveBinding;
        try {
          binding = await ensureProfileBinding(
            trigger.channelId,
            profile,
            requiredRole,
            trigger.threadId
          );
        } catch (err) {
          if (err instanceof BinderClosedError) return; // shutdown — silent
          if (err instanceof ChannelBindingError) {
            releaseDeferredParent();
            rejectAsyncTarget(
              err.unavailable ? 'target-unavailable' : 'target-binding-failed'
            );
            if (err.unavailable) {
              postUnavailableRow(
                trigger.channelId,
                profile.id,
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
        const admitted = enqueueTurn(
          binding,
          trigger,
          steering,
          false,
          undefined,
          callbackEdgeRequest
        );
        if (!admitted && callbackEdgeRequest?.continuationParentCallbackId) {
          const targetTurnId = channelTurnId(
            trigger.id,
            binding.profileActorId
          );
          // FIFO rejection creates and terminalizes its own child edge. Only a
          // failure BEFORE durable admission needs to release the announced
          // parent intent directly.
          if (
            !store.getCompletionCallback(completionCallbackEdgeId(targetTurnId))
          ) {
            releaseDeferredParent();
          }
        }
        if (!admitted) rejectAsyncTarget('target-not-admitted');
      } catch (err) {
        if (closed || err instanceof BinderClosedError) return;
        releaseDeferredParent();
        const run = store.getAsyncRunForRequestMessage(trigger.id);
        if (run) {
          const changed = store.transitionAsyncRunTarget({
            runId: run.id,
            targetId: profile.id,
            state: 'failed',
            reason: 'target-routing-failed',
          });
          if (changed) hub.broadcastRunLifecycle(changed);
        }
        logger.warn('channel binder route failed:', err);
      }
    })().finally(() => {
      const remaining =
        (routingInFlightByChannel.get(trigger.channelId) ?? 1) - 1;
      if (remaining <= 0) routingInFlightByChannel.delete(trigger.channelId);
      else routingInFlightByChannel.set(trigger.channelId, remaining);
    });
  }

  /** Eligible profile-resolved, non-self mentions in routing order. */
  function eligibleProfiles(
    message: Pick<ChannelMessage, 'sender'>,
    mentions: ChannelMention[]
  ): AgentProfile[] {
    const seen = new Set<string>();
    const out: AgentProfile[] = [];
    for (const mention of mentions) {
      const profile = resolveProfileMention(mention);
      if (!profile) continue; // unknown @name never routes (§1)
      // Bound-runtime replies carry the exact profile Actor id. Gateway posts
      // may instead use a provider-owned agent id (for example `agent:claude`),
      // so a provider's default profile must also be treated as self.
      if (
        profile.id === message.sender.id ||
        (profile.providerId === message.sender.providerId &&
          (profile.isDefault || profile.id === message.sender.id))
      ) {
        continue;
      }
      if (seen.has(profile.id)) continue;
      seen.add(profile.id);
      out.push(profile);
    }
    return out;
  }

  function currentProfileMentions(
    message: Pick<ChannelMessage, 'body'>,
    supplied: ChannelMention[]
  ): ChannelMention[] {
    if (!deps.agentProfileStore) return supplied;
    const reparsed = parseMentions(
      message.body.text,
      deps.knownProviderIds,
      deps.agentProfileStore.list()
    );
    const reparsedByRaw = new Map(
      reparsed.map((mention) => [mention.raw.toLowerCase(), mention])
    );
    const seen = new Set<string>();
    const out: ChannelMention[] = [];
    const pinnedRaw = new Set(
      supplied
        .filter((mention) => mention.profileId)
        .map((mention) => mention.raw.toLowerCase())
    );
    const append = (mention: ChannelMention) => {
      const key = mention.profileId ?? mention.raw.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(mention);
    };
    // Persisted profile pins are authoritative through renames/collisions. Only
    // unpinned legacy tokens are refreshed from the current contact catalog.
    for (const mention of supplied) {
      append(
        mention.profileId
          ? mention
          : (reparsedByRaw.get(mention.raw.toLowerCase()) ?? mention)
      );
    }
    for (const mention of reparsed) {
      if (pinnedRaw.has(mention.raw.toLowerCase())) continue;
      append(mention);
    }
    return out;
  }

  function agentTurnBrakeKey(message: ChannelMessage): string {
    if (message.source?.runtimeId && message.source.turnId) {
      return `${message.source.runtimeId}\u0000${message.source.turnId}`;
    }
    // Gateway agent posts do not yet carry provider turn identity. Treat each
    // durable post as one turn instead of collapsing unrelated agent activity.
    return `message:${message.id}`;
  }

  /**
   * Route an AGENT-authored turn's mentions under the consecutive-agent brake
   * (Amendment 5). The brake counts a durable provider turn once, keyed by
   * (source runtime, source turn), regardless of how many assistant item rows
   * or mention targets that turn fans out to. Shared by bound-runtime replies
   * AND gateway-agent posts so neither can escape the token-spend guard between
   * human turns.
   */
  function routeWithBrake(
    message: ChannelMessage,
    profiles: AgentProfile[],
    callbackSuppressedProfiles = new Set<string>(),
    prepareContinuation?: () => string | undefined
  ): void {
    if (profiles.length === 0) return;
    const rejectPreAdmittedTargets = (reason: string) => {
      const run = store.getAsyncRunForRequestMessage(message.id);
      if (!run) return;
      for (const profile of profiles) {
        const changed = store.transitionAsyncRunTarget({
          runId: run.id,
          targetId: profile.id,
          state: 'rejected',
          reason,
        });
        if (changed) hub.broadcastRunLifecycle(changed);
      }
    };
    const sourceRuntime = message.source?.runtimeId
      ? deps.runtimes.get(message.source.runtimeId)
      : undefined;
    if (sourceRuntime?.role === 'orchestrator') {
      // The orchestrator is the channel's Relay-managed driver, not a fan-out
      // participant. It must keep coordinating even after worker traffic trips
      // the brake, and its turns must not consume the worker-turn allowance.
      // Human posts still reset the ordinary brake state below.
      const continuationParentCallbackId = prepareContinuation?.();
      for (const profile of profiles) {
        void routeOne(
          message,
          profile,
          undefined,
          undefined,
          callbackSuppressedProfiles.has(profile.id)
            ? undefined
            : requesterProfileForAgentMessage(message) !== null
              ? {
                  requesterProfileId: requesterProfileForAgentMessage(message)!,
                  ...(continuationParentCallbackId
                    ? { continuationParentCallbackId }
                    : {}),
                }
              : undefined
        );
      }
      return;
    }
    const turnKey = agentTurnBrakeKey(message);
    const scopeKey = conversationScopeKey(message.channelId, message.threadId);
    let state = consecutiveAgentTurns.get(scopeKey);
    if (!state) {
      state = { count: 0, allowedTurnKeys: new Set(), paused: false };
      consecutiveAgentTurns.set(scopeKey, state);
    }
    // Pause is a per-dispatch safety check, not a turn-admission check. A turn
    // may legitimately finalize several assistant items, but none may route
    // after another turn has paused the channel.
    if (state.paused) {
      rejectPreAdmittedTargets('mention-chain-paused');
      return;
    }
    if (!state.allowedTurnKeys.has(turnKey)) {
      if (state.count >= MAX_CONSECUTIVE_AGENT_TURNS) {
        state.paused = true;
        rejectPreAdmittedTargets('mention-chain-paused');
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
    // This happens only after the one dispatch was admitted by the brake. An
    // at-cap/paused mention therefore never announces a child intent that no
    // route can later balance.
    const continuationParentCallbackId = prepareContinuation?.();
    for (const profile of profiles) {
      const requesterProfileId = requesterProfileForAgentMessage(message);
      void routeOne(
        message,
        profile,
        undefined,
        undefined,
        callbackSuppressedProfiles.has(profile.id) || !requesterProfileId
          ? undefined
          : {
              requesterProfileId,
              ...(continuationParentCallbackId
                ? { continuationParentCallbackId }
                : {}),
            }
      );
    }
  }

  /**
   * One resolver serves both pre-persistence run admission and post-persistence
   * delivery. Explicit pinned mentions win; only an unmentioned human post can
   * select a DM default or durable sole orchestrator.
   */
  function resolvedPostTargets(
    message: Pick<ChannelMessage, 'channelId' | 'sender' | 'body'>,
    mentions: ChannelMention[]
  ): Array<{ profile: AgentProfile; requiredRole?: 'orchestrator' }> {
    const routingMentions = currentProfileMentions(message, mentions);
    const profiles = eligibleProfiles(message, routingMentions);
    if (profiles.length > 0) return profiles.map((profile) => ({ profile }));
    if (message.sender.kind !== 'human' || routingMentions.length > 0)
      return [];
    const implicit = implicitHumanRecipient(message.channelId);
    return implicit ? [implicit] : [];
  }

  function resolvePostTargetIds(input: {
    channelId: string;
    sender: ChannelSenderRef;
    text: string;
    mentions: ChannelMention[];
  }): string[] {
    return resolvedPostTargets(
      {
        channelId: input.channelId,
        sender: input.sender,
        body: { text: input.text, format: 'markdown' },
      },
      input.mentions
    ).map(({ profile }) => profile.id);
  }

  function handleMessagePosted(
    message: ChannelMessage,
    mentions: ChannelMention[],
    options?: ChannelMessagePostedOptions
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
    const targets = resolvedPostTargets(message, mentions);
    if (message.sender.kind === 'agent') {
      // Steering is deliberately dropped here, not honored-then-braked: the
      // sender kind is server-derived, so this is the ONE place that can promise
      // an agent post — including a CLI-gateway actor post — can never cancel
      // another agent's live turn. Agent traffic keeps its existing brake.
      routeWithBrake(
        message,
        targets.map(({ profile }) => profile)
      );
      return;
    }
    // A message-shaped system row is not a normal production shape, but sender
    // attribution is the loop-safety boundary. It must neither route nor reset
    // the consecutive-agent brake if one is ever presented by a caller/test.
    if (message.sender.kind !== 'human') return;
    // Mechanics are explicit (epic #1308 rule): the steering intent comes from
    // the operator's choice on the post route, never inferred from the text.
    const steering = options?.steering;
    consecutiveAgentTurns.delete(
      conversationScopeKey(message.channelId, message.threadId)
    );
    for (const { profile, requiredRole } of targets) {
      void routeOne(message, profile, steering, requiredRole);
    }
  }

  /**
   * Apply an operator's explicit steering intent to a row that ALREADY exists
   * (#1308 slice 4 review).
   *
   * The post route is idempotent on `clientMessageId`, and the composer
   * deliberately RETAINS that id after a failed send. So an operator whose
   * "queue" POST looked like it failed but actually landed, and who then presses
   * "interrupt & send" on the same draft, replays a `clientMessageId` the store
   * already knows. Returning the stored row alone would silently swallow the
   * interrupt — the UI would report an interrupt-and-send that did neither.
   *
   * This applies the steering HALF only. The message itself is already queued
   * from the first post, so re-routing it here would double-deliver; what the
   * operator is still missing is the cancellation. Interrupting is idempotent (a
   * no-op when the binding has no live turn), which is what makes replaying it
   * safe on a duplicate — with one exception the loop below handles: if the
   * queued message already DRAINED between the two posts, the live turn is the
   * one this message triggered, and cancelling it would kill the operator's own
   * reply.
   */
  function steerExisting(
    message: ChannelMessage,
    steering: ChannelPostSteering
  ): void {
    if (closed) return;
    if (steering !== 'interrupt') return;
    if (message.kind !== 'message') return; // system rows never steer (§1)
    // Server-derived sender kind, the same gate `handleMessagePosted` applies:
    // an agent post can never cancel another agent's live turn.
    if (message.sender.kind !== 'human') return;
    const mentions = currentProfileMentions(message, message.mentions ?? []);
    let profiles = eligibleProfiles(message, mentions);
    if (profiles.length === 0) {
      // Explicit intent always wins, even if its pinned profile disappeared.
      if (mentions.length > 0) return;
      const implicit = implicitHumanRecipient(message.channelId);
      if (!implicit) return;
      profiles = [implicit.profile];
    }
    for (const profile of profiles) {
      const binding = live.get(
        bindingKey(message.channelId, profile.id, message.threadId)
      );
      if (!binding) continue;
      // Never cancel the turn THIS message triggered. Between the two POSTs the
      // queued message may have drained, so the binding is now running the very
      // reply the operator is waiting for; replaying the steering there would
      // interrupt their own answer — the opposite of the intent. Skipping keeps
      // the replay useful in the case it exists for (the message is still
      // queued behind someone else's live turn) and a no-op once it is being
      // answered.
      if (
        binding.activeTurnId ===
        channelTurnId(message.id, binding.profileActorId)
      ) {
        continue;
      }
      steerInterrupt(binding, message);
    }
  }

  /**
   * Resolve the one implicit recipient for an unmentioned HUMAN post. DMs keep
   * their existing provider-default behavior. A non-DM product channel routes
   * only when its durable binding carries role=`orchestrator`; the runtime may
   * be cold and will resume through the same binding path. An ordinary
   * collaborator binding never qualifies as the default.
   */
  function implicitHumanRecipient(
    channelId: string
  ): { profile: AgentProfile; requiredRole?: 'orchestrator' } | null {
    const providerId = dmProviderIdFor(channelId);
    if (providerId !== null) {
      return { profile: defaultProfileForProvider(providerId) };
    }
    const profile = designatedOrchestratorProfile(channelId);
    return profile ? { profile, requiredRole: 'orchestrator' } : null;
  }

  function consumeAncestorExplicitReturn(
    binding: LiveBinding,
    sourceTurnId: string,
    profiles: AgentProfile[],
    explicitReturnProfiles: Set<string>
  ): void {
    // C's callback reaches B on a new B turn, while A→B is still keyed to
    // B's original delegated turn. An explicit `@A` from that continuation is
    // a return, not a new B→A delegation.
    const inherited =
      binding.continuationByTurn.get(sourceTurnId)?.parentCallbackId;
    if (!inherited) return;
    try {
      const parent = store.getCompletionCallback(inherited);
      const returnsToAncestor =
        parent !== null &&
        profiles.some((profile) => profile.id === parent.requesterProfileId);
      if (!returnsToAncestor || parent === null) return;
      const consumed = store.consumeAncestorCompletionCallbackForExplicitReturn(
        parent.id
      );
      if (consumed) {
        pendingCompletionCallbacks.delete(consumed.id);
        explicitReturnProfiles.add(consumed.requesterProfileId);
      }
    } catch (err) {
      logger.warn(
        'channel completion callback ancestor explicit-return consume failed:',
        err
      );
    }
  }

  function handleAssistantFinalized(
    binding: LiveBinding,
    message: ChannelMessage
  ): void {
    if (closed) return;
    const sourceTurnId = message.source?.turnId;
    if (sourceTurnId) binding.finalMessageByTurn.set(sourceTurnId, message);
    const mentions = parseMentions(
      message.body.text,
      deps.knownProviderIds,
      deps.agentProfileStore?.list()
    );
    const profiles = eligibleProfiles(message, mentions);
    const explicitReturnProfiles = new Set<string>();
    if (sourceTurnId && profiles.length > 0) {
      try {
        const consumed = store.consumeCompletionCallbacksForExplicitReturn({
          channelId: message.channelId,
          targetProfileId: binding.profileActorId,
          targetTurnId: sourceTurnId,
          requesterProfileIds: profiles.map((profile) => profile.id),
        });
        for (const edge of consumed) {
          pendingCompletionCallbacks.delete(edge.id);
          explicitReturnProfiles.add(edge.requesterProfileId);
        }
      } catch (err) {
        logger.warn(
          'channel completion callback explicit-return consume failed:',
          err
        );
      }
    }
    if (sourceTurnId && profiles.length > 0) {
      consumeAncestorExplicitReturn(
        binding,
        sourceTurnId,
        profiles,
        explicitReturnProfiles
      );
    }
    const delegatedProfiles = profiles.filter(
      (profile) => !explicitReturnProfiles.has(profile.id)
    );
    const prepareContinuation =
      sourceTurnId && delegatedProfiles.length > 0
        ? (): string | undefined => {
            try {
              // A continuation callback keeps its original ancestor open; a
              // normal delegated turn discovers that ancestor by target turn.
              const inherited =
                binding.continuationByTurn.get(sourceTurnId)?.parentCallbackId;
              const parent = inherited
                ? store.announceContinuationChildren(
                    inherited,
                    delegatedProfiles.length
                  )
                : store.deferCompletionCallbackForChild({
                    channelId: message.channelId,
                    targetProfileId: binding.profileActorId,
                    targetTurnId: sourceTurnId,
                    expectedChildCount: delegatedProfiles.length,
                  });
              return parent?.state === 'pending' ? parent.id : undefined;
            } catch (err) {
              logger.warn(
                'channel completion callback continuation defer failed:',
                err
              );
              return undefined;
            }
          }
        : undefined;
    routeWithBrake(
      message,
      profiles,
      explicitReturnProfiles,
      prepareContinuation
    );
  }

  async function recoverCompletionCallbacks(): Promise<void> {
    if (closed) return;
    try {
      const recovered = store.recoverCompletionCallbacks();
      drainCompletionCallbacks(0, recovered);
    } catch (err) {
      logger.warn('channel completion callback recovery failed:', err);
    }
  }

  // ── runtime death ───────────────────────────────────────────────────────────

  /**
   * The ONE teardown for a binding whose runtime is gone (#1307). Every path
   * that observes a dead runtime — the `onRuntimeEnd` callback and the liveness
   * sweep — funnels through here, so a runtime can never end without a terminal
   * `idle` reaching the socket: the header chip and the in-timeline presence row
   * both render that broadcast, and the watchdog cannot bound them (it is
   * disarmed while `waitingOn !== null` and unarmed once a turn is over).
   */
  function releaseBinding(key: string, binding: LiveBinding): void {
    if (binding.activeTurnId !== null) {
      const activeTurnId = binding.activeTurnId;
      if (!releaseUnacceptedCompletionCallbackTurn(binding, activeTurnId)) {
        terminalizeCompletionCallback(
          binding,
          activeTurnId,
          CALLBACK_UNEXPECTED_DISCONNECT
        );
      }
      binding.finalMessageByTurn.delete(activeTurnId);
      binding.continuationByTurn.delete(activeTurnId);
    }
    binding.unbind?.(); // bridge finalizes any open stream 'interrupted'
    binding.patchUnlisten?.();
    disarmWatchdog(binding);
    // No-op when `markDeadRuntimeIdle` already drained on the `disconnected`
    // patch, so a death that fires both paths posts one row per trigger.
    dropQueuedTurns(binding);
    binding.adapter = null;
    binding.unbind = null;
    binding.patchUnlisten = null;
    binding.activeTurnId = null;
    binding.parentMessageIdByTurn.clear();
    binding.requestMessageIdByTurn.clear();
    binding.exactTurnTombstones.clear();
    binding.finalMessageByTurn.clear();
    binding.continuationByTurn.clear();
    binding.completionCallbackByTurn.clear();
    binding.deferredCompletionTerminalByTurn.clear();
    binding.activeContent = null;
    binding.activeAttachments = [];
    binding.waitingOn = null;
    binding.sawStream = false;
    binding.announcedApprovals.clear();
    setStatus(binding, 'idle');
    // The binding may already have BEEN idle, so the dropped queue needs its
    // own emit — otherwise the chip keeps a count for a dead runtime.
    emitAgentStatus(binding);
    live.delete(key);
    try {
      store.upsertBinding({
        channelId: binding.channelId,
        threadId: binding.threadId,
        profileActorId: binding.profileActorId,
        agentFramework: binding.framework,
        runtimeId: null,
      });
    } catch (err) {
      logger.warn('channel binder unbind persist failed:', err);
    }
  }

  function handleRuntimeEnd(runtimeId: string): void {
    for (const [key, binding] of live) {
      if (binding.runtimeId !== runtimeId) continue;
      releaseBinding(key, binding);
    }
  }

  /**
   * Dead-runtime sweep (#1307). `onRuntimeEnd` fires from exactly one place — an
   * explicit `runtimes.destroy` — and its handlers are invoked best-effort, so a
   * runtime that goes away any other way (a release that threw halfway, a
   * manager shutdown, a teardown path added later) leaves this binding pinned at
   * whatever it was doing when it died. Liveness is therefore re-derived from
   * the runtime registry on a timer rather than trusted to an event.
   */
  function sweepDeadBindings(): void {
    if (closed) return;
    for (const [key, binding] of live) {
      if (binding.runtimeId === null) continue;
      // A (re)bind in flight owns this entry: `doEnsureBinding` keeps the old
      // runtime id on the provisional binding while it awaits a spawn, and
      // `attachRuntime` is about to overwrite it. Releasing here would delete a
      // binding that is being rebuilt.
      if (inflight.has(key)) continue;
      if (
        healthyRuntime(
          binding.runtimeId,
          binding.framework,
          binding.profileActorId,
          binding.threadId
        )
      ) {
        continue;
      }
      logger.warn('channel binder released a binding with no live runtime', {
        channelId: binding.channelId,
        profileActorId: binding.profileActorId,
        runtimeId: binding.runtimeId,
        status: binding.status,
      });
      releaseBinding(key, binding);
    }
  }

  // ── control verbs ───────────────────────────────────────────────────────────

  function controlBinding(
    channelId: string,
    agentId: string,
    threadId: string | null
  ): LiveBinding | undefined {
    return (
      live.get(bindingKey(channelId, agentId, threadId)) ??
      live.get(bindingKey(channelId, builtInAgentProfileId(agentId), threadId))
    );
  }

  async function interrupt(
    channelId: string,
    agentId: string,
    threadId: string | null = null
  ): Promise<void> {
    const binding = controlBinding(channelId, agentId, threadId);
    if (!binding || !binding.adapter) throw new ChannelAgentNotFoundError();
    if (binding.activeTurnId === null)
      throw new ChannelAgentNoActiveTurnError();
    await binding.adapter.interrupt({ turnId: binding.activeTurnId });
  }

  async function release(
    channelId: string,
    agentId: string,
    threadId: string | null = null
  ): Promise<void> {
    const key = bindingKey(channelId, agentId, threadId);
    const binding =
      live.get(key) ??
      live.get(bindingKey(channelId, builtInAgentProfileId(agentId), threadId));
    if (!binding || !binding.runtimeId) throw new ChannelAgentNotFoundError();
    if (binding.waitingOn !== null) {
      throw new ChannelAgentReleaseRefusedError(
        channelId,
        binding.profileActorId,
        binding.status,
        'CHANNEL_AGENT_WAITING_ON_OPERATOR'
      );
    }
    if (binding.queue.length > 0 || binding.steeringQueue.length > 0) {
      throw new ChannelAgentReleaseRefusedError(
        channelId,
        binding.profileActorId,
        binding.status,
        'CHANNEL_AGENT_QUEUE_NOT_EMPTY'
      );
    }
    if (
      binding.status !== 'idle' ||
      binding.activeTurnId !== null ||
      binding.steeringInFlight ||
      inflight.has(
        bindingKey(channelId, binding.profileActorId, binding.threadId)
      )
    ) {
      throw new ChannelAgentReleaseRefusedError(
        channelId,
        binding.profileActorId,
        binding.status,
        'CHANNEL_AGENT_NOT_IDLE'
      );
    }
    // destroy() captures the owned process tree before the adapter's graceful
    // provider disconnect; the runtime-end path preserves the durable provider
    // session/evidence and merely clears the live runtime attachment.
    await deps.runtimes.destroy(binding.runtimeId);
  }

  /**
   * #1308 slice 1 item 2. Retry is a re-route, never a re-post: the failed row's
   * `source.turnId` names the (trigger, profile) pair the turn was raised for,
   * so the original human message is fetched back out of the store and handed to
   * the SAME `routeOne` lane a fresh mention would take. Nothing new is written
   * to the human's lane, so the timeline cannot grow a duplicate of it.
   *
   * The retried row is superseded by a system row carrying
   * `meta.retryOfMessageId`, following `handleSendFailure`'s system-row pattern
   * rather than mutating a terminal row — the durable record of what failed
   * stays intact and the supersede marker survives a reload for free.
   *
   * The re-run reuses the same deterministic turn identity (§ Amendment 3), so
   * an adapter that derives item ids from the turn rather than per SEND would
   * collide with the retried row's source triple — `channel_messages` is unique
   * on (source_runtime_id, source_turn_id, source_item_id) and inserts are
   * `DO NOTHING` — and the retried reply would be silently dropped. Minting a
   * fresh identity would fork the turn-parent, watchdog and `retriedTurns`
   * bookkeeping that keys off it, so the invariant is pushed onto the adapters
   * instead: item ids are unique per send, asserted by the mock adapter's own
   * contract test (`test/mock-v2-adapter.test.ts`).
   */
  async function retryMessage(
    channelId: string,
    messageId: string
  ): Promise<ChannelRetryResult> {
    if (closed) throw new BinderClosedError();
    const failed = store.getMessage(messageId);
    if (!failed || failed.channelId !== channelId) {
      throw new ChannelMessageNotRetryableError(
        'message not found in this channel',
        'CHANNEL_MESSAGE_NOT_FOUND',
        true
      );
    }
    const target = channelRetryTarget(failed);
    if (!target) {
      throw new ChannelMessageNotRetryableError(
        'only a failed, interrupted, or truncated agent row raised by a routed turn can be retried',
        'MESSAGE_NOT_RETRYABLE'
      );
    }
    const trigger = store.getMessage(target.triggerMessageId);
    if (!trigger || trigger.channelId !== channelId) {
      throw new ChannelMessageNotRetryableError(
        'the message that triggered this turn is no longer in this channel',
        'RETRY_TRIGGER_MISSING'
      );
    }
    // The trigger survives a deletion as a tombstone (#1308 item 4), so the id
    // still resolves — but re-running the turn would hand a provider the very
    // text the operator erased. Refused rather than sent empty: an empty packet
    // footer would spend real tokens asking an agent to reply to nothing.
    if (isChannelMessageDeleted(trigger)) {
      throw new ChannelMessageNotRetryableError(
        'the message that triggered this turn was deleted',
        'RETRY_TRIGGER_DELETED'
      );
    }
    const profile =
      deps.agentProfileStore?.get(target.profileActorId) ??
      (failed.sender.providerId
        ? defaultProfileForProvider(failed.sender.providerId)
        : null);
    if (!profile) {
      throw new ChannelMessageNotRetryableError(
        `agent profile ${target.profileActorId} no longer exists`,
        'AGENT_PROFILE_MISSING'
      );
    }
    // Storm brake: one in-flight or queued turn for this profile is enough to
    // refuse. `activeTurnId`/`queue` are checked alongside `status` because a
    // turn is enqueued before the first status transition is broadcast.
    //
    // Taken TOGETHER with the `retryInFlight` marker, and both synchronously:
    // everything below this point awaits, and a live binding's busy state only
    // becomes observable once `routeOne` has awaited its way to `enqueueTurn`.
    // Without the marker two retries in that window — two devices, or two failed
    // rows for the same profile — would both read an idle (or, on a cold
    // binding, absent) binding and both enqueue.
    const key = bindingKey(channelId, profile.id, trigger.threadId);
    const binding = live.get(key);
    if (
      binding &&
      (binding.status !== 'idle' ||
        binding.activeTurnId !== null ||
        binding.queue.length > 0)
    ) {
      throw new ChannelAgentBusyError(channelId, profile.id, binding.status);
    }
    if (retryInFlight.has(key)) {
      // Reported as `spawning`, never as the binding's own (still idle, still
      // absent) status: a turn IS being raised for this profile right now, and
      // saying "idle" would contradict the refusal in the same sentence.
      throw new ChannelAgentBusyError(channelId, profile.id, 'spawning');
    }
    retryInFlight.add(key);
    let routed = false;
    try {
      // Availability is checked HERE as well as inside `routeOne` so an
      // unroutable retry fails as a rejected request instead of as a supersede
      // mark over a turn that never ran — the mark disables the row's own retry
      // affordance, so writing it for a no-op would strand the operator.
      const mentionTarget = await resolveTarget(profile.providerId);
      const availability = availabilityForProfile(profile, mentionTarget);
      if (!availability.available) {
        throw new ChannelMessageNotRetryableError(
          `@${profile.displayName || profile.providerId} is not available in channels — ${availability.reason ?? 'framework unavailable'}`,
          'AGENT_UNAVAILABLE'
        );
      }
      const label = await rosterDisplayName(profile);
      postSystemRow(
        channelId,
        `retrying @${label} — previous reply ${failed.status}`,
        {
          meta: { [CHANNEL_RETRY_OF_META_KEY]: failed.id, agentId: profile.id },
          parentMessageId: parentForTrigger(trigger),
        }
      );
      routed = true;
      // Held until the route settles — by then the turn is enqueued, so the
      // binding's own busy state takes over as the brake.
      void routeOne(trigger, profile).finally(() => retryInFlight.delete(key));
      return {
        messageId: failed.id,
        triggerMessageId: trigger.id,
        profileActorId: profile.id,
      };
    } finally {
      if (!routed) retryInFlight.delete(key);
    }
  }

  async function respondToApproval(
    channelId: string,
    agentId: string,
    requestId: string,
    decision: AgentApprovalDecisionV2,
    threadId: string | null = null
  ): Promise<void> {
    const binding = controlBinding(channelId, agentId, threadId);
    if (!binding || !binding.adapter) throw new ChannelAgentNotFoundError();
    await binding.adapter.respondToApproval({ requestId, decision });
  }

  async function rosterForChannel(
    channelId: string
  ): Promise<ChannelAgentRosterEntry[]> {
    const targets = await getTargets();
    const targetByProvider = new Map(
      targets.map((target) => [target.id, target])
    );
    const storedProfiles = deps.agentProfileStore?.list();
    const profiles = storedProfiles
      ? [
          ...storedProfiles,
          ...targets
            .filter(
              (target) =>
                !storedProfiles.some(
                  (profile) => profile.providerId === target.id
                )
            )
            .map((target) => defaultProfileForProvider(target.id)),
        ]
      : targets.map((target) => defaultProfileForProvider(target.id));
    return Promise.all(
      profiles.map(async (profile) => {
        const target = targetByProvider.get(profile.providerId);
        const availability = availabilityForProfile(profile, target);
        const binding = live.get(bindingKey(channelId, profile.id));
        const row = store.getBinding(channelId, profile.id);
        const runtimeId = binding?.runtimeId ?? row?.runtimeId ?? null;
        const runtime = runtimeId ? deps.runtimes.get(runtimeId) : undefined;
        const role = runtime?.role ?? row?.role ?? undefined;
        const baseCommands = relayControlCatalogForProvider(
          profile.providerId
        ).filter((command) => command.collisionKey !== 'fast');
        const liveCatalog = binding?.adapter?.getSlashCommands;
        const commands = (
          liveCatalog ? liveCatalog.call(binding.adapter) : baseCommands
        ).filter(
          (command) =>
            command.dispatch === 'relay-control' &&
            (!binding || binding.adapter?.executeControlCommand !== undefined)
        );
        return {
          id: profile.id,
          displayName: await rosterDisplayName(profile),
          providerId: profile.providerId,
          isDefault: profile.isDefault,
          isBuiltIn: profile.isBuiltIn,
          kind: 'framework',
          available: availability.available,
          reason: availability.reason,
          ...(role !== undefined ? { role } : {}),
          binding: runtimeId
            ? {
                runtimeId,
                status: binding?.status ?? 'idle',
                queuedCount: binding?.queue.length ?? 0,
                steeringCount:
                  (binding?.steeringAcceptedCount ?? 0) +
                  (binding?.steeringQueue.length ?? 0) +
                  (binding?.steeringInFlight ? 1 : 0),
                steerSupported:
                  binding !== undefined && supportsSafeBoundarySteer(binding),
              }
            : null,
          ...(commands.length > 0 ? { commands } : {}),
        };
      })
    );
  }

  async function executeCommand(
    channelId: string,
    profileActorId: string,
    command: string,
    args?: string,
    confirmed?: boolean,
    threadId: string | null = null
  ): Promise<{ config?: Record<string, unknown> }> {
    // Actor id is the sole authority boundary. Never resolve a display name here.
    const targets = await getTargets();
    const stored = deps.agentProfileStore?.list() ?? [];
    const profiles = [
      ...stored,
      ...targets
        .filter(
          (target) =>
            !stored.some((profile) => profile.providerId === target.id)
        )
        .map((target) => defaultProfileForProvider(target.id)),
    ];
    const profile = profiles.find(
      (candidate) => candidate.id === profileActorId
    );
    if (!profile) {
      throw new ChannelAgentCommandError(
        'unknown agent profile',
        'UNKNOWN_PROFILE'
      );
    }
    const target = targets.find(
      (candidate) => candidate.id === profile.providerId
    );
    if (!target?.available) {
      throw new ChannelAgentCommandError('agent is unavailable', 'UNAVAILABLE');
    }
    let binding = live.get(bindingKey(channelId, profileActorId, threadId));
    let preview =
      binding?.adapter?.getSlashCommands?.() ??
      relayControlCatalogForProvider(profile.providerId).filter(
        (entry) => entry.collisionKey !== 'fast'
      );
    const name = command.trim().toLowerCase();
    let selected = preview.find(
      (entry) => entry.name === name || (entry.aliases ?? []).includes(name)
    );
    // Static catalog entries make pre-bind previews possible. Providers that
    // require live discovery intentionally publish no static entry, so the
    // same path binds and reselects only after their catalog is authoritative.
    if (!selected && !binding) {
      binding = await ensureProfileBinding(
        channelId,
        profile,
        undefined,
        threadId
      );
      preview = binding.adapter?.getSlashCommands?.() ?? [];
      selected = preview.find(
        (entry) => entry.name === name || (entry.aliases ?? []).includes(name)
      );
    }
    if (!selected) {
      throw new ChannelAgentCommandError(
        'unknown provider command',
        'UNKNOWN_COMMAND'
      );
    }
    if (selected.dispatch !== 'relay-control') {
      throw new ChannelAgentCommandError(
        'agent-dispatch commands are not executable in channels',
        'UNSUPPORTED_DISPATCH'
      );
    }
    if (selected.destructive && confirmed !== true) {
      throw new ChannelAgentCommandError(
        'command confirmation is required',
        'CONFIRMATION_REQUIRED'
      );
    }
    binding ??= await ensureProfileBinding(
      channelId,
      profile,
      undefined,
      threadId
    );
    if (!binding.adapter?.executeControlCommand) {
      throw new ChannelAgentCommandError(
        'provider command controls are unavailable',
        'UNSUPPORTED_PROVIDER'
      );
    }
    try {
      return await binding.adapter.executeControlCommand({
        command: selected.name,
        ...(args ? { args } : {}),
        ...(confirmed !== undefined ? { confirmed } : {}),
      });
    } catch (error) {
      if (error instanceof AgentControlUnavailableError) {
        throw new ChannelAgentCommandError(
          error.message,
          'UNAVAILABLE_COMMAND'
        );
      }
      throw error;
    }
  }

  function restartScope(
    channelId: string,
    threadId: string | null = null
  ): Promise<{ restarted: number }> {
    const scopeKey = conversationScopeKey(channelId, threadId);
    const existing = restartInFlight.get(scopeKey);
    if (existing) return existing;
    const operation = restartScopeImpl(channelId, threadId);
    restartInFlight.set(scopeKey, operation);
    return operation.finally(() => {
      if (restartInFlight.get(scopeKey) === operation) {
        restartInFlight.delete(scopeKey);
      }
    });
  }

  async function restartScopeImpl(
    channelId: string,
    threadId: string | null
  ): Promise<{ restarted: number }> {
    const scoped = [...live.values()].filter(
      (binding) =>
        binding.channelId === channelId && binding.threadId === threadId
    );
    if (scoped.length === 0) return { restarted: 0 };

    // Fail before changing anything: an instruction apply is explicit, but it
    // must never discard a provider turn, queued operator intent, or approval.
    for (const binding of scoped) {
      if (binding.waitingOn !== null) {
        throw new ChannelAgentRestartRefusedError(
          channelId,
          threadId,
          binding.profileActorId,
          binding.status,
          'CHANNEL_AGENT_WAITING_ON_OPERATOR'
        );
      }
      if (binding.queue.length > 0 || binding.steeringQueue.length > 0) {
        throw new ChannelAgentRestartRefusedError(
          channelId,
          threadId,
          binding.profileActorId,
          binding.status,
          'CHANNEL_AGENT_QUEUE_NOT_EMPTY'
        );
      }
      if (
        binding.status !== 'idle' ||
        binding.activeTurnId !== null ||
        binding.steeringInFlight ||
        inflight.has(
          bindingKey(channelId, binding.profileActorId, binding.threadId)
        )
      ) {
        throw new ChannelAgentRestartRefusedError(
          channelId,
          threadId,
          binding.profileActorId,
          binding.status,
          'CHANNEL_AGENT_NOT_IDLE'
        );
      }
    }

    const storedProfiles = deps.agentProfileStore?.list() ?? [];
    const planned = scoped.map((binding) => {
      const profile =
        storedProfiles.find(
          (candidate) => candidate.id === binding.profileActorId
        ) ??
        (binding.profileActorId === builtInAgentProfileId(binding.framework)
          ? defaultProfileForProvider(binding.framework)
          : null);
      if (!profile) {
        throw new ChannelBindingError(
          `agent profile ${binding.profileActorId} no longer exists`,
          `@${binding.displayName} cannot restart because its profile was removed.`
        );
      }
      return {
        binding,
        profile,
        role:
          store.getBinding(channelId, binding.profileActorId, threadId)?.role ??
          undefined,
      };
    });

    for (const { binding, profile, role } of planned) {
      const key = bindingKey(channelId, binding.profileActorId, threadId);
      const runtimeId = binding.runtimeId;
      if (!runtimeId) continue;
      // Restart is a new provider conversation. Retaining a prior provider
      // session could silently preserve the old provider-side instructions.
      store.upsertBinding({
        channelId,
        threadId,
        profileActorId: binding.profileActorId,
        agentFramework: binding.framework,
        runtimeId,
        providerSession: {},
      });
      await deps.runtimes.destroy(runtimeId);
      // Production runtime teardown broadcasts this synchronously, but own the
      // state transition here too so a conservative runtime manager cannot make
      // a restart accidentally reuse the just-destroyed adapter.
      if (live.get(key) === binding) releaseBinding(key, binding);
      await ensureProfileBinding(
        channelId,
        profile,
        role === 'orchestrator' ? 'orchestrator' : undefined,
        threadId
      );
    }
    return { restarted: planned.length };
  }

  function isControlMessage(text: string, channelId?: string): boolean {
    // A DM has an unambiguous provider target, so a raw Relay control cannot
    // fall through to durable channel prose. Group channels deliberately keep
    // bare slash text ordinary: no exact target has been supplied there.
    const topic = channelId ? deps.topicStore?.get(channelId) : undefined;
    const dmProviderId = topic ? isDmChannel(topic) : null;
    const bareCommand = /^\s*\/([^\s]+)(?:\s|$)/.exec(text)?.[1]?.toLowerCase();
    if (
      dmProviderId &&
      bareCommand &&
      relayControlInputGuardCatalogForProvider(dmProviderId).some(
        (entry) =>
          entry.name === bareCommand ||
          (entry.aliases ?? []).includes(bareCommand)
      )
    ) {
      return true;
    }
    const profiles =
      deps.agentProfileStore?.list() ??
      deps.knownProviderIds.map((providerId) =>
        defaultProfileForProvider(providerId)
      );
    let at = 0;
    while (at < text.length) {
      at = text.indexOf('@', at);
      if (at < 0) break;
      if (at > 0 && /[A-Za-z0-9_.]/.test(text[at - 1]!)) {
        at += 1;
        continue;
      }
      // Parse each candidate suffix independently: the durable parser dedupes
      // same-profile mentions for routing, while this admission check must see
      // every occurrence (for example `@codex hello @codex/compact`).
      const mention = parseMentions(
        text.slice(at),
        deps.knownProviderIds,
        profiles
      )[0];
      if (!mention?.profileId || !mention.providerId) {
        at += 1;
        continue;
      }
      const suffix = text.slice(at + mention.raw.length);
      const command = suffix
        .match(/^\s*\/([^\s]+)(?:\s|$)/)?.[1]
        ?.toLowerCase();
      if (
        command &&
        relayControlInputGuardCatalogForProvider(mention.providerId).some(
          (entry) =>
            entry.name === command || (entry.aliases ?? []).includes(command)
        )
      )
        return true;
      at += Math.max(1, mention.raw.length);
    }
    return false;
  }

  function archiveActivityForChannel(
    channelId: string
  ): ChannelArchiveActivitySnapshot {
    const reasons = new Set<ChannelArchiveActivityReason>();
    const prefix = bindingKeyPrefix(channelId);
    for (const [key, binding] of live) {
      if (!key.startsWith(prefix)) continue;
      if (binding.status !== 'idle') reasons.add('binding-status');
      if (binding.activeTurnId !== null) reasons.add('active-turn');
      if (binding.queue.length > 0) reasons.add('queued-turn');
      if (
        binding.steeringQueue.length > 0 ||
        binding.steeringInFlight ||
        binding.steeringAcceptedCount > 0
      ) {
        reasons.add('steering');
      }
    }
    if (Array.from(inflight.keys()).some((key) => key.startsWith(prefix))) {
      reasons.add('binding-in-flight');
    }
    if (orchestratorInflight.has(channelId)) {
      reasons.add('orchestrator-in-flight');
    }
    if ((routingInFlightByChannel.get(channelId) ?? 0) > 0) {
      reasons.add('routing-in-flight');
    }
    if (Array.from(retryInFlight).some((key) => key.startsWith(prefix))) {
      reasons.add('retry-in-flight');
    }
    if (
      Array.from(pendingCompletionCallbacks.values()).some(
        (pendingChannelId) => pendingChannelId === channelId
      )
    ) {
      reasons.add('completion-callback');
    }
    for (const [callbackId, retry] of terminalizationRetryByCallbackId) {
      if (
        retry.exhausted &&
        pendingCompletionCallbacks.get(callbackId) === channelId
      ) {
        reasons.add('completion-callback-terminalization-failed');
        break;
      }
    }
    return { active: reasons.size > 0, reasons: Array.from(reasons) };
  }

  return {
    handleMessagePosted,
    ensureBinding,
    ensureOrchestrator,
    interrupt,
    release,
    steerExisting,
    retryMessage,
    respondToApproval,
    rosterForChannel,
    archiveActivityForChannel,
    executeCommand,
    restartScope,
    isControlMessage,
    recoverCompletionCallbacks,
    resolvePostTargetIds,
    setStatusBroadcaster(broadcaster) {
      statusBroadcaster = broadcaster;
    },
    close() {
      closed = true;
      clearInterval(presenceSweep);
      unsubRuntimeEnd();
      for (const binding of live.values()) {
        disarmWatchdog(binding);
        binding.unbind?.();
        binding.patchUnlisten?.();
        binding.parentMessageIdByTurn.clear();
        binding.requestMessageIdByTurn.clear();
        binding.exactTurnTombstones.clear();
        binding.finalMessageByTurn.clear();
        binding.continuationByTurn.clear();
        binding.completionCallbackByTurn.clear();
        binding.deferredCompletionTerminalByTurn.clear();
        // Terminal presence on shutdown (#1307). The socket carries transitions
        // only, so a binding torn down mid-turn would leave every attached
        // client pinned at thinking/streaming/waiting until something else made
        // it refetch a roster. Broadcast is best-effort: the transport may
        // already be closing, and that must not abort the rest of shutdown.
        binding.queue = [];
        binding.steeringQueue = [];
        binding.steeringInFlight = false;
        binding.steeringAcceptedCount = 0;
        binding.activeTurnId = null;
        binding.waitingOn = null;
        binding.status = 'idle';
        try {
          emitAgentStatus(binding);
        } catch (err) {
          logger.warn('channel binder shutdown status broadcast failed:', err);
        }
      }
      live.clear();
      inflight.clear();
      restartInFlight.clear();
      orchestratorInflight.clear();
      retryInFlight.clear();
      routingInFlightByChannel.clear();
      pendingCompletionCallbacks.clear();
      terminalizationRetryByCallbackId.clear();
      consecutiveAgentTurns.clear();
      unavailableRowAt.clear();
      invalidateTargets();
    },
  };
}

function isMissingLaunchCommandError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const candidate = err as {
    code?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  if (candidate.code === 'ENOENT') return true;
  if (
    typeof candidate.message === 'string' &&
    /(?:^|\s)ENOENT(?:\s|$|:)/.test(candidate.message)
  ) {
    return true;
  }
  return candidate.cause !== undefined && candidate.cause !== err
    ? isMissingLaunchCommandError(candidate.cause)
    : false;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Keep referenced binding shape exported for callers/tests without widening deps.
export type { ChannelBinding };
