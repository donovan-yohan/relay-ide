import type { OutputParser, ParseResult } from './types.js';

/**
 * Codex output parser — stub.
 *
 * Always returns null, which tells the system to fall back to
 * timer-based idle detection. Replace with real pattern matching
 * when Codex TUI patterns are mapped.
 */
export class CodexOutputParser implements OutputParser {
  onData(_chunk: string, _recentScrollback: string[]): ParseResult | null {
    return null;
  }

  reset(): void {}
}
