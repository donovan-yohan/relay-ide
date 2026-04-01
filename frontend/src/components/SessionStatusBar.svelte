<script lang="ts">
  import { getUi } from '../lib/state/ui.svelte.js';
  import { getTelemetryState } from '../lib/state/telemetry.svelte.js';
  import type { CurrentActivity } from '../lib/types.js';

  let {
    sessionId,
    currentActivity = null,
  }: {
    sessionId: string | null;
    currentActivity?: CurrentActivity | null;
  } = $props();

  const ui = getUi();
  const telemetryState = getTelemetryState();

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

  let telemetry = $derived(sessionId ? telemetryState.sessionTelemetryById[sessionId] ?? null : null);
  let contextTone = $derived(
    !telemetry || telemetry.contextPercent < 0 ? 'muted'
    : telemetry.contextPercent >= 85 ? 'danger'
    : telemetry.contextPercent >= 60 ? 'warning'
    : 'ok'
  );

  let contextLabel = $derived(
    telemetry && telemetry.contextPercent >= 0
      ? `${barForPercent(telemetry.contextPercent)} ${Math.round(telemetry.contextPercent)}%`
      : `${'░'.repeat(BAR_WIDTH)} —%`
  );

  let activityLabel = $derived(
    currentActivity
      ? `${currentActivity.tool}${currentActivity.detail ? `: ${currentActivity.detail}` : ''}`
      : 'idle'
  );

  let rateLimitLabel = $derived.by(() => {
    const accountTelemetry = telemetryState.accountTelemetry;
    if (!accountTelemetry) return '—';

    const parts: string[] = [];
    if (accountTelemetry.fiveHourUsedPercent >= 0) {
      parts.push(`5h: ${Math.round(accountTelemetry.fiveHourUsedPercent)}%`);
    }
    if (accountTelemetry.sevenDayUsedPercent >= 0) {
      parts.push(`7d: ${Math.round(accountTelemetry.sevenDayUsedPercent)}%`);
    }
    return parts.length > 0 ? parts.join(' | ') : '—';
  });

  let telemetryTitle = $derived(
    telemetry
      ? `turns ${telemetry.turnCount} · subagents ${telemetry.subagentCount} · context ${telemetry.contextWindowSize || 'unknown'}`
      : 'telemetry unavailable'
  );
</script>

<div class="session-status-bar" hidden={ui.keyboardOpen}>
  <div class="status-left">
    <span class="status-model status-segment" title={telemetryTitle}>
      {telemetry?.model ?? '—'}
    </span>
    <span class="status-context status-segment" class:status-context--muted={contextTone === 'muted'} class:status-context--warning={contextTone === 'warning'} class:status-context--danger={contextTone === 'danger'} title={telemetryTitle}>
      {contextLabel}
    </span>
    <span class="status-tokens status-segment" title={telemetryTitle}>
      ↓{telemetry ? formatCompact(telemetry.totalInputTokens) : '—'} ↑{telemetry ? formatCompact(telemetry.totalOutputTokens) : '—'}
    </span>
    <span class="status-cost status-segment" title={telemetryTitle}>
      {telemetry ? formatCurrency(telemetry.costUsd) : '~$—'}
    </span>
    <span class="status-activity status-segment" title={activityLabel}>
      [{activityLabel}]
    </span>
  </div>

  <div class="status-right">
    <span class="status-rate-limits status-segment" title={`${formatResetAt(telemetryState.accountTelemetry?.fiveHourResetsAt)} · ${formatResetAt(telemetryState.accountTelemetry?.sevenDayResetsAt)}`}>
      {rateLimitLabel}
    </span>
  </div>
</div>

<style>
  .session-status-bar {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 28px;
    padding: 0 12px;
    background: var(--bg);
    border-top: 1px solid var(--border);
    font-family: var(--font-mono);
    font-size: var(--font-size-xs);
    overflow: hidden;
    white-space: nowrap;
  }

  .status-left,
  .status-right {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }

  .status-left {
    flex: 1;
    overflow: hidden;
  }

  .status-right {
    flex-shrink: 0;
    margin-left: auto;
  }

  .status-segment {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .status-model,
  .status-cost,
  .status-tokens,
  .status-activity,
  .status-rate-limits {
    color: var(--text-muted);
  }

  .status-context {
    color: var(--text);
  }

  .status-context--muted {
    color: var(--text-muted);
  }

  .status-context--warning {
    color: var(--status-warning);
  }

  .status-context--danger {
    color: var(--status-error);
  }

  .status-activity {
    min-width: 0;
    max-width: 38vw;
  }

  .status-rate-limits {
    text-align: right;
  }

  @media (max-width: 600px) {
    .status-model,
    .status-tokens,
    .status-cost,
    .status-rate-limits {
      display: none;
    }

    .status-activity {
      max-width: 48vw;
    }
  }

  @media (max-width: 400px) {
    .status-activity {
      display: none;
    }
  }
</style>
