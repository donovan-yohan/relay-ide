import { describe, expect, it } from 'vitest';
import { LineFramer } from '../../server/line-framer.js';

/** Feed chunks, collect the lines the framer reports, in order. */
function drain(
  framer: LineFramer,
  chunks: (Buffer | string)[]
): { lines: string[] } {
  const lines: string[] = [];
  for (const chunk of chunks) framer.push(chunk, (line) => lines.push(line));
  return { lines };
}

describe('LineFramer', () => {
  it('splits on LF and holds an unterminated tail for the next chunk', () => {
    const framer = new LineFramer();
    const { lines } = drain(framer, ['{"a":1}\n{"b":2}\n{"c":']);
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(framer.pendingBytes).toBeGreaterThan(0);

    const rest: string[] = [];
    framer.push('3}\n', (line) => rest.push(line));
    expect(rest).toEqual(['{"c":3}']);
    expect(framer.pendingBytes).toBe(0);
  });

  it('reassembles a line split at every possible byte boundary', () => {
    const source = '{"one":1}\n{"two":2}\n{"three":3}\n';
    for (let split = 1; split < source.length; split += 1) {
      const framer = new LineFramer();
      const { lines } = drain(framer, [
        source.slice(0, split),
        source.slice(split),
      ]);
      expect(lines).toEqual(['{"one":1}', '{"two":2}', '{"three":3}']);
    }
  });

  it('reassembles a multi-byte character split across two chunks', () => {
    // THE bug this framer exists to fix. claude and codex accumulated
    // `chunk.toString('utf8')` per chunk, so a character cut in half decoded as
    // two U+FFFD replacements and silently corrupted the JSON string literal.
    const payload = JSON.stringify({ text: 'héllo — 世界 🌍' });
    const bytes = Buffer.from(`${payload}\n`, 'utf8');

    for (let split = 1; split < bytes.length; split += 1) {
      const framer = new LineFramer();
      const { lines } = drain(framer, [
        bytes.subarray(0, split),
        bytes.subarray(split),
      ]);
      expect(lines).toEqual([payload]);
      expect(JSON.parse(lines[0]!)).toEqual({ text: 'héllo — 世界 🌍' });
      expect(lines[0]).not.toContain('�');
    }
  });

  it('does not split on U+2028/U+2029, which are legal JSON string content', () => {
    const payload = JSON.stringify({ text: 'a b c' });
    const { lines } = drain(new LineFramer(), [`${payload}\n`]);
    expect(lines).toEqual([payload]);
  });

  it('emits empty lines rather than swallowing them', () => {
    // Clients decide what an empty record means (pi/prime skip it, claude's
    // parser trims it away); the framer must not make that call for them.
    const { lines } = drain(new LineFramer(), ['a\n\nb\n']);
    expect(lines).toEqual(['a', '', 'b']);
  });

  describe('trimTrailingCr', () => {
    it('strips exactly one trailing CR when enabled', () => {
      const { lines } = drain(new LineFramer({ trimTrailingCr: true }), [
        'a\r\nb\n\r\nc\r\r\n',
      ]);
      expect(lines).toEqual(['a', 'b', '', 'c\r']);
    });

    it('leaves the CR in place when disabled (claude/codex default)', () => {
      const { lines } = drain(new LineFramer(), ['a\r\n']);
      expect(lines).toEqual(['a\r']);
    });
  });

  describe("oversizedPolicy 'report-and-continue' (pi/prime)", () => {
    it('drops the over-cap record, reports its byte length, and keeps framing', () => {
      const dropped: number[] = [];
      const framer = new LineFramer({
        maxLineBytes: 8,
        oversizedPolicy: 'report-and-continue',
        onOversized: (bytes) => dropped.push(bytes),
      });
      const { lines } = drain(framer, ['ok\n', 'x'.repeat(20) + '\n', 'fine\n']);
      expect(lines).toEqual(['ok', 'fine']);
      expect(dropped).toEqual([20]);
    });

    it('measures the cap in bytes, not characters', () => {
      const dropped: number[] = [];
      const framer = new LineFramer({
        maxLineBytes: 8,
        oversizedPolicy: 'report-and-continue',
        onOversized: (bytes) => dropped.push(bytes),
      });
      // 5 characters, 15 bytes — over an 8-byte cap.
      drain(framer, ['世界世界世\n']);
      expect(dropped).toEqual([15]);
    });

    it('applies the cap after the CR trim, as pi/prime did', () => {
      const dropped: number[] = [];
      const framer = new LineFramer({
        maxLineBytes: 4,
        trimTrailingCr: true,
        oversizedPolicy: 'report-and-continue',
        onOversized: (bytes) => dropped.push(bytes),
      });
      const { lines } = drain(framer, ['abcd\r\n']);
      expect(lines).toEqual(['abcd']);
      expect(dropped).toEqual([]);
    });

    it('buffers an unterminated over-cap tail rather than reporting early', () => {
      // Only skip-resync reports before seeing a newline; report-and-continue
      // trusts framing and waits, exactly as pi/prime did.
      const dropped: number[] = [];
      const framer = new LineFramer({
        maxLineBytes: 4,
        oversizedPolicy: 'report-and-continue',
        onOversized: (bytes) => dropped.push(bytes),
      });
      drain(framer, ['x'.repeat(50)]);
      expect(dropped).toEqual([]);
      expect(framer.pendingBytes).toBe(50);
    });
  });

  describe("oversizedPolicy 'skip-resync' (claude)", () => {
    it('reports an unterminated over-cap tail immediately and resyncs at the next LF', () => {
      const dropped: number[] = [];
      const framer = new LineFramer({
        maxLineBytes: 32,
        oversizedPolicy: 'skip-resync',
        onOversized: (bytes) => dropped.push(bytes),
      });
      const lines: string[] = [];
      framer.push('x'.repeat(50), (line) => lines.push(line));
      expect(dropped).toEqual([50]);
      expect(lines).toEqual([]);

      // The remainder of the huge line is discarded up to its terminator.
      framer.push('more-of-the-huge-line\n{"type":"recovered"}\n', (line) =>
        lines.push(line)
      );
      expect(lines).toEqual(['{"type":"recovered"}']);
    });

    it('stays in skip mode across chunks with no newline', () => {
      const dropped: number[] = [];
      const framer = new LineFramer({
        maxLineBytes: 4,
        oversizedPolicy: 'skip-resync',
        onOversized: (bytes) => dropped.push(bytes),
      });
      const lines: string[] = [];
      framer.push('x'.repeat(10), (line) => lines.push(line));
      framer.push('y'.repeat(10), (line) => lines.push(line));
      framer.push('z'.repeat(10), (line) => lines.push(line));
      // One report for entering skip mode; the continuation is not re-reported.
      expect(dropped).toEqual([10]);
      expect(framer.pendingBytes).toBe(0);

      framer.push('\nok\n', (line) => lines.push(line));
      expect(lines).toEqual(['ok']);
    });

    it('drops a complete over-cap line and continues with the next one', () => {
      const dropped: number[] = [];
      const framer = new LineFramer({
        maxLineBytes: 8,
        oversizedPolicy: 'skip-resync',
        onOversized: (bytes) => dropped.push(bytes),
      });
      const { lines } = drain(framer, ['ok\n' + 'x'.repeat(20) + '\nfine\n']);
      expect(lines).toEqual(['ok', 'fine']);
      expect(dropped).toEqual([20]);
    });

    it('reports interleaved with surrounding lines, not batched ahead of them', () => {
      // Why `push` takes a callback instead of returning an array: batching
      // would move this report ahead of "first", reordering the client's
      // observable event stream.
      const events: string[] = [];
      const framer = new LineFramer({
        maxLineBytes: 8,
        oversizedPolicy: 'skip-resync',
        onOversized: (bytes) => events.push(`oversized:${bytes}`),
      });
      framer.push('first\n' + 'x'.repeat(20) + '\nsecond\n', (line) =>
        events.push(`line:${line}`)
      );
      expect(events).toEqual(['line:first', 'oversized:20', 'line:second']);
    });
  });

  describe('maxBufferBytes', () => {
    it('discards the retained tail and reports overflow', () => {
      let overflows = 0;
      const framer = new LineFramer({
        maxBufferBytes: 16,
        onBufferOverflow: () => {
          overflows += 1;
        },
      });
      const { lines } = drain(framer, ['x'.repeat(40)]);
      expect(lines).toEqual([]);
      expect(overflows).toBe(1);
      expect(framer.pendingBytes).toBe(0);
    });

    it('checks the tail only after every complete line in the chunk is delivered', () => {
      // A chunk can carry good records followed by an unterminated tail that
      // blows the budget; the good records must still arrive.
      let overflows = 0;
      const framer = new LineFramer({
        maxBufferBytes: 16,
        onBufferOverflow: () => {
          overflows += 1;
        },
      });
      const { lines } = drain(framer, ['{"a":1}\n{"b":2}\n' + 'x'.repeat(40)]);
      expect(lines).toEqual(['{"a":1}', '{"b":2}']);
      expect(overflows).toBe(1);
    });

    it('does not fire when the tail stays under the cap', () => {
      let overflows = 0;
      const framer = new LineFramer({
        maxBufferBytes: 64,
        onBufferOverflow: () => {
          overflows += 1;
        },
      });
      drain(framer, ['{"a":1}\npartial']);
      expect(overflows).toBe(0);
    });
  });

  it('reset() drops the partial tail and leaves skip mode', () => {
    const framer = new LineFramer({
      maxLineBytes: 16,
      oversizedPolicy: 'skip-resync',
    });
    const lines: string[] = [];
    framer.push('x'.repeat(40), (line) => lines.push(line));
    framer.reset();

    // Without leaving skip mode, this whole line would be discarded as the
    // tail of the previous oversized record.
    framer.push('{"a":1}\n', (line) => lines.push(line));
    expect(lines).toEqual(['{"a":1}']);
  });

  it('accepts string chunks as UTF-8', () => {
    const { lines } = drain(new LineFramer(), ['héllo\n']);
    expect(lines).toEqual(['héllo']);
  });
});
