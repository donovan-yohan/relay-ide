// Profile-aware @mention contact set (#1236, epic #1232, slice 4).
//
// The @mention palette resolves against a CONTACT SET, not a bare vendor list.
// A contact is one addressable participant: a custom AgentProfile, a vendor
// DEFAULT profile (`agent-profile:<vendor>:default`), or a human channel member.
// The set is profile-aware and collision-ready today even though the only live
// agent contacts are vendor defaults synthesized from the framework list — when
// a later slice adds custom-profile creation, those rows slot in as `kind:
// 'profile'` with their own ids and no other machinery changes.
//
// boundaryCheck (#1231): every id here is a LOCAL hub Actor id. The collision
// disambiguator is a slice of that local id — never an npub / public key, never
// a team/community directory handle.

import {
  computeMentionDisambiguators,
  normalizeMentionToken,
  resolveProfileForMention,
  MENTION_DISAMBIGUATOR_DELIMITER,
  type AgentProfileContact,
} from './agent-profile.js';

/**
 * `profile` = user-authored custom profile (a later slice); `vendor-default` =
 * the built-in default profile of a configured framework; `human` = a human
 * channel member.
 */
export type MentionContactKind = 'profile' | 'vendor-default' | 'human';

/** One addressable @mention candidate rendered in the palette + fed to resolution. */
export interface MentionContact {
  /** Local Actor id — the value `parseMentions` writes into `ChannelMention.profileId`. */
  id: string;
  /** Vendor framework id for agents, `'human'` for humans. */
  providerId: string;
  /** Free-form, possibly multi-word display label shown in the palette. */
  displayName: string;
  kind: MentionContactKind;
  /** Owner label: `'system'` for a built-in vendor default; owner for a custom profile. */
  owner: string;
  /** Routable right now (vendor availability). Unavailable rows render inert. */
  available: boolean;
  /** Why unavailable, when `available` is false. */
  reason: string | null;
  /** Member of THIS channel. Non-members render a "not in channel" affordance. */
  inChannel: boolean;
  /** Vendor default of its `providerId` (drives the `@<vendor>` alias). */
  isDefault: boolean;
  /** Seeded, non-user-authored. */
  isBuiltIn: boolean;
  /** Short stable local-id token, present only when a display name collides. */
  disambiguator?: string;
}

/**
 * Resolver-facing view of a contact set. Vendor defaults are collapsed to an
 * EMPTY display name so they are reachable ONLY via their vendor alias
 * (`@claude`), never by their catalog label — mirroring the keystone contract
 * (`shared/agent-profile.ts`) so a user-named profile is never shadowed by a
 * vendor default in the longest-match path.
 */
export function toResolverContacts(
  contacts: readonly MentionContact[]
): AgentProfileContact[] {
  return contacts.map((contact) => ({
    id: contact.id,
    providerId: contact.providerId,
    displayName: contact.kind === 'vendor-default' ? '' : contact.displayName,
    isDefault: contact.isDefault,
    isBuiltIn: contact.isBuiltIn,
  }));
}

/**
 * Stamp a stable local disambiguator token onto every contact whose display
 * name collides with another's. Computed over the resolver view so the tokens
 * match exactly what `parseMentions` recomputes at read time.
 */
export function annotateMentionCollisions(
  contacts: readonly MentionContact[]
): MentionContact[] {
  const tokens = computeMentionDisambiguators(toResolverContacts(contacts));
  return contacts.map((contact) => {
    const token = tokens.get(contact.id);
    return token ? { ...contact, disambiguator: token } : contact;
  });
}

/**
 * The EXACT text the palette inserts for a picked contact. Round-trips through
 * `parseMentions` back to `contact.id`:
 *  - vendor default → `@<vendorId>` (unambiguous vendor alias),
 *  - colliding name → `@<displayName>#<token>`,
 *  - otherwise      → `@<displayName>`.
 */
export function mentionInsertText(contact: MentionContact): string {
  if (contact.kind === 'vendor-default') return `@${contact.providerId}`;
  if (contact.disambiguator) {
    return `@${contact.displayName}${MENTION_DISAMBIGUATOR_DELIMITER}${contact.disambiguator}`;
  }
  return `@${contact.displayName}`;
}

/** A contact is pickable only when routable AND a member of the channel. */
export function isMentionContactSelectable(contact: MentionContact): boolean {
  return contact.available && contact.inChannel;
}

/**
 * Case-insensitive prefix filter over display name, vendor id, and the local-id
 * disambiguator token. Unavailable / not-in-channel contacts are intentionally
 * KEPT (they render inert) so the operator still sees who exists. Empty query
 * returns the whole set.
 */
export function filterMentionContacts(
  contacts: readonly MentionContact[],
  query: string
): MentionContact[] {
  const q = query.toLowerCase();
  if (q.length === 0) return [...contacts];
  return contacts.filter(
    (contact) =>
      contact.displayName.toLowerCase().startsWith(q) ||
      contact.providerId.toLowerCase().startsWith(q) ||
      (contact.disambiguator !== undefined &&
        contact.disambiguator.startsWith(q))
  );
}

/**
 * Resolve a single token (as typed, e.g. `@Backend Claude`) against a contact
 * set to its resolved contact, delegating to the keystone
 * `resolveProfileForMention` for the vendor-alias + longest-match + tiebreak
 * rules. Convenience for callers that hold `MentionContact[]` rather than the
 * resolver shape; returns the original `MentionContact` (not the resolver view).
 */
export function resolveMentionContact(
  token: string,
  contacts: readonly MentionContact[]
): MentionContact | null {
  const resolverContacts = toResolverContacts(contacts);
  const resolved = resolveProfileForMention(token, resolverContacts);
  if (!resolved) return null;
  return contacts.find((contact) => contact.id === resolved.id) ?? null;
}

// Re-exported so palette / composer code has one import site for mention wiring.
export { normalizeMentionToken, MENTION_DISAMBIGUATOR_DELIMITER };
