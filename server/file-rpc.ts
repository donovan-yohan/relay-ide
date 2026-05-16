import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Stats } from 'node:fs';
import type {
  FileRpcDenialReason,
  FileRpcListResponse,
  FileRpcOperation,
  FileRpcReadResponse,
  FileRpcRequest,
  FileRpcResponse,
  FileRpcStat,
  FileRpcStatResponse,
  FileRpcTailChunk,
  FileRpcTailRequest,
  FileRpcTailResponse,
} from '../shared/file-rpc.js';
import {
  FILE_RPC_DEFAULT_FOLLOW_CHUNK_BYTES,
  FILE_RPC_DEFAULT_LIST_ENTRIES,
  FILE_RPC_DEFAULT_READ_BYTES,
  FILE_RPC_DEFAULT_TAIL_BYTES,
  FILE_RPC_MAX_FOLLOW_CHUNK_BYTES,
  FILE_RPC_MAX_LIST_ENTRIES,
  FILE_RPC_MAX_READ_BYTES,
  FILE_RPC_MAX_READ_LINES,
  FILE_RPC_MAX_TAIL_BYTES,
  FILE_RPC_MAX_TAIL_LINES,
} from '../shared/file-rpc.js';
import type { RelayNodeError } from '../shared/relay-node-protocol.js';
import type { ScopedSessionSummary } from './session-envelope-registry.js';

interface PathApi {
  sep: string;
  basename(path: string): string;
  isAbsolute(path: string): boolean;
  join(...paths: string[]): string;
  normalize(path: string): string;
  relative(from: string, to: string): string;
  resolve(...paths: string[]): string;
}

export interface NormalizedHubFileRpcRequest {
  request: FileRpcRequest;
  policyScope: {
    kind: ScopedSessionSummary['scope']['kind'];
    nodeId: string;
    cwd: string;
    path: string;
    repoPath?: string;
    worktreePath?: string | null;
  };
}

function fileRpcError(
  code: RelayNodeError['code'],
  reasonCode: FileRpcDenialReason,
  message: string,
  details: Record<string, unknown> = {}
): RelayNodeError {
  return {
    code,
    message,
    retryable: false,
    details: { reasonCode, ...details },
  };
}

function invalidRequest(
  reasonCode: FileRpcDenialReason,
  message: string,
  details: Record<string, unknown> = {}
): RelayNodeError {
  return fileRpcError('INVALID_REQUEST', reasonCode, message, details);
}

function notFound(
  reasonCode: FileRpcDenialReason,
  message: string,
  details: Record<string, unknown> = {}
): RelayNodeError {
  return fileRpcError('NOT_FOUND', reasonCode, message, details);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  max: number,
  field: string
): number | RelayNodeError {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || typeof value !== 'number' || value <= 0) {
    return invalidRequest('FILE_RPC_INVALID_REQUEST', `${field} must be a positive integer`, {
      field,
    });
  }
  return Math.min(value, max);
}

function optionalBoundedInteger(
  value: unknown,
  max: number,
  field: string
): number | RelayNodeError | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || typeof value !== 'number' || value <= 0) {
    return invalidRequest('FILE_RPC_INVALID_REQUEST', `${field} must be a positive integer`, {
      field,
    });
  }
  return Math.min(value, max);
}

function optionalBoolean(value: unknown, field: string): boolean | RelayNodeError {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') {
    return invalidRequest('FILE_RPC_INVALID_REQUEST', `${field} must be boolean when set`, {
      field,
    });
  }
  return value;
}

function pathApiForPlatform(platform?: string): PathApi {
  return platform === 'win32' ? path.win32 : path.posix;
}

