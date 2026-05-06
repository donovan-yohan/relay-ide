import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type {
  ActivityEntry,
  BranchBaseCandidate,
  BranchBaseCandidateSource,
  BranchDivergenceCommit,
  BranchDivergenceState,
  BranchDivergenceSummary,
  BranchLineDelta,
  BranchInfo,
  BranchLifecycleState,
  ChangedFile,
  DirtyFileStatus,
  DirtySummary,
  FileChangeStatus,
  PrInfo,
} from './types.js';
import { createLogger } from './logger.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('git');

type ExecFileAsyncResult = {
  stdout: string;
  stderr: string;
};

type ExecFileAsyncLike = (
  file: string,
  args: string[],
  options: { cwd: string; timeout?: number }
) => Promise<ExecFileAsyncResult>;

function normalizeBranchNames(stdout: string): string[] {
  const branches = stdout
    .split('\n')
    .map((branch) => branch.trim())
    .filter((branch) => branch && !branch.includes('HEAD'))
    .map((branch) => branch.replace(/^origin\//, ''));

  return [...new Set(branches)].sort();
}

async function listBranches(
  repoPath: string,
  options: {
    refresh?: boolean;
    exec?: ExecFileAsyncLike;
  } = {}
): Promise<string[]> {
  const run: ExecFileAsyncLike =
    options.exec || (execFileAsync as ExecFileAsyncLike);

  if (options.refresh) {
    try {
      await run('git', ['fetch', '--all', '--prune'], { cwd: repoPath });
    } catch {
      // Best effort — still return the locally-known refs below.
    }
  }

  try {
    const { stdout } = await run(
      'git',
      ['branch', '-a', '--format=%(refname:short)'],
      { cwd: repoPath }
    );
    return normalizeBranchNames(stdout);
  } catch {
    return [];
  }
}

async function getCurrentBranch(
  repoPath: string,
  options: { exec?: ExecFileAsyncLike } = {}
): Promise<string | null> {
  const run: ExecFileAsyncLike =
    options.exec || (execFileAsync as ExecFileAsyncLike);
  try {
    const { stdout } = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repoPath,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function parseActivityLine(line: string): ActivityEntry | null {
  // Split into exactly 6 parts by the first 5 pipe characters
  const parts: string[] = [];
  let remaining = line;
  for (let i = 0; i < 5; i++) {
    const idx = remaining.indexOf('|');
    if (idx === -1) break;
    parts.push(remaining.slice(0, idx));
    remaining = remaining.slice(idx + 1);
  }
  parts.push(remaining);

  if (parts.length < 5) return null;

  const hash = parts[0] ?? '';
  const shortHash = parts[1] ?? '';
  const message = parts[2] ?? '';
  const author = parts[3] ?? '';
  const timeAgo = parts[4] ?? '';
  const decorations = parts[5] ?? '';

  if (!hash || !shortHash) return null;

  const branches: string[] = decorations
    .split(',')
    .map((d) => d.trim())
    .filter((d) => d && !d.startsWith('tag:') && d !== 'HEAD')
    .map((d) => d.replace(/^HEAD -> /, '').replace(/^origin\//, ''));

  return {
    hash: hash.trim(),
    shortHash: shortHash.trim(),
    message: message.trim(),
    author: author.trim(),
    timeAgo: timeAgo.trim(),
    branches: [...new Set(branches)],
  };
}

async function getActivityFeed(
  repoPath: string,
  options: {
    exec?: ExecFileAsyncLike;
  } = {}
): Promise<ActivityEntry[]> {
  const run: ExecFileAsyncLike =
    options.exec || (execFileAsync as ExecFileAsyncLike);

  try {
    const { stdout } = await run(
      'git',
      [
        'log',
        '--all',
        '--since=24 hours ago',
        '--oneline',
        '--max-count=50',
        '--format=%H|%h|%s|%an|%ar|%D',
      ],
      { cwd: repoPath, timeout: 5000 }
    );

    const lines = stdout.split('\n').filter((line) => line.trim());
    const entries: ActivityEntry[] = [];

    for (const line of lines) {
      try {
        const entry = parseActivityLine(line);
        if (entry) entries.push(entry);
      } catch {
        // Skip malformed lines
        continue;
      }
    }

    return entries;
  } catch {
    return [];
  }
}

const UNKNOWN_ERROR = 'Unknown error';
const TAB = '\t';
const FIND_RENAMES = '--find-renames';

async function switchBranch(
  repoPath: string,
  branch: string,
  options: {
    exec?: ExecFileAsyncLike;
  } = {}
): Promise<{ success: true } | { success: false; error: string }> {
  const run: ExecFileAsyncLike =
    options.exec || (execFileAsync as ExecFileAsyncLike);

  try {
    await run('git', ['checkout', branch], { cwd: repoPath, timeout: 5000 });
    return { success: true };
  } catch (err: unknown) {
    if (err && typeof err === 'object') {
      const errObj = err as { stderr?: string; message?: string };
      const errorText = errObj.stderr ?? errObj.message ?? UNKNOWN_ERROR;
      return { success: false, error: errorText.trim() };
    }
    return { success: false, error: UNKNOWN_ERROR };
  }
}

async function getCommitsAhead(
  repoPath: string,
  branch: string,
  baseBranch: string,
  options: {
    exec?: ExecFileAsyncLike;
  } = {}
): Promise<number> {
  const run: ExecFileAsyncLike =
    options.exec || (execFileAsync as ExecFileAsyncLike);

  try {
    const { stdout } = await run(
      'git',
      ['rev-list', '--count', `${baseBranch}..${branch}`],
      { cwd: repoPath, timeout: 5000 }
    );
    const count = parseInt(stdout.trim(), 10);
    return Number.isFinite(count) ? count : 0;
  } catch {
    return 0;
  }
}

async function getWorkingTreeDiff(
  repoPath: string,
  exec: ExecFileAsyncLike = execFileAsync
): Promise<{ additions: number; deletions: number }> {
  try {
    const { stdout } = await exec('git', ['diff', '--shortstat'], {
      cwd: repoPath,
      timeout: 5000,
    });
    // Output like: " 3 files changed, 55 insertions(+), 12 deletions(-)"
    const insertions = stdout.match(/(\d+) insertion/);
    const deletions = stdout.match(/(\d+) deletion/);
    return {
      additions: insertions?.[1] ? parseInt(insertions[1], 10) : 0,
      deletions: deletions?.[1] ? parseInt(deletions[1], 10) : 0,
    };
  } catch {
    return { additions: 0, deletions: 0 };
  }
}

/**
 * Convert a descriptive phrase to a valid kebab-case git branch name.
 * "Fix the mobile scroll overflow" → "fix-the-mobile-scroll-overflow"
 * "Add user authentication"        → "add-user-authentication"
 */
function phraseToBranchName(phrase: string): string {
  return phrase
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

async function isBranchStale(
  repoPath: string,
  branch: string,
  options: { exec?: ExecFileAsyncLike } = {}
): Promise<boolean> {
  const run: ExecFileAsyncLike =
    options.exec || (execFileAsync as ExecFileAsyncLike);
  try {
    for (const base of ['main', 'master']) {
      try {
        const { stdout } = await run(
          'git',
          ['rev-list', '--count', `${base}..${branch}`],
          { cwd: repoPath, timeout: 5000 }
        );
        const count = parseInt(stdout.trim(), 10);
        if (count === 0) return true;
        return false;
      } catch {
        continue;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Extracts "owner/repo" from a git remote URL.
 * Handles both SSH (git@github.com:owner/repo.git) and HTTPS (https://github.com/owner/repo.git) forms.
 */
function extractOwnerRepo(remoteUrl: string): string | null {
  // SSH: git@github.com:owner/repo.git
  const sshMatch = remoteUrl.match(/git@[^:]+:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1] ?? null;
  // HTTPS: https://github.com/owner/repo.git
  const httpsMatch = remoteUrl.match(
    /https?:\/\/[^/]+\/([^/]+\/[^/]+?)(?:\.git)?$/
  );
  if (httpsMatch) return httpsMatch[1] ?? null;
  return null;
}

/**
 * Returns a map of "owner/repo" → workspace path for all git workspaces.
 * Workspaces that are not git repos or have no remote are omitted.
 */
async function buildRepoMap(
  workspacePaths: string[],
  exec: ExecFileAsyncLike
): Promise<Map<string, string>> {
  const map = new Map<string, string>();

  await Promise.all(
    workspacePaths.map(async (wsPath) => {
      try {
        const { stdout } = await exec('git', ['remote', 'get-url', 'origin'], {
          cwd: wsPath,
          timeout: 10_000,
        });
        const ownerRepo = extractOwnerRepo(stdout.trim());
        if (ownerRepo) {
          map.set(ownerRepo.toLowerCase(), wsPath);
        }
      } catch {
        // Not a git repo or no remote — skip
      }
    })
  );

  return map;
}

async function listBranchesEnriched(
  repoPath: string,
  options: {
    refresh?: boolean;
    exec?: ExecFileAsyncLike;
    sessions?: Array<{ id: string; worktreePath: string | null }>;
  } = {}
): Promise<BranchInfo[]> {
  const run: ExecFileAsyncLike =
    options.exec || (execFileAsync as ExecFileAsyncLike);

  if (options.refresh) {
    try {
      await run('git', ['fetch', '--all', '--prune'], { cwd: repoPath });
    } catch {
      // Best effort — still return the locally-known refs below.
    }
  }

  // Get local branches
  let localBranches: string[] = [];
  try {
    const { stdout } = await run(
      'git',
      ['branch', '--format=%(refname:short)'],
      { cwd: repoPath }
    );
    localBranches = stdout
      .split('\n')
      .map((b) => b.trim())
      .filter((b) => b.length > 0);
  } catch {
    // continue with empty list
  }

  // Get remote branches (strip origin/ prefix, skip HEAD)
  let remoteBranches: string[] = [];
  try {
    const { stdout } = await run(
      'git',
      ['branch', '-r', '--format=%(refname:short)'],
      { cwd: repoPath }
    );
    remoteBranches = stdout
      .split('\n')
      .map((b) => b.trim())
      .filter(
        (b) => b.length > 0 && !b.includes('HEAD') && b.startsWith('origin/')
      )
      .map((b) => b.replace(/^origin\//, ''));
  } catch {
    // continue with empty list
  }

  // Get worktree → branch mapping via porcelain output
  const worktreeBranchMap = new Map<string, string>(); // worktreePath → branchName
  try {
    const { stdout } = await run('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoPath,
    });
    const blocks = stdout.split(/\n\n+/);
    for (const block of blocks) {
      const lines = block
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      let worktreePath: string | null = null;
      let branchName: string | null = null;
      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          worktreePath = line.slice('worktree '.length);
        } else if (line.startsWith('branch ')) {
          // "branch refs/heads/branchname"
          branchName = line
            .slice('branch '.length)
            .replace(/^refs\/heads\//, '');
        }
      }
      if (worktreePath && branchName) {
        worktreeBranchMap.set(worktreePath, branchName);
      }
    }
  } catch {
    // continue without worktree data
  }

  // Build reverse map: branchName → worktree info
  const branchWorktreeMap = new Map<
    string,
    { worktreePath: string; worktreeName: string; sessionId?: string }
  >();
  for (const [wtPath, branchName] of worktreeBranchMap) {
    const worktreeName = wtPath.split('/').at(-1) ?? wtPath;
    const matchingSession = (options.sessions ?? []).find(
      (s) => s.worktreePath === wtPath
    );
    const entry: {
      worktreePath: string;
      worktreeName: string;
      sessionId?: string;
    } = {
      worktreePath: wtPath,
      worktreeName,
    };
    if (matchingSession?.id !== undefined) {
      entry.sessionId = matchingSession.id;
    }
    branchWorktreeMap.set(branchName, entry);
  }

  // Deduplicate by name across local + remote
  const allNames = new Set([...localBranches, ...remoteBranches]);
  const localSet = new Set(localBranches);
  const remoteSet = new Set(remoteBranches);

  const result: BranchInfo[] = [...allNames].sort().map((name) => {
    const checkedOutIn = branchWorktreeMap.get(name);
    return {
      name,
      isLocal: localSet.has(name),
      isRemote: remoteSet.has(name),
      ...(checkedOutIn ? { checkedOutIn } : {}),
    };
  });

  return result;
}

async function renameBranch(
  repoPath: string,
  newName: string,
  options: { exec?: ExecFileAsyncLike } = {}
): Promise<
  | { success: true; oldName: string; newName: string }
  | { success: false; error: string }
> {
  const run = options.exec || (execFileAsync as ExecFileAsyncLike);
  try {
    // Get current branch name first
    const { stdout: currentStdout } = await run(
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd: repoPath }
    );
    const oldName = currentStdout.trim();
    if (!oldName)
      return { success: false, error: 'Could not determine current branch' };
    if (oldName === 'HEAD')
      return {
        success: false,
        error: 'Cannot rename: not on a branch (detached HEAD)',
      };

    await run('git', ['branch', '-m', '--', newName], {
      cwd: repoPath,
      timeout: 5000,
    });
    return { success: true, oldName, newName };
  } catch (err: unknown) {
    const errObj = err as { stderr?: string; message?: string };
    return {
      success: false,
      error: (errObj.stderr ?? errObj.message ?? UNKNOWN_ERROR).trim(),
    };
  }
}

async function createBranch(
  repoPath: string,
  branchName: string,
  options: { exec?: ExecFileAsyncLike } = {}
): Promise<
  { success: true; branch: string } | { success: false; error: string }
> {
  const run = options.exec || (execFileAsync as ExecFileAsyncLike);
  try {
    await run('git', ['checkout', '-b', '--', branchName], {
      cwd: repoPath,
      timeout: 5000,
    });
    return { success: true, branch: branchName };
  } catch (err: unknown) {
    const errObj = err as { stderr?: string; message?: string };
    return {
      success: false,
      error: (errObj.stderr ?? errObj.message ?? UNKNOWN_ERROR).trim(),
    };
  }
}

async function pushBranch(
  repoPath: string,
  branch: string,
  deleteOldBranch?: string,
  options: { exec?: ExecFileAsyncLike } = {}
): Promise<
  { success: true; deleteError?: string } | { success: false; error: string }
> {
  const run = options.exec || (execFileAsync as ExecFileAsyncLike);
  try {
    await run('git', ['push', 'origin', branch], {
      cwd: repoPath,
      timeout: 30000,
    });
  } catch (err: unknown) {
    const errObj = err as { stderr?: string; message?: string };
    return {
      success: false,
      error: (errObj.stderr ?? errObj.message ?? UNKNOWN_ERROR).trim(),
    };
  }
  if (deleteOldBranch) {
    try {
      await run('git', ['push', 'origin', '--delete', deleteOldBranch], {
        cwd: repoPath,
        timeout: 10000,
      });
    } catch (err: unknown) {
      const errObj = err as { stderr?: string; message?: string };
      return {
        success: true,
        deleteError: (
          errObj.stderr ??
          errObj.message ??
          'Failed to delete old branch'
        ).trim(),
      };
    }
  }
  return { success: true };
}

function parseStatus(code: string): FileChangeStatus {
  switch (code.trim()) {
    case 'M':
      return 'modified';
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case '??':
      return 'untracked';
    default:
      if (code.startsWith('R')) return 'renamed';
      return 'modified';
  }
}

function fileDirectory(filePath: string): string {
  const dir = filePath.lastIndexOf('/');
  return dir === -1 ? '.' : filePath.slice(0, dir);
}

function normalizeNumstatPath(filePath: string): string {
  if (!filePath.includes(' => ')) return filePath;
  const arrow = ' => ';
  // Handle brace-style paths like "{old/dir => new/dir}/file.ts"
  if (filePath.startsWith('{')) {
    const braceMatch = filePath.match(/^\{([^{}]+)\}(.*)$/);
    if (braceMatch) {
      const inner = braceMatch[1]!;
      const suffix = braceMatch[2] ?? '';
      const idx = inner.lastIndexOf(arrow);
      if (idx !== -1) {
        const newPart = inner.slice(idx + arrow.length) || inner.slice(0, idx);
        return newPart + suffix;
      }
    }
  }
  // Simple "old => new" form
  const idx = filePath.lastIndexOf(arrow);
  if (idx !== -1) return filePath.slice(idx + arrow.length);
  return filePath;
}

type StatusEntry = { path: string; oldPath?: string; status: FileChangeStatus };

function parseNameStatusLine(line: string): StatusEntry {
  const parts = line.split(TAB);
  const code = parts[0] ?? '';
  if (code.startsWith('R')) {
    return {
      path: parts[2] ?? '',
      oldPath: parts[1] ?? '',
      status: 'renamed' as FileChangeStatus,
    };
  }
  return { path: parts[1] ?? '', status: parseStatus(code) };
}

async function buildNumstatMap(
  repoPath: string,
  numstatArgs: string[],
  exec: ExecFileAsyncLike
): Promise<Map<string, { additions: number; deletions: number }>> {
  const numstatMap = new Map<
    string,
    { additions: number; deletions: number }
  >();
  try {
    const { stdout: numstat } = await exec('git', numstatArgs, {
      cwd: repoPath,
      timeout: 10000,
    });
    for (const line of numstat.split('\n').filter(Boolean)) {
      const [add, del, ...pathParts] = line.split(TAB);
      const filePath = pathParts.join(TAB);
      const actualPath = normalizeNumstatPath(filePath);
      numstatMap.set(actualPath, {
        additions: add === '-' ? 0 : parseInt(add ?? '0', 10),
        deletions: del === '-' ? 0 : parseInt(del ?? '0', 10),
      });
    }
  } catch (err: unknown) {
    logger.warn(
      '[git] numstat failed for',
      repoPath,
      err instanceof Error ? err.message : String(err)
    );
  }
  return numstatMap;
}

async function countUntrackedLines(
  repoPath: string,
  filePath: string,
  exec: ExecFileAsyncLike
): Promise<number> {
  try {
    const { stdout: wcOut } = await exec('wc', ['-l', '--', filePath], {
      cwd: repoPath,
      timeout: 5000,
    });
    const match = wcOut.trim().match(/^\s*(\d+)/);
    if (match) return parseInt(match[1]!, 10);
  } catch {
    // best effort
  }
  return 0;
}

async function getChangedFiles(
  repoPath: string,
  base?: string,
  exec: ExecFileAsyncLike = execFileAsync as ExecFileAsyncLike
): Promise<ChangedFile[]> {
  let statusEntries: StatusEntry[];

  if (base === 'cached') {
    // Staged files
    const { stdout } = await exec(
      'git',
      ['diff', '--cached', '--name-status', FIND_RENAMES],
      { cwd: repoPath, timeout: 10000 }
    );
    statusEntries = stdout.split('\n').filter(Boolean).map(parseNameStatusLine);
  } else if (base) {
    // Branch comparison
    const { stdout } = await exec(
      'git',
      ['diff', '--name-status', FIND_RENAMES, `${base}...HEAD`],
      { cwd: repoPath, timeout: 10000 }
    );
    statusEntries = stdout.split('\n').filter(Boolean).map(parseNameStatusLine);
  } else {
    // Working tree: git status --porcelain=v1 -z
    const { stdout } = await exec('git', ['status', '--porcelain=v1', '-z'], {
      cwd: repoPath,
      timeout: 10000,
    });
    statusEntries = [];
    const parts = stdout.split('\0').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i]!;
      const code = entry.slice(0, 2);
      const filePath = entry.slice(3);
      if (code.startsWith('R')) {
        // porcelain=v1 -z: rename record is XY <newname>\0<origname>\0
        // filePath (entry.slice(3)) is the new name, parts[i+1] is the old name
        const oldPath = parts[++i] ?? filePath;
        statusEntries.push({ path: filePath, oldPath, status: 'renamed' });
      } else {
        statusEntries.push({ path: filePath, status: parseStatus(code) });
      }
    }
  }

  if (statusEntries.length === 0) return [];

  const numstatArgs =
    base === 'cached'
      ? ['diff', '--cached', '--numstat', FIND_RENAMES]
      : base
        ? ['diff', '--numstat', FIND_RENAMES, `${base}...HEAD`]
        : ['diff', '--numstat', FIND_RENAMES, 'HEAD'];
  const numstatMap = await buildNumstatMap(repoPath, numstatArgs, exec);

  const files: ChangedFile[] = [];
  for (const entry of statusEntries) {
    if (!entry.path) continue;
    const stats = numstatMap.get(entry.path);
    let additions = stats?.additions ?? 0;
    const deletions = stats?.deletions ?? 0;

    if (entry.status === 'untracked' && additions === 0) {
      additions = await countUntrackedLines(repoPath, entry.path, exec);
    }

    files.push({
      path: entry.path,
      status: entry.status,
      additions,
      deletions,
      directory: fileDirectory(entry.path),
      ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
    });
  }

  return files;
}

async function getFileDiff(
  repoPath: string,
  filePath: string,
  base?: string,
  exec: ExecFileAsyncLike = execFileAsync as ExecFileAsyncLike
): Promise<string> {
  let args: string[];
  if (!base) {
    args = ['diff', '--unified=3', FIND_RENAMES, '--', filePath];
  } else if (base === 'cached') {
    args = ['diff', '--cached', '--unified=3', '--', filePath];
  } else {
    args = [
      'diff',
      `${base}...HEAD`,
      '--unified=3',
      FIND_RENAMES,
      '--',
      filePath,
    ];
  }

  const { stdout } = await exec('git', args, { cwd: repoPath, timeout: 10000 });

  // If empty, try --no-index for untracked files only
  if (!stdout.trim() && !base) {
    try {
      const { stdout: statusOut } = await exec(
        'git',
        ['status', '--porcelain', '--', filePath],
        { cwd: repoPath, timeout: 10000 }
      );
      const isUntracked = statusOut.trim().startsWith('??');
      if (!isUntracked) {
        return stdout;
      }
    } catch {
      return stdout;
    }

    try {
      const { stdout: noIndexOut } = await exec(
        'git',
        ['diff', '--no-index', '--', '/dev/null', filePath],
        { cwd: repoPath, timeout: 10000 }
      );
      return noIndexOut;
    } catch (err: unknown) {
      // git diff --no-index exits with code 1 when there ARE differences
      const e = err as { stdout?: string };
      if (e.stdout) return e.stdout;
    }
  }

  return stdout;
}

const DIVERGENCE_TIMEOUT_MS = 10_000;
const DIVERGENCE_COMMITS_LIMIT = 20;
const DIVERGENCE_DIRTY_FILES_LIMIT = 50;
const ZERO_LINE_DELTA: BranchLineDelta = {
  additions: 0,
  deletions: 0,
  fileCount: 0,
};

const CLEAN_DIRTY_SUMMARY: DirtySummary = {
  stagedCount: 0,
  unstagedCount: 0,
  untrackedCount: 0,
  conflictedCount: 0,
  files: [],
  truncated: false,
};

const UNMERGED_STATUS_CODES = new Set([
  'DD',
  'AU',
  'UD',
  'UA',
  'DU',
  'AA',
  'UU',
]);

function emptyDivergenceSummary(
  repoPath: string,
  state: BranchDivergenceState,
  details: {
    error?: string;
    warnings?: string[];
    currentBranch?: string | null;
    headSha?: string | null;
    selectedBase?: { ref: string; sha: string | null } | null;
    baseCandidates?: BranchBaseCandidate[];
    dirty?: DirtySummary;
  } = {}
): BranchDivergenceSummary {
  return {
    repoPath,
    currentBranch: details.currentBranch ?? null,
    headSha: details.headSha ?? null,
    selectedBase: details.selectedBase ?? null,
    baseCandidates: details.baseCandidates ?? [],
    aheadCount: 0,
    behindCount: 0,
    lineDelta: { ...ZERO_LINE_DELTA },
    dirty: details.dirty ?? { ...CLEAN_DIRTY_SUMMARY, files: [] },
    commits: { ahead: [], behind: [] },
    state,
    ...(details.error ? { error: details.error } : {}),
    warnings: details.warnings ?? [],
    generatedAt: new Date().toISOString(),
  };
}

function errorText(error: unknown): string {
  if (!error || typeof error !== 'object') return UNKNOWN_ERROR;
  const err = error as { stderr?: string; stdout?: string; message?: string };
  return (err.stderr ?? err.stdout ?? err.message ?? UNKNOWN_ERROR).trim();
}

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as {
    code?: string | number;
    signal?: string;
    killed?: boolean;
    message?: string;
  };
  const message = err.message ?? '';
  return (
    err.code === 'ETIMEDOUT' ||
    err.signal === 'SIGTERM' ||
    err.killed === true ||
    message.includes('timed out') ||
    message.includes('timeout')
  );
}

function isNotGitRepositoryError(error: unknown): boolean {
  const text = errorText(error).toLowerCase();
  return (
    text.includes('not a git repository') ||
    text.includes('not a gitdir')
  );
}

function isNoMergeBaseError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as { code?: string | number };
  return err.code === 1 && errorText(error) === '';
}

function hasInvalidBaseRefChar(ref: string): boolean {
  for (const char of ref) {
    const code = char.charCodeAt(0);
    if (code <= 32 || code === 127 || '~^:?*[\\'.includes(char)) {
      return true;
    }
  }
  return false;
}

function isSafeBaseRef(ref: string | undefined): ref is string {
  if (typeof ref !== 'string') return false;
  if (ref.trim() !== ref || ref.length === 0) return false;
  if (ref.includes('\0')) return false;
  if (ref.startsWith('-')) return false;
  if (ref === '@') return false;
  if (ref.includes('..') || ref.includes('@{') || ref.includes('//'))
    return false;
  if (ref.startsWith('/') || ref.endsWith('/')) return false;
  if (ref.endsWith('.') || ref.endsWith('.lock')) return false;
  if (hasInvalidBaseRefChar(ref)) return false;
  if (
    ref
      .split('/')
      .some(
        (part) =>
          part.length === 0 || part.startsWith('.') || part.endsWith('.lock')
      )
  ) {
    return false;
  }
  return true;
}

async function resolveCommitRef(
  repoPath: string,
  ref: string,
  exec: ExecFileAsyncLike
): Promise<string | null> {
  const { stdout } = await exec(
    'git',
    ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
    { cwd: repoPath, timeout: DIVERGENCE_TIMEOUT_MS }
  );
  return stdout.trim() || null;
}

async function tryResolveCommitRef(
  repoPath: string,
  ref: string,
  exec: ExecFileAsyncLike
): Promise<string | null> {
  try {
    return await resolveCommitRef(repoPath, ref, exec);
  } catch (err) {
    if (isTimeoutError(err)) throw err;
    if (isGitRefNotFoundError(err)) return null;
    throw err;
  }
}

function addBaseCandidate(
  candidates: BranchBaseCandidate[],
  seen: Set<string>,
  ref: string,
  source: BranchBaseCandidateSource,
  sha: string | null
): void {
  if (!ref || seen.has(ref)) return;
  seen.add(ref);
  candidates.push({ ref, label: ref, source, sha });
}

async function getBaseCandidates(
  repoPath: string,
  exec: ExecFileAsyncLike
): Promise<BranchBaseCandidate[]> {
  const candidates: BranchBaseCandidate[] = [];
  const seen = new Set<string>();

  let remoteDefaultRef: string | null = null;
  try {
    const { stdout } = await exec(
      'git',
      ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
      { cwd: repoPath, timeout: DIVERGENCE_TIMEOUT_MS }
    );
    remoteDefaultRef = stdout.trim() || null;
  } catch (err) {
    if (isTimeoutError(err)) throw err;
    // Optional candidate only.
  }

  if (remoteDefaultRef) {
    addBaseCandidate(
      candidates,
      seen,
      remoteDefaultRef,
      'remoteDefault',
      await tryResolveCommitRef(repoPath, remoteDefaultRef, exec)
    );
  }

  try {
    const { stdout } = await exec(
      'git',
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
      { cwd: repoPath, timeout: DIVERGENCE_TIMEOUT_MS }
    );
    const upstream = stdout.trim();
    if (upstream) {
      addBaseCandidate(
        candidates,
        seen,
        upstream,
        'upstream',
        await tryResolveCommitRef(repoPath, upstream, exec)
      );
    }
  } catch (err) {
    if (isTimeoutError(err)) throw err;
    // Branch may not have upstream.
  }

  const defaultBranch = await getDefaultBranch(repoPath, exec);
  const remoteDefaultBranch = `origin/${defaultBranch}`;
  const remoteDefaultSha = await tryResolveCommitRef(
    repoPath,
    remoteDefaultBranch,
    exec
  );
  if (remoteDefaultSha) {
    addBaseCandidate(
      candidates,
      seen,
      remoteDefaultBranch,
      remoteDefaultRef ? 'remote' : 'remoteDefault',
      remoteDefaultSha
    );
  }

  const localDefaultSha = await tryResolveCommitRef(
    repoPath,
    defaultBranch,
    exec
  );
  if (localDefaultSha) {
    addBaseCandidate(
      candidates,
      seen,
      defaultBranch,
      'default',
      localDefaultSha
    );
  }

  for (const local of ['nightly', 'main', 'master']) {
    const sha = await tryResolveCommitRef(repoPath, local, exec);
    if (sha) addBaseCandidate(candidates, seen, local, 'local', sha);
  }

  for (const remote of ['origin/nightly', 'origin/main', 'origin/master']) {
    const sha = await tryResolveCommitRef(repoPath, remote, exec);
    if (sha) addBaseCandidate(candidates, seen, remote, 'remote', sha);
  }

  return candidates;
}

async function getRepoRootOrNull(
  repoPath: string,
  exec: ExecFileAsyncLike
): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['rev-parse', '--show-toplevel'], {
      cwd: repoPath,
      timeout: DIVERGENCE_TIMEOUT_MS,
    });
    return stdout.trim() || repoPath;
  } catch (err) {
    if (isTimeoutError(err)) throw err;
    if (isNotGitRepositoryError(err)) return null;
    throw err;
  }
}

async function getHeadSha(
  repoPath: string,
  exec: ExecFileAsyncLike
): Promise<string | null> {
  const { stdout } = await exec(
    'git',
    ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'],
    { cwd: repoPath, timeout: DIVERGENCE_TIMEOUT_MS }
  );
  return stdout.trim() || null;
}

async function getSymbolicCurrentBranch(
  repoPath: string,
  exec: ExecFileAsyncLike
): Promise<string | null> {
  try {
    const { stdout } = await exec(
      'git',
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      {
        cwd: repoPath,
        timeout: DIVERGENCE_TIMEOUT_MS,
      }
    );
    return stdout.trim() || null;
  } catch (err) {
    if (isTimeoutError(err)) throw err;
    return null;
  }
}

function parseRevListCounts(stdout: string): {
  behindCount: number;
  aheadCount: number;
} {
  const [behindRaw, aheadRaw] = stdout.trim().split(/\s+/);
  const behindCount = parseInt(behindRaw ?? '0', 10);
  const aheadCount = parseInt(aheadRaw ?? '0', 10);
  return {
    behindCount: Number.isFinite(behindCount) ? behindCount : 0,
    aheadCount: Number.isFinite(aheadCount) ? aheadCount : 0,
  };
}

async function getAheadBehindCounts(
  repoPath: string,
  base: string,
  exec: ExecFileAsyncLike
): Promise<{ behindCount: number; aheadCount: number }> {
  const { stdout } = await exec(
    'git',
    ['rev-list', '--left-right', '--count', `${base}...HEAD`],
    { cwd: repoPath, timeout: DIVERGENCE_TIMEOUT_MS }
  );
  return parseRevListCounts(stdout);
}

async function hasMergeBase(
  repoPath: string,
  base: string,
  exec: ExecFileAsyncLike
): Promise<boolean> {
  try {
    await exec('git', ['merge-base', '--', base, 'HEAD'], {
      cwd: repoPath,
      timeout: DIVERGENCE_TIMEOUT_MS,
    });
    return true;
  } catch (err) {
    if (isTimeoutError(err)) throw err;
    if (isNoMergeBaseError(err)) return false;
    throw err;
  }
}

async function getLineDelta(
  repoPath: string,
  base: string,
  exec: ExecFileAsyncLike
): Promise<BranchLineDelta> {
  const { stdout } = await exec(
    'git',
    ['diff', '--numstat', FIND_RENAMES, `${base}...HEAD`],
    { cwd: repoPath, timeout: DIVERGENCE_TIMEOUT_MS }
  );

  const delta: BranchLineDelta = { ...ZERO_LINE_DELTA };
  for (const line of stdout.split('\n').filter(Boolean)) {
    const [add, del] = line.split(TAB);
    delta.fileCount += 1;
    delta.additions += add === '-' ? 0 : parseInt(add ?? '0', 10) || 0;
    delta.deletions += del === '-' ? 0 : parseInt(del ?? '0', 10) || 0;
  }
  return delta;
}

function dirtyStatusForCode(code: string): DirtyFileStatus {
  const x = code[0] ?? ' ';
  const y = code[1] ?? ' ';
  if (code === '??') return 'untracked';
  if (UNMERGED_STATUS_CODES.has(code)) return 'conflicted';
  if (x === 'R' || y === 'R') return 'renamed';
  if (x === 'D' || y === 'D') return 'deleted';
  if (x === 'A' || y === 'A') return 'added';
  return 'modified';
}

function parseDirtySummary(stdout: string): DirtySummary {
  const parts = stdout.split('\0').filter(Boolean);
  const dirty: DirtySummary = { ...CLEAN_DIRTY_SUMMARY, files: [] };

  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    const code = entry.slice(0, 2);
    const x = code[0] ?? ' ';
    const y = code[1] ?? ' ';
    const isUntracked = code === '??';
    const isConflicted = UNMERGED_STATUS_CODES.has(code);
    const isRename = x === 'R' || y === 'R';
    const staged = !isUntracked && !isConflicted && x !== ' ';
    const unstaged = !isUntracked && !isConflicted && y !== ' ';
    const filePath = entry.slice(3);
    let oldPath: string | undefined;

    if (isRename) {
      oldPath = parts[++i] ?? undefined;
    }

    if (isUntracked) dirty.untrackedCount += 1;
    if (isConflicted) dirty.conflictedCount += 1;
    if (staged) dirty.stagedCount += 1;
    if (unstaged) dirty.unstagedCount += 1;

    if (dirty.files.length < DIVERGENCE_DIRTY_FILES_LIMIT) {
      dirty.files.push({
        path: filePath,
        ...(oldPath ? { oldPath } : {}),
        status: dirtyStatusForCode(code),
        staged,
        unstaged,
      });
    } else {
      dirty.truncated = true;
    }
  }

  return dirty;
}

async function getDirtySummary(
  repoPath: string,
  exec: ExecFileAsyncLike
): Promise<DirtySummary> {
  const { stdout } = await exec('git', ['status', '--porcelain=v1', '-z'], {
    cwd: repoPath,
    timeout: DIVERGENCE_TIMEOUT_MS,
  });
  return parseDirtySummary(stdout);
}

function parseDivergenceCommits(stdout: string): BranchDivergenceCommit[] {
  return stdout
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash = '', shortHash = '', subject = '', author = '', date = ''] =
        record.split('\x1f');
      return { hash, shortHash, subject, author, date };
    })
    .filter((commit) => commit.hash && commit.shortHash);
}

