<script lang="ts">
  import {
    fetchAnalyticsOverview,
    fetchAnalyticsSessions,
    fetchAnalyticsTools,
    fetchAnalyticsRateLimits,
  } from '../lib/api.js';
  import type {
    AnalyticsOverview,
    AnalyticsSessionsResponse,
    AnalyticsToolBreakdown,
    AnalyticsRateLimitHistory,
  } from '../lib/types.js';
  import { formatCompact, formatDuration, formatDurationMs, barForPercent } from '../lib/utils.js';

  let { onSelectSession }: { onSelectSession: (sessionId: string) => void } = $props();

  let overview = $state<AnalyticsOverview | null>(null);
  let sessions = $state<AnalyticsSessionsResponse | null>(null);
  let tools = $state<AnalyticsToolBreakdown | null>(null);
  let rateLimits = $state<AnalyticsRateLimitHistory | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  $effect(() => {
    loadData();
  });

  async function loadData() {
    loading = true;
    error = null;
    try {
      const [ov, sess, tl, rl] = await Promise.all([
        fetchAnalyticsOverview(7),
        fetchAnalyticsSessions({ limit: 20 }),
        fetchAnalyticsTools(7),
        fetchAnalyticsRateLimits(24),
      ]);
      overview = ov;
      sessions = sess;
      tools = tl;
      rateLimits = rl;
    } catch (err) {
      console.warn('[analytics] Failed to load:', err);
      error = err instanceof Error ? err.message : 'failed to load analytics';
    } finally {
      loading = false;
    }
  }

  function formatResetTime(iso: string | null | undefined): string {
    if (!iso) return '---';
    try {
      const d = new Date(iso);
      const now = new Date();
      const diffMs = d.getTime() - now.getTime();
      if (diffMs <= 0) return 'now';
      const diffMin = Math.round(diffMs / 60_000);
      if (diffMin < 60) return `${diffMin}m`;
      const diffHr = Math.floor(diffMin / 60);
      const remMin = diffMin % 60;
      return remMin > 0 ? `${diffHr}h ${remMin}m` : `${diffHr}h`;
    } catch {
      return '---';
    }
  }

  function formatTimeShort(iso: string): string {
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
    } catch {
      return '---';
    }
  }

  function formatDateShort(iso: string): string {
    try {
      const d = new Date(iso);
      const month = d.toLocaleString(undefined, { month: 'short' }).toLowerCase();
      return `${month} ${d.getDate()}`;
    } catch {
      return '---';
    }
  }

  // ── Derived data ──

  let latestRateLimit = $derived(
    rateLimits?.snapshots?.length
      ? rateLimits.snapshots[rateLimits.snapshots.length - 1]
      : null
  );

  let maxToolUses = $derived(
    tools?.tools?.length
      ? Math.max(...tools.tools.map(t => t.totalUses))
      : 1
  );
</script>

