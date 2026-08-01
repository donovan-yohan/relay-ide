// AgentProfile: the durable agent-kind Actor identity noun (#1233, epic #1232).
//
// An AgentProfile is a thin, per-hub overlay on a vendor framework
// (`server/types.ts` `AgentFramework` / `BUILTIN_FRAMEWORKS`), keyed on a stable
// profile id that is DISTINCT from the bare vendor id. `AgentProfile.id` IS the
// actor id populated into `WorkContextMessageActor.id` (`shared/work-context-message.ts`)
// and is an `'agent'`-kind actor per `WorkContextActorKind` (`shared/work-context.ts`).
//
// `@claude` / `@codex` become the DEFAULT profile of their vendor, not the only
// contact — users later add more profiles that share one `providerId`
// ("Backend Claude", "Reviewer Codex"). Exactly one profile per `providerId`
// carries `isDefault: true`.
//
// THIN OVERLAY: vendor facts (default label/glyph, command, args, model-env-var
// names) are NEVER copied onto a profile row. They are read from the framework
// catalog by `providerId` at use time. A built-in default profile therefore
// seeds with an EMPTY `displayName` ('') — the "inherit the vendor label from the
// catalog" sentinel — carrying no duplicated vendor prose.
//
// boundaryCheck (#1231): AgentProfile rows are local hub sqlite/config Actor rows.
// No Nostr keypair identity, no `community_id` scoping, no signed Persona Pack.

export const AGENT_PROFILE_SCHEMA_VERSION = 1 as const;

/**
 * Reference to an uploaded avatar blob. The avatar is a BLOB-REF ONLY in this
 * slice — DESIGN.md forbids rendering it here (no emoji, no inline image), so
 * this carries addressing metadata for a later rendering slice, never bytes.
 */
export interface AgentProfileAvatarRef {
  /** Content-addressed blob id (e.g. an uploaded attachment id). */
  id: string;
  sha256?: string;
  mediaType?: string;
  byteCount?: number;
}

/**
 * Who a profile responds to when @-mentioned. Advisory policy carried on the
 * profile; enforcement lives in later routing slices, not here.
 */
export type AgentProfileRespondTo = 'owner-only' | 'allowlist' | 'anyone';

export interface AgentProfile {
  /**
   * Stable actor id, distinct from the bare vendor id. IS the
   * `WorkContextMessageActor.id` for this agent. Built-in defaults use
   * `builtInAgentProfileId(providerId)`.
   */
  id: string;
  /** Framework catalog key (`AgentFramework.id`): claude/codex/opencode/hermes/custom. */
  providerId: string;
  /**
   * Free-form, possibly multi-word display name. EMPTY ('') on a built-in
   * default means "inherit the vendor label from the framework catalog by
   * `providerId`" — vendor facts are not duplicated onto the row.
   */
  displayName: string;
  /** Uploaded avatar blob-ref, or null. Never rendered in this slice. */
  avatar: AgentProfileAvatarRef | null;
  /** Optional launch-time system-prompt overlay text. */
  systemPrompt?: string;
  /** Optional model override (vendor-interpreted). */
  model?: string;
  /** Optional provider override (vendor-interpreted). */
  provider?: string;
  /** Optional reasoning-effort override (vendor-interpreted). */
  effort?: string;
  /** Optional extra environment variables applied at launch. */
  envVars?: Record<string, string>;
  /** Optional pool of alternate names this profile also answers to. */
  namePool?: string[];
  /** Optional respond-to policy (advisory in this slice). */
  respondTo?: AgentProfileRespondTo;
  /** Actor ids allowed when `respondTo === 'allowlist'`. */
  respondToAllowlist?: string[];
  /** Exactly one profile per `providerId` is the default. */
  isDefault: boolean;
  /** Seeded, non-user-authored profile. */
  isBuiltIn: boolean;
}

/**
 * Minimal contact shape the resolver / shim need. Accepts full `AgentProfile`
 * rows or any lighter list carrying these fields.
 */
export type AgentProfileContact = Pick<
  AgentProfile,
  'id' | 'providerId' | 'displayName' | 'isDefault' | 'isBuiltIn'
>;

/** Namespace prefix every profile Actor id carries. */
export const AGENT_PROFILE_ID_PREFIX = 'agent-profile:';

/** Stable id for the built-in default profile of a vendor. Distinct from `<vendor>`. */
export function builtInAgentProfileId(providerId: string): string {
  return `${AGENT_PROFILE_ID_PREFIX}${providerId}:default`;
}

