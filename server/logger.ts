import fs from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

// ── File logging state ──────────────────────────────────────────────────────

const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB
let logStream: fs.WriteStream | null = null;
let logFilePath: string | null = null;
let currentLogSize = 0;

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
    // eslint-disable-next-line no-console
    console[level](`${prefix} ${message}`, ...args);

    const timestamp = new Date().toISOString();
    const formatted = args.length > 0 ? format(message, ...args) : message;
    writeToFile(
      `${timestamp} ${level.toUpperCase().padEnd(5)} ${prefix} ${formatted}`
    );
  };

  return {
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
