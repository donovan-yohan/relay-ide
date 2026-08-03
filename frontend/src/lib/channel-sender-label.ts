import { parseAgentProfileProviderId } from '../../../shared/agent-profile.js';

/**
 * Canonical sender id for a browser-authored channel post
 * (`channel-chat-router` `deriveSender`).
 */
export const CURRENT_OPERATOR_SENDER_ID = 'human:operator';

/** The three sender fields every channel row shape carries. */
export interface ChannelSenderLabelFields {
  senderId: string;
  senderDisplayName?: string | undefined;
  providerId?: string | undefined;
}

/**
 * Short sender label for a compact row (rail snippet, search hit, palette
 * sublabel).
 *
 * Lifted out of `TopicSidebarShell` (#1308 slice 2 item 3) because the command
 * palette now renders message-search hits too, and a second copy of this
 * precedence would be free to drift into labelling an agent `default`.
 *
 * NEVER derived by splitting `senderId`: an agent's id is its profile Actor id
 * (`agent-profile:<vendor>:default`, or `agent-profile:<vendor>:<uuid>` for a
 * custom profile), so the trailing segment is `default`/a uuid, not a name
 * (#1234, `shared/channel-chat-protocol.ts`). Read the server-resolved
 * `senderDisplayName`, then `providerId`, and only then fall back to the vendor
 * segment of a profile id / the name half of a `human:<actorId>` ref.
 */
export function senderShortLabel(sender: ChannelSenderLabelFields): string {
  if (sender.senderId === CURRENT_OPERATOR_SENDER_ID) return 'you';
  const label =
    sender.senderDisplayName?.trim() ||
    sender.providerId?.trim() ||
    senderLabelFromId(sender.senderId);
  return label === 'operator' ? 'you' : label;
}

/** Last-resort label for a sender id with no server-resolved name/vendor. */
export function senderLabelFromId(senderId: string): string {
  // CLI-gateway actor rows are `agent:<actorId>` where the actor id may itself
  // be a profile id (`deriveSender`), so unwrap that prefix first.
  const withoutAgentPrefix = senderId.startsWith('agent:')
    ? senderId.slice('agent:'.length)
    : senderId;
  // `agent-profile:<vendor>:<rest>` — the VENDOR segment names the sender; the
  // trailing segment is `default` or a uuid.
  const vendor = parseAgentProfileProviderId(withoutAgentPrefix);
  if (vendor) return vendor;
  const separator = withoutAgentPrefix.indexOf(':');
  return separator === -1
    ? withoutAgentPrefix
    : withoutAgentPrefix.slice(separator + 1);
}
