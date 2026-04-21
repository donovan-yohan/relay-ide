import type { OutputParser, ParseResult } from './types.js';

/**
 * Null output parser — always returns null.
 *
 * Used for agents with no known output patterns. Falls back to
 * timer-based idle detection in the calling code.
 */
export class NullOutputParser implements OutputParser {
  onData(_chunk: string, _recentScrollback: string[]): ParseResult | null {
    return null;
  }

  reset(): void {}
}
