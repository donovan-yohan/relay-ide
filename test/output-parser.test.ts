import { describe, it, expect } from 'vitest';
import { ClaudeOutputParser } from '../server/output-parsers/claude-parser.js';
import { CodexOutputParser } from '../server/output-parsers/codex-parser.js';
import { OpencodeOutputParser } from '../server/output-parsers/opencode-parser.js';
import { NullOutputParser } from '../server/output-parsers/null-parser.js';
import { outputParsers } from '../server/output-parsers/index.js';

describe('ClaudeOutputParser', () => {
  it('starts in initializing state', () => {
    const parser = new ClaudeOutputParser();
    expect(parser.state).toBe('initializing');
  });

  it('transitions to waiting-for-input on > prompt', () => {
    const parser = new ClaudeOutputParser();
    const result = parser.onData('>\n', []);
    expect(result).toEqual({ state: 'waiting-for-input' });
  });

  it('transitions to waiting-for-input on greeting', () => {
    const parser = new ClaudeOutputParser();
    const result = parser.onData('How can I help you today?', []);
    expect(result).toEqual({ state: 'waiting-for-input' });
  });

  it('transitions to processing after first prompt when output arrives', () => {
    const parser = new ClaudeOutputParser();
    // First: see the prompt
    parser.onData('>\n', []);
    // Then: output starts
    const result = parser.onData('I will help you with that task...', []);
    expect(result).toEqual({ state: 'processing' });
  });

  it('transitions back to waiting-for-input after processing', () => {
    const parser = new ClaudeOutputParser();
    parser.onData('>\n', []);
    parser.onData('Working on it...', []);
    const result = parser.onData('>\n', []);
    expect(result).toEqual({ state: 'waiting-for-input' });
  });

  it('detects permission prompt', () => {
    const parser = new ClaudeOutputParser();
    parser.onData('>\n', []);
    const result = parser.onData(
      'Allow tool access to /usr/bin? Allow / Deny',
      []
    );
    expect(result).toEqual({ state: 'permission-prompt' });
  });

  it('detects error state', () => {
    const parser = new ClaudeOutputParser();
    parser.onData('>\n', []);
    const result = parser.onData('Error: something went wrong', []);
    expect(result).toEqual({ state: 'error' });
  });

  it('ignores pure ANSI escape sequences', () => {
    const parser = new ClaudeOutputParser();
    const result = parser.onData('\x1b[32m\x1b[0m', []);
    expect(result).toBe(null);
  });

  it('returns null when state does not change', () => {
    const parser = new ClaudeOutputParser();
    parser.onData('>\n', []);
    // Already in waiting-for-input, send another prompt
    const result = parser.onData('>\n', []);
    expect(result).toBe(null);
  });

  it('reset returns to initializing', () => {
    const parser = new ClaudeOutputParser();
    parser.onData('>\n', []);
    expect(parser.state).toBe('waiting-for-input');
    parser.reset();
    expect(parser.state).toBe('initializing');
  });

  it('stays initializing before first prompt', () => {
    const parser = new ClaudeOutputParser();
    const result = parser.onData('Loading configuration...', []);
    // Still initializing since no prompt seen
    expect(result).toBe(null); // already in initializing, no change
  });
});

describe('CodexOutputParser', () => {
  it('always returns null', () => {
    const parser = new CodexOutputParser();
    expect(parser.onData('any output', [])).toBe(null);
    expect(parser.onData('>\n', [])).toBe(null);
    expect(parser.onData('Error: something', [])).toBe(null);
  });

  it('reset is a no-op', () => {
    const parser = new CodexOutputParser();
    parser.reset(); // should not throw
  });
});

describe('outputParsers registry', () => {
  it('creates ClaudeOutputParser for claude', () => {
    const parser = outputParsers['claude']!();
    expect(parser instanceof ClaudeOutputParser).toBeTruthy();
  });

  it('creates CodexOutputParser for codex', () => {
    const parser = outputParsers['codex']!();
    expect(parser instanceof CodexOutputParser).toBeTruthy();
  });

  it('creates OpencodeOutputParser for opencode', () => {
    const parser = outputParsers['opencode']!();
    expect(parser instanceof OpencodeOutputParser).toBeTruthy();
  });

  it('creates NullOutputParser for none', () => {
    const parser = outputParsers['none']!();
    expect(parser instanceof NullOutputParser).toBeTruthy();
  });

  it('returns undefined for unknown keys', () => {
    expect(outputParsers['unknown-agent-xyz']).toBe(undefined);
  });
});

