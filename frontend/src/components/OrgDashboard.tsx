import React, { useState, useMemo, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchOrgPrs,
  fetchBranchLinks,
  fetchPresets,
  savePreset,
  deletePreset,
} from '../lib/api.js';
import { sortPrs } from '../lib/pr-utils.js';
import type {
  PullRequest,
  OrgPrsResponse,
  BranchLinksResponse,
  FilterPreset,
} from '../lib/types.js';
import TicketsPanel from './TicketsPanel.js';
import ActiveWorkSurface from './ActiveWorkSurface.js';
import { derivePrDotStatus } from '../lib/pr-status.js';
import { TuiButton } from './TuiButton.js';
import { PrRow } from './PrRow.js';
import './OrgDashboard.css';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OrgDashboardProps {
  onOpenPrSession: (pr: PullRequest) => void;
  onPrAction: (pr: PullRequest) => void;
}

type ActiveTab = 'active-work' | 'prs' | 'tickets';

// ── Helpers ───────────────────────────────────────────────────────────────────

function getTicketIdForPr(
  headRefName: string,
  branchLinksData: BranchLinksResponse
): string | null {
  for (const [issueNumber, links] of Object.entries(branchLinksData)) {
    for (const link of links) {
      if (link.branchName === headRefName) return issueNumber;
    }
  }
  return null;
}

interface PresetsRowProps {
  presets: FilterPreset[];
  onApply: (preset: FilterPreset) => void;
  onSave: () => void;
  onDelete: (preset: FilterPreset) => void;
}

function PresetsRow({ presets, onApply, onSave, onDelete }: PresetsRowProps) {
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const val = e.currentTarget.value;
      if (val === '__save__') {
        e.currentTarget.value = '';
        onSave();
      } else if (val) {
        const preset = presets.find((p) => p.name === val);
        if (preset) onApply(preset);
        e.currentTarget.value = '';
      }
    },
    [presets, onApply, onSave]
  );

  return (
    <div className="presets-row">
      <select className="preset-select" defaultValue="" onChange={handleChange}>
        <option value="" disabled>
          Presets...
        </option>
        {presets.map((p) => (
          <option key={p.name} value={p.name}>
            {p.name}
          </option>
        ))}
        <option value="__save__">Save current view...</option>
      </select>
      {presets
        .filter((p) => !p.builtIn)
        .map((p) => (
          <TuiButton
            key={p.name}
            variant="danger"
            size="sm"
            title={`Delete preset: ${p.name}`}
            onClick={() => onDelete(p)}
          >
            × <span style={{ textTransform: 'none' }}>{p.name}</span>
          </TuiButton>
        ))}
    </div>
  );
}

// ── usePrsTab hook ─────────────────────────────────────────────────────────────

