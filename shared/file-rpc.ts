export const FILE_RPC_MAX_LIST_ENTRIES = 500;
export const FILE_RPC_DEFAULT_LIST_ENTRIES = 100;
export const FILE_RPC_MAX_READ_BYTES = 64 * 1024;
export const FILE_RPC_DEFAULT_READ_BYTES = 32 * 1024;
export const FILE_RPC_MAX_READ_LINES = 2_000;

export type FileRpcOperation = 'list' | 'stat' | 'read';

export const FILE_RPC_OPERATIONS = ['list', 'stat', 'read'] as const satisfies readonly FileRpcOperation[];

export type FileRpcDenialReason =
  | 'FILE_RPC_INVALID_REQUEST'
  | 'FILE_RPC_SESSION_REQUIRED'
  | 'FILE_RPC_ROOT_UNAVAILABLE'
  | 'FILE_RPC_CWD_ESCAPE'
  | 'FILE_RPC_ROOT_ESCAPE'
  | 'FILE_RPC_NOT_FOUND'
  | 'FILE_RPC_NOT_DIRECTORY'
  | 'FILE_RPC_NOT_FILE'
  | 'FILE_RPC_SIZE_LIMIT_EXCEEDED';

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

export type FileRpcRequest = FileRpcListRequest | FileRpcStatRequest | FileRpcReadRequest;

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

export type FileRpcResponse = FileRpcListResponse | FileRpcStatResponse | FileRpcReadResponse;

export function isFileRpcOperation(value: unknown): value is FileRpcOperation {
  return value === 'list' || value === 'stat' || value === 'read';
}
