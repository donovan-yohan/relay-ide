import type { ProtocolAdapter } from '../protocol-adapter.js';
import { BaseProtocolAdapterV2 } from '../protocol-adapter-v2.js';
import type {
  AdapterConfig,
  AdapterStatus,
  AgentApprovalResponseInputV2,
  AgentInputResponseInputV2,
  AgentInterruptInputV2,
  AgentSendMessageInputV2,
} from '../protocol-adapter-v2.js';
import type {
  AgentApprovalDecisionV2,
  AgentCapabilitySetV2,
  AgentPatchV2,
} from '../../shared/agent-chat-protocol-v2.js';
import type { ChatEvent } from '../../shared/chat-events.js';
import { mapChatEventToAgentPatchV2 } from '../../shared/agent-chat-v1-compat.js';
import { createLogger } from '../logger.js';
import {
  resolveAbandonedApprovals,
  type AbandonedApprovalV2,
} from './adapter-utils.js';

const logger = createLogger('legacy-v2-bridge');

/**
 * Turn ids retained by the terminal ledger. Bounded so a long-lived bridged
 * session cannot grow the map without limit; eviction is oldest-first and only
 * ever reaches turns that ended many turns ago.
 *
 * The bound is also the limit of the exactly-once guarantee, and that is
 * deliberate: a duplicate terminal for a turn already evicted (an adapter
 * firing a second `chat:turn-completed` more than 256 turns later) finds no
 * record, opens a fresh one, and passes through. Memory is the harder
 * constraint — an unbounded ledger on a session that never disconnects is a
 * real leak, a terminal replayed 256 turns late is not a shape any adapter
 * here produces. See `openTurn` for the second, related escape.
 */
const MAX_TRACKED_TURNS = 256;

/** One turn's terminal state, as seen by the bridge. */
interface TurnTerminalRecord {
  /** A terminal `agent-turn-completed-v2` has already been emitted. */
  terminated: boolean;
  /** Last `chat:error` message seen for this turn, if any. */
  error?: string;
  /** A deferred fallback completion is already armed for this turn. */
  fallbackArmed: boolean;
}

/**
 * Translate a V2 decision back to the v1 binary form expected by legacy adapters.
 * Legacy adapters (opencode, hermes) only support once/permanent accept and deny.
 * Unsupported decisions fall back to deny so we never grant a wider scope than
 * the user asked for: session/turn scopes don't exist in the legacy contract,
 * and amendment payloads (execpolicy/networkPolicy/permissionGrant) cannot be
 * faithfully relayed through a binary allow.
 */
function v2DecisionToLegacy(
  decision: AgentApprovalDecisionV2
): 'allow' | 'allow-always' | 'deny' {
  if (decision.kind === 'decline' || decision.kind === 'cancel') {
    return 'deny';
  }

  // kind === 'accept' — refuse to widen scope or drop amendment constraints.
  if ((decision.amendments?.length ?? 0) > 0) {
    return 'deny';
  }

  const scope = decision.scope ?? 'once';
  if (scope === 'permanent') return 'allow-always';
  if (scope === 'once') return 'allow';
  // session / turn / unknown scopes have no legacy equivalent.
  return 'deny';
}

export class LegacyProtocolAdapterV2Bridge extends BaseProtocolAdapterV2 {
  readonly runtimeOwnership: 'spawned' | 'attached';
  readonly agentType: string;

  private unlisten: (() => void) | null = null;

