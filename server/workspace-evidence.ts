import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { constants as fsConstants, type Stats } from 'node:fs';
import type { RequestHandler, Response } from 'express';
import express from 'express';

import { executeLocalFileRpc } from './file-rpc.js';
import type { Config } from './types.js';
import type { HubNodeSummary, RelayNodeError } from '../shared/relay-node-protocol.js';
import { RELAY_NODE_LINK_PROTOCOL_VERSION } from '../shared/relay-node-protocol.js';
import {
  DEFAULT_LOCAL_NODE_ID,
  createRepoInstanceId,
  createWorktreeInstanceId,
} from '../shared/identity.js';
import {
  WORKSPACE_EVIDENCE_DEFAULT_LIST_ENTRIES,
  WORKSPACE_EVIDENCE_DEFAULT_PREVIEW_BYTES,
  WORKSPACE_EVIDENCE_HASH_BYTE_LIMIT,
  WORKSPACE_EVIDENCE_MAX_LIST_ENTRIES,
  WORKSPACE_EVIDENCE_MAX_PREVIEW_BYTES,
  createWorkspaceEvidenceRootId,
  isWorkspaceEvidenceRootRef,
  parseWorkspaceEvidenceRootId,
  type WorkspaceEvidenceEntry,
  type WorkspaceEvidenceErrorResponse,
  type WorkspaceEvidenceListResponse,
  type WorkspaceEvidencePreview,
  type WorkspaceEvidencePreviewKind,
  type WorkspaceEvidencePreviewResponse,
  type WorkspaceEvidencePreviewState,
  type WorkspaceEvidenceReadResponse,
  type WorkspaceEvidenceRoot,
  type WorkspaceEvidenceRootRef,
  type WorkspaceEvidenceStatResponse,
  type WorkspaceEvidenceUnavailableReason,
} from '../shared/workspace-evidence.js';
import type {
  FileRpcListResponse,
  FileRpcReadResponse,
  FileRpcResponse,
  FileRpcStatResponse,
} from '../shared/file-rpc.js';

export interface WorkspaceEvidenceNodeRegistry {
  listNodes(): HubNodeSummary[];
}

export interface WorkspaceEvidenceNodeLinks {
  hasActiveNode(nodeId: string): boolean;
  request(nodeId: string, type: string, payload: unknown): Promise<unknown>;
}

export interface WorkspaceEvidenceRouterOptions {
  requireAuth?: RequestHandler;
  getConfig?: () => Config;
  getRoots?: () => WorkspaceEvidenceRoot[] | Promise<WorkspaceEvidenceRoot[]>;
  registry?: WorkspaceEvidenceNodeRegistry;
  nodeLinks?: WorkspaceEvidenceNodeLinks;
}

interface ResolvedRoot {
  root: WorkspaceEvidenceRoot;
  absolutePath: string;
  api: PathApi;
}

