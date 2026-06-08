import type { BenchId } from './bench.js';
import type { NodeId, RepoInstanceId, WorktreeInstanceId } from './identity.js';
import type { ProjectId } from './project.js';
import type { WorkspaceId } from './workspace.js';

export const WORKSPACE_EVIDENCE_MAX_LIST_ENTRIES = 500;
export const WORKSPACE_EVIDENCE_DEFAULT_LIST_ENTRIES = 100;
export const WORKSPACE_EVIDENCE_MAX_PREVIEW_BYTES = 64 * 1024;
export const WORKSPACE_EVIDENCE_DEFAULT_PREVIEW_BYTES = 32 * 1024;
export const WORKSPACE_EVIDENCE_HASH_BYTE_LIMIT = 1024 * 1024;
export const WORKSPACE_EVIDENCE_LIST_HASH_TOTAL_BYTE_LIMIT = 4 * 1024 * 1024;

export type WorkspaceEvidenceRootKind = 'workspace' | 'project' | 'bench' | 'repo' | 'worktree' | 'directory';
export type WorkspaceEvidenceBackingKind = 'directory' | 'repo' | 'worktree' | 'artifact-only';

export type WorkspaceEvidenceAvailabilityState =
  | 'available'
  | 'unavailable'
  | 'offline'
  | 'permission-denied'
  | 'unsupported';

export type WorkspaceEvidenceUnavailableReason =
  | 'WORKSPACE_EVIDENCE_ROOT_NOT_FOUND'
  | 'WORKSPACE_EVIDENCE_UNAVAILABLE'
  | 'WORKSPACE_EVIDENCE_ROOT_UNAVAILABLE'
  | 'WORKSPACE_EVIDENCE_NODE_OFFLINE'
  | 'WORKSPACE_EVIDENCE_PERMISSION_DENIED'
  | 'WORKSPACE_EVIDENCE_UNSUPPORTED'
  | 'WORKSPACE_EVIDENCE_INVALID_REQUEST'
  | 'WORKSPACE_EVIDENCE_ROOT_ESCAPE'
  | 'WORKSPACE_EVIDENCE_NOT_FOUND'
  | 'WORKSPACE_EVIDENCE_NOT_DIRECTORY'
  | 'WORKSPACE_EVIDENCE_NOT_FILE'
  | 'WORKSPACE_EVIDENCE_OVERSIZED'
  | 'WORKSPACE_EVIDENCE_BINARY_UNSUPPORTED';

export type WorkspaceEvidenceEntryType = 'file' | 'directory' | 'symlink' | 'other';

export type WorkspaceEvidencePreviewKind =
  | 'text'
  | 'markdown'
  | 'json'
  | 'log'
  | 'diff'
  | 'html-source'
  | 'binary'
  | 'unsupported';

export type WorkspaceEvidencePreviewState =
  | 'available'
  | 'oversized'
  | 'unsupported'
  | 'binary'
  | 'unavailable'
  | 'permission-denied'
  | 'offline'
  | 'not-found';

export interface WorkspaceEvidenceCapabilityFlags {
  list: boolean;
  stat: boolean;
  read: boolean;
  preview: boolean;
  write: false;
  reason?: WorkspaceEvidenceUnavailableReason;
}

export interface WorkspaceEvidenceRootRef {
  id: string;
  nodeId: NodeId;
  kind: WorkspaceEvidenceRootKind;
  workspaceId?: WorkspaceId;
  projectId?: ProjectId;
  benchId?: BenchId;
  repoInstanceId?: RepoInstanceId;
  worktreeInstanceId?: WorktreeInstanceId;
}

export interface WorkspaceEvidenceRoot {
  ref: WorkspaceEvidenceRootRef;
  name: string;
  path: string | null;
  nodeId: NodeId;
  kind: WorkspaceEvidenceRootKind;
  backing: WorkspaceEvidenceBackingKind;
  status: WorkspaceEvidenceAvailabilityState;
  capabilities: WorkspaceEvidenceCapabilityFlags;
  repo?: {
    repoPath: string;
    repoInstanceId?: RepoInstanceId;
    isGitRepo: boolean;
    currentBranch?: string | null;
    defaultBranch?: string | null;
  };
  worktree?: {
    worktreePath: string;
    worktreeInstanceId?: WorktreeInstanceId;
  };
  unavailableReason?: WorkspaceEvidenceUnavailableReason;
  message?: string;
}

