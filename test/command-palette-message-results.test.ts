import { describe, expect, it } from 'vitest';

import {
  buildMessagePaletteResults,
  MESSAGE_PALETTE_LIMIT,
  messagePaletteSnippetText,
} from '../frontend/src/lib/command-palette-message-results.js';
import { builtInAgentProfileId } from '../shared/agent-profile.js';
import {
  CHANNEL_SEARCH_HIGHLIGHT_CLOSE,
  CHANNEL_SEARCH_HIGHLIGHT_OPEN,
  type ChannelMessageId,
  type ChannelMessageSearchResult,
} from '../shared/channel-chat-protocol.js';

const NOW = '2026-08-03T00:00:00Z';

function makeHit(
  overrides: Partial<ChannelMessageSearchResult> = {}
): ChannelMessageSearchResult {
  return {
    messageId: 'chm:hit-1' as ChannelMessageId,
    channelId: 'topic:alpha',
    threadId: null,
    seq: 12,
    snippet: `rebuilt the ${CHANNEL_SEARCH_HIGHLIGHT_OPEN}sqlite${CHANNEL_SEARCH_HIGHLIGHT_CLOSE} index`,
    senderKind: 'agent',
    senderId: builtInAgentProfileId('claude'),
    providerId: 'claude',
    createdAt: NOW,
    score: -3.2,
    channelTitle: 'Build UI shell',
    archived: false,
    ...overrides,
  };
}

describe('messagePaletteSnippetText', () => {
  it('consumes the highlight sentinels rather than rendering them', () => {
    // A palette row is one ellipsized `.item-label` with nowhere to hang
    // emphasis, so the runs are flattened — but the Private Use Area delimiters
    // must never survive into the label, where they print as tofu boxes.
    const text = messagePaletteSnippetText(makeHit().snippet);
    expect(text).toBe('rebuilt the sqlite index');
    expect(text).not.toContain(CHANNEL_SEARCH_HIGHLIGHT_OPEN);
    expect(text).not.toContain(CHANNEL_SEARCH_HIGHLIGHT_CLOSE);
  });

  it('collapses the newlines and indentation a real message body carries', () => {
    expect(
      messagePaletteSnippetText(
        `  …then\n\n    ${CHANNEL_SEARCH_HIGHLIGHT_OPEN}ran${CHANNEL_SEARCH_HIGHLIGHT_CLOSE}\tnpm  test  `
      )
    ).toBe('…then ran npm test');
  });
});

describe('buildMessagePaletteResults', () => {
  it('maps a hit to a jump-shaped palette row labelled by its snippet', () => {
    const results = buildMessagePaletteResults([makeHit()]);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      type: 'message',
      id: 'message-chm:hit-1',
      label: 'rebuilt the sqlite index',
      // Channel first (where), then the sender label the rail uses.
      sublabel: 'Build UI shell · claude',
    });
    // The hit itself rides along: selection needs channelId + messageId.
    expect(results[0]?.data.channelId).toBe('topic:alpha');
    expect(results[0]?.data.messageId).toBe('chm:hit-1');
  });

  it('labels the sender by display name / provider, never by splitting a profile id', () => {
    // `agent-profile:claude:default` — the trailing segment is `default`, so a
    // naive split would label every built-in agent identically (#1234).
    const noProviderHit: ChannelMessageSearchResult = makeHit();
    delete noProviderHit.providerId;
    expect(buildMessagePaletteResults([noProviderHit])[0]?.sublabel).toBe(
      'Build UI shell · claude'
    );
    expect(
      buildMessagePaletteResults([
        makeHit({ senderDisplayName: 'Reviewer', providerId: 'codex' }),
      ])[0]?.sublabel
    ).toBe('Build UI shell · Reviewer');
    expect(
      buildMessagePaletteResults([
        makeHit({ senderKind: 'human', senderId: 'human:operator' }),
      ])[0]?.sublabel
    ).toBe('Build UI shell · you');
  });

  it('marks a thread reply so the operator knows the jump opens a panel', () => {
    const [result] = buildMessagePaletteResults([
      makeHit({ threadId: 'chm:root-1' as ChannelMessageId }),
    ]);
    expect(result?.sublabel).toBe('Build UI shell · claude · thread');
  });

  it('caps at five hits, the same discipline every other palette category uses', () => {
    const many = Array.from({ length: 9 }, (_, index) =>
      makeHit({ messageId: `chm:hit-${index}` as ChannelMessageId })
    );
    expect(MESSAGE_PALETTE_LIMIT).toBe(5);
    expect(buildMessagePaletteResults(many)).toHaveLength(5);
    expect(buildMessagePaletteResults(many).map((r) => r.id)).toEqual([
      'message-chm:hit-0',
      'message-chm:hit-1',
      'message-chm:hit-2',
      'message-chm:hit-3',
      'message-chm:hit-4',
    ]);
  });

  it('never renders an empty, unclickable-looking row for a bodyless payload', () => {
    expect(
      buildMessagePaletteResults([makeHit({ snippet: '   ' })])[0]?.label
    ).toBe('(no preview)');
  });
});
