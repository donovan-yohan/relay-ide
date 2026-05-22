import {
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  GIT_DIFF_MAX_BUFFER_BYTES,
  isSafePath,
  MAX_UNTRACKED_FILE_BYTES,
  parseGitStatus,
  planHandoffSnapshot,
  type ExecFileAsyncLike,
  type HandoffPlannerDryRun,
} from '../server/handoff-planner.js';

const REPO_PATH = '/repos/relay-ide';
const NODE_ID = 'local';

type ExecCall = {
  file: string;
  args: string[];
  options: Parameters<ExecFileAsyncLike>[2];
};

// Builds a NUL-delimited porcelain=v1 -z status string from an array of entries.
// Each entry is the raw text (e.g. "M  src/foo.ts" or "?? newfile.ts").
function statusLine(...entries: string[]): string {
  return entries.map((e) => `${e}\0`).join('');
}

// Creates a mock exec that dispatches on the first git sub-command.
function makeExec(
  handlers: Partial<{
    revparseHead: string;
    revparseAbbrev: string;
    status: string;
    diff: string;
  }>
): ExecFileAsyncLike {
  return async (_file, args) => {
    const sub = args[0];
    if (sub === 'rev-parse') {
      if (args[1] === 'HEAD') {
        return { stdout: handlers.revparseHead ?? '', stderr: '' };
      }
      return { stdout: handlers.revparseAbbrev ?? '', stderr: '' };
    }
    if (sub === 'status') return { stdout: handlers.status ?? '', stderr: '' };
    if (sub === 'diff') return { stdout: handlers.diff ?? '', stderr: '' };
    throw new Error(`unexpected git command: ${args.join(' ')}`);
  };
}

function cleanExec(): ExecFileAsyncLike {
  return makeExec({
    revparseHead:
      'abc123def456abc123def456abc123def456abc123def456abc123def456\n',
    revparseAbbrev: 'main\n',
    status: '',
    diff: '',
  });
}

describe('isSafePath', () => {
  it('accepts a normal relative path', () => {
    expect(isSafePath('/repo', 'src/foo.ts')).toBe(true);
  });

  it('accepts a path at repo root level', () => {
    expect(isSafePath('/repo', 'README.md')).toBe(true);
  });

  it('rejects a path that traverses above repo root', () => {
    expect(isSafePath('/repo', '../etc/passwd')).toBe(false);
  });

  it('rejects a path with a null byte', () => {
    expect(isSafePath('/repo', 'src/foo\0.ts')).toBe(false);
  });

  it('rejects an absolute path', () => {
    expect(isSafePath('/repo', '/etc/passwd')).toBe(false);
  });

  it('rejects an empty path', () => {
    expect(isSafePath('/repo', '')).toBe(false);
  });
});

