import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { createLogger } from './logger.js';
import { ensureBranchLocal } from './git.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('watcher');

export const WORKTREE_DIRS = ['.worktrees', '.claude/worktrees'];

function closeWatchers(watchers: fs.FSWatcher[]): void {
  for (const w of watchers) {
    try {
      w.close();
    } catch (_) {
      // ignore
    }
  }
}

export function isValidWorktreePath(worktreePath: string): boolean {
  const resolved = path.resolve(worktreePath);
  return WORKTREE_DIRS.some(function (dir) {
    return resolved.includes(path.sep + dir + path.sep);
  });
}

export interface ParsedWorktree {
  path: string;
  branch: string;
}

export interface ParsedWorktreeEntry {
  path: string;
  branch: string;
  isMain: boolean;
}

interface RawWorktreeBlock {
  path: string;
  branch: string;
  bare: boolean;
}

function parseWorktreeBlocks(stdout: string): RawWorktreeBlock[] {
  return stdout
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      let path = '';
      let branch = '';
      let bare = false;
      for (const line of block.split('\n')) {
        if (line.startsWith('worktree ')) path = line.slice(9);
        else if (line.startsWith('branch refs/heads/')) branch = line.slice(18);
        else if (line === 'bare') bare = true;
      }
      return { path, branch, bare };
    });
}

/**
 * Parse `git worktree list --porcelain` output into ALL entries (including main worktree).
 * Skips bare entries. Detached HEAD entries get empty branch string.
 */
export function parseAllWorktrees(
  stdout: string,
  repoPath: string
): ParsedWorktreeEntry[] {
  return parseWorktreeBlocks(stdout)
    .filter((b) => b.path && !b.bare)
    .map((b) => ({
      path: b.path,
      branch: b.branch,
      isMain: b.path === repoPath,
    }));
}

/**
 * Parse `git worktree list --porcelain` output into structured entries.
 * Skips the main worktree (matching repoPath) and bare/detached entries.
 */
export function parseWorktreeListPorcelain(
  stdout: string,
  repoPath: string
): ParsedWorktree[] {
  return parseWorktreeBlocks(stdout)
    .filter((b) => b.path && b.path !== repoPath && !b.bare && b.branch)
    .map((b) => ({ path: b.path, branch: b.branch }));
}

export interface FindOrCreateResult {
  worktreePath: string;
  branchName: string;
  dirName: string;
  existing: boolean;
  isMain: boolean;
}

/**
 * Find an existing worktree for a branch, or create a new one.
 * Prevents "fatal: branch is already used by worktree" errors by
 * checking `git worktree list` before attempting `git worktree add`.
 * Throws branch_checked_out_in_main error if the branch is checked out
 * in the main worktree (caller should open a repo-root session instead).
 */
