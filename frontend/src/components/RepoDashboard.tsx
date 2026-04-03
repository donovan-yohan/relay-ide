import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchDashboard } from '../lib/api.js';
import { derivePrAction, buildPrStateInput } from '../lib/pr-state.js';
import { prRoleLabel, sortPrs } from '../lib/pr-utils.js';
import { formatRelativeTime } from '../lib/utils.js';
import type {
  PullRequest,
  ActivityEntry,
  DashboardData,
} from '../lib/types.js';
import { useSessionsStore } from '../lib/stores/sessions.js';
import { useTelemetryStore } from '../lib/stores/telemetry.js';
import { derivePrDotStatus } from '../lib/pr-status.js';
import type { StatusColor } from '../lib/pr-state.js';
import StatusDot from './StatusDot.js';
import { TuiButton } from './TuiButton.js';
import type { TuiButtonVariant } from './TuiButton.js';
import { TuiProgress } from './TuiProgress.js';
import './RepoDashboard.css';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RepoDashboardProps {
  repoPath: string;
  workspaceName: string;
  creatingWorktree?: boolean;
  onNewSession: () => void;
  onNewWorktree: () => void;
  onFixConflicts: (pr: PullRequest) => void;
  onPrAction: (pr: PullRequest) => void;
  onOpenPrSession: (pr: PullRequest) => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function compactCount(value: number): string {
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000)
    return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
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
  if (sameDay)
    return date.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function activityBranches(entry: ActivityEntry): string {
  if (!entry.branches || entry.branches.length === 0) return '';
  return '(' + entry.branches.join(', ') + ')';
}

function colorToVariant(color: StatusColor): TuiButtonVariant {
  if (color === 'success') return 'success';
  if (color === 'error') return 'danger';
  if (color === 'accent') return 'primary';
  if (color === 'info') return 'info';
  return 'ghost';
}

/** Returns a ref + className for a section that should only show the scroll fade when content overflows. */
function useScrollOverflow() {
  const ref = useRef<HTMLElement>(null);
  const [hasOverflow, setHasOverflow] = useState(false);

  const check = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setHasOverflow(el.scrollHeight > el.clientHeight + 4);
  }, []);

  useEffect(() => {
    check();
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [check]);

  return { ref, hasOverflow };
}

// ── Sub-components ─────────────────────────────────────��───────────────────────

interface UsageSectionProps {
  repoSessions: import('../lib/types.js').SessionSummary[];
  repoPath: string;
}

