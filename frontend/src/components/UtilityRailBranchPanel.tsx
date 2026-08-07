import React, { useCallback, useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchDivergence } from '../lib/api.js';
import { useUiStore } from '../lib/stores/ui.js';
import type {
  BranchDivergenceCommit,
  BranchDivergenceState,
  BranchDivergenceSummary,
  DirtySummary,
} from '../lib/types.js';
import './UtilityRailBranchPanel.css';

export interface UtilityRailBranchPanelProps {
  workspacePath: string;
  stateKey?: string;
}

function divergenceKey(workspacePath: string, base: string | null) {
  return ['workspaceDivergence', workspacePath, base ?? ''] as const;
}

function formatDate(date: string): string {
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function dirtyTotal(dirty: DirtySummary): number {
  return (
    dirty.stagedCount +
    dirty.unstagedCount +
    dirty.untrackedCount +
    dirty.conflictedCount
  );
}

function stateLabel(data: BranchDivergenceSummary): string {
  const dirty = dirtyTotal(data.dirty);
  if (data.state !== 'ok') {
    const labels: Record<BranchDivergenceState, string> = {
      ok: 'ok',
      not_git: 'not a git repo',
      invalid_base: 'invalid base',
      missing_base: 'missing base',
      detached: 'detached head',
      unborn: 'unborn branch',
      no_merge_base: 'no merge base',
      timeout: 'timeout',
      git_error: 'git error',
    };
    return labels[data.state];
  }
  if (data.aheadCount === 0 && data.behindCount === 0 && dirty === 0) {
    return 'clean branch';
  }
  if (data.aheadCount === 0 && data.behindCount === 0 && dirty > 0) {
    return 'dirty tree only';
  }
  if (data.aheadCount > 0 && data.behindCount === 0) return 'ahead only';
  if (data.aheadCount === 0 && data.behindCount > 0) return 'behind only';
  return 'ahead and behind';
}

function statusClass(data: BranchDivergenceSummary): string {
  if (data.state !== 'ok') return 'branch-state branch-state--error';
  if (data.behindCount > 0) return 'branch-state branch-state--warn';
  if (data.aheadCount > 0) return 'branch-state branch-state--success';
  if (dirtyTotal(data.dirty) > 0) return 'branch-state branch-state--warn';
  return 'branch-state branch-state--clean';
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  tone?: string;
}) {
  return (
    <div className={`branch-metric${tone ? ` branch-metric--${tone}` : ''}`}>
      <span className="branch-metric__value">{value}</span>
      <span className="branch-metric__label">{label}</span>
    </div>
  );
}