async function getDivergenceCommits(
  repoPath: string,
  range: string,
  exec: ExecFileAsyncLike,
  limit = DIVERGENCE_COMMITS_LIMIT
): Promise<BranchDivergenceCommit[]> {
  const { stdout } = await exec(
    'git',
    [
      'log',
      `--max-count=${limit}`,
      '--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1e',
      range,
    ],
    { cwd: repoPath, timeout: DIVERGENCE_TIMEOUT_MS }
  );
  return parseDivergenceCommits(stdout);
}

async function buildBranchDivergence(
  repoPath: string,
  base: string | undefined,
  exec: ExecFileAsyncLike
): Promise<BranchDivergenceSummary> {
  if (base !== undefined && !isSafeBaseRef(base)) {
    return emptyDivergenceSummary(repoPath, 'invalid_base', {
      error: 'invalid base ref',
    });
  }

  const root = await getRepoRootOrNull(repoPath, exec);
  if (!root) {
    return emptyDivergenceSummary(repoPath, 'not_git', {
      error: 'not a git repository',
    });
  }

  const baseCandidates = await getBaseCandidates(root, exec);
  const selectedBaseRef = base ?? baseCandidates[0]?.ref;
  const currentBranch = await getSymbolicCurrentBranch(root, exec);

  let headSha: string | null;
  try {
    headSha = await getHeadSha(root, exec);
  } catch (err) {
    if (isTimeoutError(err)) throw err;
    return emptyDivergenceSummary(root, 'unborn', {
      error: 'HEAD does not point to a commit',
      currentBranch,
      baseCandidates,
    });
  }

  const dirty = await getDirtySummary(root, exec);

  if (!selectedBaseRef) {
    return emptyDivergenceSummary(root, 'missing_base', {
      error: 'base ref not found',
      currentBranch,
      headSha,
      baseCandidates,
      dirty,
    });
  }

  let selectedBaseSha: string | null;
  try {
    selectedBaseSha = await resolveCommitRef(root, selectedBaseRef, exec);
  } catch (err) {
    if (isTimeoutError(err)) throw err;
    return emptyDivergenceSummary(root, 'missing_base', {
      error: `base ref not found: ${selectedBaseRef}`,
      currentBranch,
      headSha,
      baseCandidates,
      selectedBase: { ref: selectedBaseRef, sha: null },
      dirty,
    });
  }

  if (!(await hasMergeBase(root, selectedBaseRef, exec))) {
    return emptyDivergenceSummary(root, 'no_merge_base', {
      error: `no merge base with ${selectedBaseRef}`,
      currentBranch,
      headSha,
      baseCandidates,
      selectedBase: { ref: selectedBaseRef, sha: selectedBaseSha },
      dirty,
    });
  }

  const { aheadCount, behindCount } = await getAheadBehindCounts(
    root,
    selectedBaseRef,
    exec
  );
  const lineDelta = await getLineDelta(root, selectedBaseRef, exec);
  const [ahead, behind] = await Promise.all([
    getDivergenceCommits(root, `${selectedBaseRef}..HEAD`, exec),
    getDivergenceCommits(root, `HEAD..${selectedBaseRef}`, exec),
  ]);
  const warnings = currentBranch ? [] : ['HEAD is detached'];
  const state: BranchDivergenceState = currentBranch ? 'ok' : 'detached';

  return {
    repoPath: root,
    currentBranch,
    headSha,
    selectedBase: { ref: selectedBaseRef, sha: selectedBaseSha },
    baseCandidates,
    aheadCount,
    behindCount,
    lineDelta,
    dirty,
    commits: { ahead, behind },
    state,
    warnings,
    generatedAt: new Date().toISOString(),
  };
}

