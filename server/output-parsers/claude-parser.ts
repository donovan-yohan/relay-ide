import type { OutputParser, ParseResult, AgentState } from './index.js';

// Duplicated from utils.ts to preserve output-parsers/ module boundary
/* eslint-disable no-control-regex */
const ANSI_RE =
  /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][AB012]|\x1b\[\?[0-9;]*[hlm]|\x1b\[[0-9]*[ABCDJKH]/g;
/* eslint-enable no-control-regex */

/**
 * Claude Code output parser.
 *
 * Claude Code uses a React/Ink TUI. This parser detects semantic state
 * transitions by pattern-matching on cleaned terminal output.
 */
export class ClaudeOutputParser implements OutputParser {
  private currentState: AgentState = 'initializing';
  private hasSeenFirstPrompt = false;

  onData(chunk: string, _recentScrollback: string[]): ParseResult | null {
    const clean = chunk.replace(ANSI_RE, '');
    if (!clean.trim()) return null;

    const newState = this.classify(clean);
    if (newState && newState !== this.currentState) {
      this.currentState = newState;
      return { state: newState };
    }
    return null;
  }

  reset(): void {
    this.currentState = 'initializing';
    this.hasSeenFirstPrompt = false;
  }

  get state(): AgentState {
    return this.currentState;
  }

  private classify(clean: string): AgentState | null {
    // Permission prompt detection (highest priority)
    if (/\bAllow\b/.test(clean) && /\bDeny\b/.test(clean)) {
      return 'permission-prompt';
    }

    // Error detection
    if (/^Error:|^ERROR:|✗\s|error:/m.test(clean)) {
      return 'error';
    }

    // Waiting for input: the ">" prompt on its own line, or initial greeting
    if (
      /^>\s*$/m.test(clean) ||
      /How can I help/i.test(clean) ||
      /What would you like/i.test(clean)
    ) {
      this.hasSeenFirstPrompt = true;
      return 'waiting-for-input';
    }

    // Processing: substantive output after the first prompt
    if (this.hasSeenFirstPrompt && clean.trim().length > 0) {
      return 'processing';
    }

    // Still initializing if we haven't seen the first prompt
    if (!this.hasSeenFirstPrompt) {
      return 'initializing';
    }

    return null;
  }
}
