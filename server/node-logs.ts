import * as service from './service.js';
import {
  createLocalLogFollower,
  parseLogLineCount,
  readLocalLogSnapshot,
  resolveLocalLogPlan,
  type LocalLogFollower,
  type LocalLogRole,
} from './local-logs.js';
import { redactText } from './diagnostics-bundle.js';
import type { RelayNodeError } from '../shared/relay-node-protocol.js';

export interface NodeLogTailRequest {
  lines: number;
  follow: boolean;
}

export interface NodeLogTailSnapshot {
  status: 'ok' | 'empty';
  role: LocalLogRole;
  logDir: string;
  files: string[];
  output: string;
  message: string;
  redacted: boolean;
}

export interface NodeLogFollower {
  files: string[];
  close(): void;
}

const DEFAULT_REMOTE_LOG_LINES = 100;
const MAX_REMOTE_LOG_LINES = 2_000;

export function parseNodeLogTailRequest(raw: unknown): NodeLogTailRequest | RelayNodeError {
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const rawLines = record['lines'];
  let lines = DEFAULT_REMOTE_LOG_LINES;
  if (rawLines !== undefined) {
    if (typeof rawLines !== 'number' || !Number.isInteger(rawLines) || rawLines < 0) {
      return invalidRequest('logs.tail payload.lines must be a non-negative integer');
    }
    if (rawLines > MAX_REMOTE_LOG_LINES) {
      return invalidRequest(`logs.tail payload.lines must be <= ${MAX_REMOTE_LOG_LINES}`);
    }
    lines = rawLines;
  }
  const rawFollow = record['follow'];
  if (rawFollow !== undefined && typeof rawFollow !== 'boolean') {
    return invalidRequest('logs.tail payload.follow must be boolean when set');
  }
  return { lines, follow: rawFollow === true };
}

export function parseCliNodeLogLineCount(value: string | undefined): number {
  const lines = parseLogLineCount(value, DEFAULT_REMOTE_LOG_LINES);
  if (lines > MAX_REMOTE_LOG_LINES) {
    throw new Error(`Invalid --lines value: ${value}. Expected <= ${MAX_REMOTE_LOG_LINES}.`);
  }
  return lines;
}

export function readNodeLogTailSnapshot(options: {
  role?: LocalLogRole;
  configPath: string;
  serviceLogDir?: string | null;
  lines: number;
}): NodeLogTailSnapshot | RelayNodeError {
  const role = options.role ?? 'node';
  const snapshotOptions: {
    role: LocalLogRole;
    configPath: string;
    serviceLogDir?: string | null;
    lines: number;
  } = {
    role,
    configPath: options.configPath,
    lines: options.lines,
  };
  if (options.serviceLogDir !== undefined) {
    snapshotOptions.serviceLogDir = options.serviceLogDir;
  }
  const snapshot = readLocalLogSnapshot(snapshotOptions);
  if (snapshot.status === 'missing') {
    return {
      code: 'NOT_FOUND',
      message: snapshot.message,
      retryable: false,
      details: { logDir: snapshot.logDir, files: snapshot.files },
    };
  }
  const redactedOutput = redactText(snapshot.output);
  const redactedMessage = redactText(snapshot.message);
  return {
    status: snapshot.status === 'ok' ? 'ok' : 'empty',
    role,
    logDir: snapshot.logDir,
    files: snapshot.files,
    output: redactedOutput.value,
    message: redactedMessage.value,
    redacted:
      Object.values(redactedOutput.counts).some((count) => count > 0) ||
      Object.values(redactedMessage.counts).some((count) => count > 0),
  };
}

export function createNodeLogFollower(options: {
  configPath: string;
  serviceLogDir?: string | null;
  write: (chunk: string) => void;
  onError?: (error: Error) => void;
}): NodeLogFollower {
  const plan = resolveLocalLogPlan(options.configPath, options.serviceLogDir);
  const followerOptions: {
    files: string[];
    write: (chunk: string) => void;
    onError?: (error: Error) => void;
  } = {
    files: plan.files,
    write: (chunk) => options.write(redactText(chunk).value),
  };
  if (options.onError !== undefined) {
    followerOptions.onError = options.onError;
  }
  const follower: LocalLogFollower = createLocalLogFollower(followerOptions);
  return follower;
}

export function defaultNodeLogRuntime(): { configPath: string; serviceLogDir: string | null } {
  return {
    configPath: `${service.CONFIG_DIR}/config.json`,
    serviceLogDir: service.getServicePaths().logDir,
  };
}

function invalidRequest(message: string): RelayNodeError {
  return { code: 'INVALID_REQUEST', message, retryable: false };
}
