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

import type { EnvironmentOption } from '../../../shared/environment-option.js';
import type { EnvironmentDegradedReason } from '../../../shared/environment-option.js';
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
  | { code: 'offline'; degradedReasons?: EnvironmentDegradedReason[] };

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
    const code: LaunchBlockedReason['code'] =
      option.freshness === 'offline' ? 'offline' : 'stale';
    const reason: LaunchBlockedReason = option.degradedReasons
      ? { code, degradedReasons: option.degradedReasons }
      : { code };
    return { kind: 'blocked', reason };
  }
  const result = await createSession(
    environmentToCreateSessionOptions(option, overrides)
  );
  return { kind: 'launched', result };
}