export async function findOrCreateWorktreeForBranch(
  repoPath: string,
  branch: string,
  execFn: (
    cmd: string,
    args: string[],
    opts: { cwd: string; timeout?: number }
  ) => Promise<{ stdout: string; stderr: string }>
): Promise<FindOrCreateResult> {
  // Check if branch is already checked out in ANY worktree (including the main repo)
  try {
    const { stdout } = await execFn(
      'git',
      ['worktree', 'list', '--porcelain'],
      { cwd: repoPath }
    );
    const allWorktrees = parseAllWorktrees(stdout, repoPath);
    const match = allWorktrees.find((wt) => wt.branch === branch);
    if (match) {
      return {
        worktreePath: match.path,
        branchName: match.branch,
        dirName: match.path.split('/').pop() || '',
        existing: true,
        isMain: match.isMain,
      };
    }
  } catch (err) {
    // git worktree list failed — proceed with creation attempt
    logger.warn(
      '[watcher] git worktree list failed, proceeding with creation attempt:',
      err instanceof Error ? err.message : err
    );
  }

  // Sanitize branch name for directory
  const dirName = branch.replace(/\//g, '-').replace(/[^a-zA-Z0-9._-]/g, '');
  const worktreePath = path.join(repoPath, '.worktrees', dirName);

  // Ensure .worktrees/ is in .gitignore (best-effort — skip if directory doesn't exist)
  try {
    const gitignorePath = path.join(repoPath, '.gitignore');
    try {
      const content = fs.readFileSync(gitignorePath, 'utf8');
      if (!content.includes('.worktrees/')) {
        fs.appendFileSync(gitignorePath, '\n.worktrees/\n');
      }
    } catch {
      fs.writeFileSync(gitignorePath, '.worktrees/\n');
    }
  } catch {
    // Directory may not exist in test environments
  }

  // Ensure the branch exists locally before attempting worktree add.
  // If it only lives on the remote, fetch it first.
  const branchResult = await ensureBranchLocal(repoPath, branch, {
    exec: execFn,
  });
  if (!branchResult.found) {
    if (branchResult.reason === 'fetch_failed') {
      throw new Error(`Could not fetch branch "${branch}" from origin`);
    }
    throw new Error(
      `Branch "${branch}" not found` +
        (branchResult.reason ? ` (${branchResult.reason})` : '')
    );
  }

  await execFn('git', ['worktree', 'add', worktreePath, branch], {
    cwd: repoPath,
  });

  return {
    worktreePath,
    branchName: branch,
    dirName,
    existing: false,
    isMain: false,
  };
}

export class WorktreeWatcher extends EventEmitter {
  private watchers: fs.FSWatcher[];
  private debounceTimer: ReturnType<typeof setTimeout> | null;

  constructor() {
    super();
    this.watchers = [];
    this.debounceTimer = null;
  }

  rebuild(rootDirs: string[]): void {
    this.closeAll();

    for (const rootDir of rootDirs) {
      // config.repos stores individual repo paths — watch directly if rootDir is a repo
      if (fs.existsSync(path.join(rootDir, '.git'))) {
        this.watchRepo(rootDir);
        continue;
      }
      // Fallback: rootDir may be a parent directory containing repos
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(rootDir, { withFileTypes: true });
      } catch (_) {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const repoPath = path.join(rootDir, entry.name);
        if (!fs.existsSync(path.join(repoPath, '.git'))) continue;
        this.watchRepo(repoPath);
      }
    }
  }

  private watchRepo(repoPath: string): void {
    let anyWatched = false;
    for (const dir of WORKTREE_DIRS) {
      const worktreeDir = path.join(repoPath, dir);
      if (fs.existsSync(worktreeDir)) {
        this.addWatch(worktreeDir);
        anyWatched = true;
      }
    }
    if (!anyWatched) {
      // Watch repo root so we detect when either dir is first created
      this.addWatch(repoPath);
    }
  }

  private addWatch(dirPath: string): void {
    try {
      const watcher = fs.watch(dirPath, { persistent: false }, () => {
        this.debouncedEmit();
      });
      watcher.on('error', () => {});
      this.watchers.push(watcher);
    } catch (_) {
      // ignore
    }
  }

  private debouncedEmit(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.emit('worktrees-changed');
    }, 500);
  }

  private closeAll(): void {
    closeWatchers(this.watchers);
    this.watchers = [];
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  close(): void {
    this.closeAll();
  }
}

export type BranchChangeCallback = (cwdPath: string, newBranch: string) => void;

export class BranchWatcher {
  // Map headPath → { watcher, cwdPath } so we can recreate individual watchers
  // after detection (git's atomic checkout can change the inode, killing kqueue watchers)
  private watcherMap = new Map<
    string,
    { watcher: fs.FSWatcher; cwdPath: string }
  >();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastBranch = new Map<string, string>();
  private callback: BranchChangeCallback;
  /** Monotonic generation counter. Incremented on rebuild()/close() so that
   *  in-flight async readAndEmit calls from a prior generation don't
   *  recreate watchers into the new (or cleared) watcherMap. */
  private generation = 0;

