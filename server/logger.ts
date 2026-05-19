import fs from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';
import {
  RELAY_LOG_EVENT_SCHEMA_VERSION,
  type StructuredLogEvent,
} from '../shared/log-event.js';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  trace(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

const LEVEL_RANK: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

function resolveMinLevel(): LogLevel {
  const raw = process.env.RELAY_LOG_LEVEL?.toLowerCase();
  if (raw === 'trace' || raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') {
    return raw;
  }
  return 'debug';
}

const MIN_LEVEL_RANK = LEVEL_RANK[resolveMinLevel()];

// ── File logging state ──────────────────────────────────────────────────────

const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB
let logStream: fs.WriteStream | null = null;
let logFilePath: string | null = null;
let currentLogSize = 0;

// #597: structured JSON Lines companion stream. Writes the same events
// as the plaintext log, one JSON object per line. Failures are
// swallowed — structured logging is best-effort and must never crash
// the caller's hot path.
let structuredStream: fs.WriteStream | null = null;
let structuredFilePath: string | null = null;
let structuredLogSize = 0;
const STRUCTURED_LOG_FILE = 'relay-ide.jsonl';

/**
 * Initialize file-based logging. Call once at server startup after config dir
 * is resolved. Logs are written to `<logDir>/relay-ide.log` and rotated to
 * `.old` when they exceed MAX_LOG_SIZE.
 *
 * Loggers created before this call still work (console-only).
 */
export function initFileLogging(logDir: string): void {
  fs.mkdirSync(logDir, { recursive: true });
  logFilePath = path.join(logDir, 'relay-ide.log');

  try {
    currentLogSize = fs.statSync(logFilePath).size;
  } catch {
    currentLogSize = 0;
  }

  rotateIfNeeded();
  logStream = fs.createWriteStream(logFilePath, { flags: 'a' });

  // #597: open the structured JSONL companion alongside plaintext. Both
  // streams rotate independently at 5MB so an oversized event burst on
  // one stream doesn't drop unrelated history on the other.
  structuredFilePath = path.join(logDir, STRUCTURED_LOG_FILE);
  try {
    structuredLogSize = fs.statSync(structuredFilePath).size;
  } catch {
    structuredLogSize = 0;
  }
  rotateStructuredIfNeeded();
  structuredStream = fs.createWriteStream(structuredFilePath, { flags: 'a' });
}

function rotateIfNeeded(): void {
  if (!logFilePath || currentLogSize < MAX_LOG_SIZE) return;
  const oldPath = logFilePath + '.old';
  try {
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    if (fs.existsSync(logFilePath)) fs.renameSync(logFilePath, oldPath);
  } catch {
    /* best effort */
  }
  currentLogSize = 0;
}

function writeToFile(line: string): void {
  if (!logStream || !logFilePath) return;
  logStream.write(line + '\n');
  currentLogSize += line.length + 1;
  if (currentLogSize >= MAX_LOG_SIZE) {
    logStream.end();
    rotateIfNeeded();
    logStream = fs.createWriteStream(logFilePath, { flags: 'a' });
  }
}

function rotateStructuredIfNeeded(): void {
  if (!structuredFilePath || structuredLogSize < MAX_LOG_SIZE) return;
  const oldPath = structuredFilePath + '.old';
  try {
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    if (fs.existsSync(structuredFilePath)) fs.renameSync(structuredFilePath, oldPath);
  } catch {
    /* best effort */
  }
  structuredLogSize = 0;
}

function writeStructuredEvent(event: StructuredLogEvent): void {
  if (!structuredStream || !structuredFilePath) return;
  const line = JSON.stringify({
    schemaVersion: event.schemaVersion,
    ts: event.ts,
    level: event.level,
    subsystem: event.subsystem,
    msg: event.msg,
    ...(event.ctx !== undefined ? { ctx: event.ctx } : {}),
  });
  try {
    structuredStream.write(line + '\n');
    structuredLogSize += line.length + 1;
    if (structuredLogSize >= MAX_LOG_SIZE) {
      structuredStream.end();
      rotateStructuredIfNeeded();
      structuredStream = fs.createWriteStream(structuredFilePath, { flags: 'a' });
    }
  } catch {
    /* best effort */
  }
}

// ── Logger factory ──────────────────────────────────────────────────────────

/**
 * Create a namespaced logger that prefixes all messages.
 * Writes to both console and the log file (if initialized).
 *
 * @param namespace - Namespace used in the log prefix.
 */
export function createLogger(namespace: string): Logger {
  const prefix = `[${namespace}]`;

  const log = (level: LogLevel, message: string, ...args: unknown[]): void => {
    if (LEVEL_RANK[level] < MIN_LEVEL_RANK) return;

    // trace is file-only to avoid stdout spam from raw payload dumps.
    if (level !== 'trace') {
      const consoleMethod = level === 'debug' ? 'debug' : level;
      // eslint-disable-next-line no-console
      console[consoleMethod](`${prefix} ${message}`, ...args);
    }

    const timestamp = new Date().toISOString();
    const formatted = args.length > 0 ? format(message, ...args) : message;
    writeToFile(
      `${timestamp} ${level.toUpperCase().padEnd(5)} ${prefix} ${formatted}`
    );
    writeStructuredEvent({
      schemaVersion: RELAY_LOG_EVENT_SCHEMA_VERSION,
      ts: timestamp,
      level,
      subsystem: namespace,
      msg: formatted,
    });
  };

  return {
    trace: (message: string, ...args: unknown[]) =>
      log('trace', message, ...args),
    debug: (message: string, ...args: unknown[]) =>
      log('debug', message, ...args),
    info: (message: string, ...args: unknown[]) =>
      log('info', message, ...args),
    warn: (message: string, ...args: unknown[]) =>
      log('warn', message, ...args),
    error: (message: string, ...args: unknown[]) =>
      log('error', message, ...args),
  };
}
