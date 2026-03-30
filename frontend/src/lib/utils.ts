import { getUi } from './state/ui.svelte.js';
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
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
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
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
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
  const fontSize = isMobileDevice ? 12 : getUi().terminalFontSize;
  return scaledTerminalDimensions(window.innerWidth, window.innerHeight, fontSize);
}
