import React from 'react';
import './MentionPalette.css';
import {
  type MentionContact,
  type MentionContactKind,
  isMentionContactSelectable,
  mentionInsertText,
} from '../../../../shared/mention-contacts.js';
import { resolveSenderIdentity } from '../../lib/chat/sender-identity.js';
import { AgentBadge } from '../AgentBadge.js';

/** Human-facing kind label — FZF/`>`-palette vocabulary, lowercase, no badge chrome. */
const KIND_LABEL: Record<MentionContactKind, string> = {
  profile: 'profile',
  'vendor-default': 'vendor',
  human: 'human',
};

/** Flat monochrome line icon for a human contact (DESIGN.md: SVG line icons, no emoji). */
function HumanGlyph(): React.ReactElement {
  return (
    <svg
      className="agent-badge"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" />
    </svg>
  );
}

interface MentionPaletteProps {
  contacts: MentionContact[];
  activeIndex: number;
  visible: boolean;
}

/**
 * Presentational profile-aware `@mention` palette. Keyboard navigation lives in
 * the parent (ChannelComposer), mirroring SlashPalette. Selecting a selectable
 * row inserts the contact's plain mention text — no rich pill. Inert rows
 * (unavailable, or not a channel member) render greyed, carry `aria-disabled`,
 * and are never selectable.
 */
export const MentionPalette: React.FC<MentionPaletteProps> = ({
  contacts,
  activeIndex,
  visible,
}) => {
  return (
    <div
      className="mention-palette"
      role="listbox"
      // Accessible name is the stable `agents` contract the composer e2e locates
      // (`getByRole('listbox', { name: 'agents' })`). The set now also carries
      // humans/custom profiles (#1236), but the palette's addressable-agents
      // identity — and the test/a11y name — stays `agents`; renaming it silently
      // broke the mention e2e once already.
      aria-label="agents"
      style={{ display: visible ? undefined : 'none' }}
    >
      {contacts.map((contact, index) => {
        const isAgent = contact.kind !== 'human';
        const identity = isAgent
          ? resolveSenderIdentity({
              kind: 'agent',
              // Contacts already carry the re-keyed profile Actor id (#1234):
              // a vendor default is `builtInAgentProfileId(vendor)`, a custom
              // profile its own id. Pass it straight through — the single id
              // scheme keeps default profiles on the curated `var(--sender-*)`
              // token and hashes non-defaults, with no `agent:<vendor>` re-map.
              id: contact.id,
              providerId: contact.providerId,
              displayName: contact.displayName,
            })
          : null;
        const active = index === activeIndex;
        const selectable = isMentionContactSelectable(contact);
        const inert = !selectable;
        const notInChannel = !contact.inChannel;
        const title = !contact.available
          ? (contact.reason ?? undefined)
          : notInChannel
            ? 'not a member of this channel'
            : undefined;
        const rowClass = [
          'mention-palette__row',
          active && selectable ? 'mention-palette__row--active' : null,
          inert ? 'mention-palette__row--inert' : null,
        ]
          .filter(Boolean)
          .join(' ');
        const glyphColor =
          inert || !identity ? undefined : { color: identity.colorVar };
        return (
          <div
            key={contact.id}
            className={rowClass}
            role="option"
            aria-selected={active}
            {...(inert ? { 'aria-disabled': true } : {})}
            {...(title ? { title } : {})}
          >
            <div className="mention-palette__main">
              <span
                className="mention-palette__glyph"
                style={glyphColor}
                aria-hidden="true"
              >
                {identity ? (
                  <AgentBadge agent={identity.glyph ?? contact.providerId} />
                ) : (
                  <HumanGlyph />
                )}
              </span>
              <span
                className="mention-palette__name"
                style={
                  inert || !identity ? undefined : { color: identity.colorVar }
                }
              >
                {contact.displayName}
              </span>
              {contact.disambiguator ? (
                <span
                  className="mention-palette__disambiguator"
                  aria-label="local id"
                >
                  {contact.disambiguator}
                </span>
              ) : null}
              <span className="mention-palette__kind">
                {KIND_LABEL[contact.kind]}
              </span>
              {contact.owner ? (
                <span className="mention-palette__owner">{contact.owner}</span>
              ) : null}
              <span className="mention-palette__id">
                {mentionInsertText(contact)}
              </span>
            </div>
            {notInChannel ? (
              <span className="mention-palette__state">not in channel</span>
            ) : !contact.available && contact.reason ? (
              <span className="mention-palette__state">{contact.reason}</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
};

export default MentionPalette;
