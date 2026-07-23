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
import { GitWatcher, IGNORED_DIRS } from '../server/watcher.js';

// Unit tests for the #1249 / PR #1251-review-P0 fix. The watcher must NEVER walk
// or watch IGNORED_DIRS (node_modules/.git/.worktrees/.claude/dist/…) at ANY
// depth. Node's recursive fs.watch on Linux is implemented in JS: it walks +
// inotify-watches every subdirectory with NO per-level exclusion — so the old
// "exclude ignored dirs only at the top level, then fs.watch(dir,{recursive})"
// approach STILL walked NESTED ignored trees (e.g. the dogfood checkout's
// `.worktrees/*/node_modules`, ~12k dirs / 115k files, LARGER than the root
// node_modules) and re-wedged the hub. The robust fix walks the tree itself,
// pruning IGNORED_DIRS at every level, and attaches a NON-recursive watch to
// each non-ignored directory, maintained dynamically on create/delete.
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
const HEAD_PATH = path.join(WORKSPACE, '.git', 'HEAD');
const sep = path.sep;

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

interface Child {
  name: string;
  dir: boolean;
}

/**
 * Mutable virtual directory tree. Only directories with a listing entry "exist"
 * for readdirSync; removing an entry makes readdirSync throw ENOENT (simulating
 * a deleted directory). Undeclared directories that are nonetheless watched read
 * back as empty (readdirSync throws → walk treats as no children).
 */
class FakeTree {
  private listings = new Map<string, Child[]>();

  setDir(dirPath: string, children: Child[]): void {
    this.listings.set(dirPath, children);
  }

  removeDir(dirPath: string): void {
    this.listings.delete(dirPath);
  }

  readdir(dirPath: string): fs.Dirent[] {
    const listing = this.listings.get(dirPath);
    if (!listing) {
      const err = new Error(
        `ENOENT: no such directory, ${dirPath}`
      ) as Error & {
        code?: string;
      };
      err.code = 'ENOENT';
      throw err;
    }
    return listing.map((c) => dirent(c.name, c.dir));
  }
}

