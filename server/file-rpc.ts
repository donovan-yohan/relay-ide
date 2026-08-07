import * as crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
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
  FileRpcWriteMode,
  FileRpcWriteRequest,
  FileRpcWriteResponse,
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
  FILE_RPC_MAX_WRITE_BYTES,
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
  if (operation === 'write') return buildWriteRequest(base, fields);
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
  const encodingRaw = fields['encoding'];
  if (
    encodingRaw !== undefined &&
    encodingRaw !== null &&
    encodingRaw !== 'utf8' &&
    encodingRaw !== 'base64'
  ) {
    return invalidRequest('FILE_RPC_INVALID_REQUEST', 'encoding must be "utf8" or "base64"', {
      field: 'encoding',
    });
  }
  const encoding = encodingRaw === 'base64' ? 'base64' : 'utf8';
  return {
    ...base,
    maxBytes,
    ...(maxLines !== undefined ? { maxLines } : {}),
    ...(encoding !== 'utf8' ? { encoding } : {}),
  };
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

function buildWriteRequest(
  base: FileRpcRequest,
  fields: Record<string, unknown>
): FileRpcRequest | RelayNodeError {
  const modeRaw = fields['mode'];
  if (modeRaw !== 'create' && modeRaw !== 'overwrite' && modeRaw !== 'append') {
    return invalidRequest('FILE_RPC_INVALID_REQUEST', 'mode must be "create", "overwrite", or "append"', {
      field: 'mode',
    });
  }
  const mode = modeRaw as FileRpcWriteMode;

  const contentBase64 = fields['contentBase64'];
  if (typeof contentBase64 !== 'string') {
    return invalidRequest('FILE_RPC_INVALID_REQUEST', 'contentBase64 must be a string', {
      field: 'contentBase64',
    });
  }

  // Validate base64 before decoding: Buffer.from(garbage, 'base64') silently
  // returns an empty buffer rather than throwing, so we must pre-validate.
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64) || contentBase64.length % 4 !== 0) {
    return fileRpcError('INVALID_REQUEST', 'FILE_RPC_INVALID_REQUEST', 'contentBase64 is malformed base64', {
      field: 'contentBase64',
      reason: 'malformed_base64',
    });
  }

  let buf: Buffer;
  try {
    buf = Buffer.from(contentBase64, 'base64');
  } catch {
    return fileRpcError('INVALID_REQUEST', 'FILE_RPC_INVALID_REQUEST', 'contentBase64 is not valid base64', {
      field: 'contentBase64',
      reason: 'malformed_base64',
    });
  }

  if (buf.length > FILE_RPC_MAX_WRITE_BYTES) {
    return fileRpcError('INVALID_REQUEST', 'FILE_RPC_WRITE_SIZE_EXCEEDED', 'write content exceeds 1 MB limit', {
      bytesDecoded: buf.length,
      maxBytes: FILE_RPC_MAX_WRITE_BYTES,
    });
  }

  if (mode === 'overwrite') {
    const expectedHash = fields['expectedHash'];
    if (!expectedHash || typeof expectedHash !== 'string' || expectedHash.trim() === '') {
      return fileRpcError('INVALID_REQUEST', 'FILE_RPC_EXPECTED_HASH_REQUIRED', 'expectedHash is required when mode is "overwrite"', {
        field: 'expectedHash',
      });
    }
  }

  const permissions = fields['permissions'];
  if (permissions !== undefined && permissions !== null) {
    if (!Number.isInteger(permissions) || typeof permissions !== 'number' || permissions < 0) {
      return invalidRequest('FILE_RPC_INVALID_REQUEST', 'permissions must be a non-negative integer when set', {
        field: 'permissions',
      });
    }
  }

  const req: FileRpcWriteRequest = {
    ...base,
    operation: 'write',
    mode,
    contentBase64,
    ...(mode === 'overwrite' && fields['expectedHash']
      ? { expectedHash: fields['expectedHash'] as string }
      : {}),
    ...(permissions !== undefined && permissions !== null ? { permissions: permissions as number } : {}),
  };
  return req;
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
  if (operation === 'write') {
    // Target may not yet exist (mode='create'). Realpath the parent directory
    // instead to prevent directory traversal. executeWrite re-validates via
    // post-write symlink check.
    const parentDir = path.dirname(target);
    const realParent = await realpathOrError(parentDir, 'FILE_RPC_NOT_FOUND');
    if (typeof realParent !== 'string') return realParent;
    if (!pathInside(realRoot, realParent, path)) {
      return invalidRequest('FILE_RPC_ROOT_ESCAPE', 'resolved parent dir escapes the scoped filesystem root', {
        root: realRoot,
        path: realParent,
      });
    }
    return { ...parsed, root, cwd, path: target };
  }
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
    const visibleBuffer = buffer.subarray(0, visibleBytes);
    const encoding = 'encoding' in request && request.encoding === 'base64' ? 'base64' : 'utf8';
    let content = encoding === 'base64' ? visibleBuffer.toString('base64') : visibleBuffer.toString('utf8');
    const truncatedBytes = bytesRead > maxBytes;
    let truncatedLines = false;
    if (encoding === 'utf8' && maxLines !== undefined) {
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
      encoding,
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
    content: `${selected}${endsWithNewline ? '\n' : ''}`,
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

const FILE_RPC_FOLLOW_WRITE_TIMEOUT_MS = 5_000;

function nodeErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function isRelayNodeError(error: unknown): error is RelayNodeError {
  const record = asRecord(error);
  return (
    typeof record?.['code'] === 'string' &&
    typeof record['message'] === 'string' &&
    typeof record['retryable'] === 'boolean'
  );
}

function followBackpressureError(
  message: string,
  details: Record<string, unknown> = {}
): RelayNodeError {
  return {
    code: 'NODE_BUSY',
    message,
    retryable: true,
    details: { reasonCode: 'FILE_RPC_FOLLOW_BACKPRESSURE', ...details },
  };
}

async function withFileRpcWriteTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  details: Record<string, unknown>
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            followBackpressureError('file follow writer did not drain before timeout', {
              timeoutMs,
              ...details,
            })
          );
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createFileRpcFollower(options: {
  request: Pick<FileRpcTailRequest, 'path' | 'maxFollowChunkBytes'>;
  startOffset: number;
  write: (chunk: FileRpcTailChunk) => void | Promise<void>;
  onError?: (error: RelayNodeError) => void;
  pollIntervalMs?: number;
  writeTimeoutMs?: number;
}): FileRpcFollower {
  let offset = options.startOffset;
  let closed = false;
  let active = false;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const writeTimeoutMs = options.writeTimeoutMs ?? FILE_RPC_FOLLOW_WRITE_TIMEOUT_MS;

  const closeWithError = (error: RelayNodeError): void => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    options.onError?.(error);
  };

  const poll = async (): Promise<void> => {
    if (closed || active) return;
    active = true;
    try {
      const stats = await fs.stat(options.request.path);
      if (!stats.isFile()) {
        closeWithError(
          invalidRequest('FILE_RPC_NOT_FILE', 'path is no longer a regular file', {
            path: options.request.path,
          })
        );
        return;
      }
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
        if (bytesRead > 0 && !closed) {
          const chunk: FileRpcTailChunk = {
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
          };
          await withFileRpcWriteTimeout(Promise.resolve(options.write(chunk)), writeTimeoutMs, {
            path: options.request.path,
            startOffset,
            endOffset: startOffset + bytesRead,
            bytesRead,
          });
        }
        offset = stats.size;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (isRelayNodeError(error)) {
        closeWithError(error);
        return;
      }
      if (nodeErrorCode(error) === 'ENOENT') {
        closeWithError(
          notFound('FILE_RPC_NOT_FOUND', 'followed file was not found', {
            path: options.request.path,
          })
        );
      } else {
        closeWithError({
          code: 'INTERNAL',
          message: error instanceof Error ? error.message : String(error ?? 'unknown'),
          retryable: false,
        });
      }
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

function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// 100 MB: files larger than this will not be read into memory for hashing.
const FILE_RPC_MAX_SOURCE_READ_BYTES = 100 * 1024 * 1024;

/**
 * Hash a file via streaming so arbitrarily large source files do not OOM the
 * process. Returns the hex digest, or a RelayNodeError if the file is too
 * large (> 100 MB) or cannot be opened/read.
 */
async function streamHash(filePath: string): Promise<{ hex: string } | RelayNodeError> {
  let stat: Stats;
  try {
    stat = await fs.stat(filePath);
  } catch (err) {
    return mapWriteErrno(err);
  }
  if (stat.size > FILE_RPC_MAX_SOURCE_READ_BYTES) {
    return fileRpcError('INVALID_REQUEST', 'FILE_RPC_WRITE_SOURCE_TOO_LARGE',
      `source file exceeds ${FILE_RPC_MAX_SOURCE_READ_BYTES} byte hash limit`, {
        size: stat.size,
        max: FILE_RPC_MAX_SOURCE_READ_BYTES,
        path: filePath,
      });
  }
  return new Promise((resolve) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve({ hex: hash.digest('hex') }));
    stream.on('error', (err) => resolve(mapWriteErrno(err)));
  });
}

