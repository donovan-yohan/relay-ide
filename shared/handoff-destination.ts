import type { EnvironmentOption } from './environment-option.js';
import type {
  HandoffConflict,
  HandoffDestinationProposal,
  HandoffPathKind,
  HandoffPathMapping,
  HandoffSourceRef,
} from './handoff.js';
import type { NodeId } from './identity.js';
import type {
  RepoInventoryDirtySummary,
  RepoInventoryRepoInstance,
} from './repo-inventory.js';
import type { RelayCapabilityBit } from './security-policy.js';

export type HandoffDestinationAction =
  | 'reuse-worktree'
  | 'create-worktree'
  | 'use-cwd';

export interface HandoffDestinationProposalInput {
  source: HandoffSourceRef;
  destination: EnvironmentOption;
  sourceBranchName?: string;
  destinationWorktreeSlug?: string;
}

export interface HandoffMirrorRoot {
  sourceNodeId: NodeId;
  destinationNodeId: NodeId;
  sourceRoot: string;
  destinationRoot: string;
  label?: string;
}

export interface HandoffPathMappingInput {
  sourceNodeId: NodeId;
  destinationNodeId: NodeId;
  sourcePaths: string[];
  mirrorRoots: HandoffMirrorRoot[];
  allowedDestinationRoots: string[];
  kind?: HandoffPathKind;
  mode?: HandoffPathMapping['destination']['mode'];
}

export interface HandoffPathMappingResult {
  mappings: HandoffPathMapping[];
  conflicts: HandoffConflict[];
}

export interface HandoffDestinationConflictInput {
  source: HandoffSourceRef;
  destination: EnvironmentOption;
  sourceBranchName?: string;
  sourceBaseCommit?: string;
  destinationInventory?: RepoInventoryRepoInstance | null;
  requiredCapabilities?: RelayCapabilityBit[];
  allowedDestinationRoots?: string[];
  sourcePaths?: string[];
  mirrorRoots?: HandoffMirrorRoot[];
}

const BROAD_EXACT_ROOTS = new Set([
  '/',
  '/home',
  '/Users',
  '/root',
  '/etc',
  '/usr',
  '/var',
  '/opt',
  '/tmp',
]);

function isNonEmptyAbsolutePath(path: string): boolean {
  return path.startsWith('/') && path.trim().length > 1;
}

function normalizeAbsolutePath(path: string): string | null {
  if (!path.startsWith('/')) return null;
  const segments: string[] = [];
  for (const rawSegment of path.split('/')) {
    if (!rawSegment || rawSegment === '.') continue;
    if (rawSegment === '..') return null;
    segments.push(rawSegment);
  }
  return `/${segments.join('/')}`;
}

function isPathInside(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function pathDepth(path: string): number {
  if (path === '/') return 0;
  return path.split('/').filter(Boolean).length;
}

function isBroadMirrorRoot(path: string): boolean {
  if (BROAD_EXACT_ROOTS.has(path)) return true;
  if (path.startsWith('/Users/') && pathDepth(path) <= 2) return true;
  if (path.startsWith('/home/') && pathDepth(path) <= 2) return true;
  return false;
}

function relativePathInsideRoot(path: string, root: string): string | null {
  if (!isPathInside(path, root)) return null;
  if (path === root) return '';
  return path.slice(root.length + 1);
}

function joinRootAndRelative(root: string, relativePath: string): string {
  if (!relativePath) return root;
  return `${root}/${relativePath}`;
}

function safeSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'handoff';
}

function conflict(
  code: HandoffConflict['code'],
  message: string,
  nodeId: NodeId,
  extras: Partial<HandoffConflict> = {}
): HandoffConflict {
  return { code, message, nodeId, ...extras };
}

function sortConflicts(conflicts: HandoffConflict[]): HandoffConflict[] {
  return [...conflicts].sort((a, b) => {
    const code = a.code.localeCompare(b.code);
    if (code !== 0) return code;
    const node = (a.nodeId ?? '').localeCompare(b.nodeId ?? '');
    if (node !== 0) return node;
    return a.message.localeCompare(b.message);
  });
}

