import {
  DEFAULT_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  MAX_TERMINAL_FONT_SIZE,
} from './stores/ui.js';

export function clampFontSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_TERMINAL_FONT_SIZE;
  return Math.max(
    MIN_TERMINAL_FONT_SIZE,
    Math.min(MAX_TERMINAL_FONT_SIZE, Math.round(size))
  );
}

export function zoomPercentage(fontSize: number): number {
  return Math.round((fontSize / DEFAULT_TERMINAL_FONT_SIZE) * 100);
}

export function scaledTerminalDimensions(
  windowWidth: number,
  windowHeight: number,
  fontSize: number
): { cols: number; rows: number } {
  const ratio = fontSize / DEFAULT_TERMINAL_FONT_SIZE;
  const charWidth = 8 * ratio;
  const lineHeight = 17 * ratio;
  return {
    cols: Math.max(80, Math.floor((windowWidth - 60) / charWidth)),
    rows: Math.max(24, Math.floor((windowHeight - 120) / lineHeight)),
  };
}