export interface WorkspaceEvidenceErrorState {
  state: Exclude<WorkspaceEvidenceAvailabilityState, 'available'> | 'not-found';
  reason: WorkspaceEvidenceUnavailableReason;
  message: string;
  rootRef?: WorkspaceEvidenceRootRef;
  nodeId?: NodeId;
}

export interface WorkspaceEvidenceEntry {
  ref: {
    rootRef: WorkspaceEvidenceRootRef;
    path: string;
  };
  path: string;
  name: string;
  type: WorkspaceEvidenceEntryType;
  size: number;
  mtimeMs: number;
  mode: number;
  contentHash?: string;
}

export interface WorkspaceEvidenceListRequest {
  rootRef: WorkspaceEvidenceRootRef;
  path?: string;
  maxEntries?: number;
}

export interface WorkspaceEvidenceListResponse {
  operation: 'list';
  root: WorkspaceEvidenceRoot;
  path: string;
  entries: WorkspaceEvidenceEntry[];
  truncated: boolean;
  maxEntries: number;
  state: 'available';
}

export interface WorkspaceEvidenceStatRequest {
  rootRef: WorkspaceEvidenceRootRef;
  path?: string;
}

export interface WorkspaceEvidenceStatResponse {
  operation: 'stat';
  root: WorkspaceEvidenceRoot;
  path: string;
  entry: WorkspaceEvidenceEntry;
  state: 'available';
}

export interface WorkspaceEvidenceReadRequest {
  rootRef: WorkspaceEvidenceRootRef;
  path: string;
  maxBytes?: number;
}

export interface WorkspaceEvidenceReadResponse {
  operation: 'read';
  root: WorkspaceEvidenceRoot;
  path: string;
  entry: WorkspaceEvidenceEntry;
  encoding: 'utf8';
  content: string;
  bytesRead: number;
  maxBytes: number;
  truncated: boolean;
  contentHash: string;
}

export interface WorkspaceEvidencePreviewRequest {
  rootRef: WorkspaceEvidenceRootRef;
  path: string;
  maxBytes?: number;
}

export interface WorkspaceEvidencePreview {
  state: WorkspaceEvidencePreviewState;
  kind: WorkspaceEvidencePreviewKind;
  encoding: 'utf8' | 'base64' | 'none';
  content?: string;
  bytesRead: number;
  maxBytes: number;
  truncated: boolean;
  unsupportedReason?: WorkspaceEvidenceUnavailableReason;
  contentHash?: string;
  sandboxRequired?: boolean;
}

export interface WorkspaceEvidencePreviewResponse {
  operation: 'preview';
  root: WorkspaceEvidenceRoot;
  path: string;
  entry?: WorkspaceEvidenceEntry;
  preview: WorkspaceEvidencePreview;
}

export type WorkspaceEvidenceOperationResponse =
  | WorkspaceEvidenceListResponse
  | WorkspaceEvidenceStatResponse
  | WorkspaceEvidenceReadResponse
  | WorkspaceEvidencePreviewResponse;

export interface WorkspaceEvidenceErrorResponse {
  operation: 'list' | 'stat' | 'read' | 'preview';
  error: WorkspaceEvidenceErrorState;
}

function hasValue(value: string): boolean {
  return value.trim().length > 0;
}

export function createWorkspaceEvidenceRootId(nodeId: NodeId, rootPath: string): string {
  if (!hasValue(nodeId)) throw new Error('nodeId is required');
  if (!hasValue(rootPath)) throw new Error('rootPath is required');
  return `wer:${encodeURIComponent(nodeId)}:${encodeURIComponent(rootPath)}`;
}

export function parseWorkspaceEvidenceRootId(
  id: string
): { nodeId: NodeId; rootPath: string } | null {
  if (!id.startsWith('wer:')) return null;
  const rest = id.slice('wer:'.length);
  const sep = rest.indexOf(':');
  if (sep <= 0 || sep === rest.length - 1) return null;
  try {
    const nodeId = decodeURIComponent(rest.slice(0, sep));
    const rootPath = decodeURIComponent(rest.slice(sep + 1));
    if (!hasValue(nodeId) || !hasValue(rootPath)) return null;
    return { nodeId, rootPath };
  } catch {
    return null;
  }
}

export function isWorkspaceEvidenceRootRef(value: unknown): value is WorkspaceEvidenceRootRef {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['id'] === 'string' &&
    typeof record['nodeId'] === 'string' &&
    (record['kind'] === 'workspace' ||
      record['kind'] === 'project' ||
      record['kind'] === 'bench' ||
      record['kind'] === 'repo' ||
      record['kind'] === 'worktree' ||
      record['kind'] === 'directory')
  );
}
