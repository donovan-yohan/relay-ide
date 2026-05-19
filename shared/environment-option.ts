// EnvironmentOption (#623) — unified shape for an environment a Relay launch
// can target. Backend + frontend share this so the environment picker (#615),
// session-create flows, command palette, and agent contracts all agree on what
// "where work runs" means.
//
// An EnvironmentOption combines:
//   - Node identity + capability bits (from `shared/security-policy.ts`)
//   - Optional RepoInstance (a repo checkout on that node)
//   - Optional Bench / WorktreeInstance (a worktree inside that repo instance)
//   - cwd + cwdMode (repo-relative, free, or explicitly outside the repo)
//   - Freshness (fresh | stale | offline) + typed degraded reasons
//
// This file does NOT redefine Node, RepoInstance, or WorktreeInstance shapes
// from `shared/work-context.ts` / `shared/repo-inventory.ts`. Those existing
// types carry inventory state (dirty files, divergence, remotes) the picker
// doesn't need at decision time, so we pick the minimal slice required for
// launch context and import the canonical id helpers from `shared/identity.ts`.
//
// TODO(#615 follow-ons): once child issues land, prefer importing/re-exporting
// from a single picker barrel rather than duplicating the slim summary shapes
// here.

import type {
  NodeId,
  RepoInstanceId,
  WorktreeInstanceId,
} from './identity.js';
import {
  isRelayCapabilityBit,
  type RelayCapabilityBit,
} from './security-policy.js';

export const ENVIRONMENT_OPTION_SCHEMA_VERSION = 1 as const;

export const ENVIRONMENT_FRESHNESS_VALUES = [
  'fresh',
  'stale',
  'offline',
] as const;

export type EnvironmentFreshness = (typeof ENVIRONMENT_FRESHNESS_VALUES)[number];

export const ENVIRONMENT_DEGRADED_REASONS = [
  'node-offline',
  'node-stale',
  'capability-missing',
  'repo-missing',
  'worktree-missing',
  'auth-failed',
  'other',
] as const;

export type EnvironmentDegradedReasonKind =
  (typeof ENVIRONMENT_DEGRADED_REASONS)[number];

export type EnvironmentDegradedReason =
  | { kind: 'node-offline'; lastSeenAt?: string; message?: string }
  | { kind: 'node-stale'; lastSeenAt: string; message?: string }
  | { kind: 'capability-missing'; capability: RelayCapabilityBit; message?: string }
  | {
      kind: 'repo-missing';
      repoIdentity?: string;
      localPath?: string;
      message?: string;
    }
  | { kind: 'worktree-missing'; localPath: string; message?: string }
  | { kind: 'auth-failed'; message: string; capability?: RelayCapabilityBit }
  | { kind: 'other'; message: string; code?: string };

/**
 * How the cwd relates to the repo instance. The picker uses this to gate
 * repo-only actions (#615): a "free" launch never inherits repo actions, and
 * "explicit-outside-repo" is the user opting in to a cwd that intentionally
 * sits outside the selected repo (e.g. a sibling vendored tree).
 */
export type EnvironmentCwdMode = 'repo' | 'free' | 'explicit-outside-repo';

/**
 * Display node identity for the picker. Mirrors the slim
 * `WorkContext` `NodeRef` from `shared/work-context.ts` rather than the full
 * `NodeManifest`, because the picker decides on identity + reachability, not
 * probe payloads.
 */
export interface EnvironmentNodeSummary {
  nodeId: NodeId;
  kind: 'local' | 'remote';
  displayName?: string;
  online?: boolean;
}

/**
 * Minimal RepoInstance slice for the picker. Field names match
 * `RepoInventoryRepoInstance` from `shared/repo-inventory.ts` so adapter code
 * can pluck from inventory reports without renaming.
 */
export interface EnvironmentRepoInstanceSummary {
  repoInstanceId: RepoInstanceId;
  localPath: string;
  repoIdentity: string | null;
  name?: string;
  currentBranch?: string | null;
  defaultBranch?: string | null;
}

