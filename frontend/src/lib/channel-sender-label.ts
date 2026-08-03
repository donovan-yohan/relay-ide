import { parseAgentProfileProviderId } from '../../../shared/agent-profile.js';
import { parseMentions } from '../../../shared/channel-chat-protocol.js';

/**
 * Canonical sender id for a browser-authored channel post
 * (`channel-chat-router` `deriveSender`).
 */
export const CURRENT_OPERATOR_SENDER_ID = 'human:operator';

/**
 * The one mention token that addresses the human operator.
 *
 * VERIFIED (#1308 slice 5): `parseMentions` resolves mentions against an
 * AGENT-PROFILE contact set only — there is no human contact, no
 * `profileId`/`providerId` a human can carry, and no server-side operator
 * mention target. `@operator` therefore lands as an UNRESOLVED mention ref
 * (`{ raw: '@operator' }`), and the raw token is the entire contract. That is
 * already how the rail's mention lane works; the notification lane reads the
 * same signal rather than inventing a second definition.
 */
export const CURRENT_OPERATOR_MENTION_NAME = 'operator';

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

/** The row fields the operator-mention verdict is computed from. */
export interface OperatorMentionFields {
  senderId: string;
  /** Truncated body text. Only read when `mentions` is absent (legacy payload). */
  preview: string;
  mentions?: readonly { raw: string }[] | undefined;
}

/**
 * True when a channel row mentions the human operator.
 *
 * ONE definition, shared by the rail's mention lane (#1287) and the
 * notification lane (#1308 slice 5) — a second copy of this predicate would be
 * free to drift into notifying on a mention the sidebar does not badge.
 *
 * `mentions` is authoritative: the server computes it over the FULL body, so a
 * mention past the 200-char preview cut-off still counts. Parsing the truncated
 * preview is the fallback for a payload predating that field, and uses the
 * SHARED tokenizer (code fences, inline code, and `local@domain` spans are
 * already excluded there) rather than a lane-local regex.
 *
 * The operator's own posts never mention the operator: a row this device wrote
 * is echoed back over the socket, and self-notification is noise.
 */
export function messageMentionsOperator(row: OperatorMentionFields): boolean {
  if (row.senderId === CURRENT_OPERATOR_SENDER_ID) return false;
  const mentions = row.mentions ?? parseMentions(row.preview);
  return mentions.some(
    (mention) =>
      mention.raw.slice(1).toLowerCase() === CURRENT_OPERATOR_MENTION_NAME
  );
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
