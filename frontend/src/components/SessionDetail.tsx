import React, { useEffect, useMemo, useState } from 'react';
import { fetchAnalyticsSessionDetail } from '../lib/api.js';
import type { AnalyticsSessionDetail } from '../lib/types.js';
import './SessionDetail.css';

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


function formatTimeHMS(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  } catch {
    return '---';
  }
}

function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 12) : id;
}

function eventSymbol(type: string): string {
  switch (type) {
    case 'session_start':
    case 'session_end':
      return '\u25CF';
    case 'user_prompt':
      return '\u25C6';
    case 'tool_use':
      return '\u25B8';
    case 'agent_stop':
      return '\u25A0';
    case 'notification':
      return '\u26A1';
    default:
      return '\u25CB';
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
      const tool = evt.data['tool'] ?? evt.data['name'] ?? 'unknown';
      const target = evt.data['target'] ?? evt.data['path'] ?? '';
      return target ? `${tool} ${target}` : String(tool);
    }
    case 'agent_stop':
      return 'agent stop';
    case 'notification':
      return String(evt.data['notificationType'] ?? evt.data['message'] ?? 'notification');
    case 'rate_limit':
      return 'rate limit hit';
    default:
      return evt.type.replace(/_/g, ' ');
  }
}

// ── Timeline item types ──

type TimelineEventItem = {
  kind: 'event';
  timestamp: string;
  symbol: string;
  label: string;
};

type TimelineIdleItem = {
  kind: 'idle';
  idleSeconds: number;
};

type TimelineItem = TimelineEventItem | TimelineIdleItem;

// ── Sub-components ──

interface MetricsSectionProps {
  sess: AnalyticsSessionDetail['session'];
}

function MetricsSection({ sess }: MetricsSectionProps) {
  return (
    <section className="sd-section">
      <h2 className="sd-section-title">metrics</h2>
      <div className="sd-section-divider" />
      <div className="sd-kv-list">
        <div className="sd-kv-row">
          <span className="sd-kv-label">duration:</span>
          <span className="sd-kv-value">{formatDuration(sess.durationSeconds)}</span>
        </div>
        <div className="sd-kv-row">
          <span className="sd-kv-label">tokens:</span>
          <span className="sd-kv-value">
            <span className="sd-token-down">&#x2193;{formatCompact(sess.totalInputTokens)}</span>
            {' '}
            <span className="sd-token-up">&#x2191;{formatCompact(sess.totalOutputTokens)}</span>
            {sess.totalCacheRead > 0 && (
              <> <span className="sd-cache-info">(cache: {formatCompact(sess.totalCacheRead)} read)</span></>
            )}
          </span>
        </div>
        <div className="sd-kv-row">
          <span className="sd-kv-label">turns:</span>
          <span className="sd-kv-value">{sess.turnCount}</span>
        </div>
        <div className="sd-kv-row">
          <span className="sd-kv-label">subagents:</span>
          <span className="sd-kv-value">{sess.subagentCount}</span>
        </div>
        <div className="sd-kv-row">
          <span className="sd-kv-label">human latency:</span>
          <span className="sd-kv-value">
            avg {formatDurationMs(sess.humanResponseLatencyAvgMs)}
            {' '}p50 {formatDurationMs(sess.humanResponseLatencyP50Ms)}
            {' '}p95 {formatDurationMs(sess.humanResponseLatencyP95Ms)}
          </span>
        </div>
        <div className="sd-kv-row">
          <span className="sd-kv-label">agent idle:</span>
          <span className="sd-kv-value">
            {sess.agentIdlePercent != null ? sess.agentIdlePercent.toFixed(1) + '%' : '---'}
          </span>
        </div>
        <div className="sd-kv-row">
          <span className="sd-kv-label">rate limits:</span>
          <span className="sd-kv-value">{sess.rateLimitEncounters}</span>
        </div>
      </div>
    </section>
  );
}

interface ToolBreakdownSectionProps {
  toolBreakdown: Record<string, { count: number }>;
}