/**
 * Minimal Bench / WorktreeInstance slice for the picker. Field names match
 * `RepoInventoryWorktreeInstance` from `shared/repo-inventory.ts`.
 */
export interface EnvironmentBenchSummary {
  worktreeInstanceId: WorktreeInstanceId;
  localPath: string;
  branchName?: string | null;
  displayName?: string;
}

export interface EnvironmentOption {
  schemaVersion: typeof ENVIRONMENT_OPTION_SCHEMA_VERSION;
  /**
   * Stable id for this option in picker state. The picker may compose this
   * from `nodeId + repoInstanceId + worktreeInstanceId`, but the shape here
   * does not constrain the format beyond "non-empty string".
   */
  id: string;
  node: EnvironmentNodeSummary;
  /**
   * Subset of `RELAY_CAPABILITY_BITS` advertised by this environment. The
   * picker filters launches against required capabilities; agent contracts
   * declare required bits and the picker hides options that don't satisfy
   * them.
   */
  capabilities: RelayCapabilityBit[];
  /**
   * Absolute cwd on the target node where the launched session will start.
   * If `repoInstance` is present, the invariant in `cwdMode` applies.
   */
  cwd: string;
  cwdMode: EnvironmentCwdMode;
  freshness: EnvironmentFreshness;
  /**
   * Present iff `freshness !== 'fresh'`. Each reason carries discriminator
   * data the UI can render without re-querying the node.
   */
  degradedReasons?: EnvironmentDegradedReason[];
  repoInstance?: EnvironmentRepoInstanceSummary;
  /**
   * Optional Bench / worktree inside the repo instance. Invariant: if `bench`
   * is set, `repoInstance` MUST also be set (a Bench is always anchored to a
   * RepoInstance per `docs/WORKBENCH_BOUNDARY.md`).
   */
  bench?: EnvironmentBenchSummary;
  /**
   * ISO timestamp the picker last refreshed this option. Used by the picker
   * to compute staleness UI badges.
   */
  generatedAt: string;
}

// --- type guards --------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isOptionalStringOrNull(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === 'string';
}

export function isEnvironmentFreshness(
  value: unknown
): value is EnvironmentFreshness {
  return (
    typeof value === 'string' &&
    (ENVIRONMENT_FRESHNESS_VALUES as readonly string[]).includes(value)
  );
}

export function isEnvironmentDegradedReason(
  value: unknown
): value is EnvironmentDegradedReason {
  if (!isRecord(value)) return false;
  const kind = value.kind;
  if (typeof kind !== 'string') return false;
  switch (kind) {
    case 'node-offline':
      return (
        isOptionalString(value.lastSeenAt) && isOptionalString(value.message)
      );
    case 'node-stale':
      return hasString(value.lastSeenAt) && isOptionalString(value.message);
    case 'capability-missing':
      return (
        isRelayCapabilityBit(value.capability) && isOptionalString(value.message)
      );
    case 'repo-missing':
      return (
        isOptionalString(value.repoIdentity) &&
        isOptionalString(value.localPath) &&
        isOptionalString(value.message)
      );
    case 'worktree-missing':
      return hasString(value.localPath) && isOptionalString(value.message);
    case 'auth-failed':
      return (
        hasString(value.message) &&
        (value.capability === undefined ||
          isRelayCapabilityBit(value.capability))
      );
    case 'other':
      return hasString(value.message) && isOptionalString(value.code);
    default:
      return false;
  }
}

function isEnvironmentNodeSummary(
  value: unknown
): value is EnvironmentNodeSummary {
  if (!isRecord(value)) return false;
  return (
    hasString(value.nodeId) &&
    (value.kind === 'local' || value.kind === 'remote') &&
    isOptionalString(value.displayName) &&
    (value.online === undefined || typeof value.online === 'boolean')
  );
}

function isEnvironmentRepoInstanceSummary(
  value: unknown
): value is EnvironmentRepoInstanceSummary {
  if (!isRecord(value)) return false;
  return (
    hasString(value.repoInstanceId) &&
    hasString(value.localPath) &&
    isOptionalStringOrNull(value.repoIdentity) &&
    isOptionalString(value.name) &&
    isOptionalStringOrNull(value.currentBranch) &&
    isOptionalStringOrNull(value.defaultBranch)
  );
}

