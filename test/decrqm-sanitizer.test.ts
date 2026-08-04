import { describe, it, expect, vi } from 'vitest';

/**
 * Regression test for the DECRQM escape-sequence sanitizer.
 *
 * xterm.js v6's built-in requestMode handler crashes when double-minified
 * by Vite/esbuild (ReferenceError: s is not defined). OpenCode's Bubble Tea
 * TUI sends DECRQM sequences to probe terminal capabilities, triggering the
 * crash and rendering the terminal blank.
 *
 * The sanitizer in registerEscapeSequenceSanitizers intercepts DECRQM before
 * the broken handler and responds with DECRPM "not recognized" (Pm=0).
 *
 * These tests exercise the handler logic directly (inlined from Terminal.tsx)
 * since the frontend component requires a browser environment.
 */

// Inline the handler logic from registerEscapeSequenceSanitizers
function makeAnsiDecrqmHandler(sendPtyData: (data: string) => void) {
  return (params: (number | number[])[]) => {
    const mode = params[0];
    if (typeof mode !== 'number') return true;
    sendPtyData(`\x1b[${mode};0$y`);
    return true;
  };
}

function makeDecPrivateDecrqmHandler(sendPtyData: (data: string) => void) {
  return (params: (number | number[])[]) => {
    const mode = params[0];
    if (typeof mode !== 'number') return true;
    sendPtyData(`\x1b[?${mode};0$y`);
    return true;
  };
}

describe('DECRQM sanitizer handlers', () => {
  describe('ANSI mode handler (CSI Ps $ p)', () => {
    it('responds with DECRPM "not recognized" for a valid mode', () => {
      const send = vi.fn();
      const handler = makeAnsiDecrqmHandler(send);

      const result = handler([4]); // mode 4 = insert mode

      expect(result).toBe(true);
      expect(send).toHaveBeenCalledWith('\x1b[4;0$y');
    });

    it('swallows without response when params are empty', () => {
      const send = vi.fn();
      const handler = makeAnsiDecrqmHandler(send);

      const result = handler([]);

      expect(result).toBe(true);
      expect(send).not.toHaveBeenCalled();
    });

    it('swallows when params[0] is a subparam array', () => {
      const send = vi.fn();
      const handler = makeAnsiDecrqmHandler(send);

      const result = handler([[1, 2]]);

      expect(result).toBe(true);
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('DEC private mode handler (CSI ? Ps $ p)', () => {
    it('responds with DEC private DECRPM for mode 1000 (mouse tracking)', () => {
      const send = vi.fn();
      const handler = makeDecPrivateDecrqmHandler(send);

      const result = handler([1000]);

      expect(result).toBe(true);
      expect(send).toHaveBeenCalledWith('\x1b[?1000;0$y');
    });

    it('responds for mode 2004 (bracketed paste)', () => {
      const send = vi.fn();
      const handler = makeDecPrivateDecrqmHandler(send);

      const result = handler([2004]);

      expect(result).toBe(true);
      expect(send).toHaveBeenCalledWith('\x1b[?2004;0$y');
    });

    it('responds for mode 1049 (alternate screen)', () => {
      const send = vi.fn();
      const handler = makeDecPrivateDecrqmHandler(send);

      const result = handler([1049]);

      expect(result).toBe(true);
      expect(send).toHaveBeenCalledWith('\x1b[?1049;0$y');
    });

    it('swallows without response when params are empty', () => {
      const send = vi.fn();
      const handler = makeDecPrivateDecrqmHandler(send);

      const result = handler([]);

      expect(result).toBe(true);
      expect(send).not.toHaveBeenCalled();
    });

    it('always returns true to prevent the broken built-in handler', () => {
      const send = vi.fn();
      const handler = makeDecPrivateDecrqmHandler(send);

      // Every call must return true to swallow the sequence
      expect(handler([25])).toBe(true);
      expect(handler([])).toBe(true);
      expect(handler([[1, 2]])).toBe(true);
    });
  });
});