function mapWriteErrno(err: unknown): RelayNodeError {
  const code = nodeErrorCode(err);
  const message = err instanceof Error ? err.message : String(err ?? 'unknown');
  const errno = code;
  if (code === 'EACCES' || code === 'EROFS' || code === 'EPERM') {
    return fileRpcError('FORBIDDEN', 'FILE_RPC_WRITE_PERMISSION_DENIED', `write permission denied: ${message}`, { errno });
  }
  if (code === 'EXDEV') {
    return fileRpcError('INTERNAL', 'FILE_RPC_WRITE_CROSS_DEVICE', `cross-device rename: ${message}`, { errno });
  }
  if (code === 'ENOSPC') {
    return { code: 'INTERNAL', message: `no space left on device: ${message}`, retryable: true, details: { reasonCode: 'FILE_RPC_WRITE_NO_SPACE', errno } };
  }
  if (code === 'EBUSY' || code === 'EAGAIN' || code === 'ETIMEDOUT') {
    return { code: 'INTERNAL', message, retryable: true, details: { reasonCode: 'FILE_RPC_INVALID_REQUEST', errno } };
  }
  return { code: 'INTERNAL', message, retryable: false, details: { errno } };
}

function isWriteRequest(request: FileRpcRequest): request is FileRpcWriteRequest {
  return 'operation' in request && (request as FileRpcWriteRequest).operation === 'write';
}

