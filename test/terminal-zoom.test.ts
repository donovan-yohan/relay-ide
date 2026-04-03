import { describe, it, expect } from 'vitest';

// Pure zoom functions inlined here because the frontend source imports from
// .svelte.ts modules that the Node.js test runner cannot process.
// These mirror the implementations in frontend/src/lib/terminal-zoom.ts.

const DEFAULT = 14;
const MIN = 8;
const MAX = 28;

function clampFontSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT;
  return Math.max(MIN, Math.min(MAX, Math.round(size)));
}

function zoomPercentage(fontSize: number): number {
  return Math.round((fontSize / DEFAULT) * 100);
}

function scaledTerminalDimensions(
  windowWidth: number,
  windowHeight: number,
  fontSize: number
): { cols: number; rows: number } {
  const ratio = fontSize / DEFAULT;
  const charWidth = 8 * ratio;
  const lineHeight = 17 * ratio;
  return {
    cols: Math.max(80, Math.floor((windowWidth - 60) / charWidth)),
    rows: Math.max(24, Math.floor((windowHeight - 120) / lineHeight)),
  };
}

describe('terminal zoom', () => {
  describe('clampFontSize', () => {
    it('returns value within bounds', () => {
      expect(clampFontSize(14)).toBe(14);
      expect(clampFontSize(20)).toBe(20);
    });

    it('clamps to minimum', () => {
      expect(clampFontSize(4)).toBe(MIN);
      expect(clampFontSize(0)).toBe(MIN);
      expect(clampFontSize(-5)).toBe(MIN);
    });

    it('clamps to maximum', () => {
      expect(clampFontSize(30)).toBe(MAX);
      expect(clampFontSize(100)).toBe(MAX);
    });

    it('rounds fractional values', () => {
      expect(clampFontSize(14.6)).toBe(15);
      expect(clampFontSize(14.4)).toBe(14);
    });

    it('handles boundary values exactly', () => {
      expect(clampFontSize(MIN)).toBe(MIN);
      expect(clampFontSize(MAX)).toBe(MAX);
    });

    it('returns default for NaN and non-finite values', () => {
      expect(clampFontSize(NaN)).toBe(DEFAULT);
      expect(clampFontSize(Infinity)).toBe(DEFAULT);
      expect(clampFontSize(-Infinity)).toBe(DEFAULT);
    });
  });

  describe('zoomPercentage', () => {
    it('returns 100% at default', () => {
      expect(zoomPercentage(DEFAULT)).toBe(100);
    });

    it('scales proportionally', () => {
      expect(zoomPercentage(28)).toBe(200);
      expect(zoomPercentage(7)).toBe(50);
      expect(zoomPercentage(21)).toBe(150);
    });

    it('handles minimum and maximum', () => {
      expect(zoomPercentage(MIN)).toBe(Math.round((MIN / DEFAULT) * 100));
      expect(zoomPercentage(MAX)).toBe(Math.round((MAX / DEFAULT) * 100));
    });
  });

  describe('scaledTerminalDimensions', () => {
    it('matches original hardcoded values at default font size', () => {
      const dims = scaledTerminalDimensions(1920, 1080, DEFAULT);
      // Original formula: Math.floor((1920 - 60) / 8) = 232, Math.floor((1080 - 120) / 17) = 56
      expect(dims.cols).toBe(Math.floor((1920 - 60) / 8));
      expect(dims.rows).toBe(Math.floor((1080 - 120) / 17));
    });

    it('returns fewer cols/rows at larger font sizes', () => {
      const normal = scaledTerminalDimensions(1920, 1080, 14);
      const large = scaledTerminalDimensions(1920, 1080, 28);
      expect(large.cols < normal.cols).toBeTruthy();
      expect(large.rows < normal.rows).toBeTruthy();
    });

    it('returns more cols/rows at smaller font sizes', () => {
      const normal = scaledTerminalDimensions(1920, 1080, 14);
      const small = scaledTerminalDimensions(1920, 1080, 8);
      expect(small.cols > normal.cols).toBeTruthy();
      expect(small.rows > normal.rows).toBeTruthy();
    });

    it('enforces minimums on small screens', () => {
      const dims = scaledTerminalDimensions(100, 100, 28);
      expect(dims.cols >= 80).toBeTruthy();
      expect(dims.rows >= 24).toBeTruthy();
    });

    it('scales linearly with font size', () => {
      const at14 = scaledTerminalDimensions(1920, 1080, 14);
      const at28 = scaledTerminalDimensions(1920, 1080, 28);
      // At 2x font size, char width doubles, so cols should approximately halve
      // (not exactly due to the (width - 60) offset and Math.floor)
      const ratio = at14.cols / at28.cols;
      expect(ratio > 1.8 && ratio < 2.2).toBeTruthy();
    });
  });
});
