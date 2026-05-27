// #730: unit tests for the PURE Bench-creation helpers. These MIRROR the
// server's `validateBenchCwd` (server/features/repo-router.ts) so the client
// rejects bad input before a round-trip, and verify the create-payload builder
// drops empty fields + blank env keys.
import { describe, expect, it } from 'vitest';

import {
  benchCwdErrorMessage,
  buildBenchPayload,
  validateBenchCwd,
} from '../frontend/src/lib/state/bench-create.js';

describe('validateBenchCwd', () => {
  it('accepts a POSIX absolute path', () => {
    expect(validateBenchCwd('/home/user/project')).toBeNull();
    expect(validateBenchCwd('/tmp/scratch')).toBeNull();
    expect(validateBenchCwd('/')).toBeNull();
  });

  it('accepts a Windows absolute path (both slash styles)', () => {
    expect(validateBenchCwd('C:\\Users\\me\\repo')).toBeNull();
    expect(validateBenchCwd('D:/projects/app')).toBeNull();
  });

  it('rejects a blank / whitespace-only cwd', () => {
    expect(validateBenchCwd('')).toBe('CWD_REQUIRED');
    expect(validateBenchCwd('   ')).toBe('CWD_REQUIRED');
  });

  it('rejects a relative path', () => {
    expect(validateBenchCwd('relative/path')).toBe('CWD_NOT_ABSOLUTE');
    expect(validateBenchCwd('./here')).toBe('CWD_NOT_ABSOLUTE');
    expect(validateBenchCwd('~/home')).toBe('CWD_NOT_ABSOLUTE');
  });

  it('rejects `..` traversal anywhere in the path', () => {
    expect(validateBenchCwd('/home/../etc')).toBe('CWD_TRAVERSAL');
    expect(validateBenchCwd('/a/b/..')).toBe('CWD_TRAVERSAL');
    expect(validateBenchCwd('C:\\a\\..\\b')).toBe('CWD_TRAVERSAL');
  });

  it('rejects control / NUL characters', () => {
    expect(validateBenchCwd('/home/\x00/evil')).toBe('INVALID_CWD');
    expect(validateBenchCwd('/home/\nnewline')).toBe('INVALID_CWD');
    expect(validateBenchCwd('/home/\x7f')).toBe('INVALID_CWD');
  });

  it('does NOT reject a single dot segment (only `..` traversal)', () => {
    // A lone `.` is not a traversal segment; the server treats it the same.
    expect(validateBenchCwd('/home/.config/app')).toBeNull();
  });

  it('maps every error code to a non-empty message', () => {
    for (const code of [
      'CWD_REQUIRED',
      'CWD_NOT_ABSOLUTE',
      'CWD_TRAVERSAL',
      'INVALID_CWD',
    ] as const) {
      expect(benchCwdErrorMessage(code).length).toBeGreaterThan(0);
    }
  });
});

describe('buildBenchPayload', () => {
  it('trims surrounding whitespace off the cwd but keeps it verbatim', () => {
    const payload = buildBenchPayload({
      instanceId: 'inst:proj:node',
      cwd: '  /home/user/with spaces  ',
    });
    // Interior bytes (the space) are preserved — not decoded, not normalized.
    expect(payload.cwd).toBe('/home/user/with spaces');
    expect(payload.instanceId).toBe('inst:proj:node');
  });

  it('omits label when blank, includes it (trimmed) when present', () => {
    expect(
      buildBenchPayload({ instanceId: 'i', cwd: '/x', label: '   ' }).label
    ).toBeUndefined();
    expect(
      buildBenchPayload({ instanceId: 'i', cwd: '/x', label: '  feature  ' })
        .label
    ).toBe('feature');
  });

  it('omits envOverrides entirely when there are no usable entries', () => {
    expect(
      buildBenchPayload({
        instanceId: 'i',
        cwd: '/x',
        envEntries: [{ key: '   ', value: 'ignored' }],
      }).envOverrides
    ).toBeUndefined();
    expect(
      buildBenchPayload({ instanceId: 'i', cwd: '/x' }).envOverrides
    ).toBeUndefined();
  });

  it('collects env entries, dropping blank keys and keeping empty values', () => {
    const payload = buildBenchPayload({
      instanceId: 'i',
      cwd: '/x',
      envEntries: [
        { key: 'FOO', value: 'bar' },
        { key: '  BAZ  ', value: '' },
        { key: '', value: 'dropped' },
      ],
    });
    expect(payload.envOverrides).toEqual({ FOO: 'bar', BAZ: '' });
  });

  it('last-write-wins for a duplicated env key', () => {
    const payload = buildBenchPayload({
      instanceId: 'i',
      cwd: '/x',
      envEntries: [
        { key: 'FOO', value: 'first' },
        { key: 'FOO', value: 'second' },
      ],
    });
    expect(payload.envOverrides).toEqual({ FOO: 'second' });
  });

  it('does not decode percent-encoded sequences in the cwd (C1)', () => {
    // A literal "%2e%2e" must NOT become ".." — we send the raw path.
    const payload = buildBenchPayload({
      instanceId: 'i',
      cwd: '/home/%2e%2e/literal',
    });
    expect(payload.cwd).toBe('/home/%2e%2e/literal');
  });
});
