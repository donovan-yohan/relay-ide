import type { SessionSummary } from '../lib/types.js';
import { useTelemetryStore } from '../lib/stores/telemetry.js';
import { formatCompact } from '../lib/utils.js';
import './WorkspaceUtilityRail.css';

export interface UtilityRailStatsPanelProps {
  activeSession?: SessionSummary | undefined;
  workspaceSessions: SessionSummary[];
}

function formatMoney(value: number | null): string {
  return value === null ? '~$-' : `~$${value.toFixed(2)}`;
}

function formatPercent(value: number | null): string {
  return value === null ? '-%' : `${Math.round(value)}%`;
}

export function UtilityRailStatsPanel({
  activeSession,
  workspaceSessions,
}: UtilityRailStatsPanelProps) {
  const summarizeSessionSetTelemetry = useTelemetryStore(
    (s) => s.summarizeSessionSetTelemetry
  );
  const summarizeSessionTelemetry = useTelemetryStore(
    (s) => s.summarizeSessionTelemetry
  );
  const aggregate = summarizeSessionSetTelemetry(workspaceSessions);
  const activeTelemetry = activeSession
    ? summarizeSessionTelemetry(activeSession)
    : null;

  return (
    <div className="utility-simple-panel">
      <div className="utility-section-title">active session</div>
      <div className="utility-kv-row">
        <span>model</span>
        <span>{activeTelemetry?.model ?? '-'}</span>
      </div>
      <div className="utility-kv-row">
        <span>context</span>
        <span>
          {activeTelemetry && activeTelemetry.contextPercent >= 0
            ? `${Math.round(activeTelemetry.contextPercent)}%`
            : '-%'}
        </span>
      </div>
      <div className="utility-kv-row">
        <span>tokens</span>
        <span>
          d{' '}
          {activeTelemetry
            ? formatCompact(activeTelemetry.totalInputTokens)
            : '-'}{' '}
          u
          {activeTelemetry
            ? formatCompact(activeTelemetry.totalOutputTokens)
            : '-'}
        </span>
      </div>
      <div className="utility-kv-row">
        <span>cost</span>
        <span>{formatMoney(activeTelemetry?.costUsd ?? null)}</span>
      </div>

      <div className="utility-section-title">workspace</div>
      <div className="utility-kv-row">
        <span>tracked</span>
        <span>
          {aggregate.trackedSessions}/{aggregate.totalSessions}
        </span>
      </div>
      <div className="utility-kv-row">
        <span>max context</span>
        <span>{formatPercent(aggregate.maxContextPercent)}</span>
      </div>
      <div className="utility-kv-row">
        <span>tokens</span>
        <span>
          d {formatCompact(aggregate.totalInputTokens)} u{' '}
          {formatCompact(aggregate.totalOutputTokens)}
        </span>
      </div>
      <div className="utility-kv-row">
        <span>cost</span>
        <span>{formatMoney(aggregate.totalCostUsd)}</span>
      </div>
    </div>
  );
}

export default UtilityRailStatsPanel;
