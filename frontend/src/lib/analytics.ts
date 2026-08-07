import { isMobileDevice } from './utils.js';

interface PendingEvent {
  category: string;
  action: string;
  target?: string | null;
  properties?: Record<string, unknown> | null;
  session_id?: string | null;
  device: string;
}

const FLUSH_INTERVAL_MS = 5000;
const FLUSH_THRESHOLD = 20;
const SESSION_SCOPED_PREFIXES = ['terminal.', 'session-tab.'];

let queue: PendingEvent[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let device: string = 'desktop';
let getActiveSessionId: (() => string | null) | null = null;

function flush(): void {
  if (queue.length === 0) return;
  const batch = queue;
  queue = [];

  const body = JSON.stringify({ events: batch });

  // Use sendBeacon if available (works during page unload)
  if (navigator.sendBeacon) {
    const blob = new Blob([body], { type: 'application/json' });
    navigator.sendBeacon('/analytics/events', blob);
  } else {
    fetch('/analytics/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {});
  }
}

export function track(
  category: string,
  action: string,
  target?: string,
  properties?: Record<string, unknown>,
  sessionId?: string | null
): void {
  queue.push({
    category,
    action,
    target: target ?? null,
    properties: properties ?? null,
    session_id: sessionId ?? null,
    device,
  });

  if (queue.length >= FLUSH_THRESHOLD) {
    flush();
  }
}

function getTrackValue(el: Element): string | null {
  let current: Element | null = el;
  while (current) {
    const val = current.getAttribute('data-track');
    if (val) return val;
    current = current.parentElement;
  }
  return null;
}

function buildSelector(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const cls =
    el.className && typeof el.className === 'string'
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
      : '';
  return tag + cls;
}

function handleClick(e: MouseEvent): void {
  const el = e.target as Element | null;
  if (!el) return;

  const trackValue = getTrackValue(el);
  const target = trackValue || buildSelector(el);

  const text = (el.textContent || '').trim().slice(0, 50) || null;

  // Only attach session_id for session-scoped UI (terminal, session-tab).
  // Global UI (sidebar, dialog, search, pr-top-bar) gets session_id: null.
  const isSessionScoped =
    trackValue != null &&
    SESSION_SCOPED_PREFIXES.some((p) => trackValue.startsWith(p));
  const sessionId = isSessionScoped ? (getActiveSessionId?.() ?? null) : null;

  track('ui', 'click', target, text ? { text } : undefined, sessionId);
}

export function initAnalytics(
  activeSessionIdGetter: () => string | null
): void {
  device = isMobileDevice ? 'mobile' : 'desktop';
  getActiveSessionId = activeSessionIdGetter;

  // Auto-capture clicks
  document.addEventListener('click', handleClick, {
    capture: true,
    passive: true,
  });

  // Periodic flush
  flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);

  // Flush on page hide (tab switch, close, navigation)
  document.addEventListener('visibilitychange', handleVisibilityChange);
}

function handleVisibilityChange(): void {
  if (document.visibilityState === 'hidden') {
    flush();
  }
}

export function destroyAnalytics(): void {
  flush();
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  document.removeEventListener('click', handleClick, {
    capture: true,
  } as EventListenerOptions);
  document.removeEventListener('visibilitychange', handleVisibilityChange);
}