async function executeWriteAppend(
  request: FileRpcWriteRequest,
  buf: Buffer,
  perms: number,
  realRoot: string,
  existed: boolean
): Promise<FileRpcWriteResponse | RelayNodeError> {
  let handle: import('node:fs/promises').FileHandle | undefined;
  let appendErr: unknown;
  try {
    // O_NOFOLLOW | O_APPEND | O_WRONLY | O_CREAT — fails with ELOOP if path is a symlink.
    const flags = fsConstants.O_NOFOLLOW | fsConstants.O_APPEND | fsConstants.O_WRONLY | fsConstants.O_CREAT;
    handle = await fs.open(request.path, flags, perms);
    await handle.write(buf);
    await handle.sync();
  } catch (err) {
    appendErr = err;
  } finally {
    // Close the handle without letting a close error replace the write error.
    await handle?.close().catch((closeErr: unknown) => { void closeErr; });
  }
  if (appendErr !== undefined) {
    const errCode = nodeErrorCode(appendErr);
    if (errCode === 'ELOOP' || errCode === 'ENOTDIR') {
      return fileRpcError('INVALID_REQUEST', 'FILE_RPC_WRITE_SYMLINK_ESCAPE', 'refusing to append through a symlink', {
        path: request.path,
        errno: errCode,
      });
    }
    return mapWriteErrno(appendErr);
  }

  // Post-write symlink escape check
  try {
    const realTarget = await fs.realpath(request.path);
    if (!pathInside(realRoot, realTarget, path)) {
      return fileRpcError('INVALID_REQUEST', 'FILE_RPC_WRITE_SYMLINK_ESCAPE', 'write target resolved outside the scoped filesystem root', {
        root: realRoot,
        resolvedPath: realTarget,
      });
    }
  } catch {
    // If realpath fails after write, the file likely vanished — treat as success
  }

  // Stream the post-write hash to avoid reading arbitrarily large files into memory
  const postHash = await streamHash(request.path);
  if ('code' in postHash) return postHash;
  let postStat: Stats;
  try {
    postStat = await fs.stat(request.path);
  } catch (err) {
    return mapWriteErrno(err);
  }
  return {
    operation: 'write',
    root: request.root,
    cwd: request.cwd,
    path: request.path,
    mode: request.mode,
    bytesWritten: buf.length,
    newHash: postHash.hex,
    newMtime: new Date(postStat.mtimeMs).toISOString(),
    created: !existed,
  };
}

