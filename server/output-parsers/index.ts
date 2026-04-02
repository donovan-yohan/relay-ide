import type { AgentState } from '../types.js';
import { ClaudeOutputParser } from './claude-parser.js';
import { CodexOutputParser } from './codex-parser.js';
import { OpencodeOutputParser } from './opencode-parser.js';
import { NullOutputParser } from './null-parser.js';

export type { AgentState };

/** Result of parsing a chunk of terminal output */
export interface ParseResult {
  state: AgentState;
}

/** Per-vendor parser — each agent type implements this */
export interface OutputParser {
  /** Called on each new PTY output chunk. Returns state change or null if no change. */
  onData(chunk: string, recentScrollback: string[]): ParseResult | null;
  /** Reset internal state (e.g., on session restart) */
  reset(): void;
}

/**
 * Registry: factory per parser type. Unknown keys return undefined (fall back to timer-based detection).
 * Keys match AgentFramework.parserType values. 'none' is for frameworks that opt out of parsing.
 */
export const outputParsers: Record<string, (() => OutputParser) | undefined> = {
  claude: () => new ClaudeOutputParser(),
  codex: () => new CodexOutputParser(),
  opencode: () => new OpencodeOutputParser(),
  none: () => new NullOutputParser(),
};
