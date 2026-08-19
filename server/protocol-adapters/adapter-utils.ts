/**
 * Shared choreography for protocol adapters.
 *
 * Classification rule for anything you change in an adapter:
 * - QUIRK (event vocabulary, protocol handshake, resume-id name, permission
 *   flags) stays adapter-local and is never copied to a sibling adapter.
 * - CHOREOGRAPHY (the same dance in every adapter) lives here and is never
 *   hand-duplicated into a third adapter.
 *
 * This module is the seed of that layer. Broad extraction is sequenced behind
 * the adapter conformance suite (`test/server/protocol-adapters/conformance/`),
 * which is now the floor a shared rewrite is accountable to; add here only what
 * is already identical, or what the suite proves must be identical.
 */

import type { AdapterConfig } from '../protocol-adapter-v2.js';
import type {
  AgentApprovalItemV2,
  AgentCapabilitySetV2,
  AgentPatchV2,
  AgentSessionLiveStateV2,
  AgentSessionUpdatedPatchV2,
  AgentSlashCommandV2,
  AgentUsageV2,
} from '../../shared/agent-chat-protocol-v2.js';
import { cleanEnv } from '../utils.js';
import { createLogger } from '../logger.js';
import { nowIso } from './wire-values.js';

const logger = createLogger('adapter-utils');

export interface ReconnectWithStoredConfigOptions {
  /** Config captured by the last successful connect; null before one. */
  config: AdapterConfig | null | undefined;
  /** Tear down the live transport (adapters vary in how much they reset). */
  disconnect: () => void | Promise<void>;
  /** Re-establish the transport with the resolved config. */
  connect: (config: AdapterConfig) => void | Promise<void>;
  /**
   * Quirk hook for adapters that resume by folding a provider session id into
   * the config (pi-agent, prime-agent). Runs before `disconnect` so it reads
   * pre-teardown adapter state, matching the hand-written order it replaces.
   */
  transformConfig?: (config: AdapterConfig) => AdapterConfig;
  /** Per-adapter wording; adapters disagree and the text is observable. */
  notConnectedMessage?: string;
}

/**
 * Reconnect = re-run connect with the stored config after a full teardown.
 * Identical in every real adapter apart from the config transform and the
 * not-connected message, both parameterized here.
 */
export async function reconnectWithStoredConfig(
  options: ReconnectWithStoredConfigOptions
): Promise<void> {
  const { config } = options;
  if (!config) {
    throw new Error(
      options.notConnectedMessage ?? 'Cannot reconnect before connect'
    );
  }
  const nextConfig = options.transformConfig
    ? options.transformConfig(config)
    : config;
  await options.disconnect();
  await options.connect(nextConfig);
}

// ── Child process environment ────────────────────────────────────────────────

/**
 * Keys that must never reach ANY agent child process, whatever the provider.
 *
 * An agent harness reads these to decide it is running nested inside another
 * agent and changes its behavior accordingly. Relay spawns every harness as a
 * peer, not as a nested child, so the whole set is stripped for every provider
 * — that is a property of Relay's spawn model, not of any one harness, which is
 * why it lives here rather than in a provider's denylist.
 *
 * Before this constant existed the set was per-adapter folklore:
 * `CLAUDE_CODE_ENTRYPOINT` was stripped by claude-adapter ALONE, so codex,
 * pi-agent, prime-agent, and opencode all inherited a stale value from whatever
 * launched the hub. Owning the whole set in one place is what closes that.
 */
export const AGENT_NESTING_STRIP_KEYS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
] as const;

export interface BuildChildEnvOptions {
  /** `config.processEnv` — the trusted per-profile overlay, if any. */
  processEnv?: Record<string, string> | undefined;
  /**
   * Provider-specific keys on top of the nesting set — opencode's server
   * credentials, for instance. Source these from `provider-env.ts` so the
   * spawn-time strip and the descriptor's `launch.processEnvDenylist` cannot
   * drift apart.
   */
  denylist?: readonly string[];
  /** Seam for testing the win32 branch off Windows. */
  platform?: NodeJS.Platform;
}