function usePrsTab() {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, refetch } = useQuery<OrgPrsResponse>({
    queryKey: ['org-prs'],
    queryFn: fetchOrgPrs,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
  const { data: branchLinksData = {} } = useQuery<BranchLinksResponse>({
    queryKey: ['branch-links'],
    queryFn: fetchBranchLinks,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
  const { data: presets = [] } = useQuery<FilterPreset[]>({
    queryKey: ['presets'],
    queryFn: fetchPresets,
    staleTime: 30_000,
  });

  const [activeStatusChips, setActiveStatusChips] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState('role');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const allPrs = data?.prs ?? [];

  const processedPrs = useMemo((): PullRequest[] => {
    let prs = allPrs;
    if (activeStatusChips.length > 0)
      prs = prs.filter((pr) =>
        activeStatusChips.includes(derivePrDotStatus(pr))
      );
    const q = searchQuery.toLowerCase().trim();
    if (q)
      prs = prs.filter(
        (pr) =>
          pr.title.toLowerCase().includes(q) ||
          String(pr.number).includes(q) ||
          (pr.headRefName ?? '').toLowerCase().includes(q)
      );
    return sortPrs(prs, sortBy, sortDir);
  }, [allPrs, activeStatusChips, searchQuery, sortBy, sortDir]);

  const handleApplyPreset = useCallback((preset: FilterPreset) => {
    setActiveStatusChips(preset.filters.status ?? []);
    setSortBy(preset.sort.column);
    setSortDir(preset.sort.direction);
  }, []);

  const handleSaveCurrentView = useCallback(async () => {
    const name = window.prompt('Save current view as:');
    if (!name || !name.trim()) return;
    const filters: FilterPreset['filters'] = {};
    if (activeStatusChips.length > 0) filters.status = [...activeStatusChips];
    await savePreset({
      name: name.trim(),
      filters,
      sort: { column: sortBy, direction: sortDir },
    });
    await queryClient.invalidateQueries({ queryKey: ['presets'] });
  }, [activeStatusChips, sortBy, sortDir, queryClient]);

  const handleDeletePreset = useCallback(
    async (preset: FilterPreset) => {
      await deletePreset(preset.name);
      await queryClient.invalidateQueries({ queryKey: ['presets'] });
    },
    [queryClient]
  );

  return {
    data,
    isLoading,
    isError,
    refetch,
    branchLinksData,
    presets,
    allPrs,
    searchQuery,
    setSearchQuery,
    activeStatusChips,
    processedPrs,
    handleApplyPreset,
    handleSaveCurrentView,
    handleDeletePreset,
  };
}

// ── PrsTabError sub-component ─────────────────────────────────────────────────

interface PrsTabErrorProps {
  errorCode: string;
  onRetry: () => void;
}

function PrsTabError({ errorCode, onRetry }: PrsTabErrorProps) {
  if (errorCode === 'gh_not_in_path') {
    return (
      <div className="state-message state-message--info">
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
  if (errorCode === 'gh_not_authenticated') {
    return (
      <div className="state-message state-message--info">
        Run <code>gh auth login</code> to connect GitHub.
      </div>
    );
  }
  if (errorCode === 'gh_timeout') {
    return (
      <div className="state-message state-message--error">
        <span>GitHub is taking too long. Try again.</span>
        <TuiButton variant="ghost" size="sm" onClick={onRetry}>
          Retry
        </TuiButton>
      </div>
    );
  }
  return null;
}

// ── PrsTabContent sub-component ───────────────────────────────────────────────

interface PrsTabContentProps {
  isLoading: boolean;
  isError: boolean;
  dataError?: string;
  allPrs: PullRequest[];
  processedPrs: PullRequest[];
  branchLinksData: BranchLinksResponse;
  presets: FilterPreset[];
  searchQuery: string;
  activeStatusChips: string[];
  setSearchQuery: (q: string) => void;
  onOpenPrSession: (pr: PullRequest) => void;
  onPrAction: (pr: PullRequest) => void;
  onApplyPreset: (p: FilterPreset) => void;
  onSaveView: () => void;
  onDeletePreset: (p: FilterPreset) => void;
}

function PrsTabContent({
  isLoading,
  isError,
  dataError,
  allPrs,
  processedPrs,
  branchLinksData,
  presets,
  searchQuery,
  activeStatusChips,
  setSearchQuery,
  onOpenPrSession,
  onPrAction,
  onApplyPreset,
  onSaveView,
  onDeletePreset,
}: PrsTabContentProps) {
  const openCount = allPrs.filter((pr) => pr.state === 'OPEN').length;
  const prAttentionCount = allPrs.filter(
    (pr) =>
      pr.state === 'OPEN' &&
      (pr.reviewDecision === 'CHANGES_REQUESTED' || pr.role === 'reviewer')
  ).length;
  const emptyMsg =
    searchQuery || activeStatusChips.length > 0
      ? 'No PRs match filters.'
      : 'No open PRs across workspaces.';
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        {!isLoading && !isError && !dataError && (
          <span className="org-subtitle">
            {openCount === 1 ? '1 open PR' : `${openCount} open PRs`}
          </span>
        )}
        {prAttentionCount > 0 && (
          <span className="tab-badge">{prAttentionCount} need attention</span>
        )}
      </div>
      {!isLoading && !isError && allPrs.length > 0 && (
        <PresetsRow
          presets={presets}
          onApply={onApplyPreset}
          onSave={onSaveView}
          onDelete={onDeletePreset}
        />
      )}
      <div>
        <input
          type="search"
          placeholder="filter PRs..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
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
        {isLoading && <div className="state-message">Loading...</div>}
        {isError && (
          <div className="state-message state-message--error">
            Could not load pull requests.
          </div>
        )}
        {!isLoading && !isError && processedPrs.length === 0 && (
          <div className="state-message">{emptyMsg}</div>
        )}
        {processedPrs.map((pr) => (
          <PrRow
            key={`${pr.repoPath ?? pr.repoName}:${pr.number}`}
            pr={pr}
            onOpen={onOpenPrSession}
            onAction={onPrAction}
            ticketId={getTicketIdForPr(pr.headRefName, branchLinksData)}
            showRepo
            showCi
          />
        ))}
      </div>
    </>
  );
}

// ── PrsTab sub-component ──────────────────────────────────────────────────────

interface PrsTabProps {
  onOpenPrSession: (pr: PullRequest) => void;
  onPrAction: (pr: PullRequest) => void;
}

function PrsTab({ onOpenPrSession, onPrAction }: PrsTabProps) {
  const {
    data,
    isLoading,
    isError,
    refetch,
    branchLinksData,
    presets,
    allPrs,
    searchQuery,
    setSearchQuery,
    activeStatusChips,
    processedPrs,
    handleApplyPreset,
    handleSaveCurrentView,
    handleDeletePreset,
  } = usePrsTab();
  const onRetry = useCallback(() => {
    void refetch();
  }, [refetch]);

  if (data?.error && data.error !== 'no_workspaces')
    return <PrsTabError errorCode={data.error} onRetry={onRetry} />;
  if (data?.error === 'no_workspaces') return null;

  return (
    <PrsTabContent
      isLoading={isLoading}
      isError={isError}
      {...(data?.error ? { dataError: data.error } : {})}
      allPrs={allPrs}
      processedPrs={processedPrs}
      branchLinksData={branchLinksData}
      presets={presets}
      searchQuery={searchQuery}
      activeStatusChips={activeStatusChips}
      setSearchQuery={setSearchQuery}
      onOpenPrSession={onOpenPrSession}
      onPrAction={onPrAction}
      onApplyPreset={handleApplyPreset}
      onSaveView={() => void handleSaveCurrentView()}
      onDeletePreset={(p) => void handleDeletePreset(p)}
    />
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export function OrgDashboard({
  onOpenPrSession,
  onPrAction,
}: OrgDashboardProps) {
  const [activeTab, setActiveTab] = useState<ActiveTab>('active-work');

  return (
    <div className="org-dashboard">
      <div className="org-header">
        <span className="org-title">all workspaces</span>
      </div>
      {/* tab-strip uses raw buttons intentionally — underline-indicator navigation, not TuiButton actions */}
      <div className="tab-strip">
        <button
          className={[
            'tab-btn',
            activeTab === 'active-work' ? 'tab-btn--active' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          onClick={() => setActiveTab('active-work')}
        >
          active work
        </button>
        <button
          className={['tab-btn', activeTab === 'prs' ? 'tab-btn--active' : '']
            .filter(Boolean)
            .join(' ')}
          onClick={() => setActiveTab('prs')}
        >
          prs
        </button>
        <button
          className={[
            'tab-btn',
            activeTab === 'tickets' ? 'tab-btn--active' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          onClick={() => setActiveTab('tickets')}
        >
          tickets
        </button>
      </div>
      {activeTab === 'active-work' && <ActiveWorkSurface />}
      {activeTab === 'prs' && (
        <PrsTab onOpenPrSession={onOpenPrSession} onPrAction={onPrAction} />
      )}
      {activeTab === 'tickets' && <TicketsPanel />}
    </div>
  );
}

export default OrgDashboard;
