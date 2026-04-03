import { useUiStore } from './stores/ui.js';
import { scaledTerminalDimensions } from './terminal-zoom.js';

export function rootShortName(path: string): string {
  return path.split('/').filter(Boolean).pop() || path;
}

export function formatRelativeTime(isoString: string): string {
  if (!isoString) return '';
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffSec = Math.floor((now - then) / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return diffMin + 'm ago';
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return diffHr + 'h ago';
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay === 1) return 'yesterday';
  if (diffDay < 7) return diffDay + 'd ago';
  const d = new Date(isoString);
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return months[d.getMonth()] + ' ' + d.getDate();
}

export function formatRelativeTimeCompact(isoString: string): string {
  if (!isoString) return '';
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffSec = Math.floor((now - then) / 1000);
  if (diffSec < 60) return diffSec + 's';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return diffMin + 'm';
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return diffHr + 'h';
  const d = new Date(isoString);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  return `${dd}-${mm}-${yy}`;
}

export const isMobileDevice =
  typeof window !== 'undefined' &&
  'ontouchstart' in window &&
  /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

export const isMac =
  typeof navigator !== 'undefined' &&
  /Mac/.test(navigator.platform || '') &&
  !/iPhone|iPad|iPod/.test(navigator.platform || '');

export function estimateTerminalDimensions(): { cols: number; rows: number } {
  const fontSize = isMobileDevice ? 12 : useUiStore.getState().terminalFontSize;
  return scaledTerminalDimensions(
    window.innerWidth,
    window.innerHeight,
    fontSize
  );
}

export function formatCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value))
    return '---';
  const abs = Math.abs(value);
  if (abs < 1000) return String(Math.round(value));
  if (abs < 1_000_000)
    return `${(value / 1000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  if (abs < 1_000_000_000)
    return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  return `${(value / 1_000_000_000).toFixed(1)}B`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds))
    return '---';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM > 0 ? `${h}h ${remM}m` : `${h}h`;
}

export function formatDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '---';
  return formatDuration(ms / 1000);
}

export function barForPercent(pct: number, width: number): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  return '\u2588'.repeat(filled) + '\u2591'.repeat(width - filled);
}
