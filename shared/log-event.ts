// Structured log event schema for Relay's JSON Lines log substrate.
//
// One event per line in `relay-ide.jsonl`. The plaintext `relay-ide.log`
// remains the human-readable companion stream — both are written in lock
// step by `server/logger.ts` so existing consumers keep working while
// `logs.tail` and downstream filters get a typed surface to work with.

export const RELAY_LOG_EVENT_SCHEMA_VERSION = 1 as const;

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LOG_LEVEL_SET = new Set<string>(LOG_LEVELS);

const LEVEL_RANK: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

export interface StructuredLogEvent {
  /** Schema version. Bump on incompatible changes. */
  schemaVersion: typeof RELAY_LOG_EVENT_SCHEMA_VERSION;
  /** ISO-8601 timestamp in UTC. */
  ts: string;
  level: LogLevel;
  /** Stable subsystem tag (e.g. `node-link`, `pty-host`, `policy`). */
  subsystem: string;
  msg: string;
  /** Optional, free-form structured context. Keys are subsystem-defined. */
  ctx?: Record<string, unknown>;
}

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && LOG_LEVEL_SET.has(value);
}

export function logLevelAtLeast(level: LogLevel, minimum: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[minimum];
}

/**
 * Serialize a structured log event as a single JSON Lines record. The
 * output is exactly one line of UTF-8 JSON with no trailing newline; the
 * writer is responsible for line termination so callers can batch writes.
 */
export function serializeLogEvent(event: StructuredLogEvent): string {
  // Stable key order keeps grep-by-prefix workflows predictable.
  const ordered: Record<string, unknown> = {
    schemaVersion: event.schemaVersion,
    ts: event.ts,
    level: event.level,
    subsystem: event.subsystem,
    msg: event.msg,
  };
  if (event.ctx !== undefined) ordered['ctx'] = event.ctx;
  return JSON.stringify(ordered);
}

/**
 * Parse a single JSON Lines record. Returns `undefined` for malformed
 * lines so the reader can keep streaming without aborting on a corrupt
 * tail-end write.
 */
export function parseLogEvent(line: string): StructuredLogEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const schemaVersion = record['schemaVersion'];
  if (schemaVersion !== RELAY_LOG_EVENT_SCHEMA_VERSION) return undefined;
  const ts = record['ts'];
  const level = record['level'];
  const subsystem = record['subsystem'];
  const msg = record['msg'];
  if (
    typeof ts !== 'string' ||
    typeof subsystem !== 'string' ||
    typeof msg !== 'string' ||
    !isLogLevel(level)
  ) {
    return undefined;
  }
  const ctxRaw = record['ctx'];
  let ctx: Record<string, unknown> | undefined;
  if (ctxRaw !== undefined) {
    if (!ctxRaw || typeof ctxRaw !== 'object' || Array.isArray(ctxRaw)) {
      return undefined;
    }
    ctx = ctxRaw as Record<string, unknown>;
  }
  return ctx === undefined
    ? { schemaVersion: RELAY_LOG_EVENT_SCHEMA_VERSION, ts, level, subsystem, msg }
    : { schemaVersion: RELAY_LOG_EVENT_SCHEMA_VERSION, ts, level, subsystem, msg, ctx };
}

export interface LogEventFilter {
  /** Minimum level to include (inclusive). Defaults to `trace`. */
  level?: LogLevel;
  /** Subsystem tag exact match. */
  subsystem?: string;
  /**
   * ISO-8601 timestamp; only events with `ts > sinceTs` are kept. Invalid
   * timestamps make the filter reject everything so callers get clear
   * failure modes instead of a silent firehose.
   */
  sinceTs?: string;
}

export function logEventMatchesFilter(
  event: StructuredLogEvent,
  filter: LogEventFilter | undefined
): boolean {
  if (!filter) return true;
  if (filter.level && !logLevelAtLeast(event.level, filter.level)) return false;
  if (filter.subsystem && event.subsystem !== filter.subsystem) return false;
  if (filter.sinceTs) {
    const sinceMs = Date.parse(filter.sinceTs);
    if (!Number.isFinite(sinceMs)) return false;
    const eventMs = Date.parse(event.ts);
    if (!Number.isFinite(eventMs) || eventMs <= sinceMs) return false;
  }
  return true;
}
