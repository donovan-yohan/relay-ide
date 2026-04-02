<script lang="ts">
  import { fetchAnalyticsSessionDetail } from '../lib/api.js';
  import type { AnalyticsSessionDetail } from '../lib/types.js';

  let {
    sessionId,
    onBack,
  }: {
    sessionId: string;
    onBack: () => void;
  } = $props();

  let detail = $state<AnalyticsSessionDetail | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  $effect(() => {
    loadDetail(sessionId);
  });

  async function loadDetail(id: string) {
    loading = true;
    error = null;
    try {
      detail = await fetchAnalyticsSessionDetail(id);
    } catch (err) {
      console.warn('[analytics] Failed to load session detail:', err);
      error = err instanceof Error ? err.message : 'failed to load session';
    } finally {
      loading = false;
    }
  }

  // ── Format helpers ──

  function formatCompact(value: number | null | undefined): string {
    if (value === null || value === undefined || Number.isNaN(value)) return '---';
    const abs = Math.abs(value);
    if (abs < 1000) return String(Math.round(value));
    if (abs < 1_000_000) return `${(value / 1000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
    if (abs < 1_000_000_000) return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
    return `${(value / 1_000_000_000).toFixed(1)}B`;
  }

  function formatDuration(seconds: number | null | undefined): string {
    if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return '---';
    const s = Math.round(seconds);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    if (m < 60) return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
    const h = Math.floor(m / 60);
    const remM = m % 60;
    return remM > 0 ? `${h}h ${remM}m` : `${h}h`;
  }

  function formatDurationMs(ms: number | null | undefined): string {
    if (ms === null || ms === undefined || Number.isNaN(ms)) return '---';
    return formatDuration(ms / 1000);
  }

  function barForPercent(pct: number, width: number): string {
    const clamped = Math.max(0, Math.min(100, pct));
    const filled = Math.round((clamped / 100) * width);
    return '\u2588'.repeat(filled) + '\u2591'.repeat(width - filled);
  }

  function formatTimeHMS(iso: string): string {
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    } catch {
      return '---';
    }
  }

  function shortId(id: string): string {
    return id.length > 12 ? id.slice(0, 12) : id;
  }

  // ── Derived ──

  let sess = $derived(detail?.session ?? null);
  let toolBreakdown = $derived(detail?.toolBreakdown ?? {});
  let events = $derived(detail?.events ?? []);

  let sortedTools = $derived.by(() => {
    const entries = Object.entries(toolBreakdown).map(([name, data]) => ({
      name,
      count: data.count,
    }));
    entries.sort((a, b) => b.count - a.count);
    return entries;
  });

  let maxToolCount = $derived(
    sortedTools.length > 0 ? Math.max(...sortedTools.map(t => t.count)) : 1
  );

  // ── Event timeline helpers ──

  function eventSymbol(type: string): string {
    switch (type) {
      case 'session_start':
      case 'session_end':
        return '\u25CF'; // ●
      case 'user_prompt':
        return '\u25C6'; // ◆
      case 'tool_use':
        return '\u25B8'; // ▸
      case 'agent_stop':
        return '\u25A0'; // ■
      case 'notification':
        return '\u26A1'; // ⚡
      default:
        return '\u25CB'; // ○
    }
  }

  function eventLabel(evt: { type: string; data: Record<string, unknown> }): string {
    switch (evt.type) {
      case 'session_start':
        return 'session start';
      case 'session_end':
        return 'session end';
      case 'user_prompt':
        return 'user prompt';
      case 'tool_use': {
        const tool = evt.data.tool ?? evt.data.name ?? 'unknown';
        const target = evt.data.target ?? evt.data.path ?? '';
        return target ? `${tool} ${target}` : String(tool);
      }
      case 'agent_stop':
        return 'agent stop';
      case 'notification':
        return String(evt.data.message ?? 'notification');
      case 'rate_limit':
        return 'rate limit hit';
      default:
        return evt.type.replace(/_/g, ' ');
    }
  }

  // Build timeline items with idle durations inserted between agent_stop and user_prompt
  let timelineItems = $derived.by(() => {
    const items: Array<{
      kind: 'event' | 'idle';
      timestamp?: string;
      symbol?: string;
      label?: string;
      idleSeconds?: number;
    }> = [];

    for (let i = 0; i < events.length; i++) {
      const evt = events[i]!;
      items.push({
        kind: 'event',
        timestamp: evt.timestamp,
        symbol: eventSymbol(evt.type),
        label: eventLabel(evt),
      });

      // Insert idle marker between agent_stop and the next user_prompt
      if (evt.type === 'agent_stop' && i + 1 < events.length) {
        const next = events[i + 1]!;
        if (next.type === 'user_prompt') {
          const gap = (new Date(next.timestamp).getTime() - new Date(evt.timestamp).getTime()) / 1000;
          if (gap > 1) {
            items.push({
              kind: 'idle',
              idleSeconds: gap,
            });
          }
        }
      }
    }

    return items;
  });
</script>

<div class="session-detail">
  <!-- Back button -->
  <span
    class="back-btn"
    role="button"
    tabindex="0"
    onclick={() => onBack()}
    onkeydown={(e) => { if (e.key === 'Enter') onBack(); }}
  >&#x2190; back</span>

  {#if loading}
    <div class="loading-state">loading session detail...</div>
  {:else if error}
    <div class="error-state">error: {error}</div>
  {:else if sess}
    <h1 class="page-title">
      session {shortId(sess.sessionId)}
      {#if sess.repoName}
        <span class="title-sep">&#x2014;</span>
        <span class="title-meta">{sess.repoName}</span>
      {/if}
      {#if sess.model}
        <span class="title-sep">&#x2014;</span>
        <span class="title-meta">{sess.model}</span>
      {/if}
    </h1>
    <div class="divider"></div>

    <!-- Metrics -->
    <section class="section">
      <h2 class="section-title">metrics</h2>
      <div class="section-divider"></div>
      <div class="kv-list">
        <div class="kv-row">
          <span class="kv-label">duration:</span>
          <span class="kv-value">{formatDuration(sess.durationSeconds)}</span>
        </div>
        <div class="kv-row">
          <span class="kv-label">tokens:</span>
          <span class="kv-value">
            <span class="token-down">&#x2193;{formatCompact(sess.totalInputTokens)}</span>
            &nbsp;
            <span class="token-up">&#x2191;{formatCompact(sess.totalOutputTokens)}</span>
            {#if sess.totalCacheRead > 0}
              &nbsp;<span class="cache-info">(cache: {formatCompact(sess.totalCacheRead)} read)</span>
            {/if}
          </span>
        </div>
        <div class="kv-row">
          <span class="kv-label">turns:</span>
          <span class="kv-value">{sess.turnCount}</span>
        </div>
        <div class="kv-row">
          <span class="kv-label">subagents:</span>
          <span class="kv-value">{sess.subagentCount}</span>
        </div>
        <div class="kv-row">
          <span class="kv-label">human latency:</span>
          <span class="kv-value">
            avg {formatDurationMs(sess.humanResponseLatencyAvgMs)}
            &nbsp;p50 {formatDurationMs(sess.humanResponseLatencyP50Ms)}
            &nbsp;p95 {formatDurationMs(sess.humanResponseLatencyP95Ms)}
          </span>
        </div>
        <div class="kv-row">
          <span class="kv-label">agent idle:</span>
          <span class="kv-value">{sess.agentIdlePercent != null ? sess.agentIdlePercent.toFixed(1) + '%' : '---'}</span>
        </div>
        <div class="kv-row">
          <span class="kv-label">rate limits:</span>
          <span class="kv-value">{sess.rateLimitEncounters}</span>
        </div>
      </div>
    </section>

    <!-- Tool breakdown -->
    <section class="section">
      <h2 class="section-title">tool breakdown</h2>
      <div class="section-divider"></div>
      {#if sortedTools.length > 0}
        <div class="tool-list">
          {#each sortedTools as tool (tool.name)}
            {@const barWidth = 16}
            {@const filled = maxToolCount > 0 ? Math.round((tool.count / maxToolCount) * barWidth) : 0}
            <div class="tool-row">
              <span class="tool-name">{tool.name}</span>
              <span class="tool-bar">{'\u2588'.repeat(filled)}{'\u2591'.repeat(barWidth - filled)}</span>
              <span class="tool-count">{tool.count} uses</span>
            </div>
          {/each}
        </div>
      {:else}
        <div class="empty-text">no tool data</div>
      {/if}
    </section>

    <!-- Event timeline -->
    <section class="section">
      <h2 class="section-title">event timeline</h2>
      <div class="section-divider"></div>
      {#if timelineItems.length > 0}
        <div class="timeline">
          {#each timelineItems as item, i (i)}
            {#if item.kind === 'event'}
              <div class="timeline-event">
                <span class="tl-time">{formatTimeHMS(item.timestamp ?? '')}</span>
                <span class="tl-symbol">{item.symbol}</span>
                <span class="tl-label">{item.label}</span>
              </div>
            {:else}
              <div class="timeline-idle">
                <span class="idle-line">{'\u2500'.repeat(3)} human idle: {formatDuration(item.idleSeconds)} {'\u2500'.repeat(3)}</span>
              </div>
            {/if}
          {/each}
        </div>
      {:else}
        <div class="empty-text">no events recorded</div>
      {/if}
    </section>
  {:else}
    <div class="error-state">session not found</div>
  {/if}
</div>

<style>
  .session-detail {
    padding: 16px 20px;
    overflow-y: auto;
    height: 100%;
    font-family: var(--font-mono);
    color: var(--text);
    background: var(--bg);
  }

  .back-btn {
    display: inline-block;
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    cursor: pointer;
    padding: 4px 0;
    margin-bottom: 8px;
    transition: color 0.1s;
  }

  .back-btn:hover {
    color: var(--accent);
  }

  .back-btn:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: 2px;
  }

  .page-title {
    font-size: var(--font-size-lg);
    font-weight: 600;
    color: var(--text);
    margin: 0;
    text-transform: lowercase;
    line-height: 1.4;
  }

  .title-sep {
    color: var(--text-muted);
    margin: 0 4px;
  }

  .title-meta {
    color: var(--text-muted);
    font-weight: 400;
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

  .token-down {
    color: var(--text-muted);
  }

  .token-up {
    color: var(--text);
  }

  .cache-info {
    color: var(--text-muted);
    font-size: var(--font-size-xs);
  }

  .empty-text {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    padding: 8px 0;
  }

  /* Tool breakdown */
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
    min-width: 60px;
  }

  /* Timeline */
  .timeline {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .timeline-event {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: var(--font-size-xs);
    line-height: 1.8;
  }

  .tl-time {
    color: var(--text-muted);
    min-width: 70px;
    flex-shrink: 0;
  }

  .tl-symbol {
    flex-shrink: 0;
    width: 14px;
    text-align: center;
    color: var(--accent);
  }

  .tl-label {
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .timeline-idle {
    padding: 2px 0;
    font-size: var(--font-size-xs);
  }

  .idle-line {
    color: var(--text-muted);
    padding-left: 78px;
  }
</style>