function hasNul(value: string): boolean {
  return value.includes('\0');
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

function resolveRoot(summary: ScopedSessionSummary): string | RelayNodeError {
  const { scope } = summary;
  if (scope.kind === 'worktree' && scope.worktreePath) return scope.worktreePath;
  if (scope.kind === 'repo' && scope.repoPath) return scope.repoPath;
  if (scope.cwd) return scope.cwd;
  return invalidRequest(
    'FILE_RPC_ROOT_UNAVAILABLE',
    'scoped session does not expose a filesystem root',
    { sessionId: summary.sessionId, scope: scope.kind }
  );
}

function buildOperationRequest(
  operation: FileRpcOperation,
  base: FileRpcRequest,
  fields: Record<string, unknown>
): FileRpcRequest | RelayNodeError {
  if (operation === 'list') return buildListRequest(base, fields);
  if (operation === 'read') return buildReadRequest(base, fields);
  if (operation === 'tail') return buildTailRequest(base, fields);
  return base;
}

function buildListRequest(
  base: FileRpcRequest,
  fields: Record<string, unknown>
): FileRpcRequest | RelayNodeError {
  const maxEntries = boundedInteger(
    fields['maxEntries'],
    FILE_RPC_DEFAULT_LIST_ENTRIES,
    FILE_RPC_MAX_LIST_ENTRIES,
    'maxEntries'
  );
  if (typeof maxEntries !== 'number') return maxEntries;
  return { ...base, maxEntries };
}

function buildReadRequest(
  base: FileRpcRequest,
  fields: Record<string, unknown>
): FileRpcRequest | RelayNodeError {
  const maxBytes = boundedInteger(
    fields['maxBytes'],
    FILE_RPC_DEFAULT_READ_BYTES,
    FILE_RPC_MAX_READ_BYTES,
    'maxBytes'
  );
  if (typeof maxBytes !== 'number') return maxBytes;
  const maxLines = optionalBoundedInteger(fields['maxLines'], FILE_RPC_MAX_READ_LINES, 'maxLines');
  if (maxLines !== undefined && typeof maxLines !== 'number') return maxLines;
  return { ...base, maxBytes, ...(maxLines !== undefined ? { maxLines } : {}) };
}

function buildTailRequest(
  base: FileRpcRequest,
  fields: Record<string, unknown>
): FileRpcRequest | RelayNodeError {
  const maxBytes = boundedInteger(
    fields['maxBytes'],
    FILE_RPC_DEFAULT_TAIL_BYTES,
    FILE_RPC_MAX_TAIL_BYTES,
    'maxBytes'
  );
  if (typeof maxBytes !== 'number') return maxBytes;
  const maxLines = optionalBoundedInteger(fields['maxLines'], FILE_RPC_MAX_TAIL_LINES, 'maxLines');
  if (maxLines !== undefined && typeof maxLines !== 'number') return maxLines;
  const follow = optionalBoolean(fields['follow'], 'follow');
  if (typeof follow !== 'boolean') return follow;
  const maxFollowChunkBytes = boundedInteger(
    fields['maxFollowChunkBytes'],
    FILE_RPC_DEFAULT_FOLLOW_CHUNK_BYTES,
    FILE_RPC_MAX_FOLLOW_CHUNK_BYTES,
    'maxFollowChunkBytes'
  );
  if (typeof maxFollowChunkBytes !== 'number') return maxFollowChunkBytes;
  return {
    ...base,
    maxBytes,
    ...(maxLines !== undefined ? { maxLines } : {}),
    follow,
    maxFollowChunkBytes,
  };
}

export function normalizeHubFileRpcRequest(input: {
  operation: FileRpcOperation;
  nodePlatform?: string;
  nodeId: string;
  session: ScopedSessionSummary;
  body: Record<string, unknown>;
}): { ok: true; value: NormalizedHubFileRpcRequest } | { ok: false; error: RelayNodeError } {
  const api = pathApiForPlatform(input.nodePlatform);
  const rootRaw = resolveRoot(input.session);
  if (typeof rootRaw !== 'string') return { ok: false, error: rootRaw };
  const bodyPath = input.body['path'];
  const pathRaw = bodyPath === undefined || bodyPath === null ? '.' : nonEmptyString(bodyPath);
  if (!pathRaw) {
    return {
      ok: false,
      error: invalidRequest('FILE_RPC_INVALID_REQUEST', 'path must be a non-empty string when set', {
        field: 'path',
      }),
    };
  }
  const cwdRaw = nonEmptyString(input.body['cwd']) ?? input.session.scope.cwd ?? rootRaw;
  if (hasNul(rootRaw) || hasNul(cwdRaw) || hasNul(pathRaw)) {
    return {
      ok: false,
      error: invalidRequest('FILE_RPC_INVALID_REQUEST', 'paths must not contain NUL bytes'),
    };
  }
  const root = api.resolve(rootRaw);
  const cwd = api.isAbsolute(cwdRaw) ? api.resolve(cwdRaw) : api.resolve(root, cwdRaw);
  if (!pathInside(root, cwd, api)) {
    return {
      ok: false,
      error: invalidRequest('FILE_RPC_CWD_ESCAPE', 'cwd is outside the scoped filesystem root', {
        root,
        cwd,
      }),
    };
  }
  const target = api.isAbsolute(pathRaw) ? api.resolve(pathRaw) : api.resolve(cwd, pathRaw);
  if (!pathInside(root, target, api)) {
    return {
      ok: false,
      error: invalidRequest('FILE_RPC_ROOT_ESCAPE', 'path is outside the scoped filesystem root', {
        root,
        cwd,
        path: target,
      }),
    };
  }

  const base: FileRpcRequest = {
    sessionId: input.session.sessionId,
    root,
    cwd,
    path: target,
  };
  const request = buildOperationRequest(input.operation, base, input.body);
  if ('code' in request) return { ok: false, error: request };

  return {
    ok: true,
    value: {
      request,
      policyScope: {
        kind: input.session.scope.kind,
        nodeId: input.nodeId,
        cwd,
        path: target,
        ...(input.session.scope.repoPath ? { repoPath: input.session.scope.repoPath } : {}),
        ...(input.session.scope.worktreePath !== undefined
          ? { worktreePath: input.session.scope.worktreePath }
          : {}),
      },
    },
  };
}

function parseFileRpcRequest(raw: unknown, operation: FileRpcOperation): FileRpcRequest | RelayNodeError {
  const record = asRecord(raw);
  if (!record) return invalidRequest('FILE_RPC_INVALID_REQUEST', 'file RPC payload must be an object');
  const sessionId = nonEmptyString(record['sessionId']);
  const root = nonEmptyString(record['root']);
  const cwd = nonEmptyString(record['cwd']);
  const requestPath = nonEmptyString(record['path']);
  if (!sessionId || !root || !cwd || !requestPath) {
    return invalidRequest(
      'FILE_RPC_INVALID_REQUEST',
      'file RPC payload requires sessionId, root, cwd, and path'
    );
  }
  if (hasNul(sessionId) || hasNul(root) || hasNul(cwd) || hasNul(requestPath)) {
    return invalidRequest('FILE_RPC_INVALID_REQUEST', 'file RPC payload paths must not contain NUL bytes');
  }
  const base: FileRpcRequest = { sessionId, root, cwd, path: requestPath };
  return buildOperationRequest(operation, base, record);
}

function entryType(stats: Stats): FileRpcStat['type'] {
  if (stats.isDirectory()) return 'directory';
  if (stats.isFile()) return 'file';
  if (stats.isSymbolicLink()) return 'symlink';
  return 'other';
}

function statPayload(targetPath: string, stats: Stats): FileRpcStat {
  return {
    path: targetPath,
    name: path.basename(targetPath),
    type: entryType(stats),
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    mode: stats.mode,
  };
}

async function realpathOrError(target: string, reasonCode: FileRpcDenialReason): Promise<string | RelayNodeError> {
  try {
    return await fs.realpath(target);
  } catch {
    if (reasonCode === 'FILE_RPC_ROOT_UNAVAILABLE') {
      return notFound(reasonCode, 'filesystem root is unavailable', { root: target });
    }
    return notFound('FILE_RPC_NOT_FOUND', 'file RPC path was not found', { path: target });
  }
}

async function normalizeNodeRequest(raw: unknown, operation: FileRpcOperation): Promise<FileRpcRequest | RelayNodeError> {
  const parsed = parseFileRpcRequest(raw, operation);
  if ('code' in parsed) return parsed;
  const root = path.resolve(parsed.root);
  const cwd = path.resolve(parsed.cwd);
  const target = path.resolve(parsed.path);
  if (!pathInside(root, cwd, path)) {
    return invalidRequest('FILE_RPC_CWD_ESCAPE', 'cwd is outside the scoped filesystem root', {
      root,
      cwd,
    });
  }
  if (!pathInside(root, target, path)) {
    return invalidRequest('FILE_RPC_ROOT_ESCAPE', 'path is outside the scoped filesystem root', {
      root,
      path: target,
    });
  }
  const realRoot = await realpathOrError(root, 'FILE_RPC_ROOT_UNAVAILABLE');
  if (typeof realRoot !== 'string') return realRoot;
  const realTarget = await realpathOrError(target, 'FILE_RPC_NOT_FOUND');
  if (typeof realTarget !== 'string') return realTarget;
  if (!pathInside(realRoot, realTarget, path)) {
    return invalidRequest('FILE_RPC_ROOT_ESCAPE', 'resolved path escapes the scoped filesystem root', {
      root: realRoot,
      path: realTarget,
    });
  }
  return { ...parsed, root, cwd, path: target };
}

async function executeList(request: FileRpcRequest): Promise<FileRpcListResponse | RelayNodeError> {
  const maxEntries = 'maxEntries' in request ? request.maxEntries : FILE_RPC_DEFAULT_LIST_ENTRIES;
  let stats: Stats;
  try {
    stats = await fs.stat(request.path);
  } catch {
    return notFound('FILE_RPC_NOT_FOUND', 'directory was not found', { path: request.path });
  }
  if (!stats.isDirectory()) {
    return invalidRequest('FILE_RPC_NOT_DIRECTORY', 'path is not a directory', { path: request.path });
  }
  const dirents = (await fs.readdir(request.path, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  const entries: FileRpcStat[] = [];
  for (const dirent of dirents.slice(0, maxEntries)) {
    const entryPath = path.join(request.path, dirent.name);
    try {
      entries.push(statPayload(entryPath, await fs.lstat(entryPath)));
    } catch {
      // Directory changed between readdir and stat; skip the vanishing entry.
    }
  }
  return {
    operation: 'list',
    root: request.root,
    cwd: request.cwd,
    path: request.path,
    entries,
    truncated: dirents.length > maxEntries,
    maxEntries,
  };
}

async function executeStat(request: FileRpcRequest): Promise<FileRpcStatResponse | RelayNodeError> {
  try {
    const stats = await fs.lstat(request.path);
    return {
      operation: 'stat',
      root: request.root,
      cwd: request.cwd,
      path: request.path,
      stat: statPayload(request.path, stats),
    };
  } catch {
    return notFound('FILE_RPC_NOT_FOUND', 'path was not found', { path: request.path });
  }
}

async function executeRead(request: FileRpcRequest): Promise<FileRpcReadResponse | RelayNodeError> {
  const maxBytes = 'maxBytes' in request ? request.maxBytes : FILE_RPC_DEFAULT_READ_BYTES;
  const maxLines = 'maxLines' in request ? request.maxLines : undefined;
  let stats: Stats;
  try {
    stats = await fs.stat(request.path);
  } catch {
    return notFound('FILE_RPC_NOT_FOUND', 'file was not found', { path: request.path });
  }
  if (!stats.isFile()) {
    return invalidRequest('FILE_RPC_NOT_FILE', 'path is not a regular file', { path: request.path });
  }
  const handle = await fs.open(request.path, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(maxBytes + 1, FILE_RPC_MAX_READ_BYTES + 1));
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const read = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
    }
    const visibleBytes = Math.min(bytesRead, maxBytes);
    let content = buffer.subarray(0, visibleBytes).toString('utf8');
    const truncatedBytes = bytesRead > maxBytes;
    let truncatedLines = false;
    if (maxLines !== undefined) {
      const lines = content.split('\n');
      if (lines.length > maxLines) {
        content = lines.slice(0, maxLines).join('\n');
        truncatedLines = true;
      }
    }
    return {
      operation: 'read',
      root: request.root,
      cwd: request.cwd,
      path: request.path,
      encoding: 'utf8',
      content,
      bytesRead: visibleBytes,
      truncatedBytes,
      truncatedLines,
      maxBytes,
      ...(maxLines !== undefined ? { maxLines } : {}),
    };
  } finally {
    await handle.close();
  }
}

function tailTextByLines(content: string, maxLines: number | undefined): {
  content: string;
  truncatedLines: boolean;
} {
  if (maxLines === undefined) return { content, truncatedLines: false };
  const endsWithNewline = content.endsWith('\n');
  const lines = content.split('\n');
  if (endsWithNewline) lines.pop();
  if (lines.length <= maxLines) return { content, truncatedLines: false };
  const selected = lines.slice(-maxLines).join('\n');
  return {
    content: selected ? `${selected}${endsWithNewline ? '\n' : ''}` : '',
    truncatedLines: true,
  };
}

function isTailRequest(request: FileRpcRequest): request is FileRpcTailRequest {
  return 'follow' in request && 'maxFollowChunkBytes' in request;
}

async function executeTail(request: FileRpcRequest): Promise<FileRpcTailResponse | RelayNodeError> {
  if (!isTailRequest(request)) {
    return invalidRequest('FILE_RPC_INVALID_REQUEST', 'tail request requires follow bounds');
  }
  let stats: Stats;
  try {
    stats = await fs.stat(request.path);
  } catch {
    return notFound('FILE_RPC_NOT_FOUND', 'file was not found', { path: request.path });
  }
  if (!stats.isFile()) {
    return invalidRequest('FILE_RPC_NOT_FILE', 'path is not a regular file', { path: request.path });
  }
  const bytesToRead = Math.min(request.maxBytes, stats.size);
  const startOffset = Math.max(0, stats.size - bytesToRead);
  const handle = await fs.open(request.path, 'r');
  try {
    const buffer = Buffer.alloc(bytesToRead);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const read = await handle.read(buffer, bytesRead, buffer.length - bytesRead, startOffset + bytesRead);
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
    }
    const visible = buffer.subarray(0, bytesRead);
    const lineResult = tailTextByLines(visible.toString('utf8'), request.maxLines);
    return {
      operation: 'tail',
      root: request.root,
      cwd: request.cwd,
      path: request.path,
      encoding: 'utf8',
      content: lineResult.content,
      bytesRead,
      startOffset,
      endOffset: startOffset + bytesRead,
      fileSize: stats.size,
      truncatedBytes: startOffset > 0,
      truncatedLines: lineResult.truncatedLines,
      follow: request.follow,
      maxBytes: request.maxBytes,
      ...(request.maxLines !== undefined ? { maxLines: request.maxLines } : {}),
      maxFollowChunkBytes: request.maxFollowChunkBytes,
    };
  } finally {
    await handle.close();
  }
}

