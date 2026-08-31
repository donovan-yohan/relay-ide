// Long-lived per-profile actor credential contract (#1455 slice 3).
//
// Slice 3 gives every agent profile — a Hermes profile in particular, but any
// gateway-kind agent qualifies — ONE durable, revocable Relay credential bound
// to that profile's Actor id. The credential authenticates; hub-authoritative
// channel membership (#1455 slices 1-2) authorizes. See
// `docs/SECURITY_POLICY.md` § Agent-profile actor credentials.
//
// The token itself appears exactly once, in the mint response. Nothing stores
// it: the hub keeps a SHA-256 hash and compares like an API key, so a status
// read can never hand it back and a stolen database cannot replay it.

/** Lifecycle state of a profile's credential, derived from the stored row. */
export type AgentProfileCredentialState = 'active' | 'revoked' | 'expired';

/**
 * Token-free credential status. Every field here is safe to render, log, and
 * return on a read; the secret is deliberately not representable.
 */
export interface AgentProfileCredentialStatus {
  /** The agent profile this credential belongs to. */
  profileId: string;
  credentialId: string;
  /**
   * The Actor id the hub attributes this credential's posts to — always the
   * profile's own id, server-derived at mint and never caller-supplied.
   */
  actorId: string;
  capabilities: string[];
  issuedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
  /**
   * Last successful gateway authentication, coarsened to
   * `AGENT_PROFILE_CREDENTIAL_LAST_USED_GRANULARITY_MS`. `null` until the
   * credential is first used.
   */
  lastUsedAt: string | null;
  state: AgentProfileCredentialState;
}

/** Mint response. `token` is shown ONCE and is never retrievable afterwards. */
export interface AgentProfileCredentialMintResult {
  credential: AgentProfileCredentialStatus;
  token: string;
}

/**
 * Capability set every profile credential carries: the proven
 * channel-participation triple (#1242, verified live). Deliberately fixed
 * rather than caller-chosen — a mint surface that takes a capability list is a
 * privilege-escalation surface, and no profile has ever needed more.
 */
export const AGENT_PROFILE_CREDENTIAL_CAPABILITIES = [
  'session:read',
  'context:read',
  'context:write',
] as const;

/**
 * Write granularity for `lastUsedAt`.
 *
 * Every authenticated gateway request would otherwise be a SQLite write on the
 * request path. One write per credential per minute keeps "has this agent ever
 * used its credential, and roughly when" answerable without putting synchronous
 * database work behind every call (the shape that hurt in #1249).
 */
export const AGENT_PROFILE_CREDENTIAL_LAST_USED_GRANULARITY_MS = 60_000;

/** Derive the display state of a stored credential row at `now`. */
export function agentProfileCredentialState(
  input: { revokedAt: string | null; expiresAt: string },
  now: number = Date.now()
): AgentProfileCredentialState {
  if (input.revokedAt) return 'revoked';
  return new Date(input.expiresAt).getTime() <= now ? 'expired' : 'active';
}
