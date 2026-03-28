import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GitWatcher } from '../server/watcher.js';

let tmpDir: string;
let repoDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-watcher-test-'));
  repoDir = path.join(tmpDir, 'repo');
  fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true });
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('GitWatcher', () => {
  it('emits files-changed when .git/ directory changes', async () => {
    const watcher = new GitWatcher();
    let emitted = false;
    let emittedPath = '';

    watcher.on('files-changed', (data: { workspacePath: string }) => {
      emitted = true;
      emittedPath = data.workspacePath;
    });

    watcher.watch(repoDir);

    // Trigger a change in .git/
    fs.writeFileSync(path.join(repoDir, '.git', 'index'), 'fake');

    // Wait for debounce (500ms) + buffer
    await new Promise(resolve => setTimeout(resolve, 800));

    assert.ok(emitted, 'should emit files-changed');
    assert.equal(emittedPath, repoDir);

    watcher.close();
  });

  it('does not emit after close()', async () => {
    const watcher = new GitWatcher();
    let emitCount = 0;

    watcher.on('files-changed', () => { emitCount++; });
    watcher.watch(repoDir);
    watcher.close();

    fs.writeFileSync(path.join(repoDir, '.git', 'index2'), 'fake');
    await new Promise(resolve => setTimeout(resolve, 800));

    assert.equal(emitCount, 0);
  });

  it('deduplicates watchers for the same path', () => {
    const watcher = new GitWatcher();
    watcher.watch(repoDir);
    watcher.watch(repoDir);
    // Should not throw, refCount = 2
    watcher.unwatch(repoDir);
    // Still watching (refCount = 1)
    watcher.unwatch(repoDir);
    // Now closed (refCount = 0)
    watcher.close();
  });
});