function ToolBreakdownSection({ toolBreakdown }: ToolBreakdownSectionProps) {
  const sortedTools = useMemo(() => {
    const entries = Object.entries(toolBreakdown).map(([name, data]) => ({ name, count: data.count }));
    entries.sort((a, b) => b.count - a.count);
    return entries;
  }, [toolBreakdown]);

  const maxToolCount = useMemo(
    () => (sortedTools.length > 0 ? Math.max(...sortedTools.map((t) => t.count)) : 1),
    [sortedTools]
  );
  const barWidth = 16;

  return (
    <section className="sd-section">
      <h2 className="sd-section-title">tool breakdown</h2>
      <div className="sd-section-divider" />
      {sortedTools.length > 0 ? (
        <div className="sd-tool-list">
          {sortedTools.map((tool) => {
            const filled = maxToolCount > 0 ? Math.round((tool.count / maxToolCount) * barWidth) : 0;
            return (
              <div key={tool.name} className="sd-tool-row">
                <span className="sd-tool-name">{tool.name}</span>
                <span className="sd-tool-bar">
                  {'\u2588'.repeat(filled)}{'\u2591'.repeat(barWidth - filled)}
                </span>
                <span className="sd-tool-count">{tool.count} uses</span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="sd-empty-text">no tool data</div>
      )}
    </section>
  );
}

interface TimelineSectionProps {
  events: AnalyticsSessionDetail['events'];
}

function TimelineSection({ events }: TimelineSectionProps) {
  const timelineItems = useMemo((): TimelineItem[] => {
    const items: TimelineItem[] = [];
    for (let i = 0; i < events.length; i++) {
      const evt = events[i]!;
      items.push({
        kind: 'event',
        timestamp: evt.timestamp,
        symbol: eventSymbol(evt.type),
        label: eventLabel(evt),
      });
      if (evt.type === 'agent_stop' && i + 1 < events.length) {
        const next = events[i + 1]!;
        if (next.type === 'user_prompt') {
          const gap = (new Date(next.timestamp).getTime() - new Date(evt.timestamp).getTime()) / 1000;
          if (gap > 1) {
            items.push({ kind: 'idle', idleSeconds: gap });
          }
        }
      }
    }
    return items;
  }, [events]);

  return (
    <section className="sd-section">
      <h2 className="sd-section-title">event timeline</h2>
      <div className="sd-section-divider" />
      {timelineItems.length > 0 ? (
        <div className="sd-timeline">
          {timelineItems.map((item, i) =>
            item.kind === 'event' ? (
              <div key={i} className="sd-timeline-event">
                <span className="sd-tl-time">{formatTimeHMS(item.timestamp)}</span>
                <span className="sd-tl-symbol">{item.symbol}</span>
                <span className="sd-tl-label">{item.label}</span>
              </div>
            ) : (
              <div key={i} className="sd-timeline-idle">
                <span className="sd-idle-line">
                  {'\u2500'.repeat(3)} human idle: {formatDuration(item.idleSeconds)} {'\u2500'.repeat(3)}
                </span>
              </div>
            )
          )}
        </div>
      ) : (
        <div className="sd-empty-text">no events recorded</div>
      )}
    </section>
  );
}

// ── Main component ──

export interface SessionDetailProps {
  sessionId: string;
  onBack: () => void;
}

export function SessionDetail({ sessionId, onBack }: SessionDetailProps) {
  const [detail, setDetail] = useState<AnalyticsSessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchAnalyticsSessionDetail(sessionId)
      .then((d) => { if (!cancelled) setDetail(d); })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'failed to load session');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sessionId]);

  const sess = detail?.session ?? null;
  const toolBreakdown = detail?.toolBreakdown ?? {};
  const events = detail?.events ?? [];

  return (
    <div className="session-detail">
      <button className="sd-back-btn" onClick={onBack} tabIndex={0}>
        &#x2190; back
      </button>

      {loading ? (
        <div className="sd-loading-state">loading session detail...</div>
      ) : error ? (
        <div className="sd-error-state">error: {error}</div>
      ) : sess ? (
        <>
          <h1 className="sd-page-title">
            session {shortId(sess.sessionId)}
            {sess.repoName && (
              <><span className="sd-title-sep">&#x2014;</span><span className="sd-title-meta">{sess.repoName}</span></>
            )}
            {sess.model && (
              <><span className="sd-title-sep">&#x2014;</span><span className="sd-title-meta">{sess.model}</span></>
            )}
          </h1>
          <div className="sd-divider" />
          <MetricsSection sess={sess} />
          <ToolBreakdownSection toolBreakdown={toolBreakdown} />
          <TimelineSection events={events} />
        </>
      ) : (
        <div className="sd-error-state">session not found</div>
      )}
    </div>
  );
}

export default SessionDetail;
