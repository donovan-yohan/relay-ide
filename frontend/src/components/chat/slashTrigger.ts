/** Result of detecting an active slash/dollar trigger at the caret position. */
export type SlashTrigger = {
  prefix: '/' | '$';
  query: string;
  span: [number, number];
  isLeading: boolean;
};

/**
 * Detect whether the caret is positioned inside an active slash command trigger.
 *
 * Algorithm (§4.1):
 * 1. Walk back from caret-1 looking for '/' or '$' where ALL chars between that
 *    index and caret are non-whitespace.
 * 2. Stop walking when whitespace or string-start is hit before finding a trigger → null.
 * 3. When candidate found at pos, validate the boundary at pos-1:
 *    - pos === 0           → valid, isLeading = true
 *    - text[pos-1] === '\n'  → valid, isLeading = true
 *    - text[pos-1] is other whitespace → valid, isLeading = false
 *    - else                → invalid, null
 * 4. Return { prefix, query, span: [pos, caret], isLeading }
 */
export function detectSlashTrigger(text: string, caret: number): SlashTrigger | null {
  // Walk backwards from caret-1
  for (let i = caret - 1; i >= 0; i--) {
    const ch: string = text.charAt(i);

    if (ch === '/' || ch === '$') {
      // Found a trigger candidate at i. Validate boundary.
      if (i === 0) {
        return {
          prefix: ch,
          query: text.slice(i + 1, caret),
          span: [i, caret],
          isLeading: true,
        };
      }
      const prev: string = text.charAt(i - 1);
      if (prev === '\n') {
        return {
          prefix: ch,
          query: text.slice(i + 1, caret),
          span: [i, caret],
          isLeading: true,
        };
      }
      if (prev === ' ' || prev === '\t' || prev === '\r') {
        return {
          prefix: ch,
          query: text.slice(i + 1, caret),
          span: [i, caret],
          isLeading: false,
        };
      }
      // Non-whitespace precedes trigger → invalid
      return null;
    }

    // If we hit whitespace before finding a trigger char, stop.
    if (/\s/.test(ch)) {
      return null;
    }
  }

  // Walked all the way to start without finding trigger or whitespace
  return null;
}