describe('parseGitStatus', () => {
  it('returns empty arrays for empty status output', () => {
    const result = parseGitStatus('', REPO_PATH);
    expect(result).toEqual({
      stagedFiles: [],
      unstagedFiles: [],
      untrackedPaths: [],
      ignoredPaths: [],
      unsafePaths: [],
    });
  });

  it('classifies staged modification (X=M Y=space)', () => {
    const out = statusLine('M  src/server.ts');
    const { stagedFiles, unstagedFiles } = parseGitStatus(out, REPO_PATH);
    expect(stagedFiles).toEqual([
      { path: 'src/server.ts', status: 'modified', staged: true },
    ]);
    expect(unstagedFiles).toHaveLength(0);
  });

  it('classifies unstaged modification (X=space Y=M)', () => {
    const out = statusLine(' M src/client.ts');
    const { stagedFiles, unstagedFiles } = parseGitStatus(out, REPO_PATH);
    expect(stagedFiles).toHaveLength(0);
    expect(unstagedFiles).toEqual([
      { path: 'src/client.ts', status: 'modified', staged: false },
    ]);
  });

  it('classifies staged addition (X=A)', () => {
    const out = statusLine('A  src/new.ts');
    const { stagedFiles } = parseGitStatus(out, REPO_PATH);
    expect(stagedFiles[0]).toMatchObject({ status: 'added', staged: true });
  });

  it('classifies staged deletion (X=D)', () => {
    const out = statusLine('D  src/old.ts');
    const { stagedFiles } = parseGitStatus(out, REPO_PATH);
    expect(stagedFiles[0]).toMatchObject({ status: 'deleted', staged: true });
  });

  it('classifies untracked file', () => {
    const out = statusLine('?? newfile.ts');
    const { untrackedPaths, stagedFiles, unstagedFiles } = parseGitStatus(
      out,
      REPO_PATH
    );
    expect(untrackedPaths).toEqual(['newfile.ts']);
    expect(stagedFiles).toHaveLength(0);
    expect(unstagedFiles).toHaveLength(0);
  });

  it('classifies ignored file', () => {
    const out = statusLine('!! dist/app.js');
    const { ignoredPaths, untrackedPaths, stagedFiles, unstagedFiles } =
      parseGitStatus(out, REPO_PATH);
    expect(ignoredPaths).toEqual(['dist/app.js']);
    expect(untrackedPaths).toHaveLength(0);
    expect(stagedFiles).toHaveLength(0);
    expect(unstagedFiles).toHaveLength(0);
  });

  it('handles a staged and unstaged combination on different files', () => {
    const out =
      statusLine('M  src/a.ts') +
      statusLine(' M src/b.ts') +
      statusLine('?? new.ts');
    const result = parseGitStatus(out, REPO_PATH);
    expect(result.stagedFiles).toHaveLength(1);
    expect(result.unstagedFiles).toHaveLength(1);
    expect(result.untrackedPaths).toHaveLength(1);
  });

  it('rejects a path traversal entry and records it as unsafe', () => {
    const out = statusLine(' M ../../../etc/passwd');
    const { unstagedFiles, unsafePaths } = parseGitStatus(out, REPO_PATH);
    expect(unstagedFiles).toHaveLength(0);
    expect(unsafePaths).toContain('../../../etc/passwd');
  });

  it('handles a rename entry by consuming the old-path token', () => {
    // R  newname\0oldname\0 — rename: old path is next NUL entry
    const out = `R  src/new.ts\0src/old.ts\0`;
    const { stagedFiles } = parseGitStatus(out, REPO_PATH);
    expect(stagedFiles).toHaveLength(1);
    expect(stagedFiles[0]).toMatchObject({
      path: 'src/new.ts',
      status: 'renamed',
    });
  });
});

describe('planHandoffSnapshot — clean repo', () => {
  it('reports isClean=true and metadata-only transfer', async () => {
    const result = await planHandoffSnapshot({
      repoPath: REPO_PATH,
      nodeId: NODE_ID,
      exec: cleanExec(),
    });

    expect(result.isClean).toBe(true);
    expect(result.stagedFiles).toHaveLength(0);
    expect(result.unstagedFiles).toHaveLength(0);
    expect(result.untrackedCandidates).toHaveLength(0);
    expect(result.excludedPaths).toHaveLength(0);
    expect(result.transferMode).toBe('metadata-only');
    expect(result.fileCount).toBe(0);
    expect(result.conflicts).toHaveLength(0);
  });

  it('captures branch name and base commit', async () => {
    const result = await planHandoffSnapshot({
      repoPath: REPO_PATH,
      nodeId: NODE_ID,
      exec: cleanExec(),
    });
    expect(result.branchName).toBe('main');
    expect(result.baseCommit).toBeTruthy();
  });

  it('produces deterministic output across two identical calls', async () => {
    const exec = cleanExec();
    const a = await planHandoffSnapshot({
      repoPath: REPO_PATH,
      nodeId: NODE_ID,
      exec,
    });
    const b = await planHandoffSnapshot({
      repoPath: REPO_PATH,
      nodeId: NODE_ID,
      exec,
    });
    expect(a).toEqual(b);
  });
});

