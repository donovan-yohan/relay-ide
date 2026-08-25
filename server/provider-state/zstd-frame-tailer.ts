import fs from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { createLogger } from '../logger.js';

const logger = createLogger('provider-state:zstd-frame-tailer');

/**
 * Result of one tail poll over a concatenated zstd-frame log (DeepSeek
 * Harness `session.jsonl.zstd`).
 *
 * `events` carries one element per newly appended COMPLETE frame since the
 * previous poll, in file order, decoded to plaintext. A torn trailing frame is
 * never emitted early: its bytes stay unconsumed until a later poll observes
 * the frame structurally complete (a new frame boundary closes it), which is
 * the byte-cursor equivalent of the JSONL tailer's held-back trailing line.
 */
export interface ZstdFrameTailPoll<T> {
  events: T[];
  /** Complete frames that failed to decode; counted, not silently dropped. */
  gaps: number;
  /** Byte offset just past the last consumed complete frame (durable cursor). */
  offset: number;
}

/**
 * Byte-range tailer for concatenated zstd frame logs (#1426 DSH live tails).
 *
 * The shared {@link JsonlFileTailer} works on plaintext lines; DSH appends
 * zstd frames incrementally, so this tailer tracks the durable BYTE cursor and
 * re-decodes only newly appended complete frames each poll:
 *
 * 1. Stat the file; on rotation/truncation (inode change or cursor > size),
 *    reset to zero like the JSONL tailer.
 * 2. Read [cursor, size) — plus a small fixed lookback window so the scanner
 *    can see the previous frame's header when validating the first new bytes.
 * 3. Structurally scan for frames fully contained in the NEW range; decode
 *    each with `zstdDecompressSync` (one frame per call) and hand plaintext to
 *    the caller's decoder callback.
 *
 * Guarantees mirror `JsonlFileTailer`: at-most-once delivery per event per
 * durable cursor, torn trailing frames held back, rotation resets without
 * double-emitting, read-only observation only. The cursor key is
 * `${provider}:${nativeId}:${basename}` in the shared LiveTailCursorStore.
 */
export class ZstdFrameLogTailer<T = string> {
  private readonly filePath: string;
  private readonly decodeChunk: (plaintext: string) => T | null;
  private readonly loadCursor: () => number | null;
  private readonly saveCursor: (offset: number) => void;
  private readonly onCursorReset:
    | ((reason: 'missing' | 'corrupt' | 'truncated') => void)
    | undefined;
  private state: { offset: number };
  private fileId?: { dev: number; ino: number };
  private initialized = false;

  constructor(input: {
    filePath: string;
    /**
     * Decode one newly consumed frame's plaintext into an event batch, or
     * return null to count the frame as a gap.
     */
    decodeChunk?: (plaintext: string) => T | null;
    loadCursor?: () => number | null;
    saveCursor?: (offset: number) => void;
    onCursorReset?: (reason: 'missing' | 'corrupt' | 'truncated') => void;
  }) {
    this.filePath = input.filePath;
    this.decodeChunk =
      input.decodeChunk ?? ((plaintext: string) => plaintext as unknown as T);
    this.loadCursor = input.loadCursor ?? (() => null);
    this.saveCursor =
      input.saveCursor ??
      (() => {
        /* no persistence requested; cursor is in-memory only */
      });
    this.onCursorReset = input.onCursorReset;
    this.state = { offset: 0 };
  }

  /** Current durable cursor value (byte offset just past consumed frames). */
  get offset(): number {
    return this.state.offset;
  }