describe('NullOutputParser', () => {
  it('always returns null for any input', () => {
    const parser = new NullOutputParser();
    expect(parser.onData('any output', [])).toBe(null);
    expect(parser.onData('>\n', [])).toBe(null);
    expect(parser.onData('Error: something', [])).toBe(null);
    expect(parser.onData('', [])).toBe(null);
  });

  it('reset is a no-op', () => {
    const parser = new NullOutputParser();
    parser.reset(); // should not throw
  });
});

describe('OpencodeOutputParser', () => {
  it('starts in initializing state', () => {
    const parser = new OpencodeOutputParser();
    expect(parser.state).toBe('initializing');
  });

  it('detects permission prompt from ! permission requested line', () => {
    const parser = new OpencodeOutputParser();
    const result = parser.onData(
      '! permission requested: bash (*); allow this tool?',
      []
    );
    expect(result).toEqual({ state: 'permission-prompt' });
  });

  it('recognizes agent header and sets hasSeenFirstPrompt (no state change from initializing)', () => {
    const parser = new OpencodeOutputParser();
    // Parser starts in initializing; header keeps it in initializing — no state change, returns null
    const result = parser.onData('> build . anthropic/claude-sonnet-4-5', []);
    expect(result).toBe(null);
    expect(parser.state).toBe('initializing');
  });

  it('detects bash tool icon as processing', () => {
    const parser = new OpencodeOutputParser();
    // Simulate having seen first prompt first
    parser.onData('> build . anthropic/claude-3-5-sonnet', []);
    // Now a bash tool invocation
    const result = parser.onData('$ npm run build', []);
    expect(result).toEqual({ state: 'processing' });
  });

  it('detects file edit tool icon as processing', () => {
    const parser = new OpencodeOutputParser();
    parser.onData('> build . anthropic/claude-3-5-sonnet', []);
    const result = parser.onData('<- src/index.ts', []);
    expect(result).toEqual({ state: 'processing' });
  });

  it('detects file read tool icon as processing', () => {
    const parser = new OpencodeOutputParser();
    parser.onData('> build . anthropic/claude-3-5-sonnet', []);
    const result = parser.onData('-> src/index.ts', []);
    expect(result).toEqual({ state: 'processing' });
  });

  it('detects glob/grep tool icon as processing', () => {
    const parser = new OpencodeOutputParser();
    parser.onData('> build . anthropic/claude-3-5-sonnet', []);
    const result = parser.onData('* **/*.ts', []);
    expect(result).toEqual({ state: 'processing' });
  });

  it('detects webfetch tool icon as processing', () => {
    const parser = new OpencodeOutputParser();
    parser.onData('> build . anthropic/claude-3-5-sonnet', []);
    const result = parser.onData('% https://example.com', []);
    expect(result).toEqual({ state: 'processing' });
  });

  it('detects waiting-for-input on > prompt without provider info', () => {
    const parser = new OpencodeOutputParser();
    parser.onData('> build . anthropic/claude-3-5-sonnet', []);
    parser.onData('$ npm install', []);
    const result = parser.onData('>\n', []);
    expect(result).toEqual({ state: 'waiting-for-input' });
  });

  it('detects waiting-for-input on "Ready" pattern', () => {
    const parser = new OpencodeOutputParser();
    parser.onData('> build . anthropic/claude-3-5-sonnet', []);
    parser.onData('doing work...', []);
    const result = parser.onData('Ready', []);
    expect(result).toEqual({ state: 'waiting-for-input' });
  });

  it('strips ANSI sequences before matching', () => {
    const parser = new OpencodeOutputParser();
    // Pure ANSI should return null
    const result = parser.onData('\x1b[32m\x1b[0m', []);
    expect(result).toBe(null);
  });

  it('permission prompt has highest priority over processing', () => {
    const parser = new OpencodeOutputParser();
    parser.onData('> build . anthropic/claude-3-5-sonnet', []);
    // Even if there is tool-like content, the permission pattern wins
    const result = parser.onData(
      '! permission requested: bash (*); $ npm run test',
      []
    );
    expect(result).toEqual({ state: 'permission-prompt' });
  });

  it('returns null when state does not change', () => {
    const parser = new OpencodeOutputParser();
    parser.onData('> build . anthropic/claude-3-5-sonnet', []);
    // Still initializing, another header line should return null (already initializing)
    const result = parser.onData('> build . anthropic/claude-3-5-sonnet', []);
    expect(result).toBe(null);
  });

  it('reset returns to initializing state', () => {
    const parser = new OpencodeOutputParser();
    parser.onData('> build . anthropic/claude-3-5-sonnet', []);
    parser.onData('>\n', []);
    expect(parser.state).toBe('waiting-for-input');
    parser.reset();
    expect(parser.state).toBe('initializing');
  });
});
