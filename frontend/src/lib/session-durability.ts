// Frontend visual mapping for #614 durability states. Keeps the shared
// `SessionDurabilityState` enum decoupled from React/UI rendering decisions —
// the enum lives in `shared/session-durability.ts`; this module owns the
// label/colour mapping consumed by `TopicSidebarShell`, mobile cards, and
// tests.

import type { SessionDurabilityState } from '../../../shared/session-durability.js';
import type { StatusDotStatus } from '../components/StatusDot.js';

export interface SessionDurabilityBadge {
  /** Maps to an existing `StatusDot` color token to keep the design system intact. */
  statusDot: StatusDotStatus;
  /** Short label, lowercased per DESIGN.md. Display max 16 chars. */
  label: string;
  /** Severity ordering for sorting/aria. Lower = more attention. */
  severity: number;
}

const BADGES: Record<SessionDurabilityState, SessionDurabilityBadge> = {
  'permission-needed': {
    statusDot: 'permission-prompt',
    label: 'needs permission',
    severity: 0,
  },
  error: { statusDot: 'attention', label: 'error', severity: 1 },
  'stale-node': { statusDot: 'warning', label: 'stale node', severity: 2 },
  ended: { statusDot: 'disconnected', label: 'ended', severity: 3 },
  'awaiting-start': {
    statusDot: 'initializing',
    label: 'starting',
    severity: 4,
  },
  'running-detached': { statusDot: 'idle', label: 'detached', severity: 5 },
  'running-attached': { statusDot: 'running', label: 'live', severity: 6 },
};

export function durabilityToBadge(
  state: SessionDurabilityState
): SessionDurabilityBadge {
  // Closed enum — TS prevents unknown values at the call site; the lookup
  // is total. Defensive return only catches accidental string-cast misuse.
  return BADGES[state] ?? BADGES['running-attached'];
}

/**
 * Returns a typed disabled-reason code when a session's durability state
 * means a live control (input, kill) cannot honestly act on the process.
 * `null` means controls are allowed; `permission-needed` is intentionally
 * NOT disabled — the operator is supposed to answer it.
 */
export function durabilityDisabledReason(
  state: SessionDurabilityState | undefined
): string | null {
  if (state === 'stale-node') {
    return 'stale node — controls cannot prove the process is alive';
  }
  if (state === 'ended') {
    return 'session ended — no process to control';
  }
  if (state === 'error') {
    return 'session in error state — controls disabled until recovery';
  }
  return null;
}
