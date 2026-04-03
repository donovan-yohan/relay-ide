import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

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
      assert.equal(clampFontSize(14), 14);
      assert.equal(clampFontSize(20), 20);
    });

    it('clamps to minimum', () => {
      assert.equal(clampFontSize(4), MIN);
      assert.equal(clampFontSize(0), MIN);
      assert.equal(clampFontSize(-5), MIN);
    });

    it('clamps to maximum', () => {
      assert.equal(clampFontSize(30), MAX);
      assert.equal(clampFontSize(100), MAX);
    });

    it('rounds fractional values', () => {
      assert.equal(clampFontSize(14.6), 15);
      assert.equal(clampFontSize(14.4), 14);
    });

    it('handles boundary values exactly', () => {
      assert.equal(clampFontSize(MIN), MIN);
      assert.equal(clampFontSize(MAX), MAX);
    });

    it('returns default for NaN and non-finite values', () => {
      assert.equal(clampFontSize(NaN), DEFAULT);
      assert.equal(clampFontSize(Infinity), DEFAULT);
      assert.equal(clampFontSize(-Infinity), DEFAULT);
    });
  });

  describe('zoomPercentage', () => {
    it('returns 100% at default', () => {
      assert.equal(zoomPercentage(DEFAULT), 100);
    });

    it('scales proportionally', () => {
      assert.equal(zoomPercentage(28), 200);
      assert.equal(zoomPercentage(7), 50);
      assert.equal(zoomPercentage(21), 150);
    });

    it('handles minimum and maximum', () => {
      assert.equal(zoomPercentage(MIN), Math.round((MIN / DEFAULT) * 100));
      assert.equal(zoomPercentage(MAX), Math.round((MAX / DEFAULT) * 100));
    });
  });

  describe('scaledTerminalDimensions', () => {
    it('matches original hardcoded values at default font size', () => {
      const dims = scaledTerminalDimensions(1920, 1080, DEFAULT);
      // Original formula: Math.floor((1920 - 60) / 8) = 232, Math.floor((1080 - 120) / 17) = 56
      assert.equal(dims.cols, Math.floor((1920 - 60) / 8));
      assert.equal(dims.rows, Math.floor((1080 - 120) / 17));
    });

    it('returns fewer cols/rows at larger font sizes', () => {
      const normal = scaledTerminalDimensions(1920, 1080, 14);
      const large = scaledTerminalDimensions(1920, 1080, 28);
      assert.ok(large.cols < normal.cols, 'larger font should give fewer cols');
      assert.ok(large.rows < normal.rows, 'larger font should give fewer rows');
    });

    it('returns more cols/rows at smaller font sizes', () => {
      const normal = scaledTerminalDimensions(1920, 1080, 14);
      const small = scaledTerminalDimensions(1920, 1080, 8);
      assert.ok(small.cols > normal.cols, 'smaller font should give more cols');
      assert.ok(small.rows > normal.rows, 'smaller font should give more rows');
    });

    it('enforces minimums on small screens', () => {
      const dims = scaledTerminalDimensions(100, 100, 28);
      assert.ok(dims.cols >= 80, 'cols must be at least 80');
      assert.ok(dims.rows >= 24, 'rows must be at least 24');
    });

    it('scales linearly with font size', () => {
      const at14 = scaledTerminalDimensions(1920, 1080, 14);
      const at28 = scaledTerminalDimensions(1920, 1080, 28);
      // At 2x font size, char width doubles, so cols should approximately halve
      // (not exactly due to the (width - 60) offset and Math.floor)
      const ratio = at14.cols / at28.cols;
      assert.ok(
        ratio > 1.8 && ratio < 2.2,
        `col ratio should be ~2, got ${ratio}`
      );
    });
  });
});
