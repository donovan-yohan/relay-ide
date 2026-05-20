// Safe default environment selection (#628) — pure function picking which
// EnvironmentOption a new launch should default to, given the active tab,
// last-used history, and currently-known candidates from the picker.
//
// Decision order (see issue #628 + `docs/WORKBENCH_BOUNDARY.md` epic #615):
//
//   1. Active tab present → require its node to still be in `candidates` AND
//      to be `fresh` AND to satisfy any declared `requiredCapabilities`. If
//      yes, return that option. If no, return a typed error — NEVER silently
//      switch to a different node. This is the critical correctness property
//      of #628: a Tab "lives" on its node, and silently jumping work to a
//      different machine when the selected one is stale/offline would violate
//      the federated-Relay contract (`docs/WORKBENCH_BOUNDARY.md` and the
//      `if a selected node goes stale/offline, launch is blocked with a typed
//      reason instead of falling back to another machine` acceptance criterion
//      on epic #615).
//
//   2. No active tab → walk `history` newest-first, returning the first
//      candidate that is both present and fresh. History entries pointing at
//      candidates that have been removed (node unpaired, repo instance gone)
//      or are non-fresh are skipped.
//
//   3. No history hit → return the first `fresh` candidate in the supplied
//      order. Caller decides the ordering policy (recently-seen, alphabetical,
//      etc.); this function just preserves it.
//
//   4. Nothing fresh anywhere → `{ kind: 'error', error: NO_COMPATIBLE,
//      reason: 'all-degraded' }`.
//
// This module is pure: no I/O, no time-dependent calls, no mutation of inputs.
// Freshness is supplied by the caller via `EnvironmentOption.freshness` — the
// picker layer (#615) is responsible for deciding what "stale" means against
// the current clock and inventory snapshot.

import type {
  EnvironmentOption,
} from './environment-option.js';
import type { NodeId } from './identity.js';
import type { RelayCapabilityBit } from './security-policy.js';

/**
 * Minimal slice of "the tab the user is currently focused on" the picker needs
 * to make a safe default decision. The canonical Tab IA work (#473) has not
 * landed a single shared shape yet, so this module declares only the fields it
 * actually reads:
 *
 *   - `environment`: the `EnvironmentOption` the tab was last launched against.
 *     It must round-trip through `JSON.stringify`/`JSON.parse` (it's the same
 *     shape #623 already guarantees that for).
 *   - `requiredCapabilities`: capability bits the tab needs to keep running.
 *     The picker uses this to detect "selected node is technically online but
 *     no longer advertises a bit this tab needs", which counts as degraded.
 *
 * TODO(#473): once `WorkContext.tab` (or equivalent) lands a canonical shape,
 * adapt this interface to consume it directly rather than maintaining a
 * parallel slice here.
 */
export interface ActiveTabContext {
  environment: EnvironmentOption;
  requiredCapabilities?: RelayCapabilityBit[];
}

/**
 * One entry in the last-used environment history, newest-first by caller
 * convention. The picker keys against `environmentId` (the
 * `EnvironmentOption.id` field guaranteed stable by #623).
 *
 * `lastUsedAt` is informational — used by upstream sorters and surfaced in UI
 * — but this function does not re-sort. The caller is responsible for passing
 * history in the order it wants tried.
 */
export interface EnvironmentHistoryEntry {
  environmentId: string;
  lastUsedAt: string;
}

export interface PickDefaultEnvironmentInput {
  activeTab: ActiveTabContext | null;
  history: readonly EnvironmentHistoryEntry[];
  candidates: readonly EnvironmentOption[];
}

/**
 * Why the picker chose the option it did. Useful for UI to surface "we picked
 * this because…" copy and for telemetry on default-selection quality.
 */
export type PickDefaultEnvironmentOkReason =
  | 'active-tab'
  | 'history'
  | 'first-fresh';

export interface PickDefaultEnvironmentOk {
  kind: 'ok';
  option: EnvironmentOption;
  reason: PickDefaultEnvironmentOkReason;
}

