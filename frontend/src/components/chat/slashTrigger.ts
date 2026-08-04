/** Result of detecting an active composer trigger (`/`, `$`, `@`, …) at the caret. */
export type Trigger = {
  prefix: string;
  query: string;
  span: [number, number];
  isLeading: boolean;
};

/** Back-compat shape for the slash/dollar composer trigger. */
export type SlashTrigger = {
  prefix: '/' | '$';
  query: string;
  span: [number, number];
  isLeading: boolean;
};

/**
 * Characters that, when they immediately precede a trigger, mean the trigger is
 * "inside a word" and therefore NOT active. This is the exact complement of the
 * server mention parser's boundary class (`shared/channel-chat-protocol.ts`
 * `parseMentions`, pattern `/(^|[^A-Za-z0-9_.])@.../`): a mention is valid when
 * the preceding char is start-of-text OR does NOT match `[A-Za-z0-9_.]`. Sharing
 * the same predicate keeps the `@` palette trigger in parity with what the
 * server will actually route (so `(@claude` and `hey,@claude` trigger, while
 * mid-word `foo@claude` and email `a.b@claude` do not).
 */
const WORD_BOUNDARY_CHAR = /[A-Za-z0-9_.]/;

/**
 * Detect whether the caret is positioned inside an active trigger for any of the
 * supplied prefix characters.
 *
 * Algorithm:
 * 1. Walk back from caret-1 looking for one of `chars` where ALL chars between
 *    that index and the caret are non-whitespace.
 * 2. Stop walking when whitespace or string-start is hit before finding a
 *    trigger → null (the query part can never contain whitespace).
 * 3. When a candidate is found at `pos`, validate the preceding boundary:
 *    - `pos === 0`                              → valid, isLeading = true
 *    - `text[pos-1]` does not match `[A-Za-z0-9_.]` → valid
 *        - isLeading = true only when `text[pos-1] === '\n'`
 *    - `text[pos-1]` matches `[A-Za-z0-9_.]`    → invalid (mid-word), null
 * 4. Return `{ prefix, query, span: [pos, caret], isLeading }`.
 *
 * The boundary rule is intentionally broader than "leading whitespace only":
 * `/` and `$` (which are only meaningful when leading) are unaffected because
 * consumers re-check `isLeading`, while `@` matches the server mention boundary.
 */
export function detectTrigger(
  text: string,
  caret: number,
  chars: readonly string[]
): Trigger | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch: string = text.charAt(i);

    if (chars.includes(ch)) {
      // Found a trigger candidate at i. Validate the preceding boundary.
      const prev: string | undefined = i === 0 ? undefined : text.charAt(i - 1);
      if (prev !== undefined && WORD_BOUNDARY_CHAR.test(prev)) {
        // A word char immediately precedes the trigger (mid-word `foo@x`,
        // email `a.b@x`, path segment `a/b`) → not an active trigger.
        return null;
      }
      return {
        prefix: ch,
        query: text.slice(i + 1, caret),
        span: [i, caret],
        isLeading: prev === undefined || prev === '\n',
      };
    }

    // Whitespace before finding a trigger char closes the token → null.
    if (/\s/.test(ch)) {
      return null;
    }
  }

  // Walked all the way to start without finding a trigger or whitespace.
  return null;
}

/**
 * Detect a slash/dollar command trigger. Thin wrapper over `detectTrigger` that
 * narrows the prefix back to `'/' | '$'` for the three existing composer
 * consumers. The cast is sound because only those two chars are passed.
 */
export function detectSlashTrigger(
  text: string,
  caret: number
): SlashTrigger | null {
  return detectTrigger(text, caret, ['/', '$']) as SlashTrigger | null;
}
