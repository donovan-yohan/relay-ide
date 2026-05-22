import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  HANDOFF_SCHEMA_VERSION,
  type HandoffConflict,
  type HandoffReasonCode,
  type HandoffRequiredGrant,
  type HandoffRun,
  type HandoffRunState,
  type HandoffRunTransition,
} from '../shared/handoff.js';
import type { NodeId } from '../shared/identity.js';
import {
  isSafePath,
  MAX_UNTRACKED_FILE_BYTES,
  planHandoffSnapshot,
  type ExecFileAsyncLike,
  type HandoffPlannerDryRun,
} from './handoff-planner.js';

const execFileAsync = promisify(execFile);
const GIT_APPLY_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

export interface HandoffTransferApplyInput {
  requestId: string;
  planId?: string;
  snapshotId?: string;
  sourceRepoPath: string;
  destinationRepoPath: string;
  sourceNodeId: NodeId;
  destinationNodeId: NodeId;
  baseCommit: string;
  branchName?: string | null;
  actorId?: string;
  approvedUntrackedPaths?: readonly string[];
  requiredGrants?: readonly HandoffRequiredGrant[];
  expectedDryRun?: HandoffPlannerDryRun;
  maxUntrackedFileBytes?: number;
  exec?: ExecFileAsyncLike;
  now?: () => string;
  createId?: () => string;
}

export interface HandoffTransferAuditEvent {
  id: string;
  runId: string;
  at: string;
  phase: HandoffRunState;
  type:
    | 'handoff-run-transition'
    | 'handoff-snapshot-captured'
    | 'handoff-transfer-artifact'
    | 'handoff-apply-complete'
    | 'handoff-apply-failed';
  reasonCode: HandoffReasonCode;
  byteCount?: number;
  sha256?: string;
  refs?: string[];
  decisions?: string[];
  conflictCode?: HandoffConflict['code'];
}

export interface AppliedUntrackedFileSummary {
  path: string;
  byteCount: number;
  sha256: string;
}

export interface HandoffTransferApplySuccess {
  ok: true;
  run: HandoffRun;
  auditEvents: HandoffTransferAuditEvent[];
  trackedPatch: {
    byteCount: number;
    sha256: string;
    applied: boolean;
  };
  approvedUntrackedFiles: AppliedUntrackedFileSummary[];
}

export interface HandoffTransferApplyFailure {
  ok: false;
  run: HandoffRun;
  auditEvents: HandoffTransferAuditEvent[];
  conflicts: HandoffConflict[];
}

export type HandoffTransferApplyResult =
  | HandoffTransferApplySuccess
  | HandoffTransferApplyFailure;

interface PreparedUntrackedFile extends AppliedUntrackedFileSummary {
  sourcePath: string;
  destinationPath: string;
  data: Buffer;
}

function defaultNow(): string {
  return new Date().toISOString();
}

function hashBuffer(buffer: Buffer | string): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function makeConflict(
  code: HandoffConflict['code'],
  message: string,
  nodeId: NodeId,
  reasonCode?: HandoffReasonCode
): HandoffConflict {
  return { code, message, nodeId, ...(reasonCode ? { reasonCode } : {}) };
}

function dryRunFingerprint(dryRun: HandoffPlannerDryRun): string {
  return JSON.stringify({
    branchName: dryRun.branchName,
    baseCommit: dryRun.baseCommit,
    stagedFiles: dryRun.stagedFiles,
    unstagedFiles: dryRun.unstagedFiles,
    untrackedCandidates: dryRun.untrackedCandidates,
    excludedPaths: dryRun.excludedPaths,
    includedGroups: dryRun.includedGroups,
    excludedGroups: dryRun.excludedGroups,
    fileCount: dryRun.fileCount,
    byteCount: dryRun.byteCount,
    transferMode: dryRun.transferMode,
  });
}

