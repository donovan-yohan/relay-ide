import { describe, expect, it } from 'vitest';
import { detectTrigger } from '../../frontend/src/components/chat/slashTrigger.js';
import { parseMentions } from '../../shared/channel-chat-protocol.js';

// Boundary PARITY: `detectTrigger(text, caret, ['@'])` (composer-side, caret
// anchored) must agree with `parseMentions` (server-side, whole-text) on whether
// the `@` at the caret is a routable mention boundary. The server pattern
// `/(^|[^A-Za-z0-9_.])@.../` treats `@` as a mention when the preceding char is
// start-of-text OR NOT in `[A-Za-z0-9_.]` — broader than "leading whitespace".
// Code-span masking is server-only and out of scope for detectTrigger.

interface ParityCase {
  label: string;
  text: string;
  caret: number;
  /** Is the `@` at this caret a valid, routable mention boundary? */
  valid: boolean;
  /** The mention name (without `@`) when valid. */
  name?: string;
}

const cases: ParityCase[] = [
  {
    label: 'mid-word foo@claude is NOT a mention',
    text: 'foo@claude',
    caret: 10,
    valid: false,
  },
  {
    label: 'email a.b@claude is NOT a mention',
    text: 'a.b@claude',
    caret: 10,
    valid: false,
  },
  {
    label: 'open-paren (@claude IS a mention',
    text: '(@claude',
    caret: 8,
    valid: true,
    name: 'claude',
  },
  {
    label: 'space hey @claude IS a mention',
    text: 'hey @claude',
    caret: 11,
    valid: true,
    name: 'claude',
  },
  {
    label: 'leading @Claude preserves casing',
    text: '@Claude',
    caret: 7,
    valid: true,
    name: 'Claude',
  },
  {
    label: 'comma hey,@claude IS a mention',
    text: 'hey,@claude',
    caret: 11,
    valid: true,
    name: 'claude',
  },
];

describe('detectTrigger @ boundary parity with parseMentions', () => {
  for (const c of cases) {
    it(c.label, () => {
      const trigger = detectTrigger(c.text, c.caret, ['@']);
      const mentions = parseMentions(c.text, ['claude']);
      const parserSaysMention = mentions.some(
        (m) => m.raw.toLowerCase() === `@${(c.name ?? '').toLowerCase()}`
      );

      // The two independent implementations agree on the boundary verdict.
      expect(trigger !== null).toBe(c.valid);
      expect(parserSaysMention).toBe(c.valid);
      if (c.valid) {
        expect(trigger?.prefix).toBe('@');
        expect(trigger?.query).toBe(c.name);
      }
    });
  }
});

describe('detectTrigger @ caret anchoring', () => {
  it('extracts the partial query as the user types', () => {
    expect(detectTrigger('@cla', 4, ['@'])).toEqual({
      prefix: '@',
      query: 'cla',
      span: [0, 4],
      isLeading: true,
    });
  });

  it('is inactive once whitespace closes the token', () => {
    // caret sits inside "done"; walking back hits the space before any '@'.
    expect(detectTrigger('@claude done', 12, ['@'])).toBeNull();
  });

  it('a mid-text mention is detected but not leading', () => {
    expect(detectTrigger('hey @cla', 8, ['@'])).toEqual({
      prefix: '@',
      query: 'cla',
      span: [4, 8],
      isLeading: false,
    });
  });
});