/**
 * CHOREOGRAPHY: build the environment for an agent child process.
 *
 * The dance was written five times (claude `buildEnv`, codex `createClient`,
 * pi/prime/opencode `connect`) and drifted in two ways that mattered: codex
 * applied `cleanEnv()` only when a profile overlay existed — with no overlay
 * its client fell through to RAW `process.env`, keeping both nesting markers —
 * and only claude stripped `CLAUDE_CODE_ENTRYPOINT` at all. Stated once:
 *
 *   1. start from `cleanEnv()` (the hub's own env, minus `CLAUDECODE`),
 *   2. lay the trusted profile overlay on top,
 *   3. strip the nesting set and the provider denylist AFTER the overlay, so a
 *      profile cannot reintroduce a key the provider forbids.
 *
 * Step 3 must follow step 2; that ordering is the entire reason the deletes
 * exist rather than a filtered spread.
 *
 * On win32 the strip is case-insensitive, matching Windows' own environment
 * semantics and `sanitizeChannelAdapterProcessEnv` in `index.ts`. The old
 * hand-written deletes were case-sensitive everywhere, so a Windows host whose
 * env said `ClaudeCode` leaked it; elsewhere the two paths are identical.
 */
export function buildChildEnv(
  options: BuildChildEnvOptions = {}
): Record<string, string> {
  const env: Record<string, string> = {
    ...cleanEnv(),
    ...(options.processEnv ?? {}),
  };
  const denied = [...AGENT_NESTING_STRIP_KEYS, ...(options.denylist ?? [])];
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    const folded = new Set(denied.map((key) => key.toUpperCase()));
    for (const key of Object.keys(env)) {
      if (folded.has(key.toUpperCase())) delete env[key];
    }
  } else {
    for (const key of denied) delete env[key];
  }
  return env;
}

// ── Patch emission conventions ───────────────────────────────────────────────

/**
 * The two things every patch needs: who it is about, and where it goes.
 *
 * Free functions over this tiny sink, NOT a base class. A shared base class
 * would pull turn state, guards, and lifecycle into one inheritance chain and
 * make every adapter's quirks someone else's problem; a sink lets an adapter
 * adopt one convention without adopting a framework, and keeps its own guards
 * (`if (this.activeTurnId === null) return`) at its own call sites where they
 * are readable.
 */
export interface AdapterPatchSink {
  /** Read per patch: an adapter's session id changes when its config does. */
  readonly sessionId: string;
  emitPatch(patch: AgentPatchV2): void;
}

/**
 * Build a sink once, in a field initializer, from the adapter's own accessors.
 * `sessionId` stays a live read rather than a snapshot.
 */
export function createPatchSink(
  sessionId: () => string,
  emitPatch: (patch: AgentPatchV2) => void
): AdapterPatchSink {
  return {
    get sessionId() {
      return sessionId();
    },
    emitPatch,
  };
}

/** CHOREOGRAPHY: publish a live-state delta. Verbatim in four adapters. */
export function emitLiveStatePatch(
  sink: AdapterPatchSink,
  live: Partial<AgentSessionLiveStateV2>
): void {
  sink.emitPatch({
    type: 'agent-live-state-updated-v2',
    sessionId: sink.sessionId,
    timestamp: nowIso(),
    live,
  });
}

/**
 * CHOREOGRAPHY: publish a session-level update.
 *
 * Every field is omitted rather than sent as `undefined` when the caller did
 * not supply it — the patch reducer distinguishes "not in this patch" from
 * "explicitly cleared", so the spreads are load-bearing, not style.
 */
export function emitSessionUpdatePatch(
  sink: AdapterPatchSink,
  update: {
    providerSession?: Record<string, string>;
    capabilities?: AgentCapabilitySetV2;
    config?: AgentSessionUpdatedPatchV2['config'];
    slashCommands?: AgentSlashCommandV2[];
  }
): void {
  sink.emitPatch({
    type: 'agent-session-updated-v2',
    sessionId: sink.sessionId,
    timestamp: nowIso(),
    ...(update.providerSession !== undefined
      ? { providerSession: update.providerSession }
      : {}),
    ...(update.capabilities !== undefined
      ? { capabilities: update.capabilities }
      : {}),
    ...(update.config !== undefined ? { config: update.config } : {}),
    ...(update.slashCommands !== undefined
      ? { slashCommands: update.slashCommands }
      : {}),
  });
}