  /**
   * #1411 — the bridge is the single owner of the terminal turn patch.
   *
   * CHOREOGRAPHY, not a quirk: "a turn ends exactly once" is the V2 turn
   * lifecycle contract, identical for every legacy harness, and this bridge is
   * the one seam all of them pass through. Fixing it per adapter would mean
   * three hand-written copies of the same rule — exactly what
   * `AGENTS.md` forbids — and `mapChatEventToAgentPatchV2` cannot own it
   * because a pure event->patches function holds no turn state.
   *
   * The rule, stated once:
   *  - The adapter's own `chat:turn-completed` is authoritative; it carries the
   *    honest completion `reason`, which a synthesized patch can only flatten
   *    to `failed`.
   *  - A second completion for a turn that already ended is dropped (hermes
   *    fires `chat:error` + `chat:turn-completed` from every failure path;
   *    opencode can complete a turn from both the SSE idle and the message POST
   *    resolution).
   *  - A `chat:error` carrying a turnId arms a fallback completion. If the
   *    adapter does not end the turn in the same synchronous emit chain, the
   *    bridge ends it (opencode's `tui.toast.show` path fires the error and
   *    never completes). The deferral is one microtask — legacy adapters fire
   *    their paired events synchronously, so no wall clock is involved and the
   *    patch order stays deterministic.
   *  - A `chat:error` with NO turnId is not a turn signal and synthesizes
   *    nothing: guessing would pin a session-level failure on whatever turn
   *    happened to be running. (#1412 fixed opencode-attached by making its
   *    `session.error` carry the turnId, which is where that belongs.)
   */
  private readonly turnLedger = new Map<string, TurnTerminalRecord>();
  /** Bumped on connect/disconnect so armed fallbacks from a dead generation no-op. */
  private ledgerGeneration = 0;

  /**
   * #1407 — approvals still awaiting a human, keyed by request id.
   *
   * CHOREOGRAPHY, for the same reason the turn ledger is: "teardown never
   * leaves an actionable approval card behind" is a V2 lifecycle rule, and this
   * bridge is the one seam opencode, opencode-attached, and hermes all pass
   * through. Fixing it inside each legacy adapter would be three hand-written
   * copies. The ledger is fed by the patches the bridge itself publishes, so it
   * needs no per-adapter vocabulary: an approval item that reads pending is
   * pending, whatever native event produced it.
   */
  private readonly pendingApprovals = new Map<
    string,
    AbandonedApprovalV2 & { sessionId: string }
  >();

  constructor(
    private readonly inner: ProtocolAdapter,
    readonly capabilities: AgentCapabilitySetV2
  ) {
    super();
    this.agentType = inner.agentType;
    this.runtimeOwnership = inner.runtimeOwnership;
  }

  get status(): AdapterStatus {
    return this.inner.status;
  }

  /**
   * Drop the inner patch subscription. Idempotent, and the first move of every
   * teardown path: nothing the inner adapter emits after this reaches a
   * consumer, which is what `cancelAbandonedApprovals` relies on.
   */
  private dropInnerSubscription(): void {
    this.unlisten?.();
    this.unlisten = null;
  }

  private subscribePatches(): void {
    this.dropInnerSubscription();
    this.unlisten = this.inner.on((event) => {
      for (const patch of mapChatEventToAgentPatchV2(event)) {
        this.emitTurnOwnedPatch(patch);
      }
      this.armTerminalFallback(event);
    });
  }

  /** Forget every turn and disarm anything the previous generation scheduled. */
  private resetTurnLedger(): void {
    this.ledgerGeneration += 1;
    this.turnLedger.clear();
  }

  /**
   * Start (or restart) a turn's record, re-inserted at the tail so eviction
   * stays oldest-first.
   *
   * The record is reset unconditionally, which is the second bound on the
   * dedupe: a repeated `agent-turn-started-v2` for an id that already
   * terminated re-arms that id for another terminal. Preserving `terminated`
   * instead would be worse — an adapter that reuses a turn id is announcing a
   * genuinely new turn, and a preserved record would silently swallow its real
   * terminal, turning a duplicate into a missing one. The dedupe is therefore
   * "one terminal per turn-started", not "one terminal per id, forever".
   */
  private openTurn(turnId: string): TurnTerminalRecord {
    const record: TurnTerminalRecord = {
      terminated: false,
      fallbackArmed: false,
    };
    this.turnLedger.delete(turnId);
    this.turnLedger.set(turnId, record);
    while (this.turnLedger.size > MAX_TRACKED_TURNS) {
      const oldest = this.turnLedger.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.turnLedger.delete(oldest);
    }
    return record;
  }

