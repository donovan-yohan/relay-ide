import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeOutputParser } from '../server/output-parsers/claude-parser.js';
import { CodexOutputParser } from '../server/output-parsers/codex-parser.js';
import { outputParsers } from '../server/output-parsers/index.js';

describe('ClaudeOutputParser', () => {
  it('starts in initializing state', () => {
    const parser = new ClaudeOutputParser();
    assert.equal(parser.state, 'initializing');
  });

  it('transitions to waiting-for-input on > prompt', () => {
    const parser = new ClaudeOutputParser();
    const result = parser.onData('>\n', []);
    assert.deepEqual(result, { state: 'waiting-for-input' });
  });

  it('transitions to waiting-for-input on greeting', () => {
    const parser = new ClaudeOutputParser();
    const result = parser.onData('How can I help you today?', []);
    assert.deepEqual(result, { state: 'waiting-for-input' });
  });

  it('transitions to processing after first prompt when output arrives', () => {
    const parser = new ClaudeOutputParser();
    // First: see the prompt
    parser.onData('>\n', []);
    // Then: output starts
    const result = parser.onData('I will help you with that task...', []);
    assert.deepEqual(result, { state: 'processing' });
  });

  it('transitions back to waiting-for-input after processing', () => {
    const parser = new ClaudeOutputParser();
    parser.onData('>\n', []);
    parser.onData('Working on it...', []);
    const result = parser.onData('>\n', []);
    assert.deepEqual(result, { state: 'waiting-for-input' });
  });

  it('detects permission prompt', () => {
    const parser = new ClaudeOutputParser();
    parser.onData('>\n', []);
    const result = parser.onData('Allow tool access to /usr/bin? Allow / Deny', []);
    assert.deepEqual(result, { state: 'permission-prompt' });
  });

  it('detects error state', () => {
    const parser = new ClaudeOutputParser();
    parser.onData('>\n', []);
    const result = parser.onData('Error: something went wrong', []);
    assert.deepEqual(result, { state: 'error' });
  });

  it('ignores pure ANSI escape sequences', () => {
    const parser = new ClaudeOutputParser();
    const result = parser.onData('\x1b[32m\x1b[0m', []);
    assert.equal(result, null);
  });

  it('returns null when state does not change', () => {
    const parser = new ClaudeOutputParser();
    parser.onData('>\n', []);
    // Already in waiting-for-input, send another prompt
    const result = parser.onData('>\n', []);
    assert.equal(result, null);
  });

  it('reset returns to initializing', () => {
    const parser = new ClaudeOutputParser();
    parser.onData('>\n', []);
    assert.equal(parser.state, 'waiting-for-input');
    parser.reset();
    assert.equal(parser.state, 'initializing');
  });

  it('stays initializing before first prompt', () => {
    const parser = new ClaudeOutputParser();
    const result = parser.onData('Loading configuration...', []);
    // Still initializing since no prompt seen
    assert.equal(result, null); // already in initializing, no change
  });
});

describe('CodexOutputParser', () => {
  it('always returns null', () => {
    const parser = new CodexOutputParser();
    assert.equal(parser.onData('any output', []), null);
    assert.equal(parser.onData('>\n', []), null);
    assert.equal(parser.onData('Error: something', []), null);
  });

  it('reset is a no-op', () => {
    const parser = new CodexOutputParser();
    parser.reset(); // should not throw
  });
});

describe('outputParsers registry', () => {
  it('creates ClaudeOutputParser for claude', () => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const parser = outputParsers['claude']!();
    assert.ok(parser instanceof ClaudeOutputParser);
  });

  it('creates CodexOutputParser for codex', () => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const parser = outputParsers['codex']!();
    assert.ok(parser instanceof CodexOutputParser);
  });
});