/**
 * How much of a provider-extension item a client should surface. `normal` is
 * the default and carries no metadata; anything else is tagged so a UI can
 * hide it behind a debug affordance. claude is the only provider that uses
 * `trace` today, and the union is shared so a second one does not have to
 * re-derive the vocabulary.
 */
export type ProviderExtensionVisibility = 'normal' | 'debug' | 'trace';

/**
 * CHOREOGRAPHY: publish a provider-native event as a completed extension item.
 *
 * The item id format `ext-<namespace>-<turnId>-<seq>` is a durable transcript
 * identity, so it is written once here rather than re-spelled per adapter. The
 * sequence counter stays adapter-owned: it is per-turn state, not choreography.
 *
 * The caller passes `turnId` explicitly. Adapters disagree about where it comes
 * from (claude receives it as an argument; codex/pi/prime read their active
 * turn and return early when there is none), and that guard belongs with the
 * adapter that owns the state, not buried in a shared helper.
 *
 * One `nowIso()` serves `timestamp`, `startedAt`, and `completedAt`. claude and
 * codex called it three times, which could stamp an item as having started
 * after the patch that announced it; pi/prime already stamped once. These
 * fields are wall-clock values the conformance suite treats as volatile.
 */
export function emitProviderExtensionPatch(
  sink: AdapterPatchSink,
  options: {
    turnId: string;
    namespace: string;
    seq: number;
    payload: Record<string, unknown>;
    visibility?: ProviderExtensionVisibility;
  }
): void {
  const { turnId, namespace, seq, payload, visibility = 'normal' } = options;
  const timestamp = nowIso();
  sink.emitPatch({
    type: 'agent-item-started-v2',
    sessionId: sink.sessionId,
    timestamp,
    turnId,
    item: {
      type: 'providerExtension',
      id: `ext-${namespace}-${turnId}-${seq}`,
      namespace,
      payload,
      ...(visibility === 'normal'
        ? {}
        : { metadata: { eventVisibility: visibility } }),
      status: 'completed',
      startedAt: timestamp,
      completedAt: timestamp,
    },
  });
}

/**
 * CHOREOGRAPHY: publish a session-level error. `turnId` is omitted entirely
 * when there is no active turn, rather than sent as `undefined`.
 */
export function emitErrorPatch(
  sink: AdapterPatchSink,
  message: string,
  turnId?: string | null
): void {
  sink.emitPatch({
    type: 'agent-error-v2',
    sessionId: sink.sessionId,
    timestamp: nowIso(),
    message,
    ...(turnId ? { turnId } : {}),
  });
}

// ── Turn lifecycle ───────────────────────────────────────────────────────────

/**
 * CHOREOGRAPHY: open a Relay turn. Byte-identical in claude, codex, pi, and
 * prime-agent — same field order, same `user-<turnId>` input-message identity,
 * same empty `items` array, same single timestamp serving both the patch and
 * the turn record.
 *
 * WHY THIS IS TWO SMALL FUNCTIONS AND NOT A `beginTurn`/`completeTurn` TEMPLATE
 * ---------------------------------------------------------------------------
 * The obvious next move is a lifecycle template that owns turn-started + the
 * user item + live state + reset, with hooks for the differences. It was tried
 * and rejected: the differences ARE the content.
 *
 *   - The user-message item disagrees in three independent ways. Key order:
 *     claude/codex write `id, type, text, …`, pi/prime write `type, id, text,
 *     …`. Attachment presence: claude omits the key when the list is empty,
 *     pi/prime emit `attachments: []`, codex never emits attachments at all.
 *     Attachment shape: claude drops an absent `mimeType`, pi/prime keep the
 *     key with `undefined`. A hook that reproduces all three reproduces the
 *     whole item, so nothing is actually shared.
 *   - Live state disagrees in arity: claude/codex publish six fields
 *     (`waitingOn`/`activeRequestIds`/`error` included), pi/prime publish
 *     three. That difference is load-bearing and stays.
 *   - Per-turn reset is a different set of buffers in each adapter.
 *
 * A template hooking all of that is lowest-common-denominator flattening with
 * an indirection tax — the thing `AGENTS.md` forbids — and it would have to
 * change bytes in three of four adapters to exist at all. So the two patches
 * that really are identical are shared, and the rest stays where it is
 * readable. Converging the user-item spellings is a separate, deliberate
 * decision with its own evidence, not a side effect of extraction.
 */