  constructor(callback: BranchChangeCallback) {
    this.callback = callback;
  }

  rebuild(rootDirs: string[]): void {
    this.closeAll();

    for (const rootDir of rootDirs) {
      // config.repos stores individual repo paths — watch directly if rootDir is a repo
      if (fs.existsSync(path.join(rootDir, '.git'))) {
        this.watchRepoHeads(rootDir);
        continue;
      }
      // Fallback: rootDir may be a parent directory containing repos
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(rootDir, { withFileTypes: true });
      } catch (_) {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const repoPath = path.join(rootDir, entry.name);
        if (!fs.existsSync(path.join(repoPath, '.git'))) continue;
        this.watchRepoHeads(repoPath);
      }
    }
  }

  private watchRepoHeads(repoPath: string): void {
    // Watch main repo HEAD
    const mainHead = path.join(repoPath, '.git', 'HEAD');
    this.watchHeadFile(mainHead, repoPath);

    // Watch worktree HEADs: <repoPath>/.git/worktrees/*/HEAD
    const worktreesGitDir = path.join(repoPath, '.git', 'worktrees');
    let wtEntries: fs.Dirent[];
    try {
      wtEntries = fs.readdirSync(worktreesGitDir, { withFileTypes: true });
    } catch (_) {
      return; // No worktrees
    }

    for (const entry of wtEntries) {
      if (!entry.isDirectory()) continue;
      const wtGitDir = path.join(worktreesGitDir, entry.name);
      const headFile = path.join(wtGitDir, 'HEAD');
      if (!fs.existsSync(headFile)) continue;

      // Map worktree git dir back to checkout path via gitdir file
      const gitdirFile = path.join(wtGitDir, 'gitdir');
      let checkoutPath: string;
      try {
        const gitdirContent = fs.readFileSync(gitdirFile, 'utf-8').trim();
        // gitdir contains <checkoutPath>/.git — strip the /.git suffix
        checkoutPath = gitdirContent.replace(/\/\.git\/?$/, '');
      } catch (_) {
        continue;
      }

      this.watchHeadFile(headFile, checkoutPath);
    }
  }

  private watchHeadFile(headPath: string, cwdPath: string): void {
    // Seed initial branch to avoid false-positive on first change detection
    try {
      const content = fs.readFileSync(headPath, 'utf-8').trim();
      const match = content.match(/^ref: refs\/heads\/(.+)$/);
      if (match) this.lastBranch.set(cwdPath, match[1]!);
    } catch (_) {
      // ignore
    }

    this.createWatcher(headPath, cwdPath);
  }

  /**
   * Create (or recreate) an fs.watch() for a HEAD file. Tracked by headPath
   * so we can close and recreate after detection — git's atomic checkout
   * (write HEAD.lock, rename to HEAD) can change the file's inode, which
   * silently kills kqueue-based watchers on macOS.
   */
  private createWatcher(headPath: string, cwdPath: string): void {
    // Close existing watcher for this path if any
    const existing = this.watcherMap.get(headPath);
    if (existing) {
      try {
        existing.watcher.close();
      } catch (_) {
        // ignore
      }
    }

    try {
      const watcher = fs.watch(headPath, { persistent: false }, () => {
        this.debouncedCheck(headPath, cwdPath);
      });
      watcher.on('error', () => {});
      this.watcherMap.set(headPath, { watcher, cwdPath });
    } catch (_) {
      // ignore
    }
  }

  private debouncedCheck(headPath: string, cwdPath: string): void {
    const existing = this.debounceTimers.get(cwdPath);
    if (existing) clearTimeout(existing);

    // Capture generation so the async callback can detect stale invocations
    const gen = this.generation;
    this.debounceTimers.set(
      cwdPath,
      setTimeout(() => {
        this.debounceTimers.delete(cwdPath);
        this.readAndEmit(headPath, cwdPath, gen);
      }, 300)
    );
  }

  private async readAndEmit(
    headPath: string,
    cwdPath: string,
    gen: number
  ): Promise<void> {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        { cwd: cwdPath }
      );
      const newBranch = stdout.trim();
      const lastBranch = this.lastBranch.get(cwdPath);
      if (newBranch && newBranch !== lastBranch) {
        this.lastBranch.set(cwdPath, newBranch);
        this.callback(cwdPath, newBranch);
      }
    } catch (_) {
      // Non-fatal — repo may be in detached HEAD or mid-rebase
    }

    // Recreate the watcher — the inode may have changed due to atomic rename.
    // Only recreate if the generation hasn't changed (rebuild/close didn't happen
    // while git rev-parse was in flight).
    if (this.generation === gen) {
      this.createWatcher(headPath, cwdPath);
    }
  }

  private closeAll(): void {
    this.generation++;
    for (const { watcher } of this.watcherMap.values()) {
      try {
        watcher.close();
      } catch (_) {
        // ignore
      }
    }
    this.watcherMap.clear();
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.lastBranch.clear();
  }

  close(): void {
    this.closeAll();
  }
}

