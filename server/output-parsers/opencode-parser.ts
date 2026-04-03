import type { OutputParser, ParseResult, AgentState } from './index.js';

// Duplicated from utils.ts to preserve output-parsers/ module boundary
const ANSI_RE =
  /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][AB012]|\x1b\[\?[0-9;]*[hlm]|\x1b\[[0-9]*[ABCDJKH]/g;

/**
 * OpenCode output parser.
 *
 * OpenCode uses a Bubble Tea TUI. This parser detects semantic state
 * transitions by pattern-matching on cleaned terminal output.
 *
 * Key patterns:
 *   Permission prompt: lines starting with `!` followed by "permission"
 *   Tool use (processing): `$` bash, `<-` edit, `->` read, `*` glob/grep, `%` webfetch
 *   Agent header: `> build . provider/model` — indicates initializing/resuming
 *   Waiting for input: bare `>` prompt or "Ready" / "assistant: done" patterns
 */
export class OpencodeOutputParser implements OutputParser {
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
    // Permission prompt: highest priority — line starting with ! followed by "permission"
    if (/^!\s.*permission/im.test(clean)) {
      return 'permission-prompt';
    }

    // Waiting for input: "Ready" or "assistant: done" patterns
    if (/\bReady\b/.test(clean) || /assistant:\s*done/i.test(clean)) {
      this.hasSeenFirstPrompt = true;
      return 'waiting-for-input';
    }

    // Bare `>` prompt on its own line (not followed by provider/model info)
    if (/^>\s*$/m.test(clean)) {
      this.hasSeenFirstPrompt = true;
      return 'waiting-for-input';
    }

    // Agent header: `> build . provider/model` — initializing/resuming
    // Matches `>` followed by typical opencode startup text (not bare >)
    if (/^>\s+\S+.*\//m.test(clean)) {
      this.hasSeenFirstPrompt = true;
      return 'initializing';
    }

    // Tool icons indicating active processing (after first prompt seen)
    if (
      this.hasSeenFirstPrompt &&
      (/^\$\s/m.test(clean) || // bash/shell
        /^<-\s/m.test(clean) || // file edit
        /^->\s/m.test(clean) || // file read
        /^\*\s/m.test(clean) || // glob/grep
        /^%\s/m.test(clean)) // webfetch
    ) {
      return 'processing';
    }

    // General processing: substantive output after first prompt
    if (this.hasSeenFirstPrompt && clean.trim().length > 0) {
      return 'processing';
    }

    // Still initializing before first prompt
    if (!this.hasSeenFirstPrompt) {
      return 'initializing';
    }

    return null;
  }
}
