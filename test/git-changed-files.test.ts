import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getChangedFiles,
  getFileDiff,
  getDefaultBranch,
} from '../server/git.js';

describe('getChangedFiles', () => {
  it('parses working tree changes from git status + numstat', async () => {
    const files = await getChangedFiles(
      '/tmp/repo',
      undefined,
      async (file, args, _opts) => {
        if (args[0] === 'status') {
          return {
            stdout:
              ' M server/git.ts\0?? frontend/new.svelte\0 D old-file.js\0',
            stderr: '',
          };
        }
        if (args[0] === 'diff' && args.includes('--numstat')) {
          return { stdout: '15\t3\tserver/git.ts\n', stderr: '' };
        }
        if (file === 'wc') {
          return { stdout: '      42 frontend/new.svelte', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      }
    );

    assert.equal(files.length, 3);

    const gitTs = files.find((f) => f.path === 'server/git.ts');
    assert.ok(gitTs);
    assert.equal(gitTs.status, 'modified');
    assert.equal(gitTs.additions, 15);
    assert.equal(gitTs.deletions, 3);
    assert.equal(gitTs.directory, 'server');

    const newFile = files.find((f) => f.path === 'frontend/new.svelte');
    assert.ok(newFile);
    assert.equal(newFile.status, 'untracked');
    assert.equal(newFile.additions, 42);
    assert.equal(newFile.directory, 'frontend');

    const deleted = files.find((f) => f.path === 'old-file.js');
    assert.ok(deleted);
    assert.equal(deleted.status, 'deleted');
    assert.equal(deleted.directory, '.');
  });

  it('parses branch comparison with renames', async () => {
    const files = await getChangedFiles(
      '/tmp/repo',
      'main',
      async (_file, args, _opts) => {
        if (args[0] === 'diff' && args.includes('--name-status')) {
          return {
            stdout:
              'M\tserver/git.ts\nA\tnew-file.ts\nR100\told-name.ts\tnew-name.ts\n',
            stderr: '',
          };
        }
        if (args[0] === 'diff' && args.includes('--numstat')) {
          return {
            stdout:
              '10\t2\tserver/git.ts\n50\t0\tnew-file.ts\n5\t5\tnew-name.ts\n',
            stderr: '',
          };
        }
        return { stdout: '', stderr: '' };
      }
    );

    assert.equal(files.length, 3);

    const renamed = files.find((f) => f.path === 'new-name.ts');
    assert.ok(renamed);
    assert.equal(renamed.status, 'renamed');
    assert.equal(renamed.oldPath, 'old-name.ts');
  });

  it('throws on git failure', async () => {
    await assert.rejects(
      () =>
        getChangedFiles('/tmp/repo', undefined, async () => {
          throw new Error('not a git repo');
        }),
      { message: 'not a git repo' }
    );
  });
});

describe('getFileDiff', () => {
  it('returns working tree diff for a file', async () => {
    const diff = await getFileDiff(
      '/tmp/repo',
      'server/git.ts',
      undefined,
      async (_file, args) => {
        assert.equal(args[0], 'diff');
        assert.ok(args.includes('--unified=3'));
        assert.ok(args.includes('--find-renames'));
        assert.ok(args.includes('--'));
        assert.ok(args.includes('server/git.ts'));
        return {
          stdout:
            'diff --git a/server/git.ts b/server/git.ts\n--- a/server/git.ts\n+++ b/server/git.ts\n@@ -1,3 +1,4 @@\n+new line\n old\n',
          stderr: '',
        };
      }
    );
    assert.ok(diff.includes('new line'));
  });

  it('returns staged diff when base is "cached"', async () => {
    const diff = await getFileDiff(
      '/tmp/repo',
      'file.ts',
      'cached',
      async (_file, args) => {
        assert.ok(args.includes('--cached'));
        return { stdout: 'staged diff output', stderr: '' };
      }
    );
    assert.equal(diff, 'staged diff output');
  });

  it('returns branch comparison diff', async () => {
    const diff = await getFileDiff(
      '/tmp/repo',
      'file.ts',
      'main',
      async (_file, args) => {
        assert.ok(args.includes('main...HEAD'));
        return { stdout: 'branch diff output', stderr: '' };
      }
    );
    assert.equal(diff, 'branch diff output');
  });

  it('falls back to --no-index for untracked files when first diff is empty', async () => {
    let callCount = 0;
    const diff = await getFileDiff(
      '/tmp/repo',
      'new-file.ts',
      undefined,
      async (_file, args) => {
        callCount++;
        if (callCount === 1) {
          // First call: git diff returns empty (untracked file)
          return { stdout: '', stderr: '' };
        }
        // Second call: git diff --no-index exits with code 1 but has stdout
        assert.ok(args.includes('--no-index'));
        const err = new Error('exit code 1') as Error & { stdout: string };
        err.stdout =
          'diff --git a/dev/null b/new-file.ts\n+++ b/new-file.ts\n+content\n';
        throw err;
      }
    );
    assert.ok(diff.includes('+content'));
    assert.equal(callCount, 2);
  });

  it('throws on git failure', async () => {
    await assert.rejects(
      () =>
        getFileDiff('/tmp/repo', 'file.ts', undefined, async () => {
          throw new Error('git failed');
        }),
      { message: 'git failed' }
    );
  });
});

describe('getDefaultBranch', () => {
  it('returns default branch from symbolic-ref', async () => {
    const branch = await getDefaultBranch('/tmp/repo', async (_file, args) => {
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'refs/remotes/origin/main\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    assert.equal(branch, 'main');
  });

  it('falls back to checking rev-parse for main then master', async () => {
    const branch = await getDefaultBranch('/tmp/repo', async (_file, args) => {
      if (args[0] === 'symbolic-ref') {
        throw new Error('not set');
      }
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        if (args[2] === 'refs/heads/main') {
          throw new Error('not found');
        }
        if (args[2] === 'refs/heads/master') {
          return { stdout: 'abc123\n', stderr: '' };
        }
      }
      return { stdout: '', stderr: '' };
    });
    assert.equal(branch, 'master');
  });

  it('returns "main" as ultimate fallback', async () => {
    const branch = await getDefaultBranch('/tmp/repo', async () => {
      throw new Error('everything fails');
    });
    assert.equal(branch, 'main');
  });
});
