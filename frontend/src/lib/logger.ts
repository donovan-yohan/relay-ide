/**
 * Supported log levels for the frontend logger.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Minimal logger interface used by the frontend.
 */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

// ── Server relay (batched) ──────────────────────────────────────────────────

interface LogEntry {
  ts: string;
  level: LogLevel;
  ns: string;
  msg: string;
}

const relayQueue: LogEntry[] = [];
let relayTimer: ReturnType<typeof setTimeout> | null = null;
const RELAY_INTERVAL = 2000; // flush every 2s
const RELAY_MAX_BATCH = 50;

function scheduleRelay(): void {
  if (relayTimer !== null) return;
  relayTimer = setTimeout(flushRelay, RELAY_INTERVAL);
}

function flushRelay(): void {
  relayTimer = null;
  if (relayQueue.length === 0) return;
  const batch = relayQueue.splice(0, RELAY_MAX_BATCH);
  // Fire-and-forget — don't block the UI on log delivery
  fetch('/api/frontend-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(batch),
  }).catch(() => {
    /* best effort */
  });
  // If there's still more queued, schedule another flush
  if (relayQueue.length > 0) scheduleRelay();
}

function queueForRelay(
  level: LogLevel,
  namespace: string,
  message: string
): void {
  relayQueue.push({
    ts: new Date().toISOString(),
    level,
    ns: namespace,
    msg: message,
  });
  // Cap queue to prevent unbounded growth if server is unreachable
  if (relayQueue.length > 200) relayQueue.splice(0, relayQueue.length - 200);
  scheduleRelay();
}

// ── Logger factory ──────────────────────────────────────────────────────────

function formatArgs(message: string, args: unknown[]): string {
  if (args.length === 0) return message;
  let i = 0;
  const formatted = message.replace(/%[sdjo%]/g, (match) => {
    if (match === '%%') return '%';
    if (i >= args.length) return match;
    const arg = args[i++];
    switch (match) {
      case '%s':
        return String(arg);
      case '%d':
        return String(Number(arg));
      case '%j':
        try {
          return JSON.stringify(arg);
        } catch {
          return '[Circular]';
        }
      case '%o':
        try {
          return JSON.stringify(arg);
        } catch {
          return '[Circular]';
        }
      default:
        return match;
    }
  });
  // Append any remaining args
  const remaining = args.slice(i);
  if (remaining.length === 0) return formatted;
  return (
    formatted +
    ' ' +
    remaining
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ')
  );
}

/**
 * Creates a namespaced logger that prefixes each message with the namespace.
 * Writes to both browser console and relays to the server log file.
 *
 * @param namespace - Namespace to prepend to every log message.
 * @returns A logger that delegates to `console.*` and relays to server.
 */
export function createLogger(namespace: string): Logger {
  const prefix = `[${namespace}]`;

  const log = (level: LogLevel, message: string, ...args: unknown[]): void => {
    // eslint-disable-next-line no-console
    console[level](`${prefix} ${message}`, ...args);
    queueForRelay(level, namespace, formatArgs(message, args));
  };

  return {
    debug: (message, ...args) => log('debug', message, ...args),
    info: (message, ...args) => log('info', message, ...args),
    warn: (message, ...args) => log('warn', message, ...args),
    error: (message, ...args) => log('error', message, ...args),
  };
}
