export const FILE_RPC_MAX_LIST_ENTRIES = 500;
export const FILE_RPC_DEFAULT_LIST_ENTRIES = 100;
export const FILE_RPC_MAX_READ_BYTES = 64 * 1024;
export const FILE_RPC_DEFAULT_READ_BYTES = 32 * 1024;
export const FILE_RPC_MAX_READ_LINES = 2_000;
export const FILE_RPC_MAX_TAIL_BYTES = 64 * 1024;
export const FILE_RPC_DEFAULT_TAIL_BYTES = 32 * 1024;
export const FILE_RPC_MAX_TAIL_LINES = 2_000;
export const FILE_RPC_MAX_FOLLOW_CHUNK_BYTES = 64 * 1024;
export const FILE_RPC_DEFAULT_FOLLOW_CHUNK_BYTES = 16 * 1024;
export const FILE_RPC_MAX_WRITE_BYTES = 1024 * 1024; // 1 MB

export type FileRpcOperation = 'list' | 'stat' | 'read' | 'tail' | 'write';

export const FILE_RPC_OPERATIONS = ['list', 'stat', 'read', 'tail', 'write'] as const satisfies readonly FileRpcOperation[];

export type FileRpcDenialReason =
  | 'FILE_RPC_EXPECTED_HASH_MISMATCH'
  | 'FILE_RPC_EXPECTED_HASH_REQUIRED'
  | 'FILE_RPC_FOLLOW_BACKPRESSURE'
  | 'FILE_RPC_INVALID_REQUEST'
  | 'FILE_RPC_NOT_DIRECTORY'
  | 'FILE_RPC_NOT_FILE'
  | 'FILE_RPC_NOT_FOUND'
  | 'FILE_RPC_OVERWRITE_REQUIRED'
  | 'FILE_RPC_ROOT_ESCAPE'
  | 'FILE_RPC_ROOT_UNAVAILABLE'
  | 'FILE_RPC_SESSION_REQUIRED'
  | 'FILE_RPC_SIZE_LIMIT_EXCEEDED'
  | 'FILE_RPC_CWD_ESCAPE'
  | 'FILE_RPC_WRITE_CROSS_DEVICE'
  | 'FILE_RPC_WRITE_NO_SPACE'
  | 'FILE_RPC_WRITE_PERMISSION_DENIED'
  | 'FILE_RPC_WRITE_SIZE_EXCEEDED'
  | 'FILE_RPC_WRITE_SOURCE_TOO_LARGE'
  | 'FILE_RPC_WRITE_SYMLINK_ESCAPE'
  | 'FILE_RPC_WRITE_THROUGH_SYMLINK';

export type FileRpcEntryType = 'file' | 'directory' | 'symlink' | 'other';

export interface FileRpcBaseRequest {
  sessionId: string;
  root: string;
  cwd: string;
  path: string;
}

export interface FileRpcListRequest extends FileRpcBaseRequest {
  maxEntries: number;
}

export type FileRpcStatRequest = FileRpcBaseRequest;

export interface FileRpcReadRequest extends FileRpcBaseRequest {
  maxBytes: number;
  maxLines?: number;
}

export interface FileRpcTailRequest extends FileRpcBaseRequest {
  maxBytes: number;
  maxLines?: number;
  follow: boolean;
  maxFollowChunkBytes: number;
}

export type FileRpcWriteMode = 'create' | 'overwrite' | 'append';

export interface FileRpcWriteRequest extends FileRpcBaseRequest {
  operation: 'write';
  mode: FileRpcWriteMode;
  contentBase64: string;
  expectedHash?: string;       // required when mode === 'overwrite'
  // mtimeOk was removed: mtime-based optimistic concurrency deferred (follow-up issue)
  permissions?: number;        // POSIX bits; clamped to 0o777 at handler
}

export type FileRpcRequest =
  | FileRpcListRequest
  | FileRpcStatRequest
  | FileRpcReadRequest
  | FileRpcTailRequest
  | FileRpcWriteRequest;

export interface FileRpcStat {
  path: string;
  name: string;
  type: FileRpcEntryType;
  size: number;
  mtimeMs: number;
  mode: number;
}

export interface FileRpcListResponse {
  operation: 'list';
  root: string;
  cwd: string;
  path: string;
  entries: FileRpcStat[];
  truncated: boolean;
  maxEntries: number;
}

export interface FileRpcStatResponse {
  operation: 'stat';
  root: string;
  cwd: string;
  path: string;
  stat: FileRpcStat;
}

export interface FileRpcReadResponse {
  operation: 'read';
  root: string;
  cwd: string;
  path: string;
  encoding: 'utf8';
  content: string;
  bytesRead: number;
  truncatedBytes: boolean;
  truncatedLines: boolean;
  maxBytes: number;
  maxLines?: number;
}

export interface FileRpcTailResponse {
  operation: 'tail';
  root: string;
  cwd: string;
  path: string;
  encoding: 'utf8';
  content: string;
  bytesRead: number;
  startOffset: number;
  endOffset: number;
  fileSize: number;
  truncatedBytes: boolean;
  truncatedLines: boolean;
  follow: boolean;
  maxBytes: number;
  maxLines?: number;
  maxFollowChunkBytes: number;
}

export interface FileRpcTailChunk {
  operation: 'tail';
  path: string;
  encoding: 'utf8';
  content: string;
  bytesRead: number;
  startOffset: number;
  endOffset: number;
  fileSize: number;
  truncatedBytes: boolean;
  skippedBytes: number;
  maxFollowChunkBytes: number;
}

export interface FileRpcWriteResponse {
  operation: 'write';
  root: string;
  cwd: string;
  path: string;
  mode: FileRpcWriteMode;
  bytesWritten: number;
  newHash: string;             // sha256 hex of final on-disk content
  newMtime: string;
  created: boolean;            // true iff target did not exist prior
}

export type FileRpcResponse =
  | FileRpcListResponse
  | FileRpcStatResponse
  | FileRpcReadResponse
  | FileRpcTailResponse
  | FileRpcWriteResponse;

export function isFileRpcOperation(value: unknown): value is FileRpcOperation {
  return value === 'list' || value === 'stat' || value === 'read' || value === 'tail' || value === 'write';
}