export function emitTurnStartedPatch(
  sink: AdapterPatchSink,
  turn: { turnId: string; startedAt: string }
): void {
  sink.emitPatch({
    type: 'agent-turn-started-v2',
    sessionId: sink.sessionId,
    timestamp: turn.startedAt,
    turn: {
      id: turn.turnId,
      status: 'running',
      inputMessageId: `user-${turn.turnId}`,
      items: [],
      startedAt: turn.startedAt,
    },
  });
}

/**
 * CHOREOGRAPHY: close a Relay turn. The four adapters agree on field order and
 * on omitting `durationMs`/`usage`/`error` rather than sending `undefined`;
 * they disagree only in what they compute for those three, which is why they
 * arrive as already-decided arguments.
 *
 * `completedAt` also stamps `timestamp`. claude and codex already did that;
 * pi and prime-agent called `nowIso()` twice, so a turn could be recorded as
 * completing a millisecond before the patch that announced it. Collapsing to
 * one stamp follows the precedent set for `emitProviderExtensionPatch`, and
 * both fields are wall-clock values the conformance suite treats as volatile.
 *
 * Callers that must omit an empty-string error (pi/prime tested truthiness,
 * claude/codex tested `!== undefined`) pass `error: error || undefined` and
 * keep their exact behavior.
 */
export function emitTurnCompletedPatch(
  sink: AdapterPatchSink,
  turn: {
    turnId: string;
    status: 'completed' | 'interrupted' | 'failed';
    completedAt: string;
    durationMs?: number | undefined;
    usage?: AgentUsageV2 | undefined;
    error?: string | undefined;
  }
): void {
  sink.emitPatch({
    type: 'agent-turn-completed-v2',
    sessionId: sink.sessionId,
    timestamp: turn.completedAt,
    turnId: turn.turnId,
    status: turn.status,
    completedAt: turn.completedAt,
    ...(turn.durationMs !== undefined ? { durationMs: turn.durationMs } : {}),
    ...(turn.usage !== undefined ? { usage: turn.usage } : {}),
    ...(turn.error !== undefined ? { error: turn.error } : {}),
  });
}

// ── Server-sent events ───────────────────────────────────────────────────────

/** One dispatched SSE record: the `event:` name, if any, and its joined data. */
export interface SseRecord {
  /** `undefined` when the stream sent no `event:` field for this record. */
  event?: string;
  /** `data:` payloads for this record, joined with `\n` in arrival order. */
  data: string;
}

/**
 * CHOREOGRAPHY: read an SSE body into records.
 *
 * Three adapters framed SSE by hand — hermes (`event:` + `data:`), opencode and
 * opencode-attached (`data:` only) — and the third copy had drifted: it
 * declared its `eventData` accumulator INSIDE the read loop, so a record whose
 * `data:` line and terminating blank line arrived in different network chunks
 * was silently dropped. Same failure class as #1412. Hoisting the accumulator
 * out of the loop, which is what the other two already did, is what fixes it.
 *
 * SSE framing is provider-agnostic sequencing, so it lives here. What a record
 * MEANS is not: JSON parsing, envelope normalization, error wording, and event
 * dispatch all stay in the adapter, which is why this reports raw `data` text
 * rather than a parsed object.
 *
 * Resolves when the stream ends. A partial record left unterminated at end of
 * stream is discarded, matching all three hand-written loops.
 */
export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onRecord: (record: SseRecord) => void
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  // Declared OUTSIDE the read loop on purpose: a record can straddle chunks.
  let eventName: string | undefined;
  let eventData = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    // `{ stream: true }` holds a multi-byte character split across chunks.
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    // The last element is a partial line unless the chunk ended on a newline;
    // either way it goes back into the buffer.
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        const dataLine = line.slice(5).trim();
        eventData = eventData ? `${eventData}\n${dataLine}` : dataLine;
      } else if (line.trim() === '' && eventData) {
        onRecord(eventName ? { event: eventName, data: eventData } : { data: eventData });
        eventName = undefined;
        eventData = '';
      }
    }
  }
}