  poll(): ZstdFrameTailPoll<T> {
    if (!this.initialized) {
      const saved = this.loadCursor();
      if (saved === null || !Number.isFinite(saved) || saved < 0) {
        if (saved !== null) this.onCursorReset?.('corrupt');
        this.state = { offset: 0 };
      } else {
        this.state = { offset: saved };
      }
      this.initialized = true;
    }

    let stats: fs.Stats;
    try {
      stats = fs.statSync(this.filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        logger.warn(`Failed to stat zstd log ${this.filePath}:`, error);
      }
      // File temporarily missing (rotation gap): keep cursor; retry next poll.
      return { events: [], gaps: 0, offset: this.state.offset };
    }

    const currentId = { dev: stats.dev, ino: stats.ino };
    if (
      this.state.offset > stats.size ||
      (this.fileId &&
        (this.fileId.dev !== currentId.dev ||
          this.fileId.ino !== currentId.ino))
    ) {
      logger.warn(
        `zstd log ${this.filePath} was truncated/rotated (cursor ${this.state.offset} > size ${stats.size} or inode change); resetting to start of new file.`
      );
      this.onCursorReset?.('truncated');
      this.state = { offset: 0 };
    }
    this.fileId = currentId;

    if (this.state.offset === stats.size) {
      return { events: [], gaps: 0, offset: this.state.offset };
    }

    const scanStart = Math.max(0, this.state.offset - FRAME_SCAN_LOOKBACK);
    let buffer: Buffer;
    let bytesRead: number;
    try {
      const bytesToRead = stats.size - scanStart;
      buffer = Buffer.alloc(bytesToRead);
      const fd = fs.openSync(this.filePath, 'r');
      try {
        bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, scanStart);
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      logger.warn(`Failed to read zstd log ${this.filePath}:`, error);
      return { events: [], gaps: 0, offset: this.state.offset };
    }
    buffer = buffer.subarray(0, bytesRead);

    // Only frames ENDING past the durable cursor are new. The scan may begin
    // inside the lookback window; a frame whose end sits at/before the cursor
    // was already emitted and must not replay.
    let scan;
    try {
      scan = scanFramesFrom(buffer);
    } catch (error) {
      logger.warn(
        `zstd log ${this.filePath}: structural scan failed; keeping cursor.`,
        error
      );
      return { events: [], gaps: 0, offset: this.state.offset };
    }

    const events: T[] = [];
    let gaps = 0;
    let consumedEnd = this.state.offset;

    for (const range of scan.frames) {
      const absoluteEnd = scanStart + range.end;
      if (absoluteEnd <= this.state.offset) continue;
      let plaintext: string;
      try {
        plaintext = zstdDecodeOne(buffer.subarray(range.start, range.end));
      } catch (error) {
        gaps += 1;
        logger.warn(
          `zstd log ${this.filePath}: frame at ${absoluteEnd} failed to decode; counted as gap.`,
          error
        );
        consumedEnd = absoluteEnd;
        continue;
      }
      const parsed = this.decodeChunk(plaintext);
      if (parsed === null) {
        gaps += 1;
      } else {
        events.push(parsed);
      }
      consumedEnd = absoluteEnd;
    }

    if (gaps > 0) {
      logger.warn(
        `zstd log ${this.filePath}: ${gaps} undecodable complete frame(s) skipped as gaps.`
      );
    }

    this.state.offset = consumedEnd;
    this.saveCursor(consumedEnd);
    return { events, gaps, offset: consumedEnd };
  }
}

/**
 * Lookback window (bytes) preceding the cursor included in every read so the
 * structural scanner can anchor on a frame header. Frames entirely within the
 * lookback are filtered by their end offset, so no replay occurs.
 */
const FRAME_SCAN_LOOKBACK = 64 * 1024;

/**
 * Structural scan of concatenated zstd frames (magic `28 B5 2F FD`),
 * mirroring the harness's own `scanZstdFrames`
 * (`packages/session/session-persistence-jsonl/src/zstd.ts`). Returns only
 * COMPLETE frame ranges; EOF inside a final frame yields no range for it
 * (torn-tail holdback), while invalid structure throws.
 */
export function scanFramesFrom(buffer: Buffer): {
  frames: { start: number; end: number }[];
} {
  const ZSTD_MAGIC = 0xfd2fb528;
  const frames: { start: number; end: number }[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) break;
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`invalid frame magic at byte ${start} of scanned window`);
    }
    offset += 4;

    if (offset === buffer.length) break;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`reserved frame-header bit at byte ${offset - 1}`);
    }

    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes =
      contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes =
      (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) {
      break;
    }
    offset += remainingHeaderBytes;

    let frameComplete = true;
    for (;;) {
      if (buffer.length - offset < 3) {
        frameComplete = false;
        break;
      }
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      if (blockType === 0x03) {
        throw new Error(`reserved block type at byte ${offset - 3}`);
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) {
        frameComplete = false;
        break;
      }
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (!frameComplete) {
      break;
    }

    if (checksum) {
      if (buffer.length - offset < 4) {
        break;
      }
      offset += 4;
    }
    frames.push({ start, end: offset });
  }

  return { frames };
}

function zstdDecodeOne(frame: Buffer): string {
  return zstdDecompressSync(frame).toString('utf8');
}