describe('GitWatcher.watch — per-level IGNORED_DIRS pruning (#1249 / PR #1251 P0)', () => {
  let watchSpy: MockInstance;
  let created: FakeWatcher[];
  let tree: FakeTree;

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

  function watchFor(absPath: string): FakeWatcher | undefined {
    return created.find((w) => w.path === absPath);
  }

  /** Absolute paths passed to fs.watch, excluding the single HEAD file watch. */
  function dirWatchPaths(): string[] {
    return created.filter((w) => w.path !== HEAD_PATH).map((w) => w.path);
  }

  function entryFor(
    watcher: GitWatcher,
    workspace: string
  ): { dirWatchers: Map<string, fs.FSWatcher> } {
    return (
      watcher as unknown as {
        watchers: Map<string, { dirWatchers: Map<string, fs.FSWatcher> }>;
      }
    ).watchers.get(workspace)!;
  }

  function debounceTimers(
    watcher: GitWatcher
  ): Map<string, ReturnType<typeof setTimeout>> {
    return (
      watcher as unknown as {
        debounceTimers: Map<string, ReturnType<typeof setTimeout>>;
      }
    ).debounceTimers;
  }

  beforeEach(() => {
    created = [];
    tree = new FakeTree();
    vi.useFakeTimers();

    // Default layout with NESTED ignored dirs (the P0 repro):
    //   workspace/.worktrees/wt1/node_modules/...      (never watched)
    //   workspace/packages/foo/node_modules/...        (never watched)
    //   workspace/src/a/b/c.ts                         (watched at depth)
    tree.setDir(WORKSPACE, [
      { name: '.git', dir: true },
      { name: 'node_modules', dir: true },
      { name: '.worktrees', dir: true },
      { name: '.claude', dir: true },
      { name: 'src', dir: true },
      { name: 'packages', dir: true },
      { name: 'README.md', dir: false },
    ]);
    tree.setDir(path.join(WORKSPACE, 'src'), [{ name: 'a', dir: true }]);
    tree.setDir(path.join(WORKSPACE, 'src', 'a'), [{ name: 'b', dir: true }]);
    tree.setDir(path.join(WORKSPACE, 'src', 'a', 'b'), [
      { name: 'c.ts', dir: false },
    ]);
    tree.setDir(path.join(WORKSPACE, 'packages'), [{ name: 'foo', dir: true }]);
    tree.setDir(path.join(WORKSPACE, 'packages', 'foo'), [
      { name: 'src', dir: true },
      { name: 'node_modules', dir: true },
    ]);
    tree.setDir(path.join(WORKSPACE, 'packages', 'foo', 'src'), []);
    // Nested ignored subtrees — declared so the test FAILS loudly (an assertion
    // catches the watch) if the walk ever descends into them.
    tree.setDir(path.join(WORKSPACE, 'packages', 'foo', 'node_modules'), [
      { name: 'bar', dir: true },
    ]);
    tree.setDir(path.join(WORKSPACE, 'node_modules'), [
      { name: 'pkg', dir: true },
    ]);
    tree.setDir(path.join(WORKSPACE, '.worktrees'), [
      { name: 'wt1', dir: true },
    ]);
    tree.setDir(path.join(WORKSPACE, '.worktrees', 'wt1'), [
      { name: 'node_modules', dir: true },
      { name: 'src', dir: true },
    ]);
    tree.setDir(path.join(WORKSPACE, '.worktrees', 'wt1', 'node_modules'), []);
    tree.setDir(path.join(WORKSPACE, '.claude'), [
      { name: 'skills', dir: true },
    ]);

    vi.spyOn(fs, 'readdirSync').mockImplementation(((p: fs.PathLike) =>
      tree.readdir(String(p))) as unknown as typeof fs.readdirSync);

    // .git is a directory (regular repo) → HEAD lives at .git/HEAD.
    vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike) => {
      if (String(p) === path.join(WORKSPACE, '.git')) {
        return { isFile: () => false } as fs.Stats;
      }
      throw new Error('ENOENT');
    }) as unknown as typeof fs.statSync);

    vi.spyOn(fs, 'existsSync').mockImplementation(((p: fs.PathLike) => {
      return String(p) === HEAD_PATH;
    }) as unknown as typeof fs.existsSync);

    watchSpy = vi
      .spyOn(fs, 'watch')
      .mockImplementation(fakeWatch as unknown as typeof fs.watch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // ── 1. NESTED ignored dirs are NEVER watched (the P0 repro) ─────────────────
  it('never watches ANY path under a nested node_modules / .worktrees / .claude', () => {
    const watcher = new GitWatcher();
    watcher.watch(WORKSPACE);

    const watched = dirWatchPaths();

    // Positive: non-ignored dirs ARE watched at every depth.
    for (const good of [
      WORKSPACE,
      path.join(WORKSPACE, 'src'),
      path.join(WORKSPACE, 'src', 'a'),
      path.join(WORKSPACE, 'src', 'a', 'b'),
      path.join(WORKSPACE, 'packages'),
      path.join(WORKSPACE, 'packages', 'foo'),
      path.join(WORKSPACE, 'packages', 'foo', 'src'),
    ]) {
      expect(watched).toContain(good);
    }

    // Negative: no watched dir path contains an ignored segment at ANY depth.
    // (This is what FAILS on the old top-level-only fix, which recursively
    // watched packages/foo and .worktrees/wt1 and thus their node_modules.)
    for (const p of watched) {
      const segments = p.split(sep);
      expect(segments).not.toContain('node_modules');
      expect(segments).not.toContain('.worktrees');
      expect(segments).not.toContain('.claude');
      expect(segments).not.toContain('dist');
    }

    // No watch is ever created directly for a nested ignored directory.
    for (const ignored of [
      path.join(WORKSPACE, 'node_modules'),
      path.join(WORKSPACE, 'packages', 'foo', 'node_modules'),
      path.join(WORKSPACE, '.worktrees'),
      path.join(WORKSPACE, '.worktrees', 'wt1'),
      path.join(WORKSPACE, '.worktrees', 'wt1', 'node_modules'),
      path.join(WORKSPACE, '.claude'),
      path.join(WORKSPACE, '.git'),
    ]) {
      expect(watchFor(ignored)).toBeUndefined();
    }

    watcher.close();
  });

  // ── Every watch is NON-recursive (Node's recursive watch can't prune) ───────
  it('creates only NON-recursive watches (root + every subdir)', () => {
    const watcher = new GitWatcher();
    watcher.watch(WORKSPACE);

    for (const w of created) {
      expect(w.options?.recursive).not.toBe(true);
    }
    // The workspace root itself is watched (non-recursively).
    const root = watchFor(WORKSPACE);
    expect(root).toBeDefined();
    expect(root?.options?.recursive).not.toBe(true);

    watcher.close();
  });

  // ── 2. Source-file edit at depth still fires the emit debounce ──────────────
  it('a deep source-file edit (src/a/b/c.ts) schedules a files-changed emit', () => {
    const watcher = new GitWatcher();
    watcher.watch(WORKSPACE);

    const deep = watchFor(path.join(WORKSPACE, 'src', 'a', 'b'));
    expect(deep?.callback).toBeTypeOf('function');

    deep!.callback!('change', 'c.ts');
    expect(debounceTimers(watcher).has(WORKSPACE)).toBe(true);

    watcher.close();
  });

  // ── 3. New non-ignored subdir watched; new node_modules NOT watched ─────────
  it('watches a newly created subdir but NOT a newly created node_modules', () => {
    const watcher = new GitWatcher();
    watcher.watch(WORKSPACE);

    const srcWatch = watchFor(path.join(WORKSPACE, 'src'));
    expect(srcWatch?.callback).toBeTypeOf('function');
    const entry = entryFor(watcher, WORKSPACE);

    // (a) Create a new non-ignored subdir under src → reconcile watches it.
    tree.setDir(path.join(WORKSPACE, 'src'), [
      { name: 'a', dir: true },
      { name: 'feature', dir: true },
    ]);
    tree.setDir(path.join(WORKSPACE, 'src', 'feature'), []);
    srcWatch!.callback!('rename', 'feature');
    vi.advanceTimersByTime(300); // fire the debounced reconcile

    const featurePath = path.join(WORKSPACE, 'src', 'feature');
    expect(entry.dirWatchers.has(featurePath)).toBe(true);

    // Edits inside the new dir are detected.
    debounceTimers(watcher).delete(WORKSPACE);
    const featureWatch = watchFor(featurePath);
    featureWatch!.callback!('change', 'x.ts');
    expect(debounceTimers(watcher).has(WORKSPACE)).toBe(true);

    // (b) An npm install creates src/node_modules → NEVER watched, no emit.
    debounceTimers(watcher).delete(WORKSPACE);
    tree.setDir(path.join(WORKSPACE, 'src'), [
      { name: 'a', dir: true },
      { name: 'feature', dir: true },
      { name: 'node_modules', dir: true },
    ]);
    tree.setDir(path.join(WORKSPACE, 'src', 'node_modules'), [
      { name: 'dep', dir: true },
    ]);
    srcWatch!.callback!('rename', 'node_modules');
    vi.advanceTimersByTime(300);

    expect(
      entry.dirWatchers.has(path.join(WORKSPACE, 'src', 'node_modules'))
    ).toBe(false);
    // The ignored-child event was filtered — no emit scheduled.
    expect(debounceTimers(watcher).has(WORKSPACE)).toBe(false);

    watcher.close();
  });

  // ── 4. Delete + recreate a dir with the same name → re-watched (P2 fix) ──────
  it('re-watches a directory that is deleted then recreated with the same name', () => {
    const watcher = new GitWatcher();
    watcher.watch(WORKSPACE);
    const entry = entryFor(watcher, WORKSPACE);
    const srcWatch = watchFor(path.join(WORKSPACE, 'src'));
    const aPath = path.join(WORKSPACE, 'src', 'a');
    const bPath = path.join(WORKSPACE, 'src', 'a', 'b');

    expect(entry.dirWatchers.has(aPath)).toBe(true);
    expect(entry.dirWatchers.has(bPath)).toBe(true);

    // Delete src/a (and its subtree).
    tree.setDir(path.join(WORKSPACE, 'src'), []);
    tree.removeDir(aPath);
    tree.removeDir(bPath);
    srcWatch!.callback!('rename', 'a');
    vi.advanceTimersByTime(300);

    expect(entry.dirWatchers.has(aPath)).toBe(false);
    expect(entry.dirWatchers.has(bPath)).toBe(false);

    // Recreate src/a (empty this time).
    tree.setDir(path.join(WORKSPACE, 'src'), [{ name: 'a', dir: true }]);
    tree.setDir(aPath, []);
    srcWatch!.callback!('rename', 'a');
    vi.advanceTimersByTime(300);

    expect(entry.dirWatchers.has(aPath)).toBe(true);

    watcher.close();
  });

  // ── 5. Cap exceeded → logger.warn (not silent) ─────────────────────────────
  it('caps total watched dirs and WARNs (never silent) when exceeded', () => {
    tree.setDir(
      WORKSPACE,
      Array.from({ length: 9000 }, (_v, i) => ({ name: `pkg-${i}`, dir: true }))
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const watcher = new GitWatcher();
    watcher.watch(WORKSPACE);
    const entry = entryFor(watcher, WORKSPACE);

    // Bounded — never one-watch-per-dir for 9000 dirs.
    expect(entry.dirWatchers.size).toBeLessThanOrEqual(8192);
    expect(entry.dirWatchers.size).toBeLessThan(9001);
    expect(entry.dirWatchers.size).toBeGreaterThan(8000);
    // And it told us (partial coverage), rather than silently dropping watches.
    expect(warnSpy).toHaveBeenCalled();
    const warned = warnSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(warned).toMatch(/cap/i);

    watcher.close();
    warnSpy.mockRestore();
  });

  // ── 6. unwatch closes every per-dir watcher (+ HEAD) ───────────────────────
  it('unwatch closes every created watcher (root + all subdirs + HEAD)', () => {
    const watcher = new GitWatcher();
    watcher.watch(WORKSPACE);

    const madeWatchers = [...created];
    // root + src + src/a + src/a/b + packages + packages/foo + packages/foo/src + HEAD
    expect(madeWatchers.length).toBeGreaterThanOrEqual(8);

    watcher.unwatch(WORKSPACE);

    for (const w of madeWatchers) {
      expect(w.close).toHaveBeenCalled();
    }
  });

  // ── 7. .worktrees and .claude are in IGNORED_DIRS ──────────────────────────
  it('IGNORED_DIRS contains .worktrees and .claude (plus node_modules/.git)', () => {
    expect(IGNORED_DIRS.has('.worktrees')).toBe(true);
    expect(IGNORED_DIRS.has('.claude')).toBe(true);
    expect(IGNORED_DIRS.has('node_modules')).toBe(true);
    expect(IGNORED_DIRS.has('.git')).toBe(true);
  });

  // Guardrail: prove the watchSpy is actually intercepting real fs.watch.
  it('installs the fs.watch spy', () => {
    const watcher = new GitWatcher();
    watcher.watch(WORKSPACE);
    expect(watchSpy).toHaveBeenCalled();
    watcher.close();
  });
});
