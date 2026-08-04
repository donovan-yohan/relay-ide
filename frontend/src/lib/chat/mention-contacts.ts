// Build the @mention palette's contact set (#1236, slice 4).
//
// Agent contacts arrive as durable profile rows from the channel roster; human
// contacts come from the channel members the composer already receives.
import {
  annotateMentionCollisions,
  type MentionContact,
} from '../../../../shared/mention-contacts.js';
import type { ChannelMemberRef } from '../../../../shared/channel-chat-protocol.js';
import type { RosterEntry } from '../api.js';

/**
 * Build the palette contact set from the profile roster plus human channel
 * members, then annotate same-name collisions with a stable
 * local id token. Ordering: agents first (roster order), then humans.
 */
export function buildMentionContacts(
  roster: readonly RosterEntry[],
  members: readonly ChannelMemberRef[] = []
): MentionContact[] {
  const contacts: MentionContact[] = [];
  for (const profile of roster) {
    contacts.push({
      id: profile.id,
      providerId: profile.providerId,
      displayName: profile.displayName,
      kind:
        profile.isDefault && profile.isBuiltIn ? 'vendor-default' : 'profile',
      owner: profile.isBuiltIn ? 'system' : 'user',
      available: profile.available,
      reason: profile.reason,
      inChannel: true,
      isDefault: profile.isDefault,
      isBuiltIn: profile.isBuiltIn,
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
