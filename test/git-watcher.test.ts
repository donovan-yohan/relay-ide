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
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'node_modules', 'dep'), { recursive: true });
  // Create a HEAD file so the HEAD watcher can attach
  fs.writeFileSync(
    path.join(repoDir, '.git', 'HEAD'),
    'ref: refs/heads/main\n'
  );
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('GitWatcher', () => {
  it('emits files-changed when a working-tree file changes', async () => {
    const watcher = new GitWatcher();
    let emitted = false;
    let emittedPath = '';

    watcher.on('files-changed', (data: { workspacePath: string }) => {
      emitted = true;
      emittedPath = data.workspacePath;
    });

    watcher.watch(repoDir);

    // Write a source file (should trigger)
    fs.writeFileSync(path.join(repoDir, 'src', 'index.ts'), 'export {}');

    // Wait for debounce (1000ms) + buffer
    await new Promise((resolve) => setTimeout(resolve, 1500));

    assert.ok(emitted, 'should emit files-changed for working-tree file');
    assert.equal(emittedPath, repoDir);

    watcher.close();
  });

  it('does NOT emit for .git/ changes', async () => {
    const watcher = new GitWatcher();
    let emitCount = 0;

    watcher.on('files-changed', () => {
      emitCount++;
    });
    watcher.watch(repoDir);

    // Write to .git/ (should be filtered)
    fs.writeFileSync(path.join(repoDir, '.git', 'index'), 'fake');

    await new Promise((resolve) => setTimeout(resolve, 1500));

    // The HEAD watcher may fire from the before() setup, so we only check
    // that .git/index specifically doesn't cause extra emissions.
    // Reset and test again cleanly.
    const countBefore = emitCount;
    fs.writeFileSync(path.join(repoDir, '.git', 'index'), 'fake2');
    await new Promise((resolve) => setTimeout(resolve, 1500));

    assert.equal(
      emitCount,
      countBefore,
      'should not emit for .git/index changes'
    );

    watcher.close();
  });

  it('does NOT emit for node_modules/ changes', async () => {
    const watcher = new GitWatcher();
    let emitted = false;

    // Wait for any initial events to settle
    watcher.watch(repoDir);
    await new Promise((resolve) => setTimeout(resolve, 1500));

    watcher.on('files-changed', () => {
      emitted = true;
    });

    fs.writeFileSync(
      path.join(repoDir, 'node_modules', 'dep', 'index.js'),
      'module.exports = {}'
    );

    await new Promise((resolve) => setTimeout(resolve, 1500));

    assert.ok(!emitted, 'should not emit for node_modules/ changes');

    watcher.close();
  });

  it('emits when .git/HEAD changes (commit or branch switch)', async () => {
    const watcher = new GitWatcher();
    let emitted = false;

    watcher.watch(repoDir);
    // Let initial events settle
    await new Promise((resolve) => setTimeout(resolve, 1500));

    watcher.on('files-changed', () => {
      emitted = true;
    });

    // Simulate a branch switch
    fs.writeFileSync(
      path.join(repoDir, '.git', 'HEAD'),
      'ref: refs/heads/feature\n'
    );

    await new Promise((resolve) => setTimeout(resolve, 1500));

    assert.ok(emitted, 'should emit when .git/HEAD changes');

    watcher.close();
  });

  it('does not emit after close()', async () => {
    const watcher = new GitWatcher();
    let emitCount = 0;

    watcher.on('files-changed', () => {
      emitCount++;
    });
    watcher.watch(repoDir);
    watcher.close();

    fs.writeFileSync(path.join(repoDir, 'src', 'closed.ts'), 'export {}');
    await new Promise((resolve) => setTimeout(resolve, 1500));

    assert.equal(emitCount, 0);
  });

  it('deduplicates watchers for the same path via refCount', () => {
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
