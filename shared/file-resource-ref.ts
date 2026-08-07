import type { NodeId } from './identity.js';

/**
 * `FileResourceRef` is the addressable handle for a file/dir/log on a paired
 * node. Subsequent #616 slices (preview blocks, agent attachments, write/edit
 * flows) consume these refs as the pointer shape.
 *
 * Refs carry freshness/size hints captured at mint time, but consumers MUST
 * re-stat through `fs.stat` before treating those as authoritative — the file
 * can change after the ref was minted.
 *
 * Refs do NOT carry capability grants; the hub policy evaluator enforces
 * actual access at fetch time. The `intent` field signals which file RPC
 * verb the ref is intended to invoke so capability checks can be planned
 * up front.
 */
export interface FileResourceRef {
  /** Paired node that owns the path. */
  nodeId: NodeId;
  /** Absolute path inside the node scope. Normalized via `path.posix.normalize`. */
  path: string;
  /** ISO 8601 timestamp at which the ref was minted. */
  capturedAt: string;
  /** Intent — which file RPC verb the ref is meant to drive. */
  intent: FileResourceRefIntent;
  /** Size in bytes at mint time (optional, advisory). */
  size?: number;
  /** sha256 hex of the contents at mint time (optional; only set if `fs.read` ran). */
  sha256?: string;
  /** Last-modified time in ms-since-epoch at mint time (optional). */
  mtimeMs?: number;
  /** Optional repo/worktree binding so callers can show git context. */
  repoBinding?: FileResourceRepoBinding;
  /** Size cap in bytes the ref carries (ignored by `list`/`stat`). */
  maxBytes?: number;
}

export type FileResourceRefIntent = 'read' | 'list' | 'stat' | 'tail';

export const FILE_RESOURCE_REF_INTENTS: readonly FileResourceRefIntent[] = [
  'read',
  'list',
  'stat',
  'tail',
] as const;

export interface FileResourceRepoBinding {
  /** Absolute repo root that contains the path. */
  repoPath: string;
  /** Absolute worktree path (if the file lives in a non-primary worktree). */
  worktreePath?: string | null;
  /** Branch name (best-effort decoration; may be stale). */
  branch?: string | null;
}

export interface CreateFileResourceRefArgs {
  nodeId: NodeId;
  path: string;
  intent: FileResourceRefIntent;
  size?: number;
  sha256?: string;
  mtimeMs?: number;
  repoBinding?: FileResourceRepoBinding;
  maxBytes?: number;
  /** Override `capturedAt`; defaults to `new Date().toISOString()`. */
  capturedAt?: string;
}

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/i;

function normalizePosixPath(input: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('FileResourceRef.path must be a non-empty string');
  }
  if (!input.startsWith('/')) {
    throw new Error(`FileResourceRef.path must be absolute, got: ${input}`);
  }
  // Inline POSIX normalize so this module stays browser-safe (no `node:path` import).
  const parts: string[] = [];
  for (const segment of input.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) {
        throw new Error(`FileResourceRef.path escapes root: ${input}`);
      }
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return '/' + parts.join('/');
}

/**
 * Mint a `FileResourceRef`. Throws if required fields are missing or
 * malformed. `path` is normalized via inline POSIX semantics (no `..`
 * components survive; non-absolute paths are rejected).
 */
export function createFileResourceRef(args: CreateFileResourceRefArgs): FileResourceRef {
  if (typeof args.nodeId !== 'string' || args.nodeId.length === 0) {
    throw new Error('FileResourceRef.nodeId is required');
  }
  if (!FILE_RESOURCE_REF_INTENTS.includes(args.intent)) {
    throw new Error(
      `FileResourceRef.intent must be one of ${FILE_RESOURCE_REF_INTENTS.join('|')}, got: ${String(args.intent)}`
    );
  }
  const normalizedPath = normalizePosixPath(args.path);
  const ref: FileResourceRef = {
    nodeId: args.nodeId,
    path: normalizedPath,
    intent: args.intent,
    capturedAt: args.capturedAt ?? new Date().toISOString(),
  };
  if (typeof args.size === 'number' && Number.isFinite(args.size) && args.size >= 0) {
    ref.size = args.size;
  }
  if (typeof args.sha256 === 'string' && SHA256_HEX_RE.test(args.sha256)) {
    ref.sha256 = args.sha256.toLowerCase();
  } else if (args.sha256 !== undefined) {
    throw new Error('FileResourceRef.sha256 must be 64 hex chars if set');
  }
  if (typeof args.mtimeMs === 'number' && Number.isFinite(args.mtimeMs) && args.mtimeMs >= 0) {
    ref.mtimeMs = args.mtimeMs;
  }
  if (args.repoBinding) {
    ref.repoBinding = sanitizeRepoBinding(args.repoBinding);
  }
  if (
    typeof args.maxBytes === 'number' &&
    Number.isFinite(args.maxBytes) &&
    args.maxBytes > 0
  ) {
    ref.maxBytes = args.maxBytes;
  }
  if (!ISO_TIMESTAMP_RE.test(ref.capturedAt)) {
    throw new Error(`FileResourceRef.capturedAt must be an ISO 8601 UTC timestamp, got: ${ref.capturedAt}`);
  }
  return ref;
}