async function getBranchDivergence(
  repoPath: string,
  options: {
    base?: string;
    exec?: ExecFileAsyncLike;
  } = {}
): Promise<BranchDivergenceSummary> {
  const run: ExecFileAsyncLike =
    options.exec || (execFileAsync as ExecFileAsyncLike);
  try {
    return await buildBranchDivergence(repoPath, options.base, run);
  } catch (err) {
    if (isTimeoutError(err)) {
      return emptyDivergenceSummary(repoPath, 'timeout', {
        error: 'git command timed out',
      });
    }
    logger.warn('[git] branch divergence failed for', repoPath, errorText(err));
    return emptyDivergenceSummary(repoPath, 'git_error', {
      error: errorText(err) || 'Failed to compute branch divergence',
      warnings: ['git divergence failed inside repository'],
    });
  }
}

async function getDefaultBranch(
  repoPath: string,
  exec: ExecFileAsyncLike = execFileAsync as ExecFileAsyncLike
): Promise<string> {
  // Try symbolic-ref first (most repos have this set)
  try {
    const { stdout } = await exec(
      'git',
      ['symbolic-ref', 'refs/remotes/origin/HEAD'],
      { cwd: repoPath, timeout: 5000 }
    );
    const ref = stdout.trim();
    const prefix = 'refs/remotes/origin/';
    if (ref.startsWith(prefix)) return ref.slice(prefix.length);
  } catch (err) {
    if (isTimeoutError(err)) throw err;
    // Not set — fall through to heuristic
  }

  // Check if main or master exists locally
  for (const candidate of ['main', 'master']) {
    try {
      await exec('git', ['rev-parse', '--verify', `refs/heads/${candidate}`], {
        cwd: repoPath,
        timeout: 5000,
      });
      return candidate;
    } catch (err) {
      if (isTimeoutError(err)) throw err;
      // Not found — try next
    }
  }

  return 'main'; // ultimate fallback
}

