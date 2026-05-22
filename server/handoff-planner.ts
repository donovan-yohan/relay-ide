import { execFile } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import type { NodeId } from '../shared/identity.js';
import type {
  HandoffConflict,
  HandoffConflictCode,
  HandoffSnapshotGroup,
  HandoffTransferMode,
} from '../shared/handoff.js';

const execFileAsync = promisify(execFile);

export type ExecFileAsyncLike = (
  file: string,
  args: string[],
  options: { cwd: string; timeout?: number; maxBuffer?: number }
) => Promise<{ stdout: string; stderr: string }>;

export interface HandoffPlannerInput {
  /** Absolute path to git repo/worktree root. */
  repoPath: string;
  /** Node identity for conflict attribution. */
  nodeId: NodeId;
  /** Injected exec for testing; defaults to execFile. */
  exec?: ExecFileAsyncLike;
}

export type TrackedFileStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'other';

export interface TrackedFileSummary {
  path: string;
  status: TrackedFileStatus;
  staged: boolean;
}

export interface UntrackedCandidate {
  path: string;
  included: boolean;
  excludeConflictCode?: HandoffConflictCode;
}

export interface ExcludedPathSummary {
  path: string;
  conflictCode: HandoffConflictCode;
  reason:
    | 'secret'
    | 'provider-auth'
    | 'cache'
    | 'ignored'
    | 'raw-log'
    | 'unsafe-path'
    | 'unsupported-kind'
    | 'oversized';
}

export const MAX_UNTRACKED_FILE_BYTES = 10 * 1024 * 1024;
export const GIT_DIFF_MAX_BUFFER_BYTES = 50 * 1024 * 1024;

export interface HandoffPlannerDryRun {
  branchName: string | null;
  baseCommit: string | null;
  /** True when working tree is fully clean (no staged, unstaged, or untracked files). */
  isClean: boolean;
  stagedFiles: TrackedFileSummary[];
  unstagedFiles: TrackedFileSummary[];
  untrackedCandidates: UntrackedCandidate[];
  excludedPaths: ExcludedPathSummary[];
  includedGroups: HandoffSnapshotGroup[];
  excludedGroups: HandoffSnapshotGroup[];
  /** Staged + unstaged tracked files plus approved untracked candidates. */
  fileCount: number;
  /** Approximate patch byte count (git diff HEAD stdout size). */
  byteCount: number;
  transferMode: HandoffTransferMode;
  conflicts: HandoffConflict[];
}

// Paths matching these patterns are classified SECRET_EXCLUDED.
const SECRET_PATTERNS: readonly RegExp[] = [
  /^\.env($|\.)/, // .env, .env.local, .env.production, etc.
  /^\.npmrc$/,
  /^\.pypirc$/,
  /(^|\/)credentials?(\.|$)/i,
  /(^|\/)tokens?(\.|$)/i,
  /(^|\/)secrets?(\.|$)/i,
  /\.(pem|key|p12|pfx|crt|cer)$/i,
  /(_rsa|_dsa|_ecdsa|_ed25519)(\.pub)?$/,
  /^\.netrc$/,
  /^\.ssh\//,
  /^\.gnupg\//,
];

// Provider auth directories — never sync these across nodes.
const PROVIDER_AUTH_PATTERNS: readonly RegExp[] = [
  /^\.anthropic\//,
  /^\.claude\//,
  /^\.codex\//,
  /^\.opencode\//,
  /^\.hermes\//,
  /^\.config\/anthropic\//,
  /^\.config\/claude\//,
  /^\.config\/codex\//,
  /^\.config\/opencode\//,
  /^\.config\/gh\//,
  /^\.config\/hermes\//,
];

// Dependency and build cache patterns — classified CACHE_EXCLUDED.
const CACHE_PATTERNS: readonly RegExp[] = [
  /^node_modules\//,
  /^\.venv\//,
  /^venv\//,
  /^vendor\//,
  /^dist\//,
  /^build\//,
  /^\.next\//,
  /^__pycache__\//,
  /^\.cache\//,
  /^\.parcel-cache\//,
  /^target\//,
  /^\.gradle\//,
];