// ── Turn queue ───────────────────────────────────────────────────────────────

export interface TurnQueueOptions<T> {
  /**
   * Whether a turn may start right now. The adapter owns this: it is where
   * "connected", "no active turn", and any provider-specific interlock (a
   * claude runtime-env refresh, a pi drain already in flight) are read.
   */
  canDrain(): boolean;
  /**
   * Start one turn. Sync (claude, pi, prime-agent) or async (codex) — either
   * way the entry settles with the START ATTEMPT, not with the turn's outcome.
   */
  startTurn(input: T): void | Promise<void>;
  /**
   * The queue changed depth. The adapter emits its own live-state payload,
   * because the surrounding fields (`status`, `activeTurnId`) differ per
   * provider and are not the queue's business.
   *
   * `reason` is not decoration: the two events carry genuinely different
   * payloads. An `enqueued` change rides along with `status`/`activeTurnId`
   * (the session is working, on this turn); a `rejected` change publishes the
   * depth alone, because the queue emptying says nothing about what the
   * session is doing next.
   */
  onLengthChange(length: number, reason: 'enqueued' | 'rejected'): void;
  /**
   * Where to go after an entry's start is rejected. Defaults to this queue's
   * own `drain`. claude overrides it with the adapter's `drainQueue`, whose
   * runtime-env-refresh branch is an ACTION, not just a gate — re-entering the
   * bare queue would skip applying a refresh that is due.
   */
  continueDrain?: () => void;
}

export interface TurnQueue<T> {
  /** Queue an input; resolves when its turn starts, rejects if it cannot. */
  enqueue(input: T): Promise<void>;
  /**
   * Put work at the FRONT of the queue with nobody waiting on it.
   *
   * For resuming work the adapter itself interrupted and intends to replay —
   * claude ends a turn deliberately at a credential-refresh boundary and
   * re-queues its input under a fresh turn id. There is no caller to settle:
   * the original `sendMessage` promise resolved when the first attempt
   * started. Deliberately silent on depth, matching the hand-written
   * `unshift`, since this is the same work continuing rather than a new
   * message arriving.
   */
  requeueFront(input: T): void;
  /** Start the next turn if `canDrain()` allows it. */
  drain(): void;
  /** Fail every waiting entry — teardown, transport loss, refresh failure. */
  rejectAll(err: unknown): void;
  readonly length: number;
}

/**
 * CHOREOGRAPHY: the send queue every multi-turn adapter keeps.
 *
 * ONE SETTLEMENT SEMANTIC: the promise `enqueue` returns settles with the
 * START of that entry's turn — it resolves once `startTurn` has been invoked
 * and its own promise (if any) resolved, and rejects when the turn cannot be
 * started at all. A rejected entry does NOT wedge the queue: the next entry is
 * drained immediately, so one poisoned message cannot strand the rest.
 *
 * Four adapters had written this, in two incompatible flavors. claude and
 * codex already settled on start. pi and prime-agent resolved the caller the
 * instant the message was pushed, which reads as a convenience and is really a
 * silent drop: `sendMessage` reported success, then `handleTransportClose`
 * emptied `queued` with `length = 0`, and the message disappeared with the
 * caller's promise already resolved. The binder treats `sendMessage`
 * resolution as its delivery boundary and advances its cursor there, so those
 * messages were marked delivered and never sent. Settle-on-start is therefore
 * the semantic that survives: it is the only one that can express failure.
 *
 * What the queue does NOT own: the decision to enqueue rather than start (an
 * adapter's own gate), the live-state payload shape, and per-turn attribution
 * of a start that succeeded and then failed on the wire — that stays a turn
 * patch, exactly as before.
 */