/**
 * Vendor framework id embedded in a profile Actor id
 * (`agent-profile:<vendor>:default` | `agent-profile:<vendor>:<uuid>`), or
 * `null` for anything else. LAST-RESORT display fallback only: the authoritative
 * vendor is `ChannelSenderRef.providerId` / `AgentProfile.providerId`, and no
 * render path may derive a NAME from a profile id — the trailing segment is
 * `default` or a uuid, never a label (#1234).
 */
export function parseAgentProfileProviderId(
  profileActorId: string
): string | null {
  if (!profileActorId.startsWith(AGENT_PROFILE_ID_PREFIX)) return null;
  const vendor = profileActorId
    .slice(AGENT_PROFILE_ID_PREFIX.length)
    .split(':')[0];
  return vendor ? vendor : null;
}

/**
 * Normalize a mention token or display name for matching: strip a leading `@`,
 * lowercase, collapse internal whitespace, and trim. Case-insensitive matching
 * over free-form multi-word names hangs off this.
 */
export function normalizeMentionToken(token: string): string {
  return token.replace(/^@+/, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Deterministic collision tiebreak between two candidate profiles that matched
 * a mention equally (same normalized display name, or an equal-length prefix
 * match). Order: (1) default wins, (2) built-in wins, (3) lexicographically
 * smallest `id` wins. Returns the WINNER.
 */
function preferProfile(
  a: AgentProfileContact,
  b: AgentProfileContact
): AgentProfileContact {
  if (a.isDefault !== b.isDefault) return a.isDefault ? a : b;
  if (a.isBuiltIn !== b.isBuiltIn) return a.isBuiltIn ? a : b;
  return a.id <= b.id ? a : b;
}

/**
 * Resolve an @-mention token to a single profile.
 *
 * Resolution order:
 *  1. VENDOR ALIAS — if the normalized token exactly equals a `providerId` that
 *     has a default profile, return that default. `@claude` → the default claude
 *     profile. Vendor alias always wins over a same-named custom profile.
 *  2. NAMED, LONGEST-MATCH-FIRST, CASE-INSENSITIVE — over non-empty display
 *     names: a profile matches when its normalized display name equals the token
 *     OR is a whitespace-boundary prefix of the token (so "backend claude"
 *     matches "Backend Claude" even alongside a shorter "Backend"). The longest
 *     matching name wins; ties break via `preferProfile` (default > built-in >
 *     smallest id).
 *
 * Returns `null` when nothing matches. Built-in defaults carry an EMPTY display
 * name and so are never reachable via the named path — only via their vendor
 * alias — which is exactly why `@claude` keeps working while an unnamed default
 * never shadows a user-named profile.
 */
export function resolveProfileForMention<T extends AgentProfileContact>(
  token: string,
  contactSet: readonly T[]
): T | null {
  const norm = normalizeMentionToken(token);
  if (!norm) return null;

  // 1. Vendor alias → that vendor's default profile.
  let vendorDefault: T | null = null;
  for (const profile of contactSet) {
    if (profile.isDefault && profile.providerId.toLowerCase() === norm) {
      vendorDefault = vendorDefault
        ? (preferProfile(vendorDefault, profile) as T)
        : profile;
    }
  }
  if (vendorDefault) return vendorDefault;

  // 2. Named, longest-match-first, case-insensitive.
  let best: T | null = null;
  let bestLen = -1;
  for (const profile of contactSet) {
    const name = normalizeMentionToken(profile.displayName);
    if (!name) continue;
    const matches = norm === name || norm.startsWith(`${name} `);
    if (!matches) continue;
    if (name.length > bestLen) {
      best = profile;
      bestLen = name.length;
    } else if (name.length === bestLen && best) {
      best = preferProfile(best, profile) as T;
    }
  }
  return best;
}

/**
 * Delimiter separating a mention's display name from its short local
 * disambiguator token in inserted mention text (e.g. `@Reviewer#ab12cd`). Kept
 * as a shared const so the palette's insert-text writer and `parseMentions`
 * reader never drift.
 */
export const MENTION_DISAMBIGUATOR_DELIMITER = '#';

/** Alphanumeric-only, lowercased view of a local Actor id (for suffix slices). */
function alnumId(id: string): string {
  return id.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

/**
 * Assign each DISPLAY-NAME-colliding profile a SHORT, STABLE, GROUP-UNIQUE token
 * sliced from the TAIL of its local Actor id — never an npub / public key and
 * never a team/community directory lookup (boundaryCheck #1231). Only contacts
 * that share a normalized, NON-EMPTY display name get a token; unique names and
 * empty-name vendor defaults (reachable only via their vendor alias) are left
 * out. The slice length grows from 6 until every member of a collision group is
 * distinguishable, so the token is always both a genuine id suffix and
 * unambiguous within its group. Deterministic and input-order independent, so
 * the palette writer and `parseMentions` reader compute identical tokens from
 * the same contact set.
 */
export function computeMentionDisambiguators(
  contacts: readonly Pick<AgentProfileContact, 'id' | 'displayName'>[]
): Map<string, string> {
  const groups = new Map<
    string,
    Pick<AgentProfileContact, 'id' | 'displayName'>[]
  >();
  for (const contact of contacts) {
    const name = normalizeMentionToken(contact.displayName);
    if (!name) continue;
    const bucket = groups.get(name);
    if (bucket) bucket.push(contact);
    else groups.set(name, [contact]);
  }
  const tokens = new Map<string, string>();
  for (const bucket of groups.values()) {
    if (bucket.length < 2) continue;
    const maxLen = Math.max(6, ...bucket.map((c) => alnumId(c.id).length));
    let len = 6;
    for (; len <= maxLen; len++) {
      const seen = new Set<string>();
      let unique = true;
      for (const contact of bucket) {
        const slice = alnumId(contact.id).slice(-len);
        if (seen.has(slice)) {
          unique = false;
          break;
        }
        seen.add(slice);
      }
      if (unique) break;
    }
    for (const contact of bucket) {
      tokens.set(contact.id, alnumId(contact.id).slice(-len));
    }
  }
  return tokens;
}

const HISTORICAL_AGENT_SENDER_PREFIX = 'agent:';

/**
 * Extract the vendor framework id from a historical `agent:<framework>` sender
 * id. Returns `null` for anything that is not an `agent:<framework>` id (e.g.
 * `human:<id>`, `system`, or an already-profile-keyed id). Kept narrow: a bare
 * `agent:` with no framework, or a compound `agent:<a>:<b>` id, is not a legacy
 * framework sender and yields `null`.
 */
export function parseHistoricalAgentSenderProviderId(
  senderId: string
): string | null {
  if (!senderId.startsWith(HISTORICAL_AGENT_SENDER_PREFIX)) return null;
  const rest = senderId.slice(HISTORICAL_AGENT_SENDER_PREFIX.length);
  if (!rest || rest.includes(':') || rest.includes('/')) return null;
  return rest;
}

/**
 * READ-TIME SHIM (#1233): map a historical `agent:<framework>` sender id to that
 * vendor's DEFAULT profile id at read time. Pure resolution — it NEVER rewrites
 * stored rows. The destructive sender re-key lives in a later slice; this helper
 * is what that slice builds on.
 *
 * Returns the default profile id for the vendor, or `null` when the sender id is
 * not a legacy `agent:<framework>` id or the vendor has no default profile in
 * `contactSet`.
 */
export function resolveHistoricalAgentSenderProfileId(
  senderId: string,
  contactSet: readonly AgentProfileContact[]
): string | null {
  const providerId = parseHistoricalAgentSenderProviderId(senderId);
  if (!providerId) return null;
  const target = providerId.toLowerCase();
  let match: AgentProfileContact | null = null;
  for (const profile of contactSet) {
    if (profile.isDefault && profile.providerId.toLowerCase() === target) {
      match = match ? preferProfile(match, profile) : profile;
    }
  }
  return match ? match.id : null;
}

/** Runtime guard for a stored/parsed AgentProfile row. */
export function isAgentProfile(value: unknown): value is AgentProfile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  const isOptString = (x: unknown): boolean =>
    x === undefined || typeof x === 'string';
  const isOptStringArray = (x: unknown): boolean =>
    x === undefined ||
    (Array.isArray(x) && x.every((i) => typeof i === 'string'));
  const avatarOk =
    v.avatar === null ||
    (typeof v.avatar === 'object' &&
      v.avatar !== null &&
      typeof (v.avatar as Record<string, unknown>).id === 'string');
  const envVarsOk =
    v.envVars === undefined ||
    (typeof v.envVars === 'object' &&
      v.envVars !== null &&
      !Array.isArray(v.envVars) &&
      Object.values(v.envVars as Record<string, unknown>).every(
        (x) => typeof x === 'string'
      ));
  const respondToOk =
    v.respondTo === undefined ||
    v.respondTo === 'owner-only' ||
    v.respondTo === 'allowlist' ||
    v.respondTo === 'anyone';
  return (
    typeof v.id === 'string' &&
    v.id.length > 0 &&
    typeof v.providerId === 'string' &&
    v.providerId.length > 0 &&
    typeof v.displayName === 'string' &&
    avatarOk &&
    isOptString(v.systemPrompt) &&
    isOptString(v.model) &&
    isOptString(v.provider) &&
    isOptString(v.effort) &&
    envVarsOk &&
    isOptStringArray(v.namePool) &&
    respondToOk &&
    isOptStringArray(v.respondToAllowlist) &&
    typeof v.isDefault === 'boolean' &&
    typeof v.isBuiltIn === 'boolean'
  );
}