describe('planHandoffSnapshot — dirty tracked diff', () => {
  it('detects unstaged modification and selects tracked-patch transfer', async () => {
    const exec = makeExec({
      revparseHead: 'deadbeefdeadbeef\n',
      revparseAbbrev: 'feat/123\n',
      status: statusLine(' M src/server/git.ts'),
      diff: 'diff --git a/src/server/git.ts b/src/server/git.ts\n+new line\n',
    });

    const result = await planHandoffSnapshot({
      repoPath: REPO_PATH,
      nodeId: NODE_ID,
      exec,
    });

    expect(result.isClean).toBe(false);
    expect(result.unstagedFiles).toEqual([
      { path: 'src/server/git.ts', status: 'modified', staged: false },
    ]);
    expect(result.stagedFiles).toHaveLength(0);
    expect(result.transferMode).toBe('tracked-patch');
    expect(result.includedGroups).toContain('tracked-patch');
    expect(result.fileCount).toBe(1);
    expect(result.byteCount).toBeGreaterThan(0);
    expect(result.conflicts).toHaveLength(0);
  });

  it('adds approved untracked bytes to tracked patch byte count', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'relay-handoff-byte-count-'));
    const untrackedContent = 'safe sidecar content\n';
    writeFileSync(join(repoPath, 'notes.md'), untrackedContent);
    const diff =
      'diff --git a/src/server/git.ts b/src/server/git.ts\n+new line\n';
    const exec = makeExec({
      revparseHead: 'deadbeefdeadbeef\n',
      revparseAbbrev: 'feat/123\n',
      status: statusLine(' M src/server/git.ts') + statusLine('?? notes.md'),
      diff,
    });

    const result = await planHandoffSnapshot({
      repoPath,
      nodeId: NODE_ID,
      approvedUntrackedPaths: ['notes.md'],
      exec,
    });

    expect(result.includedGroups).toContain('tracked-patch');
    expect(result.includedGroups).toContain('approved-untracked');
    expect(result.byteCount).toBe(diff.length + untrackedContent.length);
  });

  it('passes an explicit maxBuffer when collecting tracked diff bytes', async () => {
    const calls: ExecCall[] = [];
    const exec: ExecFileAsyncLike = async (file, args, options) => {
      calls.push({ file, args, options });
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return { stdout: 'deadbeefdeadbeef\n', stderr: '' };
      }
      if (args[0] === 'rev-parse') return { stdout: 'feat/123\n', stderr: '' };
      if (args[0] === 'status') {
        return { stdout: statusLine(' M src/server/git.ts'), stderr: '' };
      }
      if (args[0] === 'diff') return { stdout: '+changed\n', stderr: '' };
      throw new Error(`unexpected git command: ${args.join(' ')}`);
    };

    await planHandoffSnapshot({ repoPath: REPO_PATH, nodeId: NODE_ID, exec });

    const diffCall = calls.find((call) => call.args[0] === 'diff');
    expect(diffCall?.file).toBe('git');
    expect(diffCall?.args).toEqual(['diff', 'HEAD']);
    expect(diffCall?.options).toMatchObject({
      cwd: REPO_PATH,
      timeout: 10000,
      maxBuffer: GIT_DIFF_MAX_BUFFER_BYTES,
    });
  });

  it('accounts for whole tracked patch bytes when excluding staged symlink metadata', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'relay-handoff-mixed-symlink-'));
    symlinkSync('/etc/passwd', join(repoPath, 'linked-outside'));
    const calls: ExecCall[] = [];
    const safeDiff =
      'diff --git a/src/server/git.ts b/src/server/git.ts\n+safe line\n';
    const fullDiff =
      safeDiff + 'diff --git a/linked-outside b/linked-outside\n+unsafe symlink\n';
    const exec: ExecFileAsyncLike = async (file, args, options) => {
      calls.push({ file, args, options });
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return { stdout: 'deadbeefdeadbeef\n', stderr: '' };
      }
      if (args[0] === 'rev-parse') return { stdout: 'feat/123\n', stderr: '' };
      if (args[0] === 'status') {
        return {
          stdout:
            statusLine(' M src/server/git.ts') + statusLine('A  linked-outside'),
          stderr: '',
        };
      }
      if (args[0] === 'diff') {
        return {
          stdout: args.includes('--') ? safeDiff : fullDiff,
          stderr: '',
        };
      }
      throw new Error(`unexpected git command: ${args.join(' ')}`);
    };

    const result = await planHandoffSnapshot({ repoPath, nodeId: NODE_ID, exec });

    const diffCall = calls.find((call) => call.args[0] === 'diff');
    expect(diffCall?.args).toEqual(['diff', 'HEAD']);
    expect(result.byteCount).toBe(Buffer.byteLength(fullDiff));
    expect(result.fileCount).toBe(1);
    expect(result.transferMode).toBe('tracked-patch');
    expect(result.includedGroups).toContain('tracked-patch');
    expect(result.includedGroups).not.toContain('staged-metadata');
    expect(result.excludedPaths).toContainEqual({
      path: 'linked-outside',
      conflictCode: 'UNSAFE_PATH_MAPPING',
      reason: 'unsafe-path',
    });
    expect(result.conflicts).toContainEqual(
      expect.objectContaining({
        code: 'UNSAFE_PATH_MAPPING',
        message: expect.stringContaining('linked-outside'),
      })
    );
  });

  it('counts tracked diff bytes instead of UTF-16 code units', async () => {
    const diff = '+emoji 🦀\n+kanji 日本\n';
    const exec = makeExec({
      revparseHead: 'deadbeefdeadbeef\n',
      revparseAbbrev: 'feat/123\n',
      status: statusLine(' M src/server/git.ts'),
      diff,
    });

    const result = await planHandoffSnapshot({
      repoPath: REPO_PATH,
      nodeId: NODE_ID,
      exec,
    });

    expect(Buffer.byteLength(diff)).toBeGreaterThan(diff.length);
    expect(result.byteCount).toBe(Buffer.byteLength(diff));
  });

  it('detects staged modification and includes staged-metadata group', async () => {
    const exec = makeExec({
      revparseHead: 'abc\n',
      revparseAbbrev: 'feat/staged\n',
      status: statusLine('M  src/index.ts'),
      diff: '+change\n',
    });

    const result = await planHandoffSnapshot({
      repoPath: REPO_PATH,
      nodeId: NODE_ID,
      exec,
    });

    expect(result.stagedFiles).toEqual([
      { path: 'src/index.ts', status: 'modified', staged: true },
    ]);
    expect(result.includedGroups).toContain('staged-metadata');
    expect(result.includedGroups).toContain('tracked-patch');
  });

  it('handles both staged and unstaged changes on different files', async () => {
    const exec = makeExec({
      revparseHead: 'abc\n',
      revparseAbbrev: 'main\n',
      status: statusLine('M  src/a.ts') + statusLine(' M src/b.ts'),
      diff: '+a\n+b\n',
    });

    const result = await planHandoffSnapshot({
      repoPath: REPO_PATH,
      nodeId: NODE_ID,
      exec,
    });

    expect(result.stagedFiles).toHaveLength(1);
    expect(result.unstagedFiles).toHaveLength(1);
    expect(result.fileCount).toBe(2);
  });
});

