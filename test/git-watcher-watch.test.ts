import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { GitWatcher } from '../server/watcher.js';

// Unit test for the #1249 fix: GitWatcher.watch() must NOT recursively watch
// IGNORED_DIRS (node_modules/.git/dist/…). On Linux, Node implements recursive
// fs.watch in JS by walking + inotify-watching every subdirectory, so a single
// fs.watch(root, {recursive:true}) on a working tree walks node_modules (100k+
// files) and wedges the event loop. The fix watches the root non-recursively
// and adds a recursive watch to each NON-ignored top-level directory only.
//
// These tests mock fs.watch / fs.readdirSync / fs.statSync / fs.existsSync so
// they are deterministic and platform-independent (no real inotify).

interface FakeWatcher {
  path: string;
  options: { persistent?: boolean; recursive?: boolean } | undefined;
  callback: ((event: string, filename: string | Buffer | null) => void) | null;
  close: MockInstance;
  on: MockInstance;
}

const WORKSPACE = path.join('/fake', 'workspace');

function dirent(name: string, isDir: boolean): fs.Dirent {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  } as unknown as fs.Dirent;
}

describe('GitWatcher.watch — excludes IGNORED_DIRS from recursive watching (#1249)', () => {
  let watchSpy: MockInstance;
  let created: FakeWatcher[];

  function fakeWatch(
    p: fs.PathLike,
    optionsOrListener?: unknown,
    maybeListener?: unknown
  ): fs.FSWatcher {
    const options =
      optionsOrListener && typeof optionsOrListener === 'object'
        ? (optionsOrListener as { persistent?: boolean; recursive?: boolean })
        : undefined;
    const callback = (
      typeof optionsOrListener === 'function'
        ? optionsOrListener
        : maybeListener
    ) as FakeWatcher['callback'];
    const fake: FakeWatcher = {
      path: String(p),
      options,
      callback: callback ?? null,
      close: vi.fn(),
      on: vi.fn(),
    };
    created.push(fake);
    return fake as unknown as fs.FSWatcher;
  }

  function watchFor(suffix: string): FakeWatcher | undefined {
    return created.find((w) => w.path === path.join(WORKSPACE, suffix));
  }

  beforeEach(() => {
    created = [];
    vi.useFakeTimers();

    // Top-level entries of the workspace: a source dir, an ignored dir, .git,
    // and a top-level file. Only `src` should get a recursive watch.
    vi.spyOn(fs, 'readdirSync').mockImplementation(((p: fs.PathLike) => {
      if (String(p) === WORKSPACE) {
        return [
          dirent('node_modules', true),
          dirent('.git', true),
          dirent('src', true),
          dirent('dist', true),
          dirent('README.md', false),
        ];
      }
      return [];
    }) as unknown as typeof fs.readdirSync);

    // .git is a directory (regular repo) → HEAD lives at .git/HEAD.
    vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike) => {
      if (String(p) === path.join(WORKSPACE, '.git')) {
        return { isFile: () => false } as fs.Stats;
      }
      throw new Error('ENOENT');
    }) as unknown as typeof fs.statSync);

    vi.spyOn(fs, 'existsSync').mockImplementation(((p: fs.PathLike) => {
      return String(p) === path.join(WORKSPACE, '.git', 'HEAD');
    }) as unknown as typeof fs.existsSync);

    watchSpy = vi
      .spyOn(fs, 'watch')
      .mockImplementation(fakeWatch as unknown as typeof fs.watch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('watches src recursively but NEVER node_modules, .git, or dist recursively', () => {
    const watcher = new GitWatcher();
    watcher.watch(WORKSPACE);

    const recursivePaths = created
      .filter((w) => w.options?.recursive === true)
      .map((w) => w.path);

    // src (non-ignored top-level dir) IS watched recursively.
    expect(recursivePaths).toContain(path.join(WORKSPACE, 'src'));

    // Ignored dirs are NEVER passed to fs.watch at all (recursive or not).
    for (const ignored of ['node_modules', '.git', 'dist']) {
      const ignoredDir = path.join(WORKSPACE, ignored);
      expect(recursivePaths).not.toContain(ignoredDir);
      expect(created.some((w) => w.path === ignoredDir)).toBe(false);
    }

    watcher.close();
  });

  it('watches the workspace root NON-recursively (top-level file edits detected)', () => {
    const watcher = new GitWatcher();
    watcher.watch(WORKSPACE);

    const rootWatch = watchFor('');
    // The root itself (WORKSPACE) is watched...
    expect(rootWatch).toBeDefined();
    // ...but NOT recursively (nightly's bug: fs.watch(root, {recursive:true})).
    expect(rootWatch?.options?.recursive).not.toBe(true);

    watcher.close();
  });

  it('unwatch closes every created sub-watcher (root + subs + HEAD)', () => {
    const watcher = new GitWatcher();
    watcher.watch(WORKSPACE);

    const madeWatchers = [...created];
    expect(madeWatchers.length).toBeGreaterThanOrEqual(3); // root + src + HEAD

    watcher.unwatch(WORKSPACE);

    for (const w of madeWatchers) {
      expect(w.close).toHaveBeenCalled();
    }
  });

  it('a source-file edit schedules an emit; a node_modules event does not', () => {
    const watcher = new GitWatcher();
    watcher.watch(WORKSPACE);

    const rootWatch = watchFor('');
    expect(rootWatch?.callback).toBeTypeOf('function');

    const debounceTimers = (
      watcher as unknown as { debounceTimers: Map<string, unknown> }
    ).debounceTimers;

    // A top-level source file edit → debounce timer scheduled.
    rootWatch!.callback!('change', 'README.md');
    expect(debounceTimers.has(WORKSPACE)).toBe(true);

    // Clear and confirm an ignored-dir (node_modules) event is filtered out.
    const timer = debounceTimers.get(WORKSPACE);
    clearTimeout(timer as ReturnType<typeof setTimeout>);
    debounceTimers.delete(WORKSPACE);

    rootWatch!.callback!('rename', 'node_modules');
    expect(debounceTimers.has(WORKSPACE)).toBe(false);

    watcher.close();
  });

  it('caps the number of recursive sub-watches and warns about the rest', () => {
    // Return more non-ignored top-level dirs than the safety cap.
    vi.spyOn(fs, 'readdirSync').mockImplementation(((p: fs.PathLike) => {
      if (String(p) === WORKSPACE) {
        return Array.from({ length: 200 }, (_v, i) => dirent(`pkg-${i}`, true));
      }
      return [];
    }) as unknown as typeof fs.readdirSync);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const watcher = new GitWatcher();
    watcher.watch(WORKSPACE);

    const recursiveCount = created.filter(
      (w) => w.options?.recursive === true
    ).length;

    // Bounded: never one-recursive-watch-per-dir when there are 200 dirs.
    expect(recursiveCount).toBeLessThan(200);
    expect(recursiveCount).toBeLessThanOrEqual(128); // generous upper bound on any sane cap
    expect(warnSpy).toHaveBeenCalled();

    watcher.close();
    warnSpy.mockRestore();
  });

  // Guardrail: prove the watchSpy is actually intercepting real fs.watch.
  it('installs the fs.watch spy', () => {
    const watcher = new GitWatcher();
    watcher.watch(WORKSPACE);
    expect(watchSpy).toHaveBeenCalled();
    watcher.close();
  });
});