export function createTurnQueue<T>(options: TurnQueueOptions<T>): TurnQueue<T> {
  interface Entry {
    input: T;
    resolve: () => void;
    reject: (err: unknown) => void;
  }
  const entries: Entry[] = [];

  const queue: TurnQueue<T> = {
    get length() {
      return entries.length;
    },

    enqueue(input: T): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        entries.push({ input, resolve, reject });
        options.onLengthChange(entries.length, 'enqueued');
      });
    },

    requeueFront(input: T): void {
      entries.unshift({ input, resolve: () => {}, reject: () => {} });
    },

    drain(): void {
      if (!options.canDrain()) return;
      const entry = entries.shift();
      if (!entry) return;
      const onRejected = (err: unknown): void => {
        entry.reject(err);
        (options.continueDrain ?? queue.drain)();
      };
      let started: void | Promise<void>;
      try {
        started = options.startTurn(entry.input);
      } catch (err) {
        onRejected(err);
        return;
      }
      // A sync `startTurn` that returned settles the entry now, preserving the
      // synchronous resolve claude relied on; an async one settles when the
      // provider has accepted the start.
      if (started === undefined) entry.resolve();
      else void started.then(() => entry.resolve(), onRejected);
    },

    rejectAll(err: unknown): void {
      const abandoned = entries.splice(0);
      for (const entry of abandoned) entry.reject(err);
      // Only announce a depth change when there was one to announce.
      if (abandoned.length > 0) options.onLengthChange(0, 'rejected');
    },
  };

  return queue;
}


// ── Spawned-process registry ─────────────────────────────────────────────────

/** Default cadence of the shared GC sweep. */
const DEFAULT_GC_INTERVAL_MS = 30_000;

/**
 * What the registry needs from an adapter that owns a child process. Nothing
 * about the provider, only about the process: what to call it, how to let it
 * reconsider its own deadlines, and how to kill it.
 */
export interface AdapterProcessRegistryEntry {
  readonly registrySessionId: string;
  /** Periodic tick. The entry decides what "too old" means for itself. */
  gcSweep(now: number): void;
  forceStop(): Promise<void>;
}

/**
 * CHOREOGRAPHY: one timer for every adapter-owned child process.
 *
 * An adapter owns its child 1:1; this only drives the periodic sweep (idle
 * eviction, stuck-turn kill) and the relay-shutdown kill-all. The interval is
 * unref'd, starts on the first insert, and stops when the last entry leaves,
 * so an idle hub holds nothing open.
 *
 * It lives here rather than inside one adapter because there is nothing
 * provider-specific in it — every fact it uses comes through the entry
 * interface. claude is its only member today, and the deliberate consequence
 * of this placement is that the next spawned adapter needing a sweep joins the
 * existing timer instead of hand-rolling a second one, which is how this
 * directory acquired five env builders and four line framers.
 */
export class AdapterProcessRegistry {
  private readonly entries = new Map<string, AdapterProcessRegistryEntry>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly gcIntervalMs: number = DEFAULT_GC_INTERVAL_MS) {}

  register(entry: AdapterProcessRegistryEntry): void {
    this.entries.set(entry.registrySessionId, entry);
    this.ensureTimer();
  }

  unregister(sessionId: string): void {
    this.entries.delete(sessionId);
    if (this.entries.size === 0) this.stopTimer();
  }

  size(): number {
    return this.entries.size;
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), this.gcIntervalMs);
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private sweep(): void {
    const now = Date.now();
    // Snapshot: an entry may unregister itself from inside its own sweep.
    for (const entry of [...this.entries.values()]) {
      try {
        entry.gcSweep(now);
      } catch (err) {
        logger.warn('adapter registry gc sweep failed:', err);
      }
    }
  }

  /** Relay shutdown: tear every child down via its own ladder. */
  async killAll(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    this.stopTimer();
    await Promise.all(entries.map((e) => e.forceStop().catch(() => undefined)));
  }
}

/** Process registry every spawned adapter shares. */
export const adapterProcessRegistry = new AdapterProcessRegistry();

// ── Turn guardrails ──────────────────────────────────────────────────────────

export interface TurnGuardrailLimits {
  /** A turn running longer than this, approval time excluded, is stuck. */
  turnTimeoutMs: () => number;
  /** Silence longer than this evicts an idle-but-warm child. */
  idleTtlMs: () => number;
  /** Window the crash-loop breaker counts respawns within. */
  crashWindowMs: number;
  /** Respawns inside that window before the breaker opens. */
  maxRespawns: number;
}