describe('planHandoffSnapshot — untracked candidates', () => {
  it('requires explicit approval for a safe untracked file by default', async () => {
    const exec = makeExec({
      revparseHead: 'abc\n',
      revparseAbbrev: 'main\n',
      status: statusLine('?? notes.md'),
      diff: '',
    });

    const result = await planHandoffSnapshot({
      repoPath: REPO_PATH,
      nodeId: NODE_ID,
      exec,
    });

    expect(result.untrackedCandidates).toEqual([
      { path: 'notes.md', included: false, approvalStatus: 'requires-review' },
    ]);
    expect(result.includedGroups).not.toContain('approved-untracked');
    expect(result.transferMode).toBe('metadata-only');
    expect(result.fileCount).toBe(0);
    expect(result.isClean).toBe(false);
  });

  it('includes a safe untracked file only when explicitly approved', async () => {
    const exec = makeExec({
      revparseHead: 'abc\n',
      revparseAbbrev: 'main\n',
      status: statusLine('?? notes.md'),
      diff: '',
    });

    const result = await planHandoffSnapshot({
      repoPath: REPO_PATH,
      nodeId: NODE_ID,
      approvedUntrackedPaths: ['notes.md'],
      exec,
    });

    expect(result.untrackedCandidates).toEqual([
      { path: 'notes.md', included: true, approvalStatus: 'approved' },
    ]);
    expect(result.includedGroups).toContain('approved-untracked');
    expect(result.transferMode).toBe('approved-untracked-files');
    expect(result.fileCount).toBe(1);
  });

  it('excludes .env files as SECRET_EXCLUDED', async () => {
    const exec = makeExec({
      revparseHead: 'abc\n',
      revparseAbbrev: 'main\n',
      status: statusLine('?? .env') + statusLine('?? .env.local'),
      diff: '',
    });

    const result = await planHandoffSnapshot({
      repoPath: REPO_PATH,
      nodeId: NODE_ID,
      exec,
    });

    for (const candidate of result.untrackedCandidates) {
      expect(candidate.included).toBe(false);
      expect(candidate.excludeConflictCode).toBe('SECRET_EXCLUDED');
    }
    expect(result.excludedPaths).toEqual([
      { path: '.env', conflictCode: 'SECRET_EXCLUDED', reason: 'secret' },
      {
        path: '.env.local',
        conflictCode: 'SECRET_EXCLUDED',
        reason: 'secret',
      },
    ]);
    expect(result.excludedGroups).toContain('excluded-secret');
    expect(result.includedGroups).not.toContain('approved-untracked');
    expect(result.transferMode).toBe('metadata-only');
  });

  it('excludes node_modules/ as CACHE_EXCLUDED', async () => {
    const exec = makeExec({
      revparseHead: 'abc\n',
      revparseAbbrev: 'main\n',
      status: statusLine('?? node_modules/'),
      diff: '',
    });

    const result = await planHandoffSnapshot({
      repoPath: REPO_PATH,
      nodeId: NODE_ID,
      exec,
    });

    expect(result.untrackedCandidates[0]).toMatchObject({
      path: 'node_modules/',
      included: false,
      excludeConflictCode: 'CACHE_EXCLUDED',
    });
    expect(result.excludedPaths[0]).toMatchObject({
      path: 'node_modules/',
      conflictCode: 'CACHE_EXCLUDED',
      reason: 'cache',
    });
    expect(result.excludedGroups).toContain('excluded-cache');
  });

  it('reports ignored files as excluded without selecting them', async () => {
    const exec = makeExec({
      revparseHead: 'abc\n',
      revparseAbbrev: 'main\n',
      status: statusLine('!! dist/app.js') + statusLine('!! ignored.log'),
      diff: '',
    });

    const result = await planHandoffSnapshot({
      repoPath: REPO_PATH,
      nodeId: NODE_ID,
      exec,
    });

    expect(result.untrackedCandidates).toHaveLength(0);
    expect(result.excludedPaths).toEqual([
      { path: 'dist/app.js', conflictCode: 'CACHE_EXCLUDED', reason: 'cache' },
      {
        path: 'ignored.log',
        conflictCode: 'SECRET_EXCLUDED',
        reason: 'raw-log',
      },
    ]);
    expect(result.excludedGroups).toContain('excluded-cache');
    expect(result.excludedGroups).toContain('excluded-secret');
    expect(result.fileCount).toBe(0);
    expect(result.isClean).toBe(true);
  });

  it('excludes .anthropic/ provider auth dir as SECRET_EXCLUDED', async () => {
    const exec = makeExec({
      revparseHead: 'abc\n',
      revparseAbbrev: 'main\n',
      status: statusLine('?? .anthropic/'),
      diff: '',
    });

    const result = await planHandoffSnapshot({
      repoPath: REPO_PATH,
      nodeId: NODE_ID,
      exec,
    });

    expect(result.untrackedCandidates[0]).toMatchObject({
      included: false,
      excludeConflictCode: 'SECRET_EXCLUDED',
    });
    expect(result.excludedPaths[0]).toMatchObject({
      reason: 'provider-auth',
    });
  });

  it('separates included from excluded when both are present', async () => {
    const exec = makeExec({
      revparseHead: 'abc\n',
      revparseAbbrev: 'main\n',
      status:
        statusLine('?? notes.md') +
        statusLine('?? .env') +
        statusLine('?? node_modules/'),
      diff: '',
    });

    const result = await planHandoffSnapshot({
      repoPath: REPO_PATH,
      nodeId: NODE_ID,
      approvedUntrackedPaths: ['notes.md'],
      exec,
    });
    const included = result.untrackedCandidates.filter((c) => c.included);
    const excluded = result.untrackedCandidates.filter((c) => !c.included);
    expect(included).toHaveLength(1);
    expect(excluded).toHaveLength(2);
    expect(result.excludedGroups).toContain('excluded-secret');
    expect(result.excludedGroups).toContain('excluded-cache');
  });

  it('deduplicates fileCount when the same tracked file has staged and unstaged changes', async () => {
    const exec = makeExec({
      revparseHead: 'abc\n',
      revparseAbbrev: 'main\n',
      status: statusLine('MM src/a.ts'),
      diff: '+changed\n',
    });

    const result = await planHandoffSnapshot({
      repoPath: REPO_PATH,
      nodeId: NODE_ID,
      exec,
    });

    expect(result.stagedFiles).toHaveLength(1);
    expect(result.unstagedFiles).toHaveLength(1);
    expect(result.fileCount).toBe(1);
  });
});

