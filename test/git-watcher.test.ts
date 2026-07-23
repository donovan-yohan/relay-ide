import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GitWatcher } from '../server/watcher.js';

let tmpDir: string;
let repoDir: string;

beforeAll(() => {
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

afterAll(() => {
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

    expect(emitted).toBeTruthy();
    expect(emittedPath).toBe(repoDir);

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

    expect(emitCount).toBe(countBefore);

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

    expect(emitted).toBeFalsy();

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

    expect(emitted).toBeTruthy();

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

    expect(emitCount).toBe(0);
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

  it('releases each session watch exactly once when session-end fires twice', () => {
    const watcher = new GitWatcher();
    watcher.watchSession('session-a', repoDir);
    watcher.watchSession('session-b', repoDir);

    watcher.unwatchSession('session-a');
    watcher.unwatchSession('session-a');

    const entry = (
      watcher as unknown as {
        watchers: Map<string, { refCount: number }>;
      }
    ).watchers.get(repoDir);
    expect(entry?.refCount).toBe(1);

    watcher.unwatchSession('session-b');
    expect(
      (
        watcher as unknown as {
          watchers: Map<string, { refCount: number }>;
        }
      ).watchers.has(repoDir)
    ).toBe(false);
    watcher.close();
  });

  it('moves an existing session watch without retaining its old cwd', () => {
    const otherRepoDir = path.join(tmpDir, 'other-repo');
    fs.mkdirSync(path.join(otherRepoDir, '.git'), { recursive: true });
    fs.writeFileSync(
      path.join(otherRepoDir, '.git', 'HEAD'),
      'ref: refs/heads/main\n'
    );

    const watcher = new GitWatcher();
    watcher.watchSession('moving-session', repoDir);
    watcher.watchSession('moving-session', repoDir);
    watcher.watchSession('moving-session', otherRepoDir);

    const entries = (
      watcher as unknown as {
        watchers: Map<string, { refCount: number }>;
      }
    ).watchers;
    expect(entries.has(repoDir)).toBe(false);
    expect(entries.get(otherRepoDir)?.refCount).toBe(1);
    watcher.close();
  });
});