export function validateHandoffDestinationRoot(input: {
  path: string;
  allowedDestinationRoots: string[];
}): { ok: true; path: string } | { ok: false; reason: string } {
  const normalized = normalizeAbsolutePath(input.path);
  if (!normalized || !isNonEmptyAbsolutePath(normalized)) {
    return { ok: false, reason: 'destination path must be absolute' };
  }
  if (normalized !== input.path.replace(/\/+$/u, '') && input.path !== '/') {
    return {
      ok: false,
      reason: 'destination path must not contain traversal or dot segments',
    };
  }
  if (isBroadMirrorRoot(normalized)) {
    return {
      ok: false,
      reason: `${normalized} is too broad for handoff mirroring`,
    };
  }
  if (input.allowedDestinationRoots.length === 0) {
    return { ok: true, path: normalized };
  }
  const allowedRoots = input.allowedDestinationRoots
    .map(normalizeAbsolutePath)
    .filter((root): root is string => root !== null);
  const insideAllowedRoot = allowedRoots.some((root) =>
    isPathInside(normalized, root)
  );
  if (!insideAllowedRoot) {
    return {
      ok: false,
      reason: `${normalized} escapes configured hub destination roots`,
    };
  }
  return { ok: true, path: normalized };
}

export function validateHandoffMirrorRoot(input: {
  mirrorRoot: HandoffMirrorRoot;
  allowedDestinationRoots: string[];
}):
  | { ok: true; mirrorRoot: HandoffMirrorRoot }
  | { ok: false; reason: string } {
  const sourceRoot = normalizeAbsolutePath(input.mirrorRoot.sourceRoot);
  const destinationRoot = normalizeAbsolutePath(
    input.mirrorRoot.destinationRoot
  );
  if (!sourceRoot || !destinationRoot) {
    return { ok: false, reason: 'mirror roots must be absolute paths' };
  }
  if (isBroadMirrorRoot(sourceRoot)) {
    return {
      ok: false,
      reason: `${sourceRoot} is too broad to infer a source mirror`,
    };
  }
  const destination = validateHandoffDestinationRoot({
    path: destinationRoot,
    allowedDestinationRoots: input.allowedDestinationRoots,
  });
  if (!destination.ok) return destination;
  return {
    ok: true,
    mirrorRoot: {
      ...input.mirrorRoot,
      sourceRoot,
      destinationRoot: destination.path,
    },
  };
}

export function proposeHandoffDestination(
  input: HandoffDestinationProposalInput
): HandoffDestinationProposal {
  const { source, destination, sourceBranchName } = input;
  const nodeId = destination.node.nodeId;
  const sourceMetadata = {
    sourceCwd: source.cwd,
    sourceNodeId: source.nodeId,
  };

  if (destination.bench && destination.repoInstance) {
    const branchName =
      destination.bench.branchName ??
      destination.repoInstance.currentBranch ??
      undefined;
    return {
      nodeId,
      cwd: destination.bench.localPath,
      repoInstanceId: destination.repoInstance.repoInstanceId,
      worktreeInstanceId: destination.bench.worktreeInstanceId,
      ...(branchName ? { branchName } : {}),
      action: 'reuse-worktree',
      summary: `reuse destination worktree ${destination.bench.worktreeInstanceId} on ${nodeId}; source cwd kept as metadata only`,
      ...sourceMetadata,
    };
  }

  if (destination.repoInstance) {
    const branchSlug = safeSlug(
      input.destinationWorktreeSlug ?? sourceBranchName ?? source.workContextId
    );
    return {
      nodeId,
      cwd: `${destination.repoInstance.localPath}/.worktrees/${branchSlug}`,
      repoInstanceId: destination.repoInstance.repoInstanceId,
      ...((sourceBranchName ?? destination.repoInstance.currentBranch)
        ? {
            branchName:
              sourceBranchName ?? destination.repoInstance.currentBranch ?? '',
          }
        : {}),
      action: 'create-worktree',
      summary: `create destination worktree for repo instance ${destination.repoInstance.repoInstanceId} on ${nodeId}; source cwd kept as metadata only`,
      ...sourceMetadata,
    };
  }

  return {
    nodeId,
    cwd: destination.cwd,
    action: 'use-cwd',
    summary: `use configured destination cwd on ${nodeId}; source cwd kept as metadata only`,
    ...sourceMetadata,
  };
}