describe('planHandoffSnapshot — secret exclusion patterns', () => {
  const secretPaths = [
    '.env',
    '.env.production',
    '.env.local',
    'server.pem',
    'id_rsa',
    'id_ed25519',
    '.netrc',
    '.npmrc',
    'credentials.json',
    'tokens.json',
  ];

  for (const secretPath of secretPaths) {
    it(`excludes untracked ${secretPath}`, async () => {
      const exec = makeExec({
        revparseHead: 'abc\n',
        revparseAbbrev: 'main\n',
        status: statusLine(`?? ${secretPath}`),
        diff: '',
      });

      const result = await planHandoffSnapshot({
        repoPath: REPO_PATH,
        nodeId: NODE_ID,
        exec,
      });

      expect(result.untrackedCandidates[0]).toMatchObject({
        included: false,
        excludeConflictCode: 'SECRET_EXCLUDED',
      });
    });
  }

  it('adds a single SECRET_EXCLUDED conflict when a tracked secret has staged and unstaged changes', async () => {
    const exec = makeExec({
      revparseHead: 'abc\n',
      revparseAbbrev: 'main\n',
      status: statusLine('MM .env'),
      diff: '-OLD=val\n+NEW=val\n',
    });

    const result = await planHandoffSnapshot({
      repoPath: REPO_PATH,
      nodeId: NODE_ID,
      exec,
    });

    const secretConflicts = result.conflicts.filter(
      (c) => c.code === 'SECRET_EXCLUDED'
    );
    expect(secretConflicts).toHaveLength(1);
    expect(secretConflicts[0]?.message).toContain('.env');
  });
});