/**
 * Resolve the git directory for a checkout path, handling both regular repos
 * and worktrees. For worktrees, follows the `commondir` file to find the main
 * repo's git dir (where remote refs live).
 */
export function resolveGitDir(cwdPath: string): string | null {
  const dotGit = path.join(cwdPath, '.git');
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(dotGit, { throwIfNoEntry: false });
  } catch (_) {
    return null; // EACCES, ENOTDIR, etc.
  }
  if (!stat) return null;

  if (stat.isDirectory()) return dotGit;

  // Worktree: .git is a file containing "gitdir: <path>"
  let content: string;
  try {
    content = fs.readFileSync(dotGit, 'utf-8').trim();
  } catch (_) {
    return null;
  }
  const match = content.match(/^gitdir:\s*(.+)$/);
  if (!match) return null;

  const worktreeGitDir = path.resolve(cwdPath, match[1]!);

  // Follow commondir to find the main repo's git dir (where refs/remotes/ lives)
  const commondirFile = path.join(worktreeGitDir, 'commondir');
  try {
    const commondir = fs.readFileSync(commondirFile, 'utf-8').trim();
    return path.resolve(worktreeGitDir, commondir);
  } catch (_) {
    // No commondir — fall back to the worktree git dir itself
    return worktreeGitDir;
  }
}

export type RefChangeCallback = (cwdPath: string, branch: string) => void;

export class RefWatcher {
  private watchers: fs.FSWatcher[] = [];
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastSha = new Map<string, string | null>();
  private entries = new Map<
    string,
    { cwdPath: string; branch: string; upstreamRef: string }
  >();
  private callback: RefChangeCallback;

  constructor(callback: RefChangeCallback) {
    this.callback = callback;
  }