function findMirrorRootForPath(
  sourcePath: string,
  mirrorRoots: HandoffMirrorRoot[]
): HandoffMirrorRoot | null {
  const normalizedSource = normalizeAbsolutePath(sourcePath);
  if (!normalizedSource) return null;
  return (
    [...mirrorRoots]
      .map((mirrorRoot) => ({
        mirrorRoot,
        normalizedSourceRoot: normalizeAbsolutePath(mirrorRoot.sourceRoot),
      }))
      .filter(
        (
          item
        ): item is {
          mirrorRoot: HandoffMirrorRoot;
          normalizedSourceRoot: string;
        } =>
          item.normalizedSourceRoot !== null &&
          isPathInside(normalizedSource, item.normalizedSourceRoot)
      )
      .sort(
        (a, b) =>
          pathDepth(b.normalizedSourceRoot) - pathDepth(a.normalizedSourceRoot)
      )[0]?.mirrorRoot ?? null
  );
}

export function resolveHandoffPathMappings(
  input: HandoffPathMappingInput
): HandoffPathMappingResult {
  const kind = input.kind ?? 'file';
  const mode = input.mode ?? 'create';
  const conflicts: HandoffConflict[] = [];
  const mappings: HandoffPathMapping[] = [];
  const normalizedRoots = new Map<HandoffMirrorRoot, HandoffMirrorRoot>();

  for (const mirrorRoot of input.mirrorRoots) {
    const validation = validateHandoffMirrorRoot({
      mirrorRoot,
      allowedDestinationRoots: input.allowedDestinationRoots,
    });
    if (validation.ok) {
      normalizedRoots.set(mirrorRoot, validation.mirrorRoot);
    } else {
      conflicts.push(
        conflict(
          'UNSAFE_PATH_MAPPING',
          `unsafe path mapping ${mirrorRoot.sourceRoot} -> ${mirrorRoot.destinationRoot}: ${validation.reason}`,
          mirrorRoot.destinationNodeId,
          { reasonCode: 'FAILED_UNSAFE_PATH_MAPPING' }
        )
      );
    }
  }

  for (const sourcePath of [...input.sourcePaths].sort()) {
    const normalizedSource = normalizeAbsolutePath(sourcePath);
    if (!normalizedSource) {
      conflicts.push(
        conflict(
          'UNSAFE_PATH_MAPPING',
          `source path ${sourcePath} is not a safe absolute path`,
          input.destinationNodeId,
          { reasonCode: 'FAILED_UNSAFE_PATH_MAPPING' }
        )
      );
      continue;
    }
    const rawMirrorRoot = findMirrorRootForPath(
      normalizedSource,
      input.mirrorRoots
    );
    const mirrorRoot = rawMirrorRoot
      ? normalizedRoots.get(rawMirrorRoot)
      : null;
    if (!mirrorRoot) {
      conflicts.push(
        conflict(
          'MISSING_PATH_MAPPING',
          `no configured path mapping for source path ${normalizedSource}`,
          input.destinationNodeId,
          { reasonCode: 'FAILED_MISSING_PATH_MAPPING' }
        )
      );
      continue;
    }
    const relative = relativePathInsideRoot(
      normalizedSource,
      mirrorRoot.sourceRoot
    );
    if (relative === null) {
      conflicts.push(
        conflict(
          'MISSING_PATH_MAPPING',
          `no configured path mapping for source path ${normalizedSource}`,
          input.destinationNodeId,
          { reasonCode: 'FAILED_MISSING_PATH_MAPPING' }
        )
      );
      continue;
    }
    const destinationPath = joinRootAndRelative(
      mirrorRoot.destinationRoot,
      relative
    );
    const validation = validateHandoffDestinationRoot({
      path: destinationPath,
      allowedDestinationRoots: input.allowedDestinationRoots,
    });
    if (!validation.ok) {
      conflicts.push(
        conflict(
          'UNSAFE_PATH_MAPPING',
          `mapped destination ${destinationPath} for ${normalizedSource}: ${validation.reason}`,
          input.destinationNodeId,
          { reasonCode: 'FAILED_UNSAFE_PATH_MAPPING' }
        )
      );
      continue;
    }
    mappings.push({
      kind,
      source: {
        nodeId: input.sourceNodeId,
        path: normalizedSource,
      },
      destination: {
        nodeId: input.destinationNodeId,
        path: validation.path,
        mode,
      },
    });
  }

  return {
    mappings,
    conflicts: sortConflicts(conflicts),
  };
}