describe('planHandoffSnapshot — path safety', () => {
  it('adds UNSAFE_PATH_MAPPING conflict for traversal path', async () => {
    const exec = makeExec({
      revparseHead: 'abc\n',
      revparseAbbrev: 'main\n',
      status: statusLine(' M ../../../etc/passwd'),
      diff: '',
    });

    const result = await planHandoffSnapshot({
      repoPath: REPO_PATH,
      nodeId: NODE_ID,
      exec,
    });

    const conflict = result.conflicts.find(
      (c) => c.code === 'UNSAFE_PATH_MAPPING'
    );
    expect(conflict).toBeDefined();
    expect(conflict?.message).toContain('../../../etc/passwd');
    // Unsafe path must not appear in any file list.
    const allPaths = [
      ...result.stagedFiles,
      ...result.unstagedFiles,
      ...result.untrackedCandidates,
    ].map((f) => f.path);
    expect(allPaths).not.toContain('../../../etc/passwd');
  });

  it('excludes existing untracked symlinks as unsafe mappings', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'relay-handoff-symlink-'));
    writeFileSync(join(repoPath, 'target.txt'), 'target');
    symlinkSync('target.txt', join(repoPath, 'linked.txt'));
    const exec = makeExec({
      revparseHead: 'abc\n',
      revparseAbbrev: 'main\n',
      status: statusLine('?? linked.txt'),
      diff: '',
    });

    const result = await planHandoffSnapshot({
      repoPath,
      nodeId: NODE_ID,
      exec,
    });

    expect(result.untrackedCandidates).toEqual([
      {
        path: 'linked.txt',
        included: false,
        approvalStatus: 'default-excluded',
        excludeConflictCode: 'UNSAFE_PATH_MAPPING',
      },
    ]);
    expect(result.excludedPaths).toEqual([
      {
        path: 'linked.txt',
        conflictCode: 'UNSAFE_PATH_MAPPING',
        reason: 'unsafe-path',
      },
    ]);
  });

  it('excludes staged symlink pointing outside repo as unsafe mapping', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'relay-handoff-staged-symlink-'));
    symlinkSync('/etc/passwd', join(repoPath, 'linked-outside'));
    const exec = makeExec({
      revparseHead: 'abc\n',
      revparseAbbrev: 'main\n',
      status: statusLine('A  linked-outside'),
      diff: '',
    });

    const result = await planHandoffSnapshot({
      repoPath,
      nodeId: NODE_ID,
      exec,
    });

    expect(result.stagedFiles.map((file) => file.path)).not.toContain(
      'linked-outside'
    );
    expect(result.includedGroups).not.toContain('tracked-patch');
    expect(result.excludedPaths).toContainEqual({
      path: 'linked-outside',
      conflictCode: 'UNSAFE_PATH_MAPPING',
      reason: 'unsafe-path',
    });
    const conflict = result.conflicts.find(
      (candidate) => candidate.code === 'UNSAFE_PATH_MAPPING'
    );
    expect(conflict).toBeDefined();
    expect(conflict?.message).toContain('linked-outside');
  });

  it('excludes oversized untracked files as typed cache exclusions', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'relay-handoff-oversized-'));
    writeFileSync(join(repoPath, 'huge.bin'), '');
    truncateSync(join(repoPath, 'huge.bin'), MAX_UNTRACKED_FILE_BYTES + 1);
    const exec = makeExec({
      revparseHead: 'abc\n',
      revparseAbbrev: 'main\n',
      status: statusLine('?? huge.bin'),
      diff: '',
    });

    const result = await planHandoffSnapshot({
      repoPath,
      nodeId: NODE_ID,
      exec,
    });

    expect(result.untrackedCandidates).toEqual([
      {
        path: 'huge.bin',
        included: false,
        approvalStatus: 'default-excluded',
        excludeConflictCode: 'CACHE_EXCLUDED',
      },
    ]);
    expect(result.excludedPaths).toEqual([
      {
        path: 'huge.bin',
        conflictCode: 'CACHE_EXCLUDED',
        reason: 'oversized',
      },
    ]);
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        code: 'CACHE_EXCLUDED',
        message: expect.stringContaining('huge.bin'),
      }),
    ]);
    expect(result.includedGroups).not.toContain('approved-untracked');
    expect(result.excludedGroups).toContain('excluded-cache');
    expect(result.byteCount).toBe(0);
  });

  it('excludes unsupported untracked path kinds as unsafe mappings', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'relay-handoff-unsupported-'));
    mkdirSync(join(repoPath, 'scratch'));
    const exec = makeExec({
      revparseHead: 'abc\n',
      revparseAbbrev: 'main\n',
      status: statusLine('?? scratch/'),
      diff: '',
    });

    const result = await planHandoffSnapshot({
      repoPath,
      nodeId: NODE_ID,
      exec,
    });

    expect(result.untrackedCandidates).toEqual([
      {
        path: 'scratch/',
        included: false,
        approvalStatus: 'default-excluded',
        excludeConflictCode: 'UNSAFE_PATH_MAPPING',
      },
    ]);
    expect(result.excludedPaths).toEqual([
      {
        path: 'scratch/',
        conflictCode: 'UNSAFE_PATH_MAPPING',
        reason: 'unsupported-kind',
      },
    ]);
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        code: 'UNSAFE_PATH_MAPPING',
        message: expect.stringContaining('unsupported filesystem kind'),
      }),
    ]);
  });
});