interface EnsureBranchResult {
  found: boolean;
  reason?: 'not_found' | 'fetch_failed';
}

function isGitRefNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const stderr = (error as { stderr?: string }).stderr ?? '';
  const message = (error as { message?: string }).message ?? '';
  const text = stderr || message;
  return (
    text.includes('Needed a single revision') ||
    text.includes('unknown revision or path not in the working tree') ||
    text.includes('ambiguous argument') ||
    text.includes("couldn't find remote ref") ||
    text.includes('could not find remote ref') ||
    text.includes('not something we can merge') ||
    text.includes('fatal: bad revision')
  );
}

/**
 * Ensure a branch ref exists locally. If not, fetch it from origin.
 * Returns { found: true } if the branch is now available locally,
 * { found: false, reason: 'not_found' } if it doesn't exist anywhere,
 * or { found: false, reason: 'fetch_failed' } if the fetch failed unexpectedly.
 * Rethrows non-git errors (permissions, timeouts, corrupt repo) so callers
 * can distinguish "branch doesn't exist" from "git is broken".
 */
async function ensureBranchLocal(
  repoPath: string,
  branch: string,
  options: { exec?: ExecFileAsyncLike } = {}
): Promise<EnsureBranchResult> {
  const run: ExecFileAsyncLike =
    options.exec || (execFileAsync as ExecFileAsyncLike);

  // Check if branch exists locally
  try {
    await run('git', ['rev-parse', '--verify', '--', branch], {
      cwd: repoPath,
      timeout: 5000,
    });
    return { found: true };
  } catch (error) {
    if (!isGitRefNotFoundError(error)) {
      throw error; // permissions, timeout, corrupt repo — surface to caller
    }
    // Not found locally — try fetching
  }

  // Fetch from origin
  try {
    await run('git', ['fetch', 'origin', '--', `${branch}:${branch}`], {
      cwd: repoPath,
      timeout: 30000,
    });
    return { found: true };
  } catch (error) {
    if (isGitRefNotFoundError(error)) {
      return { found: false, reason: 'not_found' };
    }
    // Network failures, auth errors, DNS issues — distinct from "branch doesn't exist"
    return { found: false, reason: 'fetch_failed' };
  }
}

