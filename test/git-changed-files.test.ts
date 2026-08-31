import { describe, it, expect } from 'vitest';
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

    expect(files.length).toBe(3);

    const gitTs = files.find((f) => f.path === 'server/git.ts');
    expect(gitTs).toBeTruthy();
    expect(gitTs!.status).toBe('modified');
    expect(gitTs!.additions).toBe(15);
    expect(gitTs!.deletions).toBe(3);
    expect(gitTs!.directory).toBe('server');

    const newFile = files.find((f) => f.path === 'frontend/new.svelte');
    expect(newFile).toBeTruthy();
    expect(newFile!.status).toBe('untracked');
    expect(newFile!.additions).toBe(42);
    expect(newFile!.directory).toBe('frontend');

    const deleted = files.find((f) => f.path === 'old-file.js');
    expect(deleted).toBeTruthy();
    expect(deleted!.status).toBe('deleted');
    expect(deleted!.directory).toBe('.');
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

    expect(files.length).toBe(3);

    const renamed = files.find((f) => f.path === 'new-name.ts');
    expect(renamed).toBeTruthy();
    expect(renamed!.status).toBe('renamed');
    expect(renamed!.oldPath).toBe('old-name.ts');
  });

  it('throws on git failure', async () => {
    await expect(() =>
      getChangedFiles('/tmp/repo', undefined, async () => {
        throw new Error('not a git repo');
      })
    ).rejects.toThrow('not a git repo');
  });
});

describe('getFileDiff', () => {
  it('returns working tree diff for a file', async () => {
    const diff = await getFileDiff(
      '/tmp/repo',
      'server/git.ts',
      undefined,
      async (_file, args) => {
        expect(args[0]).toBe('diff');
        expect(args).toContain('--unified=3');
        expect(args).toContain('--find-renames');
        expect(args).toContain('--');
        expect(args).toContain('server/git.ts');
        return {
          stdout:
            'diff --git a/server/git.ts b/server/git.ts\n--- a/server/git.ts\n+++ b/server/git.ts\n@@ -1,3 +1,4 @@\n+new line\n old\n',
          stderr: '',
        };
      }
    );
    expect(diff).toContain('new line');
  });

  it('returns staged diff when base is "cached"', async () => {
    const diff = await getFileDiff(
      '/tmp/repo',
      'file.ts',
      'cached',
      async (_file, args) => {
        expect(args).toContain('--cached');
        return { stdout: 'staged diff output', stderr: '' };
      }
    );
    expect(diff).toBe('staged diff output');
  });

  it('returns branch comparison diff', async () => {
    const diff = await getFileDiff(
      '/tmp/repo',
      'file.ts',
      'main',
      async (_file, args) => {
        expect(args).toContain('main...HEAD');
        return { stdout: 'branch diff output', stderr: '' };
      }
    );
    expect(diff).toBe('branch diff output');
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
        if (callCount === 2) {
          // Second call: git status --porcelain confirms untracked
          expect(args[0]).toBe('status');
          expect(args).toContain('--porcelain');
          return { stdout: '?? new-file.ts\n', stderr: '' };
        }
        // Third call: git diff --no-index exits with code 1 but has stdout
        expect(args).toContain('--no-index');
        const err = new Error('exit code 1') as Error & { stdout: string };
        err.stdout =
          'diff --git a/dev/null b/new-file.ts\n+++ b/new-file.ts\n+content\n';
        throw err;
      }
    );
    expect(diff).toContain('+content');
    expect(callCount).toBe(3);
  });

  it('does not fall back to --no-index when untracked status cannot be confirmed', async () => {
    let callCount = 0;
    const diff = await getFileDiff(
      '/tmp/repo',
      'maybe-new-file.ts',
      undefined,
      async (_file, args) => {
        callCount++;
        if (callCount === 1) {
          return { stdout: '', stderr: '' };
        }
        expect(args[0]).toBe('status');
        throw new Error('status failed');
      }
    );
    expect(diff).toBe('');
    expect(callCount).toBe(2);
  });

  it('throws on git failure', async () => {
    await expect(() =>
      getFileDiff('/tmp/repo', 'file.ts', undefined, async () => {
        throw new Error('git failed');
      })
    ).rejects.toThrow('git failed');
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
    expect(branch).toBe('main');
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
    expect(branch).toBe('master');
  });

  it('returns "main" as ultimate fallback', async () => {
    const branch = await getDefaultBranch('/tmp/repo', async () => {
      throw new Error('everything fails');
    });
    expect(branch).toBe('main');
  });
});