<div class="analytics-dashboard">
  <h1 class="page-title">analytics</h1>
  <div class="divider"></div>

  {#if loading}
    <div class="loading-state">loading analytics data...</div>
  {:else if error}
    <div class="error-state">error: {error}</div>
  {:else}
    <!-- Top grid: overview + rate limits -->
    <div class="top-grid">
      <!-- Overview section -->
      <section class="section">
        <h2 class="section-title">overview (last 7 days)</h2>
        <div class="section-divider"></div>
        {#if overview}
          <div class="kv-list">
            <div class="kv-row">
              <span class="kv-label">sessions:</span>
              <span class="kv-value">{overview.totalSessions}</span>
            </div>
            <div class="kv-row">
              <span class="kv-label">tokens:</span>
              <span class="kv-value">
                <span class="token-down">&#x2193;{formatCompact(overview.totalTokensIn)}</span>
                &nbsp;
                <span class="token-up">&#x2191;{formatCompact(overview.totalTokensOut)}</span>
              </span>
            </div>
            <div class="kv-row">
              <span class="kv-label">cache:</span>
              <span class="kv-value">{formatCompact(overview.totalCacheRead)} read</span>
            </div>
            <div class="kv-row">
              <span class="kv-label">avg duration:</span>
              <span class="kv-value">{formatDuration(overview.avgSessionDuration)}</span>
            </div>
            <div class="kv-row">
              <span class="kv-label">avg human latency:</span>
              <span class="kv-value">{formatDurationMs(overview.avgHumanResponseLatency)}</span>
            </div>
            <div class="kv-row">
              <span class="kv-label">agent idle:</span>
              <span class="kv-value">{overview.avgAgentIdlePercent != null ? overview.avgAgentIdlePercent.toFixed(1) + '%' : '---'}</span>
            </div>
            <div class="kv-row">
              <span class="kv-label">rate limits:</span>
              <span class="kv-value">{overview.totalRateLimitEncounters} encounters</span>
            </div>
          </div>
        {:else}
          <div class="empty-text">no data</div>
        {/if}
      </section>

      <!-- Rate limits section -->
      <section class="section">
        <h2 class="section-title">rate limits</h2>
        <div class="section-divider"></div>
        {#if latestRateLimit}
          <div class="kv-list">
            <div class="kv-row">
              <span class="kv-label">5-hour:</span>
              <span class="kv-value bar-row">
                <span class="bar">{barForPercent(latestRateLimit.fiveHourPercent, 20)}</span>
                <span class="bar-pct">{Math.round(latestRateLimit.fiveHourPercent)}%</span>
              </span>
            </div>
            <div class="kv-row">
              <span class="kv-label">7-day:</span>
              <span class="kv-value bar-row">
                <span class="bar">{barForPercent(latestRateLimit.sevenDayPercent, 20)}</span>
                <span class="bar-pct">{Math.round(latestRateLimit.sevenDayPercent)}%</span>
              </span>
            </div>
          </div>
        {:else}
          <div class="empty-text">no rate limit data</div>
        {/if}
      </section>
    </div>

    <!-- Tool usage section -->
    <section class="section">
      <h2 class="section-title">tool usage (by count)</h2>
      <div class="section-divider"></div>
      {#if tools?.tools?.length}
        <div class="tool-list">
          {#each tools.tools.slice(0, 10) as tool (tool.name)}
            {@const barWidth = 16}
            {@const filled = maxToolUses > 0 ? Math.round((tool.totalUses / maxToolUses) * barWidth) : 0}
            <div class="tool-row">
              <span class="tool-name">{tool.name}</span>
              <span class="tool-bar">{'\u2588'.repeat(filled)}{'\u2591'.repeat(barWidth - filled)}</span>
              <span class="tool-count">{tool.totalUses}</span>
            </div>
          {/each}
        </div>
      {:else}
        <div class="empty-text">no tool data</div>
      {/if}
    </section>

    <!-- Sessions table -->
    <section class="section">
      <h2 class="section-title">sessions (most recent)</h2>
      <div class="section-divider"></div>
      {#if sessions?.sessions?.length}
        <div class="sessions-table-wrap">
          <table class="sessions-table">
            <thead>
              <tr>
                <th>time</th>
                <th>repo</th>
                <th>duration</th>
                <th>tokens</th>
                <th>turns</th>
                <th>tools</th>
              </tr>
            </thead>
            <tbody>
              {#each sessions.sessions as sess (sess.sessionId)}
                <tr
                  class="session-row"
                  onclick={() => onSelectSession(sess.sessionId)}
                  role="button"
                  tabindex="0"
                  onkeydown={(e) => { if (e.key === 'Enter') onSelectSession(sess.sessionId); }}
                >
                  <td class="cell-time">
                    <span class="date-part">{formatDateShort(sess.startedAt)}</span>
                    <span class="time-part">{formatTimeShort(sess.startedAt)}</span>
                  </td>
                  <td class="cell-repo">{sess.repoName ?? '---'}</td>
                  <td class="cell-duration">{formatDuration(sess.durationSeconds)}</td>
                  <td class="cell-tokens">
                    <span class="token-down">&#x2193;{formatCompact(sess.totalInputTokens)}</span>
                    &nbsp;
                    <span class="token-up">&#x2191;{formatCompact(sess.totalOutputTokens)}</span>
                  </td>
                  <td class="cell-turns">{sess.turnCount}</td>
                  <td class="cell-tools">{sess.topTools.slice(0, 3).join(', ') || '---'}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        {#if sessions.total > sessions.sessions.length}
          <div class="sessions-count">showing {sessions.sessions.length} of {sessions.total}</div>
        {/if}
      {:else}
        <div class="empty-text">no sessions recorded</div>
      {/if}
    </section>
  {/if}
</div>

<style>
  .analytics-dashboard {
    padding: 16px 20px;
    overflow-y: auto;
    height: 100%;
    font-family: var(--font-mono);
    color: var(--text);
    background: var(--bg);
  }

  .page-title {
    font-size: var(--font-size-lg);
    font-weight: 600;
    color: var(--text);
    margin: 0;
    text-transform: lowercase;
  }

  .divider {
    border-top: 1px solid var(--border);
    margin: 8px 0 16px;
  }

  .loading-state,
  .error-state {
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    padding: 24px 0;
  }

  .error-state {
    color: var(--status-error);
  }

  /* Top grid: overview + rate limits side-by-side */
  .top-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 24px;
    margin-bottom: 24px;
  }

  @media (max-width: 768px) {
    .top-grid {
      grid-template-columns: 1fr;
      gap: 16px;
    }
  }

  /* Sections */
  .section {
    margin-bottom: 24px;
  }

  .section-title {
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text);
    margin: 0 0 4px;
    text-transform: lowercase;
  }

  .section-divider {
    border-top: 1px solid var(--border);
    margin: 4px 0 8px;
  }

  /* Key-value rows */
  .kv-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .kv-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: var(--font-size-sm);
    line-height: 1.6;
  }

  .kv-label {
    color: var(--text-muted);
    min-width: 120px;
    flex-shrink: 0;
  }

  .kv-value {
    color: var(--text);
  }

  .bar-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  .bar {
    color: var(--accent);
    letter-spacing: -0.05em;
    font-size: var(--font-size-xs);
  }

  .bar-pct {
    color: var(--text);
    font-size: var(--font-size-xs);
    min-width: 32px;
  }

  .token-down {
    color: var(--text-muted);
  }

  .token-up {
    color: var(--text);
  }

  .empty-text {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    padding: 8px 0;
  }

  /* Tool usage */
  .tool-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .tool-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: var(--font-size-sm);
    line-height: 1.6;
  }

  .tool-name {
    color: var(--text);
    min-width: 80px;
    flex-shrink: 0;
  }

  .tool-bar {
    color: var(--accent);
    letter-spacing: -0.05em;
    font-size: var(--font-size-xs);
  }

  .tool-count {
    color: var(--text-muted);
    font-size: var(--font-size-xs);
    min-width: 40px;
    text-align: right;
  }

  /* Sessions table */
  .sessions-table-wrap {
    overflow-x: auto;
  }

  .sessions-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--font-size-xs);
  }

  .sessions-table th {
    text-align: left;
    color: var(--text-muted);
    font-weight: 400;
    padding: 4px 8px 4px 0;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
    text-transform: lowercase;
  }

  .sessions-table td {
    padding: 4px 8px 4px 0;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 40%, transparent);
    white-space: nowrap;
    color: var(--text);
    vertical-align: baseline;
  }

  .session-row {
    cursor: pointer;
    transition: background 0.1s;
  }

  .session-row:hover {
    background: var(--surface-hover);
  }

  .session-row:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: -1px;
  }

  .cell-time {
    color: var(--text-muted);
  }

  .date-part {
    margin-right: 4px;
  }

  .time-part {
    opacity: 0.7;
  }

  .cell-repo {
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .cell-duration {
    color: var(--text);
  }

  .cell-turns {
    text-align: right;
    padding-right: 12px;
  }

  .cell-tools {
    color: var(--text-muted);
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .sessions-count {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    padding: 8px 0;
  }
</style>