  async rebuild(
    entries: Array<{ cwdPath: string; branch: string }>
  ): Promise<void> {
    this.closeAll();

    // Dedupe entries — multiple sessions can share the same cwdPath:branch
    const seen = new Set<string>();
    for (const { cwdPath, branch } of entries) {
      const dedupeKey = `${cwdPath}:${branch}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      // Resolve the upstream tracking ref
      let upstreamRef: string;
      try {
        const { stdout } = await execFileAsync(
          'git',
          ['rev-parse', '--symbolic-full-name', '@{u}'],
          { cwd: cwdPath }
        );
        upstreamRef = stdout.trim();
        if (!upstreamRef) continue;
      } catch (_) {
        // No upstream (detached HEAD, unpushed branch) — skip
        continue;
      }

      const key = `${cwdPath}:${branch}`;
      this.entries.set(key, { cwdPath, branch, upstreamRef });

      // Seed last known SHA
      try {
        const { stdout } = await execFileAsync(
          'git',
          ['rev-parse', upstreamRef],
          { cwd: cwdPath }
        );
        this.lastSha.set(key, stdout.trim());
      } catch (_) {
        this.lastSha.set(key, null);
      }

      // Resolve git dir (handles worktrees via commondir)
      const gitDir = resolveGitDir(cwdPath);
      if (!gitDir) continue;

      // Watch the loose ref file if it exists (e.g. refs/remotes/origin/feature-x)
      // upstreamRef is like "refs/remotes/origin/feature-x"
      const refFile = path.join(gitDir, upstreamRef);
      this.addWatch(refFile, key);

      // Watch the remote's ref directory to catch new ref creation
      const refDir = path.dirname(refFile);
      this.addWatch(refDir, key);
    }
  }

  private addWatch(target: string, key: string): void {
    try {
      if (!fs.existsSync(target)) return;
      const watcher = fs.watch(target, { persistent: false }, () => {
        this.debouncedCheck(key);
      });
      watcher.on('error', () => {});
      this.watchers.push(watcher);
    } catch (_) {
      // ignore
    }
  }

  private debouncedCheck(key: string): void {
    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);

    this.debounceTimers.set(
      key,
      setTimeout(() => {
        this.debounceTimers.delete(key);
        this.checkAndEmit(key);
      }, 300)
    );
  }

  private async checkAndEmit(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;

    let newSha: string | null;
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['rev-parse', entry.upstreamRef],
        { cwd: entry.cwdPath }
      );
      newSha = stdout.trim();
    } catch (_) {
      newSha = null; // Ref deleted or pruned
    }

    const lastSha = this.lastSha.get(key);
    if (newSha !== lastSha) {
      this.lastSha.set(key, newSha);
      this.callback(entry.cwdPath, entry.branch);
    }
  }

  private closeAll(): void {
    closeWatchers(this.watchers);
    this.watchers = [];
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.lastSha.clear();
    this.entries.clear();
  }

  close(): void {
    this.closeAll();
  }
}

// Directories to ignore when watching the working tree.
// These never contain user-authored source files worth diffing.
// IMPORTANT: these are pruned at EVERY level of the walk (not just the top),
// so nested trees such as `.worktrees/<wt>/node_modules` or a monorepo's
// `packages/<pkg>/node_modules` are never descended into (#1249 / PR #1251
// review P0: nested node_modules re-wedged the hub even after top-level
// exclusion). `.worktrees` and `.claude` are ignored because the dogfood
// checkout keeps sibling worktrees and generated agent config there — both
// are large, gitignored, and never source worth diffing from the root.
export const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'dist',
  'build',
  'out',
  '.output',
  'coverage',
  '__pycache__',
  '.pytest_cache',
  '.venv',
  'venv',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.worktrees',
  '.claude',
]);

// Safety cap on the total number of per-directory watches per workspace.
// The walk prunes IGNORED_DIRS at every level, so a normal source tree is
// hundreds-to-low-thousands of dirs. This cap bounds a pathological
// non-ignored tree; hitting it logs a WARN describing the partial coverage
// (never a silent cap — #1244).
const MAX_WATCHED_DIRS = 8192;

// Debounce for reconciling a single directory's watch set after a create/delete
// ('rename') event. Collapses bursts (e.g. a tool writing many files into a
// watched dir) into one cheap, non-recursive re-read of that ONE directory.
const RESCAN_DEBOUNCE_MS = 250;

interface WorkspaceWatchEntry {
  // One NON-recursive fs.watch per NON-ignored directory in the tree, keyed by
  // absolute directory path. Node's recursive fs.watch cannot prune per-level,
  // so we maintain the recursion ourselves and skip IGNORED_DIRS at every depth.
  dirWatchers: Map<string, fs.FSWatcher>;
  // .git/HEAD watch for commits / branch switches.
  headWatcher?: fs.FSWatcher | undefined;
  // Per-directory debounce timers for create/delete reconciliation, keyed by
  // the directory whose children changed.
  rescanTimers: Map<string, ReturnType<typeof setTimeout>>;
  // Set once we log the cap WARN so a workspace warns at most once.
  cappedWarned: boolean;
  refCount: number;
}

export class GitWatcher extends EventEmitter {
  private watchers = new Map<string, WorkspaceWatchEntry>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  watch(workspacePath: string): void {
    const existing = this.watchers.get(workspacePath);
    if (existing) {
      existing.refCount++;
      return;
    }

    const entry: WorkspaceWatchEntry = {
      dirWatchers: new Map(),
      rescanTimers: new Map(),
      cappedWarned: false,
      refCount: 1,
    };

    // 1. Watch the working tree for file edits with a CUSTOM per-level-pruning
    //    recursive watcher (#1249 / PR #1251 review P0). Node's recursive
    //    fs.watch on Linux is implemented in JS: it walks + stats +
    //    inotify-watches EVERY subdirectory with NO per-level exclusion, so it
    //    always descends node_modules (100k+ files) — even a `fs.watch(dir,
    //    {recursive:true})` on a *non-ignored* top-level dir still walks any
    //    node_modules nested underneath it (a monorepo `packages/*/node_modules`
    //    or the dogfood checkout's `.worktrees/*/node_modules`, which is LARGER
    //    than the root node_modules). We therefore walk the tree ourselves,
    //    pruning IGNORED_DIRS at every level, and attach a NON-recursive watch
    //    to each non-ignored directory. Create/delete of a child re-reads that
    //    one directory (cheap) to add/drop watches dynamically. IGNORED_DIRS is
    //    also filtered in each callback (defense in depth) so git-status calls
    //    never cause feedback loops.
    this.walkAndWatch(workspacePath, entry, workspacePath);

    // 2. Watch .git/HEAD for commits and branch switches.
    //    Single-file watch, no feedback loop risk (HEAD only changes on checkout/commit).
    const gitDir = path.join(workspacePath, '.git');
    try {
      const stat = fs.statSync(gitDir);
      let headPath: string;
      if (stat.isFile()) {
        // Worktree: .git is a file pointing to the real git dir
        const content = fs.readFileSync(gitDir, 'utf-8').trim();
        const match = content.match(/^gitdir:\s*(.+)$/);
        headPath = match
          ? path.join(path.resolve(workspacePath, match[1]!), 'HEAD')
          : '';
      } else {
        headPath = path.join(gitDir, 'HEAD');
      }
      if (headPath && fs.existsSync(headPath)) {
        entry.headWatcher = fs.watch(headPath, { persistent: false }, () => {
          this.debouncedEmit(workspacePath);
        });
        entry.headWatcher.on('error', () => {
          /* HEAD watch is best-effort */
        });
      }
    } catch {
      // .git doesn't exist or isn't readable — skip HEAD watching
    }

    if (entry.dirWatchers.size === 0 && !entry.headWatcher) {
      return;
    }

    this.watchers.set(workspacePath, entry);
  }

  /**
   * Walk the tree rooted at `startDir`, pruning IGNORED_DIRS at EVERY level, and
   * attach a NON-recursive fs.watch to each non-ignored directory. Iterative
   * (explicit stack) so a deep tree can't blow the call stack. Bounded by
   * MAX_WATCHED_DIRS: once the cap is hit, remaining directories are skipped and
   * a single WARN is logged (never a silent cap). An ignored directory is never
   * counted toward the cap — the walk skips it before it is ever pushed.
   */
  private walkAndWatch(
    workspacePath: string,
    entry: WorkspaceWatchEntry,
    startDir: string
  ): void {
    const stack: string[] = [startDir];
    let skipped = 0;
    let cappedHit = false;

    while (stack.length > 0) {
      const dir = stack.pop()!;
      if (entry.dirWatchers.has(dir)) continue;

      if (entry.dirWatchers.size >= MAX_WATCHED_DIRS) {
        skipped++;
        cappedHit = true;
        continue;
      }

      const watcher = this.createDirWatcher(workspacePath, entry, dir);
      if (watcher) entry.dirWatchers.set(dir, watcher);

      let dirents: fs.Dirent[];
      try {
        dirents = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        // Directory vanished or is unreadable — nothing more to enqueue.
        continue;
      }
      for (const dirent of dirents) {
        if (!dirent.isDirectory()) continue;
        if (IGNORED_DIRS.has(dirent.name)) continue; // prune at EVERY level
        const child = path.join(dir, dirent.name);
        if (!entry.dirWatchers.has(child)) stack.push(child);
      }
    }

    if (cappedHit && !entry.cappedWarned) {
      entry.cappedWarned = true;
      logger.warn(
        `[GitWatcher] ${workspacePath}: reached watch cap of ${MAX_WATCHED_DIRS} directories; skipped at least ${skipped} — change detection is PARTIAL for this workspace (edits in directories beyond the cap will not auto-refresh changed-files)`
      );
    }
  }

  /**
   * Create a single NON-recursive fs.watch for `dir`. Its callback filters
   * IGNORED_DIRS children (defense in depth) and, on a 'rename' (child created
   * or deleted), schedules a debounced reconcile of THIS directory only — cheap,
   * because it re-reads one directory non-recursively, never the whole tree.
   */
  private createDirWatcher(
    workspacePath: string,
    entry: WorkspaceWatchEntry,
    dir: string
  ): fs.FSWatcher | undefined {
    try {
      const watcher = fs.watch(
        dir,
        { persistent: false },
        (event, filename) => {
          if (filename) {
            // A non-recursive watch reports the changed direct child. Skip
            // ignored children so a newly created node_modules / .worktrees
            // neither gets watched nor spams git-status.
            const firstSegment = String(filename).split(path.sep)[0] ?? '';
            if (IGNORED_DIRS.has(firstSegment)) return;
          }
          if (event === 'rename') {
            // Child dir created or removed — reconcile watches for this dir.
            this.scheduleDirRescan(workspacePath, entry, dir);
          }
          this.debouncedEmit(workspacePath);
        }
      );
      watcher.on('error', () => {
        /* per-dir watch is best-effort */
      });
      return watcher;
    } catch (err: unknown) {
      if (dir === workspacePath) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(
          '[GitWatcher] could not watch working tree for',
          workspacePath,
          '—',
          msg
        );
        logger.warn(
          '[GitWatcher] changed-files may not auto-refresh for this workspace. On Linux, try: sysctl fs.inotify.max_user_watches=524288'
        );
      }
      // Nested per-dir watch failures are non-fatal and stay quiet.
      return undefined;
    }
  }

  /**
   * Debounce a reconcile of a single directory. At most one reconcile is pending
   * per directory, so a burst of create/delete events collapses to one
   * non-recursive readdir of that directory.
   */
  private scheduleDirRescan(
    workspacePath: string,
    entry: WorkspaceWatchEntry,
    dir: string
  ): void {
    if (entry.rescanTimers.has(dir)) return;
    const timer = setTimeout(() => {
      entry.rescanTimers.delete(dir);
      // Ignore if this entry has been torn down / replaced in the meantime.
      if (this.watchers.get(workspacePath) !== entry) return;
      this.reconcileDir(workspacePath, entry, dir);
    }, RESCAN_DEBOUNCE_MS);
    entry.rescanTimers.set(dir, timer);
  }

  /**
   * Re-read ONE directory (non-recursively) and reconcile its child watches:
   * walk+watch newly created non-ignored subdirs, and drop watches for direct
   * child directories that were removed (unwatching their whole subtree). If the
   * directory itself is gone, unwatch it and everything under it.
   */
  private reconcileDir(
    workspacePath: string,
    entry: WorkspaceWatchEntry,
    dir: string
  ): void {
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // Directory removed or unreadable — drop it and all descendant watches.
      this.unwatchSubtree(entry, dir);
      return;
    }

    const liveChildDirs = new Set<string>();
    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue;
      if (IGNORED_DIRS.has(dirent.name)) continue; // prune ignored children
      const child = path.join(dir, dirent.name);
      liveChildDirs.add(child);
      if (!entry.dirWatchers.has(child)) {
        // Newly created non-ignored subdir — walk + watch it (bounded, pruned).
        this.walkAndWatch(workspacePath, entry, child);
      }
    }

