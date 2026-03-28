import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';

const execFileAsync = promisify(execFile);

export const WORKTREE_DIRS = ['.worktrees', '.claude/worktrees'];

function closeWatchers(watchers: fs.FSWatcher[]): void {
  for (const w of watchers) {
    try { w.close(); } catch (_) {}
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
  return stdout.split('\n\n').filter(Boolean).map(block => {
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
export function parseAllWorktrees(stdout: string, repoPath: string): ParsedWorktreeEntry[] {
  return parseWorktreeBlocks(stdout)
    .filter(b => b.path && !b.bare)
    .map(b => ({ path: b.path, branch: b.branch, isMain: b.path === repoPath }));
}

/**
 * Parse `git worktree list --porcelain` output into structured entries.
 * Skips the main worktree (matching repoPath) and bare/detached entries.
 */
export function parseWorktreeListPorcelain(stdout: string, repoPath: string): ParsedWorktree[] {
  return parseWorktreeBlocks(stdout)
    .filter(b => b.path && b.path !== repoPath && !b.bare && b.branch)
    .map(b => ({ path: b.path, branch: b.branch }));
}

export interface FindOrCreateResult {
  worktreePath: string;
  branchName: string;
  dirName: string;
  existing: boolean;
}

/**
 * Find an existing worktree for a branch, or create a new one.
 * Prevents "fatal: branch is already used by worktree" errors by
 * checking `git worktree list` before attempting `git worktree add`.
 */
export async function findOrCreateWorktreeForBranch(
  repoPath: string,
  branch: string,
  execFn: (cmd: string, args: string[], opts: { cwd: string; timeout?: number }) => Promise<{ stdout: string; stderr: string }>,
): Promise<FindOrCreateResult> {
  // Check if branch is already checked out in an existing worktree
  try {
    const { stdout } = await execFn('git', ['worktree', 'list', '--porcelain'], { cwd: repoPath });
    const existing = parseWorktreeListPorcelain(stdout, repoPath);
    const match = existing.find(wt => wt.branch === branch);
    if (match) {
      return {
        worktreePath: match.path,
        branchName: match.branch,
        dirName: match.path.split('/').pop() || '',
        existing: true,
      };
    }
  } catch {
    // git worktree list failed — proceed with creation attempt
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
    // Directory may not exist in test environments — skip
  }

  await execFn('git', ['worktree', 'add', worktreePath, branch], { cwd: repoPath });

  return {
    worktreePath,
    branchName: branch,
    dirName,
    existing: false,
  };
}

export class WorktreeWatcher extends EventEmitter {
  private _watchers: fs.FSWatcher[];
  private _debounceTimer: ReturnType<typeof setTimeout> | null;

  constructor() {
    super();
    this._watchers = [];
    this._debounceTimer = null;
  }

  rebuild(rootDirs: string[]): void {
    this._closeAll();

    for (const rootDir of rootDirs) {
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
        this._watchRepo(repoPath);
      }
    }
  }

  private _watchRepo(repoPath: string): void {
    let anyWatched = false;
    for (const dir of WORKTREE_DIRS) {
      const worktreeDir = path.join(repoPath, dir);
      if (fs.existsSync(worktreeDir)) {
        this._addWatch(worktreeDir);
        anyWatched = true;
      }
    }
    if (!anyWatched) {
      // Watch repo root so we detect when either dir is first created
      this._addWatch(repoPath);
    }
  }

  private _addWatch(dirPath: string): void {
    try {
      const watcher = fs.watch(dirPath, { persistent: false }, () => {
        this._debouncedEmit();
      });
      watcher.on('error', () => {});
      this._watchers.push(watcher);
    } catch (_) {}
  }

  private _debouncedEmit(): void {
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      this.emit('worktrees-changed');
    }, 500);
  }

  private _closeAll(): void {
    closeWatchers(this._watchers);
    this._watchers = [];
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
  }

  close(): void {
    this._closeAll();
  }
}

export type BranchChangeCallback = (cwdPath: string, newBranch: string) => void;

export class BranchWatcher {
  private _watchers: fs.FSWatcher[] = [];
  private _debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private _lastBranch = new Map<string, string>();
  private _callback: BranchChangeCallback;

  constructor(callback: BranchChangeCallback) {
    this._callback = callback;
  }

  rebuild(rootDirs: string[]): void {
    this._closeAll();

    for (const rootDir of rootDirs) {
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
        this._watchRepoHeads(repoPath);
      }
    }
  }

  private _watchRepoHeads(repoPath: string): void {
    // Watch main repo HEAD
    const mainHead = path.join(repoPath, '.git', 'HEAD');
    this._watchHeadFile(mainHead, repoPath);

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

      this._watchHeadFile(headFile, checkoutPath);
    }
  }

  private _watchHeadFile(headPath: string, cwdPath: string): void {
    // Seed initial branch to avoid false-positive on first change detection
    try {
      const content = fs.readFileSync(headPath, 'utf-8').trim();
      const match = content.match(/^ref: refs\/heads\/(.+)$/);
      if (match) this._lastBranch.set(cwdPath, match[1]!);
    } catch (_) {}

    try {
      const watcher = fs.watch(headPath, { persistent: false }, () => {
        this._debouncedCheck(cwdPath);
      });
      watcher.on('error', () => {});
      this._watchers.push(watcher);
    } catch (_) {}
  }

  private _debouncedCheck(cwdPath: string): void {
    const existing = this._debounceTimers.get(cwdPath);
    if (existing) clearTimeout(existing);

    this._debounceTimers.set(cwdPath, setTimeout(() => {
      this._debounceTimers.delete(cwdPath);
      this._readAndEmit(cwdPath);
    }, 300));
  }

  private async _readAndEmit(cwdPath: string): Promise<void> {
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: cwdPath });
      const newBranch = stdout.trim();
      const lastBranch = this._lastBranch.get(cwdPath);
      if (newBranch && newBranch !== lastBranch) {
        this._lastBranch.set(cwdPath, newBranch);
        this._callback(cwdPath, newBranch);
      }
    } catch (_) {
      // Non-fatal — repo may be in detached HEAD or mid-rebase
    }
  }

  private _closeAll(): void {
    closeWatchers(this._watchers);
    this._watchers = [];
    for (const timer of this._debounceTimers.values()) {
      clearTimeout(timer);
    }
    this._debounceTimers.clear();
    this._lastBranch.clear();
  }

  close(): void {
    this._closeAll();
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
  private _watchers: fs.FSWatcher[] = [];
  private _debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private _lastSha = new Map<string, string | null>();
  private _entries = new Map<string, { cwdPath: string; branch: string; upstreamRef: string }>();
  private _callback: RefChangeCallback;

  constructor(callback: RefChangeCallback) {
    this._callback = callback;
  }

  async rebuild(entries: Array<{ cwdPath: string; branch: string }>): Promise<void> {
    this._closeAll();

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
          'git', ['rev-parse', '--symbolic-full-name', '@{u}'],
          { cwd: cwdPath },
        );
        upstreamRef = stdout.trim();
        if (!upstreamRef) continue;
      } catch (_) {
        // No upstream (detached HEAD, unpushed branch) — skip
        continue;
      }

      const key = `${cwdPath}:${branch}`;
      this._entries.set(key, { cwdPath, branch, upstreamRef });

      // Seed last known SHA
      try {
        const { stdout } = await execFileAsync(
          'git', ['rev-parse', upstreamRef],
          { cwd: cwdPath },
        );
        this._lastSha.set(key, stdout.trim());
      } catch (_) {
        this._lastSha.set(key, null);
      }

      // Resolve git dir (handles worktrees via commondir)
      const gitDir = resolveGitDir(cwdPath);
      if (!gitDir) continue;

      // Watch the loose ref file if it exists (e.g. refs/remotes/origin/feature-x)
      // upstreamRef is like "refs/remotes/origin/feature-x"
      const refFile = path.join(gitDir, upstreamRef);
      this._addWatch(refFile, key);

      // Watch the remote's ref directory to catch new ref creation
      const refDir = path.dirname(refFile);
      this._addWatch(refDir, key);
    }
  }

  private _addWatch(target: string, key: string): void {
    try {
      if (!fs.existsSync(target)) return;
      const watcher = fs.watch(target, { persistent: false }, () => {
        this._debouncedCheck(key);
      });
      watcher.on('error', () => {});
      this._watchers.push(watcher);
    } catch (_) {}
  }

  private _debouncedCheck(key: string): void {
    const existing = this._debounceTimers.get(key);
    if (existing) clearTimeout(existing);

    this._debounceTimers.set(key, setTimeout(() => {
      this._debounceTimers.delete(key);
      this._checkAndEmit(key);
    }, 300));
  }

  private async _checkAndEmit(key: string): Promise<void> {
    const entry = this._entries.get(key);
    if (!entry) return;

    let newSha: string | null;
    try {
      const { stdout } = await execFileAsync(
        'git', ['rev-parse', entry.upstreamRef],
        { cwd: entry.cwdPath },
      );
      newSha = stdout.trim();
    } catch (_) {
      newSha = null; // Ref deleted or pruned
    }

    const lastSha = this._lastSha.get(key);
    if (newSha !== lastSha) {
      this._lastSha.set(key, newSha);
      this._callback(entry.cwdPath, entry.branch);
    }
  }

  private _closeAll(): void {
    closeWatchers(this._watchers);
    this._watchers = [];
    for (const timer of this._debounceTimers.values()) {
      clearTimeout(timer);
    }
    this._debounceTimers.clear();
    this._lastSha.clear();
    this._entries.clear();
  }

  close(): void {
    this._closeAll();
  }
}