async function runGit(
  run: ExecFileAsyncLike,
  cwd: string,
  args: string[],
  options: { timeout?: number; maxBuffer?: number } = {}
): Promise<string> {
  const execOptions: { cwd: string; timeout?: number; maxBuffer?: number } = {
    cwd,
    timeout: options.timeout ?? 10_000,
  };
  if (options.maxBuffer !== undefined) {
    execOptions.maxBuffer = options.maxBuffer;
  }
  const { stdout } = await run('git', args, {
    ...execOptions,
  });
  return stdout;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function safeRepoPath(repoPath: string, relativePath: string): string | null {
  if (!isSafePath(repoPath, relativePath)) return null;
  const resolved = resolve(repoPath, relativePath);
  const root = repoPath.endsWith('/') ? repoPath : `${repoPath}/`;
  if (resolved !== repoPath && !resolved.startsWith(root)) return null;
  return resolved;
}

function createRun(input: HandoffTransferApplyInput, now: string): HandoffRun {
  return {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    id: input.createId?.() ?? `handoff-run-${randomUUID()}`,
    requestId: input.requestId,
    ...(input.planId ? { planId: input.planId } : {}),
    ...(input.snapshotId ? { snapshotId: input.snapshotId } : {}),
    state: 'planned',
    sourceDisposition: 'left-running',
    conflicts: [],
    transitions: [],
    createdAt: now,
    updatedAt: now,
  };
}

function transitionRun(
  run: HandoffRun,
  to: HandoffRunState,
  reasonCode: HandoffReasonCode,
  at: string,
  actorId: string | undefined,
  auditEvents: HandoffTransferAuditEvent[],
  createId: () => string
): void {
  const from = run.state;
  const transition: HandoffRunTransition = {
    from,
    to,
    at,
    reasonCode,
    ...(actorId ? { actorId } : {}),
  };
  run.transitions.push(transition);
  run.state = to;
  run.reasonCode = reasonCode;
  run.updatedAt = at;
  if (to === 'complete' || to === 'failed' || to === 'cancelled') {
    run.completedAt = at;
  }
  auditEvents.push({
    id: createId(),
    runId: run.id,
    at,
    phase: to,
    type: 'handoff-run-transition',
    reasonCode,
  });
}

function failResult(
  run: HandoffRun,
  auditEvents: HandoffTransferAuditEvent[],
  conflicts: HandoffConflict[],
  reasonCode: HandoffReasonCode,
  now: () => string,
  actorId: string | undefined,
  createId: () => string
): HandoffTransferApplyFailure {
  run.conflicts = conflicts;
  const at = now();
  transitionRun(run, 'failed', reasonCode, at, actorId, auditEvents, createId);
  const failureEvent: HandoffTransferAuditEvent = {
    id: createId(),
    runId: run.id,
    at,
    phase: 'failed',
    type: 'handoff-apply-failed',
    reasonCode,
  };
  if (conflicts[0]?.code !== undefined) {
    failureEvent.conflictCode = conflicts[0].code;
  }
  auditEvents.push(failureEvent);
  return { ok: false, run, auditEvents, conflicts };
}

function deniedGrantConflicts(
  grants: readonly HandoffRequiredGrant[] | undefined
): HandoffConflict[] {
  return (grants ?? [])
    .filter((grant) => grant.decision !== 'allow')
    .map((grant) =>
      makeConflict(
        'MISSING_CAPABILITY_GRANT',
        `handoff grant ${grant.leg} for ${grant.capability} on ${grant.nodeId} is not allowed`,
        grant.nodeId,
        'FAILED_MISSING_GRANT'
      )
    );
}

async function prepareApprovedUntrackedFiles(input: {
  dryRun: HandoffPlannerDryRun;
  sourceRepoPath: string;
  destinationRepoPath: string;
  maxUntrackedFileBytes: number;
  sourceNodeId: NodeId;
  destinationNodeId: NodeId;
}): Promise<
  | { ok: true; files: PreparedUntrackedFile[] }
  | { ok: false; conflicts: HandoffConflict[] }
> {
  const files: PreparedUntrackedFile[] = [];
  const conflicts: HandoffConflict[] = [];
  const candidates = input.dryRun.untrackedCandidates
    .filter((candidate) => candidate.included)
    .sort((a, b) => a.path.localeCompare(b.path));

  for (const candidate of candidates) {
    const sourcePath = safeRepoPath(input.sourceRepoPath, candidate.path);
    const destinationPath = safeRepoPath(input.destinationRepoPath, candidate.path);
    if (!sourcePath || !destinationPath) {
      conflicts.push(
        makeConflict(
          'UNSAFE_PATH_MAPPING',
          `approved untracked path is unsafe: ${candidate.path}`,
          input.destinationNodeId,
          'FAILED_UNSAFE_PATH_MAPPING'
        )
      );
      continue;
    }

    const sourceStat = await stat(sourcePath).catch(() => null);
    if (!sourceStat?.isFile()) {
      conflicts.push(
        makeConflict(
          'STALE_SOURCE',
          `approved untracked file disappeared or changed kind: ${candidate.path}`,
          input.sourceNodeId,
          'FAILED_STALE_SOURCE'
        )
      );
      continue;
    }
    if (sourceStat.size > input.maxUntrackedFileBytes) {
      conflicts.push(
        makeConflict(
          'CACHE_EXCLUDED',
          `approved untracked file exceeds ${input.maxUntrackedFileBytes} byte transfer limit: ${candidate.path}`,
          input.sourceNodeId,
          'FAILED_DESTINATION_CONFLICT'
        )
      );
      continue;
    }
    if (await pathExists(destinationPath)) {
      conflicts.push(
        makeConflict(
          'UNTRACKED_COLLISION',
          `destination path already exists for approved untracked file: ${candidate.path}`,
          input.destinationNodeId,
          'FAILED_DESTINATION_CONFLICT'
        )
      );
      continue;
    }

    const data = await readFile(sourcePath);
    if (data.byteLength !== sourceStat.size) {
      conflicts.push(
        makeConflict(
          'STALE_SOURCE',
          `approved untracked file changed while snapshotting: ${candidate.path}`,
          input.sourceNodeId,
          'FAILED_STALE_SOURCE'
        )
      );
      continue;
    }
    files.push({
      path: candidate.path,
      sourcePath,
      destinationPath,
      data,
      byteCount: data.byteLength,
      sha256: hashBuffer(data),
    });
  }

  if (conflicts.length > 0) return { ok: false, conflicts };
  return { ok: true, files };
}

export async function applyHandoffTransfer(
  input: HandoffTransferApplyInput
): Promise<HandoffTransferApplyResult> {
  const now = input.now ?? defaultNow;
  const createId = input.createId ?? (() => `handoff-event-${randomUUID()}`);
  const run = createRun(input, now());
  const auditEvents: HandoffTransferAuditEvent[] = [];
  const exec = input.exec ?? (execFileAsync as ExecFileAsyncLike);
  const maxUntrackedFileBytes =
    input.maxUntrackedFileBytes ?? MAX_UNTRACKED_FILE_BYTES;

  const grantConflicts = deniedGrantConflicts(input.requiredGrants);
  if (grantConflicts.length > 0) {
    return failResult(
      run,
      auditEvents,
      grantConflicts,
      'FAILED_MISSING_GRANT',
      now,
      input.actorId,
      createId
    );
  }

  transitionRun(
    run,
    'snapshotting',
    'SNAPSHOT_CAPTURED',
    now(),
    input.actorId,
    auditEvents,
    createId
  );

  const plannerInput = {
    repoPath: input.sourceRepoPath,
    nodeId: input.sourceNodeId,
    exec,
  } satisfies Parameters<typeof planHandoffSnapshot>[0];
  const dryRun = await planHandoffSnapshot(
    input.approvedUntrackedPaths === undefined
      ? plannerInput
      : { ...plannerInput, approvedUntrackedPaths: input.approvedUntrackedPaths }
  );
  if (dryRun.conflicts.length > 0) {
    return failResult(
      run,
      auditEvents,
      dryRun.conflicts,
      dryRun.conflicts[0]?.reasonCode ?? 'FAILED_STALE_SOURCE',
      now,
      input.actorId,
      createId
    );
  }
  if (dryRun.baseCommit !== input.baseCommit) {
    return failResult(
      run,
      auditEvents,
      [
        makeConflict(
          'STALE_SOURCE',
          `source HEAD changed from planned base ${input.baseCommit} to ${dryRun.baseCommit ?? 'unknown'}`,
          input.sourceNodeId,
          'FAILED_STALE_SOURCE'
        ),
      ],
      'FAILED_STALE_SOURCE',
      now,
      input.actorId,
      createId
    );
  }
  if (input.expectedDryRun) {
    const expected = dryRunFingerprint(input.expectedDryRun);
    const actual = dryRunFingerprint(dryRun);
    if (expected !== actual) {
      return failResult(
        run,
        auditEvents,
        [
          makeConflict(
            'STALE_SOURCE',
            'source working tree changed after handoff planning',
            input.sourceNodeId,
            'FAILED_STALE_SOURCE'
          ),
        ],
        'FAILED_STALE_SOURCE',
        now,
        input.actorId,
        createId
      );
    }
  }

  const trackedPaths = [
    ...new Set(
      [...dryRun.stagedFiles, ...dryRun.unstagedFiles].map((file) => file.path)
    ),
  ].sort();
  const patch =
    trackedPaths.length > 0
      ? await runGit(
          exec,
          input.sourceRepoPath,
          ['diff', 'HEAD', '--', ...trackedPaths],
          { maxBuffer: GIT_APPLY_MAX_BUFFER_BYTES }
        )
      : '';
  const patchBuffer = Buffer.from(patch);
  const patchSha256 = hashBuffer(patchBuffer);

  const untracked = await prepareApprovedUntrackedFiles({
    dryRun,
    sourceRepoPath: input.sourceRepoPath,
    destinationRepoPath: input.destinationRepoPath,
    maxUntrackedFileBytes,
    sourceNodeId: input.sourceNodeId,
    destinationNodeId: input.destinationNodeId,
  });
  if (!untracked.ok) {
    return failResult(
      run,
      auditEvents,
      untracked.conflicts,
      untracked.conflicts[0]?.reasonCode ?? 'FAILED_DESTINATION_CONFLICT',
      now,
      input.actorId,
      createId
    );
  }

  auditEvents.push({
    id: createId(),
    runId: run.id,
    at: now(),
    phase: 'snapshotting',
    type: 'handoff-snapshot-captured',
    reasonCode: 'SNAPSHOT_CAPTURED',
    byteCount:
      patchBuffer.byteLength +
      untracked.files.reduce((sum, file) => sum + file.byteCount, 0),
    sha256: hashBuffer(
      `${patchSha256}:${untracked.files.map((file) => file.sha256).join(':')}`
    ),
    refs: [
      `git:${input.baseCommit}`,
      ...trackedPaths.map((path) => `tracked:${path}`),
      ...untracked.files.map((file) => `untracked:${file.path}`),
    ],
    decisions: [
      `transferMode:${dryRun.transferMode}`,
      `approvedUntracked:${untracked.files.length}`,
    ],
  });

  const destinationHead = (
    await runGit(exec, input.destinationRepoPath, ['rev-parse', 'HEAD'])
  ).trim();
  if (destinationHead !== input.baseCommit) {
    return failResult(
      run,
      auditEvents,
      [
        makeConflict(
          'BASE_MISMATCH',
          `destination HEAD ${destinationHead} does not match planned base ${input.baseCommit}`,
          input.destinationNodeId,
          'FAILED_BASE_MISMATCH'
        ),
      ],
      'FAILED_BASE_MISMATCH',
      now,
      input.actorId,
      createId
    );
  }

  const destinationStatus = await runGit(exec, input.destinationRepoPath, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ]);
  if (destinationStatus.length > 0) {
    return failResult(
      run,
      auditEvents,
      [
        makeConflict(
          'DESTINATION_DIRTY',
          'destination worktree must be clean before applying a handoff snapshot',
          input.destinationNodeId,
          'FAILED_DESTINATION_CONFLICT'
        ),
      ],
      'FAILED_DESTINATION_CONFLICT',
      now,
      input.actorId,
      createId
    );
  }

  transitionRun(
    run,
    'transferring',
    'TRANSFER_STARTED',
    now(),
    input.actorId,
    auditEvents,
    createId
  );

  let patchPath: string | null = null;
  let tempDir: string | null = null;
  try {
    if (patchBuffer.byteLength > 0) {
      tempDir = await mkdtemp(join(tmpdir(), 'relay-handoff-transfer-'));
      patchPath = join(tempDir, 'tracked.patch');
      await writeFile(patchPath, patchBuffer);
      await runGit(exec, input.destinationRepoPath, [
        'apply',
        '--check',
        patchPath,
      ]);
      auditEvents.push({
        id: createId(),
        runId: run.id,
        at: now(),
        phase: 'transferring',
        type: 'handoff-transfer-artifact',
        reasonCode: 'TRANSFER_COMPLETED',
        byteCount: patchBuffer.byteLength,
        sha256: patchSha256,
        refs: ['tracked-patch'],
      });
    }
  } catch (error) {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
    return failResult(
      run,
      auditEvents,
      [
        makeConflict(
          'DESTINATION_CONFLICT',
          `tracked patch does not apply cleanly: ${error instanceof Error ? error.message : String(error)}`,
          input.destinationNodeId,
          'FAILED_DESTINATION_CONFLICT'
        ),
      ],
      'FAILED_DESTINATION_CONFLICT',
      now,
      input.actorId,
      createId
    );
  }

  transitionRun(
    run,
    'applying',
    'APPLY_STARTED',
    now(),
    input.actorId,
    auditEvents,
    createId
  );

  try {
    if (patchPath) {
      await runGit(exec, input.destinationRepoPath, ['apply', patchPath]);
    }
    for (const file of untracked.files) {
      await mkdir(dirname(file.destinationPath), { recursive: true });
      await writeFile(file.destinationPath, file.data, { flag: 'wx' });
      auditEvents.push({
        id: createId(),
        runId: run.id,
        at: now(),
        phase: 'applying',
        type: 'handoff-transfer-artifact',
        reasonCode: 'APPLY_COMPLETED',
        byteCount: file.byteCount,
        sha256: file.sha256,
        refs: [`untracked:${file.path}`],
      });
    }
  } catch (error) {
    return failResult(
      run,
      auditEvents,
      [
        makeConflict(
          'DESTINATION_CONFLICT',
          `failed while applying handoff snapshot: ${error instanceof Error ? error.message : String(error)}`,
          input.destinationNodeId,
          'FAILED_DESTINATION_CONFLICT'
        ),
      ],
      'FAILED_DESTINATION_CONFLICT',
      now,
      input.actorId,
      createId
    );
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  const completedAt = now();
  transitionRun(
    run,
    'complete',
    'APPLY_COMPLETED',
    completedAt,
    input.actorId,
    auditEvents,
    createId
  );
  auditEvents.push({
    id: createId(),
    runId: run.id,
    at: completedAt,
    phase: 'complete',
    type: 'handoff-apply-complete',
    reasonCode: 'APPLY_COMPLETED',
    byteCount:
      patchBuffer.byteLength +
      untracked.files.reduce((sum, file) => sum + file.byteCount, 0),
    sha256: hashBuffer(
      `${patchSha256}:${untracked.files.map((file) => file.sha256).join(':')}`
    ),
  });

  return {
    ok: true,
    run,
    auditEvents,
    trackedPatch: {
      byteCount: patchBuffer.byteLength,
      sha256: patchSha256,
      applied: patchBuffer.byteLength > 0,
    },
    approvedUntrackedFiles: untracked.files.map(
      ({ path, byteCount, sha256 }) => ({ path, byteCount, sha256 })
    ),
  };
}
