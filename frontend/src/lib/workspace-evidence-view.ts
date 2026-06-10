import type {
  WorkspaceEvidencePreview,
  WorkspaceEvidenceRoot,
} from '../../../shared/workspace-evidence.js';

export type EvidenceSectionState =
  | 'no-workspace'
  | 'no-root'
  | 'offline'
  | 'permission-denied'
  | 'missing-root'
  | 'unsupported'
  | 'ready';

export interface EvidenceSectionStateContext {
  hasWorkspaceSelected: boolean;
  backendConnected: boolean;
}

export interface ResolveWorkspaceEvidenceRootOptions {
  repoPath: string;
  workspaceId?: string | undefined;
}

const BACKING_SPECIFICITY: Record<WorkspaceEvidenceRoot['backing'], number> = {
  worktree: 3,
  repo: 2,
  directory: 1,
  'artifact-only': 0,
};

function matchesRepoPath(root: WorkspaceEvidenceRoot, repoPath: string): boolean {
  if (!repoPath) return false;
  if (root.path === repoPath) return true;
  if (root.repo?.repoPath === repoPath) return true;
  if (root.worktree?.worktreePath === repoPath) return true;
  return false;
}

function matchesWorkspaceId(
  root: WorkspaceEvidenceRoot,
  workspaceId: string | undefined
): boolean {
  if (!workspaceId) return false;
  return root.ref.workspaceId === workspaceId;
}

export function resolveWorkspaceEvidenceRoot(
  roots: WorkspaceEvidenceRoot[],
  opts: ResolveWorkspaceEvidenceRootOptions
): WorkspaceEvidenceRoot | null {
  const { repoPath, workspaceId } = opts;
  const candidates = roots.filter(
    (root) =>
      matchesRepoPath(root, repoPath) || matchesWorkspaceId(root, workspaceId)
  );
  if (candidates.length === 0) return null;

  let best: WorkspaceEvidenceRoot | null = null;
  let bestScore = -1;
  for (const root of candidates) {
    // path matches are more specific than workspace-id-only matches
    const pathScore = matchesRepoPath(root, repoPath) ? 100 : 0;
    const score = pathScore + BACKING_SPECIFICITY[root.backing];
    if (score > bestScore) {
      best = root;
      bestScore = score;
    }
  }
  return best;
}

export function workspaceEvidenceSectionState(
  root: WorkspaceEvidenceRoot | null,
  ctx: EvidenceSectionStateContext
): EvidenceSectionState {
  if (!ctx.hasWorkspaceSelected) return 'no-workspace';
  if (!ctx.backendConnected) return 'offline';
  if (!root) return 'no-root';
  // A deleted root path surfaces as status='unavailable' with a NOT_FOUND
  // reason. Check the reason before mapping 'unavailable' → 'offline' so the
  // missing-root case is not mistaken for an offline node.
  if (
    root.unavailableReason === 'WORKSPACE_EVIDENCE_ROOT_NOT_FOUND' ||
    root.capabilities.reason === 'WORKSPACE_EVIDENCE_ROOT_NOT_FOUND'
  ) {
    return 'missing-root';
  }
  if (root.status === 'offline' || root.status === 'unavailable') return 'offline';
  if (root.status === 'permission-denied') return 'permission-denied';
  if (root.status === 'unsupported' || !root.capabilities.list) {
    return 'unsupported';
  }
  if (root.status === 'available') return 'ready';
  return 'unsupported';
}

export type PreviewRenderMode =
  | 'text'
  | 'markdown'
  | 'json'
  | 'log'
  | 'diff'
  | 'image'
  | 'oversized'
  | 'unsupported'
  | 'binary'
  | 'error';

export interface PreviewRenderKind {
  mode: PreviewRenderMode;
  language?: string;
}

export function mapPreviewToRenderKind(
  preview: WorkspaceEvidencePreview
): PreviewRenderKind {
  if (preview.state === 'oversized') return { mode: 'oversized' };
  if (preview.state === 'binary') return { mode: 'binary' };
  if (preview.state === 'not-found') return { mode: 'error' };
  if (
    preview.state === 'unavailable' ||
    preview.state === 'permission-denied' ||
    preview.state === 'offline'
  ) {
    return { mode: 'error' };
  }
  if (preview.state === 'unsupported') return { mode: 'unsupported' };

  if (preview.sandboxRequired) return { mode: 'unsupported' };

  switch (preview.kind) {
    case 'markdown':
      return { mode: 'markdown', language: 'markdown' };
    case 'json':
      return { mode: 'json', language: 'json' };
    case 'diff':
      return { mode: 'diff' };
    case 'log':
      return { mode: 'log', language: 'log' };
    case 'html-source':
      return { mode: 'unsupported' };
    case 'binary':
      if (preview.encoding === 'base64') return { mode: 'image' };
      return { mode: 'binary' };
    case 'unsupported':
      return { mode: 'unsupported' };
    case 'text':
    default:
      return { mode: 'text', language: 'text' };
  }
}
