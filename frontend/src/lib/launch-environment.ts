// launchEnvironment (#630 / #629) — small adapter that maps an
// `EnvironmentOption` (the picker's selection shape) onto the existing
// `createAgentSession` launch path.
//
// Scope:
//   - Single launch entry point shared by the command-palette picker (#630)
//     and the new-session/start-work dialog (#629). Both surfaces select an
//     `EnvironmentOption` via the same `EnvironmentPicker`; both must launch
//     against the SAME create-session API so we get one audit/telemetry path
//     and no drift between surfaces. If #629 lands after this PR, it imports
//     `launchEnvironment` from here instead of duplicating the mapping.
//
//   - Enforces the "never silently switch nodes" invariant from #615:
//     stale/offline options are rejected here with a typed reason before the
//     launch ever reaches the network. The UI is expected to gate on
//     `canLaunch(option)` BEFORE calling this, but the runtime guard is
//     defense-in-depth — a bug in the picker that surfaces a stale option
//     should not silently launch on a different node.
//
// This module is intentionally pure-ish: it calls the existing
// `createAgentSession` (which talks to the store + API) but does no
// store-state mutation of its own beyond what `createAgentSession` already
// performs. Tests can inject a `createSession` override.

import type {
  EnvironmentAgentProvider,
  EnvironmentDegradedReason,
  EnvironmentFreshness,
  EnvironmentOption,
  EnvironmentProviderAvailability,
} from '../../../shared/environment-option.js';
import {
  createAgentSession,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
} from './session-utils.js';

/**
 * Result discriminator returned by {@link launchEnvironment}. Callers that need
 * the block-on-stale reason for UI display can pattern-match on `kind`.
 */
export type LaunchEnvironmentResult =
  | { kind: 'launched'; result: CreateAgentSessionResult }
  | { kind: 'blocked'; reason: LaunchBlockedReason };

export type LaunchBlockedReason =
  | { code: 'stale'; degradedReasons?: EnvironmentDegradedReason[] }
  | { code: 'offline'; degradedReasons?: EnvironmentDegradedReason[] }
  // #861(A): node is mid-update. Distinct from stale/offline so callers can
  // surface "blocked until update completes" copy instead of a generic retry.
  | { code: 'updating'; degradedReasons?: EnvironmentDegradedReason[] }
  // #863: an agent launch chose a provider whose availability on the target
  // node is not `available` (unavailable / degraded / unknown / not advertised
  // at all). Distinct from the freshness codes so callers can render
  // "provider unavailable — pick another agent or launch a terminal" copy
  // WITHOUT collapsing to a generic node-stale retry. Terminal launches never
  // hit this branch: the option list stays `sessionType: 'terminal'`, so a
  // node row is launchable for a shell even when every agent provider is down
  // (acceptance: unavailable agents must not block a plain terminal launch).
  | {
      code: 'provider-unavailable';
      agent: string;
      /**
       * 1:1 from `EnvironmentAgentProvider.availability` when the node
       * advertised the provider; `'unknown'` when the node did not advertise
       * it at all (no matching entry in `node.agentProviders`).
       */
      availability: EnvironmentProviderAvailability;
      /** Short reason string the provider carried (RelayNodeErrorCode-derived). */
      providerReason?: string;
      /** Auth/login status the node reported for the provider, when present. */
      authStatus?: string;
    };

export interface LaunchEnvironmentOptions {
  /** Override the launch type. Defaults to 'terminal' (a bare shell launch). */
  type?: 'agent' | 'terminal';
  /**
   * Override the agent id (e.g. `'claude'`, `'codex'`). Only relevant when
   * `type === 'agent'`; the create-session path uses this to pick a framework.
   */
  agent?: string;
}

/**
 * True iff this option is safe to launch against. The picker's "never silently
 * switch nodes" invariant means anything not `fresh` is blocked at the launch
 * boundary, regardless of which surface made the selection.
 */
export function canLaunchEnvironment(option: EnvironmentOption): boolean {
  return option.freshness === 'fresh';
}

/**
 * Map a non-fresh freshness onto a typed {@link LaunchBlockedReason} `code`.
 * `updating` (#861(A)) is distinct so callers can render "blocked until update
 * completes" copy; everything else that is not `offline` collapses to `stale`.
 */
