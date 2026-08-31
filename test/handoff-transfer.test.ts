import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { isHandoffRun, type HandoffRequiredGrant } from '../shared/handoff.js';
import {
  planHandoffSnapshot,
  type ExecFileAsyncLike,
} from '../server/handoff-planner.js';
import { applyHandoffTransfer } from '../server/handoff-transfer.js';

const SOURCE_NODE = 'local-node';
const DESTINATION_NODE = 'hub-node';

const tempRoots: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: '2026-05-21T12:00:00Z',
      GIT_COMMITTER_DATE: '2026-05-21T12:00:00Z',
    },
  });
}

function gitCommit(cwd: string, message: string): void {
  git(cwd, [
    '-c',
    'user.name=Relay Test',
    '-c',
    'user.email=relay@example.test',
    'commit',
    '-m',
    message,
  ]);
}

function makeRepos(): {
  root: string;
  seed: string;
  source: string;
  destination: string;
  baseCommit: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'relay-handoff-transfer-test-'));
  tempRoots.push(root);
  const seed = join(root, 'seed');
  const source = join(root, 'source');
  const destination = join(root, 'destination');

  mkdirSync(seed, { recursive: true });
  git(seed, ['init', '-b', 'nightly']);
  writeFileSync(join(seed, 'README.md'), '# relay fixture\n');
  mkdirSync(join(seed, 'src'));
  writeFileSync(join(seed, 'src', 'app.ts'), 'export const value = 1;\n');
  git(seed, ['add', '.']);
  gitCommit(seed, 'initial fixture');
  const baseCommit = git(seed, ['rev-parse', 'HEAD']).trim();

  git(root, ['clone', seed, source]);
  git(root, ['clone', seed, destination]);

  return { root, seed, source, destination, baseCommit };
}

function createIdFactory(): () => string {
  let id = 0;
  return () => `handoff-test-id-${++id}`;
}

function allowedGrants(): HandoffRequiredGrant[] {
  return [
    {
      leg: 'source-read',
      nodeId: SOURCE_NODE,
      capability: 'rpc:fs:read',
      decision: 'allow',
    },
    {
      leg: 'destination-write',
      nodeId: DESTINATION_NODE,
      capability: 'rpc:fs:write',
      decision: 'allow',
    },
    // TODO(#1497): the fixture used to also allow
    // `destination-session-create` / `destination-exec` legs, but
    // `HandoffRequiredGrantLeg` only models `source-read` and
    // `destination-write`, so the transfer path never read them.
  ];
}

