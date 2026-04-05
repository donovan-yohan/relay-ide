import { describe, it, expect } from 'vitest';
import { stripAnsi, semverLessThan, cleanEnv } from '../server/utils.js';
import { onStateChange, fireStateChange } from '../server/sessions.js';
import type { AgentState } from '../server/types.js';

describe('stripAnsi', () => {
  it('strips CSI color sequences', () => {
    expect(stripAnsi('\x1b[32mhello\x1b[0m')).toBe('hello');
  });

  it('strips CSI bold/reset sequences', () => {
    expect(stripAnsi('\x1b[1mbold\x1b[0m')).toBe('bold');
  });

  it('strips OSC sequences', () => {
    expect(stripAnsi('\x1b]0;window title\x07plain')).toBe('plain');
  });

  it('strips cursor movement sequences', () => {
    expect(stripAnsi('\x1b[2Jhello')).toBe('hello');
  });

  it('preserves plain text', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
  });

  it('handles empty string', () => {
    expect(stripAnsi('')).toBe('');
  });

  it('strips multiple sequences in one string', () => {
    expect(stripAnsi('\x1b[32mfoo\x1b[0m and \x1b[1mbar\x1b[0m')).toBe(
      'foo and bar'
    );
  });
});

describe('semverLessThan', () => {
  it('returns true when major is lower', () => {
    expect(semverLessThan('1.0.0', '2.0.0')).toBe(true);
  });

  it('returns false when major is higher', () => {
    expect(semverLessThan('2.0.0', '1.0.0')).toBe(false);
  });

  it('returns true when patch is lower', () => {
    expect(semverLessThan('1.2.3', '1.2.4')).toBe(true);
  });

  it('returns false when patch is higher', () => {
    expect(semverLessThan('1.2.4', '1.2.3')).toBe(false);
  });

  it('returns false for equal versions', () => {
    expect(semverLessThan('1.0.0', '1.0.0')).toBe(false);
  });

  it('pre-release is less than release with same base version', () => {
    expect(semverLessThan('1.2.3-beta.1', '1.2.3')).toBe(true);
  });

  it('pre-release with lower base version is less than higher release', () => {
    expect(semverLessThan('1.2.3-beta.1', '1.3.0')).toBe(true);
  });

  it('returns true when minor is lower', () => {
    expect(semverLessThan('1.1.0', '1.2.0')).toBe(true);
  });

  it('handles major version jumps', () => {
    expect(semverLessThan('1.9.9', '2.0.0')).toBe(true);
  });
});

describe('cleanEnv', () => {
  it('returns an object that does not contain CLAUDECODE', () => {
    const originalValue = process.env.CLAUDECODE;
    process.env.CLAUDECODE = 'some-value';
    try {
      const env = cleanEnv();
      expect(Object.prototype.hasOwnProperty.call(env, 'CLAUDECODE')).toBe(
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
      expect(process.env.CLAUDECODE).toBe('test-token');
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
    expect(process.env[testKey]).toBe(undefined);
  });

  it('preserves other environment variables', () => {
    const env = cleanEnv();
    // PATH is virtually always set; verify it round-trips
    if (process.env.PATH !== undefined) {
      expect(env.PATH).toBe(process.env.PATH);
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
    expect(match).toBeTruthy();
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

    expect(count).toBeGreaterThanOrEqual(2);
  });

  it('passes idle state to callback', () => {
    let received: AgentState | undefined;
    onStateChange((_, state) => {
      received = state;
    });

    fireStateChange('some-session', 'idle');

    expect(received).toBe('idle');
  });

  it('passes permission-prompt state to callback', () => {
    let received: AgentState | undefined;
    onStateChange((_, state) => {
      received = state;
    });

    fireStateChange('some-session', 'permission-prompt');

    expect(received).toBe('permission-prompt');
  });

  it('passes waiting-for-input state to callback', () => {
    let received: AgentState | undefined;
    onStateChange((_, state) => {
      received = state;
    });

    fireStateChange('some-session', 'waiting-for-input');

    expect(received).toBe('waiting-for-input');
  });
});