    // Drop watches for direct child directories that no longer exist. A
    // non-recursive watch on `dir` only reports its own direct children, so we
    // only reconcile this level; nested changes are handled by nested watches.
    for (const watched of [...entry.dirWatchers.keys()]) {
      if (path.dirname(watched) !== dir) continue;
      if (!liveChildDirs.has(watched)) {
        this.unwatchSubtree(entry, watched);
      }
    }
  }

  /**
   * Close and forget the watch on `root` and every watched directory beneath it,
   * plus any pending reconcile timers in that subtree. Idempotent.
   */
  private unwatchSubtree(entry: WorkspaceWatchEntry, root: string): void {
    const prefix = root + path.sep;
    for (const [watchedPath, watcher] of [...entry.dirWatchers]) {
      if (watchedPath === root || watchedPath.startsWith(prefix)) {
        try {
          watcher.close();
        } catch {
          // ignore
        }
        entry.dirWatchers.delete(watchedPath);
      }
    }
    for (const [timerPath, timer] of [...entry.rescanTimers]) {
      if (timerPath === root || timerPath.startsWith(prefix)) {
        clearTimeout(timer);
        entry.rescanTimers.delete(timerPath);
      }
    }
  }

  private closeEntry(entry: WorkspaceWatchEntry): void {
    for (const timer of entry.rescanTimers.values()) {
      clearTimeout(timer);
    }
    entry.rescanTimers.clear();
    for (const watcher of entry.dirWatchers.values()) {
      try {
        watcher.close();
      } catch {
        // ignore
      }
    }
    entry.dirWatchers.clear();
    if (entry.headWatcher) {
      try {
        entry.headWatcher.close();
      } catch {
        // ignore
      }
      entry.headWatcher = undefined;
    }
  }

  unwatch(workspacePath: string): void {
    const entry = this.watchers.get(workspacePath);
    if (!entry) return;
    entry.refCount--;
    if (entry.refCount <= 0) {
      this.closeEntry(entry);
      this.watchers.delete(workspacePath);
      const timer = this.debounceTimers.get(workspacePath);
      if (timer) {
        clearTimeout(timer);
        this.debounceTimers.delete(workspacePath);
      }
    }
  }

  private debouncedEmit(workspacePath: string): void {
    const existing = this.debounceTimers.get(workspacePath);
    if (existing) clearTimeout(existing);
    this.debounceTimers.set(
      workspacePath,
      setTimeout(async () => {
        this.debounceTimers.delete(workspacePath);
        // Collect changed file paths via git status for the sidebar's blue-dot tracking
        const changedFiles: string[] = [];
        try {
          const { stdout } = await execFileAsync(
            'git',
            ['status', '--porcelain=v1', '-z'],
            {
              cwd: workspacePath,
              timeout: 5000,
            }
          );
          const parts = stdout.split('\0').filter(Boolean);
          for (let i = 0; i < parts.length; i++) {
            const entry = parts[i]!;
            const code = entry.slice(0, 2);
            const filePath = entry.slice(3);
            if (code.startsWith('R')) {
              // Rename: porcelain -z gives [newPath]\0[oldPath]
              // filePath is the new name (the one on disk), next part is the old name
              if (filePath) changedFiles.push(filePath);
              i++; // skip old path
              continue;
            }
            if (filePath) changedFiles.push(filePath);
          }
        } catch {
          // git status failed — emit without file list
        }
        this.emit('files-changed', { workspacePath, changedFiles });
      }, 1000)
    );
  }

  close(): void {
    for (const entry of this.watchers.values()) {
      this.closeEntry(entry);
    }
    this.watchers.clear();
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }
}
