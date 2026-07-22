// Relay-native agent avatar (#1235, epic #1232). A three-tier fallback badge
// over the SINGLE identity renderer (`resolveSenderIdentity`) — never a second
// identity/color system.
//
// Fallback order (issue #1235 scope): (a) uploaded image blob →
// (b) initials-on-hash-color → (c) vendor SVG glyph (reuse `AgentBadge`).
//
// COLOR is sourced from the caller's resolved `SenderIdentity.colorVar`, which
// already encodes the #1234 re-key contract: a vendor's DEFAULT profile keeps
// its curated `var(--sender-<vendor>)` token, non-default profiles hash on their
// Actor id via `deriveColor` over the 12-color palette. The avatar therefore
// NEVER overrides `@claude`'s established sender color. INITIALS carry identity
// (distinct per profile by construction); color is decorative.
//
// DESIGN.md (hard): 2px badge radius at ≤24px (the zero-radius exception), 0
// above; outline treatment; presence is a 50% (circular) status dot. No emoji,
// no Radix, no animation/lottie, no blur-up progressive image.
//
// boundaryCheck (#1231): the image tier renders a locally-resolved blob URL for
// an uploaded hub-storage avatar — no emoji-avatar generator, no animated
// avatars, no Nostr kind-0 picture events.
import React from 'react';
import { AgentBadge } from '../AgentBadge.js';
import type { SenderIdentity } from '../../lib/chat/sender-identity.js';
import type { AgentProfileAvatarRef } from '../../../../shared/agent-profile.js';
import './AgentAvatar.css';

/** Presence maps to a 50%-radius status dot — the only circular chrome allowed. */
export type AgentAvatarPresence = 'online' | 'busy' | 'offline';

/**
 * Reduce a display label to 1–2 uppercase initials. Multi-word labels take the
 * first letter of the first two words ("Backend Claude" → "BC"); a single token
 * takes its first two alphanumerics ("claude" → "CL"). Returns '' when the label
 * carries no letters/digits, so the caller drops to the vendor-glyph tier.
 */
export function avatarInitials(label: string): string {
  const cleaned = label.trim();
  if (!cleaned) return '';
  const words = cleaned.split(/[\s._/\\-]+/).filter(Boolean);
  const alnum = (word: string): string => word.replace(/[^\p{L}\p{N}]/gu, '');
  if (words.length >= 2) {
    const initials = `${alnum(words[0]!).slice(0, 1)}${alnum(words[1]!).slice(0, 1)}`;
    if (initials) return initials.toUpperCase();
  }
  return alnum(words[0] ?? '')
    .slice(0, 2)
    .toUpperCase();
}

export type AgentAvatarTier = 'image' | 'initials' | 'glyph';

export interface AgentAvatarProps {
  /** Single identity source (color + glyph). Defaults keep `var(--sender-<vendor>)`. */
  identity: SenderIdentity;
  /** Display label the initials derive from. Defaults to `identity.label`. */
  name?: string;
  /** Tier 1: resolved uploaded-avatar image URL (object/data URL). */
  imageUrl?: string | null;
  /** Tier-1 blob-ref metadata (addressing only; bytes are resolved by the caller). */
  avatar?: AgentProfileAvatarRef | null;
  /** Square px size. 2px badge radius at ≤24, 0 above (DESIGN.md). Default 24. */
  size?: number;
  /** Presence → 50% status dot; null/undefined hides it. */
  presence?: AgentAvatarPresence | null;
  /** Accessible label override (defaults to the display label). */
  title?: string;
  className?: string;
}

const DEFAULT_SIZE = 24;

/** Resolve the tier deterministically from the inputs — pure, testable. */
export function resolveAvatarTier(input: {
  imageUrl?: string | null | undefined;
  initials: string;
}): AgentAvatarTier {
  if (input.imageUrl) return 'image';
  if (input.initials) return 'initials';
  return 'glyph';
}

export const AgentAvatar: React.FC<AgentAvatarProps> = ({
  identity,
  name,
  imageUrl,
  avatar,
  size = DEFAULT_SIZE,
  presence,
  title,
  className,
}) => {
  const label = (name ?? identity.label ?? '').trim();
  const initials = avatarInitials(label);
  const tier = resolveAvatarTier({ imageUrl, initials });
  const accessibleName = title ?? (label || 'agent avatar');
  // 2px optical-correction radius at ≤24px; hard zero above (DESIGN.md §Layout).
  const radius = size <= 24 ? 2 : 0;
  const rootStyle: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: radius,
    fontSize: Math.max(7, Math.round(size * 0.42)),
    // The identity color drives the outline ring + tier fills via one custom prop.
    ['--agent-avatar-color' as string]: identity.colorVar,
  };
  const classes = ['agent-avatar', `agent-avatar--${tier}`, className]
    .filter(Boolean)
    .join(' ');

  return (
    <span
      className={classes}
      style={rootStyle}
      role="img"
      aria-label={accessibleName}
      data-tier={tier}
    >
      <span className="agent-avatar__frame">
        {tier === 'image' ? (
          // No blur-up/progressive placeholder, no transition — DESIGN.md forbids it.
          <img
            className="agent-avatar__image"
            src={imageUrl ?? undefined}
            alt=""
            aria-hidden="true"
            draggable={false}
            {...(avatar?.mediaType
              ? { 'data-media-type': avatar.mediaType }
              : {})}
          />
        ) : tier === 'initials' ? (
          <span
            className="agent-avatar__initials"
            style={{ background: identity.colorVar }}
            aria-hidden="true"
          >
            {initials}
          </span>
        ) : (
          <span
            className="agent-avatar__glyph"
            style={{ color: identity.colorVar }}
            aria-hidden="true"
          >
            <AgentBadge agent={identity.glyph ?? ''} />
          </span>
        )}
      </span>
      {presence ? (
        <span
          className={`agent-avatar__presence agent-avatar__presence--${presence}`}
          aria-hidden="true"
        />
      ) : null}
    </span>
  );
};

export default AgentAvatar;