const RAW_LOG_PATTERNS: readonly RegExp[] = [
  /(^|\/)transcripts?\//i,
  /(^|\/)raw[-_]?logs?\//i,
  /(^|\/)logs?\//i,
  /\.log(\.|$)/i,
  /\.sqlite(3)?$/i,
  /(^|\/)hermes[-_]?profile\//i,
];

interface PathClassification {
  conflictCode: HandoffConflictCode;
  reason: ExcludedPathSummary['reason'];
}

/** Returns the conflict code to apply, or null if the path is safe to include. */
function classifyPath(relativePath: string): PathClassification | null {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(relativePath)) {
      return { conflictCode: 'SECRET_EXCLUDED', reason: 'secret' };
    }
  }
  for (const pattern of PROVIDER_AUTH_PATTERNS) {
    if (pattern.test(relativePath)) {
      return { conflictCode: 'SECRET_EXCLUDED', reason: 'provider-auth' };
    }
  }
  for (const pattern of CACHE_PATTERNS) {
    if (pattern.test(relativePath)) {
      return { conflictCode: 'CACHE_EXCLUDED', reason: 'cache' };
    }
  }
  for (const pattern of RAW_LOG_PATTERNS) {
    if (pattern.test(relativePath)) {
      return { conflictCode: 'SECRET_EXCLUDED', reason: 'raw-log' };
    }
  }
  return null;
}

function inspectExistingPath(repoPath: string, relativePath: string) {
  try {
    return lstatSync(resolve(repoPath, relativePath));
  } catch {
    return null;
  }
}

/**
 * Returns true if a git-status relative path is safely contained within repoPath.
 * Rejects null bytes, absolute paths, and `../` escapes.
 */
export function isSafePath(repoPath: string, relativePath: string): boolean {
  if (!relativePath || relativePath.includes('\0')) return false;
  if (relativePath.startsWith('/')) return false;
  const resolved = resolve(repoPath, relativePath);
  const root = repoPath.endsWith('/') ? repoPath : `${repoPath}/`;
  return resolved === repoPath || resolved.startsWith(root);
}

function statusCharToStatus(c: string): TrackedFileStatus {
  switch (c) {
    case 'M':
      return 'modified';
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    default:
      return 'other';
  }
}

interface ParsedGitStatus {
  stagedFiles: TrackedFileSummary[];
  unstagedFiles: TrackedFileSummary[];
  untrackedPaths: string[];
  ignoredPaths: string[];
  unsafePaths: string[];
}

/**
 * Parses `git status --porcelain=v1 -z` stdout.
 * Entries are NUL-delimited; renames consume an extra NUL-delimited old-path entry.
 */
export function parseGitStatus(
  stdout: string,
  repoPath: string
): ParsedGitStatus {
  const parts = stdout.split('\0').filter(Boolean);
  const stagedFiles: TrackedFileSummary[] = [];
  const unstagedFiles: TrackedFileSummary[] = [];
  const untrackedPaths: string[] = [];
  const ignoredPaths: string[] = [];
  const unsafePaths: string[] = [];

  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry || entry.length < 3) continue;

    const code = entry.slice(0, 2);
    const x = code[0] ?? ' ';
    const y = code[1] ?? ' ';
    const filePath = entry.slice(3);

    // Renames: consume the extra old-path NUL entry (not needed for planner).
    if (x === 'R' || y === 'R') {
      i++;
    }

    if (!isSafePath(repoPath, filePath)) {
      unsafePaths.push(filePath);
      continue;
    }

    if (code === '??') {
      untrackedPaths.push(filePath);
      continue;
    }

    if (code === '!!') {
      ignoredPaths.push(filePath);
      continue;
    }

    if (x !== ' ') {
      stagedFiles.push({
        path: filePath,
        status: statusCharToStatus(x),
        staged: true,
      });
    }
    if (y !== ' ') {
      unstagedFiles.push({
        path: filePath,
        status: statusCharToStatus(y),
        staged: false,
      });
    }
  }

  return {
    stagedFiles,
    unstagedFiles,
    untrackedPaths,
    ignoredPaths,
    unsafePaths,
  };
}

/**
 * Produces a deterministic dry-run HandoffPlannerDryRun for a git-backed
 * worktree. Non-git repos result in STALE_SOURCE conflicts and empty file
 * sets; non-git mode is not supported and remains a follow-up.
 */
