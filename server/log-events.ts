import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  logEventMatchesFilter,
  parseLogEvent,
  serializeLogEvent,
  type LogEventFilter,
  type StructuredLogEvent,
} from '../shared/log-event.js';

const STRUCTURED_LOG_FILE = 'relay-ide.jsonl';
// Same 5MB cap as the plaintext companion in `server/logger.ts`; keeps
// disk usage predictable across both streams without surprising
// operators with mismatched rotation thresholds.
const MAX_STRUCTURED_LOG_SIZE = 5 * 1024 * 1024;
// Chunk size for the reverse-seek tail reader. Matches local-logs.ts so
// the structured stream behaves identically under low-memory hosts.
const TAIL_CHUNK_SIZE = 64 * 1024;

export function structuredLogFilename(): string {
  return STRUCTURED_LOG_FILE;
}

/**
 * Append a single structured log event to `<logDir>/relay-ide.jsonl`,
 * rotating to `.old` on size. Failures are swallowed — structured
 * logging is best-effort and must never crash the caller's hot path.
 */
export function appendStructuredLogEvent(
  logDir: string,
  event: StructuredLogEvent
): void {
  try {
    fs.mkdirSync(logDir, { recursive: true });
    const file = path.join(logDir, STRUCTURED_LOG_FILE);
    rotateIfNeeded(file);
    fs.appendFileSync(file, `${serializeLogEvent(event)}\n`, 'utf8');
  } catch {
    /* best effort */
  }
}

function rotateIfNeeded(filePath: string): void {
  let size: number;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return;
  }
  if (size < MAX_STRUCTURED_LOG_SIZE) return;
  const oldPath = `${filePath}.old`;
  try {
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    fs.renameSync(filePath, oldPath);
  } catch {
    /* best effort */
  }
}

export interface ReadStructuredLogOptions {
  logFile: string;
  /** Maximum number of matching events to return (last N, FIFO trim). */
  maxEvents: number;
  filter?: LogEventFilter | undefined;
}

export interface ReadStructuredLogResult {
  status: 'ok' | 'missing' | 'empty';
  events: StructuredLogEvent[];
  /** Lines that failed to parse, surfaced for diagnostics. */
  malformedCount: number;
}

/**
 * Tail-read a JSON Lines log file from disk and return at most `maxEvents`
 * matching events (newest-first walk, then reversed to chronological).
 *
 * NOTE: the structured log is hard-capped at `MAX_STRUCTURED_LOG_SIZE`
 * (5 MiB) with `.old` rotation, so this reader bounds its working set to
 * that ceiling — the file is read into a single buffer (either one
 * `readSync` for files ≤ 1 MiB or a series of reverse `TAIL_CHUNK_SIZE`
 * reads that are concatenated before line-splitting). A true incremental
 * reverse tail-read that stops as soon as enough newlines are found is
 * tracked separately; this implementation is the minimum-viable backend
 * for the `logs.tail` foundation PR (#597) and is safe at the current
 * rotation cap. See bot review on PR #607.
 */
export function readStructuredLogTail(options: ReadStructuredLogOptions): ReadStructuredLogResult {
  const { logFile, maxEvents, filter } = options;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(logFile);
  } catch {
    return { status: 'missing', events: [], malformedCount: 0 };
  }
  if (!stat.isFile()) {
    return { status: 'missing', events: [], malformedCount: 0 };
  }
  if (stat.size === 0 || maxEvents <= 0) {
    return { status: stat.size === 0 ? 'empty' : 'ok', events: [], malformedCount: 0 };
  }

  const fd = fs.openSync(logFile, 'r');
  try {
    const lines = readLinesFromTail(fd, stat.size);
    const events: StructuredLogEvent[] = [];
    let malformedCount = 0;
    // Walk newest-first so we can stop as soon as we've collected enough
    // events after filtering. Result is then reversed back to chronological.
    for (let i = lines.length - 1; i >= 0 && events.length < maxEvents; i -= 1) {
      const parsed = parseLogEvent(lines[i]!);
      if (!parsed) {
        if (lines[i]!.trim().length > 0) malformedCount += 1;
        continue;
      }
      if (!logEventMatchesFilter(parsed, filter)) continue;
      events.push(parsed);
    }
    events.reverse();
    return { status: events.length === 0 ? 'empty' : 'ok', events, malformedCount };
  } finally {
    fs.closeSync(fd);
  }
}

function readLinesFromTail(fd: number, size: number): string[] {
  // Working set is bounded by `MAX_STRUCTURED_LOG_SIZE` (5 MiB) — the
  // producer rotates at that cap. Files ≤ 1 MiB get a single `readSync`;
  // larger files are pulled in reverse `TAIL_CHUNK_SIZE` slices and
  // concatenated. This is not yet an incremental reverse tail-read —
  // see `readStructuredLogTail`'s docstring and the bot review on #607.
  if (size <= TAIL_CHUNK_SIZE * 16) {
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, 0);
    return splitLines(buffer.toString('utf8'));
  }
  const chunks: Buffer[] = [];
  let position = size;
  while (position > 0) {
    const length = Math.min(TAIL_CHUNK_SIZE, position);
    position -= length;
    const chunk = Buffer.allocUnsafe(length);
    fs.readSync(fd, chunk, 0, length, position);
    chunks.unshift(chunk);
  }
  return splitLines(Buffer.concat(chunks).toString('utf8'));
}

function splitLines(text: string): string[] {
  // The producer always terminates with `\n`; trailing empty splits are
  // dropped so reverse iteration starts on the newest real event.
  if (text.endsWith('\n')) {
    const trimmed = text.slice(0, -1);
    return trimmed.length === 0 ? [] : trimmed.split('\n');
  }
  return text.split('\n');
}

export {
  type LogEventFilter,
  type StructuredLogEvent,
};
