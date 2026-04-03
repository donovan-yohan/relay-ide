import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stripAnsi, semverLessThan, cleanEnv } from '../server/utils.js';
import { onStateChange, fireStateChange } from '../server/sessions.js';
import type { AgentState } from '../server/types.js';

describe('stripAnsi', () => {
  it('strips CSI color sequences', () => {
    assert.equal(stripAnsi('\x1b[32mhello\x1b[0m'), 'hello');
  });

  it('strips CSI bold/reset sequences', () => {
    assert.equal(stripAnsi('\x1b[1mbold\x1b[0m'), 'bold');
  });

  it('strips OSC sequences', () => {
    assert.equal(stripAnsi('\x1b]0;window title\x07plain'), 'plain');
  });

  it('strips cursor movement sequences', () => {
    assert.equal(stripAnsi('\x1b[2Jhello'), 'hello');
  });

  it('preserves plain text', () => {
    assert.equal(stripAnsi('hello world'), 'hello world');
  });

  it('handles empty string', () => {
    assert.equal(stripAnsi(''), '');
  });

  it('strips multiple sequences in one string', () => {
    assert.equal(
      stripAnsi('\x1b[32mfoo\x1b[0m and \x1b[1mbar\x1b[0m'),
      'foo and bar'
    );
  });
});

describe('semverLessThan', () => {
  it('returns true when major is lower', () => {
    assert.equal(semverLessThan('1.0.0', '2.0.0'), true);
  });

  it('returns false when major is higher', () => {
    assert.equal(semverLessThan('2.0.0', '1.0.0'), false);
  });

  it('returns true when patch is lower', () => {
    assert.equal(semverLessThan('1.2.3', '1.2.4'), true);
  });

  it('returns false when patch is higher', () => {
    assert.equal(semverLessThan('1.2.4', '1.2.3'), false);
  });

  it('returns false for equal versions', () => {
    assert.equal(semverLessThan('1.0.0', '1.0.0'), false);
  });

  it('strips pre-release tag before comparing — 1.2.3-beta.1 vs 1.2.3 treated as equal', () => {
    assert.equal(semverLessThan('1.2.3-beta.1', '1.2.3'), false);
  });

  it('strips pre-release tag before comparing — 1.2.3-beta.1 vs 1.3.0 treated as less than', () => {
    assert.equal(semverLessThan('1.2.3-beta.1', '1.3.0'), true);
  });

  it('returns true when minor is lower', () => {
    assert.equal(semverLessThan('1.1.0', '1.2.0'), true);
  });

  it('handles major version jumps', () => {
    assert.equal(semverLessThan('1.9.9', '2.0.0'), true);
  });
});

describe('cleanEnv', () => {
  it('returns an object that does not contain CLAUDECODE', () => {
    const originalValue = process.env.CLAUDECODE;
    process.env.CLAUDECODE = 'some-value';
    try {
      const env = cleanEnv();
      assert.equal(
        Object.prototype.hasOwnProperty.call(env, 'CLAUDECODE'),
        false
      );
    } finally {
      if (originalValue === undefined) {
        delete process.env.CLAUDECODE;
      } else {
        process.env.CLAUDECODE = originalValue;
      }
    }
  });

  it('does not modify original process.env', () => {
    const originalValue = process.env.CLAUDECODE;
    process.env.CLAUDECODE = 'test-token';
    try {
      cleanEnv();
      assert.equal(process.env.CLAUDECODE, 'test-token');
    } finally {
      if (originalValue === undefined) {
        delete process.env.CLAUDECODE;
      } else {
        process.env.CLAUDECODE = originalValue;
      }
    }
  });

  it('returns a copy — mutations do not affect process.env', () => {
    const env = cleanEnv();
    const testKey = '__CRC_TEST_KEY__';
    (env as Record<string, string>)[testKey] = 'injected';
    assert.equal(process.env[testKey], undefined);
  });

  it('preserves other environment variables', () => {
    const env = cleanEnv();
    // PATH is virtually always set; verify it round-trips
    if (process.env.PATH !== undefined) {
      assert.equal(env.PATH, process.env.PATH);
    }
  });
});

describe('fireStateChange callbacks', () => {
  it('calls a registered onStateChange callback with correct args', () => {
    const received: Array<{ sessionId: string; state: AgentState }> = [];

    onStateChange((sessionId, state) => {
      received.push({ sessionId, state });
    });

    fireStateChange('test-session-id', 'processing');

    const match = received.find(
      (e) => e.sessionId === 'test-session-id' && e.state === 'processing'
    );
    assert.ok(
      match,
      'callback should have been called with the expected sessionId and state'
    );
  });

  it('fires multiple registered callbacks', () => {
    let count = 0;
    onStateChange(() => {
      count++;
    });
    onStateChange(() => {
      count++;
    });

    fireStateChange('multi-cb-session', 'idle');

    assert.ok(count >= 2, 'both callbacks should have been invoked');
  });

  it('passes idle state to callback', () => {
    let received: AgentState | undefined;
    onStateChange((_, state) => {
      received = state;
    });

    fireStateChange('some-session', 'idle');

    assert.equal(received, 'idle');
  });

  it('passes permission-prompt state to callback', () => {
    let received: AgentState | undefined;
    onStateChange((_, state) => {
      received = state;
    });

    fireStateChange('some-session', 'permission-prompt');

    assert.equal(received, 'permission-prompt');
  });

  it('passes waiting-for-input state to callback', () => {
    let received: AgentState | undefined;
    onStateChange((_, state) => {
      received = state;
    });

    fireStateChange('some-session', 'waiting-for-input');

    assert.equal(received, 'waiting-for-input');
  });
});
