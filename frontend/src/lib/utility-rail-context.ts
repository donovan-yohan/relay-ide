import { DEFAULT_LOCAL_NODE_ID } from '../../../shared/identity.js';
import type { Repo, SessionSummary } from './types.js';

export type UtilityRailDisabledReason =
  | 'remote-files-unavailable'
  | 'remote-git-unavailable'
  | 'no-git-context'
  | 'no-workspace-context';

export interface UtilityRailResourcePath {
  workspacePath: string;
  disabledReason: UtilityRailDisabledReason | null;
}

export interface UtilityRailResourceContext {
  displayWorkspacePath: string;
  anchorLabel: string;
  repoBadge: string | null;
  files: UtilityRailResourcePath;
  git: UtilityRailResourcePath;
}

export interface DerivedUtilityRailContext extends UtilityRailResourceContext {
  stateKey: string;
}

export interface DeriveUtilityRailContextOptions {
  activeRepoPath?: string | null | undefined;
  activeWorkspace?: Repo | undefined;
  activeSession?: SessionSummary | undefined;
}

function isRemoteNode(nodeId: string | undefined): boolean {
  return Boolean(nodeId && nodeId !== DEFAULT_LOCAL_NODE_ID);
}

function remoteStateKey(nodeId: string, workspacePath: string): string {
  return `node:${nodeId}:${workspacePath}`;
}

function deriveActivePath({
  activeRepoPath,
  activeWorkspace,
  activeSession,
}: DeriveUtilityRailContextOptions): string {
  return (
    activeSession?.worktreePath ??
    activeSession?.repoPath ??
    activeSession?.cwd ??
    activeWorkspace?.path ??
    activeRepoPath ??
    ''
  );
}

function hasRepoBoundSession(activeSession: SessionSummary | undefined): boolean {
  return Boolean(activeSession?.worktreePath || activeSession?.repoPath);
}

function hasGitContext(
  activeSession: SessionSummary | undefined,
  activeWorkspace: Repo | undefined
): boolean {
  if (activeSession) {
    if (!hasRepoBoundSession(activeSession)) return false;
    return activeWorkspace?.isGitRepo !== false;
  }
  return Boolean(activeWorkspace?.isGitRepo);
}

function formatAnchorLabel(nodeLabel: string, workspacePath: string): string {
  return workspacePath ? `${nodeLabel} · ${workspacePath}` : nodeLabel;
}

export function deriveUtilityRailContext(
  options: DeriveUtilityRailContextOptions
): DerivedUtilityRailContext {
  const { activeSession, activeWorkspace } = options;
  const displayWorkspacePath = deriveActivePath(options);
  const nodeId = activeSession?.nodeId ?? activeWorkspace?.nodeId;
  const remote = isRemoteNode(nodeId);
  const nodeLabel = remote ? (nodeId as string) : 'local';
  const stateKey = remote
    ? remoteStateKey(nodeId as string, displayWorkspacePath)
    : displayWorkspacePath;

  if (!displayWorkspacePath) {
    return {
      stateKey,
      displayWorkspacePath,
      anchorLabel: formatAnchorLabel(nodeLabel, displayWorkspacePath),
      repoBadge: null,
      files: { workspacePath: '', disabledReason: 'no-workspace-context' },
      git: { workspacePath: '', disabledReason: 'no-workspace-context' },
    };
  }

  if (remote) {
    return {
      stateKey,
      displayWorkspacePath,
      anchorLabel: formatAnchorLabel(nodeLabel, displayWorkspacePath),
      repoBadge: null,
      files: { workspacePath: '', disabledReason: 'remote-files-unavailable' },
      git: { workspacePath: '', disabledReason: 'remote-git-unavailable' },
    };
  }

  const gitWorkspacePath = hasGitContext(activeSession, activeWorkspace)
    ? displayWorkspacePath
    : '';

  return {
    stateKey,
    displayWorkspacePath,
    anchorLabel: formatAnchorLabel(nodeLabel, displayWorkspacePath),
    repoBadge: gitWorkspacePath ? 'repo' : null,
    files: { workspacePath: displayWorkspacePath, disabledReason: null },
    git: {
      workspacePath: gitWorkspacePath,
      disabledReason: gitWorkspacePath ? null : 'no-git-context',
    },
  };
}