function blockedCodeFor(
  freshness: EnvironmentFreshness
): 'stale' | 'offline' | 'updating' {
  if (freshness === 'offline') return 'offline';
  if (freshness === 'updating') return 'updating';
  return 'stale';
}

/**
 * #863: locate the chosen agent provider on the option's node. Returns the
 * matching {@link EnvironmentAgentProvider} (populated by #861's converter from
 * `node.capabilities.agents`) or `undefined` when the node did not advertise
 * this provider at all.
 */
function providerForAgent(
  option: EnvironmentOption,
  agent: string
): EnvironmentAgentProvider | undefined {
  return option.node.agentProviders?.find((provider) => provider.id === agent);
}

/**
 * #863: build the typed {@link LaunchBlockedReason} for an agent launch whose
 * chosen provider is not launchable on the option's node. A provider is
 * launchable only when it is advertised AND its `availability` is `available`;
 * `degraded` / `unavailable` / `unknown` (and "not advertised", treated as
 * `unknown`) all fail closed here. The reason carries the provider's own
 * availability / reason / authStatus so callers explain *why* without a parallel
 * lookup against `node.agentProviders`.
 *
 * Returns `null` when the provider IS launchable (the happy path).
 */
function agentProviderBlockedReason(
  option: EnvironmentOption,
  agent: string
): Extract<LaunchBlockedReason, { code: 'provider-unavailable' }> | null {
  const provider = providerForAgent(option, agent);
  if (provider && provider.availability === 'available') return null;
  const availability: EnvironmentProviderAvailability =
    provider?.availability ?? 'unknown';
  return {
    code: 'provider-unavailable',
    agent,
    availability,
    ...(provider?.reason ? { providerReason: provider.reason } : {}),
    ...(provider?.authStatus ? { authStatus: provider.authStatus } : {}),
  };
}

/**
 * Map an EnvironmentOption to `createAgentSession` options. Visible for
 * testing so adapters / #629's dialog can reuse the mapping without going
 * through the launch side-effects.
 */
export function environmentToCreateSessionOptions(
  option: EnvironmentOption,
  overrides: LaunchEnvironmentOptions = {}
): CreateAgentSessionOptions {
  const type = overrides.type ?? 'terminal';
  const base: CreateAgentSessionOptions = {
    nodeId: option.node.nodeId,
    cwd: option.cwd,
    type,
  };
  if (option.repoInstance) {
    base.repoPath = option.repoInstance.localPath;
  }
  if (option.bench) {
    base.worktreePath = option.bench.localPath;
  }
  if (overrides.agent !== undefined) {
    base.agent = overrides.agent;
  }
  return base;
}

/**
 * Launch a session against the supplied environment. Refuses to launch
 * non-fresh options with a typed reason — UI surfaces should pre-check via
 * {@link canLaunchEnvironment} so this only fails on a programming bug.
 *
 * The optional `createSession` override is for tests that want to capture the
 * mapped options without hitting the real store/network.
 */
export async function launchEnvironment(
  option: EnvironmentOption,
  overrides: LaunchEnvironmentOptions = {},
  createSession: (
    opts: CreateAgentSessionOptions
  ) => Promise<CreateAgentSessionResult> = createAgentSession
): Promise<LaunchEnvironmentResult> {
  if (!canLaunchEnvironment(option)) {
    const code: LaunchBlockedReason['code'] = blockedCodeFor(option.freshness);
    const reason: LaunchBlockedReason = option.degradedReasons
      ? { code, degradedReasons: option.degradedReasons }
      : { code };
    return { kind: 'blocked', reason };
  }
  // #863: gate the chosen agent provider at the launch boundary. This runs
  // ONLY for `type === 'agent'`; a terminal launch (the default) never inspects
  // `agentProviders`, so an unavailable agent on a fresh node still launches a
  // shell (acceptance: unavailable agents must not block plain terminal
  // launch). Like the freshness guard above, this is defense-in-depth — the
  // dialog disables unselectable providers — but it must fail closed if a bug
  // surfaces an unavailable provider, so the unavailable choice never reaches
  // the create-session network call.
  if (overrides.type === 'agent' && overrides.agent !== undefined) {
    const providerReason = agentProviderBlockedReason(option, overrides.agent);
    if (providerReason) {
      return { kind: 'blocked', reason: providerReason };
    }
  }
  const result = await createSession(
    environmentToCreateSessionOptions(option, overrides)
  );
  return { kind: 'launched', result };
}