export async function planHandoffSnapshot(
  input: HandoffPlannerInput
): Promise<HandoffPlannerDryRun> {
  const { repoPath, nodeId } = input;
  const run: ExecFileAsyncLike =
    input.exec ?? (execFileAsync as ExecFileAsyncLike);

  const conflicts: HandoffConflict[] = [];

  // Resolve HEAD commit.
  let baseCommit: string | null = null;
  try {
    const { stdout } = await run('git', ['rev-parse', 'HEAD'], {
      cwd: repoPath,
      timeout: 5000,
    });
    baseCommit = stdout.trim() || null;
  } catch {
    conflicts.push({
      code: 'STALE_SOURCE',
      message:
        'HEAD commit unresolvable; repo may be unborn or inaccessible — non-git unsupported',
      nodeId,
    });
  }

  // Resolve branch name (best effort; null for detached HEAD).
  let branchName: string | null = null;
  try {
    const { stdout } = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repoPath,
      timeout: 5000,
    });
    const name = stdout.trim();
    branchName = name && name !== 'HEAD' ? name : null;
  } catch {
    // best effort
  }

  // Collect working tree status.
  let rawStatus = '';
  try {
    const { stdout } = await run(
      'git',
      [
        'status',
        '--porcelain=v1',
        '-z',
        '--ignored=matching',
        '--untracked-files=all',
      ],
      { cwd: repoPath, timeout: 10000 }
    );
    rawStatus = stdout;
  } catch {
    conflicts.push({
      code: 'STALE_SOURCE',
      message: 'git status failed; working tree may be inaccessible',
      nodeId,
    });
  }

  const {
    stagedFiles: rawStagedFiles,
    unstagedFiles: rawUnstagedFiles,
    untrackedPaths,
    ignoredPaths,
    unsafePaths,
  } = parseGitStatus(rawStatus, repoPath);

  for (const p of unsafePaths) {
    conflicts.push({
      code: 'UNSAFE_PATH_MAPPING',
      message: `path rejected as unsafe (traversal or absolute): ${p}`,
      nodeId,
    });
  }

  // Classify untracked candidates against exclusion rules.
  const excludedPaths: ExcludedPathSummary[] = [];
  const excludedTrackedSymlinkPaths = new Set<string>();

  const excludeTrackedSymlinks = (
    files: TrackedFileSummary[]
  ): TrackedFileSummary[] =>
    files.filter((file) => {
      const stat = inspectExistingPath(repoPath, file.path);
      if (!stat?.isSymbolicLink()) return true;

      if (!excludedTrackedSymlinkPaths.has(file.path)) {
        excludedTrackedSymlinkPaths.add(file.path);
        excludedPaths.push({
          path: file.path,
          conflictCode: 'UNSAFE_PATH_MAPPING',
          reason: 'unsafe-path',
        });
        conflicts.push({
          code: 'UNSAFE_PATH_MAPPING',
          message: `tracked symlink cannot be transferred as a patch: ${file.path}`,
          nodeId,
        });
      }
      return false;
    });

  const stagedFiles = excludeTrackedSymlinks(rawStagedFiles);
  const unstagedFiles = excludeTrackedSymlinks(rawUnstagedFiles);
  let untrackedByteCount = 0;
  const untrackedCandidates: UntrackedCandidate[] = untrackedPaths.map(
    (path) => {
      const classification = classifyPath(path);
      if (classification !== null) {
        excludedPaths.push({
          path,
          conflictCode: classification.conflictCode,
          reason: classification.reason,
        });
        return {
          path,
          included: false,
          excludeConflictCode: classification.conflictCode,
        };
      }
      const stat = inspectExistingPath(repoPath, path);
      if (stat?.isSymbolicLink()) {
        excludedPaths.push({
          path,
          conflictCode: 'UNSAFE_PATH_MAPPING',
          reason: 'unsafe-path',
        });
        return {
          path,
          included: false,
          excludeConflictCode: 'UNSAFE_PATH_MAPPING',
        };
      }
      if (stat && !stat.isFile()) {
        excludedPaths.push({
          path,
          conflictCode: 'UNSAFE_PATH_MAPPING',
          reason: 'unsupported-kind',
        });
        conflicts.push({
          code: 'UNSAFE_PATH_MAPPING',
          message: `untracked path has unsupported filesystem kind: ${path}`,
          nodeId,
        });
        return {
          path,
          included: false,
          excludeConflictCode: 'UNSAFE_PATH_MAPPING',
        };
      }
      if (stat?.isFile()) {
        if (stat.size > MAX_UNTRACKED_FILE_BYTES) {
          excludedPaths.push({
            path,
            conflictCode: 'CACHE_EXCLUDED',
            reason: 'oversized',
          });
          conflicts.push({
            code: 'CACHE_EXCLUDED',
            message: `untracked file exceeds ${MAX_UNTRACKED_FILE_BYTES} byte snapshot limit: ${path}`,
            nodeId,
          });
          return {
            path,
            included: false,
            excludeConflictCode: 'CACHE_EXCLUDED',
          };
        }
        untrackedByteCount += stat.size;
      }
      return { path, included: true };
    }
  );

  for (const path of ignoredPaths) {
    const classification = classifyPath(path) ?? {
      conflictCode: 'CACHE_EXCLUDED' as const,
      reason: 'ignored' as const,
    };
    excludedPaths.push({
      path,
      conflictCode: classification.conflictCode,
      reason: classification.reason,
    });
  }

  // Warn when tracked files match secret patterns (they'll appear in the patch).
  const allTracked = [...stagedFiles, ...unstagedFiles];
  for (const f of allTracked) {
    if (classifyPath(f.path)?.conflictCode === 'SECRET_EXCLUDED') {
      conflicts.push({
        code: 'SECRET_EXCLUDED',
        message: `tracked file matches secret exclusion pattern and will appear in patch: ${f.path}`,
        nodeId,
      });
    }
  }

  // Estimate size as patch bytes plus known safe untracked file bytes.
  let byteCount = untrackedByteCount;
  if (stagedFiles.length > 0 || unstagedFiles.length > 0) {
    try {
      const { stdout } = await run('git', ['diff', 'HEAD'], {
        cwd: repoPath,
        timeout: 10000,
        maxBuffer: GIT_DIFF_MAX_BUFFER_BYTES,
      });
      byteCount += Buffer.byteLength(stdout);
    } catch {
      // best effort
    }
  }

  const approvedUntracked = untrackedCandidates.filter((c) => c.included);

  const hasTracked = stagedFiles.length > 0 || unstagedFiles.length > 0;
  const hasStaged = stagedFiles.length > 0;
  const hasApprovedUntracked = approvedUntracked.length > 0;
  const hasSecretExclusion =
    excludedPaths.some((p) => p.conflictCode === 'SECRET_EXCLUDED') ||
    allTracked.some(
      (f) => classifyPath(f.path)?.conflictCode === 'SECRET_EXCLUDED'
    );
  const hasCacheExclusion = excludedPaths.some(
    (p) => p.conflictCode === 'CACHE_EXCLUDED'
  );

  const includedGroups: HandoffSnapshotGroup[] = [];
  const excludedGroups: HandoffSnapshotGroup[] = [];

  if (hasTracked) includedGroups.push('tracked-patch');
  if (hasStaged) includedGroups.push('staged-metadata');
  if (hasApprovedUntracked) includedGroups.push('approved-untracked');
  if (hasSecretExclusion) excludedGroups.push('excluded-secret');
  if (hasCacheExclusion) excludedGroups.push('excluded-cache');

  let transferMode: HandoffTransferMode = 'metadata-only';
  if (hasTracked) {
    transferMode = 'tracked-patch';
  } else if (hasApprovedUntracked) {
    transferMode = 'approved-untracked-files';
  }

  const trackedPathSet = new Set(
    [...stagedFiles, ...unstagedFiles].map((file) => file.path)
  );
  const fileCount = trackedPathSet.size + approvedUntracked.length;
  const isClean =
    stagedFiles.length === 0 &&
    unstagedFiles.length === 0 &&
    untrackedPaths.length === 0;

  return {
    branchName,
    baseCommit,
    isClean,
    stagedFiles,
    unstagedFiles,
    untrackedCandidates,
    excludedPaths,
    includedGroups,
    excludedGroups,
    fileCount,
    byteCount,
    transferMode,
    conflicts,
  };
}