/** Check if a PR is in MERGED state (immediate check, no 24h delay like isStalePr). */
function isPrMerged(pr: PrInfo): boolean {
  return pr.state === 'MERGED';
}

interface BranchLifecycleInput {
  pr: PrInfo | null;
  isBranchStale: boolean;
  hasActiveSessions: boolean;
  isMainBranch: boolean;
}

interface BranchLifecycleResult {
  state: BranchLifecycleState;
  prNumber?: number;
  prTitle?: string;
}

/**
 * Compute branch lifecycle state from authoritative sources.
 * Main branch can be active/stale but never merged.
 */
function computeBranchLifecycleState(
  input: BranchLifecycleInput
): BranchLifecycleResult {
  const { pr, isBranchStale: stale, hasActiveSessions, isMainBranch } = input;

  // Merged: PR is merged AND not the main branch
  if (pr && isPrMerged(pr) && !isMainBranch) {
    return { state: 'merged', prNumber: pr.number, prTitle: pr.title };
  }

  // Active: has sessions OR branch is not stale
  if (hasActiveSessions || !stale) {
    return { state: 'active' };
  }

  // Stale: no sessions AND branch is stale (0 commits ahead of main)
  return { state: 'stale' };
}

export {
  listBranches,
  listBranchesEnriched,
  normalizeBranchNames,
  getActivityFeed,
  switchBranch,
  getCommitsAhead,
  getCurrentBranch,
  getWorkingTreeDiff,
  phraseToBranchName,
  isBranchStale,
  extractOwnerRepo,
  buildRepoMap,
  renameBranch,
  createBranch,
  pushBranch,
  getChangedFiles,
  getFileDiff,
  getBranchDivergence,
  getDefaultBranch,
  ensureBranchLocal,
  isPrMerged,
  computeBranchLifecycleState,
};
export type { EnsureBranchResult };