/**
 * CHOREOGRAPHY: the clocks behind a spawned adapter's self-defense.
 *
 * Three deadlines, each easy to get subtly wrong, and none of them provider
 * specific:
 *
 *  - **turn timeout** with a carve-out for human deliberation. Time spent
 *    waiting on an approval must NOT count against a turn's budget, or a
 *    reviewer who steps away gets their agent killed underneath them. The
 *    carve-out is implemented by rolling the turn's start stamp FORWARD by the
 *    wait once it ends, so the budget measures work, not wall clock.
 *  - **idle eviction**, measured from the last sign of life rather than from
 *    the last turn, so a warm child is only reaped when genuinely unused.
 *  - **crash-loop breaker**, a sliding window that must be pruned before it is
 *    read or old crashes wedge a session that has since recovered.
 *
 * This owns time and policy only. Killing children, emitting patches, and
 * failing turns stay with the adapter that has the client and the patch sink —
 * so the guardrails can be unit-tested against a fake clock without standing
 * up a subprocess, and the sweep still reads as the sequence of actions it is.
 *
 * Enabled for claude today, with claude's exact constants. Turning it on for
 * another provider is a behavior change (eviction and resume must be proven
 * for that harness), not a free consequence of this type existing.
 */
export class TurnGuardrails {
  private lastActivityAt = Date.now();
  private turnStartedAtMs: number | null = null;
  private approvalWaitStartedMs: number | null = null;
  private readonly crashTimestamps: number[] = [];

  constructor(private readonly limits: TurnGuardrailLimits) {}

  /** Any sign of life: a send, a steer, an inbound provider line. */
  noteActivity(now: number = Date.now()): void {
    this.lastActivityAt = now;
  }

  noteTurnStart(now: number = Date.now()): void {
    this.turnStartedAtMs = now;
    this.lastActivityAt = now;
  }

  noteTurnEnd(): void {
    this.turnStartedAtMs = null;
    this.approvalWaitStartedMs = null;
  }

  /**
   * Enter the waiting-on-a-human sub-state. Idempotent: only the FIRST
   * outstanding approval starts the clock, so overlapping approvals measure
   * one continuous wait rather than restarting it.
   */
  enterApprovalWait(now: number = Date.now()): void {
    if (this.approvalWaitStartedMs !== null) return;
    this.approvalWaitStartedMs = now;
  }

  /**
   * Leave it, once `outstandingApprovals` has fallen to zero, and pay the turn
   * back the time it spent waiting. A no-op while approvals remain.
   */
  settleApprovalWait(
    outstandingApprovals: number,
    now: number = Date.now()
  ): void {
    if (this.approvalWaitStartedMs === null) return;
    if (outstandingApprovals > 0) return;
    if (this.turnStartedAtMs !== null) {
      this.turnStartedAtMs += now - this.approvalWaitStartedMs;
    }
    this.approvalWaitStartedMs = null;
  }

  /**
   * Has the active turn burned its budget? Callers must separately confirm a
   * turn is active and that no approval is outstanding — a turn parked on an
   * approval is not stuck, and its own stall timer owns that deadline.
   */
  isTurnOverdue(now: number): boolean {
    if (this.turnStartedAtMs === null) return false;
    return now - this.turnStartedAtMs > this.limits.turnTimeoutMs();
  }

  /** Has the adapter been silent long enough to evict a warm child? */
  isIdle(now: number): boolean {
    return now - this.lastActivityAt > this.limits.idleTtlMs();
  }

  /**
   * Record an UNEXPECTED child failure. Deliberate kills must never land here
   * or the breaker opens on healthy sessions.
   */
  recordCrash(now: number = Date.now()): void {
    this.pruneCrashWindow(now);
    this.crashTimestamps.push(now);
  }

  /** Have too many crashes landed inside the window to justify a respawn? */
  isCrashLooping(now: number = Date.now()): boolean {
    this.pruneCrashWindow(now);
    return this.crashTimestamps.length >= this.limits.maxRespawns;
  }

  /** Fresh session: drop every deadline and the crash history with them. */
  reset(now: number = Date.now()): void {
    this.lastActivityAt = now;
    this.turnStartedAtMs = null;
    this.approvalWaitStartedMs = null;
    this.crashTimestamps.length = 0;
  }

  private pruneCrashWindow(now: number): void {
    const windowStart = now - this.limits.crashWindowMs;
    while (
      this.crashTimestamps.length > 0 &&
      this.crashTimestamps[0]! < windowStart
    ) {
      this.crashTimestamps.shift();
    }
  }
}