  /**
   * Emit a mapped patch, enforcing exactly-one-terminal ownership on the way
   * out. Every non-turn-lifecycle patch passes straight through.
   */
  private emitTurnOwnedPatch(patch: AgentPatchV2): void {
    this.trackApproval(patch);
    if (patch.type === 'agent-turn-started-v2') {
      this.openTurn(patch.turn.id);
      this.emitPatch(patch);
      return;
    }
    if (patch.type !== 'agent-turn-completed-v2') {
      this.emitPatch(patch);
      return;
    }

    const known = this.turnLedger.get(patch.turnId);
    if (known?.terminated) {
      // Not silence: a duplicate terminal is a logged gap, per the fidelity
      // invariants in AGENTS.md. Dropping it is the whole point of #1411.
      logger.debug(
        `[${this.agentType}] dropped a duplicate agent-turn-completed-v2 for turn ${patch.turnId} (status ${patch.status})`
      );
      return;
    }

    const record = known ?? this.openTurn(patch.turnId);
    record.terminated = true;
    // The error text used to ride the synthesized patch. Now that the adapter's
    // own completion wins, carry the message onto it so a failed turn still
    // says why it failed.
    const enriched =
      patch.status === 'failed' && !patch.error && record.error
        ? { ...patch, error: record.error }
        : patch;
    this.emitPatch(enriched);
  }

  /**
   * Keep the approval ledger in step with the cards the bridge publishes: an
   * item that reads `pending`/`running` is outstanding, anything else has been
   * answered. Reading the patch stream rather than the native events is what
   * keeps this provider-agnostic.
   */
  private trackApproval(patch: AgentPatchV2): void {
    if (
      patch.type !== 'agent-item-started-v2' &&
      patch.type !== 'agent-item-updated-v2'
    ) {
      return;
    }
    const item = patch.item;
    if (item.type !== 'approval') return;
    const status = item.status ?? 'pending';
    if (status !== 'pending' && status !== 'running') {
      this.pendingApprovals.delete(item.requestId);
      return;
    }
    this.pendingApprovals.set(item.requestId, {
      sessionId: patch.sessionId,
      requestId: item.requestId,
      turnId: patch.turnId,
      card: {
        id: item.id,
        kind: item.kind,
        description: item.description,
        target: item.target,
        ...(item.detail !== undefined ? { detail: item.detail } : {}),
        ...(item.details !== undefined ? { details: item.details } : {}),
        ...(item.supported !== undefined ? { supported: item.supported } : {}),
        ...(item.startedAt !== undefined ? { startedAt: item.startedAt } : {}),
        ...(item.metadata !== undefined ? { metadata: item.metadata } : {}),
      },
    });
  }

  /**
   * Teardown half of #1407. Every caller MUST drop the inner subscription
   * first, and both do (`onDisconnect`, `reconnect`). That ordering is what
   * makes the cancelled cards this publishes the only resolution the transcript
   * sees: the wire deny below is fire-and-forget, and both OpenCode adapters
   * fire a `chat:approval-response` on a 2xx, so with the subscription still
   * attached a deny that lands before the session dies would emit a
   * `completed` / `respondedBy: 'user'` update AFTER the cancelled card and
   * overwrite it — a transcript claiming the operator denied an approval they
   * never saw.
   */
  private cancelAbandonedApprovals(): void {
    const abandoned = [...this.pendingApprovals.values()];
    this.pendingApprovals.clear();
    const sessionId = abandoned[0]?.sessionId;
    if (sessionId === undefined) return;
    resolveAbandonedApprovals({
      sessionId,
      approvals: abandoned,
      emitPatch: (patch) => this.emitPatch(patch),
      // QUIRK, delegated: every legacy adapter already knows how to say "deny"
      // on its own transport. Best-effort and unawaited — teardown must not
      // block on a provider round-trip that may never answer.
      denyOnWire: ({ requestId }) => {
        void this.inner.respondToApproval(requestId, 'deny').catch((err) => {
          logger.debug(
            `[${this.agentType}] teardown deny for approval ${requestId} did not land:`,
            err
          );
        });
      },
    });
  }