function isEnvironmentBenchSummary(
  value: unknown
): value is EnvironmentBenchSummary {
  if (!isRecord(value)) return false;
  return (
    hasString(value.worktreeInstanceId) &&
    hasString(value.localPath) &&
    isOptionalStringOrNull(value.branchName) &&
    isOptionalString(value.displayName)
  );
}

function isCwdMode(value: unknown): value is EnvironmentCwdMode {
  return (
    value === 'repo' || value === 'free' || value === 'explicit-outside-repo'
  );
}

/**
 * Determines whether `cwd` is inside the given `repoLocalPath`. Treats
 * path-separator boundaries to avoid `/repos/relay` matching `/repos/relay-ide`.
 */
function isCwdInsideRepo(cwd: string, repoLocalPath: string): boolean {
  if (cwd === repoLocalPath) return true;
  const withSep = repoLocalPath.endsWith('/')
    ? repoLocalPath
    : `${repoLocalPath}/`;
  return cwd.startsWith(withSep);
}

export function hasRepoInstance(
  option: EnvironmentOption
): option is EnvironmentOption & {
  repoInstance: EnvironmentRepoInstanceSummary;
} {
  return option.repoInstance !== undefined;
}

export function hasBench(
  option: EnvironmentOption
): option is EnvironmentOption & {
  bench: EnvironmentBenchSummary;
  repoInstance: EnvironmentRepoInstanceSummary;
} {
  return option.bench !== undefined && option.repoInstance !== undefined;
}

function hasValidScalars(value: Record<string, unknown>): boolean {
  return (
    value.schemaVersion === ENVIRONMENT_OPTION_SCHEMA_VERSION &&
    hasString(value.id) &&
    isEnvironmentNodeSummary(value.node) &&
    Array.isArray(value.capabilities) &&
    value.capabilities.every(isRelayCapabilityBit) &&
    hasString(value.cwd) &&
    isCwdMode(value.cwdMode) &&
    isEnvironmentFreshness(value.freshness) &&
    hasString(value.generatedAt)
  );
}

function hasValidRepoAndBench(value: Record<string, unknown>): boolean {
  if (
    value.repoInstance !== undefined &&
    !isEnvironmentRepoInstanceSummary(value.repoInstance)
  ) {
    return false;
  }
  if (value.bench === undefined) return true;
  if (!isEnvironmentBenchSummary(value.bench)) return false;
  // Invariant: bench implies repoInstance.
  return value.repoInstance !== undefined;
}

function hasValidCwdContainment(value: Record<string, unknown>): boolean {
  const cwd = value.cwd as string;
  const repoInstance = value.repoInstance as
    | EnvironmentRepoInstanceSummary
    | undefined;
  const bench = value.bench as EnvironmentBenchSummary | undefined;
  if (value.cwdMode === 'repo') {
    if (repoInstance === undefined) return false;
    const insideRepo = isCwdInsideRepo(cwd, repoInstance.localPath);
    const insideBench =
      bench !== undefined ? isCwdInsideRepo(cwd, bench.localPath) : false;
    if (!insideRepo && !insideBench) return false;
  }
  if (value.cwdMode === 'free' && repoInstance !== undefined) return false;
  return true;
}

function hasValidDegradedReasons(value: Record<string, unknown>): boolean {
  if (value.degradedReasons === undefined) return true;
  if (!Array.isArray(value.degradedReasons)) return false;
  if (value.freshness === 'fresh' && value.degradedReasons.length > 0) {
    return false;
  }
  return value.degradedReasons.every(isEnvironmentDegradedReason);
}

export function isEnvironmentOption(value: unknown): value is EnvironmentOption {
  if (!isRecord(value)) return false;
  return (
    hasValidScalars(value) &&
    hasValidRepoAndBench(value) &&
    hasValidCwdContainment(value) &&
    hasValidDegradedReasons(value)
  );
}
