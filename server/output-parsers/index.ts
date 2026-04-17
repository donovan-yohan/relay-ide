import { ClaudeOutputParser } from './claude-parser.js';
import { CodexOutputParser } from './codex-parser.js';
import { OpencodeOutputParser } from './opencode-parser.js';
import { NullOutputParser } from './null-parser.js';
import type { OutputParser } from './types.js';

export type { AgentState, OutputParser, ParseResult } from './types.js';

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
