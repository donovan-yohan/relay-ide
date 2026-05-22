import { useUiStore } from '../lib/stores/ui.js';
import { useTelemetryStore } from '../lib/stores/telemetry.js';
import type { CurrentActivity } from '../lib/types.js';
import { formatCompact, formatResetAt } from '../lib/utils.js';
import './SessionStatusBar.css';

export interface SessionStatusBarProps {
  sessionId: string | null;
  currentActivity?: CurrentActivity | null;
  framework?: string | null | undefined;
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

const RATE_LIMIT_DISPLAY_NAMES: Record<string, string> = {
  five_hour: '5h',
  seven_day: '7d',
};

function buildRateLimitLabel(
  accountTelemetry:
    | import('../lib/types.js').AccountTelemetry
    | null
    | undefined
): string {
  if (!accountTelemetry || !accountTelemetry.rateLimits.length) return '—';
  const parts: string[] = [];
  for (const rl of accountTelemetry.rateLimits) {
    if (rl.usedPercent >= 0) {
      const label = RATE_LIMIT_DISPLAY_NAMES[rl.name] ?? rl.name;
      parts.push(`${label}: ${Math.round(rl.usedPercent)}%`);
    }
  }
  return parts.length > 0 ? parts.join(' | ') : '—';
}

function useSessionStatusBarData(
  sessionId: string | null,
  framework: string | null | undefined
) {
  const sessionTelemetryById = useTelemetryStore((s) => s.sessionTelemetryById);
  const getAccountTelemetry = useTelemetryStore((s) => s.getAccountTelemetry);
  const accountTelemetry = framework ? getAccountTelemetry(framework) : null;
  const frameworkLabel = framework ?? 'unknown';

  const telemetry = sessionId
    ? (sessionTelemetryById[sessionId] ?? null)
    : null;

  return { telemetry, accountTelemetry, frameworkLabel };
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
  framework,
  onHandoffClick,
}: SessionStatusBarProps) {
  const keyboardOpen = useUiStore((s) => s.keyboardOpen);
  const { telemetry, accountTelemetry, frameworkLabel } =
    useSessionStatusBarData(sessionId, framework);

  const contextTone = getContextTone(telemetry);
  const contextLabel = getContextLabel(telemetry);

  const contextClass =
    contextTone === 'ok'
      ? 'status-context status-segment'
      : `status-context status-segment status-context--${contextTone}`;

  const activityLabel = buildActivityLabel(currentActivity);
  const rateLimitLabel = buildRateLimitLabel(accountTelemetry);
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
        <span
          className={`status-framework status-segment status-framework--${frameworkLabel}`}
          title={`Framework: ${frameworkLabel}`}
        >
          {frameworkLabel}
        </span>
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
        <span
          className="status-rate-limits status-segment"
          title={
            accountTelemetry?.rateLimits.length
              ? accountTelemetry.rateLimits
                  .map((rl) => formatResetAt(rl.resetsAt))
                  .join(' · ')
              : '—'
          }
        >
          {rateLimitLabel}
        </span>
      </div>
    </div>
  );
}

export default SessionStatusBar;