  /**
   * A `chat:error` bound to a turn arms the fallback completion the mapper used
   * to synthesize unconditionally. It fires only if the adapter did not end the
   * turn itself in the same synchronous emit chain.
   */
  private armTerminalFallback(event: ChatEvent): void {
    if (event.type !== 'chat:error') return;
    const turnId = event.turnId;
    if (!turnId) return;

    const known = this.turnLedger.get(turnId);
    if (known?.terminated) return;
    const record = known ?? this.openTurn(turnId);
    record.error = event.message;
    if (record.fallbackArmed) return;
    record.fallbackArmed = true;

    const generation = this.ledgerGeneration;
    const { sessionId, timestamp } = event;
    queueMicrotask(() => {
      if (generation !== this.ledgerGeneration) return;
      const current = this.turnLedger.get(turnId);
      if (!current || current.terminated) return;
      current.terminated = true;
      logger.debug(
        `[${this.agentType}] completing turn ${turnId} from chat:error — the adapter never did`
      );
      this.emitPatch({
        type: 'agent-turn-completed-v2',
        sessionId,
        timestamp,
        turnId,
        status: 'failed',
        completedAt: timestamp,
        ...(current.error ? { error: current.error } : {}),
      });
    });
  }

  async connect(config: AdapterConfig): Promise<void> {
    this.resetTurnLedger();
    this.pendingApprovals.clear();
    this.subscribePatches();
    try {
      await this.inner.connect(config);
    } catch (error) {
      this.dropInnerSubscription();
      this.resetTurnLedger();
      throw error;
    }
  }

  protected async onDisconnect(): Promise<void> {
    this.dropInnerSubscription();
    this.resetTurnLedger();
    this.cancelAbandonedApprovals();
    await this.inner.disconnect();
  }

  async reconnect(): Promise<void> {
    // Drop the inner subscription BEFORE cancelling, exactly as `onDisconnect`
    // does: the wire deny is unawaited and answers with a
    // `chat:approval-response`, which would otherwise overwrite the cancelled
    // card with a `user`-decided one. `subscribePatches()` re-attaches below.
    this.dropInnerSubscription();
    // A reconnect replaces the session the outstanding approvals belonged to,
    // so they are as abandoned as they are on a plain disconnect (#1407).
    this.cancelAbandonedApprovals();
    try {
      await this.inner.reconnect();
      this.subscribePatches();
    } catch (error) {
      this.dropInnerSubscription();
      throw error;
    }
  }

  async resumeSession(sessionId: string): Promise<void> {
    if (!this.capabilities.resume) {
      throw new Error(
        `${this.agentType} does not support resume (capabilities.resume is false).`
      );
    }
    // The wrapped adapter is already connected (patch subscription is live from
    // connect()); resume only restores provider-native continuation state.
    await this.inner.resumeSession(sessionId);
  }

  async sendMessage(input: AgentSendMessageInputV2): Promise<void> {
    await this.inner.sendMessage(
      input.turnId,
      input.content,
      input.attachments
    );
  }

  async interrupt(input: AgentInterruptInputV2): Promise<void> {
    await this.inner.interrupt(input.turnId ?? '');
  }

  async respondToApproval(input: AgentApprovalResponseInputV2): Promise<void> {
    await this.inner.respondToApproval(
      input.requestId,
      v2DecisionToLegacy(input.decision)
    );
  }

  async respondToInput(input: AgentInputResponseInputV2): Promise<void> {
    await this.inner.respondToInput(input.requestId, input.answers);
  }
}
