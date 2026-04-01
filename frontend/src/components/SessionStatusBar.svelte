<script lang="ts">
  import { getSessionState } from '../lib/state/sessions.svelte.js';
  import { getTelemetryState } from '../lib/state/telemetry.svelte.js';
  import { getUi } from '../lib/state/ui.svelte.js';

  let { sessionId }: { sessionId: string } = $props();

  const sessionState = getSessionState();
  const telemetry = getTelemetryState();
  const ui = getUi();

  const dash = '—';

  let session = $derived(sessionState.sessions.find((item) => item.id === sessionId));
  let sessionTelemetry = $derived(telemetry.sessionTelemetry.get(sessionId));
  let accountTelemetry = $derived(telemetry.accountTelemetry);
  let contextPercent = $derived(sessionTelemetry?.contextPercent ?? -1);

  function formatNumber(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return dash;
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
    return String(Math.round(value));
  }

  function formatCost(value: number | null | undefined): string {
    if (value == null || !Number.isFinite(value)) return `~$${dash}`;
    return `~$${value.toFixed(2)}`;
  }

  function formatTool(): string {
    if (!session?.currentActivity?.tool) return dash;
    if (session.currentActivity.detail) return `[${session.currentActivity.tool}: ${session.currentActivity.detail}]`;
    return `[${session.currentActivity.tool}]`;
  }

  function rateLimitLabel(label: 'fiveHour' | 'sevenDay'): string {
    if (!accountTelemetry) return `${label === 'fiveHour' ? '5h' : '7d'}: ${dash}`;
    const value = label === 'fiveHour' ? accountTelemetry.fiveHourUsedPercent : accountTelemetry.sevenDayUsedPercent;
    return `${label === 'fiveHour' ? '5h' : '7d'}: ${value >= 0 ? `${Math.round(value)}%` : dash}`;
  }

  function meterColor(percent: number): string {
    if (percent >= 85) return 'var(--status-error)';
    if (percent >= 60) return 'var(--status-warning)';
    return 'var(--text)';
  }

  function modelLabel(): string {
    if (!sessionTelemetry?.model) return dash;
    return sessionTelemetry.model.replace(/^Claude\s+/i, '');
  }
</script>

<div class="session-status-bar" style:display={ui.keyboardOpen ? 'none' : undefined}>
  <div class="segment segment--model">{modelLabel()}</div>

  <div class="segment segment--context">
    <div class="context-meter" aria-hidden="true">
      <div
        class="context-meter-fill"
        style:width={contextPercent >= 0 ? `${Math.min(contextPercent, 100)}%` : '0%'}
        style:background={meterColor(contextPercent)}
      ></div>
    </div>
    <span class="context-value" style:color={meterColor(contextPercent)}>
      {contextPercent >= 0 ? `${Math.round(contextPercent)}%` : `${dash}%`}
    </span>
  </div>

  <div class="segment segment--tokens">
    ↓{formatNumber(sessionTelemetry?.totalInputTokens ?? 0)}
    ↑{formatNumber(sessionTelemetry?.totalOutputTokens ?? 0)}
  </div>

  <div class="segment segment--cost">{formatCost(sessionTelemetry?.costUsd)}</div>

  <div class="segment segment--tool" title={formatTool()}>{formatTool()}</div>

  <div class="segment segment--limits">
    {rateLimitLabel('fiveHour')} | {rateLimitLabel('sevenDay')}
  </div>
</div>

<style>
  .session-status-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 28px;
    padding: 0 8px;
    border-top: 1px solid var(--border);
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-mono);
    font-size: var(--font-size-xs);
    flex-shrink: 0;
    overflow: hidden;
  }

  .segment {
    white-space: nowrap;
    min-width: 0;
  }

  .segment--model {
    color: var(--text-muted);
  }

  .segment--context {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .context-meter {
    width: 72px;
    height: 6px;
    border: 1px solid var(--border);
    background: transparent;
  }

  .context-meter-fill {
    height: 100%;
  }

  .segment--tool {
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
  }

  .segment--limits {
    margin-left: auto;
    color: var(--text-muted);
  }

  @media (max-width: 600px) {
    .segment--model,
    .segment--tokens,
    .segment--cost,
    .segment--limits {
      display: none;
    }
  }

  @media (max-width: 400px) {
    .segment--tool {
      display: none;
    }
  }
</style>