// ── Abandoned approvals (#1407) ──────────────────────────────────────────────

/**
 * Reason a stranded approval card carries out when the session goes away
 * underneath it. Exported and constant on purpose: the string reaches a durable
 * transcript, so two identical teardowns must read identically rather than
 * drifting per adapter.
 */
export const ABANDONED_APPROVAL_REASON =
  'Approval cancelled: the agent session disconnected before it was answered.';

/** Same shape, for the turn that dies with an approval still on screen. */
export const TURN_ENDED_APPROVAL_REASON =
  'Approval cancelled: the turn ended before it was answered.';

/**
 * The approval card exactly as its adapter last published it, minus everything
 * that describes how it ENDED. Those fields are the shared choreography's to
 * write; the rest — kind, description, target, provider details, supported
 * scopes — is harness vocabulary the helper only copies through.
 */
export type AbandonedApprovalCardV2 = Omit<
  AgentApprovalItemV2,
  | 'type'
  | 'requestId'
  | 'status'
  | 'decision'
  | 'respondedBy'
  | 'completedAt'
  | 'error'
  | 'card'
>;

/** One approval that was still awaiting a human when the session went away. */
export interface AbandonedApprovalV2 {
  /** The id the provider knows this request by (its wire identity). */
  requestId: string;
  /** Turn the approval card lives in, so the patch lands on the right turn. */
  turnId: string;
  card: AbandonedApprovalCardV2;
}

export interface ResolveAbandonedApprovalsOptions {
  sessionId: string;
  approvals: Iterable<AbandonedApprovalV2>;
  emitPatch: (patch: AgentPatchV2) => void;
  /**
   * QUIRK hook — how this harness answers the outstanding request on its own
   * wire (claude writes a `deny` control_response, codex answers the
   * `respondToServerRequest`, the legacy bridge POSTs `deny` through the inner
   * adapter). Runs BEFORE the card is published so the provider is released
   * first and the transcript never claims a resolution the wire refused to
   * carry. Callers that have no live wire left simply omit it.
   */
  denyOnWire?: (approval: AbandonedApprovalV2) => void;
  /** Defaults to `ABANDONED_APPROVAL_REASON`. */
  reason?: string;
  /** Seam for deterministic timestamps in tests. */
  now?: () => string;
}

/**
 * CHOREOGRAPHY (#1407). Teardown with an approval still outstanding used to
 * leave a permanently actionable Allow/Deny card in the reduced session: the
 * wire got its deny but the patch stream got nothing, so every consumer replayed
 * a live-looking approval for a session that no longer exists.
 *
 * The dance is identical for every harness and is stated once, here:
 *  1. release the provider on its own wire (the one per-adapter quirk),
 *  2. publish a terminal `agent-item-updated-v2` for each card — `cancelled`,
 *     `respondedBy: 'timeout'`, carrying a stable reason,
 *  3. drain `live.activeRequestIds` / `waitingOn` exactly once, and only when
 *     there was something to drain.
 *
 * Emitting is synchronous by contract: `BaseProtocolAdapterV2.disconnect()`
 * clears its handler set as soon as `onDisconnect()` resolves, so a resolution
 * deferred to a later microtask reaches nobody.
 */
export function resolveAbandonedApprovals(
  options: ResolveAbandonedApprovalsOptions
): void {
  const now = options.now ?? (() => new Date().toISOString());
  const reason = options.reason ?? ABANDONED_APPROVAL_REASON;
  let resolved = 0;

  for (const approval of options.approvals) {
    options.denyOnWire?.(approval);
    resolved += 1;
    options.emitPatch({
      type: 'agent-item-updated-v2',
      sessionId: options.sessionId,
      timestamp: now(),
      turnId: approval.turnId,
      item: {
        ...approval.card,
        type: 'approval',
        requestId: approval.requestId,
        decision: { kind: 'cancel' },
        respondedBy: 'timeout',
        status: 'cancelled',
        error: reason,
        completedAt: now(),
      },
    });
  }

  if (resolved === 0) return;

  options.emitPatch({
    type: 'agent-live-state-updated-v2',
    sessionId: options.sessionId,
    timestamp: now(),
    live: { waitingOn: null, activeRequestIds: [] },
  });
}
