import * as path from 'node:path';
import * as service from './service.js';
import {
  createLocalLogFollower,
  parseLogLineCount,
  readLocalLogSnapshot,
  resolveLocalLogPlan,
  type LocalLogFollower,
  type LocalLogRole,
} from './local-logs.js';
import { redactJson, redactText } from './diagnostics-bundle.js';
import {
  readStructuredLogTail,
  structuredLogFilename,
} from './log-events.js';
import { isLogLevel, type StructuredLogEvent } from '../shared/log-event.js';
import type { LogEventFilter } from '../shared/log-event.js';
import type { RelayNodeError } from '../shared/relay-node-protocol.js';

export interface NodeLogTailRequest {
  lines: number;
  follow: boolean;
  /** Filter fields for the structured JSONL log. Omitted = no filter. */
  level?: LogEventFilter['level'];
  subsystem?: LogEventFilter['subsystem'];
  sinceTs?: LogEventFilter['sinceTs'];
}

export interface NodeLogTailSnapshot {
  status: 'ok' | 'empty';
  role: LocalLogRole;
  logDir: string;
  files: string[];
  output: string;
  message: string;
  redacted: boolean;
  /**
   * When the caller requests structured output (`structured: true`),
   * the JSONL log is read instead of the plaintext companion and parsed
   * events are returned here. `output` stays empty in that mode.
   */
  events?: StructuredLogEvent[];
  /** Lines in the JSONL file that failed schema validation. */
  malformedCount?: number;
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
  const out: NodeLogTailRequest = { lines, follow: rawFollow === true };
  if (record['level'] !== undefined) {
    if (!isLogLevel(record['level'])) {
      return invalidRequest(
        'logs.tail payload.level must be one of trace|debug|info|warn|error when set'
      );
    }
    out.level = record['level'];
  }
  if (record['subsystem'] !== undefined) {
    if (typeof record['subsystem'] !== 'string' || record['subsystem'].length === 0) {
      return invalidRequest('logs.tail payload.subsystem must be a non-empty string when set');
    }
    out.subsystem = record['subsystem'];
  }
  if (record['sinceTs'] !== undefined) {
    if (typeof record['sinceTs'] !== 'string') {
      return invalidRequest('logs.tail payload.sinceTs must be an ISO-8601 string when set');
    }
    const parsed = Date.parse(record['sinceTs']);
    if (!Number.isFinite(parsed)) {
      return invalidRequest('logs.tail payload.sinceTs must be a valid ISO-8601 timestamp');
    }
    out.sinceTs = record['sinceTs'];
  }
  return out;
}

export function parseCliNodeLogLineCount(value: string | undefined): number {
  const lines = parseLogLineCount(value, DEFAULT_REMOTE_LOG_LINES);
  if (lines > MAX_REMOTE_LOG_LINES) {
    throw new Error(`Invalid --lines value: ${value}. Expected <= ${MAX_REMOTE_LOG_LINES}.`);
  }
  return lines;
}

export interface ReadNodeLogTailSnapshotOptions {
  role?: LocalLogRole;
  configPath: string;
  serviceLogDir?: string | null;
  lines: number;
  /**
   * Read the structured JSONL log instead of the plaintext companion.
   * Defaults to false so legacy callers keep their plaintext behavior.
   */
  structured?: boolean;
  filter?: LogEventFilter | undefined;
}

export function readNodeLogTailSnapshot(
  options: ReadNodeLogTailSnapshotOptions
): NodeLogTailSnapshot | RelayNodeError {
  const role = options.role ?? 'node';
  if (options.structured) {
    return readStructuredSnapshot({ ...options, role });
  }
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

function readStructuredSnapshot(
  options: ReadNodeLogTailSnapshotOptions & { role: LocalLogRole }
): NodeLogTailSnapshot | RelayNodeError {
  const plan = resolveLocalLogPlan(options.configPath, options.serviceLogDir ?? undefined);
  // Each candidate log directory may carry its own JSONL stream; prefer
  // the service log dir if both exist so operator workflows match what
  // `relay-ide hub logs --follow` would surface today.
  const candidateDirs = uniqueDirsForFiles(plan.files);
  let chosenFile: string | undefined;
  for (const dir of candidateDirs) {
    const candidate = path.join(dir, structuredLogFilename());
    chosenFile = candidate;
    const result = readStructuredLogTail({
      logFile: candidate,
      maxEvents: options.lines,
      filter: options.filter,
    });
    if (result.status !== 'missing') {
      const redactedEvents = result.events.map((event) => redactEvent(event));
      const redactedAny = redactedEvents.some((entry) => entry.redacted);
      return {
        status: result.status === 'ok' ? 'ok' : 'empty',
        role: options.role,
        logDir: plan.logDir,
        files: [candidate],
        output: '',
        message: '',
        redacted: redactedAny,
        events: redactedEvents.map((entry) => entry.event),
        malformedCount: result.malformedCount,
      };
    }
  }
  return {
    code: 'NOT_FOUND',
    message: `Structured log file not found in ${plan.logDir}. Looked for ${structuredLogFilename()}.`,
    retryable: false,
    details: {
      logDir: plan.logDir,
      files: chosenFile ? [chosenFile] : [],
    },
  };
}

function uniqueDirsForFiles(files: string[]): string[] {
  return Array.from(new Set(files.map((file) => path.dirname(file))));
}

function redactEvent(event: StructuredLogEvent): {
  event: StructuredLogEvent;
  redacted: boolean;
} {
  const redactedMsg = redactText(event.msg);
  let redacted = Object.values(redactedMsg.counts).some((count) => count > 0);
  let ctx: Record<string, unknown> | undefined;
  if (event.ctx) {
    const ctxResult = redactJson(event.ctx);
    if (Object.values(ctxResult.counts).some((count) => count > 0)) redacted = true;
    ctx = ctxResult.value as Record<string, unknown>;
  }
  const out: StructuredLogEvent = {
    schemaVersion: event.schemaVersion,
    ts: event.ts,
    level: event.level,
    subsystem: event.subsystem,
    msg: redactedMsg.value,
  };
  if (ctx !== undefined) out.ctx = ctx;
  return { event: out, redacted };
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
