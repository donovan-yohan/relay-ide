import {
  parseChannelSearchSnippet,
  type ChannelMessageSearchResult,
} from '../../../shared/channel-chat-protocol.js';
import { senderShortLabel } from './channel-sender-label.js';

export interface MessagePaletteResult {
  type: 'message';
  id: string;
  label: string;
  sublabel: string;
  data: ChannelMessageSearchResult;
}

/**
 * How many message hits the palette shows, and asks the server for.
 *
 * Five, the same cap every other palette category uses (`workspaces`,
 * `sessions`, `topics`, `artifacts`). The palette is a jump affordance stacked
 * with seven other categories, so a category that spends more rows than its
 * neighbours pushes them under the fold — the sidebar's `messages` section, with
 * a panel to itself, is where 20 rows belong.
 */
export const MESSAGE_PALETTE_LIMIT = 5;

/**
 * A server snippet as ONE palette line.
 *
 * Two things happen here, both load-bearing:
 *
 * - the highlight sentinels are CONSUMED. They are Private Use Area code points
 *   (`shared/channel-chat-protocol.ts`), so leaving them in would print tofu
 *   boxes in the middle of every match. The palette row is a single ellipsized
 *   line of `.item-label`, with no element of its own to hang emphasis on, so
 *   unlike the sidebar's snippet renderer it drops the runs' emphasis rather
 *   than rendering it — the query the operator just typed is still on screen in
 *   the input above.
 * - whitespace collapses. A message body is multi-line prose or a code block;
 *   its newlines and runs of indentation would either break the row's single-line
 *   rhythm or render as a long empty gap before the matched text.
 */
export function messagePaletteSnippetText(snippet: string): string {
  return parseChannelSearchSnippet(snippet)
    .map((segment) => segment.text)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

function toResult(hit: ChannelMessageSearchResult): MessagePaletteResult {
  const text = messagePaletteSnippetText(hit.snippet);
  const where = [hit.channelTitle, senderShortLabel(hit)];
  // A reply's destination is its thread panel, not the main lane, so the row
  // says so before the operator commits to the jump.
  if (hit.threadId) where.push('thread');
  return {
    type: 'message',
    id: `message-${hit.messageId}`,
    // Indexed rows always carry body text (tombstones are excluded from the
    // index and system/detail rows never enter it), so the fallback is only
    // ever reached by a malformed payload — it must still not render an empty,
    // unclickable-looking row.
    label: text || '(no preview)',
    sublabel: where.join(' · '),
    data: hit,
  };
}

/**
 * Pure mapping from already-fetched search hits to palette result objects,
 * mirroring `command-palette-topic-results.ts`: the fetch itself lives in the
 * palette's own query so this stays testable without a network stub.
 *
 * The cap is applied here as well as in the request. The server honours
 * `limit`, but this list is rendered next to seven other capped categories and
 * a future caller (or a cache entry populated by a wider request) must not be
 * able to spend the whole palette on messages.
 */
export function buildMessagePaletteResults(
  hits: ChannelMessageSearchResult[],
  limit = MESSAGE_PALETTE_LIMIT
): MessagePaletteResult[] {
  return hits.slice(0, limit).map(toResult);
}
