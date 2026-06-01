import { describe, expect, it } from 'vitest';
import { detectTerminalAttentionPrompt } from '../server/terminal-attention.js';

describe('detectTerminalAttentionPrompt', () => {
  it('detects Claude-style approval prompts from terminal visible text', () => {
    expect(
      detectTerminalAttentionPrompt(`
        Bash command
        gh pr view 843 --json mergeCommit

        Do you want to proceed?
        ❯ 1. Yes
          2. No
      `)
    ).toEqual({ kind: 'approval', source: 'terminal-model' });
  });

  it('detects generic terminal permission wording', () => {
    expect(
      detectTerminalAttentionPrompt('Command requires your approval before running')
    ).toEqual({ kind: 'approval', source: 'terminal-model' });
  });

  it('detects question prompts separately from approvals', () => {
    expect(
      detectTerminalAttentionPrompt('Agent is waiting for your answer to continue')
    ).toEqual({ kind: 'question', source: 'terminal-model' });
  });

  it('ignores normal terminal output', () => {
    expect(detectTerminalAttentionPrompt('npm test\n PASS test/config.test.ts')).toBeNull();
  });

  it('does not match approval words embedded inside other words', () => {
    expect(
      detectTerminalAttentionPrompt('the eyes know the answer and cannot reject nothing')
    ).toBeNull();
  });
});