describe('planHandoffSnapshot — non-git / stale source', () => {
  it('adds STALE_SOURCE conflict when git rev-parse HEAD fails', async () => {
    const exec: ExecFileAsyncLike = async (_file, args) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        throw new Error('not a git repository');
      }
      if (args[0] === 'rev-parse') return { stdout: '', stderr: '' };
      if (args[0] === 'status') return { stdout: '', stderr: '' };
      if (args[0] === 'diff') return { stdout: '', stderr: '' };
      throw new Error(`unexpected: ${args.join(' ')}`);
    };

    const result = await planHandoffSnapshot({
      repoPath: REPO_PATH,
      nodeId: NODE_ID,
      exec,
    });

    const stale = result.conflicts.find((c) => c.code === 'STALE_SOURCE');
    expect(stale).toBeDefined();
    expect(result.baseCommit).toBeNull();
  });

  it('adds STALE_SOURCE conflict when git status fails', async () => {
    const exec: ExecFileAsyncLike = async (_file, args) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD')
        return { stdout: 'abc\n', stderr: '' };
      if (args[0] === 'rev-parse') return { stdout: 'main\n', stderr: '' };
      if (args[0] === 'status') throw new Error('locked index');
      if (args[0] === 'diff') return { stdout: '', stderr: '' };
      throw new Error(`unexpected: ${args.join(' ')}`);
    };

    const result = await planHandoffSnapshot({
      repoPath: REPO_PATH,
      nodeId: NODE_ID,
      exec,
    });

    expect(result.conflicts.some((c) => c.code === 'STALE_SOURCE')).toBe(true);
    expect(result.stagedFiles).toHaveLength(0);
  });

  it('returns null branchName for detached HEAD', async () => {
    const exec = makeExec({
      revparseHead: 'abc\n',
      revparseAbbrev: 'HEAD\n', // detached HEAD returns literal "HEAD"
      status: '',
      diff: '',
    });

    const result = await planHandoffSnapshot({
      repoPath: REPO_PATH,
      nodeId: NODE_ID,
      exec,
    });

    expect(result.branchName).toBeNull();
  });
});