function dirtySummaryForDestination(
  destination: EnvironmentOption,
  inventory: RepoInventoryRepoInstance
): RepoInventoryDirtySummary | null | undefined {
  if (!destination.bench) return inventory.dirty;
  return inventory.worktrees.find(
    (worktree) =>
      worktree.worktreeInstanceId === destination.bench?.worktreeInstanceId
  )?.dirty;
}

function branchForDestination(
  destination: EnvironmentOption,
  inventory: RepoInventoryRepoInstance
): string | null | undefined {
  if (!destination.bench) return inventory.currentBranch;
  return inventory.worktrees.find(
    (worktree) =>
      worktree.worktreeInstanceId === destination.bench?.worktreeInstanceId
  )?.branchName;
}

function headShaForDestination(
  destination: EnvironmentOption,
  inventory: RepoInventoryRepoInstance
): string | null | undefined {
  if (!destination.bench) return inventory.divergence?.headSha;
  return inventory.worktrees.find(
    (worktree) =>
      worktree.worktreeInstanceId === destination.bench?.worktreeInstanceId
  )?.divergence?.headSha;
}

function detectUntrackedCollisions(input: {
  dirty: RepoInventoryDirtySummary;
  destination: EnvironmentOption;
  mappings: HandoffPathMapping[];
  nodeId: NodeId;
}): HandoffConflict[] {
  const untrackedFiles = input.dirty.files.filter(
    (file) => file.status === 'untracked'
  );
  if (untrackedFiles.length === 0 && input.dirty.untrackedCount === 0)
    return [];
  const mappedDestinations = new Set(
    input.mappings.map((mapping) => mapping.destination.path)
  );
  const cwd =
    normalizeAbsolutePath(input.destination.cwd) ?? input.destination.cwd;
  const collisions = untrackedFiles.filter((file) => {
    const path = file.path.startsWith('/') ? file.path : `${cwd}/${file.path}`;
    return mappedDestinations.size === 0 || mappedDestinations.has(path);
  });
  if (collisions.length > 0) {
    return collisions.map((file) =>
      conflict(
        'UNTRACKED_COLLISION',
        `destination untracked path may be overwritten: ${file.path}`,
        input.nodeId,
        { reasonCode: 'FAILED_DESTINATION_CONFLICT' }
      )
    );
  }
  return [
    conflict(
      'UNTRACKED_COLLISION',
      `destination has ${input.dirty.untrackedCount} untracked path(s) that require explicit handling`,
      input.nodeId,
      { reasonCode: 'FAILED_DESTINATION_CONFLICT' }
    ),
  ];
}

