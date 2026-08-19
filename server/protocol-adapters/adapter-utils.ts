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
  AgentPatchV2,
} from '../../shared/agent-chat-protocol-v2.js';

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
