import { describe, expect, it } from 'vitest';

import {
  FILE_RESOURCE_REF_INTENTS,
  createFileResourceRef,
  fileResourceRefEquals,
  fileResourceRefSummary,
  parseFileResourceRef,
  type FileResourceRef,
} from '../shared/file-resource-ref.js';

describe('createFileResourceRef', () => {
  it('mints a ref with required fields', () => {
    const ref = createFileResourceRef({
      nodeId: 'node_abc',
      path: '/home/user/file.txt',
      intent: 'read',
    });
    expect(ref.nodeId).toBe('node_abc');
    expect(ref.path).toBe('/home/user/file.txt');
    expect(ref.intent).toBe('read');
    expect(typeof ref.capturedAt).toBe('string');
    expect(ref.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('normalizes paths and strips redundant segments', () => {
    const ref = createFileResourceRef({
      nodeId: 'n',
      path: '/foo//bar/./baz',
      intent: 'list',
    });
    expect(ref.path).toBe('/foo/bar/baz');
  });

  it('rejects relative paths', () => {
    expect(() =>
      createFileResourceRef({ nodeId: 'n', path: 'relative/path', intent: 'read' })
    ).toThrow(/absolute/);
  });

  it('rejects paths that escape root via `..`', () => {
    expect(() =>
      createFileResourceRef({ nodeId: 'n', path: '/foo/../../etc', intent: 'read' })
    ).toThrow(/escapes/);
  });

  it('rejects empty nodeId', () => {
    expect(() =>
      createFileResourceRef({
        nodeId: '' as string,
        path: '/x',
        intent: 'read',
      })
    ).toThrow(/nodeId/);
  });

  it('rejects unknown intents', () => {
    expect(() =>
      createFileResourceRef({
        nodeId: 'n',
        path: '/x',
        // @ts-expect-error: testing the runtime guard
        intent: 'write',
      })
    ).toThrow(/intent/);
  });

  it('enforces all four intents are accepted', () => {
    for (const intent of FILE_RESOURCE_REF_INTENTS) {
      const ref = createFileResourceRef({ nodeId: 'n', path: '/a', intent });
      expect(ref.intent).toBe(intent);
    }
  });

  it('drops nonsense size / mtime values silently rather than throwing', () => {
    const ref = createFileResourceRef({
      nodeId: 'n',
      path: '/x',
      intent: 'read',
      size: -10,
      mtimeMs: Number.NaN,
    });
    expect(ref.size).toBeUndefined();
    expect(ref.mtimeMs).toBeUndefined();
  });

  it('rejects malformed sha256 explicitly (vs accepting silently)', () => {
    expect(() =>
      createFileResourceRef({
        nodeId: 'n',
        path: '/x',
        intent: 'read',
        sha256: 'not-a-hex-string',
      })
    ).toThrow(/sha256/);
  });

  it('accepts a valid 64-hex sha256 and lowercases it', () => {
    const ref = createFileResourceRef({
      nodeId: 'n',
      path: '/x',
      intent: 'read',
      sha256: 'A'.repeat(64),
    });
    expect(ref.sha256).toBe('a'.repeat(64));
  });

  it('preserves repoBinding (path normalized, branch optional)', () => {
    const ref = createFileResourceRef({
      nodeId: 'n',
      path: '/a/b/c',
      intent: 'read',
      repoBinding: {
        repoPath: '/a',
        worktreePath: '/a/wt',
        branch: 'main',
      },
    });
    expect(ref.repoBinding?.repoPath).toBe('/a');
    expect(ref.repoBinding?.worktreePath).toBe('/a/wt');
    expect(ref.repoBinding?.branch).toBe('main');
  });

  it('rejects repoBinding with missing repoPath', () => {
    expect(() =>
      createFileResourceRef({
        nodeId: 'n',
        path: '/a/b',
        intent: 'read',
        // @ts-expect-error: missing repoPath
        repoBinding: { worktreePath: '/wt' },
      })
    ).toThrow(/repoPath/);
  });

  it('honors an explicit capturedAt override', () => {
    const ts = '2026-05-20T03:04:05.000Z';
    const ref = createFileResourceRef({
      nodeId: 'n',
      path: '/x',
      intent: 'read',
      capturedAt: ts,
    });
    expect(ref.capturedAt).toBe(ts);
  });

  it('rejects a non-ISO capturedAt override', () => {
    expect(() =>
      createFileResourceRef({
        nodeId: 'n',
        path: '/x',
        intent: 'read',
        capturedAt: '2026/05/20 12:00',
      })
    ).toThrow(/ISO/);
  });

  it('drops maxBytes <= 0', () => {
    const ref = createFileResourceRef({
      nodeId: 'n',
      path: '/x',
      intent: 'read',
      maxBytes: 0,
    });
    expect(ref.maxBytes).toBeUndefined();
  });
});

describe('parseFileResourceRef', () => {
  it('returns null for non-objects', () => {
    expect(parseFileResourceRef(null)).toBeNull();
    expect(parseFileResourceRef(undefined)).toBeNull();
    expect(parseFileResourceRef('a string')).toBeNull();
    expect(parseFileResourceRef(42)).toBeNull();
  });

  it('round-trips a valid ref through JSON', () => {
    const original = createFileResourceRef({
      nodeId: 'node_xyz',
      path: '/foo/bar.md',
      intent: 'read',
      size: 1234,
      sha256: 'f'.repeat(64),
      mtimeMs: 1716200000000,
      repoBinding: { repoPath: '/foo', branch: 'nightly' },
      maxBytes: 65536,
    });
    const parsed = parseFileResourceRef(JSON.parse(JSON.stringify(original)));
    expect(parsed).not.toBeNull();
    expect(parsed?.nodeId).toBe(original.nodeId);
    expect(parsed?.path).toBe(original.path);
    expect(parsed?.intent).toBe(original.intent);
    expect(parsed?.size).toBe(original.size);
    expect(parsed?.sha256).toBe(original.sha256);
    expect(parsed?.repoBinding?.repoPath).toBe('/foo');
    expect(parsed?.repoBinding?.branch).toBe('nightly');
  });

  it('returns null on malformed payload (bad intent)', () => {
    expect(parseFileResourceRef({ nodeId: 'n', path: '/x', intent: 'write' })).toBeNull();
  });

  it('returns null on malformed path', () => {
    expect(parseFileResourceRef({ nodeId: 'n', path: '../bad', intent: 'read' })).toBeNull();
  });

  it('returns null on malformed sha256', () => {
    expect(
      parseFileResourceRef({ nodeId: 'n', path: '/x', intent: 'read', sha256: 'short' })
    ).toBeNull();
  });
});

describe('fileResourceRefEquals', () => {
  function make(overrides: Partial<FileResourceRef> = {}): FileResourceRef {
    return createFileResourceRef({
      nodeId: 'n',
      path: '/x',
      intent: 'read',
      capturedAt: '2026-05-20T00:00:00.000Z',
      ...overrides,
    });
  }

  it('ignores mint-time decorations (size/sha256/mtime/capturedAt)', () => {
    const a = make({ size: 10, sha256: 'a'.repeat(64) });
    const b = make({ size: 999, capturedAt: '2026-05-21T00:00:00.000Z' });
    expect(fileResourceRefEquals(a, b)).toBe(true);
  });

  it('differs on intent', () => {
    expect(fileResourceRefEquals(make({ intent: 'read' }), make({ intent: 'tail' }))).toBe(false);
  });

  it('differs on repoBinding presence', () => {
    expect(
      fileResourceRefEquals(make(), make({ repoBinding: { repoPath: '/x' } }))
    ).toBe(false);
  });

  it('differs on repoBinding.branch', () => {
    expect(
      fileResourceRefEquals(
        make({ repoBinding: { repoPath: '/x', branch: 'main' } }),
        make({ repoBinding: { repoPath: '/x', branch: 'nightly' } })
      )
    ).toBe(false);
  });
});

describe('fileResourceRefSummary', () => {
  it('formats with no intent suffix for read', () => {
    const ref = createFileResourceRef({ nodeId: 'mac', path: '/Users/d', intent: 'read' });
    expect(fileResourceRefSummary(ref)).toBe('mac:/Users/d');
  });

  it('adds intent suffix for non-read', () => {
    const ref = createFileResourceRef({ nodeId: 'mac', path: '/Users/d', intent: 'tail' });
    expect(fileResourceRefSummary(ref)).toBe('mac:/Users/d (tail)');
  });
});