function CommitList({
  title,
  commits,
  empty,
}: {
  title: string;
  commits: BranchDivergenceCommit[];
  empty: string;
}) {
  return (
    <section className="branch-section">
      <header className="branch-section__header">
        <span>{title}</span>
        <span>{commits.length}</span>
      </header>
      {commits.length === 0 ? (
        <div className="branch-empty-line">{empty}</div>
      ) : (
        <div className="branch-commit-list">
          {commits.map((commit) => (
            <div className="branch-commit" key={commit.hash}>
              <span className="branch-commit__hash">{commit.shortHash}</span>
              <span className="branch-commit__subject" title={commit.subject}>
                {commit.subject}
              </span>
              <span className="branch-commit__meta">
                {commit.author} · {formatDate(commit.date)}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function EmptyOrError({ data }: { data: BranchDivergenceSummary }) {
  const label = stateLabel(data);
  if (data.state === 'ok' && (data.aheadCount > 0 || data.behindCount > 0)) {
    return null;
  }
  return (
    <div className="branch-state-detail">
      <span>{label}</span>
      {data.error ? <span>{data.error}</span> : null}
      {data.state === 'ok' &&
      data.lineDelta.fileCount === 0 &&
      (data.aheadCount > 0 || data.behindCount > 0) ? (
        <span>divergence with zero line delta</span>
      ) : null}
      {data.state === 'ok' && data.baseCandidates.length === 0 ? (
        <span>no remote/default fallback found</span>
      ) : null}
    </div>
  );
}

export function UtilityRailBranchPanel({
  workspacePath,
  stateKey,
}: UtilityRailBranchPanelProps) {
  const workspaceStateKey = stateKey ?? workspacePath;
  const queryClient = useQueryClient();
  const openUtilityRailTab = useUiStore((s) => s.openUtilityRailTab);
  const setUtilityBranchBase = useUiStore((s) => s.setUtilityBranchBase);
  const selectedBase = useUiStore(
    (s) => s.getUtilityRailState(workspaceStateKey).branchBase ?? null
  );

  const query = useQuery<BranchDivergenceSummary>({
    queryKey: divergenceKey(workspacePath, selectedBase),
    queryFn: async () =>
      fetchDivergence(workspacePath, selectedBase ?? undefined),
    enabled: Boolean(workspacePath),
    staleTime: 5 * 1000,
    retry: false,
  });

  const data = query.data;

  useEffect(() => {
    if (!data || selectedBase !== null) return;
    const nextBase = data.selectedBase?.ref ?? data.baseCandidates[0]?.ref;
    if (nextBase) setUtilityBranchBase(workspaceStateKey, nextBase);
  }, [data, selectedBase, setUtilityBranchBase, workspaceStateKey]);

  const dirtySummary = useMemo(() => {
    if (!data) return '0 files';
    const dirty = data.dirty;
    const parts = [
      dirty.stagedCount > 0 ? `${dirty.stagedCount} staged` : null,
      dirty.unstagedCount > 0 ? `${dirty.unstagedCount} unstaged` : null,
      dirty.untrackedCount > 0 ? `${dirty.untrackedCount} untracked` : null,
      dirty.conflictedCount > 0 ? `${dirty.conflictedCount} conflicted` : null,
    ].filter(Boolean);
    if (parts.length === 0) return 'clean tree';
    return parts.join(' · ');
  }, [data]);

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({
      queryKey: divergenceKey(workspacePath, selectedBase),
    });
  }, [queryClient, selectedBase, workspacePath]);

  const openChanges = useCallback(() => {
    openUtilityRailTab(workspaceStateKey, 'changes');
  }, [openUtilityRailTab, workspaceStateKey]);

  const openReview = useCallback(() => {
    openUtilityRailTab(workspaceStateKey, 'review');
  }, [openUtilityRailTab, workspaceStateKey]);

  if (query.isPending && !data) {
    return (
      <div className="branch-panel">
        <div className="branch-topbar">
          <span className="branch-title">divergence</span>
          <span className="branch-muted">loading...</span>
        </div>
        <div className="branch-empty">loading branch state...</div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="branch-panel">
        <div className="branch-topbar">
          <span className="branch-title">divergence</span>
          <button className="branch-button" type="button" onClick={refresh}>
            retry
          </button>
        </div>
        <div className="branch-empty">unable to load branch state</div>
      </div>
    );
  }

  const currentBase = selectedBase ?? data.selectedBase?.ref ?? '';
  const baseOptions = data.baseCandidates;
  const shouldShowMissingBaseOption =
    Boolean(currentBase) &&
    !baseOptions.some((candidate) => candidate.ref === currentBase);
  const lineDelta = data.lineDelta;
  const isZeroLineDivergence =
    (data.aheadCount > 0 || data.behindCount > 0) &&
    lineDelta.additions === 0 &&
    lineDelta.deletions === 0 &&
    lineDelta.fileCount === 0;

  return (
    <div className="branch-panel">
      <div className="branch-topbar">
        <div className="branch-topbar__main">
          <span className="branch-title">divergence</span>
          <span
            className="branch-current"
            title={data.currentBranch ?? 'detached head'}
          >
            {data.currentBranch ?? 'detached head'}
          </span>
        </div>
        <button
          className="branch-button"
          type="button"
          onClick={refresh}
          aria-label="refresh branch divergence"
        >
          refresh
        </button>
      </div>

      <div className="branch-base-row">
        <label htmlFor="branch-base-select">base</label>
        <select
          id="branch-base-select"
          className="branch-select"
          value={currentBase}
          onChange={(event) =>
            setUtilityBranchBase(workspaceStateKey, event.target.value || null)
          }
          disabled={baseOptions.length === 0 && !shouldShowMissingBaseOption}
        >
          {shouldShowMissingBaseOption ? (
            <option value={currentBase} disabled>
              {currentBase} (missing)
            </option>
          ) : null}
          {baseOptions.length === 0 && !shouldShowMissingBaseOption ? (
            <option value="">no base candidates</option>
          ) : (
            baseOptions.map((candidate) => (
              <option
                key={`${candidate.source}:${candidate.ref}`}
                value={candidate.ref}
              >
                {candidate.label || candidate.ref}
              </option>
            ))
          )}
        </select>
        <span className={statusClass(data)}>{stateLabel(data)}</span>
        {query.isFetching ? (
          <span className="branch-muted">refreshing</span>
        ) : null}
        {query.isStale ? (
          <span className="branch-muted branch-muted--warn">stale</span>
        ) : null}
      </div>

      <div className="branch-metrics" aria-label="branch metrics">
        <Metric label="ahead" value={data.aheadCount} tone="success" />
        <Metric label="behind" value={data.behindCount} tone="warning" />
        <Metric label="files" value={lineDelta.fileCount} />
        <Metric label="add" value={`+${lineDelta.additions}`} tone="success" />
        <Metric label="del" value={`−${lineDelta.deletions}`} tone="error" />
        <Metric label="dirty" value={dirtyTotal(data.dirty)} tone="warning" />
        <Metric label="untracked" value={data.dirty.untrackedCount} />
      </div>

      <EmptyOrError data={data} />
      {isZeroLineDivergence ? (
        <div className="branch-state-detail">
          divergence with zero line delta
        </div>
      ) : null}

      {data.warnings.length > 0 || data.dirty.truncated ? (
        <div className="branch-warnings">
          {data.warnings.map((warning) => (
            <span key={warning}>{warning}</span>
          ))}
          {data.dirty.truncated ? <span>dirty file list truncated</span> : null}
        </div>
      ) : null}

      <section className="branch-dirty">
        <div>
          <span className="branch-section-label">dirty tree</span>
          <span className="branch-muted">{dirtySummary}</span>
        </div>
        <div className="branch-link-row">
          <button
            className="branch-link"
            type="button"
            onClick={openChanges}
            data-testid="branch-open-changes"
          >
            open changes
          </button>
          <button
            className="branch-link"
            type="button"
            onClick={openReview}
            data-testid="branch-open-review"
          >
            open review
          </button>
        </div>
      </section>

      <CommitList
        title="head commits"
        commits={data.commits.ahead}
        empty="no head-only commits"
      />
      <CommitList
        title="base commits"
        commits={data.commits.behind}
        empty="no base-only commits"
      />
    </div>
  );
}

export default UtilityRailBranchPanel;
