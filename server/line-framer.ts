/**
 * CHOREOGRAPHY: framing a newline-delimited JSON stream off a child process.
 *
 * Four transport clients — `claude-stream-client`, `codex-app-server-client`,
 * `pi-agent-rpc-client`, `prime-agent-rpc-client` — each wrote their own
 * "accumulate a chunk, cut on LF, keep the partial tail" loop. Framing is not a
 * provider quirk: it is the same dance in all four, and writing it four times
 * produced four different sets of bugs. What each client does with a completed
 * line — JSON parsing, error wording, response correlation, event routing — is
 * genuinely provider-specific and deliberately stays where it is.
 *
 * ## Why bytes, not a string
 *
 * claude and codex accumulated `chunk.toString('utf8')` PER CHUNK. A stream is
 * chopped at arbitrary byte offsets, so a multi-byte character split across two
 * chunks decoded as two replacement characters — silently corrupting a line
 * before it ever reached `JSON.parse`, and corrupting a JSON string literal in
 * a way that usually still parses. pi/prime accumulated `Buffer`s and were
 * already correct. This framer buffers bytes and decodes only whole lines, so
 * all four are now correct; that is a deliberate convergence on the behavior
 * two of the four already had, not a new policy.
 *
 * ## Why a callback, not a returned array
 *
 * `push` reports lines through `onLine` as it finds them rather than returning
 * them in a batch, so an oversized-line or buffer-overflow report stays
 * interleaved with the surrounding lines exactly where it fell before. Batching
 * would move every report ahead of the lines that preceded it in the same
 * chunk, which is an observable reordering of a client's event stream.
 *
 * Splitting is on ASCII LF only. U+2028/U+2029 are legal JSON string content
 * and must not be treated as record separators.
 */

/** Policy for a line that exceeds `maxLineBytes`. */
export type OversizedLinePolicy =
  /**
   * claude: a line over the cap means the framer stops trusting its position in
   * the stream, drops what it has, and discards bytes until the next LF. An
   * unterminated over-cap tail is reported immediately rather than buffered
   * without bound.
   */
  | 'skip-resync'
  /**
   * pi/prime: the record is dropped and reported, but framing is still trusted
   * — the LF that ended it was found, so the next line starts cleanly.
   */
  | 'report-and-continue';

export interface LineFramerOptions {
  /**
   * Per-line cap in BYTES. Omit for no cap (codex, whose app-server output is
   * already bounded upstream; adding one is a separate, deliberate change).
   */
  maxLineBytes?: number;
  /**
   * Called with the number of bytes dropped when a line exceeds `maxLineBytes`.
   * Clients turn this into their own signal (claude emits `oversized-line`,
   * pi/prime emit a `protocolError`).
   */
  onOversized?: (droppedBytes: number) => void;
  /** Defaults to `report-and-continue`. Only meaningful with `maxLineBytes`. */
  oversizedPolicy?: OversizedLinePolicy;
  /**
   * Cap on the retained partial tail, checked after every complete line in a
   * chunk has been consumed — a chunk can carry good records followed by an
   * unterminated tail that blows the budget.
   */
  maxBufferBytes?: number;
  /**
   * Called after an overflowing buffer is discarded. Framing is lost at that
   * point (the discarded bytes were part of a record), so pi/prime stop the
   * client here rather than risk reading a later suffix as a fresh record.
   */
  onBufferOverflow?: () => void;
  /**
   * Strip one trailing CR from each line, for a peer that writes CRLF. Off by
   * default: claude and codex hand the raw line to a parser that tolerates
   * trailing whitespace, and changing that would alter their byte counts.
   */
  trimTrailingCr?: boolean;
}

const LF = 0x0a;
const CR = 0x0d;

export class LineFramer {
  private buffer: Buffer = Buffer.alloc(0);
  /** `skip-resync` only: discarding bytes until the LF that ends a huge line. */
  private skipping = false;

  constructor(private readonly options: LineFramerOptions = {}) {}

  /** Bytes currently held as an incomplete trailing line. Exposed for tests. */
  get pendingBytes(): number {
    return this.buffer.length;
  }

  /**
   * Feed one chunk. `onLine` runs once per complete line, in stream order,
   * before `push` returns.
   */
  push(chunk: Buffer | string, onLine: (line: string) => void): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    this.buffer =
      this.buffer.length === 0 ? bytes : Buffer.concat([this.buffer, bytes]);

    const {
      maxLineBytes,
      oversizedPolicy = 'report-and-continue',
      trimTrailingCr = false,
    } = this.options;

    for (;;) {
      const newline = this.buffer.indexOf(LF);

      if (newline === -1) {
        if (this.skipping) {
          // Still inside an oversized line — the partial tail is more of it.
          if (this.buffer.length > 0) this.buffer = Buffer.alloc(0);
          break;
        }
        if (
          oversizedPolicy === 'skip-resync' &&
          maxLineBytes !== undefined &&
          this.buffer.length > maxLineBytes
        ) {
          // No LF yet and the tail already blew the cap: report now and resync
          // at the next LF instead of growing the buffer waiting for one.
          const dropped = this.buffer.length;
          this.skipping = true;
          this.buffer = Buffer.alloc(0);
          this.options.onOversized?.(dropped);
        }
        break;
      }

      let lineBytes = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);

      if (this.skipping) {
        // This LF terminates the oversized line; resume normal framing.
        this.skipping = false;
        continue;
      }

      if (trimTrailingCr && lineBytes.at(-1) === CR) {
        lineBytes = lineBytes.subarray(0, -1);
      }

      if (maxLineBytes !== undefined && lineBytes.length > maxLineBytes) {
        this.options.onOversized?.(lineBytes.length);
        continue;
      }

      onLine(lineBytes.toString('utf8'));
    }

    const { maxBufferBytes } = this.options;
    if (maxBufferBytes !== undefined && this.buffer.length > maxBufferBytes) {
      this.buffer = Buffer.alloc(0);
      this.options.onBufferOverflow?.();
    }
  }

  /** Drop any partial line and leave skip mode. Used when a transport restarts. */
  reset(): void {
    this.buffer = Buffer.alloc(0);
    this.skipping = false;
  }
}
