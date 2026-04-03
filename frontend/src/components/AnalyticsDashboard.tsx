import React, { useEffect, useState, useMemo } from 'react';
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
import './AnalyticsDashboard.css';

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

function formatDateShort(iso: string): string {
  try {
    const d = new Date(iso);
    const month = d.toLocaleString(undefined, { month: 'short' }).toLowerCase();
    return `${month} ${d.getDate()}`;
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

// ── Sub-components ──

interface OverviewSectionProps {
  overview: AnalyticsOverview | null;
}

function OverviewSection({ overview }: OverviewSectionProps) {
  return (
    <section className="analytics-section">
      <h2 className="analytics-section-title">overview (last 7 days)</h2>
      <div className="analytics-section-divider" />
      {overview ? (
        <div className="analytics-kv-list">
          <div className="analytics-kv-row">
            <span className="analytics-kv-label">sessions:</span>
            <span className="analytics-kv-value">{overview.totalSessions}</span>
          </div>
          <div className="analytics-kv-row">
            <span className="analytics-kv-label">tokens:</span>
            <span className="analytics-kv-value">
              <span className="analytics-token-down">&#x2193;{formatCompact(overview.totalTokensIn)}</span>
              {' '}
              <span className="analytics-token-up">&#x2191;{formatCompact(overview.totalTokensOut)}</span>
            </span>
          </div>
          <div className="analytics-kv-row">
            <span className="analytics-kv-label">cache:</span>
            <span className="analytics-kv-value">{formatCompact(overview.totalCacheRead)} read</span>
          </div>
          <div className="analytics-kv-row">
            <span className="analytics-kv-label">avg duration:</span>
            <span className="analytics-kv-value">{formatDuration(overview.avgSessionDuration)}</span>
          </div>
          <div className="analytics-kv-row">
            <span className="analytics-kv-label">avg human latency:</span>
            <span className="analytics-kv-value">{formatDurationMs(overview.avgHumanResponseLatency)}</span>
          </div>
          <div className="analytics-kv-row">
            <span className="analytics-kv-label">agent idle:</span>
            <span className="analytics-kv-value">
              {overview.avgAgentIdlePercent != null ? overview.avgAgentIdlePercent.toFixed(1) + '%' : '---'}
            </span>
          </div>
          <div className="analytics-kv-row">
            <span className="analytics-kv-label">rate limits:</span>
            <span className="analytics-kv-value">{overview.totalRateLimitEncounters} encounters</span>
          </div>
        </div>
      ) : (
        <div className="analytics-empty-text">no data</div>
      )}
    </section>
  );
}

interface RateLimitSectionProps {
  rateLimits: AnalyticsRateLimitHistory | null;
}

function RateLimitSection({ rateLimits }: RateLimitSectionProps) {
  const latestRateLimit = useMemo(
    () => (rateLimits?.snapshots?.length ? rateLimits.snapshots[rateLimits.snapshots.length - 1] : null),
    [rateLimits]
  );

  return (
    <section className="analytics-section">
      <h2 className="analytics-section-title">rate limits</h2>
      <div className="analytics-section-divider" />
      {latestRateLimit ? (
        <div className="analytics-kv-list">
          <div className="analytics-kv-row">
            <span className="analytics-kv-label">5-hour:</span>
            <span className="analytics-kv-value analytics-bar-row">
              <span className="analytics-bar">{barForPercent(latestRateLimit.fiveHourPercent, 20)}</span>
              <span className="analytics-bar-pct">{Math.round(latestRateLimit.fiveHourPercent)}%</span>
            </span>
          </div>
          <div className="analytics-kv-row">
            <span className="analytics-kv-label">7-day:</span>
            <span className="analytics-kv-value analytics-bar-row">
              <span className="analytics-bar">{barForPercent(latestRateLimit.sevenDayPercent, 20)}</span>
              <span className="analytics-bar-pct">{Math.round(latestRateLimit.sevenDayPercent)}%</span>
            </span>
          </div>
        </div>
      ) : (
        <div className="analytics-empty-text">no rate limit data</div>
      )}
    </section>
  );
}

interface ToolSectionProps {
  tools: AnalyticsToolBreakdown | null;
}

function ToolSection({ tools }: ToolSectionProps) {
  const maxToolUses = useMemo(
    () => (tools?.tools?.length ? Math.max(...tools.tools.map((t) => t.totalUses)) : 1),
    [tools]
  );
  const barWidth = 16;

  return (
    <section className="analytics-section">
      <h2 className="analytics-section-title">tool usage (by count)</h2>
      <div className="analytics-section-divider" />
      {tools?.tools?.length ? (
        <div className="analytics-tool-list">
          {tools.tools.slice(0, 10).map((tool) => {
            const filled = maxToolUses > 0 ? Math.round((tool.totalUses / maxToolUses) * barWidth) : 0;
            return (
              <div key={tool.name} className="analytics-tool-row">
                <span className="analytics-tool-name">{tool.name}</span>
                <span className="analytics-tool-bar">
                  {'\u2588'.repeat(filled)}{'\u2591'.repeat(barWidth - filled)}
                </span>
                <span className="analytics-tool-count">{tool.totalUses}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="analytics-empty-text">no tool data</div>
      )}
    </section>
  );
}

interface SessionsTableProps {
  sessions: AnalyticsSessionsResponse | null;
  onSelectSession: (sessionId: string) => void;
}

function SessionsTable({ sessions, onSelectSession }: SessionsTableProps) {
  return (
    <section className="analytics-section">
      <h2 className="analytics-section-title">sessions (most recent)</h2>
      <div className="analytics-section-divider" />
      {sessions?.sessions?.length ? (
        <>
          <div className="analytics-sessions-table-wrap">
            <table className="analytics-sessions-table">
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
                {sessions.sessions.map((sess) => (
                  <tr
                    key={sess.sessionId}
                    className="analytics-session-row"
                    onClick={() => onSelectSession(sess.sessionId)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter') onSelectSession(sess.sessionId); }}
                  >
                    <td className="analytics-cell-time">
                      <span className="analytics-date-part">{formatDateShort(sess.startedAt)}</span>
                      <span className="analytics-time-part">{formatTimeShort(sess.startedAt)}</span>
                    </td>
                    <td className="analytics-cell-repo">{sess.repoName ?? '---'}</td>
                    <td className="analytics-cell-duration">{formatDuration(sess.durationSeconds)}</td>
                    <td>
                      <span className="analytics-token-down">&#x2193;{formatCompact(sess.totalInputTokens)}</span>
                      {' '}
                      <span className="analytics-token-up">&#x2191;{formatCompact(sess.totalOutputTokens)}</span>
                    </td>
                    <td className="analytics-cell-turns">{sess.turnCount}</td>
                    <td className="analytics-cell-tools">{sess.topTools.slice(0, 3).join(', ') || '---'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {sessions.total > sessions.sessions.length && (
            <div className="analytics-sessions-count">
              showing {sessions.sessions.length} of {sessions.total}
            </div>
          )}
        </>
      ) : (
        <div className="analytics-empty-text">no sessions recorded</div>
      )}
    </section>
  );
}

// ── Main component ──

export interface AnalyticsDashboardProps {
  onSelectSession: (sessionId: string) => void;
  onClose?: () => void;
}

export function AnalyticsDashboard({ onSelectSession, onClose }: AnalyticsDashboardProps) {
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [sessions, setSessions] = useState<AnalyticsSessionsResponse | null>(null);
  const [tools, setTools] = useState<AnalyticsToolBreakdown | null>(null);
  const [rateLimits, setRateLimits] = useState<AnalyticsRateLimitHistory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      fetchAnalyticsOverview(7),
      fetchAnalyticsSessions({ limit: 20 }),
      fetchAnalyticsTools(7),
      fetchAnalyticsRateLimits(24),
    ])
      .then(([ov, sess, tl, rl]) => {
        if (cancelled) return;
        setOverview(ov);
        setSessions(sess);
        setTools(tl);
        setRateLimits(rl);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'failed to load analytics');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <div className="analytics-dashboard">
        <div className="analytics-header-row">
          <h1 className="analytics-page-title">analytics</h1>
          {onClose && <button className="analytics-close-btn" onClick={onClose} title="close analytics">✕</button>}
        </div>
        <div className="analytics-divider" />
        <div className="analytics-loading-state">loading analytics data...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="analytics-dashboard">
        <div className="analytics-header-row">
          <h1 className="analytics-page-title">analytics</h1>
          {onClose && <button className="analytics-close-btn" onClick={onClose} title="close analytics">✕</button>}
        </div>
        <div className="analytics-divider" />
        <div className="analytics-error-state">error: {error}</div>
      </div>
    );
  }

  return (
    <div className="analytics-dashboard">
      <h1 className="analytics-page-title">analytics</h1>
      <div className="analytics-divider" />
      <div className="analytics-top-grid">
        <OverviewSection overview={overview} />
        <RateLimitSection rateLimits={rateLimits} />
      </div>
      <ToolSection tools={tools} />
      <SessionsTable sessions={sessions} onSelectSession={onSelectSession} />
    </div>
  );
}

export default AnalyticsDashboard;
