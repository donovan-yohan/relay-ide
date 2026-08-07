import { describe, it, expect } from 'vitest';
import { stripAnsi, cleanEnv } from '../server/utils.js';

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
    const testKey = '__RELAY_IDE_TEST_KEY__';
    (env as Record<string, string>)[testKey] = 'injected';
    expect(process.env[testKey]).toBe(undefined);
  });

  it('preserves other environment variables', () => {
    const env = cleanEnv();
    if (process.env.PATH !== undefined) {
      expect(env.PATH).toBe(process.env.PATH);
    }
  });
});
