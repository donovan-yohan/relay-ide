// Build the @mention palette's contact set (#1236, slice 4).
//
// v1 SOURCE = CLIENT-SIDE SYNTHESIS, no new server endpoint. Agent contacts are
// the vendor DEFAULT profiles synthesized from the channel roster the composer
// already fetches (`GET /channels/:id/roster`), each keyed on
// `builtInAgentProfileId(vendor)`. Human contacts come from the channel members
// the composer already receives. When a later slice adds custom-profile
// creation those rows slot in as `kind: 'profile'` with their own ids — this
// builder is the only place that changes.

import { builtInAgentProfileId } from '../../../../shared/agent-profile.js';
import {
  annotateMentionCollisions,
  type MentionContact,
} from '../../../../shared/mention-contacts.js';
import type { ChannelMemberRef } from '../../../../shared/channel-chat-protocol.js';
import type { RosterEntry } from '../api.js';

/**
 * Synthesize the palette contact set from the framework roster (vendor defaults)
 * plus human channel members, then annotate same-name collisions with a stable
 * local id token. Ordering: agents first (roster order), then humans.
 */
export function buildMentionContacts(
  roster: readonly RosterEntry[],
  members: readonly ChannelMemberRef[] = []
): MentionContact[] {
  const contacts: MentionContact[] = [];
  for (const framework of roster) {
    contacts.push({
      id: builtInAgentProfileId(framework.id),
      providerId: framework.id,
      displayName: framework.displayName,
      kind: 'vendor-default',
      owner: 'system',
      available: framework.available,
      reason: framework.reason,
      inChannel: true,
      isDefault: true,
      isBuiltIn: true,
    });
  }
  const seenHumans = new Set<string>();
  for (const member of members) {
    if (member.kind !== 'human') continue;
    if (seenHumans.has(member.id)) continue;
    seenHumans.add(member.id);
    const label = member.id.replace(/^human:/, '');
    contacts.push({
      id: member.id,
      providerId: 'human',
      displayName: label,
      kind: 'human',
      owner: '',
      available: true,
      reason: null,
      inChannel: true,
      isDefault: false,
      isBuiltIn: false,
    });
  }
  return annotateMentionCollisions(contacts);
}
