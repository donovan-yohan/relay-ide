// Session durability state for #614. The Relay session is process-owned by a
// node-side PTY/session registry; browser/hub sockets are attach handles, not process owners.
// `SessionDurabilityState` is a derived, closed enum surfaced on session
// summaries so consumers can reason about reattach safety without poking at
// internal handles.

// Mirror the two existing typing dimensions without importing from
// `server/types.ts`, so this module stays in the shared layer and is
// consumable by frontend code without leaking server-only types.
// Kept narrow on purpose: the durability derivation only reads a small
// subset of agent-state values.
export type SessionDurabilityStatus = 'active' | 'disconnected';
export type SessionDurabilityAgentState =
  | 'initializing'
  | 'waiting-for-input'
  | 'processing'
  | 'permission-prompt'
  | 'error'
  | 'idle';

export const SESSION_DURABILITY_STATES = [
  'running-attached',
  'running-detached',
  'awaiting-start',
  'stale-node',
  'ended',
  'error',
  'permission-needed',
] as const;

export type SessionDurabilityState = (typeof SESSION_DURABILITY_STATES)[number];

export function isSessionDurabilityState(
  value: unknown
): value is SessionDurabilityState {
  return (
    typeof value === 'string' &&
    (SESSION_DURABILITY_STATES as readonly string[]).includes(value)
  );
}

/**
 * Node-link health hint from the perspective of the hub. `null` means the
 * caller does not have a hub-side opinion (e.g. a node is reporting its own
 * sessions) and the derivation should trust local signals instead.
 */
export type SessionDurabilityNodeStatus =
  | 'online'
  | 'stale'
  | 'offline'
  | 'revoked'
  | null;

export interface SessionDurabilityInput {
  /** Coarse two-state field already on every session summary. */
  status: SessionDurabilityStatus;
  /** Agent state machine; carries permission-prompt + error signals. */
  agentState: SessionDurabilityAgentState;
  /** True when the session is not actively producing/consuming. */
  idle: boolean;
  /** PTY sessions only — process was reaped and cleanup ran. */
  cleanedUp?: boolean;
  /** Hub-side view of the node link, when available. */
  nodeStatus?: SessionDurabilityNodeStatus;
  /** True when the session has at least one live attach handle. */
  hasLiveAttach?: boolean;
}

/**
 * Derive a `SessionDurabilityState` from current Relay signals. Pure function;
 * callers handle persistence and transition emission. Closed enum: any input
 * combination resolves to exactly one of the seven states.
 *
 * Priority order, top down:
 *   1. `stale-node` — hub reports the owning node link is unhealthy. The
 *      session may still be running locally but we cannot prove it from here.
 *   2. `ended` — process was reaped (PTY `cleanedUp`) and there is nothing to
 *      reattach to.
 *   3. `error` — agent state reports an error; honored even when `status` is
 *      still `'active'` because the error signal is more specific.
 *   4. `permission-needed` — interactive prompt waiting for an operator.
 *   5. `awaiting-start` — session created but has not produced output yet.
 *   6. `running-detached` — process alive but no live attach handle.
 *   7. `running-attached` — default for an active, attached session.
 */
export function deriveSessionDurability(
  input: SessionDurabilityInput
): SessionDurabilityState {
  if (
    input.nodeStatus === 'stale' ||
    input.nodeStatus === 'offline' ||
    input.nodeStatus === 'revoked'
  ) {
    return 'stale-node';
  }
  if (input.cleanedUp) return 'ended';
  if (input.agentState === 'error') return 'error';
  if (input.agentState === 'permission-prompt') return 'permission-needed';
  if (input.agentState === 'initializing' && input.idle)
    return 'awaiting-start';
  if (input.status === 'disconnected') return 'running-detached';
  // The slice 1 scope does not track per-session attach handles centrally.
  // When a caller knows attach state explicitly (e.g. a PTY with no open
  // browser socket), it can pass `hasLiveAttach: false` to surface
  // `running-detached`; otherwise we trust the coarse `status` field.
  if (input.hasLiveAttach === false) return 'running-detached';
  return 'running-attached';
}
