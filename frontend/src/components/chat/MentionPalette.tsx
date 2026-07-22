import React from 'react';
import './MentionPalette.css';
import type { RosterEntry } from '../../lib/api.js';
import { builtInAgentProfileId } from '../../../../shared/agent-profile.js';
import { resolveSenderIdentity } from '../../lib/chat/sender-identity.js';
import { AgentBadge } from '../AgentBadge.js';

/**
 * Prefix-filter the channel roster by `id`/`displayName` (case-insensitive).
 * Unavailable entries are intentionally KEPT — they render greyed and
 * non-selectable so the operator can see who is in the channel but currently
 * unroutable (and why, via the `reason` tooltip). Empty query returns all rows.
 */
export function filterRoster(
  roster: RosterEntry[],
  query: string
): RosterEntry[] {
  const q = query.toLowerCase();
  if (q.length === 0) return roster;
  return roster.filter(
    (entry) =>
      entry.id.toLowerCase().startsWith(q) ||
      entry.displayName.toLowerCase().startsWith(q)
  );
}

interface MentionPaletteProps {
  entries: RosterEntry[];
  activeIndex: number;
  visible: boolean;
}

/**
 * Presentational `@mention` palette. Keyboard navigation lives in the parent
 * (ChannelComposer), mirroring SlashPalette. Selecting an available row inserts
 * plain `@<id> ` text — no rich pill. Unavailable rows are greyed, carry
 * `aria-disabled` + the `reason` as their `title`, and are never selectable.
 */
export const MentionPalette: React.FC<MentionPaletteProps> = ({
  entries,
  activeIndex,
  visible,
}) => {
  return (
    <div
      className="mention-palette"
      role="listbox"
      aria-label="agents"
      style={{ display: visible ? undefined : 'none' }}
    >
      {entries.map((entry, index) => {
        const identity = resolveSenderIdentity({
          kind: 'agent',
          // Roster entries are vendors, i.e. their DEFAULT profile — key on the
          // profile Actor id so the palette keeps the curated vendor token (#1234).
          id: builtInAgentProfileId(entry.id),
          providerId: entry.id,
          displayName: entry.displayName,
        });
        const active = index === activeIndex;
        const unavailable = !entry.available;
        const rowClass = [
          'mention-palette__row',
          active ? 'mention-palette__row--active' : null,
          unavailable ? 'mention-palette__row--unavailable' : null,
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <div
            key={entry.id}
            className={rowClass}
            role="option"
            aria-selected={active}
            {...(unavailable ? { 'aria-disabled': true } : {})}
            {...(unavailable && entry.reason ? { title: entry.reason } : {})}
          >
            <span
              className="mention-palette__glyph"
              style={unavailable ? undefined : { color: identity.colorVar }}
              aria-hidden="true"
            >
              {identity.glyph ? <AgentBadge agent={identity.glyph} /> : '@'}
            </span>
            <span
              className="mention-palette__name"
              style={unavailable ? undefined : { color: identity.colorVar }}
            >
              {entry.displayName}
            </span>
            <span className="mention-palette__id">@{entry.id}</span>
            {unavailable && entry.reason ? (
              <span className="mention-palette__reason">{entry.reason}</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
};

export default MentionPalette;