export interface FileRpcFollower {
  close(): void;
}

export function createFileRpcFollower(options: {
  request: Pick<FileRpcTailRequest, 'path' | 'maxFollowChunkBytes'>;
  startOffset: number;
  write: (chunk: FileRpcTailChunk) => void;
  onError?: (error: Error) => void;
  pollIntervalMs?: number;
}): FileRpcFollower {
  let offset = options.startOffset;
  let closed = false;
  let active = false;
  const pollIntervalMs = options.pollIntervalMs ?? 500;

  const poll = async (): Promise<void> => {
    if (closed || active) return;
    active = true;
    try {
      const stats = await fs.stat(options.request.path);
      if (!stats.isFile()) return;
      if (stats.size < offset) offset = 0;
      if (stats.size <= offset) return;
      const appendedBytes = stats.size - offset;
      const skippedBytes = Math.max(0, appendedBytes - options.request.maxFollowChunkBytes);
      const startOffset = offset + skippedBytes;
      const bytesToRead = stats.size - startOffset;
      const handle = await fs.open(options.request.path, 'r');
      try {
        const buffer = Buffer.alloc(bytesToRead);
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
          const read = await handle.read(
            buffer,
            bytesRead,
            buffer.length - bytesRead,
            startOffset + bytesRead
          );
          if (read.bytesRead === 0) break;
          bytesRead += read.bytesRead;
        }
        offset = stats.size;
        if (bytesRead > 0 && !closed) {
          options.write({
            operation: 'tail',
            path: options.request.path,
            encoding: 'utf8',
            content: buffer.subarray(0, bytesRead).toString('utf8'),
            bytesRead,
            startOffset,
            endOffset: startOffset + bytesRead,
            fileSize: stats.size,
            truncatedBytes: skippedBytes > 0,
            skippedBytes,
            maxFollowChunkBytes: options.request.maxFollowChunkBytes,
          });
        }
      } finally {
        await handle.close();
      }
    } catch (error) {
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
      closed = true;
      clearInterval(timer);
    } finally {
      active = false;
    }
  };

  const timer = setInterval(() => void poll(), pollIntervalMs);
  timer.unref?.();
  return {
    close() {
      closed = true;
      clearInterval(timer);
    },
  };
}

export async function executeLocalFileRpc(
  operation: FileRpcOperation,
  raw: unknown
): Promise<FileRpcResponse | RelayNodeError> {
  const request = await normalizeNodeRequest(raw, operation);
  if ('code' in request) return request;
  if (operation === 'list') return await executeList(request);
  if (operation === 'stat') return await executeStat(request);
  if (operation === 'tail') return await executeTail(request);
  return await executeRead(request);
}
