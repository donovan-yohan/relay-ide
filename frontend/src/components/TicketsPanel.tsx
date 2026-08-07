import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchGithubIssues, fetchBranchLinks, fetchJiraIssues } from '../lib/api.js';
import type { GitHubIssuesResponse, JiraIssuesResponse, BranchLinksResponse, BranchLink, AnyIssue } from '../lib/types.js';
import { TicketCard } from './TicketCard.js';
import { DataTable } from './DataTable.js';
import type { Column } from './DataTable.js';
import './TicketsPanel.css';

const TICKET_COLUMNS: Column[] = [
  { key: 'status', label: 'St', sortable: false, width: '36px' },
  { key: 'title', label: 'Title', sortable: true },
  { key: 'action', label: '', sortable: false, width: '100px' },
];

interface QueryState<T> {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
}

function useSimpleQuery<T>(queryFn: () => Promise<T>): QueryState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(true);
  const [isError, setIsError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setIsError(false);
    queryFn().then((result) => {
      if (!cancelled) { setData(result); setIsLoading(false); }
    }).catch(() => {
      if (!cancelled) { setIsError(true); setIsLoading(false); }
    });
    return () => { cancelled = true; };
  }, [queryFn]);

  return { data, isLoading, isError };
}

function getTicketId(issue: AnyIssue): string {
  if ('number' in issue) return `GH-${issue.number}`;
  return issue.key;
}

function AuthError({ tab, error }: { tab: 'github' | 'jira'; error: string }) {
  if (tab === 'github' && error === 'gh_not_in_path') {
    return <div className="state-message state-message--info">Install GitHub CLI — <a href="https://cli.github.com" target="_blank" rel="noopener noreferrer">cli.github.com</a></div>;
  }
  if (tab === 'github' && error === 'gh_not_authenticated') {
    return <div className="state-message state-message--info">Run <code>gh auth login</code> to connect GitHub.</div>;
  }
  if (tab === 'jira' && error === 'acli_not_in_path') {
    return <div className="state-message state-message--info">Install Atlassian CLI: <code>brew install acli</code> then <code>acli jira auth login --web</code></div>;
  }
  if (tab === 'jira' && error === 'acli_not_authenticated') {
    return <div className="state-message state-message--info">Run <code>acli jira auth login --web</code> to connect Jira.</div>;
  }
  return null;
}

export interface TicketsPanelProps {
  onStartWork?: (issue: AnyIssue) => void;
}

function filterAndSortIssues(issues: AnyIssue[], searchQuery: string, sortBy: string, sortDir: 'asc' | 'desc'): AnyIssue[] {
  let result = issues;
  const q = searchQuery.toLowerCase().trim();
  if (q) {
    result = result.filter((i) => {
      const title = 'title' in i ? i.title : '';
      const key = 'key' in i ? i.key : `#${(i as { number: number }).number}`;
      return title.toLowerCase().includes(q) || key.toLowerCase().includes(q);
    });
  }
  if (sortBy === 'title') {
    const getTitle = (i: AnyIssue) => ('title' in i ? i.title : '');
    result = [...result].sort((a, b) =>
      sortDir === 'asc' ? getTitle(a).localeCompare(getTitle(b)) : getTitle(b).localeCompare(getTitle(a)),
    );
  }
  return result;
}

function buildCountLabel(tab: 'github' | 'jira', githubOpenCount: number, jiraCount: number): string {
  if (tab === 'github') return `${githubOpenCount} open issue${githubOpenCount === 1 ? '' : 's'}`;
  return `${jiraCount} issue${jiraCount === 1 ? '' : 's'}`;
}

export function TicketsPanel({ onStartWork }: TicketsPanelProps) {
  const [activeTab, setActiveTab] = useState<'github' | 'jira'>('jira');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState('title');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const githubFn = useCallback(() => fetchGithubIssues(), []);
  const jiraFn = useCallback(() => fetchJiraIssues(), []);
  const branchLinksFn = useCallback(() => fetchBranchLinks(), []);

  const githubQuery = useSimpleQuery<GitHubIssuesResponse>(githubFn);
  const jiraQuery = useSimpleQuery<JiraIssuesResponse>(jiraFn);
  const branchLinksQuery = useSimpleQuery<BranchLinksResponse>(branchLinksFn);

  const branchLinksData: BranchLinksResponse = branchLinksQuery.data ?? {};
  const githubIssues = githubQuery.data?.issues ?? [];
  const jiraIssues = jiraQuery.data?.issues ?? [];
  const activeQuery = activeTab === 'github' ? githubQuery : jiraQuery;
  const activeIssues: AnyIssue[] = activeTab === 'github' ? githubIssues : jiraIssues;
  const activeError = activeTab === 'github' ? githubQuery.data?.error : jiraQuery.data?.error;
  const githubOpenCount = githubIssues.filter((i) => i.state === 'OPEN').length;
  const countLabel = buildCountLabel(activeTab, githubOpenCount, jiraIssues.length);

  const processedIssues = useMemo(
    () => filterAndSortIssues(activeIssues, searchQuery, sortBy, sortDir),
    [activeIssues, searchQuery, sortBy, sortDir],
  );

  function handleSort(col: string) {
    if (col === sortBy) setSortDir((d) => d === 'asc' ? 'desc' : 'asc');
    else { setSortBy(col); setSortDir('asc'); }
  }

  function getBranchLinks(issue: AnyIssue): BranchLink[] { return branchLinksData[getTicketId(issue)] ?? []; }

  const renderRow = (issue: AnyIssue) => (
    <TicketCard issue={issue} source={activeTab} branchLinks={getBranchLinks(issue)} {...(onStartWork != null && { onStartWork })} />
  );

  const authError = activeError ? <AuthError tab={activeTab} error={activeError} /> : null;
  const showCount = !activeQuery.isLoading && !activeQuery.isError && !activeError;
  const tableError = activeQuery.isError || activeError ? 'Failed to load issues.' : undefined;

  return (
    <div className="tickets-panel">
      <div className="tab-strip">
        <button className={['tab-btn', activeTab === 'github' && 'tab-btn--active'].filter(Boolean).join(' ')} onClick={() => setActiveTab('github')}>GitHub Issues</button>
        <button className={['tab-btn', activeTab === 'jira' && 'tab-btn--active'].filter(Boolean).join(' ')} onClick={() => setActiveTab('jira')}>Jira</button>
      </div>
      <div className="panel-header">
        <span className="panel-title">Tickets{showCount ? <span className="panel-count">· {countLabel}</span> : null}</span>
      </div>
      {authError ?? (
        <DataTable
          columns={TICKET_COLUMNS} rows={processedIssues} sortBy={sortBy} sortDir={sortDir} onSort={handleSort}
          loading={activeQuery.isLoading} error={tableError}
          emptyMessage="No assigned tickets." filteredEmptyMessage="No tickets match search."
          hasActiveFilters={searchQuery.length > 0} onClearFilters={() => setSearchQuery('')}
          row={renderRow} mobileCard={renderRow}
        />
      )}
    </div>
  );
}

export default TicketsPanel;