interface PathApi {
  sep: string;
  basename(p: string): string;
  extname(p: string): string;
  isAbsolute(p: string): boolean;
  join(...paths: string[]): string;
  normalize(p: string): string;
  relative(from: string, to: string): string;
  resolve(...paths: string[]): string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nodePathApi(node?: HubNodeSummary): PathApi {
  return node?.platform === 'win32' ? path.win32 : path.posix;
}

function localPathApi(): PathApi {
  return process.platform === 'win32' ? path.win32 : path.posix;
}

function normalizeForCompare(value: string, api: PathApi): string {
  const normalized = api.normalize(value);
  return api === path.win32 ? normalized.toLowerCase() : normalized;
}

function pathInside(root: string, target: string, api: PathApi): boolean {
  const normalizedRoot = normalizeForCompare(root, api);
  const normalizedTarget = normalizeForCompare(target, api);
  if (normalizedTarget === normalizedRoot) return true;
  const relative = api.relative(normalizedRoot, normalizedTarget);
  return !!relative && !relative.startsWith('..') && !api.isAbsolute(relative);
}

function hasNul(value: string): boolean {
  return value.includes('\0');
}

function clampPositiveInt(value: unknown, fallback: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? Math.min(value, max)
    : fallback;
}

function localRootRef(rootPath: string, kind: WorkspaceEvidenceRoot['kind']): WorkspaceEvidenceRootRef {
  const rootId = createWorkspaceEvidenceRootId(DEFAULT_LOCAL_NODE_ID, path.resolve(rootPath));
  const ref: WorkspaceEvidenceRootRef = {
    id: rootId,
    nodeId: DEFAULT_LOCAL_NODE_ID,
    kind,
  };
  if (kind === 'repo') ref.repoInstanceId = createRepoInstanceId(DEFAULT_LOCAL_NODE_ID, path.resolve(rootPath));
  if (kind === 'worktree') ref.worktreeInstanceId = createWorktreeInstanceId(DEFAULT_LOCAL_NODE_ID, path.resolve(rootPath));
  return ref;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function buildLocalRoot(rootPath: string, workspaceId?: string): Promise<WorkspaceEvidenceRoot> {
  const absolute = path.resolve(rootPath);
  let rootStats: Stats | null = null;
  let rootUnavailableReason: WorkspaceEvidenceUnavailableReason | undefined;
  let rootStatus: WorkspaceEvidenceRoot['status'] = 'available';
  let rootMessage: string | undefined;
  try {
    rootStats = await fs.stat(absolute);
    if (!rootStats.isDirectory()) {
      rootStatus = 'unsupported';
      rootUnavailableReason = 'WORKSPACE_EVIDENCE_UNSUPPORTED';
      rootMessage = 'workspace evidence root is not a directory';
    } else {
      await fs.access(absolute, fsConstants.R_OK);
    }
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code) : undefined;
    rootStatus = code === 'EACCES' || code === 'EPERM' ? 'permission-denied' : 'unavailable';
    rootUnavailableReason = rootStatus === 'permission-denied' ? 'WORKSPACE_EVIDENCE_PERMISSION_DENIED' : 'WORKSPACE_EVIDENCE_ROOT_NOT_FOUND';
    rootMessage = rootStatus === 'permission-denied' ? 'workspace evidence root is not readable' : 'workspace evidence root does not exist';
  }
  const dotGit = path.join(absolute, '.git');
  const dotGitExists = rootStats?.isDirectory() ? await fileExists(dotGit) : false;
  let dotGitIsFile = false;
  if (dotGitExists) {
    try {
      dotGitIsFile = (await fs.lstat(dotGit)).isFile();
    } catch {
      dotGitIsFile = false;
    }
  }
  const kind: WorkspaceEvidenceRoot['kind'] = dotGitExists
    ? dotGitIsFile
      ? 'worktree'
      : 'repo'
    : 'directory';
  const backing: WorkspaceEvidenceRoot['backing'] = kind === 'worktree' ? 'worktree' : kind === 'repo' ? 'repo' : 'directory';
  const ref = localRootRef(absolute, kind);
  if (workspaceId) ref.workspaceId = workspaceId;
  const root: WorkspaceEvidenceRoot = {
    ref,
    name: path.basename(absolute) || absolute,
    path: absolute,
    nodeId: DEFAULT_LOCAL_NODE_ID,
    kind,
    backing,
    status: rootStatus,
    capabilities:
      rootStatus === 'available'
        ? { list: true, stat: true, read: true, preview: true, write: false }
        : {
            list: false,
            stat: false,
            read: false,
            preview: false,
            write: false,
            reason: rootUnavailableReason ?? 'WORKSPACE_EVIDENCE_ROOT_UNAVAILABLE',
          },
    ...(rootUnavailableReason ? { unavailableReason: rootUnavailableReason } : {}),
    ...(rootMessage ? { message: rootMessage } : {}),
    ...(kind === 'repo' || kind === 'worktree'
      ? {
          repo: {
            repoPath: absolute,
            repoInstanceId: createRepoInstanceId(DEFAULT_LOCAL_NODE_ID, absolute),
            isGitRepo: true,
          },
        }
      : {}),
    ...(kind === 'worktree'
      ? {
          worktree: {
            worktreePath: absolute,
            worktreeInstanceId: createWorktreeInstanceId(DEFAULT_LOCAL_NODE_ID, absolute),
          },
        }
      : {}),
  };
  return root;
}

export async function listConfiguredWorkspaceEvidenceRoots(config: Config): Promise<WorkspaceEvidenceRoot[]> {
  const seen = new Set<string>();
  const paths: Array<{ path: string; workspaceId?: string }> = [];
  for (const repoPath of config.repos ?? []) paths.push({ path: repoPath });
  for (const workspace of config.workspaces ?? []) {
    for (const repoPath of workspace.repos ?? []) paths.push({ path: repoPath, workspaceId: workspace.id });
  }

  const roots: WorkspaceEvidenceRoot[] = [];
  for (const entry of paths) {
    const absolute = path.resolve(entry.path);
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    roots.push(await buildLocalRoot(absolute, entry.workspaceId));
  }
  return roots;
}

function errorResponse(
  operation: WorkspaceEvidenceErrorResponse['operation'],
  reason: WorkspaceEvidenceUnavailableReason,
  message: string,
  state: WorkspaceEvidenceErrorResponse['error']['state'],
  rootRef?: WorkspaceEvidenceRootRef,
  nodeId?: string
): WorkspaceEvidenceErrorResponse {
  return {
    operation,
    error: {
      state,
      reason,
      message,
      ...(rootRef ? { rootRef } : {}),
      ...(nodeId ? { nodeId } : {}),
    },
  };
}

function statusForError(response: WorkspaceEvidenceErrorResponse): number {
  switch (response.error.state) {
    case 'not-found':
      return 404;
    case 'permission-denied':
      return 403;
    case 'offline':
    case 'unavailable':
      return 503;
    case 'unsupported':
      return 422;
  }
}

function relayErrorReason(error: RelayNodeError): WorkspaceEvidenceUnavailableReason {
  const reason = error.details?.['reasonCode'];
  if (reason === 'FILE_RPC_ROOT_ESCAPE' || reason === 'FILE_RPC_CWD_ESCAPE') {
    return 'WORKSPACE_EVIDENCE_ROOT_ESCAPE';
  }
  if (reason === 'FILE_RPC_NOT_FOUND') return 'WORKSPACE_EVIDENCE_NOT_FOUND';
  if (reason === 'FILE_RPC_NOT_DIRECTORY') return 'WORKSPACE_EVIDENCE_NOT_DIRECTORY';
  if (reason === 'FILE_RPC_NOT_FILE') return 'WORKSPACE_EVIDENCE_NOT_FILE';
  if (reason === 'FILE_RPC_ROOT_UNAVAILABLE') return 'WORKSPACE_EVIDENCE_ROOT_UNAVAILABLE';
  if (error.code === 'FORBIDDEN') return 'WORKSPACE_EVIDENCE_PERMISSION_DENIED';
  return 'WORKSPACE_EVIDENCE_UNAVAILABLE';
}

function relayState(error: RelayNodeError): WorkspaceEvidenceErrorResponse['error']['state'] {
  if (error.code === 'FORBIDDEN') return 'permission-denied';
  if (error.code === 'NOT_FOUND') return 'not-found';
  if (error.code === 'NODE_OFFLINE') return 'offline';
  return 'unavailable';
}

function isRelayNodeError(value: unknown): value is RelayNodeError {
  const record = asRecord(value);
  return (
    typeof record?.['code'] === 'string' &&
    typeof record['message'] === 'string' &&
    typeof record['retryable'] === 'boolean'
  );
}

function errorFromThrown(error: unknown): RelayNodeError | null {
  if (isRelayNodeError(error)) return error;
  const record = asRecord(error);
  const nested = record?.['relayNodeError'];
  return isRelayNodeError(nested) ? nested : null;
}

function looksLikeFileRpcResponse(value: unknown): value is FileRpcResponse {
  const record = asRecord(value);
  return typeof record?.['operation'] === 'string';
}

function nodeForRoot(registry: WorkspaceEvidenceNodeRegistry | undefined, root: WorkspaceEvidenceRoot): HubNodeSummary | undefined {
  if (root.nodeId === DEFAULT_LOCAL_NODE_ID) return undefined;
  return registry?.listNodes().find((node) => node.nodeId === root.nodeId);
}

function remoteNodeAvailable(
  root: WorkspaceEvidenceRoot,
  registry: WorkspaceEvidenceNodeRegistry | undefined,
  nodeLinks: WorkspaceEvidenceNodeLinks | undefined
): { ok: true; node: HubNodeSummary } | { ok: false; response: WorkspaceEvidenceErrorResponse } {
  const node = nodeForRoot(registry, root);
  if (!node || node.status !== 'online' || node.protocolVersion !== RELAY_NODE_LINK_PROTOCOL_VERSION) {
    return {
      ok: false,
      response: errorResponse(
        'list',
        'WORKSPACE_EVIDENCE_NODE_OFFLINE',
        `workspace evidence node ${root.nodeId} is offline or unavailable`,
        'offline',
        root.ref,
        root.nodeId
      ),
    };
  }
  if (!nodeLinks?.hasActiveNode(root.nodeId)) {
    return {
      ok: false,
      response: errorResponse(
        'list',
        'WORKSPACE_EVIDENCE_NODE_OFFLINE',
        `workspace evidence node ${root.nodeId} has no active node link`,
        'offline',
        root.ref,
        root.nodeId
      ),
    };
  }
  return { ok: true, node };
}

function findRootByRef(roots: WorkspaceEvidenceRoot[], rootRef: unknown): WorkspaceEvidenceRoot | null {
  if (!isWorkspaceEvidenceRootRef(rootRef)) return null;
  const parsed = parseWorkspaceEvidenceRootId(rootRef.id);
  if (!parsed || parsed.nodeId !== rootRef.nodeId) return null;
  return (
    roots.find(
      (root) =>
        root.ref.id === rootRef.id &&
        root.ref.nodeId === rootRef.nodeId &&
        root.ref.kind === rootRef.kind &&
        root.path !== null
    ) ?? null
  );
}

function resolveTarget(root: WorkspaceEvidenceRoot, requestPath: unknown, api: PathApi): { ok: true; path: string } | { ok: false; reason: string } {
  if (!root.path) return { ok: false, reason: 'root has no filesystem path' };
  const rawPath = typeof requestPath === 'string' && requestPath.trim() ? requestPath : '.';
  if (hasNul(root.path) || hasNul(rawPath)) return { ok: false, reason: 'paths must not contain NUL bytes' };
  const rootPath = api.resolve(root.path);
  const target = api.isAbsolute(rawPath) ? api.resolve(rawPath) : api.resolve(rootPath, rawPath);
  if (!pathInside(rootPath, target, api)) return { ok: false, reason: 'path is outside the workspace evidence root' };
  return { ok: true, path: target };
}

function relativeEntryPath(root: WorkspaceEvidenceRoot, entryPath: string, api: PathApi): string {
  if (!root.path) return entryPath;
  const relative = api.relative(api.resolve(root.path), api.resolve(entryPath));
  return relative === '' ? '.' : relative;
}

function entryFromStat(root: WorkspaceEvidenceRoot, stat: FileRpcStatResponse['stat'], api: PathApi, hash?: string): WorkspaceEvidenceEntry {
  const relative = relativeEntryPath(root, stat.path, api);
  return {
    ref: { rootRef: root.ref, path: relative },
    path: relative,
    name: stat.name,
    type: stat.type,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    mode: stat.mode,
    ...(hash ? { contentHash: hash } : {}),
  };
}

function sha256Hex(content: Buffer | string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function localHashIfSmall(targetPath: string, stats: Stats): Promise<string | undefined> {
  if (!stats.isFile() || stats.size > WORKSPACE_EVIDENCE_HASH_BYTE_LIMIT) return undefined;
  try {
    return sha256Hex(await fs.readFile(targetPath));
  } catch {
    return undefined;
  }
}

async function addLocalHashes(root: WorkspaceEvidenceRoot, entries: WorkspaceEvidenceEntry[], api: PathApi): Promise<WorkspaceEvidenceEntry[]> {
  if (root.nodeId !== DEFAULT_LOCAL_NODE_ID || !root.path) return entries;
  return Promise.all(
    entries.map(async (entry) => {
      if (entry.type !== 'file' || entry.size > WORKSPACE_EVIDENCE_HASH_BYTE_LIMIT) return entry;
      const target = api.resolve(root.path ?? '', entry.path);
      try {
        const contentHash = await localHashIfSmall(target, await fs.stat(target));
        return contentHash ? { ...entry, contentHash } : entry;
      } catch {
        return entry;
      }
    })
  );
}

function previewKindForPath(filePath: string, api: PathApi): WorkspaceEvidencePreviewKind {
  const ext = api.extname(filePath).toLowerCase();
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (ext === '.json' || ext === '.jsonl') return 'json';
  if (ext === '.log' || ext === '.out' || ext === '.err') return 'log';
  if (ext === '.diff' || ext === '.patch') return 'diff';
  if (ext === '.html' || ext === '.htm' || ext === '.svg') return 'html-source';
  const textExts = new Set([
    '.txt',
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.css',
    '.scss',
    '.yml',
    '.yaml',
    '.toml',
    '.xml',
    '.csv',
    '.sh',
    '.bash',
    '.zsh',
    '.fish',
    '.py',
    '.rs',
    '.go',
    '.java',
    '.kt',
    '.sql',
  ]);
  return textExts.has(ext) || ext === '' ? 'text' : 'unsupported';
}

function binaryLike(content: string): boolean {
  return content.includes('\0');
}

async function dispatchFileRpc(
  root: WorkspaceEvidenceRoot,
  operation: 'list' | 'stat' | 'read',
  targetPath: string,
  options: {
    node?: HubNodeSummary;
    nodeLinks?: WorkspaceEvidenceNodeLinks;
    maxEntries?: number;
    maxBytes?: number;
  } = {}
): Promise<FileRpcResponse | RelayNodeError> {
  if (!root.path) {
    return {
      code: 'NOT_FOUND',
      message: 'workspace evidence root has no filesystem path',
      retryable: false,
      details: { reasonCode: 'FILE_RPC_ROOT_UNAVAILABLE' },
    };
  }
  const payload: Record<string, unknown> = {
    sessionId: `workspace-evidence:${root.ref.id}`,
    root: root.path,
    cwd: root.path,
    path: targetPath,
  };
  if (operation === 'list') payload.maxEntries = options.maxEntries ?? WORKSPACE_EVIDENCE_DEFAULT_LIST_ENTRIES;
  if (operation === 'read') payload.maxBytes = options.maxBytes ?? WORKSPACE_EVIDENCE_DEFAULT_PREVIEW_BYTES;
  if (root.nodeId === DEFAULT_LOCAL_NODE_ID) return await executeLocalFileRpc(operation, payload);
  if (!options.nodeLinks) {
    return {
      code: 'NODE_OFFLINE',
      message: `workspace evidence node ${root.nodeId} has no node link`,
      retryable: true,
      details: { reasonCode: 'WORKSPACE_EVIDENCE_NODE_OFFLINE' },
    };
  }
  try {
    const response = await options.nodeLinks.request(root.nodeId, `fs.${operation}`, payload);
    if (isRelayNodeError(response)) return response;
    if (looksLikeFileRpcResponse(response)) return response;
    return {
      code: 'INTERNAL',
      message: 'node returned an invalid file RPC response',
      retryable: false,
      details: { reasonCode: 'WORKSPACE_EVIDENCE_UNSUPPORTED' },
    };
  } catch (error) {
    return (
      errorFromThrown(error) ?? {
        code: 'INTERNAL',
        message: error instanceof Error ? error.message : String(error ?? 'unknown'),
        retryable: false,
      }
    );
  }
}

async function operationRoot(
  roots: WorkspaceEvidenceRoot[], rootRef: unknown, operation: WorkspaceEvidenceErrorResponse['operation']
): Promise<{ ok: true; value: WorkspaceEvidenceRoot } | { ok: false; response: WorkspaceEvidenceErrorResponse }> {
  if (!isWorkspaceEvidenceRootRef(rootRef)) {
    return {
      ok: false,
      response: errorResponse(
        operation,
        'WORKSPACE_EVIDENCE_INVALID_REQUEST',
        'rootRef is required and must be a workspace evidence root ref',
        'unsupported'
      ),
    };
  }
  const root = findRootByRef(roots, rootRef);
  if (!root) {
    return {
      ok: false,
      response: errorResponse(
        operation,
        'WORKSPACE_EVIDENCE_ROOT_NOT_FOUND',
        'workspace evidence root is not registered or no longer available',
        'not-found',
        rootRef,
        rootRef.nodeId
      ),
    };
  }
  if (root.status !== 'available') {
    return {
      ok: false,
      response: errorResponse(
        operation,
        root.unavailableReason ?? 'WORKSPACE_EVIDENCE_ROOT_UNAVAILABLE',
        root.message ?? 'workspace evidence root is unavailable',
        root.status === 'permission-denied' ? 'permission-denied' : root.status,
        root.ref,
        root.nodeId
      ),
    };
  }
  return { ok: true, value: root };
}

async function resolveOperationRoot(
  roots: WorkspaceEvidenceRoot[],
  body: Record<string, unknown>,
  operation: WorkspaceEvidenceErrorResponse['operation'],
  registry?: WorkspaceEvidenceNodeRegistry,
  nodeLinks?: WorkspaceEvidenceNodeLinks
): Promise<{ ok: true; value: ResolvedRoot } | { ok: false; response: WorkspaceEvidenceErrorResponse }> {
  const rootResult = await operationRoot(roots, body['rootRef'], operation);
  if (rootResult.ok === false) return rootResult;
  const root = rootResult.value;
  if (root.nodeId === DEFAULT_LOCAL_NODE_ID) {
    return { ok: true, value: { root, absolutePath: root.path ?? '', api: localPathApi() } };
  }
  const remote = remoteNodeAvailable(root, registry, nodeLinks);
  if (remote.ok === false) {
    return { ok: false, response: { ...remote.response, operation } };
  }
  return { ok: true, value: { root, absolutePath: root.path ?? '', api: nodePathApi(remote.node) } };
}

function dispatchOptions(
  nodeLinks?: WorkspaceEvidenceNodeLinks,
  limits: { maxEntries?: number; maxBytes?: number } = {}
): { nodeLinks?: WorkspaceEvidenceNodeLinks; maxEntries?: number; maxBytes?: number } {
  return {
    ...(nodeLinks ? { nodeLinks } : {}),
    ...(limits.maxEntries !== undefined ? { maxEntries: limits.maxEntries } : {}),
    ...(limits.maxBytes !== undefined ? { maxBytes: limits.maxBytes } : {}),
  };
}

async function handleList(
  roots: WorkspaceEvidenceRoot[],
  body: Record<string, unknown>,
  registry?: WorkspaceEvidenceNodeRegistry,
  nodeLinks?: WorkspaceEvidenceNodeLinks
): Promise<WorkspaceEvidenceListResponse | WorkspaceEvidenceErrorResponse> {
  const resolved = await resolveOperationRoot(roots, body, 'list', registry, nodeLinks);
  if (resolved.ok === false) return resolved.response;
  const { root, api } = resolved.value;
  const target = resolveTarget(root, body['path'], api);
  if (target.ok === false) {
    return errorResponse('list', 'WORKSPACE_EVIDENCE_ROOT_ESCAPE', target.reason, 'unsupported', root.ref, root.nodeId);
  }
  const maxEntries = clampPositiveInt(
    body['maxEntries'],
    WORKSPACE_EVIDENCE_DEFAULT_LIST_ENTRIES,
    WORKSPACE_EVIDENCE_MAX_LIST_ENTRIES
  );
  const response = await dispatchFileRpc(root, 'list', target.path, dispatchOptions(nodeLinks, { maxEntries }));
  if (isRelayNodeError(response)) {
    return errorResponse('list', relayErrorReason(response), response.message, relayState(response), root.ref, root.nodeId);
  }
  const list = response as FileRpcListResponse;
  let entries = list.entries.map((entry) => entryFromStat(root, entry, api));
  entries = await addLocalHashes(root, entries, api);
  return {
    operation: 'list',
    root,
    path: relativeEntryPath(root, list.path, api),
    entries,
    truncated: list.truncated,
    maxEntries: list.maxEntries,
    state: 'available',
  };
}

async function handleStat(
  roots: WorkspaceEvidenceRoot[],
  body: Record<string, unknown>,
  registry?: WorkspaceEvidenceNodeRegistry,
  nodeLinks?: WorkspaceEvidenceNodeLinks
): Promise<WorkspaceEvidenceStatResponse | WorkspaceEvidenceErrorResponse> {
  const resolved = await resolveOperationRoot(roots, body, 'stat', registry, nodeLinks);
  if (resolved.ok === false) return resolved.response;
  const { root, api } = resolved.value;
  const target = resolveTarget(root, body['path'], api);
  if (target.ok === false) {
    return errorResponse('stat', 'WORKSPACE_EVIDENCE_ROOT_ESCAPE', target.reason, 'unsupported', root.ref, root.nodeId);
  }
  const response = await dispatchFileRpc(root, 'stat', target.path, dispatchOptions(nodeLinks));
  if (isRelayNodeError(response)) {
    return errorResponse('stat', relayErrorReason(response), response.message, relayState(response), root.ref, root.nodeId);
  }
  const stat = response as FileRpcStatResponse;
  let hash: string | undefined;
  if (root.nodeId === DEFAULT_LOCAL_NODE_ID && stat.stat.type === 'file') {
    try {
      hash = await localHashIfSmall(stat.stat.path, await fs.stat(stat.stat.path));
    } catch {
      hash = undefined;
    }
  }
  return {
    operation: 'stat',
    root,
    path: relativeEntryPath(root, stat.path, api),
    entry: entryFromStat(root, stat.stat, api, hash),
    state: 'available',
  };
}

async function handleRead(
  roots: WorkspaceEvidenceRoot[],
  body: Record<string, unknown>,
  registry?: WorkspaceEvidenceNodeRegistry,
  nodeLinks?: WorkspaceEvidenceNodeLinks
): Promise<WorkspaceEvidenceReadResponse | WorkspaceEvidenceErrorResponse> {
  const resolved = await resolveOperationRoot(roots, body, 'read', registry, nodeLinks);
  if (resolved.ok === false) return resolved.response;
  const { root, api } = resolved.value;
  const target = resolveTarget(root, body['path'], api);
  const maxBytes = clampPositiveInt(
    body['maxBytes'],
    WORKSPACE_EVIDENCE_DEFAULT_PREVIEW_BYTES,
    WORKSPACE_EVIDENCE_MAX_PREVIEW_BYTES
  );
  if (target.ok === false) {
    return errorResponse('read', 'WORKSPACE_EVIDENCE_ROOT_ESCAPE', target.reason, 'unsupported', root.ref, root.nodeId);
  }

  const statResponse = await dispatchFileRpc(root, 'stat', target.path, dispatchOptions(nodeLinks));
  if (isRelayNodeError(statResponse)) {
    return errorResponse('read', relayErrorReason(statResponse), statResponse.message, relayState(statResponse), root.ref, root.nodeId);
  }
  const stat = statResponse as FileRpcStatResponse;
  const entry = entryFromStat(root, stat.stat, api);
  if (stat.stat.type !== 'file') {
    return errorResponse('read', 'WORKSPACE_EVIDENCE_NOT_FILE', 'workspace evidence read target is not a file', 'unsupported', root.ref, root.nodeId);
  }

  const readResponse = await dispatchFileRpc(root, 'read', target.path, dispatchOptions(nodeLinks, { maxBytes }));
  if (isRelayNodeError(readResponse)) {
    return errorResponse('read', relayErrorReason(readResponse), readResponse.message, relayState(readResponse), root.ref, root.nodeId);
  }
  const read = readResponse as FileRpcReadResponse;
  if (binaryLike(read.content)) {
    return errorResponse('read', 'WORKSPACE_EVIDENCE_BINARY_UNSUPPORTED', 'workspace evidence read target is binary', 'unsupported', root.ref, root.nodeId);
  }
  const contentHash = sha256Hex(read.content);
  return {
    operation: 'read',
    root,
    path: entry.path,
    entry: { ...entry, contentHash },
    encoding: 'utf8',
    content: read.content,
    bytesRead: read.bytesRead,
    maxBytes: read.maxBytes,
    truncated: read.truncatedBytes || read.truncatedLines,
    contentHash,
  };
}

function unavailablePreview(
  state: WorkspaceEvidencePreviewState,
  reason: WorkspaceEvidenceUnavailableReason,
  maxBytes: number,
  kind: WorkspaceEvidencePreviewKind = 'unsupported'
): WorkspaceEvidencePreview {
  return {
    state,
    kind,
    encoding: 'none',
    bytesRead: 0,
    maxBytes,
    truncated: false,
    unsupportedReason: reason,
  };
}

async function handlePreview(
  roots: WorkspaceEvidenceRoot[],
  body: Record<string, unknown>,
  registry?: WorkspaceEvidenceNodeRegistry,
  nodeLinks?: WorkspaceEvidenceNodeLinks
): Promise<WorkspaceEvidencePreviewResponse | WorkspaceEvidenceErrorResponse> {
  const resolved = await resolveOperationRoot(roots, body, 'preview', registry, nodeLinks);
  if (resolved.ok === false) return resolved.response;
  const { root, api } = resolved.value;
  const target = resolveTarget(root, body['path'], api);
  const maxBytes = clampPositiveInt(
    body['maxBytes'],
    WORKSPACE_EVIDENCE_DEFAULT_PREVIEW_BYTES,
    WORKSPACE_EVIDENCE_MAX_PREVIEW_BYTES
  );
  if (target.ok === false) {
    return errorResponse('preview', 'WORKSPACE_EVIDENCE_ROOT_ESCAPE', target.reason, 'unsupported', root.ref, root.nodeId);
  }

  const statResponse = await dispatchFileRpc(root, 'stat', target.path, dispatchOptions(nodeLinks));
  if (isRelayNodeError(statResponse)) {
    return errorResponse(
      'preview',
      relayErrorReason(statResponse),
      statResponse.message,
      relayState(statResponse),
      root.ref,
      root.nodeId
    );
  }
  const stat = statResponse as FileRpcStatResponse;
  const entry = entryFromStat(root, stat.stat, api);
  if (stat.stat.type !== 'file') {
    return {
      operation: 'preview',
      root,
      path: entry.path,
      entry,
      preview: unavailablePreview('unsupported', 'WORKSPACE_EVIDENCE_UNSUPPORTED', maxBytes),
    };
  }
  if (stat.stat.size > maxBytes) {
    return {
      operation: 'preview',
      root,
      path: entry.path,
      entry,
      preview: unavailablePreview('oversized', 'WORKSPACE_EVIDENCE_OVERSIZED', maxBytes, previewKindForPath(entry.path, api)),
    };
  }

  const kind = previewKindForPath(entry.path, api);
  if (kind === 'unsupported') {
    return {
      operation: 'preview',
      root,
      path: entry.path,
      entry,
      preview: unavailablePreview('unsupported', 'WORKSPACE_EVIDENCE_UNSUPPORTED', maxBytes),
    };
  }

  const readResponse = await dispatchFileRpc(root, 'read', target.path, dispatchOptions(nodeLinks, { maxBytes }));
  if (isRelayNodeError(readResponse)) {
    return errorResponse('preview', relayErrorReason(readResponse), readResponse.message, relayState(readResponse), root.ref, root.nodeId);
  }
  const read = readResponse as FileRpcReadResponse;
  if (binaryLike(read.content)) {
    return {
      operation: 'preview',
      root,
      path: entry.path,
      entry,
      preview: unavailablePreview('binary', 'WORKSPACE_EVIDENCE_BINARY_UNSUPPORTED', maxBytes, 'binary'),
    };
  }
  const contentHash = sha256Hex(read.content);
  return {
    operation: 'preview',
    root,
    path: entry.path,
    entry: { ...entry, contentHash },
    preview: {
      state: 'available',
      kind,
      encoding: 'utf8',
      content: read.content,
      bytesRead: read.bytesRead,
      maxBytes: read.maxBytes,
      truncated: read.truncatedBytes || read.truncatedLines,
      contentHash,
      ...(kind === 'html-source' ? { sandboxRequired: true } : {}),
    },
  };
}

async function rootsForOptions(options: WorkspaceEvidenceRouterOptions): Promise<WorkspaceEvidenceRoot[]> {
  const configured = options.getConfig ? await listConfiguredWorkspaceEvidenceRoots(options.getConfig()) : [];
  const additional = options.getRoots ? await options.getRoots() : [];
  const byId = new Map<string, WorkspaceEvidenceRoot>();
  for (const root of [...configured, ...additional]) byId.set(root.ref.id, root);
  return Array.from(byId.values());
}

function sendOperationResponse(
  res: Response,
  response:
    | WorkspaceEvidenceListResponse
    | WorkspaceEvidenceStatResponse
    | WorkspaceEvidenceReadResponse
    | WorkspaceEvidencePreviewResponse
    | WorkspaceEvidenceErrorResponse
): void {
  if ('error' in response) {
    res.status(statusForError(response)).json(response);
    return;
  }
  res.json(response);
}

export function createWorkspaceEvidenceRouter(options: WorkspaceEvidenceRouterOptions): express.Router {
  const router = express.Router();
  const auth = options.requireAuth ?? ((_req, _res, next) => next());

  // Workspace evidence roots are read-only dashboard scopes. They intentionally
  // describe repo/worktree bindings as optional decoration; callers must pass a
  // returned rootRef back to list/stat/preview, preventing arbitrary home-path browsing.
  router.get('/workspace-evidence/roots', auth, async (_req, res) => {
    res.json({ roots: await rootsForOptions(options) });
  });

  router.post('/workspace-evidence/list', auth, async (req, res) => {
    const body = asRecord(req.body) ?? {};
    const response = await handleList(await rootsForOptions(options), body, options.registry, options.nodeLinks);
    sendOperationResponse(res, response);
  });

  router.post('/workspace-evidence/stat', auth, async (req, res) => {
    const body = asRecord(req.body) ?? {};
    const response = await handleStat(await rootsForOptions(options), body, options.registry, options.nodeLinks);
    sendOperationResponse(res, response);
  });

  router.post('/workspace-evidence/read', auth, async (req, res) => {
    const body = asRecord(req.body) ?? {};
    const response = await handleRead(await rootsForOptions(options), body, options.registry, options.nodeLinks);
    sendOperationResponse(res, response);
  });

  router.post('/workspace-evidence/preview', auth, async (req, res) => {
    const body = asRecord(req.body) ?? {};
    const response = await handlePreview(await rootsForOptions(options), body, options.registry, options.nodeLinks);
    sendOperationResponse(res, response);
  });

  return router;
}
