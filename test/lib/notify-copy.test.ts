// #1308 slice 5 item 2 — notification copy. Pure: no DOM, no stores.
import { describe, it, expect } from 'vitest';
import {
  formatNotifyTitle,
  notifyOsBody,
  notifyRelayCopyFragment,
  stripNotifyTitlePrefix,
  NOTIFY_OS_TITLE,
  type NotifyCopyInput,
} from '../../frontend/src/lib/notify/copy.js';

function copy(overrides: Partial<NotifyCopyInput> = {}): NotifyCopyInput {
  return {
    reason: 'mention',
    senderLabel: 'claude',
    channelTitle: 'impl 1308',
    count: 1,
    ...overrides,
  };
}

describe('OS notification body', () => {
  it('names the agent, the verb, and the channel', () => {
    expect(notifyOsBody(copy())).toBe('claude mentioned you in impl 1308');
    expect(notifyOsBody(copy({ reason: 'dm-reply' }))).toBe(
      'claude replied in impl 1308'
    );
    expect(
      notifyOsBody(copy({ reason: 'turn-complete', senderLabel: 'codex' }))
    ).toBe('codex finished in impl 1308');
  });

  it('reports a coalesced run with the mono-spirit separator', () => {
    expect(notifyOsBody(copy({ reason: 'dm-reply', count: 3 }))).toBe(
      'claude replied in impl 1308 · 3 new'
    );
  });

  it('uses the operator channel title verbatim, without restyling it', () => {
    expect(notifyOsBody(copy({ channelTitle: 'Impl 1308' }))).toBe(
      'claude mentioned you in Impl 1308'
    );
  });

  it('never carries message text', () => {
    // The copy input has no field a body could be smuggled through — the only
    // free-text field is the operator's own channel title.
    expect(notifyOsBody(copy())).not.toContain('pushed the branch');
  });
});

describe('relay-authored copy fragment', () => {
  const fragments = [
    notifyRelayCopyFragment({ reason: 'mention', senderLabel: 'claude' }),
    notifyRelayCopyFragment({ reason: 'dm-reply', senderLabel: 'claude' }),
    notifyRelayCopyFragment({ reason: 'turn-complete', senderLabel: 'codex' }),
  ];

  it('is lowercase with no emoji (DESIGN.md)', () => {
    for (const fragment of fragments) {
      expect(fragment).toBe(fragment.toLowerCase());
      expect(fragment).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });

  it('titles the notification with relay, not the channel', () => {
    // The channel is already inside the body; repeating it as the title reads
    // as a bug on every platform that renders both lines.
    expect(NOTIFY_OS_TITLE).toBe('relay');
    expect(NOTIFY_OS_TITLE).toBe(NOTIFY_OS_TITLE.toLowerCase());
  });
});

describe('document title', () => {
  it('prefixes a channel count and restores the clean title at zero', () => {
    expect(formatNotifyTitle('Relay', 3)).toBe('(3) Relay');
    expect(formatNotifyTitle('Relay', 1)).toBe('(1) Relay');
    expect(formatNotifyTitle('Relay', 0)).toBe('Relay');
  });

  it('strips a prefix it wrote earlier so counts cannot compound', () => {
    expect(stripNotifyTitlePrefix('(3) Relay')).toBe('Relay');
    expect(stripNotifyTitlePrefix('Relay')).toBe('Relay');
    // A parenthesised title that is not a count is left alone.
    expect(stripNotifyTitlePrefix('(beta) Relay')).toBe('(beta) Relay');
  });
});
