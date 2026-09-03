/**
 * Per-provider child-process env denylists — ONE definition each, read by both
 * seams that enforce them.
 *
 * There are two enforcement points for the same rule, and they used to be
 * written out separately:
 *  - spawn time, where an adapter builds the child env (`buildChildEnv`), and
 *  - profile time, where `sanitizeChannelAdapterProcessEnv` strips keys a named
 *    profile tried to set, reading `PROVIDER_DESCRIPTORS[...].launch
 *    .processEnvDenylist`.
 *
 * Two hand-maintained lists of the same keys is a drift bug waiting to happen:
 * a key added to the descriptor but not the spawn site is enforced against
 * profiles and silently inherited from the hub's own environment. Both sides
 * now read the constants below.
 *
 * This module exists rather than exporting from `index.ts` because adapters
 * cannot import `index.ts` — it imports every adapter, so that edge is a cycle.
 * It stays a leaf: constants only, no runtime imports beyond the shared
 * nesting set.
 */

import { AGENT_NESTING_STRIP_KEYS } from './adapter-utils.js';

/**
 * Compose a provider's full denylist: the universal nesting set plus whatever
 * that provider adds. Callers of `buildChildEnv` may pass just the extras (it
 * applies the nesting set itself); descriptor rows want the composed list,
 * because a profile must be blocked from setting either kind.
 */
function providerDenylist(...extra: readonly string[]): readonly string[] {
  return Object.freeze([...AGENT_NESTING_STRIP_KEYS, ...extra]);
}

/**
 * OpenCode's local API server reads these to decide its own auth. Letting a
 * profile — or the hub's environment — set them would either lock Relay out of
 * the server it just spawned or expose it under credentials Relay never chose.
 */
export const OPENCODE_EXTRA_ENV_DENYLIST = Object.freeze([
  'OPENCODE_SERVER_PASSWORD',
  'OPENCODE_SERVER_USERNAME',
]);

/** Composed denylists, one per provider, for `PROVIDER_DESCRIPTORS`. */
export const CLAUDE_ENV_DENYLIST = providerDenylist();
export const CODEX_ENV_DENYLIST = providerDenylist();
export const PI_AGENT_ENV_DENYLIST = providerDenylist();
export const PRIME_AGENT_ENV_DENYLIST = providerDenylist();
export const OPENCODE_ENV_DENYLIST = providerDenylist(
  ...OPENCODE_EXTRA_ENV_DENYLIST
);
export const ANTIGRAVITY_ENV_DENYLIST = providerDenylist();
/**
 * Nesting set only. `DEEPSEEK_API_KEY` and `DEEPSEEK_BASE_URL` are the ONLY way
 * a dsh channel runtime is credentialed, so a named profile must stay able to
 * set them.
 */
export const DSH_ENV_DENYLIST = providerDenylist();
/**
 * Nesting set only. `CURSOR_API_KEY` and `CURSOR_AUTH_TOKEN` must remain settable
 * per profile.
 */
export const CURSOR_ENV_DENYLIST = providerDenylist();