async function executeWrite(request: FileRpcRequest): Promise<FileRpcWriteResponse | RelayNodeError> {
  if (!isWriteRequest(request)) {
    return invalidRequest('FILE_RPC_INVALID_REQUEST', 'write request is malformed');
  }

  // Defense-in-depth: re-validate base64 at the executor boundary (buildWriteRequest
  // already validates, but this catches any path that bypasses buildWriteRequest).
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(request.contentBase64) || request.contentBase64.length % 4 !== 0) {
    return fileRpcError('INVALID_REQUEST', 'FILE_RPC_INVALID_REQUEST', 'contentBase64 is malformed base64', {
      field: 'contentBase64',
      reason: 'malformed_base64',
    });
  }
  const buf = Buffer.from(request.contentBase64, 'base64');
  const perms = request.permissions !== undefined ? (request.permissions & 0o777) : 0o666;

  // Realpath root for post-write symlink escape checks (handles /tmp -> /private/tmp on macOS).
  // If root realpath fails (e.g. the scoped root directory itself is gone), refuse the write
  // rather than silently comparing unresolved-root vs resolved-target — that could either
  // trigger a false-positive escape that rolls back a valid write, or miss a real escape.
  let realRoot: string;
  try {
    realRoot = await fs.realpath(request.root);
  } catch (rootErr) {
    return fileRpcError(
      'INTERNAL',
      'FILE_RPC_ROOT_UNAVAILABLE',
      `scoped filesystem root is unavailable: ${rootErr instanceof Error ? rootErr.message : String(rootErr ?? 'unknown')}`,
      { root: request.root, errno: nodeErrorCode(rootErr) }
    );
  }

  let st: import('node:fs').Stats | null = null;
  try {
    st = await fs.lstat(request.path);
  } catch (err) {
    if (nodeErrorCode(err) === 'ENOENT') {
      // Expected: file does not exist; st remains null
    } else {
      return mapWriteErrno(err);
    }
  }

  const existed = st !== null;

  if (st && !st.isFile() && !st.isSymbolicLink()) {
    return invalidRequest('FILE_RPC_NOT_FILE', 'path exists but is not a regular file or symlink', {
      path: request.path,
    });
  }

  // Refuse to overwrite a symlink: rename(tmp, symlink) would replace the
  // directory entry, destroying the symlink and losing the original target.
  if (st && st.isSymbolicLink() && (request.mode === 'create' || request.mode === 'overwrite')) {
    return fileRpcError(
      'INVALID_REQUEST',
      'FILE_RPC_WRITE_THROUGH_SYMLINK',
      'refusing to overwrite a symlink; remove and recreate the file explicitly',
      { path: request.path }
    );
  }

  if (request.mode === 'create' && existed) {
    return fileRpcError('INVALID_REQUEST', 'FILE_RPC_OVERWRITE_REQUIRED', 'file already exists; use mode "overwrite" to replace it', {
      path: request.path,
    });
  }

  if (request.mode === 'overwrite' && existed) {
    // Stream-hash the existing content to avoid reading arbitrarily large files into memory.
    const currentHashResult = await streamHash(request.path);
    if ('code' in currentHashResult) return currentHashResult;
    const currentHash = currentHashResult.hex;
    if (currentHash !== request.expectedHash) {
      return fileRpcError('INVALID_REQUEST', 'FILE_RPC_EXPECTED_HASH_MISMATCH', 'file content has changed since the expectedHash was computed', {
        expectedHash: request.expectedHash,
        actualHash: currentHash,
        path: request.path,
      });
    }
  }

  // append: open with O_NOFOLLOW so a symlink at request.path cannot redirect
  // bytes to an out-of-scope target before the post-write escape check fires.
  if (request.mode === 'append') {
    return executeWriteAppend(request, buf, perms, realRoot, existed);
  }

  // create / overwrite: atomic rename via tmp file in same directory
  const tmpPath = path.join(
    path.dirname(request.path),
    '.relay-fs-write-' + crypto.randomBytes(4).toString('hex') + '.tmp'
  );

  let handle: import('node:fs/promises').FileHandle | undefined;
  try {
    handle = await fs.open(tmpPath, 'wx', perms);
    await handle.write(buf);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tmpPath, request.path);
  } catch (err) {
    await handle?.close().catch(() => {});
    await fs.unlink(tmpPath).catch(() => {});
    return mapWriteErrno(err);
  }

  // Post-write symlink escape check
  try {
    const realTarget = await fs.realpath(request.path);
    if (!pathInside(realRoot, realTarget, path)) {
      // Rollback: if we just created the file, remove it
      if (!existed) await fs.unlink(request.path).catch(() => {});
      return fileRpcError('INVALID_REQUEST', 'FILE_RPC_WRITE_SYMLINK_ESCAPE', 'write target resolved outside the scoped filesystem root', {
        root: realRoot,
        resolvedPath: realTarget,
      });
    }
  } catch {
    // realpath failure after write — treat as success
  }

  let postStat: Stats;
  try {
    postStat = await fs.stat(request.path);
  } catch (err) {
    return mapWriteErrno(err);
  }
  return {
    operation: 'write',
    root: request.root,
    cwd: request.cwd,
    path: request.path,
    mode: request.mode,
    bytesWritten: buf.length,
    newHash: sha256Hex(buf),
    newMtime: new Date(postStat.mtimeMs).toISOString(),
    created: !existed,
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
  if (operation === 'write') return await executeWrite(request);
  return await executeRead(request);
}
