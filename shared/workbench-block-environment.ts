/**
 * Workbench block environment metadata (#631, parent epic #615).
 *
 * Typed envelope describing the environment a Workbench block was launched in,
 * persisted alongside the block descriptor so resume/attach can rebuild the
 * exact launch context per `docs/WORKBENCH_BOUNDARY.md`.
 *
 * Why this shape (and not a free-form path string):
 *   - `WORKBENCH_BOUNDARY.md` requires node-scoped identity. `nodeId +
 *     repoIdentity + repoInstanceId + worktreeInstanceId` form a stable typed
 *     handle that survives "same repo, different path on different machines".
 *   - `cwd` and `cwdMode` distinguish in-repo / non-git / explicit-outside
 *     launches without inheriting repo-only actions on a non-git tab
 *     (#615 acceptance criterion).
 *   - `capabilities` is the snapshot of capability bits the picker advertised
 *     at create time. Resume can compare against the live env's bits and emit
 *     `block-on-launch` with a typed reason if the bit set has shrunk.
 *   - `pickerVersion` records the `EnvironmentOption.schemaVersion` so a
 *     future widening of the picker schema can detect older blocks.
 *
 * Forward / backward compatibility:
 *   - The block descriptor's `environment` field is OPTIONAL. Legacy blocks
 *     (saved before #631 landed) deserialise with no environment metadata;
 *     `isLegacyBlockEnvironment` returns `true` for the missing case so the
 *     resume path can choose a migration policy explicitly instead of
 *     silently substituting a different node (the #615 non-goal).
 *   - Adding new fields here MUST keep round-trip identity for older values.
 *     `WORKBENCH_BLOCK_ENVIRONMENT_SCHEMA_VERSION` bumps when an existing field
 *     changes shape; pure additions stay on the current version with optional
 *     fields.
 */

import {
  isEnvironmentOption,
  type EnvironmentCwdMode,
  type EnvironmentOption,
} from './environment-option.js';
import type {
  NodeId,
  RepoIdentity,
  RepoInstanceId,
  WorktreeInstanceId,
} from './identity.js';
import {
  isRelayCapabilityBit,
  type RelayCapabilityBit,
} from './security-policy.js';

export const WORKBENCH_BLOCK_ENVIRONMENT_SCHEMA_VERSION = 1 as const;

/**
 * Typed environment metadata stored on a Workbench block descriptor.
 *
 * Field semantics:
 *   - `nodeId`: the Node the block targets. Required; the operator's "where
 *     does this block live" answer.
 *   - `repoIdentity`: normalized RepoIdentity (e.g. `github.com/owner/repo`)
 *     when the launch was repo-anchored. Null/absent for free / non-git cwd.
 *   - `repoInstanceId`: the node-scoped RepoInstance id from
 *     `shared/identity.ts#createRepoInstanceId`. Present iff the launch is
 *     anchored to a real on-disk checkout.
 *   - `worktreeInstanceId`: the WorktreeInstance id when the launch lives
 *     inside a git worktree (Bench). Implies `repoInstanceId` is set.
 *   - `benchId`: alias for `worktreeInstanceId` per the WorkbenchBoundary
 *     vocabulary. We carry both to keep cross-doc grep clean; the picker
 *     fills both with the same value, but downstream code may evolve.
 *   - `cwd`: the absolute cwd on the target node. Stored verbatim — the hub
 *     resolves it against the node. NEVER used as a global identifier.
 *   - `cwdMode`: matches `EnvironmentOption.cwdMode` so resume can keep
 *     repo-only actions off a free / non-git cwd.
 *   - `capabilities`: capability bits the picker advertised at create time.
 *   - `pickerOptionId`: stable id of the picker option chosen at create time.
 *     The picker uses this to detect the original choice on resume.
 *   - `pickerVersion`: `EnvironmentOption.schemaVersion` at create time.
 *   - `createdAt`: ISO 8601 timestamp; used for audit and "you picked this on
 *     <date>" UI copy. Resume does NOT use it for decisions.
 */