export class GitWatcher extends EventEmitter {
  private _watchers = new Map<string, { watcher: fs.FSWatcher; refCount: number }>();
  private _debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  watch(workspacePath: string): void {
    const existing = this._watchers.get(workspacePath);
    if (existing) {
      existing.refCount++;
      return;
    }

    const gitDir = path.join(workspacePath, '.git');
    if (!fs.existsSync(gitDir)) return;

    // For worktrees, .git is a file — resolve to actual git dir
    let watchTarget: string;
    try {
      const stat = fs.statSync(gitDir);
      if (stat.isFile()) {
        const content = fs.readFileSync(gitDir, 'utf-8').trim();
        const match = content.match(/^gitdir:\s*(.+)$/);
        if (!match) return;
        watchTarget = path.resolve(workspacePath, match[1]!);
      } else {
        watchTarget = gitDir;
      }
    } catch {
      return;
    }

    try {
      const watcher = fs.watch(watchTarget, { persistent: false }, () => {
        this._debouncedEmit(workspacePath);
      });
      watcher.on('error', () => {});
      this._watchers.set(workspacePath, { watcher, refCount: 1 });
    } catch {
      // Cannot watch — directory may not exist
    }
  }

  unwatch(workspacePath: string): void {
    const entry = this._watchers.get(workspacePath);
    if (!entry) return;
    entry.refCount--;
    if (entry.refCount <= 0) {
      try { entry.watcher.close(); } catch {}
      this._watchers.delete(workspacePath);
      const timer = this._debounceTimers.get(workspacePath);
      if (timer) {
        clearTimeout(timer);
        this._debounceTimers.delete(workspacePath);
      }
    }
  }

  private _debouncedEmit(workspacePath: string): void {
    const existing = this._debounceTimers.get(workspacePath);
    if (existing) clearTimeout(existing);
    this._debounceTimers.set(workspacePath, setTimeout(() => {
      this._debounceTimers.delete(workspacePath);
      this.emit('files-changed', { workspacePath });
    }, 500));
  }

  close(): void {
    for (const entry of this._watchers.values()) {
      try { entry.watcher.close(); } catch {}
    }
    this._watchers.clear();
    for (const timer of this._debounceTimers.values()) {
      clearTimeout(timer);
    }
    this._debounceTimers.clear();
  }
}
