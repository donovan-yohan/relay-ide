import type { AgentState } from '../types.js';

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
