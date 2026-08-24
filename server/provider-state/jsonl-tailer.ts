import fs from 'node:fs';
import { createLogger } from '../logger.js';

const logger = createLogger('provider-state:jsonl-tailer');

/**
 * Result of one tail poll over a JSONL file.
 *
 * `events` contains only complete lines observed since the previous poll, in
 * file order. A trailing fragment (a final line not yet terminated by `\n`) is
 * held back internally and prepended to the next read — it is never emitted
 * early. Unparseable complete lines are reported as gaps rather than dropped:
 * the caller decides how to surface them (see `NativeSessionLiveTailManager`).
 */
export interface JsonlTailPoll<T> {
  events: T[];
  gaps: number;
  /** Byte offset just past the last consumed byte (durable cursor value). */
  offset: number;
}

interface TailState {
  /** Durable byte cursor: resume position across process restarts. */
  offset: number;
  /** Incomplete trailing line held back until its terminating newline arrives. */
  trailingFragment: string;
  /** File identity from the last poll, used to detect rotation/truncation. */
  fileId?: { dev: number; ino: number };
}

export interface JsonlTailerOptions {
  /**
   * Poll interval hint for callers driving `poll` on a timer; the tailer
   * itself is stateless between polls and does not own a timer.
   */
  pollIntervalMs?: number;
  /** Called when a persisted cursor is unavailable or unparsable at start. */
  onCursorReset?: (reason: 'missing' | 'corrupt' | 'truncated') => void;
}

/**
 * Generic offset-tracking JSONL tailer generalized from the Codex telemetry
 * adapter's proven incremental-read pattern (`server/adapters/codex-telemetry.ts`).
 *
 * Guarantees:
 * - At-most-once delivery per event per cursor: events are never replayed when
 *   the consumer persists `poll().offset` and resumes with it.
 * - Partial trailing lines are held back until complete.
 * - Rotation/truncation is detected via file identity + size and resets to the
 *   beginning of the new file without crashing or double-emitting.
 * - Observation only: the file is opened read-only; nothing is ever written.
 */
export class JsonlFileTailer<T = Record<string, unknown>> {
  private readonly filePath: string;
  private readonly parseLine: (line: string) => T | null;
  private readonly loadCursor: () => number | null;
  private readonly saveCursor: (offset: number) => void;
  private readonly onCursorReset?: JsonlTailerOptions['onCursorReset'];
  private state: TailState;
  private initialized = false;

  constructor(input: {
    filePath: string;
    parseLine?: (line: string) => T | null;
    /** Load the durable cursor (byte offset). Return null when none exists. */
    loadCursor?: () => number | null;
    /** Persist the durable cursor after each poll that advanced it. */
    saveCursor?: (offset: number) => void;
    options?: JsonlTailerOptions;
  }) {
    this.filePath = input.filePath;
    this.parseLine =
      input.parseLine ??
      (defaultParseLine as (line: string) => T | null);
    this.loadCursor = input.loadCursor ?? (() => null);
    this.saveCursor =
      input.saveCursor ??
      (() => {
        /* no persistence requested; cursor is in-memory only */
      });
    this.onCursorReset = input.options?.onCursorReset;
    this.state = { offset: 0, trailingFragment: '' };
  }

  /**
   * Read newly appended complete lines. Safe to call on any cadence; calls
   * with no new data return an empty result and advance nothing.
   */
  poll(): JsonlTailPoll<T> {
    if (!this.initialized) {
      this.initialize();
      this.initialized = true;
    }

    let stats: fs.Stats;
    try {
      stats = fs.statSync(this.filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        logger.warn(`Failed to stat JSONL ${this.filePath}:`, error);
      }
      // File temporarily missing (rotation gap): keep cursor; retry next poll.
      return { events: [], gaps: 0, offset: this.state.offset };
    }

    // Rotation/truncation: a different inode or a smaller size than our cursor
    // means the file was replaced or rewritten. Reset to the new file's start.
    const currentId = { dev: stats.dev, ino: stats.ino };
    if (
      this.state.offset > stats.size ||
      (this.state.fileId &&
        (this.state.fileId.dev !== currentId.dev ||
          this.state.fileId.ino !== currentId.ino))
    ) {
      logger.warn(
        `JSONL ${this.filePath} was truncated/rotated (cursor ${this.state.offset} > size ${stats.size} or inode change); resetting to start of new file.`
      );
      this.onCursorReset?.('truncated');
      this.state = { offset: 0, trailingFragment: '', fileId: currentId };
    } else {
      this.state.fileId = currentId;
    }

    if (this.state.offset === stats.size) {
      return { events: [], gaps: 0, offset: this.state.offset };
    }

    let bytesRead: number;
    let chunk: string;
    try {
      const bytesToRead = stats.size - this.state.offset;
      const buffer = Buffer.alloc(bytesToRead);
      const fd = fs.openSync(this.filePath, 'r');
      try {
        bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, this.state.offset);
      } finally {
        fs.closeSync(fd);
      }
      chunk = buffer.subarray(0, bytesRead).toString('utf-8');
    } catch (error) {
      logger.warn(`Failed to read JSONL ${this.filePath}:`, error);
      return { events: [], gaps: 0, offset: this.state.offset };
    }

    // Prepend the previously held-back partial line so it is parsed exactly
    // once, in order, once complete.
    const content = this.state.trailingFragment + chunk;
    const rawLines = content.split('\n');
    const trailing = rawLines.pop() ?? '';

    const events: T[] = [];
    let gaps = 0;
    for (const rawLine of rawLines) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      const parsed = this.parseLine(trimmed);
      if (parsed === null) {
        gaps += 1;
        continue;
      }
      events.push(parsed);
    }
    if (gaps > 0) {
      logger.warn(
        `JSONL ${this.filePath}: ${gaps} unparseable complete line(s) skipped as gaps.`
      );
    }

    // The durable cursor covers every byte whose line has been fully consumed,
    // including the bytes of a held-back trailing fragment (they are re-read
    // from memory, not from disk). Persisting here keeps restart semantics
    // exact: no replay, no gap.
    const newOffset = this.state.offset + bytesRead;
    this.state.offset = newOffset;
    this.state.trailingFragment = trailing;
    this.saveCursor(newOffset);

    return { events, gaps, offset: newOffset };
  }

  /** Current durable cursor value (byte offset). */
  get offset(): number {
    return this.state.offset;
  }

  private initialize(): void {
    const saved = this.loadCursor();
    if (saved === null || !Number.isFinite(saved) || saved < 0) {
      if (saved !== null) this.onCursorReset?.('corrupt');
      this.state = { offset: 0, trailingFragment: '' };
      return;
    }
    this.state = { offset: saved, trailingFragment: '' };
  }
}

function defaultParseLine(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value)
    ) {
      return value as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}
