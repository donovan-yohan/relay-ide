import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getChangedFiles } from '../server/git.js';

describe('getChangedFiles', () => {
  it('parses working tree changes from git status + numstat', async () => {
    const files = await getChangedFiles('/tmp/repo', undefined, async (file, args, _opts) => {
      if (args[0] === 'status') {
        return { stdout: ' M server/git.ts\0?? frontend/new.svelte\0 D old-file.js\0', stderr: '' };
      }
      if (args[0] === 'diff' && args.includes('--numstat')) {
        return { stdout: '15\t3\tserver/git.ts\n', stderr: '' };
      }
      if (file === 'wc') {
        return { stdout: '      42 frontend/new.svelte', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    assert.equal(files.length, 3);

    const gitTs = files.find(f => f.path === 'server/git.ts');
    assert.ok(gitTs);
    assert.equal(gitTs.status, 'modified');
    assert.equal(gitTs.additions, 15);
    assert.equal(gitTs.deletions, 3);
    assert.equal(gitTs.directory, 'server');

    const newFile = files.find(f => f.path === 'frontend/new.svelte');
    assert.ok(newFile);
    assert.equal(newFile.status, 'untracked');
    assert.equal(newFile.additions, 42);
    assert.equal(newFile.directory, 'frontend');

    const deleted = files.find(f => f.path === 'old-file.js');
    assert.ok(deleted);
    assert.equal(deleted.status, 'deleted');
    assert.equal(deleted.directory, '.');
  });

  it('parses branch comparison with renames', async () => {
    const files = await getChangedFiles('/tmp/repo', 'main', async (_file, args, _opts) => {
      if (args[0] === 'diff' && args.includes('--name-status')) {
        return { stdout: 'M\tserver/git.ts\nA\tnew-file.ts\nR100\told-name.ts\tnew-name.ts\n', stderr: '' };
      }
      if (args[0] === 'diff' && args.includes('--numstat')) {
        return { stdout: '10\t2\tserver/git.ts\n50\t0\tnew-file.ts\n5\t5\tnew-name.ts\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    assert.equal(files.length, 3);

    const renamed = files.find(f => f.path === 'new-name.ts');
    assert.ok(renamed);
    assert.equal(renamed.status, 'renamed');
    assert.equal(renamed.oldPath, 'old-name.ts');
  });

  it('returns empty array on git failure', async () => {
    const files = await getChangedFiles('/tmp/repo', undefined, async () => {
      throw new Error('not a git repo');
    });
    assert.deepEqual(files, []);
  });
});
