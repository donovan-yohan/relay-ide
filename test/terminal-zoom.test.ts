import { describe, it, expect } from 'vitest';
import {
  clampFontSize,
  zoomPercentage,
  scaledTerminalDimensions,
  shouldUseWebGpuRenderer,
} from '../frontend/src/lib/terminal-zoom.js';
import {
  DEFAULT_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  MAX_TERMINAL_FONT_SIZE,
} from '../frontend/src/lib/stores/ui.js';

describe('terminal zoom', () => {
  describe('clampFontSize', () => {
    it('returns value within bounds', () => {
      expect(clampFontSize(14)).toBe(14);
      expect(clampFontSize(20)).toBe(20);
    });

    it('clamps to minimum', () => {
      expect(clampFontSize(4)).toBe(MIN_TERMINAL_FONT_SIZE);
      expect(clampFontSize(0)).toBe(MIN_TERMINAL_FONT_SIZE);
      expect(clampFontSize(-5)).toBe(MIN_TERMINAL_FONT_SIZE);
    });

    it('clamps to maximum', () => {
      expect(clampFontSize(30)).toBe(MAX_TERMINAL_FONT_SIZE);
      expect(clampFontSize(100)).toBe(MAX_TERMINAL_FONT_SIZE);
    });

    it('rounds fractional values', () => {
      expect(clampFontSize(14.6)).toBe(15);
      expect(clampFontSize(14.4)).toBe(14);
    });

    it('handles boundary values exactly', () => {
      expect(clampFontSize(MIN_TERMINAL_FONT_SIZE)).toBe(
        MIN_TERMINAL_FONT_SIZE
      );
      expect(clampFontSize(MAX_TERMINAL_FONT_SIZE)).toBe(
        MAX_TERMINAL_FONT_SIZE
      );
    });

    it('returns default for NaN and non-finite values', () => {
      expect(clampFontSize(NaN)).toBe(DEFAULT_TERMINAL_FONT_SIZE);
      expect(clampFontSize(Infinity)).toBe(DEFAULT_TERMINAL_FONT_SIZE);
      expect(clampFontSize(-Infinity)).toBe(DEFAULT_TERMINAL_FONT_SIZE);
    });
  });

  describe('zoomPercentage', () => {
    it('returns 100% at default', () => {
      expect(zoomPercentage(DEFAULT_TERMINAL_FONT_SIZE)).toBe(100);
    });

    it('scales proportionally', () => {
      expect(zoomPercentage(28)).toBe(200);
      expect(zoomPercentage(7)).toBe(50);
      expect(zoomPercentage(21)).toBe(150);
    });

    it('handles minimum and maximum', () => {
      expect(zoomPercentage(MIN_TERMINAL_FONT_SIZE)).toBe(
        Math.round((MIN_TERMINAL_FONT_SIZE / DEFAULT_TERMINAL_FONT_SIZE) * 100)
      );
      expect(zoomPercentage(MAX_TERMINAL_FONT_SIZE)).toBe(
        Math.round((MAX_TERMINAL_FONT_SIZE / DEFAULT_TERMINAL_FONT_SIZE) * 100)
      );
    });
  });

  describe('scaledTerminalDimensions', () => {
    it('matches original hardcoded values at default font size', () => {
      const dims = scaledTerminalDimensions(
        1920,
        1080,
        DEFAULT_TERMINAL_FONT_SIZE
      );
      expect(dims.cols).toBe(Math.floor((1920 - 60) / 8));
      expect(dims.rows).toBe(Math.floor((1080 - 120) / 17));
    });

    it('returns fewer cols/rows at larger font sizes', () => {
      const normal = scaledTerminalDimensions(1920, 1080, 14);
      const large = scaledTerminalDimensions(1920, 1080, 28);
      expect(large.cols).toBeLessThan(normal.cols);
      expect(large.rows).toBeLessThan(normal.rows);
    });

    it('returns more cols/rows at smaller font sizes', () => {
      const normal = scaledTerminalDimensions(1920, 1080, 14);
      const small = scaledTerminalDimensions(1920, 1080, 8);
      expect(small.cols).toBeGreaterThan(normal.cols);
      expect(small.rows).toBeGreaterThan(normal.rows);
    });

    it('enforces minimums on small screens', () => {
      const dims = scaledTerminalDimensions(100, 100, 28);
      expect(dims.cols).toBeGreaterThanOrEqual(80);
      expect(dims.rows).toBeGreaterThanOrEqual(24);
    });

    it('scales linearly with font size', () => {
      const at14 = scaledTerminalDimensions(1920, 1080, 14);
      const at28 = scaledTerminalDimensions(1920, 1080, 28);
      const ratio = at14.cols / at28.cols;
      expect(ratio).toBeGreaterThan(1.8);
      expect(ratio).toBeLessThan(2.2);
    });
  });

  describe('shouldUseWebGpuRenderer', () => {
    it('enables WebGPU when GPU available and not mobile', () => {
      expect(shouldUseWebGpuRenderer(true, false)).toBe(true);
    });

    it('skips WebGPU on mobile even with GPU', () => {
      expect(shouldUseWebGpuRenderer(true, true)).toBe(false);
    });

    it('skips WebGPU when GPU unavailable', () => {
      expect(shouldUseWebGpuRenderer(false, false)).toBe(false);
      expect(shouldUseWebGpuRenderer(false, true)).toBe(false);
    });
  });
});