describe('planHandoffSnapshot — determinism', () => {
  it('returns identical results for identical inputs', async () => {
    const makeInput = () =>
      makeExec({
        revparseHead: 'abc123\n',
        revparseAbbrev: 'feat/test\n',
        status:
          statusLine('M  src/a.ts') +
          statusLine(' M src/b.ts') +
          statusLine('?? notes.md') +
          statusLine('?? .env') +
          statusLine('?? node_modules/'),
        diff: '+changed\n',
      });

    const r1 = await planHandoffSnapshot({
      repoPath: REPO_PATH,
      nodeId: NODE_ID,
      exec: makeInput(),
    });
    const r2 = await planHandoffSnapshot({
      repoPath: REPO_PATH,
      nodeId: NODE_ID,
      exec: makeInput(),
    });

    expect(r1).toEqual(r2);
  });

  it('correctly computes all groups and fileCount for a mixed status', async () => {
    const exec = makeExec({
      revparseHead: 'abc\n',
      revparseAbbrev: 'feat/mixed\n',
      status:
        statusLine('M  src/a.ts') + // staged
        statusLine(' M src/b.ts') + // unstaged
        statusLine('?? safe.md') + // approved untracked
        statusLine('?? .env') + // secret excluded
        statusLine('?? dist/'), // cache excluded
      diff: '+change\n',
    });

    const result: HandoffPlannerDryRun = await planHandoffSnapshot({
      repoPath: REPO_PATH,
      nodeId: NODE_ID,
      approvedUntrackedPaths: ['safe.md'],
      exec,
    });

    expect(result.transferMode).toBe('tracked-patch');
    expect(result.includedGroups).toContain('tracked-patch');
    expect(result.includedGroups).toContain('staged-metadata');
    expect(result.includedGroups).toContain('approved-untracked');
    expect(result.excludedGroups).toContain('excluded-secret');
    expect(result.excludedGroups).toContain('excluded-cache');
    // staged(1) + unstaged(1) + approved-untracked(1)
    expect(result.fileCount).toBe(3);
  });
});
