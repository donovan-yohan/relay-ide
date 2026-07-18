// Sender identity visual system for the channel timeline (#1166).
//
// Resolves a `ChannelSenderRef` to a stable color / glyph / label. Human is
// always "you" (right-aligned bubble, no name chrome). Known agent frameworks
// map to fixed CSS custom properties (defined in App.css, each reusing an
// existing DESIGN.md identity token — no invented hex values); long-tail custom
// providers fall back to the existing hash-based `deriveColor`. Reused verbatim
// by the future @mention pill (#1167) and sidebar presence dot — do not fork.
import type { ChannelSenderRef } from '../../../../shared/channel-chat-protocol.js';
import { deriveColor } from '../colors.js';

export type KnownAgentGlyph = 'claude' | 'codex' | 'hermes' | 'opencode';

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
};

const KNOWN_AGENT_GLYPHS: readonly KnownAgentGlyph[] = [
  'claude',
  'codex',
  'hermes',
  'opencode',
];

function isKnownGlyph(value: string): value is KnownAgentGlyph {
  return (KNOWN_AGENT_GLYPHS as readonly string[]).includes(value);
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
  const providerId = sender.providerId ?? sender.id.replace(/^agent:/, '');
  const knownVar = KNOWN_AGENT_COLOR_VAR[providerId];
  const colorVar = knownVar
    ? `var(${knownVar})`
    : deriveColor(`sender:agent:${providerId}`);
  const glyph = isKnownGlyph(providerId) ? providerId : null;
  return {
    label: sender.displayName ?? providerId,
    colorVar,
    glyph,
    kind: 'agent',
  };
}
