import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { ActivityEntry, BranchInfo, ChangedFile, CiStatus, FileChangeStatus, PrInfo } from './types.js';

const execFileAsync = promisify(execFile);

type ExecFileAsyncResult = {
  stdout: string;
  stderr: string;
};

type ExecFileAsyncLike = (
  file: string,
  args: string[],
  options: { cwd: string; timeout?: number },
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
  } = {},
): Promise<string[]> {
  const run: ExecFileAsyncLike = options.exec || execFileAsync as ExecFileAsyncLike;

  if (options.refresh) {
    try {
      await run('git', ['fetch', '--all', '--prune'], { cwd: repoPath });
    } catch {
      // Best effort — still return the locally-known refs below.
    }
  }

  try {
    const { stdout } = await run('git', ['branch', '-a', '--format=%(refname:short)'], { cwd: repoPath });
    return normalizeBranchNames(stdout);
  } catch {
    return [];
  }
}

async function getCurrentBranch(
  repoPath: string,
  options: { exec?: ExecFileAsyncLike } = {},
): Promise<string | null> {
  const run: ExecFileAsyncLike = options.exec || execFileAsync as ExecFileAsyncLike;
  try {
    const { stdout } = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function getActivityFeed(
  repoPath: string,
  options: {
    exec?: ExecFileAsyncLike;
  } = {},
): Promise<ActivityEntry[]> {
  const run: ExecFileAsyncLike = options.exec || execFileAsync as ExecFileAsyncLike;

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
      { cwd: repoPath, timeout: 5000 },
    );

    const lines = stdout.split('\n').filter((line) => line.trim());
    const entries: ActivityEntry[] = [];

    for (const line of lines) {
      try {
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

        if (parts.length < 5) continue;

        const hash = parts[0] ?? '';
        const shortHash = parts[1] ?? '';
        const message = parts[2] ?? '';
        const author = parts[3] ?? '';
        const timeAgo = parts[4] ?? '';
        const decorations = parts[5] ?? '';

        if (!hash || !shortHash) continue;

        const branches: string[] = decorations
          .split(',')
          .map((d) => d.trim())
          .filter((d) => d && !d.startsWith('tag:') && d !== 'HEAD')
          .map((d) => d.replace(/^HEAD -> /, '').replace(/^origin\//, ''));

        entries.push({
          hash: hash.trim(),
          shortHash: shortHash.trim(),
          message: message.trim(),
          author: author.trim(),
          timeAgo: timeAgo.trim(),
          branches: [...new Set(branches)],
        });
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

async function getCiStatus(
  repoPath: string,
  branch: string,
  options: {
    exec?: ExecFileAsyncLike;
  } = {},
): Promise<(CiStatus & { authError?: boolean }) | null> {
  const run: ExecFileAsyncLike = options.exec || execFileAsync as ExecFileAsyncLike;

  let stdout: string;
  let stderr: string;

  try {
    ({ stdout, stderr } = await run(
      'gh',
      ['pr', 'checks', branch, '--json', 'name,state,conclusion'],
      { cwd: repoPath, timeout: 5000 },
    ));
  } catch (err: unknown) {
    if (err && typeof err === 'object') {
      const errObj = err as { code?: string; message?: string; stderr?: string };
      const errorText = errObj.stderr ?? errObj.message ?? '';

      // gh not installed
      if (errObj.code === 'ENOENT') return null;

      // Not authenticated
      if (
        typeof errorText === 'string' &&
        (errorText.includes('not logged into') || errorText.includes('authentication'))
      ) {
        return { total: 0, passing: 0, failing: 0, pending: 0, authError: true };
      }

      // No PR for branch
      if (
        typeof errorText === 'string' &&
        (errorText.includes('no pull requests found') || errorText.includes('Could not find'))
      ) {
        return null;
      }
    }

    return null;
  }

  // gh may exit 0 but write errors or auth prompts to stderr
  if (stderr && (stderr.includes('not logged into') || stderr.includes('authentication'))) {
    return { total: 0, passing: 0, failing: 0, pending: 0, authError: true };
  }

  if (!stdout.trim()) return null;

  try {
    const checks: Array<{ name: string; state: string; conclusion: string }> = JSON.parse(stdout);

    let passing = 0;
    let failing = 0;
    let pending = 0;

    for (const check of checks) {
      const conclusion = (check.conclusion ?? '').toUpperCase();
      const state = (check.state ?? '').toUpperCase();

      if (conclusion === 'SUCCESS' || conclusion === 'SKIPPED' || conclusion === 'NEUTRAL') {
        passing++;
      } else if (conclusion === 'FAILURE' || conclusion === 'CANCELLED' || conclusion === 'TIMED_OUT') {
        failing++;
      } else if (state === 'IN_PROGRESS' || state === 'QUEUED' || state === 'PENDING' || conclusion === '') {
        pending++;
      } else {
        // Unknown conclusion — treat as pending rather than silently ignoring
        pending++;
      }
    }

    return { total: checks.length, passing, failing, pending };
  } catch {
    return null;
  }
}

async function getPrForBranch(
  repoPath: string,
  branch: string,
  options: {
    exec?: ExecFileAsyncLike;
  } = {},
): Promise<PrInfo | null> {
  const run: ExecFileAsyncLike = options.exec || execFileAsync as ExecFileAsyncLike;

  let stdout: string;

  try {
    ({ stdout } = await run(
      'gh',
      [
        'pr',
        'view',
        branch,
        '--json',
        'number,title,url,state,headRefName,baseRefName,reviewDecision,isDraft,additions,deletions,mergeable,updatedAt',
      ],
      { cwd: repoPath, timeout: 5000 },
    ));
  } catch {
    return null;
  }

  if (!stdout.trim()) return null;

  try {
    const data = JSON.parse(stdout) as {
      number: number;
      title: string;
      url: string;
      state: string;
      headRefName: string;
      baseRefName: string;
      isDraft: boolean;
      reviewDecision: string | null;
      additions: number;
      deletions: number;
      mergeable: string;
      updatedAt: string;
    };

    return {
      number: data.number,
      title: data.title,
      url: data.url,
      state: data.state as PrInfo['state'],
      headRefName: data.headRefName,
      baseRefName: data.baseRefName,
      isDraft: data.isDraft,
      reviewDecision: data.reviewDecision ?? null,
      additions: data.additions ?? 0,
      deletions: data.deletions ?? 0,
      mergeable: (data.mergeable as PrInfo['mergeable']) ?? 'UNKNOWN',
      unresolvedCommentCount: 0,
      updatedAt: data.updatedAt ?? '',
    };
  } catch {
    return null;
  }
}

async function switchBranch(
  repoPath: string,
  branch: string,
  options: {
    exec?: ExecFileAsyncLike;
  } = {},
): Promise<{ success: true } | { success: false; error: string }> {
  const run: ExecFileAsyncLike = options.exec || execFileAsync as ExecFileAsyncLike;

  try {
    await run('git', ['checkout', branch], { cwd: repoPath, timeout: 5000 });
    return { success: true };
  } catch (err: unknown) {
    if (err && typeof err === 'object') {
      const errObj = err as { stderr?: string; message?: string };
      const errorText = errObj.stderr ?? errObj.message ?? 'Unknown error';
      return { success: false, error: errorText.trim() };
    }
    return { success: false, error: 'Unknown error' };
  }
}

async function getCommitsAhead(
  repoPath: string,
  branch: string,
  baseBranch: string,
  options: {
    exec?: ExecFileAsyncLike;
  } = {},
): Promise<number> {
  const run: ExecFileAsyncLike = options.exec || execFileAsync as ExecFileAsyncLike;

  try {
    const { stdout } = await run(
      'git',
      ['rev-list', '--count', `${baseBranch}..${branch}`],
      { cwd: repoPath, timeout: 5000 },
    );
    const count = parseInt(stdout.trim(), 10);
    return Number.isFinite(count) ? count : 0;
  } catch {
    return 0;
  }
}

async function getUnresolvedCommentCount(
  repoPath: string,
  prNumber: number,
  options: {
    exec?: ExecFileAsyncLike;
  } = {},
): Promise<number> {
  const run: ExecFileAsyncLike = options.exec || execFileAsync as ExecFileAsyncLike;

  try {
    const { stdout: repoStdout } = await run(
      'gh',
      ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
      { cwd: repoPath, timeout: 5000 },
    );
    const nameWithOwner = repoStdout.trim();
    if (!nameWithOwner) return 0;

    const [owner, repo] = nameWithOwner.split('/');
    if (!owner || !repo) return 0;

    const query = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes { isResolved }
      }
    }
  }
}`;

    const { stdout } = await run(
      'gh',
      [
        'api', 'graphql',
        '-f', `query=${query}`,
        '-f', `owner=${owner}`,
        '-f', `repo=${repo}`,
        '-F', `number=${prNumber}`,
      ],
      { cwd: repoPath, timeout: 10000 },
    );

    const result = JSON.parse(stdout) as {
      data?: {
        repository?: {
          pullRequest?: {
            reviewThreads?: {
              nodes?: Array<{ isResolved: boolean }>;
            };
          };
        };
      };
    };

    const nodes = result?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
    return nodes.filter((n) => !n.isResolved).length;
  } catch {
    return 0;
  }
}

async function getWorkingTreeDiff(
  repoPath: string,
  exec: ExecFileAsyncLike = execFileAsync,
): Promise<{ additions: number; deletions: number }> {
  try {
    const { stdout } = await exec('git', ['diff', '--shortstat'], { cwd: repoPath, timeout: 5000 });
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
 * Convert a git branch name to a human-readable display name.
 * "fix-mobile-scroll-bug" → "Fix mobile scroll bug"
 * "feature/add-auth"      → "Add auth"
 */
function branchToDisplayName(branch: string): string {
  const stripped = branch.replace(/^(feature|fix|chore|refactor|docs|test|ci|build)\//i, '');
  const words = stripped.replace(/[-_]/g, ' ').trim();
  if (!words) return branch;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

async function isBranchStale(
  repoPath: string,
  branch: string,
  options: { exec?: ExecFileAsyncLike } = {},
): Promise<boolean> {
  const run: ExecFileAsyncLike = options.exec || execFileAsync as ExecFileAsyncLike;
  try {
    for (const base of ['main', 'master']) {
      try {
        const { stdout } = await run(
          'git', ['rev-list', '--count', `${base}..${branch}`],
          { cwd: repoPath, timeout: 5000 },
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
  const httpsMatch = remoteUrl.match(/https?:\/\/[^/]+\/([^/]+\/[^/]+?)(?:\.git)?$/);
  if (httpsMatch) return httpsMatch[1] ?? null;
  return null;
}

/**
 * Returns a map of "owner/repo" → workspace path for all git workspaces.
 * Workspaces that are not git repos or have no remote are omitted.
 */
async function buildRepoMap(
  workspacePaths: string[],
  exec: ExecFileAsyncLike,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();

  await Promise.all(
    workspacePaths.map(async (wsPath) => {
      try {
        const { stdout } = await exec(
          'git',
          ['remote', 'get-url', 'origin'],
          { cwd: wsPath, timeout: 10_000 },
        );
        const ownerRepo = extractOwnerRepo(stdout.trim());
        if (ownerRepo) {
          map.set(ownerRepo.toLowerCase(), wsPath);
        }
      } catch {
        // Not a git repo or no remote — skip
      }
    }),
  );

  return map;
}

async function listBranchesEnriched(
  repoPath: string,
  options: {
    refresh?: boolean;
    exec?: ExecFileAsyncLike;
    sessions?: Array<{ id: string; worktreePath: string | null }>;
  } = {},
): Promise<BranchInfo[]> {
  const run: ExecFileAsyncLike = options.exec || execFileAsync as ExecFileAsyncLike;

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
    const { stdout } = await run('git', ['branch', '--format=%(refname:short)'], { cwd: repoPath });
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
    const { stdout } = await run('git', ['branch', '-r', '--format=%(refname:short)'], { cwd: repoPath });
    remoteBranches = stdout
      .split('\n')
      .map((b) => b.trim())
      .filter((b) => b.length > 0 && !b.includes('HEAD') && b.startsWith('origin/'))
      .map((b) => b.replace(/^origin\//, ''));
  } catch {
    // continue with empty list
  }

  // Get worktree → branch mapping via porcelain output
  const worktreeBranchMap = new Map<string, string>(); // worktreePath → branchName
  try {
    const { stdout } = await run('git', ['worktree', 'list', '--porcelain'], { cwd: repoPath });
    const blocks = stdout.split(/\n\n+/);
    for (const block of blocks) {
      const lines = block.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
      let worktreePath: string | null = null;
      let branchName: string | null = null;
      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          worktreePath = line.slice('worktree '.length);
        } else if (line.startsWith('branch ')) {
          // "branch refs/heads/branchname"
          branchName = line.slice('branch '.length).replace(/^refs\/heads\//, '');
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
  const branchWorktreeMap = new Map<string, { worktreePath: string; worktreeName: string; sessionId?: string }>();
  for (const [wtPath, branchName] of worktreeBranchMap) {
    const worktreeName = wtPath.split('/').at(-1) ?? wtPath;
    const matchingSession = (options.sessions ?? []).find(
      (s) => s.worktreePath === wtPath,
    );
    const entry: { worktreePath: string; worktreeName: string; sessionId?: string } = {
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
  options: { exec?: ExecFileAsyncLike } = {},
): Promise<{ success: true; oldName: string; newName: string } | { success: false; error: string }> {
  const run = options.exec || execFileAsync as ExecFileAsyncLike;
  try {
    // Get current branch name first
    const { stdout: currentStdout } = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath });
    const oldName = currentStdout.trim();
    if (!oldName) return { success: false, error: 'Could not determine current branch' };
    if (oldName === 'HEAD') return { success: false, error: 'Cannot rename: not on a branch (detached HEAD)' };

    await run('git', ['branch', '-m', '--', newName], { cwd: repoPath, timeout: 5000 });
    return { success: true, oldName, newName };
  } catch (err: unknown) {
    const errObj = err as { stderr?: string; message?: string };
    return { success: false, error: (errObj.stderr ?? errObj.message ?? 'Unknown error').trim() };
  }
}

async function createBranch(
  repoPath: string,
  branchName: string,
  options: { exec?: ExecFileAsyncLike } = {},
): Promise<{ success: true; branch: string } | { success: false; error: string }> {
  const run = options.exec || execFileAsync as ExecFileAsyncLike;
  try {
    await run('git', ['checkout', '-b', '--', branchName], { cwd: repoPath, timeout: 5000 });
    return { success: true, branch: branchName };
  } catch (err: unknown) {
    const errObj = err as { stderr?: string; message?: string };
    return { success: false, error: (errObj.stderr ?? errObj.message ?? 'Unknown error').trim() };
  }
}

async function changePrBase(
  repoPath: string,
  prNumber: number,
  baseBranch: string,
  options: { exec?: ExecFileAsyncLike } = {},
): Promise<{ success: true } | { success: false; error: string }> {
  const run = options.exec || execFileAsync as ExecFileAsyncLike;
  try {
    await run('gh', ['pr', 'edit', String(prNumber), '--base', baseBranch], { cwd: repoPath, timeout: 10000 });
    return { success: true };
  } catch (err: unknown) {
    const errObj = err as { stderr?: string; message?: string; code?: string };
    if (errObj.code === 'ENOENT') return { success: false, error: 'gh CLI not installed' };
    return { success: false, error: (errObj.stderr ?? errObj.message ?? 'Unknown error').trim() };
  }
}

async function pushBranch(
  repoPath: string,
  branch: string,
  deleteOldBranch?: string,
  options: { exec?: ExecFileAsyncLike } = {},
): Promise<{ success: true; deleteError?: string } | { success: false; error: string }> {
  const run = options.exec || execFileAsync as ExecFileAsyncLike;
  try {
    await run('git', ['push', 'origin', branch], { cwd: repoPath, timeout: 30000 });
  } catch (err: unknown) {
    const errObj = err as { stderr?: string; message?: string };
    return { success: false, error: (errObj.stderr ?? errObj.message ?? 'Unknown error').trim() };
  }
  if (deleteOldBranch) {
    try {
      await run('git', ['push', 'origin', '--delete', deleteOldBranch], { cwd: repoPath, timeout: 10000 });
    } catch (err: unknown) {
      const errObj = err as { stderr?: string; message?: string };
      return { success: true, deleteError: (errObj.stderr ?? errObj.message ?? 'Failed to delete old branch').trim() };
    }
  }
  return { success: true };
}

function parseStatus(code: string): FileChangeStatus {
  switch (code.trim()) {
    case 'M': return 'modified';
    case 'A': return 'added';
    case 'D': return 'deleted';
    case '??': return 'untracked';
    default:
      if (code.startsWith('R')) return 'renamed';
      return 'modified';
  }
}

function fileDirectory(filePath: string): string {
  const dir = filePath.lastIndexOf('/');
  return dir === -1 ? '.' : filePath.slice(0, dir);
}

async function getChangedFiles(
  repoPath: string,
  base?: string,
  exec: ExecFileAsyncLike = execFileAsync as ExecFileAsyncLike,
): Promise<ChangedFile[]> {
  try {
    let statusEntries: Array<{ path: string; oldPath?: string; status: FileChangeStatus }>;

    if (base) {
      // Branch comparison
      const { stdout } = await exec('git', ['diff', '--name-status', '--find-renames', `${base}...HEAD`], { cwd: repoPath, timeout: 10000 });
      statusEntries = stdout.split('\n').filter(Boolean).map(line => {
        const parts = line.split('\t');
        const code = parts[0] ?? '';
        if (code.startsWith('R')) {
          return { path: parts[2] ?? '', oldPath: parts[1] ?? '', status: 'renamed' as FileChangeStatus };
        }
        return { path: parts[1] ?? '', status: parseStatus(code) };
      });
    } else {
      // Working tree: git status --porcelain=v1 -z
      const { stdout } = await exec('git', ['status', '--porcelain=v1', '-z'], { cwd: repoPath, timeout: 10000 });
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

    // Get per-file stats via numstat
    const numstatArgs = base
      ? ['diff', '--numstat', '--find-renames', `${base}...HEAD`]
      : ['diff', '--numstat', '--find-renames'];
    let numstatMap = new Map<string, { additions: number; deletions: number }>();
    try {
      const { stdout: numstat } = await exec('git', numstatArgs, { cwd: repoPath, timeout: 10000 });
      for (const line of numstat.split('\n').filter(Boolean)) {
        const [add, del, ...pathParts] = line.split('\t');
        const filePath = pathParts.join('\t');
        const actualPath = filePath.includes(' => ') ? filePath.split(' => ').pop()!.replace(/}$/, '') : filePath;
        numstatMap.set(actualPath, {
          additions: add === '-' ? 0 : parseInt(add ?? '0', 10),
          deletions: del === '-' ? 0 : parseInt(del ?? '0', 10),
        });
      }
    } catch (err: unknown) {
      console.warn('[git] numstat failed for', repoPath, err instanceof Error ? err.message : String(err));
    }

    const files: ChangedFile[] = [];
    for (const entry of statusEntries) {
      if (!entry.path) continue;
      const stats = numstatMap.get(entry.path);
      let additions = stats?.additions ?? 0;
      let deletions = stats?.deletions ?? 0;

      if (entry.status === 'untracked' && additions === 0) {
        try {
          const { stdout: wcOut } = await exec('wc', ['-l', entry.path], { cwd: repoPath, timeout: 5000 });
          const match = wcOut.trim().match(/^\s*(\d+)/);
          if (match) additions = parseInt(match[1]!, 10);
        } catch {
          // best effort
        }
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
  } catch (err: unknown) {
    console.warn('[git] getChangedFiles failed for', repoPath, err instanceof Error ? err.message : String(err));
    return [];
  }
}

async function getFileDiff(
  repoPath: string,
  filePath: string,
  base?: string,
  exec: ExecFileAsyncLike = execFileAsync as ExecFileAsyncLike,
): Promise<string> {
  try {
    let args: string[];
    if (!base) {
      args = ['diff', '--unified=3', '--find-renames', '--', filePath];
    } else if (base === 'cached') {
      args = ['diff', '--cached', '--unified=3', '--', filePath];
    } else {
      args = ['diff', `${base}...HEAD`, '--unified=3', '--find-renames', '--', filePath];
    }

    const { stdout } = await exec('git', args, { cwd: repoPath, timeout: 10000 });

    // If empty (no changes or untracked), try --no-index for new files
    if (!stdout.trim()) {
      try {
        const { stdout: noIndexOut } = await exec('git', ['diff', '--no-index', '/dev/null', filePath], { cwd: repoPath, timeout: 10000 });
        return noIndexOut;
      } catch (err: unknown) {
        // git diff --no-index exits with code 1 when there ARE differences
        const e = err as { stdout?: string };
        if (e.stdout) return e.stdout;
      }
    }

    return stdout;
  } catch (err: unknown) {
    console.warn('[git] getFileDiff failed for', repoPath, filePath, err instanceof Error ? err.message : String(err));
    return '';
  }
}

const ONE_DAY_MS = 86_400_000;

/** A PR is stale if it's MERGED or CLOSED and was last updated more than 1 day ago (or has no valid timestamp). */
function isStalePr(pr: PrInfo): boolean {
  if (pr.state === 'OPEN') return false;
  if (!pr.updatedAt) return true; // no timestamp → treat as stale
  const elapsed = Date.now() - new Date(pr.updatedAt).getTime();
  if (Number.isNaN(elapsed)) return true; // unparseable date → treat as stale
  return elapsed > ONE_DAY_MS;
}

export {
  listBranches,
  listBranchesEnriched,
  normalizeBranchNames,
  getActivityFeed,
  getCiStatus,
  getPrForBranch,
  getUnresolvedCommentCount,
  switchBranch,
  getCommitsAhead,
  getCurrentBranch,
  getWorkingTreeDiff,
  branchToDisplayName,
  isBranchStale,
  isStalePr,
  extractOwnerRepo,
  buildRepoMap,
  renameBranch,
  createBranch,
  changePrBase,
  pushBranch,
  getChangedFiles,
  getFileDiff,
};
