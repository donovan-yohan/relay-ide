import { useUiStore } from '../lib/stores/ui.js';
import { useTelemetryStore } from '../lib/stores/telemetry.js';
import type { CurrentActivity } from '../lib/types.js';
import './SessionStatusBar.css';

export interface SessionStatusBarProps {
  sessionId: string | null;
  currentActivity?: CurrentActivity | null;
}

const BAR_WIDTH = 10;

function formatCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const abs = Math.abs(value);
  if (abs < 1000) return String(Math.round(value));
  if (abs < 1_000_000) return `${(value / 1000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  if (abs < 1_000_000_000) return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  return `${(value / 1_000_000_000).toFixed(1)}B`;
}

function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '~$—';
  return `~$${value.toFixed(2)}`;
}

function formatResetAt(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString([], sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: '2-digit' });
}

function barForPercent(value: number): string {
  const clamped = Math.max(0, Math.min(100, value));
  const filled = Math.round((clamped / 100) * BAR_WIDTH);
  return `${'█'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)}`;
}

function getContextTone(telemetry: { contextPercent: number } | null): string {
  if (!telemetry || telemetry.contextPercent < 0) return 'muted';
  if (telemetry.contextPercent >= 85) return 'danger';
  if (telemetry.contextPercent >= 60) return 'warning';
  return 'ok';
}

function getContextLabel(telemetry: { contextPercent: number } | null): string {
  if (telemetry && telemetry.contextPercent >= 0) {
    return `${barForPercent(telemetry.contextPercent)} ${Math.round(telemetry.contextPercent)}%`;
  }
  return `${'░'.repeat(BAR_WIDTH)} —%`;
}

function buildRateLimitLabel(accountTelemetry: import('../lib/types.js').AccountTelemetry | null | undefined): string {
  if (!accountTelemetry || !accountTelemetry.rateLimits.length) return '—';
  const parts: string[] = [];
  for (const rl of accountTelemetry.rateLimits) {
    if (rl.usedPercent >= 0) {
      const label = rl.windowMinutes === 300 ? '5h' : rl.windowMinutes === 10080 ? '7d' : rl.name;
      parts.push(`${label}: ${Math.round(rl.usedPercent)}%`);
    }
  }
  return parts.length > 0 ? parts.join(' | ') : '—';
}

export function SessionStatusBar({ sessionId, currentActivity = null }: SessionStatusBarProps) {
  const keyboardOpen = useUiStore((s) => s.keyboardOpen);
  const sessionTelemetryById = useTelemetryStore((s) => s.sessionTelemetryById);
  const accountTelemetry = useTelemetryStore((s) => s.accountTelemetry);

  const telemetry = sessionId ? sessionTelemetryById[sessionId] ?? null : null;
  const contextTone = getContextTone(telemetry);
  const contextLabel = getContextLabel(telemetry);

  const contextClass =
    contextTone === 'ok' ? 'status-context status-segment' : `status-context status-segment status-context--${contextTone}`;

  const activityLabel = currentActivity
    ? `${currentActivity.tool}${currentActivity.detail ? `: ${currentActivity.detail}` : ''}`
    : 'idle';

  const rateLimitLabel = buildRateLimitLabel(accountTelemetry);

  const telemetryTitle = telemetry
    ? `turns ${telemetry.turnCount} · subagents ${telemetry.subagentCount} · context ${telemetry.contextWindowSize || 'unknown'}`
    : 'telemetry unavailable';

  return (
    <div className="session-status-bar" hidden={keyboardOpen}>
      <div className="status-left">
        <span className="status-model status-segment" title={telemetryTitle}>
          {telemetry?.model ?? '—'}
        </span>
        <span className={contextClass} title={telemetryTitle}>
          {contextLabel}
        </span>
        <span className="status-tokens status-segment" title={telemetryTitle}>
          ↓{telemetry ? formatCompact(telemetry.totalInputTokens) : '—'} ↑
          {telemetry ? formatCompact(telemetry.totalOutputTokens) : '—'}
        </span>
        <span className="status-cost status-segment" title={telemetryTitle}>
          {telemetry ? formatCurrency(telemetry.costUsd) : '~$—'}
        </span>
        <span className="status-activity status-segment" title={activityLabel}>
          [{activityLabel}]
        </span>
      </div>

      <div className="status-right">
        <span
          className="status-rate-limits status-segment"
          title={accountTelemetry?.rateLimits.map((rl) => formatResetAt(rl.resetsAt)).join(' · ') ?? '—'}
        >
          {rateLimitLabel}
        </span>
      </div>
    </div>
  );
}

export default SessionStatusBar;
