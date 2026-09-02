// Sender identity visual system for the channel timeline (#1166, re-keyed #1234).
//
// Resolves a `ChannelSenderRef` to a stable color / glyph / label. Human is
// always "you" (right-aligned bubble, no name chrome). `providerId` is ALWAYS
// read from the explicit `ChannelSenderRef.providerId` field — never derived by
// stripping `agent:` off the id, because `id` is now a profile Actor id
// (`agent-profile:<vendor>:default` for a vendor's built-in default), not
// `agent:<framework>` (#1234).
//
// Color re-key (#1234): a vendor's DEFAULT profile keeps its curated
// `var(--sender-<vendor>)` DESIGN.md token; only NON-default profiles hash via
// `deriveColor(profileActorId)` over the 12-color palette, so two profiles of one
// vendor render distinct colors while SHARING the vendor glyph. The profile
// name/initials carry identity by construction; color is decorative. Reused
// verbatim by the @mention palette, sidebar DM dot, and streaming/presence chip —
// do not fork.
import type { ChannelSenderRef } from '../../../../shared/channel-chat-protocol.js';
import {
  builtInAgentProfileId,
  parseHistoricalAgentSenderProviderId,
} from '../../../../shared/agent-profile.js';
import { deriveColor } from '../colors.js';

export type KnownAgentGlyph =
  | 'claude'
  | 'codex'
  | 'hermes'
  | 'opencode'
  | 'prime-agent'
  | 'pi'
  | 'antigravity'
  | 'dsh';

export interface SenderIdentity {
  /** Display label — human is always 'you'. */
  label: string;
  /** CSS color value: a `var(--sender-*)` custom property, or a hash-derived hex. */
  colorVar: string;
  /** AgentBadge glyph id, or null for human/system (no glyph). */
  glyph: KnownAgentGlyph | null;
  kind: 'human' | 'agent' | 'system';
}

const KNOWN_AGENT_COLOR_VAR: Record<string, string> = {
  claude: '--sender-claude',
  codex: '--sender-codex',
  hermes: '--sender-hermes',
  opencode: '--sender-opencode',
  'prime-agent': '--sender-prime-agent',
  pi: '--sender-pi',
  antigravity: '--sender-antigravity',
  dsh: '--sender-dsh',
};

const KNOWN_AGENT_GLYPHS: readonly KnownAgentGlyph[] = [
  'claude',
  'codex',
  'hermes',
  'opencode',
  'prime-agent',
  'pi',
  'antigravity',
  'dsh',
];

function isKnownGlyph(value: string): value is KnownAgentGlyph {
  return (KNOWN_AGENT_GLYPHS as readonly string[]).includes(value);
}

/**
 * Effective RENDER id for a sender (#1245). Channel rows persisted BEFORE the
 * #1234 attribution re-key carry the bare `agent:<vendor>` sender id, while the
 * re-key stamps new agent rows with the profile Actor id
 * (`builtInAgentProfileId(vendor)` for a vendor's built-in default). Reading a
 * legacy row back verbatim would drop it from its curated `var(--sender-<vendor>)`
 * color (the default-profile check below keys on the profile id) and split it
 * from new `agent-profile:<vendor>:default` rows in timeline grouping.
 *
 * Map a legacy `agent:<vendor>` id to that vendor's built-in default profile id
 * for RENDER decisions only — color here and the grouping key in
 * `channel-timeline-layout.ts`. This is deliberately NOT a store/wire mutation:
 * the CLI-gateway actor lane (`channel-chat-router.ts` `deriveSender`) also
 * emits `agent:<actorId>` on the wire and that attribution must stay byte-exact,
 * so the heal lives at the render boundary instead of `rowToMessage`. Only
 * re-maps when the parsed vendor equals the authoritative `providerId` (a true
 * legacy vendor-default row); already-migrated `agent-profile:*`, human, and
 * system ids pass through unchanged.
 */
export function resolveRenderSenderId(sender: ChannelSenderRef): string {
  if (sender.kind !== 'agent') return sender.id;
  const providerId = sender.providerId ?? '';
  if (providerId === '') return sender.id;
  const legacyVendor = parseHistoricalAgentSenderProviderId(sender.id);
  if (legacyVendor === null || legacyVendor !== providerId) return sender.id;
  return builtInAgentProfileId(providerId);
}

export function resolveSenderIdentity(
  sender: ChannelSenderRef
): SenderIdentity {
  if (sender.kind === 'human') {
    return {
      label: sender.displayName ?? 'you',
      colorVar: 'var(--text)',
      glyph: null,
      kind: 'human',
    };
  }
  if (sender.kind === 'system') {
    return {
      label: 'system',
      colorVar: 'var(--sender-system)',
      glyph: null,
      kind: 'system',
    };
  }
  // providerId is authoritative from the explicit field — never from the id.
  const providerId = sender.providerId ?? '';
  // Heal legacy `agent:<vendor>` rows to the vendor built-in default id for the
  // color decision (#1245) without touching the wire id.
  const renderId = resolveRenderSenderId(sender);
  // A DEFAULT (built-in) profile's id is exactly `agent-profile:<vendor>:default`.
  // Only then does it keep the curated vendor token; every non-default profile
  // hashes on its own Actor id so same-vendor profiles are visually distinct.
  const isDefaultProfile =
    providerId !== '' && renderId === builtInAgentProfileId(providerId);
  const knownVar = KNOWN_AGENT_COLOR_VAR[providerId];
  const colorVar =
    isDefaultProfile && knownVar ? `var(${knownVar})` : deriveColor(renderId);
  // The vendor glyph is shared across all of a vendor's profiles (default or not).
  const glyph = isKnownGlyph(providerId) ? providerId : null;
  return {
    label: sender.displayName ?? providerId,
    colorVar,
    glyph,
    kind: 'agent',
  };
}