/**
 * Discriminated error shape. `error` is a stable string the caller can switch
 * on (currently always `'no-compatible'`); `reason` is the finer-grained
 * cause. Both are intentionally typed unions so adding a new failure mode is a
 * breaking change for consumers and gets caught at the type checker.
 *
 * Field set per case:
 *   - `active-tab-degraded`: active tab's node is in candidates but stale,
 *     offline, or missing required capabilities. `activeNodeId` is populated.
 *   - `active-tab-missing`: active tab's environment id is not in candidates
 *     (node unpaired, repo instance removed). `activeNodeId` is populated.
 *   - `all-degraded`: no active tab, no candidate is fresh.
 *   - `no-candidates`: caller passed an empty candidate list.
 */
export type PickDefaultEnvironmentErrorReason =
  | 'active-tab-degraded'
  | 'active-tab-missing'
  | 'all-degraded'
  | 'no-candidates';

export interface PickDefaultEnvironmentError {
  kind: 'error';
  error: 'no-compatible';
  reason: PickDefaultEnvironmentErrorReason;
  activeNodeId?: NodeId;
}

export type PickDefaultEnvironmentResult =
  | PickDefaultEnvironmentOk
  | PickDefaultEnvironmentError;

const NO_COMPATIBLE = 'no-compatible' as const;

function hasCapabilitySuperset(
  option: EnvironmentOption,
  required: readonly RelayCapabilityBit[] | undefined
): boolean {
  if (!required || required.length === 0) return true;
  const advertised = new Set(option.capabilities);
  return required.every((bit) => advertised.has(bit));
}

function indexCandidatesById(
  candidates: readonly EnvironmentOption[]
): Map<string, EnvironmentOption> {
  const byId = new Map<string, EnvironmentOption>();
  for (const candidate of candidates) {
    // First-wins on duplicate ids — caller is responsible for unique ids, but
    // we don't want to silently let a later duplicate override the earlier
    // entry that the user's ordering implies as canonical.
    if (!byId.has(candidate.id)) byId.set(candidate.id, candidate);
  }
  return byId;
}

/**
 * Pure selection function: pick the safe default environment for a new launch.
 *
 * Contract:
 *   - No I/O, no mutation of inputs, no clock reads.
 *   - Stable for identical inputs (same input shape → same output shape).
 *   - Never silently substitutes a different node when the active tab's
 *     selected node is stale/offline.
 *   - Empty candidate list returns `{ reason: 'no-candidates' }` rather than
 *     throwing.
 *   - O(C + H) — candidates are indexed once into a Map for O(1) lookup from
 *     both the active-tab match and the history walk.
 */
export function pickDefaultEnvironment(
  input: PickDefaultEnvironmentInput
): PickDefaultEnvironmentResult {
  const { activeTab, history, candidates } = input;

  if (candidates.length === 0) {
    return { kind: 'error', error: NO_COMPATIBLE, reason: 'no-candidates' };
  }

  const candidatesById = indexCandidatesById(candidates);

  // Rule 1: active tab → never silently switch nodes.
  if (activeTab) {
    const activeNodeId = activeTab.environment.node.nodeId;
    const matched = candidatesById.get(activeTab.environment.id);
    if (matched === undefined) {
      return {
        kind: 'error',
        error: NO_COMPATIBLE,
        reason: 'active-tab-missing',
        activeNodeId,
      };
    }
    if (
      matched.freshness !== 'fresh' ||
      !hasCapabilitySuperset(matched, activeTab.requiredCapabilities)
    ) {
      return {
        kind: 'error',
        error: NO_COMPATIBLE,
        reason: 'active-tab-degraded',
        activeNodeId,
      };
    }
    return { kind: 'ok', option: matched, reason: 'active-tab' };
  }

  // Rule 2: history walk (caller-supplied order, newest first by convention).
  for (const entry of history) {
    const match = candidatesById.get(entry.environmentId);
    if (match && match.freshness === 'fresh') {
      return { kind: 'ok', option: match, reason: 'history' };
    }
  }

  // Rule 3: first fresh candidate in the supplied order.
  const firstFresh = candidates.find((candidate) => candidate.freshness === 'fresh');
  if (firstFresh) {
    return { kind: 'ok', option: firstFresh, reason: 'first-fresh' };
  }

  // Rule 4: nothing fresh anywhere.
  return { kind: 'error', error: NO_COMPATIBLE, reason: 'all-degraded' };
}
