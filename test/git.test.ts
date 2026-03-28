import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { listBranches, normalizeBranchNames } from '../server/git.js';
import { ensureBranchLocal } from '../server/git.js';

describe('normalizeBranchNames', () => {
  it('deduplicates refs, strips origin prefixes, and skips HEAD entries', () => {
    const stdout = [
      'main',
      'origin/main',
      'origin/feat/remote-only',
      'feat/local',
      'remotes/origin/HEAD -> origin/main',
      'origin/feat/remote-only',
      '',
    ].join('\n');

    assert.deepEqual(normalizeBranchNames(stdout), [
      'feat/local',
      'feat/remote-only',
      'main',
    ]);
  });
});

describe('listBranches', () => {
  it('refreshes remotes before listing when requested', async () => {
    const calls: Array<{ file: string; args: string[]; cwd: string }> = [];

    const branches = await listBranches('/tmp/repo', {
      refresh: true,
      exec: async (file, args, options) => {
        calls.push({ file, args, cwd: options.cwd });
        if (args[0] === 'fetch') {
          return { stdout: '', stderr: '' };
        }
        return {
          stdout: ['main', 'origin/main', 'origin/feature/remote'].join('\n'),
          stderr: '',
        };
      },
    });

    assert.deepEqual(calls, [
      { file: 'git', args: ['fetch', '--all', '--prune'], cwd: '/tmp/repo' },
      { file: 'git', args: ['branch', '-a', '--format=%(refname:short)'], cwd: '/tmp/repo' },
    ]);
    assert.deepEqual(branches, ['feature/remote', 'main']);
  });

  it('falls back to locally-known refs if fetch fails', async () => {
    const branches = await listBranches('/tmp/repo', {
      refresh: true,
      exec: async (_file, args) => {
        if (args[0] === 'fetch') {
          throw new Error('network down');
        }
        return {
          stdout: ['main', 'origin/feature/stale'].join('\n'),
          stderr: '',
        };
      },
    });

    assert.deepEqual(branches, ['feature/stale', 'main']);
  });

  it('returns an empty list when refs cannot be listed', async () => {
    const branches = await listBranches('/tmp/repo', {
      exec: async () => {
        throw new Error('git failed');
      },
    });

    assert.deepEqual(branches, []);
  });
});

describe('ensureBranchLocal', () => {
  it('returns true immediately if branch exists locally', async () => {
    const calls: string[][] = [];
    const exec = async (_cmd: string, args: string[], _opts: { cwd: string; timeout?: number }) => {
      calls.push(args);
      return { stdout: 'abc123\n', stderr: '' };
    };
    const result = await ensureBranchLocal('/tmp/repo', 'main', { exec });
    assert.equal(result.found, true);
    assert.deepEqual(calls, [['rev-parse', '--verify', 'main']]);
  });

  it('fetches from origin if branch does not exist locally', async () => {
    const calls: string[][] = [];
    let revParseCount = 0;
    const exec = async (_cmd: string, args: string[], _opts: { cwd: string; timeout?: number }) => {
      calls.push(args);
      if (args[0] === 'rev-parse') {
        revParseCount++;
        if (revParseCount === 1) throw new Error('not found');
        return { stdout: 'abc123\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };
    const result = await ensureBranchLocal('/tmp/repo', 'feature/remote-only', { exec });
    assert.equal(result.found, true);
    assert.deepEqual(calls[1], ['fetch', 'origin', 'feature/remote-only:feature/remote-only']);
  });

  it('returns found:false if branch does not exist locally or on remote', async () => {
    const exec = async (_cmd: string, _args: string[], _opts: { cwd: string; timeout?: number }) => {
      throw new Error('fatal: not found');
    };
    const result = await ensureBranchLocal('/tmp/repo', 'nonexistent', { exec });
    assert.equal(result.found, false);
  });
});
