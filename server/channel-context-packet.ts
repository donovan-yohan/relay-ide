import type { ChannelMessage } from '../shared/channel-chat-protocol.js';

// Pure context-packet builder for @-mention routing (#1167, slice 4). No I/O:
// store rows in, prompt string out — fully unit-testable. The binder fetches the
// eligible rows (`store.history(channelId, { afterSeq: lastDeliveredSeq })`
// filtered to `seq < trigger.seq`) and hands them here; this module owns ONLY the
// deterministic string shape (§4 of the spec). It never touches the network, the
// store, or the adapter, so the golden test pins the exact bytes an agent sees.

/** Newest N context rows retained; older eligible rows collapse to one marker. */
export const PACKET_MAX_ROWS = 20;
/** Per-row body cap before the ellipsis marker (token frugality). */
export const PACKET_ROW_MAX_CHARS = 2000;
/** Whole-packet byte budget — oldest context rows drop until under (never the trigger). */
export const PACKET_MAX_BYTES = 24 * 1024;

const OMITTED_MARKER = '[…earlier messages omitted]';
const ROW_TRUNCATED_SUFFIX = '…[truncated]';

export interface BuildMentionContextPacketInput {
  /** Human-facing channel title (topic display title), rendered as `#<title>`. */
  channelTitle: string;
  /** Framework id the packet is addressed to (`you are @<framework>`). */
  framework: string;
  /**
   * Eligible prior rows, oldest-first: every row with
   * `lastDeliveredSeq < seq < trigger.seq`. The agent's own prior rows are
   * skipped HERE (they already live in the reused provider conversation), so the
   * binder may pass the raw window untrimmed.
   */
  rows: ChannelMessage[];
  /** The mention row itself — always rendered in the footer, never dropped. */
  trigger: ChannelMessage;
  /** Cursor: 0 for a first-ever mention (cold session → full orientation window). */
  lastDeliveredSeq: number;
}

function senderLabel(message: ChannelMessage): string {
  return message.sender.displayName ?? message.sender.id;
}

/** Render one row as `label: text`, agent-tagged, with multi-line bodies indented. */
function renderRow(message: ChannelMessage): string {
  const truncated =
    message.body.text.length > PACKET_ROW_MAX_CHARS
      ? message.body.text.slice(0, PACKET_ROW_MAX_CHARS) + ROW_TRUNCATED_SUFFIX
      : message.body.text;
  const lines = truncated.split('\n');
  const first = lines[0] ?? '';
  const rest = lines.slice(1);
  const indentRest = (body: string): string =>
    rest.length > 0
      ? body + '\n' + rest.map((l) => `    ${l}`).join('\n')
      : body;

  if (message.kind === 'system' || message.sender.kind === 'system') {
    return indentRest(`[system]: ${first}`);
  }
  const label = senderLabel(message);
  if (message.sender.kind === 'agent') {
    return indentRest(`${label} [agent]: ${first}`);
  }
  return indentRest(`${label}: ${first}`);
}

/**
 * Build the deterministic context packet delivered as the agent's turn content.
 *
 * Shape (§4):
 *   [Relay channel #<title> — you are @<framework>, one participant in a multi-party chat]
 *   Recent messages, oldest first. Lines are "sender: text"; ...        (only with context)
 *   […earlier messages omitted]                                          (only when >N eligible)
 *   <sender>: <text>
 *   ...
 *                                                                        (blank line)
 *   [<trigger sender> mentioned you — reply to this message; your reply is posted to the channel]
 *   <trigger text>
 *
 * A reused session with no interim rows collapses to header + footer only — the
 * provider already holds the conversation, so re-sending it wastes tokens.
 */
export function buildMentionContextPacket(
  input: BuildMentionContextPacketInput
): string {
  const header = `[Relay channel #${input.channelTitle} — you are @${input.framework}, one participant in a multi-party chat]`;

  // Eligible = rows strictly after the delivery cursor and strictly before the
  // trigger, minus the agent's OWN prior rows (already in its reused provider
  // conversation — re-sending wastes tokens and confuses attribution). A reused
  // session with no interim rows therefore yields an empty window → header +
  // footer only; a first-ever mention (cursor 0) yields the full orientation
  // window.
  const eligible = input.rows.filter(
    (row) =>
      row.seq > input.lastDeliveredSeq &&
      row.seq < input.trigger.seq &&
      !(
        row.sender.kind === 'agent' && row.sender.providerId === input.framework
      )
  );

  let contextRows = eligible;
  let omittedEarlier = false;
  if (contextRows.length > PACKET_MAX_ROWS) {
    omittedEarlier = true;
    contextRows = contextRows.slice(contextRows.length - PACKET_MAX_ROWS);
  }

  const triggerLabel = senderLabel(input.trigger);
  const triggerText =
    input.trigger.body.text.length > PACKET_ROW_MAX_CHARS
      ? input.trigger.body.text.slice(0, PACKET_ROW_MAX_CHARS) +
        ROW_TRUNCATED_SUFFIX
      : input.trigger.body.text;
  const footer = [
    `[${triggerLabel} mentioned you — reply to this message; your reply is posted to the channel]`,
    triggerText,
  ].join('\n');

  const assemble = (rows: ChannelMessage[], omitted: boolean): string => {
    if (rows.length === 0) {
      return `${header}\n\n${footer}`;
    }
    const contextBlock = [
      'Recent messages, oldest first. Lines are "sender: text"; agents tagged [agent], system rows tagged [system].',
      ...(omitted ? [OMITTED_MARKER] : []),
      ...rows.map(renderRow),
    ].join('\n');
    return `${header}\n${contextBlock}\n\n${footer}`;
  };

  // Whole-packet byte budget: drop oldest context rows until under (never the
  // trigger/footer). A single over-budget footer is still delivered — losing the
  // mention is worse than a slightly oversized packet.
  let packet = assemble(contextRows, omittedEarlier);
  while (
    contextRows.length > 0 &&
    Buffer.byteLength(packet, 'utf8') > PACKET_MAX_BYTES
  ) {
    contextRows = contextRows.slice(1);
    omittedEarlier = true;
    packet = assemble(contextRows, omittedEarlier);
  }
  return packet;
}