async function applyFixture(input: {
  source: string;
  destination: string;
  baseCommit: string;
  approvedUntrackedPaths?: readonly string[];
  requiredGrants?: readonly HandoffRequiredGrant[];
  maxUntrackedFileBytes?: number;
  exec?: ExecFileAsyncLike;
}) {
  const dryRun = await planHandoffSnapshot({
    repoPath: input.source,
    nodeId: SOURCE_NODE,
    ...(input.approvedUntrackedPaths !== undefined
      ? { approvedUntrackedPaths: input.approvedUntrackedPaths }
      : {}),
    ...(input.exec !== undefined ? { exec: input.exec } : {}),
  });
  return applyHandoffTransfer({
    requestId: 'handoff-request-test',
    planId: 'handoff-plan-test',
    snapshotId: 'handoff-snapshot-test',
    sourceRepoPath: input.source,
    destinationRepoPath: input.destination,
    sourceNodeId: SOURCE_NODE,
    destinationNodeId: DESTINATION_NODE,
    baseCommit: input.baseCommit,
    ...(input.approvedUntrackedPaths !== undefined
      ? { approvedUntrackedPaths: input.approvedUntrackedPaths }
      : {}),
    requiredGrants: input.requiredGrants ?? allowedGrants(),
    expectedDryRun: dryRun,
    ...(input.maxUntrackedFileBytes !== undefined
      ? { maxUntrackedFileBytes: input.maxUntrackedFileBytes }
      : {}),
    ...(input.exec !== undefined ? { exec: input.exec } : {}),
    now: () => '2026-05-21T12:00:00.000Z',
    createId: createIdFactory(),
  });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('applyHandoffTransfer', () => {
  it('completes a clean git-backed handoff without touching destination files', async () => {
    const { source, destination, baseCommit } = makeRepos();
    const before = readFileSync(join(destination, 'src', 'app.ts'), 'utf8');

    const result = await applyFixture({ source, destination, baseCommit });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(isHandoffRun(result.run)).toBe(true);
    expect(result.run.state).toBe('complete');
    expect(result.run.transitions.map((transition) => transition.to)).toEqual([
      'snapshotting',
      'transferring',
      'applying',
      'complete',
    ]);
    expect(result.trackedPatch.applied).toBe(false);
    expect(readFileSync(join(destination, 'src', 'app.ts'), 'utf8')).toBe(
      before
    );
    expect(git(destination, ['status', '--porcelain=v1'])).toBe('');
  });

  it('applies a tracked dirty diff as a patch against the planned base', async () => {
    const { source, destination, baseCommit } = makeRepos();
    writeFileSync(join(source, 'src', 'app.ts'), 'export const value = 2;\n');

    const result = await applyFixture({ source, destination, baseCommit });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.trackedPatch.applied).toBe(true);
    expect(result.trackedPatch.byteCount).toBeGreaterThan(0);
    expect(readFileSync(join(destination, 'src', 'app.ts'), 'utf8')).toBe(
      'export const value = 2;\n'
    );
    expect(result.auditEvents.some((event) => event.sha256)).toBe(true);
  });

  it('copies only explicitly approved untracked files and leaves secrets/caches absent', async () => {
    const { source, destination, baseCommit } = makeRepos();
    writeFileSync(join(source, 'notes.md'), 'safe note\n');
    writeFileSync(join(source, '.env'), 'TOKEN=do-not-copy\n');
    mkdirSync(join(source, 'node_modules'));
    writeFileSync(join(source, 'node_modules', 'cache.txt'), 'cache\n');

    const result = await applyFixture({
      source,
      destination,
      baseCommit,
      approvedUntrackedPaths: ['notes.md', '.env', 'node_modules/cache.txt'],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.approvedUntrackedFiles.map((file) => file.path)).toEqual([
      'notes.md',
    ]);
    expect(readFileSync(join(destination, 'notes.md'), 'utf8')).toBe(
      'safe note\n'
    );
    expect(existsSync(join(destination, '.env'))).toBe(false);
    expect(existsSync(join(destination, 'node_modules', 'cache.txt'))).toBe(
      false
    );
  });

  it('rejects source base mismatch before touching the destination', async () => {
    const { source, destination, baseCommit } = makeRepos();
    writeFileSync(join(source, 'src', 'app.ts'), 'export const value = 3;\n');
    git(source, ['add', 'src/app.ts']);
    gitCommit(source, 'advance source');
    const before = readFileSync(join(destination, 'src', 'app.ts'), 'utf8');

    const result = await applyFixture({ source, destination, baseCommit });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.conflicts[0]).toMatchObject({ code: 'STALE_SOURCE' });
    expect(readFileSync(join(destination, 'src', 'app.ts'), 'utf8')).toBe(
      before
    );
    expect(git(destination, ['status', '--porcelain=v1'])).toBe('');
  });

  it('rejects destination base mismatch before applying the source patch', async () => {
    const { source, destination, baseCommit } = makeRepos();
    writeFileSync(join(source, 'src', 'app.ts'), 'export const value = 4;\n');
    writeFileSync(join(destination, 'README.md'), '# destination advanced\n');
    git(destination, ['add', 'README.md']);
    gitCommit(destination, 'advance destination');
    const before = readFileSync(join(destination, 'src', 'app.ts'), 'utf8');

    const result = await applyFixture({ source, destination, baseCommit });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.conflicts[0]).toMatchObject({ code: 'BASE_MISMATCH' });
    expect(readFileSync(join(destination, 'src', 'app.ts'), 'utf8')).toBe(
      before
    );
  });

  it('rejects destination dirty state before applying a patch', async () => {
    const { source, destination, baseCommit } = makeRepos();
    writeFileSync(join(source, 'src', 'app.ts'), 'export const value = 5;\n');
    writeFileSync(
      join(destination, 'src', 'app.ts'),
      'export const local = 99;\n'
    );

    const result = await applyFixture({ source, destination, baseCommit });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.conflicts[0]).toMatchObject({ code: 'DESTINATION_DIRTY' });
    expect(readFileSync(join(destination, 'src', 'app.ts'), 'utf8')).toBe(
      'export const local = 99;\n'
    );
  });

  it('rejects untracked collisions before applying any tracked patch', async () => {
    const { source, destination, baseCommit } = makeRepos();
    writeFileSync(join(source, 'src', 'app.ts'), 'export const value = 6;\n');
    writeFileSync(join(source, 'notes.md'), 'source note\n');
    writeFileSync(join(destination, 'notes.md'), 'destination note\n');
    const beforeTracked = readFileSync(
      join(destination, 'src', 'app.ts'),
      'utf8'
    );

    const result = await applyFixture({
      source,
      destination,
      baseCommit,
      approvedUntrackedPaths: ['notes.md'],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.conflicts[0]).toMatchObject({ code: 'UNTRACKED_COLLISION' });
    expect(readFileSync(join(destination, 'notes.md'), 'utf8')).toBe(
      'destination note\n'
    );
    expect(readFileSync(join(destination, 'src', 'app.ts'), 'utf8')).toBe(
      beforeTracked
    );
  });

  it('rejects same-size tracked source changes after planning', async () => {
    const { source, destination, baseCommit } = makeRepos();
    writeFileSync(join(source, 'src', 'app.ts'), 'export const value = 2;\n');
    const expectedDryRun = await planHandoffSnapshot({
      repoPath: source,
      nodeId: SOURCE_NODE,
    });
    writeFileSync(join(source, 'src', 'app.ts'), 'export const value = 3;\n');
    const beforeTracked = readFileSync(
      join(destination, 'src', 'app.ts'),
      'utf8'
    );

    const result = await applyHandoffTransfer({
      requestId: 'handoff-request-test',
      planId: 'handoff-plan-test',
      snapshotId: 'handoff-snapshot-test',
      sourceRepoPath: source,
      destinationRepoPath: destination,
      sourceNodeId: SOURCE_NODE,
      destinationNodeId: DESTINATION_NODE,
      baseCommit,
      expectedDryRun,
      requiredGrants: allowedGrants(),
      now: () => '2026-05-21T12:00:00.000Z',
      createId: createIdFactory(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected stale-source failure');
    expect(result.conflicts[0]).toMatchObject({ code: 'STALE_SOURCE' });
    expect(readFileSync(join(destination, 'src', 'app.ts'), 'utf8')).toBe(
      beforeTracked
    );
    expect(git(destination, ['status', '--porcelain=v1'])).toBe('');
  });

  it('rejects same-size approved untracked source changes after planning', async () => {
    const { source, destination, baseCommit } = makeRepos();
    writeFileSync(join(source, 'notes.md'), 'aaaa\n');
    const expectedDryRun = await planHandoffSnapshot({
      repoPath: source,
      nodeId: SOURCE_NODE,
      approvedUntrackedPaths: ['notes.md'],
    });
    writeFileSync(join(source, 'notes.md'), 'bbbb\n');

    const result = await applyHandoffTransfer({
      requestId: 'handoff-request-test',
      planId: 'handoff-plan-test',
      snapshotId: 'handoff-snapshot-test',
      sourceRepoPath: source,
      destinationRepoPath: destination,
      sourceNodeId: SOURCE_NODE,
      destinationNodeId: DESTINATION_NODE,
      baseCommit,
      approvedUntrackedPaths: ['notes.md'],
      expectedDryRun,
      requiredGrants: allowedGrants(),
      now: () => '2026-05-21T12:00:00.000Z',
      createId: createIdFactory(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected stale-source failure');
    expect(result.conflicts[0]).toMatchObject({ code: 'STALE_SOURCE' });
    expect(existsSync(join(destination, 'notes.md'))).toBe(false);
    expect(git(destination, ['status', '--porcelain=v1'])).toBe('');
  });

  it('rolls back tracked and untracked writes when apply fails after mutation starts', async () => {
    const { source, destination, baseCommit } = makeRepos();
    writeFileSync(join(source, 'src', 'app.ts'), 'export const value = 7;\n');
    writeFileSync(join(source, 'notes.md'), 'source note\n');
    const beforeTracked = readFileSync(
      join(destination, 'src', 'app.ts'),
      'utf8'
    );
    let lockedDestination = false;
    const exec: ExecFileAsyncLike = async (file, args, options) => {
      const stdout = execFileSync(file, args, {
        cwd: options.cwd,
        encoding: 'utf8',
        maxBuffer: options.maxBuffer,
        timeout: options.timeout,
      });
      if (
        file === 'git' &&
        args[0] === 'apply' &&
        args.length === 2 &&
        options.cwd === destination
      ) {
        chmodSync(destination, 0o555);
        lockedDestination = true;
      }
      return { stdout, stderr: '' };
    };

    try {
      const result = await applyFixture({
        source,
        destination,
        baseCommit,
        approvedUntrackedPaths: ['notes.md'],
        exec,
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected apply failure');
      expect(result.conflicts[0]).toMatchObject({
        code: 'DESTINATION_CONFLICT',
      });
    } finally {
      if (lockedDestination) chmodSync(destination, 0o755);
    }
    expect(readFileSync(join(destination, 'src', 'app.ts'), 'utf8')).toBe(
      beforeTracked
    );
    expect(existsSync(join(destination, 'notes.md'))).toBe(false);
    expect(git(destination, ['status', '--porcelain=v1'])).toBe('');
  });

  it('returns a typed failure when the destination is unavailable', async () => {
    const { source, destination, baseCommit } = makeRepos();
    writeFileSync(join(source, 'src', 'app.ts'), 'export const value = 8;\n');
    rmSync(destination, { recursive: true, force: true });

    const result = await applyFixture({ source, destination, baseCommit });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected unavailable destination failure');
    expect(result.conflicts[0]).toMatchObject({
      code: 'DESTINATION_UNAVAILABLE',
    });
  });

  it('rejects denied grants and oversized approved files before destination writes', async () => {
    const { source, destination, baseCommit } = makeRepos();
    const deniedGrant: HandoffRequiredGrant = {
      leg: 'destination-write',
      nodeId: DESTINATION_NODE,
      capability: 'rpc:fs:write',
      decision: 'deny',
    };

    const denied = await applyFixture({
      source,
      destination,
      baseCommit,
      requiredGrants: [deniedGrant],
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error('expected denied grant failure');
    expect(denied.conflicts[0]).toMatchObject({
      code: 'MISSING_CAPABILITY_GRANT',
    });

    writeFileSync(join(source, 'big.bin'), 'too-large-for-test');
    const oversized = await applyFixture({
      source,
      destination,
      baseCommit,
      approvedUntrackedPaths: ['big.bin'],
      maxUntrackedFileBytes: 4,
    });
    expect(oversized.ok).toBe(false);
    if (oversized.ok) throw new Error('expected oversized failure');
    expect(oversized.conflicts[0]).toMatchObject({ code: 'CACHE_EXCLUDED' });
    expect(existsSync(join(destination, 'big.bin'))).toBe(false);
    expect(git(destination, ['status', '--porcelain=v1'])).toBe('');
  });
});