function sanitizeRepoBinding(binding: FileResourceRepoBinding): FileResourceRepoBinding {
  if (typeof binding.repoPath !== 'string' || binding.repoPath.length === 0) {
    throw new Error('FileResourceRef.repoBinding.repoPath is required');
  }
  const out: FileResourceRepoBinding = { repoPath: normalizePosixPath(binding.repoPath) };
  if (binding.worktreePath != null) {
    if (typeof binding.worktreePath !== 'string') {
      throw new Error('FileResourceRef.repoBinding.worktreePath must be a string or null');
    }
    out.worktreePath = normalizePosixPath(binding.worktreePath);
  } else if (binding.worktreePath === null) {
    out.worktreePath = null;
  }
  if (binding.branch != null) {
    if (typeof binding.branch !== 'string') {
      throw new Error('FileResourceRef.repoBinding.branch must be a string or null');
    }
    out.branch = binding.branch;
  } else if (binding.branch === null) {
    out.branch = null;
  }
  return out;
}

/**
 * Parse + validate an unknown payload into a `FileResourceRef`. Returns
 * `null` on validation failure rather than throwing — callers typically
 * surface a typed denial in their own response shape.
 */
export function parseFileResourceRef(payload: unknown): FileResourceRef | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  try {
    const args: CreateFileResourceRefArgs = {
      nodeId: p['nodeId'] as NodeId,
      path: p['path'] as string,
      intent: p['intent'] as FileResourceRefIntent,
    };
    if (typeof p['size'] === 'number') args.size = p['size'] as number;
    if (typeof p['sha256'] === 'string') args.sha256 = p['sha256'] as string;
    if (typeof p['mtimeMs'] === 'number') args.mtimeMs = p['mtimeMs'] as number;
    if (p['repoBinding'] && typeof p['repoBinding'] === 'object') {
      args.repoBinding = p['repoBinding'] as FileResourceRepoBinding;
    }
    if (typeof p['maxBytes'] === 'number') args.maxBytes = p['maxBytes'] as number;
    if (typeof p['capturedAt'] === 'string') args.capturedAt = p['capturedAt'] as string;
    return createFileResourceRef(args);
  } catch {
    return null;
  }
}

/**
 * Structural equality for refs. Mint-time decorations (`size`, `sha256`,
 * `mtimeMs`, `capturedAt`) are excluded — the identity is `(nodeId, path,
 * intent, maxBytes, repoBinding)`. Two refs minted at different times for
 * the same file with the same intent are considered equal.
 */
export function fileResourceRefEquals(a: FileResourceRef, b: FileResourceRef): boolean {
  if (a.nodeId !== b.nodeId) return false;
  if (a.path !== b.path) return false;
  if (a.intent !== b.intent) return false;
  if ((a.maxBytes ?? null) !== (b.maxBytes ?? null)) return false;
  const aBinding = a.repoBinding ?? null;
  const bBinding = b.repoBinding ?? null;
  if (aBinding === null && bBinding === null) return true;
  if (aBinding === null || bBinding === null) return false;
  if (aBinding.repoPath !== bBinding.repoPath) return false;
  if ((aBinding.worktreePath ?? null) !== (bBinding.worktreePath ?? null)) return false;
  if ((aBinding.branch ?? null) !== (bBinding.branch ?? null)) return false;
  return true;
}

/**
 * Compact human-readable label suitable for chips, audit rows, or log
 * lines. Format: `<nodeId>:<path>` plus an optional `(<intent>)` suffix
 * when the intent is not `read` (the default for most call sites).
 */
export function fileResourceRefSummary(ref: FileResourceRef): string {
  const base = `${ref.nodeId}:${ref.path}`;
  return ref.intent === 'read' ? base : `${base} (${ref.intent})`;
}