export function detectHandoffDestinationConflicts(
  input: HandoffDestinationConflictInput
): HandoffConflict[] {
  const destinationNodeId = input.destination.node.nodeId;
  const conflicts: HandoffConflict[] = [];
  const requiredCapabilities = new Set(input.requiredCapabilities ?? []);
  const mappingResult =
    input.sourcePaths && input.sourcePaths.length > 0
      ? resolveHandoffPathMappings({
          sourceNodeId: input.source.nodeId,
          destinationNodeId,
          sourcePaths: input.sourcePaths,
          mirrorRoots: input.mirrorRoots ?? [],
          allowedDestinationRoots: input.allowedDestinationRoots ?? [],
        })
      : { mappings: [], conflicts: [] };

  conflicts.push(...mappingResult.conflicts);

  if (
    input.destination.node.online === false ||
    input.destination.freshness === 'offline'
  ) {
    conflicts.push(
      conflict(
        'DESTINATION_UNAVAILABLE',
        `destination node ${destinationNodeId} is offline`,
        destinationNodeId,
        { reasonCode: 'FAILED_DESTINATION_UNAVAILABLE' }
      )
    );
  } else if (input.destination.freshness === 'stale') {
    conflicts.push(
      conflict(
        'DESTINATION_UNAVAILABLE',
        `destination node ${destinationNodeId} has stale inventory`,
        destinationNodeId,
        { reasonCode: 'FAILED_DESTINATION_UNAVAILABLE' }
      )
    );
  }

  for (const reason of input.destination.degradedReasons ?? []) {
    if (reason.kind === 'capability-missing') {
      requiredCapabilities.add(reason.capability);
    }
    if (reason.kind === 'repo-missing' || reason.kind === 'worktree-missing') {
      conflicts.push(
        conflict(
          'DESTINATION_CONFLICT',
          reason.message ??
            (reason.kind === 'repo-missing'
              ? 'destination repository is missing'
              : `destination worktree ${reason.localPath} is missing`),
          destinationNodeId,
          { reasonCode: 'FAILED_DESTINATION_CONFLICT' }
        )
      );
    }
  }

  for (const capability of [...requiredCapabilities].sort()) {
    if (!input.destination.capabilities.includes(capability)) {
      conflicts.push(
        conflict(
          'MISSING_CAPABILITY_GRANT',
          `destination node ${destinationNodeId} does not advertise ${capability}`,
          destinationNodeId,
          { reasonCode: 'FAILED_MISSING_GRANT' }
        )
      );
    }
  }

  const destinationRootCheck = validateHandoffDestinationRoot({
    path: input.destination.cwd,
    allowedDestinationRoots: input.allowedDestinationRoots ?? [],
  });
  if (!destinationRootCheck.ok) {
    conflicts.push(
      conflict(
        'UNSAFE_PATH_MAPPING',
        `destination cwd ${input.destination.cwd}: ${destinationRootCheck.reason}`,
        destinationNodeId,
        { reasonCode: 'FAILED_UNSAFE_PATH_MAPPING' }
      )
    );
  }

  const inventory = input.destinationInventory;
  if (inventory) {
    const destinationBranch = branchForDestination(
      input.destination,
      inventory
    );
    const destinationHeadSha = headShaForDestination(
      input.destination,
      inventory
    );
    const dirty = dirtySummaryForDestination(input.destination, inventory);

    if (
      input.sourceBaseCommit &&
      destinationHeadSha &&
      input.sourceBaseCommit !== destinationHeadSha
    ) {
      conflicts.push(
        conflict(
          'BASE_MISMATCH',
          `source base ${input.sourceBaseCommit} does not match destination head ${destinationHeadSha}`,
          destinationNodeId,
          { reasonCode: 'FAILED_BASE_MISMATCH' }
        )
      );
    }

    if (
      input.sourceBranchName &&
      destinationBranch &&
      input.sourceBranchName !== destinationBranch
    ) {
      conflicts.push(
        conflict(
          'BASE_MISMATCH',
          `source branch ${input.sourceBranchName} does not match destination branch ${destinationBranch}`,
          destinationNodeId,
          { reasonCode: 'FAILED_BASE_MISMATCH' }
        )
      );
    }

    if (dirty) {
      const changedCount =
        dirty.stagedCount + dirty.unstagedCount + dirty.conflictedCount;
      if (changedCount > 0) {
        conflicts.push(
          conflict(
            'DESTINATION_DIRTY',
            `destination has ${changedCount} tracked/conflicted change(s)`,
            destinationNodeId,
            { reasonCode: 'FAILED_DESTINATION_CONFLICT' }
          )
        );
      }
      conflicts.push(
        ...detectUntrackedCollisions({
          dirty,
          destination: input.destination,
          mappings: mappingResult.mappings,
          nodeId: destinationNodeId,
        })
      );
    }
  }

  return sortConflicts(conflicts);
}