function UsageSection({ repoSessions }: UsageSectionProps) {
  const summarize = useTelemetryStore((s) => s.summarizeSessionSetTelemetry);
  const accountTelemetry = useTelemetryStore((s) => s.accountTelemetry);
  const repoTelemetry = useMemo(
    () => summarize(repoSessions),
    [summarize, repoSessions]
  );

  const sessionCoveragePercent =
    repoTelemetry.totalSessions > 0
      ? Math.round(
          (repoTelemetry.trackedSessions / repoTelemetry.totalSessions) * 100
        )
      : 0;

  const contextPercent =
    repoTelemetry.averageContextPercent !== null
      ? Math.max(
          0,
          Math.min(100, Math.round(repoTelemetry.averageContextPercent))
        )
      : -1;

  return (
    <section className="dashboard-section">
      <div className="section-heading">usage this window</div>
      <div className="usage-panel">
        <div className="usage-row">
          <span className="usage-label">sessions tracked</span>
          <span className="usage-bar">
            <TuiProgress
              variant="bar"
              value={sessionCoveragePercent}
              width={10}
            />
          </span>
          <span className="usage-value">
            {repoTelemetry.trackedSessions} of {repoTelemetry.totalSessions}
            {repoTelemetry.totalSessions > repoTelemetry.trackedSessions && (
              <>
                {' '}
                ({repoTelemetry.totalSessions -
                  repoTelemetry.trackedSessions}{' '}
                outside relay)
              </>
            )}
          </span>
        </div>
        <div className="usage-row">
          <span className="usage-label">relay tokens</span>
          <span className="usage-value">
            ↓{compactCount(repoTelemetry.totalInputTokens)} ↑
            {compactCount(repoTelemetry.totalOutputTokens)}
          </span>
          <span className="usage-meta">
            cache: {compactCount(repoTelemetry.totalCacheRead)} read
          </span>
        </div>
        <div className="usage-row">
          <span className="usage-label">context pressure</span>
          <span className="usage-bar">
            <TuiProgress
              variant="bar"
              value={contextPercent >= 0 ? contextPercent : 0}
              width={10}
            />
          </span>
          <span className="usage-value">
            {repoTelemetry.averageContextPercent !== null
              ? `${Math.round(repoTelemetry.averageContextPercent)}% avg`
              : '—'}
            {repoTelemetry.maxContextPercent !== null && (
              <span className="usage-meta">
                {' '}
                peak {Math.round(repoTelemetry.maxContextPercent)}%
              </span>
            )}
          </span>
        </div>
        {accountTelemetry && (
          <>
            <div className="usage-divider" />
            <div className="usage-row">
              <span className="usage-label">5h limit</span>
              <span className="usage-bar">
                <TuiProgress
                  variant="bar"
                  value={Math.max(
                    0,
                    Math.min(
                      100,
                      accountTelemetry.fiveHourUsedPercent >= 0
                        ? accountTelemetry.fiveHourUsedPercent
                        : 0
                    )
                  )}
                  width={10}
                />
              </span>
              <span className="usage-value">
                {accountTelemetry.fiveHourUsedPercent >= 0
                  ? `${Math.round(accountTelemetry.fiveHourUsedPercent)}% used`
                  : '—'}
              </span>
              <span className="usage-meta">
                resets {formatResetAt(accountTelemetry.fiveHourResetsAt)}
              </span>
            </div>
            <div className="usage-row">
              <span className="usage-label">7d limit</span>
              <span className="usage-bar">
                <TuiProgress
                  variant="bar"
                  value={Math.max(
                    0,
                    Math.min(
                      100,
                      accountTelemetry.sevenDayUsedPercent >= 0
                        ? accountTelemetry.sevenDayUsedPercent
                        : 0
                    )
                  )}
                  width={10}
                />
              </span>
              <span className="usage-value">
                {accountTelemetry.sevenDayUsedPercent >= 0
                  ? `${Math.round(accountTelemetry.sevenDayUsedPercent)}% used`
                  : '—'}
              </span>
              <span className="usage-meta">
                resets {formatResetAt(accountTelemetry.sevenDayResetsAt)}
              </span>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

interface ActivitySectionProps {
  data: DashboardData | undefined;
  isLoading: boolean;
}

function ActivitySection({ data, isLoading }: ActivitySectionProps) {
  const { ref: scrollRef, hasOverflow } = useScrollOverflow();
  const sectionClass = [
    'dashboard-section',
    'dashboard-section--scroll',
    hasOverflow && 'has-overflow',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <section className={sectionClass} ref={scrollRef}>
      <div className="section-heading">recent activity</div>
      {isLoading ? (
        <div className="scroll-container">
          <div className="activity-list">
            {[1, 2, 3].map((i) => (
              <div key={i} className="activity-row skeleton">
                <div className="skeleton-line skeleton-activity" />
              </div>
            ))}
          </div>
        </div>
      ) : data && data.activity.length === 0 ? (
        <div className="section-message">No recent commits (24h)</div>
      ) : data ? (
        <div className="scroll-container">
          <div className="activity-list">
            {data.activity.map((entry: ActivityEntry) => (
              <div key={entry.hash} className="activity-row">
                <span className="commit-hash">{entry.shortHash}</span>
                <span className="commit-msg">{entry.message}</span>
                {entry.branches.length > 0 && (
                  <span className="commit-branch">
                    {activityBranches(entry)}
                  </span>
                )}
                <span className="commit-time">{entry.timeAgo}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

interface PrRowProps {
  pr: PullRequest;
  onOpenPrSession: (pr: PullRequest) => void;
  onPrAction: (pr: PullRequest) => void;
}

function PrRow({ pr, onOpenPrSession, onPrAction }: PrRowProps) {
  const action = derivePrAction(buildPrStateInput(pr));
  return (
    <>
      <div
        className="pr-cell pr-cell--status"
        style={{ width: 36, flex: 'none' }}
      >
        <StatusDot status={derivePrDotStatus(pr)} />
      </div>
      <div className="pr-cell pr-cell--title" style={{ flex: 1 }}>
        <a
          className="pr-title-link"
          href={pr.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          {pr.title}
        </a>
        <div className="pr-row-meta">
          <span className="pr-num">#{pr.number}</span>
          <span className="pr-sep">&middot;</span>
          <span className="pr-role">{prRoleLabel(pr)}</span>
          <span className="pr-sep">&middot;</span>
          <span className="pr-time">{formatRelativeTime(pr.updatedAt)}</span>
        </div>
      </div>
      <div
        className="pr-cell pr-cell--role"
        style={{ width: 60, flex: 'none' }}
      >
        <span className="pr-role-text">
          {pr.role === 'author' ? 'Author' : 'Review'}
        </span>
      </div>
      <div className="pr-cell pr-cell--age" style={{ width: 72, flex: 'none' }}>
        <span className="pr-age-text">{formatRelativeTime(pr.updatedAt)}</span>
      </div>
      <div
        className="pr-cell pr-cell--action"
        style={{ width: 160, flex: 'none' }}
      >
        <div className="pr-row-actions">
          <TuiButton
            variant="primary"
            size="icon"
            onClick={() => onOpenPrSession(pr)}
            title="Open session on this branch"
          >
            +
          </TuiButton>
          {action.type !== 'none' && action.label && (
            <TuiButton
              variant={colorToVariant(action.color)}
              size="sm"
              onClick={() => onPrAction(pr)}
              title={action.label}
              disabled={action.type === 'checks-running'}
            >
              {action.label}
            </TuiButton>
          )}
        </div>
      </div>
    </>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

interface PrListBodyProps {
  data: DashboardData | undefined;
  isLoading: boolean;
  isError: boolean;
  workspaceName: string;
  searchQuery: string;
  processedPrs: PullRequest[];
  onSearchChange: (q: string) => void;
  onOpenPrSession: (pr: PullRequest) => void;
  onPrAction: (pr: PullRequest) => void;
}

function PrListBody({
  data,
  isLoading,
  isError,
  workspaceName,
  searchQuery,
  processedPrs,
  onSearchChange,
  onOpenPrSession,
  onPrAction,
}: PrListBodyProps) {
  if (data && !data.hasGhCli) {
    return (
      <div className="section-message info">
        Install GitHub CLI for PR tracking —{' '}
        <a
          href="https://cli.github.com"
          target="_blank"
          rel="noopener noreferrer"
        >
          cli.github.com
        </a>
      </div>
    );
  }
  if (isLoading) return <div className="section-message">Loading...</div>;
  if (isError)
    return <div className="section-message">Could not load pull requests.</div>;
  if (processedPrs.length === 0 && !searchQuery)
    return (
      <div className="section-message">No open PRs for {workspaceName}.</div>
    );
  return (
    <>
      <input
        type="search"
        placeholder="filter PRs..."
        value={searchQuery}
        onChange={(e) => onSearchChange(e.target.value)}
        style={{
          marginBottom: 8,
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--font-size-xs)',
          background: 'transparent',
          border: '1px solid var(--border)',
          color: 'var(--text)',
          padding: '2px 8px',
        }}
      />
      {processedPrs.length === 0 ? (
        <div className="section-message">
          No results for &apos;{searchQuery}&apos;.
        </div>
      ) : (
        <div>
          {processedPrs.map((pr) => (
            <div
              key={pr.number}
              style={{
                display: 'flex',
                alignItems: 'center',
                borderBottom: '1px solid var(--border)',
              }}
            >
              <PrRow
                pr={pr}
                onOpenPrSession={onOpenPrSession}
                onPrAction={onPrAction}
              />
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export function RepoDashboard({
  repoPath,
  workspaceName,
  creatingWorktree = false,
  onNewSession,
  onNewWorktree,
  onFixConflicts: _onFixConflicts,
  onPrAction,
  onOpenPrSession,
}: RepoDashboardProps) {
  const sessions = useSessionsStore((s) => s.sessions);
  const repoSessions = useMemo(
    () => sessions.filter((s) => s.repoPath === repoPath),
    [sessions, repoPath]
  );

  const [searchQuery, setSearchQuery] = useState('');
  const sortBy = 'age';
  const sortDir: 'asc' | 'desc' = 'desc';
  const { ref: prScrollRef, hasOverflow: prHasOverflow } = useScrollOverflow();

  const { data, isLoading, isError } = useQuery<DashboardData>({
    queryKey: ['dashboard', repoPath],
    queryFn: () => fetchDashboard(repoPath),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });

  const processedPrs = useMemo((): PullRequest[] => {
    if (!data) return [];
    let prs = data.prs;
    const q = searchQuery.toLowerCase().trim();
    if (q) {
      prs = prs.filter(
        (pr) =>
          pr.title.toLowerCase().includes(q) ||
          String(pr.number).includes(q) ||
          pr.headRefName.toLowerCase().includes(q)
      );
    }
    return sortPrs(prs, sortBy, sortDir);
  }, [data, searchQuery, sortBy, sortDir]);

  return (
    <div className="repo-dashboard">
      {data && !data.isGitRepo ? (
        <div className="non-git-notice">
          <span className="non-git-msg">Not a git repository</span>
        </div>
      ) : (
        <>
          <UsageSection repoSessions={repoSessions} repoPath={repoPath} />
          <section
            className={[
              'dashboard-section',
              'dashboard-section--scroll',
              prHasOverflow && 'has-overflow',
            ]
              .filter(Boolean)
              .join(' ')}
            ref={prScrollRef}
          >
            <div className="section-heading">open pull requests</div>
            <PrListBody
              data={data}
              isLoading={isLoading}
              isError={isError}
              workspaceName={workspaceName}
              searchQuery={searchQuery}
              processedPrs={processedPrs}
              onSearchChange={setSearchQuery}
              onOpenPrSession={onOpenPrSession}
              onPrAction={onPrAction}
            />
          </section>
          <ActivitySection data={data} isLoading={isLoading} />
        </>
      )}
      <div className="cta-row">
        <TuiButton variant="primary" onClick={onNewSession}>
          + start session
        </TuiButton>
        {(!data || data.isGitRepo) && (
          <TuiButton
            variant="ghost"
            onClick={onNewWorktree}
            disabled={creatingWorktree}
          >
            {creatingWorktree ? 'creating...' : '+ new worktree'}
          </TuiButton>
        )}
      </div>
    </div>
  );
}

export default RepoDashboard;