export interface WorkbenchBlockEnvironmentRef {
  schemaVersion: typeof WORKBENCH_BLOCK_ENVIRONMENT_SCHEMA_VERSION;
  nodeId: NodeId;
  repoIdentity?: RepoIdentity | null;
  repoInstanceId?: RepoInstanceId;
  worktreeInstanceId?: WorktreeInstanceId;
  /** Alias for `worktreeInstanceId` to match WORKBENCH_BOUNDARY.md `Bench` noun. */
  benchId?: WorktreeInstanceId;
  cwd: string;
  cwdMode: EnvironmentCwdMode;
  capabilities: RelayCapabilityBit[];
  pickerOptionId: string;
  pickerVersion: number;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export interface BuildBlockEnvironmentInput {
  /** Picker option the user (or agent default) chose. */
  option: EnvironmentOption;
  /** Wall-clock ISO timestamp. Injected for deterministic tests. */
  createdAt: string;
}

/**
 * Build a typed `WorkbenchBlockEnvironmentRef` from a picker option.
 *
 * Pure: no I/O, no clock reads (caller supplies `createdAt`). The function
 * captures only typed IDs and capability bits — never derived path strings
 * outside what `cwd` already carries. Repeated calls with the same input
 * produce identical output (round-trip safe).
 */
export function buildBlockEnvironmentRef(
  input: BuildBlockEnvironmentInput
): WorkbenchBlockEnvironmentRef {
  const { option, createdAt } = input;
  const ref: WorkbenchBlockEnvironmentRef = {
    schemaVersion: WORKBENCH_BLOCK_ENVIRONMENT_SCHEMA_VERSION,
    nodeId: option.node.nodeId,
    cwd: option.cwd,
    cwdMode: option.cwdMode,
    capabilities: [...option.capabilities],
    pickerOptionId: option.id,
    pickerVersion: option.schemaVersion,
    createdAt,
  };
  if (option.repoInstance) {
    ref.repoInstanceId = option.repoInstance.repoInstanceId;
    ref.repoIdentity = option.repoInstance.repoIdentity;
  } else {
    ref.repoIdentity = null;
  }
  if (option.bench) {
    ref.worktreeInstanceId = option.bench.worktreeInstanceId;
    ref.benchId = option.bench.worktreeInstanceId;
  }
  return ref;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isCwdMode(value: unknown): value is EnvironmentCwdMode {
  return (
    value === 'repo' || value === 'free' || value === 'explicit-outside-repo'
  );
}

/**
 * Structural guard for `WorkbenchBlockEnvironmentRef`. Validates the schema
 * version, required scalars, capability bits (against the closed enum), and
 * `cwdMode`. Optional fields are checked only when present.
 *
 * Used by the layout deserialiser to recognise the typed `environment` field
 * on a block descriptor without leaving it stranded in the `_unknown` bag.
 */
export function isWorkbenchBlockEnvironmentRef(
  value: unknown
): value is WorkbenchBlockEnvironmentRef {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== WORKBENCH_BLOCK_ENVIRONMENT_SCHEMA_VERSION) {
    return false;
  }
  if (!hasString(value.nodeId)) return false;
  if (!hasString(value.cwd)) return false;
  if (!isCwdMode(value.cwdMode)) return false;
  if (
    value.repoIdentity !== undefined &&
    value.repoIdentity !== null &&
    typeof value.repoIdentity !== 'string'
  ) {
    return false;
  }
  if (
    value.repoInstanceId !== undefined &&
    !hasString(value.repoInstanceId)
  ) {
    return false;
  }
  if (
    value.worktreeInstanceId !== undefined &&
    !hasString(value.worktreeInstanceId)
  ) {
    return false;
  }
  if (value.benchId !== undefined && !hasString(value.benchId)) return false;
  if (!Array.isArray(value.capabilities)) return false;
  if (!value.capabilities.every(isRelayCapabilityBit)) return false;
  if (!hasString(value.pickerOptionId)) return false;
  if (typeof value.pickerVersion !== 'number') return false;
  if (!isOptionalString(value.createdAt) || !hasString(value.createdAt)) {
    return false;
  }
  // Invariant: bench implies repoInstance.
  if (value.worktreeInstanceId !== undefined && value.repoInstanceId === undefined) {
    return false;
  }
  // Invariant: cwdMode 'free' MUST NOT carry a repoInstanceId.
  if (value.cwdMode === 'free' && value.repoInstanceId !== undefined) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Resume / launch helpers
// ---------------------------------------------------------------------------

/**
 * Outcome of resolving a block's stored env metadata against the currently
 * available picker options.
 *
 * Discriminated union — callers MUST handle every variant:
 *   - `ok`: found the same typed option; launch may proceed.
 *   - `block-on-launch`: typed env exists but the picker no longer offers the
 *     matching option fresh. UI must surface the typed reason and refuse to
 *     silently substitute a different node.
 *   - `legacy-no-environment`: block predates #631; caller chooses migration
 *     policy (prompt user, default to active tab, etc.). NEVER silently
 *     substitutes.
 */
export type ResolveBlockEnvironmentResult =
  | { kind: 'ok'; option: EnvironmentOption }
  | {
      kind: 'block-on-launch';
      reason:
        | 'option-missing'
        | 'option-stale'
        | 'option-offline'
        | 'capability-shrunk';
      ref: WorkbenchBlockEnvironmentRef;
      candidate?: EnvironmentOption;
    }
  | { kind: 'legacy-no-environment' };

/**
 * Resolve the typed env metadata on a block descriptor against the currently
 * known picker options. Pure; no clock reads; never silently switches nodes.
 *
 * Decision order:
 *   1. `environment` missing → `legacy-no-environment`.
 *   2. Picker option for `pickerOptionId` not in `candidates`
 *      → `block-on-launch / option-missing`.
 *   3. Option present but not `fresh` → `block-on-launch / option-stale | offline`.
 *   4. Option present, fresh, but advertised capability set no longer covers
 *      the create-time bits → `block-on-launch / capability-shrunk`.
 *   5. Otherwise → `ok`.
 */
export function resolveBlockEnvironment(
  environment: WorkbenchBlockEnvironmentRef | undefined,
  candidates: readonly EnvironmentOption[]
): ResolveBlockEnvironmentResult {
  if (environment === undefined) return { kind: 'legacy-no-environment' };

  const match = candidates.find((c) => c.id === environment.pickerOptionId);
  if (match === undefined) {
    return {
      kind: 'block-on-launch',
      reason: 'option-missing',
      ref: environment,
    };
  }
  if (match.freshness === 'offline') {
    return {
      kind: 'block-on-launch',
      reason: 'option-offline',
      ref: environment,
      candidate: match,
    };
  }
  if (match.freshness === 'stale') {
    return {
      kind: 'block-on-launch',
      reason: 'option-stale',
      ref: environment,
      candidate: match,
    };
  }
  const advertised = new Set(match.capabilities);
  const stillSatisfied = environment.capabilities.every((bit) =>
    advertised.has(bit)
  );
  if (!stillSatisfied) {
    return {
      kind: 'block-on-launch',
      reason: 'capability-shrunk',
      ref: environment,
      candidate: match,
    };
  }
  return { kind: 'ok', option: match };
}

// ---------------------------------------------------------------------------
// Re-export for callers who want the option guard alongside the ref guard
// ---------------------------------------------------------------------------

export { isEnvironmentOption };
