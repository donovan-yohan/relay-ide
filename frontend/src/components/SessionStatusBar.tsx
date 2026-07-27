import { useUiStore } from '../lib/stores/ui.js';
import { useTelemetryStore } from '../lib/stores/telemetry.js';
import type { CurrentActivity } from '../lib/types.js';
import { formatCompact } from '../lib/utils.js';
import './SessionStatusBar.css';

export interface SessionStatusBarProps {
  sessionId: string | null;
  currentActivity?: CurrentActivity | null;
  onHandoffClick?: () => void;
}

const BAR_WIDTH = 10;

function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value))
    return '~$—';
  return `~$${value.toFixed(2)}`;
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

function useSessionStatusBarData(sessionId: string | null) {
  const sessionTelemetryById = useTelemetryStore((s) => s.sessionTelemetryById);

  const telemetry = sessionId
    ? (sessionTelemetryById[sessionId] ?? null)
    : null;

  return telemetry;
}

function buildActivityLabel(currentActivity: CurrentActivity | null): string {
  if (!currentActivity) return 'idle';
  return `${currentActivity.tool}${currentActivity.detail ? `: ${currentActivity.detail}` : ''}`;
}

function buildTelemetryTitle(
  telemetry: import('../lib/types.js').TelemetryData | null
): string {
  if (!telemetry) return 'telemetry unavailable';
  return `turns ${telemetry.turnCount} · subagents ${telemetry.subagentCount} · context ${telemetry.contextWindowSize || 'unknown'}`;
}

export function SessionStatusBar({
  sessionId,
  currentActivity = null,
  onHandoffClick,
}: SessionStatusBarProps) {
  const keyboardOpen = useUiStore((s) => s.keyboardOpen);
  const telemetry = useSessionStatusBarData(sessionId);

  const contextTone = getContextTone(telemetry);
  const contextLabel = getContextLabel(telemetry);

  const contextClass =
    contextTone === 'ok'
      ? 'status-context status-segment'
      : `status-context status-segment status-context--${contextTone}`;

  const activityLabel = buildActivityLabel(currentActivity);
  const telemetryTitle = buildTelemetryTitle(telemetry);

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
          {telemetry && telemetry.costUsd !== null
            ? formatCurrency(telemetry.costUsd)
            : '~$—'}
        </span>
        <span className="status-terminal status-segment">terminal</span>
        <span className="status-activity status-segment" title={activityLabel}>
          [{activityLabel}]
        </span>
      </div>

      <div className="status-right">
        {onHandoffClick && (
          <button
            className="status-handoff"
            type="button"
            title="open cold handoff dry-run plan"
            onClick={onHandoffClick}
          >
            handoff
          </button>
        )}
      </div>
    </div>
  );
}

export default SessionStatusBar;
